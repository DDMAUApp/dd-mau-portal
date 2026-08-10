// Pins the queued-pay-adds lifecycle: queue → seed into a run → consumed
// history → requeue. The invariant that matters most: seeding NEVER loses
// an item (every unconsumed item becomes exactly one run row and exactly
// one consumed history entry).

import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase/firestore', () => ({
    doc: vi.fn(), getDoc: vi.fn(), setDoc: vi.fn(), serverTimestamp: vi.fn(),
}));
vi.mock('../../../firebase', () => ({ db: {} }));
vi.mock('../../firestoreRevive', () => ({
    watchdogWrite: (p) => p, watchdogRead: (p) => p,
}));

import {
    activeQueueItems, consumedQueueItems, trimConsumed,
    seedAdjustmentsFromQueue, requeueItem, validateQueueItem, CONSUMED_KEEP,
} from '../queuedAdds';

const item = (over = {}) => ({
    id: 'q1', loc: 'WG', key: 'doe_j', name: 'Jane Doe',
    type: 'bonus', amount: '50', hours: '', perHour: '', rate: '', note: '',
    addedBy: 'Andrew', addedAt: '2026-08-10T12:00:00Z', consumedIn: null,
    ...over,
});

describe('seedAdjustmentsFromQueue', () => {
    it('copies every unconsumed item into a run row and marks it consumed', () => {
        let n = 0;
        const items = [item(), item({ id: 'q2', type: 'advance', amount: '100', note: 'check #204' })];
        const { adjustments, items: out, count } = seedAdjustmentsFromQueue(items, '8.1.26-8.15.26', () => `adj_${n++}`);
        expect(count).toBe(2);
        expect(adjustments).toHaveLength(2);
        expect(adjustments[0]).toMatchObject({ id: 'adj_0', loc: 'WG', key: 'doe_j', type: 'bonus', amount: '50' });
        expect(adjustments[1]).toMatchObject({ type: 'advance', note: 'check #204' });
        expect(out.every((x) => x.consumedIn === '8.1.26-8.15.26')).toBe(true);
        // input untouched
        expect(items[0].consumedIn).toBeNull();
    });

    it('skips already-consumed items (a second new period never double-pays)', () => {
        const items = [item({ consumedIn: '7.16.26-7.31.26' }), item({ id: 'q2' })];
        const { adjustments, count } = seedAdjustmentsFromQueue(items, '8.1.26-8.15.26', () => 'adj_x');
        expect(count).toBe(1);
        expect(adjustments[0].key).toBe('doe_j');
    });

    it('empty queue seeds nothing', () => {
        const { adjustments, count } = seedAdjustmentsFromQueue([], 'p', () => 'a');
        expect(count).toBe(0);
        expect(adjustments).toEqual([]);
    });
});

describe('requeueItem', () => {
    it('returns a consumed item to the active queue', () => {
        const items = [item({ consumedIn: 'p1', consumedAt: '2026-08-01' })];
        const out = requeueItem(items, 'q1');
        expect(out[0].consumedIn).toBeNull();
        expect(activeQueueItems(out)).toHaveLength(1);
    });
});

describe('trimConsumed', () => {
    it('keeps all active items and only the newest N consumed', () => {
        const items = [
            item({ id: 'live1' }),
            ...Array.from({ length: CONSUMED_KEEP + 5 }, (_, i) =>
                item({ id: `c${i}`, consumedIn: 'p', consumedAt: `2026-07-${String(i + 1).padStart(2, '0')}` })),
        ];
        const out = trimConsumed(items);
        expect(activeQueueItems(out)).toHaveLength(1);
        expect(consumedQueueItems(out)).toHaveLength(CONSUMED_KEEP);
        // newest kept — the highest consumedAt survives
        expect(out.some((x) => x.id === `c${CONSUMED_KEEP + 4}`)).toBe(true);
        expect(out.some((x) => x.id === 'c0')).toBe(false);
    });
});

describe('validateQueueItem (same rules as the run)', () => {
    it('valid bonus passes', () => expect(validateQueueItem(item())).toBeNull());
    it('requires a person', () => expect(validateQueueItem(item({ key: '' }))).toMatch(/person/));
    it('advance requires a note', () =>
        expect(validateQueueItem(item({ type: 'advance', amount: '100' }))).toMatch(/note/));
    it('advance with note passes', () =>
        expect(validateQueueItem(item({ type: 'advance', amount: '100', note: 'check #12' }))).toBeNull());
    it('dollar types need an amount', () =>
        expect(validateQueueItem(item({ amount: '' }))).toMatch(/amount/));
    it('hour types need hours', () =>
        expect(validateQueueItem(item({ type: 'vacation', hours: '' }))).toMatch(/hours/));
    it('backpay needs hours AND rate', () =>
        expect(validateQueueItem(item({ type: 'backpay', hours: '4', perHour: '' }))).toMatch(/hours and/));
});
