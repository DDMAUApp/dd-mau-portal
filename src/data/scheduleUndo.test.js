// scheduleUndo.test.js — the Schedule editor's ↩ Undo brain (2026-09-01).
// Pins the safety rules: published shifts are never silently deleted or
// un-published, colleague edits are never clobbered (drift refusal), and
// restores can never carry `undefined` into batch.set.
import { describe, it, expect } from 'vitest';
import { pushUndo, planUndoOps, undoKindLabel, UNDO_CAP } from './scheduleUndo';

const live = (over = {}) => ({
    staffName: 'Maria', date: '2026-09-08', startTime: '10:00', endTime: '16:00',
    location: 'webster', side: null, published: false, ...over,
});

describe('pushUndo', () => {
    it('appends newest-last and caps at UNDO_CAP dropping oldest', () => {
        let s = [];
        for (let i = 0; i < UNDO_CAP + 5; i++) s = pushUndo(s, { kind: 'create', ids: [String(i)] });
        expect(s).toHaveLength(UNDO_CAP);
        expect(s[0].ids[0]).toBe('5');
        expect(s[s.length - 1].ids[0]).toBe(String(UNDO_CAP + 4));
    });
});

describe('planUndoOps — create', () => {
    it('deletes still-draft created docs, skips published, counts missing', () => {
        const m = new Map([
            ['a', live()],
            ['b', live({ published: true })],
            // 'c' missing — deleted by hand already
        ]);
        const { ops, skippedPublished, missing, drifted } = planUndoOps({ kind: 'create', ids: ['a', 'b', 'c'] }, m);
        expect(drifted).toBe(false);
        expect(ops).toEqual([{ op: 'delete', id: 'a', data: m.get('a') }]);
        expect(skippedPublished).toBe(1);
        expect(missing).toBe(1);
    });
});

describe('planUndoOps — delete', () => {
    it('recreates the doc at the same id from the snapshot', () => {
        const { ops } = planUndoOps({ kind: 'delete', id: 'x', snapshot: live({ notes: 'hi' }) }, new Map());
        expect(ops).toHaveLength(1);
        expect(ops[0].op).toBe('set');
        expect(ops[0].id).toBe('x');
        expect(ops[0].data).toMatchObject({ staffName: 'Maria', notes: 'hi', published: false, reminderSent: false });
    });

    it('is a no-op when the doc already exists again', () => {
        const { ops } = planUndoOps({ kind: 'delete', id: 'x', snapshot: live() }, new Map([['x', live()]]));
        expect(ops).toHaveLength(0);
    });

    it('strips volatile fields and undefined values from the restore payload', () => {
        const snap = live({
            id: 'x', createdAt: { seconds: 1 }, updatedAt: { seconds: 2 }, updatedBy: 'Someone',
            offeredAt: { seconds: 3 }, claimedAt: { seconds: 4 }, coverNeededAt: null,
            reminderSentAt: { seconds: 5 }, fromNeedId: undefined, offerStatus: 'open', offeredBy: 'Maria',
        });
        const { ops } = planUndoOps({ kind: 'delete', id: 'x', snapshot: snap }, new Map());
        const d = ops[0].data;
        for (const k of ['id', 'createdAt', 'updatedAt', 'updatedBy', 'offeredAt', 'claimedAt', 'reminderSentAt', 'fromNeedId']) {
            expect(k in d && k !== 'reminderSentAt' ? d[k] !== undefined : true).toBe(true);
            if (['id', 'createdAt', 'updatedAt', 'updatedBy', 'offeredAt', 'claimedAt', 'fromNeedId'].includes(k)) {
                expect(Object.prototype.hasOwnProperty.call(d, k)).toBe(false);
            }
        }
        expect(d.reminderSent).toBe(false);
        expect(d.reminderSentAt).toBeNull();
        expect(d.offerStatus).toBe('open'); // status fields survive
        for (const v of Object.values(d)) expect(v).not.toBeUndefined();
    });
});

describe('planUndoOps — update', () => {
    const before = live({ startTime: '10:00', endTime: '16:00' });
    const timesEntry = {
        kind: 'update', id: 'x', before,
        after: { startTime: '11:00', endTime: '17:00' },
        revert: { startTime: '10:00', endTime: '16:00' },
    };

    it('MERGES only the reverted fields when the live doc still matches our edit', () => {
        const m = new Map([['x', live({ startTime: '11:00', endTime: '17:00' })]]);
        const { ops, drifted } = planUndoOps(timesEntry, m);
        expect(drifted).toBe(false);
        expect(ops[0].op).toBe('merge');
        expect(ops[0].data).toEqual({ startTime: '10:00', endTime: '16:00', reminderSent: false, reminderSentAt: null });
    });

    it('REFUSES (drift) when a colleague changed the same fields since', () => {
        const m = new Map([['x', live({ startTime: '12:00', endTime: '18:00' })]]);
        const { ops, drifted } = planUndoOps(timesEntry, m);
        expect(drifted).toBe(true);
        expect(ops).toHaveLength(0);
    });

    it("AUDIT: a colleague's change to OTHER fields survives — merge never touches them", () => {
        // Manager edits times; Maria then offers the shift for cover and it
        // gets published. Undo of the times edit must not erase either.
        const m = new Map([['x', live({
            startTime: '11:00', endTime: '17:00', published: true,
            offerStatus: 'offered', offeredBy: 'Maria',
        })]]);
        const { ops, drifted } = planUndoOps(timesEntry, m);
        expect(drifted).toBe(false);
        expect(ops[0].op).toBe('merge');
        expect('offerStatus' in ops[0].data).toBe(false);
        expect('published' in ops[0].data).toBe(false);
        expect('staffName' in ops[0].data).toBe(false);
    });

    it('recreates from before-snapshot when the doc was deleted since', () => {
        const { ops, missing, drifted } = planUndoOps(timesEntry, new Map());
        expect(drifted).toBe(false);
        expect(missing).toBe(1);
        expect(ops[0]).toMatchObject({ op: 'set', id: 'x' });
        expect(ops[0].data.startTime).toBe('10:00');
    });

    it('drag-move undo reverts owner/date/offer-state and checks drift on owner/date', () => {
        const b = live({ staffName: 'Maria', date: '2026-09-08', offerStatus: 'offered', offeredBy: 'Maria' });
        const moveEntry = {
            kind: 'update', id: 'x', before: b,
            after: { staffName: 'Jose', date: '2026-09-09' },
            revert: {
                staffName: 'Maria', date: '2026-09-08',
                offerStatus: 'offered', offeredBy: 'Maria',
                pendingClaimBy: null, coverNeeded: false, proposedSplit: null, approvedBy: null,
            },
        };
        const m = new Map([['x', live({ staffName: 'Jose', date: '2026-09-09', offerStatus: null })]]);
        const ok = planUndoOps(moveEntry, m);
        expect(ok.drifted).toBe(false);
        expect(ok.ops[0].op).toBe('merge');
        expect(ok.ops[0].data).toMatchObject({ staffName: 'Maria', date: '2026-09-08', offerStatus: 'offered' });
        const m2 = new Map([['x', live({ staffName: 'Ana', date: '2026-09-09' })]]);
        const bad = planUndoOps(moveEntry, m2);
        expect(bad.drifted).toBe(true);
    });

    it('AUDIT: cache-rehydrate timestamp shims never reach a restore payload', () => {
        // Snapshots taken while the grid painted from the localStorage
        // cache carry {toMillis: fn} shims — batch.set would throw on the
        // function. Both the missing-doc recreate and the merge must drop
        // them (known names stripped; unknown ones caught by isCleanValue).
        const shim = { toMillis: () => 123, seconds: 1 };
        const b = live({ publishedAt: shim, pendingOfferAt: shim, coverRequestedAt: shim,
                         approvedAt: shim, splitAt: shim, futureTsField: shim });
        const recreate = planUndoOps({ kind: 'update', id: 'x', before: b,
            after: { startTime: '11:00' }, revert: { startTime: '10:00', futureTsField: shim } }, new Map());
        for (const k of ['publishedAt', 'pendingOfferAt', 'coverRequestedAt', 'approvedAt', 'splitAt', 'futureTsField']) {
            expect(Object.prototype.hasOwnProperty.call(recreate.ops[0].data, k)).toBe(false);
        }
        const merge = planUndoOps({ kind: 'update', id: 'x', before: b,
            after: { startTime: '11:00' }, revert: { startTime: '10:00', futureTsField: shim } },
            new Map([['x', live({ startTime: '11:00' })]]));
        expect(Object.prototype.hasOwnProperty.call(merge.ops[0].data, 'futureTsField')).toBe(false);
        const del = planUndoOps({ kind: 'delete', id: 'x', snapshot: b }, new Map());
        expect(Object.prototype.hasOwnProperty.call(del.ops[0].data, 'publishedAt')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(del.ops[0].data, 'futureTsField')).toBe(false);
    });
});

describe('undoKindLabel', () => {
    it('labels each kind and tag bilingually', () => {
        expect(undoKindLabel({ kind: 'create' }, true)).toBe('Added shift');
        expect(undoKindLabel({ kind: 'create', tag: 'autofill' }, true)).toBe('Auto-fill');
        expect(undoKindLabel({ kind: 'create', tag: 'copy' }, false)).toBe('Copiar semana anterior');
        expect(undoKindLabel({ kind: 'delete' }, false)).toBe('Turno eliminado');
        expect(undoKindLabel({ kind: 'update' }, true)).toBe('Shift change');
    });
});
