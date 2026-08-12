// Bottles sticker category (2026-08-11, Andrew: retail 16oz sauce
// bottles, Look 2 "framed premium" label). Pins the section data, the
// per-kind format seed, and the label pipeline end-to-end so the
// customer-facing layout can't silently regress.
import { describe, it, expect } from 'vitest';
import { STICKER_SECTIONS } from './stickerListsOverride';
import { DEFAULT_LABEL_FORMAT, cleanKindFormats, mergeWithDefaults } from './labelFormat';
import { buildLabelPayload, buildLabelPreviewModel, resolveLabelFormatForKind } from './labelPrinting';
import { payloadToBridgeFormat } from './printBridge';

const bottlesFormat = () => resolveLabelFormatForKind({ ...DEFAULT_LABEL_FORMAT }, 'bottles');

const payloadFor = (location = 'Webster') => buildLabelPayload({
    itemName: 'Vietnamese Vinaigrette',
    itemNameEs: 'Vinagreta Vietnamita',
    prepDate: new Date(2026, 7, 11, 14, 30),
    shelfLifeDays: 7,
    preppedBy: 'Andrew',
    location,
    allergens: [],
    ingredients: [],
    language: 'en',
    desc: 'Sweet, tangy, garlic-chili classic',
    format: bottlesFormat(),
});

describe('bottles sticker section', () => {
    const section = STICKER_SECTIONS.find(s => s.key === 'bottles');
    it('exists with kind bottles and 11 sauces', () => {
        expect(section).toBeTruthy();
        expect(section.kind).toBe('bottles');
        expect(section.defaults).toHaveLength(11);
    });
    it('every bottle carries a customer description', () => {
        for (const row of section.defaults) {
            expect(row.descEn, row.nameEn).toBeTruthy();
            expect(row.descEn.split(/\s+/).length).toBeLessThanOrEqual(6);
        }
    });
});

describe('bottles kind format seed (Look 2)', () => {
    const f = bottlesFormat();
    it('framed premium: frame + header + ornament + desc + address + footer', () => {
        expect(f.showFrame).toBe(true);
        expect(f.headerText).toBe('DD MAU');
        expect(f.showOrnament).toBe(true);
        expect(f.showItemDesc).toBe(true);
        expect(f.showAddress).toBe(true);
        expect(f.footerText).toBe('DDMAUSTL.COM');
    });
    it('no date, no internal ops lines, English only', () => {
        expect(f.showDate).toBe(false);
        expect(f.showPreppedLabel).toBe(false);
        expect(f.showByName).toBe(false);
        expect(f.showLocation).toBe(false);
        expect(f.showTitleTranslation).toBe(false);
        expect(f.layout).toBe('nameFirst');
    });
    it('survives an admin save round-trip (cleanKindFormats + deep merge)', () => {
        const cleaned = cleanKindFormats({ bottles: { ...f, titleScale: 4 } });
        expect(cleaned.bottles.showFrame).toBe(true);
        expect(cleaned.bottles.headerText).toBe('DD MAU');
        expect(cleaned.bottles.showAddress).toBe(true);
        const merged = mergeWithDefaults({ kindFormats: { catering: { titleScale: 5 } } });
        expect(merged.kindFormats.bottles.showFrame).toBe(true);
    });
});

describe('bottles label payload', () => {
    it('carries every Look 2 element', () => {
        const p = payloadFor('Webster');
        expect(p.frame).toBe(true);
        expect(p.headerText).toBe('DD MAU');
        expect(p.headerOrnament).toBe(true);
        expect(p.itemDesc).toBe('Sweet, tangy, garlic-chili classic');
        expect(p.footer).toBe('DDMAUSTL.COM');
        expect(p.addressLines).toEqual(['8169 BIG BEND BLVD', 'WEBSTER GROVES, MO 63119']);
    });
    it('resolves the Maryland address from BOTH location label variants', () => {
        for (const label of ['Maryland Heights', 'MD Heights']) {
            expect(payloadFor(label).addressLines).toEqual(
                ['11982 DORSETT RD', 'MARYLAND HEIGHTS, MO 63043'], label);
        }
    });
    it('prints no date anywhere', () => {
        const p = payloadFor();
        expect(p.prepDateNumber).toBe('');
        expect(p.prepDateBig).toBe('');
        expect(p.prepTimeBig).toBe('');
    });
    it('description only renders for kinds that opt in', () => {
        const plain = buildLabelPayload({
            itemName: 'Pho Broth', prepDate: new Date(), shelfLifeDays: 3,
            preppedBy: 'A', location: 'Webster', language: 'en',
            desc: 'should not print', format: { ...DEFAULT_LABEL_FORMAT },
        });
        expect(plain.itemDesc).toBe('');
        expect(plain.frame).toBe(false);
        expect(plain.addressLines).toEqual([]);
    });
});

describe('bottles renderers', () => {
    it('block ORDER matches Look 2: header → ornament → name → desc → address → footer', () => {
        const m = buildLabelPreviewModel(payloadFor());
        const texts = m.segs.map(s => s.text);
        const at = (t) => texts.findIndex(x => x.toUpperCase().includes(t.toUpperCase()));
        expect(at('D D   M A U')).toBeGreaterThanOrEqual(0);
        expect(at('* * *')).toBeGreaterThan(at('D D   M A U'));
        expect(at('Vietnamese')).toBeGreaterThan(at('* * *'));
        expect(at('- Sweet, tangy, garlic-chili classic -')).toBeGreaterThan(at('Vietnamese'));
        expect(at('8169 BIG BEND BLVD')).toBeGreaterThan(at('- Sweet, tangy, garlic-chili classic -'));
        expect(at('DDMAUSTL.COM')).toBeGreaterThan(at('WEBSTER GROVES, MO 63119'));
    });
    it('preview model mirrors the renderer (frame + address)', () => {
        const m = buildLabelPreviewModel(payloadFor());
        expect(m.frame).toBe(true);
        const texts = m.segs.map(s => s.text);
        expect(texts.some(t => t.includes('D D   M A U'))).toBe(true);
        expect(texts).toContain('8169 BIG BEND BLVD');
        expect(texts).toContain('WEBSTER GROVES, MO 63119');
    });
    it('Brother bridge format: header, ornament, desc, address, frame', () => {
        const bf = payloadToBridgeFormat(payloadFor(), { copies: 1 });
        expect(bf.frame).toBe(true);
        const texts = bf.lines.map(l => l.text);
        expect(texts).toContain('D D   M A U');
        expect(texts).toContain('◆ ◆ ◆');
        expect(texts).toContain('- Sweet, tangy, garlic-chili classic -');
        expect(texts).toContain('8169 BIG BEND BLVD');
        expect(bf.footer).toBe('DDMAUSTL.COM');
    });
});
