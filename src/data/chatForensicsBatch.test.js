// Tests for the 2026-08-11 chat forensics batch (C2/C4/C8 pure logic).
// See CHAT-FORENSICS.md for the full audit + phase list.
import { describe, it, expect } from 'vitest';
import { parseChatDeepLink } from './chatDeepLink';
import { previewOf, isMessageEditable, MESSAGE_TYPES, dmDocId } from './chat';

describe('parseChatDeepLink (C4)', () => {
    it('splits a composite chat deep link', () => {
        expect(parseChatDeepLink('chat:abc123')).toEqual({ tab: 'chat', chatId: 'abc123' });
    });
    it('handles chat ids containing colons and underscores (DM doc ids)', () => {
        // Deterministic DM ids embed names: 'dm_Andrew Shih__Julie Shih'
        expect(parseChatDeepLink('chat:dm_Andrew Shih__Julie Shih'))
            .toEqual({ tab: 'chat', chatId: 'dm_Andrew Shih__Julie Shih' });
    });
    it('passes plain tabs through unchanged', () => {
        expect(parseChatDeepLink('chat')).toEqual({ tab: 'chat', chatId: null });
        expect(parseChatDeepLink('schedule')).toEqual({ tab: 'schedule', chatId: null });
    });
    it('treats an empty id as no id', () => {
        expect(parseChatDeepLink('chat:')).toEqual({ tab: 'chat', chatId: null });
        expect(parseChatDeepLink('chat:  ')).toEqual({ tab: 'chat', chatId: null });
    });
    it('tolerates junk input', () => {
        expect(parseChatDeepLink(null)).toEqual({ tab: '', chatId: null });
        expect(parseChatDeepLink(undefined)).toEqual({ tab: '', chatId: null });
    });
});

describe('file message type (C8)', () => {
    it('is a registered bubble type', () => {
        expect(MESSAGE_TYPES.file).toEqual({ renderer: 'bubble', priority: 'normal' });
    });
    it('previews with the filename', () => {
        expect(previewOf({ type: 'file', senderName: 'Andrew Shih', filename: 'menu.pdf' }))
            .toBe('Andrew: 📎 menu.pdf');
    });
    it('previews a nameless file with a generic label, bilingual', () => {
        expect(previewOf({ type: 'file', senderName: 'Andrew Shih' })).toBe('Andrew: 📎 File');
        expect(previewOf({ type: 'file', senderName: 'Andrew Shih' }, 'es')).toBe('Andrew: 📎 Archivo');
    });
    it('caption on a file message is editable; captionless is not', () => {
        const base = { type: 'file', filename: 'invoice.pdf', deleted: false };
        expect(isMessageEditable({ ...base, text: 'July invoice' })).toBe(true);
        expect(isMessageEditable({ ...base, text: '' })).toBe(false);
    });
});

describe('dmDocId honesty (C6)', () => {
    it('does NOT normalize case or inner whitespace (why findLiveDmId exists)', () => {
        // These SHOULD ideally match but never have — pinning the real
        // behavior so nobody "fixes" it and re-keys every existing DM.
        expect(dmDocId('Fui jun Mok', 'Enzo  Gilbonio'))
            .not.toBe(dmDocId('Fuijun Mok', 'Enzo Gilbonio'));
        expect(dmDocId('andrew shih', 'Julie Shih'))
            .not.toBe(dmDocId('Andrew Shih', 'Julie Shih'));
    });
    it('is order-independent and trims outer whitespace', () => {
        expect(dmDocId('Andrew Shih', 'Julie Shih')).toBe(dmDocId('Julie Shih', ' Andrew Shih '));
    });
});
