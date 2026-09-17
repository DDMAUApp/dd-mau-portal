import { describe, it, expect } from 'vitest';
import { isTvImpersonationBlocked, asPreviewUrl } from './tvHeartbeatGate';

const PI = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const FIRE_TV = 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Silk/120 like Chrome/120 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';

describe('isTvImpersonationBlocked', () => {
    it('the real kiosks (and unknown signage boxes) DO heartbeat', () => {
        expect(isTvImpersonationBlocked({ search: '?tv=webster', userAgent: PI })).toBe(false);
        expect(isTvImpersonationBlocked({ search: '?tv=md-1', userAgent: FIRE_TV })).toBe(false);
        expect(isTvImpersonationBlocked({ search: '?tv=x', userAgent: '' })).toBe(false);          // fails open
        expect(isTvImpersonationBlocked()).toBe(false);
    });
    it('the owner checking the link on his own devices does NOT', () => {
        for (const ua of [MAC, IPHONE, ANDROID_PHONE, WINDOWS]) expect(isTvImpersonationBlocked({ search: '?tv=webster', userAgent: ua })).toBe(true);
    });
    it('preview=1 and embedded iframes never heartbeat, even on a kiosk-looking browser', () => {
        expect(isTvImpersonationBlocked({ search: '?tv=webster&preview=1', userAgent: PI })).toBe(true);
        expect(isTvImpersonationBlocked({ embedded: true, search: '?tv=webster', userAgent: PI })).toBe(true);
        expect(isTvImpersonationBlocked({ search: '?tv=webster&preview=0', userAgent: PI })).toBe(false);
    });
});

describe('asPreviewUrl', () => {
    it('appends the marker once, with the right separator', () => {
        expect(asPreviewUrl('https://app.ddmaustl.com/?tv=webster')).toBe('https://app.ddmaustl.com/?tv=webster&preview=1');
        expect(asPreviewUrl('https://app.ddmaustl.com/')).toBe('https://app.ddmaustl.com/?preview=1');
        expect(asPreviewUrl('https://app.ddmaustl.com/?tv=webster&preview=1')).toBe('https://app.ddmaustl.com/?tv=webster&preview=1');
        expect(asPreviewUrl('')).toBe('');
    });
});
