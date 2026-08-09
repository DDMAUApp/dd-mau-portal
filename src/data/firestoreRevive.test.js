// Pins the 2026-08-08 wedged-Firestore recovery: hung writes and stale
// resumes must trigger exactly one disableNetwork→enableNetwork cycle,
// and the wrapper must never alter the wrapped promise's semantics.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const disableNetwork = vi.fn().mockResolvedValue(undefined);
const enableNetwork = vi.fn().mockResolvedValue(undefined);
vi.mock('firebase/firestore', () => ({
    disableNetwork: (...a) => disableNetwork(...a),
    enableNetwork: (...a) => enableNetwork(...a),
}));
vi.mock('../firebase', () => ({ db: { __fake: true } }));

// Fresh module per test so the throttle state resets.
async function loadFresh() {
    vi.resetModules();
    return await import('./firestoreRevive.js');
}

beforeEach(() => {
    vi.useFakeTimers();
    disableNetwork.mockClear();
    enableNetwork.mockClear();
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
