import { describe, it, expect } from 'vitest';
import { parseAllergenText, unrecognizedAllergenWords } from './allergenParse';
import { ALLERGEN_CODES } from './allergens';

describe('parseAllergenText', () => {
    it('emits only canonical codes', () => {
        const all = parseAllergenText('milk egg fish shrimp soy wheat peanut cashew sesame msg');
        for (const c of all) expect(ALLERGEN_CODES).toContain(c);
        expect(all.sort()).toEqual([...ALLERGEN_CODES].sort());
    });
    it('menu-style strings', () => {
        expect(parseAllergenText('Soy, Fish (vinaigrette). Optional peanut.')).toEqual(['fish', 'soy', 'peanut']);
    });
    it('whole words: shellfish is not fish, eggplant is not egg, peanut is not a tree nut', () => {
        expect(parseAllergenText('shellfish')).toEqual(['shell']);
        expect(parseAllergenText('eggplant')).toEqual([]);
        expect(parseAllergenText('peanut sauce')).toEqual(['peanut']);
    });
    it('synonyms staff actually type', () => {
        expect(parseAllergenText('Cashews')).toEqual(['treenut']);
        expect(parseAllergenText('butter, cheese')).toEqual(['milk']);
        expect(parseAllergenText('rice noodles, rice flour')).toEqual([]);   // gluten-free, not wheat
        expect(parseAllergenText('lobster')).toEqual(['shell']);
        expect(parseAllergenText('eggs')).toEqual(['eggs']);
        expect(parseAllergenText('coconut milk')).toEqual(['milk', 'treenut']);   // errs toward listing
    });
    it('legacy code lists normalize', () => {
        expect(parseAllergenText(['egg', 'shellfish', 'soy'])).toEqual(['eggs', 'shell', 'soy']);
    });
    it('garbage-safe', () => {
        expect(parseAllergenText('')).toEqual([]);
        expect(parseAllergenText(null)).toEqual([]);
    });
    it('reports words it could not map', () => {
        expect(unrecognizedAllergenWords('peanut, lupin, and mustard')).toEqual(['lupin', 'mustard']);
    });
});
