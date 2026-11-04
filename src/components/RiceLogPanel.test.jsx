// The rice screen — mounts the real panel + real riceLog.js and riceSticker.js
// logic with Firestore + printing mocked (2026-11-02, rebuilt 2026-11-03).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';

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
vi.mock('../capacitor-bridge', () => ({ printViaNative: vi.fn() }));
vi.mock('../toast', () => ({ toast: vi.fn() }));
vi.mock('./ModalPortal', () => ({ default: ({ children }) => children }));

import RiceLogPanel from './RiceLogPanel';

const NOW = new Date(2026, 10, 2, 13, 0);   // Mon Nov 2, 1:00p local
const iso = (h, m, d = 2) => new Date(2026, 10, d, h, m).toISOString();

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

// A row as a v2 client writes it.
const batch = (over = {}) => ({
    id: 'a', schemaVersion: 2, route: 'time_control', batchNo: 1, cookDay: '2026-11-02', location: 'webster', status: 'cooling',
    cookedBy: 'Rubisel', madeAt: iso(11, 0), cookedAt: iso(11, 0), wokByAt: iso(14, 45), tossByAt: iso(15, 0), fridgeByAt: iso(13, 0),
    startTempF: 198, startAttempts: [198], pans: 1, prints: [{ ok: true, copies: 1 }], createdMs: new Date(iso(11, 0)).getTime(),
    ...over,
});

const open = async (props = {}) => {
    render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} {...props} />);
    await feed([]);
};
const wheel = () => screen.getByRole('spinbutton');
const tapCenter = () => fireEvent.click(screen.getByRole('button', { name: '200' }));
// The print buttons, not the route chips on older-batch rows.
const todayButton = () => screen.getByRole('button', { name: /^For Today/ });
const fridgeButton = () => screen.getByRole('button', { name: /^For the Fridge/ });
const pressToday = async () => { await act(async () => { fireEvent.click(todayButton()); }); };
const pressFridge = async () => { await act(async () => { fireEvent.click(fridgeButton()); }); };
const rollTo = (value) => {
    const step = value < Number(wheel().getAttribute('aria-valuenow')) ? 'ArrowDown' : 'ArrowUp';
    while (Number(wheel().getAttribute('aria-valuenow')) !== value) fireEvent.keyDown(wheel(), { key: step });
};
const printedText = (call = 0) => printRiceLabelMock.mock.calls[call][0].rows.map((r) => r.text.trim());
// What setDoc was given, by kind: low readings are their own write.
const written = () => setDocMock.mock.calls.map((c) => c[1]);
const batchWrites = () => written().filter((d) => d.recordType !== 'low_reading');
const lowWrites = () => written().filter((d) => d.recordType === 'low_reading');

beforeEach(() => {
    listeners.length = 0;
    localStorage.clear();
    setDocMock.mockClear();
    setDocMock.mockImplementation(async () => {});
    updateDocMock.mockClear();
    updateDocMock.mockImplementation(async () => {});
    printRiceLabelMock.mockClear();
    printRiceLabelMock.mockImplementation(async () => ({ ok: true }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('print stays locked until the cook touches the wheel', () => {
    it('tapping Print first shows a message, and nothing prints or saves', async () => {
        await open();
        await pressToday();
        expect(screen.getByRole('alert')).toHaveTextContent('Touch the wheel first');
        expect(setDocMock).not.toHaveBeenCalled();
        expect(printRiceLabelMock).not.toHaveBeenCalled();
        // The buttons aren't silently disabled.
        expect(todayButton()).not.toBeDisabled();
    });

    it('rolling unlocks it and saves "rolled"', async () => {
        await open();
        rollTo(187);
        await pressToday();
        const logged = setDocMock.mock.calls[0][1];
        expect(logged).toMatchObject({ startTempF: 187, startAttempts: [187], startSetBy: 'rolled' });
    });

    it('tapping the centered number unlocks it and saves "tapped"', async () => {
        await open();
        tapCenter();
        await pressToday();
        expect(setDocMock.mock.calls[0][1]).toMatchObject({ startTempF: 200, startSetBy: 'tapped' });
    });

    it('the message goes away after a touch', async () => {
        await open();
        await pressToday();
        tapCenter();
        expect(screen.queryByRole('alert')).toBe(null);
    });

    it('opens at 200', async () => {
        await open();
        expect(wheel()).toHaveAttribute('aria-valuenow', '200');
    });
});

describe('starting a batch', () => {
    it('For Today logs a v2 row, then prints its own labeled sticker', async () => {
        await open();
        tapCenter();
        await pressToday();

        expect(setDocMock).toHaveBeenCalledTimes(1);
        const logged = setDocMock.mock.calls[0][1];
        expect(logged).toMatchObject({
            schemaVersion: 2, route: 'time_control', location: 'webster', cookDay: '2026-11-02', batchNo: 1,
            cookedBy: 'Laura Hurtado', status: 'cooling', timeSource: 'now', minutesLate: 0, pans: 1, createdAt: 'SERVER_TS',
        });
        expect(logged.madeAt).toBe(NOW.toISOString());
        expect(new Date(logged.tossByAt) - NOW).toBe(4 * 3600000);

        expect(printRiceLabelMock).toHaveBeenCalledTimes(1);
        expect(printRiceLabelMock.mock.calls[0][0]).toMatchObject({ location: 'webster', copies: 1, byName: 'Laura Hurtado' });
        expect(printedText()).toEqual([
            'FRIED RICE RICE', 'ARROZ PARA FREIR', '#1 MON 11/02  LAURA H', 'MADE/HECHO      1:00p', 'TEMP             200F',
            'WOK BY/ANTES    4:45p', 'TOSS BY/TIRAR ANTES', '5:00p', 'NO FRIDGE/NO AL REFRI',
        ]);
        // The sticker attempt lands in the batch's print history.
        expect(updateDocMock.mock.calls[0][1].prints.arrayUnion[0]).toMatchObject({ ok: true, by: 'Laura Hurtado', copies: 1 });
    });

    it('For the Fridge logs the cooling route and its deadlines', async () => {
        await open();
        rollTo(198);
        await pressFridge();
        expect(setDocMock.mock.calls[0][1]).toMatchObject({ route: 'cooling', useByDay: '2026-11-03', startTempF: 198, status: 'cooling' });
        expect(printedText()).toEqual([
            'FRIED RICE RICE', 'ARROZ PARA FREIR', 'FOR FRIDGE/PARA REFRI', '#1 MON 11/02  LAURA H', 'MADE/HECHO      1:00p', 'TEMP             198F',
            '70F BY/ANTES    3:00p', 'THEN FRIDGE/AL REFRI', '41F BY/ANTES    7:00p', 'LATE=TOSS/TARDE=TIRAR', 'USE BY/USAR TUE 11/03',
        ]);
    });

    it('each button shows the deadlines it will print before you tap', async () => {
        await open();
        const today = within(todayButton());
        expect(today.getByText('Wok by 4:45p')).toBeInTheDocument();
        expect(today.getByText('Toss by 5:00p')).toBeInTheDocument();
        const fridge = within(fridgeButton());
        expect(fridge.getByText(/70F by 3:00p · 41F by 7:00p/)).toBeInTheDocument();
        expect(fridge.getByText('Use by TUE 11/03')).toBeInTheDocument();
    });

    it('reads the clock at the moment of the tap, not the last render', async () => {
        await open();
        tapCenter();
        vi.setSystemTime(new Date(2026, 10, 2, 13, 4, 30));
        await pressToday();
        expect(setDocMock.mock.calls[0][1].madeAt).toBe(new Date(2026, 10, 2, 13, 4, 30).toISOString());
        expect(printedText()).toContain('MADE/HECHO      1:04p');
    });

    it('5 minutes ago runs its deadlines from the picked time and flags the row', async () => {
        await open();
        fireEvent.click(screen.getByText('5 min ago'));
        expect(within(todayButton()).getByText('Toss by 4:55p')).toBeInTheDocument();
        tapCenter();
        await pressToday();
        const logged = setDocMock.mock.calls[0][1];
        expect(logged).toMatchObject({ timeSource: 'picked', minutesLate: 5 });
        expect(new Date(logged.madeAt).getTime()).toBe(NOW.getTime() - 5 * 60000);
    });

    it('10 minutes ago too', async () => {
        await open();
        fireEvent.click(screen.getByText('10 min ago'));
        tapCenter();
        await pressToday();
        expect(setDocMock.mock.calls[0][1]).toMatchObject({ timeSource: 'picked', minutesLate: 10 });
    });

    it('For the Fridge is now only: picking an earlier time stops it, and says why', async () => {
        await open();
        fireEvent.click(screen.getByText('5 min ago'));
        tapCenter();
        expect(screen.getByText('Now only')).toBeInTheDocument();
        await pressFridge();
        expect(screen.getByRole('alert')).toHaveTextContent('For the Fridge prints with Now only');
        expect(setDocMock).not.toHaveBeenCalled();
        expect(printRiceLabelMock).not.toHaveBeenCalled();
    });

    it('pans cap at 4, one sticker each', async () => {
        await open();
        const more = screen.getByLabelText('More pans');
        for (let i = 0; i < 6; i++) fireEvent.click(more);
        expect(screen.getByTestId('rice-pans')).toHaveTextContent('4');
        tapCenter();
        await pressToday();
        expect(setDocMock.mock.calls[0][1].pans).toBe(4);
        expect(printRiceLabelMock.mock.calls[0][0].copies).toBe(4);
        expect(screen.getByTestId('rice-pans')).toHaveTextContent('1');
    });

    it('resets for the next batch: the wheel relocks at 200', async () => {
        await open();
        rollTo(190);
        await pressToday();
        expect(wheel()).toHaveAttribute('aria-valuenow', '200');
        await pressToday();
        expect(setDocMock).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('alert')).toHaveTextContent('Touch the wheel first');
    });

    it('a double tap starts one batch', async () => {
        let release;
        printRiceLabelMock.mockImplementation(() => new Promise((r) => { release = () => r({ ok: true }); }));
        await open();
        tapCenter();
        const btn = todayButton();
        await act(async () => { fireEvent.click(btn); fireEvent.click(btn); });
        expect(setDocMock).toHaveBeenCalledTimes(1);
        await act(async () => { release(); });
    });

    it('the log write never waits on the server: a Wi-Fi drop can\'t stop a sticker', async () => {
        setDocMock.mockImplementation(() => new Promise(() => {}));   // offline: never acked
        await open();
        tapCenter();
        await pressToday();
        expect(setDocMock).toHaveBeenCalledTimes(1);
        expect(printRiceLabelMock).toHaveBeenCalledTimes(1);
    });
});

describe('below 135F', () => {
    it('numbers turn red, nothing prints, it says probe again, and the wheel reopens at 200', async () => {
        await open();
        rollTo(128);
        expect(screen.getByText(/Below 135°F won't print/)).toBeInTheDocument();
        await pressToday();
        expect(printRiceLabelMock).not.toHaveBeenCalled();
        expect(batchWrites()).toEqual([]);
        expect(screen.getByText('Probe again in the center.')).toBeInTheDocument();
        expect(screen.getByText(/128°F is below 135°F/)).toBeInTheDocument();
        expect(wheel()).toHaveAttribute('aria-valuenow', '200');
    });

    it('135 exactly prints', async () => {
        await open();
        rollTo(135);
        await pressToday();
        expect(printRiceLabelMock).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('Probe again in the center.')).toBe(null);
    });

    it('a second reading at 135 or above prints, keeps both numbers, and locks again until touched', async () => {
        await open();
        rollTo(128);
        await pressToday();
        // The wheel is relocked: the old reading can't print by accident.
        await pressToday();
        expect(printRiceLabelMock).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent('Touch the wheel first');
        rollTo(142);
        await pressToday();
        expect(printRiceLabelMock).toHaveBeenCalledTimes(1);
        expect(batchWrites()[0]).toMatchObject({ startTempF: 142, startAttempts: [128, 142] });
        expect(screen.queryByText('Probe again in the center.')).toBe(null);
    });

    it('still low: the only action is Toss, which logs a tossed row with no sticker', async () => {
        await open();
        rollTo(128);
        await pressToday();
        rollTo(130);
        await pressToday();
        expect(screen.getByText('Still low. Toss it.')).toBeInTheDocument();
        expect(screen.queryByRole('spinbutton')).toBe(null);
        expect(screen.queryByText('For Today')).toBe(null);
        expect(screen.queryByText('For the Fridge')).toBe(null);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Toss' })); });
        expect(printRiceLabelMock).not.toHaveBeenCalled();
        expect(batchWrites()).toHaveLength(1);
        expect(batchWrites()[0]).toMatchObject({
            schemaVersion: 2, status: 'tossed', tossReason: 'below_135', tossedBy: 'Laura Hurtado',
            startAttempts: [128, 130], startTempF: 130, batchNo: 1, stickerCount: 0,
        });
        // Back to a clean start.
        expect(wheel()).toHaveAttribute('aria-valuenow', '200');
    });

    it('the Fridge button runs the same re-probe', async () => {
        await open();
        rollTo(120);
        await pressFridge();
        expect(printRiceLabelMock).not.toHaveBeenCalled();
        expect(screen.getByText('Probe again in the center.')).toBeInTheDocument();
    });

    it('closing the screen doesn\'t erase a low reading', async () => {
        const { unmount } = render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
        await feed([]);
        rollTo(128);
        await pressToday();
        unmount();
        listeners.length = 0;
        await open();
        expect(screen.getByText('Probe again in the center.')).toBeInTheDocument();
        rollTo(150);
        await pressToday();
        expect(batchWrites()[0].startAttempts).toEqual([128, 150]);
    });

    it('every low reading is logged the moment it\'s taken, without waiting on the server', async () => {
        setDocMock.mockImplementation(() => new Promise(() => {}));   // offline: never acked
        await open();
        rollTo(128);
        await pressToday();
        expect(lowWrites()).toHaveLength(1);
        expect(lowWrites()[0]).toMatchObject({
            recordType: 'low_reading', tempF: 128, location: 'webster', readingDay: '2026-11-02',
            by: 'Laura Hurtado', setBy: 'rolled', at: NOW.toISOString(), createdAt: 'SERVER_TS',
        });
        expect(screen.getByText('Probe again in the center.')).toBeInTheDocument();
        rollTo(130);
        await pressToday();
        expect(lowWrites().map((d) => d.tempF)).toEqual([128, 130]);
    });

    it('the batch that follows links back to them', async () => {
        await open();
        rollTo(128);
        await pressToday();
        rollTo(142);
        await pressToday();
        expect(batchWrites()[0].lowReadingIds).toEqual(['newBatch']);
    });

    it('a toss links to them too', async () => {
        await open();
        rollTo(128);
        await pressToday();
        rollTo(130);
        await pressToday();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Toss' })); });
        expect(batchWrites()[0].lowReadingIds).toEqual(['newBatch', 'newBatch']);
    });

    it('a low reading that doesn\'t save says so', async () => {
        const { toast } = await import('../toast');
        toast.mockClear();
        setDocMock.mockImplementationOnce(async () => { throw new Error('denied'); });
        await open();
        rollTo(128);
        await pressToday();
        expect(toast).toHaveBeenCalledWith(expect.stringMatching(/The 128°F reading did not save/), expect.objectContaining({ kind: 'error' }));
        expect(screen.getByText('Probe again in the center.')).toBeInTheDocument();
    });

    it('another cook\'s start doesn\'t inherit it: no flag on their batch, and their own low reading isn\'t a second low', async () => {
        const { unmount } = render(<RiceLogPanel location="webster" staffName="Ana Reyes" language="en" onClose={() => {}} />);
        await feed([]);
        rollTo(128);
        await pressToday();
        unmount();
        listeners.length = 0;
        setDocMock.mockClear();
        await open();     // Laura Hurtado
        expect(screen.queryByText('Probe again in the center.')).toBe(null);
        rollTo(130);
        await pressToday();
        expect(screen.queryByText('Still low. Toss it.')).toBe(null);
        expect(screen.getByText('Probe again in the center.')).toBeInTheDocument();
        rollTo(150);
        await pressToday();
        expect(batchWrites()[0].startAttempts).toEqual([130, 150]);
    });
});

describe('unmarked more than 10 minutes', () => {
    it('gets a one-tap Toss it that logs no_sticker, not a sticker', async () => {
        await open();
        fireEvent.click(screen.getByText('Over 10 min'));
        expect(screen.getByText('Unmarked too long. Toss it.')).toBeInTheDocument();
        expect(screen.queryByText('For Today')).toBe(null);
        expect(screen.queryByRole('spinbutton')).toBe(null);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Toss it' })); });
        expect(printRiceLabelMock).not.toHaveBeenCalled();
        expect(setDocMock.mock.calls[0][1]).toMatchObject({
            status: 'tossed', tossReason: 'no_sticker', timeUnknown: true, startTempF: null, batchNo: 1,
        });
    });

    it('a slip of the finger can go back to Now', async () => {
        await open();
        fireEvent.click(screen.getByText('Over 10 min'));
        fireEvent.click(screen.getByText('Now'));
        expect(screen.getByText('For Today')).toBeInTheDocument();
    });
});

describe('batch numbers and loading', () => {
    it('numbers after the day\'s highest, counting deleted tickets', async () => {
        await open();
        await feed([batch({ id: 'a', batchNo: 1 }), batch({ id: 'b', batchNo: 4, deletedAt: iso(12, 0), deletedBy: 'L', deleteReason: 'x' })]);
        expect(screen.getByText(/New batch #5/)).toBeInTheDocument();
        tapCenter();
        await pressToday();
        expect(setDocMock.mock.calls[0][1].batchNo).toBe(5);
    });

    it('shows when two devices used the same number', async () => {
        await open();
        await feed([batch({ id: 'a', batchNo: 2 }), batch({ id: 'b', batchNo: 2 })]);
        expect(screen.getByText('a number is used twice today')).toBeInTheDocument();
    });

    it('waits a moment for today\'s batches, and says so instead of silently ignoring the tap', async () => {
        render(<RiceLogPanel location="webster" staffName="L" language="en" onClose={() => {}} />);
        expect(screen.getByText(/New batch #…/)).toBeInTheDocument();
        tapCenter();
        await pressToday();
        expect(setDocMock).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent("getting today's batch number");
        await feed([]);
        await pressToday();
        expect(setDocMock).toHaveBeenCalledTimes(1);
    });

    describe('offline, with this device\'s saved copy', () => {
        const fakeClock = () => {
            vi.useRealTimers();
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            vi.setSystemTime(NOW);
        };

        it('a saved copy isn\'t the day: the number waits, then warns it may repeat', async () => {
            fakeClock();
            render(<RiceLogPanel location="webster" staffName="L" language="en" onClose={() => {}} />);
            await act(async () => { vi.advanceTimersByTime(50); });
            await feed([batch({ id: 'a', batchNo: 2 })], { fromCache: true });
            expect(screen.getByText(/New batch #…/)).toBeInTheDocument();
            expect(screen.queryByText(/batch number may repeat/)).toBe(null);
            await act(async () => { vi.advanceTimersByTime(5100); });
            expect(screen.getByText(/New batch #3/)).toBeInTheDocument();
            expect(screen.getByText(/batch number may repeat/)).toBeInTheDocument();
            tapCenter();
            await act(async () => {
                fireEvent.click(todayButton());
                await vi.advanceTimersByTimeAsync(10);
            });
            expect(batchWrites()[0].batchNo).toBe(3);
            expect(printRiceLabelMock).toHaveBeenCalledTimes(1);
        });

        it('an empty saved copy doesn\'t clear the warning', async () => {
            fakeClock();
            render(<RiceLogPanel location="webster" staffName="L" language="en" onClose={() => {}} />);
            await act(async () => { vi.advanceTimersByTime(5100); });
            expect(screen.getByText(/batch number may repeat/)).toBeInTheDocument();
            await feed([], { fromCache: true });
            expect(screen.getByText(/New batch #1/)).toBeInTheDocument();
            expect(screen.getByText(/batch number may repeat/)).toBeInTheDocument();
        });

        it('the server answering clears it, with the right number', async () => {
            fakeClock();
            render(<RiceLogPanel location="webster" staffName="L" language="en" onClose={() => {}} />);
            await act(async () => { vi.advanceTimersByTime(5100); });
            await feed([batch({ id: 'a', batchNo: 2 })], { fromCache: true });
            await feed([batch({ id: 'a', batchNo: 2 }), batch({ id: 'b', batchNo: 4 })]);
            expect(screen.getByText(/New batch #5/)).toBeInTheDocument();
            expect(screen.queryByText(/batch number may repeat/)).toBe(null);
        });
    });

    it('a failed load of today\'s batches still lets the cook start, with a repeat-number warning', async () => {
        render(<RiceLogPanel location="webster" staffName="L" language="en" onClose={() => {}} />);
        const day = listeners.find((l) => l.filters.some(([f]) => f === 'cookDay'));
        await act(async () => { day.err(new Error('offline')); });
        expect(screen.getByText(/batch number may repeat/)).toBeInTheDocument();
        tapCenter();
        await pressToday();
        expect(setDocMock.mock.calls[0][1].batchNo).toBe(1);
        expect(printRiceLabelMock).toHaveBeenCalledTimes(1);
    });

    it('a slow first load stops blocking after a few seconds (first batch of the day on weak Wi-Fi)', async () => {
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        vi.setSystemTime(NOW);
        render(<RiceLogPanel location="webster" staffName="L" language="en" onClose={() => {}} />);
        expect(screen.getByText(/Loading today's batches/)).toBeInTheDocument();
        await act(async () => { vi.advanceTimersByTime(50); });     // let React run the mount effects
        await act(async () => { vi.advanceTimersByTime(5100); });
        expect(screen.getByText(/batch number may repeat/)).toBeInTheDocument();
        tapCenter();
        await act(async () => {
            fireEvent.click(todayButton());
            await vi.advanceTimersByTimeAsync(10);
        });
        expect(setDocMock).toHaveBeenCalledTimes(1);
    });
});

describe('when the sticker doesn\'t print', () => {
    it('the row is still saved, the failure recorded, and the toss time shows huge with Reprint', async () => {
        printRiceLabelMock.mockImplementation(async () => ({ ok: false, error: 'no_printer_configured' }));
        await open();
        tapCenter();
        await pressToday();
        expect(setDocMock).toHaveBeenCalledTimes(1);
        expect(updateDocMock.mock.calls[0][1].prints.arrayUnion[0]).toMatchObject({ ok: false, error: 'no_printer_configured' });
        expect(updateDocMock.mock.calls[0][1].stickerCount).toBeUndefined();
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Batch #1 is saved');
        expect(alert).toHaveTextContent('No printer set up');
        expect(within(alert).getByText('5:00p').className).toContain('text-5xl');
        expect(within(alert).getByRole('button', { name: 'Reprint' })).toBeInTheDocument();
    });

    it('the tape card goes away once that ticket is deleted, so nothing reprints under it', async () => {
        printRiceLabelMock.mockImplementation(async () => ({ ok: false, error: 'no_printer_configured' }));
        await open();
        tapCenter();
        await pressToday();
        expect(screen.getByText('Write this on tape:')).toBeInTheDocument();
        await feed([batch({ id: 'newBatch', prints: [{ ok: false, error: 'no_printer_configured', copies: 1 }] })]);
        expect(screen.getByText('Write this on tape:')).toBeInTheDocument();
        await feed([batch({ id: 'newBatch', deletedAt: iso(13, 1), deletedBy: 'L', deleteReason: 'Printed by mistake' })]);
        expect(screen.queryByText('Write this on tape:')).toBe(null);
    });

    it('a Fridge batch\'s tape card has the use-by day too', async () => {
        printRiceLabelMock.mockImplementation(async () => ({ ok: false, error: 'no_printer_configured' }));
        await open();
        tapCenter();
        await pressFridge();
        expect(screen.getByRole('alert')).toHaveTextContent('USE BY TUE 11/03');
    });

    it('a timeout says to check for a sticker, and is never re-sent by itself', async () => {
        printRiceLabelMock.mockImplementation(async () => ({ ok: false, error: 'printer timeout' }));
        await open();
        tapCenter();
        await pressToday();
        expect(screen.getByRole('alert')).toHaveTextContent('Check whether a sticker came out before you reprint');
        expect(screen.getByRole('alert')).not.toHaveTextContent('Check the paper');
        expect(printRiceLabelMock).toHaveBeenCalledTimes(1);
    });

    it('Reprint sends the same times, only when tapped', async () => {
        printRiceLabelMock.mockImplementationOnce(async () => ({ ok: false, error: 'printer timeout' }));
        await open();
        tapCenter();
        await pressToday();
        vi.setSystemTime(new Date(2026, 10, 2, 13, 20));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reprint' })); });
        expect(printRiceLabelMock).toHaveBeenCalledTimes(2);
        expect(printedText(1)).toEqual(printedText(0));
        // It came out: the tape card goes away.
        expect(screen.queryByRole('alert')).toBe(null);
    });

    describe('a failed job with several pans', () => {
        const failThree = async (res = { ok: false, error: 'no_printer_configured' }) => {
            printRiceLabelMock.mockImplementationOnce(async () => res);
            await open();
            fireEvent.click(screen.getByLabelText('More pans'));
            fireEvent.click(screen.getByLabelText('More pans'));
            tapCenter();
            await pressToday();
        };
        const copiesOf = (call) => printRiceLabelMock.mock.calls[call][0].copies;

        it('Reprint sends every pan when nothing printed, and the card goes away', async () => {
            await failThree();
            expect(copiesOf(0)).toBe(3);
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reprint 3' })); });
            expect(copiesOf(1)).toBe(3);
            expect(screen.queryByText('Write this on tape:')).toBe(null);
        });

        it('the cook can send fewer. The card stays, saying what\'s left', async () => {
            await failThree();
            fireEvent.click(screen.getByLabelText('Fewer stickers'));
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reprint 2' })); });
            expect(copiesOf(1)).toBe(2);
            expect(screen.getByText('Write this on tape:')).toBeInTheDocument();
            expect(screen.getByTestId('rice-printed-so-far')).toHaveTextContent('2 of 3 stickers are done.');
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reprint' })); });
            expect(copiesOf(2)).toBe(1);
            expect(screen.queryByText('Write this on tape:')).toBe(null);
        });

        it('a timed-out job says to check first, and lets the cook say it came out without printing', async () => {
            await failThree({ ok: false, error: 'printer timeout' });
            expect(screen.getByRole('alert')).toHaveTextContent('Check whether a sticker came out before you reprint');
            updateDocMock.mockClear();
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'It came out' })); });
            expect(printRiceLabelMock).toHaveBeenCalledTimes(1);
            expect(updateDocMock.mock.calls[0][1].prints.arrayUnion[0]).toMatchObject({ ok: true, seen: true, copies: 3, by: 'Laura Hurtado' });
            expect(updateDocMock.mock.calls[0][1].stickerCount).toEqual({ increment: 3 });
            expect(screen.queryByText('Write this on tape:')).toBe(null);
        });

        it('a definite failure doesn\'t offer "It came out"', async () => {
            await failThree();
            expect(screen.queryByRole('button', { name: 'It came out' })).toBe(null);
        });

        it('a job that failed partway offers only what\'s missing, and logs what came out', async () => {
            await failThree({ ok: false, error: 'printer_rejected', copyFailed: 2 });
            expect(updateDocMock.mock.calls[0][1].prints.arrayUnion[0]).toMatchObject({ ok: false, copies: 3, copiesPrinted: 1 });
            expect(updateDocMock.mock.calls[0][1].stickerCount).toEqual({ increment: 1 });
            expect(screen.getByTestId('rice-printed-so-far')).toHaveTextContent('1 of 3 stickers are done.');
            expect(screen.getByTestId('rice-reprint-count')).toHaveTextContent('2');
        });
    });

    describe('when the screen closes while the printer is thinking', () => {
        const deferPrint = () => {
            let finish;
            printRiceLabelMock.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
            return (res) => finish(res);
        };

        it('a toast still carries the failure and the toss time for the tape', async () => {
            const { toast } = await import('../toast');
            toast.mockClear();
            const finish = deferPrint();
            const { unmount } = render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
            await feed([]);
            tapCenter();
            await pressToday();
            unmount();
            await act(async () => { finish({ ok: false, error: 'printer timeout' }); await Promise.resolve(); });
            const failure = toast.mock.calls.find(([, o]) => o?.kind === 'error');
            expect(failure?.[0]).toMatch(/Batch #1 is saved/);
            expect(failure?.[0]).toMatch(/Check whether a sticker came out/);
            expect(failure?.[0]).toMatch(/Toss by 5:00p/);
        });

        it('a Fridge batch\'s toast carries both its times', async () => {
            const { toast } = await import('../toast');
            toast.mockClear();
            const finish = deferPrint();
            const { unmount } = render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
            await feed([]);
            tapCenter();
            await pressFridge();
            unmount();
            await act(async () => { finish({ ok: false, error: 'printer_rejected' }); await Promise.resolve(); });
            const failure = toast.mock.calls.find(([, o]) => o?.kind === 'error');
            expect(failure?.[0]).toMatch(/70F by 3:00p, 41F by 7:00p/);
        });

        it('so does moving to the log view, where the card doesn\'t show', async () => {
            const { toast } = await import('../toast');
            toast.mockClear();
            const finish = deferPrint();
            await open();
            tapCenter();
            await pressToday();
            fireEvent.click(screen.getByRole('button', { name: 'Rice Log' }));
            await act(async () => { finish({ ok: false, error: 'no_printer_configured' }); await Promise.resolve(); });
            expect(toast.mock.calls.some(([m, o]) => o?.kind === 'error' && /No printer set up/.test(m))).toBe(true);
        });

        it('with the card on screen there\'s no second message', async () => {
            const { toast } = await import('../toast');
            toast.mockClear();
            printRiceLabelMock.mockImplementationOnce(async () => ({ ok: false, error: 'no_printer_configured' }));
            await open();
            tapCenter();
            await pressToday();
            expect(screen.getByText('Write this on tape:')).toBeInTheDocument();
            expect(toast.mock.calls.some(([, o]) => o?.kind === 'error')).toBe(false);
        });
    });

    it('a Fridge batch shows both its times for the tape', async () => {
        printRiceLabelMock.mockImplementation(async () => ({ ok: false, error: 'printer_rejected' }));
        await open();
        tapCenter();
        await pressFridge();
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('70F 3:00p');
        expect(alert).toHaveTextContent('41F 7:00p');
        expect(alert).toHaveTextContent('Check the paper');
    });

    it('a log write that fails is reported too', async () => {
        const { toast } = await import('../toast');
        setDocMock.mockImplementation(async () => { throw new Error('denied'); });
        await open();
        tapCenter();
        await pressToday();
        expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Could not save the batch/), expect.objectContaining({ kind: 'error' }));
    });
});

describe('older batches line', () => {
    it('shows the oldest open batches with All Gone and Tossed, and doesn\'t block printing', async () => {
        await open();
        await feed([
            batch({ id: 'old', batchNo: 1 }),                          // 2 hours ago
            batch({ id: 'new', batchNo: 2, madeAt: iso(12, 30), cookedAt: iso(12, 30) }),   // 30 minutes ago
            batch({ id: 'done', batchNo: 3, status: 'used' }),
        ]);
        const row = screen.getByTestId('rice-row-1');
        expect(within(row).getByText('All Gone')).toBeInTheDocument();
        expect(within(row).getByText('Tossed')).toBeInTheDocument();
        expect(screen.queryByTestId('rice-row-2')).toBe(null);   // probably still in use
        expect(screen.queryByTestId('rice-row-3')).toBe(null);
        tapCenter();
        await pressToday();
        expect(printRiceLabelMock).toHaveBeenCalledTimes(1);
    });

    it('caps the line and points at the log for the rest', async () => {
        await open();
        await feed([1, 2, 3, 4, 5].map((n) => batch({ id: `b${n}`, batchNo: n })));
        expect(screen.getAllByText('All Gone')).toHaveLength(3);
        expect(screen.getByText('2 more in the Rice Log')).toBeInTheDocument();
    });

    it('a batch past its toss time asks the three answers', async () => {
        await open();
        await feed([batch({ id: 'late', madeAt: iso(8, 0), cookedAt: iso(8, 0), tossByAt: iso(12, 0), wokByAt: iso(11, 45) })]);
        const row = screen.getByTestId('rice-row-1');
        expect(within(row).getByText('I saw it gone in time')).toBeInTheDocument();
        expect(within(row).getByText('Tossed')).toBeInTheDocument();
        expect(within(row).getByText("Don't know, or used late")).toBeInTheDocument();
        expect(within(row).queryByText('All Gone')).toBe(null);
    });

    it('brings open batches from earlier days, labeled', async () => {
        await open();
        await feed([batch({ id: 'y', cookDay: '2026-11-01', batchNo: 7, madeAt: iso(18, 0, 1), cookedAt: iso(18, 0, 1), tossByAt: iso(22, 0, 1), wokByAt: iso(21, 45, 1) })]);
        expect(within(screen.getByTestId('rice-row-7')).getByText('Still open from SUN 11/01')).toBeInTheDocument();
    });

    it('never offers a fridge button on a For Today batch', async () => {
        await open();
        await feed([batch()]);
        expect(screen.queryByText('Into Fridge')).toBe(null);
    });

    it('a timed-out older batch warns and offers It came out, instead of a bare Reprint', async () => {
        await open();
        await feed([batch({ id: 'late', madeAt: iso(9, 0), cookedAt: iso(9, 0), tossByAt: iso(16, 0), prints: [{ ok: false, error: 'printer timeout', copies: 1 }] })]);
        const row = screen.getByTestId('rice-row-1');
        expect(row).toHaveTextContent('Printer timed out. Check whether a sticker came out.');
        await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'It came out' })); });
        expect(printRiceLabelMock).not.toHaveBeenCalled();
        expect(updateDocMock.mock.calls[0][1].prints.arrayUnion[0]).toMatchObject({ ok: true, seen: true });
    });

    it('a definite print failure on an older batch has no It came out', async () => {
        await open();
        await feed([batch({ id: 'late', madeAt: iso(9, 0), cookedAt: iso(9, 0), tossByAt: iso(16, 0), prints: [{ ok: false, error: 'printer_rejected', copies: 1 }] })]);
        const row = screen.getByTestId('rice-row-1');
        expect(within(row).getByRole('button', { name: 'Reprint' })).toBeInTheDocument();
        expect(within(row).queryByRole('button', { name: 'It came out' })).toBe(null);
    });

    it('a high morning reading here leaves a card that stays until someone dismisses it', async () => {
        vi.setSystemTime(new Date(2026, 10, 3, 8, 0));
        const overnight = batch({
            id: 'f', batchNo: 2, route: 'cooling', status: 'fridge', fridgedAt: iso(12, 55), fridgedBy: 'A',
            madeAt: iso(12, 30), cookedAt: iso(12, 30), seventyByAt: iso(14, 30), fortyOneByAt: iso(18, 30), useByDay: '2026-11-03',
        });
        await open();
        await feed([overnight]);
        const row = screen.getByTestId('rice-row-2');
        fireEvent.click(within(row).getByText('Morning Reading'));
        fireEvent.change(screen.getByLabelText('Reading in degrees F'), { target: { value: '50' } });
        await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Save' })); });
        vi.setSystemTime(new Date(2026, 10, 3, 8, 0, 1));
        await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Yes, 50F: toss it' })); });
        expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'tossed', tossReason: 'morning_above_41' });
        await feed([{ ...overnight, status: 'tossed', tossReason: 'morning_above_41', tossedAt: iso(8, 0, 3), tossedBy: 'L' }]);
        expect(screen.queryByTestId('rice-row-2')).toBe(null);
        expect(screen.getByText('50F: TOSS IT')).toBeInTheDocument();
        expect(screen.getByText(/Batch #2 is above 41F/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(screen.queryByText('50F: TOSS IT')).toBe(null);
    });

    it('a stuck write on one batch never blocks another', async () => {
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        vi.setSystemTime(NOW);
        updateDocMock.mockImplementationOnce(() => new Promise(() => {}));   // offline: never acked
        await open();
        await feed([batch({ id: 'a', batchNo: 1 }), batch({ id: 'b', batchNo: 2 })]);
        const first = screen.getByTestId('rice-row-1');
        await act(async () => { fireEvent.click(within(first).getByText('All Gone')); });
        await act(async () => { vi.advanceTimersByTime(15000); });
        expect(updateDocMock).toHaveBeenCalledTimes(1);
        const second = screen.getByTestId('rice-row-2');
        expect(within(second).getByText('Tossed').closest('button')).not.toBeDisabled();
        await act(async () => { fireEvent.click(within(second).getByText('Tossed')); });
        await act(async () => { vi.advanceTimersByTime(15000); });
        expect(updateDocMock).toHaveBeenCalledTimes(2);
        expect(updateDocMock.mock.calls[1][1]).toMatchObject({ status: 'tossed' });
    });
});

describe('the log from here', () => {
    it('the sticker page\'s Rice log button opens straight on the log', async () => {
        await open({ initialView: 'log' });
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('0 batches');
        expect(screen.queryByRole('spinbutton')).toBe(null);
    });

    it('switching views keeps a reading already rolled', async () => {
        await open();
        rollTo(187);
        fireEvent.click(screen.getByRole('button', { name: 'Rice Log' }));
        expect(screen.queryByRole('spinbutton')).toBe(null);
        fireEvent.click(screen.getByRole('button', { name: 'Start a batch' }));
        expect(wheel()).toHaveAttribute('aria-valuenow', '187');
        await feed([]);
        await pressToday();
        expect(setDocMock.mock.calls[0][1].startTempF).toBe(187);
    });
});

describe('language and store', () => {
    it('reads in Spanish', async () => {
        await open({ location: 'maryland', language: 'es' });
        expect(screen.getByText('Arroz para freír')).toBeInTheDocument();
        expect(screen.getByText('Para hoy')).toBeInTheDocument();
        expect(screen.getByText('Para el refri')).toBeInTheDocument();
        expect(screen.getByText(/Maryland Heights/)).toBeInTheDocument();
        expect(screen.getByText('Ahora')).toBeInTheDocument();
        expect(screen.queryByText('For Today')).toBe(null);
    });

    it('the screen says the use-by weekday in Spanish, and the sticker stays English', async () => {
        await open({ language: 'es' });
        expect(screen.getByText('Usar antes de MAR 11/03')).toBeInTheDocument();
        tapCenter();
        await act(async () => { fireEvent.click(screen.getByText('Para el refri').closest('button')); });
        expect(printedText()).toContain('USE BY/USAR TUE 11/03');
    });

    it('the sticker stays bilingual whatever the screen language', async () => {
        await open({ language: 'es' });
        tapCenter();
        await act(async () => { fireEvent.click(screen.getByText('Para hoy').closest('button')); });
        expect(printedText()).toContain('NO FRIDGE/NO AL REFRI');
        expect(printedText()).toContain('TOSS BY/TIRAR ANTES');
    });

    it('logs to the store being viewed', async () => {
        await open({ location: 'maryland' });
        tapCenter();
        await pressToday();
        expect(setDocMock.mock.calls[0][1].location).toBe('maryland');
        expect(printRiceLabelMock.mock.calls[0][0].location).toBe('maryland');
    });

    it('never logs to "both"', async () => {
        await open({ location: 'both' });
        tapCenter();
        await pressToday();
        expect(setDocMock.mock.calls[0][1].location).toBe('webster');
    });
});

describe('a held close across the two views', () => {
    it('stays held when the cook switches to the log, and Undo still works there', async () => {
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        vi.setSystemTime(NOW);
        await open();
        await feed([batch()]);
        await act(async () => { fireEvent.click(within(screen.getByTestId('rice-row-1')).getByText('All Gone')); });
        fireEvent.click(screen.getByRole('button', { name: 'Rice Log' }));
        await feed([batch()]);
        const logRow = screen.getByTestId('rice-row-1');
        expect(within(logRow).queryByText('All Gone')).toBe(null);
        await act(async () => { fireEvent.click(within(logRow).getByRole('button', { name: 'Undo' })); });
        await act(async () => { vi.advanceTimersByTime(20000); });
        expect(updateDocMock).not.toHaveBeenCalled();
    });
});
