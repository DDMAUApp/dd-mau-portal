// The boot check around the push-token transaction, on the real enableFcmPush.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testMode = false;
let native = null; // null = web, else 'ios' | 'android'
let token = 'T1';
let serverDoc = null;
let commitError = null;
const listeners = [];

const runTransaction = vi.fn(async (_db, body) => {
    let pending = null;
    const tx = {
        get: async () => ({ exists: () => !!serverDoc, data: () => serverDoc }),
        set: (_ref, next) => { pending = next; },
    };
    await body(tx);
    if (commitError) throw commitError;
    if (pending) serverDoc = pending;
});
const onSnapshot = vi.fn((_ref, opts, next, error) => {
    const l = { opts, next, error, stopped: false };
    listeners.push(l);
    return () => { l.stopped = true; };
});

vi.mock('./data/testMode', () => ({ get TEST_MODE() { return testMode; } }));
vi.mock('./firebase', () => ({ default: {}, db: {} }));
vi.mock('./data/firestoreRevive', () => ({ watchdogWrite: (p) => p, watchdogTransaction: (p) => p }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn(() => ({})),
    setDoc: vi.fn(),
    runTransaction: (...a) => runTransaction(...a),
    onSnapshot: (...a) => onSnapshot(...a),
}));
vi.mock('firebase/messaging', () => ({
    isSupported: async () => true,
    getMessaging: () => ({}),
    getToken: async () => token,
    deleteToken: async () => true,
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => !!native, getPlatform: () => native || 'web' },
}));
vi.mock('@capacitor/push-notifications', () => ({
    PushNotifications: {
        requestPermissions: async () => ({ receive: 'granted' }),
        register: async () => {},
        addListener: async (name, cb) => {
            if (name === 'registration') setTimeout(() => cb({ value: token }), 0);
            return { remove() {} };
        },
    },
}));

const flagsOn = () => localStorage.setItem('ddmau:relFlags', JSON.stringify({ flags: { skipNoChangeTx: true } }));
const DEV = 'device-aaaa';
const entry = (t, deviceId = DEV, extra = {}) => ({ token: t, lastSeen: 1, deviceId, ...extra });
const roster = (...list) => ({ rev: 7, list });
const person = (name, fcmTokens) => ({ name, ...(fcmTokens ? { fcmTokens } : {}) });
const outcomes = () => JSON.parse(localStorage.getItem('ddmau:pushOutcomes') || '{}');
const ana = () => serverDoc.list.find((s) => s.name === 'Ana');

const realTimeout = globalThis.setTimeout;
const flush = () => new Promise((r) => realTimeout(r, 0));
const serverSnap = (data) => ({ exists: () => !!data, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
const cacheSnap = (data) => ({ exists: () => !!data, data: () => data, metadata: { fromCache: true, hasPendingWrites: false } });

async function load() {
    vi.resetModules();
    return import('./messaging.js');
}

// Starts a boot bind and returns once its listener is up, with the wait under test control.
async function startBoot(m) {
    const before = listeners.length;
    const p = m.enableFcmPush('Ana', [], null, { bootCheck: true });
    await vi.waitFor(() => expect(listeners.length).toBe(before + 1), { timeout: 3000, interval: 5 });
    return { p, listener: listeners[listeners.length - 1] };
}

beforeEach(() => {
    testMode = false;
    native = null;
    token = 'T1';
    commitError = null;
    serverDoc = roster(person('Ana', [entry('T1')]), person('Bo'));
    listeners.length = 0;
    runTransaction.mockClear();
    onSnapshot.mockClear();
    localStorage.clear();
    localStorage.setItem('ddmau:fcmDeviceId', DEV);
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { getRegistrations: async () => [], register: async () => ({}) },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('flag off, never delivered, or test mode: exactly today', () => {
    it.each([
        ['never delivered', () => {}],
        ['set off', () => localStorage.setItem('ddmau:relFlags', JSON.stringify({ flags: { skipNoChangeTx: false } }))],
        ['test mode', () => { flagsOn(); testMode = true; }],
    ])('%s: transaction runs, no listener, nothing counted', async (_label, arrange) => {
        arrange();
        const m = await load();
        const before = JSON.stringify(serverDoc);
        const r = await m.enableFcmPush('Ana', [], null, { bootCheck: true });
        expect(runTransaction).toHaveBeenCalledTimes(1);
        expect(onSnapshot).not.toHaveBeenCalled();
        expect(JSON.stringify(serverDoc)).toBe(before); // internal check still finds nothing to do
        expect(r).toEqual({ ok: true, token: 'T1', persisted: true });
        expect(localStorage.getItem('ddmau:pushOutcomes')).toBeNull();
    });

    it('a rotated token still writes', async () => {
        token = 'T2';
        const m = await load();
        await m.enableFcmPush('Ana', [], null, { bootCheck: true });
        expect(ana().fcmTokens.map((t) => t.token)).toEqual(['T2']);
        expect(serverDoc.rev).toBe(8);
    });
});

describe('flag on', () => {
    beforeEach(flagsOn);

    it('a button tap never skips: no boot check asked for', async () => {
        const m = await load();
        await m.enableFcmPush('Ana', [], null);
        expect(runTransaction).toHaveBeenCalledTimes(1);
        expect(onSnapshot).not.toHaveBeenCalled();
    });

    it('server says bound: no transaction, reported as saved, UI told, counted', async () => {
        const m = await load();
        const seen = vi.fn();
        window.addEventListener('ddmau:pushBound', seen);
        const { p, listener } = await startBoot(m);
        expect(listener.opts).toEqual({ includeMetadataChanges: true });
        listener.next(serverSnap(serverDoc));
        const r = await p;
        window.removeEventListener('ddmau:pushBound', seen);
        expect(runTransaction).not.toHaveBeenCalled();
        expect(r).toEqual({ ok: true, token: 'T1', persisted: true });
        expect(seen).toHaveBeenCalledTimes(1);
        expect(listener.stopped).toBe(true);
        expect(outcomes()).toEqual({ 'already-bound': 1 });
    });

    it('rotated token: the transaction runs and writes', async () => {
        token = 'T2';
        const m = await load();
        const { p, listener } = await startBoot(m);
        listener.next(serverSnap(serverDoc));
        await p;
        expect(runTransaction).toHaveBeenCalledTimes(1);
        expect(ana().fcmTokens.map((t) => t.token)).toEqual(['T2']);
        expect(outcomes()).toEqual({ 'tx:wrote': 1 });
    });

    it('another person holds this device: the transaction runs and takes it off them', async () => {
        serverDoc = roster(person('Ana'), person('Bo', [entry('T1')]));
        const m = await load();
        const { p, listener } = await startBoot(m);
        listener.next(serverSnap(serverDoc));
        await p;
        expect(ana().fcmTokens.map((t) => t.token)).toEqual(['T1']);
        expect(serverDoc.list[1].fcmTokens).toEqual([]);
    });

    it('my record is right but someone else also has it: the sweep still runs', async () => {
        serverDoc = roster(person('Ana', [entry('T1')]), person('Bo', [entry('OLD')]));
        const m = await load();
        const { p, listener } = await startBoot(m);
        listener.next(serverSnap(serverDoc));
        await p;
        expect(runTransaction).toHaveBeenCalledTimes(1);
        expect(serverDoc.list[1].fcmTokens).toEqual([]);
    });

    it.each([
        ['server has no such doc', (l) => l.next(serverSnap(null))],
        ['listener errors', (l) => l.error(new Error('denied'))],
        ['malformed roster', (l) => l.next(serverSnap({ list: [null] }))],
    ])('doubt, %s: the transaction runs', async (_label, act) => {
        const m = await load();
        const { p, listener } = await startBoot(m);
        act(listener);
        await p.catch(() => {});
        expect(runTransaction).toHaveBeenCalledTimes(1);
        expect(listener.stopped).toBe(true);
    });

    it('onSnapshot throwing is doubt too', async () => {
        onSnapshot.mockImplementationOnce(() => { throw new Error('boom'); });
        const m = await load();
        const r = await m.enableFcmPush('Ana', [], null, { bootCheck: true });
        expect(runTransaction).toHaveBeenCalledTimes(1);
        expect(r.persisted).toBe(true);
    });

    describe('when the server stays quiet', () => {
        beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });

        it('cached says bound: skips for now, then a server answer that agrees changes nothing', async () => {
            const m = await load();
            const { p, listener } = await startBoot(m);
            listener.next(cacheSnap(serverDoc));
            vi.advanceTimersByTime(3000);
            const r = await p;
            expect(r.persisted).toBe(true);
            expect(runTransaction).not.toHaveBeenCalled();
            expect(listener.stopped).toBe(false);
            listener.next(serverSnap(serverDoc));
            await flush();
            expect(runTransaction).not.toHaveBeenCalled();
            expect(listener.stopped).toBe(true);
            expect(outcomes()).toEqual({ 'already-bound:cache': 1, 'cache-confirmed': 1 });
        });

        // The silent failure this whole file guards against: the token was pruned
        // while the app was closed and the cache hasn't heard.
        it('cached says bound but the server disagrees: the binding comes back', async () => {
            const stale = roster(person('Ana', [entry('T1')]), person('Bo'));
            serverDoc = roster(person('Ana', []), person('Bo'));
            const m = await load();
            const { p, listener } = await startBoot(m);
            listener.next(cacheSnap(stale));
            vi.advanceTimersByTime(3000);
            await p;
            expect(runTransaction).not.toHaveBeenCalled();
            listener.next(serverSnap(serverDoc));
            await vi.waitFor(() => expect(ana().fcmTokens.map((t) => t.token)).toEqual(['T1']), { interval: 5 });
            expect(outcomes()).toEqual({ 'already-bound:cache': 1, 'late-rebind:wrote': 1 });
        });

        it('cached says bound, then the listener dies: the transaction runs', async () => {
            const m = await load();
            const { p, listener } = await startBoot(m);
            listener.next(cacheSnap(serverDoc));
            vi.advanceTimersByTime(3000);
            await p;
            listener.error(new Error('gone'));
            await vi.waitFor(() => expect(runTransaction).toHaveBeenCalledTimes(1), { interval: 5 });
        });

        it('cached says not bound: the transaction runs at the end of the wait', async () => {
            token = 'T2';
            const m = await load();
            const { p, listener } = await startBoot(m);
            listener.next(cacheSnap(serverDoc));
            expect(runTransaction).not.toHaveBeenCalled();
            vi.advanceTimersByTime(3000);
            await p;
            expect(runTransaction).toHaveBeenCalledTimes(1);
            expect(listener.stopped).toBe(true);
        });

        it('no roster anywhere: the transaction runs', async () => {
            const m = await load();
            const { p } = await startBoot(m);
            vi.advanceTimersByTime(3000);
            await p;
            expect(runTransaction).toHaveBeenCalledTimes(1);
        });

        it('falls back to the latest doc App has seen', async () => {
            const m = await load();
            const { noteStaffSnapshot } = await import('./data/staffDoc.js');
            noteStaffSnapshot(serverDoc);
            const { p } = await startBoot(m);
            vi.advanceTimersByTime(3000);
            await p;
            expect(runTransaction).not.toHaveBeenCalled();
            expect(outcomes()).toEqual({ 'already-bound:cache': 1 });
        });

        it('someone signs out during the wait: the stale bind never runs', async () => {
            serverDoc = roster(person('Ana', []), person('Bo'));
            const m = await load();
            const { p, listener } = await startBoot(m);
            await m.disableFcmPush('Ana');
            expect(listener.stopped).toBe(true);
            runTransaction.mockClear();
            vi.advanceTimersByTime(3000);
            await p;
            await flush();
            expect(runTransaction).not.toHaveBeenCalled();
            expect(ana().fcmTokens).toEqual([]);
        });

        it('a pending server check is dropped when someone signs out first', async () => {
            serverDoc = roster(person('Ana', []), person('Bo'));
            const m = await load();
            const { p, listener } = await startBoot(m);
            listener.next(cacheSnap(roster(person('Ana', [entry('T1')]), person('Bo'))));
            vi.advanceTimersByTime(3000);
            await p;
            await m.disableFcmPush('Ana');
            runTransaction.mockClear();
            listener.next(serverSnap(serverDoc));
            await flush();
            expect(runTransaction).not.toHaveBeenCalled();
            expect(listener.stopped).toBe(true);
        });
    });

    it('after any token removal on this page, the snapshot isn\'t trusted', async () => {
        const m = await load();
        await m.disableFcmPush('Bo');
        runTransaction.mockClear();
        await m.enableFcmPush('Ana', [], null, { bootCheck: true });
        expect(onSnapshot).not.toHaveBeenCalled();
        expect(runTransaction).toHaveBeenCalledTimes(1);
        await m.purgeDeviceTokensAllStaff();
    });

    it('after a token write on this page, the next bind runs the transaction', async () => {
        token = 'T2';
        const m = await load();
        const { p, listener } = await startBoot(m);
        listener.next(serverSnap(serverDoc));
        await p;
        onSnapshot.mockClear();
        runTransaction.mockClear();
        await m.enableFcmPush('Ana', [], null, { bootCheck: true });
        expect(onSnapshot).not.toHaveBeenCalled();
        expect(runTransaction).toHaveBeenCalledTimes(1);
    });

    it('a failed transaction reaches the caller and is counted', async () => {
        token = 'T2';
        commitError = new Error('offline');
        native = 'android';
        const m = await load();
        const { p, listener } = await startBoot(m);
        listener.next(serverSnap(serverDoc));
        const r = await p;
        expect(r).toMatchObject({ ok: true, persisted: false, persistError: 'offline' });
        expect(outcomes()).toEqual({ 'tx:error': 1 });
    });
});

describe('native', () => {
    it.each([['ios', 'apns_raw'], ['android', 'fcm']])('%s binds with its platform tags', async (platform, tokenKind) => {
        native = platform;
        serverDoc = roster(person('Ana'));
        const m = await load();
        const r = await m.enableFcmPush('Ana', [], null);
        expect(r).toMatchObject({ ok: true, persisted: true, platform, tokenKind });
        expect(ana().fcmTokens[0]).toMatchObject({ token: 'T1', deviceId: DEV, platform, tokenKind });
    });

    it('flag on and already bound: skips, and the result keeps its native fields', async () => {
        flagsOn();
        native = 'ios';
        serverDoc = roster(person('Ana', [entry('T1', DEV, { platform: 'ios', tokenKind: 'apns_raw' })]));
        const m = await load();
        const { p, listener } = await startBoot(m);
        listener.next(serverSnap(serverDoc));
        const r = await p;
        expect(runTransaction).not.toHaveBeenCalled();
        expect(r).toEqual({ ok: true, token: 'T1', platform: 'ios', tokenKind: 'apns_raw', persisted: true });
    });

    it('flag on and rotated: writes the new token with its tags', async () => {
        flagsOn();
        native = 'android';
        token = 'T2';
        const m = await load();
        const { p, listener } = await startBoot(m);
        listener.next(serverSnap(serverDoc));
        await p;
        expect(ana().fcmTokens).toHaveLength(1);
        expect(ana().fcmTokens[0]).toMatchObject({ token: 'T2', platform: 'android', tokenKind: 'fcm' });
    });

    it('someone not on the roster is not reported as saved', async () => {
        native = 'ios';
        serverDoc = roster(person('Bo'));
        const m = await load();
        const r = await m.enableFcmPush('Ana', [], null);
        expect(r).toMatchObject({ persisted: false, reason: 'staff-not-found' });
    });
});

describe('web', () => {
    it('the saved entry has no platform keys', async () => {
        serverDoc = roster(person('Ana'));
        const m = await load();
        await m.enableFcmPush('Ana', [], null);
        expect(Object.keys(ana().fcmTokens[0]).sort()).toEqual(['deviceId', 'lastSeen', 'token']);
    });
});
