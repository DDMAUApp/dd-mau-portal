// The Rice Log — mounts the real tab + rows + riceLog.js logic with Firestore
// mocked (2026-11-03): viewable by day, closing, editing, printed-by-mistake.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, act, fireEvent, within } from '@testing-library/react';

const listeners = [];
const setDocMock = vi.fn(async () => {});
const updateDocMock = vi.fn(async () => {});
vi.mock('../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn((...a) => ({ id: a.length === 1 ? 'newBatch' : a[a.length - 1] })),
    collection: vi.fn(() => ({ path: 'rice_log' })),
    onSnapshot: vi.fn((q, opts, cb, err) => {
        const l = { filters: q, cb, err, active: true };
        listeners.push(l);
        return () => { l.active = false; };
    }),
    query: vi.fn((coll, ...filters) => filters),
    where: vi.fn((...a) => a),
    setDoc: (...a) => setDocMock(...a),
    updateDoc: (...a) => updateDocMock(...a),
    arrayUnion: vi.fn((...x) => ({ arrayUnion: x })),
    increment: vi.fn((n) => ({ increment: n })),
    serverTimestamp: vi.fn(() => 'SERVER_TS'),
}));
vi.mock('../data/firestoreRevive', () => ({
    watchdogWrite: (p) => p,
    resilientSnapshot: (label, attach) => attach(() => {}, () => {}),
}));
const printRiceLabelMock = vi.fn(async () => ({ ok: true }));
vi.mock('../data/labelPrinting', () => ({ printRiceLabel: (...a) => printRiceLabelMock(...a) }));
const printViaNativeMock = vi.fn();
vi.mock('../capacitor-bridge', () => ({ printViaNative: (...a) => printViaNativeMock(...a) }));
vi.mock('../toast', () => ({ toast: vi.fn() }));

import RiceLogTab from './RiceLogTab';
import { useRiceBatchActions } from './useRiceBatchActions';

const NOW = new Date(2026, 10, 2, 13, 0);   // Mon Nov 2, 1:00p local
const iso = (h, m, d = 2) => new Date(2026, 10, d, h, m).toISOString();
const STAFF = [
    { id: 1, name: 'Cook Carla', role: 'Line Cook' },
    { id: 2, name: 'Lead Luis', role: 'Line Cook', shiftLead: true },
    { id: 3, name: 'Manager Mia', role: 'Manager' },
    { id: 40, name: 'Owner Andrew' },
];

const matches = (row, filters) => filters.every(([field, op, val]) => (op === 'in' ? val.includes(row[field]) : row[field] === val));
const feed = (rows, meta = {}) => act(async () => {
    for (const l of listeners) {
        if (!l.active) continue;
        const found = rows.filter((r) => matches(r, l.filters));
        l.cb({
            metadata: { fromCache: false, hasPendingWrites: false, ...meta },
            forEach: (fn) => found.forEach((r) => fn({ id: r.id, data: () => r })),
        });
    }
});

const today = (over = {}) => ({
    id: 'a', schemaVersion: 2, route: 'time_control', batchNo: 1, cookDay: '2026-11-02', location: 'webster', status: 'cooling',
    cookedBy: 'Rubisel Ramos', madeAt: iso(11, 0), cookedAt: iso(11, 0), wokByAt: iso(14, 45), tossByAt: iso(15, 0), fridgeByAt: iso(13, 0),
    startTempF: 198, startAttempts: [198], pans: 2, prints: [{ ok: true, copies: 2 }], notes: '',
    createdMs: new Date(iso(11, 0)).getTime(),
    ...over,
});
const fridge = (over = {}) => ({
    id: 'f', schemaVersion: 2, route: 'cooling', batchNo: 2, cookDay: '2026-11-02', location: 'webster', status: 'cooling',
    cookedBy: 'Rubisel Ramos', madeAt: iso(12, 30), cookedAt: iso(12, 30), seventyByAt: iso(14, 30), fortyOneByAt: iso(18, 30), useByDay: '2026-11-03',
    tossByAt: iso(18, 30), fridgeByAt: iso(14, 30),
    startTempF: 196, startAttempts: [196], pans: 1, prints: [{ ok: true, copies: 1 }], notes: '',
    createdMs: new Date(iso(12, 30)).getTime(),
    ...over,
});
// A row from before this change.
const old = (over = {}) => ({
    id: 'o', batchNo: 1, cookDay: '2026-11-02', location: 'webster', status: 'cooling',
    cookedBy: 'Laura Hurtado', cookedAt: iso(11, 0), fridgeByAt: iso(13, 0), tossByAt: iso(15, 0),
    stickerCount: 1, prints: [{ ok: true, copies: 1 }], notes: '',
    ...over,
});

const useFakeClock = () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
};
const open = async (rows, { staff = 'Cook Carla', props = {}, meta } = {}) => {
    const utils = render(<RiceLogTab location="webster" staffName={staff} staffList={STAFF} language="en" {...props} />);
    if (rows) await feed(rows, meta);
    return utils;
};
const row = (n) => screen.getByTestId(`rice-row-${n}`);

beforeEach(() => {
    listeners.length = 0;
    setDocMock.mockClear();
    updateDocMock.mockClear();
    updateDocMock.mockImplementation(async () => {});
    printRiceLabelMock.mockClear();
    printViaNativeMock.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('viewing a day', () => {
    it('opens on today at the store being viewed, with a big name and date', async () => {
        await open([]);
        expect(screen.getByRole('heading', { name: 'Webster Groves' })).toBeInTheDocument();
        expect(screen.getByText('MON 11/02/2026')).toBeInTheDocument();
        const day = listeners.find((l) => l.filters.some(([f]) => f === 'cookDay'));
        expect(day.filters).toEqual(expect.arrayContaining([['location', '==', 'webster'], ['cookDay', '==', '2026-11-02']]));
    });

    it('the one-line summary adds it up', async () => {
        await open([
            today({ id: 'a', batchNo: 1, status: 'used', usedAt: iso(12, 0), usedBy: 'A' }),
            today({ id: 'b', batchNo: 2 }),
            today({ id: 'c', batchNo: 3, madeAt: iso(7, 0), cookedAt: iso(7, 0), tossByAt: iso(11, 0), wokByAt: iso(10, 45) }),
        ]);
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('3 batches: 1 used up, 2 open. 1 past limit. 1 flag.');
    });

    it('each row shows batch, route, made time, reading, deadlines, who, pans and how it ended', async () => {
        await open([today({ status: 'used', usedAt: iso(12, 10), usedBy: 'Ana' })]);
        const r = within(row(1));
        expect(r.getByText('#1')).toBeInTheDocument();
        expect(r.getByText('For Today')).toBeInTheDocument();
        expect(row(1)).toHaveTextContent('Made 11:00 AM');
        expect(row(1)).toHaveTextContent('198°F');
        expect(row(1)).toHaveTextContent('Rubisel Ramos');
        expect(row(1)).toHaveTextContent('2 pans');
        expect(row(1)).toHaveTextContent('Wok by 2:45 PM · Toss by 3:00 PM');
        expect(row(1)).toHaveTextContent('Used up, logged 12:10 PM — Ana');
    });

    it('a Fridge row shows its own deadlines and never a toss time', async () => {
        await open([fridge()]);
        const text = row(2).textContent;
        expect(within(row(2)).getByText('For the Fridge')).toBeInTheDocument();
        expect(text).toContain('70F by 2:30 PM · 41F by 6:30 PM · Use by TUE 11/03');
        expect(text).not.toMatch(/Toss by|Wok by/);
    });

    it('old rows from before this change display correctly', async () => {
        await open([
            old({ id: 'o1', batchNo: 1 }),
            old({ id: 'o2', batchNo: 2, status: 'used', usedAt: iso(12, 0), usedBy: 'Rubisel' }),
            old({ id: 'o3', batchNo: 3, status: 'fridge', fridgedAt: iso(12, 0), fridgedBy: 'L', fridgeTempF: 66 }),
            old({ id: 'o4', batchNo: 4, status: 'tossed', tossedAt: iso(12, 5), tossedBy: 'L', tossReason: 'chose_to_toss' }),
            old({ id: 'o5', batchNo: 5, status: 'void', voidedBy: 'L' }),
        ]);
        expect(within(row(1)).getByText('Old format')).toBeInTheDocument();
        expect(row(1)).toHaveTextContent('Made 11:00 AM');
        expect(row(1)).toHaveTextContent('no reading');
        expect(row(1)).toHaveTextContent('1 pan');
        expect(row(1)).toHaveTextContent('Toss by 3:00 PM');
        expect(row(1)).not.toHaveTextContent(/fridge by/i);
        expect(row(2)).toHaveTextContent('Used up, logged 12:00 PM — Rubisel');
        expect(row(3)).toHaveTextContent('Into fridge 12:00 PM @ 66F');
        expect(within(row(3)).queryByText('All Gone')).toBe(null);
        expect(row(4)).toHaveTextContent('Tossed 12:05 PM');
        expect(row(5)).toHaveTextContent('Voided (printed by mistake)');
        // Voided and old-fridge rows aren't open. The last line of the summary
        // still counts them honestly.
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('4 batches: 1 used up, 1 open, 1 tossed, 1 into fridge, 1 void.');
    });

    it('an old open row can still be closed', async () => {
        useFakeClock();
        await open([old()]);
        await act(async () => { fireEvent.click(within(row(1)).getByText('All Gone')); });
        await act(async () => { vi.advanceTimersByTime(15000); });
        expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'used', usedBy: 'Cook Carla' });
    });
});

describe('any day', () => {
    const onDay = (day) => listeners.filter((l) => l.active && l.filters.some(([f, , v]) => f === 'cookDay' && v === day));

    it('previous day moves back; next day comes forward and stops at today', async () => {
        await open([]);
        expect(screen.getByLabelText('Next day')).toBeDisabled();
        await act(async () => { fireEvent.click(screen.getByLabelText('Previous day')); });
        expect(onDay('2026-11-01')).toHaveLength(1);
        expect(onDay('2026-11-02')).toHaveLength(0);
        expect(screen.getByText('SUN 11/01/2026')).toBeInTheDocument();
        expect(screen.getByLabelText('Next day')).not.toBeDisabled();
        await act(async () => { fireEvent.click(screen.getByLabelText('Next day')); });
        expect(onDay('2026-11-02')).toHaveLength(1);
        expect(screen.getByLabelText('Next day')).toBeDisabled();
    });

    it('the date picker reaches any past day, with no lower limit, and refuses the future', async () => {
        await open([]);
        const pick = screen.getByLabelText('Pick a day');
        expect(pick).toHaveAttribute('max', '2026-11-02');
        expect(pick).not.toHaveAttribute('min');
        await act(async () => { fireEvent.change(pick, { target: { value: '2019-03-04' } }); });
        expect(onDay('2019-03-04')).toHaveLength(1);
        await act(async () => { fireEvent.change(pick, { target: { value: '2030-01-01' } }); });
        expect(onDay('2026-11-02')).toHaveLength(1);
    });

    it('Today jumps back', async () => {
        await open([]);
        await act(async () => { fireEvent.click(screen.getByLabelText('Previous day')); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Today' })); });
        expect(onDay('2026-11-02')).toHaveLength(1);
    });

    it('rolls to the new day on a long-open iPad, unless someone picked a day', async () => {
        useFakeClock();
        await open([]);
        vi.setSystemTime(new Date(2026, 10, 3, 0, 1));
        await act(async () => { vi.advanceTimersByTime(30000); });
        expect(onDay('2026-11-03')).toHaveLength(1);
    });
});

describe('connection line', () => {
    it('a server answer can say the day is empty', async () => {
        await open([]);
        expect(screen.getByTestId('rice-connection')).toHaveTextContent('Connected. Up to date.');
        expect(screen.getByText('No batches logged yet today.')).toBeInTheDocument();
    });

    it('a past day says so differently', async () => {
        await open([]);
        await act(async () => { fireEvent.click(screen.getByLabelText('Previous day')); });
        await feed([]);
        expect(screen.getByText('No batches logged this day.')).toBeInTheDocument();
    });

    it('offline never says no batches', async () => {
        useFakeClock();
        await open([], { meta: { fromCache: true } });
        expect(screen.queryByText(/No batches logged/)).toBe(null);
        expect(screen.getByText(/Can't confirm this day/)).toBeInTheDocument();
        await act(async () => { vi.advanceTimersByTime(6100); });
        expect(screen.getByTestId('rice-connection')).toHaveTextContent('Offline. Showing what this device has saved.');
        expect(screen.queryByText(/No batches logged/)).toBe(null);
    });

    it('a count from saved data doesn\'t show as the day\'s summary, empty or not', async () => {
        useFakeClock();
        await open([], { meta: { fromCache: true } });
        expect(screen.queryByTestId('rice-summary')).toBe(null);
        await act(async () => { vi.advanceTimersByTime(6100); });
        expect(screen.queryByTestId('rice-summary')).toBe(null);
        await feed([today()], { fromCache: true });
        expect(screen.queryByTestId('rice-summary')).toBe(null);
        expect(row(1)).toBeInTheDocument();
        await feed([today()]);
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('1 batch:');
    });

    it('shows how old saved data is after losing the server', async () => {
        useFakeClock();
        await open([today()]);
        vi.setSystemTime(new Date(2026, 10, 2, 13, 5));
        await act(async () => { vi.advanceTimersByTime(6100); });
        await feed([today()], { fromCache: true });
        expect(screen.getByTestId('rice-connection')).toHaveTextContent('Offline. Showing saved data from 1:00 PM.');
        expect(within(row(1)).getByText('For Today')).toBeInTheDocument();
    });

    it('a failed load says it couldn\'t load, not that nothing happened', async () => {
        await open();
        const day = listeners.find((l) => l.filters.some(([f]) => f === 'cookDay'));
        await act(async () => { day.err(new Error('offline')); });
        expect(screen.getByTestId('rice-connection')).toHaveTextContent("Can't load this day");
        expect(screen.queryByText(/No batches logged/)).toBe(null);
        expect(screen.queryByTestId('rice-summary')).toBe(null);
    });

    it('still waiting on the first answer says so, then says it can\'t reach it', async () => {
        useFakeClock();
        await open();
        expect(screen.getByTestId('rice-connection')).toHaveTextContent('Loading this day');
        await act(async () => { vi.advanceTimersByTime(6100); });
        expect(screen.getByTestId('rice-connection')).toHaveTextContent("Can't reach the log yet");
        expect(screen.queryByText(/No batches logged/)).toBe(null);
    });
});

describe('open batches from earlier days', () => {
    const yesterday = today({ id: 'y', batchNo: 7, cookDay: '2026-11-01', madeAt: iso(18, 0, 1), cookedAt: iso(18, 0, 1), tossByAt: iso(22, 0, 1), wokByAt: iso(21, 45, 1) });

    it('sit at the top, labeled, with the three late answers', async () => {
        await open([yesterday, today({ id: 'b', batchNo: 1 })]);
        const r = within(row(7));
        expect(r.getByText('Still open from SUN 11/01')).toBeInTheDocument();
        expect(r.getByText('I saw it gone in time')).toBeInTheDocument();
        expect(screen.getByText('Still open from earlier days')).toBeInTheDocument();
    });

    it('a closed batch from an earlier day doesn\'t show up', async () => {
        await open([{ ...yesterday, status: 'used' }, today({ id: 'b', batchNo: 1 })]);
        expect(screen.queryByTestId('rice-row-7')).toBe(null);
    });

    it('viewing that same day doesn\'t list it twice', async () => {
        await open([yesterday]);
        await act(async () => { fireEvent.click(screen.getByLabelText('Previous day')); });
        await feed([yesterday]);
        expect(screen.getAllByTestId('rice-row-7')).toHaveLength(1);
    });
});

describe('closing a batch', () => {
    it('All Gone waits 15 seconds before it writes, stamped with the tap', async () => {
        useFakeClock();
        await open([today()]);
        await act(async () => { fireEvent.click(within(row(1)).getByText('All Gone')); });
        expect(updateDocMock).not.toHaveBeenCalled();
        expect(within(row(1)).getByText(/saving in 15s/)).toBeInTheDocument();
        await act(async () => { vi.advanceTimersByTime(14000); });
        expect(updateDocMock).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(1000); });
        expect(updateDocMock).toHaveBeenCalledTimes(1);
        expect(updateDocMock.mock.calls[0][1]).toEqual({ status: 'used', usedAt: NOW.toISOString(), usedBy: 'Cook Carla' });
    });

    it('Undo drops the write', async () => {
        useFakeClock();
        await open([today()]);
        await act(async () => { fireEvent.click(within(row(1)).getByText('Tossed')); });
        await act(async () => { vi.advanceTimersByTime(5000); });
        await act(async () => { fireEvent.click(within(row(1)).getByRole('button', { name: 'Undo' })); });
        await act(async () => { vi.advanceTimersByTime(20000); });
        expect(updateDocMock).not.toHaveBeenCalled();
        expect(within(row(1)).getByText('All Gone')).toBeInTheDocument();
    });

    it('leaving the screen sends what was held', async () => {
        useFakeClock();
        const { unmount } = await open([today()]);
        await act(async () => { fireEvent.click(within(row(1)).getByText('All Gone')); });
        unmount();
        expect(updateDocMock).toHaveBeenCalledTimes(1);
        expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'used' });
    });

    it('a reprint tapped during the hold can\'t lose the close', async () => {
        useFakeClock();
        const { result } = renderHook(() => useRiceBatchActions({ location: 'webster', staffName: 'Cook Carla', language: 'en' }));
        const r = today();
        act(() => { result.current.requestClose(r, 'used'); });
        await act(async () => { vi.advanceTimersByTime(14000); });
        let res;
        await act(async () => { res = await result.current.reprint(r); });
        expect(res).toBe(null);
        expect(printRiceLabelMock).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(1000); });
        expect(updateDocMock).toHaveBeenCalledTimes(1);
        expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'used', usedBy: 'Cook Carla' });
        expect(result.current.pending).toEqual({});
    });

    it('All Gone is locked while a reprint is printing, then goes through', async () => {
        useFakeClock();
        let finishPrint;
        printRiceLabelMock.mockImplementationOnce(() => new Promise((r) => { finishPrint = r; }));
        await open([today({ prints: [{ ok: false, error: 'printer_rejected', copies: 1 }], pans: 1 })]);
        // Printing, so the row is busy and All Gone is locked until it answers.
        await act(async () => { fireEvent.click(within(row(1)).getByRole('button', { name: 'Reprint' })); });
        expect(within(row(1)).getByText('All Gone').closest('button')).toBeDisabled();
        await act(async () => { finishPrint({ ok: true }); });
        await act(async () => { fireEvent.click(within(row(1)).getByText('All Gone')); });
        await act(async () => { vi.advanceTimersByTime(15000); });
        const closes = updateDocMock.mock.calls.map((c) => c[1]).filter((f) => f.status);
        expect(closes).toHaveLength(1);
        expect(closes[0]).toMatchObject({ status: 'used' });
    });

    it('nothing else runs on a batch during its hold', async () => {
        useFakeClock();
        await open([today({ prints: [{ ok: false, error: 'printer_rejected', copies: 1 }], pans: 1 })], { staff: 'Lead Luis' });
        await act(async () => { fireEvent.click(within(row(1)).getByText('All Gone')); });
        expect(within(row(1)).getByRole('button', { name: 'Reprint' })).toBeDisabled();
        expect(within(row(1)).getByRole('button', { name: 'Edit' })).toBeDisabled();
        expect(within(row(1)).getByRole('button', { name: 'Printed by mistake: delete' })).toBeDisabled();
        await act(async () => { fireEvent.click(within(row(1)).getByRole('button', { name: 'Undo' })); });
        expect(within(row(1)).getByRole('button', { name: 'Edit' })).not.toBeDisabled();
    });

    it('Tossed before the toss time is a leftover', async () => {
        useFakeClock();
        await open([today()]);
        await act(async () => { fireEvent.click(within(row(1)).getByText('Tossed')); });
        await act(async () => { vi.advanceTimersByTime(15000); });
        expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'tossed', tossReason: 'leftover', tossedBy: 'Cook Carla' });
    });

    describe('past the toss time', () => {
        const late = () => today({ madeAt: iso(8, 0), cookedAt: iso(8, 0), tossByAt: iso(12, 0), wokByAt: iso(11, 45) });

        it('asks three answers, not All Gone', async () => {
            await open([late()]);
            const r = within(row(1));
            expect(r.getByText('PAST THE TOSS TIME')).toBeInTheDocument();
            expect(r.queryByText('All Gone')).toBe(null);
            expect(r.getByText('I saw it gone in time')).toBeInTheDocument();
            expect(r.getByText('Tossed')).toBeInTheDocument();
            expect(r.getByText("Don't know, or used late")).toBeInTheDocument();
        });

        it('"I saw it gone in time" logs used, closed late', async () => {
            useFakeClock();
            await open([late()]);
            await act(async () => { fireEvent.click(within(row(1)).getByText('I saw it gone in time')); });
            await act(async () => { vi.advanceTimersByTime(15000); });
            expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'used', closedLate: true, closeAnswer: 'saw_gone', usedBy: 'Cook Carla' });
        });

        it('"Tossed" logs past the limit', async () => {
            useFakeClock();
            await open([late()]);
            await act(async () => { fireEvent.click(within(row(1)).getByText('Tossed')); });
            await act(async () => { vi.advanceTimersByTime(15000); });
            expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'tossed', tossReason: 'past_4h' });
        });

        it('"Don\'t know, or used late" logs unknown, and the row is flagged', async () => {
            useFakeClock();
            await open([late()]);
            await act(async () => { fireEvent.click(within(row(1)).getByText("Don't know, or used late")); });
            await act(async () => { vi.advanceTimersByTime(15000); });
            const written = updateDocMock.mock.calls[0][1];
            expect(written).toMatchObject({ status: 'unknown', unknownBy: 'Cook Carla', closeAnswer: 'unknown' });
            await feed([{ ...late(), ...written }]);
            expect(row(1)).toHaveTextContent("Closed as don't know, or used late.");
            expect(within(row(1)).queryByText('Tossed')).toBe(null);
        });
    });

    it('All Gone on a screen that hasn\'t redrawn since the toss time asks the three answers', async () => {
        useFakeClock();
        vi.setSystemTime(new Date(2026, 10, 2, 14, 59, 50));
        await open([today()]);
        expect(within(row(1)).getByText('All Gone')).toBeInTheDocument();
        vi.setSystemTime(new Date(2026, 10, 2, 15, 0, 10));    // no redraw yet
        await act(async () => { fireEvent.click(within(row(1)).getByText('All Gone')); });
        expect(within(row(1)).queryByText('All Gone')).toBe(null);
        expect(within(row(1)).getByText('I saw it gone in time')).toBeInTheDocument();
        await act(async () => { vi.advanceTimersByTime(15000); });
        expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('offline, a saved write doesn\'t freeze that batch\'s own buttons', async () => {
        useFakeClock();
        updateDocMock.mockImplementation(() => new Promise(() => {}));   // offline: never acked
        await open([fridge()]);
        fireEvent.click(within(row(2)).getByText('Into Fridge'));
        await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
        expect(updateDocMock).toHaveBeenCalledTimes(1);
        // The local copy lands right away, as Firestore's does.
        await feed([fridge({ status: 'fridge', fridgedAt: NOW.toISOString(), fridgedBy: 'Cook Carla' })], { hasPendingWrites: true });
        await act(async () => { vi.advanceTimersByTime(800); });
        const r = within(row(2));
        for (const name of ['Tossed', 'Used', 'Reading', 'Edit', 'Printed by mistake: delete']) {
            expect(r.getByRole('button', { name }), name).not.toBeDisabled();
        }
    });

    it('a double tap on Save still only writes once', async () => {
        useFakeClock();
        await open([fridge()]);
        fireEvent.click(within(row(2)).getByText('Reading'));
        fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '90' } });
        fireEvent.change(screen.getByLabelText('Time of the reading'), { target: { value: '12:50' } });
        const save = within(row(2)).getByRole('button', { name: 'Save' });
        await act(async () => { fireEvent.click(save); fireEvent.click(save); });
        expect(updateDocMock).toHaveBeenCalledTimes(1);
    });

    it('a failed save still says so after the buttons let go', async () => {
        const { toast } = await import('../toast');
        toast.mockClear();
        useFakeClock();
        let reject;
        updateDocMock.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
        await open([fridge()]);
        fireEvent.click(within(row(2)).getByText('Into Fridge'));
        await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
        await act(async () => { vi.advanceTimersByTime(5000); });
        await act(async () => { reject(new Error('denied')); });
        expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Batch #2 did not save/), expect.objectContaining({ kind: 'error' }));
    });

    it('a close the rules refuse says it may already be closed, not to try again', async () => {
        const { toast } = await import('../toast');
        toast.mockClear();
        useFakeClock();
        updateDocMock.mockImplementationOnce(async () => { throw Object.assign(new Error('nope'), { code: 'permission-denied' }); });
        await open([today()]);
        await act(async () => { fireEvent.click(within(row(1)).getByText('All Gone')); });
        await act(async () => { vi.advanceTimersByTime(15000); });
        const words = toast.mock.calls.map((c) => c[0]).join(' | ');
        expect(words).toMatch(/Batch #1 did not save\. It may already be closed on another device/);
        expect(words).not.toMatch(/Try again/);
    });

    it('a deleted or closed batch can\'t be reprinted', async () => {
        const { result } = renderHook(() => useRiceBatchActions({ location: 'webster', staffName: 'Cook Carla', language: 'en' }));
        for (const r of [today({ deletedAt: iso(12, 0) }), today({ status: 'used' })]) {
            let res;
            await act(async () => { res = await result.current.reprint(r); });
            expect(res).toBe(null);
        }
        expect(printRiceLabelMock).not.toHaveBeenCalled();
    });

    it('a Fridge batch\'s failed sticker shows every time for the tape', async () => {
        await open([fridge({ prints: [{ ok: false, error: 'printer_rejected', copies: 1 }] })]);
        expect(row(2)).toHaveTextContent("Sticker didn't print. Write it on tape.");
        expect(row(2)).toHaveTextContent('USE BY TUE 11/03');
        expect(within(row(2)).getByText(/^70F \d/).className).toContain('text-3xl');
        expect(within(row(2)).getByText(/^41F \d/).className).toContain('text-3xl');
    });

    it('a For Today batch has no fridge button, ever', async () => {
        await open([today(), today({ id: 'b', batchNo: 2, madeAt: iso(7, 0), cookedAt: iso(7, 0), tossByAt: iso(11, 0), wokByAt: iso(10, 45) })]);
        expect(screen.queryByText('Into Fridge')).toBe(null);
    });
});

describe('Fridge batches', () => {
    it('offer Into Fridge, a reading, and Tossed. Not All Gone mid-cooling', async () => {
        await open([fridge()]);
        const r = within(row(2));
        expect(r.getByText('Into Fridge')).toBeInTheDocument();
        expect(r.getByText('Reading')).toBeInTheDocument();
        expect(r.getByText('Tossed')).toBeInTheDocument();
        expect(r.queryByText('All Gone')).toBe(null);
    });

    it('Into Fridge saves right away with the reading left blank when nobody took one', async () => {
        await open([fridge()]);
        fireEvent.click(within(row(2)).getByText('Into Fridge'));
        expect(screen.getByLabelText('Reading in degrees F')).toHaveValue(null);
        await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
        const written = updateDocMock.mock.calls[0][1];
        expect(written).toMatchObject({ status: 'fridge', fridgedBy: 'Cook Carla' });
        expect(written.fridgeTempF).toBeUndefined();
        expect(written.readings).toBeUndefined();
    });

    it('Into Fridge saves a reading with its time when one was taken', async () => {
        await open([fridge()]);
        fireEvent.click(within(row(2)).getByText('Into Fridge'));
        fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '68' } });
        fireEvent.change(screen.getByLabelText('Time of the reading'), { target: { value: '12:50' } });
        await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
        const written = updateDocMock.mock.calls[0][1];
        expect(written.fridgeTempF).toBe(68);
        expect(written.readings.arrayUnion[0]).toMatchObject({ tempF: 68, by: 'Cook Carla', kind: 'fridge', at: iso(12, 50) });
    });

    it('a reading can\'t be in the future, or a word', async () => {
        await open([fridge()]);
        fireEvent.click(within(row(2)).getByText('Reading'));
        await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
        expect(screen.getByText('Enter the reading from the probe.')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '60' } });
        fireEvent.change(screen.getByLabelText('Time of the reading'), { target: { value: '18:00' } });
        await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
        expect(screen.getByText('That time is in the future.')).toBeInTheDocument();
        expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('a reading\'s time can\'t be blank, or before the batch was made', async () => {
        await open([fridge()]);
        fireEvent.click(within(row(2)).getByText('Reading'));
        fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '60' } });
        fireEvent.change(screen.getByLabelText('Time of the reading'), { target: { value: '' } });
        await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
        expect(screen.getByText('Enter the time of the reading.')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Time of the reading'), { target: { value: '09:00' } });
        await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
        expect(screen.getByText(/That time is before this batch was made \(12:30 PM\)/)).toBeInTheDocument();
        expect(updateDocMock).not.toHaveBeenCalled();
        // The batch's own minute is fine.
        fireEvent.change(screen.getByLabelText('Time of the reading'), { target: { value: '12:30' } });
        await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
        expect(updateDocMock).toHaveBeenCalledTimes(1);
    });

    it('Into Fridge only asks for a time along with a reading, and says it\'s stamped now', async () => {
        await open([fridge()]);
        fireEvent.click(within(row(2)).getByText('Into Fridge'));
        expect(screen.queryByLabelText('Time of the reading')).toBe(null);
        expect(within(row(2)).getByText('Into the fridge now. Reading is optional.')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '68' } });
        expect(screen.getByLabelText('Time of the reading')).toBeInTheDocument();
    });

    it('warns when a typed reading is above 41F past its 41F time', async () => {
        vi.setSystemTime(new Date(2026, 10, 2, 19, 0));
        await open([fridge({ status: 'fridge', fridgedAt: iso(12, 55), fridgedBy: 'A' })]);
        fireEvent.click(within(row(2)).getByText('Reading'));
        fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '50' } });
        expect(screen.getByText('Above 41F past its 41F time: toss it.')).toBeInTheDocument();
    });

    it('past 70F BY, out of the walk-in: the summary counts it, and Tossed says why', async () => {
        useFakeClock();
        vi.setSystemTime(new Date(2026, 10, 2, 15, 0));
        await open([fridge()]);
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('1 past limit. 1 flag.');
        expect(row(2)).toHaveTextContent('Past its 70F time. Over 70F: toss it.');
        expect(row(2)).toHaveTextContent('Not in the walk-in by its 70F time.');
        await act(async () => { fireEvent.click(within(row(2)).getByText('Tossed')); });
        await act(async () => { vi.advanceTimersByTime(15000); });
        expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'tossed', tossReason: 'past_70f' });
    });

    it('in the fridge: readings, Used, Tossed', async () => {
        useFakeClock();
        await open([fridge({ status: 'fridge', fridgedAt: iso(12, 55), fridgedBy: 'A' })]);
        const r = within(row(2));
        expect(r.getByText(/In the fridge since 12:55 PM/)).toBeInTheDocument();
        expect(r.queryByText('Into Fridge')).toBe(null);
        await act(async () => { fireEvent.click(r.getByText('Used')); });
        await act(async () => { vi.advanceTimersByTime(15000); });
        expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'used', usedBy: 'Cook Carla' });
    });

    it('readings nobody took stay blank on the row', async () => {
        await open([fridge({ status: 'fridge', fridgedAt: iso(12, 55), fridgedBy: 'A' })]);
        expect(row(2)).not.toHaveTextContent('Readings:');
    });

    it('readings that were taken show on the row', async () => {
        await open([fridge({ readings: [{ kind: 'fridge', tempF: 90, at: iso(12, 45) }] })]);
        expect(row(2)).toHaveTextContent('Readings: 12:45 PM 90°F');
    });

    describe('next morning', () => {
        const overnight = () => fridge({ status: 'fridge', fridgedAt: iso(12, 55), fridgedBy: 'A' });
        const nextMorning = () => vi.setSystemTime(new Date(2026, 10, 3, 8, 0));

        it('offers Morning Reading, Used and Tossed', async () => {
            nextMorning();
            await open([overnight()]);
            const r = within(row(2));
            expect(r.getByText('Morning Reading')).toBeInTheDocument();
            expect(r.getByText('Used')).toBeInTheDocument();
            expect(r.getByText('Tossed')).toBeInTheDocument();
        });

        it('at 41F or below it just saves the reading', async () => {
            nextMorning();
            await open([overnight()]);
            fireEvent.click(within(row(2)).getByText('Morning Reading'));
            expect(screen.getByLabelText('Reading in degrees F')).toHaveValue(null);
            fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '41' } });
            await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
            const written = updateDocMock.mock.calls[0][1];
            expect(written.status).toBeUndefined();
            expect(written.readings.arrayUnion[0]).toMatchObject({ tempF: 41, kind: 'morning' });
        });

        it('above 41F logs the toss, and says Toss even after the row leaves the list', async () => {
            nextMorning();
            await open([overnight()]);
            fireEvent.click(within(row(2)).getByText('Morning Reading'));
            fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '44' } });
            await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
            // A mistyped number would cost a good pan, for good: it asks first.
            expect(updateDocMock).not.toHaveBeenCalled();
            expect(screen.getByRole('alert')).toHaveTextContent('44F is above 41F');
            vi.setSystemTime(new Date(2026, 10, 3, 8, 0, 1));
            await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Yes, 44F: toss it' })); });
            const written = updateDocMock.mock.calls[0][1];
            expect(written).toMatchObject({ status: 'tossed', tossReason: 'morning_above_41', tossedBy: 'Cook Carla' });
            // The row closes on its local copy, and today's list never had it.
            await feed([{ ...overnight(), status: 'tossed', tossReason: 'morning_above_41', tossedAt: iso(8, 0, 3), tossedBy: 'Cook Carla' }]);
            expect(screen.queryByTestId('rice-row-2')).toBe(null);
            expect(screen.getByRole('alert')).toHaveTextContent('44F: TOSS IT');
            expect(screen.getByRole('alert')).toHaveTextContent('Batch #2 is above 41F');
            fireEvent.click(screen.getByRole('button', { name: 'Done' }));
            expect(screen.queryByRole('alert')).toBe(null);
        });

        it('a high morning number can be fixed before it closes anything, and a double tap can\'t answer the yes', async () => {
            nextMorning();
            await open([overnight()]);
            fireEvent.click(within(row(2)).getByText('Morning Reading'));
            fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '83' } });
            const tap = () => fireEvent.click(within(row(2)).getByRole('button', { name: /^(Save|Yes, 83F: toss it)$/ }));
            await act(async () => { tap(); tap(); });
            expect(updateDocMock).not.toHaveBeenCalled();
            fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '38' } });
            expect(screen.queryByRole('alert')).toBe(null);
            await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
            const written = updateDocMock.mock.calls[0][1];
            expect(written.status).toBeUndefined();
            expect(written.readings.arrayUnion[0].tempF).toBe(38);
        });

        it('after a good reading it says so, and Used comes first', async () => {
            nextMorning();
            await open([fridge({
                status: 'fridge', fridgedAt: iso(12, 55), fridgedBy: 'A',
                readings: [{ kind: 'morning', tempF: 38, at: iso(7, 30, 3), enteredAt: iso(7, 30, 3), by: 'A' }],
            })]);
            expect(row(2)).toHaveTextContent('Morning reading 38F, 7:30 AM. OK to use.');
            expect(row(2)).not.toHaveTextContent('Take the morning reading');
            const r = within(row(2));
            const pos = r.getByText('Used').compareDocumentPosition(r.getByText('Morning Reading'));
            expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        it('at 41F or below there\'s no card', async () => {
            nextMorning();
            await open([overnight()]);
            fireEvent.click(within(row(2)).getByText('Morning Reading'));
            fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '38' } });
            await act(async () => { fireEvent.click(within(row(2)).getByRole('button', { name: 'Save' })); });
            expect(screen.queryByRole('alert')).toBe(null);
        });

        it('a toss from a high morning reading shows it big on the row', async () => {
            await open([fridge({ status: 'tossed', tossReason: 'morning_above_41', tossedAt: iso(12, 58), tossedBy: 'A' })]);
            expect(within(row(2)).getByText('ABOVE 41F: TOSS IT')).toBeInTheDocument();
        });

        it('past its use-by, the only way out is Tossed', async () => {
            vi.setSystemTime(new Date(2026, 10, 4, 8, 0));
            await open([overnight()]);
            const r = within(row(2));
            expect(r.getByText('PAST ITS USE-BY: TOSS IT')).toBeInTheDocument();
            expect(r.queryByText('Used')).toBe(null);
            expect(r.queryByText('Morning Reading')).toBe(null);
            expect(r.getByText('Tossed')).toBeInTheDocument();
        });
    });
});

describe('Printed by mistake: delete', () => {
    const fresh = (over = {}) => today({ madeAt: iso(12, 55), cookedAt: iso(12, 55), tossByAt: iso(16, 55), wokByAt: iso(16, 40), createdMs: new Date(iso(12, 55)).getTime(), ...over });
    const tapDelete = (n = 1) => fireEvent.click(within(row(n)).getByText('Printed by mistake: delete'));

    it('inside 10 minutes: any staff, one confirm, soft delete', async () => {
        await open([fresh()], { staff: 'Cook Carla' });
        tapDelete();
        expect(screen.queryByLabelText('Reason for deleting')).toBe(null);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' })); });
        expect(updateDocMock).toHaveBeenCalledTimes(1);
        expect(updateDocMock.mock.calls[0][1]).toEqual({ deletedAt: NOW.toISOString(), deletedBy: 'Cook Carla', deleteReason: 'Printed by mistake' });
    });

    it('Cancel writes nothing', async () => {
        await open([fresh()]);
        tapDelete();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(updateDocMock).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Yes, delete' })).toBe(null);
    });

    it('after 10 minutes a regular staff member is told who can', async () => {
        await open([today()], { staff: 'Cook Carla' });
        tapDelete();
        expect(screen.getByText(/only a shift lead or manager can delete, with a reason/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Yes, delete' })).toBe(null);
    });

    for (const staff of ['Lead Luis', 'Manager Mia', 'Owner Andrew']) {
        it(`after 10 minutes ${staff} can, with a typed reason`, async () => {
            await open([today()], { staff });
            tapDelete();
            const yes = screen.getByRole('button', { name: 'Yes, delete' });
            expect(yes).toBeDisabled();
            fireEvent.change(screen.getByLabelText('Reason for deleting'), { target: { value: 'Test ticket from training' } });
            expect(yes).not.toBeDisabled();
            await act(async () => { fireEvent.click(yes); });
            expect(updateDocMock.mock.calls[0][1]).toMatchObject({ deletedBy: staff, deleteReason: 'Test ticket from training' });
        });
    }

    it('a tossed batch takes shift lead or above, even inside 10 minutes', async () => {
        const tossed = fresh({ status: 'tossed', tossReason: 'leftover', tossedAt: iso(12, 58), tossedBy: 'A' });
        await open([tossed], { staff: 'Cook Carla' });
        tapDelete();
        expect(screen.getByText(/tossed or past its limit can only be deleted by a shift lead or manager/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Yes, delete' })).toBe(null);
    });

    it('a shift lead deleting a tossed batch still needs a reason', async () => {
        const tossed = fresh({ status: 'tossed', tossReason: 'leftover', tossedAt: iso(12, 58), tossedBy: 'A' });
        await open([tossed], { staff: 'Lead Luis' });
        tapDelete();
        expect(screen.getByLabelText('Reason for deleting')).toBeInTheDocument();
    });

    it('a batch past its limit takes shift lead or above', async () => {
        await open([today({ madeAt: iso(7, 0), cookedAt: iso(7, 0), tossByAt: iso(11, 0), wokByAt: iso(10, 45), createdMs: new Date(iso(12, 58)).getTime() })], { staff: 'Cook Carla' });
        tapDelete();
        expect(screen.getByText(/tossed or past its limit/)).toBeInTheDocument();
    });

    it('a deleted row leaves the list, the summary and the open list', async () => {
        const gone = fresh({ deletedAt: iso(12, 59), deletedBy: 'A', deleteReason: 'Printed by mistake' });
        await open([gone, today({ id: 'b', batchNo: 2 })]);
        expect(screen.queryByTestId('rice-row-1')).toBe(null);
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('1 batch: 0 used up, 1 open.');
    });

    it('a deleted open row from an earlier day doesn\'t linger at the top', async () => {
        const gone = today({ id: 'y', batchNo: 7, cookDay: '2026-11-01', deletedAt: iso(9, 0, 1), deletedBy: 'A', deleteReason: 'x' });
        await open([gone]);
        expect(screen.queryByTestId('rice-row-7')).toBe(null);
    });

    it('a new batch within 30 minutes of a delete is flagged', async () => {
        const gone = fresh({ id: 'g', batchNo: 1, deletedAt: iso(12, 50), deletedBy: 'A', deleteReason: 'x' });
        await open([gone, fresh({ id: 'n', batchNo: 2 })]);
        expect(row(2)).toHaveTextContent('Started within 30 minutes of deleted ticket #1.');
    });

    describe('a form left open', () => {
        it('a cook past the window, or past the limit, is refused at Yes, delete', async () => {
            useFakeClock();
            await open([fresh()], { staff: 'Cook Carla' });
            tapDelete();
            const yes = screen.getByRole('button', { name: 'Yes, delete' });
            vi.setSystemTime(new Date(2026, 10, 2, 17, 0));    // past its toss time, too
            await act(async () => { fireEvent.click(yes); });
            expect(updateDocMock).not.toHaveBeenCalled();
            expect(screen.queryByRole('button', { name: 'Yes, delete' })).toBe(null);
            expect(screen.getByText(/tossed or past its limit can only be deleted by a shift lead or manager/)).toBeInTheDocument();
        });

        it('a cook is refused after minute 10, even with a reason typed', async () => {
            useFakeClock();
            await open([fresh()], { staff: 'Cook Carla' });
            tapDelete();
            vi.setSystemTime(new Date(2026, 10, 2, 13, 6));    // made 12:55, so 11 minutes
            await act(async () => { vi.advanceTimersByTime(30000); });
            fireEvent.change(screen.getByLabelText('Reason for deleting'), { target: { value: 'any reason' } });
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' })); });
            expect(updateDocMock).not.toHaveBeenCalled();
            expect(screen.getByText(/After 10 minutes, only a shift lead or manager can delete/)).toBeInTheDocument();
        });

        it('a lead past the window is asked for the reason instead of writing without one', async () => {
            useFakeClock();
            await open([fresh()], { staff: 'Lead Luis' });
            tapDelete();
            expect(screen.queryByLabelText('Reason for deleting')).toBe(null);
            const yes = screen.getByRole('button', { name: 'Yes, delete' });
            vi.setSystemTime(new Date(2026, 10, 2, 13, 6));
            await act(async () => { fireEvent.click(yes); });
            expect(updateDocMock).not.toHaveBeenCalled();
            fireEvent.change(screen.getByLabelText('Reason for deleting'), { target: { value: 'duplicate' } });
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' })); });
            expect(updateDocMock.mock.calls[0][1]).toMatchObject({ deletedBy: 'Lead Luis', deleteReason: 'duplicate' });
        });
    });

    describe('seeing deleted rows', () => {
        const gone = () => fresh({ deletedAt: iso(12, 59), deletedBy: 'Maria', deleteReason: 'Printed by mistake' });

        it('managers get a small toggle', async () => {
            await open([gone()], { staff: 'Manager Mia' });
            expect(screen.queryByTestId('rice-row-1')).toBe(null);
            fireEvent.click(screen.getByLabelText('Show deleted tickets (1)'));
            expect(row(1)).toHaveTextContent('Deleted 12:59 PM — Maria: Printed by mistake');
            expect(within(row(1)).queryByText('All Gone')).toBe(null);
            expect(within(row(1)).queryByText('Edit')).toBe(null);
            expect(within(row(1)).queryByText('Printed by mistake: delete')).toBe(null);
        });

        it('so do owners', async () => {
            await open([gone()], { staff: 'Owner Andrew' });
            expect(screen.getByLabelText('Show deleted tickets (1)')).toBeInTheDocument();
        });

        it('staff don\'t', async () => {
            await open([gone()], { staff: 'Cook Carla' });
            expect(screen.queryByLabelText(/Show deleted/)).toBe(null);
        });
    });
});

describe('Edit', () => {
    const fresh = (over = {}) => today({ madeAt: iso(12, 55), cookedAt: iso(12, 55), tossByAt: iso(16, 55), wokByAt: iso(16, 40), createdMs: new Date(iso(12, 55)).getTime(), ...over });
    const tapEdit = (n = 1) => fireEvent.click(within(row(n)).getByText('Edit'));

    it('says made time and route can\'t change: delete and reprint instead', async () => {
        await open([fresh()]);
        tapEdit();
        expect(row(1)).toHaveTextContent("Made time and route can't change");
        expect(row(1)).toHaveTextContent('delete this ticket and print a new one');
    });

    it('offers the reading, pans, how it ended and a note, and nothing else', async () => {
        await open([fresh()]);
        tapEdit();
        expect(screen.getByLabelText('Edit the reading')).toHaveValue(198);
        expect(screen.getByLabelText('More pans')).toBeInTheDocument();
        expect(screen.getByLabelText('How it ended')).toBeInTheDocument();
        expect(screen.getByLabelText('Note')).toBeInTheDocument();
    });

    it('inside 10 minutes any staff can, and every change goes in edits[]', async () => {
        await open([fresh()], { staff: 'Cook Carla' });
        tapEdit();
        fireEvent.change(screen.getByLabelText('Edit the reading'), { target: { value: '190' } });
        fireEvent.click(screen.getByLabelText('More pans'));
        fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'wrong number at first' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save edit' })); });
        const written = updateDocMock.mock.calls[0][1];
        expect(written).toMatchObject({ startTempF: 190, pans: 3, notes: 'wrong number at first' });
        expect(written.edits.arrayUnion).toEqual([
            { field: 'startTempF', old: 198, new: 190, by: 'Cook Carla', at: NOW.toISOString() },
            { field: 'pans', old: 2, new: 3, by: 'Cook Carla', at: NOW.toISOString() },
            { field: 'notes', old: '', new: 'wrong number at first', by: 'Cook Carla', at: NOW.toISOString() },
        ]);
    });

    it('a form left open past the window is refused at Save', async () => {
        useFakeClock();
        await open([fresh()], { staff: 'Cook Carla' });
        tapEdit();
        fireEvent.change(screen.getByLabelText('Edit the reading'), { target: { value: '190' } });
        vi.setSystemTime(new Date(2026, 10, 2, 13, 6));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save edit' })); });
        expect(updateDocMock).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Save edit' })).toBe(null);
        expect(screen.getByText('After 10 minutes, only a shift lead or manager can edit.')).toBeInTheDocument();
    });

    it('past the toss time, how-it-ended offers the same three answers', async () => {
        const late = () => today({ madeAt: iso(8, 0), cookedAt: iso(8, 0), tossByAt: iso(12, 0), wokByAt: iso(11, 45) });
        await open([late()], { staff: 'Lead Luis' });
        tapEdit();
        const values = [...screen.getByLabelText('How it ended').querySelectorAll('option')].map((o) => o.value);
        expect(values).toEqual(['', 'saw_gone', 'tossed', 'unknown']);
        fireEvent.change(screen.getByLabelText('How it ended'), { target: { value: 'saw_gone' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save edit' })); });
        expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'used', closedLate: true, closeAnswer: 'saw_gone', usedBy: 'Lead Luis' });
    });

    it('a row that already answered "saw it gone" doesn\'t offer it again', async () => {
        const saw = today({ madeAt: iso(8, 0), cookedAt: iso(8, 0), tossByAt: iso(12, 0), wokByAt: iso(11, 45), status: 'used', usedAt: iso(12, 30), usedBy: 'A', closedLate: true, closeAnswer: 'saw_gone' });
        await open([saw], { staff: 'Lead Luis' });
        tapEdit();
        const values = [...screen.getByLabelText('How it ended').querySelectorAll('option')].map((o) => o.value);
        expect(values).toEqual(['', 'tossed', 'unknown']);
    });

    it('changing nothing writes nothing', async () => {
        await open([fresh()]);
        tapEdit();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save edit' })); });
        expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('a bad reading is refused on the spot', async () => {
        await open([fresh()]);
        tapEdit();
        fireEvent.change(screen.getByLabelText('Edit the reading'), { target: { value: '9999' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save edit' })); });
        expect(screen.getByText('Enter the reading as a number.')).toBeInTheDocument();
        expect(updateDocMock).not.toHaveBeenCalled();
    });

    it('after 10 minutes a regular staff member is told who can', async () => {
        await open([today()], { staff: 'Cook Carla' });
        tapEdit();
        expect(screen.getByText('After 10 minutes, only a shift lead or manager can edit.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save edit' })).toBe(null);
    });

    it('after 10 minutes a shift lead can', async () => {
        await open([today()], { staff: 'Lead Luis' });
        tapEdit();
        expect(screen.getByRole('button', { name: 'Save edit' })).toBeInTheDocument();
    });

    it('a closed batch takes shift lead or above, even inside 10 minutes', async () => {
        const closed = fresh({ status: 'used', usedAt: iso(12, 58), usedBy: 'A' });
        await open([closed], { staff: 'Cook Carla' });
        tapEdit();
        expect(screen.getByText(/This batch is closed/)).toBeInTheDocument();
    });

    it('a shift lead corrects how a closed batch ended, on the record', async () => {
        const closed = today({ status: 'used', usedAt: iso(12, 0), usedBy: 'A' });
        await open([closed], { staff: 'Lead Luis' });
        tapEdit();
        fireEvent.change(screen.getByLabelText('How it ended'), { target: { value: 'tossed' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save edit' })); });
        const written = updateDocMock.mock.calls[0][1];
        expect(written).toMatchObject({ status: 'tossed', tossedBy: 'Lead Luis' });
        expect(written.edits.arrayUnion[0]).toMatchObject({ field: 'status', old: 'used', new: 'tossed', by: 'Lead Luis' });
    });

    it('how-it-ended never offers going back to open', async () => {
        await open([today({ status: 'used', usedAt: iso(12, 0), usedBy: 'A' })], { staff: 'Lead Luis' });
        tapEdit();
        const values = [...screen.getByLabelText('How it ended').querySelectorAll('option')].map((o) => o.value);
        expect(values).toEqual(['', 'tossed', 'unknown']);
    });

    it('an "edited" marker opens the history', async () => {
        const edits = [{ field: 'startTempF', old: 190, new: 198, by: 'Maria', at: iso(12, 45) }];
        await open([today({ edits })]);
        expect(screen.queryByText('Edit history')).toBe(null);
        fireEvent.click(within(row(1)).getByRole('button', { name: 'edited' }));
        expect(screen.getByText('Edit history')).toBeInTheDocument();
        expect(screen.getByText('reading: 190F to 198F, Maria, 12:45 PM')).toBeInTheDocument();
    });
});

describe('flags and markers on a row', () => {
    it('shows a flag count and what each one means', async () => {
        await open([today({ minutesLate: 5 })]);
        expect(within(row(1)).getByText(/1 flag$/)).toBeInTheDocument();
        expect(row(1)).toHaveTextContent('Stickered 5 minutes after it came out.');
    });

    it('a failed sticker shows the toss time huge, and Reprint on the row', async () => {
        await open([today({ pans: 1, prints: [{ ok: false, error: 'printer timeout' }] })]);
        expect(row(1)).toHaveTextContent('Printer timed out. Check whether a sticker came out.');
        expect(row(1)).toHaveTextContent('Printer timed out. A sticker may have printed.');
        expect(row(1)).not.toHaveTextContent('No sticker printed.');
        expect(within(row(1)).getByText(/Toss by 3:00p/).className).toContain('text-3xl');
        await act(async () => { fireEvent.click(within(row(1)).getByRole('button', { name: 'Reprint' })); });
        expect(printRiceLabelMock).toHaveBeenCalledTimes(1);
        expect(printRiceLabelMock.mock.calls[0][0].copies).toBe(1);
        expect(printRiceLabelMock.mock.calls[0][0].rows.map((r) => r.text.trim())).toContain('MADE/HECHO     11:00a');
    });

    it('with several pans and nothing printed, Reprint asks how many and starts at all of them', async () => {
        await open([today({ pans: 3, prints: [{ ok: false, error: 'printer_rejected', copies: 3 }] })]);
        await act(async () => { fireEvent.click(within(row(1)).getByRole('button', { name: 'Reprint' })); });
        expect(printRiceLabelMock).not.toHaveBeenCalled();
        expect(screen.getByTestId('rice-reprint-count')).toHaveTextContent('3');
        fireEvent.click(screen.getByLabelText('Fewer stickers'));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Print 2' })); });
        expect(printRiceLabelMock.mock.calls[0][0].copies).toBe(2);
    });

    it('a batch whose stickers all printed reprints just one, for a lost sticker', async () => {
        await open([today({ pans: 2, prints: [{ ok: true, copies: 2 }] })]);
        await act(async () => { fireEvent.click(within(row(1)).getByRole('button', { name: 'Reprint' })); });
        expect(printRiceLabelMock.mock.calls[0][0].copies).toBe(1);
    });

    it('a timed-out job can be marked as having come out, without printing', async () => {
        await open([today({ pans: 2, prints: [{ ok: false, error: 'printer timeout', copies: 2 }] })]);
        await act(async () => { fireEvent.click(within(row(1)).getByRole('button', { name: 'It came out' })); });
        expect(printRiceLabelMock).not.toHaveBeenCalled();
        expect(updateDocMock.mock.calls[0][1].prints.arrayUnion[0]).toMatchObject({ ok: true, seen: true, copies: 2, by: 'Cook Carla' });
    });

    it('a definite failure has no "It came out"', async () => {
        await open([today({ pans: 1, prints: [{ ok: false, error: 'printer_rejected' }] })]);
        expect(within(row(1)).queryByRole('button', { name: 'It came out' })).toBe(null);
    });

    it('marks a repeat number', async () => {
        await open([today({ id: 'a' }), today({ id: 'b', batchNo: 1 })]);
        expect(screen.getAllByText(/Same number as another batch/)).toHaveLength(2);
    });
});

describe('Print / PDF', () => {
    const fakeWindow = () => {
        const docMock = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
        const openMock = vi.spyOn(window, 'open').mockReturnValue({ document: docMock });
        return { docMock, openMock };
    };
    afterEach(() => vi.restoreAllMocks());

    it('prints the day in English, even from a Spanish screen', async () => {
        const { docMock } = fakeWindow();
        await open([today()], { props: { language: 'es' } });
        fireEvent.click(screen.getByText('Imprimir / PDF'));
        const html = docMock.write.mock.calls[0][0];
        expect(html).toContain('RICE FOR FRIED RICE: 4-HOUR TIME CONTROL LOG');
        expect(html).toContain('Webster Groves');
        expect(html).toContain('Printed 1:00 PM by C. Carla');
        expect(html).not.toMatch(/Registro|Lote/);
    });

    it('a saved copy prints with a warning and never says the day was empty', async () => {
        const { docMock } = fakeWindow();
        await open([], { meta: { fromCache: true } });
        fireEvent.click(screen.getByText('Print / PDF'));
        const html = docMock.write.mock.calls[0][0];
        expect(html).toContain('NOT CONFIRMED: printed offline');
        expect(html).not.toContain('No rice batches logged this day');
        expect(html).not.toMatch(/0 batches/);
    });

    it('a partial saved copy prints what it has, with the same warning', async () => {
        const { docMock } = fakeWindow();
        await open([today()], { meta: { fromCache: true } });
        fireEvent.click(screen.getByText('Print / PDF'));
        const html = docMock.write.mock.calls[0][0];
        expect(html).toContain('It may be missing batches');
        expect(html).toContain('Saved on this device so far: 1 batch:');
    });

    it('a day the server answered has no warning', async () => {
        const { docMock } = fakeWindow();
        await open([]);
        fireEvent.click(screen.getByText('Print / PDF'));
        const html = docMock.write.mock.calls[0][0];
        expect(html).not.toContain('NOT CONFIRMED');
        expect(html).toContain('No rice batches logged this day.');
    });

    it('uses the native print path in the app', async () => {
        window.Capacitor = { isNativePlatform: () => true };
        try {
            await open([today()]);
            fireEvent.click(screen.getByText('Print / PDF'));
            expect(printViaNativeMock).toHaveBeenCalledTimes(1);
            expect(printViaNativeMock.mock.calls[0][1]).toBe('DD Mau Rice Log');
        } finally {
            delete window.Capacitor;
        }
    });

    it('won\'t print a day that couldn\'t load', async () => {
        const { openMock } = fakeWindow();
        await open();
        const day = listeners.find((l) => l.filters.some(([f]) => f === 'cookDay'));
        await act(async () => { day.err(new Error('offline')); });
        fireEvent.click(screen.getByText('Print / PDF'));
        expect(openMock).not.toHaveBeenCalled();
    });

    it('the printed log carries deleted tickets as one line', async () => {
        const { docMock } = fakeWindow();
        await open([today({ id: 'g', batchNo: 4, deletedAt: iso(12, 0), deletedBy: 'Maria Lee', deleteReason: 'Printed by mistake' }), today({ id: 'k', batchNo: 5 })]);
        fireEvent.click(screen.getByText('Print / PDF'));
        expect(docMock.write.mock.calls[0][0]).toContain('Deleted tickets: #4 (M. Lee, 12:00 PM: Printed by mistake).');
    });
});

describe('readings below 135F on the log', () => {
    const low = (over = {}) => ({ id: 'l1', recordType: 'low_reading', location: 'webster', readingDay: '2026-11-02', tempF: 128, at: iso(11, 2), by: 'Ana Reyes', ...over });

    it('shows one a batch followed, and doesn\'t count it as a batch or a flag', async () => {
        await open([low(), today({ startAttempts: [128, 142], startTempF: 142, lowReadingIds: ['l1'] })]);
        expect(screen.getByTestId('rice-low-reading')).toHaveTextContent('11:02 AM · 128°F · Ana Reyes: re-probed: batch #1');
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('1 batch:');
        expect(row(1)).toHaveTextContent('First reading 128F was below 135F. Re-probed: 142F.');
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('1 flag');
    });

    it('shows one nothing followed, and that counts as a flag', async () => {
        await open([low()]);
        expect(screen.getByTestId('rice-low-reading')).toHaveTextContent('no batch logged after this reading');
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('0 batches: 0 used up, 0 open. 0 past limit. 1 flag.');
    });

    it('prints with the day', async () => {
        const docMock = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
        vi.spyOn(window, 'open').mockReturnValue({ document: docMock });
        await open([low()]);
        fireEvent.click(screen.getByText('Print / PDF'));
        expect(docMock.write.mock.calls[0][0]).toContain('* 11:02 AM 128F, A. Reyes: no batch logged after this reading.');
        vi.restoreAllMocks();
    });

    it('its listener follows the day and store', async () => {
        await open([]);
        await act(async () => { fireEvent.click(screen.getByLabelText('Previous day')); });
        const live = listeners.filter((l) => l.active && l.filters.some(([f]) => f === 'readingDay'));
        expect(live).toHaveLength(1);
        expect(live[0].filters).toEqual(expect.arrayContaining([['location', '==', 'webster'], ['readingDay', '==', '2026-11-01']]));
    });
});

describe('stores and language', () => {
    it('an owner viewing both stores picks one, and rows follow', async () => {
        await open([], { staff: 'Owner Andrew', props: { location: 'both' } });
        expect(screen.getByRole('heading', { name: 'Webster Groves' })).toBeInTheDocument();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Maryland Heights' })); });
        expect(screen.getByRole('heading', { name: 'Maryland Heights' })).toBeInTheDocument();
        const day = listeners.filter((l) => l.active).find((l) => l.filters.some(([f]) => f === 'cookDay'));
        expect(day.filters).toContainEqual(['location', '==', 'maryland']);
    });

    it('a one-store view has no picker', async () => {
        await open([], { props: { location: 'maryland' } });
        expect(screen.getByRole('heading', { name: 'Maryland Heights' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Webster Groves' })).toBe(null);
    });

    it('says the weekday in Spanish on screen', async () => {
        const y = today({ id: 'y', batchNo: 7, cookDay: '2026-11-01', madeAt: iso(18, 0, 1), cookedAt: iso(18, 0, 1), tossByAt: iso(22, 0, 1), wokByAt: iso(21, 45, 1) });
        await open([y, fridge()], { props: { language: 'es' } });
        expect(screen.getByText('LUN 11/02/2026')).toBeInTheDocument();
        expect(row(2).textContent).toContain('Usar antes de MAR 11/03');
        expect(within(row(7)).getByText('Sigue abierto desde DOM 11/01')).toBeInTheDocument();
    });

    it('reads in Spanish', async () => {
        await open([today(), fridge()], { props: { language: 'es' } });
        expect(screen.getByText('Registro de arroz')).toBeInTheDocument();
        expect(within(row(1)).getByText('Se acabó')).toBeInTheDocument();
        expect(within(row(1)).getByText('Para hoy')).toBeInTheDocument();
        expect(within(row(2)).getByText('Para el refri')).toBeInTheDocument();
        expect(within(row(1)).getByText('Impreso por error: borrar')).toBeInTheDocument();
        expect(screen.getByTestId('rice-connection')).toHaveTextContent('Conectado. Al día.');
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('2 lotes');
    });
});
