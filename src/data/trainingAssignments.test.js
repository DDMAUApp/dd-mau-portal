import { describe, it, expect } from 'vitest';
import { deriveAssignmentRows, myOpenAssignments, assignmentMessageText, reminderMessageText } from './trainingAssignments';
import { parseTrainingDeepLink } from './trainingDeepLink';

const module = { id: 'm18', lessons: [{ id: 'm18-l1' }, { id: 'm18-l2' }, { id: 'm18-l3' }] };
const DUE = Date.parse('2026-08-22T21:00:00-05:00');
const base = {
    moduleId: 'm18', moduleCode: 'M18', titleEn: 'Wet Floors', titleEs: 'Pisos Mojados', dueAt: DUE, status: 'open',
    recipients: [{ name: 'Ana Lopez', id: 1 }, { name: 'Bo Tran', id: 2 }, { name: 'Cy Park', id: 3 }, { name: 'Di Vu', id: 4 }],
    sent: { ana_lopez: { at: '2026-08-18T10:00:00Z' }, bo_tran: { at: '2026-08-18T10:00:01Z' }, cy_park: { at: '2026-08-18T10:00:02Z', error: 'send_failed' } },
    opened: { bo_tran: '2026-08-18T12:00:00Z', cy_park: '2026-08-18T13:00:00Z' },
    reminders: { di_vu: { lastAt: '2026-08-19T10:00:00Z', count: 1 } },
};
const docs = {
    ana_lopez: { modules: { m18: { lessonsCompleted: ['m18-l1', 'm18-l2', 'm18-l3'], attempts: [{ at: '2026-08-18T11:00:00Z', passed: true }], passed: true, passedAt: '2026-08-18T11:00:00Z' } } },
    cy_park:   { modules: { m18: { lessonsCompleted: ['m18-l1', 'zzz-other'], attempts: [{ at: '2026-08-18T14:00:00Z', passed: false }], passed: false } } },
};

describe('deriveAssignmentRows', () => {
    it('classifies done / in progress / opened / not started and counts lessons of THIS module only', () => {
        const { rows, summary } = deriveAssignmentRows(base, docs, module, Date.parse('2026-08-20T12:00:00Z'));
        const by = Object.fromEntries(rows.map(r => [r.name, r]));
        expect(by['Ana Lopez'].status).toBe('done');
        expect(by['Ana Lopez'].lessonsDone).toBe(3);
        expect(by['Ana Lopez'].passedAt).toBe('2026-08-18T11:00:00Z');
        expect(by['Bo Tran'].status).toBe('opened');
        expect(by['Cy Park'].status).toBe('in_progress');
        expect(by['Cy Park'].lessonsDone).toBe(1);           // 'zzz-other' ignored
        expect(by['Cy Park'].failedAttempts).toBe(1);
        expect(by['Cy Park'].sendError).toBe('send_failed');
        expect(by['Di Vu'].status).toBe('not_started');
        expect(by['Di Vu'].sentAt).toBeNull();
        expect(by['Di Vu'].reminderCount).toBe(1);
        expect(summary).toMatchObject({ total: 4, done: 1, inProgress: 1, opened: 1, notStarted: 1, overdue: 0, sendFailed: 1, isPastDue: false });
    });
    it('flags overdue for everyone not done once the due time passes', () => {
        const { rows, summary } = deriveAssignmentRows(base, docs, module, DUE + 60_000);
        expect(rows.find(r => r.name === 'Ana Lopez').overdue).toBe(false);
        expect(rows.filter(r => r.overdue).length).toBe(3);
        expect(summary.isPastDue).toBe(true);
    });
    it('handles missing maps and unknown staff docs', () => {
        const { rows } = deriveAssignmentRows({ moduleId: 'm18', dueAt: null, recipients: [{ name: 'New Person' }] }, {}, module);
        expect(rows[0]).toMatchObject({ status: 'not_started', lessonsDone: 0, lessonsTotal: 3, overdue: false });
    });
});

describe('myOpenAssignments', () => {
    it('returns open assignments for this staffer, sorted by due, with done flag from progress', () => {
        const a2 = { ...base, moduleId: 'm3', dueAt: DUE - 86_400_000, recipients: [{ name: 'Ana Lopez' }] };
        const closed = { ...base, status: 'closed' };
        const out = myOpenAssignments([base, a2, closed], 'ana lopez', { m18: { passed: true } });
        expect(out.map(a => a.moduleId)).toEqual(['m3', 'm18']);
        expect(out[1].done).toBe(true);
        expect(out[0].done).toBe(false);
        expect(myOpenAssignments([base], 'Nobody', {})).toEqual([]);
    });
});

describe('message text + deep link', () => {
    it('message carries both languages, code, title and due', () => {
        const t = assignmentMessageText({ moduleCode: 'M18', titleEn: 'Wet Floors', titleEs: 'Pisos Mojados', dueMs: DUE, note: 'Read by Friday' });
        expect(t).toContain('M18 · Wet Floors');
        expect(t).toContain('M18 · Pisos Mojados');
        expect(t).toContain('Read by Friday');
        expect(reminderMessageText({ moduleCode: 'M18', titleEn: 'Wet Floors', titleEs: '', dueMs: DUE, overdue: true })).toMatch(/Overdue/);
    });
    it('parses training deep links', () => {
        expect(parseTrainingDeepLink('training:m18')).toEqual({ tab: 'training', moduleId: 'm18' });
        expect(parseTrainingDeepLink('training:')).toEqual({ tab: 'training', moduleId: null });
        expect(parseTrainingDeepLink('chat:abc')).toEqual({ tab: 'chat:abc', moduleId: null });
    });
});
