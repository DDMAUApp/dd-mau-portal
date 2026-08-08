// Firestore connection watchdog — recover a wedged SDK without a refresh.
//
// ⚠ WHY THIS EXISTS (2026-08-08, Andrew): "delete a shift times out",
// "when i add a shift it doesnt respond until i refresh the app",
// "the money counter keeps timing out". One root cause: when iOS/Android
// suspends the WebView, Firestore's transport socket dies. On resume the
// SDK can stay WEDGED — it believes it's online, so writes queue forever
// (addDoc/deleteDoc awaits never resolve → buttons hang) and snapshot
// listeners stop ticking (changes invisible until refresh). A refresh
// "fixes" it only because it rebuilds the SDK. The error_logs
// `useFirestoreDoc timeout` warnings are the same disease.
//
// The recovery is the SDK's own documented escape hatch: cycling
// disableNetwork() → enableNetwork() tears down the dead transport and
// dials a fresh one. Queued writes flush immediately after — nothing is
// lost, the hung awaits RESOLVE, and listeners resume. We trigger it two
// ways:
//
//   1. installFirestoreRevive() — on app resume (Capacitor appStateChange
//      / visibilitychange) after being backgrounded PAST the threshold,
//      cycle proactively. iOS kills idle sockets after ~30s of suspend,
//      so a long-backgrounded app is presumed wedged.
//
//   2. watchdogWrite(promise) — wrap a user-facing write; if it hasn't
//      settled within WRITE_HANG_MS the transport is presumed dead and we
//      cycle. The original promise then resolves on its own once the
//      queued write flushes — callers need no changes beyond the wrap.
//
// Both are throttled through the same gate so bursts (5 hung writes at
// once) collapse into ONE cycle. Everything is fail-soft: a failed cycle
// only logs — it can never break a page.

import { disableNetwork, enableNetwork } from 'firebase/firestore';
import { db } from '../firebase';

// Backgrounded longer than this ⇒ assume the socket died (iOS suspends
// sockets after ~30s; 45s adds margin so quick app-switches skip the cycle).
export const RESUME_STALE_MS = 45 * 1000;
// A healthy Firestore write acks in <2s even on store Wi-Fi. 8s without
// settling means the transport is gone, not slow.
export const WRITE_HANG_MS = 8 * 1000;
// Min gap between cycles — a cycle takes ~1s; re-cycling mid-reconnect
// would just tear down the fresh transport we're waiting on.
export const REVIVE_COOLDOWN_MS = 15 * 1000;

let _lastReviveAt = 0;
let _reviving = false;

/**
 * Tear down and re-dial the Firestore transport. Throttled + reentrancy-
 * guarded; safe to call speculatively. Resolves true if a cycle ran.
 */
export async function reviveFirestore(reason = 'manual') {
    const now = Date.now();
    if (_reviving) return false;
    if (now - _lastReviveAt < REVIVE_COOLDOWN_MS) return false;
    _reviving = true;
    _lastReviveAt = now;
    try {
        // eslint-disable-next-line no-console
        console.info(`[firestoreRevive] cycling network (${reason})`);
        await disableNetwork(db);
        await enableNetwork(db);
        return true;
    } catch (e) {
        console.warn('[firestoreRevive] cycle failed (non-fatal):', e?.message || e);
        return false;
    } finally {
        _reviving = false;
    }
}

/**
 * Wrap a Firestore write promise. If it hasn't settled in `hangMs`,
 * trigger a revive — the queued write then flushes over the fresh
 * transport and the ORIGINAL promise resolves. Returns the original
 * promise unchanged (same value, same rejection), so call sites keep
 * their exact semantics:   await watchdogWrite(addDoc(...))
 */
export function watchdogWrite(promise, hangMs = WRITE_HANG_MS) {
    let settled = false;
    const timer = setTimeout(() => {
        if (!settled) reviveFirestore('slow-write');
    }, hangMs);
    // Attach via then() so we neither swallow rejections nor create an
    // unhandled-rejection duplicate (errors still flow to the caller).
    promise.then(
        () => { settled = true; clearTimeout(timer); },
        () => { settled = true; clearTimeout(timer); },
    );
    return promise;
}

/**
 * Install the resume-triggered revive. Call ONCE at app startup.
 * Listens on both channels because neither alone covers everything:
 * visibilitychange misses the iOS suspend case (the WebView is frozen,
 * the hidden event may never commit); Capacitor appStateChange only
 * exists on native.
 */
export function installFirestoreRevive() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    let hiddenAt = null;

    const onHide = () => { if (hiddenAt == null) hiddenAt = Date.now(); };
    const onShow = () => {
        const was = hiddenAt;
        hiddenAt = null;
        if (was != null && Date.now() - was > RESUME_STALE_MS) {
            reviveFirestore('resume');
        }
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') onHide();
        else onShow();
    });

    // Native suspend/resume — same pattern App.jsx uses for the idle lock.
    (async () => {
        try {
            if (!window.Capacitor?.isNativePlatform?.()) return;
            const { App: CapApp } = await import('@capacitor/app');
            await CapApp.addListener('appStateChange', ({ isActive }) => {
                if (isActive) onShow();
                else onHide();
            });
        } catch { /* plugin unavailable — web path already covers it */ }
    })();
}
