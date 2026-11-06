import { describe, it, expect } from 'vitest';
import { matchOrders, compareOrder, invoiceLocal, linkChoices } from './cateringMatch';

// 11:30 AM Central on Nov 9, 2026 = 17:30Z.
const inv = (over = {}) => ({
    invoiceGuid: 'g1', invoiceNumber: '000300', promisedDate: '2026-11-09T17:30:00Z', customerName: 'Ana Ruiz', companyName: '',
    phone: '(314) 555-0101', email: 'ana@x.com', total: 200, isDelivery: false, location: 'webster',
    items: [{ name: 'Spring Rolls', qty: 2, price: 90 }, { name: 'DELIVERY FEE', qty: 1, price: 15 }, { name: 'Plates and Utensils', qty: 1, price: 5 }],
    ...over,
});
const order = (over = {}) => ({
    id: 'o1', total: 200,
    customer: { name: 'Ana Ruiz', phone: '314-555-0101', email: 'ANA@x.com', date: '2026-11-09', time: '11:30 AM', orderType: 'pickup', pickupLocation: 'webster' },
    items: [{ nameEn: 'Spring Rolls', qty: 2 }],
    ...over,
});

describe('Toast time', () => {
    it('reads the promised time in Central time', () => { expect(invoiceLocal(inv())).toEqual({ date: '2026-11-09', minutes: 690 }); });
});

describe('matching', () => {
    it('same day and same customer match, with nothing to report', () => {
        const r = matchOrders([order()], [inv()]).get('o1');
        expect(r.invoice.invoiceGuid).toBe('g1');
        expect(r.diffs).toEqual([]);
    });
    it('a different day never matches', () => {
        expect(matchOrders([order()], [inv({ promisedDate: '2026-11-10T17:30:00Z' })]).get('o1').invoice).toBe(null);
    });
    it('a different customer on the same day never matches', () => {
        expect(matchOrders([order()], [inv({ customerName: 'Bo Chen', phone: '', email: '' })]).get('o1').invoice).toBe(null);
    });
    it('one invoice goes to only one order, the closer one', () => {
        const a = order({ id: 'a', customer: { ...order().customer, time: '5:00 PM' } });
        const b = order({ id: 'b' });
        const m = matchOrders([a, b], [inv()]);
        expect(m.get('b').invoice?.invoiceGuid).toBe('g1');
        expect(m.get('a').invoice).toBe(null);
    });
    it('an unlinked invoice is not matched again', () => {
        expect(matchOrders([order({ toastUnlinked: ['g1'] })], [inv()]).get('o1').invoice).toBe(null);
    });
    it('a hand link wins, even across days', () => {
        const r = matchOrders([order({ toastLink: { invoiceGuid: 'g2' } })], [inv(), inv({ invoiceGuid: 'g2', promisedDate: '2026-11-12T17:30:00Z' })]).get('o1');
        expect(r.invoice.invoiceGuid).toBe('g2');
        expect(r.manual).toBe(true);
        expect(r.diffs.map(d => d.kind)).toEqual(['date']);
    });
});

describe('differences', () => {
    it('total, items, time, pickup or delivery, and store', () => {
        const d = compareOrder(order({ total: 180, items: [{ qty: 3 }] }), inv({ promisedDate: '2026-11-09T18:30:00Z', isDelivery: true, location: 'maryland' }));
        expect(d.map(x => x.kind)).toEqual(['total', 'items', 'time', 'type', 'store']);
        expect(d[0].en).toBe('Total: app $180.00, Toast $200.00');
    });
    it('fees and utensils on the Toast side are not counted as food', () => {
        expect(compareOrder(order(), inv()).find(x => x.kind === 'items')).toBeUndefined();
    });
    it('up to a dollar off is not a difference, more is', () => {
        expect(compareOrder(order({ total: 200.3 }), inv())).toEqual([]);
        expect(compareOrder(order({ total: 199.01 }), inv())).toEqual([]);
        expect(compareOrder(order({ total: 201 }), inv())).toEqual([]);
        expect(compareOrder(order({ total: 201.01 }), inv()).map(x => x.kind)).toEqual(['total']);
        expect(compareOrder(order({ total: 198.99 }), inv()).map(x => x.kind)).toEqual(['total']);
    });
});

describe('linking by hand', () => {
    it('offers invoices within a week, nearest first', () => {
        const far = inv({ invoiceGuid: 'far', promisedDate: '2026-12-09T17:30:00Z' });
        const near = inv({ invoiceGuid: 'near', promisedDate: '2026-11-10T17:30:00Z' });
        expect(linkChoices(order(), [far, near, inv()]).map(i => i.invoiceGuid)).toEqual(['g1', 'near']);
    });
});
