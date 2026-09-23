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

import { disableNetwork, enableNetwork, doc, getDocFromServer, getDocFromCache } from 'firebase/firestore';
import { runReloadStashes } from './reloadStash';
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
// Before the reload: let every page stash its in-memory state, then give the
// SDK's serial queue up to this long to commit already-queued local writes to
// IndexedDB (a cache read enqueued NOW resolves only after everything ahead of
// it ran). A timeout means the persistence layer itself is the wedge — the
// reload's actual premise — so we reload anyway.
export const DRAIN_CAP_MS = 5 * 1000;
export const PENDING_REPORT_KEY = 'ddmau:pendingReloadReport';

// ── Write-stuck reload: only when it can actually help (2026-09-23) ──────
// Field telemetry after v1.0.472 (the Webster iPad, native iOS app):
//   • 9/11: 14 "write-stuck" reloads in ~20 min, every one with the local
//     queue unresponsive (drain timed out). A page reload does NOT restart
//     iOS's wedged storage process, so each reload changed nothing — a loop.
//   • 9/18–9/19: reloads mid-count where the local queue answered in 28 ms–
//     2.5 s. The taps were already durable on the device and only waiting on
//     a slow connection; the reload just yanked the sheet from the counter.
// So for write-stuck: probe the local queue FIRST. Healthy ⇒ never reload
// (keep the Reconnecting pill; the writes flush when the network allows).
// Unresponsive ⇒ reload, but at most WRITE_STUCK_MAX_RELOADS per window;
// after that, stop and tell the person what actually fixes it.
export const WRITE_STUCK_LOOP_WINDOW_MS = 20 * 60 * 1000;
export const WRITE_STUCK_MAX_RELOADS = 2;
const WRITE_STUCK_RELOADS_KEY = 'ddmau:writeStuckReloads';
const SKIP_LOG_EVERY_MS = 10 * 60 * 1000;
const _lastSkipLogAt = {};
let _hardStuck = false;

function _readStuckReloads(now) {
    try {
        const arr = JSON.parse(sessionStorage.getItem(WRITE_STUCK_RELOADS_KEY) || '[]');
        return Array.isArray(arr) ? arr.filter((t) => Number.isFinite(t) && now - t < WRITE_STUCK_LOOP_WINDOW_MS) : [];
    } catch { return []; }
}
function _setHardStuck(on) {
    if (_hardStuck === on) return;
    _hardStuck = on;
    _notifyWriteSubs();
}
function _logReloadSkipped(why, meta) {
    const now = Date.now();
    if (now - (_lastSkipLogAt[why] || 0) < SKIP_LOG_EVERY_MS) return;
    _lastSkipLogAt[why] = now;
    try {
        logError({ error: new Error(`reload skipped: ${why}`), severity: 'warning', feature: 'firestoreRevive:reload-skipped', meta: { why, ...meta } });
    } catch { /* never block */ }
}
// 'ok' = the local queue answered (resolved); 'rejected' = it answered with an
// error (can't prove health); 'timeout' = no answer within DRAIN_CAP_MS.
async function _probeLocalQueue() {
    try {
        return await Promise.race([
            getDocFromCache(doc(db, 'config', 'minVersion')).then(() => 'ok', () => 'rejected'),
            new Promise((res) => setTimeout(() => res('timeout'), DRAIN_CAP_MS)),
        ]);
    } catch { return 'rejected'; }
}

export async function escalateReload(reason = 'write-stuck', ctx = {}) {
    const loopable = reason === 'write-stuck-after-revive';
    try {
        const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
        if (Date.now() - last < RELOAD_GUARD_MS) return false;
    } catch { /* storage broken — still reload; worst case iOS re-suspends */ }
    let pre = null;
    if (loopable) {
        const recent = _readStuckReloads(Date.now());
        if (recent.length >= WRITE_STUCK_MAX_RELOADS) {
            // Reloading already failed to cure this — stop looping.
            _setHardStuck(true);
            _logReloadSkipped('loop-cap', { reason, recentReloads: recent.length, ...getWatchdogTelemetry(), ...ctx });
            return false;
        }
        const t0 = Date.now();
        pre = await _probeLocalQueue();
        if (pre === 'ok') {
            _logReloadSkipped('queue-healthy', { reason, probeMs: Date.now() - t0, ...getWatchdogTelemetry(), ...ctx });
            return false;
        }
    }
    try { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); } catch { /* ignore */ }
    if (loopable) {
        try {
            const now = Date.now();
            sessionStorage.setItem(WRITE_STUCK_RELOADS_KEY, JSON.stringify([..._readStuckReloads(now), now]));
        } catch { /* ignore */ }
    }
    const report = { reason, at: Date.now(), ...getWatchdogTelemetry(), ...ctx };
    // Stash BEFORE the drain (pages flush their pending taps into the SDK
    // queue so the drain covers them) and AGAIN after it (taps made during
    // the up-to-5 s drain still reach the rehydrated sheet).
    try { report.stashed = runReloadStashes(reason); } catch { /* best-effort */ }
    let drained = false;
    const t0 = Date.now();
    if (pre === 'timeout') {
        // Just proved unresponsive — don't wait another DRAIN_CAP_MS for it.
        drained = false;
    } else {
        try {
            drained = await Promise.race([
                // Any settle (resolve OR "not in cache" rejection) proves the
                // queue reached this op ⇒ every queued local write is durable.
                getDocFromCache(doc(db, 'config', 'minVersion')).then(() => true, () => true),
                new Promise((res) => setTimeout(() => res(false), DRAIN_CAP_MS)),
            ]);
        } catch { drained = false; }
    }
    report.drained = drained;
    report.drainMs = Date.now() - t0;
    if (pre) report.preProbe = pre;
    try { runReloadStashes(reason); } catch { /* best-effort */ }
    // The transport is suspect by definition, so the report is parked in
    // sessionStorage and flushed through logError on the next boot (App.jsx,
    // once identity is set) — exactly ONE error_logs row per reload.
    try { sessionStorage.setItem(PENDING_REPORT_KEY, JSON.stringify(report)); } catch { /* ignore */ }
    console.warn(`[firestoreRevive] still stuck after revive (${reason}) — reloading app to rebuild the SDK`, report);
    _reloadImpl();
    return true;
}
// Input-idle wait (same pattern as App.jsx's broadcast reload): never yank
// the page out from under someone mid-typing. 3s poll, capped — after the
// cap the caller reloads anyway (the tab is wedged; nothing they type can
// save without a reload either). Shared by BOTH escalation paths (probe +
// write) — every reload this module can trigger waits for idle first.
// 2026-09-09 (Andrew: "sometimes i lose what ive clicked already"): a
// focused text field was the ONLY thing that counted as busy, so someone
// tapping +/- BUTTONS on the inventory sheet was "idle" and got reloaded
// mid-count. Any pointer/key/touch activity in the last INTERACTION_IDLE_MS
// now counts too (listeners installed by installFirestoreRevive).
export const INTERACTION_IDLE_MS = 5_000;
let _lastInteractionAt = 0;
export function markInteraction() { _lastInteractionAt = Date.now(); }
export function isInputBusy() {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return true;
    return Date.now() - _lastInteractionAt < INTERACTION_IDLE_MS;
}
export async function waitInputIdle(capMs = 60_000) {
    const cap = Date.now() + capMs;
    while (Date.now() < cap) {
        if (!isInputBusy()) return;
        await new Promise(r => setTimeout(r, 1000));
    }
}
const _waitInputIdle = waitInputIdle;

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

// ── Progress tracking (2026-09-09) ─────────────────────────────────────
// The watchdog used to judge each write by its own AGE. During a burst of
// inventory taps Firestore acks batches strictly in order through a 10-deep
// pipeline, so the tail of a perfectly healthy drain sat "unsettled" past
// 8 s and was declared a dead transport — the revive then tore down the
// draining stream (re-sending in-flight increments) and the reload followed.
// A wedged transport settles NOTHING; a busy one settles something every few
// hundred ms. So the signal is "when did ANY watchdogged write last settle",
// not "how old is this one". watchdogRead settles never count (a cache-served
// read resolves while the transport is dead).
let _lastWriteSettleAt = 0;
// A fresh transport dial counts as progress too (review 2026-09-09 r3):
// after an honest offline stretch the last settle stamp is from BEFORE the
// outage, so the first hang step after `online` stalled at once — pill,
// then a reload before the re-dialed stream had acked anything. The 8 s
// dead-stream window restarts from the dial instead.
let _lastReviveDoneAt = 0;
const _progressAt = () => Math.max(_lastWriteSettleAt, _lastReviveDoneAt);
let _writeToken = 0;
const _inFlightStarts = new Map();
// Tokens of in-flight PROGRESS writes (mutation-queue writes only) — the
// probe gates key off these, never off transactions/unary reads.
const _inFlightProgress = new Set();

/**
 * Pure step decision: 'wait' (re-arm for delayMs) while some write settled
 * inside the window — the queue is draining — else 'stall'. A write open for
 * more than 8× the window stalls regardless (safety valve).
 */
export function nextWatchdogStep({ now, startedAt, lastSettleAt, hangMs, valve = true }) {
    // Safety valve (8× the window) — only for promises that do NOT feed
    // progress (transactions): mutation-queue writes ack strictly in order,
    // so an older one can never be outlived by newer settles; the valve
    // would only misfire on a backlog draining after an offline stretch.
    if (valve && Number.isFinite(startedAt) && now - startedAt > hangMs * 8) return { action: 'stall' };
    if (lastSettleAt && now - lastSettleAt < hangMs) {
        return { action: 'wait', delayMs: Math.max(250, hangMs - (now - lastSettleAt)) };
    }
    return { action: 'stall' };
}

export function getWatchdogTelemetry() {
    const now = Date.now();
    let oldest = null;
    for (const t of _inFlightStarts.values()) if (oldest == null || t < oldest) oldest = t;
    let onLine = null, visibility = null, path = null;
    try { onLine = typeof navigator !== 'undefined' ? navigator.onLine : null; } catch { /* ignore */ }
    try { visibility = typeof document !== 'undefined' ? document.visibilityState : null; } catch { /* ignore */ }
    try { path = typeof location !== 'undefined' ? location.pathname : null; } catch { /* ignore */ }
    return {
        inFlight: _inFlight,
        stuck: _stuck,
        hardStuck: _hardStuck,
        sinceLastSettleMs: _lastWriteSettleAt ? now - _lastWriteSettleAt : null,
        sinceLastReviveMs: _lastReviveDoneAt ? now - _lastReviveDoneAt : null,
        oldestWriteAgeMs: oldest != null ? now - oldest : null,
        onLine, visibility, path,
    };
}

function _notifyWriteSubs() {
    const snapshot = { inFlight: _inFlight, stuck: _stuck, hardStuck: _hardStuck };
    _writeSubs.forEach((cb) => { try { cb(snapshot); } catch { /* subscriber's problem */ } });
}

/**
 * Subscribe to {inFlight, stuck} counts of watchdogged writes. Calls back
 * immediately with the current state; returns an unsubscribe function.
 */
export function subscribeInFlightWrites(cb) {
    _writeSubs.add(cb);
    try { cb({ inFlight: _inFlight, stuck: _stuck, hardStuck: _hardStuck }); } catch { /* ignore */ }
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
        // Telemetry (2026-09-09): revives were invisible — only a console line.
        // Resume/online cycles are routine and stay quiet; anything the
        // watchdogs trigger is worth a row so false positives are measurable.
        if (reason !== 'resume' && reason !== 'online') {
            try {
                logError({ error: new Error(`revive: ${reason}`), severity: 'warning', feature: 'firestoreRevive:revive', meta: { reason, ...getWatchdogTelemetry() } });
            } catch { /* never block the cycle */ }
        }
        await disableNetwork(db);
        await enableNetwork(db);
        _lastReviveDoneAt = Date.now();
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
export function watchdogWrite(promise, hangMs = WRITE_HANG_MS, { progress = true } = {}) {
    let settled = false;
    let hangTimer = null;
    let escalateTimer = null;
    let markedStuck = false;
    const token = ++_writeToken;
    const startedAt = Date.now();
    _inFlight += 1;
    _inFlightStarts.set(token, startedAt);
    if (progress) _inFlightProgress.add(token);
    _notifyWriteSubs();

    // Escalation (2026-08-08, Andrew: "it just keeps spinning. i refresh
    // the app and it works"): if the network cycle didn't unstick the
    // write, the wedge is in the persistence layer and only a reload
    // rebuilds it. Do the reload for him — guarded to once per 2 min.
    // 2026-08-29 (Andrew: chat text "gets erased" while the pill shows):
    // this reload used to fire mid-KEYSTROKE — now it waits for input-idle
    // (typing AND tapping, 2026-09-09) and RE-CHECKS settled + progress —
    // a write that landed during the wait, ANY write settling meanwhile
    // (the queue is draining), or an honest offline drop stands it down.
    // The RELOAD is gated on real write-stream silence for every promise
    // kind (valve: false): a hung transaction on a device whose taps are
    // still landing reloads once the burst pauses — never under the user's
    // fingers (review 2026-09-09 r3). The 8× valve only drives the revive.
    const escalateStep = async () => {
        if (settled) return;
        const step = nextWatchdogStep({ now: Date.now(), startedAt, lastSettleAt: _progressAt(), hangMs: WRITE_ESCALATE_MS, valve: false });
        if (step.action === 'wait') { escalateTimer = setTimeout(escalateStep, step.delayMs); return; }
        await _waitInputIdle(60_000);
        if (settled) return;
        // Honestly offline: never abandon the write — keep watching so the
        // wedge check resumes the moment the network is back (review 2026-09-09).
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            escalateTimer = setTimeout(escalateStep, WRITE_ESCALATE_MS);
            return;
        }
        // Post-idle progress re-check goes through the same valve so the
        // reload backstop can be deferred, never suppressed forever.
        const again = nextWatchdogStep({ now: Date.now(), startedAt, lastSettleAt: _progressAt(), hangMs: WRITE_ESCALATE_MS, valve: false });
        if (again.action === 'wait') { escalateTimer = setTimeout(escalateStep, again.delayMs); return; }
        const reloaded = await escalateReload('write-stuck-after-revive', { writeAgeMs: Date.now() - startedAt });
        // 2-min guard refused (a reload just happened): keep watching.
        if (!reloaded && !settled) escalateTimer = setTimeout(escalateStep, WRITE_ESCALATE_MS);
    };

    const hangStep = () => {
        if (settled) return;
        // Honestly OFFLINE (2026-08-10): a queued write hanging is expected,
        // not a wedge — reviving does nothing and a forced reload could
        // white-screen a device with no connection. The offline pill tells
        // the user; the write flushes when the network returns. Re-arm
        // rather than abandon (review 2026-09-09): an orphaned in-flight
        // write used to silence the liveness probe for the rest of the tab.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            hangTimer = setTimeout(hangStep, hangMs);
            return;
        }
        // Progress check (2026-09-09): some OTHER watchdogged write settled
        // inside the window ⇒ the transport is alive and merely backed up
        // (a burst of taps). Re-arm instead of tearing the stream down.
        const step = nextWatchdogStep({ now: Date.now(), startedAt, lastSettleAt: _progressAt(), hangMs, valve: !progress });
        if (step.action === 'wait') { hangTimer = setTimeout(hangStep, step.delayMs); return; }
        markedStuck = true;
        _stuck += 1;
        _notifyWriteSubs();
        reviveFirestore('slow-write');
        escalateTimer = setTimeout(escalateStep, WRITE_ESCALATE_MS);
    };
    hangTimer = setTimeout(hangStep, hangMs);

    const onSettle = (ok) => {
        settled = true;
        // Progress = a MUTATION-QUEUE write the server acked. Rejections are
        // not transport evidence, and transactions/unary RPCs travel over
        // XHR, not the WebChannel write stream this watchdog guards — they
        // opt out via watchdogTransaction (review 2026-09-09: counting them
        // let a dead write stream hide behind live transactions for ~64 s).
        if (progress && ok === true) {
            _lastWriteSettleAt = Date.now();
            // Real progress ⇒ whatever was "stuck for good" is moving again.
            if (_hardStuck) { _hardStuck = false; }
        }
        clearTimeout(hangTimer);
        if (escalateTimer) clearTimeout(escalateTimer);
        _inFlight = Math.max(0, _inFlight - 1);
        _inFlightStarts.delete(token);
        _inFlightProgress.delete(token);
        if (markedStuck) _stuck = Math.max(0, _stuck - 1);
        _notifyWriteSubs();
    };
    // Attach via then() so we neither swallow rejections nor create an
    // unhandled-rejection duplicate (errors still flow to the caller).
    promise.then(() => onSettle(true), () => onSettle(false));
    return promise;
}

/**
 * watchdogWrite for runTransaction(): same revive/escalate/pill behavior,
 * but its settle is NOT counted as write-stream progress (transactions
 * commit over unary XHR and can succeed while the write stream is dead).
 */
export function watchdogTransaction(promise, hangMs = WRITE_HANG_MS) {
    return watchdogWrite(promise, hangMs, { progress: false });
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
    let timer = null;
    const step = () => {
        if (settled) return;
        // A read queued behind a healthy tap burst is not a wedge: while
        // writes keep settling, re-arm instead of tearing the stream down.
        const progressAt = _progressAt();
        if (progressAt && Date.now() - progressAt < hangMs) {
            timer = setTimeout(step, Math.max(250, hangMs - (Date.now() - progressAt)));
            return;
        }
        reviveFirestore('slow-read');
    };
    timer = setTimeout(step, hangMs);
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
    // A burst overlapping this hang ⇒ the probe merely queued behind it
    // (2026-09-09). Not a strike. Gated on a progress write STILL in flight
    // right now, or one the server acked inside the last 8 s — not on any
    // write that merely STARTED in the 18 s window (r3: one instant tap
    // shielded a dead listen stream from its once-per-session backstop).
    if (_inFlightProgress.size > 0) return;
    if (_lastWriteSettleAt && Date.now() - _lastWriteSettleAt < WRITE_HANG_MS) return;
    _probeStrikes += 1;
    if (_probeStrikes < PROBE_STRIKES_TO_RELOAD) return;
    // Honestly offline — hanging is expected; the online listener revives.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    _maybeProbeReload();
}

export async function probeFirestoreLiveness() {
    if (_probeInFlight) return;               // never stack probes
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // A burst still draining (a write younger than the probe budget) would
    // only queue the probe behind it and manufacture a hang — skip. A write
    // OLDER than that with nothing settling is the wedge itself, and the
    // probe must run (review 2026-09-09: an orphaned write used to disable
    // the probe for the rest of the tab).
    let newest = 0;
    for (const tok of _inFlightProgress) { const t = _inFlightStarts.get(tok) || 0; if (t > newest) newest = t; }
    if (newest && Date.now() - newest < PROBE_STUCK_MS) return;
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
    // Tap/keystroke activity feeds isInputBusy() (2026-09-09) — capture +
    // passive so it costs nothing and sees events any element swallows.
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
        document.addEventListener(ev, markInteraction, { capture: true, passive: true });
    }

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
