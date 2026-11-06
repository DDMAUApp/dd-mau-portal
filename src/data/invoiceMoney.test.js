import { describe, it, expect } from 'vitest';
import { itemMoney, tipOf, breakdownRows } from './invoiceMoney';
import { compareOrder } from './cateringMatch';

describe('item prices', () => {
    it("uses Toast's unit price when it has one", () => {
        expect(itemMoney({ qty: 2, price: 180, unitPrice: 90 })).toEqual({ qty: 2, unit: 90, line: 180 });
    });
    it('works the unit out from the line for older invoices', () => {
        expect(itemMoney({ qty: 3, price: 100 })).toEqual({ qty: 3, unit: 33.33, line: 100 });
    });
    it('no price, no numbers', () => { expect(itemMoney({ qty: 1 })).toEqual({ qty: 1, unit: null, line: null }); });
});

describe('tips', () => {
    it('payment tips plus gratuity service charges', () => {
        expect(tipOf({ breakdown: { tip: 20, serviceCharges: [{ name: 'Gratuity', amount: 10, gratuity: true }, { name: 'Delivery', amount: 15 }] } })).toBe(30);
    });
    it('older invoices have none', () => { expect(tipOf({})).toBe(0); });
    it('a tip is left out when comparing with the catering order', () => {
        const order = { total: 200, customer: { date: '2026-11-09', time: '11:30 AM', orderType: 'pickup' }, items: [] };
        const inv = { total: 225, promisedDate: '2026-11-09T17:30:00Z', items: [], isDelivery: false, breakdown: { tip: 25 } };
        expect(compareOrder(order, inv)).toEqual([]);
        const off = compareOrder({ ...order, total: 150 }, inv);
        expect(off[0].en).toBe('Total: app $150.00, Toast $200.00 (not counting a $25.00 tip)');
    });
});

describe('breakdown', () => {
    it('receipt order, only what Toast sent', () => {
        const rows = breakdownRows({ total: 230.5, breakdown: { subtotal: 190, discounts: 5, tax: 19.5, tip: 21, serviceCharges: [{ name: 'Delivery', amount: 15 }] } });
        expect(rows.map(r => [r.en, r.amount])).toEqual([
            ['Subtotal', 190], ['Discounts', -5], ['Delivery', 15], ['Tax', 19.5], ['Tip', 21], ['Total', 230.5],
        ]);
    });
    it('older invoices show no breakdown', () => { expect(breakdownRows({ total: 100 })).toEqual([]); });
});
