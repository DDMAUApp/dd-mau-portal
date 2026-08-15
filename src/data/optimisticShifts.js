// Optimistic overlay for shift edits (2026-08-15, schedule perf forensics S1).
//
// WHY: every shift edit/move goes through `runTransaction` (Phase F drift
// checks). Firestore transactions have NO latency compensation — nothing
// changes on screen until the server commits and the listener echoes it, so
// on store Wi-Fi a time edit "does nothing" for 300 ms – 2 s and the editor
// sits busy the whole time. That is the "edits lag / inconsistent" feel.
//
// HOW: the handler applies the intended patch to the local `shifts` array
// immediately and records it here. Every incoming snapshot is re-overlaid so
// a *different* doc's echo (or a cache-first emit) can't visually revert the
// edit while the transaction is in flight. An entry drops out as soon as a
// snapshot already reflects the patch (server truth caught up), is reverted
// on transaction failure, and self-expires so a hung write can't pin stale
// pixels forever (the watchdog toast/reload covers that case anyway).
//
// Pure functions over a caller-owned Map so they're unit-testable and usable
// from any page with the same "transaction + listener" shape.

export const OPTIMISTIC_TTL_MS = 20000;

const same = (a, b) => {
    if (a === b) return true;
    if (a == null && b == null) return true; // null vs undefined
    return false;
};

/** Record a patch and return the new array with it applied. */
export function applyOptimistic(map, shifts, shiftId, patch, now = Date.now()) {
    const cur = shifts.find(s => s.id === shiftId);
    if (!cur) return shifts;
    const before = {};
    for (const k of Object.keys(patch)) before[k] = cur[k];
    const prev = map.get(shiftId);
    // Stack on an earlier un-settled patch: keep the ORIGINAL before-values so
    // a revert restores what the user actually started from.
    map.set(shiftId, { patch: { ...(prev?.patch || {}), ...patch }, before: { ...before, ...(prev?.before || {}) }, at: now });
    return shifts.map(s => (s.id === shiftId ? { ...s, ...patch } : s));
}

/** Drop the entry and return the array with the original values restored. */
export function revertOptimistic(map, shifts, shiftId) {
    const e = map.get(shiftId);
    map.delete(shiftId);
    if (!e) return shifts;
    return shifts.map(s => (s.id === shiftId ? { ...s, ...e.before } : s));
}

/** Re-apply live entries on top of a fresh snapshot; settle satisfied/expired ones. */
export function overlayOptimistic(map, items, now = Date.now()) {
    if (!map || map.size === 0) return items;
    const seen = new Set();
    const out = items.map(s => {
        const e = map.get(s.id);
        if (!e) return s;
        seen.add(s.id);
        const satisfied = Object.keys(e.patch).every(k => same(s[k], e.patch[k]));
        if (satisfied || now - e.at > OPTIMISTIC_TTL_MS) { map.delete(s.id); return s; }
        return { ...s, ...e.patch };
    });
    // Entries whose shift vanished from the window (deleted, or moved out of
    // the viewed week by someone else) are meaningless — drop them.
    for (const id of [...map.keys()]) if (!seen.has(id)) map.delete(id);
    return out;
}
