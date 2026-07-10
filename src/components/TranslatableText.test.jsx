// Chat web links must be clickable on native (App Store app) — Andrew
// 2026-06-20: "posting a web page still doesn't let you click it." The link
// must open EXPLICITLY via openExternalUrl (in-app browser on native), not
// rely on target="_blank" (a no-op in WKWebView).

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openSpy, txMocks } = vi.hoisted(() => ({
    openSpy: vi.fn(),
    // Keep firebase + the Cloud Function client out of the test —
    // configurable per-test so the component behavior tests below can
    // simulate translations landing.
    txMocks: {
        translateMessage: vi.fn(),
        readCachedTranslation: vi.fn(),
        shouldOfferTranslation: vi.fn(),
        subscribeTranslation: vi.fn(),
        detectLanguageHint: vi.fn(),
    },
}));
vi.mock('../capacitor-bridge', () => ({ openExternalUrl: openSpy }));
vi.mock('../data/translation', () => txMocks);

import TranslatableText, { renderWithMentions } from './TranslatableText';

beforeEach(() => {
    txMocks.translateMessage.mockReset().mockResolvedValue({ translatedText: '', sourceLang: null });
    txMocks.readCachedTranslation.mockReset().mockReturnValue(null);
    txMocks.shouldOfferTranslation.mockReset().mockReturnValue(false);
    txMocks.subscribeTranslation.mockReset().mockReturnValue(() => {});
    txMocks.detectLanguageHint.mockReset().mockReturnValue(null);
});
afterEach(() => { cleanup(); openSpy.mockClear(); });

describe('chat link rendering', () => {
    it('renders an http(s) URL as a link that opens via openExternalUrl', () => {
        render(<div>{renderWithMentions('see https://example.com/page now', false)}</div>);
        const link = screen.getByText('https://example.com/page');
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe('https://example.com/page');
        // No target="_blank" — it no-ops in the native WebView and would also
        // double-open via the global a[target=_blank] interceptor.
        expect(link.getAttribute('target')).toBeNull();
        fireEvent.click(link);
        expect(openSpy).toHaveBeenCalledWith('https://example.com/page');
    });

    it('linkifies a www. URL with an https:// href', () => {
        render(<div>{renderWithMentions('visit www.ddmau.com today', false)}</div>);
        const link = screen.getByText('www.ddmau.com');
        expect(link.getAttribute('href')).toBe('https://www.ddmau.com');
        fireEvent.click(link);
        expect(openSpy).toHaveBeenCalledWith('https://www.ddmau.com');
    });

    it('leaves plain text without a link', () => {
        render(<div data-testid="wrap">{renderWithMentions('no links here at all', false)}</div>);
        expect(screen.getByTestId('wrap').querySelector('a')).toBeNull();
    });
});

// ── Translate chip behavior ──────────────────────────────────────────
// Pins the 2026-07-10 fixes: auto-translate must DISPLAY the translation
// (not just prefetch it — the ChatNotifSettings copy promises "show every
// foreign-language message translated"), and an edit must reset the
// bubble so it can't keep showing the pre-edit translation.
describe('TranslatableText chip', () => {
    const msg = { id: 'm1', senderName: 'Maria', type: 'text', text: 'Hola equipo' };
    const baseProps = {
        targetLang: 'en', staffName: 'Andrew Shih', chatId: 'c1',
        isMine: false, isEs: false, blockMode: false,
    };

    it('manual tap fetches and shows the translation', async () => {
        txMocks.shouldOfferTranslation.mockReturnValue(true);
        txMocks.translateMessage.mockResolvedValue({ translatedText: 'Hello team', sourceLang: 'es' });
        render(<TranslatableText message={msg} autoTranslate={false} {...baseProps} />);
        expect(screen.getByText('Hola equipo')).toBeTruthy();
        fireEvent.click(screen.getByText('Translate'));
        await screen.findByText('Hello team');
        expect(screen.getByText('Translated · Show original')).toBeTruthy();
        expect(screen.queryByText('Hola equipo')).toBeNull();
    });

    it('auto-translate displays the translation without a tap', async () => {
        txMocks.shouldOfferTranslation.mockReturnValue(true);
        txMocks.detectLanguageHint.mockReturnValue('es'); // foreign vs target 'en'
        txMocks.translateMessage.mockResolvedValue({ translatedText: 'Hello team', sourceLang: 'es' });
        render(<TranslatableText message={msg} autoTranslate={true} {...baseProps} />);
        await screen.findByText('Hello team');
        expect(screen.queryByText('Hola equipo')).toBeNull();
    });

    it('"Show original" sticks even with auto-translate on', async () => {
        txMocks.shouldOfferTranslation.mockReturnValue(true);
        txMocks.detectLanguageHint.mockReturnValue('es');
        txMocks.translateMessage.mockResolvedValue({ translatedText: 'Hello team', sourceLang: 'es' });
        render(<TranslatableText message={msg} autoTranslate={true} {...baseProps} />);
        await screen.findByText('Hello team');
        fireEvent.click(screen.getByText('Translated · Show original'));
        await screen.findByText('Hola equipo');
        expect(screen.queryByText('Hello team')).toBeNull();
    });

    it('an edit resets the bubble to the new original text', async () => {
        txMocks.shouldOfferTranslation.mockReturnValue(true);
        txMocks.translateMessage.mockResolvedValue({ translatedText: 'Hello team', sourceLang: 'es' });
        const { rerender } = render(<TranslatableText message={msg} autoTranslate={false} {...baseProps} />);
        fireEvent.click(screen.getByText('Translate'));
        await screen.findByText('Hello team');
        const edited = { ...msg, text: 'Hola equipo — a las 5', edited: true };
        rerender(<TranslatableText message={edited} autoTranslate={false} {...baseProps} />);
        await screen.findByText('Hola equipo — a las 5');
        expect(screen.queryByText('Hello team')).toBeNull();
        // Chip is back to a fresh "Translate" for the new text.
        expect(screen.getByText('Translate')).toBeTruthy();
    });

    // ── Bidirectional chip (Andrew 2026-07-10: "the translate need to
    // also translate in spanish") — a message already in the viewer's
    // language offers the OTHER language instead of an inert pill.
    it('source == target flips the chip to "Translate to Spanish" and it works', async () => {
        const msgEn = { id: 'm2', senderName: 'Maria', type: 'text', text: 'The oven is broken' };
        txMocks.shouldOfferTranslation.mockImplementation((m, n, lang) => String(lang).startsWith('en'));
        txMocks.translateMessage.mockImplementation(({ targetLang }) => Promise.resolve(
            targetLang === 'es'
                ? { translatedText: 'El horno está roto', sourceLang: 'en' }
                : { translatedText: 'The oven is broken', sourceLang: 'en' }, // echo: same lang
        ));
        render(<TranslatableText message={msgEn} autoTranslate={false} {...baseProps} />);
        // First tap discovers the message is already in English…
        fireEvent.click(screen.getByText('Translate'));
        const altBtn = await screen.findByText('Translate to Spanish');
        // …second tap translates the other way and shows it.
        fireEvent.click(altBtn);
        await screen.findByText('El horno está roto');
        expect(txMocks.translateMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({ targetLang: 'es' }),
        );
        // Toggle back to the original.
        fireEvent.click(screen.getByText('Translated · Show original'));
        await screen.findByText('The oven is broken');
        expect(screen.getByText('Show translation')).toBeTruthy();
    });

    it('a message stamped in the viewer language offers the other language up front', () => {
        const msgEn = {
            id: 'm3', senderName: 'Maria', type: 'text',
            text: 'Closing checklist is done', sourceLang: 'en',
        };
        // Real shouldOfferTranslation semantics: false for en (source
        // matches), true for es.
        txMocks.shouldOfferTranslation.mockImplementation((m, n, lang) => String(lang).startsWith('es'));
        render(<TranslatableText message={msgEn} autoTranslate={false} {...baseProps} />);
        expect(screen.getByText('Translate to Spanish')).toBeTruthy();
        expect(screen.queryByText('Translate')).toBeNull();
    });

    it('Spanish viewers get "Traducir al inglés" on Spanish messages', () => {
        const msgEs = {
            id: 'm4', senderName: 'Maria', type: 'text',
            text: 'La lista de cierre está lista', sourceLang: 'es',
        };
        txMocks.shouldOfferTranslation.mockImplementation((m, n, lang) => String(lang).startsWith('en'));
        render(<TranslatableText message={msgEs} autoTranslate={false} {...baseProps} targetLang="es" isEs={true} />);
        expect(screen.getByText('Traducir al inglés')).toBeTruthy();
    });
});
