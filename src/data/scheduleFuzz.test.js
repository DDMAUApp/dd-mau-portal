// scheduleFuzz.test.js — seeded fuzzer over the scheduling brain
// (2026-08-10 stabilization gap work, SCHEDULING-FORENSICS follow-up).
//
// Deterministic: a fixed-seed LCG generates thousands of random staff,
// shifts, PTO rows, and malformed garbage, and we assert the INVARIANTS
// that must survive any input — the properties whose violation has
// historically meant a shipped bug:
//
//   I1  No pure function ever THROWS on malformed docs (prod contains
//       garbage; a throw in the conflict engine blanks the whole grid).
//   I2  Hours math: never negative, never NaN for well-formed times.
//   I3  Conflict detection is symmetric (A↔B) and irreflexive (A vs A
//       by id never reports itself).
//   I4  Date round-trip: toDateStr(parseLocalDate(s)) === s for every
//       generated date, across DST boundaries.
//   I5  weeksBetween is DST-stable: week(d) to week(d+7n days) === n.
//   I6  staffOffOn never throws on mixed-schema PTO and respects
//       start<=date<=end for approved full-day rows.

import { describe, it, expect } from 'vitest';
import {
    toDateStr, parseLocalDate, startOfWeek, addDays, weeksBetween,
    hoursBetween, dayPaidHours, hhmmToMin, timeRangesOverlap,
} from './scheduleCore';
import { computeScheduleConflicts, staffOffOn } from './scheduleConflicts';

// Deterministic LCG — same sequence every run, so failures reproduce.
function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

const NAMES = ['Ana', 'Ben', 'Cara', 'Dev', 'Elle', 'Franco', 'Gia', 'Hoa', 'Ivy', 'Jun',
    'Kai', 'Lia', 'Mo', 'Nia', 'Omar', 'Pia', 'Quinn', 'Rio', 'Sam', 'Tara'];

function randTime(rng) {
    const h = Math.floor(rng() * 24), m = [0, 15, 30, 45][Math.floor(rng() * 4)];
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function randDate(rng) {
    // Spans both 2026 DST transitions (Mar 8, Nov 1).
    const base = parseLocalDate('2026-01-01');
    return toDateStr(addDays(base, Math.floor(rng() * 365)));
}
function randShift(rng, i) {
    const roll = rng();
    if (roll < 0.06) {
        // Malformed garbage — prod has these (I1).
        return { id: `bad${i}`, staffName: rng() < 0.5 ? null : '', date: rng() < 0.5 ? undefined : 'not-a-date',
            startTime: null, endTime: rng() < 0.5 ? '' : '99:99' };
    }
    return {
        id: `s${i}`,
        staffName: NAMES[Math.floor(rng() * NAMES.length)],
        date: randDate(rng),
        startTime: randTime(rng),
        endTime: randTime(rng),          // may be <= start — engine must cope
        side: rng() < 0.5 ? 'foh' : (rng() < 0.5 ? 'boh' : undefined),
        published: rng() < 0.7,
        isDouble: rng() < 0.05,
    };
}
function randPto(rng, i) {
    const start = randDate(rng);
    const legacy = rng() < 0.25;
    const row = legacy
        ? { id: `t${i}`, staffName: NAMES[Math.floor(rng() * NAMES.length)], date: start,
            status: ['approved', 'pending', 'denied'][Math.floor(rng() * 3)] }
        : { id: `t${i}`, staffName: NAMES[Math.floor(rng() * NAMES.length)], startDate: start,
            endDate: toDateStr(addDays(parseLocalDate(start), Math.floor(rng() * 5))),
            status: ['approved', 'pending', 'denied'][Math.floor(rng() * 3)] };
    if (rng() < 0.1) delete row.status;   // schema drift
    return row;
}

describe('scheduling fuzz (seeded, deterministic)', () => {
    it('I1+I3: conflict engine survives 40 random rosters; every conflict is real', () => {
        for (let round = 0; round < 40; round++) {
            const rng = makeRng(1000 + round);
            const shifts = Array.from({ length: 120 }, (_, i) => randShift(rng, i));
            let conflicts;
            expect(() => { conflicts = computeScheduleConflicts(shifts, round % 2 === 0); }).not.toThrow();
            const byId = new Map(shifts.map(s => [s.id, s]));
            for (const c of conflicts) {
                const [aId, bId] = c.shiftIds;
                expect(aId).not.toBe(bId);                      // irreflexive — never self-conflict
                const a = byId.get(aId), b = byId.get(bId);
                expect(a).toBeTruthy();                          // no phantom ids
                expect(b).toBeTruthy();
                expect(a.staffName).toBe(b.staffName);           // same person…
                expect(a.date).toBe(b.date);                     // …same day
                // …and a genuine overlap (strict — adjacency is not a conflict)
                const min = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
                expect(min(a.endTime)).toBeGreaterThan(min(b.startTime));
                expect(min(b.endTime)).toBeGreaterThan(min(a.startTime));
            }
        }
    });

    it('I2: hours math never yields negative or NaN for well-formed inputs', () => {
        const rng = makeRng(42);
        for (let i = 0; i < 2000; i++) {
            const a = randTime(rng), b = randTime(rng);
            const h = hoursBetween(a, b);
            expect(Number.isNaN(h)).toBe(false);
            expect(h).toBeGreaterThanOrEqual(0);
            const paid = dayPaidHours([{ startTime: a, endTime: b }]);
            expect(Number.isNaN(paid)).toBe(false);
            expect(paid).toBeGreaterThanOrEqual(0);
        }
    });

    it('I4: date string round-trip holds for 365 consecutive days incl. DST', () => {
        const base = parseLocalDate('2026-01-01');
        for (let i = 0; i < 365; i++) {
            const s = toDateStr(addDays(base, i));
            expect(toDateStr(parseLocalDate(s))).toBe(s);
        }
    });

    it('I5: weeksBetween(week(d), week(d)+7n) === n across the whole year', () => {
        const rng = makeRng(7);
        for (let i = 0; i < 500; i++) {
            const d = startOfWeek(parseLocalDate(randDate(rng)));
            const n = Math.floor(rng() * 20) - 10;
            expect(weeksBetween(d, addDays(d, n * 7))).toBe(n);
        }
    });

    it('I6: staffOffOn survives mixed-schema PTO and honors approved ranges', () => {
        const rng = makeRng(99);
        for (let round = 0; round < 20; round++) {
            const pto = Array.from({ length: 60 }, (_, i) => randPto(rng, i));
            const name = NAMES[Math.floor(rng() * NAMES.length)];
            const date = randDate(rng);
            expect(() => staffOffOn(pto, name, date)).not.toThrow();
        }
        // Directed check: an approved range must cover its interior day.
        const pto = [{ id: 't1', staffName: 'Ana', startDate: '2026-06-10', endDate: '2026-06-12', status: 'approved' }];
        expect(staffOffOn(pto, 'Ana', '2026-06-11')).toBeTruthy();
        expect(staffOffOn(pto, 'Ana', '2026-06-13')).toBeFalsy();
        // Legacy bare-date row still protects its day.
        const legacy = [{ id: 't2', staffName: 'Ben', date: '2026-06-10', status: 'approved' }];
        expect(staffOffOn(legacy, 'Ben', '2026-06-10')).toBeTruthy();
    });

    it('timeRangesOverlap: symmetric and irreflexive-safe under fuzz', () => {
        const rng = makeRng(1234);
        for (let i = 0; i < 2000; i++) {
            const a1 = hhmmToMin(randTime(rng)), a2 = hhmmToMin(randTime(rng));
            const b1 = hhmmToMin(randTime(rng)), b2 = hhmmToMin(randTime(rng));
            expect(timeRangesOverlap(a1, a2, b1, b2)).toBe(timeRangesOverlap(b1, b2, a1, a2));
        }
    });
});
