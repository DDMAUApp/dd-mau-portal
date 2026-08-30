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

import { disableNetwork, enableNetwork, doc, getDocFromServer } from 'firebase/firestore';
import { db } from '../firebase';
import { logError } from './logger';

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
    console.warn(`[firestoreRevive] still stuck after revive (${reason}) — reloading app to rebuild the SDK`);
    _reloadImpl();
    return true;
}
// Input-idle wait (same pattern as App.jsx's broadcast reload): never yank
// the page out from under someone mid-typing. 3s poll, capped — after the
// cap the caller reloads anyway (the tab is wedged; nothing they type can
// save without a reload either). Shared by BOTH escalation paths (probe +
// write) — every reload this module can trigger waits for idle first.
async function _waitInputIdle(capMs = 60_000) {
    const cap = Date.now() + capMs;
    while (Date.now() < cap) {
        const el = typeof document !== 'undefined' ? document.activeElement : null;
        const busy = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (!busy) return;
        await new Promise(r => setTimeout(r, 3000));
    }
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
        // Honestly OFFLINE (2026-08-10): a queued write hanging is expected,
        // not a wedge — reviving does nothing and a forced reload could
        // white-screen a device with no connection. The offline pill tells
        // the user; the write flushes when the network returns.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        markedStuck = true;
        _stuck += 1;
        _notifyWriteSubs();
        reviveFirestore('slow-write');
        // Escalation (2026-08-08, Andrew: "it just keeps spinning. i refresh
        // the app and it works"): if the network cycle didn't unstick the
        // write, the wedge is in the persistence layer and only a reload
        // rebuilds it. Do the reload for him — guarded to once per 2 min.
        // 2026-08-29 (Andrew: chat text "gets erased" while the pill shows):
        // this reload used to fire mid-KEYSTROKE — an auto mark-read hanging
        // on store Wi-Fi would yank the app out from under a half-typed
        // message 18s later. Now it waits for input-idle (same pattern as
        // the probe path) and RE-CHECKS settled — a write that landed during
        // the wait, or an honest offline drop, stands the reload down.
        escalateTimer = setTimeout(async () => {
            if (settled) return;
            await _waitInputIdle(60_000);
            if (settled) return;
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
            escalateReload('write-stuck-after-revive');
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
 * Read-flavored watchdog (2026-08-09 audit): revive a hung READ, but never
 * escalate to a reload and never feed the "Saving…" pill. A slow query on
 * bad store Wi-Fi is not a wedge — reloading mid-use over a background
 * prefetch would be worse than the slowness. If the transport truly IS
 * wedged, the user's next WRITE goes through watchdogWrite and escalates.
 */
export function watchdogRead(promise, hangMs = WRITE_HANG_MS) {
    let settled = false;
    const timer = setTimeout(() => {
        if (!settled) reviveFirestore('slow-read');
    }, hangMs);
    const onSettle = () => { settled = true; clearTimeout(timer); };
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
// ── Liveness probe (2026-08-10, Julie: staff delete on the web app hung;
// Andrew: "on the web app the schedule is lagging behind") ─────────────
// The resume-triggered revive only fires when a tab comes back from
// hidden. A DESKTOP tab that stays visible (or wakes without firing a
// visibility event) can sit with a dead socket for hours: every
// onSnapshot listener is frozen — schedule shows stale data, deploy
// broadcasts and the version floor never arrive — and any write hangs.
// So: while the tab is visible, ping the server every PROBE_INTERVAL_MS
// with a tiny forced-server read. A clean rejection means we're honestly
// offline (Firestore knows — no action); a HANG past WRITE_HANG_MS means
// the wedge, and the revive tears down the dead transport, which also
// resurrects every frozen listener. ~20 reads/hour per open tab.
export const PROBE_INTERVAL_MS = 3 * 60 * 1000;
let _probeInFlight = false;

// ── Probe-stuck reload escalation (2026-08-29, ST1) ────────────────────
// The watchdogRead revive above fixes a dead TRANSPORT, but an iOS
// IndexedDB wedge (see WRITE_ESCALATE_MS) survives a network cycle: the
// probe keeps hanging forever and the tab keeps showing stale data until
// someone happens to WRITE. So: count CONSECUTIVE hung probes. A probe
// that succeeds — or that late-settles after being counted — resets the
// count; so does a clean rejection (the SDK knows it's offline, no
// wedge); a hang detected while the tab isn't visible never counts (a
// frozen background WebView hangs for boring reasons). Two strikes while
// the browser believes it's online ⇒ wait for input-idle, re-check, and
// reload — the same last resort the write path already uses.
// ONE probe-triggered reload per session (own key, separate from the
// write path's 2-min guard): if the reload didn't cure it, it's a
// backend outage — degrade to staleness, never a reload loop.
export const PROBE_STUCK_MS = WRITE_HANG_MS + WRITE_ESCALATE_MS;
export const PROBE_STRIKES_TO_RELOAD = 2;
const PROBE_RELOAD_KEY = 'ddmau:probeReloadAt';
let _probeStrikes = 0;
let _probeEscalating = false;

function _resetProbeStrikes() { _probeStrikes = 0; }

async function _maybeProbeReload() {
    if (_probeEscalating) return;
    try { if (sessionStorage.getItem(PROBE_RELOAD_KEY)) return; } catch { /* storage broken — still escalate (same posture as escalateReload) */ }
    _probeEscalating = true;
    try {
        await _waitInputIdle(60_000);
        // RE-CHECK after the wait — a probe may have succeeded meanwhile
        // (strikes reset), the tab may have hidden, or we may have gone
        // honestly offline. Any of those ⇒ stand down.
        if (_probeStrikes < PROBE_STRIKES_TO_RELOAD) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        try { sessionStorage.setItem(PROBE_RELOAD_KEY, String(Date.now())); } catch { /* still reload */ }
        escalateReload('probe-stuck');
    } finally { _probeEscalating = false; }
}

function _onProbeHang() {
    // Hidden tabs hang because the WebView is frozen, not wedged.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    _probeStrikes += 1;
    if (_probeStrikes < PROBE_STRIKES_TO_RELOAD) return;
    // Honestly offline — hanging is expected; the online listener revives.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    _maybeProbeReload();
}

export async function probeFirestoreLiveness() {
    if (_probeInFlight) return;               // never stack probes
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    _probeInFlight = true;
    try {
        // config/minVersion: tiny, always present, already hot in cache
        // server-side. watchdogRead = revive on hang, no reload, no pill.
        const read = watchdogRead(getDocFromServer(doc(db, 'config', 'minVersion')));
        let hangTimer = null;
        const hung = await Promise.race([
            read.then(() => false, () => null),   // null ⇒ clean rejection
            new Promise((res) => { hangTimer = setTimeout(() => res(true), PROBE_STUCK_MS); }),
        ]);
        clearTimeout(hangTimer);
        if (hung === true) {
            // Counted as a strike below — but if the read settles LATE
            // (the revive healed it after all) the transport is alive:
            // un-count by resetting.
            read.then(_resetProbeStrikes, _resetProbeStrikes);
            _onProbeHang();
        } else {
            // Success or clean rejection — either way the SDK is not
            // wedged, so consecutive-hang evidence resets.
            _resetProbeStrikes();
        }
    } finally { _probeInFlight = false; }
}

export const POST_RESUME_PROBE_MS = 15 * 1000;

// ── resilientSnapshot (2026-08-29, ST3) ────────────────────────────────
// A Firestore onSnapshot that ERRORS is DEAD: the SDK never re-fires an
// errored listener, so a transport blip could permanently kill a stream
// (roster, notifications, the deploy broadcast…) until the next full
// reload. This wraps an attach function and re-attaches with backoff.
//
// Deliberately closure-preserving (NOT a gen-counter/remount pattern):
// `attach` re-runs inside the SAME effect closure, so state the callback
// captures (e.g. App.jsx's forceRefresh `baseline`, the roster's
// prevShapeHash) survives across re-attaches — a broadcast that landed
// during the dead window still registers on the fresh listener's first
// snapshot.
//
//   attach: (onHealthy, onError) => Unsubscribe
//     — call onHealthy() as the FIRST line of the snapshot callback,
//       and pass the error callback straight through as onError.
//   returns: stop() — unsubscribes and cancels any pending retry.
export function resilientSnapshot(label, attach) {
    let stopped = false;
    let unsub = null;
    let timer = null;
    let attempt = 0;
    const DELAYS = [5_000, 30_000, 120_000, 300_000];
    const onHealthy = () => { attempt = 0; };
    const onError = (err) => {
        if (stopped) return;
        try { unsub?.(); } catch { /* listener already dead */ }
        unsub = null;
        const delay = DELAYS[Math.min(attempt, DELAYS.length - 1)];
        attempt += 1;
        console.warn(`[resilientSnapshot] ${label} listener error (${err?.code || err?.message || err}) — re-attaching in ${Math.round(delay / 1000)}s`);
        // One report per losing streak (not per retry): ~4 consecutive
        // failures means this is real, not a blip.
        if (attempt === DELAYS.length) {
            try {
                logError({
                    error: err instanceof Error ? err : new Error(String(err?.message || err || 'snapshot error')),
                    severity: 'warning',
                    feature: `resilientSnapshot:${label}`,
                });
            } catch { /* logging must never break the retry loop */ }
        }
        timer = setTimeout(start, delay);
    };
    const start = () => {
        if (stopped) return;
        timer = null;
        try {
            unsub = attach(onHealthy, onError);
        } catch (e) {
            onError(e);
        }
    };
    start();
    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        try { unsub?.(); } catch { /* ignore */ }
    };
}

export function installFirestoreRevive() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    let hiddenAt = null;

    const onHide = () => { if (hiddenAt == null) hiddenAt = Date.now(); };
    const onShow = () => {
        const was = hiddenAt;
        hiddenAt = null;
        if (was != null && Date.now() - was > RESUME_STALE_MS) {
            reviveFirestore('resume');
            // Post-resume probe (2026-08-29, ST1): don't wait up to
            // PROBE_INTERVAL_MS to learn whether the resume-revive
            // actually took — probe ~15s after it (enough time for the
            // fresh transport to dial) so a still-wedged tab starts
            // accumulating strikes immediately instead of ~3 min later.
            setTimeout(() => { probeFirestoreLiveness(); }, POST_RESUME_PROBE_MS);
        }
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') onHide();
        else onShow();
    });

    // Network came back (Wi-Fi rejoin, cable, VPN) — the SDK usually
    // redials on its own, but a wedged transport doesn't. Cheap to cycle.
    window.addEventListener('online', () => { reviveFirestore('online'); });

    // Periodic liveness probe for visible tabs (see probeFirestoreLiveness).
    setInterval(() => { probeFirestoreLiveness(); }, PROBE_INTERVAL_MS);

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
