import { describe, it, expect } from 'vitest';
import {
    centralToday, centralTomorrow, shouldAutoEmpty, deliveredDocId, buildHistoryDoc,
} from '../inventoryDelivery';

describe('centralToday / centralTomorrow', () => {
    it('formats YYYY-MM-DD in Central time', () => {
        // 2026-06-27 15:00 UTC = 10:00am CDT → still the 27th in Central.
        const d = new Date('2026-06-27T15:00:00Z');
        expect(centralToday(d)).toBe('2026-06-27');
        expect(centralTomorrow(d)).toBe('2026-06-28');
    });
    it('rolls the day using Central midnight, not UTC', () => {
        // 2026-06-28 03:00 UTC = 10:00pm CDT on the 27th → Central day is the 27th.
        const lateNight = new Date('2026-06-28T03:00:00Z');
        expect(centralToday(lateNight)).toBe('2026-06-27');
        expect(centralTomorrow(lateNight)).toBe('2026-06-28');
    });
    it('crosses month + handles the +1 day correctly', () => {
        const d = new Date('2026-06-30T15:00:00Z');
        expect(centralToday(d)).toBe('2026-06-30');
        expect(centralTomorrow(d)).toBe('2026-07-01');
    });
});

describe('shouldAutoEmpty', () => {
    it('empties when the delivery date is today or past', () => {
        expect(shouldAutoEmpty('2026-06-27', '2026-06-27')).toBe(true);  // the day
        expect(shouldAutoEmpty('2026-06-26', '2026-06-27')).toBe(true);  // past (missed)
    });
    it('does NOT empty before the delivery date', () => {
        expect(shouldAutoEmpty('2026-06-28', '2026-06-27')).toBe(false);
    });
    it('is false for blank / malformed / non-string dates', () => {
        expect(shouldAutoEmpty('', '2026-06-27')).toBe(false);
        expect(shouldAutoEmpty(null, '2026-06-27')).toBe(false);
        expect(shouldAutoEmpty(undefined, '2026-06-27')).toBe(false);
        expect(shouldAutoEmpty('6/27/2026', '2026-06-27')).toBe(false);
        expect(shouldAutoEmpty(20260627, '2026-06-27')).toBe(false);
    });
});

describe('deliveredDocId', () => {
    it('is deterministic per delivery date', () => {
        expect(deliveredDocId('2026-06-27')).toBe('2026-06-27_delivered');
    });
});

describe('buildHistoryDoc', () => {
    const customInventory = [
        { name: 'Proteins', items: [
            { id: '0-0', name: 'Shrimp', nameEs: 'Camarón', vendor: 'Sysco', pack: '5lb', orderDay: 'Mon' },
            { id: '0-1', name: 'Beef', vendor: '', supplier: 'Costco' },
        ] },
        { name: 'Veggies', items: [
            { id: '1-0', name: 'Tofu' },
        ] },
    ];

    it('keeps only counted items, grouped by category, with the delivery listName', () => {
        const doc = buildHistoryDoc({
            counts: { '0-0': 3, '0-1': 0, '1-0': 2 },   // 0-1 has 0 → dropped
            customInventory,
            countMeta: { '0-0': { by: 'Andrew', at: '9:00 AM' }, '0-1': { by: 'x' } },
            deliveryDate: '2026-06-27',
            nowIso: '2026-06-25T12:00:00.000Z',
        });
        expect(doc.counts).toEqual({ '0-0': 3, '1-0': 2 });
        expect(doc.listName).toBe('Delivery 2026-06-27');
        expect(doc.deliveryDate).toBe('2026-06-27');
        expect(doc.date).toBe('2026-06-25T12:00:00.000Z');
        expect(doc.ordered).toEqual({});
        // countMeta filtered to counted ids only
        expect(doc.countMeta).toEqual({ '0-0': { by: 'Andrew', at: '9:00 AM' } });
        // Proteins keeps only Shrimp; Beef (0) dropped; Veggies keeps Tofu
        expect(doc.items).toEqual([
            { category: 'Proteins', items: [
                { id: '0-0', name: 'Shrimp', nameEs: 'Camarón', vendor: 'Sysco', supplier: 'Sysco', orderDay: 'Mon', pack: '5lb', price: null },
            ] },
            { category: 'Veggies', items: [
                { id: '1-0', name: 'Tofu', nameEs: '', vendor: '', supplier: '', orderDay: '', pack: '', price: null },
            ] },
        ]);
    });

    it('drops empty categories and tolerates missing fields', () => {
        const doc = buildHistoryDoc({ counts: {}, customInventory, deliveryDate: '2026-06-27' });
        expect(doc.items).toEqual([]);
        expect(doc.counts).toEqual({});
    });
});
