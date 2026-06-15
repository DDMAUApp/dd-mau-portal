import { describe, it, expect } from 'vitest';
import { buildMasterIndex, matchItemByName } from './itemMatch';

const CATS = [
    { items: [
        { id: '0-0', name: '21/25 Shrimp Tail Off' },
        { id: '0-1', name: 'Jasmine Rice' },
        { id: '0-2', name: 'Soy Sauce' },
        { id: '0-3', name: 'Beef Brisket' },
    ] },
    { items: [
        { id: '1-0', name: 'Green Onion' },
        { id: '1-1', name: '' },          // blank name skipped
        { id: '1-2', name: 'Cilantro' },
    ] },
];

describe('buildMasterIndex', () => {
    const idx = buildMasterIndex(CATS);
    it('flattens items and skips blanks', () => {
        expect(idx.length).toBe(6); // 7 items minus the 1 blank
        expect(idx.find((x) => x.id === '1-1')).toBeUndefined();
    });
    it('lowercases + extracts keywords', () => {
        const shrimp = idx.find((x) => x.id === '0-0');
        expect(shrimp.nameLower).toBe('21/25 shrimp tail off');
        expect(shrimp.keywords).toContain('shrimp');
        expect(shrimp.keywords).toContain('tail');
    });
    it('handles empty / missing input', () => {
        expect(buildMasterIndex(null)).toEqual([]);
        expect(buildMasterIndex([])).toEqual([]);
        expect(buildMasterIndex([{}])).toEqual([]);
    });
});

describe('matchItemByName', () => {
    const idx = buildMasterIndex(CATS);

    it('matches a receipt line to the right master item (substring → high)', () => {
        const m = matchItemByName('SHRIMP 21/25 TAIL OFF 4/2.5LB', idx);
        expect(m).not.toBeNull();
        expect(m.id).toBe('0-0');
        expect(m.confidence).toBe('high');
    });

    it('matches on keyword overlap', () => {
        const m = matchItemByName('Rice Jasmine Premium', idx);
        expect(m?.id).toBe('0-1');
    });

    it('matches a single distinctive keyword', () => {
        expect(matchItemByName('Fresh Cilantro Bunch', idx)?.id).toBe('1-2');
        expect(matchItemByName('BRISKET beef choice', idx)?.id).toBe('0-3');
    });

    it('returns null when nothing reasonably matches', () => {
        expect(matchItemByName('Aluminum Foil Roll', idx)).toBeNull();
        expect(matchItemByName('xyzzy', idx)).toBeNull();
    });

    it('guards empty / bad input', () => {
        expect(matchItemByName('', idx)).toBeNull();
        expect(matchItemByName('shrimp', null)).toBeNull();
        expect(matchItemByName('shrimp', [])).toBeNull();
        expect(matchItemByName('ab', idx)).toBeNull(); // all tokens <=2 chars
    });
});
