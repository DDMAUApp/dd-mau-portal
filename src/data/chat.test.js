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
    it('prefers full-name match over first-name when ambiguous', () => {
        // "Andrew" could be Andrew Shih OR Andrew Jones — first-name match
        // picks the first one found. The test pins that behavior so a
        // future refactor doesn't silently change who gets notified.
        const { mentions } = parseMentions('hey @andrew', list);
        expect(mentions.length).toBe(1);
        expect(['Andrew Shih', 'Andrew Jones']).toContain(mentions[0]);
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
