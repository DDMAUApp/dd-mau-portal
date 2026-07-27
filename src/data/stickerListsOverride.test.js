// Tests for the pure parts of stickerListsOverride — the name-dedupe key
// and section resolution rules that the 2026-07-26 audit fixes lean on.
import { describe, it, expect } from 'vitest';
import { stickerNameKey, resolveSections, STICKER_SECTIONS } from './stickerListsOverride';

describe('stickerNameKey', () => {
    it('is case- and whitespace-insensitive', () => {
        expect(stickerNameKey('  Fish  Sauce ')).toBe(stickerNameKey('fish sauce'));
    });
    it('is accent-insensitive (Jalapeño == Jalapeno)', () => {
        expect(stickerNameKey('Jalapeño')).toBe(stickerNameKey('Jalapeno'));
        expect(stickerNameKey('Salsa Picánte')).toBe(stickerNameKey('salsa picante'));
    });
    it('handles empty/nullish', () => {
        expect(stickerNameKey('')).toBe('');
        expect(stickerNameKey(null)).toBe('');
        expect(stickerNameKey(undefined)).toBe('');
    });
});

describe('resolveSections', () => {
    it('returns built-ins when no override', () => {
        expect(resolveSections({})).toBe(STICKER_SECTIONS);
        expect(resolveSections(null)).toBe(STICKER_SECTIONS);
    });
    it('re-appends dropped built-ins so Proteins can never disappear', () => {
        const out = resolveSections({ sectionsOverride: [{ key: 'c_special', kind: 'other', titleEn: 'Specials', titleEs: 'Especiales' }] });
        expect(out.some(s => s.key === 'proteins')).toBe(true);
        expect(out.some(s => s.key === 'c_special')).toBe(true);
    });
    it('drops malformed keys and duplicates', () => {
        const out = resolveSections({ sectionsOverride: [
            { key: '9bad', kind: 'other', titleEn: 'x' },
            { key: 'c_ok', kind: 'other', titleEn: 'ok' },
            { key: 'c_ok', kind: 'other', titleEn: 'dupe' },
        ] });
        expect(out.filter(s => s.key === 'c_ok')).toHaveLength(1);
        expect(out.some(s => s.key === '9bad')).toBe(false);
    });
    it('falls back to key when a custom title is blank', () => {
        const out = resolveSections({ sectionsOverride: [{ key: 'c_x', kind: 'other', titleEn: '', titleEs: '' }] });
        const cx = out.find(s => s.key === 'c_x');
        expect(cx.titleEn).toBe('c_x');
    });
});
