import { describe, it, expect } from 'vitest';
import { tvConfigIsStale, mayReloadForStale, STALE_RELOAD_GAP_MS } from './tvStaleConfig';

describe('tvConfigIsStale', () => {
    it('newer published version on the server = stale (the webster-photos v48 case)', () => {
        expect(tvConfigIsStale({ publishedVersion: 47 }, { publishedVersion: 48 })).toBe(true);
    });
    it('same or older version is never stale (no reload loops)', () => {
        expect(tvConfigIsStale({ publishedVersion: 48 }, { publishedVersion: 48 })).toBe(false);
        expect(tvConfigIsStale({ publishedVersion: 49 }, { publishedVersion: 48 })).toBe(false);
    });
    it('falls back to publish / update times for unversioned docs', () => {
        expect(tvConfigIsStale({ updatedAt: '2026-07-01T00:00:00Z' }, { updatedAt: '2026-09-28T00:00:00Z' })).toBe(true);
        expect(tvConfigIsStale({ updatedAt: '2026-09-28T00:00:00Z' }, { updatedAt: '2026-09-28T00:00:00Z' })).toBe(false);
        expect(tvConfigIsStale({ updatedAt: { seconds: 2000000000 } }, { updatedAt: '2026-09-28T00:00:00Z' })).toBe(false);
    });
    it('no server doc = nothing to do; nothing on screen yet = take the server copy', () => {
        expect(tvConfigIsStale({ publishedVersion: 3 }, null)).toBe(false);
        expect(tvConfigIsStale(null, { publishedVersion: 1 })).toBe(true);
    });
});

describe('mayReloadForStale', () => {
    it('allows one reload per 20 minutes', () => {
        const now = 1_000_000_000;
        expect(mayReloadForStale(null, now)).toBe(true);
        expect(mayReloadForStale(now - 60_000, now)).toBe(false);
        expect(mayReloadForStale(now - STALE_RELOAD_GAP_MS, now)).toBe(true);
    });
});
