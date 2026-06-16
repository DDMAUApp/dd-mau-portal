import { describe, it, expect } from 'vitest';
import { buildPricingCsv, pricingCsvFilename } from './pricingExport';

const categories = [
    { category: 'Proteins', items: [
        { id: 'a1', name: 'Jasmine Rice', nameEs: 'Arroz', pack: '50LB', vendor: 'Sysco' },
        { id: 'a2', name: 'Salt, Kosher', pack: '12/1QT', vendor: 'Costco' }, // no price + comma in name
    ] },
];
const itemPrices = {
    a1: {
        manual: { price: 9.99, pack: '50LB', vendor: 'Sysco', effectiveDate: '2026-06-10' },
        byVendor: { Sysco: { price: 9.99, pack: '50LB', source: 'invoice', lastPurchased: '2026-06-10' } },
        qtyHistory: [{ qty: 2, at: '2026-06-10T00:00:00Z' }],
    },
};

describe('buildPricingCsv', () => {
    it('emits one row per item plus a header, and counts priced items', () => {
        const { csv, itemCount, pricedCount } = buildPricingCsv({ categories, itemPrices, language: 'en' });
        expect(itemCount).toBe(2);
        expect(pricedCount).toBe(1);
        const lines = csv.replace(/^﻿/, '').split('\r\n');
        expect(lines).toHaveLength(3); // header + 2 items
        expect(lines[0]).toContain('Item');
        expect(lines[0]).toContain('Price/unit');
    });

    it('writes the trusted price, per-unit, and order qty for a priced item', () => {
        const { csv } = buildPricingCsv({ categories, itemPrices, language: 'en' });
        const row = csv.split('\r\n').find((l) => l.includes('Jasmine Rice'));
        expect(row).toContain('9.99');      // price
        expect(row).toContain('lb');        // unit from 50LB pack
        expect(row).toContain('Sysco');     // vendor
    });

    it('leaves price columns blank for an unpriced item and quotes commas', () => {
        const { csv } = buildPricingCsv({ categories, itemPrices, language: 'en' });
        const row = csv.split('\r\n').find((l) => l.includes('Salt'));
        expect(row).toContain('"Salt, Kosher"'); // RFC-4180 quoting
        expect(row).toContain('Costco');
    });

    it('starts with a UTF-8 BOM (Excel-friendly) and supports Spanish headers', () => {
        const en = buildPricingCsv({ categories, itemPrices, language: 'en' });
        const es = buildPricingCsv({ categories, itemPrices, language: 'es' });
        expect(en.csv.startsWith('﻿')).toBe(true);
        expect(es.csv).toContain('Artículo');
    });

    it('handles empty / missing input without throwing', () => {
        expect(buildPricingCsv({}).itemCount).toBe(0);
        expect(buildPricingCsv({ categories: [], itemPrices: {} }).itemCount).toBe(0);
    });
});

describe('pricingCsvFilename', () => {
    it('builds a safe filename', () => {
        expect(pricingCsvFilename('Webster', '2026-06-15')).toBe('dd-mau-pricing-webster-2026-06-15.csv');
        expect(pricingCsvFilename(null, '2026-06-15')).toBe('dd-mau-pricing-inventory-2026-06-15.csv');
    });
});
