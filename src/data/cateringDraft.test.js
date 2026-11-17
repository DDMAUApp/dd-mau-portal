import { describe, it, expect, beforeEach } from 'vitest';
import { loadCateringDraft, saveCateringDraft, clearCateringDraft, draftHasContent, CATERING_DRAFT_TTL_MS } from './cateringDraft';

const store = new Map();
beforeEach(() => {
    store.clear();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
});

const draft = { customer: { name: 'Acme Office', phone: '314', orderType: 'delivery' }, cart: [{ name: 'Pho tray', qty: 2, price: 60 }], newOrderId: 'abc123', step: 3 };

describe('catering draft', () => {
    it('survives a reload for the same person, not for someone else', () => {
        saveCateringDraft('Yulissa Hurtado', draft, 1000);
        expect(loadCateringDraft('Yulissa Hurtado', 2000)).toMatchObject({ newOrderId: 'abc123', step: 3 });
        expect(loadCateringDraft('Eduvijen Gomez', 2000)).toBeNull();
    });
    it('expires after a day and is cleared after a save', () => {
        saveCateringDraft('Yulissa Hurtado', draft, 1000);
        expect(loadCateringDraft('Yulissa Hurtado', 1000 + CATERING_DRAFT_TTL_MS + 1)).toBeNull();
        saveCateringDraft('Yulissa Hurtado', draft, 1000);
        clearCateringDraft('Yulissa Hurtado');
        expect(loadCateringDraft('Yulissa Hurtado', 2000)).toBeNull();
    });
    it('an untouched form is not a draft', () => {
        expect(draftHasContent({ customer: { orderType: 'pickup' }, cart: [] })).toBe(false);
        saveCateringDraft('Yulissa Hurtado', { customer: { orderType: 'pickup' }, cart: [] }, 1000);
        expect(loadCateringDraft('Yulissa Hurtado', 2000)).toBeNull();
        expect(draftHasContent({ customer: {}, cart: [], specialNotes: 'call first' })).toBe(true);
    });
});
