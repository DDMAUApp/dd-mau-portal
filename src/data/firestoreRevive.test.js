// Pins the 2026-08-08 wedged-Firestore recovery: hung writes and stale
// resumes must trigger exactly one disableNetwork→enableNetwork cycle,
// and the wrapper must never alter the wrapped promise's semantics.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const disableNetwork = vi.fn().mockResolvedValue(undefined);
const enableNetwork = vi.fn().mockResolvedValue(undefined);
const getDocFromServer = vi.fn().mockResolvedValue({ exists: () => true });
vi.mock('firebase/firestore', () => ({
    disableNetwork: (...a) => disableNetwork(...a),
    enableNetwork: (...a) => enableNetwork(...a),
    doc: (...a) => ({ __ref: a.slice(1).join('/') }),
    getDocFromServer: (...a) => getDocFromServer(...a),
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
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        mod.watchdogWrite(new Promise(() => {}));   // never settles
        await vi.advanceTimersByTimeAsync(mod.WRITE_HANG_MS + 100);
        expect(disableNetwork).toHaveBeenCalledTimes(1);   // revive tried first
        expect(reload).not.toHaveBeenCalled();             // not yet
        await vi.advanceTimersByTimeAsync(mod.WRITE_ESCALATE_MS + 100);
        expect(reload).toHaveBeenCalledTimes(1);           // then the reload
    });

    it('does NOT reload when the revive unsticks the write in time', async () => {
        const mod = await loadFresh();
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
        const reload = vi.fn();
        mod.__setReloadImplForTests(reload);
        sessionStorage.clear();
        expect(mod.escalateReload('a')).toBe(true);
        expect(mod.escalateReload('b')).toBe(false);
        expect(mod.escalateReload('c')).toBe(false);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    // 2026-08-29 (Andrew: chat text "gets erased" while the pill shows) —
    // the write-stuck reload must never fire mid-keystroke.
    it('waits for typing to stop before the write-stuck reload', async () => {
        const mod = await loadFresh();
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
        await vi.advanceTimersByTimeAsync(4000);    // next 3s idle poll
        expect(reload).toHaveBeenCalledTimes(1);    // wedge still real → reload
    });

    it('a write that lands DURING the idle wait stands the reload down', async () => {
        const mod = await loadFresh();
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
        await vi.advanceTimersByTimeAsync(4000);    // idle again → re-check settled
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
        expect(states.at(-1)).toEqual({ inFlight: 0, stuck: 0 });
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
        expect(states.at(-1)).toEqual({ inFlight: 0, stuck: 0 });

        let resolveA, rejectB;
        const a = watchdogWrite(new Promise(res => { resolveA = res; }));
        const b = watchdogWrite(new Promise((_, rej) => { rejectB = rej; }));
        expect(states.at(-1).inFlight).toBe(2);

        resolveA('ok');
        await a;
        expect(states.at(-1).inFlight).toBe(1);

        rejectB(new Error('denied'));
        await expect(b).rejects.toThrow('denied');
        expect(states.at(-1)).toEqual({ inFlight: 0, stuck: 0 });
    });

    it('flags stuck once the hang timer fires, clears when the write lands', async () => {
        const { watchdogWrite, subscribeInFlightWrites, WRITE_HANG_MS } = await loadFresh();
        const states = [];
        subscribeInFlightWrites(s => states.push(s));

        let resolveLate;
        const wrapped = watchdogWrite(new Promise(res => { resolveLate = res; }));
        expect(states.at(-1)).toEqual({ inFlight: 1, stuck: 0 });

        await vi.advanceTimersByTimeAsync(WRITE_HANG_MS + 100);
        expect(states.at(-1)).toEqual({ inFlight: 1, stuck: 1 });

        resolveLate('flushed');
        await wrapped;
        expect(states.at(-1)).toEqual({ inFlight: 0, stuck: 0 });
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
        await vi.advanceTimersByTimeAsync(4000);                       // next 3s poll → idle → re-check
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
