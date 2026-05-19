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

    // Regression — Andrew 2026-05-18: "searched wings, didn't isolate
    // wings". Cuts/species/category expansions are off for recipe
    // search but bilingual base terms still work.
    it('does NOT broaden cuts — "wings" only matches recipes literally about wings', () => {
        const wholeChicken = {
            id: 11, titleEn: 'Roast Chicken', titleEs: 'Pollo Rostizado',
            ingredientsEn: ['whole chicken', 'rosemary', 'salt'],
            ingredientsEs: ['pollo entero', 'romero', 'sal'],
        };
        const wings = {
            id: 12, titleEn: 'Buffalo Wings', titleEs: 'Alitas Búfalo',
            ingredientsEn: ['chicken wings', 'hot sauce', 'butter'],
            ingredientsEs: ['alitas de pollo', 'salsa picante', 'mantequilla'],
        };
        // The bug: "wings" used to pull wholeChicken too via the
        // chicken/wings/thigh/breast group.
        expect(matchesRecipeQuery(wholeChicken, 'wings')).toBe(false);
        expect(matchesRecipeQuery(wings, 'wings')).toBe(true);
        // Sanity: chicken↔pollo translation still works (TIGHT keeps it)
        expect(matchesRecipeQuery(wholeChicken, 'pollo')).toBe(true);
        expect(matchesRecipeQuery(wholeChicken, 'chicken')).toBe(true);
    });

    it('does NOT broaden species — "salmon" only matches recipes with salmon', () => {
        const tilapia = {
            id: 13, titleEn: 'Tilapia Tacos', category: 'Fish',
            ingredientsEn: ['tilapia fillet', 'corn tortilla'],
        };
        const salmon = {
            id: 14, titleEn: 'Grilled Salmon', category: 'Fish',
            ingredientsEn: ['salmon fillet', 'lemon'],
        };
        // The bug: "salmon" used to surface tilapia via fish↔salmon↔tuna
        expect(matchesRecipeQuery(tilapia, 'salmon')).toBe(false);
        expect(matchesRecipeQuery(salmon, 'salmon')).toBe(true);
        // Sanity: fish↔pescado translation still hits both Fish-category recipes
        expect(matchesRecipeQuery(tilapia, 'pescado')).toBe(true);
        expect(matchesRecipeQuery(salmon, 'pescado')).toBe(true);
    });

    it('does NOT bridge pho↔soup↔broth — they are separate concepts in a recipe book', () => {
        const pho = {
            id: 15, titleEn: 'Beef Pho', ingredientsEn: ['rice noodles', 'star anise'],
        };
        const minestrone = {
            id: 16, titleEn: 'Minestrone Soup', ingredientsEn: ['white beans', 'celery'],
        };
        // Searching "soup" should NOT surface pho (it's broth-based but
        // not labeled soup); searching "pho" should NOT surface minestrone.
        expect(matchesRecipeQuery(pho, 'soup')).toBe(false);
        expect(matchesRecipeQuery(minestrone, 'pho')).toBe(false);
        // But the literal terms still match their own recipes.
        expect(matchesRecipeQuery(pho, 'pho')).toBe(true);
        expect(matchesRecipeQuery(minestrone, 'soup')).toBe(true);
    });

    it('does NOT bridge tofu ↔ soy sauce — they are different ingredients', () => {
        const pad = {
            id: 17, titleEn: 'Pad See Ew',
            ingredientsEn: ['rice noodles', 'soy sauce', 'chinese broccoli'],
        };
        const tofuDish = {
            id: 18, titleEn: 'Mapo Tofu', ingredientsEn: ['silken tofu', 'doubanjiang'],
        };
        // Pad See Ew contains soy sauce but is not a tofu dish.
        expect(matchesRecipeQuery(pad, 'tofu')).toBe(false);
        expect(matchesRecipeQuery(tofuDish, 'tofu')).toBe(true);
    });
});

// ── chatSearch parity assertions ────────────────────────────────────
// Chat search must keep its BROAD behavior — typing "wings" in the
// chat panel still surfaces every message about chicken thighs/breast,
// which is what makes chat search useful for "anything related to X"
// lookups. These tests guard the split: if someone re-points chat
// search at the tight index, this catches it.
import { expandQueryTerms } from './chatSearch';

describe('chatSearch (broad) still broadens for chat use', () => {
    const hasExpansion = (query, term) => {
        const toks = expandQueryTerms(query);
        return toks.some(t => t.expansions.has(term));
    };
    it('chat: wings → expands to chicken', () => {
        expect(hasExpansion('wings', 'chicken')).toBe(true);
    });
    it('chat: salmon → expands to fish', () => {
        expect(hasExpansion('salmon', 'fish')).toBe(true);
    });
    it('chat: pho → expands to soup/broth/sopa/caldo', () => {
        expect(hasExpansion('pho', 'soup')).toBe(true);
        expect(hasExpansion('pho', 'caldo')).toBe(true);
    });
    it('chat: manager → expands to boss/jefe', () => {
        expect(hasExpansion('manager', 'boss')).toBe(true);
        expect(hasExpansion('manager', 'jefe')).toBe(true);
    });
});
