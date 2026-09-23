import { describe, it, expect } from 'vitest';
import { keepLocationFolds, LOC_FOLD_PREFIX } from '../components/InventoryLayoutParts';

describe('keepLocationFolds — clearing the search keeps folded locations', () => {
    it('drops other views\' collapsed keys but keeps loc:: folds', () => {
        const prev = { 'cat-3': true, v_Sysco: true, [`${LOC_FOLD_PREFIX}Pantry`]: true, 'loc::Expo': false };
        expect(keepLocationFolds(prev)).toEqual({ 'loc::Pantry': true, 'loc::Expo': false });
    });
    it('returns the same object when there is nothing to drop (no re-render)', () => {
        const onlyLoc = { 'loc::Pantry': true };
        expect(keepLocationFolds(onlyLoc)).toBe(onlyLoc);
        const empty = {};
        expect(keepLocationFolds(empty)).toBe(empty);
    });
});
