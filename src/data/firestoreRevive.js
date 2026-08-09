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
// After a revive, give the flush this long. Still unsettled ⇒ the wedge is
// BELOW the network layer (iOS kills the IndexedDB connection during
// suspend — writes then can't even enter the local queue, and cycling the
// network can't fix that; only a reload can, which is why Andrew's manual
// refresh "works"). Escalate to the reload FOR him.
export const WRITE_ESCALATE_MS = 10 * 1000;
// At most one automatic reload per window — a persistent backend outage
// must degrade to error toasts, never a reload loop.
export const RELOAD_GUARD_MS = 2 * 60 * 1000;
const RELOAD_GUARD_KEY = 'ddmau:reviveReloadAt';

// Reload seam — swapped out by tests; jsdom's location.reload is not
// stubbable.
let _reloadImpl = () => { try { window.location.reload(); } catch { /* ignore */ } };
export function __setReloadImplForTests(fn) { _reloadImpl = fn; }

/**
 * Last-resort self-heal: the same thing the user does by hand when a
 * button spins forever. sessionStorage-guarded so it can never loop.
 * Returns true if a reload was actually triggered.
 */
export function escalateReload(reason = 'write-stuck') {
    try {
        const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
        if (Date.now() - last < RELOAD_GUARD_MS) return false;
        sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch { /* storage broken — still reload; worst case iOS re-suspends */ }
    console.warn(`[firestoreRevive] write still stuck after revive (${reason}) — reloading app to rebuild the SDK`);
    _reloadImpl();
    return true;
}
// A healthy Firestore write acks in <2s even on store Wi-Fi. 8s without
// settling means the transport is gone, not slow.
export const WRITE_HANG_MS = 8 * 1000;
// Min gap between cycles — a cycle takes ~1s; re-cycling mid-reconnect
// would just tear down the fresh transport we're waiting on.
export const REVIVE_COOLDOWN_MS = 15 * 1000;

let _lastReviveAt = 0;
let _reviving = false;

// ── In-flight write tracking (stabilization Phase E) ───────────────────
// Every watchdogged write increments a counter; the SyncPill subscribes
// and shows "Saving…" once a write has been airborne past a short delay.
// `stuck` counts writes past WRITE_HANG_MS (revive already fired) — the
// pill flips amber so a wedged transport LOOKS like reconnecting instead
// of a dead button. Pure module state; no React dependency.
let _inFlight = 0;
let _stuck = 0;
const _writeSubs = new Set();

function _notifyWriteSubs() {
    const snapshot = { inFlight: _inFlight, stuck: _stuck };
    _writeSubs.forEach((cb) => { try { cb(snapshot); } catch { /* subscriber's problem */ } });
}

/**
 * Subscribe to {inFlight, stuck} counts of watchdogged writes. Calls back
 * immediately with the current state; returns an unsubscribe function.
 */
export function subscribeInFlightWrites(cb) {
    _writeSubs.add(cb);
    try { cb({ inFlight: _inFlight, stuck: _stuck }); } catch { /* ignore */ }
    return () => _writeSubs.delete(cb);
}

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
    let escalateTimer = null;
    let markedStuck = false;
    _inFlight += 1;
    _notifyWriteSubs();
    const timer = setTimeout(() => {
        if (settled) return;
        markedStuck = true;
        _stuck += 1;
        _notifyWriteSubs();
        reviveFirestore('slow-write');
        // Escalation (2026-08-08, Andrew: "it just keeps spinning. i refresh
        // the app and it works"): if the network cycle didn't unstick the
        // write, the wedge is in the persistence layer and only a reload
        // rebuilds it. Do the reload for him — guarded to once per 2 min.
        escalateTimer = setTimeout(() => {
            if (!settled) escalateReload('write-stuck-after-revive');
        }, WRITE_ESCALATE_MS);
    }, hangMs);
    const onSettle = () => {
        settled = true;
        clearTimeout(timer);
        if (escalateTimer) clearTimeout(escalateTimer);
        _inFlight = Math.max(0, _inFlight - 1);
        if (markedStuck) _stuck = Math.max(0, _stuck - 1);
        _notifyWriteSubs();
    };
    // Attach via then() so we neither swallow rejections nor create an
    // unhandled-rejection duplicate (errors still flow to the caller).
    promise.then(onSettle, onSettle);
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
