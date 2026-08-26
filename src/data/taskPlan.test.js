// Resolver tests for the Task Planner — the pure recurrence math that
// decides which planned tasks are due on a given day. The materializer's
// carry-over behavior rides on assigned_tasks state (covered by the
// skip-if-open logic in ensureMaterializedForToday), but the date math
// here is what the calendar renders and the daily instances follow.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
    // doc() returns { path } so the per-task-writer tests below can tell
    // the live checklist ref from the history-mirror ref.
    collection: vi.fn(), doc: vi.fn((_db, ...segs) => ({ path: segs.join('/') })), getDoc: vi.fn(), getDocs: vi.fn(), onSnapshot: vi.fn(),
    query: vi.fn(), where: vi.fn(), limit: vi.fn(), addDoc: vi.fn(),
    updateDoc: vi.fn(), setDoc: vi.fn(), deleteDoc: vi.fn(),
    serverTimestamp: vi.fn(() => ({})), arrayUnion: vi.fn((...a) => a),
    runTransaction: vi.fn(),
}));

import {
    isRuleDueOn, rulesDueOn, addDaysStr, dayDiff, weekdayOf,
    checklistTasksForDay, moveOccurrence, moveInArray,
    mutateOpsChecklistTask, appendOpsChecklistTask, swapOpsChecklistTasks,
} from './taskPlan';
import { getDoc, updateDoc, runTransaction } from 'firebase/firestore';

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

describe('moveOccurrence (2026-07-27 audit R1)', () => {
    it('moving back to the original day un-skips it instead of stacking skips', async () => {
        // A Tuesday-weekly rule already moved 8/11 (Tue) → 8/12 (Wed).
        // Moving it BACK used to arrayUnion 8/11 into skipDates on top of
        // the existing entry — skipDates wins over extraDates in
        // isRuleDueOn, so the occurrence vanished from BOTH days.
        getDoc.mockResolvedValue({
            exists: () => true,
            data: () => ({ skipDates: ['2026-08-11'], extraDates: ['2026-08-12'] }),
        });
        updateDoc.mockResolvedValue();
        const r = rule({ type: 'weekly', weekdays: [2], anchor: '2026-07-01' });
        await moveOccurrence(r, '2026-08-12', '2026-08-11');
        const patch = updateDoc.mock.calls.at(-1)[1];
        expect(patch.skipDates).toEqual(['2026-08-12']);   // landing day un-skipped
        expect(patch.extraDates).toEqual(['2026-08-11']);  // left day no longer extra
        const moved = rule(r.recurrence,
            { skipDates: patch.skipDates, extraDates: patch.extraDates });
        expect(isRuleDueOn(moved, '2026-08-11')).toBe(true);   // back on Tuesday
        expect(isRuleDueOn(moved, '2026-08-12')).toBe(false);  // gone from Wednesday
    });
});

describe('moveInArray (Daily Ops drag-reorder math, 2026-07-29)', () => {
    // The DaySheet list is DAY-FILTERED, so the on-screen next row may not
    // be the array-adjacent one — insert-before-anchor handles that.
    const arr = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

    it('inserts the moved task before the anchor', () => {
        expect(moveInArray(arr, 'd', 'b').map(t => t.id)).toEqual(['a', 'd', 'b', 'c']);
        expect(moveInArray(arr, 'a', 'd').map(t => t.id)).toEqual(['b', 'c', 'a', 'd']);
    });

    it('null or unknown anchor pushes to the end', () => {
        expect(moveInArray(arr, 'a', null).map(t => t.id)).toEqual(['b', 'c', 'd', 'a']);
        expect(moveInArray(arr, 'a', 'zzz').map(t => t.id)).toEqual(['b', 'c', 'd', 'a']);
    });

    it('anchor right after the task = same order (pure no-op reorder)', () => {
        expect(moveInArray(arr, 'b', 'c').map(t => t.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('returns null when the task is absent, and never mutates the input', () => {
        expect(moveInArray(arr, 'x', 'b')).toBeNull();
        expect(moveInArray([], 'a', null)).toBeNull();
        moveInArray(arr, 'd', 'a');
        expect(arr.map(t => t.id)).toEqual(['a', 'b', 'c', 'd']);
    });
});

describe('checklistTasksForDay (day-sheet Daily Ops list)', () => {
    // 2026-07-27 is a Monday; 2026-07-26 is a Sunday.
    const ct = (tasks) => ({ FOH: { all: tasks }, BOH: { all: [] } });

    it('filters by per-task recurrence for the tapped day', () => {
        const tasks = [
            // 2026-07-29: assignTo/completeBy must pass through for the
            // DaySheet's inline row editors (and default to []/'').
            { id: 'a', task: 'Every day', assignTo: ['Ana', 'Bo'], completeBy: '15:30' },
            { id: 'b', task: 'Mondays only', recurrence: 'monday' },
            { id: 'c', task: 'Weekends', recurrence: 'weekend' },
            { id: 'd', task: 'Weekdays', recurrence: 'weekday' },
        ];
        const mon = checklistTasksForDay(ct(tasks), {}, 'FOH', '2026-07-27');
        expect(mon.map(t => t.id)).toEqual(['a', 'b', 'd']);
        const sun = checklistTasksForDay(ct(tasks), {}, 'FOH', '2026-07-26');
        expect(sun.map(t => t.id)).toEqual(['a', 'c']);
        expect(mon.find(t => t.id === 'a').assignTo).toEqual(['Ana', 'Bo']);
        expect(mon.find(t => t.id === 'a').completeBy).toBe('15:30');
        expect(mon.find(t => t.id === 'b').assignTo).toEqual([]);
        expect(mon.find(t => t.id === 'b').completeBy).toBe('');
    });

    it('done = bare check, or ALL subtasks checked, and photo when required', () => {
        const tasks = [
            { id: 'plain', task: 'Plain' },
            { id: 'subs', task: 'Has subs', subtasks: [{ id: 's1' }, { id: 's2' }] },
            { id: 'photo', task: 'Needs photo', requirePhoto: true },
        ];
        const checks = { plain: true, s1: true, photo: true }; // s2 unchecked, no photo check
        const out = checklistTasksForDay(ct(tasks), checks, 'FOH', '2026-07-27');
        expect(out.find(t => t.id === 'plain').done).toBe(true);
        expect(out.find(t => t.id === 'subs').done).toBe(false);
        expect(out.find(t => t.id === 'subs').subsDone).toBe(1);
        expect(out.find(t => t.id === 'photo').done).toBe(false);
        const out2 = checklistTasksForDay(ct(tasks), { ...checks, s2: true, photo_photo: true }, 'FOH', '2026-07-27');
        expect(out2.find(t => t.id === 'subs').done).toBe(true);
        expect(out2.find(t => t.id === 'photo').done).toBe(true);
    });

    it('reads the requested side and survives the legacy morning/afternoon shape', () => {
        const legacy = { BOH: { morning: [{ id: 'm1', task: 'AM' }], afternoon: [{ id: 'p1', task: 'PM' }] } };
        const out = checklistTasksForDay(legacy, { m1: true }, 'BOH', '2026-07-27');
        expect(out.map(t => [t.id, t.done])).toEqual([['m1', true], ['p1', false]]);
        expect(checklistTasksForDay(legacy, {}, 'FOH', '2026-07-27')).toEqual([]);
    });
});

// ── Per-task transactional writers (2026-08-25 audit) ───────────────────
// mutateOpsChecklistTask / appendOpsChecklistTask / swapOpsChecklistTasks
// replaced Operations' whole-array checklist writes. The transaction is
// mocked with a fake tx; these tests pin the load-bearing behavior:
// locate BY ID (not index), touch only the owning period's dot-path,
// mirror the final array to the history doc, null-mutate = delete,
// non-adjacent two-id swap, and append idempotence under a retry.
describe('per-task checklist transactions', () => {
    const liveDoc = (customTasks) => ({ customTasks });
    // Wire runTransaction to run the callback against a fake tx whose
    // get() serves `docData` (null = doc doesn't exist).
    const arm = (docData) => {
        const tx = {
            get: vi.fn(async () => ({ exists: () => docData !== null, data: () => docData })),
            update: vi.fn(),
            set: vi.fn(),
        };
        runTransaction.mockImplementation(async (_db, fn) => await fn(tx));
        return tx;
    };
    const a = { id: 'a', task: 'A' };
    const b = { id: 'b', task: 'B' };
    const c = { id: 'c', task: 'C' };
    const d = { id: 'd', task: 'D' };

    it('mutates ONLY the target task, via the owning period dot-path, and mirrors history', async () => {
        const tx = arm(liveDoc({ FOH: { all: [a, b] } }));
        await mutateOpsChecklistTask('webster', 'FOH', 'b', t => ({ ...t, task: 'B2' }));
        expect(tx.update).toHaveBeenCalledTimes(1);
        const [ref, patch] = tx.update.mock.calls[0];
        expect(ref.path).toBe('ops/checklists2_webster');
        expect(patch['customTasks.FOH.all']).toEqual([a, { id: 'b', task: 'B2' }]);
        // History mirror: nested set-merge on today's history row.
        expect(tx.set).toHaveBeenCalledTimes(1);
        const [href, hdata, hopts] = tx.set.mock.calls[0];
        expect(href.path).toMatch(/^checklistHistory_webster\/\d{4}-\d{2}-\d{2}$/);
        expect(hdata.customTasks.FOH.all).toEqual([a, { id: 'b', task: 'B2' }]);
        expect(hopts).toEqual({ merge: true });
    });

    it('mutateFn returning null deletes the task', async () => {
        const tx = arm(liveDoc({ FOH: { all: [a, b, c] } }));
        await mutateOpsChecklistTask('webster', 'FOH', 'b', () => null);
        expect(tx.update.mock.calls[0][1]['customTasks.FOH.all']).toEqual([a, c]);
    });

    it('finds tasks in the legacy morning/afternoon periods', async () => {
        const tx = arm(liveDoc({ BOH: { morning: [a], afternoon: [b] } }));
        await mutateOpsChecklistTask('maryland', 'BOH', 'b', t => ({ ...t, task: 'B2' }));
        const patch = tx.update.mock.calls[0][1];
        expect(patch['customTasks.BOH.afternoon']).toEqual([{ id: 'b', task: 'B2' }]);
        expect(patch['customTasks.BOH.morning']).toBeUndefined();
    });

    it('throws (aborting the tx) when the task id is not in the live doc', async () => {
        arm(liveDoc({ FOH: { all: [a] } }));
        await expect(mutateOpsChecklistTask('webster', 'FOH', 'zzz', t => t))
            .rejects.toThrow('task not found');
    });

    it('create branch: seeds a missing doc from fallbackSideArr with the mutation applied', async () => {
        const tx = arm(null);
        await mutateOpsChecklistTask('webster', 'FOH', 'a', t => ({ ...t, task: 'A2' }), { fallbackSideArr: [a, b] });
        expect(tx.update).not.toHaveBeenCalled();
        const liveSet = tx.set.mock.calls.find(([r]) => r.path === 'ops/checklists2_webster');
        expect(liveSet[1].customTasks.FOH.all).toEqual([{ id: 'a', task: 'A2' }, b]);
        expect(liveSet[2]).toEqual({ merge: true });
    });

    it('swap exchanges two NON-adjacent tasks in place and leaves the rest untouched', async () => {
        const tx = arm(liveDoc({ FOH: { all: [a, b, c, d] } }));
        await swapOpsChecklistTasks('webster', 'a', 'd');
        expect(tx.update.mock.calls[0][1]['customTasks.FOH.all']).toEqual([d, b, c, a]);
    });

    it('swap aborts when the partner id vanished (concurrent delete)', async () => {
        arm(liveDoc({ FOH: { all: [a, b] } }));
        await expect(swapOpsChecklistTasks('webster', 'a', 'zzz')).rejects.toThrow('swap partner not found');
    });

    it('append adds to the live array; a retry with the same id cannot double-append', async () => {
        const tx = arm(liveDoc({ FOH: { all: [a] } }));
        await appendOpsChecklistTask('webster', 'FOH', b);
        expect(tx.update.mock.calls[0][1]['customTasks.FOH.all']).toEqual([a, b]);
        const tx2 = arm(liveDoc({ FOH: { all: [a, b] } }));
        await appendOpsChecklistTask('webster', 'FOH', b); // id already present
        expect(tx2.update.mock.calls[0][1]['customTasks.FOH.all']).toEqual([a, b]);
    });

    it('append merges a legacy morning/afternoon side into `all` (same as the old listener-migrated write)', async () => {
        const tx = arm(liveDoc({ FOH: { morning: [a], afternoon: [b] } }));
        await appendOpsChecklistTask('webster', 'FOH', c);
        expect(tx.update.mock.calls[0][1]['customTasks.FOH.all']).toEqual([a, b, c]);
    });

    it('append creates the doc when it does not exist yet', async () => {
        const tx = arm(null);
        await appendOpsChecklistTask('webster', 'BOH', a);
        const liveSet = tx.set.mock.calls.find(([r]) => r.path === 'ops/checklists2_webster');
        expect(liveSet[1].customTasks.BOH.all).toEqual([a]);
        expect(liveSet[2]).toEqual({ merge: true });
    });
});
