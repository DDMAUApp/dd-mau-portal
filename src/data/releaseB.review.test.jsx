// Release B review findings, on the real Operations page. Firebase I/O is mocked,
// and nothing else about the page is. Harness copied from releaseB.operations.test.jsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';

const listeners = new Map();   // path -> [cb]
const fake = { liveDoc: null, writes: [], batchUpdates: [], batchSets: [] };
const appData = { labor: null };
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
        runTransaction: vi.fn(async (_db, fn) => fn({
            get: async () => ({ exists: () => fake.liveDoc != null, data: () => fake.liveDoc }),
            update: (ref, data) => fake.writes.push({ op: 'update', path: ref.path, data }),
            set: (ref, data, opts) => fake.writes.push({ op: 'set', path: ref.path, data, opts }),
        })),
        writeBatch: vi.fn(() => ({
            set: (ref, data) => fake.batchSets.push({ path: ref.path, data }),
            update: (ref, data) => fake.batchUpdates.push({ path: ref.path, data }),
            delete: vi.fn(),
            commit: vi.fn(async () => {}),
        })),
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
vi.mock('../v2/AppDataContext', () => ({ useAppData: () => ({ labor: appData.labor }) }));
vi.mock('../data/aiSearch', () => ({ useAiSearch: () => ({ loading: false, matchingIds: null, error: null }) }));
vi.mock('../components/ItemPriceModal', () => ({ default: () => null }));
vi.mock('../components/PricingWorkspace', () => ({ default: () => null }));
vi.mock('../components/SauceLogBohBanner', () => ({ default: () => <div data-testid="boh-sauce" /> }));
vi.mock('../components/CartPlanView', () => ({ default: () => null }));

import * as fsMock from 'firebase/firestore';
import Operations from '../components/Operations';
import { INVENTORY_CATEGORIES } from './inventory';
import { DEFAULT_STAFF } from './staff';
import { effectiveStaffRecord, listWithEffectiveRecord, readLastKnownAccess, saveLastKnownAccess } from './lastKnownAccess';
import { planHoldsOnOpen, settleIncHolds } from './inventoryReconcile';
import { PLACE_TTL_MS, readInventoryPlace, saveInventoryPlace, __resetPlaceMemoryForTests } from './placeMemory';

vi.setConfig({ testTimeout: 30000 });

const snap = (data, { fromCache = false, hasPendingWrites = false } = {}) => ({
    exists: () => data != null,
    data: () => data,
    metadata: { fromCache, hasPendingWrites },
});
const fire = (path, s) => { for (const cb of (listeners.get(path) || [])) cb(s); };

const INV = 'ops/inventory_webster';
const INV_MD = 'ops/inventory_maryland';
const flagOn = () => localStorage.setItem('ddmau:relFlags', JSON.stringify({ flags: { placeRestore: true } }));
const staffList = [{ id: 77, name: 'Laura', role: 'Prep', location: 'webster', opsAccess: true }];
const liveDoc = (extra = {}) => ({
    counts: {}, countMeta: {}, vendorCounts: {}, deletedMasterIds: [],
    customInventory: INVENTORY_CATEGORIES.map(c => ({ name: c.name, items: c.items.map(i => ({ ...i })) })),
    ...extra,
});
const stashKey = 'ddmau:reloadStash:inventory';
const putStash = (data) => sessionStorage.setItem(stashKey, JSON.stringify({ v: 1, key: 'inventory', reason: 'write-stuck', at: Date.now(), data }));

const item = INVENTORY_CATEGORIES.flatMap(c => c.items).find(i => i.location);
const ui = (props = {}) => <Operations language="en" staffName="Laura" storeLocation="webster" staffList={staffList} {...props} />;
const openInventory = async () => { await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Inventory/ })[0]); }); };
const mountOnInventory = async (props) => { const r = render(ui(props)); await openInventory(); return r; };
const stash = (extra = {}) => ({ loc: 'webster', staffName: 'Laura', counts: { [item.id]: 4 }, countMeta: {}, vendorCounts: {}, pendingCounts: {}, subTab: 'inventory', clearedAt: null, ...extra });
const withCount = (n = 4) => liveDoc({ counts: { [item.id]: n } });

// The default Location view's row for this item.
const row = () => {
    const el = screen.getAllByText(item.name).map(n => n.closest('.ddmau-inv-cv')).find(Boolean);
    return {
        minus: within(el).getByRole('button', { name: '−' }),
        plus: within(el).getByRole('button', { name: '+' }),
        input: within(el).getByRole('textbox'),
    };
};
const clearBtns = () => screen.getAllByRole('button', { name: /Clear/ }).filter(b => b.title === 'Clear all counts');
const saveBtns = () => screen.getAllByRole('button', { name: /Save/ }).filter(b => /Save( |$)|Save & Reset/.test(b.textContent));
const addBtn = () => {
    const input = screen.getAllByPlaceholderText(/Add item to/)[0];
    return within(input.closest('.space-y-2')).getByRole('button', { name: /Add/ });
};
const expectPlusOnly = async () => {
    expect(row().plus.disabled).toBe(false);
    expect(row().minus.disabled).toBe(true);
    expect(row().input.disabled).toBe(true);
    expect(clearBtns().every(b => b.disabled)).toBe(true);
    expect(saveBtns().length).toBeGreaterThan(0);
    expect(saveBtns().every(b => b.disabled)).toBe(true);
    // The Add button only appears once there's text in the box.
    await act(async () => { fireEvent.change(screen.getAllByPlaceholderText(/Add item to/)[0], { target: { value: 'x' } }); });
    expect(addBtn().disabled).toBe(true);
};
const expectAllOpen = () => {
    expect(row().minus.disabled).toBe(false);
    expect(row().input.disabled).toBe(false);
    expect(clearBtns().every(b => !b.disabled)).toBe(true);
    expect(saveBtns().every(b => !b.disabled)).toBe(true);
};
const line = () => screen.queryByTestId('sheet-saved-copy');
const rowBox = () => screen.getAllByText(item.name).map(n => n.closest('.ddmau-inv-cv')).find(Boolean);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetPlaceMemoryForTests();
    listeners.clear();
    fake.liveDoc = null;
    fake.writes = [];
    fake.batchUpdates = [];
    fake.batchSets = [];
    appData.labor = null;
    fsMock.runTransaction.mockClear();
    fsMock.setDoc.mockClear();
    fsMock.updateDoc.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('1. Operations under a placeholder roster, with saved access', () => {
    // A person on the built-in list, which carries no opsAccess. App hands Operations
    // exactly this list while the roster hasn't answered.
    const who = DEFAULT_STAFF.find(s => s.id === 1);
    // Through the real save and read, so the allow-list is part of what's tested.
    const listFrom = (fields) => {
        saveLastKnownAccess({ name: who.name, ...fields });
        const saved = readLastKnownAccess(who.name);
        return listWithEffectiveRecord(DEFAULT_STAFF, who.name, effectiveStaffRecord({ staffList: DEFAULT_STAFF, staffName: who.name, staffListReady: false, saved }));
    };
    const open = (list) => render(<Operations language="en" staffName={who.name} storeLocation="webster" staffList={list} />);
    const denied = () => screen.queryByText(/don't have access to Operations/);
    beforeEach(flagOn);

    it('the raw placeholder denies them, which is why App must not pass it', async () => {
        open(DEFAULT_STAFF);
        expect(denied()).toBeTruthy();
    });
    it('no false "no access" screen', async () => {
        open(listFrom({ id: 1, role: who.role, opsAccess: true }));
        expect(denied()).toBe(null);
        await openInventory();
        expect(screen.getByTestId('sheet-loading')).toBeTruthy();
    });
    it('checklist side comes from saved scheduleSide', async () => {
        open(listFrom({ id: 1, role: 'FOH', opsAccess: true, scheduleSide: 'boh' }));
        await act(async () => {});
        expect(screen.getAllByText(/Sauce/).length).toBeGreaterThan(0);
        const foh = render(<Operations language="en" staffName={who.name} storeLocation="webster" staffList={listFrom({ id: 1, role: 'Pho', opsAccess: true, scheduleSide: 'foh' })} />);
        expect(within(foh.container).queryByTestId('boh-sauce')).toBe(null);
    });
    it('labor bubble follows saved viewLabor and role', async () => {
        appData.labor = { laborPercent: 21.5, laborCost: 100, netSales: 465, updatedAt: new Date().toISOString() };
        const shown = () => screen.queryByText('21.5%');
        const a = open(listFrom({ id: 1, role: 'Pho', opsAccess: true, viewLabor: true }));
        expect(shown()).toBeTruthy();
        a.unmount();
        const b = open(listFrom({ id: 1, role: 'Manager', opsAccess: true, viewLabor: false }));
        expect(shown()).toBe(null);
        b.unmount();
        open(listFrom({ id: 1, role: 'Manager', opsAccess: true }));
        expect(shown()).toBeTruthy();
    });
});

describe('2. a cached copy, flag on', () => {
    beforeEach(flagOn);

    it('viewing and + only, with the line; the server opens the rest', async () => {
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(), { fromCache: true })); });
        expect(screen.queryByTestId('sheet-loading')).toBe(null);
        expect(line().textContent).toBe('Saved copy, still connecting. Only + works for now.');
        await expectPlusOnly();
        await act(async () => { fire(INV, snap(withCount())); });
        expect(line()).toBe(null);
        expectAllOpen();
    });
    it('the line in Spanish', async () => {
        render(ui({ language: 'es' }));
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Inventario/ })[0]); });
        await act(async () => { fire(INV, snap(withCount(), { fromCache: true })); });
        expect(line().textContent).toBe('Copia guardada, todavía conectando. Por ahora solo funciona +.');
    });
    it('+ goes through as an increment, and stays usable on a line that never frees', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const r = await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(), { fromCache: true })); });
        await act(async () => { vi.advanceTimersByTime(120000); });
        expect(screen.queryByTestId('sheet-loading')).toBe(null);
        await act(async () => { fireEvent.click(row().plus); });
        expect(row().input.value).toBe('5');
        vi.useRealTimers();
        r.unmount();
        expect(fake.batchUpdates.at(-1).data[`counts.${item.id}`]).toEqual({ __op: 'inc', n: 1 });
    });
    it('− and typed entry write nothing', async () => {
        const r = await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(), { fromCache: true })); });
        await act(async () => { fireEvent.click(row().minus); });
        expect(row().input.value).toBe('4');
        r.unmount();
        expect(fake.batchUpdates).toHaveLength(0);
    });
    it('an empty cached doc is not an empty sheet: still loading, until the server says so', async () => {
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc(), { fromCache: true })); });
        expect(screen.getByTestId('sheet-loading')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Clear/ })).toBe(null);
        await act(async () => { fire(INV, snap(liveDoc())); });
        expect(screen.queryByTestId('sheet-loading')).toBe(null);
        expectAllOpen();
    });
    it('all-zero counts in a cached doc are empty too', async () => {
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc({ counts: { [item.id]: 0 } }), { fromCache: true })); });
        expect(screen.getByTestId('sheet-loading')).toBeTruthy();
    });
    it('a cached snapshot after the server has answered never takes the controls away', async () => {
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount())); });
        await act(async () => { fire(INV, snap(withCount(), { fromCache: true })); });
        expect(line()).toBe(null);
        expectAllOpen();
    });
});

describe('3. after a stash paint, flag on', () => {
    beforeEach(flagOn);

    it('only +; − and typed entry look disabled and write nothing', async () => {
        putStash(stash());
        const r = await mountOnInventory();
        expect(line()).toBeTruthy();
        await expectPlusOnly();
        expect(row().minus.className).toContain('disabled:opacity-40');
        expect(row().input.className).toContain('opacity-50');
        await act(async () => { fireEvent.click(row().minus); });
        expect(row().input.value).toBe('4');
        await act(async () => { fireEvent.click(row().plus); });
        expect(row().input.value).toBe('5');
        r.unmount();
        expect(fake.batchUpdates).toHaveLength(1);
        expect(fake.batchUpdates[0].data[`counts.${item.id}`]).toEqual({ __op: 'inc', n: 1 });
    });
    it('the Master List rows are locked the same way', async () => {
        putStash(stash());
        await mountOnInventory();
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '📋 Master List' })[0]); });
        const minus = screen.getAllByRole('button', { name: '−' });
        expect(minus.length).toBeGreaterThan(0);
        expect(minus.every(b => b.disabled)).toBe(true);
        const qty = screen.getAllByRole('textbox', { name: 'Quantity' });
        expect(qty.every(i => i.disabled)).toBe(true);
        expect(screen.getAllByRole('button', { name: '+' }).every(b => !b.disabled)).toBe(true);
    });
});

describe('4. skills matrix', () => {
    const breakCrew = [
        { id: 77, name: 'Laura', role: 'Prep', location: 'webster', opsAccess: true },
        { id: 78, name: 'O.J. Cook', role: 'Grill', location: 'webster' },
    ];
    const MATRIX = 'config/skillsMatrix';
    const open = async () => {
        render(ui({ staffList: breakCrew }));
        await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Breaks/ })[0]); });
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Skills matrix' })); });
    };
    const boxes = () => screen.getAllByText('O.J.')[0].closest('tr').querySelectorAll('button');
    const matrixWrites = () => fsMock.setDoc.mock.calls.filter(c => c[0].path === MATRIX);

    it('flag on: locked until the first snapshot, and a click writes nothing', async () => {
        flagOn();
        await open();
        expect(screen.getByTestId('skills-loading')).toBeTruthy();
        expect([...boxes()].every(b => b.disabled)).toBe(true);
        await act(async () => { fireEvent.click(boxes()[0]); });
        expect(matrixWrites()).toHaveLength(0);
    });
    it('flag on: a cache with no copy is not the first snapshot; the server saying none is', async () => {
        flagOn();
        await open();
        await act(async () => { fire(MATRIX, snap(null, { fromCache: true })); });
        expect(boxes()[0].disabled).toBe(true);
        await act(async () => { fire(MATRIX, snap(null)); });
        expect(boxes()[0].disabled).toBe(false);
        expect(screen.queryByTestId('skills-loading')).toBe(null);
    });
    it('flag on: a click writes one box by merge, so other boxes and dotted names are safe', async () => {
        flagOn();
        await open();
        await act(async () => { fire(MATRIX, snap({ matrix: { 'Laura_x': true } }, { fromCache: true })); });
        await act(async () => { fireEvent.click(boxes()[0]); });
        const [, data, opts] = matrixWrites()[0];
        expect(opts).toEqual({ merge: true });
        expect(Object.keys(data.matrix)).toHaveLength(1);
        expect(Object.keys(data.matrix)[0]).toMatch(/^O\.J\. Cook_/);
        expect(Object.values(data.matrix)[0]).toBe(true);
    });
    it('flag off: today\'s page, open at once, and the whole map replaces the document', async () => {
        await open();
        expect(screen.queryByTestId('skills-loading')).toBe(null);
        expect(boxes()[0].disabled).toBe(false);
        await act(async () => { fireEvent.click(boxes()[0]); });
        const call = matrixWrites()[0];
        expect(call).toHaveLength(2);
        await act(async () => { fireEvent.click(boxes()[1]); });
        expect(Object.keys(matrixWrites()[1][1].matrix)).toHaveLength(2);
    });
});

describe('5. a late add after a store toggle', () => {
    const lateName = 'Webster Only Late Item';
    const startHungAdd = async (r) => {
        let land;
        fsMock.runTransaction.mockImplementationOnce(() => new Promise((res) => { land = res; }));
        const input = screen.getAllByPlaceholderText(/Add item to/)[0];
        await act(async () => { fireEvent.change(input, { target: { value: lateName } }); });
        await act(async () => { fireEvent.click(addBtn()); });
        await act(async () => { r.rerender(ui({ storeLocation: 'maryland' })); });
        await act(async () => { fire(INV_MD, snap(liveDoc())); });
        return (list) => act(async () => { land({ updated: list, tombstones: [] }); });
    };
    const websterList = () => {
        const list = liveDoc().customInventory;
        list[0] = { ...list[0], items: [...list[0].items, { id: 'late1', name: lateName, nameEs: '', location: item.location }] };
        return list;
    };
    const visible = () => screen.queryAllByText(lateName).length > 0;

    it('flag on: the other store\'s catalog is not painted', async () => {
        flagOn();
        const r = await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        const landIt = await startHungAdd(r);
        await landIt(websterList());
        expect(visible()).toBe(false);
    });
    it('flag on: an add that lands on the same store still shows at once', async () => {
        flagOn();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        let land;
        fsMock.runTransaction.mockImplementationOnce(() => new Promise((res) => { land = res; }));
        const input = screen.getAllByPlaceholderText(/Add item to/)[0];
        await act(async () => { fireEvent.change(input, { target: { value: lateName } }); });
        await act(async () => { fireEvent.click(addBtn()); });
        await act(async () => { land({ updated: websterList(), tombstones: [] }); });
        expect(visible()).toBe(true);
    });
    it('flag off: today\'s behavior is unchanged', async () => {
        const r = await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        const landIt = await startHungAdd(r);
        await landIt(websterList());
        expect(visible()).toBe(true);
    });
});

describe('6. the inventory place while idle', () => {
    const idle = async (ms) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
    const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

    it('flag on: a person sitting on the page never ages out', async () => {
        flagOn();
        fakeClock();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        await idle(1000);
        expect(readInventoryPlace('Laura', 'webster')?.subTab).toBe('inventory');
        await idle(PLACE_TTL_MS + 60000);
        expect(readInventoryPlace('Laura', 'webster')?.subTab).toBe('inventory');
    });
    it('flag on: visibilitychange refreshes it right then', async () => {
        flagOn();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        await act(async () => { await new Promise(res => setTimeout(res, 600)); });
        fakeClock();
        vi.setSystemTime(Date.now() + PLACE_TTL_MS - 1000);
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        vi.setSystemTime(Date.now() + 5000);
        expect(readInventoryPlace('Laura', 'webster')?.subTab).toBe('inventory');
    });
    it('flag off: no record, however long they sit', async () => {
        fakeClock();
        await mountOnInventory();
        await idle(120000);
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(readInventoryPlace('Laura', 'webster')).toBe(null);
    });
});

describe('7. a store toggle and the saved place', () => {
    const typeInBox = async (text) => {
        await act(async () => { fireEvent.change(screen.getAllByPlaceholderText(/Add item to/)[0], { target: { value: text } }); });
    };
    const ready = async (store) => { await act(async () => { fire(store === 'maryland' ? INV_MD : INV, snap(liveDoc())); }); };

    it('flag on: one store\'s text and filters never land in the other\'s record', async () => {
        flagOn();
        saveInventoryPlace('Laura', 'maryland', { subTab: 'checklist', locWriteIn: { Keep: 'maryland text' }, invSearch: 'mdsearch' });
        const r = await mountOnInventory();
        await ready('webster');
        await typeInBox('webster text');
        await act(async () => { r.rerender(ui({ storeLocation: 'maryland' })); });
        await ready('maryland');
        await act(async () => { await new Promise(res => setTimeout(res, 600)); });
        const md = readInventoryPlace('Laura', 'maryland');
        expect(JSON.stringify(md)).not.toContain('webster text');
        expect(md.locWriteIn).toEqual({ Keep: 'maryland text' });
        expect(md.invSearch).toBe('mdsearch');
        expect(md.subTab).toBe('inventory');
        const web = readInventoryPlace('Laura', 'webster');
        expect(Object.values(web.locWriteIn)).toContain('webster text');
    });
    it('flag on: each store shows its own, and going back brings the text back', async () => {
        flagOn();
        const r = await mountOnInventory();
        await ready('webster');
        await typeInBox('webster text');
        await act(async () => { r.rerender(ui({ storeLocation: 'maryland' })); });
        await ready('maryland');
        expect(screen.queryByDisplayValue('webster text')).toBe(null);
        await act(async () => { r.rerender(ui({ storeLocation: 'webster' })); });
        await ready('webster');
        expect(screen.getAllByDisplayValue('webster text').length).toBeGreaterThan(0);
    });
    it('flag off: the text stays on screen across the toggle, as today, and no record is written', async () => {
        const r = await mountOnInventory();
        await ready('webster');
        await typeInBox('webster text');
        await act(async () => { r.rerender(ui({ storeLocation: 'maryland' })); });
        await ready('maryland');
        await act(async () => { await new Promise(res => setTimeout(res, 600)); });
        expect(readInventoryPlace('Laura', 'maryland')).toBe(null);
        expect(readInventoryPlace('Laura', 'webster')).toBe(null);
    });
});

describe('8. the server says empty', () => {
    it('flag on: stash numbers go at once, and the controls open', async () => {
        flagOn();
        putStash(stash({ countMeta: { [item.id]: { by: 'Laura', at: '1:00' } } }));
        await mountOnInventory();
        expect(row().input.value).toBe('4');
        await act(async () => { fire(INV, snap(liveDoc())); });
        expect(row().input.value).toBe('0');
        expectAllOpen();
    });
    it('flag on: cached numbers go too', async () => {
        flagOn();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(), { fromCache: true })); });
        expect(row().input.value).toBe('4');
        await act(async () => { fire(INV, snap(liveDoc())); });
        expect(row().input.value).toBe('0');
    });
    it('flag on: the server having no document at all wins too', async () => {
        flagOn();
        putStash(stash());
        await mountOnInventory();
        await act(async () => { fire(INV, snap(null)); });
        expect(row().input.value).toBe('0');
        expect(line()).toBe(null);
    });
    it('flag on: a restored hold the server doesn\'t show gives way at once, and the row says so', async () => {
        flagOn();
        putStash(stash({ pendingCounts: { [item.id]: { expected: 4, ts: Date.now(), mode: 'abs' } } }));
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        expect(row().input.value).toBe('0');
        expect(rowBox().textContent).toMatch(/elsewhere/i);
    });
    it('flag on: an empty CACHED doc does not wipe a stash', async () => {
        flagOn();
        putStash(stash());
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc(), { fromCache: true })); });
        expect(row().input.value).toBe('4');
        expect(line()).toBeTruthy();
    });
    it('flag on: a server snapshot carrying this device\'s pending writes does not wipe it', async () => {
        flagOn();
        putStash(stash());
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc(), { hasPendingWrites: true })); });
        expect(row().input.value).toBe('4');
        expect(line()).toBeTruthy();
    });
    it('flag off: the first server snapshot stays guarded, as today', async () => {
        putStash(stash());
        await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        expect(row().input.value).toBe('4');
    });
});

describe('flag off: the page before any snapshot and on a cached copy is today\'s', () => {
    it('all controls open, no line, no matter what has or hasn\'t arrived', async () => {
        await mountOnInventory();
        expect(line()).toBe(null);
        expectAllOpen();
        await act(async () => { fire(INV, snap(withCount(), { fromCache: true })); });
        expect(line()).toBe(null);
        expectAllOpen();
    });
    it('− on a stash paint writes an absolute, as today', async () => {
        putStash(stash());
        const r = await mountOnInventory();
        expect(line()).toBe(null);
        await act(async () => { fireEvent.click(row().minus); });
        expect(row().input.value).toBe('3');
        r.unmount();
        expect(fake.batchUpdates.at(-1).data[`counts.${item.id}`]).toBe(3);
    });
});

// Second review round.
const waitWindow = () => act(async () => { await new Promise(res => setTimeout(res, 400)); });

describe('9. a + on a saved copy, then the server answers lower', () => {
    it('flag on, cached copy: the server\'s number shows, and − works from it', async () => {
        flagOn();
        const r = await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(4), { fromCache: true })); });
        await act(async () => { fireEvent.click(row().plus); });
        expect(row().input.value).toBe('5');
        await waitWindow();
        // The server really had 2, and the tap made it 3.
        await act(async () => { fire(INV, snap(withCount(3))); });
        expect(row().input.value).toBe('3');
        expect(row().minus.disabled).toBe(false);
        fake.batchUpdates.length = 0;
        await act(async () => { fireEvent.click(row().minus); });
        r.unmount();
        expect(fake.batchUpdates.at(-1).data[`counts.${item.id}`]).toBe(2);
    });
    it('flag on, stash: same', async () => {
        flagOn();
        putStash(stash());
        await mountOnInventory();
        await act(async () => { fireEvent.click(row().plus); });
        await waitWindow();
        await act(async () => { fire(INV, snap(withCount(3))); });
        expect(row().input.value).toBe('3');
    });
    it('flag on: a tap still in its window keeps its hold, then goes on the next clean answer', async () => {
        flagOn();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(4), { fromCache: true })); });
        await act(async () => { fireEvent.click(row().plus); });
        await act(async () => { fire(INV, snap(withCount(2))); });
        expect(row().input.value).toBe('3');
        await waitWindow();
        await act(async () => { fire(INV, snap(withCount(3))); });
        expect(row().input.value).toBe('3');
    });
    it('flag on: with no further snapshot, the timer releases what remains', async () => {
        flagOn();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(4), { fromCache: true })); });
        await act(async () => { fireEvent.click(row().plus); });
        await act(async () => { fire(INV, snap(withCount(2))); });
        expect(row().input.value).toBe('3');
        await act(async () => { vi.advanceTimersByTime(15000); });
        expect(row().input.value).toBe('2');
    });
    it('flag on: a + on a live sheet still holds over a stale server answer', async () => {
        flagOn();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(4))); });
        await act(async () => { fireEvent.click(row().plus); });
        await waitWindow();
        await act(async () => { fire(INV, snap(withCount(4))); });
        expect(row().input.value).toBe('5');
    });
    it('flag off: the hold stays, as today', async () => {
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(4), { fromCache: true })); });
        await act(async () => { fireEvent.click(row().plus); });
        await waitWindow();
        await act(async () => { fire(INV, snap(withCount(3))); });
        expect(row().input.value).toBe('5');
    });
    it('flag on: a + in its window when the server answers: shown and held on the server\'s count', async () => {
        flagOn();
        const r = await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(4), { fromCache: true })); });
        await act(async () => { fireEvent.click(row().plus); fireEvent.click(row().plus); });
        await act(async () => { fire(INV, snap(withCount(2))); });
        expect(row().input.value).toBe('4');
        await waitWindow();
        expect(fake.batchUpdates.map(b => b.data[`counts.${item.id}`])).toEqual([{ __op: 'inc', n: 2 }]);
        await act(async () => { fire(INV, snap(withCount(4))); });
        expect(row().input.value).toBe('4');
        r.unmount();
    });
    it('flag on: − in that same window writes from the server\'s count', async () => {
        flagOn();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(4), { fromCache: true })); });
        await act(async () => { fireEvent.click(row().plus); });
        await act(async () => { fire(INV, snap(withCount(2))); });
        await act(async () => { fireEvent.click(row().minus); });
        await waitWindow();
        expect(fake.batchUpdates.map(b => b.data[`counts.${item.id}`])).toEqual([2]);
    });
    it('flag on: a tap landing right as the server answers counts from the server\'s number', async () => {
        flagOn();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(4), { fromCache: true })); });
        await act(async () => { fireEvent.click(row().plus); });
        const plus = row().plus;
        await act(async () => { fire(INV, snap(withCount(2))); fireEvent.click(plus); });
        await waitWindow();
        expect(fake.batchSets.at(-1).data).toMatchObject({ previous: 2, next: 4, ownDelta: 2 });
    });
    it('flag on: a restored + hold the server doesn\'t show: server\'s number and the conflict flag', async () => {
        flagOn();
        putStash(stash({ counts: { [item.id]: 5 }, pendingCounts: { [item.id]: { expected: 5, ts: Date.now(), mode: 'inc' } } }));
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(4))); });
        expect(row().input.value).toBe('4');
        expect(rowBox().textContent).toMatch(/elsewhere/i);
    });
    it('flag on: a restored + hold the server does show just resolves', async () => {
        flagOn();
        putStash(stash({ counts: { [item.id]: 5 }, pendingCounts: { [item.id]: { expected: 5, ts: Date.now(), mode: 'inc' } } }));
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(5))); });
        expect(row().input.value).toBe('5');
        expect(rowBox().textContent).not.toMatch(/elsewhere/i);
    });
    it('flag on: a new + on top of a restored hold doesn\'t hide that it may be lost', async () => {
        flagOn();
        putStash(stash({ counts: { [item.id]: 5 }, pendingCounts: { [item.id]: { expected: 5, ts: Date.now(), mode: 'inc' } } }));
        await mountOnInventory();
        await act(async () => { fireEvent.click(row().plus); });
        await waitWindow();
        await act(async () => { fire(INV, snap(withCount(4))); });
        expect(row().input.value).toBe('4');
        expect(rowBox().textContent).toMatch(/elsewhere/i);
    });
    it('a + on a saved copy goes quietly: no conflict flag', async () => {
        flagOn();
        await mountOnInventory();
        await act(async () => { fire(INV, snap(withCount(4), { fromCache: true })); });
        await act(async () => { fireEvent.click(row().plus); });
        await waitWindow();
        await act(async () => { fire(INV, snap(withCount(3))); });
        expect(rowBox().textContent).not.toMatch(/elsewhere/i);
    });
    it('planHoldsOnOpen sorts every hold', () => {
        const pending = { tap: { mode: 'inc' }, win: { mode: 'inc' }, back: { mode: 'inc' }, both: { mode: 'inc' }, abs: { mode: 'abs' } };
        expect(planHoldsOnOpen(pending, { openWindowIds: ['win'], tappedOnCopy: ['tap', 'both'], restoredIds: ['back', 'both'] })).toEqual({
            dropped: ['tap'], waiting: ['win'], restored: ['back', 'both', 'abs'],
        });
    });
    it('settleIncHolds sorts + holds by whether their window is open, and skips the rest', () => {
        const pending = { a: { mode: 'inc' }, b: { mode: 'inc' }, c: { mode: 'abs' } };
        expect(settleIncHolds(pending, ['a', 'b', 'c', 'gone'], ['b'])).toEqual({ dropped: ['a'], waiting: ['b'] });
        expect(settleIncHolds(pending, [], undefined)).toEqual({ dropped: [], waiting: [] });
    });
});

describe('10. Place order', () => {
    const placeOrder = () => screen.getByRole('button', { name: /Place order/ });
    const openCart = async () => { await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /total/ })[0]); }); };

    it('flag on: disabled on a saved copy, opens up when the server answers', async () => {
        flagOn();
        putStash(stash());
        await mountOnInventory();
        await openCart();
        expect(placeOrder().disabled).toBe(true);
        expect(placeOrder().className).toContain('disabled:opacity-50');
        await act(async () => { fireEvent.click(placeOrder()); });
        expect(screen.getByRole('button', { name: /Place order/ })).toBeTruthy(); // cart still open
        await act(async () => { fire(INV, snap(withCount())); });
        expect(placeOrder().disabled).toBe(false);
    });
    it('flag off: open, as today', async () => {
        putStash(stash());
        await mountOnInventory();
        await openCart();
        expect(placeOrder().disabled).toBe(false);
    });
});

describe('11. split write-ins', () => {
    const SPLIT = 'ops/splitConfig_webster';
    const openSplit = async () => { await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Split/ })[0]); }); };
    const person = 'Lorena';
    const config = () => ({ overrides: {}, writeIns: { [person]: [{ id: 'w1', name: 'Saved Write In', count: 2 }] } });
    const box = () => screen.getAllByRole('textbox').filter(i => /write in|Can't write in/i.test(i.placeholder || ''));
    const wiRow = () => screen.getByText('Saved Write In').closest('.flex.items-center.justify-between');
    const splitWrites = () => fsMock.updateDoc.mock.calls.filter(c => c[0].path === SPLIT);
    const live = async () => { await act(async () => { fire(INV, snap(withCount())); }); };

    it('flag on: everything locked until the server answers, whatever the sheet is doing', async () => {
        flagOn();
        await mountOnInventory();
        await live();
        await openSplit();
        await act(async () => { fire(SPLIT, snap(config(), { fromCache: true })); });
        expect(box().every(i => i.disabled)).toBe(true);
        const buttons = within(wiRow()).getAllByRole('button');
        expect(buttons).toHaveLength(3);
        expect(buttons.every(b => b.disabled)).toBe(true);
        await act(async () => { fireEvent.change(box()[0], { target: { value: 'New' } }); fireEvent.keyDown(box()[0], { key: 'Enter' }); });
        expect(splitWrites()).toHaveLength(0);
    });
    it('flag on: the real SDK sequence, server copy matching the cache: only the second event unlocks', async () => {
        flagOn();
        await mountOnInventory();
        await live();
        await openSplit();
        expect(fsMock.onSnapshot.mock.calls.find(c => c[0].path === SPLIT)[1]).toEqual({ includeMetadataChanges: true });
        await act(async () => { fire(SPLIT, snap(config(), { fromCache: true })); });
        expect(box().every(i => i.disabled)).toBe(true);
        await act(async () => { fire(SPLIT, snap(config())); });
        expect(box().every(i => !i.disabled)).toBe(true);
    });
    it('either flag: a metadata-only event doesn\'t undo a tap made since the data last changed', async () => {
        for (const on of [true, false]) {
            localStorage.clear();
            if (on) flagOn();
            const r = await mountOnInventory();
            await act(async () => { fire(INV, snap(withCount())); });
            await openSplit();
            await act(async () => { fire(SPLIT, snap(config(), { fromCache: true })); });
            await act(async () => { fire(SPLIT, snap(config())); }); // same data, now from the server
            const plus = () => within(wiRow()).getAllByRole('button')[1];
            await act(async () => { fireEvent.click(plus()); }); // 3
            const three = { overrides: {}, writeIns: { [person]: [{ id: 'w1', name: 'Saved Write In', count: 3 }] } };
            await act(async () => { fire(SPLIT, snap(three, { hasPendingWrites: true })); }); // the echo, skipped
            await act(async () => { fireEvent.click(plus()); }); // 4, before the first ack
            await act(async () => { fire(SPLIT, snap(three)); }); // the first ack: metadata only
            expect(wiRow().textContent).toContain('4');
            r.unmount();
            listeners.clear();
        }
    });
    it('either flag: an event with new data is still applied', async () => {
        for (const on of [true, false]) {
            localStorage.clear();
            if (on) flagOn();
            const r = await mountOnInventory();
            await act(async () => { fire(INV, snap(withCount())); });
            await openSplit();
            await act(async () => { fire(SPLIT, snap(config(), { fromCache: true })); });
            const seven = { overrides: {}, writeIns: { [person]: [{ id: 'w1', name: 'Saved Write In', count: 7 }] } };
            await act(async () => { fire(SPLIT, snap(seven)); });
            expect(wiRow().textContent).toContain('7');
            r.unmount();
            listeners.clear();
        }
    });
    it('flag on: the server answering opens it, and a save goes through', async () => {
        flagOn();
        await mountOnInventory();
        await live();
        await openSplit();
        await act(async () => { fire(SPLIT, snap(config(), { fromCache: true })); });
        await act(async () => { fire(SPLIT, snap(config())); });
        const buttons = within(wiRow()).getAllByRole('button');
        expect(buttons.every(b => !b.disabled)).toBe(true);
        await act(async () => { fireEvent.click(buttons[1]); });
        expect(splitWrites()).toHaveLength(1);
    });
    it('flag on: a store switch locks it again, and the last store\'s list doesn\'t follow', async () => {
        flagOn();
        const r = await mountOnInventory();
        await live();
        await openSplit();
        await act(async () => { fire(SPLIT, snap(config())); });
        await act(async () => { r.rerender(ui({ storeLocation: 'maryland' })); });
        await act(async () => { fire(INV_MD, snap(withCount())); });
        expect(box().every(i => i.disabled)).toBe(true);
        await act(async () => { fire('ops/splitConfig_maryland', snap(null, { fromCache: true })); });
        expect(box().every(i => i.disabled)).toBe(true);
        await act(async () => { fire('ops/splitConfig_maryland', snap(null)); });
        expect(box().every(i => !i.disabled)).toBe(true);
        expect(screen.queryByText('Saved Write In')).toBe(null);
    });
    it('every save carries the list, even two taps before the page redraws', async () => {
        await mountOnInventory();
        await openSplit();
        await act(async () => { fire(SPLIT, snap(config())); });
        const plus = within(wiRow()).getAllByRole('button')[1];
        await act(async () => { fireEvent.click(plus); fireEvent.click(plus); });
        expect(splitWrites()).toHaveLength(2);
        for (const c of splitWrites()) expect(c[2]).toEqual([{ id: 'w1', name: 'Saved Write In', count: 3 }]);
    });
    it('a first event that was a skipped echo doesn\'t leave the list blank when the same data follows', async () => {
        flagOn();
        await mountOnInventory();
        await live();
        await openSplit();
        await act(async () => { fire(SPLIT, snap(config(), { hasPendingWrites: true })); });
        expect(screen.queryByText('Saved Write In')).toBe(null);
        await act(async () => { fire(SPLIT, snap(config())); });
        expect(screen.getByText('Saved Write In')).toBeTruthy();
        expect(box().every(i => !i.disabled)).toBe(true);
    });
    it('flag off: open before any snapshot, and the list follows a store switch, as today', async () => {
        const r = await mountOnInventory();
        await openSplit();
        await act(async () => { fire(SPLIT, snap(config(), { fromCache: true })); });
        const buttons = within(wiRow()).getAllByRole('button');
        expect(buttons.every(b => !b.disabled)).toBe(true);
        await act(async () => { fireEvent.click(buttons[1]); });
        expect(splitWrites()).toHaveLength(1);
        await act(async () => { r.rerender(ui({ storeLocation: 'maryland' })); });
        await act(async () => { fire('ops/splitConfig_maryland', snap(null)); });
        expect(screen.getByText('Saved Write In')).toBeTruthy();
    });
});

describe('12. the flag arriving mid-session', () => {
    it('a server answer ignored with the flag off still counts when the flag arrives', async () => {
        putStash(stash());
        const r = await mountOnInventory();
        await act(async () => { fire(INV, snap(liveDoc())); });
        expect(row().input.value).toBe('4'); // the guard kept the numbers
        flagOn();
        await act(async () => { r.rerender(ui()); });
        expect(line()).toBe(null);
        expectAllOpen();
    });
    it('no server answer yet: a saved copy is still a saved copy when the flag arrives', async () => {
        putStash(stash());
        const r = await mountOnInventory();
        flagOn();
        await act(async () => { r.rerender(ui()); });
        expect(line()).toBeTruthy();
    });
});
