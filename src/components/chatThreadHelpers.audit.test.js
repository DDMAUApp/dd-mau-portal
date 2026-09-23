// 2026-09-23 chat audit — pure helpers behind M4 (server-driven pin banner)
// and M2 (per-conversation notification sweep throttle).
import { describe, it, expect } from 'vitest';
import { sortPinsForBanner, planNotifSweepDelay, needsFollowUpNotifSweep } from './chatThreadHelpers';

const ts = (seconds) => ({ seconds, toMillis() { return seconds * 1000; } });

describe('sortPinsForBanner (M4)', () => {
    it('orders oldest→newest by message createdAt so [length-1] is the newest pin', () => {
        const out = sortPinsForBanner([
            { id: 'b', pinned: true, createdAt: ts(200) },
            { id: 'a', pinned: true, createdAt: ts(100) },
            { id: 'c', pinned: true, createdAt: { seconds: 300 } }, // warm-cache shape
        ]);
        expect(out.map(p => p.id)).toEqual(['a', 'b', 'c']);
    });
    it('drops soft-deleted and unpinned entries (drawer parity)', () => {
        const out = sortPinsForBanner([
            { id: 'a', pinned: true, createdAt: ts(100) },
            { id: 'd', pinned: true, deleted: true, createdAt: ts(150) },
            { id: 'u', pinned: false, createdAt: ts(160) },
        ]);
        expect(out.map(p => p.id)).toEqual(['a']);
    });
    it('a pending local message (no createdAt yet) sorts as newest', () => {
        const out = sortPinsForBanner([
            { id: 'p', pinned: true, createdAt: null },
            { id: 'a', pinned: true, createdAt: ts(100) },
        ]);
        expect(out.map(p => p.id)).toEqual(['a', 'p']);
    });
    it('counts pins outside any message window — the cap sees all of them', () => {
        const many = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, pinned: true, createdAt: ts(i + 1) }));
        expect(sortPinsForBanner(many)).toHaveLength(5);
    });
    it('does not mutate its input and tolerates junk', () => {
        const input = [{ id: 'b', pinned: true, createdAt: ts(2) }, { id: 'a', pinned: true, createdAt: ts(1) }];
        const copy = JSON.stringify(input);
        sortPinsForBanner(input);
        expect(JSON.stringify(input)).toBe(copy);
        expect(sortPinsForBanner(null)).toEqual([]);
        expect(sortPinsForBanner([null, {}, { id: 'x' }])).toEqual([]);
    });
});

describe('notification sweep throttle (M2)', () => {
    it('first sweep waits the settle window (the CF writes the notif a beat later)', () => {
        expect(planNotifSweepDelay({ now: 1_000_000, lastSweepAt: 0 })).toBe(4000);
    });
    it('caps the rate: next sweep no sooner than 15s after the previous one', () => {
        expect(planNotifSweepDelay({ now: 1_005_000, lastSweepAt: 1_000_000 })).toBe(10_000);
    });
    it('never goes below the settle window even long after the last sweep', () => {
        expect(planNotifSweepDelay({ now: 2_000_000, lastSweepAt: 1_000_000 })).toBe(4000);
    });
    it('the request that armed a sweep does not by itself trigger a follow-up', () => {
        const requestAt = 1_000_000;
        const firedAt = requestAt + planNotifSweepDelay({ now: requestAt, lastSweepAt: 0 });
        expect(needsFollowUpNotifSweep({ firedAt, lastRequestAt: requestAt })).toBe(false);
    });
    it('a request inside the settle window before firing (or during the sweep) needs a follow-up', () => {
        expect(needsFollowUpNotifSweep({ firedAt: 1_010_000, lastRequestAt: 1_008_000 })).toBe(true);
        expect(needsFollowUpNotifSweep({ firedAt: 1_010_000, lastRequestAt: 1_010_500 })).toBe(true);
    });
});
