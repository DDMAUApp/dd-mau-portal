// Tests for the chat translation helpers.
//
// We can't easily test the live Cloud Function call (it requires
// Firebase Functions emulator + a billing-enabled GCP project). What
// we CAN pin:
//   • The pure helpers (shouldOfferTranslation, readCachedTranslation,
//     detectLanguageHint).
//   • The in-memory cache + subscription bus.
//
// The translateMessage() function is exercised via a mock of
// `firebase/functions` httpsCallable so we can verify it dedups
// concurrent calls and writes to the cache + notifies subscribers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock firebase/functions BEFORE the module under test loads it.
vi.mock('firebase/functions', () => {
    const mockCall = vi.fn();
    return {
        httpsCallable: () => mockCall,
        __mockCall: mockCall,
    };
});
vi.mock('../firebase', () => ({ functions: {} }));

import {
    readCachedTranslation,
    shouldOfferTranslation,
    detectLanguageHint,
    subscribeTranslation,
    translateMessage,
    _resetTranslationCacheForTest,
} from './translation';
import * as functionsMock from 'firebase/functions';

beforeEach(() => {
    _resetTranslationCacheForTest();
    functionsMock.__mockCall.mockReset();
});

describe('readCachedTranslation', () => {
    it('returns the stored translation for a target lang', () => {
        const m = { translations: { en: 'Hello', es: 'Hola' } };
        expect(readCachedTranslation(m, 'en')).toBe('Hello');
        expect(readCachedTranslation(m, 'es')).toBe('Hola');
    });
    it('case-insensitive on the target lang', () => {
        const m = { translations: { es: 'Hola' } };
        expect(readCachedTranslation(m, 'ES')).toBe('Hola');
    });
    it('returns null when no cache exists', () => {
        expect(readCachedTranslation({}, 'es')).toBeNull();
        expect(readCachedTranslation(null, 'es')).toBeNull();
        expect(readCachedTranslation({ translations: {} }, 'es')).toBeNull();
    });
});

describe('shouldOfferTranslation', () => {
    const me = 'Andrew Shih';
    it('hides on own messages', () => {
        expect(shouldOfferTranslation({ senderName: me, text: 'hi' }, me, 'es')).toBe(false);
    });
    it('hides on empty text', () => {
        expect(shouldOfferTranslation({ senderName: 'Maria', text: '' }, me, 'es')).toBe(false);
    });
    it('hides on system events', () => {
        expect(shouldOfferTranslation({ senderName: 'sys', type: 'system', text: 'joined' }, me, 'es')).toBe(false);
        expect(shouldOfferTranslation({ senderName: 'sys', type: 'system_event', text: 'joined' }, me, 'es')).toBe(false);
    });
    it('hides on 86 alerts (emoji noise)', () => {
        expect(shouldOfferTranslation({ senderName: 'sys', type: 'eighty_six_alert', text: 'item out' }, me, 'es')).toBe(false);
    });
    it('hides when sourceLang already matches target', () => {
        const msg = { senderName: 'Maria', text: 'Hola', sourceLang: 'es' };
        expect(shouldOfferTranslation(msg, me, 'es')).toBe(false);
    });
    it('shows otherwise', () => {
        const msg = { senderName: 'Maria', type: 'text', text: 'Hola equipo' };
        expect(shouldOfferTranslation(msg, me, 'es')).toBe(true);
    });
    it('shows on announcements + coverage + photo issues', () => {
        for (const type of ['announcement', 'coverage_request', 'photo_issue', 'task_handoff', 'text', 'image']) {
            const msg = { senderName: 'Maria', type, text: 'Hola' };
            expect(shouldOfferTranslation(msg, me, 'es')).toBe(true);
        }
    });
});

describe('detectLanguageHint', () => {
    it('detects Spanish from ñ + accented chars', () => {
        expect(detectLanguageHint('mañana viene Andrés')).toBe('es');
        expect(detectLanguageHint('¿Estás bien?')).toBe('es');
        expect(detectLanguageHint('¡Hola!')).toBe('es');
    });
    it('detects Spanish from stop words', () => {
        expect(detectLanguageHint('el horno no funciona en la cocina')).toBe('es');
    });
    it('detects English from stop words', () => {
        expect(detectLanguageHint('the oven is broken in the kitchen')).toBe('en');
    });
    it('returns null on ambiguous text', () => {
        expect(detectLanguageHint('ok')).toBeNull();
        expect(detectLanguageHint('')).toBeNull();
        expect(detectLanguageHint(null)).toBeNull();
    });
});

describe('translateMessage — dedup + cache + subscribers', () => {
    it('returns the translatedText from the callable', async () => {
        functionsMock.__mockCall.mockResolvedValueOnce({
            data: { translatedText: 'Hello team', sourceLang: 'es' },
        });
        const res = await translateMessage({
            chatId: 'c1', messageId: 'm1', targetLang: 'en', text: 'Hola equipo',
        });
        expect(res.translatedText).toBe('Hello team');
        expect(res.sourceLang).toBe('es');
    });

    it('coalesces concurrent calls for the same key', async () => {
        let resolveCall;
        functionsMock.__mockCall.mockImplementation(() => new Promise(r => { resolveCall = r; }));
        const p1 = translateMessage({ chatId: 'c1', messageId: 'm1', targetLang: 'en', text: 'Hola' });
        const p2 = translateMessage({ chatId: 'c1', messageId: 'm1', targetLang: 'en', text: 'Hola' });
        // Same in-flight promise.
        expect(p1).toBe(p2);
        resolveCall({ data: { translatedText: 'Hi' } });
        const out = await p1;
        expect(out.translatedText).toBe('Hi');
        // Only one underlying call.
        expect(functionsMock.__mockCall).toHaveBeenCalledTimes(1);
    });

    it('serves the second call from cache (no second API hit)', async () => {
        functionsMock.__mockCall.mockResolvedValueOnce({
            data: { translatedText: 'Hello' },
        });
        await translateMessage({ chatId: 'c1', messageId: 'm1', targetLang: 'en', text: 'Hola' });
        await translateMessage({ chatId: 'c1', messageId: 'm1', targetLang: 'en', text: 'Hola' });
        expect(functionsMock.__mockCall).toHaveBeenCalledTimes(1);
    });

    it('notifies subscribers when the translation lands', async () => {
        functionsMock.__mockCall.mockResolvedValueOnce({
            data: { translatedText: 'Hello' },
        });
        const received = [];
        const unsub = subscribeTranslation('c1', 'm1', 'en', (v) => received.push(v));
        await translateMessage({ chatId: 'c1', messageId: 'm1', targetLang: 'en', text: 'Hola' });
        expect(received).toContain('Hello');
        unsub();
    });

    it('subscribe immediately replays an existing cache hit', async () => {
        functionsMock.__mockCall.mockResolvedValueOnce({
            data: { translatedText: 'Hello' },
        });
        await translateMessage({ chatId: 'c1', messageId: 'm1', targetLang: 'en', text: 'Hola' });
        const received = [];
        const unsub = subscribeTranslation('c1', 'm1', 'en', (v) => received.push(v));
        expect(received).toEqual(['Hello']);
        unsub();
    });

    it('throws if targetLang missing', async () => {
        await expect(
            translateMessage({ chatId: 'c1', messageId: 'm1' })
        ).rejects.toThrow(/targetLang/);
    });
});
