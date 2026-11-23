import { describe, it, expect } from 'vitest';
import { encodeSampler, decodeSampler, itemsForSave } from './cateringSampler';

// Firestore rejects an array directly inside another array.
const hasNestedArray = (v) => Array.isArray(v)
    ? v.some((x) => Array.isArray(x) || hasNestedArray(x))
    : (v && typeof v === 'object' ? Object.values(v).some(hasNestedArray) : false);

describe('catering sampler picks (Yulissa 2026-11-23: "Nested arrays are not supported")', () => {
    const cart = [
        { id: 1, name: 'Sampler Platter', samplerProteins: [['Chicken', 'Pork'], ['Beef'], []], sauces: ['Peanut'] },
        { id: 2, name: 'Egg Rolls', samplerProteins: null, proteins: ['Pork'] },
    ];

    it('the order items Firestore receives contain no nested arrays and no cart ids', () => {
        expect(hasNestedArray(cart)).toBe(true);           // what used to be sent
        const items = itemsForSave(cart);
        expect(hasNestedArray(items)).toBe(false);
        expect(items[0].id).toBeUndefined();
        expect(items[0].samplerProteins).toEqual([{ picks: ['Chicken', 'Pork'] }, { picks: ['Beef'] }, { picks: [] }]);
        expect(items[1]).toEqual({ name: 'Egg Rolls', samplerProteins: null, proteins: ['Pork'] });
    });

    it('round-trips, and reads both the old and the new shape', () => {
        const groups = [['Chicken', 'Pork'], ['Beef'], []];
        expect(decodeSampler(encodeSampler(groups))).toEqual(groups);
        expect(decodeSampler(groups)).toEqual(groups);       // cart / draft shape
        expect(decodeSampler(null)).toBeNull();
        expect(decodeSampler([{ picks: ['Tofu'] }, {}])).toEqual([['Tofu'], []]);
    });
});
