import { describe, it, expect, beforeEach } from 'vitest';
import { registerReloadStash, runReloadStashes, takeReloadStash, peekReloadStash, peekReloadStashMeta, clearReloadStash, planStashRehydrate, STASH_MAX_AGE_MS, resolveLostHolds } from './reloadStash';

beforeEach(() => { sessionStorage.clear(); });

describe('reloadStash round trip', () => {
    it('registers, runs, and takes back a stash exactly once', () => {
        const un = registerReloadStash('inventory', () => ({ loc: 'webster', counts: { eggs: 3 } }));
        expect(runReloadStashes('test')).toEqual(['inventory']);
        expect(takeReloadStash('inventory')).toEqual({ loc: 'webster', counts: { eggs: 3 } });
        expect(takeReloadStash('inventory')).toBeNull(); // consumed
        un();
        expect(runReloadStashes('test')).toEqual([]);
    });
    it('expires an old stash', () => {
        registerReloadStash('x', () => ({ a: 1 }));
        runReloadStashes();
        expect(takeReloadStash('x', { now: Date.now() + STASH_MAX_AGE_MS + 1 })).toBeNull();
    });
    it('a throwing snapshot function or broken storage never throws', () => {
        registerReloadStash('bad', () => { throw new Error('boom'); });
        expect(() => runReloadStashes()).not.toThrow();
        sessionStorage.setItem('ddmau:reloadStash:junk', '{not json');
        expect(takeReloadStash('junk')).toBeNull();
    });
});

describe('planStashRehydrate', () => {
    const stash = { loc: 'webster', counts: { eggs: 3, milk: 0 }, countMeta: { eggs: { by: 'A' } }, pendingCounts: { eggs: { expected: 3, ts: 1, mode: 'inc' } }, subTab: 'inventory' };
    it('rebuilds counts/meta and turns pending ids into abs holds flagged saving', () => {
        const plan = planStashRehydrate(stash, { loc: 'webster', now: 1000 });
        expect(plan.counts).toEqual({ eggs: 3, milk: 0 });
        expect(plan.countMeta).toEqual({ eggs: { by: 'A' } });
        expect(plan.pending).toEqual({ eggs: { expected: 3, ts: 1000, mode: 'inc' } });
        expect(planStashRehydrate({ ...stash, pendingCounts: { eggs: { expected: 3, ts: 1, mode: 'abs' } } }, { loc: 'webster', now: 1 }).pending.eggs.mode).toBe('abs');
        expect(plan.savingIds).toEqual(['eggs']);
        expect(plan.subTab).toBe('inventory');
        expect(plan.clearedAt).toBeNull();
        expect(planStashRehydrate({ ...stash, clearedAt: '2026-09-09T10:00:00Z' }, { loc: 'webster' }).clearedAt).toBe('2026-09-09T10:00:00Z');
    });
    it('rejects another store or garbage', () => {
        expect(planStashRehydrate(stash, { loc: 'maryland' })).toBeNull();
        expect(planStashRehydrate(null, { loc: 'webster' })).toBeNull();
        expect(planStashRehydrate({ loc: 'webster' }, { loc: 'webster' })).toEqual({ counts: {}, countMeta: {}, pending: {}, savingIds: [], lostIds: [], lost: {}, subTab: null, clearedAt: null });
    });
});

describe('peek / clear', () => {
    it('peek leaves the stash in place; clear removes it', () => {
        registerReloadStash('inv', () => ({ loc: 'webster' }));
        runReloadStashes();
        expect(peekReloadStash('inv')).toEqual({ loc: 'webster' });
        expect(peekReloadStash('inv')).toEqual({ loc: 'webster' });
        clearReloadStash('inv');
        expect(peekReloadStash('inv')).toBeNull();
    });
});

describe('peekReloadStashMeta', () => {
    it('exposes the reason a stash was written', () => {
        registerReloadStash('m', () => ({ a: 1 }));
        runReloadStashes('fs-heal-wiped');
        expect(peekReloadStashMeta('m').reason).toBe('fs-heal-wiped');
        expect(peekReloadStashMeta('nope')).toBeNull();
    });
});

describe('wiped rehydrate (crash heal destroyed the queue)', () => {
    const stash = { loc: 'webster', counts: { eggs: 3, milk: 2 }, countMeta: { eggs: { by: 'A' } }, pendingCounts: { eggs: { expected: 3, ts: 1, mode: 'inc' } } };
    it('drops the lost ids from counts/meta, holds nothing, reports lostIds', () => {
        const plan = planStashRehydrate(stash, { loc: 'webster', now: 5, wiped: true });
        expect(plan.counts).toEqual({ milk: 2 });
        expect(plan.countMeta).toEqual({});
        expect(plan.pending).toEqual({});
        expect(plan.savingIds).toEqual([]);
        expect(plan.lostIds).toEqual(['eggs']);
        // …and what each lost hold expected, so the page can check the server
        expect(plan.lost).toEqual({ eggs: { expected: 3, mode: 'inc' } });
    });
    it('non-wiped plan is unchanged', () => {
        const plan = planStashRehydrate(stash, { loc: 'webster', now: 5 });
        expect(plan.counts).toEqual({ eggs: 3, milk: 2 });
        expect(plan.lostIds).toEqual([]);
        expect(plan.savingIds).toEqual(['eggs']);
    });
});


describe('resolveLostHolds (r3: a wiped hold may already have landed)', () => {
    it("'inc' landed when server >= expected; 'abs' only on an exact match; missing = 0", () => {
        const lost = { eggs: { expected: 3, mode: 'inc' }, milk: { expected: 2, mode: 'abs' }, bread: { expected: 1, mode: 'inc' }, rice: { expected: 0, mode: 'abs' } };
        expect(resolveLostHolds(lost, { eggs: 4, milk: 1, bread: 0 })).toEqual({ landedIds: ['eggs', 'rice'], lostIds: ['milk', 'bread'] });
        expect(resolveLostHolds(lost, { eggs: 3, milk: 2, bread: 1, rice: 0 }).lostIds).toEqual([]);
    });
    it('tolerates garbage', () => {
        expect(resolveLostHolds(null, {})).toEqual({ landedIds: [], lostIds: [] });
        expect(resolveLostHolds({ x: { expected: 'nope' } }, null)).toEqual({ landedIds: [], lostIds: [] });
    });
});
