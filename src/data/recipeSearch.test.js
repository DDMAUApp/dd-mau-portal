import { describe, it, expect } from 'vitest';
import { matchesRecipeQuery, buildRecipeHaystack } from './recipeSearch';

const PHO = {
    id: 1, emoji: '🍜', category: 'Soups',
    titleEn: 'Beef Pho',     titleEs: 'Pho de Res',
    ingredientsEn: ['Beef bones', 'Star anise', 'Onion'],
    ingredientsEs: ['Huesos de res', 'Anís estrella', 'Cebolla'],
    allergens: [],
};

const PEANUT_NOODLES = {
    id: 2, emoji: '🥜', category: 'Noodles',
    titleEn: 'Cold Peanut Noodles', titleEs: 'Fideos Fríos de Cacahuate',
    ingredientsEn: ['Skippy creamy', 'Soy sauce', 'Lime juice'],
    ingredientsEs: ['Skippy cremoso', 'Salsa de soya', 'Jugo de limón'],
    allergens: ['peanut', 'soy'],
};

const TOFU_BOWL = {
    id: 3, emoji: '🥗', category: 'Bowls',
    titleEn: 'Lemongrass Tofu Bowl', titleEs: 'Tazón de Tofú con Limoncillo',
    ingredientsEn: ['Firm tofu', 'Lemongrass', 'Mint leaves'],
    ingredientsEs: ['Tofu firme', 'Limoncillo', 'Hojas de menta'],
    allergens: ['soy'],
};

describe('matchesRecipeQuery', () => {
    it('empty query matches everything (no filter)', () => {
        expect(matchesRecipeQuery(PHO, '')).toBe(true);
        expect(matchesRecipeQuery(PHO, '   ')).toBe(true);
        expect(matchesRecipeQuery(PHO, null)).toBe(true);
    });

    it('matches by English title', () => {
        expect(matchesRecipeQuery(PHO, 'pho')).toBe(true);
        expect(matchesRecipeQuery(PHO, 'beef')).toBe(true);
    });

    it('matches by Spanish title', () => {
        expect(matchesRecipeQuery(PHO, 'res')).toBe(true);
    });

    it('matches by category', () => {
        expect(matchesRecipeQuery(PHO, 'soups')).toBe(true);
        expect(matchesRecipeQuery(TOFU_BOWL, 'bowls')).toBe(true);
    });

    it('matches by ingredient — EN and ES', () => {
        expect(matchesRecipeQuery(PHO, 'star anise')).toBe(true);
        expect(matchesRecipeQuery(PHO, 'cebolla')).toBe(true);
        expect(matchesRecipeQuery(TOFU_BOWL, 'mint')).toBe(true);
    });

    it('is accent-insensitive', () => {
        // "tofú" stripped → "tofu" — matches the EN ingredient
        expect(matchesRecipeQuery(TOFU_BOWL, 'tofú')).toBe(true);
        // Reverse: query without accent finds the accented Spanish title
        expect(matchesRecipeQuery(TOFU_BOWL, 'tazon')).toBe(true);
        expect(matchesRecipeQuery(PEANUT_NOODLES, 'frios')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(matchesRecipeQuery(PHO, 'BEEF')).toBe(true);
        expect(matchesRecipeQuery(PHO, 'BeEf')).toBe(true);
    });

    it('multi-word query is AND-semantic', () => {
        // Both words present anywhere in the haystack
        expect(matchesRecipeQuery(PHO, 'beef anise')).toBe(true);
        // Second word absent → no match
        expect(matchesRecipeQuery(PHO, 'beef chocolate')).toBe(false);
    });

    it('synonym expansion: EN query finds ES content via chatSearch synonyms', () => {
        // "chicken" → expands to include "pollo"
        const chicken = {
            id: 9, titleEn: 'Pollo Asado', titleEs: 'Pollo Asado',
            ingredientsEn: ['pollo'], ingredientsEs: ['pollo'],
        };
        expect(matchesRecipeQuery(chicken, 'chicken')).toBe(true);
        // "lime" ↔ "limón"
        expect(matchesRecipeQuery(PEANUT_NOODLES, 'lime')).toBe(true);
        // "mint" ↔ "menta" / "hierbabuena"
        expect(matchesRecipeQuery(TOFU_BOWL, 'menta')).toBe(true);
    });

    it('matches by allergen label even when the word is hidden behind a brand name', () => {
        // Ingredients say "Skippy creamy" — no literal "peanut" — but the
        // allergen tag is indexed, so a peanut-allergy guest scan still hits.
        expect(matchesRecipeQuery(PEANUT_NOODLES, 'peanut')).toBe(true);
        // And the Spanish form
        expect(matchesRecipeQuery(PEANUT_NOODLES, 'cacahuate')).toBe(true);
    });

    it('returns false when nothing matches', () => {
        expect(matchesRecipeQuery(PHO, 'chocolate cake')).toBe(false);
        expect(matchesRecipeQuery(TOFU_BOWL, 'shrimp scampi')).toBe(false);
    });

    it('handles null/undefined recipe safely', () => {
        expect(buildRecipeHaystack(null)).toBe('');
        expect(buildRecipeHaystack(undefined)).toBe('');
    });

    it('does not index instructions (intentional)', () => {
        const r = {
            id: 99, titleEn: 'Plain Rice',
            ingredientsEn: ['rice', 'water'],
            instructionsEn: ['Add saffron, simmer 20 minutes.'],
        };
        // "saffron" lives only in instructions — should NOT match
        expect(matchesRecipeQuery(r, 'saffron')).toBe(false);
    });
});
