// Regression tests for the inventory-cart stability guard — the logic that
// stops a staff member's in-progress list from disappearing when a glitchy /
// stale / offline-cache Firestore snapshot arrives, while STILL honoring a real
// Save & Reset / Clear (local or from another iPad). Locks in the fixes from
// v1.0.287 + v1.0.289 so they can never silently regress.
import { describe, it, expect } from 'vitest';
import { hasAnyCount, isRemoteClearAdvanced, shouldIgnoreInventorySnapshot } from '../inventoryStability';

describe('hasAnyCount', () => {
    it('is false for empty / missing / all-zero maps', () => {
        expect(hasAnyCount()).toBe(false);
        expect(hasAnyCount(null, undefined)).toBe(false);
        expect(hasAnyCount({})).toBe(false);
        expect(hasAnyCount({ a: 0, b: 0 })).toBe(false);
    });
    it('is true when any map has a positive quantity', () => {
        expect(hasAnyCount({ a: 0, b: 3 })).toBe(true);
        expect(hasAnyCount({}, { 'sysco:1': 2 })).toBe(true); // vendor-only cart
    });
});

describe('isRemoteClearAdvanced', () => {
    it('true only when a NEWER clearedAt than the one already applied arrives', () => {
        expect(isRemoteClearAdvanced('2026-07-14T18:00:00Z', null)).toBe(true);
        expect(isRemoteClearAdvanced('2026-07-14T18:05:00Z', '2026-07-14T18:00:00Z')).toBe(true);
    });
    it('false for the same or a missing clearedAt (a transient flicker)', () => {
        expect(isRemoteClearAdvanced('2026-07-14T18:00:00Z', '2026-07-14T18:00:00Z')).toBe(false);
        expect(isRemoteClearAdvanced(null, '2026-07-14T18:00:00Z')).toBe(false);
        expect(isRemoteClearAdvanced(undefined, null)).toBe(false);
    });
});

describe('shouldIgnoreInventorySnapshot', () => {
    // THE core protection: a transient empty snapshot must NOT wipe a cart that
    // has items on screen.
    it('IGNORES an empty snapshot over a non-empty cart (the "list disappears" flicker)', () => {
        expect(shouldIgnoreInventorySnapshot({
            incomingHasAny: false, localHasAny: true, recentlyCleared: false, remoteClearAdvanced: false,
        })).toBe(true);
    });

    // Real clears must still go through.
    it('APPLIES an empty snapshot after THIS device pressed Clear / Save & Reset', () => {
        expect(shouldIgnoreInventorySnapshot({
            incomingHasAny: false, localHasAny: true, recentlyCleared: true, remoteClearAdvanced: false,
        })).toBe(false);
    });
    it('APPLIES an empty snapshot from a genuine clear on ANOTHER iPad (newer clearedAt)', () => {
        expect(shouldIgnoreInventorySnapshot({
            incomingHasAny: false, localHasAny: true, recentlyCleared: false, remoteClearAdvanced: true,
        })).toBe(false);
    });

    // Normal traffic must always apply.
    it('APPLIES a snapshot that has items (normal edit / load)', () => {
        expect(shouldIgnoreInventorySnapshot({
            incomingHasAny: true, localHasAny: true, recentlyCleared: false, remoteClearAdvanced: false,
        })).toBe(false);
    });
    it('APPLIES an empty snapshot when the local cart is ALSO empty (nothing to protect)', () => {
        expect(shouldIgnoreInventorySnapshot({
            incomingHasAny: false, localHasAny: false, recentlyCleared: false, remoteClearAdvanced: false,
        })).toBe(false);
    });
});
