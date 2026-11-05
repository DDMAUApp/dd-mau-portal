// Release B, on the real Operations page: loading gate, keep the place, add item.
// Harness copied from inventoryAddItem.test.jsx. Firebase I/O is mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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


import * as fsMock from 'firebase/firestore';
import { readInventoryPlace, saveInventoryPlace, __resetPlaceMemoryForTests } from './placeMemory';
import { runReloadStashes, peekReloadStash } from './reloadStash';
import { readParkedReports } from './pendingReports';

// The whole 12k-line page mounts in every test, and the Master List paths are slow under suite load.
vi.setConfig({ testTimeout: 30000 });

const INV = 'ops/inventory_webster';
const flagOn = () => localStorage.setItem('ddmau:relFlags', JSON.stringify({ flags: { placeRestore: true } }));
const staffList = [{ id: 77, name: 'Laura', role: 'Prep', location: 'webster', opsAccess: true }];
const liveDoc = (extra = {}) => ({
    counts: {}, countMeta: {}, vendorCounts: {}, deletedMasterIds: [],
    customInventory: INVENTORY_CATEGORIES.map(c => ({ name: c.name, items: c.items.map(i => ({ ...i })) })),
    ...extra,
});
const stashKey = 'ddmau:reloadStash:inventory';
const putStash = (data, reason = 'write-stuck') => sessionStorage.setItem(stashKey, JSON.stringify({ v: 1, key: 'inventory', reason, at: Date.now(), data }));

const ui = (props = {}) => (
    <Operations language="en" staffName="Laura" storeLocation="webster" staffList={staffList} {...props} />
);
const openInventory = async () => {
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Inventory/ })[0]); });
};
const mountOnInventory = async (props) => {
    const r = render(ui(props));
    await openInventory();
    return r;
};
// Every control that writes to the sheet, however it's labelled.
const writeControls = () => screen.queryAllByRole('button', { name: /^[−+-]$|Save & Reset|Clear|Empty|^Add$|Adding/ })
    .filter((b) => !b.disabled);
const countInputs = () => document.querySelectorAll('input[type="number"], input[inputmode="numeric"]');

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetPlaceMemoryForTests();
    listeners.clear();
    txnCalls.length = 0;
    fake.liveDoc = null;
    fake.writes = [];
    fsMock.runTransaction.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('flag off: today\'s page', () => {
    it('shows rows and controls before any snapshot, and saves no place', async () => {
        await mountOnInventory();
        expect(screen.queryByTestId('sheet-loading')).toBe(null);
        expect(screen.getAllByPlaceholderText(/Add item to/).length).toBeGreaterThan(0);
        await act(async () => { await new Promise(r => setTimeout(r, 600)); });
        expect(readInventoryPlace('Laura', 'webster')).toBe(null);
    });
    it('ignores a saved place', async () => {
        saveInventoryPlace('Laura', 'webster', { subTab: 'inventory', invSearch: 'egg' });
        render(ui());
        expect(screen.queryByDisplayValue('egg')).toBe(null);
        expect(screen.queryByPlaceholderText(/Add item to/)).toBe(null); // still on Tasks
    });
    it('an add gets no deadline, no audit row and no duplicate check', async () => {
        fake.liveDoc = liveDoc();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        const input = screen.getAllByPlaceholderText(/Add item to/)[0];
        await act(async () => { fireEvent.change(input, { target: { value: 'Brand New Thing' } }); });
        const btn = within(input.closest('.space-y-2')).getByRole('button', { name: /Add/ });
        await act(async () => { fireEvent.click(btn); });
        expect(fake.writes.filter(w => w.path.startsWith('inventory_audits'))).toHaveLength(0);
        expect(readParkedReports()).toHaveLength(0);
    });
});

describe('loading gate, flag on', () => {
    beforeEach(flagOn);

    it('restored session + no snapshot: no rows, no write path reachable', async () => {
        const updates = fsMock.updateDoc.mock.calls.length;
        await mountOnInventory();
        expect(screen.getByTestId('sheet-loading').textContent).toContain("Loading your sheet. Don't recount yet.");
        expect(screen.queryAllByPlaceholderText(/Add item to/)).toHaveLength(0);
        expect(writeControls()).toHaveLength(0);
        expect(countInputs()).toHaveLength(0);
        expect(screen.queryByText(/Save & Reset/)).toBe(null);
        expect(fsMock.updateDoc.mock.calls.length).toBe(updates);
        expect(fsMock.runTransaction).not.toHaveBeenCalled();
    });

    it('after 15 s adds the second line and a Home button', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const onGoHome = vi.fn();
        await mountOnInventory({ onGoHome });
        expect(screen.queryByText(/Still loading/)).toBe(null);
        await act(async () => { vi.advanceTimersByTime(15000); });
        expect(screen.getByText('Still loading. If this stays, close the app and reopen it.')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Home' }));
        expect(onGoHome).toHaveBeenCalled();
    });

    it('a cached snapshot opens the sheet; a cache with no copy does not; the server saying none does', async () => {
        await mountOnInventory();
        await act(async () => { fire(INV, snap(null, { fromCache: true })); });
        expect(screen.getByTestId('sheet-loading')).toBeTruthy();
        await act(async () => { fire(INV, snap(null, { fromCache: false })); });
        expect(screen.queryByTestId('sheet-loading')).toBe(null);
        expect(screen.getAllByPlaceholderText(/Add item to/).length).toBeGreaterThan(0);
    });

    it('a cached copy of the document opens it', async () => {
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc({ counts: { [firstItem.id]: 2 } }), { fromCache: true })); });
        expect(screen.queryByTestId('sheet-loading')).toBe(null);
    });

    it('a store switch closes it again', async () => {
        const r = await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        expect(screen.queryByTestId('sheet-loading')).toBe(null);
        await act(async () => { r.rerender(ui({ storeLocation: 'maryland' })); });
        expect(screen.getByTestId('sheet-loading')).toBeTruthy();
        await act(async () => { fire('ops/inventory_maryland', snap(liveDoc())); });
        expect(screen.queryByTestId('sheet-loading')).toBe(null);
    });

    it('no stash from a sheet that never loaded', async () => {
        await mountOnInventory();
        runReloadStashes('write-stuck');
        expect(peekReloadStash('inventory')).toBe(null);
        await act(async () => { fire(INV, snap(liveDoc({ counts: { x: 1 } }))); });
        runReloadStashes('write-stuck');
        expect(peekReloadStash('inventory')).toMatchObject({ staffName: 'Laura', loc: 'webster' });
    });
});

describe('after a stash paint, flag on', () => {
    beforeEach(flagOn);
    const id = firstItem.id;
    const stash = (extra = {}) => ({ loc: 'webster', staffName: 'Laura', counts: { [id]: 4 }, countMeta: {}, vendorCounts: {}, pendingCounts: {}, subTab: 'inventory', clearedAt: null, ...extra });

    it('rows and taps yes; Add, Save & Reset, Clear no, until a real snapshot', async () => {
        putStash(stash());
        await mountOnInventory();
        expect(screen.queryByTestId('sheet-loading')).toBe(null);
        const save = screen.getAllByRole('button', { name: /Save & reset|Save & Reset|Guardar/i });
        expect(save.every(b => b.disabled)).toBe(true);
        expect(screen.getAllByRole('button', { name: /Clear/ }).filter(b => b.title === 'Clear all counts').every(b => b.disabled)).toBe(true);
        // An Enter in an add box is refused and the text stays.
        const input = screen.getAllByPlaceholderText(/Add item to/)[0];
        await act(async () => { fireEvent.change(input, { target: { value: 'Stash Item' } }); });
        await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
        expect(fsMock.runTransaction).not.toHaveBeenCalled();
        expect(input.value).toBe('Stash Item');
        // Cached echoes with this device's pending writes don't count as seeing the sheet.
        await act(async () => { fire(INV, snap(liveDoc({ counts: { [id]: 4 } }), { fromCache: true, hasPendingWrites: true })); });
        expect(screen.getAllByRole('button', { name: /Clear/ }).filter(b => b.title === 'Clear all counts').every(b => b.disabled)).toBe(true);
        await act(async () => { fire(INV, snap(liveDoc({ counts: { [id]: 4 } }))); });
        expect(screen.getAllByRole('button', { name: /Clear/ }).filter(b => b.title === 'Clear all counts').every(b => !b.disabled)).toBe(true);
    });

    it('another person\'s stash is refused: loading, not their numbers', async () => {
        putStash(stash({ staffName: 'Yulissa' }));
        await mountOnInventory();
        expect(screen.getByTestId('sheet-loading')).toBeTruthy();
    });

    it('a server snapshot the empty-cart guard ignores still opens the sheet', async () => {
        putStash(stash());
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        expect(screen.getAllByRole('button', { name: /Clear/ }).filter(b => b.title === 'Clear all counts').every(b => !b.disabled)).toBe(true);
    });
});

describe('keep the place, flag on', () => {
    beforeEach(flagOn);

    it('paints the saved sub-tab first, with every saved field, and no crash (TDZ)', async () => {
        saveInventoryPlace('Laura', 'webster', {
            subTab: 'inventory', invViewMode: 'category', invSearch: 'zz-none', invShowOnlyCounted: true, invShowOnlyLow: true,
            collapsedCats: { 'cat::x': true }, writeInValues: { 0: 'typed' }, writeInDest: { 0: { catIdx: 0, location: 'Walk-in' } },
            locWriteIn: { 'Walk-in': 'typed2' }, locWriteInCat: { 'Walk-in': 1 }, invNewName: 'n', invNewNameEs: 'm', scrollY: 300,
        });
        render(ui());
        // Straight on the sheet without a tap, at the gate rather than on Tasks.
        expect(screen.getByTestId('sheet-loading')).toBeTruthy();
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
        await act(async () => { fire(INV, snap(liveDoc())); });
        expect(screen.getAllByDisplayValue('zz-none').length).toBeGreaterThan(0);
        await act(async () => { await new Promise(r => requestAnimationFrame(r)); });
        expect(scrollTo).toHaveBeenCalledTimes(1);
        expect(scrollTo).toHaveBeenCalledWith(0, 300);
        // Once only.
        await act(async () => { fire(INV, snap(liveDoc({ date: 'later' }))); });
        await act(async () => { await new Promise(r => requestAnimationFrame(r)); });
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('restored folds survive the mount', async () => {
        const catKey = `cat::${INVENTORY_CATEGORIES[0].name}`;
        saveInventoryPlace('Laura', 'webster', { subTab: 'inventory', collapsedCats: { [catKey]: true, 'loc::A': true } });
        const r = render(ui());
        await act(async () => { await new Promise(res => setTimeout(res, 700)); });
        expect(readInventoryPlace('Laura', 'webster').collapsedCats).toEqual({ [catKey]: true, 'loc::A': true });
        r.unmount();
    });

    it('saves changes, on the next tick of the 500 ms saver and on leaving', async () => {
        const r = await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        await act(async () => { fireEvent.change(screen.getAllByPlaceholderText(/Add item to/)[0], { target: { value: 'half typed' } }); });
        r.unmount();
        const saved = readInventoryPlace('Laura', 'webster');
        expect(saved.subTab).toBe('inventory');
        expect(Object.values(saved.locWriteIn)).toContain('half typed');
    });

    it('a different person gets their own record', async () => {
        saveInventoryPlace('Yulissa', 'webster', { subTab: 'inventory', invSearch: 'hers' });
        render(ui());
        expect(screen.queryByDisplayValue('hers')).toBe(null);
        expect(screen.queryByTestId('sheet-loading')).toBe(null); // Laura is on Tasks
    });
});

describe('add item, flag on', () => {
    beforeEach(flagOn);
    const ready = async () => {
        fake.liveDoc = liveDoc();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        fsMock.runTransaction.mockClear();
    };
    const boxes = () => {
        const input = screen.getAllByPlaceholderText(/Add item to/)[0];
        return { input, btn: () => within(input.closest('.space-y-2')).getByRole('button', { name: /Add/ }) };
    };
    const typeIn = async (text) => {
        const { input } = boxes();
        await act(async () => { fireEvent.change(input, { target: { value: text } }); });
        return boxes();
    };
    const addRows = () => readParkedReports().filter(r => r.feature === 'inventory:add');

    it('success writes the item and a kind:add audit row in one transaction', async () => {
        await ready();
        const { btn } = await typeIn('Brand New Thing');
        await act(async () => { fireEvent.click(btn()); });
        const audit = fake.writes.find(w => w.path.startsWith('inventory_audits_webster'));
        expect(audit.data).toMatchObject({ kind: 'add', itemName: 'Brand New Thing', byStaff: 'Laura', delta: 0 });
        expect(addRows()).toHaveLength(0);
    });

    it('offline: fails at once, keeps the text, parks a row, never starts a transaction', async () => {
        await ready();
        const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        const { input, btn } = await typeIn('Offline Thing');
        await act(async () => { fireEvent.click(btn()); });
        expect(fsMock.runTransaction).not.toHaveBeenCalled();
        expect(input.value).toBe('Offline Thing');
        expect(addRows()[0]).toMatchObject({ outcome: 'offline', ageMs: 0, net: { online: false } });
        online.mockRestore();
    });

    it('hang: the 25 s deadline frees the box, keeps the text, parks a row; a late landing mirrors in', async () => {
        await ready();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let land;
        fsMock.runTransaction.mockImplementationOnce(() => new Promise((res) => { land = res; }));
        const { input, btn } = await typeIn('Hung Thing');
        await act(async () => { fireEvent.click(btn()); });
        expect(btn().textContent).toMatch(/Adding/);
        await act(async () => { vi.advanceTimersByTime(25000); });
        expect(btn().textContent).not.toMatch(/Adding/);
        expect(input.value).toBe('Hung Thing');
        expect(addRows()[0]).toMatchObject({ outcome: 'deadline', box: expect.stringContaining('loc:') });
        // The first try lands after all.
        const cat = INVENTORY_CATEGORIES[0];
        const landed = liveDoc().customInventory.map((c) => (c.name === cat.name ? { ...c, items: [...c.items, { id: 'late1', name: 'Hung Thing', nameEs: '', location: 'Walk-in' }] } : c));
        await act(async () => { land({ updated: landed, tombstones: [] }); });
        expect(addRows().map(r => r.outcome)).toEqual(['deadline', 'late-success']);
        expect(input.value).toBe('Hung Thing'); // still theirs to clear
    });

    it('reject: today\'s toast, text stays, parked row', async () => {
        await ready();
        fsMock.runTransaction.mockImplementationOnce(async () => { throw new Error('unavailable'); });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { input, btn } = await typeIn('Rejected Thing');
        await act(async () => { fireEvent.click(btn()); });
        expect(input.value).toBe('Rejected Thing');
        expect(addRows()[0]).toMatchObject({ outcome: 'rejected' });
    });

    // The first try reaches the server, but the answer never gets back to this device.
    const landsButNeverAnswers = () => fsMock.runTransaction.mockImplementationOnce((_db, fn) => {
        fn({
            get: async () => ({ exists: () => true, data: () => fake.liveDoc }),
            set: (ref, data) => { if (ref.path === INV) fake.liveDoc = { ...fake.liveDoc, ...data }; else fake.writes.push({ path: ref.path, data }); },
            update: () => {},
        });
        return new Promise(() => {});
    });
    const copiesOf = (name) => fake.liveDoc.customInventory.flatMap(c => c.items).filter(i => i.name === name).length;
    const lastInvSet = () => [...fake.writes].reverse().find(w => w.path === INV && w.op === 'set');
    const passDeadline = async () => { await act(async () => { vi.advanceTimersByTime(25000); }); };

    it('Location box: a retry that finds the item there adds no second copy', async () => {
        await ready();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        landsButNeverAnswers();
        const { input, btn } = await typeIn('Retry Thing');
        await act(async () => { fireEvent.click(btn()); });
        await passDeadline();
        expect(copiesOf('Retry Thing')).toBe(1);
        expect(fake.writes.filter(w => w.path.startsWith('inventory_audits'))).toHaveLength(1);
        await act(async () => { fireEvent.click(btn()); });
        expect(lastInvSet().data.customInventory.flatMap(c => c.items).filter(i => i.name === 'Retry Thing')).toHaveLength(1);
        expect(fake.writes.filter(w => w.path.startsWith('inventory_audits'))).toHaveLength(1);
        expect(input.value).toBe('Retry Thing');
    });

    it('Master List write-in: same, through quickAddItem', async () => {
        await ready();
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '📋 Master List' })[0]); });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const input = () => screen.getAllByPlaceholderText(/Write in item/)[0];
        const add = () => within(input().closest('.space-y-2')).getByRole('button', { name: /Add|Adding/ });
        fireEvent.change(input(), { target: { value: 'Zz Quick Retry' } });
        const sel = input().closest('.space-y-2').querySelectorAll('select')[1];
        fireEvent.change(sel, { target: { value: sel.options[1].value } });
        landsButNeverAnswers();
        await act(async () => { fireEvent.click(add()); });
        await passDeadline();
        expect(copiesOf('Zz Quick Retry')).toBe(1);
        await act(async () => { fireEvent.click(add()); });
        expect(lastInvSet().data.customInventory.flatMap(c => c.items).filter(i => i.name === 'Zz Quick Retry')).toHaveLength(1);
        expect(input().value).toBe('Zz Quick Retry');
    });

    it('Master List form (addInvItem): same, within the category', async () => {
        await ready();
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '📋 Master List' })[0]); });
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /More|⋯/ })[0]); });
        await act(async () => { fireEvent.click(screen.getByText(/Edit list/)); });
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Add Item/ })[0]); });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const name = () => screen.getByPlaceholderText('New item name');
        const form = name().closest('.space-y-2');
        fireEvent.change(name(), { target: { value: 'Zz Form Retry' } });
        const add = () => within(form).getByRole('button', { name: /^Add$|Adding/ });
        landsButNeverAnswers();
        await act(async () => { fireEvent.click(add()); });
        await passDeadline();
        expect(copiesOf('Zz Form Retry')).toBe(1);
        await act(async () => { fireEvent.click(add()); });
        expect(lastInvSet().data.customInventory.flatMap(c => c.items).filter(i => i.name === 'Zz Form Retry')).toHaveLength(1);
        expect(name().value).toBe('Zz Form Retry');
    });

    it('isDuplicateInCategory compares both names, trimmed, within one category', async () => {
        const { isDuplicateInCategory } = await import('./inventory');
        expect(isDuplicateInCategory({ items: [{ name: 'Eggs', nameEs: 'Huevos' }] }, { name: ' eggs ' })).toBe(true);
        expect(isDuplicateInCategory({ items: [{ name: 'Eggs', nameEs: 'Huevos' }] }, { name: 'x', nameEs: 'HUEVOS' })).toBe(true);
        expect(isDuplicateInCategory({ items: [{ name: 'Eggs', nameEs: '' }] }, { name: 'Milk', nameEs: '' })).toBe(false);
        expect(isDuplicateInCategory(undefined, { name: 'Milk' })).toBe(false);
    });
});
