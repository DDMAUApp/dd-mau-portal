// Pins the 2026-08-08 wedged-Firestore recovery: hung writes and stale
// resumes must trigger exactly one disableNetwork→enableNetwork cycle,
// and the wrapper must never alter the wrapped promise's semantics.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const disableNetwork = vi.fn().mockResolvedValue(undefined);
const enableNetwork = vi.fn().mockResolvedValue(undefined);
const getDocFromServer = vi.fn().mockResolvedValue({ exists: () => true });
// The pre-reload drain probe (2026-09-09) — resolves at once by default.
const getDocFromCache = vi.fn().mockResolvedValue({ exists: () => true });
vi.mock('firebase/firestore', () => ({
    disableNetwork: (...a) => disableNetwork(...a),
    enableNetwork: (...a) => enableNetwork(...a),
    doc: (...a) => ({ __ref: a.slice(1).join('/') }),
    getDocFromServer: (...a) => getDocFromServer(...a),
    getDocFromCache: (...a) => getDocFromCache(...a),
}));
vi.mock('../firebase', () => ({ db: { __fake: true } }));
// firestoreRevive imports logError for resilientSnapshot's streak report;
// mock it so the test graph never pulls the real logger's firebase deps.
const logError = vi.fn().mockResolvedValue(undefined);
vi.mock('./logger', () => ({ logError: (...a) => logError(...a) }));

// Fresh module per test so the throttle state resets.
async function loadFresh() {
    vi.resetModules();
    return await import('./firestoreRevive.js');
}

beforeEach(() => {
    vi.useFakeTimers();
    disableNetwork.mockClear();
    enableNetwork.mockClear();
    getDocFromServer.mockClear();
    getDocFromServer.mockResolvedValue({ exists: () => true });
    getDocFromCache.mockClear();
    getDocFromCache.mockResolvedValue({ exists: () => true });
    logError.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('reviveFirestore', () => {
    it('cycles disable then enable exactly once', async () => {
        const { reviveFirestore } = await loadFresh();
        await expect(reviveFirestore('test')).resolves.toBe(true);
        expect(disableNetwork).toHaveBeenCalledTimes(1);
        expect(enableNetwork).toHaveBeenCalledTimes(1);
    });

    it('throttles bursts into one cycle', async () => {
        const { reviveFirestore } = await loadFresh();
        await reviveFirestore('a');
        await reviveFirestore('b');
        await reviveFirestore('c');
        expect(disableNetwork).toHaveBeenCalledTimes(1);
    });

    it('allows another cycle after the cooldown', async () => {
        const { reviveFirestore, REVIVE_COOLDOWN_MS } = await loadFresh();
        await reviveFirestore('a');
        vi.setSystemTime(Date.now() + REVIVE_COOLDOWN_MS + 1);
        await reviveFirestore('b');
        expect(disableNetwork).toHaveBeenCalledTimes(2);
    });

    it('never throws when the SDK cycle fails', async () => {
        disableNetwork.mockRejectedValueOnce(new Error('sdk broken'));
        const { reviveFirestore } = await loadFresh();
        await expect(reviveFirestore('test')).resolves.toBe(false);
    });
});

describe('watchdogWrite', () => {
    it('returns the resolved value untouched and does not cycle on a fast write', async () => {
        const { watchdogWrite, WRITE_HANG_MS } = await loadFresh();
        const result = await watchdogWrite(Promise.resolve('ok'));
        expect(result).toBe('ok');
        await vi.advanceTimersByTimeAsync(WRITE_HANG_MS + 100);
        expect(disableNetwork).not.toHaveBeenCalled();
    });

    it('propagates rejections untouched (caller catch still fires)', async () => {
        const { watchdogWrite } = await loadFresh();
        await expect(watchdogWrite(Promise.reject(new Error('denied'))))
            .rejects.toThrow('denied');
        expect(disableNetwork).not.toHaveBeenCalled();
    });

    it('cycles the network when the write hangs past the threshold', async () => {
        const { watchdogWrite, WRITE_HANG_MS } = await loadFresh();
        let resolveLate;
        const hung = new Promise(res => { resolveLate = res; });
        const wrapped = watchdogWrite(hung);
        await vi.advanceTimersByTimeAsync(WRITE_HANG_MS + 100);
        expect(disableNetwork).toHaveBeenCalledTimes(1);
        expect(enableNetwork).toHaveBeenCalledTimes(1);
        // The original promise still resolves normally after the flush.
        resolveLate('flushed');
        await expect(wrapped).resolves.toBe('flushed');
    });

    it('collapses many simultaneously-hung writes into one cycle', async () => {
        const { watchdogWrite, WRITE_HANG_MS } = await loadFresh();
        for (let i = 0; i < 5; i++) watchdogWrite(new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(WRITE_HANG_MS + 100);
        expect(disableNetwork).toHaveBeenCalledTimes(1);
    });
});

describe('escalation to reload (persistence-layer wedge)', () => {
    it('reloads when a write is STILL stuck after the revive', async () => {
        const mod = await loadFresh();
        getDocFromCache.mockRejectedValue(new Error('idb wedged'));   // local queue NOT provably healthy (2026-09-23)
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        mod.watchdogWrite(new Promise(() => {}));   // never settles
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + 100);
        expect(disableNetwork).toHaveBeenCalledTimes(1);   // revive tried first
        expect(reload).not.toHaveBeenCalled();             // not yet
        await vi.advanceTimersByTimeAsync(mod.WRITE_ESCALATE_MS + 500);
        expect(reload).toHaveBeenCalledTimes(1);           // then the reload
    });

    it('does NOT reload when the revive unsticks the write in time', async () => {
        const mod = await loadFresh();
        getDocFromCache.mockRejectedValue(new Error('idb wedged'));   // local queue NOT provably healthy (2026-09-23)
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        let resolveLate;
        const wrapped = mod.watchdogWrite(new Promise(res => { resolveLate = res; }));
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + 100);
        resolveLate('flushed');                            // revive worked
        await wrapped;
        await vi.advanceTimersByTimeAsync(mod.WRITE_ESCALATE_MS + 1000);
        expect(reload).not.toHaveBeenCalled();
    });

    it('never reload-loops — guarded to once per window', async () => {
        const mod = await loadFresh();
        getDocFromCache.mockRejectedValue(new Error('idb wedged'));   // local queue NOT provably healthy (2026-09-23)
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        expect(await mod.escalateReload('a')).toBe(true);
        expect(await mod.escalateReload('b')).toBe(false);
        expect(await mod.escalateReload('c')).toBe(false);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    // 2026-08-29 (Andrew: chat text "gets erased" while the pill shows) —
    // the write-stuck reload must never fire mid-keystroke.
    it('waits for typing to stop before the write-stuck reload', async () => {
        const mod = await loadFresh();
        getDocFromCache.mockRejectedValue(new Error('idb wedged'));   // local queue NOT provably healthy (2026-09-23)
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        const input = document.createElement('textarea');
        document.body.appendChild(input);
        input.focus();
        mod.watchdogWrite(new Promise(() => {}));   // never settles
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + mod.WRITE_ESCALATE_MS + 200);
        expect(reload).not.toHaveBeenCalled();      // parked on the idle wait
        input.blur();
        document.body.removeChild(input);
        await vi.advanceTimersByTimeAsync(4000);    // next idle poll (1s)
        expect(reload).toHaveBeenCalledTimes(1);    // wedge still real → reload
    });

    it('a write that lands DURING the idle wait stands the reload down', async () => {
        const mod = await loadFresh();
        getDocFromCache.mockRejectedValue(new Error('idb wedged'));   // local queue NOT provably healthy (2026-09-23)
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        const input = document.createElement('textarea');
        document.body.appendChild(input);
        input.focus();
        let resolveLate;
        const wrapped = mod.watchdogWrite(new Promise(res => { resolveLate = res; }));
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + mod.WRITE_ESCALATE_MS + 200);
        expect(reload).not.toHaveBeenCalled();      // parked on the idle wait
        resolveLate('flushed');                     // the revive worked after all
        await wrapped;
        input.blur();
        document.body.removeChild(input);
        await vi.advanceTimersByTimeAsync(4000);    // idle again (1s poll) → re-check settled
        expect(reload).not.toHaveBeenCalled();      // stood down
    });
});

describe('watchdogRead (2026-08-09 audit — reads must not reload or feed the pill)', () => {
    it('revives on a hung read but NEVER escalates to a reload', async () => {
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        mod.watchdogRead(new Promise(() => {}));   // hangs forever
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + mod.WRITE_ESCALATE_MS + 5000);
        expect(disableNetwork).toHaveBeenCalledTimes(1);  // revive fired
        expect(reload).not.toHaveBeenCalled();            // no reload, ever
    });

    it('does not count toward the in-flight write pill', async () => {
        const { watchdogRead, subscribeInFlightWrites } = await loadFresh();
        const states = [];
        subscribeInFlightWrites(s => states.push(s));
        watchdogRead(new Promise(() => {}));
        expect(states.at(-1)).toEqual({ inFlight: 0, stuck: 0, hardStuck: false });
    });

    it('returns the original promise semantics untouched', async () => {
        const { watchdogRead } = await loadFresh();
        await expect(watchdogRead(Promise.resolve('rows'))).resolves.toBe('rows');
        await expect(watchdogRead(Promise.reject(new Error('idx')))).rejects.toThrow('idx');
    });
});

describe('in-flight write tracking (SyncPill feed)', () => {
    it('counts up on start, down on settle, for both resolve and reject', async () => {
        const { watchdogWrite, subscribeInFlightWrites } = await loadFresh();
        const states = [];
        subscribeInFlightWrites(s => states.push(s));
        expect(states.at(-1)).toEqual({ inFlight: 0, stuck: 0, hardStuck: false });

        let resolveA, rejectB;
        const a = watchdogWrite(new Promise(res => { resolveA = res; }));
        const b = watchdogWrite(new Promise((_, rej) => { rejectB = rej; }));
        expect(states.at(-1).inFlight).toBe(2);

        resolveA('ok');
        await a;
        expect(states.at(-1).inFlight).toBe(1);

        rejectB(new Error('denied'));
        await expect(b).rejects.toThrow('denied');
        expect(states.at(-1)).toEqual({ inFlight: 0, stuck: 0, hardStuck: false });
    });

    it('flags stuck once the hang timer fires, clears when the write lands', async () => {
        const { watchdogWrite, subscribeInFlightWrites, WRITE_HANG_MS } = await loadFresh();
        const states = [];
        subscribeInFlightWrites(s => states.push(s));

        let resolveLate;
        const wrapped = watchdogWrite(new Promise(res => { resolveLate = res; }));
        expect(states.at(-1)).toEqual({ inFlight: 1, stuck: 0, hardStuck: false });

        await vi.advanceTimersByTimeAsync(WRITE_HANG_MS + 100);
        expect(states.at(-1)).toEqual({ inFlight: 1, stuck: 1, hardStuck: false });

        resolveLate('flushed');
        await wrapped;
        expect(states.at(-1)).toEqual({ inFlight: 0, stuck: 0, hardStuck: false });
    });

    it('unsubscribe stops callbacks; a throwing subscriber cannot break the write', async () => {
        const { watchdogWrite, subscribeInFlightWrites } = await loadFresh();
        const good = [];
        subscribeInFlightWrites(() => { throw new Error('bad subscriber'); });
        const unsub = subscribeInFlightWrites(s => good.push(s));
        const countAtUnsub = good.length;
        unsub();
        await watchdogWrite(Promise.resolve('ok'));   // must not throw
        expect(good.length).toBe(countAtUnsub);        // no callbacks after unsub
    });
});

describe('probeFirestoreLiveness (2026-08-10 — wedged desktop tabs)', () => {
    const setVisibility = (state) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    };

    it('a HUNG probe triggers the revive (the wedge case)', async () => {
        setVisibility('visible');
        getDocFromServer.mockReturnValue(new Promise(() => {}));   // hangs
        const mod = await loadFresh();
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + 100);
        expect(disableNetwork).toHaveBeenCalledTimes(1);
    });

    it('a clean rejection (honest offline) does NOT revive', async () => {
        setVisibility('visible');
        getDocFromServer.mockRejectedValue(new Error('unavailable'));
        const mod = await loadFresh();
        await mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + 100);
        expect(disableNetwork).not.toHaveBeenCalled();
    });

    it('skips hidden tabs and never stacks probes', async () => {
        setVisibility('hidden');
        const mod = await loadFresh();
        await mod.probeFirestoreLiveness();
        expect(getDocFromServer).not.toHaveBeenCalled();
        setVisibility('visible');
        getDocFromServer.mockReturnValue(new Promise(() => {}));   // in-flight forever
        mod.probeFirestoreLiveness();
        mod.probeFirestoreLiveness();  // second call must be a no-op
        expect(getDocFromServer).toHaveBeenCalledTimes(1);
    });

    // NOTE: no install-based interval test — installFirestoreRevive attaches
    // document listeners that outlive vi.resetModules() (shared jsdom doc)
    // and would double-fire the resume-path test below. The interval wiring
    // is a single setInterval line; the probe behaviors above are the pins.
});

describe('probe-stuck reload escalation (2026-08-29, ST1)', () => {
    const setVisibility = (state) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    };
    const hangForever = () => new Promise(() => {});

    // Boot a fresh module with the reload seam installed and a clean session.
    async function setup() {
        setVisibility('visible');
        sessionStorage.clear();
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        return { mod, reload };
    }

    it('reloads after TWO consecutive hung probes — never after one', async () => {
        getDocFromServer.mockReturnValue(hangForever());
        const { mod, reload } = await setup();
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);   // strike 1
        expect(reload).not.toHaveBeenCalled();
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);   // strike 2 → idle-wait (no input) → reload
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('a probe SUCCESS between hangs resets the strike count', async () => {
        const { mod, reload } = await setup();
        getDocFromServer.mockReturnValueOnce(hangForever());
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);   // strike 1
        getDocFromServer.mockResolvedValueOnce({ exists: () => true });
        await mod.probeFirestoreLiveness();                            // success → reset
        getDocFromServer.mockReturnValue(hangForever());
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);   // back to strike 1 only
        expect(reload).not.toHaveBeenCalled();
    });

    it('a clean REJECTION (honest offline) also resets the strike count', async () => {
        const { mod, reload } = await setup();
        getDocFromServer.mockReturnValueOnce(hangForever());
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);   // strike 1
        getDocFromServer.mockRejectedValueOnce(new Error('unavailable'));
        await mod.probeFirestoreLiveness();                            // clean rejection → reset
        getDocFromServer.mockReturnValue(hangForever());
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);   // strike 1 again
        expect(reload).not.toHaveBeenCalled();
    });

    it('caps at ONE probe-triggered reload per session (recurrence = outage)', async () => {
        getDocFromServer.mockReturnValue(hangForever());
        const { mod, reload } = await setup();
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);
        expect(reload).toHaveBeenCalledTimes(1);
        // Move PAST escalateReload's generic 2-min guard so the only thing
        // standing between us and reload #2 is the per-session probe key.
        vi.setSystemTime(Date.now() + mod.RELOAD_GUARD_MS + 1000);
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);
        expect(reload).toHaveBeenCalledTimes(1);                       // still one
    });

    it('a hang detected while the tab is HIDDEN does not count a strike', async () => {
        getDocFromServer.mockReturnValue(hangForever());
        const { mod, reload } = await setup();
        mod.probeFirestoreLiveness();                                  // starts visible…
        setVisibility('hidden');                                       // …tab hides mid-probe
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);   // hang while hidden → NO strike
        setVisibility('visible');
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);   // only strike 1
        expect(reload).not.toHaveBeenCalled();
    });

    it('idle-wait then RE-CHECK: a probe success while waiting for typing stands the reload down', async () => {
        getDocFromServer.mockReturnValue(hangForever());
        const { mod, reload } = await setup();
        // User is mid-typing when the second strike lands.
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);
        mod.probeFirestoreLiveness();
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 100);   // strike 2 → idle-wait loop parks
        expect(reload).not.toHaveBeenCalled();                         // waiting, not reloading
        // While parked, a probe succeeds — the SDK healed itself.
        getDocFromServer.mockResolvedValueOnce({ exists: () => true });
        await mod.probeFirestoreLiveness();
        input.blur();
        document.body.removeChild(input);
        await vi.advanceTimersByTimeAsync(4000);                       // next idle poll (1s) → re-check
        expect(reload).not.toHaveBeenCalled();                         // strikes reset → stood down
    });
});

describe('resilientSnapshot (2026-08-29, ST3 — dead listeners re-attach)', () => {
    it('re-attaches after an error, preserving the same closure', async () => {
        const mod = await loadFresh();
        let attachCount = 0;
        let handlers = null;
        const stop = mod.resilientSnapshot('test-stream', (onHealthy, onError) => {
            attachCount += 1;
            handlers = { onHealthy, onError };
            return () => {};
        });
        expect(attachCount).toBe(1);
        handlers.onError(Object.assign(new Error('transport died'), { code: 'unavailable' }));
        await vi.advanceTimersByTimeAsync(5_000 + 100);               // first backoff step
        expect(attachCount).toBe(2);
        stop();
    });

    it('stop() cancels a pending retry and further errors are ignored', async () => {
        const mod = await loadFresh();
        let attachCount = 0;
        let handlers = null;
        const stop = mod.resilientSnapshot('test-stream', (onHealthy, onError) => {
            attachCount += 1;
            handlers = { onHealthy, onError };
            return () => {};
        });
        handlers.onError(new Error('boom'));
        stop();                                                        // cancels the queued retry
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(attachCount).toBe(1);
        handlers.onError(new Error('late'));                           // post-stop error → no-op
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(attachCount).toBe(1);
    });

    it('a healthy snapshot resets the backoff ladder; one logError per ~4-failure streak', async () => {
        const mod = await loadFresh();
        let attachCount = 0;
        let handlers = null;
        const stop = mod.resilientSnapshot('test-stream', (onHealthy, onError) => {
            attachCount += 1;
            handlers = { onHealthy, onError };
            return () => {};
        });
        // 4 consecutive failures → exactly ONE logError (not one per retry).
        for (const delay of [5_000, 30_000, 120_000, 300_000]) {
            handlers.onError(new Error('down'));
            await vi.advanceTimersByTimeAsync(delay + 100);
        }
        expect(attachCount).toBe(5);
        expect(logError).toHaveBeenCalledTimes(1);
        // Healthy snapshot resets the ladder: next error retries at 5s again.
        handlers.onHealthy();
        handlers.onError(new Error('down again'));
        await vi.advanceTimersByTimeAsync(5_000 + 100);
        expect(attachCount).toBe(6);
        stop();
    });
});

describe('installFirestoreRevive (resume path)', () => {
    it('cycles after a long-backgrounded resume but not a quick app-switch', async () => {
        const { installFirestoreRevive, RESUME_STALE_MS } = await loadFresh();
        installFirestoreRevive();
        const setVisibility = (state) => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
            document.dispatchEvent(new Event('visibilitychange'));
        };
        // Quick switch: hidden 2s → visible. No cycle.
        setVisibility('hidden');
        vi.setSystemTime(Date.now() + 2000);
        setVisibility('visible');
        expect(disableNetwork).not.toHaveBeenCalled();
        // Long suspend: hidden past the threshold → visible. One cycle.
        setVisibility('hidden');
        vi.setSystemTime(Date.now() + RESUME_STALE_MS + 1000);
        setVisibility('visible');
        expect(disableNetwork).toHaveBeenCalledTimes(1);
    });
});

// ── 2026-09-09: progress-based watchdog, tap-aware idle, drained reload ──
describe('progress-based watchdog (2026-09-09 — inventory tap bursts)', () => {
    it('a healthy backlog never revives: writes keep settling in order while the tail is >8 s old', async () => {
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        // 8 writes started 500 ms apart; each settles 1.6 s after the previous one
        // (in order), so the last one is open for ~13 s — but something settles
        // every 1.6 s the whole time.
        const resolvers = [];
        for (let i = 0; i < 8; i++) {
            mod.watchdogWrite(new Promise(res => resolvers.push(res)));
            await vi.advanceTimersByTimeAsync(500);
        }
        for (let i = 0; i < 8; i++) {
            await vi.advanceTimersByTimeAsync(1600);
            resolvers[i]('ok');
            await vi.advanceTimersByTimeAsync(0);
        }
        await vi.advanceTimersByTimeAsync(mod.WRITE_ESCALATE_MS + 1000);
        expect(disableNetwork).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
    });

    it('a dead transport still revives at exactly the old threshold (nothing settles)', async () => {
        const mod = await loadFresh();
        mod.watchdogWrite(new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS - 100);
        expect(disableNetwork).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(200);
        expect(disableNetwork).toHaveBeenCalledTimes(1);
    });

    it('a DIFFERENT write settling after the revive stands the reload down', async () => {
        const mod = await loadFresh();
        getDocFromCache.mockRejectedValue(new Error('idb wedged'));   // local queue NOT provably healthy (2026-09-23)
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        mod.watchdogWrite(new Promise(() => {}));                 // the stuck one
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + 100);
        expect(disableNetwork).toHaveBeenCalledTimes(1);
        // Other writes keep landing every 6 s — the transport is alive, the
        // stuck one is just deep in a queue. No reload while that is true...
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(6000);
            let res; const late = mod.watchdogWrite(new Promise(r => { res = r; }));
            res('landed'); await late;
            expect(reload).not.toHaveBeenCalled();
        }
        // ...and once the transport falls silent for a full escalation window
        // with the write STILL open, the reload is the right call.
        await vi.advanceTimersByTimeAsync(mod.WRITE_ESCALATE_MS + 2000);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('button taps defer the reload until 5 s after the last tap', async () => {
        const mod = await loadFresh();
        getDocFromCache.mockRejectedValue(new Error('idb wedged'));   // local queue NOT provably healthy (2026-09-23)
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        // (markInteraction is what the installFirestoreRevive pointerdown/keydown
        // listeners call — driven directly so no document listener outlives
        // this module instance, per the note above the probe tests.)
        mod.watchdogWrite(new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + mod.WRITE_ESCALATE_MS - 500);
        // user is tapping +/- buttons (no focused text field)
        mod.markInteraction();
        await vi.advanceTimersByTimeAsync(3000);
        mod.markInteraction();
        await vi.advanceTimersByTimeAsync(3000);
        expect(reload).not.toHaveBeenCalled();            // still tapping
        await vi.advanceTimersByTimeAsync(mod.INTERACTION_IDLE_MS + 1500);
        expect(reload).toHaveBeenCalledTimes(1);          // idle → wedge still real → reload
    });

    it('escalateReload runs stashes, drains, and records telemetry BEFORE reloading', async () => {
        const mod = await loadFresh();
        const { registerReloadStash } = await import('./reloadStash.js');
        const order = [];
        const reload = vi.fn(() => order.push('reload'));
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        registerReloadStash('inventory', () => { order.push('stash'); return { loc: 'webster', counts: { eggs: 2 } }; });
        // local queue answers with an error ⇒ health not proven ⇒ reload path
        getDocFromCache.mockImplementation(() => { order.push('drain'); return Promise.reject(new Error('idb wedged')); });
        expect(await mod.escalateReload('write-stuck-after-revive', { page: 'inventory' })).toBe(true);
        // pre-probe, then stash → drain → stash → reload
        expect(order).toEqual(['drain', 'stash', 'drain', 'stash', 'reload']);
        const rep = JSON.parse(sessionStorage.getItem(mod.PENDING_REPORT_KEY));
        expect(rep.reason).toBe('write-stuck-after-revive');
        expect(rep.drained).toBe(true);
        expect(rep.page).toBe('inventory');
        expect(sessionStorage.getItem('ddmau:reloadStash:inventory')).toContain('eggs');
        // exactly one row per reload: the parked report (flushed by App.jsx on
        // boot, once identity is set) — nothing is logged pre-reload.
        expect(logError).not.toHaveBeenCalledWith(expect.objectContaining({ feature: 'firestoreRevive:reload' }));
    });

    it('a drain that never completes still reloads after DRAIN_CAP_MS', async () => {
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        getDocFromCache.mockReturnValue(new Promise(() => {}));
        const p = mod.escalateReload('probe-stuck');
        await vi.advanceTimersByTimeAsync(mod.DRAIN_CAP_MS + 100);
        expect(await p).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(JSON.parse(sessionStorage.getItem(mod.PENDING_REPORT_KEY)).drained).toBe(false);
    });

    it('a hung probe is NOT a strike while writes are settling', async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        sessionStorage.clear();
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        getDocFromServer.mockReturnValue(new Promise(() => {}));
        for (let round = 0; round < 3; round++) {
            mod.probeFirestoreLiveness();
            // a burst keeps landing writes every 3 s while the probe is queued behind it
            for (let k = 0; k < 6; k++) {
                await vi.advanceTimersByTimeAsync(3000);
                let res; const w = mod.watchdogWrite(new Promise(r => { res = r; })); res('ok'); await w;
            }
            await vi.advanceTimersByTimeAsync(100);
        }
        expect(reload).not.toHaveBeenCalled();
        expect(disableNetwork).not.toHaveBeenCalled();     // the probe read never revived mid-burst either
    });

    it('nextWatchdogStep table', async () => {
        const mod = await loadFresh();
        expect(mod.nextWatchdogStep({ now: 10_000, startedAt: 1_000, lastSettleAt: 0, hangMs: 8000 })).toEqual({ action: 'stall' });
        expect(mod.nextWatchdogStep({ now: 10_000, startedAt: 1_000, lastSettleAt: 9_000, hangMs: 8000 })).toEqual({ action: 'wait', delayMs: 7000 });
        expect(mod.nextWatchdogStep({ now: 10_000, startedAt: 1_000, lastSettleAt: 1_500, hangMs: 8000 })).toEqual({ action: 'stall' });
        // safety valve: only for non-progress promises (transactions) — a
        // mutation-queue write that is still open while newer writes settle
        // is a backlog (e.g. draining after an offline stretch), not a wedge
        expect(mod.nextWatchdogStep({ now: 100_000, startedAt: 1_000, lastSettleAt: 99_000, hangMs: 8000, valve: false })).toEqual({ action: 'wait', delayMs: 7000 });
        expect(mod.nextWatchdogStep({ now: 100_000, startedAt: 1_000, lastSettleAt: 99_000, hangMs: 8000, valve: true })).toEqual({ action: 'stall' });
    });

    it('revive telemetry: watchdog-triggered cycles log a row, resume cycles stay quiet', async () => {
        const mod = await loadFresh();
        await mod.reviveFirestore('resume');
        expect(logError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(mod.REVIVE_COOLDOWN_MS + 10);
        await mod.reviveFirestore('slow-write');
        expect(logError).toHaveBeenCalledWith(expect.objectContaining({ feature: 'firestoreRevive:revive' }));
    });
});

describe('review fixes (2026-09-09 round 2)', () => {
    it('settling TRANSACTIONS do not mask a dead write stream: still revives at 8 s', async () => {
        const mod = await loadFresh();
        mod.watchdogWrite(new Promise(() => {}));                 // stuck stream write
        for (let i = 0; i < 3; i++) {
            await vi.advanceTimersByTimeAsync(2500);
            let res; const t = mod.watchdogTransaction(new Promise(r => { res = r; })); res('committed'); await t;
        }
        await vi.advanceTimersByTimeAsync(1000);                  // t ≈ 8.5 s
        expect(disableNetwork).toHaveBeenCalledTimes(1);
    });
    it('REJECTED writes are not progress: still revives at 8 s', async () => {
        const mod = await loadFresh();
        mod.watchdogWrite(new Promise(() => {}));
        for (let i = 0; i < 3; i++) {
            await vi.advanceTimersByTimeAsync(2500);
            const w = mod.watchdogWrite(Promise.reject(new Error('permission-denied')));
            await w.catch(() => {});
        }
        await vi.advanceTimersByTimeAsync(1000);
        expect(disableNetwork).toHaveBeenCalledTimes(1);
    });
    it('honest offline keeps WATCHING the write and resumes the wedge check once online', async () => {
        const mod = await loadFresh();
        const onLine = vi.spyOn(navigator, 'onLine', 'get');
        onLine.mockReturnValue(false);
        mod.watchdogWrite(new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS * 3);
        expect(disableNetwork).not.toHaveBeenCalled();           // offline: no revive
        onLine.mockReturnValue(true);
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + 100);
        expect(disableNetwork).toHaveBeenCalledTimes(1);         // back online → wedge check resumed
        onLine.mockRestore();
    });
    it('the liveness probe still runs when the only in-flight write is an old orphan', async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        sessionStorage.clear();
        const mod = await loadFresh();
        mod.__setReloadImplForTests(vi.fn());
        mod.watchdogWrite(new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 1000);   // orphan is older than the probe budget
        getDocFromServer.mockClear();
        await mod.probeFirestoreLiveness();
        expect(getDocFromServer).toHaveBeenCalledTimes(1);
    });
    it('a probe is skipped only while a YOUNG write is draining', async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        const mod = await loadFresh();
        mod.watchdogWrite(new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(1000);
        getDocFromServer.mockClear();
        await mod.probeFirestoreLiveness();
        expect(getDocFromServer).not.toHaveBeenCalled();
    });
});

describe('review fixes (2026-09-09 round 3)', () => {
    it('an offline backlog draining after reconnect never revives while writes keep settling', async () => {
        const mod = await loadFresh();
        const onLine = vi.spyOn(navigator, 'onLine', 'get');
        onLine.mockReturnValue(false);
        const resolvers = [];
        for (let i = 0; i < 5; i++) { mod.watchdogWrite(new Promise(r => resolvers.push(r))); await vi.advanceTimersByTimeAsync(20_000); }
        onLine.mockReturnValue(true);                       // writes are now > 8× the window old
        for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(2000); resolvers[i]('ok'); await vi.advanceTimersByTimeAsync(0); }
        await vi.advanceTimersByTimeAsync(mod.WRITE_ESCALATE_MS + 1000);
        expect(disableNetwork).not.toHaveBeenCalled();
        onLine.mockRestore();
    });
    it('a hung READ does not revive while writes are settling (read re-arms on progress)', async () => {
        const mod = await loadFresh();
        mod.watchdogRead(new Promise(() => {}));
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(3000);
            let res; const w = mod.watchdogWrite(new Promise(r => { res = r; })); res('ok'); await w;
        }
        expect(disableNetwork).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + 500);   // then silence → the read is a real hang
        expect(disableNetwork).toHaveBeenCalledTimes(1);
    });
    it('a stalled TRANSACTION revives at the 8× valve but never RELOADS while writes settle; reloads once the stream is quiet', async () => {
        sessionStorage.clear();
        const mod = await loadFresh();
        getDocFromCache.mockRejectedValue(new Error('idb wedged'));   // local queue NOT provably healthy (2026-09-23)
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        mod.watchdogTransaction(new Promise(() => {}));
        for (let i = 0; i < 40; i++) {                            // 100 s of healthy taps
            await vi.advanceTimersByTimeAsync(2500);
            let res; const w = mod.watchdogWrite(new Promise(r => { res = r; })); res('ok'); await w;
        }
        expect(disableNetwork).toHaveBeenCalled();                // valve → revive (~64 s)
        expect(reload).not.toHaveBeenCalled();                    // but no reload under the user's fingers
        await vi.advanceTimersByTimeAsync(mod.WRITE_ESCALATE_MS * 2 + 1000);   // burst pauses → stream silent
        expect(reload).toHaveBeenCalledTimes(1);
    });
});

describe('review fixes (2026-09-09 round 3b)', () => {
    it('an online revive restarts the 8 s window: the pre-outage settle stamp does not stall the re-armed hang step', async () => {
        sessionStorage.clear();
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        let snap = null; mod.subscribeInFlightWrites(s => { snap = s; });
        { let res; const w = mod.watchdogWrite(new Promise(r => { res = r; })); res('ok'); await w; }   // last ack before the dead zone
        const onLine = vi.spyOn(navigator, 'onLine', 'get');
        onLine.mockReturnValue(false);
        const resolvers = [];
        for (let i = 0; i < 5; i++) { mod.watchdogWrite(new Promise(r => resolvers.push(r))); await vi.advanceTimersByTimeAsync(2000); }
        await vi.advanceTimersByTimeAsync(60_000);                 // 60 s in the walk-in
        onLine.mockReturnValue(true);
        await mod.reviveFirestore('online');                      // the online listener's cycle
        expect(disableNetwork).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(7000);                   // AP takes 7 s to pass traffic
        expect(snap.stuck).toBe(0);                                // no Reconnecting… pill yet
        expect(reload).not.toHaveBeenCalled();
        for (const r of resolvers) r('ok');                        // backlog acks
        await vi.advanceTimersByTimeAsync(mod.WRITE_ESCALATE_MS * 2);
        expect(snap.stuck).toBe(0);
        expect(reload).not.toHaveBeenCalled();
        expect(disableNetwork).toHaveBeenCalledTimes(1);           // no second cycle
        onLine.mockRestore();
    });
    it('a dead re-dialed stream still escalates: no ack 8 s after the dial → pill, 18 s → reload', async () => {
        sessionStorage.clear();
        const mod = await loadFresh();
        getDocFromCache.mockRejectedValue(new Error('idb wedged'));   // local queue NOT provably healthy (2026-09-23)
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        let snap = null; mod.subscribeInFlightWrites(s => { snap = s; });
        const onLine = vi.spyOn(navigator, 'onLine', 'get');
        onLine.mockReturnValue(false);
        mod.watchdogWrite(new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(60_000);
        onLine.mockReturnValue(true);
        await mod.reviveFirestore('online');
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + 500);
        expect(snap.stuck).toBe(1);
        expect(reload).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(mod.WRITE_ESCALATE_MS + 500);
        expect(reload).toHaveBeenCalledTimes(1);
        onLine.mockRestore();
    });
    it('one instant tap inside the probe window no longer shields a hung probe from a strike', async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        sessionStorage.clear();
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        getDocFromServer.mockReturnValue(new Promise(() => {}));
        for (let round = 0; round < 2; round++) {
            const p = mod.probeFirestoreLiveness();
            await vi.advanceTimersByTimeAsync(1000);
            { let res; const w = mod.watchdogWrite(new Promise(r => { res = r; })); res('ok'); await w; }   // a single 300 ms tap
            await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS);   // then 17 s of silence → hang
            await p;
            await vi.advanceTimersByTimeAsync(1000);
        }
        await vi.advanceTimersByTimeAsync(2000);
        expect(reload).toHaveBeenCalledTimes(1);                   // two strikes → the backstop ran
    });
    it('a progress write still IN FLIGHT at hang time is an overlapping burst — not a strike', async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        sessionStorage.clear();
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        getDocFromServer.mockReturnValue(new Promise(() => {}));
        for (let round = 0; round < 3; round++) {
            const p = mod.probeFirestoreLiveness();
            await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS - 2000);
            let res; const w = mod.watchdogWrite(new Promise(r => { res = r; }));   // open across the hang moment
            await vi.advanceTimersByTimeAsync(3000);
            res('ok'); await w;
            await p;
            await vi.advanceTimersByTimeAsync(mod.PROBE_STUCK_MS + 1000);           // let it age past the start gate
        }
        expect(reload).not.toHaveBeenCalled();
    });
});


describe('write-stuck reload only when it can help (2026-09-23 field telemetry)', () => {
    it('local queue HEALTHY ⇒ no reload, guard untouched, one skip row', async () => {
        sessionStorage.clear();
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        expect(await mod.escalateReload('write-stuck-after-revive')).toBe(false);
        expect(reload).not.toHaveBeenCalled();
        expect(sessionStorage.getItem('ddmau:reviveReloadAt')).toBeNull();
        expect(logError).toHaveBeenCalledWith(expect.objectContaining({ feature: 'firestoreRevive:reload-skipped', meta: expect.objectContaining({ why: 'queue-healthy' }) }));
        logError.mockClear();
        await mod.escalateReload('write-stuck-after-revive');
        expect(logError).not.toHaveBeenCalled();                 // throttled: one row per 10 min
    });
    it('a stuck write on a healthy device keeps waiting — never reloads — and still saves when the network recovers', async () => {
        sessionStorage.clear();
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        let res; const w = mod.watchdogWrite(new Promise(r => { res = r; }));
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + mod.WRITE_ESCALATE_MS * 6);
        expect(disableNetwork).toHaveBeenCalled();                // revived
        expect(reload).not.toHaveBeenCalled();                    // but never reloaded
        res('ok'); await w;
    });
    it('loop cap: after 2 write-stuck reloads in the window, stop reloading and flag hardStuck until a write lands', async () => {
        sessionStorage.clear();
        const mod = await loadFresh();
        getDocFromCache.mockRejectedValue(new Error('idb wedged'));
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        let snap = null; mod.subscribeInFlightWrites(s => { snap = s; });
        expect(await mod.escalateReload('write-stuck-after-revive')).toBe(true);
        vi.setSystemTime(Date.now() + mod.RELOAD_GUARD_MS + 1000);
        expect(await mod.escalateReload('write-stuck-after-revive')).toBe(true);
        vi.setSystemTime(Date.now() + mod.RELOAD_GUARD_MS + 1000);
        expect(await mod.escalateReload('write-stuck-after-revive')).toBe(false);   // capped
        expect(reload).toHaveBeenCalledTimes(2);
        expect(snap.hardStuck).toBe(true);
        expect(logError).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ why: 'loop-cap' }) }));
        await mod.watchdogWrite(Promise.resolve('ok'));
        expect(snap.hardStuck).toBe(false);                        // real progress clears it
        vi.setSystemTime(Date.now() + mod.WRITE_STUCK_LOOP_WINDOW_MS + 1000);
        expect(await mod.escalateReload('write-stuck-after-revive')).toBe(true);    // window passed
    });
    it('local queue UNRESPONSIVE ⇒ reload right after the 5 s probe (no second 5 s wait)', async () => {
        sessionStorage.clear();
        const mod = await loadFresh();
        getDocFromCache.mockReturnValue(new Promise(() => {}));
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        const p = mod.escalateReload('write-stuck-after-revive');
        await vi.advanceTimersByTimeAsync(mod.DRAIN_CAP_MS + 50);
        expect(await p).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        const rep = JSON.parse(sessionStorage.getItem(mod.PENDING_REPORT_KEY));
        expect(rep.drained).toBe(false);
        expect(rep.preProbe).toBe('timeout');
    });
    it('other reasons (probe-stuck) keep their old behavior — no pre-probe', async () => {
        sessionStorage.clear();
        const mod = await loadFresh();
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        expect(await mod.escalateReload('probe-stuck')).toBe(true);
    });
});
