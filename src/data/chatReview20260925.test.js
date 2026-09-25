// 2026-09-25 chat review — chat.js pure logic:
//   #8 previewOf reads the STORED chat.lastMessage shape (sender + baked text)
//   #7 previewShowsMessage — strict id / ts match for the delete/edit patch
import { describe, it, expect } from 'vitest';
import { previewOf, previewShowsMessage } from './chat';

const ts = (seconds) => ({ seconds, nanoseconds: 0, toMillis() { return seconds * 1000; } });

describe('previewOf — stored lastMessage shape (#8)', () => {
    // Exactly what onChatMessageCreated writes: {text, sender, ts, type, id}.
    const lm = (type, text, extra = {}) => ({ type, text, sender: 'Cash Magruder', ts: ts(1), id: 'm1', ...extra });

    it('86 previews keep the item name (was always "🚫 86: item")', () => {
        expect(previewOf(lm('eighty_six_alert', '🚫 86: Chicken Wings'))).toBe('Cash: 🚫 86: Chicken Wings');
        expect(previewOf(lm('eighty_six_alert', '✅ Back in stock: Chicken Wings'))).toBe('Cash: ✅ Back in stock: Chicken Wings');
    });
    it('poll previews keep the question', () => {
        expect(previewOf(lm('poll', '📊 Staff meal Friday?'))).toBe('Cash: 📊 Staff meal Friday?');
    });
    it('file previews keep the filename', () => {
        expect(previewOf(lm('file', '📎 menu.pdf'))).toBe('Cash: 📎 menu.pdf');
    });
    it('reads `sender` (stored previews have no senderName)', () => {
        expect(previewOf(lm('text', 'see you at 5'))).toBe('Cash: see you at 5');
    });
    it('media previews stay localized by type', () => {
        expect(previewOf(lm('image', '📷 Photo'), 'es')).toBe('Cash: 📷 Foto');
    });
    it('long stored text is clipped like any preview', () => {
        const p = previewOf(lm('poll', '📊 ' + 'q'.repeat(200)));
        expect(p.endsWith('…')).toBe(true);
        expect(p.length).toBeLessThan(80);
    });
    it('empty stored text falls back to the generic label', () => {
        expect(previewOf(lm('poll', ''))).toBe('Cash: 📊 Poll');
        expect(previewOf(lm('file', ''), 'es')).toBe('Cash: 📎 Archivo');
        expect(previewOf(lm('eighty_six_alert', ''))).toBe('Cash: 🚫 86: item');
    });
});

describe('previewOf — message objects keep the structured, localized form', () => {
    it('86 message with eightySixData renders from the data (localized)', () => {
        const m = { senderName: 'Tom Lee', type: 'eighty_six_alert', text: '✅ Back in stock: Pho', eightySixData: { transition: 'in', itemName: 'Pho' } };
        expect(previewOf(m, 'es')).toBe('Tom: ✅ De vuelta en stock: Pho');
    });
    it('poll + file messages use their structured fields', () => {
        expect(previewOf({ senderName: 'Tom Lee', type: 'poll', text: '📊 Q?', poll: { question: 'Lunch?' } })).toBe('Tom: 📊 Lunch?');
        expect(previewOf({ senderName: 'Tom Lee', type: 'file', text: 'caption', filename: 'a.pdf' })).toBe('Tom: 📎 a.pdf');
    });
    it('a file message with only a caption still reads as a file', () => {
        expect(previewOf({ senderName: 'Tom Lee', type: 'file', text: 'invoice' })).toBe('Tom: 📎 invoice');
    });
});

describe('previewShowsMessage — strict delete/edit patch match (#7)', () => {
    const msg = { id: 'm9', senderName: 'Cash Magruder', createdAt: ts(500) };

    it('lastMessage.id decides when present', () => {
        expect(previewShowsMessage({ lastMessage: { id: 'm9', ts: ts(1) } }, msg)).toBe(true);
        expect(previewShowsMessage({ lastMessage: { id: 'm10', ts: ts(500), sender: 'Cash Magruder' } }, msg)).toBe(false);
    });
    it('without an id: lastMessage.ts must equal the message createdAt (same sender)', () => {
        expect(previewShowsMessage({ lastMessage: { ts: ts(500), sender: 'Cash Magruder' } }, msg)).toBe(true);
        expect(previewShowsMessage({ lastMessage: { ts: { seconds: 500 }, sender: 'Cash Magruder' } }, msg)).toBe(true);
        expect(previewShowsMessage({ lastMessage: { ts: ts(501), sender: 'Cash Magruder' } }, msg)).toBe(false);
        expect(previewShowsMessage({ lastMessage: { ts: ts(500), sender: 'Tom Lee' } }, msg)).toBe(false);
    });
    it('a NEWER message took over the preview → skip (the bug: it was blanked)', () => {
        const newer = { lastMessage: { ts: ts(600), sender: 'Tom Lee', text: 'newer' } };
        expect(previewShowsMessage(newer, msg)).toBe(false);
    });
    it('pending message (no createdAt), no preview, or junk → false', () => {
        expect(previewShowsMessage({ lastMessage: { ts: ts(500) } }, { ...msg, createdAt: null })).toBe(false);
        expect(previewShowsMessage({}, msg)).toBe(false);
        expect(previewShowsMessage(null, msg)).toBe(false);
        expect(previewShowsMessage({ lastMessage: { id: 'm9' } }, null)).toBe(false);
    });
});

import { previewOf as _previewOfVA } from './chat';
describe('chat-list preview prefix is viewer-aware', () => {
    const lm = { type: 'text', text: 'Running late', sender: 'Maria Lopez' };
    it('groups: sender first name; your own: You; DMs: no prefix', () => {
        expect(_previewOfVA(lm, 'en', { viewerName: 'Andrew Shih' })).toBe('Maria: Running late');
        expect(_previewOfVA({ ...lm, sender: 'Andrew Shih' }, 'en', { viewerName: 'Andrew Shih' })).toBe('You: Running late');
        expect(_previewOfVA({ ...lm, sender: 'Andrew Shih' }, 'es', { viewerName: 'Andrew Shih' })).toBe('Tú: Running late');
        expect(_previewOfVA(lm, 'en', { viewerName: 'Andrew Shih', isDm: true })).toBe('Running late');
    });
});
