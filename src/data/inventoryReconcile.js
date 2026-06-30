// inventoryReconcile.js — reconcile a server counts snapshot against
// still-in-flight optimistic +/- bumps so a stale snapshot can't visibly
// undo a count the user just changed.
//
// Background (2026-06-30). The inventory page applies count taps optimistically
// (local state bumps instantly) and writes to Firestore. A realtime snapshot can
// arrive that is STALE for an item the user just bumped — e.g. a server read that
// hasn't yet applied every increment from a rapid burst. Naively doing
// `setInventory(snapshot.counts)` then makes the count flicker back down ("the
// item disappears and comes back a few seconds later"). Two earlier attempts tried
// to DETECT-and-SKIP the bad snapshot, which is brittle. This makes the merge
// TOLERANT instead: for any item with an outstanding optimistic bump, keep showing
// the value we wrote until the server confirms it (or a timeout elapses).
//
// `pending` shape: { [itemId]: { expected:number, ts:number(ms), mode:'inc'|'abs' } }
//   'inc'  — the + button, written via FieldValue.increment. Release as soon as the
//            server value is >= expected: a concurrent device can only push the count
//            higher than our own contribution, never below it.
//   'abs'  — text entry and the − button, written as a clamped absolute value.
//            Release only on an exact server match.
// Both modes also release after RELEASE_TIMEOUT_MS as a safety valve so a genuinely
// failed or conflicting write can never pin a wrong value forever.

export const RELEASE_TIMEOUT_MS = 12000;

/**
 * @param {Object<string,number>} serverCounts  counts from the Firestore snapshot
 * @param {Object<string,{expected:number,ts:number,mode:'inc'|'abs'}>} pending
 *        in-flight optimistic bumps. MUTATED IN PLACE: confirmed/expired entries
 *        are deleted so they release on the next snapshot.
 * @param {number} now  epoch ms (pass Date.now()); injectable for tests
 * @returns {Object<string,number>} the counts map to actually display
 */
export function reconcileCounts(serverCounts, pending, now) {
    const src = serverCounts || {};
    const ids = pending ? Object.keys(pending) : [];
    if (ids.length === 0) return src;
    const merged = { ...src };
    for (const id of ids) {
        const p = pending[id];
        const s = Number(src[id] || 0);
        const expired = now - p.ts > RELEASE_TIMEOUT_MS;
        const confirmed = p.mode === 'inc' ? s >= p.expected : s === p.expected;
        if (expired || confirmed) {
            delete pending[id]; // server caught up (or we gave up) — let the server value win
        } else {
            merged[id] = p.expected; // hold the user's value; this snapshot is stale for this item
        }
    }
    return merged;
}
