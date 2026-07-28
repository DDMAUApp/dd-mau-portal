// Tests for the free-text label helpers behind PrintCenter's Custom
// Print modal. Pins the 2026-07-10 fixes: the size chips map to
// DISTINCT Brother scales (the old map was keyed small/medium/large,
// so the UI's 'normal' and 'huge' both silently fell back to 1.0 and
// the size tabs looked dead), and the date/name stamps share one
// format across the Epson / AirPrint / direct-IPP paths.

import { describe, it, expect, vi } from 'vitest';

// labelPrinting.js drags in firebase + printer transports — none of
// which the pure helpers under test need. Mock them away.
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, CapacitorHttp: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn(), collection: vi.fn(), getDoc: vi.fn(), setDoc: vi.fn(),
    addDoc: vi.fn(), onSnapshot: vi.fn(), serverTimestamp: vi.fn(),
    query: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), deleteField: vi.fn(),
}));
vi.mock('./audit', () => ({ recordAudit: vi.fn() }));
vi.mock('./labelFormat', () => ({ getLabelFormat: vi.fn(), getLabelFormatFast: vi.fn() }));
vi.mock('./printBridge', () => ({
    tryPrintViaBridge: vi.fn(), payloadToBridgeFormat: vi.fn(), warmPrintBridge: vi.fn(),
}));
vi.mock('./brotherIpp', () => ({ printBrotherDirect: vi.fn() }));

import { freeTextDateStamp, brotherFreeTextScale } from './labelPrinting';

describe('freeTextDateStamp', () => {
    it('formats mm/dd/yy h:mma with a/p suffix', () => {
        expect(freeTextDateStamp(new Date(2026, 6, 10, 8, 5))).toBe('07/10/26 8:05a');
        expect(freeTextDateStamp(new Date(2026, 0, 2, 14, 30))).toBe('01/02/26 2:30p');
    });
    it('midnight renders as 12:xxa, noon as 12:xxp', () => {
        expect(freeTextDateStamp(new Date(2026, 6, 10, 0, 15))).toBe('07/10/26 12:15a');
        expect(freeTextDateStamp(new Date(2026, 6, 10, 12, 0))).toBe('07/10/26 12:00p');
    });
});

describe('brotherFreeTextScale', () => {
    it('every UI size key maps to a DISTINCT scale', () => {
        // Regression — 'normal' and 'huge' used to fall through to the
        // same 1.0 default because the map was keyed small/medium/large.
        const scales = ['small', 'normal', 'large', 'huge'].map(brotherFreeTextScale);
        expect(new Set(scales).size).toBe(4);
        expect(brotherFreeTextScale('small')).toBeLessThan(brotherFreeTextScale('normal'));
        expect(brotherFreeTextScale('normal')).toBeLessThan(brotherFreeTextScale('large'));
        expect(brotherFreeTextScale('large')).toBeLessThan(brotherFreeTextScale('huge'));
    });
    it('legacy "medium" and numeric sizes pass through; garbage → 1.0', () => {
        expect(brotherFreeTextScale('medium')).toBe(1.0);
        expect(brotherFreeTextScale(1.3)).toBe(1.3);
        expect(brotherFreeTextScale('nonsense')).toBe(1.0);
        expect(brotherFreeTextScale(undefined)).toBe(1.0);
    });
});

// ── Translated-name size (title2Scale, Andrew 2026-07-27) ─────────────
// "the sticker item name in spanish needs a size format too … make sure
// the sizes changes according to the change." Proves the editor slider
// value actually reaches the printed label AND the on-screen preview.
import { buildLabelPayload, buildLabelPreviewModel } from './labelPrinting';

describe('title2Scale (translated-name size slider)', () => {
    const base = {
        itemName: 'Pork Bowl',
        itemNameEs: 'Bowl de Cerdo',
        prepDate: new Date('2026-07-27T12:00:00'),
        shelfLifeDays: 5,
        preppedBy: 'Andrew',
        location: 'Webster',
        language: 'en',
        paperWidthMm: 58, // 34 cols
    };
    const payloadWith = (title2Scale) => buildLabelPayload({
        ...base,
        format: { showTitleTranslation: true, title2Scale },
    });

    it('slider value flows through to the print payload', () => {
        expect(payloadWith(1).title2Scale).toBe(1);
        expect(payloadWith(4).title2Scale).toBe(4);
        // longest word "CERDO" = 5 chars; 34 cols fits scale 6 → cfg wins
        expect(payloadWith(6).title2Scale).toBe(6);
    });

    it('width auto-fit still caps long words below the slider value', () => {
        const p = buildLabelPayload({
            ...base,
            itemNameEs: 'Descongelacion Extraordinaria', // 15-char word
            format: { showTitleTranslation: true, title2Scale: 6 },
            paperWidthMm: 40, // 21 cols → max fit = floor(21/15) = 1
        });
        expect(p.title2Scale).toBe(1);
    });

    it('preview model renders the translated line at the chosen size', () => {
        // buildLabelPreviewModel returns { cols, segs: [{text, w, h, …}] }.
        const segAt = (scale) => buildLabelPreviewModel(payloadWith(scale))
            .segs.find(s => String(s.text).includes('CERDO'));
        const small = segAt(1);
        const big = segAt(4);
        expect(small).toBeTruthy();
        expect(big).toBeTruthy();
        expect(small.w).toBe(1);
        expect(small.h).toBe(1);
        expect(big.w).toBe(4);
        expect(big.h).toBe(4);
    });

    it('no translated line when the toggle is off or names identical', () => {
        const off = buildLabelPayload({ ...base, format: { showTitleTranslation: false, title2Scale: 4 } });
        expect(off.titleLines2).toEqual([]);
        const same = buildLabelPayload({
            ...base, itemNameEs: 'Pork Bowl',
            format: { showTitleTranslation: true, title2Scale: 4 },
        });
        expect(same.titleLines2).toEqual([]);
    });
});

// ── Per-block bold + size (Andrew 2026-07-27: "make every text from the
// top to bottom editable for size to bold") ───────────────────────────
// GOLDEN RULE guard: with an empty saved format, every block must keep
// TODAY's flags — date/band/allergens/footer were always em (bold),
// time/meta/title2/ingredients/notes were always plain, and none of the
// new scales existed (= 1). Then proves the new knobs actually reach the
// preview model (which mirrors renderPrepLabelBody block-for-block).
// No italic tests on purpose — the TM-L100's ePOS-Print XML has no
// italic attribute, so the feature deliberately doesn't exist.
describe('per-block bold + size (every-text-editable, 2026-07-27)', () => {
    const base = {
        itemName: 'Pork Bowl',
        itemNameEs: 'Bowl de Cerdo',
        prepDate: new Date('2026-07-27T12:00:00'), // use-by 08/01/26 = SAT
        shelfLifeDays: 5,
        preppedBy: 'Andrew',
        location: 'Webster',
        allergens: ['Soy', 'Wheat'],
        ingredients: ['Rice noodles'],
        notes: 'Keep cold',
        language: 'en',
        paperWidthMm: 58, // 34 cols
    };
    const seg = (model, pred) => model.segs.find(pred);

    it('empty format keeps today\'s exact defaults (payload + preview)', () => {
        const p = buildLabelPayload({ ...base, format: {} });
        // Payload flags — blocks that always printed em default bold ON.
        expect(p.dateBold).toBe(true);
        expect(p.bandBold).toBe(true);
        expect(p.allergensBold).toBe(true);
        expect(p.footerBold).toBe(true);
        expect(p.timeBold).toBe(false);
        expect(p.metaBold).toBe(false);
        expect(p.title2Bold).toBe(false);
        expect(p.ingredientsBold).toBe(false);
        expect(p.notesBold).toBe(false);
        expect(p.allergensScale).toBe(1);
        expect(p.ingredientsScale).toBe(1);
        expect(p.notesScale).toBe(1);
        expect(p.footerScale).toBe(1);
        // Preview segments mirror the printed em/w/h exactly.
        const m = buildLabelPreviewModel(p);
        // (w/h 4 not 5: the 8-char date width-fits 34 cols → floor(34/8).)
        const dateSeg = seg(m, s => s.text === '07/27/26');
        expect(dateSeg).toMatchObject({ em: true, w: 4, h: 4 });
        const timeSeg = seg(m, s => s.text === '12:00p');
        expect(timeSeg).toMatchObject({ em: false, w: 2, h: 2 });
        const metaSeg = seg(m, s => String(s.text).startsWith('Use by:'));
        expect(metaSeg).toMatchObject({ em: false, w: 1, h: 1 });
        const bandSeg = seg(m, s => s.text === 'SAT');
        expect(bandSeg).toMatchObject({ em: true });
        const aSeg = seg(m, s => String(s.text).startsWith('ALLERGENS:'));
        expect(aSeg).toMatchObject({ em: true, w: 1, h: 1 });
        const iSeg = seg(m, s => s.text === '- Rice noodles');
        expect(iSeg).toMatchObject({ em: false, w: 1, h: 1 });
        const nSeg = seg(m, s => s.text === 'Keep cold');
        expect(nSeg).toMatchObject({ em: false, w: 1, h: 1 });
        const fSeg = seg(m, s => s.text === 'DD MAU');
        expect(fSeg).toMatchObject({ em: true, w: 1, h: 1 });
    });

    it('new knobs flow into the matching preview segments (w/h + em)', () => {
        const p = buildLabelPayload({
            ...base,
            allergens: ['Soy'], // "ALLERGENS: Soy" = 14 chars → scale 2 fits 34 cols
            format: {
                footerScale: 3, allergensScale: 2, allergensBold: true,
                ingredientsBold: true, metaBold: true, dateBold: false, timeBold: true,
            },
        });
        const m = buildLabelPreviewModel(p);
        // footerScale 3: "DD MAU" (6 chars) fits scale 3 on 34 cols.
        expect(seg(m, s => s.text === 'DD MAU')).toMatchObject({ em: true, w: 3, h: 3 });
        expect(seg(m, s => String(s.text).startsWith('ALLERGENS:')))
            .toMatchObject({ em: true, w: 2, h: 2 });
        expect(seg(m, s => s.text === '- Rice noodles')).toMatchObject({ em: true });
        expect(seg(m, s => String(s.text).startsWith('Use by:'))).toMatchObject({ em: true });
        // dateBold OFF / timeBold ON invert the old hardcoded pair.
        expect(seg(m, s => s.text === '07/27/26')).toMatchObject({ em: false });
        expect(seg(m, s => s.text === '12:00p')).toMatchObject({ em: true });
    });

    it('scaled ingredient lines width-fit the roll (no overflow at scale 3)', () => {
        const p = buildLabelPayload({
            ...base,
            paperWidthMm: 40, // 21 cols
            ingredients: ['Lemongrass chicken marinade mix', 'Rice'],
            format: { ingredientsScale: 3 },
        });
        const m = buildLabelPreviewModel(p);
        // Long line: "- " + 30 sliced chars = 32 chars > 21 cols → forced to 1.
        const long = seg(m, s => String(s.text).startsWith('- Lemongrass'));
        expect(long.w).toBe(1);
        expect(long.w * long.text.length).toBeLessThanOrEqual(Math.max(21, long.text.length));
        // Short line: "- Rice" (6 chars) × 3 = 18 ≤ 21 cols → full scale 3.
        expect(seg(m, s => s.text === '- Rice')).toMatchObject({ w: 3, h: 3 });
    });
});
