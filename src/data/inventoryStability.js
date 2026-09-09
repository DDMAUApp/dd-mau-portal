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

// ── Snapshot admission (2026-09-09) ────────────────────────────────────────
// Which inventory-doc snapshots the listener should APPLY. Replaces two
// separate early returns in Operations.jsx that had a blind spot after a
// forced reload: with a persisted mutation queue every snapshot carries
// hasPendingWrites until the whole backlog acks, and the old unconditional
// `if (hasPendingWrites) return` ran BEFORE the cold-start allowance — so the
// sheet painted as zeros for the entire drain even though the cache already
// held the tapped counts.
//   hasPendingWrites — snapshot includes this device's un-acked writes
//   fromCache        — served from the local cache, not the server
//   serverSynced     — a server-confirmed snapshot has been applied before
//   localHasAny      — the on-screen sheet already has counts
// Rules:
//   (a) pending + (warm sheet or already synced) → skip. Byte-for-byte the
//       2026-06-30 behavior that stops a mid-burst cache echo from flickering
//       Counted/Low-filtered rows out of the list.
//   (b) fromCache + synced → skip (stale cache echo after first sync).
//   (c) otherwise apply. A COLD sheet takes its first paint from whatever
//       the cache holds — pending overlay included — because that IS the
//       device's true state. markSynced only on a clean server snapshot.
export function shouldApplyInventorySnapshot({ hasPendingWrites, fromCache, serverSynced, localHasAny }) {
    if (hasPendingWrites && (serverSynced || localHasAny)) return { apply: false, markSynced: false };
    if (fromCache && serverSynced) return { apply: false, markSynced: false };
    return { apply: true, markSynced: !fromCache && !hasPendingWrites };
}
