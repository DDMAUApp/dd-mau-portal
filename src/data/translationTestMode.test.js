// Test mode: chat translation is sent text-only (2026-11-03 review). With
// {chatId, messageId} the translateMessage Cloud Function writes the result
// back onto the real production message doc.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCall = vi.fn(async () => ({ data: { translatedText: 'Hola', sourceLang: 'en' } }));
vi.mock('firebase/functions', () => ({ httpsCallable: () => mockCall }));
vi.mock('../firebase', () => ({ functions: {} }));

async function load(testMode) {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    if (testMode) {
        localStorage.setItem('ddmau:testMode', JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1' }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 't1');
    }
    return import('./translation');
}

beforeEach(() => mockCall.mockClear());

describe('translateMessage payload', () => {
    it('normal app sends the message coordinates (server caches the translation)', async () => {
        const { translateMessage } = await load(false);
        await translateMessage({ chatId: 'c1', messageId: 'm1', text: 'Hello', targetLang: 'es' });
        expect(mockCall).toHaveBeenCalledWith({ targetLang: 'es', chatId: 'c1', messageId: 'm1', text: 'Hello' });
    });

    it('test mode sends only the text, so the server writes nothing', async () => {
        const { translateMessage } = await load(true);
        const res = await translateMessage({ chatId: 'c1', messageId: 'm1', text: 'Hello', targetLang: 'es' });
        expect(res.translatedText).toBe('Hola');
        expect(mockCall).toHaveBeenCalledWith({ targetLang: 'es', text: 'Hello' });
    });

    it('test mode refuses a coordinates-only call rather than letting the server write', async () => {
        const { translateMessage } = await load(true);
        await expect(translateMessage({ chatId: 'c1', messageId: 'm1', targetLang: 'es' })).rejects.toThrow(/test mode/i);
        expect(mockCall).not.toHaveBeenCalled();
    });
});
