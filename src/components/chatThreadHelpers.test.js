// Tests for chatDocEqual — the Timestamp-aware deep-equal that lets
// ChatCenter keep a stable `activeChat` reference across chats-snapshot
// churn (see the 2026-07-21 chat-audit follow-up note in the helper).
import { describe, it, expect } from 'vitest';
import { chatDocEqual } from './chatThreadHelpers';

// Minimal Firestore-Timestamp stand-ins. Firestore hands back a NEW
// Timestamp instance on every snapshot, so two value-equal writes are
// distinct objects — exactly the case a naive === would miss.
const ts = (seconds, nanoseconds = 0) => ({
    seconds,
    nanoseconds,
    toMillis() { return seconds * 1000 + Math.floor(nanoseconds / 1e6); },
});

describe('chatDocEqual', () => {
    it('same reference is equal', () => {
        const a = { id: 'c1', members: ['A', 'B'] };
        expect(chatDocEqual(a, a)).toBe(true);
    });

    it('deep-equal distinct objects are equal', () => {
        const a = { id: 'c1', type: 'group', members: ['A', 'B'], lastReadByName: { A: ts(100) } };
        const b = { id: 'c1', type: 'group', members: ['A', 'B'], lastReadByName: { A: ts(100) } };
        expect(a).not.toBe(b);
        expect(chatDocEqual(a, b)).toBe(true);
    });

    it('distinct Timestamp instances with the same value are equal', () => {
        expect(chatDocEqual(ts(1721000000, 500), ts(1721000000, 500))).toBe(true);
    });

    it('Timestamps with different values are not equal', () => {
        expect(chatDocEqual(ts(100), ts(101))).toBe(false);
    });

    it('a read-marker change on THIS chat is detected (not equal)', () => {
        const a = { id: 'c1', lastReadByName: { A: ts(100) } };
        const b = { id: 'c1', lastReadByName: { A: ts(100), B: ts(200) } };
        expect(chatDocEqual(a, b)).toBe(false);
    });

    it('a typing heartbeat change is detected (not equal)', () => {
        const a = { id: 'c1', typingByName: { A: ts(100) } };
        const b = { id: 'c1', typingByName: { A: ts(105) } };
        expect(chatDocEqual(a, b)).toBe(false);
    });

    it('member list order/content difference is detected', () => {
        expect(chatDocEqual({ members: ['A', 'B'] }, { members: ['B', 'A'] })).toBe(false);
        expect(chatDocEqual({ members: ['A'] }, { members: ['A', 'B'] })).toBe(false);
    });

    it('differing key sets are not equal', () => {
        expect(chatDocEqual({ id: 'c1', name: 'x' }, { id: 'c1' })).toBe(false);
        expect(chatDocEqual({ id: 'c1' }, { id: 'c1', name: 'x' })).toBe(false);
    });

    it('null / undefined handling', () => {
        expect(chatDocEqual(null, null)).toBe(true);
        expect(chatDocEqual(undefined, undefined)).toBe(true);
        expect(chatDocEqual(null, undefined)).toBe(false);
        expect(chatDocEqual(null, { id: 'c1' })).toBe(false);
        expect(chatDocEqual({ id: 'c1' }, null)).toBe(false);
    });

    it('nested arrays of objects compare deeply', () => {
        const a = { pinned: [{ id: 'm1', at: ts(1) }, { id: 'm2', at: ts(2) }] };
        const b = { pinned: [{ id: 'm1', at: ts(1) }, { id: 'm2', at: ts(2) }] };
        expect(chatDocEqual(a, b)).toBe(true);
        const c = { pinned: [{ id: 'm1', at: ts(1) }, { id: 'm2', at: ts(3) }] };
        expect(chatDocEqual(a, c)).toBe(false);
    });

    it('primitive scalar differences are detected', () => {
        expect(chatDocEqual({ smsNudge: true }, { smsNudge: false })).toBe(false);
        expect(chatDocEqual({ name: 'Kitchen' }, { name: 'Kitchen' })).toBe(true);
    });
});
