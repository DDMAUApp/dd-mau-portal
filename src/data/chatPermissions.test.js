// Tests for the chat-feature capability engine.
//
// Pins the role + flag matrix so a future refactor can't silently
// grant staff the ability to post announcements or delete other
// people's messages.

import { describe, it, expect } from 'vitest';
import {
    canPostInChat,
    canPostAnnouncements,
    canRequireAck,
    canPinMessages,
    canConvertToTask,
    canViewAuditLog,
    canDeleteAnyMessage,
    canDeleteOwnMessage,
    canDeleteChat,
    canPostCoverageRequest,
    canClaimCoverage,
    canApproveCoverage,
    tierLabel,
} from './chatPermissions';
import { channelMembersFor } from './chat';

const owner    = { id: 40, name: 'Andrew Shih',  role: 'Owner' };
const manager  = { id: 7,  name: 'Maria Lopez',  role: 'Manager', location: 'webster' };
const kmanager = { id: 8,  name: 'Sam Cook',     role: 'Kitchen Manager', location: 'maryland' };
const lead     = { id: 9,  name: 'Lee Lead',     role: 'FOH', isShiftLead: true };
const lineFoh  = { id: 1,  name: 'Cash Magruder',role: 'FOH', location: 'webster' };
const lineBoh  = { id: 2,  name: 'Tom Lee',      role: 'BOH', location: 'webster' };
const optStaff = { id: 3,  name: 'Sara Opt',     role: 'FOH', canPostAnnouncements: true };

describe('canPostAnnouncements', () => {
    it('admin yes', () => expect(canPostAnnouncements(owner, true, true)).toBe(true));
    it('manager yes', () => expect(canPostAnnouncements(manager, false, true)).toBe(true));
    it('staff no', () => expect(canPostAnnouncements(lineFoh, false, false)).toBe(false));
    it('shift lead no by default', () => expect(canPostAnnouncements(lead, false, false)).toBe(false));
    it('staff with explicit flag yes', () => expect(canPostAnnouncements(optStaff, false, false)).toBe(true));
});

describe('canPostInChat — announcement channel locks out non-managers', () => {
    const annChat = {
        kind: 'announcement',
        channelKey: 'announcements',
        members: ['Andrew Shih', 'Maria Lopez', 'Cash Magruder'],
    };
    it('admin can post', () => expect(canPostInChat(annChat, owner, true, true)).toBe(true));
    it('manager can post', () => expect(canPostInChat(annChat, manager, false, true)).toBe(true));
    it('staff cannot post', () => expect(canPostInChat(annChat, lineFoh, false, false)).toBe(false));
});

describe('canPostInChat — non-announcement channels', () => {
    const chat = { type: 'channel', kind: 'system_role', members: ['Cash Magruder'] };
    it('member can post', () => expect(canPostInChat(chat, lineFoh, false, false)).toBe(true));
    it('non-member cannot post', () => {
        const stranger = { name: 'Stranger' };
        expect(canPostInChat(chat, stranger, false, false)).toBe(false);
    });
});

describe('canPinMessages', () => {
    it('no pins in DMs even for admin', () => {
        const dm = { type: 'dm' };
        expect(canPinMessages(dm, owner, true, true)).toBe(false);
    });
    it('admin can pin channels', () => {
        const ch = { type: 'channel', channelKey: 'all' };
        expect(canPinMessages(ch, owner, true, true)).toBe(true);
    });
    it('staff cannot pin channels by default', () => {
        const ch = { type: 'channel', channelKey: 'all' };
        expect(canPinMessages(ch, lineFoh, false, false)).toBe(false);
    });
    it('shift lead can pin channels', () => {
        const ch = { type: 'channel', channelKey: 'all' };
        expect(canPinMessages(ch, lead, false, false)).toBe(true);
    });
});

describe('canDeleteAnyMessage — location scoping', () => {
    it('admin can delete anywhere', () => {
        const ch = { channelKey: 'maryland' };
        expect(canDeleteAnyMessage(ch, owner, true, true)).toBe(true);
    });
    it('webster manager cannot moderate #maryland channel', () => {
        const ch = { channelKey: 'maryland' };
        const websterMgr = { ...manager, location: 'webster' };
        expect(canDeleteAnyMessage(ch, websterMgr, false, true)).toBe(false);
    });
    it('maryland manager can moderate #maryland channel', () => {
        const ch = { channelKey: 'maryland' };
        expect(canDeleteAnyMessage(ch, kmanager, false, true)).toBe(true);
    });
    it('staff cannot delete others', () => {
        const ch = { channelKey: 'all' };
        expect(canDeleteAnyMessage(ch, lineFoh, false, false)).toBe(false);
    });
});

describe('canDeleteOwnMessage', () => {
    it('sender can delete own', () => {
        const msg = { senderName: 'Cash Magruder' };
        expect(canDeleteOwnMessage(msg, lineFoh)).toBe(true);
    });
    it('non-sender cannot', () => {
        const msg = { senderName: 'Cash Magruder' };
        expect(canDeleteOwnMessage(msg, lineBoh)).toBe(false);
    });
});

describe('canClaimCoverage', () => {
    it('open + not own = yes', () => {
        const req = { coverageStatus: 'open', requesterId: 'Maria Lopez' };
        expect(canClaimCoverage(req, lineFoh)).toBe(true);
    });
    it('own request = no', () => {
        const req = { coverageStatus: 'open', requesterId: 'Cash Magruder' };
        expect(canClaimCoverage(req, lineFoh)).toBe(false);
    });
    it('already claimed = no', () => {
        const req = { coverageStatus: 'claimed', requesterId: 'Maria Lopez' };
        expect(canClaimCoverage(req, lineFoh)).toBe(false);
    });
});

describe('canApproveCoverage', () => {
    it('manager yes', () => expect(canApproveCoverage(manager, false, true)).toBe(true));
    it('admin yes', () => expect(canApproveCoverage(owner, true, true)).toBe(true));
    it('staff no', () => expect(canApproveCoverage(lineFoh, false, false)).toBe(false));
});

describe('channelMembersFor — new rules', () => {
    const list = [owner, manager, kmanager, lead, lineFoh, lineBoh];
    it('managers includes owners + managers + kitchen managers', () => {
        const m = channelMembersFor('managers', list);
        expect(m).toContain('Andrew Shih');
        expect(m).toContain('Maria Lopez');
        expect(m).toContain('Sam Cook');
        expect(m).not.toContain('Cash Magruder');
        expect(m).not.toContain('Lee Lead');
    });
    it('webster channel includes webster staff', () => {
        const m = channelMembersFor('webster', list);
        expect(m).toContain('Maria Lopez');  // location: webster
        expect(m).toContain('Cash Magruder'); // location: webster
        expect(m).not.toContain('Sam Cook');  // location: maryland
    });
    it('maryland channel includes maryland staff', () => {
        const m = channelMembersFor('maryland', list);
        expect(m).toContain('Sam Cook');
        expect(m).not.toContain('Cash Magruder');
    });
    it('announcements channel = everyone (broadcast)', () => {
        const m = channelMembersFor('announcements', list);
        expect(m.length).toBe(list.length);
    });
});

describe('tierLabel', () => {
    it('admin > manager > shift-lead > staff', () => {
        expect(tierLabel(owner, true, true)).toBe('Admin');
        expect(tierLabel(manager, false, true)).toBe('Manager');
        expect(tierLabel(lead, false, false)).toBe('Shift Lead');
        expect(tierLabel(lineFoh, false, false)).toBe('Staff');
    });
});

describe('canConvertToTask', () => {
    it('manager yes', () => expect(canConvertToTask(manager, false, true)).toBe(true));
    it('shift lead yes', () => expect(canConvertToTask(lead, false, false)).toBe(true));
    it('line staff no', () => expect(canConvertToTask(lineFoh, false, false)).toBe(false));
});

describe('canViewAuditLog', () => {
    it('admin yes', () => expect(canViewAuditLog(owner, true)).toBe(true));
    it('non-admin without flag no', () => expect(canViewAuditLog(manager, false)).toBe(false));
    it('flag override yes', () => expect(canViewAuditLog({ canViewAuditLog: true }, false)).toBe(true));
});

describe('canPostCoverageRequest', () => {
    it('anyone with a name can request', () => {
        expect(canPostCoverageRequest(lineFoh)).toBe(true);
        expect(canPostCoverageRequest(null)).toBe(false);
    });
});

describe('canDeleteChat', () => {
    it('admin can delete any chat type', () => {
        expect(canDeleteChat({ type: 'dm', members: ['a', 'b'] }, owner, true)).toBe(true);
        expect(canDeleteChat({ type: 'group', createdBy: 'someone-else' }, owner, true)).toBe(true);
        expect(canDeleteChat({ type: 'channel', channelKey: 'all' }, owner, true)).toBe(true);
    });
    it('non-admin cannot delete channels', () => {
        expect(canDeleteChat({ type: 'channel', channelKey: 'all' }, manager, false)).toBe(false);
    });
    it('DM participant can delete the DM', () => {
        const dm = { type: 'dm', members: ['Cash Magruder', 'Maria Lopez'] };
        expect(canDeleteChat(dm, lineFoh, false)).toBe(true);
        expect(canDeleteChat(dm, manager, false)).toBe(true);
    });
    it('non-participant cannot delete a DM', () => {
        const dm = { type: 'dm', members: ['Cash Magruder', 'Maria Lopez'] };
        expect(canDeleteChat(dm, lineBoh, false)).toBe(false);
    });
    it('group creator can delete their group', () => {
        const group = { type: 'group', createdBy: 'Cash Magruder', members: ['Cash Magruder', 'Tom Lee'] };
        expect(canDeleteChat(group, lineFoh, false)).toBe(true);
    });
    it('group member who is not creator cannot delete', () => {
        const group = { type: 'group', createdBy: 'Cash Magruder', members: ['Cash Magruder', 'Tom Lee'] };
        expect(canDeleteChat(group, lineBoh, false)).toBe(false);
    });
    it('group co-admin can delete', () => {
        const group = { type: 'group', createdBy: 'Cash Magruder', admins: ['Tom Lee'], members: ['Cash Magruder', 'Tom Lee'] };
        expect(canDeleteChat(group, lineBoh, false)).toBe(true);
    });
});

describe('canRequireAck — tied to announcements', () => {
    it('mirrors canPostAnnouncements', () => {
        expect(canRequireAck(manager, false, true)).toBe(true);
        expect(canRequireAck(lineFoh, false, false)).toBe(false);
    });
});
