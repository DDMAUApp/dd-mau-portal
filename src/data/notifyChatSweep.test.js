// 2026-09-23 chat audit — notify.js additions:
//   M2  markChatNotificationsRead: equality/`in`-only sweep (no composite
//       index), optional per-conversation chatId filter, ≤450-op chunks,
//       never throws.
//   m11 notifyStaff: optional chatId passes through to the notification doc
//       (and is omitted when not given); returns null on a failed write.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { where: [], limit: [], batches: [], addDoc: [] };
let docsToReturn = [];
let addDocImpl = async () => ({ id: 'n1' });
let getDocsImpl = null;

vi.mock('../firebase', () => ({ db: { __fake: true } }));
vi.mock('./firestoreRevive', () => ({
    watchdogWrite: (p) => p,
    watchdogRead: (p) => p,
}));
vi.mock('firebase/firestore', () => ({
    collection: (_db, ...segs) => ({ path: segs.join('/') }),
    doc: (_db, ...segs) => ({ path: segs.join('/') }),
    serverTimestamp: () => ({ __ts: true }),
    query: (ref, ...cs) => ({ ref, cs }),
    where: (f, op, v) => { calls.where.push([f, op, v]); return { where: [f, op, v] }; },
    limit: (n) => { calls.limit.push(n); return { limit: n }; },
    writeBatch: () => {
        const b = { ops: [], update(ref, data) { b.ops.push([ref.path, data]); }, commit: async () => {} };
        calls.batches.push(b);
        return b;
    },
    getDocs: async (q) => (getDocsImpl ? getDocsImpl(q) : {
        forEach: (fn) => docsToReturn.forEach(id => fn({ id })),
    }),
    getDoc: async () => ({ exists: () => false }),
    setDoc: async () => {},
    addDoc: async (ref, data) => { calls.addDoc.push([ref.path, data]); return addDocImpl(ref, data); },
}));

import {
    markChatNotificationsRead, chatNotifSweepFilters, CHAT_NOTIF_TYPES, notifyStaff,
} from './notify';

beforeEach(() => {
    calls.where = []; calls.limit = []; calls.batches = []; calls.addDoc = [];
    docsToReturn = [];
    addDocImpl = async () => ({ id: 'n1' });
    getDocsImpl = null;
});

describe('chatNotifSweepFilters', () => {
    it('is equality/`in` only — the shape that needs no composite index', () => {
        const f = chatNotifSweepFilters('Cash Magruder');
        expect(f).toEqual([
            ['forStaff', '==', 'Cash Magruder'],
            ['read', '==', false],
            ['type', 'in', CHAT_NOTIF_TYPES],
        ]);
        expect(f.every(([, op]) => op === '==' || op === 'in')).toBe(true);
    });
    it('adds chatId == for a per-conversation sweep', () => {
        expect(chatNotifSweepFilters('Cash Magruder', 'dm_A__B')).toContainEqual(['chatId', '==', 'dm_A__B']);
    });
    it('covers exactly the types the Chat badge counts', () => {
        expect(CHAT_NOTIF_TYPES).toEqual(['chat_message', 'chat_mention', 'chat_reply']);
    });
});

describe('markChatNotificationsRead', () => {
    it('marks every matching doc read, in ≤450-op batches', async () => {
        docsToReturn = Array.from({ length: 1000 }, (_, i) => `n${i}`);
        const n = await markChatNotificationsRead('Cash Magruder');
        expect(n).toBe(1000);
        expect(calls.batches.map(b => b.ops.length)).toEqual([450, 450, 100]);
        expect(calls.batches[0].ops[0]).toEqual(['notifications/n0', { read: true }]);
        expect(calls.limit).toEqual([1500]);
    });
    it('scopes to one conversation when chatId is given', async () => {
        docsToReturn = ['a', 'b'];
        await markChatNotificationsRead('Cash Magruder', { chatId: 'c1', max: 200 });
        expect(calls.where).toContainEqual(['chatId', '==', 'c1']);
        expect(calls.limit).toEqual([200]);
    });
    it('no staffName → no query', async () => {
        expect(await markChatNotificationsRead('')).toBe(0);
        expect(calls.where).toEqual([]);
    });
    it('writes nothing when nothing is unread', async () => {
        expect(await markChatNotificationsRead('Cash Magruder')).toBe(0);
        expect(calls.batches).toEqual([]);
    });
    it('honours isCancelled between the read and the writes', async () => {
        docsToReturn = ['a'];
        expect(await markChatNotificationsRead('Cash Magruder', { isCancelled: () => true })).toBe(0);
        expect(calls.batches).toEqual([]);
    });
    it('never throws — a failed read resolves 0', async () => {
        getDocsImpl = async () => { throw new Error('offline'); };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(markChatNotificationsRead('Cash Magruder')).resolves.toBe(0);
        warn.mockRestore();
    });
});

describe('notifyStaff chatId passthrough (m11)', () => {
    it('stamps chatId on the doc when given', async () => {
        const id = await notifyStaff({ forStaff: 'Tom Lee', type: 'chat_nudge', title: 't', body: 'b', chatId: 'c1' });
        expect(id).toBe('n1');
        expect(calls.addDoc[0][1].chatId).toBe('c1');
    });
    it('omits the field when not given (existing callers unchanged)', async () => {
        await notifyStaff({ forStaff: 'Tom Lee', type: 'shift_offer', title: 't', body: 'b' });
        expect('chatId' in calls.addDoc[0][1]).toBe(false);
    });
    it('resolves null (never throws) when the write fails — callers must check', async () => {
        addDocImpl = async () => { throw new Error('denied'); };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(notifyStaff({ forStaff: 'Tom Lee', type: 'chat_nudge', title: 't', body: 'b' })).resolves.toBeNull();
        warn.mockRestore();
    });
});
