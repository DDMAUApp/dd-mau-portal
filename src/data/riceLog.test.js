// Fried Rice Rice log (2026-11-02, rebuilt on two routes 2026-11-03).
import { describe, it, expect, beforeEach } from 'vitest';
import {
    RICE_BATCH_KIND, RICE_ROUTE_FRIDGE, RICE_ROUTE_TODAY, RICE_STATUS, RICE_TOSS_HOURS,
    RICE_WHEEL_START_F, RICE_MAX_COPIES,
    buildRiceBatchDoc, buildRiceEdit, buildRiceLogHtml, buildRiceTossedStartDoc, duplicateBatchNumbers,
    buildRiceLowReadingDoc, fmtRiceDay, isRiceOpen, loadRiceAttempts, nextBatchNo, parseRiceTemp, riceBatchState, riceCloseFields,
    riceConnectionState, riceCreatedMs, riceDayStr, riceDaySummary, riceDeletePolicy, riceEditPolicy,
    riceEditText, riceGoodMorningReading, riceIntoFridgeFields, riceLowReadingText, riceMorningFields, riceOlderOpen, riceOutcomeText, ricePastLimit,
    riceReadingTime, riceReprintCopies, riceRowFlags, riceScreenDay, riceStickersPrinted, riceSummaryLine, saveRiceAttempts,
} from './riceLog';
import { DEFAULT_LABEL_FORMAT, mergeWithDefaults, clampLabelFormat } from './labelFormat';
import { STICKER_SECTIONS, resolveSections } from './stickerListsOverride';
import { COMPONENT_KIND_TONE } from './itemBuild';
import { buildLabelPayload, buildLabelPreviewModel, resolveLabelFormatForKind, renderEposXml } from './labelPrinting';
import { payloadToBridgeFormat } from './printBridge';

const made = new Date(2026, 10, 2, 10, 15);   // Mon Nov 2 2026, 10:15a local
const at = (h, m, d = 2) => new Date(2026, 10, d, h, m);
const MIN = 60000;

const todayBatch = (over = {}) => ({
    id: 'r1',
    ...buildRiceBatchDoc({
        madeAt: made, location: 'webster', cookedBy: 'Laura Hurtado', batchNo: 3,
        startTempF: 198, startAttempts: [198], startSetBy: 'rolled',
    }),
    createdMs: made.getTime(),
    ...over,
});
const fridgeBatch = (over = {}) => ({
    id: 'f1',
    ...buildRiceBatchDoc({
        madeAt: made, route: RICE_ROUTE_FRIDGE, location: 'webster', cookedBy: 'Laura Hurtado', batchNo: 5,
        startTempF: 196, startAttempts: [196], startSetBy: 'tapped',
    }),
    createdMs: made.getTime(),
    ...over,
});
// A row exactly as builds up to v1.0.500 wrote it.
const oldRow = (over = {}) => ({
    id: 'o1', location: 'webster', cookDay: '2026-11-02', batchNo: 3,
    cookedAt: made.toISOString(),
    fridgeByAt: new Date(made.getTime() + 2 * 3600000).toISOString(),
    tossByAt: new Date(made.getTime() + 4 * 3600000).toISOString(),
    cookedBy: 'Laura Hurtado', status: 'cooling', stickerCount: 0, prints: [], notes: '',
    ...over,
});

describe('new rows', () => {
    it('For Today carries everything the plan names, plus what old builds read', () => {
        const d = buildRiceBatchDoc({
            madeAt: made, location: 'maryland', cookedBy: 'Laura Hurtado', batchNo: 4,
            startTempF: 142, startAttempts: [128, 142], startSetBy: 'rolled', timeSource: 'picked', minutesLate: 5, pans: 2,
        });
        expect(d).toMatchObject({
            schemaVersion: 2, route: 'time_control', location: 'maryland', cookDay: '2026-11-02', batchNo: 4,
            status: 'cooling', timeSource: 'picked', minutesLate: 5, startTempF: 142,
            startAttempts: [128, 142], startSetBy: 'rolled', pans: 2, cookedBy: 'Laura Hurtado',
        });
        expect(d.madeAt).toBe(made.toISOString());
        expect(d.cookedAt).toBe(d.madeAt);
        expect(new Date(d.tossByAt) - made).toBe(4 * 3600000);
        expect(new Date(d.tossByAt) - new Date(d.wokByAt)).toBe(15 * MIN);
        expect(typeof d.fridgeByAt).toBe('string');
        expect(d.seventyByAt).toBeUndefined();
    });

    it('For the Fridge has its own deadlines, and its old-build toss is the 41F time', () => {
        const d = fridgeBatch();
        expect(d.route).toBe(RICE_ROUTE_FRIDGE);
        expect(new Date(d.seventyByAt) - made).toBe(2 * 3600000);
        expect(new Date(d.fortyOneByAt) - made).toBe(6 * 3600000);
        expect(d.useByDay).toBe('2026-11-03');
        expect(d.tossByAt).toBe(d.fortyOneByAt);
        expect(d.wokByAt).toBeUndefined();
    });

    it('caps pans, keeps a name short, and leaves a reading it never got blank', () => {
        const d = buildRiceBatchDoc({ madeAt: made, location: 'webster', cookedBy: 'x'.repeat(90), batchNo: 1, pans: 9 });
        expect(d.pans).toBe(RICE_MAX_COPIES);
        expect(d.cookedBy).toHaveLength(60);
        expect(d.startTempF).toBe(null);
    });

    it('a low reading tossed at the start keeps every attempt and gets no sticker', () => {
        const d = buildRiceTossedStartDoc({ now: at(11, 0), reason: 'below_135', location: 'webster', cookedBy: 'Ana', batchNo: 2, startAttempts: [128, 130] });
        expect(d).toMatchObject({ status: 'tossed', tossReason: 'below_135', tossedBy: 'Ana', startTempF: 130, startAttempts: [128, 130], stickerCount: 0, prints: [], schemaVersion: 2 });
        expect(d.timeUnknown).toBeUndefined();
        expect(typeof d.tossByAt).toBe('string');
    });

    it('an unmarked pan has no known time, and says so', () => {
        const d = buildRiceTossedStartDoc({ now: at(11, 0), reason: 'no_sticker', location: 'webster', cookedBy: 'Ana', batchNo: 2 });
        expect(d).toMatchObject({ status: 'tossed', tossReason: 'no_sticker', timeUnknown: true, startTempF: null, startAttempts: [] });
    });

    it('the wheel opens at the one named start number', () => {
        expect(RICE_WHEEL_START_F).toBe(200);
    });

    it('"created" is the earlier of the server time and the device stamp', () => {
        expect(riceCreatedMs({ createdAt: { toMillis: () => 5 }, createdMs: 9 })).toBe(5);
        expect(riceCreatedMs({ createdAt: { seconds: 7 }, createdMs: 9 })).toBe(9);
        expect(riceCreatedMs({ createdAt: { seconds: 7 } })).toBe(7000);
        expect(riceCreatedMs({ createdAt: null, createdMs: 9 })).toBe(9);
        expect(riceCreatedMs({ cookedAt: made.toISOString() })).toBe(made.getTime());
    });

    it('a row printed offline that reaches the server hours later doesn\'t reopen its 10-minute window', () => {
        const queued = todayBatch({ createdMs: at(10, 0).getTime(), createdAt: { toMillis: () => at(13, 0).getTime() } });
        expect(riceDeletePolicy(queued, { now: at(13, 5), isLead: false })).toMatchObject({ canDelete: false, needsReason: true });
        expect(riceEditPolicy(queued, { now: at(13, 5), isLead: false })).toEqual({ canEdit: false, why: 'window' });
    });

    it('a low reading has its own doc: no batch number, no status, no cookDay', () => {
        const d = buildRiceLowReadingDoc({ now: at(11, 2), tempF: 128, setBy: 'rolled', location: 'webster', staffName: 'Ana Reyes' });
        expect(d).toMatchObject({ recordType: 'low_reading', location: 'webster', readingDay: '2026-11-02', tempF: 128, by: 'Ana Reyes', setBy: 'rolled', at: at(11, 2).toISOString() });
        expect(d.status).toBeUndefined();
        expect(d.cookDay).toBeUndefined();
        expect(d.batchNo).toBeUndefined();
    });

    it('a batch carries the ids of the low readings before it', () => {
        expect(buildRiceBatchDoc({ madeAt: made, location: 'webster', cookedBy: 'A', batchNo: 1, lowReadingIds: ['x'] }).lowReadingIds).toEqual(['x']);
        expect(buildRiceBatchDoc({ madeAt: made, location: 'webster', cookedBy: 'A', batchNo: 1, lowReadingIds: [] }).lowReadingIds).toBeUndefined();
        expect(buildRiceTossedStartDoc({ now: made, reason: 'below_135', location: 'webster', cookedBy: 'A', batchNo: 1, startAttempts: [128, 130], lowReadingIds: ['x', 'y'] }).lowReadingIds).toEqual(['x', 'y']);
    });
});

describe('batch numbers', () => {
    it('flags a number two devices both used, ignoring void and deleted rows', () => {
        expect([...duplicateBatchNumbers([{ batchNo: 1 }, { batchNo: 2 }, { batchNo: 2 }])]).toEqual([2]);
        expect([...duplicateBatchNumbers([{ batchNo: 3 }, { batchNo: 3, status: 'void' }])]).toEqual([]);
        expect([...duplicateBatchNumbers([{ batchNo: 3 }, { batchNo: 3, deletedAt: 'x' }])]).toEqual([]);
        expect([...duplicateBatchNumbers(null)]).toEqual([]);
    });
    it('count past voided and deleted ones and never repeat', () => {
        expect(nextBatchNo([])).toBe(1);
        expect(nextBatchNo(null)).toBe(1);
        expect(nextBatchNo([{ batchNo: 1 }, { batchNo: 2, status: 'void' }])).toBe(3);
        expect(nextBatchNo([{ batchNo: 5 }, { batchNo: 2 }])).toBe(6);
        expect(nextBatchNo([{ batchNo: 1 }, { batchNo: 2, deletedAt: 'x' }])).toBe(3);
    });
});

describe('state', () => {
    it('For Today: open, then past the toss time', () => {
        const r = todayBatch();
        expect(riceBatchState(r, at(11, 0))).toBe('ok');
        expect(riceBatchState(r, at(14, 14))).toBe('ok');
        expect(riceBatchState(r, at(14, 15))).toBe('tossNow');
        expect(riceBatchState({ ...r, status: RICE_STATUS.USED }, at(20, 0))).toBe('used');
    });

    it('an old row reads the same way, with no fridge-late state left', () => {
        const r = oldRow();
        expect(riceBatchState(r, at(13, 0))).toBe('ok');
        expect(riceBatchState(r, at(14, 15))).toBe('tossNow');
    });

    it('an old row that went in the fridge is finished. A Fridge batch in the walk-in is still open', () => {
        expect(isRiceOpen(oldRow({ status: 'fridge' }))).toBe(false);
        expect(isRiceOpen(fridgeBatch({ status: 'fridge' }))).toBe(true);
        expect(riceBatchState(oldRow({ status: 'fridge' }), at(13, 0))).toBe('fridge');
    });

    it('a Fridge batch walks through cooling, past 70F, in the fridge, morning, past its use-by', () => {
        expect(riceBatchState(fridgeBatch(), at(11, 0))).toBe('cooling');
        expect(riceBatchState(fridgeBatch(), at(12, 15))).toBe('past70');
        expect(riceBatchState(fridgeBatch({ status: 'fridge' }), at(13, 0))).toBe('inFridge');
        expect(riceBatchState(fridgeBatch({ status: 'fridge' }), at(8, 0, 3))).toBe('morning');
        expect(riceBatchState(fridgeBatch(), at(8, 0, 3))).toBe('morning');
        expect(riceBatchState(fridgeBatch({ status: 'fridge' }), at(8, 0, 4))).toBe('pastUseBy');
    });

    it('a soft-deleted row is never open and never past its limit', () => {
        const r = todayBatch({ deletedAt: at(10, 20).toISOString() });
        expect(isRiceOpen(r)).toBe(false);
        expect(riceBatchState(r, at(20, 0))).toBe('deleted');
        expect(ricePastLimit(r, at(20, 0))).toBe(false);
    });
});

describe('closing a batch', () => {
    it('All Gone', () => {
        expect(riceCloseFields(todayBatch(), 'used', 'Rubisel', at(11, 40))).toEqual({
            status: 'used', usedAt: at(11, 40).toISOString(), usedBy: 'Rubisel',
        });
    });
    it('Tossed: leftover before the toss time, past_4h after', () => {
        expect(riceCloseFields(todayBatch(), 'tossed', 'R', at(11, 0))).toMatchObject({ status: 'tossed', tossReason: 'leftover', tossedBy: 'R' });
        expect(riceCloseFields(todayBatch(), 'tossed', 'R', at(15, 0))).toMatchObject({ status: 'tossed', tossReason: 'past_4h' });
    });
    it('past the toss time, the three answers log differently', () => {
        expect(riceCloseFields(todayBatch(), 'saw_gone', 'R', at(15, 0))).toMatchObject({ status: 'used', closedLate: true, closeAnswer: 'saw_gone', usedBy: 'R' });
        expect(riceCloseFields(todayBatch(), 'unknown', 'R', at(15, 0))).toMatchObject({ status: 'unknown', closeAnswer: 'unknown', unknownBy: 'R' });
    });
    it('a Fridge batch past its use-by tosses with that reason', () => {
        expect(riceCloseFields(fridgeBatch({ status: 'fridge' }), 'tossed', 'R', at(9, 0, 4))).toMatchObject({ tossReason: 'past_use_by' });
    });
    it('a Fridge batch tossed past its 70F time, out of the walk-in, has its own reason, flag and wording', () => {
        const f = riceCloseFields(fridgeBatch(), 'tossed', 'R', at(13, 0));
        expect(f.tossReason).toBe('past_70f');
        const tossed = fridgeBatch({ ...f });
        expect(riceRowFlags(tossed, [tossed], at(14, 0)).map((x) => x.code)).toEqual(['tossed_past_70f']);
        expect(ricePastLimit(tossed, at(14, 0))).toBe(true);
        expect(riceOutcomeText(tossed)).toContain('past its 70F time, not in the fridge');
        expect(riceOutcomeText(tossed, true)).toContain('pasó su hora de 70F');
        // Before 70F BY it's a leftover, and in the walk-in too.
        expect(riceCloseFields(fridgeBatch(), 'tossed', 'R', at(11, 0)).tossReason).toBe('leftover');
        expect(riceCloseFields(fridgeBatch({ status: 'fridge', fridgedAt: at(11, 0).toISOString() }), 'tossed', 'R', at(13, 0)).tossReason).toBe('leftover');
    });
    it('the older-batches line takes a For Today batch after 90 minutes, a Fridge batch at once, oldest first', () => {
        const a = todayBatch({ id: 'a', madeAt: at(9, 0).toISOString() });
        const b = todayBatch({ id: 'b', madeAt: at(10, 45).toISOString(), cookedAt: at(10, 45).toISOString() });
        const c = fridgeBatch({ id: 'c', madeAt: at(10, 50).toISOString() });
        const d = todayBatch({ id: 'd', status: 'used' });
        const e = todayBatch({ id: 'e', madeAt: at(8, 0).toISOString(), deletedAt: 'x' });
        expect(riceOlderOpen([b, c, d, e, a], at(11, 0)).map((r) => r.id)).toEqual(['a', 'c']);
    });
    it('the older-batches line puts an overdue pan ahead of older walk-in batches', () => {
        const walkIn = (id, d) => fridgeBatch({
            id, status: 'fridge', fridgedAt: at(11, 0, d).toISOString(), cookDay: `2026-11-0${d}`,
            madeAt: at(10, 0, d).toISOString(), useByDay: '2026-11-04',
        });
        const overdue = todayBatch({ id: 'late', madeAt: at(7, 0, 3).toISOString(), tossByAt: at(11, 0, 3).toISOString() });
        expect(riceOlderOpen([walkIn('w1', 2), walkIn('w2', 2), walkIn('w3', 2), overdue], at(12, 0, 3)).map((r) => r.id)[0]).toBe('late');
    });
});

describe('Fridge readings', () => {
    it('a reading has to be a number, and blank stays blank', () => {
        expect(parseRiceTemp('68')).toBe(68);
        expect(parseRiceTemp(68.4)).toBe(68);
        expect(parseRiceTemp('')).toBe(null);
        expect(parseRiceTemp(null)).toBe(null);
        expect(parseRiceTemp('hot')).toBe(null);
        expect(parseRiceTemp('999')).toBe(null);
    });
    it('Into Fridge writes no reading when nobody took one', () => {
        const f = riceIntoFridgeFields('R', { now: at(12, 0) });
        expect(f).toMatchObject({ status: 'fridge', fridgedBy: 'R', fridgedAt: at(12, 0).toISOString() });
        expect(f.fridgeTempF).toBeUndefined();
        expect(f.readings).toBeUndefined();
    });
    it('Into Fridge saves a reading when one was taken', () => {
        const f = riceIntoFridgeFields('R', { tempF: 68, at: at(11, 50), now: at(12, 0) });
        expect(f.fridgeTempF).toBe(68);
        expect(f.readings).toBeDefined();
    });
    it('a morning reading above 41F logs the toss', () => {
        expect(riceMorningFields('R', { tempF: 42, at: at(8, 0, 3) })).toMatchObject({ status: 'tossed', tossedBy: 'R', tossReason: 'morning_above_41' });
    });
    it('41F or below just saves the reading', () => {
        const f = riceMorningFields('R', { tempF: 41, at: at(8, 0, 3) });
        expect(f.status).toBeUndefined();
        expect(f.tossReason).toBeUndefined();
        expect(f.readings).toBeDefined();
    });
});

describe('delete rules', () => {
    const inside = new Date(made.getTime() + 9 * MIN);
    const after = new Date(made.getTime() + 11 * MIN);

    it('inside 10 minutes: anyone, one confirm', () => {
        expect(riceDeletePolicy(todayBatch(), { now: inside, isLead: false })).toEqual({ canDelete: true, needsReason: false, why: null });
    });
    it('after 10 minutes: shift lead or above, with a reason', () => {
        expect(riceDeletePolicy(todayBatch(), { now: after, isLead: false })).toEqual({ canDelete: false, needsReason: true, why: 'window' });
        expect(riceDeletePolicy(todayBatch(), { now: after, isLead: true })).toEqual({ canDelete: true, needsReason: true, why: null });
    });
    it('tossed, or past its limit: shift lead with a reason, even inside 10 minutes', () => {
        const tossed = todayBatch({ status: 'tossed', tossReason: 'leftover' });
        expect(riceDeletePolicy(tossed, { now: inside, isLead: false })).toMatchObject({ canDelete: false, why: 'miss' });
        expect(riceDeletePolicy(tossed, { now: inside, isLead: true })).toMatchObject({ canDelete: true, needsReason: true });
        const late = new Date(made.getTime() + 5 * 3600000);
        expect(riceDeletePolicy(todayBatch(), { now: late, isLead: false })).toMatchObject({ canDelete: false, why: 'miss' });
        expect(riceDeletePolicy(todayBatch(), { now: late, isLead: true })).toMatchObject({ canDelete: true, needsReason: true });
    });
    it('a row already deleted or voided can\'t be deleted', () => {
        expect(riceDeletePolicy(todayBatch({ deletedAt: 'x' }), { isLead: true }).canDelete).toBe(false);
        expect(riceDeletePolicy(todayBatch({ status: 'void' }), { isLead: true }).canDelete).toBe(false);
    });
    it('the window runs from creation, not from a back-dated made time', () => {
        const backdated = todayBatch({ minutesLate: 10, createdMs: made.getTime() + 10 * MIN });
        expect(riceDeletePolicy(backdated, { now: new Date(made.getTime() + 15 * MIN) }).canDelete).toBe(true);
    });
});

describe('edit rules', () => {
    const inside = new Date(made.getTime() + 9 * MIN);
    const after = new Date(made.getTime() + 11 * MIN);

    it('inside 10 minutes anyone may edit an open batch. After that, shift lead or above', () => {
        expect(riceEditPolicy(todayBatch(), { now: inside })).toEqual({ canEdit: true, why: null });
        expect(riceEditPolicy(todayBatch(), { now: after })).toEqual({ canEdit: false, why: 'window' });
        expect(riceEditPolicy(todayBatch(), { now: after, isLead: true })).toEqual({ canEdit: true, why: null });
    });
    it('a closed batch takes shift lead or above, even inside 10 minutes', () => {
        const closed = todayBatch({ status: 'used' });
        expect(riceEditPolicy(closed, { now: inside })).toEqual({ canEdit: false, why: 'closed' });
        expect(riceEditPolicy(closed, { now: after, isLead: true }).canEdit).toBe(true);
    });
    it('a deleted or voided row can\'t be edited', () => {
        expect(riceEditPolicy(todayBatch({ deletedAt: 'x' }), { isLead: true }).canEdit).toBe(false);
        expect(riceEditPolicy(oldRow({ status: 'void' }), { isLead: true }).canEdit).toBe(false);
    });
});

describe('building an edit', () => {
    const when = at(10, 20);

    it('records who, when, field, old and new for each change', () => {
        const { fields, entries } = buildRiceEdit(todayBatch(), { startTempF: '199', pans: 2, notes: 'second pan' }, 'Maria', when);
        expect(fields).toEqual({ startTempF: 199, pans: 2, notes: 'second pan' });
        expect(entries).toEqual([
            { field: 'startTempF', old: 198, new: 199, by: 'Maria', at: when.toISOString() },
            { field: 'pans', old: 1, new: 2, by: 'Maria', at: when.toISOString() },
            { field: 'notes', old: '', new: 'second pan', by: 'Maria', at: when.toISOString() },
        ]);
    });
    it('changing nothing makes no entry', () => {
        expect(buildRiceEdit(todayBatch(), { startTempF: '198', pans: 1, notes: '' }, 'M', when)).toEqual({ fields: {}, entries: [] });
    });
    it('blank means leave it alone', () => {
        expect(buildRiceEdit(todayBatch(), { startTempF: '', pans: '' }, 'M', when).entries).toEqual([]);
    });
    it('refuses a reading or pan count that makes no sense', () => {
        expect(buildRiceEdit(todayBatch(), { startTempF: 'hot' }, 'M', when)).toEqual({ error: 'reading' });
        expect(buildRiceEdit(todayBatch(), { pans: 9 }, 'M', when)).toEqual({ error: 'pans' });
        expect(buildRiceEdit(todayBatch(), { pans: 0 }, 'M', when)).toEqual({ error: 'pans' });
    });
    it('how it ended carries its own stamps', () => {
        const { fields, entries } = buildRiceEdit(todayBatch({ status: 'used', usedAt: 'x', usedBy: 'y' }), { outcome: 'tossed' }, 'M', when);
        expect(fields).toMatchObject({ status: 'tossed', tossedBy: 'M', tossReason: 'leftover' });
        expect(entries[0]).toMatchObject({ field: 'status', old: 'used', new: 'tossed' });
    });
    it('correcting how it ended takes the toss reason from the deadlines, not the row\'s state', () => {
        const unknown = todayBatch({ status: 'unknown', unknownAt: at(15, 0).toISOString(), unknownBy: 'A', closeAnswer: 'unknown' });
        const { fields } = buildRiceEdit(unknown, { outcome: 'tossed' }, 'Lead', at(16, 0));
        expect(fields).toMatchObject({ status: 'tossed', tossReason: 'past_4h', tossedBy: 'Lead' });
        const corrected = { ...unknown, ...fields };
        expect(ricePastLimit(corrected, at(16, 0))).toBe(true);
        expect(riceRowFlags(corrected, [corrected], at(16, 0)).map((f) => f.code)).toEqual(['tossed_late']);
        // An old row that went in the fridge left the 4-hour clock.
        const fridged = oldRow({ status: 'fridge', fridgedAt: at(12, 0).toISOString(), fridgedBy: 'A' });
        expect(buildRiceEdit(fridged, { outcome: 'tossed' }, 'Lead', at(20, 0)).fields.tossReason).toBe('leftover');
    });
    it('a batch corrected away from "saw it gone" doesn\'t keep that answer\'s flag', () => {
        const saw = todayBatch({ status: 'used', usedAt: at(15, 0).toISOString(), usedBy: 'A', closedLate: true, closeAnswer: 'saw_gone' });
        const { fields, entries } = buildRiceEdit(saw, { outcome: 'tossed' }, 'Lead', at(16, 0));
        const corrected = { ...saw, ...fields, edits: entries };
        expect(riceRowFlags(corrected, [corrected], at(16, 0)).map((f) => f.code)).toEqual(['tossed_late']);
    });
    it('All gone past the toss time can\'t come out clean', () => {
        const { fields } = buildRiceEdit(todayBatch(), { outcome: 'used' }, 'Lead', at(16, 0));
        const corrected = todayBatch({ ...fields });
        expect(ricePastLimit(corrected, at(16, 0))).toBe(true);
        expect(riceRowFlags(corrected, [corrected], at(16, 0)).map((f) => f.code)).toEqual(['used_late']);
    });
    it('the "saw it gone" answer can be given through an edit', () => {
        const { fields, entries } = buildRiceEdit(todayBatch(), { outcome: 'saw_gone' }, 'Lead', at(16, 0));
        expect(fields).toMatchObject({ status: 'used', closedLate: true, closeAnswer: 'saw_gone', usedBy: 'Lead' });
        expect(entries[0]).toMatchObject({ field: 'status', old: 'cooling', new: 'saw_gone' });
        expect(riceEditText(entries[0])).toContain('open to saw it gone in time');
    });
    it('an old row with no reading records blank as the old value', () => {
        const { entries } = buildRiceEdit(oldRow(), { startTempF: '180' }, 'M', when);
        expect(entries[0]).toMatchObject({ field: 'startTempF', old: null, new: 180 });
    });
    it('never touches made time or route, whatever the form sends', () => {
        const { fields } = buildRiceEdit(todayBatch(), { madeAt: 'x', route: 'cooling', cookedAt: 'x', startTempF: '199' }, 'M', when);
        expect(Object.keys(fields)).toEqual(['startTempF']);
    });
    it('reads back in plain words', () => {
        const e = { field: 'startTempF', old: 190, new: 198, by: 'M. Lee', at: at(12, 45).toISOString() };
        expect(riceEditText(e)).toBe('reading: 190F to 198F, M. Lee, 12:45 PM');
        expect(riceEditText({ field: 'status', old: 'used', new: 'unknown', by: 'M', at: at(12, 45).toISOString() })).toContain("used up to don't know");
        expect(riceEditText({ field: 'notes', old: '', new: 'x', by: 'M', at: at(12, 45).toISOString() })).toContain('(blank) to x');
        expect(riceEditText(e, true)).toContain('lectura');
    });
});

describe('flags', () => {
    const codes = (r, day = [r], now = at(11, 0)) => riceRowFlags(r, day, now).map((f) => f.code);

    it('a clean batch has none', () => {
        expect(codes(todayBatch())).toEqual([]);
    });
    it('a back-dated start flags', () => {
        expect(codes(todayBatch({ minutesLate: 5 }))).toContain('late_start');
    });
    it('a low first reading flags the batch that printed after it', () => {
        const r = todayBatch({ startAttempts: [128, 142], startTempF: 142 });
        expect(codes(r)).toContain('reprobed');
        expect(riceRowFlags(r, [r], at(11, 0)).find((f) => f.code === 'reprobed').en).toContain('128F');
    });
    it('a batch tossed at the start says why', () => {
        const low = buildRiceTossedStartDoc({ now: at(11, 0), reason: 'below_135', location: 'webster', cookedBy: 'A', batchNo: 2, startAttempts: [128, 130] });
        expect(codes(low)).toEqual(['below_135']);
        const none = buildRiceTossedStartDoc({ now: at(11, 0), reason: 'no_sticker', location: 'webster', cookedBy: 'A', batchNo: 2 });
        expect(codes(none)).toEqual(['no_sticker']);
    });
    it('closing late flags each answer', () => {
        expect(codes(todayBatch({ status: 'used', closedLate: true, usedAt: at(15, 0).toISOString() }))).toContain('closed_late');
        expect(codes(todayBatch({ status: 'unknown', unknownAt: at(15, 0).toISOString() }))).toContain('unknown');
        expect(codes(todayBatch({ status: 'tossed', tossReason: 'past_4h' }))).toContain('tossed_late');
    });
    it('a batch left open past its toss time flags', () => {
        expect(codes(todayBatch(), undefined, at(15, 0))).toContain('past_limit');
    });
    it('a reading corrected below 135F flags', () => {
        expect(codes(todayBatch({ startTempF: 120 }))).toContain('reading_low');
    });
    it('a sticker that never printed flags', () => {
        expect(codes(todayBatch({ prints: [{ ok: false, error: 'printer_rejected' }] }))).toContain('no_print');
        expect(codes(todayBatch({ prints: [{ ok: false }, { ok: true }] }))).not.toContain('no_print');
    });
    it('a timed-out job isn\'t recorded as "no sticker": nobody knows', () => {
        const r = todayBatch({ prints: [{ ok: false, error: 'printer timeout' }] });
        expect(codes(r)).toEqual(['print_unconfirmed']);
        expect(riceRowFlags(r, [r], at(11, 0))[0].en).toBe('Printer timed out. A sticker may have printed.');
        expect(codes(todayBatch({ prints: [{ ok: false, error: 'printer_rejected' }, { ok: false, error: 'printer timeout' }] }))).toEqual(['print_unconfirmed']);
    });
    it('a job that failed partway says how many are confirmed, not that none printed', () => {
        const r = todayBatch({ pans: 3, prints: [{ ok: false, error: 'printer_rejected', copies: 3, copiesPrinted: 1 }] });
        expect(codes(r)).toEqual(['short_print']);
        expect(riceRowFlags(r, [r], at(11, 0))[0].en).toBe('1 of 3 stickers confirmed.');
    });
    it('"It came out" clears a timed-out job', () => {
        expect(codes(todayBatch({ prints: [{ ok: false, error: 'printer timeout', copies: 1 }, { ok: true, seen: true, copies: 1 }] }))).toEqual([]);
    });
    it('a new batch within 30 minutes on either side of a delete flags', () => {
        const old = todayBatch({ id: 'g', batchNo: 2, createdMs: at(12, 0).getTime(), deletedAt: at(12, 31).toISOString() });
        const printedFirst = todayBatch({ id: 'n', createdMs: at(12, 30).getTime() });
        const printedAfter = todayBatch({ id: 'm', createdMs: at(12, 32).getTime() });
        const olderThanIt = todayBatch({ id: 'p', createdMs: at(11, 58).getTime() });
        expect(codes(printedFirst, [old, printedFirst])).toContain('after_delete');
        expect(codes(printedAfter, [old, printedAfter])).toContain('after_delete');
        // Printed before the deleted ticket, so it can't be the replacement.
        expect(codes(olderThanIt, [old, olderThanIt])).not.toContain('after_delete');
    });
    it('a new batch within 30 minutes after a delete flags', () => {
        const gone = todayBatch({ id: 'g', batchNo: 2, deletedAt: at(10, 0).toISOString() });
        const soon = todayBatch({ id: 's', createdMs: at(10, 25).getTime() });
        const later = todayBatch({ id: 'l', createdMs: at(10, 31).getTime() });
        const before = todayBatch({ id: 'b', createdMs: at(9, 55).getTime() });
        expect(codes(soon, [gone, soon])).toContain('after_delete');
        expect(riceRowFlags(soon, [gone, soon], at(11, 0)).find((f) => f.code === 'after_delete').en).toContain('#2');
        expect(codes(later, [gone, later])).not.toContain('after_delete');
        expect(codes(before, [gone, before])).not.toContain('after_delete');
    });
    it('the same number twice flags both rows, but not after one is deleted', () => {
        const a = todayBatch({ id: 'a' });
        const b = todayBatch({ id: 'b' });
        expect(codes(a, [a, b])).toContain('duplicate_number');
        expect(codes(a, [a, { ...b, deletedAt: at(9, 0).toISOString() }])).not.toContain('duplicate_number');
    });
    it('a Fridge batch in late, or used without a morning reading, flags', () => {
        expect(codes(fridgeBatch({ status: 'fridge', fridgedAt: at(13, 0).toISOString() }))).toContain('fridge_late');
        expect(codes(fridgeBatch({ status: 'used', usedAt: at(11, 0, 3).toISOString() }))).toContain('no_morning_reading');
        expect(codes(fridgeBatch({ status: 'used', usedAt: at(11, 0, 3).toISOString(), readings: [{ kind: 'morning', tempF: 38 }] }))).not.toContain('no_morning_reading');
        expect(codes(fridgeBatch({ status: 'tossed', tossReason: 'morning_above_41' }))).toContain('morning_above_41');
    });
    it('All Gone logged after the toss time flags and counts, from the timestamps alone', () => {
        const late = todayBatch({ status: 'used', usedAt: at(15, 0).toISOString(), usedBy: 'Old Build' });
        expect(codes(late)).toEqual(['used_late']);
        expect(ricePastLimit(late, at(16, 0))).toBe(true);
        const onTime = todayBatch({ status: 'used', usedAt: at(13, 0).toISOString() });
        expect(codes(onTime)).toEqual([]);
        expect(ricePastLimit(onTime, at(16, 0))).toBe(false);
        // Its own answer isn't a miss.
        const answered = todayBatch({ status: 'used', usedAt: at(15, 0).toISOString(), closedLate: true, closeAnswer: 'saw_gone' });
        expect(codes(answered)).toEqual(['closed_late']);
        expect(ricePastLimit(answered, at(16, 0))).toBe(false);
        // An old row reads the same way.
        expect(codes(oldRow({ status: 'used', usedAt: at(15, 0).toISOString() }))).toEqual(['used_late']);
    });
    it('a Fridge batch not in the walk-in past its 70F time flags and counts as past its limit', () => {
        const late = fridgeBatch();
        expect(codes(late, undefined, at(13, 0))).toEqual(['not_in_fridge']);
        expect(ricePastLimit(late, at(13, 0))).toBe(true);
        expect(riceDaySummary([late], at(13, 0))).toMatchObject({ pastLimit: 1, flags: 1 });
        expect(ricePastLimit(late, at(11, 0))).toBe(false);
        expect(codes(late, undefined, at(11, 0))).toEqual([]);
    });
    it('the next morning a batch never marked Into Fridge still shows it', () => {
        expect(riceBatchState(fridgeBatch(), at(8, 0, 3))).toBe('morning');
        expect(codes(fridgeBatch(), undefined, at(8, 0, 3))).toContain('not_in_fridge');
        expect(ricePastLimit(fridgeBatch(), at(8, 0, 3))).toBe(true);
        const used = fridgeBatch({ status: 'used', usedAt: at(9, 0, 3).toISOString(), readings: [{ kind: 'morning', tempF: 38, at: at(8, 0, 3).toISOString() }] });
        expect(codes(used)).toEqual(['not_in_fridge']);
        expect(ricePastLimit(used, at(10, 0, 3))).toBe(true);
    });
    it('a Fridge batch in on time has none of those', () => {
        const fine = fridgeBatch({ status: 'fridge', fridgedAt: at(11, 0).toISOString(), fridgedBy: 'A' });
        expect(codes(fine, undefined, at(13, 0))).toEqual([]);
        expect(ricePastLimit(fine, at(13, 0))).toBe(false);
    });
    it('a typed reading over a limit, after that limit\'s time, flags', () => {
        const over70 = fridgeBatch({ status: 'fridge', fridgedAt: at(11, 0).toISOString(), readings: [{ kind: 'fridge', tempF: 95, at: at(12, 30).toISOString() }] });
        expect(codes(over70, undefined, at(13, 0))).toEqual(['over_70']);
        expect(riceRowFlags(over70, [over70], at(13, 0))[0].en).toBe('Read 95F at 12:30 PM: above 70F, past its 70F time.');
        expect(ricePastLimit(over70, at(13, 0))).toBe(true);
        const over41 = fridgeBatch({ status: 'fridge', fridgedAt: at(11, 0).toISOString(), readings: [{ kind: 'fridge', tempF: 50, at: at(17, 0).toISOString() }] });
        expect(codes(over41, undefined, at(18, 0))).toEqual(['over_41']);
        // The same reading before its time is just a reading.
        const early = fridgeBatch({ status: 'fridge', fridgedAt: at(11, 0).toISOString(), readings: [{ kind: 'fridge', tempF: 95, at: at(11, 30).toISOString() }, { kind: 'fridge', tempF: 50, at: at(13, 0).toISOString() }] });
        expect(codes(early, undefined, at(13, 30))).toEqual([]);
        expect(ricePastLimit(early, at(13, 30))).toBe(false);
    });
    it('a high morning reading has one flag, not two', () => {
        const r = fridgeBatch({ status: 'tossed', tossReason: 'morning_above_41', fridgedAt: at(11, 0).toISOString(), readings: [{ kind: 'morning', tempF: 50, at: at(8, 0, 3).toISOString() }] });
        expect(codes(r, undefined, at(9, 0, 3))).toEqual(['morning_above_41']);
    });
    it('deleted and voided rows carry no flags', () => {
        expect(codes(todayBatch({ deletedAt: 'x', minutesLate: 5 }))).toEqual([]);
        expect(codes(oldRow({ status: 'void' }))).toEqual([]);
    });
});

describe('the day\'s summary', () => {
    it('counts batches, leaves out deleted and voided, and adds up past limit and flags', () => {
        const rows = [
            todayBatch({ id: 'a', status: 'used', usedAt: 'x' }),
            todayBatch({ id: 'b', batchNo: 4 }),
            todayBatch({ id: 'c', batchNo: 5, status: 'tossed', tossReason: 'past_4h' }),
            todayBatch({ id: 'd', batchNo: 6, deletedAt: at(9, 0).toISOString(), createdMs: at(8, 0).getTime() }),
            oldRow({ id: 'e', batchNo: 7, status: 'void' }),
        ];
        const s = riceDaySummary(rows, at(11, 0));
        expect(s).toMatchObject({ batches: 3, used: 1, open: 1, tossed: 1, voided: 1, deleted: 1, pastLimit: 1, flags: 1 });
        expect(riceSummaryLine(s)).toBe('3 batches: 1 used up, 1 open, 1 tossed, 1 void. 1 past limit. 1 flag.');
    });
    it('reads plainly on an empty day, in both languages', () => {
        const s = riceDaySummary([], at(11, 0));
        expect(riceSummaryLine(s)).toBe('0 batches: 0 used up, 0 open. 0 past limit. 0 flags.');
        expect(riceSummaryLine(s, true)).toContain('0 lotes');
    });
});

describe('how a row ended, in words', () => {
    it('old rows read correctly', () => {
        expect(riceOutcomeText(oldRow({ status: 'used', usedAt: at(11, 40).toISOString(), usedBy: 'Rubisel' }))).toBe('Used up, logged 11:40 AM — Rubisel');
        expect(riceOutcomeText(oldRow({ status: 'fridge', fridgedAt: at(12, 0).toISOString(), fridgedBy: 'L', fridgeTempF: 66 }))).toBe('Into fridge 12:00 PM @ 66F — L');
        expect(riceOutcomeText(oldRow({ status: 'tossed', tossedAt: at(11, 0).toISOString(), tossedBy: 'L', tossReason: 'chose_to_toss' }))).toBe('Tossed 11:00 AM — L');
        expect(riceOutcomeText(oldRow({ status: 'void', voidedBy: 'L' }))).toBe('Voided (printed by mistake) — L');
    });
    it('a batch closed the next day shows the date, not a bare time', () => {
        const t = riceOutcomeText(todayBatch({ status: 'tossed', tossedAt: at(9, 5, 3).toISOString(), tossedBy: 'Maria', tossReason: 'past_4h' }));
        expect(t).toContain('11/3 9:05 AM (logged late)');
        expect(t).toContain('4-hour limit');
    });
    it('a Fridge batch ending the next day is on schedule, not late', () => {
        const used = fridgeBatch({ status: 'used', usedAt: at(11, 0, 3).toISOString(), usedBy: 'A' });
        const tossed = fridgeBatch({ status: 'tossed', tossedAt: at(7, 5, 3).toISOString(), tossedBy: 'A', tossReason: 'morning_above_41' });
        expect(riceOutcomeText(used)).toContain('11/3 11:00 AM');
        expect(riceOutcomeText(used)).not.toContain('late');
        expect(riceOutcomeText(tossed, true)).toContain('11/3 7:05 AM');
        expect(riceOutcomeText(tossed, true)).not.toContain('tarde');
        expect(buildRiceLogHtml({ rows: [used], cookDay: '2026-11-02', locationLabel: 'W', now: at(12, 0, 3) })).not.toContain('logged late');
    });
    it('new endings', () => {
        expect(riceOutcomeText(todayBatch({ status: 'used', closedLate: true, usedAt: at(15, 0).toISOString(), usedBy: 'A' }))).toContain('saw it gone in time');
        expect(riceOutcomeText(todayBatch({ status: 'unknown', unknownAt: at(15, 0).toISOString(), unknownBy: 'A' }))).toContain("Don't know, or used late");
        expect(riceOutcomeText(todayBatch({ status: 'tossed', tossedAt: at(11, 0).toISOString(), tossReason: 'below_135' }))).toContain('below 135F, no sticker');
        expect(riceOutcomeText(todayBatch())).toBe('Still open');
        expect(riceOutcomeText(todayBatch({ status: 'used', usedAt: at(11, 0).toISOString() }), true)).toContain('Se acabó');
    });
});

describe('a reading is never back-dated without showing it', () => {
    const batch = (reading, over = {}) => fridgeBatch({ readings: [{ kind: 'fridge', tempF: 80, by: 'A', ...reading }], ...over });
    const seventy = () => new Date(fridgeBatch().seventyByAt);
    const minutesFrom70 = (m) => new Date(seventy().getTime() + m * 60000).toISOString();

    it('lateness goes by when it was tapped in', () => {
        const r = batch({ at: minutesFrom70(-1), enteredAt: minutesFrom70(180) });
        const now = new Date(minutesFrom70(181));
        expect(riceRowFlags(r, [r], now).map((f) => f.code)).toContain('over_70');
        expect(ricePastLimit({ ...r, status: 'fridge', fridgedAt: minutesFrom70(-30) }, now)).toBe(true);
    });
    it('a reading tapped in before the deadline is not late, and old readings go by their one time', () => {
        const r = batch({ at: minutesFrom70(-10), enteredAt: minutesFrom70(-9) }, { status: 'fridge', fridgedAt: minutesFrom70(-30) });
        expect(ricePastLimit(r, new Date(minutesFrom70(1)))).toBe(false);
        const old = batch({ at: minutesFrom70(5) }, { status: 'fridge', fridgedAt: minutesFrom70(-30) });
        expect(ricePastLimit(old, new Date(minutesFrom70(6)))).toBe(true);
    });
    it('shows both times past a 2-minute gap, or across a deadline', () => {
        const row = fridgeBatch();
        expect(riceReadingTime({ at: minutesFrom70(-30), enteredAt: minutesFrom70(-28) }, row)).not.toContain('entered');
        expect(riceReadingTime({ at: minutesFrom70(-30), enteredAt: minutesFrom70(-27) }, row)).toContain('entered');
        expect(riceReadingTime({ at: minutesFrom70(-1), enteredAt: minutesFrom70(0) }, row)).toContain('entered');
        expect(riceReadingTime({ at: minutesFrom70(-30), enteredAt: minutesFrom70(-27) }, row, true)).toContain('anotada');
        expect(riceReadingTime({ at: minutesFrom70(-30) }, row)).not.toContain('entered');
    });
    it('the printed log and the flag carry both times', () => {
        const r = batch({ at: minutesFrom70(-1), enteredAt: minutesFrom70(180) });
        const out = buildRiceLogHtml({ rows: [r], cookDay: r.cookDay, locationLabel: 'W', now: new Date(minutesFrom70(181)) });
        expect(out.match(/\(entered [^)]+\)/g).length).toBeGreaterThanOrEqual(2);
    });
    it('only a passing morning reading from today counts as done', () => {
        const row = (tempF, day = 3) => fridgeBatch({ readings: [{ kind: 'morning', tempF, at: at(7, 30, day).toISOString() }] });
        expect(riceGoodMorningReading(row(38), at(9, 0, 3))).toMatchObject({ tempF: 38 });
        expect(riceGoodMorningReading(row(44), at(9, 0, 3))).toBe(null);
        expect(riceGoodMorningReading(row(38, 2), at(9, 0, 3))).toBe(null);
        expect(riceGoodMorningReading(fridgeBatch(), at(9, 0, 3))).toBe(null);
    });
});

describe('the printed log', () => {
    const html = (rows, over = {}) => buildRiceLogHtml({ rows, cookDay: '2026-11-02', locationLabel: 'Webster Groves', printedBy: 'Laura Hurtado', now: at(21, 14), ...over });

    it('doesn\'t say the rice isn\'t refrigerated on a day an old-format row went in the fridge', () => {
        expect(html([todayBatch()])).toContain('It is not refrigerated.');
        const fridged = oldRow({ status: 'fridge', fridgedAt: at(12, 0).toISOString(), fridgedBy: 'L', fridgeTempF: 66 });
        expect(html([fridged])).not.toContain('It is not refrigerated.');
        expect(html([fridged])).toContain('4-hour time control under our written procedure');
        expect(html([fridged])).not.toMatch(/fridge by/i);
    });

    it('is one portrait page with the plan\'s layout', () => {
        const out = html([todayBatch({ status: 'used', usedAt: at(11, 40).toISOString(), usedBy: 'Ana Reyes', pans: 2 })]);
        expect(out).toContain('size: letter portrait');
        expect(out).toContain('RICE FOR FRIED RICE: 4-HOUR TIME CONTROL LOG');
        expect(out).toContain('Webster Groves');
        expect(out).toContain('MON 11/02/2026');
        expect(out).toContain('1 batch: 1 used up, 0 open. 0 past limit. 0 flags.');
        for (const h of ['Batch', 'Made', 'Probe', 'Toss by', 'How it ended', 'Pans', 'By (start/close)']) expect(out).toContain(`<th>${h}</th>`);
        expect(out).toContain('10:15 AM');
        expect(out).toContain('198F');
        expect(out).toContain('2:15 PM');
        expect(out).toContain('Used up, logged 11:40 AM');
        expect(out).toContain('L. Hurtado/A. Reyes');
        expect(out).toContain('Printed 9:14 PM by L. Hurtado');
        expect(out).toContain('Signature:');
    });

    it('is always in English', () => {
        const out = html([todayBatch()]);
        expect(out).toContain('lang="en"');
        expect(out).not.toMatch(/Lote|Tirar|Arroz/);
    });

    it('never says room temperature or names a fridge-by rule', () => {
        const out = html([todayBatch(), fridgeBatch({ batchNo: 6 }), oldRow({ batchNo: 7 })]).toLowerCase();
        expect(out).not.toContain('room temperature');
        expect(out).not.toMatch(/fridge[- ]by/);
        expect(out).not.toContain('temperatura ambiente');
    });

    it('old rows print with their times, a blank reading, and old endings', () => {
        const out = html([oldRow({ status: 'fridge', fridgedAt: at(12, 0).toISOString(), fridgedBy: 'Laura Hurtado', fridgeTempF: 66, prints: [{ ok: true, copies: 2 }] })]);
        expect(out).toContain('10:15 AM');
        expect(out).toContain('----');
        expect(out).toContain('Into fridge 12:00 PM @ 66F');
        // Pans fall back to the stickers an old row actually printed.
        expect(out).toMatch(/<td>2<\/td>/);
        expect(out).toContain('1 batch: 0 used up, 0 open, 1 into fridge.');
    });

    it('escapes what people typed', () => {
        const out = html([todayBatch({ cookedBy: '<b>x</b>', notes: '<script>' })]);
        expect(out).not.toContain('<b>x</b>');
        expect(out).toContain('&lt;b&gt;');
    });

    it('strikes through old voided rows', () => {
        expect(html([oldRow({ status: 'void', voidedBy: 'L' })])).toContain('class="void"');
    });

    it('lists flags, marks the row, and shows corrections', () => {
        const edits = [{ field: 'startTempF', old: 190, new: 198, by: 'Maria Lee', at: at(12, 45).toISOString() }];
        const out = html([todayBatch({ minutesLate: 5, edits })]);
        expect(out).toContain('FLAGS');
        expect(out).toContain('#3*');
        expect(out).toContain('(edited)');
        expect(out).toContain('* #3 Stickered 5 minutes after it came out.');
        expect(out).toContain('CORRECTIONS');
        expect(out).toContain('reading: 190F to 198F, Maria Lee, 12:45 PM');
    });

    it('the By column names who closed it the way it reads now', () => {
        const saw = todayBatch({ status: 'used', usedAt: at(15, 0).toISOString(), usedBy: 'Rubisel Ramos', closedLate: true, closeAnswer: 'saw_gone' });
        const out = html([{ ...saw, status: 'tossed', tossedAt: at(16, 0).toISOString(), tossedBy: 'Carla Lead', tossReason: 'past_4h' }]);
        expect(out).toContain('L. Hurtado/C. Lead');
        expect(out).not.toContain('R. Ramos');
    });

    describe('when the server hasn\'t answered', () => {
        const unconfirmed = { notConfirmed: true, lastServerAt: at(14, 5).getTime() };

        it('an empty cached day never says no batches were made', () => {
            const out = html([], unconfirmed);
            expect(out).not.toContain('No rice batches logged this day');
            expect(out).not.toMatch(/0 batches/);
            expect(out).toContain('NOT CONFIRMED: printed offline');
            expect(out).toContain('This does not mean no batches were made');
            expect(out).toContain('Last server update 2:05 PM.');
        });

        it('a partial cached day says it may be missing batches', () => {
            const out = html([todayBatch()], unconfirmed);
            expect(out).toContain('It may be missing batches');
            expect(out).toContain('Saved on this device so far: 1 batch:');
            expect(out).toMatch(/<td>#3/);
        });

        it('a Fridge-only cached day doesn\'t say there were no For Today batches', () => {
            expect(html([fridgeBatch()], unconfirmed)).toContain('No For Today batches saved on this device.');
        });

        it('a confirmed day has no warning', () => {
            const out = html([]);
            expect(out).not.toContain('NOT CONFIRMED');
            expect(out).toContain('No rice batches logged this day.');
            expect(out).toContain('0 batches');
        });
    });

    describe('readings below 135F', () => {
        const low = (over = {}) => ({ id: 'l1', recordType: 'low_reading', tempF: 128, at: at(11, 2).toISOString(), by: 'Ana Reyes', ...over });

        it('prints each one, with the batch it led to', () => {
            const out = html([todayBatch({ startAttempts: [128, 142], startTempF: 142, lowReadingIds: ['l1'] })], { lowReadings: [low()] });
            expect(out).toContain('READINGS BELOW 135F (NO STICKER)');
            expect(out).toContain('11:02 AM 128F, A. Reyes: re-probed: batch #3.');
            expect(out).not.toContain('* 11:02 AM');
        });

        it('a reading no batch followed is marked and counts as a flag', () => {
            const out = html([], { lowReadings: [low()] });
            expect(out).toContain('* 11:02 AM 128F, A. Reyes: no batch logged after this reading.');
            expect(out).toContain('1 flag');
        });

        it('says when it ended in a toss', () => {
            const tossed = buildRiceTossedStartDoc({ now: at(11, 5), reason: 'below_135', location: 'webster', cookedBy: 'A', batchNo: 4, startAttempts: [128, 130], lowReadingIds: ['l1'] });
            expect(riceLowReadingText(low(), [tossed])).toBe('batch #4, tossed');
            expect(riceLowReadingText(low(), [], true)).toContain('ningún lote');
        });

        it('no section on a day without any', () => {
            expect(html([todayBatch()])).not.toContain('READINGS BELOW 135F');
        });
    });

    it('a deleted ticket leaves the table but gets one small line, so a gap in numbers isn\'t unexplained', () => {
        const gone = todayBatch({ id: 'g', batchNo: 2, deletedAt: at(10, 30).toISOString(), deletedBy: 'Maria Lee', deleteReason: 'Printed by mistake' });
        const keep = todayBatch({ id: 'k', batchNo: 3 });
        const out = html([gone, keep]);
        expect(out).toContain('Deleted tickets: #2 (M. Lee, 10:30 AM: Printed by mistake).');
        expect(out).not.toMatch(/<td>#2/);
        expect(out).toMatch(/<td>#3/);
        expect(out).toContain('1 batch:');
    });

    it('no deleted line on a clean day', () => {
        expect(html([todayBatch()])).not.toContain('Deleted tickets');
    });

    it('says what\'s true about the record, and doesn\'t promise entries can never change', () => {
        const out = html([todayBatch()]);
        expect(out).toContain('The app records when each entry was made.');
        expect(out).toContain('Corrections and deleted tickets are listed on this page.');
        expect(out).not.toContain("Staff can't change or delete entries");
    });

    it('a fridge table appears only on a day with a Fridge batch, with blank readings left blank', () => {
        expect(html([todayBatch()])).not.toContain('FRIDGE BATCHES');
        const out = html([fridgeBatch()]);
        expect(out).toContain('FRIDGE BATCHES (COOLING)');
        expect(out).toContain('70F by 12:15 PM. 41F by 4:15 PM. Use by TUE 11/03.');
        expect(out).toContain('Readings: none taken.');
        expect(out).toContain('still open');
        expect(out).toContain('A blank reading means nobody took one.');
    });

    it('shows the readings that were taken, morning included', () => {
        const out = html([fridgeBatch({
            status: 'fridge', fridgedAt: at(11, 30).toISOString(), fridgedBy: 'A',
            readings: [{ kind: 'fridge', tempF: 68, at: at(11, 30).toISOString() }, { kind: 'morning', tempF: 38, at: at(8, 0, 3).toISOString() }],
        })]);
        expect(out).toContain('Readings: 11:30 AM 68F, morning 8:00 AM 38F.');
        expect(out).toContain('in the fridge');
    });

    it('never claims an empty day when it has no rows of For Today but has Fridge rows', () => {
        expect(html([fridgeBatch()])).toContain('No For Today batches this day.');
        expect(html([])).toContain('No rice batches logged this day.');
    });
});

describe('connection line', () => {
    const state = (over) => riceConnectionState({ rows: [], meta: { fromCache: false }, error: false, waitedLong: true, lastServerAt: null, ...over });

    it('only a server answer may say the day is empty', () => {
        expect(state().canSayEmpty).toBe(true);
        expect(state().en).toBe('Connected. Up to date.');
        expect(state({ meta: { fromCache: true } }).canSayEmpty).toBe(false);
        expect(state({ rows: null }).canSayEmpty).toBe(false);
        expect(state({ error: true }).canSayEmpty).toBe(false);
    });
    it('says when it\'s offline and how old the data is', () => {
        expect(state({ meta: { fromCache: true } }).en).toContain('Offline');
        expect(state({ meta: { fromCache: true }, lastServerAt: at(14, 14).getTime() }).en).toBe('Offline. Showing saved data from 2:14 PM.');
    });
    it('a first cached answer isn\'t called offline yet', () => {
        expect(state({ meta: { fromCache: true }, waitedLong: false }).en).toBe('Connecting…');
    });
    it('a load that fails never reads like an empty day', () => {
        expect(state({ error: true }).en).toMatch(/Can't load this day/);
        expect(state({ error: true }).en).toMatch(/doesn't mean no batches/);
        expect(state({ rows: null, waitedLong: false }).en).toMatch(/Loading/);
        expect(state({ rows: null }).en).toMatch(/Can't reach the log/);
    });
    it('says it\'s saving while writes wait', () => {
        expect(state({ meta: { fromCache: false, pending: true } }).en).toBe('Connected. Saving…');
    });
    it('has Spanish for every state', () => {
        for (const over of [{}, { error: true }, { rows: null }, { meta: { fromCache: true } }, { meta: { pending: true } }]) {
            expect(state(over).es).toBeTruthy();
        }
    });
});

describe('a low reading waiting on the next one', () => {
    beforeEach(() => localStorage.clear());

    const none = { attempts: [], ids: [] };

    it('survives closing the screen, per store', () => {
        saveRiceAttempts('webster', 'Ana', [128], ['x'], 1000);
        expect(loadRiceAttempts('webster', 'Ana', 2000)).toEqual({ attempts: [128], ids: ['x'] });
        expect(loadRiceAttempts('maryland', 'Ana', 2000)).toEqual(none);
    });
    it('stays with the cook who took it', () => {
        saveRiceAttempts('webster', 'Ana', [128], ['x'], 1000);
        expect(loadRiceAttempts('webster', 'Luis', 2000)).toEqual(none);
    });
    it('clears', () => {
        saveRiceAttempts('webster', 'Ana', [128], ['x'], 1000);
        saveRiceAttempts('webster', 'Ana', [], [], 1000);
        expect(loadRiceAttempts('webster', 'Ana', 2000)).toEqual(none);
    });
    it('expires after 30 minutes', () => {
        saveRiceAttempts('webster', 'Ana', [128], ['x'], 1000);
        expect(loadRiceAttempts('webster', 'Ana', 1000 + 31 * MIN)).toEqual(none);
    });
    it('junk in storage is ignored', () => {
        localStorage.setItem('ddmau:riceLowReadings:webster', '{nope');
        expect(loadRiceAttempts('webster', 'Ana')).toEqual(none);
    });
});

describe('small helpers', () => {
    it('day strings and labels', () => {
        expect(riceDayStr(made)).toBe('2026-11-02');
        expect(fmtRiceDay('2026-11-03')).toBe('TUE 11/03/2026');
    });
    it('the screen says the weekday in Spanish, and the printed log\'s default stays English', () => {
        expect(riceScreenDay('2026-11-03')).toBe('TUE 11/03');
        expect(riceScreenDay('2026-11-03', true)).toBe('MAR 11/03');
        expect(riceScreenDay('2026-11-04', true)).toBe('MIÉ 11/04');
        expect(fmtRiceDay('2026-11-02', true)).toBe('LUN 11/02/2026');
        expect(riceScreenDay('', true)).toBe('');
    });
    it('a reprint offers the pans still missing a sticker, or one when none are', () => {
        expect(riceReprintCopies({ pans: 3, prints: [] })).toBe(3);
        expect(riceReprintCopies({ pans: 3, prints: [{ ok: false, error: 'printer timeout', copies: 3 }] })).toBe(3);
        expect(riceReprintCopies({ pans: 3, prints: [{ ok: false, copies: 3, copiesPrinted: 1 }] })).toBe(2);
        expect(riceReprintCopies({ pans: 3, prints: [{ ok: true, copies: 3 }] })).toBe(1);
        // An old row has no pan count.
        expect(riceReprintCopies({ prints: [{ ok: true, copies: 2 }] })).toBe(1);
        expect(riceReprintCopies({ prints: [] })).toBe(1);
        expect(riceStickersPrinted({ prints: [{ ok: true, copies: 2 }, { ok: false, copies: 3, copiesPrinted: 1 }, { ok: false }] })).toBe(3);
    });
});

// The shared-format path stays for builds up to v1.0.500, which still print
// through it from the saved label format.
describe('old builds\' sticker path still works', () => {
    const payload = (paperWidthMm = 80, language = 'en') => buildLabelPayload({
        itemName: 'Fried Rice Rice',
        itemNameEs: 'Arroz para Arroz Frito',
        prepDate: made,
        shelfLifeHours: RICE_TOSS_HOURS,
        preppedBy: 'Laura Hurtado',
        language,
        extraMetaLines: [
            { en: 'BATCH', es: 'LOTE', text: '#3' },
            { en: 'FRIDGE BY', es: 'REFRIGERAR', at: new Date(made.getTime() + 2 * 3600000) },
        ],
        format: resolveLabelFormatForKind(mergeWithDefaults(DEFAULT_LABEL_FORMAT), RICE_BATCH_KIND),
        paperWidthMm,
    });

    it('COOKED / BATCH / FRIDGE BY / TOSS reach every renderer', () => {
        const p = payload();
        expect(p.prepDateLabel).toBe('COOKED');
        expect(p.metaLines[0]).toBe('BATCH #3');
        expect(p.useByBig).toBe('2:15p');
        expect(renderEposXml(p)).toContain('FRIDGE BY 12:15p');
        expect(buildLabelPreviewModel(p).segs.some((s) => String(s.text).includes('FRIDGE BY 12:15p'))).toBe(true);
        expect(payloadToBridgeFormat(p).lines.some((l) => String(l.text).includes('FRIDGE BY 12:15p'))).toBe(true);
    });

    it('per-kind wording survives the saved-format cleaner', () => {
        const saved = clampLabelFormat(mergeWithDefaults({ kindFormats: { chemical: { titleScale: 6 } } }));
        expect(saved.kindFormats.rice_batch.preppedLabelTextEn).toBe('COOKED');
        expect(saved.kindFormats.chemical.titleScale).toBe(6);
    });

    it('other stickers are untouched with no extra lines', () => {
        const p = buildLabelPayload({ itemName: 'Pho Broth', prepDate: made, shelfLifeDays: 3, preppedBy: 'X', format: DEFAULT_LABEL_FORMAT });
        expect(p.prepDateLabel).toBe('PREPPED');
        expect(p.metaLines[0]).toMatch(/^Use by: /);
    });
});

describe('fried rice rice sticker section', () => {
    it('is a built-in section with the rice_batch kind and a tone', () => {
        const s = STICKER_SECTIONS.find((x) => x.key === 'friedRiceRice');
        expect(s?.kind).toBe(RICE_BATCH_KIND);
        expect(s.defaults[0].nameEn).toBe('Fried Rice Rice');
        expect(COMPONENT_KIND_TONE.rice_batch?.icon).toBe('🍚');
    });

    it('is appended to the live section list and keeps its kind through a saved override', () => {
        const appended = resolveSections({ sectionsOverride: [{ key: 'proteins', kind: 'protein', titleEn: 'P' }] });
        expect(appended.find((s) => s.key === 'friedRiceRice')?.kind).toBe(RICE_BATCH_KIND);
        const kept = resolveSections({ sectionsOverride: [{ key: 'friedRiceRice', kind: 'rice_batch', titleEn: 'Rice!' }] });
        expect(kept[0].kind).toBe(RICE_BATCH_KIND);
        // An older app build that doesn't know 'rice_batch' saves it as 'other'.
        const oldSave = resolveSections({ sectionsOverride: [{ key: 'friedRiceRice', kind: 'other', titleEn: 'Rice!' }] });
        expect(oldSave[0].kind).toBe(RICE_BATCH_KIND);
        expect(oldSave[0].titleEn).toBe('Rice!');
    });
});

describe('routes are named once', () => {
    it('matches what the rules accept', () => {
        expect(RICE_ROUTE_TODAY).toBe('time_control');
        expect(RICE_ROUTE_FRIDGE).toBe('cooling');
    });
});
