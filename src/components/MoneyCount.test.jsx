// Money Count — live-draft persistence regression test (2026-07-14).
// Reproduces Andrew's report: "if i click out of the screen the money count
// resets." Mounts the real component, types a count, UNMOUNTS (what a tab
// switch does), remounts, and asserts the count is still there.
import { render, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock only the Firebase-touching data functions; keep the real pure helpers
// (COIN_DENOMS, totalCents, fmtMoney, centralDate, normalizeLocation, …).
vi.mock('../data/moneyCount', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        subscribeMoneyCounts: () => () => {},
        subscribeTodayCounts: () => () => {},
        saveMoneyCount: vi.fn(async () => 'id'),
        saveCashTips: vi.fn(),
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
