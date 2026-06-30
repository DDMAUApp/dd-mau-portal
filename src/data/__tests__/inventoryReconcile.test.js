import { describe, it, expect } from 'vitest';
import { reconcileCounts, RELEASE_TIMEOUT_MS } from '../inventoryReconcile';

const T0 = 1_000_000; // fixed "now" base for deterministic ts math

describe('reconcileCounts', () => {
    it('passes the server map through untouched when nothing is pending', () => {
        const server = { a: 3, b: 0 };
        const pending = {};
        expect(reconcileCounts(server, pending, T0)).toBe(server); // same ref, no copy
        expect(pending).toEqual({});
    });

    it('inc: HOLDS the optimistic value when the snapshot is stale (server < expected)', () => {
        // User tapped + (0 -> 1) via increment; a stale snapshot still says 0.
        const pending = { a: { expected: 1, ts: T0, mode: 'inc' } };
        const out = reconcileCounts({ a: 0 }, pending, T0 + 500);
        expect(out.a).toBe(1);                // no visible revert
        expect(pending.a).toBeTruthy();       // still waiting on the server
    });

    it('inc: RELEASES when the server has caught up (server === expected)', () => {
        const pending = { a: { expected: 1, ts: T0, mode: 'inc' } };
        const out = reconcileCounts({ a: 1 }, pending, T0 + 800);
        expect(out.a).toBe(1);
        expect(pending.a).toBeUndefined();    // released
    });

    it('inc: RELEASES and accepts a higher value when another device also added (server > expected)', () => {
        // We bumped to 1; a concurrent device bumped too, server is now 2.
        const pending = { a: { expected: 1, ts: T0, mode: 'inc' } };
        const out = reconcileCounts({ a: 2 }, pending, T0 + 800);
        expect(out.a).toBe(2);                // take the higher concurrent total
        expect(pending.a).toBeUndefined();
    });

    it('abs (decrement): HOLDS the lowered value against a stale higher snapshot', () => {
        // User tapped − (1 -> 0), written as absolute 0; stale snapshot still says 1.
        const pending = { a: { expected: 0, ts: T0, mode: 'abs' } };
        const out = reconcileCounts({ a: 1 }, pending, T0 + 500);
        expect(out.a).toBe(0);                // decrement is not undone
        expect(pending.a).toBeTruthy();
    });

    it('abs: RELEASES only on an EXACT match', () => {
        const pending = { a: { expected: 4, ts: T0, mode: 'abs' } };
        // server overshoots/undershoots → keep holding
        expect(reconcileCounts({ a: 5 }, { ...pending }, T0 + 500).a).toBe(4);
        expect(reconcileCounts({ a: 3 }, { ...pending }, T0 + 500).a).toBe(4);
        // exact → release
        const p2 = { a: { expected: 4, ts: T0, mode: 'abs' } };
        const out = reconcileCounts({ a: 4 }, p2, T0 + 500);
        expect(out.a).toBe(4);
        expect(p2.a).toBeUndefined();
    });

    it('safety valve: a never-confirmed bump RELEASES after the timeout', () => {
        // Write failed / conflicting; server never reaches expected.
        const pending = { a: { expected: 9, ts: T0, mode: 'abs' } };
        const out = reconcileCounts({ a: 2 }, pending, T0 + RELEASE_TIMEOUT_MS + 1);
        expect(out.a).toBe(2);                // accept server reality after timeout
        expect(pending.a).toBeUndefined();
    });

    it('does not mutate or hold items that have no pending bump', () => {
        const pending = { a: { expected: 1, ts: T0, mode: 'inc' } };
        const out = reconcileCounts({ a: 0, b: 7 }, pending, T0 + 100);
        expect(out.a).toBe(1); // held
        expect(out.b).toBe(7); // straight from server
    });

    it('handles a mixed burst: some held, some released, in one snapshot', () => {
        const pending = {
            held:     { expected: 3, ts: T0, mode: 'inc' }, // server lags
            released: { expected: 2, ts: T0, mode: 'inc' }, // server caught up
            decr:     { expected: 0, ts: T0, mode: 'abs' }, // stale higher
        };
        const out = reconcileCounts({ held: 1, released: 2, decr: 5 }, pending, T0 + 600);
        expect(out).toEqual({ held: 3, released: 2, decr: 0 });
        expect(pending.held).toBeTruthy();
        expect(pending.released).toBeUndefined();
        expect(pending.decr).toBeTruthy();
    });

    it('never lowers a freshly incremented count even if the server snapshot is empty', () => {
        // The exact reported symptom: tap + on 4 items, a stale snapshot drops them all.
        const pending = {
            i0: { expected: 1, ts: T0, mode: 'inc' },
            i1: { expected: 1, ts: T0, mode: 'inc' },
            i2: { expected: 1, ts: T0, mode: 'inc' },
            i3: { expected: 1, ts: T0, mode: 'inc' },
        };
        const out = reconcileCounts({}, pending, T0 + 300); // server map has none of them yet
        expect(out).toEqual({ i0: 1, i1: 1, i2: 1, i3: 1 });
    });
});
