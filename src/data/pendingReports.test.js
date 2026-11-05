import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const landed = [];
const setDocMock = vi.fn();
vi.mock('./testMode', () => ({ TEST_MODE: false }));
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('./sentryClient', () => ({ setSentryIdentity: vi.fn(), captureException: vi.fn() }));
vi.mock('firebase/firestore', () => ({
    addDoc: vi.fn(async () => ({ id: 'auto' })),
    collection: vi.fn(),
    doc: vi.fn((_db, c, id) => ({ c, id })),
    serverTimestamp: vi.fn(() => 'ts'),
    setDoc: (...a) => setDocMock(...a),
}));

async function fresh() {
    vi.resetModules();
    const pending = await import('./pendingReports.js');
    const flush = await import('./reportFlush.js');
    const toast = await import('../toast.js');
    return { ...pending, ...flush, toastMod: toast };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    landed.length = 0;
    setDocMock.mockReset();
    setDocMock.mockImplementation(async (ref, row) => { landed.push({ c: ref.c, id: ref.id, row }); });
});

let nowSpy = null;
function restoreClock() {
    nowSpy?.mockRestore();
    nowSpy = null;
}
afterEach(restoreClock);

// Moves the clock past the wait between sends, so the next flush can send again.
function afterResendWindow(m, windows = 1) {
    restoreClock();
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + windows * (m.RESEND_EVERY_MS + 1));
}

describe('parked reports', () => {
    it('3 same-reason reports make 3 rows, each on its own ID', async () => {
        const m = await fresh();
        m.parkReport({ reason: 'write-stuck-after-revive', at: 1 });
        m.parkReport({ reason: 'write-stuck-after-revive', at: 2 });
        m.parkReport({ reason: 'write-stuck-after-revive', at: 3 });
        await m.flushParkedReports({ language: 'en' });
        expect(landed).toHaveLength(3);
        expect(new Set(landed.map((l) => l.id)).size).toBe(3);
        expect(m.readParkedReports()).toHaveLength(0);
    });

    it('a hung write keeps the report on the list', async () => {
        const m = await fresh();
        setDocMock.mockImplementation(() => new Promise(() => {}));
        m.parkReport({ reason: 'probe-stuck', at: 1 });
        m.flushParkedReports({ language: 'en' });
        await new Promise((r) => setTimeout(r, 0));
        expect(m.readParkedReports()).toHaveLength(1);
    });

    it('a failed write keeps it, and a repeat the server refuses clears it', async () => {
        const m = await fresh();
        m.parkReport({ reason: 'probe-stuck', at: 1 });
        setDocMock.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'unavailable' }));
        await m.flushParkedReports({});
        expect(m.readParkedReports()).toHaveLength(1);
        afterResendWindow(m);
        setDocMock.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'permission-denied' }));
        await m.flushParkedReports({});
        expect(m.readParkedReports()).toHaveLength(0);
    });

    it('waits between sends', async () => {
        const m = await fresh();
        setDocMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'unavailable' }));
        m.parkReport({ reason: 'probe-stuck', at: 1 });
        await m.flushParkedReports({});
        await m.flushParkedReports({});
        expect(setDocMock).toHaveBeenCalledTimes(1);
        expect(m.readParkedReports()[0].attempts).toBe(1);
        afterResendWindow(m);
        await m.flushParkedReports({});
        expect(setDocMock).toHaveBeenCalledTimes(2);
    });

    it('at the send limit it gives up, and records that no write was confirmed', async () => {
        let m = await fresh();
        setDocMock.mockImplementation(() => new Promise(() => {}));
        const id = m.parkReport({ reason: 'fs-heal-wiped', cls: 'crash', at: 1 });
        for (let i = 0; i < m.MAX_SEND_ATTEMPTS; i++) {
            afterResendWindow(m, i);
            m.flushParkedReports({});
            await new Promise((r) => setTimeout(r, 0));
            // Each try is a new boot: a hung send only holds its place for one page.
            m = await fresh();
        }
        expect(setDocMock).toHaveBeenCalledTimes(m.MAX_SEND_ATTEMPTS);
        expect(m.readDroppedReports().entries).toHaveLength(0);
        afterResendWindow(m, m.MAX_SEND_ATTEMPTS);
        await m.flushParkedReports({});
        expect(m.readParkedReports()).toHaveLength(0);
        expect(setDocMock).toHaveBeenCalledTimes(m.MAX_SEND_ATTEMPTS);
        expect(m.readDroppedReports().entries).toEqual([
            expect.objectContaining({ id, reason: 'fs-heal-wiped', cls: 'crash', attempts: m.MAX_SEND_ATTEMPTS }),
        ]);
    });

    it('a send the logger never issued uses up no attempt', async () => {
        const m = await fresh();
        const { logError } = await import('./logger.js');
        for (let i = 0; i < 40; i++) await logError({ error: new Error(`fill ${i}`), parked: true, docId: `fill_${i}` });
        setDocMock.mockClear();
        m.parkReport({ reason: 'probe-stuck', at: 1 });
        await m.flushParkedReports({});
        expect(setDocMock).not.toHaveBeenCalled();
        const [rep] = m.readParkedReports();
        expect(rep.attempts).toBeUndefined();
        expect(rep.lastSentAt).toBeUndefined();
    });

    it('the cap holds, keeping the newest', async () => {
        const m = await fresh();
        for (let i = 0; i < m.MAX_PARKED + 5; i++) m.parkReport({ reason: 'r', at: i + 1 });
        const list = m.readParkedReports();
        expect(list).toHaveLength(m.MAX_PARKED);
        expect(list.at(-1).at).toBe(m.MAX_PARKED + 5);
    });

    it('still reads the old single slot, once', async () => {
        const m = await fresh();
        sessionStorage.setItem(m.LEGACY_REPORT_KEY, JSON.stringify({ reason: 'old', at: 5 }));
        expect(m.readParkedReports().map((r) => r.reason)).toEqual(['old']);
        expect(sessionStorage.getItem(m.LEGACY_REPORT_KEY)).toBeNull();
        expect(m.readParkedReports()).toHaveLength(1);
    });

    it('stamps which boot delivered it', async () => {
        const m = await fresh();
        expect(m.deliveredBootLabel({ parkedBoot: m.getBootSeq() })).toBe('next');
        expect(m.deliveredBootLabel({ parkedBoot: m.getBootSeq() - 1 })).toBe('next');
        expect(m.deliveredBootLabel({ parkedBoot: m.getBootSeq() - 2 })).toBe('later');
    });
});

describe('the message after a reload', () => {
    function toastsOf(m) {
        let seen = [];
        m.toastMod.subscribeToasts((t) => { seen = t; });
        return () => seen;
    }

    it('shows once, sticky, in their language, only when a report was parked', async () => {
        const m = await fresh();
        const seen = toastsOf(m);
        await m.flushParkedReports({ language: 'es' });
        expect(seen()).toHaveLength(0);
        m.parkReport({ reason: 'probe-stuck', at: Date.now() });
        setDocMock.mockImplementation(() => new Promise(() => {}));
        m.flushParkedReports({ language: 'es' });
        expect(seen()).toHaveLength(1);
        expect(seen()[0].duration).toBe(0);
        expect(seen()[0].message).toContain('La app se reinició');
        expect(seen()[0].message).not.toContain('The app restarted');
        // Re-sent report, same person: no second message.
        m.flushParkedReports({ language: 'es' });
        expect(seen()).toHaveLength(1);
    });

    it('says nothing about an old reload', async () => {
        const m = await fresh();
        const seen = toastsOf(m);
        m.parkReport({ reason: 'probe-stuck', at: Date.now() - m.NOTIFY_WITHIN_MS - 1 });
        await m.flushParkedReports({ language: 'en' });
        expect(seen()).toHaveLength(0);
        expect(landed).toHaveLength(1);
    });
});

describe('the daily device row', () => {
    it('writes once a day, on a fixed ID, and not to Sentry', async () => {
        const m = await fresh();
        const sentry = await import('./sentryClient');
        sentry.captureException.mockClear();
        const day = new Date('2026-11-03T20:00:00Z');
        await m.logDeviceSeenOncePerDay({ staffName: 'Laura', now: day });
        await m.logDeviceSeenOncePerDay({ staffName: 'Laura', now: day });
        expect(landed).toHaveLength(1);
        expect(landed[0].id).toMatch(/^seen_.+_2026-11-03$/);
        expect(landed[0].c).toBe('device_seen');
        expect(landed[0].row).toMatchObject({ day: '2026-11-03', signedIn: 'Laura', capgoDeviceId: null });
        expect(landed[0].row.deviceId).toBeTruthy();
        expect(landed[0].row.droppedReports).toBeUndefined();
        expect(sentry.captureException).not.toHaveBeenCalled();
        await m.logDeviceSeenOncePerDay({ staffName: 'Laura', now: new Date('2026-11-04T20:00:00Z') });
        expect(landed).toHaveLength(2);
    });

    it('carries reports given up on, and clears them only once the row lands', async () => {
        const m = await fresh();
        m.noteReportDropped({ reportId: 'rr_1', reason: 'probe-stuck', cls: 'sdk-stuck', attempts: 3 }, 5);
        setDocMock.mockRejectedValueOnce(new Error('nope'));
        await m.logDeviceSeenOncePerDay({ staffName: 'Laura', now: new Date('2026-11-03T20:00:00Z') });
        expect(m.readDroppedReports().entries).toHaveLength(1);
        await m.logDeviceSeenOncePerDay({ staffName: 'Laura', now: new Date('2026-11-03T20:00:00Z') });
        expect(landed[0].row.droppedReports).toEqual([{ id: 'rr_1', reason: 'probe-stuck', cls: 'sdk-stuck', attempts: 3, at: 5 }]);
        expect(landed[0].row.droppedReportsOverflow).toBe(0);
        expect(m.readDroppedReports().entries).toHaveLength(0);
    });

    it('keeps the newest dropped reports and counts the rest', async () => {
        const m = await fresh();
        for (let i = 0; i < m.MAX_DROPPED_KEPT + 3; i++) m.noteReportDropped({ reportId: `rr_${i}` }, i);
        m.noteReportDropped({ reportId: `rr_${m.MAX_DROPPED_KEPT + 2}` }, 99);
        const d = m.readDroppedReports();
        expect(d.entries).toHaveLength(m.MAX_DROPPED_KEPT);
        expect(d.overflow).toBe(3);
        expect(d.entries.at(-1).id).toBe(`rr_${m.MAX_DROPPED_KEPT + 2}`);
    });
});

describe('after-reload message and place:restored (Release B)', () => {
    const on = () => localStorage.setItem('ddmau:relFlags', JSON.stringify({ flags: { placeRestore: true } }));
    const place = { tab: 'operations', subTab: 'inventory', body: 'tab', msSinceBoot: 900 };
    const messages = (m) => {
        const seen = [];
        m.toastMod.subscribeToasts((list) => list.forEach((t) => { if (!seen.includes(t.message)) seen.push(t.message); }));
        return seen;
    };

    it('text: flag-off wording is byte-for-byte Release A', async () => {
        const m = await fresh();
        expect(m.reloadToastText('en')).toBe('The app restarted to fix a stuck connection. Check your last changes before entering them again.');
        expect(m.reloadToastText('es')).toBe('La app se reinició para arreglar la conexión. Revisa tus últimos cambios antes de volver a ingresarlos.');
        expect(m.reloadToastText('en', { restored: true })).toBe("The app restarted to fix a stuck connection. You're back where you were. Check your last changes before entering them again.");
        expect(m.reloadToastText('es', { restored: true })).toBe('La app se reinició para arreglar la conexión. Estás donde estabas. Revisa tus últimos cambios antes de volver a ingresarlos.');
    });

    it('flag off: no row and no line, whatever place is passed', async () => {
        const m = await fresh();
        const seen = messages(m);
        m.parkReport({ reason: 'write-stuck-after-revive', at: Date.now(), activeTab: 'operations' });
        await m.flushParkedReports({ language: 'en', place });
        expect(landed.filter((r) => r.row.feature === 'place:restored')).toHaveLength(0);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBe(m.reloadToastText('en'));
    });

    it('flag on, tab area still connecting: no line, row says not restored', async () => {
        on();
        const m = await fresh();
        const seen = messages(m);
        m.parkReport({ reason: 'probe-3min', at: Date.now(), activeTab: 'operations' });
        await m.flushParkedReports({ language: 'en', place: { ...place, body: 'connecting' } });
        expect(seen[0]).not.toContain('back where');
        expect(landed.find((r) => r.row.feature === 'place:restored').row.meta).toMatchObject({ restored: false, landedHome: false });
    });

    it('flag on, restored: one row joined on reloadId, and it says so', async () => {
        on();
        const m = await fresh();
        const seen = messages(m);
        const id = m.parkReport({ reason: 'write-stuck-after-revive', at: Date.now(), activeTab: 'operations' });
        await m.flushParkedReports({ language: 'en', place });
        expect(seen[0]).toContain("You're back where you were.");
        const rows = landed.filter((r) => r.row.feature === 'place:restored');
        expect(rows).toHaveLength(1);
        expect(rows[0].row.meta).toMatchObject({ reloadId: id, tab: 'operations', subTab: 'inventory', restored: true, landedHome: false, msSinceBoot: 900 });
        // The reload's own row still goes under its own feature.
        expect(landed.filter((r) => r.row.feature === 'firestoreRevive:reload-after')).toHaveLength(1);
        // A later boot neither repeats the row nor brings the message back.
        await m.flushParkedReports({ language: 'en', place });
        expect(landed.filter((r) => r.row.feature === 'place:restored')).toHaveLength(1);
    });

    it('flag on, on Home after being elsewhere: recorded as landed on Home, not restored', async () => {
        on();
        const m = await fresh();
        m.parkReport({ reason: 'probe-3min', at: Date.now(), activeTab: 'operations' });
        await m.flushParkedReports({ language: 'en', place: { tab: 'home', subTab: null, body: 'home', msSinceBoot: 5 } });
        const row = landed.find((r) => r.row.feature === 'place:restored');
        expect(row.row.meta).toMatchObject({ restored: false, landedHome: true });
    });

    it('a place row never counts as a reload that needs telling', async () => {
        on();
        const m = await fresh();
        m.parkReport({ feature: 'inventory:add', reason: 'add-deadline', notified: true, at: Date.now() });
        await m.flushParkedReports({ language: 'en', place });
        expect(landed.filter((r) => r.row.feature === 'place:restored')).toHaveLength(0);
        expect(landed.filter((r) => r.row.feature === 'inventory:add')).toHaveLength(1);
    });
});
