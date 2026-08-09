// scheduleConflicts.test.js — the conflict engine against the golden
// dataset (Phase 1, SCHEDULING-FORENSICS.md §13). The mixed time_off
// schema cases here pin the bug family that shipped three times
// (QA-audit S1 2026-06-20, myPto v1.0.385, and the original subscription
// drop) — legacy `date`-only docs MUST behave identically to
// startDate/endDate docs in every guard.

import { describe, it, expect } from 'vitest';
import {
    checkAvailabilityConflict, staffOffOn, partialOffWindows,
    shiftOverlapsPartialOff, computeScheduleConflicts,
} from './scheduleConflicts';
import { GOLDEN_STAFF, GOLDEN_SHIFTS, GOLDEN_TIME_OFF } from './__fixtures__/goldenSchedule';

const byName = (n) => GOLDEN_STAFF.find(s => s.name === n);

// ── Availability ───────────────────────────────────────────────────────────

describe('checkAvailabilityConflict', () => {
    it('flags a marked-off day (Ana is off Sundays)', () => {
        expect(checkAvailabilityConflict(byName('Ana Torres'), '2026-08-09', '10:00', '15:00'))
            .toEqual({ type: 'off' });
    });
    it('flags a shift outside a constrained window (Omar: Fri 3–8 only, golden s11)', () => {
        const c = checkAvailabilityConflict(byName('Omar Haddad'), '2026-08-14', '10:00', '15:00');
        expect(c).toEqual({ type: 'outside', from: '15:00', to: '20:00' });
    });
    it('passes a shift inside the window (Ana Mon 10–4, shift 10–3)', () => {
        expect(checkAvailabilityConflict(byName('Ana Torres'), '2026-08-10', '10:00', '15:00')).toBeNull();
    });
    it('default-wide availability never warns — explicit 09:00–21:00 or absent day both count', () => {
        // Iris explicitly set the modal defaults for Wednesday → not "constrained".
        expect(checkAvailabilityConflict(byName('Iris Novak'), '2026-08-12', '08:00', '22:00')).toBeNull();
        // Ben has {} availability → no day entry → null.
        expect(checkAvailabilityConflict(byName('Ben Carter'), '2026-08-10', '06:00', '23:00')).toBeNull();
    });
    it('survives missing inputs', () => {
        expect(checkAvailabilityConflict(null, '2026-08-10', '10:00', '15:00')).toBeNull();
        expect(checkAvailabilityConflict(byName('Ana Torres'), '', '10:00', '15:00')).toBeNull();
        expect(checkAvailabilityConflict(byName('Ana Torres'), '2026-08-10', '', '15:00')).toBeNull();
    });
});

// ── Whole-day off (mixed schema!) ─────────────────────────────────────────

describe('staffOffOn', () => {
    it('covers every day of an approved multi-day range, and none outside it', () => {
        expect(staffOffOn(GOLDEN_TIME_OFF, 'Gia Chen', '2026-08-11')).toBe(true);
        expect(staffOffOn(GOLDEN_TIME_OFF, 'Gia Chen', '2026-08-12')).toBe(true);
        expect(staffOffOn(GOLDEN_TIME_OFF, 'Gia Chen', '2026-08-13')).toBe(true);
        expect(staffOffOn(GOLDEN_TIME_OFF, 'Gia Chen', '2026-08-10')).toBe(false);
        expect(staffOffOn(GOLDEN_TIME_OFF, 'Gia Chen', '2026-08-14')).toBe(false);
    });
    it('PENDING counts as off (deliberate: never schedule over a request in review)', () => {
        expect(staffOffOn(GOLDEN_TIME_OFF, 'Iris Novak', '2026-08-14')).toBe(true);
    });
    it('DENIED never counts', () => {
        expect(staffOffOn(GOLDEN_TIME_OFF, 'Ben Carter', '2026-08-12')).toBe(false);
    });
    it('LEGACY bare-`date` docs behave identically (the 3× shipped bug family)', () => {
        expect(staffOffOn(GOLDEN_TIME_OFF, 'Hugo Reyes', '2026-08-13')).toBe(true);
        expect(staffOffOn(GOLDEN_TIME_OFF, 'Hugo Reyes', '2026-08-12')).toBe(false);
    });
    it('a PARTIAL window does NOT take the whole day off — they stay schedulable', () => {
        expect(staffOffOn(GOLDEN_TIME_OFF, 'Ana Torres', '2026-08-14')).toBe(false);
    });
    it('empty/absent list is safely "not off"', () => {
        expect(staffOffOn([], 'Ana Torres', '2026-08-14')).toBe(false);
        expect(staffOffOn(null, 'Ana Torres', '2026-08-14')).toBe(false);
    });
});

describe('partial windows + soft overlap warning', () => {
    it('finds Ana’s Friday 3–8 window on the right person/day only', () => {
        expect(partialOffWindows(GOLDEN_TIME_OFF, 'Ana Torres', '2026-08-14')).toHaveLength(1);
        expect(partialOffWindows(GOLDEN_TIME_OFF, 'Ana Torres', '2026-08-13')).toHaveLength(0);
        expect(partialOffWindows(GOLDEN_TIME_OFF, 'Ben Carter', '2026-08-14')).toHaveLength(0);
    });
    it('warns when a shift overlaps the window, half-open at the edges', () => {
        expect(shiftOverlapsPartialOff(GOLDEN_TIME_OFF, 'Ana Torres', '2026-08-14', '14:00', '18:00')).toBe(true);
        // Adjacent 10–3 shift touching the 3pm window start: NOT an overlap.
        expect(shiftOverlapsPartialOff(GOLDEN_TIME_OFF, 'Ana Torres', '2026-08-14', '10:00', '15:00')).toBe(false);
        expect(shiftOverlapsPartialOff(GOLDEN_TIME_OFF, 'Ana Torres', '2026-08-14', '20:00', '21:00')).toBe(false);
    });
});

// ── Overlap engine against the golden week ────────────────────────────────

describe('computeScheduleConflicts', () => {
    it('EDITOR view: flags exactly Cara’s Tuesday overlap and Quinn’s draft overlap', () => {
        const out = computeScheduleConflicts(GOLDEN_SHIFTS, true);
        const keys = out.map(c => `${c.staffName}|${c.date}`).sort();
        expect(keys).toEqual(['Cara Diaz|2026-08-11', 'Quinn Reed|2026-08-13']);
        const cara = out.find(c => c.staffName === 'Cara Diaz');
        expect(cara.shiftIds.sort()).toEqual(['s4', 's5']);
        expect(cara.label).toBe('11:00–16:00 vs 15:00–20:00');
    });

    it('NON-editor view: the draft half of Quinn’s pair is hidden → only Cara conflicts', () => {
        const out = computeScheduleConflicts(GOLDEN_SHIFTS, false);
        expect(out.map(c => c.staffName)).toEqual(['Cara Diaz']);
    });

    it('adjacency is never a conflict (Ben’s 10–3 + 3–8 double day)', () => {
        const out = computeScheduleConflicts(GOLDEN_SHIFTS, true);
        expect(out.some(c => c.staffName === 'Ben Carter')).toBe(false);
    });

    it('same person on DIFFERENT days never conflicts; malformed times are skipped, never throw', () => {
        const out = computeScheduleConflicts(GOLDEN_SHIFTS, true);
        expect(out.some(c => c.staffName === 'Hugo Reyes')).toBe(false); // s13 bogus start skipped
        expect(() => computeScheduleConflicts([{ staffName: 'X', date: 'd', startTime: null, endTime: undefined }], true)).not.toThrow();
    });

    it('three-way overlap reports every conflicting pair', () => {
        const trio = [
            { id: 'a', staffName: 'Z', date: '2026-08-10', startTime: '10:00', endTime: '14:00' },
            { id: 'b', staffName: 'Z', date: '2026-08-10', startTime: '11:00', endTime: '15:00' },
            { id: 'c', staffName: 'Z', date: '2026-08-10', startTime: '12:00', endTime: '16:00' },
        ];
        expect(computeScheduleConflicts(trio, true)).toHaveLength(3); // ab, ac, bc
    });

    it('handles empty and null input', () => {
        expect(computeScheduleConflicts([], true)).toEqual([]);
        expect(computeScheduleConflicts(null, true)).toEqual([]);
    });
});
