import { describe, it, expect } from 'vitest';
import { shouldApplyInventorySnapshot, shouldIgnoreInventorySnapshot, hasAnyCount, isServerConfirmedSnapshot } from './inventoryStability';

describe('shouldApplyInventorySnapshot — admission truth table', () => {
    const t = (o) => shouldApplyInventorySnapshot(o);
    it('cold sheet + pending + cache (post-reload backlog) → APPLY, not synced', () => {
        expect(t({ hasPendingWrites: true, fromCache: true, serverSynced: false, localHasAny: false })).toEqual({ apply: true, markSynced: false });
    });
    it('warm sheet + pending → skip (2026-06-30 mid-burst flicker guard)', () => {
        expect(t({ hasPendingWrites: true, fromCache: true, serverSynced: false, localHasAny: true })).toEqual({ apply: false, markSynced: false });
        expect(t({ hasPendingWrites: true, fromCache: false, serverSynced: true, localHasAny: false })).toEqual({ apply: false, markSynced: false });
    });
    it('synced + cache echo → skip', () => {
        expect(t({ hasPendingWrites: false, fromCache: true, serverSynced: true, localHasAny: true })).toEqual({ apply: false, markSynced: false });
    });
    it('clean server snapshot → apply + markSynced', () => {
        expect(t({ hasPendingWrites: false, fromCache: false, serverSynced: false, localHasAny: false })).toEqual({ apply: true, markSynced: true });
        expect(t({ hasPendingWrites: false, fromCache: false, serverSynced: true, localHasAny: true })).toEqual({ apply: true, markSynced: true });
    });
    it('first cache paint on a cold sheet → apply, not synced', () => {
        expect(t({ hasPendingWrites: false, fromCache: true, serverSynced: false, localHasAny: false })).toEqual({ apply: true, markSynced: false });
    });
    it('cold + server + pending (another tab queued a write) → apply, not synced', () => {
        expect(t({ hasPendingWrites: true, fromCache: false, serverSynced: false, localHasAny: false })).toEqual({ apply: true, markSynced: false });
    });
});

describe('existing guards still hold', () => {
    it('empty snapshot over a non-empty cart is ignored unless a clear explains it', () => {
        expect(shouldIgnoreInventorySnapshot({ incomingHasAny: false, localHasAny: true, recentlyCleared: false, remoteClearAdvanced: false })).toBe(true);
        expect(shouldIgnoreInventorySnapshot({ incomingHasAny: false, localHasAny: true, recentlyCleared: true, remoteClearAdvanced: false })).toBe(false);
    });
    it('hasAnyCount', () => { expect(hasAnyCount({ a: 0 }, { b: 2 })).toBe(true); expect(hasAnyCount({}, null)).toBe(false); });
});

describe('M2 — an emptied cart propagates when the server confirms it', () => {
    const base = { incomingHasAny: false, localHasAny: true, recentlyCleared: false, remoteClearAdvanced: false };
    it('server-confirmed empty snapshot after first sync → applied (cart emptied by − taps elsewhere)', () => {
        expect(shouldIgnoreInventorySnapshot({ ...base, serverConfirmed: true })).toBe(false);
    });
    it('empty CACHE echo is still ignored', () => {
        const serverConfirmed = isServerConfirmedSnapshot({ fromCache: true, hasPendingWrites: false, syncedBefore: true });
        expect(serverConfirmed).toBe(false);
        expect(shouldIgnoreInventorySnapshot({ ...base, serverConfirmed })).toBe(true);
    });
    it('first server snapshot after a (re)load is still guarded', () => {
        const serverConfirmed = isServerConfirmedSnapshot({ fromCache: false, hasPendingWrites: false, syncedBefore: false });
        expect(serverConfirmed).toBe(false);
        expect(shouldIgnoreInventorySnapshot({ ...base, serverConfirmed })).toBe(true);
    });
    it('pending-write snapshot is not server-confirmed', () => {
        expect(isServerConfirmedSnapshot({ fromCache: false, hasPendingWrites: true, syncedBefore: true })).toBe(false);
        expect(isServerConfirmedSnapshot({ fromCache: false, hasPendingWrites: false, syncedBefore: true })).toBe(true);
    });
    it('omitting serverConfirmed keeps the old behavior', () => {
        expect(shouldIgnoreInventorySnapshot(base)).toBe(true);
    });
});
