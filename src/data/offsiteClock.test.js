// Tests for the off-site clock-in helpers.
//
// The pure helpers (offsitePromptKind + snooze store + format) are
// what really need pinning — they decide which modal shows and when.
// We don't test Firestore round-trips here; those are exercised by
// the live admin/staff flows.

import { describe, it, expect, beforeEach } from 'vitest';
import {
    OFFSITE_STATUS,
    offsitePromptKind,
    snoozeOffsitePrompt,
    isOffsitePromptSnoozed,
    clearAllOffsiteSnoozes,
    formatOffsiteWhen,
} from './offsiteClock';

// vitest's happy-dom env gives us localStorage; we wipe it between
// tests so snooze state doesn't leak.
beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.clear();
});

describe('offsitePromptKind', () => {
    const fakeTs = (ms) => ({ toMillis: () => ms });
    const now = 1_700_000_000_000;

    it('completed → done', () => {
        expect(offsitePromptKind({ status: OFFSITE_STATUS.COMPLETED }, now)).toBe('done');
    });
    it('cancelled → done', () => {
        expect(offsitePromptKind({ status: OFFSITE_STATUS.CANCELLED }, now)).toBe('done');
    });
    it('active → clock_out', () => {
        expect(offsitePromptKind({ status: OFFSITE_STATUS.ACTIVE }, now)).toBe('clock_out');
    });
    it('pending + arrival 1h away → clock_in_soon', () => {
        const shift = {
            status: OFFSITE_STATUS.PENDING,
            scheduledArrivalAt: fakeTs(now + 60 * 60_000),
        };
        expect(offsitePromptKind(shift, now)).toBe('clock_in_soon');
    });
    it('pending + arrival within 15 min → clock_in_now', () => {
        const shift = {
            status: OFFSITE_STATUS.PENDING,
            scheduledArrivalAt: fakeTs(now + 10 * 60_000),
        };
        expect(offsitePromptKind(shift, now)).toBe('clock_in_now');
    });
    it('pending + arrival in the past → clock_in_now', () => {
        const shift = {
            status: OFFSITE_STATUS.PENDING,
            scheduledArrivalAt: fakeTs(now - 60 * 60_000),
        };
        expect(offsitePromptKind(shift, now)).toBe('clock_in_now');
    });
    it('pending + no arrival timestamp → clock_in_now (fail-open)', () => {
        const shift = { status: OFFSITE_STATUS.PENDING };
        expect(offsitePromptKind(shift, now)).toBe('clock_in_now');
    });
    it('null shift → done', () => {
        expect(offsitePromptKind(null, now)).toBe('done');
    });
});

describe('snooze store', () => {
    it('snoozeOffsitePrompt + isOffsitePromptSnoozed round-trips', () => {
        const now = 1_700_000_000_000;
        snoozeOffsitePrompt('shift_1', now);
        expect(isOffsitePromptSnoozed('shift_1', now + 5 * 60_000)).toBe(true);   // still within TTL
        expect(isOffsitePromptSnoozed('shift_1', now + 11 * 60_000)).toBe(false); // past TTL
    });
    it('unknown shift id is never snoozed', () => {
        expect(isOffsitePromptSnoozed('never_set')).toBe(false);
    });
    it('missing shiftId is a no-op', () => {
        // Don't throw, don't write anything.
        snoozeOffsitePrompt(null);
        snoozeOffsitePrompt('');
        expect(isOffsitePromptSnoozed(null)).toBe(false);
    });
    it('clearAllOffsiteSnoozes wipes every shift', () => {
        const now = 1_700_000_000_000;
        snoozeOffsitePrompt('a', now);
        snoozeOffsitePrompt('b', now);
        snoozeOffsitePrompt('c', now);
        // A non-offsite key should NOT be touched.
        localStorage.setItem('ddmau:unrelated', 'keep_me');
        clearAllOffsiteSnoozes();
        expect(isOffsitePromptSnoozed('a', now)).toBe(false);
        expect(isOffsitePromptSnoozed('b', now)).toBe(false);
        expect(isOffsitePromptSnoozed('c', now)).toBe(false);
        expect(localStorage.getItem('ddmau:unrelated')).toBe('keep_me');
    });
});

describe('formatOffsiteWhen', () => {
    it('renders something for a valid Timestamp shape', () => {
        const ts = { toMillis: () => new Date('2026-06-15T18:30:00').getTime() };
        const out = formatOffsiteWhen(ts, 'en-US');
        // Result string varies by environment locale data, but must
        // include the day-of-week + month + day + a time value.
        expect(out.length).toBeGreaterThan(8);
        expect(out).toMatch(/Jun|Jun\.?/);
    });
    it('empty timestamp returns empty string', () => {
        expect(formatOffsiteWhen(null)).toBe('');
        expect(formatOffsiteWhen({})).toBe('');
        expect(formatOffsiteWhen({ toMillis: () => 0 })).toBe('');
    });
    it('accepts the legacy {seconds} shape', () => {
        const out = formatOffsiteWhen({ seconds: 1_700_000_000 }, 'en-US');
        expect(out.length).toBeGreaterThan(8);
    });
});

describe('OFFSITE_STATUS', () => {
    it('exposes the four canonical statuses', () => {
        expect(OFFSITE_STATUS.PENDING).toBe('pending');
        expect(OFFSITE_STATUS.ACTIVE).toBe('active');
        expect(OFFSITE_STATUS.COMPLETED).toBe('completed');
        expect(OFFSITE_STATUS.CANCELLED).toBe('cancelled');
    });
    it('is frozen — no accidental mutation', () => {
        expect(() => { OFFSITE_STATUS.PENDING = 'foo'; }).toThrow();
    });
});
