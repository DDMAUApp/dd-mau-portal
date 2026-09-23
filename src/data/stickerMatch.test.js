import { describe, it, expect } from 'vitest';
import { buildStickerMatchIndex, findStickerMatches, stickerNameQuery, hasExactStickerMatch } from './stickerMatch';

const rows = [
    { id: 'a', nameEn: 'Pho Plates', nameEs: 'Platos de Pho', category: 'Catering' },
    { id: 'b', nameEn: 'Pho Broth', nameEs: 'Caldo de Pho', category: 'Pho' },
    { id: 'c', nameEn: 'Jalapeño', nameEs: 'Jalapeño', category: 'Toppings' },
    { id: 'd', nameEn: 'Tomatoes', category: 'Veg' },
    { id: 'e', nameEn: 'Sweet Chili Sauce', category: 'Sauces' },
    { id: 'f', nameEn: 'Egg Rolls', category: 'Snacks' },
];
const index = buildStickerMatchIndex(rows);
const ids = (q) => findStickerMatches(q, index).map(m => m.row.id);

describe('findStickerMatches', () => {
    it('exact name, any case/plural/order', () => {
        for (const q of ['pho plates', 'PHO PLATES', 'pho plate', 'plates pho', '  Pho   Plates ']) {
            const m = findStickerMatches(q, index);
            expect(m[0].row.id).toBe('a');
            expect(m[0].exact).toBe(true);
        }
    });
    it('half-typed last word still finds it (search-bar behavior)', () => {
        expect(ids('pho pla')).toEqual(['a']);
        expect(findStickerMatches('pho pla', index)[0].exact).toBe(false);
    });
    it('one word lists every sticker with that word, closest first', () => {
        expect(ids('pho')).toEqual(['b', 'a']);
    });
    it('accents and Spanish names match', () => {
        expect(ids('jalapeno')).toEqual(['c']);
        expect(findStickerMatches('caldo de pho', index)[0]).toMatchObject({ exact: true, row: { id: 'b' } });
    });
    it('-oes plurals', () => {
        expect(findStickerMatches('tomato', index)[0]).toMatchObject({ exact: true, row: { id: 'd' } });
    });
    it('names only — no category or unrelated-word hits', () => {
        expect(ids('catering')).toEqual([]);
        expect(ids('pho soup')).toEqual([]);
    });
    it('needs 3+ letters before suggesting', () => {
        expect(ids('ph')).toEqual([]);
        expect(ids('')).toEqual([]);
    });
    it('word must not be reused for two query words', () => {
        expect(ids('egg egg')).toEqual([]);
    });
    it('hasExactStickerMatch', () => {
        expect(hasExactStickerMatch('Sweet chili sauces', index)).toBe(true);
        expect(hasExactStickerMatch('sweet chili', index)).toBe(false);
    });
});

describe('stickerNameQuery', () => {
    it('first non-empty line, trimmed', () => {
        expect(stickerNameQuery('\n  PHO PLATES \nfor party')).toBe('PHO PLATES');
        expect(stickerNameQuery('')).toBe('');
    });
});
