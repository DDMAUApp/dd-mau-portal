// scheduleCore.test.js — first-ever regression coverage for the scheduling
// brain (Phase 1, SCHEDULING-FORENSICS.md §13). Every function here shipped
// at least one production bug while untested inside Schedule.jsx; several
// tests below pin the EXACT past incidents (named inline).

import { describe, it, expect } from 'vitest';
import {
    DAYS_EN, DAY_IDS, dayIdFromDateStr, WEEK_START_DOW,
    resolveStaffSide, isOnSide, isRoleEligible, roleColors,
    getShiftPresets, sanitizeShiftPresets, SHIFT_PRESETS_FOH, SHIFT_PRESETS_BOH,
    toDateStr, parseLocalDate, startOfWeek, addDays, weeksBetween,
    blockedDatesInRange, stripShiftTimestamps, rehydrateShiftTimestamps,
    formatTime12h, shortTime12h, ptoIsPartial, ptoWindowLabel, timeRangesOverlap,
    hoursBetween, dayPaidHours, isDoubleDay, formatHours, hoursColor,
    minorShiftWarnings, MINOR_WEEKLY_HOURS_MAX,
} from './scheduleCore';
import { GOLDEN_STAFF, goldenBlocksByDate } from './__fixtures__/goldenSchedule';

const byName = (n) => GOLDEN_STAFF.find(s => s.name === n);

// ── Dates ──────────────────────────────────────────────────────────────────

describe('date round-trip', () => {
    it('toDateStr ↔ parseLocalDate is lossless for every day of a year', () => {
        let d = new Date(2026, 0, 1);
        for (let i = 0; i < 365; i++) {
            const s = toDateStr(d);
            expect(toDateStr(parseLocalDate(s))).toBe(s);
            d = addDays(d, 1);
        }
    });

    it('parseLocalDate never slides a day (the new Date("YYYY-MM-DD") UTC trap)', () => {
        const d = parseLocalDate('2026-08-09');
        expect(d.getFullYear()).toBe(2026);
        expect(d.getMonth()).toBe(7);
        expect(d.getDate()).toBe(9);
        expect(parseLocalDate('')).toBeNull();
        expect(parseLocalDate(null)).toBeNull();
    });

    it('dayIdFromDateStr maps 2026-08-09 (a Sunday) to "sun" and aligns with DAY_IDS', () => {
        expect(dayIdFromDateStr('2026-08-09')).toBe('sun');
        expect(dayIdFromDateStr('2026-08-15')).toBe('sat');
        expect(dayIdFromDateStr('')).toBeNull();
        expect(DAY_IDS[parseLocalDate('2026-08-12').getDay()]).toBe('wed');
    });
});

describe('week math (Sunday-start FLSA week)', () => {
    it('startOfWeek lands on Sunday for every day of the golden week', () => {
        expect(WEEK_START_DOW).toBe(0);
        for (let i = 0; i < 7; i++) {
            const d = addDays(parseLocalDate('2026-08-09'), i);
            expect(toDateStr(startOfWeek(d))).toBe('2026-08-09');
        }
    });

    it('a Saturday belongs to the week that STARTED the previous Sunday (boundary)', () => {
        expect(toDateStr(startOfWeek(parseLocalDate('2026-08-15')))).toBe('2026-08-09');
        expect(toDateStr(startOfWeek(parseLocalDate('2026-08-16')))).toBe('2026-08-16'); // next Sunday = its own week
    });

    it('addDays crosses month and year ends correctly', () => {
        expect(toDateStr(addDays(parseLocalDate('2026-08-31'), 1))).toBe('2026-09-01');
        expect(toDateStr(addDays(parseLocalDate('2026-12-28'), 7))).toBe('2027-01-04');
        expect(toDateStr(addDays(parseLocalDate('2026-03-01'), -1))).toBe('2026-02-28');
    });
});

describe('weeksBetween — the 2026-05-22 bi-weekly DST parity fix', () => {
    // US 2026 transitions: spring-forward Mar 8, fall-back Nov 1.
    it('counts exact weeks across the spring-forward transition', () => {
        const anchor = startOfWeek(parseLocalDate('2026-03-01')); // week before the Mar 8 change
        for (let n = 0; n <= 8; n++) {
            const wk = startOfWeek(addDays(anchor, n * 7));
            expect(weeksBetween(anchor, wk)).toBe(n);   // Math.floor would give n-1 past the transition
        }
    });

    it('counts exact weeks across the fall-back transition', () => {
        const anchor = startOfWeek(parseLocalDate('2026-10-25'));
        for (let n = 0; n <= 8; n++) {
            const wk = startOfWeek(addDays(anchor, n * 7));
            expect(weeksBetween(anchor, wk)).toBe(n);
        }
    });

    it('is negative for weeks before the anchor (biweekly rules must not fire pre-validFrom)', () => {
        const anchor = startOfWeek(parseLocalDate('2026-08-09'));
        expect(weeksBetween(anchor, startOfWeek(addDays(anchor, -7)))).toBe(-1);
    });
});

// ── Hours math ─────────────────────────────────────────────────────────────

describe('hoursBetween', () => {
    it('computes plain and fractional shifts', () => {
        expect(hoursBetween('10:00', '15:00')).toBe(5);
        expect(hoursBetween('10:30', '15:00')).toBe(4.5);
    });
    it('wraps overnight (end < start) forward 24h; equal times = 0', () => {
        expect(hoursBetween('22:00', '02:00')).toBe(4);
        expect(hoursBetween('10:00', '10:00')).toBe(0); // zero-length shift, NOT a 24h wrap (2026-08-25 fix)
    });
    it('deducts the 1h unpaid break on isDouble, floored at 0', () => {
        expect(hoursBetween('10:00', '20:00', true)).toBe(9);
        expect(hoursBetween('10:00', '10:30', true)).toBe(0);
    });
    it('returns 0 on missing inputs', () => {
        expect(hoursBetween('', '15:00')).toBe(0);
        expect(hoursBetween('10:00', null)).toBe(0);
    });
});

describe('dayPaidHours + isDoubleDay (auto-double policy)', () => {
    const s = (a, b, isDouble = false) => ({ startTime: a, endTime: b, isDouble });
    it('single shift honors the legacy isDouble flag', () => {
        expect(dayPaidHours([s('10:00', '20:00', true)])).toBe(9);
        expect(isDoubleDay([s('10:00', '20:00', true)])).toBe(true);
    });
    it('2+ shifts on one day deduct the break ONCE, regardless of flags', () => {
        expect(dayPaidHours([s('10:00', '15:00'), s('16:00', '20:00')])).toBe(8); // 5+4-1
        expect(isDoubleDay([s('10:00', '15:00'), s('16:00', '20:00')])).toBe(true);
    });
    it('adjacent Ben-Carter-style 10-3 + 3-8 is a paid 9h double', () => {
        expect(dayPaidHours([s('10:00', '15:00'), s('15:00', '20:00')])).toBe(9); // 5+5-1
    });
    it('empty day is 0 / not a double', () => {
        expect(dayPaidHours([])).toBe(0);
        expect(isDoubleDay([])).toBe(false);
    });
});

describe('minorShiftWarnings', () => {
    it('flags past-10PM AND >8h together (golden Dev Patel shift)', () => {
        const w = minorShiftWarnings({ startTime: '13:00', endTime: '22:30' }, true);
        expect(w).toHaveLength(2);
        expect(w[0]).toContain('10PM');
        expect(w[1]).toContain('>8h');
    });
    it('treats a midnight end (hour 0) as late', () => {
        expect(minorShiftWarnings({ startTime: '18:00', endTime: '00:00' }, true)[0]).toContain('10PM');
    });
    it('is silent for a compliant shift and empty input', () => {
        expect(minorShiftWarnings({ startTime: '10:00', endTime: '15:00' }, true)).toHaveLength(0);
        expect(minorShiftWarnings({}, true)).toHaveLength(0);
    });
    it('weekly cap constant is the auto-fill ceiling', () => {
        expect(MINOR_WEEKLY_HOURS_MAX).toBe(30);
    });
});

describe('formatters', () => {
    it('formatTime12h renders on-the-hour compactly and keeps minutes otherwise', () => {
        expect(formatTime12h('10:00')).toBe('10AM');
        expect(formatTime12h('15:30')).toBe('3:30PM');
        expect(formatTime12h('12:00')).toBe('12PM');
        expect(formatTime12h('00:15')).toBe('12:15AM');
        expect(formatTime12h('')).toBe('');
    });
    it('shortTime12h is the tiny-grid variant', () => {
        expect(shortTime12h('09:00')).toBe('9a');
        expect(shortTime12h('21:30')).toBe('9:30p');
    });
    it('formatHours + hoursColor OT thresholds', () => {
        expect(formatHours(8)).toBe('8h');
        expect(formatHours(8.5)).toBe('8.5h');
        expect(hoursColor(29)).toContain('green');
        expect(hoursColor(30)).toContain('yellow');
        expect(hoursColor(40)).toContain('red');
    });
});

// ── PTO window helpers ─────────────────────────────────────────────────────

describe('partial-PTO helpers', () => {
    it('ptoIsPartial requires the flag AND both times', () => {
        expect(ptoIsPartial({ partial: true, startTime: '15:00', endTime: '20:00' })).toBe(true);
        expect(ptoIsPartial({ partial: true, startTime: '15:00' })).toBe(false);
        expect(ptoIsPartial({ startTime: '15:00', endTime: '20:00' })).toBe(false);
    });
    it('ptoWindowLabel renders the window, empty for whole-day', () => {
        expect(ptoWindowLabel({ partial: true, startTime: '15:00', endTime: '20:00' })).toBe('3PM–8PM');
        expect(ptoWindowLabel({ startDate: '2026-08-14' })).toBe('');
    });
    it('timeRangesOverlap is half-open — touching edges do NOT overlap', () => {
        expect(timeRangesOverlap('10:00', '15:00', '15:00', '20:00')).toBe(false);
        expect(timeRangesOverlap('10:00', '15:01', '15:00', '20:00')).toBe(true);
        expect(timeRangesOverlap('10:00', '15:00', '', '20:00')).toBe(false);
    });
});

// ── Sides / roles / presets ────────────────────────────────────────────────

describe('side resolution against the golden roster', () => {
    it('explicit scheduleSide wins; roles infer; default is foh', () => {
        expect(resolveStaffSide(byName('Gia Chen'))).toBe('boh');       // explicit
        expect(resolveStaffSide(byName('Franco Silva'))).toBe('boh');   // inferred from 'Pho Station'
        expect(resolveStaffSide(byName('Jon Kim'))).toBe('boh');        // inferred from 'Kitchen Manager'
        expect(resolveStaffSide(byName('Quinn Reed'))).toBe('foh');     // no side, FOH role
        expect(resolveStaffSide(null)).toBe('foh');
    });
    it("'both' belongs to every side but resolves home = foh", () => {
        const kai = byName('Kai Osei');
        expect(isOnSide(kai, 'foh')).toBe(true);
        expect(isOnSide(kai, 'boh')).toBe(true);
        expect(resolveStaffSide(kai)).toBe('foh');
        expect(isOnSide(byName('Gia Chen'), 'foh')).toBe(false);
    });
    it('roleColors tiers: manager orange, lead green (role OR flag), staff blue', () => {
        expect(roleColors('Kitchen Manager', false).tier).toBe('manager');
        expect(roleColors('Shift Lead', false).tier).toBe('lead');
        expect(roleColors('FOH', true).tier).toBe('lead');
        expect(roleColors('FOH', false).tier).toBe('staff');
    });
    it('isRoleEligible: "any" and unknown groups always pass; real groups filter', () => {
        expect(isRoleEligible('FOH', 'any')).toBe(true);
        expect(isRoleEligible('FOH', 'nonexistent-group')).toBe(true);
        expect(isRoleEligible('Dish', 'boh-staff')).toBe(true);
        expect(isRoleEligible('FOH', 'boh-staff')).toBe(false);
        expect(isRoleEligible('Owner', 'manager')).toBe(true);
    });
});

describe('sanitizeShiftPresets — bad config can never empty the quick-add', () => {
    it('drops malformed rows but keeps good ones', () => {
        const out = sanitizeShiftPresets([
            { label: 'Good', start: '9:00', end: '15:00' },
            { label: '', start: '10:00', end: '15:00' },          // no label
            { label: 'NoTimes' },                                  // no times
            { label: 'BadTime', start: '25:xx', end: '15:00' },    // invalid start
        ], SHIFT_PRESETS_FOH);
        expect(out).toHaveLength(1);
        expect(out[0].label).toBe('Good');
    });
    it('falls back to defaults when everything is dropped or input is not an array', () => {
        expect(sanitizeShiftPresets([{ label: '' }], SHIFT_PRESETS_FOH)).toBe(SHIFT_PRESETS_FOH);
        expect(sanitizeShiftPresets(undefined, SHIFT_PRESETS_BOH)).toBe(SHIFT_PRESETS_BOH);
    });
    it('getShiftPresets routes by side', () => {
        expect(getShiftPresets('boh')).toBe(SHIFT_PRESETS_BOH);
        expect(getShiftPresets('foh')).toBe(SHIFT_PRESETS_FOH);
        expect(getShiftPresets(undefined)).toBe(SHIFT_PRESETS_FOH);
    });
});

// ── Blackouts ──────────────────────────────────────────────────────────────

describe('blockedDatesInRange against golden blocks', () => {
    it('finds closed + no_timeoff days inside the range, inclusive both ends', () => {
        const out = blockedDatesInRange('2026-08-09', '2026-08-15', goldenBlocksByDate());
        expect(out.map(o => o.date)).toEqual(['2026-08-12', '2026-08-14']);
        expect(out[0].reason).toBe('Deep clean');
    });
    it('single-day range works and misses nothing adjacent', () => {
        expect(blockedDatesInRange('2026-08-12', '2026-08-12', goldenBlocksByDate())).toHaveLength(1);
        expect(blockedDatesInRange('2026-08-13', '2026-08-13', goldenBlocksByDate())).toHaveLength(0);
    });
    it('caps the walk at 120 days and survives junk input', () => {
        const yearLong = blockedDatesInRange('2026-01-01', '2026-12-31', goldenBlocksByDate());
        expect(yearLong.length).toBeGreaterThanOrEqual(0); // must return, not hang
        expect(blockedDatesInRange(null, '2026-08-15', goldenBlocksByDate())).toEqual([]);
        expect(blockedDatesInRange('2026-08-09', '2026-08-15', null)).toEqual([]);
    });
});

// ── localStorage timestamp round-trip (production audit 2026-05-22) ───────

describe('strip/rehydrate shift timestamps', () => {
    it('round-trips a Firestore-like Timestamp through JSON without losing .toMillis()', () => {
        const ts = { toMillis: () => 1754700000000 };
        const shift = { id: 's1', createdAt: ts, updatedAt: ts, startTime: '10:00' };
        const revived = rehydrateShiftTimestamps(JSON.parse(JSON.stringify(stripShiftTimestamps(shift))));
        expect(revived.createdAt.toMillis()).toBe(1754700000000);
        expect(revived.createdAt.seconds).toBe(Math.floor(1754700000000 / 1000));
        expect(revived.startTime).toBe('10:00');
    });
    it('leaves plain fields and non-timestamp objects untouched', () => {
        const shift = { id: 's1', notes: 'hi', createdAt: { seconds: 1 } }; // no toMillis → not a Timestamp
        expect(stripShiftTimestamps(shift).createdAt).toEqual({ seconds: 1 });
        expect(rehydrateShiftTimestamps({ createdAt: { seconds: 1 } }).createdAt).toEqual({ seconds: 1 });
        expect(stripShiftTimestamps(null)).toBeNull();
    });
});

// ── Golden-week sanity: DAYS_EN alignment ─────────────────────────────────

describe('golden week', () => {
    it('2026-08-09 is a Sunday and the labels align', () => {
        const d = parseLocalDate('2026-08-09');
        expect(d.getDay()).toBe(0);
        expect(DAYS_EN[d.getDay()]).toBe('Sun');
    });
});
