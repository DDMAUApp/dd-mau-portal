// Fried-rice rice cooling log + batch stickers (2026-11-02).
import { describe, it, expect } from 'vitest';
import {
    RICE_FRIDGE_BY_HOURS, RICE_TOSS_HOURS, RICE_BATCH_KIND, RICE_STATUS,
    riceDeadlines, nextBatchNo, riceBatchState, buildRiceBatchDoc,
    riceStickerLines, riceOutcomeText, buildRiceLogHtml, riceDayStr, duplicateBatchNumbers,
} from './riceLog';
import { DEFAULT_LABEL_FORMAT, mergeWithDefaults, clampLabelFormat } from './labelFormat';
import { STICKER_SECTIONS, resolveSections } from './stickerListsOverride';
import { COMPONENT_KIND_TONE } from './itemBuild';
import { buildLabelPayload, buildLabelPreviewModel, resolveLabelFormatForKind, renderEposXml } from './labelPrinting';
import { payloadToBridgeFormat } from './printBridge';

// Local wall-clock times — the label prints local time.
const cooked = new Date(2026, 10, 2, 10, 15);   // Mon Nov 2 2026, 10:15a

const riceRow = (over = {}) => {
    const doc = buildRiceBatchDoc({ cookedAt: cooked, location: 'webster', cookedBy: 'Laura Hurtado', batchNo: 3 });
    return { id: 'r1', ...doc, ...over };
};

const ricePayload = ({ language = 'en', format = DEFAULT_LABEL_FORMAT, paperWidthMm = 80 } = {}) => {
    const row = riceRow();
    return buildLabelPayload({
        itemName: 'Fried Rice Rice',
        itemNameEs: 'Arroz para Arroz Frito',
        prepDate: new Date(row.cookedAt),
        shelfLifeHours: RICE_TOSS_HOURS,
        preppedBy: 'Laura Hurtado',
        language,
        extraMetaLines: riceStickerLines(row),
        format: resolveLabelFormatForKind(mergeWithDefaults(format), RICE_BATCH_KIND),
        paperWidthMm,
    });
};

describe('rice clock', () => {
    it('fridge by = cooked + 2h, toss = cooked + 4h', () => {
        expect(RICE_FRIDGE_BY_HOURS).toBe(2);
        expect(RICE_TOSS_HOURS).toBe(4);
        const { fridgeByAt, tossByAt } = riceDeadlines(cooked);
        expect(fridgeByAt.getTime() - cooked.getTime()).toBe(2 * 3600000);
        expect(tossByAt.getTime() - cooked.getTime()).toBe(4 * 3600000);
    });

    it('state walks ok → fridgeLate → tossNow, finished batches report their outcome', () => {
        const row = riceRow();
        expect(riceBatchState(row, new Date(2026, 10, 2, 11, 0))).toBe('ok');
        expect(riceBatchState(row, new Date(2026, 10, 2, 12, 15))).toBe('fridgeLate');
        expect(riceBatchState(row, new Date(2026, 10, 2, 13, 0))).toBe('fridgeLate');
        expect(riceBatchState(row, new Date(2026, 10, 2, 14, 15))).toBe('tossNow');
        expect(riceBatchState({ ...row, status: RICE_STATUS.USED }, new Date(2026, 10, 2, 20, 0))).toBe('used');
    });

    it('flags a batch number two devices both used, ignoring voided batches', () => {
        expect([...duplicateBatchNumbers([{ batchNo: 1 }, { batchNo: 2 }, { batchNo: 2 }])]).toEqual([2]);
        expect([...duplicateBatchNumbers([{ batchNo: 3 }, { batchNo: 3, status: 'void' }])]).toEqual([]);
        expect([...duplicateBatchNumbers(null)]).toEqual([]);
    });

    it('batch numbers count past voided ones and never repeat', () => {
        expect(nextBatchNo([])).toBe(1);
        expect(nextBatchNo(null)).toBe(1);
        expect(nextBatchNo([{ batchNo: 1 }, { batchNo: 2, status: 'void' }])).toBe(3);
        expect(nextBatchNo([{ batchNo: 5 }, { batchNo: 2 }])).toBe(6);
    });
});

describe('rice_log doc', () => {
    it('carries every field the firestore rule requires on create', () => {
        const d = buildRiceBatchDoc({ cookedAt: cooked, location: 'maryland', cookedBy: 'Laura Hurtado', batchNo: 4 });
        expect(d.location).toBe('maryland');
        expect(d.cookDay).toBe(riceDayStr(cooked));
        expect(d.cookDay).toBe('2026-11-02');
        expect(Number.isInteger(d.batchNo)).toBe(true);
        expect(typeof d.cookedAt).toBe('string');
        expect(typeof d.fridgeByAt).toBe('string');
        expect(typeof d.tossByAt).toBe('string');
        expect(typeof d.cookedBy).toBe('string');
        expect(d.status).toBe('cooling');
        expect(new Date(d.tossByAt) - new Date(d.cookedAt)).toBe(4 * 3600000);
    });
});

describe('rice batch sticker', () => {
    it('reads COOKED / BATCH / FRIDGE BY / TOSS with the toss time as the giant band', () => {
        const p = ricePayload();
        expect(p.prepDateLabel).toBe('COOKED');
        expect(p.prepTimeBig).toBe('10:15a');
        expect(p.hoursBased).toBe(true);
        expect(p.metaLines[0]).toBe('BATCH #3');
        expect(p.metaLines[1]).toBe('FRIDGE BY 12:15p');
        expect(p.metaLines[2]).toBe('TOSS: 11/02/26 2:15p');
        expect(p.useByBig).toBe('2:15p');
        expect(p.titleLines.join(' ')).toBe('FRIED RICE RICE');
    });

    it('prints in Spanish', () => {
        const p = ricePayload({ language: 'es' });
        expect(p.prepDateLabel).toBe('COCIDO');
        expect(p.metaLines[0]).toBe('LOTE #3');
        expect(p.metaLines[1]).toBe('REFRIGERAR 12:15p');
        expect(p.metaLines[2]).toMatch(/^TIRA: /);
    });

    it('follows the 24-hour time setting', () => {
        const p = ricePayload({ format: { ...DEFAULT_LABEL_FORMAT, timeFormat: '24h' } });
        expect(p.metaLines[1]).toBe('FRIDGE BY 12:15');
        expect(p.useByBig).toBe('14:15');
    });

    it('fits the 40 mm roll (21 columns) both stores use — even the longest (12:xx) toss time', () => {
        for (const language of ['en', 'es']) {
            for (const [h, m] of [[10, 15], [8, 45], [6, 5], [23, 59]]) {
                const row = buildRiceBatchDoc({ cookedAt: new Date(2026, 10, 2, h, m), location: 'webster', cookedBy: 'L', batchNo: 12 });
                const p = buildLabelPayload({
                    itemName: 'Fried Rice Rice', itemNameEs: 'Arroz para Arroz Frito',
                    prepDate: new Date(row.cookedAt), shelfLifeHours: RICE_TOSS_HOURS, preppedBy: 'L', language,
                    extraMetaLines: riceStickerLines(row),
                    format: resolveLabelFormatForKind(mergeWithDefaults(DEFAULT_LABEL_FORMAT), RICE_BATCH_KIND),
                    paperWidthMm: 40,
                });
                for (const line of p.metaLines.slice(0, 3)) expect(line.length, `${language} ${h}:${m} "${line}"`).toBeLessThanOrEqual(21);
            }
        }
    });

    it('reaches every renderer (Epson XML, preview, Brother)', () => {
        const p = ricePayload();
        expect(renderEposXml(p)).toContain('FRIDGE BY 12:15p');
        expect(buildLabelPreviewModel(p).segs.some((s) => String(s.text).includes('FRIDGE BY 12:15p'))).toBe(true);
        expect(payloadToBridgeFormat(p).lines.some((l) => String(l.text).includes('FRIDGE BY 12:15p'))).toBe(true);
    });

    it('per-kind wording survives the saved-format cleaner and other saved kinds', () => {
        const saved = clampLabelFormat(mergeWithDefaults({ kindFormats: { chemical: { titleScale: 6 } } }));
        expect(saved.kindFormats.rice_batch.preppedLabelTextEn).toBe('COOKED');
        expect(saved.kindFormats.rice_batch.useByLabelTextEn).toBe('TOSS');
        expect(saved.kindFormats.chemical.titleScale).toBe(6);
    });

    it('leaves every other sticker unchanged when no extra lines are passed', () => {
        const p = buildLabelPayload({ itemName: 'Pho Broth', prepDate: cooked, shelfLifeDays: 3, preppedBy: 'X', format: DEFAULT_LABEL_FORMAT });
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

describe('inspector log', () => {
    it('lists every batch with its outcome and escapes names', () => {
        const rows = [
            riceRow({ status: RICE_STATUS.USED, usedAt: new Date(2026, 10, 2, 11, 40).toISOString(), usedBy: 'Rubisel', prints: [{ ok: true, copies: 2 }] }),
            riceRow({ id: 'r2', batchNo: 4, cookedBy: '<b>x</b>', status: RICE_STATUS.FRIDGE, fridgedAt: new Date(2026, 10, 2, 12, 0).toISOString(), fridgedBy: 'Laura', fridgeTempF: 66 }),
            riceRow({ id: 'r3', batchNo: 5, status: RICE_STATUS.VOID, voidedBy: 'Laura' }),
        ];
        const html = buildRiceLogHtml({ rows, cookDay: '2026-11-02', locationLabel: 'Webster Groves' });
        expect(html).toContain('#3');
        expect(html).toContain('10:15 AM');
        expect(html).toContain('12:15 PM');
        expect(html).toContain('2:15 PM');
        expect(html).toContain('Used for fried rice 11:40 AM');
        expect(html).toContain('@ 66°F');
        expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
        expect(html).not.toContain('<b>x</b>');
        expect(html).toContain('class="void"');
    });

    it('marks a batch number used twice on the inspector log', () => {
        const html = buildRiceLogHtml({ rows: [riceRow(), riceRow({ id: 'r2' })], cookDay: '2026-11-02', locationLabel: 'Webster Groves' });
        expect(html.match(/number used twice/g)).toHaveLength(2);
    });

    it('a batch closed out the next day shows the date, not a bare time', () => {
        const t = riceOutcomeText(riceRow({ status: RICE_STATUS.TOSSED, tossedAt: new Date(2026, 10, 3, 9, 5).toISOString(), tossedBy: 'Maria', tossReason: 'past_4h' }));
        expect(t).toContain('11/3 9:05 AM (logged late)');
        expect(t).toContain('4-hour limit');
    });

    it('says when a batch was tossed at the 4-hour limit', () => {
        const t = riceOutcomeText(riceRow({ status: RICE_STATUS.TOSSED, tossedAt: new Date(2026, 10, 2, 14, 20).toISOString(), tossedBy: 'Laura', tossReason: 'past_4h' }));
        expect(t).toContain('Tossed 2:20 PM');
        expect(t).toContain('4-hour limit');
    });

    it('shows an empty-day message', () => {
        expect(buildRiceLogHtml({ rows: [], cookDay: '2026-11-01', locationLabel: 'Webster Groves' })).toContain('No rice batches logged this day.');
    });
});
