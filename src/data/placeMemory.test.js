import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLACE_TTL_MS, __resetPlaceMemoryForTests, createPlaceSaver, placeOutcome, readInventoryPlace, readMainTab, saveInventoryPlace, saveMainTab } from './placeMemory';

beforeEach(() => { localStorage.clear(); __resetPlaceMemoryForTests(); });
afterEach(() => vi.useRealTimers());

const T = 1_000_000_000;
describe('main tab', () => {
    it('round trips', () => {
        saveMainTab('Laura', 'operations', T);
        expect(readMainTab('Laura', T + 1000)).toBe('operations');
    });
    it('keeps each person on a shared iPad apart', () => {
        saveMainTab('Laura', 'operations', T);
        saveMainTab('Yulissa', 'schedule', T);
        expect(readMainTab('Laura', T)).toBe('operations');
        expect(readMainTab('Yulissa', T)).toBe('schedule');
        expect(readMainTab('Myia', T)).toBe(null);
    });
    it('expires at 30 minutes', () => {
        saveMainTab('Laura', 'operations', T);
        expect(readMainTab('Laura', T + PLACE_TTL_MS - 1)).toBe('operations');
        expect(readMainTab('Laura', T + PLACE_TTL_MS)).toBe(null);
    });
    it("a relock's tab change has no name, so it can't overwrite", () => {
        saveMainTab('Laura', 'operations', T);
        saveMainTab(null, 'home', T + 1);
        expect(readMainTab('Laura', T + 2)).toBe('operations');
    });
});

describe('inventory place', () => {
    const place = {
        subTab: 'inventory', invViewMode: 'vendor', invSearch: 'egg', invShowOnlyCounted: true, invShowOnlyLow: false,
        collapsedCats: { 'loc::Walk-in': true }, writeInValues: { 0: 'x' }, writeInDest: { 0: { catIdx: 1, location: 'A' } },
        locWriteIn: { A: 'y' }, locWriteInCat: { A: 2 }, invNewName: 'n', invNewNameEs: 'm', scrollY: 640,
    };
    it('round trips per person and store', () => {
        saveInventoryPlace('Laura', 'webster', place, T);
        expect(readInventoryPlace('Laura', 'webster', T + 1)).toEqual(place);
        expect(readInventoryPlace('Laura', 'maryland', T + 1)).toBe(null);
        expect(readInventoryPlace('Yulissa', 'webster', T + 1)).toBe(null);
    });
    it('expires', () => {
        saveInventoryPlace('Laura', 'webster', place, T);
        expect(readInventoryPlace('Laura', 'webster', T + PLACE_TTL_MS)).toBe(null);
    });
    it('drops anything unknown or malformed', () => {
        saveInventoryPlace('Laura', 'webster', { subTab: 'nope', invViewMode: 'x', invSearch: 4, scrollY: -1, collapsedCats: [], pin: '1' }, T);
        expect(readInventoryPlace('Laura', 'webster', T)).toEqual({});
    });
    it('removes other people\'s expired records, which can hold typed text', () => {
        saveInventoryPlace('Gone', 'webster', place, T);
        __resetPlaceMemoryForTests();
        saveInventoryPlace('Laura', 'webster', place, T + PLACE_TTL_MS + 1);
        expect(Object.keys(localStorage).concat(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))).join()).not.toContain('Gone');
    });
    it('survives broken storage', () => {
        localStorage.setItem('ddmau:placeTab:Laura', '{bad');
        expect(readMainTab('Laura', T)).toBe(null);
    });
});

describe('saver', () => {
    it('writes at most every 500 ms and flushes what waits', () => {
        vi.useFakeTimers();
        const write = vi.fn();
        const s = createPlaceSaver(write, 500);
        s.schedule(); s.schedule(); s.schedule();
        vi.advanceTimersByTime(0);
        expect(write).toHaveBeenCalledTimes(1);
        s.schedule();
        vi.advanceTimersByTime(499);
        expect(write).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(write).toHaveBeenCalledTimes(2);
        s.schedule();
        s.flush();
        expect(write).toHaveBeenCalledTimes(3);
        s.flush();
        vi.advanceTimersByTime(1000);
        expect(write).toHaveBeenCalledTimes(3);
    });
});

describe('placeOutcome', () => {
    it('restored only when the tab area really shows the same tab', () => {
        expect(placeOutcome({ reportTab: 'operations', tab: 'operations', body: 'tab' })).toEqual({ restored: true, landedHome: false });
        expect(placeOutcome({ reportTab: 'operations', tab: 'operations', body: 'connecting' }).restored).toBe(false);
        expect(placeOutcome({ reportTab: 'operations', tab: 'operations', body: null }).restored).toBe(false);
        expect(placeOutcome({ reportTab: 'operations', tab: 'operations', body: 'denied' }).restored).toBe(false);
        expect(placeOutcome({ reportTab: 'operations', tab: 'home', body: 'home' })).toEqual({ restored: false, landedHome: true });
        expect(placeOutcome({ reportTab: 'home', tab: 'home', body: 'home' })).toEqual({ restored: true, landedHome: false });
        expect(placeOutcome({ reportTab: null, tab: 'schedule', body: 'tab' }).restored).toBe(true);
    });
});

describe('test mode', () => {
    it('never writes or reads a place, and the flag reads off', async () => {
        vi.resetModules();
        vi.doMock('./testMode', () => ({ TEST_MODE: { name: 'T', id: 9 } }));
        localStorage.setItem('ddmau:relFlags', JSON.stringify({ flags: { placeRestore: true } }));
        const m = await import('./placeMemory');
        const f = await import('./reliabilityFlags');
        expect(f.getReliabilityFlag('placeRestore')).toBe(false);
        m.saveMainTab('T', 'operations');
        m.saveInventoryPlace('T', 'webster', { subTab: 'inventory' });
        expect(localStorage.getItem('ddmau:placeTab:T')).toBe(null);
        expect(localStorage.getItem('ddmau:placeInv:T:webster')).toBe(null);
        localStorage.setItem('ddmau:placeTab:T', JSON.stringify({ tab: 'x', at: Date.now() }));
        expect(m.readMainTab('T')).toBe(null);
        vi.doUnmock('./testMode');
        vi.resetModules();
    });
});
