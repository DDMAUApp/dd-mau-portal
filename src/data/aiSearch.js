// Client-side helper for the aiSearch Cloud Function.
//
// Posts { query, items[] } and gets back { matchingIds } — semantic
// matching via Anthropic Claude. The function call costs about
// $0.001-$0.002 per query at restaurant-scale inventory size, so
// we debounce in the consumer to avoid firing on every keystroke.
//
// Used today by InventoryListsAdmin (split-pane editor). Designed
// so it can be reused anywhere with a list of {id, name, category,
// subcat} items — recipe search, chat search, etc.

import { getFunctions, httpsCallable } from 'firebase/functions';

// Initialize the callable lazily so the import doesn't drag firebase
// functions SDK into bundles that never call aiSearch.
let _callable = null;
function getCallable() {
    if (_callable) return _callable;
    const functions = getFunctions(undefined, 'us-central1');
    _callable = httpsCallable(functions, 'aiSearch');
    return _callable;
}

// Cache previously-resolved queries so re-typing the same text
// doesn't re-bill Claude. Keyed by `${query}|${itemFingerprint}`.
// In-memory only — clears on page reload.
const CACHE = new Map();

// Compute a cheap fingerprint of an items list so cache invalidates
// when the inventory changes. We hash the ids+names; that's stable
// across renders of the same data.
function fingerprintItems(items) {
    let h = 0;
    for (const it of items) {
        const s = `${it.id}:${it.name}`;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
    }
    return String(h);
}

// Call the aiSearch Cloud Function. Returns { matchingIds: string[] }
// on success, or throws on network / API errors. Caller catches and
// falls back to substring matching.
//
// items shape: [{ id, name, category, subcat }, ...]
//   Other fields are ignored. We trim/slice on the server too.
export async function aiSearchItems({ query, items }) {
    if (!query || !query.trim() || !Array.isArray(items) || items.length === 0) {
        return { matchingIds: [] };
    }
    const trimmed = query.trim();
    const key = `${trimmed}|${fingerprintItems(items)}`;
    if (CACHE.has(key)) return CACHE.get(key);

    const callable = getCallable();
    const res = await callable({
        query: trimmed,
        items: items.map(it => ({
            id: it.id,
            name: it.name,
            category: it.category,
            subcat: it.subcat,
        })),
    });
    const data = res?.data || {};
    const out = {
        matchingIds: Array.isArray(data.matchingIds) ? data.matchingIds : [],
    };
    CACHE.set(key, out);
    // Bound the cache so it doesn't grow unbounded over a long
    // browser session.
    if (CACHE.size > 100) {
        const firstKey = CACHE.keys().next().value;
        CACHE.delete(firstKey);
    }
    return out;
}

// Convenience hook for components: debounces calls, exposes loading
// + matches + error states. Returns { loading, matchingIds, error,
// debouncedQuery } — components render based on these. Pass the
// items array stable-by-reference for best caching behavior.
//
// Usage:
//   const { loading, matchingIds, error } = useAiSearch({
//       query, items, enabled: aiOn,
//   });
import { useState, useEffect, useRef } from 'react';

export function useAiSearch({ query, items, enabled = true, debounceMs = 350 }) {
    const [loading, setLoading] = useState(false);
    const [matchingIds, setMatchingIds] = useState(null);
    const [error, setError] = useState(null);
    const reqRef = useRef(0);

    useEffect(() => {
        // Reset state immediately when the consumer disables AI or
        // clears the query — keeps stale results from lingering.
        if (!enabled || !query || !query.trim() || !Array.isArray(items) || items.length === 0) {
            setMatchingIds(null);
            setError(null);
            setLoading(false);
            return;
        }
        const myReq = ++reqRef.current;
        setLoading(true);
        setError(null);
        const t = setTimeout(async () => {
            try {
                const { matchingIds } = await aiSearchItems({ query, items });
                if (reqRef.current !== myReq) return; // stale
                setMatchingIds(matchingIds);
            } catch (e) {
                if (reqRef.current !== myReq) return;
                console.warn('aiSearch failed:', e);
                setError(e?.message || 'ai_search_failed');
                setMatchingIds(null);
            } finally {
                if (reqRef.current === myReq) setLoading(false);
            }
        }, debounceMs);
        return () => clearTimeout(t);
    }, [query, enabled, items, debounceMs]);

    return { loading, matchingIds, error };
}
