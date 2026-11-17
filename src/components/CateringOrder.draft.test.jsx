// Catering order form survives a reload (2026-11-17 — Yulissa's order was
// lost three times when the Maryland iPad's connection wedged and the app
// auto-reloaded). Real component, Firebase mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const h = vi.hoisted(() => ({ sets: [], autoId: 0 }));
vi.mock('../firebase', () => ({ db: {}, functions: {} }));
vi.mock('firebase/firestore', () => ({
    doc: (base, ...segs) => {
        if (!segs.length) { h.autoId += 1; return { id: `auto${h.autoId}`, path: `${base.path}/auto${h.autoId}` }; }
        return { id: segs[segs.length - 1], path: [base?.path, ...segs].filter(Boolean).join('/') };
    },
    collection: (_db, p) => ({ path: p }),
    onSnapshot: (_ref, _cb) => () => {},
    query: (c) => c, orderBy: () => ({}), limit: () => ({}),
    setDoc: vi.fn(async (ref, data, opts) => { h.sets.push({ path: ref.path, data, opts }); }),
    updateDoc: vi.fn(async () => {}), arrayUnion: vi.fn(), deleteField: vi.fn(),
}));
vi.mock('firebase/functions', () => ({ httpsCallable: () => async () => ({ data: {} }) }));
vi.mock('../data/firestoreRevive', () => ({ watchdogWrite: (p) => p }));
vi.mock('../data/notify', () => ({ notifyManagement: vi.fn(async () => {}), notifyStaff: vi.fn(async () => {}) }));
vi.mock('./ToastInvoices', () => ({ default: () => null }));
vi.mock('./ToastOrders', () => ({ default: () => null }));
vi.mock('../toast', () => ({ toast: vi.fn() }));

import CateringOrder from './CateringOrder';

const KEY = 'ddmau:cateringDraft:yulissa hurtado';
beforeEach(() => { localStorage.clear(); h.sets.length = 0; h.autoId = 0; });

describe('catering order draft', () => {
    it('typed customer info comes back after a reload', async () => {
        vi.useFakeTimers();
        const first = render(<CateringOrder language="en" staffName="Yulissa Hurtado" storeLocation="maryland" />);
        fireEvent.click(screen.getByText(/Catering$/));
        fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Acme Office Lunch' } });
        fireEvent.change(screen.getByPlaceholderText('(314) 555-1234'), { target: { value: '3145550000' } });
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(JSON.parse(localStorage.getItem(KEY)).customer.name).toBe('Acme Office Lunch');
        first.unmount();                                     // "reload"
        render(<CateringOrder language="en" staffName="Yulissa Hurtado" storeLocation="maryland" />);
        expect(screen.getByText(/Your unfinished order was restored/)).toBeTruthy();
        expect(screen.getByPlaceholderText('Full name').value).toBe('Acme Office Lunch');
        vi.useRealTimers();
    });

    it('a restored order saves under its pre-picked id (a retry can never duplicate it) and clears the draft', async () => {
        localStorage.setItem(KEY, JSON.stringify({
            savedAt: Date.now(), step: 3, newOrderId: 'keepThisId',
            customer: { name: 'Acme', phone: '314', email: 'a@b.co', date: '2099-01-05', time: '11:30', guests: '20', orderType: 'pickup', pickupLocation: 'maryland' },
            cart: [{ id: 1, name: 'Spring Rolls', price: 50, qty: 2 }],
        }));
        render(<CateringOrder language="en" staffName="Yulissa Hurtado" storeLocation="maryland" />);
        const submit = screen.getByText(/Submit/i, { selector: 'button' });
        await act(async () => { fireEvent.click(submit); });
        // Outside-the-rules confirmation may appear first — go ahead.
        const goAhead = screen.queryByText(/Yes, save|Save anyway|Submit anyway|Continue/i, { selector: 'button' });
        if (goAhead) await act(async () => { fireEvent.click(goAhead); });
        const saved = h.sets.find(s => s.path === 'cateringOrders/keepThisId');
        expect(saved, JSON.stringify(h.sets.map(s => s.path))).toBeTruthy();
        expect(saved.data.customer.name).toBe('Acme');
        expect(localStorage.getItem(KEY)).toBeNull();
    });
});
