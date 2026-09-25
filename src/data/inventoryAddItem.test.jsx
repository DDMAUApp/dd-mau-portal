// Inventory ADD-ITEM regression (2026-09-25) — harness copied from the
// Operations inventory mount test.
// Mount smoke test for the Operations inventory page (2026-09-23 inventory
// bug batch). Operations.jsx is one ~11.8k-line component whose hooks all live
// in one body — a hook that reads state declared BELOW it crashes the page on
// EVERY mount (TDZ, the 2026-07-01 outage) and the build does not catch it.
// This mounts the real component with Firebase I/O mocked (no network, no
// writes), opens the Inventory tab, and drives the inventory listeners:
//   • first paint + the Location view (memoized grouping + jump bar)
//   • M1 — an active list takes over, and DEACTIVATING it restores the catalog
//   • M2 — a server-confirmed empty snapshot (cart emptied by "−" on another
//          device) is applied; an empty cache echo is still ignored.
//   • C3 — editing from the Vendor view keeps the item's min + location
//   • C1 — a cross-category move writes a NEW id, moves the count with dotted
//          paths and tombstones the built-in (one transaction)
//   • C2 — deleting a built-in tombstones it + clears its count
// Transactions run against an in-memory "live doc"; nothing leaves the test.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';

const listeners = new Map();   // path -> [cb]
const txnCalls = [];
const fake = { liveDoc: null, writes: [] };
vi.mock('../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => {
    const pathOf = (x) => (x && x.path) || 'unknown';
    return {
        doc: vi.fn((base, ...segs) => ({ path: segs.length ? segs.join('/') : `${pathOf(base)}/auto` })),
        collection: vi.fn((_db, ...segs) => ({ path: segs.join('/') })),
        query: vi.fn((c) => ({ path: pathOf(c) })),
        where: vi.fn(() => ({})), orderBy: vi.fn(() => ({})), limit: vi.fn(() => ({})),
        onSnapshot: vi.fn((ref, a, b) => {
            const cb = typeof a === 'function' ? a : b;
            const p = pathOf(ref);
            if (!listeners.has(p)) listeners.set(p, []);
            listeners.get(p).push(cb);
            return () => { const arr = listeners.get(p) || []; const i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1); };
        }),
        setDoc: vi.fn(async () => {}),
        updateDoc: vi.fn(async () => {}),
        addDoc: vi.fn(async () => ({ id: 'x' })),
        getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}), metadata: { fromCache: false } })),
        getDocs: vi.fn(async () => ({ docs: [], empty: true, size: 0, forEach: () => {}, metadata: { fromCache: false } })),
        getDocsFromServer: vi.fn(async () => ({ docs: [], empty: true, size: 0, forEach: () => {}, metadata: { fromCache: false } })),
        getDocFromServer: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
        getDocFromCache: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
        disableNetwork: vi.fn(async () => {}), enableNetwork: vi.fn(async () => {}),
        runTransaction: vi.fn(async (_db, fn) => {
            txnCalls.push(fn);
            const txn = {
                get: async () => ({ exists: () => fake.liveDoc != null, data: () => fake.liveDoc }),
                update: (ref, data) => fake.writes.push({ op: 'update', path: ref.path, data }),
                set: (ref, data, opts) => fake.writes.push({ op: 'set', path: ref.path, data, opts }),
            };
            return fn(txn);
        }),
        writeBatch: vi.fn(() => ({ set: vi.fn(), update: vi.fn(), delete: vi.fn(), commit: vi.fn(async () => {}) })),
        deleteField: vi.fn(() => ({ __op: 'delete' })),
        arrayUnion: vi.fn((...v) => ({ __op: 'union', v })),
        increment: vi.fn((n) => ({ __op: 'inc', n })),
        serverTimestamp: vi.fn(() => ({ __op: 'ts' })),
        Timestamp: { now: () => ({ toDate: () => new Date() }), fromDate: (d) => ({ toDate: () => d }) },
        FieldPath: class FieldPath { constructor(...p) { this.p = p; } },
    };
});
vi.mock('firebase/storage', () => ({
    ref: vi.fn(), getDownloadURL: vi.fn(), uploadBytes: vi.fn(), deleteObject: vi.fn(), uploadBytesResumable: vi.fn(),
}));
vi.mock('../data/firestoreRevive', async (importOriginal) => ({
    ...(await importOriginal()),
    watchdogWrite: (p) => p, watchdogRead: (p) => p, watchdogTransaction: (p) => p,
}));
vi.mock('../v2/AppDataContext', () => ({ useAppData: () => ({ labor: null }) }));
vi.mock('../data/aiSearch', () => ({ useAiSearch: () => ({ loading: false, matchingIds: null, error: null }) }));
vi.mock('../components/ItemPriceModal', () => ({ default: () => null }));
vi.mock('../components/PricingWorkspace', () => ({ default: () => null }));
vi.mock('../components/SauceLogBohBanner', () => ({ default: () => null }));
vi.mock('../components/CartPlanView', () => ({ default: () => null }));
// Run the 5 s undo-toast action immediately so delete can be asserted.
vi.mock('../toast', async (importOriginal) => ({
    ...(await importOriginal()),
    undoToast: vi.fn((_msg, commit) => { commit(); return 'undo-id'; }),
}));

import Operations from '../components/Operations';
import { INVENTORY_CATEGORIES } from './inventory';

const snap = (data, { fromCache = false, hasPendingWrites = false } = {}) => ({
    exists: () => data != null,
    data: () => data,
    metadata: { fromCache, hasPendingWrites },
});
const fire = (path, s) => { for (const cb of (listeners.get(path) || [])) cb(s); };

const firstItem = INVENTORY_CATEGORIES[0].items[0];
const savedCatalog = INVENTORY_CATEGORIES.map(c => ({ name: c.name, items: c.items.map(i => ({ ...i })) }));

beforeEach(() => { txnCalls.length = 0; fake.liveDoc = null; fake.writes = []; });

const mount = async () => {
    render(
        <Operations
            language="en"
            staffName="Owner Test"
            storeLocation="webster"
            staffList={[{ id: 40, name: 'Owner Test', role: 'Owner', location: 'webster', opsAccess: true }]}
        />,
    );
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Inventory/ })[0]); });
};
// The row that shows `name` → its Edit button.
const openEditFor = async (name) => {
    const row = screen.getAllByText(name)[0].closest('.px-3');
    await act(async () => { fireEvent.click(within(row).getByText(/Edit/)); });
    const form = screen.getByDisplayValue(name).closest('.space-y-2');
    return form;
};
const lastInvUpdate = () => [...fake.writes].reverse().find(w => w.path === 'ops/inventory_webster' && w.op === 'update');


import * as fsMock from 'firebase/firestore';

describe('Inventory add item (Andrew 2026-09-25 "adding items not working")', () => {
    const docFor = () => ({ counts: {}, countMeta: {}, vendorCounts: {}, customInventory: INVENTORY_CATEGORIES.map(c => ({ name: c.name, items: c.items.map(i => ({ ...i })) })), deletedMasterIds: [] });
    const lastSet = () => [...fake.writes].reverse().find(w => w.path === 'ops/inventory_webster' && w.op === 'set');
    const locInput = () => screen.getAllByPlaceholderText(/Add item to/)[0];
    const addBtnFor = (input) => within(input.closest('.space-y-2')).getByRole('button', { name: /Add|Adding/ });

    it('Location view: success saves, clears the box, confirms', async () => {
        fake.liveDoc = docFor();
        await mount();
        await act(async () => { fire('ops/inventory_webster', snap(fake.liveDoc)); });
        fireEvent.change(locInput(), { target: { value: 'Zz Brand New Thing' } });
        await act(async () => { fireEvent.click(addBtnFor(locInput())); });
        const saved = lastSet().data.customInventory.flatMap(c => c.items).filter(i => i.name === 'Zz Brand New Thing');
        expect(saved).toHaveLength(1);
        expect(locInput().value).toBe('');
    });

    it('a hanging save keeps the typed name and shows "Adding…" (was: box cleared, nothing saved, no message)', async () => {
        fake.liveDoc = docFor();
        await mount();
        await act(async () => { fire('ops/inventory_webster', snap(fake.liveDoc)); });
        let release;
        fsMock.runTransaction.mockImplementationOnce(() => new Promise((r) => { release = r; }));
        fireEvent.change(locInput(), { target: { value: 'Zz Slow Thing' } });
        await act(async () => { fireEvent.click(addBtnFor(locInput())); });
        expect(locInput().value).toBe('Zz Slow Thing');
        expect(addBtnFor(locInput()).textContent).toMatch(/Adding/);
        expect(addBtnFor(locInput()).disabled).toBe(true);
        await act(async () => { release({ updated: docFor().customInventory, tombstones: [] }); });
        expect(locInput().value).toBe('');
    });

    it('a failed save keeps the typed name so nothing is lost', async () => {
        fake.liveDoc = docFor();
        await mount();
        await act(async () => { fire('ops/inventory_webster', snap(fake.liveDoc)); });
        fsMock.runTransaction.mockImplementationOnce(async () => { throw new Error('unavailable'); });
        fireEvent.change(locInput(), { target: { value: 'Zz Fail Thing' } });
        await act(async () => { fireEvent.click(addBtnFor(locInput())); });
        expect(locInput().value).toBe('Zz Fail Thing');
    });

    it('Master List write-in: success saves + clears; failure keeps the text', async () => {
        fake.liveDoc = docFor();
        await mount();
        await act(async () => { fire('ops/inventory_webster', snap(fake.liveDoc)); });
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '📋 Master List' })[0]); });
        const input = () => screen.getAllByPlaceholderText(/Write in item/)[0];
        const pickLoc = () => { const sel = input().closest('.space-y-2').querySelectorAll('select')[1]; fireEvent.change(sel, { target: { value: sel.options[1].value } }); };
        fsMock.runTransaction.mockImplementationOnce(async () => { throw new Error('unavailable'); });
        fireEvent.change(input(), { target: { value: 'Zz Master Fail' } });
        pickLoc();
        await act(async () => { fireEvent.click(addBtnFor(input())); });
        expect(input().value).toBe('Zz Master Fail');
        await act(async () => { fireEvent.click(addBtnFor(input())); });
        expect(lastSet().data.customInventory.flatMap(c => c.items).some(i => i.name === 'Zz Master Fail')).toBe(true);
        expect(input().value).toBe('');
    });
});
