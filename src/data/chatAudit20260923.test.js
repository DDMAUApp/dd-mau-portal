// Tests for the 2026-09-23 chat-audit fixes (pure logic in chat.js):
//   C1 — canEditChat fails closed on a missing/unknown editTier; co-admin
//        edits merge onto the LIVE admins array (never a stale/empty copy)
//   M5 — chat-list preview follows a delete/edit of the previewed message
//   M6 — Leave is blocked where the add-only auto-audience sync re-adds
import { describe, it, expect } from 'vitest';
import {
    canEditChat,
    leaveBlockedByAutoAudience,
    mergeCoAdminEdits,
    isChatLastMessage,
    lastMessagePatchFor,
    previewOf,
    audienceMembersFor,
} from './chat';

const owner   = { id: 40, name: 'Andrew Shih', role: 'Owner' };
const manager = { id: 3,  name: 'Maria Lopez', role: 'FOH Manager', location: 'webster' };
const lineFoh = { id: 10, name: 'Cash Magruder', role: 'Server', location: 'webster', scheduleSide: 'foh' };
const lineBoh = { id: 11, name: 'Tom Lee', role: 'Line Cook', location: 'maryland', scheduleSide: 'boh' };

describe('canEditChat — fails closed without an editTier (C1)', () => {
    // Exactly the shape the chat-list warm cache stores for a group row:
    // no members, admins, editTier, createdBy, readOnly.
    const cachedGroupRow = { id: 'g1', type: 'group', name: 'FOH', _cached: true };

    it('a slim cached group row grants NO edit rights to staff or managers', () => {
        expect(canEditChat(cachedGroupRow, lineFoh, false)).toBe(false);
        expect(canEditChat(cachedGroupRow, manager, false)).toBe(false);
    });
    it('even the creator cannot edit a group whose editTier is missing', () => {
        const legacy = { type: 'group', createdBy: 'Cash Magruder', admins: ['Tom Lee'] };
        expect(canEditChat(legacy, lineFoh, false)).toBe(false);
        expect(canEditChat(legacy, lineBoh, false)).toBe(false);
    });
    it('an unknown editTier value fails closed too', () => {
        const odd = { type: 'group', createdBy: 'Cash Magruder', editTier: 'superuser' };
        expect(canEditChat(odd, lineFoh, false)).toBe(false);
        expect(canEditChat(odd, manager, false)).toBe(false);
    });
    it('app admins keep full access (unchanged admin behavior)', () => {
        expect(canEditChat(cachedGroupRow, owner, true)).toBe(true);
        expect(canEditChat({ type: 'group' }, owner, true)).toBe(true);
    });
    it('explicit tiers behave exactly as before', () => {
        const staffGroup = { type: 'group', createdBy: 'Cash Magruder', editTier: 'staff', admins: [] };
        expect(canEditChat(staffGroup, lineFoh, false)).toBe(true);    // creator
        expect(canEditChat(staffGroup, lineBoh, false)).toBe(false);   // not creator
        const mgrGroup = { type: 'group', createdBy: 'Maria Lopez', editTier: 'manager' };
        expect(canEditChat(mgrGroup, manager, false)).toBe(true);
        expect(canEditChat(mgrGroup, lineFoh, false)).toBe(false);
    });
    it('DMs stay uneditable for everyone', () => {
        expect(canEditChat({ type: 'dm', members: ['A', 'B'] }, owner, true)).toBe(false);
    });
});

describe('mergeCoAdminEdits (C1 — settings-modal Save)', () => {
    it('returns null when the user never toggled a co-admin (→ no admins write)', () => {
        expect(mergeCoAdminEdits({
            liveAdmins: ['A', 'B'], liveMembers: ['A', 'B', 'C'],
            baseline: ['A', 'B'], local: ['A', 'B'],
        })).toBeNull();
    });
    it('never wipes live admins the user did not touch (the admins: [] bug)', () => {
        // Modal opened on a partial object → baseline/local empty; the user
        // then promoted C. Live admins A and B must survive.
        expect(mergeCoAdminEdits({
            liveAdmins: ['A', 'B'], liveMembers: ['A', 'B', 'C'],
            baseline: [], local: ['C'],
        })).toEqual(['A', 'B', 'C']);
    });
    it('keeps a co-admin someone ELSE added while the modal was open', () => {
        expect(mergeCoAdminEdits({
            liveAdmins: ['A', 'X'], liveMembers: ['A', 'X', 'C'],
            baseline: ['A'], local: ['A', 'C'],
        })).toEqual(['A', 'X', 'C']);
    });
    it('applies an explicit removal', () => {
        expect(mergeCoAdminEdits({
            liveAdmins: ['A', 'B'], liveMembers: ['A', 'B'],
            baseline: ['A', 'B'], local: ['A'],
        })).toEqual(['A']);
    });
    it('can only reach [] when the user removed every co-admin themselves', () => {
        expect(mergeCoAdminEdits({
            liveAdmins: ['A'], liveMembers: ['A'],
            baseline: ['A'], local: [],
        })).toEqual([]);
    });
    it('does not add a co-admin who is no longer a member', () => {
        expect(mergeCoAdminEdits({
            liveAdmins: [], liveMembers: ['A'],
            baseline: [], local: ['Gone'],
        })).toEqual([]);
    });
    it('tolerates missing live arrays without throwing', () => {
        expect(mergeCoAdminEdits({ liveAdmins: undefined, liveMembers: undefined, baseline: [], local: ['A'] }))
            .toEqual(['A']);
    });
    it('does not duplicate names', () => {
        expect(mergeCoAdminEdits({
            liveAdmins: ['A'], liveMembers: ['A', 'B'],
            baseline: [], local: ['A', 'B'],
        })).toEqual(['A', 'B']);
    });
});

describe('leaveBlockedByAutoAudience (M6)', () => {
    const fohWebsterGroup = { type: 'group', autoAudience: 'foh-webster', members: [] };
    it('blocks a viewer the sync would re-add', () => {
        expect(leaveBlockedByAutoAudience(fohWebsterGroup, lineFoh)).toBe(true);
        // same predicate the sync itself uses
        expect(audienceMembersFor('foh-webster', [lineFoh])).toEqual(['Cash Magruder']);
    });
    it('allows a viewer who does not match the audience', () => {
        expect(leaveBlockedByAutoAudience(fohWebsterGroup, lineBoh)).toBe(false);
    });
    it('allows leaving when auto-add is off / unknown / not a group / deleted', () => {
        expect(leaveBlockedByAutoAudience({ type: 'group' }, lineFoh)).toBe(false);
        expect(leaveBlockedByAutoAudience({ type: 'group', autoAudience: '' }, lineFoh)).toBe(false);
        expect(leaveBlockedByAutoAudience({ type: 'group', autoAudience: 'bogus' }, lineFoh)).toBe(false);
        expect(leaveBlockedByAutoAudience({ type: 'channel', autoAudience: 'foh' }, lineFoh)).toBe(false);
        expect(leaveBlockedByAutoAudience({ ...fohWebsterGroup, deletedAt: { seconds: 1 } }, lineFoh)).toBe(false);
    });
    it("'all' audience blocks everyone", () => {
        expect(leaveBlockedByAutoAudience({ type: 'group', autoAudience: 'all' }, lineBoh)).toBe(true);
    });
    it('no viewer record → not blocked (never strands the button)', () => {
        expect(leaveBlockedByAutoAudience(fohWebsterGroup, null)).toBe(false);
        expect(leaveBlockedByAutoAudience(fohWebsterGroup, {})).toBe(false);
    });
});

describe('chat-list preview follows delete/edit of the newest message (M5)', () => {
    const chat = { lastMessage: { text: 'see you at 5', sender: 'Cash Magruder', type: 'text', ts: { seconds: 100 } } };
    const newest = { id: 'm9', senderName: 'Cash Magruder', type: 'text', text: 'see you at 5' };

    it('matches the newest loaded message from the same sender', () => {
        expect(isChatLastMessage(chat, newest, 'm9')).toBe(true);
    });
    it('does not match an older message', () => {
        expect(isChatLastMessage(chat, { ...newest, id: 'm3' }, 'm9')).toBe(false);
    });
    it('does not match when the preview was written by someone else', () => {
        expect(isChatLastMessage(chat, { ...newest, senderName: 'Tom Lee' }, 'm9')).toBe(false);
    });
    it('an explicit lastMessage.id wins over the heuristic', () => {
        const withId = { lastMessage: { ...chat.lastMessage, id: 'm7' } };
        expect(isChatLastMessage(withId, { ...newest, id: 'm7' }, 'm9')).toBe(true);
        expect(isChatLastMessage(withId, newest, 'm9')).toBe(false);
    });
    it('no preview / no message → false', () => {
        expect(isChatLastMessage({}, newest, 'm9')).toBe(false);
        expect(isChatLastMessage(chat, null, 'm9')).toBe(false);
        expect(isChatLastMessage(chat, newest, undefined)).toBe(false);
    });
    it('delete patch blanks the text + flags deleted with fixed dotted paths', () => {
        expect(lastMessagePatchFor('delete', newest)).toEqual({ 'lastMessage.text': '', 'lastMessage.deleted': true });
    });
    it('edit patch carries the new text (capped at 200) for text messages only', () => {
        expect(lastMessagePatchFor('edit', newest, 'see you at 6')).toEqual({ 'lastMessage.text': 'see you at 6' });
        expect(lastMessagePatchFor('edit', newest, 'x'.repeat(300))['lastMessage.text']).toHaveLength(200);
        // media previews show the type, not the caption → leave them alone
        expect(lastMessagePatchFor('edit', { ...newest, type: 'image' }, 'new caption')).toBeNull();
        expect(lastMessagePatchFor('nope', newest)).toBeNull();
    });
    it('previewOf renders the patched (deleted) preview in both languages', () => {
        const patched = { ...chat.lastMessage, text: '', deleted: true };
        expect(previewOf(patched, 'en')).toBe('(deleted)');
        expect(previewOf(patched, 'es')).toBe('(eliminado)');
    });
});
