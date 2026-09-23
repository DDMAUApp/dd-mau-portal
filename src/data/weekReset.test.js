import { describe, it, expect } from 'vitest';
import { planUnassign, planUnassignUndo, planClearUndo, unassignGroupKey } from './weekReset';

const sh = (id, over = {}) => ({
    id, staffName: 'Maria', date: '2026-09-28', side: 'foh', location: 'webster',
    startTime: '10:00', endTime: '15:00', isDouble: false, published: false, notes: '', ...over,
});

describe('planUnassign', () => {
    it('identical shifts share one slot with a count and remember who had them', () => {
        const { groups, reopen } = planUnassign([
            sh('a', { staffName: 'Maria' }),
            sh('b', { staffName: 'Juan' }),
            sh('c', { staffName: 'Ana', startTime: '16:00', endTime: '21:00' }),
        ], new Map());
        expect(reopen).toEqual([]);
        expect(groups).toHaveLength(2);
        expect(groups[0]).toMatchObject({ count: 2, unassignedFrom: ['Maria', 'Juan'], shiftIds: ['a', 'b'], startTime: '10:00' });
        expect(groups[1]).toMatchObject({ count: 1, unassignedFrom: ['Ana'], startTime: '16:00' });
    });
    it('different day / store / side / double flag never merge', () => {
        const { groups } = planUnassign([
            sh('a'), sh('b', { date: '2026-09-29' }), sh('c', { location: 'maryland' }),
            sh('d', { side: 'boh' }), sh('e', { isDouble: true }),
        ], new Map());
        expect(groups).toHaveLength(5);
    });
    it('a seat filled from an existing slot is given back, not duplicated', () => {
        const needs = new Map([['n1', { filledStaff: ['Maria'], filledShiftIds: ['a'] }]]);
        const { groups, reopen } = planUnassign([sh('a', { fromNeedId: 'n1' }), sh('b')], needs);
        expect(reopen).toEqual([{ shift: expect.objectContaining({ id: 'a' }), needId: 'n1' }]);
        expect(groups).toHaveLength(1);
        expect(groups[0].shiftIds).toEqual(['b']);
    });
    it('stale fromNeedId (slot gone or no longer tracking it) becomes a new slot', () => {
        const needs = new Map([['n1', { filledShiftIds: ['zzz'] }]]);
        const { groups, reopen } = planUnassign([sh('a', { fromNeedId: 'n1' }), sh('b', { fromNeedId: 'gone' })], needs);
        expect(reopen).toEqual([]);
        expect(groups[0].count).toBe(2);
    });
    it('keeps a note only when every shift in the slot shares it', () => {
        expect(planUnassign([sh('a', { notes: 'Patio' }), sh('b', { notes: 'Patio' })], new Map()).groups[0].notes).toBe('Patio');
        expect(planUnassign([sh('a', { notes: 'Patio' }), sh('b', { notes: '' })], new Map()).groups[0].notes).toBe('');
    });
    it('skips malformed rows', () => {
        expect(planUnassign([null, { id: 'x' }, sh('a')], new Map()).groups).toHaveLength(1);
    });
    it('group key', () => {
        expect(unassignGroupKey(sh('a'))).toBe('2026-09-28|foh|webster|10:00|15:00|0');
    });
});

describe('planUnassignUndo', () => {
    const entry = {
        kind: 'unassign',
        snapshots: [{ id: 'a', data: sh('a') }, { id: 'b', data: sh('b') }],
        createdNeedIds: ['new1'],
        keptFillIds: { old1: ['keep1'] },
    };
    it('removes seats filled since, the created slots, and restores the originals', () => {
        const needsById = new Map([
            ['new1', { filledShiftIds: ['f1'] }],
            ['old1', { filledShiftIds: ['keep1', 'f2'] }],
        ]);
        const shiftsById = new Map([['f1', sh('f1')], ['f2', sh('f2')], ['keep1', sh('keep1')]]);
        const plan = planUnassignUndo(entry, { needsById, shiftsById });
        expect(plan.blockedPublished).toBe(0);
        expect(plan.deleteShifts.map(s => s.id).sort()).toEqual(['f1', 'f2']);
        expect(plan.deleteNeedIds).toEqual(['new1']);
        expect(plan.restore.map(s => s.id)).toEqual(['a', 'b']);
    });
    it('refuses entirely if a seat filled since was published', () => {
        const needsById = new Map([['new1', { filledShiftIds: ['f1'] }]]);
        const shiftsById = new Map([['f1', sh('f1', { published: true })]]);
        const plan = planUnassignUndo(entry, { needsById, shiftsById });
        expect(plan).toEqual({ blockedPublished: 1, deleteShifts: [], deleteNeedIds: [], restore: [] });
    });
    it('does not recreate an original that already exists again', () => {
        const plan = planUnassignUndo(entry, { needsById: new Map(), shiftsById: new Map([['a', sh('a')]]) });
        expect(plan.restore.map(s => s.id)).toEqual(['b']);
        expect(plan.deleteNeedIds).toEqual([]);
    });
});

describe('planClearUndo', () => {
    it('restores slots + shifts; relinks only seats whose slot was not wiped', () => {
        const entry = {
            kind: 'clear',
            shiftSnaps: [
                { id: 'a', data: sh('a', { fromNeedId: 'wiped' }) },
                { id: 'b', data: sh('b', { fromNeedId: 'kept' }) },
                { id: 'c', data: sh('c') },
            ],
            needSnaps: [{ id: 'wiped', data: { count: 2 } }],
        };
        const plan = planClearUndo(entry, { needsById: new Map(), shiftsById: new Map([['c', sh('c')]]) });
        expect(plan.restoreNeeds.map(n => n.id)).toEqual(['wiped']);
        expect(plan.restoreShifts.map(s => s.id)).toEqual(['a', 'b']);
        expect(plan.relink.map(s => s.id)).toEqual(['b']);
    });
});
