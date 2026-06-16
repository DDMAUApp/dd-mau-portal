import { describe, it, expect } from 'vitest';
import { buildUnmatchedQueue } from './receiptScans';

const scans = [
    {
        id: 's1', vendor: 'Sysco', date: '2026-06-10', createdAt: 1000,
        lines: [
            { name: 'CHI MEI GWA BUN', masterId: null, price: 12.5, pack: '30CT' }, // unmatched
            { name: 'Jasmine Rice', masterId: 'rice-1', price: 38.5 },              // matched → skip
        ],
    },
    {
        id: 's2', vendor: 'Restaurant Depot', date: '2026-06-14', createdAt: 2000,
        lines: [
            { name: 'chi mei  gwa-bun', masterId: null, price: 11.0, pack: '30CT' }, // same key, newer
            { name: 'Mystery Sauce', masterId: null, price: null },                  // unmatched, no price
        ],
    },
];

describe('buildUnmatchedQueue', () => {
    it('dedupes by normalized name and keeps the most recent occurrence', () => {
        const q = buildUnmatchedQueue(scans, {});
        const gwa = q.find((e) => e.key === 'chi_mei_gwa_bun');
        expect(gwa).toBeTruthy();
        expect(gwa.count).toBe(2);          // seen in both scans
        expect(gwa.price).toBe(11.0);       // newest occurrence's price
        expect(gwa.vendor).toBe('Restaurant Depot');
        expect(gwa.date).toBe('2026-06-14');
    });

    it('excludes already-matched lines and respects learned aliases', () => {
        const all = buildUnmatchedQueue(scans, {});
        expect(all.some((e) => e.name === 'Jasmine Rice')).toBe(false); // matched
        // once an alias exists for gwa bun, it drops from the queue
        const withAlias = buildUnmatchedQueue(scans, { chi_mei_gwa_bun: { masterId: 'bao-1' } });
        expect(withAlias.some((e) => e.key === 'chi_mei_gwa_bun')).toBe(false);
    });

    it('keeps unpriced unmatched lines (price null) and sorts newest-first', () => {
        const q = buildUnmatchedQueue(scans, {});
        const mystery = q.find((e) => e.name === 'Mystery Sauce');
        expect(mystery).toBeTruthy();
        expect(mystery.price).toBeNull();
        expect(q[0].createdAt).toBeGreaterThanOrEqual(q[q.length - 1].createdAt);
    });

    it('handles empty / missing input', () => {
        expect(buildUnmatchedQueue([], {})).toEqual([]);
        expect(buildUnmatchedQueue(undefined, undefined)).toEqual([]);
    });
});
