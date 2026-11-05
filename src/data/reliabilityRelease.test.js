import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testMode = false;
vi.mock('./testMode', () => ({ get TEST_MODE() { return testMode; } }));

beforeEach(() => { testMode = false; localStorage.clear(); vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); });

describe('flags', () => {
    it('default off, and a broken store reads as off', async () => {
        const { getReliabilityFlag, FLAGS_KEY } = await import('./reliabilityFlags.js');
        expect(getReliabilityFlag('placeRestore')).toBe(false);
        localStorage.setItem(FLAGS_KEY, '{not json');
        expect(getReliabilityFlag('placeRestore')).toBe(false);
    });

    it('off in test mode even when set, and nothing is written or fetched', async () => {
        const { getReliabilityFlag, applyReliabilityConfig, refreshReliabilityFlags, FLAGS_KEY } = await import('./reliabilityFlags.js');
        localStorage.setItem(FLAGS_KEY, JSON.stringify({ flags: { placeRestore: true } }));
        testMode = true;
        expect(getReliabilityFlag('placeRestore')).toBe(false);
        applyReliabilityConfig({ flags: { other: true } });
        expect(JSON.parse(localStorage.getItem(FLAGS_KEY)).flags.other).toBeUndefined();
        const fetchImpl = vi.fn();
        expect(await refreshReliabilityFlags(fetchImpl)).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('pilot flags reach listed devices only, by whole ID or badge ID', async () => {
        const { resolveFlags } = await import('./reliabilityFlags.js');
        const rel = { flags: { a: true }, pilot: { devices: { abc123: { b: true }, 'whole-device-id-1': { c: true } } } };
        expect(resolveFlags(rel, 'xxxxabc123')).toEqual({ a: true, b: true });
        // One device's flags never reach another pilot device.
        expect(resolveFlags(rel, 'whole-device-id-1')).toEqual({ a: true, c: true });
        expect(resolveFlags(rel, 'other-device')).toEqual({ a: true });
        expect(resolveFlags(null, 'x')).toEqual({});
        // A key under 6 characters is too short to trust as a suffix.
        expect(resolveFlags({ pilot: { devices: { abc: { b: true } } } }, 'xabc')).toEqual({});
    });

    it('reads a real REST document shape', async () => {
        const { reliabilityFromRestDoc } = await import('./reliabilityFlags.js');
        expect(reliabilityFromRestDoc({ fields: { min: { stringValue: '1.0.1' } } })).toBeNull();
        expect(reliabilityFromRestDoc({ fields: { reliability: { mapValue: { fields: {
            flags: { mapValue: { fields: { placeRestore: { booleanValue: true } } } },
            pilot: { mapValue: { fields: { devices: { mapValue: { fields: { abc123: { mapValue: { fields: { b: { booleanValue: true } } } } } } } } } },
        } } } } })).toEqual({ flags: { placeRestore: true }, pilot: { devices: { abc123: { b: true } } } });
    });

    it('a failed read keeps the last flags', async () => {
        const { refreshReliabilityFlags, getReliabilityFlag, FLAGS_KEY } = await import('./reliabilityFlags.js');
        localStorage.setItem(FLAGS_KEY, JSON.stringify({ flags: { x: true } }));
        expect(await refreshReliabilityFlags(vi.fn().mockRejectedValue(new Error('offline')))).toBe(false);
        expect(await refreshReliabilityFlags(vi.fn().mockResolvedValue({ ok: false }))).toBe(false);
        expect(getReliabilityFlag('x')).toBe(true);
    });

    it('gives up on a slow read', async () => {
        vi.useFakeTimers();
        const { refreshReliabilityFlags, FLAG_FETCH_CAP_MS } = await import('./reliabilityFlags.js');
        const fetchImpl = vi.fn((_u, { signal }) => new Promise((_res, rej) => {
            signal.addEventListener('abort', () => rej(new Error('aborted')));
        }));
        const p = refreshReliabilityFlags(fetchImpl);
        await vi.advanceTimersByTimeAsync(FLAG_FETCH_CAP_MS + 1);
        expect(await p).toBe(false);
    });
});

describe('old-definition line', () => {
    const weekly = createRequire(import.meta.url)('../../scripts/reliability-weekly.cjs');
    const IPAD_APP = { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)', viewport: '1024x768' };
    const IPHONE_APP = { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)', viewport: '390x844' };

    it.each([
        ['crash heal', { reason: 'fs-heal-wiped' }, 'fs-heal'],
        ['write-stuck, timed-out probe at exactly 5 s', { reason: 'write-stuck-after-revive', preProbe: 'timeout', probeMs: 5000 }, 'write-stuck'],
        ['write-stuck, older row with no probeMs', { reason: 'write-stuck-after-revive', preProbe: 'timeout' }, 'write-stuck'],
        ['write-stuck, slow probe', { reason: 'write-stuck-after-revive', preProbe: 'rejected', probeMs: 6000 }, 'write-stuck'],
        ['write-stuck, fast rejected probe', { reason: 'write-stuck-after-revive', preProbe: 'rejected', probeMs: 10 }, null],
        ['probe reload', { reason: 'probe-stuck', detectedBy: 'probe-3min' }, 'probe'],
        ['probe reload, older row', { reason: 'probe-stuck' }, 'probe'],
        ['delivered on a later boot', { reason: 'fs-heal-wiped', deliveredBoot: 'later' }, null],
        ['delivered on the next boot', { reason: 'fs-heal-wiped', deliveredBoot: 'next' }, 'fs-heal'],
        ['anything else', { reason: 'other' }, null],
    ])('%s', (_name, meta, kind) => {
        expect(weekly.oldLineKind({ meta })).toBe(kind);
    });

    it('leaves off dev rows, Andrew, and listed devices', () => {
        expect(weekly.isExcludedFromOldLine({ env: 'dev' }, [])).toBe(true);
        expect(weekly.isExcludedFromOldLine({ env: 'prod', userName: 'Andrew Shih' }, [])).toBe(true);
        expect(weekly.isExcludedFromOldLine({ env: 'prod', deviceId: 'xxxxabc123' }, ['abc123'])).toBe(true);
        expect(weekly.isExcludedFromOldLine({ env: 'prod', userName: 'Laura', deviceId: 'xxxxabc123' }, ['zzz999'])).toBe(false);
        expect(weekly.isExcludedFromOldLine({ env: 'prod', userName: 'Laura' }, ['abc123'])).toBe(false);
    });

    it('classes devices the way the baseline did', () => {
        expect(weekly.deviceClass(IPAD_APP)).toBe('iPad app');
        expect(weekly.deviceClass(IPHONE_APP)).toBe('iPhone app');
        expect(weekly.deviceClass({ ...IPAD_APP, viewport: '1330x978' })).toBe('Mac-UA WebView (odd size)');
    });

    it('merges by person and device class under 30 minutes', () => {
        const min = 60 * 1000;
        const row = (userName, device, at) => ({ userName, device, occurredAt: at + 5, meta: { at } });
        const eps = weekly.mergeEpisodes([
            row('Laura', IPAD_APP, 40 * min),
            row('Laura', IPAD_APP, 0),
            row('Laura', IPAD_APP, 29 * min),
            row('Laura', IPAD_APP, 70 * min),
            row('Laura', IPHONE_APP, 1 * min),
            row('Maria', IPAD_APP, 2 * min),
        ]);
        // 0-29-40 chain; 70 is exactly 30 from 40, so it starts a new one.
        expect(eps.map((e) => e.rows.length).sort()).toEqual([1, 1, 1, 3]);
    });
});

describe('request watcher', () => {
    class FakeXHR {
        constructor() { this.listeners = {}; this.timeout = 0; }
        open() { this.opened = [...arguments]; }
        send(body) { this.sent = body; this.sendArgs = arguments.length; }
        addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }
        finish() { (this.listeners.loadend || []).forEach((f) => f()); }
    }

    it('records commits and leaves everything about them alone', async () => {
        const { installNetWatch, getNetWatchTelemetry } = await import('./netWatch.js');
        const XHR = class extends FakeXHR {};
        expect(installNetWatch(XHR)).toBe(true);
        const x = new XHR();
        x.timeout = 12345;
        x.open('POST', 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents:commit', true);
        x.send('12345');
        expect(x.opened).toHaveLength(3);
        expect(x.sent).toBe('12345');
        expect(x.timeout).toBe(12345);
        const t = getNetWatchTelemetry(Date.now() + 500);
        expect(t.commitInFlight).toBe(1);
        expect(t.oldestCommitBytes).toBe(5);
        expect(t.oldestCommitMs).toBeGreaterThanOrEqual(500);
        x.finish();
        expect(getNetWatchTelemetry().commitInFlight).toBe(0);
    });

    it('never touches a printer or any other URL', async () => {
        const { installNetWatch, getNetWatchTelemetry, matchesWatchedUrl } = await import('./netWatch.js');
        const XHR = class extends FakeXHR {};
        installNetWatch(XHR);
        for (const url of ['http://192.168.1.50/cgi-bin/epos/service.cgi', 'http://192.168.1.51:631/ipp/print', 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Write/channel']) {
            expect(matchesWatchedUrl(url)).toBe(false);
            const x = new XHR();
            x.open('POST', url);
            x.send('x');
            expect(x.listeners.loadend).toBeUndefined();
        }
        expect(getNetWatchTelemetry().commitInFlight).toBe(0);
    });

    it('stands down in test mode', async () => {
        testMode = true;
        const { installNetWatch } = await import('./netWatch.js');
        const XHR = class extends FakeXHR {};
        const open = XHR.prototype.open;
        expect(installNetWatch(XHR)).toBe(false);
        expect(XHR.prototype.open).toBe(open);
    });
});

describe('raw storage checks', () => {
    const openable = () => {
        const conn = {
            closed: false,
            close() { this.closed = true; },
            objectStoreNames: { contains: () => true },
            transaction: () => {
                const tx = { objectStore: () => ({ count: () => {} }) };
                setTimeout(() => tx.oncomplete?.(), 0);
                return tx;
            },
        };
        return conn;
    };

    it('never opens anything when the Firestore database is absent', async () => {
        const { probeFirestoreDb } = await import('./idbProbe.js');
        const idb = { databases: async () => [{ name: 'other' }], open: vi.fn() };
        expect((await probeFirestoreDb(idb)).r).toBe('absent');
        expect(idb.open).not.toHaveBeenCalled();
        const old = { open: vi.fn() };
        expect((await probeFirestoreDb(old)).r).toBe('absent');
        expect(old.open).not.toHaveBeenCalled();
    });

    it('opens with no version, and closes when done', async () => {
        const { probeFirestoreDb } = await import('./idbProbe.js');
        const conn = openable();
        const idb = {
            databases: async () => [{ name: 'firestore/[DEFAULT]/x/main' }],
            open: vi.fn(() => { const req = { result: conn }; setTimeout(() => req.onsuccess?.(), 0); return req; }),
        };
        expect((await probeFirestoreDb(idb)).r).toBe('ok');
        expect(idb.open.mock.calls[0]).toEqual(['firestore/[DEFAULT]/x/main']);
        expect(conn.closed).toBe(true);
    });

    it('aborts an upgrade rather than creating a database', async () => {
        const { probeFirestoreDb } = await import('./idbProbe.js');
        const abort = vi.fn();
        const idb = {
            databases: async () => [{ name: 'firestore/x' }],
            open: () => { const req = {}; setTimeout(() => req.onupgradeneeded?.({ target: { transaction: { abort } } }), 0); return req; },
        };
        expect((await probeFirestoreDb(idb)).r).toBe('absent');
        expect(abort).toHaveBeenCalled();
    });

    it('calls a silent open a hang at 2 seconds', async () => {
        vi.useFakeTimers();
        const { probeFirestoreDb, PROBE_CAP_MS } = await import('./idbProbe.js');
        const idb = { databases: async () => [{ name: 'firestore/x' }], open: () => ({}) };
        const p = probeFirestoreDb(idb);
        await vi.advanceTimersByTimeAsync(PROBE_CAP_MS + 1);
        expect((await p).r).toBe('hang');
    });

    it('stands down in test mode', async () => {
        testMode = true;
        const { probeFirestoreDb, probePrivateDb } = await import('./idbProbe.js');
        const idb = { databases: vi.fn(), open: vi.fn() };
        expect((await probeFirestoreDb(idb)).r).toBe('absent');
        expect((await probePrivateDb(idb)).r).toBe('absent');
        expect(idb.databases).not.toHaveBeenCalled();
        expect(idb.open).not.toHaveBeenCalled();
    });
});

describe('status wording', () => {
    it('shows one language, both only when unknown, and no counts', async () => {
        vi.doMock('../data/firestoreRevive', () => ({ subscribeInFlightWrites: () => () => {} }));
        const { syncPillLabel } = await import('../components/SyncPill.jsx');
        const es = syncPillLabel({ hardStuck: true, isNative: true, language: 'es' });
        expect(es).toContain('Cierra la app');
        expect(es).not.toContain('Close the app');
        expect(syncPillLabel({ hardStuck: true, isNative: false, language: 'en' })).toContain('Refresh the page');
        expect(syncPillLabel({ offline: true, language: 'en' })).toMatch(/^No connection\. Counts wait/);
        expect(syncPillLabel({ stuck: true, language: 'en' })).toBe('Still sending. Hold off on new changes until this goes away.');
        expect(syncPillLabel({ reloadNotice: true, hardStuck: true, language: 'en' })).toContain('Restarting');
        expect(syncPillLabel({ language: undefined })).toBe('Saving… / Guardando…');
        expect(syncPillLabel({ language: 'en' })).not.toMatch(/\d/);
    });
});
