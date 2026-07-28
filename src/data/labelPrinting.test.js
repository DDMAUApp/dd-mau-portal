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
