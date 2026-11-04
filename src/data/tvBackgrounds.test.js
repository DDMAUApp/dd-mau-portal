import { describe, it, expect } from 'vitest';
import { TV_BACKGROUNDS, normalizeImageBackground as norm, imageBackgroundForSave as forSave, bgSupportsMotion } from './tvBackgrounds';

describe('normalizeImageBackground', () => {
    it.each([
        [undefined], [null], ['fall'], [7], [[]], [{}], [{ kind: 'plaid' }], [{ kind: 'constructor' }], [{ kind: 'black', motion: true, color: '#ffffff' }],
    ])('%j is black', (raw) => {
        expect(norm(raw)).toEqual({ kind: 'black' });
    });
    it.each([
        [undefined], ['red'], ['#fff'], ['#12345g'], ['#1234567'], [' #123456'], ['url(x)'], [123],
    ])('color kind with bad color %j falls back to black', (color) => {
        expect(norm({ kind: 'color', color })).toEqual({ kind: 'black' });
    });
    it('keeps a good color, lowercased, and drops motion from it', () => {
        expect(norm({ kind: 'color', color: '#AABBCC', motion: true })).toEqual({ kind: 'color', color: '#aabbcc' });
    });
    it('motion is off unless exactly true, and only fall and snow have it', () => {
        expect(norm({ kind: 'fall' })).toEqual({ kind: 'fall', motion: false });
        expect(norm({ kind: 'fall', motion: 'yes' })).toEqual({ kind: 'fall', motion: false });
        expect(norm({ kind: 'snow', motion: true })).toEqual({ kind: 'snow', motion: true });
        expect(norm({ kind: 'sky', motion: true })).toEqual({ kind: 'sky' });
        expect(TV_BACKGROUNDS.filter(b => bgSupportsMotion(b.id)).map(b => b.id)).toEqual(['fall', 'snow']);
    });
    it('drops a color left over on an art kind', () => {
        expect(norm({ kind: 'sky', color: '#123456' })).toEqual({ kind: 'sky' });
    });
    it('every kind has English and Spanish labels', () => {
        expect(TV_BACKGROUNDS.map(b => b.id)).toEqual(['black', 'color', 'fall', 'snow', 'sky']);
        for (const b of TV_BACKGROUNDS) { expect(b.en).toBeTruthy(); expect(b.es).toBeTruthy(); }
    });
    it('is stable when applied twice', () => {
        for (const raw of [{ kind: 'fall', motion: true }, { kind: 'color', color: '#ABCDEF' }, { kind: 'sky' }, null]) {
            expect(norm(norm(raw))).toEqual(norm(raw));
        }
    });
});

describe('imageBackgroundForSave', () => {
    it('a TV with no field and an untouched picker stays without one', () => {
        expect(forSave({ kind: 'black', color: '#14532d', motion: false }, undefined)).toBeUndefined();
        expect(forSave(null, undefined)).toBeUndefined();
    });
    it('an unchanged pick sends the raw value so the merge sees no change', () => {
        const raw = { motion: true, kind: 'fall' };
        expect(forSave({ kind: 'fall', color: '#14532d', motion: true }, raw)).toBe(raw);
        expect(forSave({ kind: 'black' }, null)).toBeNull();
    });
    it('a new pick is written clean', () => {
        expect(forSave({ kind: 'snow', color: '#14532d', motion: false }, undefined)).toEqual({ kind: 'snow', motion: false });
        expect(forSave({ kind: 'color', color: '#ABCDEF', motion: true }, undefined)).toEqual({ kind: 'color', color: '#abcdef' });
        expect(forSave({ kind: 'fall', motion: true }, { kind: 'fall', motion: false })).toEqual({ kind: 'fall', motion: true });
    });
    it('going back to black, or leaving image mode, clears with null', () => {
        expect(forSave({ kind: 'black' }, { kind: 'sky' })).toBeNull();
        expect(forSave(null, { kind: 'sky' })).toBeNull();
    });
});
