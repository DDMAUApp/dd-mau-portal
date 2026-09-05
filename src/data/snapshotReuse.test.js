import { describe, it, expect } from 'vitest';
import { reuseSnapshotDocs } from './snapshotReuse';

const order = (id, extra = {}) => ({
    id,
    orderNumber: id.toUpperCase(),
    status: 'CLOSED',
    itemCount: 2,
    items: [
        { name: 'Egg Rolls', qty: 1, modifiers: ['Peanut Sauce'] },
        { name: 'Half Tray Chicken', qty: 1, modifiers: [] },
    ],
    createdDate: '2026-09-05T17:00:00.000Z',
    syncedAt: '2026-09-05T17:01:00+00:00',
    ...extra,
});

describe('reuseSnapshotDocs', () => {
    it('returns the previous ARRAY identity when only ignored fields changed', () => {
        const prev = [order('a'), order('b')];
        const next = [
            order('a', { syncedAt: '2026-09-05T17:02:00+00:00' }),
            order('b', { syncedAt: '2026-09-05T17:02:00+00:00' }),
        ];
        expect(reuseSnapshotDocs(prev, next)).toBe(prev);
    });

    it('returns the previous array identity for a byte-identical snapshot', () => {
        const prev = [order('a')];
        expect(reuseSnapshotDocs(prev, [order('a')])).toBe(prev);
    });

    it('keeps unchanged doc OBJECT identity when another doc changed', () => {
        const prev = [order('a'), order('b')];
        const next = [order('a'), order('b', { status: 'VOID' })];
        const out = reuseSnapshotDocs(prev, next);
        expect(out).not.toBe(prev);
        expect(out[0]).toBe(prev[0]);       // reused
        expect(out[1]).toBe(next[1]);       // replaced
        expect(out[1].status).toBe('VOID');
    });

    it('detects a nested change inside items (modifier edit)', () => {
        const prev = [order('a')];
        const next = [order('a')];
        next[0].items[0].modifiers = ['Sweet Chili'];
        const out = reuseSnapshotDocs(prev, next);
        expect(out[0]).toBe(next[0]);
    });

    it('handles a new doc arriving (new order) — new array, old rows reused', () => {
        const prev = [order('b')];
        const next = [order('c', { createdDate: '2026-09-05T18:00:00.000Z' }), order('b')];
        const out = reuseSnapshotDocs(prev, next);
        expect(out).not.toBe(prev);
        expect(out).toHaveLength(2);
        expect(out[0]).toBe(next[0]);
        expect(out[1]).toBe(prev[0]);
    });

    it('handles a doc disappearing (void/delete)', () => {
        const prev = [order('a'), order('b')];
        const next = [order('a')];
        const out = reuseSnapshotDocs(prev, next);
        expect(out).not.toBe(prev);
        expect(out).toHaveLength(1);
        expect(out[0]).toBe(prev[0]);
    });

    it('reorder alone produces a new array with reused objects', () => {
        const prev = [order('a'), order('b')];
        const next = [order('b'), order('a')];
        const out = reuseSnapshotDocs(prev, next);
        expect(out).not.toBe(prev);
        expect(out[0]).toBe(prev[1]);
        expect(out[1]).toBe(prev[0]);
    });

    it('empty prev returns next as-is', () => {
        const next = [order('a')];
        expect(reuseSnapshotDocs([], next)).toBe(next);
        expect(reuseSnapshotDocs(null, next)).toBe(next);
    });

    it('a field added or removed counts as a change', () => {
        const prev = [order('a')];
        const withNote = [order('a', { specialInstructions: 'no peanuts' })];
        expect(reuseSnapshotDocs(prev, withNote)[0]).toBe(withNote[0]);
        const out2 = reuseSnapshotDocs(withNote, [order('a')]);
        expect(out2[0]).not.toBe(withNote[0]);
    });

    it('custom ignore list', () => {
        const prev = [order('a')];
        const next = [order('a', { syncedAt: 'x', updatedAt: 'y' })];
        // default ignore only covers syncedAt → updatedAt addition = change
        expect(reuseSnapshotDocs(prev, next)[0]).toBe(next[0]);
        const prev2 = [order('a', { updatedAt: 'z' })];
        expect(reuseSnapshotDocs(prev2, next, ['syncedAt', 'updatedAt'])).toBe(prev2);
    });

    it('null vs missing values are not equal', () => {
        const prev = [order('a', { phone: null })];
        const next = [order('a')];
        expect(reuseSnapshotDocs(prev, next)[0]).toBe(next[0]);
    });
});
