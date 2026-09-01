// ingredientParts.test.js — the recipe editor's amount/unit/item split
// (2026-09-01). The hard guarantee: join(split(line)) reproduces every
// REAL ingredient line in the live book (whitespace-normalized), so the
// three-box editor can never silently rewrite a recipe.
import { describe, it, expect } from 'vitest';
import { splitIngredientLine, joinIngredientParts, UNITS_EN, UNITS_ES } from './ingredientParts';
import { MASTER_RECIPES } from './masterRecipes';

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

describe('splitIngredientLine', () => {
    it('splits the basic case', () => {
        expect(splitIngredientLine('1 cup sugar', 'en')).toEqual({ qty: '1', unit: 'cup', rest: 'sugar' });
    });
    it('keeps mixed numbers and unicode fractions whole in qty', () => {
        expect(splitIngredientLine('1 1/2 cups fish sauce', 'en')).toEqual({ qty: '1 1/2', unit: 'cups', rest: 'fish sauce' });
        expect(splitIngredientLine('½ tsp salt', 'en')).toEqual({ qty: '½', unit: 'tsp', rest: 'salt' });
        expect(splitIngredientLine('1½ tbsp oil', 'en')).toEqual({ qty: '1½', unit: 'tbsp', rest: 'oil' });
    });
    it('keeps ranges whole in qty', () => {
        expect(splitIngredientLine('8–10 onions, sliced', 'en')).toEqual({ qty: '8–10', unit: '', rest: 'onions, sliced' });
    });
    it('does NOT treat food words as units (bare counts)', () => {
        expect(splitIngredientLine('3 eggs', 'en')).toEqual({ qty: '3', unit: '', rest: 'eggs' });
        expect(splitIngredientLine('2 limes', 'en')).toEqual({ qty: '2', unit: '', rest: 'limes' });
    });
    it('matches two-word units before their suffix ("fl oz" vs "oz")', () => {
        expect(splitIngredientLine('4 fl oz water', 'en')).toEqual({ qty: '4', unit: 'fl oz', rest: 'water' });
        expect(splitIngredientLine('4 oz water', 'en')).toEqual({ qty: '4', unit: 'oz', rest: 'water' });
    });
    it('handles Spanish units on the ES side', () => {
        expect(splitIngredientLine('2 tazas de azúcar', 'es')).toEqual({ qty: '2', unit: 'tazas', rest: 'de azúcar' });
        expect(splitIngredientLine('1 cdta sal', 'es')).toEqual({ qty: '1', unit: 'cdta', rest: 'sal' });
        expect(splitIngredientLine('3 cucharaditas ajo', 'es')).toEqual({ qty: '3', unit: 'cucharaditas', rest: 'ajo' });
    });
    it('no leading quantity → everything in rest', () => {
        expect(splitIngredientLine('Salt to taste', 'en')).toEqual({ qty: '', unit: '', rest: 'Salt to taste' });
        expect(splitIngredientLine('', 'en')).toEqual({ qty: '', unit: '', rest: '' });
    });
    it('shrimp grades stay intact through a round-trip', () => {
        const p = splitIngredientLine('21/25 shrimp, peeled', 'en');
        expect(joinIngredientParts(p)).toBe('21/25 shrimp, peeled');
    });
    it('preserves the line-side casing of a unit', () => {
        expect(splitIngredientLine('2 Cups flour', 'en').unit).toBe('Cups');
    });
});

describe('joinIngredientParts', () => {
    it('joins with single spaces, skipping empties', () => {
        expect(joinIngredientParts({ qty: '1', unit: 'cup', rest: 'sugar' })).toBe('1 cup sugar');
        expect(joinIngredientParts({ qty: '', unit: '', rest: 'Salt to taste' })).toBe('Salt to taste');
        expect(joinIngredientParts({ qty: '3', unit: '', rest: 'eggs' })).toBe('3 eggs');
        expect(joinIngredientParts({})).toBe('');
    });
});

describe('round-trip over the ENTIRE live book', () => {
    it('join(split(line)) reproduces every real EN + ES ingredient line', () => {
        let checked = 0;
        for (const r of MASTER_RECIPES) {
            for (const [field, lang] of [['ingredientsEn', 'en'], ['ingredientsEs', 'es']]) {
                for (const line of (r[field] || [])) {
                    const round = joinIngredientParts(splitIngredientLine(line, lang));
                    expect(round, `field=${field} line=${JSON.stringify(line)}`).toBe(norm(line));
                    checked++;
                }
            }
        }
        expect(checked).toBeGreaterThan(400); // both languages of the whole book
    });
});

describe('unit lists', () => {
    it('have no duplicates', () => {
        expect(new Set(UNITS_EN).size).toBe(UNITS_EN.length);
        expect(new Set(UNITS_ES).size).toBe(UNITS_ES.length);
    });
});

describe('unit-first entry (no amount yet)', () => {
    it('recognizes a leading unit with no qty and round-trips it', () => {
        expect(splitIngredientLine('cups chicken', 'en')).toEqual({ qty: '', unit: 'cups', rest: 'chicken' });
        expect(splitIngredientLine('Pinch of salt', 'en')).toEqual({ qty: '', unit: 'Pinch', rest: 'of salt' });
        expect(splitIngredientLine('tazas de arroz', 'es')).toEqual({ qty: '', unit: 'tazas', rest: 'de arroz' });
        const p = splitIngredientLine('cups chicken', 'en');
        expect(joinIngredientParts(p)).toBe('cups chicken');
    });
    it('repeated unit picks are idempotent (no word stacking)', () => {
        // pick unit on an empty-qty row, then pick again
        let item = joinIngredientParts({ ...splitIngredientLine('fish sauce', 'en'), unit: 'cups' });
        expect(item).toBe('cups fish sauce');
        item = joinIngredientParts({ ...splitIngredientLine(item, 'en'), unit: 'tbsp' });
        expect(item).toBe('tbsp fish sauce');
    });
});
