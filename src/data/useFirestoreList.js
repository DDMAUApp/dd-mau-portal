// useFirestoreList — shared React hook for Firestore live-subscriptions
// with loading / error / retry built in.
//
// Andrew 2026-05-27 — extracted from the chat-loading-bug fix. Every
// onSnapshot in the codebase (~119 call sites) had the same
// boilerplate, and every component reinvented its own loading/error
// UI from scratch. Worse: most error handlers were silent
// console.warn so a transient permission-denied or network failure
// killed the listener with no UI signal. This hook is the canonical
// way to subscribe going forward.
//
// What you get from one call:
//   • `data`     — the list of decoded docs (id + spread data)
//   • `loading`  — true until the first snapshot resolves
//   • `error`    — string code on failure, null on success
//   • `retry()`  — bump a regen counter to force-resubscribe
//   • `refresh()`— alias for retry, semantically clearer for
//                  manual pull-to-refresh callers
//
// Usage:
//   const { data: chats, loading, error, retry } = useFirestoreList(
//       () => query(collection(db, 'chats'),
//                   where('members', 'array-contains', staffName),
//                   orderBy('lastActivityAt', 'desc'),
//                   limit(100)),
//       [staffName],  // deps — when these change, re-subscribe
//       { timeoutMs: 6000, label: 'chats' }
//   );
//
// IMPORTANT: pass the query as a FACTORY (() => query(...)) not as a
// direct query object. Firestore query objects don't have stable
// reference equality and would re-fire the subscription on every
// render. The factory closes over your deps and only re-runs when
// the dep array changes.
//
// When the deps include a value that's NOT YET READY (null/undefined/
// empty string), return null from the factory to skip subscription
// entirely. The hook treats null as "not ready" and stays in loading
// state without firing any query.
//
// All log writes from this hook go through src/data/logger.js so
// errors are visible in Sentry + the Error Report dashboard.

import { useEffect, useState, useCallback, useRef } from 'react';
import { onSnapshot } from 'firebase/firestore';
import { logError } from './logger';

// Default snapshot timeout — 6 seconds. Tuned for restaurant Wi-Fi
// on a packed Friday night. Callers can override per-subscription
// via opts.timeoutMs. If you have a query that's genuinely slow
// (large historical scan), bump it.
const DEFAULT_TIMEOUT_MS = 6000;

/**
 * @param {() => import('firebase/firestore').Query | null} queryFactory
 *   Function returning a Firestore Query. Return null to skip
 *   subscription when deps aren't ready.
 * @param {any[]} deps  React-style deps array. Re-subs when these change.
 * @param {object} [opts]
 * @param {number}  [opts.timeoutMs=6000]   Surface error if first snapshot doesn't land within this window.
 * @param {string}  [opts.label='unknown']  Used in error_logs + Sentry tags for diagnosis.
 * @param {string}  [opts.feature]          Feature tag for logError (defaults to label).
 * @param {(docs:any[]) => any[]} [opts.transform] Pure post-processing applied before setData (e.g. sort).
 *
 * @returns {{ data: any[], loading: boolean, error: string|null, retry: () => void, refresh: () => void }}
 */
export function useFirestoreList(queryFactory, deps, opts = {}) {
    const {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        label = 'unknown',
        feature,
        transform,
    } = opts;

    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [regen, setRegen] = useState(0);

    // Track whether the hook is still mounted. Avoids setState-after-
    // unmount warnings when a subscription's first snapshot arrives
    // after the component has already left the tree (common when the
    // user fast-taps between tabs).
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // Stable retry handler — bumps `regen` so the subscription effect
    // re-runs with a fresh listener. The fresh-listener path is
    // important because Firestore's snapshot listener doesn't itself
    // expose a "reconnect" affordance; the only way to recover from a
    // dead listener is unsub + new onSnapshot.
    const retry = useCallback(() => {
        setError(null);
        setLoading(true);
        setRegen((g) => g + 1);
    }, []);

    useEffect(() => {
        const q = queryFactory();
        if (q == null) {
            // Deps aren't ready (e.g. staffName is still null). Stay
            // in loading state without subscribing. The effect will
            // re-run when deps change and the factory returns a real
            // query.
            return;
        }

        // Reset state on every (re-)subscription so the hook never
        // leaves stale data from a previous query in place.
        setLoading(true);
        setError(null);

        // Safety-net timeout. If we don't hear back from Firestore
        // within timeoutMs, surface a 'timeout' error so the caller
        // can show a retry button instead of an indefinite spinner.
        // Cleared as soon as the first snapshot lands (success OR
        // recoverable error).
        const timeoutId = setTimeout(() => {
            if (!mountedRef.current) return;
            setError((prev) => prev || 'timeout');
            setLoading(false);
            // We DO log timeouts to /error_logs (severity=warn) so
            // patterns are visible in the Error Report dashboard.
            // Use feature || label so the dashboard groups them.
            try {
                logError({
                    error: new Error(`useFirestoreList timeout: ${label}`),
                    severity: 'warn',
                    feature: feature || label,
                    meta: { kind: 'firestore-timeout', timeoutMs },
                });
            } catch {}
        }, timeoutMs);

        const unsub = onSnapshot(
            q,
            (snap) => {
                clearTimeout(timeoutId);
                if (!mountedRef.current) return;
                const list = [];
                snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
                const next = typeof transform === 'function'
                    ? transform(list)
                    : list;
                setData(next);
                setLoading(false);
                setError(null);
            },
            (err) => {
                clearTimeout(timeoutId);
                if (!mountedRef.current) return;
                // The pattern we're replacing: silent console.warn.
                // Now: surface to error state (caller shows retry UI),
                // log to /error_logs (Sentry-visible), keep listener
                // closed so the user has to retry — Firestore's
                // snapshot listener can't recover from auth/rules
                // errors without a fresh subscription.
                const code = err?.code || err?.message || 'load-failed';
                // eslint-disable-next-line no-console
                console.warn(`[useFirestoreList:${label}] subscription failed:`, err);
                setError(code);
                setLoading(false);
                try {
                    logError({
                        error: err instanceof Error ? err : new Error(String(err)),
                        severity: 'error',
                        feature: feature || label,
                        meta: { kind: 'firestore-subscribe-error', code },
                    });
                } catch {}
            },
        );

        return () => {
            clearTimeout(timeoutId);
            try { unsub(); } catch {}
        };
        // queryFactory + transform are intentionally NOT in the deps
        // array. Callers pass them as inline functions which would
        // change identity on every render → infinite re-subscription
        // loop. We trust the deps array to express what should trigger
        // a re-sub. eslint-disable below documents this choice.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...(deps || []), regen]);

    return { data, loading, error, retry, refresh: retry };
}

/**
 * Companion: useFirestoreDoc — same pattern but for a single doc
 * subscription. Convenience for the (rarer) cases where you want
 * to subscribe to one specific document.
 *
 * @param {() => import('firebase/firestore').DocumentReference | null} docRefFactory
 * @param {any[]} deps
 * @param {object} [opts]
 * @returns {{ data: object|null, loading: boolean, error: string|null, retry: () => void, refresh: () => void, exists: boolean }}
 */
export function useFirestoreDoc(docRefFactory, deps, opts = {}) {
    const {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        label = 'unknown',
        feature,
    } = opts;

    const [data, setData] = useState(null);
    const [exists, setExists] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [regen, setRegen] = useState(0);

    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const retry = useCallback(() => {
        setError(null);
        setLoading(true);
        setRegen((g) => g + 1);
    }, []);

    useEffect(() => {
        const ref = docRefFactory();
        if (ref == null) return;

        setLoading(true);
        setError(null);

        const timeoutId = setTimeout(() => {
            if (!mountedRef.current) return;
            setError((prev) => prev || 'timeout');
            setLoading(false);
            try {
                logError({
                    error: new Error(`useFirestoreDoc timeout: ${label}`),
                    severity: 'warn',
                    feature: feature || label,
                    meta: { kind: 'firestore-doc-timeout', timeoutMs },
                });
            } catch {}
        }, timeoutMs);

        const unsub = onSnapshot(
            ref,
            (snap) => {
                clearTimeout(timeoutId);
                if (!mountedRef.current) return;
                if (snap.exists()) {
                    setData({ id: snap.id, ...snap.data() });
                    setExists(true);
                } else {
                    setData(null);
                    setExists(false);
                }
                setLoading(false);
                setError(null);
            },
            (err) => {
                clearTimeout(timeoutId);
                if (!mountedRef.current) return;
                const code = err?.code || err?.message || 'load-failed';
                // eslint-disable-next-line no-console
                console.warn(`[useFirestoreDoc:${label}] subscription failed:`, err);
                setError(code);
                setLoading(false);
                try {
                    logError({
                        error: err instanceof Error ? err : new Error(String(err)),
                        severity: 'error',
                        feature: feature || label,
                        meta: { kind: 'firestore-doc-subscribe-error', code },
                    });
                } catch {}
            },
        );

        return () => {
            clearTimeout(timeoutId);
            try { unsub(); } catch {}
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...(deps || []), regen]);

    return { data, exists, loading, error, retry, refresh: retry };
}
