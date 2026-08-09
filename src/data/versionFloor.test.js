// versionFloor.test.js — pins the fleet-floor gate (Phase 2). The two
// properties that must never regress: (1) comparison is numeric, not
// lexicographic — '1.0.9' < '1.0.10'; (2) FAIL-OPEN — garbage input can
// never block the app.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    parseVersion, isBelowMinVersion, shouldAttemptFloorReload, FLOOR_RELOAD_GUARD_MS,
} from './versionFloor';

describe('parseVersion', () => {
    it('parses plain semver-ish strings', () => {
        expect(parseVersion('1.0.390')).toEqual([1, 0, 390]);
        expect(parseVersion('2.1')).toEqual([2, 1]);
        expect(parseVersion(' 1.0.390 ')).toEqual([1, 0, 390]);
    });
    it('accepts the build display string by taking the leading token', () => {
        // __APP_VERSION__ is '1.0.390 · 9c288be' — the gate MUST parse it
        // or it is permanently dead (found during Phase 2 implementation).
        expect(parseVersion('1.0.390 · 9c288be')).toEqual([1, 0, 390]);
    });
    it('rejects garbage (null → fail-open upstream)', () => {
        expect(parseVersion('v1.0.390')).toBeNull();
        expect(parseVersion('')).toBeNull();
        expect(parseVersion(null)).toBeNull();
        expect(parseVersion('1')).toBeNull();
        expect(parseVersion('1.0.x')).toBeNull();
    });
});

describe('isBelowMinVersion', () => {
    it('compares numerically, not lexicographically', () => {
        expect(isBelowMinVersion('1.0.9', '1.0.10')).toBe(true);   // lexicographic would say false
        expect(isBelowMinVersion('1.0.390', '1.0.386')).toBe(false);
        expect(isBelowMinVersion('1.0.386', '1.0.390')).toBe(true);
        expect(isBelowMinVersion('1.0.390', '1.0.390')).toBe(false); // equal = at floor = fine
    });
    it('pads missing segments with zero', () => {
        expect(isBelowMinVersion('1.0', '1.0.1')).toBe(true);
        expect(isBelowMinVersion('1.0.0', '1.0')).toBe(false);
    });
    it('FAIL-OPEN: any unparsable side means "not below" — never block', () => {
        expect(isBelowMinVersion(null, '1.0.390')).toBe(false);
        expect(isBelowMinVersion('1.0.390', undefined)).toBe(false);
        expect(isBelowMinVersion('garbage', 'also garbage')).toBe(false);
    });
    it('display strings compare correctly on BOTH sides', () => {
        expect(isBelowMinVersion('1.0.390 · 9c288be', '1.0.391')).toBe(true);
        expect(isBelowMinVersion('1.0.391 · abc1234', '1.0.390')).toBe(false);
    });
});

describe('shouldAttemptFloorReload', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const fakeStorage = () => {
        const m = new Map();
        return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
    };

    it('allows the first attempt, blocks repeats inside the guard window', () => {
        const s = fakeStorage();
        expect(shouldAttemptFloorReload(s)).toBe(true);
        expect(shouldAttemptFloorReload(s)).toBe(false);
        expect(shouldAttemptFloorReload(s)).toBe(false);
    });
    it('allows again after the window passes', () => {
        const s = fakeStorage();
        expect(shouldAttemptFloorReload(s)).toBe(true);
        vi.setSystemTime(Date.now() + FLOOR_RELOAD_GUARD_MS + 1000);
        expect(shouldAttemptFloorReload(s)).toBe(true);
    });
    it('broken storage still permits the attempt (fail-open)', () => {
        const broken = { getItem: () => { throw new Error('nope'); }, setItem: () => {} };
        expect(shouldAttemptFloorReload(broken)).toBe(true);
    });
});
