// Money Count — live-draft persistence regression test (2026-07-14).
// Reproduces Andrew's report: "if i click out of the screen the money count
// resets." Mounts the real component, types a count, UNMOUNTS (what a tab
// switch does), remounts, and asserts the count is still there.
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock only the Firebase-touching data functions; keep the real pure helpers
// (COIN_DENOMS, totalCents, fmtMoney, centralDate, normalizeLocation, …).
const h = vi.hoisted(() => ({ todayCb: null, saveCashTips: null }));
vi.mock('../data/moneyCount', async (importOriginal) => {
    const actual = await importOriginal();
    h.saveCashTips = vi.fn(async () => 'id');
    return {
        ...actual,
        subscribeMoneyCounts: () => () => {},
        subscribeTodayCounts: (date, cb) => { h.todayCb = cb; return () => {}; },
        saveMoneyCount: vi.fn(async () => 'id'),
        saveCashTips: (...a) => h.saveCashTips(...a),
        getCashTipsRange: vi.fn(async () => []),
        editCashTips: vi.fn(),
        deleteMoneyCount: vi.fn(),
        setMoneyCountNote: vi.fn(),
    };
});
vi.mock('../toast', () => ({ toast: vi.fn() }));
vi.mock('../data/audit', () => ({ recordAudit: vi.fn() }));
vi.mock('../data/staff', () => ({ LOCATION_LABELS: { webster: 'Webster', maryland: 'Maryland Heights' } }));

import MoneyCount from './MoneyCount';

const props = { language: 'en', storeLocation: 'webster', staffName: 'Tester', staffList: [{ name: 'Tester', id: 1 }], staffId: 1 };

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); });

describe('MoneyCount live draft', () => {
    it('keeps the in-progress count after leaving and returning to the screen', () => {
        const first = render(<MoneyCount {...props} />);
        fireEvent.change(first.getByLabelText(/25¢ count/i), { target: { value: '3' } });
        fireEvent.change(first.getByLabelText(/\$20 count/i), { target: { value: '5' } });
        // Persisted synchronously as typed.
        expect(JSON.parse(localStorage.getItem('ddmau:moneydraft:webster'))).toMatchObject({ '25': '3', '2000': '5' });

        first.unmount();               // ← "click out of the screen"

        const second = render(<MoneyCount {...props} />);   // ← come back
        expect(second.getByLabelText(/25¢ count/i).value).toBe('3');
        expect(second.getByLabelText(/\$20 count/i).value).toBe('5');
    });

    it('clears the draft on Clear', () => {
        const r = render(<MoneyCount {...props} />);
        fireEvent.change(r.getByLabelText(/25¢ count/i), { target: { value: '3' } });
        fireEvent.click(r.getByText(/^Clear$/i));
        expect(localStorage.getItem('ddmau:moneydraft:webster')).toBeNull();
    });

    it('keeps separate drafts per store', () => {
        localStorage.setItem('ddmau:moneydraft:maryland', JSON.stringify({ '100': '7' }));
        const r = render(<MoneyCount {...props} />);
        // Webster view starts empty; Maryland draft untouched.
        expect(r.getByLabelText(/\$1 count/i).value).toBe('');
        expect(JSON.parse(localStorage.getItem('ddmau:moneydraft:maryland'))).toMatchObject({ '100': '7' });
    });
});

// 2026-08-29 (Andrew): "when i was entering the tip count it just got stuck
// on saving and never saved" — the Save-tips button must never spin forever,
// and the typed amount must survive a recovery reload.
describe('MoneyCount tip save', () => {
    it('a tip save that hangs clears its busy flag at the deadline and shows an error', async () => {
        vi.useFakeTimers();
        try {
            h.saveCashTips.mockReturnValue(new Promise(() => {}));   // hangs forever
            const { toast } = await import('../toast');
            const r = render(<MoneyCount {...props} />);
            fireEvent.change(r.getByPlaceholderText('0.00'), { target: { value: '55' } });
            fireEvent.click(r.getByText(/Save tips/i));
            expect(r.getByText(/Saving…/i)).toBeTruthy();
            await act(async () => { await vi.advanceTimersByTimeAsync(26_000); });
            expect(r.getByText(/Save tips/i)).toBeTruthy();          // busy flag cleared
            expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Could not save tips/i), { kind: 'error' });
        } finally { vi.useRealTimers(); }
    });

    it('the in-progress tip amount survives an unmount/remount (reload recovery)', () => {
        const first = render(<MoneyCount {...props} />);
        fireEvent.change(first.getByPlaceholderText('0.00'), { target: { value: '42.50' } });
        first.unmount();
        const second = render(<MoneyCount {...props} />);
        expect(second.getByPlaceholderText('0.00').value).toBe('42.50');
    });

    it('a successful save clears the tip draft', async () => {
        h.saveCashTips.mockResolvedValue('id');
        const r = render(<MoneyCount {...props} />);
        fireEvent.change(r.getByPlaceholderText('0.00'), { target: { value: '10' } });
        expect(localStorage.getItem('ddmau:tipdraft:webster')).toBeTruthy();
        fireEvent.click(r.getByText(/Save tips/i));
        await act(async () => {});   // flush the save promise
        expect(localStorage.getItem('ddmau:tipdraft:webster')).toBeNull();
    });
});

// 2026-08-29 (Andrew): "i add the count i need to see the current count show
// up at the bottom with the morning count."
describe('MoneyCount today summary strip', () => {
    it('shows Morning, Current, and the Change between them', () => {
        const r = render(<MoneyCount {...props} />);
        act(() => h.todayCb([
            { id: 'a', location: 'webster', totalCents: 20000, createdMs: 1000, counts: {} },
            { id: 'b', location: 'webster', totalCents: 15000, createdMs: 2000, counts: {} },
        ]));
        expect(r.getByText(/Morning/)).toBeTruthy();
        expect(r.getByText(/Current/)).toBeTruthy();
        // Each total renders in its list row AND the strip (strip = 2nd copy).
        expect(r.getAllByText('$200.00').length).toBeGreaterThanOrEqual(2);
        expect(r.getAllByText('$150.00').length).toBeGreaterThanOrEqual(2);
        expect(r.getByText('-$50.00')).toBeTruthy();   // drawer down → negative change
    });

    it('a single count shows only the Morning line', () => {
        const r = render(<MoneyCount {...props} />);
        act(() => h.todayCb([
            { id: 'a', location: 'webster', totalCents: 20000, createdMs: 1000, counts: {} },
        ]));
        expect(r.getByText(/Morning/)).toBeTruthy();
        expect(r.queryByText(/Current/)).toBeNull();
        expect(r.queryByText(/Change/)).toBeNull();
    });
});
