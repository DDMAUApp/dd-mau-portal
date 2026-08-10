// schedulePerf.test.js — scale guard (2026-08-10 gap work).
//
// The fleet is ~64 staff today; this pins the scheduling brain at ~4×
// that so an accidental O(n²)-per-cell regression (the class of bug that
// made the grid crawl before extraction) fails CI long before Andrew
// feels it. Bounds are deliberately GENEROUS — this is a tripwire for
// order-of-magnitude blowups, not a microbenchmark.

import { describe, it, expect } from 'vitest';
import { toDateStr, parseLocalDate, addDays, dayPaidHours, hoursBetween } from './scheduleCore';
import { computeScheduleConflicts } from './scheduleConflicts';

const STAFF_COUNT = 250;
const WEEK_START = parseLocalDate('2026-08-09');

function buildWeek() {
    const shifts = [];
    let id = 0;
    for (let s = 0; s < STAFF_COUNT; s++) {
        const name = `Staff ${s}`;
        for (let d = 0; d < 7; d++) {
            // ~2 shifts/staff/day incl. deliberate overlaps → worst-case load
            const date = toDateStr(addDays(WEEK_START, d));
            shifts.push({ id: `p${id++}`, staffName: name, date, startTime: '09:00', endTime: '15:00', published: true, side: 'foh' });
            shifts.push({ id: `p${id++}`, staffName: name, date, startTime: '14:00', endTime: '21:00', published: d % 2 === 0, side: 'foh' });
        }
    }
    return shifts; // 3,500 shifts
}

describe('scheduling perf tripwire (250 staff × week = 3,500 shifts)', () => {
    it('conflict engine completes the full grid well under 2s', () => {
        const shifts = buildWeek();
        const t0 = performance.now();
        const conflicts = computeScheduleConflicts(shifts, true);
        const ms = performance.now() - t0;
        // Every deliberate overlap pair must be found — correctness at scale:
        // each staff×day has exactly one overlapping pair → 250 × 7 conflicts.
        expect(conflicts.length).toBe(STAFF_COUNT * 7);
        expect(ms).toBeLessThan(2000);
    });

    it('hours math over the whole roster stays under 500ms', () => {
        const shifts = buildWeek();
        const byStaffDay = new Map();
        for (const sh of shifts) {
            const k = sh.staffName + '|' + sh.date;
            if (!byStaffDay.has(k)) byStaffDay.set(k, []);
            byStaffDay.get(k).push(sh);
        }
        const t0 = performance.now();
        let total = 0;
        for (const list of byStaffDay.values()) total += dayPaidHours(list);
        for (const sh of shifts) total += hoursBetween(sh.startTime, sh.endTime);
        const ms = performance.now() - t0;
        expect(total).toBeGreaterThan(0);
        expect(ms).toBeLessThan(500);
    });
});
