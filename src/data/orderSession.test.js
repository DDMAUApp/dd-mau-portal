import { describe, it, expect } from 'vitest';
import {
    deriveVendorsFromInventory,
    ORDER_STATUS,
    ITEM_STATUS,
} from './orderSession';

describe('deriveVendorsFromInventory', () => {
    it('returns [] for empty / non-array input', () => {
        expect(deriveVendorsFromInventory(null)).toEqual([]);
        expect(deriveVendorsFromInventory(undefined)).toEqual([]);
        expect(deriveVendorsFromInventory('not an array')).toEqual([]);
        expect(deriveVendorsFromInventory([])).toEqual([]);
    });

    it('collects vendor names from item.vendor', () => {
        const inv = [{
            name: 'Proteins',
            items: [
                { id: '0-0', vendor: 'Sysco' },
                { id: '0-1', vendor: 'US Foods' },
            ],
        }];
        expect(deriveVendorsFromInventory(inv)).toEqual(['Sysco', 'US Foods']);
    });

    it('collects from preferredVendor too', () => {
        const inv = [{
            name: 'Proteins',
            items: [
                { id: '0-0', preferredVendor: 'Restaurant Depot' },
            ],
        }];
        expect(deriveVendorsFromInventory(inv)).toContain('Restaurant Depot');
    });

    it('walks vendorOptions[]', () => {
        const inv = [{
            name: 'Produce',
            items: [{
                id: '1-0',
                vendor: 'Sysco',
                vendorOptions: [
                    { vendor: 'Sysco', price: 1 },
                    { vendor: 'STL Wholesale', price: 2 },
                    { vendor: 'Jays', price: 3 },
                ],
            }],
        }];
        const got = deriveVendorsFromInventory(inv);
        expect(got).toContain('Sysco');
        expect(got).toContain('STL Wholesale');
        expect(got).toContain('Jays');
    });

    it('deduplicates across categories + items', () => {
        const inv = [
            { items: [{ id: '0-0', vendor: 'Sysco' }] },
            { items: [{ id: '1-0', vendor: 'Sysco' }] },
            { items: [{ id: '2-0', vendor: 'Sysco' }] },
        ];
        const got = deriveVendorsFromInventory(inv);
        expect(got.filter(v => v === 'Sysco').length).toBe(1);
    });

    it('drops placeholder "Current App" and empty strings', () => {
        const inv = [{
            items: [
                { id: '0-0', vendor: 'Current App' },
                { id: '0-1', vendor: '' },
                { id: '0-2', vendor: 'Sysco' },
                { id: '0-3', preferredVendor: 'Current App' },
            ],
        }];
        const got = deriveVendorsFromInventory(inv);
        expect(got).not.toContain('Current App');
        expect(got).not.toContain('');
        expect(got).toContain('Sysco');
    });

    it('sorts alphabetically (case-insensitive locale)', () => {
        const inv = [{
            items: [
                { id: '0-0', vendor: 'Zenith' },
                { id: '0-1', vendor: 'apple' },
                { id: '0-2', vendor: 'Banana' },
            ],
        }];
        // localeCompare default: 'apple' < 'Banana' < 'Zenith'
        const got = deriveVendorsFromInventory(inv);
        expect(got).toEqual(['apple', 'Banana', 'Zenith']);
    });
});

describe('status enums', () => {
    it('ORDER_STATUS values are stable strings', () => {
        expect(ORDER_STATUS.OPEN).toBe('open');
        expect(ORDER_STATUS.SUBMITTED).toBe('submitted');
        expect(ORDER_STATUS.CANCELLED).toBe('cancelled');
    });
    it('ITEM_STATUS values are stable strings', () => {
        expect(ITEM_STATUS.PENDING).toBe('pending');
        expect(ITEM_STATUS.ORDERED).toBe('ordered');
        expect(ITEM_STATUS.OOS).toBe('oos');
        expect(ITEM_STATUS.PARTIAL).toBe('partial');
    });
});
