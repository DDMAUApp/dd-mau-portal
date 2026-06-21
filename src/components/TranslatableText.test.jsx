// Chat web links must be clickable on native (App Store app) — Andrew
// 2026-06-20: "posting a web page still doesn't let you click it." The link
// must open EXPLICITLY via openExternalUrl (in-app browser on native), not
// rely on target="_blank" (a no-op in WKWebView).

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { openSpy } = vi.hoisted(() => ({ openSpy: vi.fn() }));
vi.mock('../capacitor-bridge', () => ({ openExternalUrl: openSpy }));
// Keep firebase + the Cloud Function client out of the test.
vi.mock('../data/translation', () => ({
    translateMessage: vi.fn(),
    readCachedTranslation: () => null,
    shouldOfferTranslation: () => false,
    subscribeTranslation: () => () => {},
    detectLanguageHint: () => null,
}));

import { renderWithMentions } from './TranslatableText';

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
