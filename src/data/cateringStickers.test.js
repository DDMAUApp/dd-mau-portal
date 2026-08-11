// Catering sticker section + customer-facing label format (2026-08-11).
import { describe, it, expect } from 'vitest';
import { DEFAULT_LABEL_FORMAT, mergeWithDefaults, cleanKindFormats } from './labelFormat';
import { STICKER_SECTIONS, getStampedDefaults, resolveSections } from './stickerListsOverride';
import { COMPONENT_KIND_TONE } from './itemBuild';

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
