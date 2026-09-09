import { describe, it, expect } from 'vitest';
import { reconcileCounts, reconcileCountsDetailed, RELEASE_TIMEOUT_MS } from './inventoryReconcile';

describe('reconcileCountsDetailed', () => {
    it('reports ids the 12 s valve released without confirmation, keeps the rest held', () => {
        const pending = { eggs: { expected: 5, ts: 0, mode: 'inc' }, milk: { expected: 2, ts: 10_000, mode: 'abs' } };
        const r = reconcileCountsDetailed({ eggs: 3, milk: 1 }, pending, RELEASE_TIMEOUT_MS + 1);
        expect(r.expiredIds).toEqual(['eggs']);
        expect(r.counts).toEqual({ eggs: 3, milk: 2 }); // eggs released to server value; milk still held
        expect(pending.eggs).toBeUndefined();
        expect(pending.milk).toBeDefined();
    });
    it('a confirmed id is not "expired" even if old', () => {
        const pending = { eggs: { expected: 5, ts: 0, mode: 'inc' } };
        const r = reconcileCountsDetailed({ eggs: 6 }, pending, RELEASE_TIMEOUT_MS + 1);
        expect(r.expiredIds).toEqual([]);
        expect(r.counts).toEqual({ eggs: 6 });
    });
    it('matches reconcileCounts for the merged map', () => {
        const p1 = { a: { expected: 2, ts: 0, mode: 'abs' } }, p2 = { a: { expected: 2, ts: 0, mode: 'abs' } };
        expect(reconcileCountsDetailed({ a: 1 }, p1, 100).counts).toEqual(reconcileCounts({ a: 1 }, p2, 100));
    });
});

describe('confirmedIds', () => {
    it('reports inc (>=) and abs (===) confirmations, never an expired-unconfirmed id', () => {
        const pending = { a: { expected: 5, ts: 0, mode: 'inc' }, b: { expected: 2, ts: 0, mode: 'abs' }, c: { expected: 9, ts: 0, mode: 'abs' } };
        const r = reconcileCountsDetailed({ a: 6, b: 2, c: 1 }, pending, RELEASE_TIMEOUT_MS + 1);
        expect(r.confirmedIds.sort()).toEqual(['a', 'b']);
        expect(r.expiredIds).toEqual(['c']);
    });
});

describe('return shape is stable on every path (the listener destructures all three)', () => {
    it('empty and undefined pending', () => {
        expect(reconcileCountsDetailed({ a: 1 }, {}, 0)).toEqual({ counts: { a: 1 }, expiredIds: [], confirmedIds: [] });
        expect(reconcileCountsDetailed({ a: 1 }, undefined, 0)).toEqual({ counts: { a: 1 }, expiredIds: [], confirmedIds: [] });
        const { expiredIds, confirmedIds } = reconcileCountsDetailed({}, {}, 0);
        expect(expiredIds.length || confirmedIds.length).toBe(0); // mirrors the Operations.jsx consumer
    });
});

