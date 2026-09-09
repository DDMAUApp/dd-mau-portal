// reloadStash.js — carry a page's in-memory state across a forced reload.
//
// WHY (2026-09-09, Andrew: "it keeps reconnecting and reloading the page.
// sometimes i lose what ive clicked already"): several code paths reload
// the app out from under the user — the Firestore revive watchdog's
// last-resort reload, main.jsx's crash heal, and forceRefresh (the deploy
// broadcast, the hourly version poll, the chunk-error reload, Danger Zone).
// Anything that lived only in React state (optimistic inventory counts, the
// sub-tab) vanished. This module lets a page register a snapshot function;
// those reload paths call runReloadStashes() right before reloading, and the
// page takes its stash back on mount.
//
// Deliberately dependency-free (NO firebase import) so main.jsx can use it at
// module-eval time, before the SDK exists. Every storage call is try/catch —
// a private-mode tab or a full quota just means "no stash" (today's behavior).

const PREFIX = 'ddmau:reloadStash:';
const MAX_BYTES = 200 * 1024;
export const STASH_MAX_AGE_MS = 5 * 60 * 1000;

const _stashes = new Map(); // key -> () => data

/** Register a snapshot function for `key`; returns an unregister function. */
export function registerReloadStash(key, fn) {
    if (!key || typeof fn !== 'function') return () => {};
    _stashes.set(key, fn);
    return () => { if (_stashes.get(key) === fn) _stashes.delete(key); };
}

/** Snapshot every registered page into sessionStorage. Never throws. */
export function runReloadStashes(reason = 'reload') {
    const written = [];
    for (const [key, fn] of _stashes) {
        try {
            const data = fn();
            if (data == null) continue;
            const json = JSON.stringify({ v: 1, key, reason, at: Date.now(), data });
            if (json.length > MAX_BYTES) continue; // never wedge storage with a huge blob
            sessionStorage.setItem(PREFIX + key, json);
            written.push(key);
        } catch { /* best-effort */ }
    }
    return written;
}

/** Read + delete a stash. Returns its data, or null when missing/expired/malformed. */
export function takeReloadStash(key, { maxAgeMs = STASH_MAX_AGE_MS, now = Date.now() } = {}) {
    try {
        const raw = sessionStorage.getItem(PREFIX + key);
        if (!raw) return null;
        sessionStorage.removeItem(PREFIX + key);
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== 1 || !Number.isFinite(parsed.at)) return null;
        if (now - parsed.at > maxAgeMs) return null;
        return parsed.data ?? null;
    } catch {
        return null;
    }
}

/**
 * Pure: turn an inventory stash back into the pieces Operations.jsx needs.
 * Every id that had an in-flight optimistic bump becomes an 'abs' pending
 * entry (hold the stashed value until the server shows exactly it) and is
 * flagged 'saving' so the row keeps its amber dot until confirmed.
 * Returns null when the stash is for another store or unusable.
 */
export function planStashRehydrate(stash, { loc, now = Date.now(), wiped = false } = {}) {
    if (!stash || typeof stash !== 'object') return null;
    if (!loc || stash.loc !== loc) return null;
    const counts = (stash.counts && typeof stash.counts === 'object') ? { ...stash.counts } : {};
    const countMeta = (stash.countMeta && typeof stash.countMeta === 'object') ? { ...stash.countMeta } : {};
    const pendingSrc = (stash.pendingCounts && typeof stash.pendingCounts === 'object') ? stash.pendingCounts : {};
    const pending = {};
    const savingIds = [];
    const lostIds = [];
    const lost = {};
    for (const id of Object.keys(pendingSrc)) {
        if (wiped) {
            // The crash heal destroyed the SDK mutation queue, so any tap the
            // server had NOT acked is gone. Drop the phantom values (the
            // server's numbers paint instead) and hand back {expected, mode}
            // per id: a hold can linger past its ack during a burst (every
            // snapshot carries hasPendingWrites and is skipped), so the page
            // resolves each one against the FIRST server snapshot
            // (resolveLostHolds) instead of painting "tap again" over a
            // count that already includes the tap (r3: double count).
            lostIds.push(id);
            const expected = Number(counts[id]);
            if (Number.isFinite(expected)) lost[id] = { expected, mode: pendingSrc[id] && pendingSrc[id].mode === 'inc' ? 'inc' : 'abs' };
            delete counts[id];
            delete countMeta[id];
            continue;
        }
        const expected = Number(counts[id]);
        if (!Number.isFinite(expected)) continue;
        // Keep the stashed mode: a '+' window that lands beside another
        // device's increment confirms on server >= expected; forcing 'abs'
        // would never confirm it and flag a landed write as a conflict.
        pending[id] = { expected, ts: now, mode: pendingSrc[id] && pendingSrc[id].mode === 'inc' ? 'inc' : 'abs' };
        savingIds.push(id);
    }
    // The last remote-clear marker this device had applied. Seeding it back
    // keeps the listener's "remote clear advanced?" check honest after a
    // reload: the doc's stored clearedAt is NOT new, so the rehydrated holds
    // survive — while a clear that really happened during the reload gap
    // (a different clearedAt) still wins and drops them.
    return { counts, countMeta, pending, savingIds, lostIds, lost, subTab: stash.subTab || null, clearedAt: stash.clearedAt ?? null };
}

/**
 * Pure: after a WIPED rehydrate, decide per lost hold whether the server
 * already carries the tap (same rule as reconcileCounts: 'inc' landed when
 * server >= expected, 'abs' when server === expected). Missing server
 * value counts as 0.
 */
export function resolveLostHolds(lost, serverCounts) {
    const landedIds = [];
    const lostIds = [];
    if (!lost || typeof lost !== 'object') return { landedIds, lostIds };
    const src = (serverCounts && typeof serverCounts === 'object') ? serverCounts : {};
    for (const id of Object.keys(lost)) {
        const h = lost[id];
        const expected = Number(h && h.expected);
        if (!Number.isFinite(expected)) continue;
        const server = Number(src[id]);
        const have = Number.isFinite(server) ? server : 0;
        const landed = h.mode === 'inc' ? have >= expected : have === expected;
        (landed ? landedIds : lostIds).push(id);
    }
    return { landedIds, lostIds };
}

/** Read a stash WITHOUT consuming it (null when missing/expired/malformed). */
export function peekReloadStash(key, { maxAgeMs = STASH_MAX_AGE_MS, now = Date.now() } = {}) {
    try {
        const raw = sessionStorage.getItem(PREFIX + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== 1 || !Number.isFinite(parsed.at)) return null;
        if (now - parsed.at > maxAgeMs) return null;
        return parsed.data ?? null;
    } catch {
        return null;
    }
}

export function clearReloadStash(key) {
    try { sessionStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}

/** The record's metadata ({ reason, at }) without consuming it, or null. */
export function peekReloadStashMeta(key) {
    try {
        const raw = sessionStorage.getItem(PREFIX + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== 1) return null;
        return { reason: parsed.reason || null, at: parsed.at || null };
    } catch {
        return null;
    }
}

