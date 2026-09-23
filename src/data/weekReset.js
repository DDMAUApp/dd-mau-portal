// weekReset.js — "Unassign all shifts" + "Delete all unpublished" for the
// schedule editor (Andrew 2026-09-23: "when you copy from last week we can
// unassign all the shifts and then we can drag and drop the shifts down to
// the names … make a delete all unpublished shifts so we can also start
// over").
//
// PURE module (unit-tested). The component reads live docs, calls these
// planners, and applies the writes.
//
// Model: an unassigned shift IS an open slot (staffing_needs) — the thing
// the grid's blue "Unassigned" row already shows, that never publishes,
// never notifies and never counts hours, and whose fill path already runs
// the availability / time-off / double-booking checks. Unassign turns each
// DRAFT shift into slot capacity (identical shifts share one slot with a
// count); dragging a slot chip onto a name fills it like tapping does.
//
//   • A draft that was itself filled FROM an existing slot just gives that
//     seat back ("reopen") instead of minting a second slot.
//   • Published shifts are never touched — staff were already told.

// Shifts that are the same job (same day, side, store, hours, double flag)
// collapse into one slot with a count.
export function unassignGroupKey(sh) {
    return [sh.date, sh.side, sh.location || '', sh.startTime, sh.endTime, sh.isDouble ? 1 : 0].join('|');
}

// drafts: the draft shift docs in view ({ id, ...data }, side + location
// already resolved by the caller). needsById: Map of live staffing_needs.
// → {
//   reopen: [{ shift, needId }]  — seat goes back to its existing slot
//   groups: [{ date, side, location, startTime, endTime, isDouble, count,
//              unassignedFrom:[names], notes, shiftIds:[] }]
// }
export function planUnassign(drafts, needsById) {
    const reopen = [];
    const byKey = new Map();
    for (const sh of drafts || []) {
        if (!sh || !sh.id || !sh.date || !sh.startTime || !sh.endTime) continue;
        const need = sh.fromNeedId && needsById ? needsById.get(sh.fromNeedId) : null;
        if (need && (need.filledShiftIds || []).includes(sh.id)) {
            reopen.push({ shift: sh, needId: sh.fromNeedId });
            continue;
        }
        const key = unassignGroupKey(sh);
        let g = byKey.get(key);
        if (!g) {
            g = {
                date: sh.date, side: sh.side, location: sh.location || null,
                startTime: sh.startTime, endTime: sh.endTime, isDouble: !!sh.isDouble,
                count: 0, unassignedFrom: [], notes: sh.notes || '', shiftIds: [],
            };
            byKey.set(key, g);
        }
        g.count++;
        g.shiftIds.push(sh.id);
        if (sh.staffName && !g.unassignedFrom.includes(sh.staffName)) g.unassignedFrom.push(sh.staffName);
        // Keep a note only when every shift in the slot shares it.
        if ((sh.notes || '') !== g.notes) g.notes = '';
    }
    const groups = [...byKey.values()].sort((a, b) =>
        a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    return { reopen, groups };
}

// Seats filled AFTER the unassign (dragged/tapped onto names) are the ids in
// a touched slot's live filledShiftIds that weren't there right after the
// unassign (`keptFillIds[needId]`; created slots started empty).
function postUnassignFills(entry, needsById) {
    const out = [];
    const touched = new Set([...(entry.createdNeedIds || []), ...Object.keys(entry.keptFillIds || {})]);
    for (const needId of touched) {
        const live = needsById.get(needId);
        if (!live) continue;
        const kept = new Set((entry.keptFillIds || {})[needId] || []);
        for (const fid of (live.filledShiftIds || [])) {
            if (!kept.has(fid)) out.push({ needId, shiftId: fid });
        }
    }
    return out;
}

// Undo "Unassign all": put the week back exactly as it was — remove the
// shifts people were dragged into since, remove the slots it created, and
// recreate the original shifts at their SAME ids.
//   entry: { kind:'unassign', snapshots:[{id,data}], createdNeedIds:[],
//            keptFillIds:{ reopenedNeedId: [fillIds still there after] } }
//   live:  { needsById: Map, shiftsById: Map }
// → { blockedPublished, deleteShifts:[{id,data}], deleteNeedIds:[],
//     restore:[{id,data}] }
// Refuses (blockedPublished > 0, nothing else) if any seat filled since was
// already PUBLISHED — staff were told; removing that is a deliberate act.
export function planUnassignUndo(entry, live) {
    const needsById = live?.needsById || new Map();
    const shiftsById = live?.shiftsById || new Map();
    const deleteShifts = [];
    let blockedPublished = 0;
    for (const { shiftId } of postUnassignFills(entry, needsById)) {
        const sh = shiftsById.get(shiftId);
        if (!sh) continue;
        if (sh.published !== false) { blockedPublished++; continue; }
        deleteShifts.push({ id: shiftId, data: sh });
    }
    if (blockedPublished > 0) return { blockedPublished, deleteShifts: [], deleteNeedIds: [], restore: [] };
    const deleteNeedIds = (entry.createdNeedIds || []).filter(id => needsById.has(id));
    const restore = (entry.snapshots || []).filter(s => s && s.id && !shiftsById.has(s.id));
    return { blockedPublished: 0, deleteShifts, deleteNeedIds, restore };
}

// Undo "Delete all unpublished": recreate the deleted drafts and the
// unassigned slots at their same ids. A restored shift whose slot was NOT
// part of the wipe needs its seat re-linked (the wipe pruned it); one whose
// slot comes back from its own snapshot is already consistent.
//   entry: { kind:'clear', shiftSnaps:[{id,data}], needSnaps:[{id,data}] }
// → { restoreNeeds:[{id,data}], restoreShifts:[{id,data}], relink:[{id,data}] }
export function planClearUndo(entry, live) {
    const needsById = live?.needsById || new Map();
    const shiftsById = live?.shiftsById || new Map();
    const restoreNeeds = (entry.needSnaps || []).filter(n => n && n.id && !needsById.has(n.id));
    const restoredNeedIds = new Set((entry.needSnaps || []).map(n => n.id));
    const restoreShifts = (entry.shiftSnaps || []).filter(s => s && s.id && !shiftsById.has(s.id));
    const relink = restoreShifts.filter(s => s.data?.fromNeedId && !restoredNeedIds.has(s.data.fromNeedId));
    return { restoreNeeds, restoreShifts, relink };
}

// ── Scope: exactly what's on screen, drafts only (Andrew 2026-09-23: "only
// work for the unpublished shifts and the page we are currently on … only
// the week I'm viewing, not all shifts and not all locations") ────────────
//   scope: { startStr, endStr (exclusive), storeLocation, side, personFilter }
// A 'both stores' view is refused — these actions run on ONE store.
export function resetScopeProblem(scope) {
    if (!scope || !scope.startStr || !scope.endStr || !scope.side) return 'no_scope';
    if (!scope.storeLocation || scope.storeLocation === 'both') return 'both_stores';
    return null;
}

// One shift is in scope only if ALL hold (checked on the freshest data we
// have — the server copy when given, else the on-screen copy):
//   draft · no pending claim · date inside the range · THIS store (a shift
//   with no store is left alone) · THIS side · the filtered person (if any).
export function shiftInResetScope(sh, scope, fallbackSide = null) {
    if (!sh || resetScopeProblem(scope)) return false;
    if (sh.published !== false) return false;
    if (sh.pendingClaimBy) return false;
    if (!sh.date || sh.date < scope.startStr || sh.date >= scope.endStr) return false;
    if (sh.location !== scope.storeLocation) return false;
    if ((sh.side || fallbackSide) !== scope.side) return false;
    if (scope.personFilter && sh.staffName !== scope.personFilter) return false;
    return true;
}

// viewShifts: what the grid shows ({ id, ...data }, side may be missing on
// legacy docs — the grid already resolved it to the viewed side).
// liveById: Map of fresh server docs for the range, or null to count from
// the screen (the confirm dialog). A shift must be on screen AND (when
// liveById is given) still exist and still qualify on the server.
export function selectResetDrafts(viewShifts, liveById, scope) {
    if (resetScopeProblem(scope)) return [];
    const out = [];
    for (const v of viewShifts || []) {
        if (!v || !v.id) continue;
        const fallbackSide = v.side || scope.side;
        const data = liveById ? liveById.get(v.id) : v;
        if (!data) continue;
        if (!shiftInResetScope(data, scope, fallbackSide)) continue;
        out.push({ ...data, id: v.id, side: data.side || fallbackSide });
    }
    return out;
}

// Unassigned seats "Delete all unpublished" clears: only ones Unassign-all
// made, in this range / store / side. None while a person filter is on —
// seats belong to nobody, so "only Maria's shifts" must not wipe them.
export function selectResetSeats(needs, scope) {
    if (resetScopeProblem(scope) || scope.personFilter) return [];
    return (needs || []).filter(n => n && n.fromUnassign === true &&
        n.date >= scope.startStr && n.date < scope.endStr &&
        n.side === scope.side && n.location === scope.storeLocation);
}
