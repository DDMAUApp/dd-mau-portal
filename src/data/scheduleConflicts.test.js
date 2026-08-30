// scheduleConflicts.test.js — the conflict engine against the golden
// dataset (Phase 1, SCHEDULING-FORENSICS.md §13). The mixed time_off
// schema cases here pin the bug family that shipped three times
// (QA-audit S1 2026-06-20, myPto v1.0.385, and the original subscription
// drop) — legacy `date`-only docs MUST behave identically to
// startDate/endDate docs in every guard.

import { describe, it, expect } from 'vitest';
import {
    checkAvailabilityConflict, availabilityForDate, staffOffOn, partialOffWindows,
    shiftOverlapsPartialOff, computeScheduleConflicts,
} from './scheduleConflicts';
import { weekKeyOf, pruneAvailabilityWeeks } from './scheduleCore';
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

// ── Multi-week availability (2026-08-29) ───────────────────────────────────
// availabilityWeeks: { '<sunday>': <day map> } replaces the base pattern
// for that WHOLE week; weeks without an entry fall back to the base map.

describe('availabilityForDate + week overrides', () => {
    // Ana's base: Mon 10–16, Sun off. Override for the golden week
    // (Sunday 2026-08-09): ONLY Thursday, everything else off — Andrew's
    // "this week I can only work Thursday" example.
    const anaMultiWeek = {
        ...byName('Ana Torres'),
        availabilityWeeks: {
            '2026-08-09': {
                sun: { available: false }, mon: { available: false }, tue: { available: false },
                wed: { available: false }, fri: { available: false }, sat: { available: false },
                // thu absent → available all day (opt-out semantics hold inside overrides)
            },
        },
    };
    it('weekKeyOf maps any date to its Sunday', () => {
        expect(weekKeyOf('2026-08-09')).toBe('2026-08-09');   // Sunday itself
        expect(weekKeyOf('2026-08-12')).toBe('2026-08-09');   // Wednesday
        expect(weekKeyOf('2026-08-15')).toBe('2026-08-09');   // Saturday
        expect(weekKeyOf('2026-08-16')).toBe('2026-08-16');   // next Sunday
        expect(weekKeyOf('')).toBeNull();
        expect(weekKeyOf('garbage')).toBeNull();              // never 'NaN-NaN-NaN'
    });
    it('an override week replaces the base pattern for that whole week', () => {
        // Monday of the override week: base says available 10–16, override says OFF.
        expect(checkAvailabilityConflict(anaMultiWeek, '2026-08-10', '10:00', '15:00')).toEqual({ type: 'off' });
        // Thursday of the override week: absent in the override → available (no warning).
        expect(checkAvailabilityConflict(anaMultiWeek, '2026-08-13', '10:00', '15:00')).toBeNull();
    });
    it('weeks without an entry fall back to the base pattern', () => {
        // Next-week Monday: no override → base window 10–16 applies again.
        expect(checkAvailabilityConflict(anaMultiWeek, '2026-08-17', '10:00', '15:00')).toBeNull();
        expect(checkAvailabilityConflict(anaMultiWeek, '2026-08-17', '09:00', '17:00'))
            .toEqual({ type: 'outside', from: '10:00', to: '16:00' });
        // Next-week Sunday: base says off.
        expect(checkAvailabilityConflict(anaMultiWeek, '2026-08-16', '10:00', '15:00')).toEqual({ type: 'off' });
    });
    it('an override can OPEN a day the base pattern blocks', () => {
        const opened = { ...byName('Ana Torres'), availabilityWeeks: { '2026-08-09': {} } };
        // Sunday is off in the base map, but the override week's empty map = all available.
        expect(checkAvailabilityConflict(opened, '2026-08-09', '10:00', '15:00')).toBeNull();
    });
    it('malformed availabilityWeeks falls back to the base map and never throws', () => {
        for (const weeks of [null, 'junk', 7, [], { '2026-08-09': 'junk' }, { '2026-08-09': [] }]) {
            const s = { ...byName('Ana Torres'), availabilityWeeks: weeks };
            expect(checkAvailabilityConflict(s, '2026-08-10', '09:00', '17:00'))
                .toEqual({ type: 'outside', from: '10:00', to: '16:00' });   // base still applies
        }
        expect(availabilityForDate(null, '2026-08-10')).toEqual({});
        expect(availabilityForDate({}, '')).toEqual({});
    });
});

describe('pruneAvailabilityWeeks', () => {
    it('drops weeks before the current week, keeps current + future', () => {
        const weeks = { '2026-08-02': { sun: { available: false } }, '2026-08-09': {}, '2026-08-16': {} };
        expect(pruneAvailabilityWeeks(weeks, '2026-08-12'))
            .toEqual({ '2026-08-09': {}, '2026-08-16': {} });   // 08-12 is inside the 08-09 week
    });
    it('returns null when nothing valid remains (caller drops the field)', () => {
        expect(pruneAvailabilityWeeks({ '2026-08-02': {} }, '2026-08-12')).toBeNull();
        expect(pruneAvailabilityWeeks({}, '2026-08-12')).toBeNull();
        expect(pruneAvailabilityWeeks(null, '2026-08-12')).toBeNull();
        expect(pruneAvailabilityWeeks('junk', '2026-08-12')).toBeNull();
    });
    it('drops garbage keys and non-map values', () => {
        expect(pruneAvailabilityWeeks({ junk: {}, '2026-08-16': 'nope', '2026-08-23': {} }, '2026-08-12'))
            .toEqual({ '2026-08-23': {} });
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
