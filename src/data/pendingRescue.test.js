import { describe, it, expect, vi } from 'vitest';
vi.mock('./deviceId', () => ({ getOrCreateDeviceId: () => 'dev-1' }));
import { rescuePendingWrites, pickStuck, describeBatch, readQueuedWrites } from './pendingRescue';

// Minimal fake IndexedDB holding Firestore's queue.
function fakeIdb(batches, { hang = false } = {}) {
    return {
        databases: async () => [{ name: 'firestore/[DEFAULT]/dd-mau-staff-app/main' }],
        open: () => {
            const req = {};
            if (hang) return req;   // never fires
            setTimeout(() => {
                req.result = {
                    objectStoreNames: { contains: (n) => n === 'mutations' },
                    close: () => {},
                    transaction: () => {
                        const tx = {};
                        tx.objectStore = () => ({ getAll: () => { const g = {}; setTimeout(() => { g.result = batches; g.onsuccess?.(); }, 0); return g; } });
                        return tx;
                    },
                };
                req.onsuccess?.();
            }, 0);
            return req;
        },
    };
}
const fakeLs = (obj = {}) => {
    const m = new Map(Object.entries(obj));
    return { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};
const NOW = Date.parse('2026-11-17T21:00:00Z');
const cateringBatch = {
    batchId: 7, localWriteTimeMs: Date.parse('2026-11-17T20:17:50Z'),
    mutations: [{ update: { name: 'projects/dd-mau-staff-app/databases/(default)/documents/cateringOrders/AbC', fields: { customer: { mapValue: {} }, items: { arrayValue: {} }, total: { doubleValue: 410 } } } }],
};

describe('pending rescue', () => {
    it('reads the queue and keeps only saves stuck 2+ minutes', async () => {
        const fresh = { ...cateringBatch, batchId: 8, localWriteTimeMs: NOW - 5000 };
        const q = await readQueuedWrites(fakeIdb([cateringBatch, fresh]));
        expect(q.r).toBe('ok');
        expect(pickStuck(q.batches, NOW).map(b => b.batchId)).toEqual([7]);
        expect(describeBatch(cateringBatch)).toEqual(['set cateringOrders/AbC (customer, items, total)']);
    });

    it('uploads a stuck catering order once (same copy never sent twice)', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
        const ls = fakeLs({
            'ddmau:cateringDraft:eduvijen gomez': JSON.stringify({ customer: { name: 'X' }, savedAt: NOW - 3600000 }),   // abandoned 1 h → sent
            'ddmau:cateringDraft:yulissa hurtado': JSON.stringify({ customer: { name: 'Y' }, savedAt: NOW - 60000 }),    // being typed → skipped
        });
        const r1 = await rescuePendingWrites({ staffName: 'Eduvijen Gomez', now: NOW, idb: fakeIdb([cateringBatch]), ls, fetchImpl });
        expect(r1).toMatchObject({ sent: true, stuck: 1, drafts: 1 });
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.fields.summary.stringValue).toMatch(/set cateringOrders\/AbC/);
        expect(JSON.parse(body.fields.payload.stringValue).stuck[0].batchId).toBe(7);
        const r2 = await rescuePendingWrites({ staffName: 'Eduvijen Gomez', now: NOW + 600000, idb: fakeIdb([cateringBatch]), ls, fetchImpl });
        expect(r2.why).toBe('already-sent');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('healthy device with nothing pending sends nothing; a hung queue sends a note', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true }));
        expect((await rescuePendingWrites({ now: NOW, idb: fakeIdb([]), ls: fakeLs(), fetchImpl })).why).toBe('nothing');
        expect(fetchImpl).not.toHaveBeenCalled();
        const hung = await rescuePendingWrites({ now: NOW, idb: fakeIdb([], { hang: true }), ls: fakeLs(), fetchImpl });
        expect(hung).toMatchObject({ sent: true, r: 'hang' });
    }, 10000);
});
