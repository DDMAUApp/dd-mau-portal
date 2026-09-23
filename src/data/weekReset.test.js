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

import { resetScopeProblem, shiftInResetScope, selectResetDrafts, selectResetSeats } from './weekReset';

describe('reset scope — only drafts on the page being viewed', () => {
    const scope = { startStr: '2026-09-20', endStr: '2026-09-27', storeLocation: 'webster', side: 'foh', personFilter: null };
    const d = (id, over = {}) => ({ id, staffName: 'Maria', date: '2026-09-22', side: 'foh', location: 'webster', published: false, startTime: '10:00', endTime: '15:00', ...over });

    it('refuses a both-stores view', () => {
        expect(resetScopeProblem({ ...scope, storeLocation: 'both' })).toBe('both_stores');
        expect(selectResetDrafts([d('a')], null, { ...scope, storeLocation: 'both' })).toEqual([]);
        expect(resetScopeProblem(scope)).toBe(null);
    });
    it('published shifts are never included', () => {
        expect(shiftInResetScope(d('a', { published: true }), scope)).toBe(false);
        expect(shiftInResetScope(d('a', { published: undefined }), scope)).toBe(false); // legacy = published
        expect(shiftInResetScope(d('a'), scope)).toBe(true);
    });
    it('only the week on screen (range edges)', () => {
        expect(shiftInResetScope(d('a', { date: '2026-09-19' }), scope)).toBe(false); // last week
        expect(shiftInResetScope(d('a', { date: '2026-09-20' }), scope)).toBe(true);  // first day
        expect(shiftInResetScope(d('a', { date: '2026-09-26' }), scope)).toBe(true);  // last day
        expect(shiftInResetScope(d('a', { date: '2026-09-27' }), scope)).toBe(false); // next week
    });
    it('only the store on screen — other store and no-store shifts are left alone', () => {
        expect(shiftInResetScope(d('a', { location: 'maryland' }), scope)).toBe(false);
        expect(shiftInResetScope(d('a', { location: undefined }), scope)).toBe(false);
    });
    it('only the side on screen; legacy no-side uses the grid-resolved side', () => {
        expect(shiftInResetScope(d('a', { side: 'boh' }), scope)).toBe(false);
        expect(shiftInResetScope(d('a', { side: undefined }), scope, 'foh')).toBe(true);
        expect(shiftInResetScope(d('a', { side: undefined }), scope, 'boh')).toBe(false);
    });
    it('pending claims and the person filter', () => {
        expect(shiftInResetScope(d('a', { pendingClaimBy: 'Juan' }), scope)).toBe(false);
        expect(shiftInResetScope(d('a', { staffName: 'Juan' }), { ...scope, personFilter: 'Maria' })).toBe(false);
        expect(shiftInResetScope(d('a'), { ...scope, personFilter: 'Maria' })).toBe(true);
    });
    it('a day scope (Day view) covers just that day', () => {
        const day = { ...scope, startStr: '2026-09-22', endStr: '2026-09-23' };
        expect(shiftInResetScope(d('a', { date: '2026-09-22' }), day)).toBe(true);
        expect(shiftInResetScope(d('a', { date: '2026-09-23' }), day)).toBe(false);
    });
    it('server copy wins: moved/published/deleted since the screen loaded → skipped', () => {
        const view = [d('a'), d('b'), d('c'), d('e')];
        const live = new Map([
            ['a', d('a')],                              // still a draft here → included
            ['b', d('b', { published: true })],         // published since
            ['c', d('c', { location: 'maryland' })],    // moved to the other store
            // 'e' deleted since
        ]);
        expect(selectResetDrafts(view, live, scope).map(x => x.id)).toEqual(['a']);
    });
    it('never reaches beyond what the grid shows, even if the server has more', () => {
        const live = new Map([['a', d('a')], ['zzz', d('zzz')]]);
        expect(selectResetDrafts([d('a')], live, scope).map(x => x.id)).toEqual(['a']);
    });
    it('seats: only Unassign-made, this range/store/side, none under a person filter', () => {
        const seats = [
            { id: 's1', fromUnassign: true, date: '2026-09-22', side: 'foh', location: 'webster' },
            { id: 's2', fromUnassign: true, date: '2026-09-22', side: 'foh', location: 'maryland' },
            { id: 's3', fromUnassign: true, date: '2026-09-29', side: 'foh', location: 'webster' },
            { id: 's4', fromUnassign: true, date: '2026-09-22', side: 'boh', location: 'webster' },
            { id: 's5', date: '2026-09-22', side: 'foh', location: 'webster' }, // template / hand-made
        ];
        expect(selectResetSeats(seats, scope).map(s => s.id)).toEqual(['s1']);
        expect(selectResetSeats(seats, { ...scope, personFilter: 'Maria' })).toEqual([]);
        expect(selectResetSeats(seats, { ...scope, storeLocation: 'both' })).toEqual([]);
    });
});
