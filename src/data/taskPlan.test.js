// Resolver tests for the Task Planner — the pure recurrence math that
// decides which planned tasks are due on a given day. The materializer's
// carry-over behavior rides on assigned_tasks state (covered by the
// skip-if-open logic in ensureMaterializedForToday), but the date math
// here is what the calendar renders and the daily instances follow.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
    collection: vi.fn(), doc: vi.fn(), getDocs: vi.fn(), onSnapshot: vi.fn(),
    query: vi.fn(), where: vi.fn(), limit: vi.fn(), addDoc: vi.fn(),
    updateDoc: vi.fn(), setDoc: vi.fn(), deleteDoc: vi.fn(),
    serverTimestamp: vi.fn(() => ({})), arrayUnion: vi.fn((...a) => a),
}));

import { isRuleDueOn, rulesDueOn, addDaysStr, dayDiff, weekdayOf } from './taskPlan';

const rule = (recurrence, extra = {}) => ({
    id: 'r1', task: 'Clean table bases', side: 'FOH', active: true,
    recurrence, extraDates: [], skipDates: [], endDate: null, ...extra,
});

describe('taskPlan date helpers', () => {
    it('adds days across month boundaries', () => {
        expect(addDaysStr('2026-07-31', 1)).toBe('2026-08-01');
        expect(addDaysStr('2026-01-01', -1)).toBe('2025-12-31');
    });
    it('day diff spans DST edges without drift', () => {
        // US spring-forward 2026-03-08 — plain ms math would be off by 1h.
        expect(dayDiff('2026-03-07', '2026-03-09')).toBe(2);
        expect(dayDiff('2026-11-01', '2026-11-03')).toBe(2); // fall-back
    });
    it('weekday is calendar-stable', () => {
        expect(weekdayOf('2026-07-27')).toBe(1); // Monday
        expect(weekdayOf('2026-08-01')).toBe(6); // Saturday
    });
});

describe('isRuleDueOn', () => {
    it('once fires on its date only', () => {
        const r = rule({ type: 'once', date: '2026-07-28' });
        expect(isRuleDueOn(r, '2026-07-28')).toBe(true);
        expect(isRuleDueOn(r, '2026-07-29')).toBe(false);
    });

    it('daily fires from its anchor onward', () => {
        const r = rule({ type: 'daily', anchor: '2026-07-28' });
        expect(isRuleDueOn(r, '2026-07-27')).toBe(false);
        expect(isRuleDueOn(r, '2026-07-28')).toBe(true);
        expect(isRuleDueOn(r, '2026-09-15')).toBe(true);
    });

    it('every-other-day (n=2) alternates from the anchor', () => {
        const r = rule({ type: 'everyN', n: 2, anchor: '2026-07-28' });
        expect(isRuleDueOn(r, '2026-07-28')).toBe(true);
        expect(isRuleDueOn(r, '2026-07-29')).toBe(false);
        expect(isRuleDueOn(r, '2026-07-30')).toBe(true);
        expect(isRuleDueOn(r, '2026-08-01')).toBe(true);  // +4 days
        expect(isRuleDueOn(r, '2026-07-27')).toBe(false); // before anchor
    });

    it('weekly fires on the chosen weekdays', () => {
        const r = rule({ type: 'weekly', weekdays: [2], anchor: '2026-07-01' }); // Tuesdays
        expect(isRuleDueOn(r, '2026-07-28')).toBe(true);  // a Tuesday
        expect(isRuleDueOn(r, '2026-07-29')).toBe(false);
        expect(isRuleDueOn(r, '2026-08-04')).toBe(true);  // next Tuesday
    });

    it('skipDates removes one occurrence; extraDates adds one (the move flow)', () => {
        // "Clean the table bases Tuesday … again 2 weeks later on a Wednesday":
        // Tuesday weekly, with 8/11 skipped and 8/12 (Wed) added.
        const r = rule({ type: 'weekly', weekdays: [2], anchor: '2026-07-01' },
            { skipDates: ['2026-08-11'], extraDates: ['2026-08-12'] });
        expect(isRuleDueOn(r, '2026-08-04')).toBe(true);   // normal Tuesday
        expect(isRuleDueOn(r, '2026-08-11')).toBe(false);  // skipped Tuesday
        expect(isRuleDueOn(r, '2026-08-12')).toBe(true);   // moved to Wednesday
    });

    it('endDate stops the series; archived rules never fire', () => {
        const r = rule({ type: 'daily', anchor: '2026-07-01' }, { endDate: '2026-07-31' });
        expect(isRuleDueOn(r, '2026-07-31')).toBe(true);
        expect(isRuleDueOn(r, '2026-08-01')).toBe(false);
        expect(isRuleDueOn(rule({ type: 'daily' }, { active: false }), '2026-07-28')).toBe(false);
    });

    it('rulesDueOn filters a mixed set', () => {
        const rules = [
            rule({ type: 'daily', anchor: '2026-07-01' }, { id: 'a' }),
            rule({ type: 'weekly', weekdays: [3], anchor: '2026-07-01' }, { id: 'b' }), // Wednesdays
            rule({ type: 'once', date: '2026-07-29' }, { id: 'c' }),
        ];
        expect(rulesDueOn(rules, '2026-07-29').map(r => r.id)).toEqual(['a', 'b', 'c']); // Wed
        expect(rulesDueOn(rules, '2026-07-30').map(r => r.id)).toEqual(['a']);
    });
});
