// scheduleUndo.js — session undo stack for the Schedule editor.
//
// Andrew 2026-09-01: "add a undo button on the make schedule page so if we
// make changes and didnt mean it we can change it." One ↩ button in the
// editor header reverses the manager's own recent actions, newest first.
//
// PURE module (unit-tested): stack bookkeeping + the undo PLAN — given an
// entry and the live docs, decide exactly which writes reverse it. The
// component fetches live docs and applies the plan (Firestore stays there).
//
// Entry shapes (pushed by Schedule.jsx after each successful edit):
//   { kind:'create', ids:[...], week:{startStr,endStr}|null, label, tag? }
//       — added shift(s): auto-fill / generate / copy / single add.
//         Undo deletes them, but ONLY ones still drafts (published stays).
//   { kind:'delete', id, snapshot, label }
//       — deleted shift. Undo recreates the SAME doc id from the snapshot.
//   { kind:'update', id, before, after, revert, label }
//       — times edit or drag move. `before` = full pre-edit doc (used only
//         to recreate when the doc was deleted since); `after` = the fields
//         the edit wrote (drift check); `revert` = the exact fields to write
//         back on undo, valued from the pre-edit doc. Undo MERGES `revert`
//         only — a colleague's concurrent change to any other field
//         survives — and refuses entirely when the `after` fields drifted.
//
// Safety rules baked into the plan:
//   • published is never silently flipped by an update-undo — the live
//     value is kept (undoing an edit must not un-publish a shift).
//   • create-undo skips docs that got published meanwhile (same rule as
//     copy-undo: staff were notified; removing them is a deliberate act).
//   • volatile/timestamp fields are stripped on restore and the shift
//     reminder is re-armed, mirroring what the edit handlers do.

export const UNDO_CAP = 20;

// Append, capped — oldest entries fall off.
export function pushUndo(stack, entry) {
    return [...(stack || []), entry].slice(-UNDO_CAP);
}

// Short human label for the entry kind ("what will Undo undo?").
export function undoKindLabel(entry, isEn) {
    const k = entry?.kind;
    const tag = entry?.tag;
    if (k === 'create') {
        if (tag === 'copy') return isEn ? 'Copy last week' : 'Copiar semana anterior';
        if (tag === 'autofill') return isEn ? 'Auto-fill' : 'Auto-rellenar';
        if (tag === 'recurring') return isEn ? 'Generated recurring shifts' : 'Turnos recurrentes generados';
        return isEn ? 'Added shift' : 'Turno agregado';
    }
    if (k === 'delete') return isEn ? 'Deleted shift' : 'Turno eliminado';
    if (k === 'update') return isEn ? 'Shift change' : 'Cambio de turno';
    return isEn ? 'Change' : 'Cambio';
}

// Fields never written back on a restore. createdAt/updatedAt are
// re-stamped by the applier; every TIMESTAMP field is stripped because a
// snapshot taken while the grid painted from the localStorage week cache
// carries rehydrateShiftTimestamps shims ({ toMillis: fn }) or plain
// {seconds,nanoseconds} maps — writing those would throw or corrupt the
// doc. The companion status fields (published, offerStatus, approvedBy…)
// carry the state coherently without them.
const STRIP_ON_RESTORE = new Set([
    'id', 'createdAt', 'updatedAt', 'updatedBy',
    'offeredAt', 'claimedAt', 'coverNeededAt', 'reminderSentAt',
    'publishedAt', 'pendingOfferAt', 'coverRequestedAt', 'approvedAt', 'splitAt',
]);

// Defense for timestamp-ish fields NOT on the list above (future schema
// drift): refuse any value that is or contains a function — the cache
// rehydrate shim's signature — so it can never reach batch.set.
function isCleanValue(v) {
    if (typeof v === 'function') return false;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const x of Object.values(v)) {
            if (typeof x === 'function') return false;
        }
    }
    return true;
}

function restoreFields(snapshot) {
    const out = {};
    for (const [k, v] of Object.entries(snapshot || {})) {
        if (STRIP_ON_RESTORE.has(k)) continue;
        if (v === undefined) continue; // batch.set throws on undefined
        if (!isCleanValue(v)) continue;
        out[k] = v;
    }
    // Re-arm the 1-hour reminder — the restore may change date/times and
    // the server cron skips shifts already flagged reminderSent.
    out.reminderSent = false;
    out.reminderSentAt = null;
    return out;
}

// Build the write plan that reverses `entry`.
//   liveById: Map<docId, docData> — fresh reads of every doc the entry touches.
// Returns { ops, skippedPublished, drifted, missing }:
//   ops: [{op:'delete', id, data(live)} | {op:'set', id, data}]
//   skippedPublished: created docs left alone because they got published
//   drifted: true → refuse whole undo (someone else edited those fields)
//   missing: created docs already gone (deleted by hand — nothing to do)
export function planUndoOps(entry, liveById) {
    const ops = [];
    let skippedPublished = 0;
    let missing = 0;

    if (entry.kind === 'create') {
        for (const id of (entry.ids || [])) {
            const live = liveById.get(id);
            if (!live) { missing++; continue; }
            if (live.published !== false) { skippedPublished++; continue; }
            ops.push({ op: 'delete', id, data: live });
        }
        return { ops, skippedPublished, drifted: false, missing };
    }

    if (entry.kind === 'delete') {
        // Recreate at the SAME id (references like need.filledShiftIds
        // keep working). If it somehow exists again, nothing to do.
        if (!liveById.has(entry.id)) {
            ops.push({ op: 'set', id: entry.id, data: restoreFields(entry.snapshot) });
        }
        return { ops, skippedPublished: 0, drifted: false, missing: 0 };
    }

    if (entry.kind === 'update') {
        const live = liveById.get(entry.id);
        if (!live) {
            // Deleted since our edit — restore what the manager had.
            ops.push({ op: 'set', id: entry.id, data: restoreFields(entry.before) });
            return { ops, skippedPublished: 0, drifted: false, missing: 1 };
        }
        // Drift check: if the live doc no longer matches what OUR edit
        // wrote, a colleague changed it since — refuse rather than
        // clobber their work.
        for (const [k, v] of Object.entries(entry.after || {})) {
            if (live[k] !== v) return { ops: [], skippedPublished: 0, drifted: true, missing: 0 };
        }
        // TARGETED merge of only the fields the edit actually wrote
        // (entry.revert, valued from the pre-edit doc) — NOT a full-doc
        // replace. A colleague's concurrent change to any OTHER field
        // (an offer opened, a swap approved, published flipped) survives
        // the undo untouched.
        const revert = {};
        for (const [k, v] of Object.entries(entry.revert || {})) {
            if (v === undefined || !isCleanValue(v)) continue;
            revert[k] = v;
        }
        ops.push({
            op: 'merge', id: entry.id,
            data: { ...revert, reminderSent: false, reminderSentAt: null },
        });
        return { ops, skippedPublished: 0, drifted: false, missing: 0 };
    }

    return { ops: [], skippedPublished: 0, drifted: false, missing: 0 };
}
