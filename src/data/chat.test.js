// Tests for chat helpers.
//
// The permission model (canEditChat) is the most load-bearing piece —
// it's the difference between "admins can't lock staff out of their
// own group" and "any staff can hijack the whole-team channel". These
// tests pin the exact spec the user requested:
//
//   • Admin-created group → only admins can edit
//   • Manager-created group → managers + admins can edit
//   • Staff-created group → creator + admins (+ deputized co-admins) can edit
//   • Channels → only app admins can rename; member sync is automatic
//   • DMs → never editable

import { describe, it, expect } from 'vitest';
import {
    canEditChat,
    tierOf,
    channelDocId,
    dmDocId,
    channelMembersFor,
    parseMentions,
    isChatUnread,
    previewOf,
    formatChatName,
    getSeenByVisibility,
    canSeeReceiptsForMessage,
    getSeenByForMessage,
    canEditMessage,
    isMessageEditable,
    isWithinEditWindow,
    EDIT_WINDOW_MS,
} from './chat';

const owner    = { id: 40, name: 'Andrew Shih', role: 'Owner' };
const manager  = { id: 7,  name: 'Maria Lopez', role: 'Manager' };
const kmanager = { id: 8,  name: 'Sam Cook',    role: 'Kitchen Manager' };
const lineFoh  = { id: 1,  name: 'Cash Magruder', role: 'FOH' };
const lineBoh  = { id: 2,  name: 'Tom Lee', role: 'BOH' };

describe('tierOf', () => {
    it('admin flag wins', () => {
        expect(tierOf(lineFoh, true)).toBe('admin');
    });
    it('manager role string', () => {
        expect(tierOf(manager, false)).toBe('manager');
        expect(tierOf(kmanager, false)).toBe('manager');
    });
    it('default tier is staff', () => {
        expect(tierOf(lineFoh, false)).toBe('staff');
        expect(tierOf({}, false)).toBe('staff');
        expect(tierOf(null, false)).toBe('staff');
    });
});

describe('canEditChat — admin-created group', () => {
    const chat = {
        type: 'group',
        createdBy: 'Andrew Shih',
        createdByTier: 'admin',
        editTier: 'admin',
        members: ['Andrew Shih', 'Maria Lopez', 'Cash Magruder'],
    };
    it('app admin can edit', () => {
        expect(canEditChat(chat, lineFoh, true)).toBe(true);
    });
    it('manager cannot edit', () => {
        expect(canEditChat(chat, manager, false)).toBe(false);
    });
    it('line staff cannot edit', () => {
        expect(canEditChat(chat, lineFoh, false)).toBe(false);
    });
});

describe('canEditChat — manager-created group', () => {
    const chat = {
        type: 'group',
        createdBy: 'Maria Lopez',
        createdByTier: 'manager',
        editTier: 'manager',
        members: ['Maria Lopez', 'Cash Magruder', 'Tom Lee'],
    };
    it('manager can edit', () => {
        expect(canEditChat(chat, manager, false)).toBe(true);
    });
    it('kitchen manager can edit (manager-tier role)', () => {
        expect(canEditChat(chat, kmanager, false)).toBe(true);
    });
    it('app admin can edit', () => {
        expect(canEditChat(chat, owner, true)).toBe(true);
    });
    it('line staff cannot edit even if creator (manager floor)', () => {
        // Creator does NOT override editTier for manager-created groups —
        // the floor IS manager. (Manager creators are still managers, so
        // they keep edit rights regardless.)
        expect(canEditChat(chat, lineFoh, false)).toBe(false);
    });
});

describe('canEditChat — staff-created group', () => {
    const chat = {
        type: 'group',
        createdBy: 'Cash Magruder',
        createdByTier: 'staff',
        editTier: 'staff',
        admins: [],
        members: ['Cash Magruder', 'Tom Lee'],
    };
    it('creator can edit their own group', () => {
        expect(canEditChat(chat, lineFoh, false)).toBe(true);
    });
    it('non-creator staff cannot edit', () => {
        expect(canEditChat(chat, lineBoh, false)).toBe(false);
    });
    it('app admin can always edit', () => {
        expect(canEditChat(chat, manager, true)).toBe(true);
    });
    it('deputized co-admin can edit', () => {
        const withCo = { ...chat, admins: ['Tom Lee'] };
        expect(canEditChat(withCo, lineBoh, false)).toBe(true);
    });
});

describe('canEditChat — DMs + channels', () => {
    it('DMs never editable, even for admin', () => {
        const dm = { type: 'dm', members: ['Andrew Shih', 'Cash Magruder'] };
        expect(canEditChat(dm, owner, true)).toBe(false);
        expect(canEditChat(dm, lineFoh, false)).toBe(false);
    });
    it('channels: only admins (auto-membership)', () => {
        const channel = { type: 'channel', channelKey: 'all', editTier: 'admin' };
        expect(canEditChat(channel, owner, true)).toBe(true);
        expect(canEditChat(channel, manager, false)).toBe(false);
        expect(canEditChat(channel, lineFoh, false)).toBe(false);
    });
});

describe('channelDocId / dmDocId', () => {
    it('channel ids are deterministic', () => {
        expect(channelDocId('all')).toBe('channel_all');
        expect(channelDocId('foh')).toBe('channel_foh');
    });
    it('DM ids are order-independent + collision-safe', () => {
        const a = dmDocId('Andrew Shih', 'Cash Magruder');
        const b = dmDocId('Cash Magruder', 'Andrew Shih');
        expect(a).toBe(b);
        expect(a).toContain('dm_');
    });
});

describe('channelMembersFor', () => {
    // 2026-05-16 bug-fix regression: hideFromSchedule used to filter
    // here, which silently hid owners (Andrew + Julie both toggle the
    // flag on themselves so they don't clutter the schedule grid)
    // from the chat picker AND from every auto-channel. Pinning the
    // new behavior: hideFromSchedule is a SCHEDULE flag, not a chat
    // flag. Owners belong in chat.
    const list = [
        owner,
        manager,
        lineFoh,
        lineBoh,
        { id: 41, name: 'Julie Shih', role: 'Owner', hideFromSchedule: true },
    ];
    it('"all" includes everyone — hideFromSchedule does not filter chat', () => {
        const m = channelMembersFor('all', list);
        expect(m).toContain('Andrew Shih');
        expect(m).toContain('Julie Shih');         // owner with hideFromSchedule still in chat
        expect(m).toContain('Cash Magruder');
        expect(m).toContain('Tom Lee');
    });
    it('"foh" matches FOH role / scheduleSide', () => {
        const m = channelMembersFor('foh', list);
        expect(m).toContain('Cash Magruder');
        expect(m).not.toContain('Tom Lee');
    });
    it('"boh" matches BOH role / scheduleSide', () => {
        const m = channelMembersFor('boh', list);
        expect(m).toContain('Tom Lee');
        expect(m).not.toContain('Cash Magruder');
    });
});

describe('channelMembersFor — location-split side channels', () => {
    // Location separation (2026-05-16). Webster + Maryland staff each
    // get their own side channels; owners (location 'both') auto-join
    // every pair so they can see chatter from either store.
    const websterFoh  = { id: 1, name: 'Cash Magruder',  role: 'FOH', location: 'webster' };
    const websterBoh  = { id: 2, name: 'Tom Lee',         role: 'BOH', location: 'webster' };
    const marylandFoh = { id: 3, name: 'Riley Maryland',  role: 'FOH', location: 'maryland' };
    const marylandBoh = { id: 4, name: 'Sam Cook',        role: 'BOH', location: 'maryland' };
    const floaterFoh  = { id: 5, name: 'Avery Floater',   role: 'FOH', location: 'both' };
    const ownerBoth   = { id: 40, name: 'Andrew Shih',    role: 'Owner', location: 'both' };
    const list = [websterFoh, websterBoh, marylandFoh, marylandBoh, floaterFoh, ownerBoth];

    it('foh-webster includes Webster FOH + both-location FOH + owners', () => {
        const m = channelMembersFor('foh-webster', list);
        expect(m).toContain('Cash Magruder');
        expect(m).toContain('Avery Floater');
        expect(m).toContain('Andrew Shih');
        expect(m).not.toContain('Riley Maryland');   // Maryland FOH excluded
        expect(m).not.toContain('Tom Lee');           // Webster BOH excluded
        expect(m).not.toContain('Sam Cook');          // Maryland BOH excluded
    });
    it('foh-maryland includes Maryland FOH + both-location FOH + owners', () => {
        const m = channelMembersFor('foh-maryland', list);
        expect(m).toContain('Riley Maryland');
        expect(m).toContain('Avery Floater');
        expect(m).toContain('Andrew Shih');
        expect(m).not.toContain('Cash Magruder');     // Webster FOH excluded
    });
    it('boh-webster includes only Webster BOH + both', () => {
        const m = channelMembersFor('boh-webster', list);
        expect(m).toContain('Tom Lee');
        expect(m).toContain('Andrew Shih');
        expect(m).not.toContain('Sam Cook');
        expect(m).not.toContain('Cash Magruder');
    });
    it('boh-maryland includes only Maryland BOH + both', () => {
        const m = channelMembersFor('boh-maryland', list);
        expect(m).toContain('Sam Cook');
        expect(m).not.toContain('Tom Lee');
    });
});

describe('parseMentions', () => {
    const list = [owner, manager, lineFoh, { id: 99, name: 'Andrew Jones' }];
    it('matches bare @firstname', () => {
        const { mentions } = parseMentions('hey @cash you in?', list);
        expect(mentions).toEqual(['Cash Magruder']);
    });
    it('matches quoted @"First Last"', () => {
        const { mentions } = parseMentions('cc @"Andrew Jones" please', list);
        expect(mentions).toEqual(['Andrew Jones']);
    });
    it('notifies EVERY match when a bare first name is ambiguous', () => {
        // "Andrew" could be Andrew Shih OR Andrew Jones. Correctness fix
        // (2026-07-14): rather than silently pick whoever is first in the
        // array (leaving the intended Andrew un-notified), notify BOTH — the
        // right person always gets pinged. Use @"First Last" to target one.
        const { mentions } = parseMentions('hey @andrew', list);
        expect(mentions.length).toBe(2);
        expect(mentions).toContain('Andrew Shih');
        expect(mentions).toContain('Andrew Jones');
    });
    it('still prefers an EXACT full-name match over first-name spread', () => {
        // If someone is literally named one word matching the token, only
        // they are mentioned (no first-name fan-out).
        const oneWord = [...list, { id: 100, name: 'Cash' }];
        const { mentions } = parseMentions('hey @cash', oneWord);
        expect(mentions).toEqual(['Cash']);
    });
    it('ignores unknown names', () => {
        const { mentions } = parseMentions('@ghost where are you', list);
        expect(mentions).toEqual([]);
    });
    it('empty input is safe', () => {
        expect(parseMentions('', list).mentions).toEqual([]);
        expect(parseMentions(null, list).mentions).toEqual([]);
    });
});

describe('previewOf', () => {
    it('renders sender + text for text messages', () => {
        expect(previewOf({ senderName: 'Cash Magruder', type: 'text', text: 'hi team' }))
            .toBe('Cash: hi team');
    });
    it('emoji-prefixed previews for media types', () => {
        expect(previewOf({ senderName: 'Maria', type: 'image' })).toContain('📷');
        expect(previewOf({ senderName: 'Maria', type: 'video' })).toContain('🎬');
        expect(previewOf({ senderName: 'Maria', type: 'audio' })).toContain('🎤');
    });
    it('truncates long bodies', () => {
        const text = 'a'.repeat(200);
        const p = previewOf({ senderName: 'Cash', type: 'text', text });
        expect(p.length).toBeLessThan(text.length);
        expect(p.endsWith('…')).toBe(true);
    });
    it('soft-deleted message reads as "(deleted)"', () => {
        expect(previewOf({ deleted: true })).toBe('(deleted)');
    });
});

describe('formatChatName', () => {
    it('full first + last initial for two-word name', () => {
        expect(formatChatName('Andrew Shih')).toBe('Andrew S.');
        expect(formatChatName('Cash Magruder')).toBe('Cash M.');
    });
    it('three-word name uses LAST word as last name', () => {
        expect(formatChatName('Maria José Lopez')).toBe('Maria L.');
    });
    it('single-word name returns as-is (no initial available)', () => {
        expect(formatChatName('Andrew')).toBe('Andrew');
    });
    it('empty / null returns empty string', () => {
        expect(formatChatName('')).toBe('');
        expect(formatChatName(null)).toBe('');
        expect(formatChatName(undefined)).toBe('');
    });
    it('extra whitespace handled', () => {
        expect(formatChatName('  Cash   Magruder  ')).toBe('Cash M.');
    });
    it('lowercase last initial is uppercased', () => {
        expect(formatChatName('andrew shih')).toBe('andrew S.');
    });
});

describe('isChatUnread', () => {
    const tsBefore = { toMillis: () => 100 };
    const tsAfter  = { toMillis: () => 200 };
    it('unread when lastActivity > lastRead', () => {
        const chat = {
            lastActivityAt: tsAfter,
            lastReadByName: { 'Cash Magruder': tsBefore },
        };
        expect(isChatUnread(chat, 'Cash Magruder')).toBe(true);
    });
    it('read when lastRead >= lastActivity', () => {
        const chat = {
            lastActivityAt: tsBefore,
            lastReadByName: { 'Cash Magruder': tsAfter },
        };
        expect(isChatUnread(chat, 'Cash Magruder')).toBe(false);
    });
    it('sender of last message is implicitly read', () => {
        const chat = {
            lastActivityAt: tsAfter,
            lastMessage: { sender: 'Cash Magruder' },
            lastReadByName: {},
        };
        expect(isChatUnread(chat, 'Cash Magruder')).toBe(false);
    });
    it('no lastActivity = not unread (empty chat)', () => {
        expect(isChatUnread({}, 'Cash')).toBe(false);
    });
});

describe('getSeenByVisibility — default + roundtrip', () => {
    // Default flipped to 'admins_strict' on 2026-05-17 — Andrew wants
    // owner-only read-receipt oversight on every chat by default.
    it('defaults to admins_strict when missing', () => {
        expect(getSeenByVisibility({})).toBe('admins_strict');
        expect(getSeenByVisibility(null)).toBe('admins_strict');
    });
    it('passes through valid values', () => {
        expect(getSeenByVisibility({ seenByVisibility: 'everyone' })).toBe('everyone');
        expect(getSeenByVisibility({ seenByVisibility: 'admins_only' })).toBe('admins_only');
        expect(getSeenByVisibility({ seenByVisibility: 'admins_strict' })).toBe('admins_strict');
        expect(getSeenByVisibility({ seenByVisibility: 'sender_only' })).toBe('sender_only');
        expect(getSeenByVisibility({ seenByVisibility: 'off' })).toBe('off');
    });
    it('coerces invalid value back to default', () => {
        expect(getSeenByVisibility({ seenByVisibility: 'garbage' })).toBe('admins_strict');
    });
});

describe('canSeeReceiptsForMessage', () => {
    const msg = { senderName: 'Cash Magruder', createdAt: { toMillis: () => 100 } };
    const otherMsg = { senderName: 'Maria Lopez', createdAt: { toMillis: () => 100 } };
    const viewerCash    = { name: 'Cash Magruder' };
    const viewerMaria   = { name: 'Maria Lopez' };

    it('off — nobody sees receipts', () => {
        const chat = { seenByVisibility: 'off', members: [], admins: [] };
        expect(canSeeReceiptsForMessage(chat, msg, viewerCash, false)).toBe(false);
        expect(canSeeReceiptsForMessage(chat, msg, viewerMaria, true)).toBe(false);
    });
    it('everyone — every viewer sees receipts', () => {
        const chat = { seenByVisibility: 'everyone' };
        expect(canSeeReceiptsForMessage(chat, msg, viewerCash, false)).toBe(true);
        expect(canSeeReceiptsForMessage(chat, msg, viewerMaria, false)).toBe(true);
    });
    it('sender_only — only the message author sees', () => {
        const chat = { seenByVisibility: 'sender_only' };
        expect(canSeeReceiptsForMessage(chat, msg, viewerCash, false)).toBe(true);
        expect(canSeeReceiptsForMessage(chat, msg, viewerMaria, false)).toBe(false);
    });
    it('admins_only — sender + app admin + chat co-admin', () => {
        const chat = { seenByVisibility: 'admins_only', admins: ['Maria Lopez'] };
        // App admin sees a message they didn't send
        expect(canSeeReceiptsForMessage(chat, msg, viewerMaria, true)).toBe(true);
        // Co-admin (in chat.admins) sees too
        expect(canSeeReceiptsForMessage(chat, otherMsg, viewerMaria, false)).toBe(true);
        // Sender always sees their own
        expect(canSeeReceiptsForMessage(chat, msg, viewerCash, false)).toBe(true);
        // Non-admin non-sender does NOT see
        expect(canSeeReceiptsForMessage(chat, otherMsg, viewerCash, false)).toBe(false);
    });
    it('admins_strict — ONLY admins see, sender does not', () => {
        const chat = { seenByVisibility: 'admins_strict', admins: ['Maria Lopez'] };
        // App admin sees regardless
        expect(canSeeReceiptsForMessage(chat, msg, viewerMaria, true)).toBe(true);
        // Co-admin (listed in chat.admins) sees
        expect(canSeeReceiptsForMessage(chat, otherMsg, viewerMaria, false)).toBe(true);
        // Sender does NOT see their own receipts (the strict-only diff
        // from admins_only)
        expect(canSeeReceiptsForMessage(chat, msg, viewerCash, false)).toBe(false);
        // Random staff also does not see
        expect(canSeeReceiptsForMessage(chat, otherMsg, viewerCash, false)).toBe(false);
    });
    it('defaults to admins_strict when field absent', () => {
        // Post-2026-05-17 default: only admins see. The sender does
        // NOT see their own receipts unless they ARE an admin.
        const chat = {};
        // Sender Cash is not admin → no receipts
        expect(canSeeReceiptsForMessage(chat, msg, viewerCash, false)).toBe(false);
        // Maria (not sender) as admin → sees
        expect(canSeeReceiptsForMessage(chat, msg, viewerMaria, true)).toBe(true);
        // Maria as plain staff → no receipts
        expect(canSeeReceiptsForMessage(chat, msg, viewerMaria, false)).toBe(false);
    });
});

describe('getSeenByForMessage', () => {
    const msg = { senderName: 'Cash Magruder', createdAt: { toMillis: () => 100 } };
    it('lists members whose lastRead >= message createdAt, excluding sender', () => {
        const chat = {
            members: ['Cash Magruder', 'Maria Lopez', 'Tom Lee', 'Sam Cook'],
            lastReadByName: {
                'Cash Magruder': { toMillis: () => 200 },   // sender — excluded
                'Maria Lopez':   { toMillis: () => 150 },   // read after  ✓
                'Tom Lee':       { toMillis: () => 90 },    // read before — no
                'Sam Cook':      { toMillis: () => 100 },   // exact — counted
            },
        };
        const result = getSeenByForMessage(chat, msg);
        expect(result.map(r => r.name)).toEqual(['Sam Cook', 'Maria Lopez']);
    });
    it('skips members with no lastRead entry', () => {
        const chat = {
            members: ['Cash Magruder', 'Maria Lopez'],
            lastReadByName: { 'Cash Magruder': { toMillis: () => 100 } },
        };
        expect(getSeenByForMessage(chat, msg)).toEqual([]);
    });
    it('returns [] when chat or message missing', () => {
        expect(getSeenByForMessage(null, msg)).toEqual([]);
        expect(getSeenByForMessage({}, null)).toEqual([]);
    });
});

// Edit-your-own-message — author + window + type gates. Each gate is
// individually testable so a future change (e.g., widening the
// window or supporting announcement edits) doesn't silently widen
// the surface in production without an updated test.
describe('canEditMessage / isMessageEditable / isWithinEditWindow', () => {
    const now = 1_730_000_000_000; // arbitrary fixed Date.now()
    const mkMsg = (overrides = {}) => ({
        id: 'm1',
        senderName: 'Cash Magruder',
        type: 'text',
        text: 'hello',
        createdAt: { toMillis: () => now - 60_000 }, // 1 min ago
        ...overrides,
    });
    const viewerCash = { name: 'Cash Magruder' };
    const viewerMaria = { name: 'Maria Lopez' };

    it('isMessageEditable: text yes; image w/ caption yes; image w/o caption no', () => {
        expect(isMessageEditable(mkMsg({ type: 'text' }))).toBe(true);
        expect(isMessageEditable(mkMsg({ type: 'image', text: 'caption' }))).toBe(true);
        expect(isMessageEditable(mkMsg({ type: 'image', text: '' }))).toBe(false);
        expect(isMessageEditable(mkMsg({ type: 'audio', text: 'note' }))).toBe(true);
        expect(isMessageEditable(mkMsg({ type: 'audio', text: '' }))).toBe(false);
    });

    it('isMessageEditable: structured types are not editable', () => {
        expect(isMessageEditable(mkMsg({ type: 'announcement' }))).toBe(false);
        expect(isMessageEditable(mkMsg({ type: 'poll' }))).toBe(false);
        expect(isMessageEditable(mkMsg({ type: 'coverage_request' }))).toBe(false);
        expect(isMessageEditable(mkMsg({ type: 'eighty_six_alert' }))).toBe(false);
        expect(isMessageEditable(mkMsg({ type: 'photo_issue' }))).toBe(false);
        expect(isMessageEditable(mkMsg({ type: 'task_handoff' }))).toBe(false);
        expect(isMessageEditable(mkMsg({ type: 'system' }))).toBe(false);
    });

    it('isMessageEditable: deleted messages cannot be edited', () => {
        expect(isMessageEditable(mkMsg({ deleted: true }))).toBe(false);
    });

    it('isWithinEditWindow: 1 min ago = yes, just over 15 min = no', () => {
        expect(isWithinEditWindow(mkMsg(), now)).toBe(true);
        const oneSecOver = mkMsg({
            createdAt: { toMillis: () => now - EDIT_WINDOW_MS - 1_000 },
        });
        expect(isWithinEditWindow(oneSecOver, now)).toBe(false);
    });

    it('isWithinEditWindow: missing createdAt → refuse (no provenance)', () => {
        expect(isWithinEditWindow({ id: 'x' }, now)).toBe(false);
        expect(isWithinEditWindow({ id: 'x', createdAt: null }, now)).toBe(false);
    });

    it('canEditMessage: author + editable type + within window → true', () => {
        expect(canEditMessage(mkMsg(), viewerCash, now)).toBe(true);
    });

    it('canEditMessage: NOT author → false even if otherwise editable', () => {
        expect(canEditMessage(mkMsg(), viewerMaria, now)).toBe(false);
    });

    it('canEditMessage: outside window → false', () => {
        const old = mkMsg({
            createdAt: { toMillis: () => now - EDIT_WINDOW_MS - 1_000 },
        });
        expect(canEditMessage(old, viewerCash, now)).toBe(false);
    });

    it('canEditMessage: non-editable type → false', () => {
        const ann = mkMsg({ type: 'announcement' });
        expect(canEditMessage(ann, viewerCash, now)).toBe(false);
    });
});
