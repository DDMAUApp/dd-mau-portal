// 2026-09-25 chat review — pure helpers behind the ChatThread / ChatCenter
// fixes: #2 jump re-measure, #9 mark-read skip, #11 Load-older restore,
// #14 late notification sweep, #21 sender grouping on cold-cache paints, and
// the own-typing activeChat stabilization.
import { describe, it, expect } from 'vitest';
import {
    tsToMillis,
    isSameSenderRun,
    markReadNeeded,
    nextNotifSweepStep,
    LATE_NOTIF_SWEEP_MS,
    planNotifSweepDelay,
    chatDocEqualExceptOwnTyping,
    planScrollRestore,
    SCROLL_RESTORE_TTL_MS,
    SCROLL_RESTORE_HARD_CAP_MS,
    isNearBottom,
} from './chatThreadHelpers';

const ts = (seconds) => ({ seconds, nanoseconds: 0, toMillis() { return seconds * 1000; } });
const cached = (seconds) => ({ seconds }); // localStorage warm-cache shape

describe('tsToMillis', () => {
    it('reads a Timestamp and the {seconds} cache shape', () => {
        expect(tsToMillis(ts(100))).toBe(100_000);
        expect(tsToMillis(cached(100))).toBe(100_000);
    });
    it('missing / pending / junk → 0', () => {
        expect(tsToMillis(null)).toBe(0);
        expect(tsToMillis(undefined)).toBe(0);
        expect(tsToMillis('2026-01-01')).toBe(0);
        expect(tsToMillis({})).toBe(0);
    });
});

describe('isSameSenderRun (#21)', () => {
    const a = { senderName: 'Cash Magruder', createdAt: ts(1000) };
    it('groups consecutive messages from one sender within 5 minutes', () => {
        expect(isSameSenderRun(a, { senderName: 'Cash Magruder', createdAt: ts(1000 + 60) })).toBe(true);
    });
    it('groups on a cold-cache paint too ({seconds}, no toMillis)', () => {
        const p = { senderName: 'Cash Magruder', createdAt: cached(1000) };
        const m = { senderName: 'Cash Magruder', createdAt: cached(1030) };
        expect(isSameSenderRun(p, m)).toBe(true);
    });
    it('mixed shapes (cache → live) still group', () => {
        expect(isSameSenderRun({ senderName: 'X', createdAt: cached(10) }, { senderName: 'X', createdAt: ts(20) })).toBe(true);
    });
    it('breaks on a different sender, a >5 min gap, a pending message, or no prev', () => {
        expect(isSameSenderRun(a, { senderName: 'Tom Lee', createdAt: ts(1001) })).toBe(false);
        expect(isSameSenderRun(a, { senderName: 'Cash Magruder', createdAt: ts(1000 + 301) })).toBe(false);
        expect(isSameSenderRun(a, { senderName: 'Cash Magruder', createdAt: null })).toBe(false);
        expect(isSameSenderRun(undefined, a)).toBe(false);
    });
});

describe('markReadNeeded (#9)', () => {
    const me = 'Cash Magruder';
    const other = (id, s) => ({ id, senderName: 'Tom Lee', createdAt: ts(s) });
    const mine = (id, s) => ({ id, senderName: me, createdAt: s == null ? null : ts(s) });

    it('skips the write when my marker already covers the newest message from someone else', () => {
        const chat = { lastReadByName: { [me]: ts(200) }, lastActivityAt: ts(150), lastMessage: { sender: 'Tom Lee' } };
        expect(markReadNeeded(chat, [other('a', 100), other('b', 150)], me)).toBe(false);
    });
    it('writes when a newer message from someone else is loaded', () => {
        const chat = { lastReadByName: { [me]: ts(100) }, lastActivityAt: ts(150), lastMessage: { sender: 'Tom Lee' } };
        expect(markReadNeeded(chat, [other('a', 100), other('b', 150)], me)).toBe(true);
    });
    it('my own newer messages (incl. a pending one) never force a write', () => {
        const chat = { lastReadByName: { [me]: ts(100) }, lastActivityAt: ts(160), lastMessage: { sender: me } };
        expect(markReadNeeded(chat, [other('a', 90), mine('b', 160), mine('c', null)], me)).toBe(false);
    });
    it('writes when the list would still show unread (lastActivityAt past my marker, not my preview)', () => {
        // e.g. the newest message is outside the loaded set but the preview moved on
        const chat = { lastReadByName: { [me]: ts(100) }, lastActivityAt: ts(300), lastMessage: { sender: 'Tom Lee' } };
        expect(markReadNeeded(chat, [other('a', 90)], me)).toBe(true);
    });
    it('no marker yet + messages from others → write', () => {
        const chat = { lastMessage: { sender: 'Tom Lee' }, lastActivityAt: ts(100) };
        expect(markReadNeeded(chat, [other('a', 100)], me)).toBe(true);
    });
    it('reads the {seconds} cache shape and an estimated (pending-write) marker', () => {
        const chat = { lastReadByName: { [me]: cached(500) }, lastMessage: { sender: 'Tom Lee' }, lastActivityAt: cached(400) };
        expect(markReadNeeded(chat, [{ senderName: 'Tom Lee', createdAt: cached(400) }], me)).toBe(false);
    });
    it('a chat with only my own messages never needs a write; no viewer → false', () => {
        expect(markReadNeeded({ lastMessage: { sender: me } }, [mine('a', 10)], me)).toBe(false);
        expect(markReadNeeded({}, [other('a', 10)], '')).toBe(false);
    });
});

describe('nextNotifSweepStep (#14)', () => {
    it('a request inside the settle window → follow-up sweep', () => {
        expect(nextNotifSweepStep({ firedAt: 10_000, lastRequestAt: 9_000 })).toBe('followup');
    });
    it('no new request → exactly one bounded LATE sweep', () => {
        const requestAt = 1_000_000;
        const firedAt = requestAt + planNotifSweepDelay({ now: requestAt, lastSweepAt: 0 });
        expect(nextNotifSweepStep({ firedAt, lastRequestAt: requestAt })).toBe('late');
    });
    it('the late sweep never schedules another late sweep', () => {
        expect(nextNotifSweepStep({ firedAt: 50_000, lastRequestAt: 1_000, wasLate: true })).toBe(null);
    });
    it('…but a request that landed just before the late sweep still gets its follow-up', () => {
        expect(nextNotifSweepStep({ firedAt: 50_000, lastRequestAt: 49_000, wasLate: true })).toBe('followup');
    });
    it('the late delay also honors the 15s minimum gap between sweeps', () => {
        expect(LATE_NOTIF_SWEEP_MS).toBeGreaterThanOrEqual(15_000);
    });
});

describe('chatDocEqualExceptOwnTyping (own heartbeat does not re-render the thread)', () => {
    const base = { id: 'c1', name: 'FOH', typingByName: { 'Tom Lee': ts(5) }, lastReadByName: { 'Cash Magruder': ts(3) } };
    it('ignores a change to MY typing heartbeat only', () => {
        const a = { ...base, typingByName: { ...base.typingByName, 'Cash Magruder': ts(10) } };
        const b = { ...base, typingByName: { ...base.typingByName, 'Cash Magruder': ts(12) } };
        expect(chatDocEqualExceptOwnTyping(a, b, 'Cash Magruder')).toBe(true);
        // my key appearing / disappearing is ignored too
        expect(chatDocEqualExceptOwnTyping(base, a, 'Cash Magruder')).toBe(true);
    });
    it("still sees someone ELSE's typing and every other field", () => {
        const b = { ...base, typingByName: { 'Tom Lee': ts(9) } };
        expect(chatDocEqualExceptOwnTyping(base, b, 'Cash Magruder')).toBe(false);
        expect(chatDocEqualExceptOwnTyping(base, { ...base, name: 'BOH' }, 'Cash Magruder')).toBe(false);
        expect(chatDocEqualExceptOwnTyping(base, { ...base, lastReadByName: { 'Cash Magruder': ts(4) } }, 'Cash Magruder')).toBe(false);
    });
    it('without a viewer name it is plain chatDocEqual; does not mutate inputs', () => {
        const a = { ...base, typingByName: { 'Cash Magruder': ts(1) } };
        const snapshot = JSON.stringify(a);
        expect(chatDocEqualExceptOwnTyping(a, base, '')).toBe(false);
        chatDocEqualExceptOwnTyping(a, base, 'Cash Magruder');
        expect(JSON.stringify(a)).toBe(snapshot);
    });
});

describe('planScrollRestore (#11)', () => {
    const rec = { height: 2000, top: 40, firstId: 'm50', at: 1_000_000 };
    const ctx = (over) => ({ now: 1_000_500, firstId: 'm50', atBottom: false, scrollHeight: 2000, inFlight: true, ...over });

    it('applies once older rows were prepended (first message changed + grew)', () => {
        expect(planScrollRestore(rec, ctx({ firstId: 'm0', scrollHeight: 3500 }))).toEqual({ action: 'apply', top: 1540 });
    });
    it('waits on a cache echo of the old window (nothing prepended)', () => {
        expect(planScrollRestore(rec, ctx({}))).toEqual({ action: 'wait' });
    });
    it('growth at the BOTTOM (same first message) never applies the restore', () => {
        expect(planScrollRestore(rec, ctx({ scrollHeight: 2300, inFlight: false })).action).not.toBe('apply');
    });
    it('drops a stale record once no bigger window is in flight (load prepended nothing)', () => {
        const now = rec.at + SCROLL_RESTORE_TTL_MS + 1;
        expect(planScrollRestore(rec, ctx({ now, inFlight: false, scrollHeight: 2300 }))).toEqual({ action: 'drop' });
    });
    it('keeps waiting past the TTL while the bigger window is still in flight (slow Wi-Fi)…', () => {
        const now = rec.at + SCROLL_RESTORE_TTL_MS + 5000;
        expect(planScrollRestore(rec, ctx({ now }))).toEqual({ action: 'wait' });
        expect(planScrollRestore(rec, ctx({ now, firstId: 'm0', scrollHeight: 3000 })).action).toBe('apply');
    });
    it('…up to a hard cap', () => {
        const now = rec.at + SCROLL_RESTORE_HARD_CAP_MS + 1;
        expect(planScrollRestore(rec, ctx({ now, firstId: 'm0', scrollHeight: 3000 }))).toEqual({ action: 'drop' });
    });
    it('drops when the viewer is pinned to the bottom (the ResizeObserver owns that)', () => {
        expect(planScrollRestore(rec, ctx({ atBottom: true, firstId: 'm0', scrollHeight: 3000 }))).toEqual({ action: 'drop' });
    });
    it('no record → none; a record without a timestamp is treated as stale', () => {
        expect(planScrollRestore(null, ctx({}))).toEqual({ action: 'none' });
        expect(planScrollRestore({ height: 1, top: 0, firstId: 'x' }, ctx({ firstId: 'y', scrollHeight: 50 }))).toEqual({ action: 'drop' });
    });
});

describe('isNearBottom (#2 jump re-measure)', () => {
    it('within 100px of the bottom → true; further up → false', () => {
        expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1450, clientHeight: 500 })).toBe(true);
        expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1000, clientHeight: 500 })).toBe(false);
    });
    it('a short thread that fits the viewport is at the bottom', () => {
        expect(isNearBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 600 })).toBe(true);
    });
});
