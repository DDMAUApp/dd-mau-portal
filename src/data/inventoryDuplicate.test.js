// Regression tests for the By-Location quick-add duplicate check
// (Andrew 2026-07-30: "under each section you can add items and that stays
// on forever").
//
// The first test is the one that matters: the original implementation
// compared Spanish names unconditionally, so `'' === ''` made every add look
// like a duplicate the moment a location held any item without a Spanish
// name — which is most of them. That would have silently bricked the whole
// feature in the stores.

import { describe, it, expect } from 'vitest';
import { isDuplicateInventoryName } from './inventory';

const cat = (items) => [{ name: 'Produce', items }];

describe('the empty-Spanish-name trap', () => {
    it('does NOT flag a new item just because neither side has a Spanish name', () => {
        const categories = cat([{ name: 'Carrots', nameEs: '', location: 'walk-in' }]);
        expect(isDuplicateInventoryName(categories, {
            location: 'walk-in', name: 'Celery', nameEs: '',
        })).toBe(false);
    });

    it('handles missing nameEs fields entirely (undefined, not empty string)', () => {
        const categories = cat([{ name: 'Carrots', location: 'walk-in' }]);
        expect(isDuplicateInventoryName(categories, {
            location: 'walk-in', name: 'Celery',
        })).toBe(false);
    });
});

describe('genuine duplicates are caught', () => {
    it('catches an exact English match in the same location', () => {
        const categories = cat([{ name: 'Carrots', location: 'walk-in' }]);
        expect(isDuplicateInventoryName(categories, {
            location: 'walk-in', name: 'Carrots',
        })).toBe(true);
    });

    it('ignores case and surrounding whitespace', () => {
        const categories = cat([{ name: 'Carrots', location: 'walk-in' }]);
        expect(isDuplicateInventoryName(categories, {
            location: 'WALK-IN', name: '  carrots  ',
        })).toBe(true);
    });

    it('catches a Spanish name colliding with a stored English one', () => {
        // Added in Spanish later; the English spelling already exists.
        const categories = cat([{ name: 'Zanahorias', location: 'walk-in' }]);
        expect(isDuplicateInventoryName(categories, {
            location: 'walk-in', name: 'Carrots', nameEs: 'Zanahorias',
        })).toBe(true);
    });

    it('catches a stored Spanish name colliding with a new English one', () => {
        const categories = cat([{ name: 'Carrots', nameEs: 'Zanahorias', location: 'walk-in' }]);
        expect(isDuplicateInventoryName(categories, {
            location: 'walk-in', name: 'Zanahorias',
        })).toBe(true);
    });
});

describe('scoping', () => {
    it('the same name in a DIFFERENT location is not a duplicate', () => {
        const categories = cat([{ name: 'Carrots', location: 'walk-in' }]);
        expect(isDuplicateInventoryName(categories, {
            location: 'dry storage', name: 'Carrots',
        })).toBe(false);
    });

    it('searches across every category, not just one', () => {
        const categories = [
            { name: 'Produce', items: [{ name: 'Lettuce', location: 'walk-in' }] },
            { name: 'Dairy', items: [{ name: 'Butter', location: 'walk-in' }] },
        ];
        expect(isDuplicateInventoryName(categories, {
            location: 'walk-in', name: 'Butter',
        })).toBe(true);
    });
});

describe('degenerate input', () => {
    it('an empty candidate name is never a duplicate', () => {
        const categories = cat([{ name: 'Carrots', location: 'walk-in' }]);
        expect(isDuplicateInventoryName(categories, { location: 'walk-in', name: '' })).toBe(false);
    });

    it('survives null/empty catalogs and malformed rows', () => {
        expect(isDuplicateInventoryName(null, { location: 'walk-in', name: 'X' })).toBe(false);
        expect(isDuplicateInventoryName([], { location: 'walk-in', name: 'X' })).toBe(false);
        expect(isDuplicateInventoryName([{ name: 'C' }], { location: 'walk-in', name: 'X' })).toBe(false);
        expect(isDuplicateInventoryName([{ items: [null] }], { location: 'walk-in', name: 'X' })).toBe(false);
    });
});
