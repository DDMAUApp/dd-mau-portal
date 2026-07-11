// The ONE write path for the /config/staff roster doc.
//
// 2026-07-11 — Andrew's staff renames REVERTED overnight, and later the
// same day an active staffer (Emma Castro) was misnamed and deleted.
// Root causes, in order of discovery:
//   1. The v1.0.227 lastSignInAt/pwaInstalled stamps did a plain
//      getDoc → modify → setDoc of the WHOLE list from every phone at
//      sign-in — a classic read-modify-write race that wrote stale
//      rosters back over admin edits.
//   2. A survey of ALL roster writers found 19 of them, 7 of which
//      never bumped the `rev` counter — and several used
//      tx.set(ref, {list}) with no merge, which silently DELETED the
//      rev field, disarming the concurrent-edit guard entirely.
//   3. Admin saves wrote a whole 60+ person list built from CLIENT
//      state, so any staleness was amplified into a full-roster
//      clobber.
//
// The rules now (enforced by this module + firestore.rules):
//   • Every roster write goes through mutateStaffList (or a helper
//     built on it). The mutation is applied to the SERVER list inside
//     a transaction — client state is never written wholesale.
//   • Every write bumps the monotonic `rev` counter. firestore.rules
//     rejects any config/staff update whose rev isn't an int greater
//     than the current one, so old app bundles and rev-forgetting
//     writers are blocked AT THE DATABASE.
//   • List invariants are validated centrally on every write: unique
//     names (case-insensitive), unique ids, unique 4-digit PINs,
//     non-empty names. No code path can recreate the duplicate-name
//     identity collapse.
//   • Removal archives the record and removes it in ONE transaction —
//     a deletion can never lose the record, and a restore atomically
//     marks the archive entry.
//
// STAFF_DOC.rev is a module singleton fed by App.jsx's /config/staff
// onSnapshot — it holds the rev of the roster the UI currently shows.
// `undefined` = no snapshot yet this session.

export const STAFF_DOC = { rev: undefined };

export function noteStaffSnapshot(data) {
    STAFF_DOC.rev = (data && typeof data.rev === 'number') ? data.rev : null;
}

// Next revision value for a transactional write, given the doc data
// the transaction just read.
export function nextStaffRev(data) {
    const cur = (data && typeof data.rev === 'number') ? data.rev : 0;
    return cur + 1;
}

function rosterError(code, detail) {
    const e = new Error(code);
    e.code = code;
    e.detail = detail;
    return e;
}

// Pure core — apply a mutation to a roster list and validate the
// result. Exported for unit tests; the txn wrapper below is thin.
//
// mutate: (list) => null            → no-op (nothing to change)
//                 | nextList        → the new list
//                 | {list, result}  → new list + a value handed back
//                                     to the caller (assigned ids,
//                                     removed record, counts, …)
//
// Throws rosterError on invariant violations:
//   empty_list, bad_record, empty_name, name_exists, dup_id,
//   invalid_pin (detail = offending name), dup_pin.
// Returns { noop, list, changed, result } where changed is
// [{before, after}] — before null = added, after null = removed.
export function applyRosterMutation(data, mutate) {
    const list = (data && data.list) || [];
    const res = mutate(list);
    if (res == null) return { noop: true, list, changed: [] };
    const nextList = Array.isArray(res) ? res : res.list;
    const result = Array.isArray(res) ? undefined : res.result;
    if (!Array.isArray(nextList) || nextList.length === 0) {
        // An empty roster is never a legitimate client write — losing
        // the list is exactly the failure mode this module prevents.
        throw rosterError('empty_list');
    }
    const seenIds = new Set();
    const seenNames = new Set();
    const seenPins = new Set();
    for (const s of nextList) {
        if (!s || typeof s !== 'object') throw rosterError('bad_record');
        const nm = String(s.name || '').trim();
        if (!nm) throw rosterError('empty_name');
        const nameKey = nm.toLowerCase();
        if (seenNames.has(nameKey)) throw rosterError('name_exists', nm);
        seenNames.add(nameKey);
        const idKey = String(s.id);
        if (s.id == null || seenIds.has(idKey)) throw rosterError('dup_id', nm);
        seenIds.add(idKey);
        const pin = String(s.pin ?? '').trim();
        if (!/^\d{4}$/.test(pin)) throw rosterError('invalid_pin', nm);
        if (seenPins.has(pin)) throw rosterError('dup_pin', nm);
        seenPins.add(pin);
    }
    // Diff by id + reference. Mutators use map()+spread, so untouched
    // records keep their identity and the diff is cheap and exact.
    const byId = new Map(list.map(s => [String(s?.id), s]));
    const changed = [];
    for (const s of nextList) {
        const before = byId.get(String(s.id));
        if (!before) changed.push({ before: null, after: s });
        else if (before !== s) changed.push({ before, after: s });
    }
    const nextIds = new Set(nextList.map(s => String(s.id)));
    for (const s of list) {
        if (!nextIds.has(String(s?.id))) changed.push({ before: s, after: null });
    }
    if (changed.length === 0) return { noop: true, list, changed: [] };
    return { noop: false, list: nextList, changed, result };
}

// Run a roster mutation in a transaction against the SERVER list.
// Returns:
//   { ok:true, noop:true, list }                          nothing changed
//   { ok:true, noop:false, list, changed, result }        written
//   { ok:false, error, detail }                           error codes:
//       no_doc | empty_list | empty_name | name_exists | dup_id |
//       invalid_pin | dup_pin | not_found | <firestore message>
export async function mutateStaffList(mutate) {
    try {
        const { doc, runTransaction } = await import('firebase/firestore');
        const { db } = await import('../firebase');
        let out = null;
        await runTransaction(db, async (tx) => {
            const ref = doc(db, 'config', 'staff');
            const snap = await tx.get(ref);
            if (!snap.exists()) throw rosterError('no_doc');
            const data = snap.data() || {};
            const applied = applyRosterMutation(data, mutate);
            if (applied.noop) {
                out = { ok: true, noop: true, list: applied.list, changed: [] };
                return;
            }
            tx.set(ref, { list: applied.list, rev: nextStaffRev(data) });
            out = { ok: true, noop: false, list: applied.list, changed: applied.changed, result: applied.result };
        });
        return out;
    } catch (e) {
        return { ok: false, error: e?.code || e?.message || 'write_failed', detail: e?.detail };
    }
}

// Patch ONE record found by exact name. patch may be an object to
// merge or a function (record) => nextRecord. Missing name or an
// identical result is a clean no-op.
export async function patchStaffRecordByName(name, patch) {
    return mutateStaffList((list) => {
        const idx = list.findIndex(s => s && s.name === name);
        if (idx === -1) return null;
        const before = list[idx];
        const after = typeof patch === 'function' ? patch(before) : { ...before, ...patch };
        if (!after || after === before) return null;
        const next = [...list];
        next[idx] = after;
        return next;
    });
}

// Pick a PIN for a new/restored record: keep `preferred` if it's a
// valid 4-digit PIN nobody on the list holds, else generate a random
// unused one.
function assignPin(list, preferred) {
    const used = new Set(list.map(s => String(s?.pin ?? '').trim()));
    const pref = String(preferred ?? '').trim();
    if (/^\d{4}$/.test(pref) && !used.has(pref)) return { pin: pref, changed: false };
    let pin;
    do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (used.has(pin));
    return { pin, changed: true };
}

// Append ONE new staff record, race-safely. Used by the Onboarding
// "Add to Staff" button, admin Add Staff, and archive Restore.
//   name            required, must be unique (case-insensitive)
//   record          extra fields for the record (id/pin overridden)
//   preferredPin    keep this PIN if valid + unused (restore flow);
//                   otherwise a random unused PIN is generated
//   restoreArchiveId + restoredBy — when set, the /staff_archive doc
//                   is marked restored IN THE SAME transaction
// Returns { ok:true, id, pin, pinChanged } or { ok:false, error }
// where error is 'no_name' | 'name_exists' | 'no_doc' | ...
export async function appendStaffRecord({ name, record = {}, preferredPin = null, restoreArchiveId = null, restoredBy = null }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { ok: false, error: 'no_name' };
    try {
        const { doc, runTransaction, serverTimestamp } = await import('firebase/firestore');
        const { db } = await import('../firebase');
        let assigned = null;
        await runTransaction(db, async (tx) => {
            const ref = doc(db, 'config', 'staff');
            const snap = await tx.get(ref);
            if (!snap.exists()) throw rosterError('no_doc');
            const data = snap.data() || {};
            const list = data.list || [];
            if (list.some(s => String(s?.name || '').trim().toLowerCase() === trimmed.toLowerCase())) {
                throw rosterError('name_exists', trimmed);
            }
            const maxId = list.reduce((m, s) => Math.max(m, Number(s?.id) || 0), 0);
            const { pin, changed: pinChanged } = assignPin(list, preferredPin);
            assigned = { id: maxId + 1, pin, pinChanged };
            const applied = applyRosterMutation(data, (l) => [
                ...l,
                { ...record, name: trimmed, id: assigned.id, pin },
            ]);
            tx.set(ref, { list: applied.list, rev: nextStaffRev(data) });
            if (restoreArchiveId) {
                tx.update(doc(db, 'staff_archive', restoreArchiveId), {
                    restored: true,
                    restoredAt: serverTimestamp(),
                    restoredBy: restoredBy || 'admin',
                });
            }
        });
        return { ok: true, ...assigned };
    } catch (e) {
        return { ok: false, error: e?.code || e?.message || 'failed' };
    }
}

// Remove ONE staff record by id — archive snapshot + roster removal
// in a single ATOMIC transaction. Either both happen or neither does,
// so a deletion can never lose the person's record.
// Returns { ok:true, removed, archiveId, list } or { ok:false, error }
// (error 'not_found' = already gone — treat as success upstream).
export async function removeStaffRecord({ id, byName }) {
    try {
        const { doc, collection, runTransaction, serverTimestamp } = await import('firebase/firestore');
        const { db } = await import('../firebase');
        let out = null;
        await runTransaction(db, async (tx) => {
            const ref = doc(db, 'config', 'staff');
            const snap = await tx.get(ref);
            if (!snap.exists()) throw rosterError('no_doc');
            const data = snap.data() || {};
            const list = data.list || [];
            const person = list.find(s => s && s.id === id);
            if (!person) throw rosterError('not_found');
            const applied = applyRosterMutation(data, (l) => l.filter(s => s.id !== id));
            // JSON round-trip strips `undefined` values, which Firestore
            // rejects (same as staffArchive.js).
            const record = JSON.parse(JSON.stringify(person));
            const archiveRef = doc(collection(db, 'staff_archive'));
            tx.set(archiveRef, {
                name: person.name,
                staffId: person.id ?? null,
                record,
                archivedAt: serverTimestamp(),
                archivedBy: byName || 'admin',
                restored: false,
            });
            tx.set(ref, { list: applied.list, rev: nextStaffRev(data) });
            out = { ok: true, removed: person, archiveId: archiveRef.id, list: applied.list };
        });
        return out;
    } catch (e) {
        return { ok: false, error: e?.code || e?.message || 'failed' };
    }
}
