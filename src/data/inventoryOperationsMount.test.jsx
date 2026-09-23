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

describe('Operations inventory — mounts and survives the listener paths', () => {
    it('renders the Location view, M1 list deactivation, M2 remote empty', async () => {
        render(
            <Operations
                language="en"
                staffName="Owner Test"
                storeLocation="webster"
                staffList={[{ id: 40, name: 'Owner Test', role: 'Owner', location: 'webster', opsAccess: true }]}
            />,
        );
        // Open the Inventory sub-tab.
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Inventory/ })[0]); });
        expect(listeners.get('ops/inventory_webster')?.length).toBeGreaterThan(0);

        // First server snapshot: one counted item.
        await act(async () => {
            fire('ops/inventory_webster', snap({ counts: { [firstItem.id]: 3 }, countMeta: {}, vendorCounts: {}, customInventory: savedCatalog, deletedMasterIds: [] }));
        });
        expect(screen.getAllByText(firstItem.name).length).toBeGreaterThan(0);
        expect(screen.getAllByDisplayValue('3').length).toBeGreaterThan(0);

        // M1 — an active list overrides the catalog…
        await act(async () => {
            fire('inventory_lists', { empty: false, docs: [{ id: 'L1', data: () => ({ status: 'active', categories: [{ name: 'Only List', items: [{ id: 'zz-1', name: 'Zebra Test Item', location: 'Pantry' }] }] }) }] });
        });
        expect(screen.getAllByText('Zebra Test Item').length).toBeGreaterThan(0);
        expect(screen.queryAllByText(firstItem.name).length).toBe(0);
        // …and deactivating it puts the catalog back (it used to stick).
        await act(async () => { fire('inventory_lists', { empty: true, docs: [] }); });
        expect(screen.queryAllByText('Zebra Test Item').length).toBe(0);
        expect(screen.getAllByText(firstItem.name).length).toBeGreaterThan(0);

        // M2 — an empty CACHE echo is still ignored…
        await act(async () => {
            fire('ops/inventory_webster', snap({ counts: {}, countMeta: {}, vendorCounts: {}, customInventory: savedCatalog, deletedMasterIds: [] }, { fromCache: true }));
        });
        expect(screen.getAllByDisplayValue('3').length).toBeGreaterThan(0);
        // …but a server-confirmed empty snapshot (another device emptied the
        // cart with "−") is applied.
        await act(async () => {
            fire('ops/inventory_webster', snap({ counts: {}, countMeta: {}, vendorCounts: {}, customInventory: savedCatalog, deletedMasterIds: [] }));
        });
        expect(screen.queryAllByDisplayValue('3').length).toBe(0);

        // No catalog migration was needed for a clean catalog.
        expect(txnCalls.length).toBe(0);
    });
});

describe('Operations inventory — catalog edits (fake transaction)', () => {
    const cat0 = INVENTORY_CATEGORIES[0];
    const A = cat0.items[0], B = cat0.items[1], C = cat0.items[2];
    const catalogWith = () => {
        const c = INVENTORY_CATEGORIES.map(cat => ({ name: cat.name, items: cat.items.map(i => ({ ...i })) }));
        c[0].items[0] = { ...c[0].items[0], min: 5, location: 'Pantry' };
        return c;
    };
    const docWith = () => ({
        counts: { [B.id]: 4, [C.id]: 1 }, countMeta: { [B.id]: { by: 'Staff X', at: '9:00' } }, vendorCounts: {},
        customInventory: catalogWith(), deletedMasterIds: [],
    });

    it('C3 — Vendor-view edit keeps min + location', async () => {
        fake.liveDoc = docWith();
        await mount();
        await act(async () => { fire('ops/inventory_webster', snap(fake.liveDoc)); });
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Vendor' })[0]); });
        const form = await openEditFor(A.name);
        fireEvent.change(within(form).getByDisplayValue(A.name), { target: { value: 'Renamed A' } });
        await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save' })); });
        const w = lastInvUpdate();
        expect(w).toBeTruthy();
        const saved = w.data.customInventory.flatMap(c => c.items).find(i => i.id === A.id);
        expect(saved).toMatchObject({ name: 'Renamed A', min: 5, location: 'Pantry' });
    });

    it('C1 — Master List move: new id, count follows, built-in tombstoned', async () => {
        fake.liveDoc = docWith();
        await mount();
        await act(async () => { fire('ops/inventory_webster', snap(fake.liveDoc)); });
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '📋 Master List' })[0]); });
        const form = await openEditFor(B.name);
        fireEvent.change(within(form).getByLabelText('Move to'), { target: { value: '1|' } });
        await act(async () => { fireEvent.click(within(form).getByRole('button', { name: 'Save' })); });
        const w = lastInvUpdate();
        expect(w).toBeTruthy();
        const dest = w.data.customInventory.find(c => c.name === INVENTORY_CATEGORIES[1].name);
        const moved = dest.items.find(i => i.name === B.name);
        expect(moved).toBeTruthy();
        expect(moved.id).not.toBe(B.id);
        expect(moved.id.startsWith('1-')).toBe(true);
        expect(INVENTORY_CATEGORIES.flatMap(c => c.items).some(i => i.id === moved.id)).toBe(false);
        expect(w.data.customInventory[0].items.some(i => i.id === B.id)).toBe(false);
        expect(w.data[`counts.${moved.id}`]).toBe(4);
        expect(w.data[`counts.${B.id}`]).toEqual({ __op: 'delete' });
        expect(w.data[`countMeta.${moved.id}`]).toEqual({ by: 'Staff X', at: '9:00' });
        expect(w.data.deletedMasterIds).toEqual({ __op: 'union', v: [B.id] });
        // No whole-map writes.
        expect(w.data.counts).toBeUndefined();
        expect(w.data.countMeta).toBeUndefined();
    });

    it('C2 — deleting a built-in tombstones it and clears its count', async () => {
        fake.liveDoc = docWith();
        await mount();
        await act(async () => { fire('ops/inventory_webster', snap(fake.liveDoc)); });
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '📋 Master List' })[0]); });
        const form = await openEditFor(C.name);
        await act(async () => { fireEvent.click(within(form).getByRole('button', { name: /Delete item/ })); });
        const w = lastInvUpdate();
        expect(w).toBeTruthy();
        expect(w.data.customInventory.flatMap(c => c.items).some(i => i.id === C.id)).toBe(false);
        expect(w.data.deletedMasterIds).toEqual({ __op: 'union', v: [C.id] });
        expect(w.data[`counts.${C.id}`]).toEqual({ __op: 'delete' });
    });
});
