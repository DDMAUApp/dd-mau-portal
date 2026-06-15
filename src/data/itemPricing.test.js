import { describe, it, expect } from 'vitest';
import {
    parsePackToUnits,
    perUnitPrice,
    resolveTrustedPrice,
    cheapestVendor,
    lastOrdered,
    isStale,
    missingPackUnit,
    PRICE_SOURCE,
    PRICE_SOURCE_RANK,
} from './itemPricing';

describe('parsePackToUnits', () => {
    it('parses direct + multiplied weights to lb', () => {
        expect(parsePackToUnits('lb')).toEqual({ total: 1, unit: 'lb' });
        expect(parsePackToUnits('50lb')).toEqual({ total: 50, unit: 'lb' });
        expect(parsePackToUnits('4/2.5LB')).toEqual({ total: 10, unit: 'lb' });
        expect(parsePackToUnits('6/5lb')).toEqual({ total: 30, unit: 'lb' });
        expect(parsePackToUnits('5/10#UP')).toEqual({ total: 50, unit: 'lb' });
    });
    it('converts ounce packs to lb', () => {
        expect(parsePackToUnits('12/25oz').unit).toBe('lb');
        expect(parsePackToUnits('12/25oz').total).toBeCloseTo(18.75, 5);
    });
    it('parses gallons and converts quarts to gal', () => {
        expect(parsePackToUnits('9/0.5GAL')).toEqual({ total: 4.5, unit: 'gal' });
        expect(parsePackToUnits('5gal')).toEqual({ total: 5, unit: 'gal' });
        expect(parsePackToUnits('12/1 QT')).toEqual({ total: 3, unit: 'gal' });
    });
    it('parses counts', () => {
        expect(parsePackToUnits('200 EA')).toEqual({ total: 200, unit: 'ct' });
        expect(parsePackToUnits('EA')).toEqual({ total: 1, unit: 'ea' });
        expect(parsePackToUnits('1x3')).toEqual({ total: 3, unit: 'ct' });
    });
    it('returns null on empty / unparseable', () => {
        expect(parsePackToUnits('')).toBeNull();
        expect(parsePackToUnits(null)).toBeNull();
        expect(parsePackToUnits('a random thing')).toBeNull();
    });
});

describe('perUnitPrice', () => {
    it('divides price by parsed pack total', () => {
        expect(perUnitPrice(50, '4/2.5LB')).toEqual({ perUnit: 5, unit: 'lb', packTotal: 10 });
        expect(perUnitPrice(20, 'lb')).toEqual({ perUnit: 20, unit: 'lb', packTotal: 1 });
    });
    it('returns null on bad price or unparseable pack', () => {
        expect(perUnitPrice(null, '4/2.5LB')).toBeNull();
        expect(perUnitPrice(-3, 'lb')).toBeNull();
        expect(perUnitPrice(10, 'mystery')).toBeNull();
        expect(perUnitPrice('10', 'lb')).toBeNull(); // non-number guard
    });
});

describe('resolveTrustedPrice — priority order', () => {
    it('returns null when no candidates', () => {
        expect(resolveTrustedPrice(null)).toBeNull();
        expect(resolveTrustedPrice({})).toBeNull();
        expect(resolveTrustedPrice({ byVendor: {} })).toBeNull();
    });

    it('manual beats invoice beats scraped', () => {
        const doc = {
            manual: { price: 9, pack: 'lb', effectiveDate: '2026-06-01' },
            byVendor: {
                sysco: { price: 7, pack: 'lb', source: PRICE_SOURCE.LEGACY_SCRAPED },
                usfoods: { price: 8, pack: 'lb', source: PRICE_SOURCE.INVOICE, lastPurchased: '2026-06-10' },
            },
        };
        const r = resolveTrustedPrice(doc, { nowMs: Date.parse('2026-06-15') });
        expect(r.source).toBe('manual');
        expect(r.price).toBe(9);
    });

    it('falls to invoice when no manual', () => {
        const doc = {
            byVendor: {
                sysco: { price: 7, pack: 'lb', source: PRICE_SOURCE.LEGACY_SCRAPED },
                usfoods: { price: 8, pack: 'lb', source: PRICE_SOURCE.INVOICE, lastPurchased: '2026-06-10' },
            },
        };
        const r = resolveTrustedPrice(doc, { nowMs: Date.parse('2026-06-15') });
        expect(r.source).toBe('invoice');
        expect(r.vendor).toBe('usfoods');
    });

    it('uses most-recent within the same source rank', () => {
        const doc = {
            byVendor: {
                a: { price: 5, pack: 'lb', source: PRICE_SOURCE.INVOICE, lastPurchased: '2026-05-01' },
                b: { price: 6, pack: 'lb', source: PRICE_SOURCE.INVOICE, lastPurchased: '2026-06-12' },
            },
        };
        const r = resolveTrustedPrice(doc, { nowMs: Date.parse('2026-06-15') });
        expect(r.vendor).toBe('b'); // newer wins the tiebreak
    });

    it('returns scraped only as last resort, labeled', () => {
        const doc = { byVendor: { sysco: { price: 7, pack: 'lb', source: PRICE_SOURCE.LEGACY_SCRAPED } } };
        const r = resolveTrustedPrice(doc, { nowMs: Date.parse('2026-06-15') });
        expect(r.source).toBe('legacy_scraped');
        expect(r.price).toBe(7);
    });

    it('flags stale prices', () => {
        const doc = { manual: { price: 9, pack: 'lb', effectiveDate: '2026-01-01' } };
        const r = resolveTrustedPrice(doc, { nowMs: Date.parse('2026-06-15') });
        expect(r.stale).toBe(true);
    });
});

describe('cheapestVendor — per-unit apples-to-apples', () => {
    it('returns null with no priced vendors', () => {
        expect(cheapestVendor(null)).toBeNull();
        expect(cheapestVendor({ byVendor: {} })).toBeNull();
    });

    it('picks lowest per-unit, not lowest sticker price', () => {
        // Sysco sticker $50 but it's a 10lb case → $5/lb.
        // Costco sticker $30 but only 5lb → $6/lb. Sysco is actually cheaper per lb.
        const doc = {
            byVendor: {
                sysco: { price: 50, pack: '4/2.5LB', source: PRICE_SOURCE.INVOICE },   // 10lb → $5/lb
                costco: { price: 30, pack: '5lb', source: PRICE_SOURCE.CSV },           // 5lb → $6/lb
            },
        };
        const c = cheapestVendor(doc);
        expect(c.vendor).toBe('sysco');
        expect(c.perUnit).toBeCloseTo(5, 5);
        expect(c.comparable).toBe(true);
    });

    it('compares within the unit group that has the most vendors', () => {
        const doc = {
            byVendor: {
                a: { price: 10, pack: 'lb', source: PRICE_SOURCE.INVOICE },   // 10/lb
                b: { price: 8, pack: 'lb', source: PRICE_SOURCE.INVOICE },    //  8/lb  ← cheapest lb
                c: { price: 1, pack: '5gal', source: PRICE_SOURCE.INVOICE },  // 0.2/gal (different dimension)
            },
        };
        const c = cheapestVendor(doc);
        expect(c.vendor).toBe('b'); // picks within the 2-vendor 'lb' group, ignores the lone gal
    });

    it('falls back to raw price when no packs parse', () => {
        const doc = {
            byVendor: {
                a: { price: 9, pack: 'mystery', source: PRICE_SOURCE.INVOICE },
                b: { price: 4, pack: '???', source: PRICE_SOURCE.INVOICE },
            },
        };
        const c = cheapestVendor(doc);
        expect(c.vendor).toBe('b');
        expect(c.comparable).toBe(false);
    });
});

describe('lastOrdered', () => {
    it('returns most recent invoice purchase only', () => {
        const doc = {
            byVendor: {
                sysco: { price: 7, source: PRICE_SOURCE.LEGACY_SCRAPED, lastPurchased: '2026-06-14' },
                usfoods: { price: 8, source: PRICE_SOURCE.INVOICE, lastPurchased: '2026-05-01' },
                costco: { price: 6, source: PRICE_SOURCE.INVOICE, lastPurchased: '2026-06-10' },
            },
        };
        const r = lastOrdered(doc);
        expect(r.vendor).toBe('costco'); // newest INVOICE; ignores the newer scraped entry
        expect(r.price).toBe(6);
    });
    it('returns null when no invoice purchases', () => {
        expect(lastOrdered({ byVendor: { sysco: { price: 7, source: PRICE_SOURCE.LEGACY_SCRAPED } } })).toBeNull();
        expect(lastOrdered(null)).toBeNull();
    });
});

describe('isStale + missingPackUnit', () => {
    it('isStale respects the day window and unknown dates', () => {
        const now = Date.parse('2026-06-15');
        expect(isStale('2026-06-10', 45, now)).toBe(false);
        expect(isStale('2026-01-01', 45, now)).toBe(true);
        expect(isStale(null, 45, now)).toBe(false); // unknown → not stale
    });
    it('missingPackUnit flags items without a parseable pack', () => {
        expect(missingPackUnit({ pack: '4/2.5LB' })).toBe(false);
        expect(missingPackUnit({ pack: '' })).toBe(true);
        expect(missingPackUnit({})).toBe(true);
        expect(missingPackUnit({ pack: 'gibberish' })).toBe(true);
    });
});

describe('PRICE_SOURCE_RANK sanity', () => {
    it('ranks manual most-trusted and legacy_scraped least', () => {
        expect(PRICE_SOURCE_RANK.manual).toBeLessThan(PRICE_SOURCE_RANK.invoice);
        expect(PRICE_SOURCE_RANK.invoice).toBeLessThan(PRICE_SOURCE_RANK.legacy_scraped);
        expect(Math.max(...Object.values(PRICE_SOURCE_RANK))).toBe(PRICE_SOURCE_RANK.legacy_scraped);
    });
});
