// Catering sticker section + customer-facing label format (2026-08-11).
import { describe, it, expect } from 'vitest';
import { DEFAULT_LABEL_FORMAT, mergeWithDefaults, cleanKindFormats } from './labelFormat';
import { STICKER_SECTIONS, getStampedDefaults, resolveSections } from './stickerListsOverride';
import { COMPONENT_KIND_TONE } from './itemBuild';
import { buildLabelPayload, buildLabelPreviewModel, resolveLabelFormatForKind } from './labelPrinting';
import { payloadToBridgeFormat } from './printBridge';

describe('catering sticker section', () => {
    const catering = STICKER_SECTIONS.find(s => s.key === 'catering');
    it('exists with the catering kind and 30 items', () => {
        expect(catering).toBeTruthy();
        expect(catering.kind).toBe('catering');
        expect(catering.defaults.length).toBe(30);
    });
    it("applies Andrew's review edits", () => {
        const names = catering.defaults.map(r => r.nameEn);
        // Proteins WITHOUT the Lemongrass prefix
        expect(names).toContain('Chicken');
        expect(names.some(n => n.startsWith('Lemongrass'))).toBe(false);
        // Pork called out on the Vietnamese egg rolls
        expect(names).toContain('Vietnamese Egg Rolls (Pork)');
    });
    it('every item is bilingual', () => {
        for (const r of catering.defaults) {
            expect(r.nameEn?.length).toBeGreaterThan(0);
            expect(r.nameEs?.length).toBeGreaterThan(0);
        }
    });
    it('stamps stable default ids and survives a sectionsOverride doc', () => {
        expect(getStampedDefaults('catering')[0].id).toBe('default-catering-0');
        // Prod has a sectionsOverride WITHOUT catering — resolveSections must
        // re-append the new built-in so it can never be missing.
        const resolved = resolveSections({ sectionsOverride: [{ key: 'proteins', kind: 'protein', titleEn: 'P' }] });
        expect(resolved.some(s => s.key === 'catering')).toBe(true);
    });
    it('has a tone entry (UI chips)', () => {
        expect(COMPONENT_KIND_TONE.catering?.labelEn).toBe('Catering');
    });
});

describe('customer-facing catering label format', () => {
    it('seeds a nameFirst format with the internal lines off and branding footer', () => {
        const f = DEFAULT_LABEL_FORMAT.kindFormats.catering;
        expect(f.layout).toBe('nameFirst');
        expect(f.showPreppedLabel).toBe(false);
        expect(f.showByName).toBe(false);
        expect(f.showLocation).toBe(false);
        expect(f.showUseByBand).toBe(false);
        expect(f.footerText).toBe('DD MAU · DDMAUSTL.COM');
        // Andrew: no "Made fresh for your event" line anywhere.
        expect(JSON.stringify(f)).not.toMatch(/made fresh/i);
    });
    it('deep-merges saved kindFormats without wiping the catering seed', () => {
        // Admin saves a tweak to a DIFFERENT kind — catering must survive.
        const merged = mergeWithDefaults({ kindFormats: { chemical: { titleScale: 6 } } });
        expect(merged.kindFormats.catering.layout).toBe('nameFirst');
        expect(merged.kindFormats.chemical.titleScale).toBe(6);
        // Admin tweaks catering itself — their field wins, seed fields remain.
        const merged2 = mergeWithDefaults({ kindFormats: { catering: { titleScale: 6 } } });
        expect(merged2.kindFormats.catering.titleScale).toBe(6);
        expect(merged2.kindFormats.catering.showByName).toBe(false);
    });
    it('cleanKindFormats keeps the new per-kind visibility fields + footerText', () => {
        const out = cleanKindFormats({ catering: { showByName: false, showTime: true, footerText: 'X'.repeat(100) } });
        expect(out.catering.showByName).toBe(false);
        expect(out.catering.showTime).toBe(true);
        expect(out.catering.footerText.length).toBe(60);
    });
});

describe('brand band (black bar, white DD MAU)', () => {
    const cateringFormat = resolveLabelFormatForKind(mergeWithDefaults({}), 'catering');
    const payload = buildLabelPayload({
        itemName: 'Peanut Sauce',
        itemNameEs: 'Salsa de Cacahuate',
        prepDate: new Date('2026-08-11T12:00:00'),
        shelfLifeDays: 3,
        format: cateringFormat,
    });
    it('rides the payload for catering and only catering', () => {
        expect(payload.brandBand).toBe('DD MAU');
        const plain = buildLabelPayload({
            itemName: 'Sanitizer', prepDate: new Date('2026-08-11T12:00:00'),
            shelfLifeDays: 3, format: mergeWithDefaults({}),
        });
        expect(plain.brandBand).toBe(null);
    });
    it('is the FIRST preview segment, flagged band, mirroring the Epson reverse block', () => {
        const m = buildLabelPreviewModel(payload);
        expect(m.segs[0].band).toBe(true);
        expect(m.segs[0].text).toContain('DD MAU');
        expect(m.segs[0].em).toBe(true);
    });
    it('is the FIRST Brother line, flagged band', () => {
        const bf = payloadToBridgeFormat(payload);
        expect(bf.lines[0]).toMatchObject({ text: 'DD MAU', bold: true, band: true });
    });
    it('catering labels are English-only (no Spanish second line) per Andrew', () => {
        expect(payload.titleLines2 || []).toHaveLength(0);
        const bf = payloadToBridgeFormat(payload);
        expect(bf.lines.some(l => /cacahuate/i.test(l.text))).toBe(false);
    });
    it('catering labels carry NO date (round 3) — other kinds keep theirs', () => {
        expect(payload.prepDateNumber).toBe('');
        expect(payload.prepDateBig).toBe('');
        expect(payload.prepTimeBig).toBe('');
        // Preview + Brother emit no date line at all.
        const dateRe = /08\/11\/26|8\/11/;
        expect(buildLabelPreviewModel(payload).segs.some(s => dateRe.test(s.text))).toBe(false);
        expect(payloadToBridgeFormat(payload).lines.some(l => dateRe.test(l.text))).toBe(false);
        // Default format (internal prep labels) still dates.
        const plain = buildLabelPayload({
            itemName: 'Sanitizer', prepDate: new Date('2026-08-11T12:00:00'),
            shelfLifeDays: 3, format: mergeWithDefaults({}),
        });
        expect(plain.prepDateNumber).toBe('08/11/26');
    });
    it('cleanKindFormats round-trips the band fields', () => {
        const out = cleanKindFormats({ catering: { showBrandBand: false, brandBandText: 'B'.repeat(50) } });
        expect(out.catering.showBrandBand).toBe(false);
        expect(out.catering.brandBandText.length).toBe(24);
    });
});

// 2026-08-15 — customer-facing kinds stay out of the sticker search index.
import { CUSTOMER_FACING_KINDS } from './stickerListsOverride';
describe('customer-facing kinds are search-excluded by KIND', () => {
    it('flags catering + bottles and survives an admin sectionsOverride re-order', () => {
        expect(CUSTOMER_FACING_KINDS.has('catering')).toBe(true);
        expect(CUSTOMER_FACING_KINDS.has('bottles')).toBe(true);
        expect(CUSTOMER_FACING_KINDS.has('protein')).toBe(false);
        const reordered = resolveSections({ sectionsOverride: [{ key: 'bottles', kind: 'bottles', titleEn: 'B' }, { key: 'catering', kind: 'catering', titleEn: 'C' }] });
        const cf = reordered.filter(s => CUSTOMER_FACING_KINDS.has(s.kind)).map(s => s.key);
        expect(cf).toEqual(['bottles', 'catering']);
    });
});
