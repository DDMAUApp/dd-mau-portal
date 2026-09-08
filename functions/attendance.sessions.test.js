import { describe, it, expect } from 'vitest';
import { planCompletedSessions, saneSession, beforeIsStale } from './attendance.js';

const roster = (updatedAt, entries) => ({ updatedAt, entries });
const active = (id, clockedInAt, extra = {}) => ({ toastEmployeeId: id, employeeName: `Emp ${id}`, clockedInAt, clockedOut: false, clockedOutAt: null, ...extra });
const out = (id, firstIn, clockedOutAt) => ({ toastEmployeeId: id, employeeName: `Emp ${id}`, clockedInAt: firstIn, clockedOut: true, clockedOutAt });

const T = (h, m = 0, day = 8) => `2026-09-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000+0000`;

describe('saneSession', () => {
    it('accepts a positive span up to 16h, rejects negative/zero/over/invalid', () => {
        expect(saneSession(T(15), T(20))).toBe(true);
        expect(saneSession(T(19, 45), T(15, 5))).toBe(false);   // the negative-span bug
        expect(saneSession(T(15), T(15))).toBe(false);
        expect(saneSession(T(15, 0, 5), T(15, 0, 8))).toBe(false); // Sat → Tue fabrication
        expect(saneSession(T(15), null)).toBe(false);
        expect(saneSession(null, T(15))).toBe(false);
    });
});

describe('beforeIsStale', () => {
    it('flags a before-snapshot more than 3h older than after', () => {
        expect(beforeIsStale(roster('2026-09-05T21:57:00Z', []), roster('2026-09-08T15:53:00Z', []))).toBe(true);
        expect(beforeIsStale(roster('2026-09-08T15:50:00Z', []), roster('2026-09-08T15:53:00Z', []))).toBe(false);
    });
    it('fails open (not stale) when stamps are missing', () => {
        expect(beforeIsStale(roster(undefined, []), roster('2026-09-08T15:53:00Z', []))).toBe(false);
    });
});

describe('planCompletedSessions — roster transition table', () => {
    const b = '2026-09-08T15:50:00Z', a = '2026-09-08T15:51:30Z';

    it('active → clocked out: closes the ACTIVE session at clockedOutAt (not at the first punch)', () => {
        // second session started 14:45 CT after a clock-out break; the day's first punch was 10:05 CT
        const before = roster(b, [active('e1', T(19, 45))]);
        const after = roster(a, [out('e1', T(15, 5), T(1, 16, 9))]);   // first punch 10:05 CT, out 8:16pm CT
        expect(planCompletedSessions(before, after)).toEqual([
            { id: 'e1', name: 'Emp e1', clockIn: T(19, 45), clockOut: T(1, 16, 9) },
        ]);
    });

    it('clocked out → active (re-clock-in after a full clock-out): nothing to close', () => {
        const before = roster(b, [out('e1', T(15, 5), T(19, 30))]);
        const after = roster(a, [active('e1', T(19, 45))]);
        expect(planCompletedSessions(before, after)).toEqual([]);
    });

    it('active → active with a new start (clock-out not observed): closes the old one where the new began', () => {
        const before = roster(b, [active('e1', T(15, 5))]);
        const after = roster(a, [active('e1', T(19, 45))]);
        expect(planCompletedSessions(before, after)).toEqual([
            { id: 'e1', name: 'Emp e1', clockIn: T(15, 5), clockOut: T(19, 45) },
        ]);
    });

    it('active → active, unchanged: nothing', () => {
        const before = roster(b, [active('e1', T(15, 5))]);
        const after = roster(a, [active('e1', T(15, 5))]);
        expect(planCompletedSessions(before, after)).toEqual([]);
    });

    it('stale before (weekend outage): records nothing even though every clockedInAt differs', () => {
        const before = roster('2026-09-05T21:57:00Z', [active('e1', T(15, 37, 5)), active('e2', T(20, 22, 5))]);
        const after = roster('2026-09-08T15:53:00Z', [active('e1', T(14, 49)), active('e2', T(15, 4))]);
        expect(planCompletedSessions(before, after)).toEqual([]);
    });

    it('never emits an insane session even with fresh stamps', () => {
        const before = roster(b, [active('e1', T(15, 37, 5))]);         // Saturday start somehow still active
        const after = roster(a, [out('e1', T(15, 37, 5), T(1, 0, 9))]); // 57h "session"
        expect(planCompletedSessions(before, after)).toEqual([]);
    });

    it('clocked out → clocked out (no observable session): nothing', () => {
        const before = roster(b, [out('e1', T(15, 5), T(19, 30))]);
        const after = roster(a, [out('e1', T(15, 5), T(1, 16, 9))]);
        expect(planCompletedSessions(before, after)).toEqual([]);
    });
});

describe('review fixes (2026-09-08)', () => {
    const { sameCtDay, mergeBreaks } = require('./attendance.js');
    const todayCT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

    it('sameCtDay: only a clock-in on today (Central) may carry the roster hoursToday', () => {
        expect(sameCtDay(new Date().toISOString())).toBe(true);
        expect(sameCtDay('2026-09-05T15:37:04.381+0000')).toBe(todayCT === '2026-09-05');
        expect(sameCtDay(null)).toBe(false);
        expect(sameCtDay('garbage')).toBe(false);
    });

    it('mergeBreaks: unions by `in`, prefers the completed observation, never wipes to []', () => {
        const held = [{ in: T(18), out: T(18, 30), minutes: 30, paid: false }];
        expect(mergeBreaks(held, [])).toEqual(held);
        expect(mergeBreaks([{ in: T(18), out: null, minutes: 0, paid: false }], held)).toEqual(held);
        const merged = mergeBreaks(held, [{ in: T(21), out: T(21, 15), minutes: 15, paid: true }]);
        expect(merged.map(b => b.in)).toEqual([T(18), T(21)]);
        // a corrected (later) complete observation replaces the earlier one
        expect(mergeBreaks(held, [{ in: T(18), out: T(18, 45), minutes: 45, paid: false }])[0].minutes).toBe(45);
        // but a completed break is never replaced by an incomplete one
        expect(mergeBreaks(held, [{ in: T(18), out: null, minutes: 0, paid: false }])[0].minutes).toBe(30);
        expect(mergeBreaks(undefined, null)).toEqual([]);
    });

    it('stale before + SAME-DAY prev session: the close is still recorded (daytime outage)', () => {
        const nowIso = new Date().toISOString();
        const fourHoursAgo = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
        const prevIn = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
        const outAt = new Date(Date.now() - 60 * 1000).toISOString();
        const sameDay = sameCtDay(prevIn);
        const before = roster(fourHoursAgo, [active('e1', prevIn)]);
        const after = roster(nowIso, [out('e1', prevIn, outAt)]);
        const got = planCompletedSessions(before, after);
        if (sameDay) expect(got).toEqual([{ id: 'e1', name: 'Emp e1', clockIn: prevIn, clockOut: outAt }]);
        else expect(got).toEqual([]);
    });
});
