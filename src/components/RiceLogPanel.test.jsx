// RiceLogPanel — mounts the real panel + real riceLog.js logic with
// Firestore + printing mocked (2026-11-02).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

const snapCbs = [];
const errCbs = [];
const setDocMock = vi.fn(async () => {});
const updateDocMock = vi.fn(async () => {});
vi.mock('../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn((...a) => ({ id: a.length === 1 ? 'newBatch' : a[a.length - 1] })),
    collection: vi.fn(() => ({ path: 'rice_log' })),
    onSnapshot: vi.fn((q, cb, err) => { snapCbs.push(cb); errCbs.push(err); return () => {}; }),
    query: vi.fn((...a) => a),
    where: vi.fn((...a) => a),
    setDoc: (...a) => setDocMock(...a),
    updateDoc: (...a) => updateDocMock(...a),
    arrayUnion: vi.fn((x) => ({ arrayUnion: x })),
    increment: vi.fn((n) => ({ increment: n })),
    serverTimestamp: vi.fn(() => 'SERVER_TS'),
}));
vi.mock('../data/firestoreRevive', () => ({ watchdogWrite: (p) => p }));
const printPrepLabelMock = vi.fn(async () => ({ ok: true }));
vi.mock('../data/labelPrinting', () => ({ printPrepLabel: (...a) => printPrepLabelMock(...a) }));
vi.mock('../capacitor-bridge', () => ({ printViaNative: vi.fn() }));
vi.mock('../toast', () => ({ toast: vi.fn() }));
vi.mock('./ModalPortal', () => ({ default: ({ children }) => children }));

import RiceLogPanel from './RiceLogPanel';

const NOW = new Date(2026, 10, 2, 13, 0);   // Mon Nov 2, 1:00p local
const iso = (h, m) => new Date(2026, 10, 2, h, m).toISOString();
const feed = (rows) => act(async () => {
    for (const cb of snapCbs) cb({ forEach: (fn) => rows.forEach((r) => fn({ id: r.id, data: () => r })) });
});

beforeEach(() => {
    snapCbs.length = 0;
    errCbs.length = 0;
    setDocMock.mockClear();
    updateDocMock.mockClear();
    printPrepLabelMock.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('RiceLogPanel', () => {
    it('logs batch #1 and prints a 4-hour COOKED/FRIDGE BY/TOSS sticker', async () => {
        render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
        await feed([]);
        expect(screen.getByText(/batch #1/i)).toBeInTheDocument();
        expect(screen.getByText('No rice batches yet today.')).toBeInTheDocument();

        await act(async () => { fireEvent.click(screen.getByText(/Print sticker \+ log batch/)); });

        expect(setDocMock).toHaveBeenCalledTimes(1);
        const logged = setDocMock.mock.calls[0][1];
        expect(logged).toMatchObject({
            location: 'webster', cookDay: '2026-11-02', batchNo: 1, cookedBy: 'Laura Hurtado', status: 'cooling',
        });
        expect(new Date(logged.tossByAt) - new Date(logged.cookedAt)).toBe(4 * 3600000);

        expect(printPrepLabelMock).toHaveBeenCalledTimes(1);
        const p = printPrepLabelMock.mock.calls[0][0];
        expect(p.shelfLifeHours).toBe(4);
        expect(p.recipe.kind).toBe('rice_batch');
        expect(p.prepDate.toISOString()).toBe(logged.cookedAt);
        expect(p.extraMetaLines[0]).toMatchObject({ en: 'BATCH', text: '#1' });
        // The sticker attempt lands in the batch's print history.
        expect(updateDocMock.mock.calls[0][1].prints.arrayUnion).toMatchObject({ ok: true, by: 'Laura Hurtado' });
    });

    it('numbers the next batch after the day\'s highest and flags a batch past 4 hours', async () => {
        render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
        await feed([
            // Cooked 8:30a — toss was 12:30p, now is 1:00p.
            { id: 'a', batchNo: 1, cookDay: '2026-11-02', location: 'webster', status: 'cooling', cookedBy: 'Rubisel', cookedAt: iso(8, 30), fridgeByAt: iso(10, 30), tossByAt: iso(12, 30), prints: [{ ok: true, copies: 1 }] },
            // Cooked 11:30a — fridge-by 1:30p, still open; its sticker failed.
            { id: 'b', batchNo: 2, cookDay: '2026-11-02', location: 'webster', status: 'cooling', cookedBy: 'Rubisel', cookedAt: iso(11, 30), fridgeByAt: iso(13, 30), tossByAt: iso(15, 30), prints: [{ ok: false, copies: 1, error: 'printer timeout' }] },
        ]);
        expect(screen.getByText(/batch #3/i)).toBeInTheDocument();
        expect(screen.getByText('PAST 4 HOURS — TOSS IT')).toBeInTheDocument();
        expect(screen.getByText(/1 batch is past 4 hours/)).toBeInTheDocument();
        // The open batch still offers Used + In fridge; the expired one only Tossed.
        expect(screen.getAllByText('Used')).toHaveLength(1);
        expect(screen.getAllByText('In fridge')).toHaveLength(1);
        expect(screen.getAllByText('Tossed')).toHaveLength(2);
        expect(screen.getByText(/Sticker didn't print/)).toBeInTheDocument();
    });

    it('records the fridge temperature and the toss reason', async () => {
        render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
        await feed([
            { id: 'b', batchNo: 2, cookDay: '2026-11-02', location: 'webster', status: 'cooling', cookedBy: 'Rubisel', cookedAt: iso(11, 30), fridgeByAt: iso(13, 30), tossByAt: iso(15, 30), prints: [{ ok: true, copies: 1 }] },
        ]);
        fireEvent.click(screen.getByText('In fridge'));
        fireEvent.change(screen.getByPlaceholderText('Temp °F (optional)'), { target: { value: '66' } });
        await act(async () => { fireEvent.click(screen.getByText(/Save/)); });
        expect(updateDocMock).toHaveBeenCalledTimes(1);
        expect(updateDocMock.mock.calls[0][1]).toMatchObject({ status: 'fridge', fridgedBy: 'Laura Hurtado', fridgeTempF: 66 });
    });

    it('refuses to sticker a batch that finished cooking over 4 hours ago', async () => {
        render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
        await feed([]);
        fireEvent.change(screen.getByLabelText('Finished at'), { target: { value: '08:00' } });
        expect(screen.getByText(/already past the 4-hour limit/)).toBeInTheDocument();
        expect(screen.getByText(/Print sticker \+ log batch/).closest('button')).toBeDisabled();
    });

    it('waits for today\'s batches before it will number and print a new one', async () => {
        render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
        expect(screen.getByText(/batch #…/i)).toBeInTheDocument();
        expect(screen.getByText(/Print sticker \+ log batch/).closest('button')).toBeDisabled();
        await feed([]);
        expect(screen.getByText(/Print sticker \+ log batch/).closest('button')).not.toBeDisabled();
    });

    it('a failed load of today\'s batches still lets the cook log the batch, with a repeat-number warning', async () => {
        render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
        await act(async () => { errCbs[1](new Error('offline')); });
        expect(screen.getByText(/batch number may repeat/)).toBeInTheDocument();
        expect(screen.getByText(/Print sticker \+ log batch/).closest('button')).not.toBeDisabled();
    });

    it('a slow first load stops blocking after a few seconds (first batch of the day on weak Wi-Fi)', async () => {
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        vi.setSystemTime(NOW);
        render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
        expect(screen.getByText(/Print sticker \+ log batch/).closest('button')).toBeDisabled();
        expect(screen.getByText(/Loading today's batches/)).toBeInTheDocument();
        await act(async () => { vi.advanceTimersByTime(50); });     // let React run the mount effects
        await act(async () => { vi.advanceTimersByTime(5100); });
        expect(screen.getByText(/Print sticker \+ log batch/).closest('button')).not.toBeDisabled();
        expect(screen.getByText(/batch number may repeat/)).toBeInTheDocument();
    });

    it('a write still waiting on one batch never blocks another batch', async () => {
        updateDocMock.mockImplementationOnce(() => new Promise(() => {}));   // offline: never acked
        render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
        await feed([
            { id: 'a', batchNo: 1, cookDay: '2026-11-02', location: 'webster', status: 'cooling', cookedBy: 'R', cookedAt: iso(8, 30), fridgeByAt: iso(10, 30), tossByAt: iso(12, 30), prints: [] },
            { id: 'b', batchNo: 2, cookDay: '2026-11-02', location: 'webster', status: 'cooling', cookedBy: 'R', cookedAt: iso(11, 30), fridgeByAt: iso(13, 30), tossByAt: iso(15, 30), prints: [] },
        ]);
        await act(async () => { fireEvent.click(screen.getByText('Used')); });          // batch #2 — hangs
        const tossed = screen.getAllByText('Tossed');
        await act(async () => { fireEvent.click(tossed[tossed.length - 1]); });          // batch #1 — must still go
        expect(updateDocMock).toHaveBeenCalledTimes(2);
        expect(updateDocMock.mock.calls[1][1]).toMatchObject({ status: 'tossed', tossReason: 'past_4h' });
    });

    it('a batch left open on an earlier day can still be closed out', async () => {
        render(<RiceLogPanel location="webster" staffName="Laura Hurtado" language="en" onClose={() => {}} />);
        await feed([]);
        const before = snapCbs.length;
        await act(async () => { fireEvent.change(screen.getByDisplayValue('2026-11-02'), { target: { value: '2026-11-01' } }); });
        const dayCb = snapCbs[before];
        const y = (h, m) => new Date(2026, 10, 1, h, m).toISOString();
        await act(async () => {
            dayCb({ forEach: (fn) => [{ id: 'old', batchNo: 7, cookDay: '2026-11-01', location: 'webster', status: 'cooling', cookedBy: 'R', cookedAt: y(18, 30), fridgeByAt: y(20, 30), tossByAt: y(22, 30), prints: [] }]
                .forEach((r) => fn({ id: r.id, data: () => r })) });
        });
        expect(screen.getByText(/Left open/)).toBeInTheDocument();
        expect(screen.queryByText('Used')).toBe(null);
        // A batch left out overnight can't be voided as a misprint.
        expect(screen.queryByText(/printed by mistake/i)).toBe(null);
        await act(async () => { fireEvent.click(screen.getByText('Tossed')); });
        expect(updateDocMock.mock.calls.at(-1)[1]).toMatchObject({ status: 'tossed', tossReason: 'past_4h', tossedBy: 'Laura Hurtado' });
    });

    it('renders in Spanish', async () => {
        render(<RiceLogPanel location="maryland" staffName="Laura Hurtado" language="es" onClose={() => {}} />);
        await feed([]);
        expect(screen.getByText('Registro de Arroz para Arroz Frito')).toBeInTheDocument();
        expect(screen.getByText(/Imprimir etiqueta \+ registrar lote/)).toBeInTheDocument();
    });
});
