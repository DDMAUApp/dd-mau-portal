// inventoryStability.js — pure decision helpers for the inventory-cart
// "don't let a glitchy snapshot wipe the list" stability guard used in
// Operations.jsx's Firestore snapshot handler.
//
// Extracted from the component (2026-07-14) so the EXACT behavior that keeps a
// staff member's in-progress inventory list from disappearing is locked in by
// unit tests and can never silently regress. See project_operations_audit +
// project_auto_refresh_deploy memories for the history ("it keeps deleting the
// list they make but then it comes back — make it stable").

// True if any counts map passed in has at least one positive quantity.
// Accepts multiple maps (e.g. master `counts` + `vendorCounts`).
export function hasAnyCount(...maps) {
    for (const m of maps) {
        if (m && typeof m === 'object') {
            for (const k in m) {
                if (Number(m[k]) > 0) return true;
            }
        }
    }
    return false;
}

// A real clear on ANOTHER device stamps a NEW `clearedAt` timestamp on the ops
// doc. This is "advanced" (i.e. authoritative) when the incoming clearedAt
// exists AND differs from the last one this device already applied. A transient
// flicker snapshot carries the same-or-missing clearedAt → not advanced.
export function isRemoteClearAdvanced(incomingClearedAt, lastAppliedClearedAt) {
    return !!incomingClearedAt && incomingClearedAt !== lastAppliedClearedAt;
}

// THE guard: should this incoming snapshot be IGNORED because applying it would
// wipe a non-empty cart that's currently on screen?
//   incomingHasAny      — the snapshot has >=1 counted item
//   localHasAny         — the on-screen cart currently has >=1 counted item
//   recentlyCleared     — THIS device pressed Save&Reset / Clear within ~15s
//   remoteClearAdvanced — a genuine clear from another device (see above)
// Ignore ONLY when the snapshot is empty, we still have items, and neither a
// local nor a real remote clear explains the emptiness — i.e. it's a transient
// / stale / offline-cache blip. In every other case the snapshot is applied
// normally (so real edits, real clears, and normal loads all go through).
export function shouldIgnoreInventorySnapshot({ incomingHasAny, localHasAny, recentlyCleared, remoteClearAdvanced }) {
    return !incomingHasAny && localHasAny && !recentlyCleared && !remoteClearAdvanced;
}
