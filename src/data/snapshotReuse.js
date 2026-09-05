// snapshotReuse.js — identity-preserving snapshot mapping for churny
// scraper-fed collections (toast_orders / toast_invoices).
//
// WHY (Andrew 2026-09-05: "loading the orders and invoices are very slow
// and glitchy. after a refesh it works great but then after use its hard
// to load"): the Railway Toast scraper rewrites every one of today's
// order docs every minute (delete-then-re-insert, scraper.py
// fetch_toast_orders) and every invoice doc every 30 min (batch.set,
// fetch_toast_invoices). Each pass stamps a fresh `syncedAt`, so every
// doc arrives through onSnapshot as "modified" even when nothing the UI
// renders has changed — and a naive `snap.docs.map(...)` hands React a
// brand-new array of brand-new objects, forcing a full re-render of
// every row (each with several Intl date formats) on every pass. On a
// 200-order day that compounds into the "degrades with use" jank.
//
// reuseSnapshotDocs() rebuilds the mapped array but keeps the PREVIOUS
// object for any doc whose visible content is unchanged (ignoring
// volatile fields like syncedAt), and returns the PREVIOUS ARRAY
// IDENTITY when nothing changed at all — so `setState(prev => reuse(...))`
// bails out of the re-render entirely, and memoized row components skip
// unchanged rows when something did change.

/**
 * Deterministic deep-equality that ignores a set of top-level keys.
 * Handles the plain JSON shapes the Python scraper writes (strings,
 * numbers, booleans, null, arrays, nested objects). Firestore Timestamp
 * values compare via toMillis() defensively, though these collections
 * don't currently carry any.
 */
function valuesEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') {
        // NaN !== NaN but the same missing-number sentinel should match
        return typeof a === 'number' && Number.isNaN(a) && Number.isNaN(b);
    }
    if (typeof a.toMillis === 'function' || typeof b.toMillis === 'function') {
        try {
            return typeof a.toMillis === 'function'
                && typeof b.toMillis === 'function'
                && a.toMillis() === b.toMillis();
        } catch {
            return false;
        }
    }
    const aArr = Array.isArray(a);
    if (aArr !== Array.isArray(b)) return false;
    if (aArr) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!valuesEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!valuesEqual(a[k], b[k])) return false;
    }
    return true;
}

function docsEqualIgnoring(a, b, ignoreSet) {
    const aKeys = Object.keys(a).filter(k => !ignoreSet.has(k));
    const bKeys = Object.keys(b).filter(k => !ignoreSet.has(k));
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!valuesEqual(a[k], b[k])) return false;
    }
    return true;
}

/**
 * Map a fresh snapshot's docs onto the previous state, preserving object
 * identity for unchanged docs and array identity for unchanged lists.
 *
 * @param {Array<object>} prevDocs previous state array (each doc has .id)
 * @param {Array<object>} nextDocs freshly mapped + sorted snapshot docs
 * @param {Array<string>} ignoreKeys top-level fields to ignore when
 *        comparing (volatile stamps like syncedAt)
 * @returns {Array<object>} nextDocs with unchanged entries swapped for
 *        their previous objects; prevDocs itself if fully unchanged
 */
export function reuseSnapshotDocs(prevDocs, nextDocs, ignoreKeys = ['syncedAt']) {
    if (!Array.isArray(prevDocs) || prevDocs.length === 0) return nextDocs;
    const ignoreSet = new Set(ignoreKeys);
    const prevById = new Map();
    for (const d of prevDocs) {
        if (d && d.id != null) prevById.set(d.id, d);
    }
    let allSame = prevDocs.length === nextDocs.length;
    const out = new Array(nextDocs.length);
    for (let i = 0; i < nextDocs.length; i++) {
        const next = nextDocs[i];
        const prev = next && next.id != null ? prevById.get(next.id) : undefined;
        if (prev && docsEqualIgnoring(prev, next, ignoreSet)) {
            out[i] = prev;
            if (allSame && prevDocs[i] !== prev) allSame = false;
        } else {
            out[i] = next;
            allSame = false;
        }
    }
    return allSame ? prevDocs : out;
}
