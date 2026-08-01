// Pins the 2026-08-01 bug-run finding: three call sites wrapped
// `new Notification()` in a bare try/catch with no service-worker fallback,
// so on Android (where page-context Notification throws "Illegal
// constructor") the foreground push, the in-app popup and the 1-hour shift
// reminder all silently did nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showLocalNotification } from './localNotification';

const origNotification = globalThis.Notification;
const origSW = globalThis.navigator?.serviceWorker;

function setNotification(impl, permission = 'granted') {
    const ctor = impl || function () {};
    ctor.permission = permission;
    globalThis.Notification = ctor;
}

function setServiceWorker(showNotification) {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        configurable: true,
        value: showNotification === null
            ? undefined
            : { ready: Promise.resolve({ showNotification }) },
    });
}

beforeEach(() => { setServiceWorker(vi.fn().mockResolvedValue(undefined)); });
afterEach(() => {
    globalThis.Notification = origNotification;
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
        configurable: true, value: origSW,
    });
});

describe('the happy path', () => {
    it('constructs a page-context notification when the browser allows it', async () => {
        const ctor = vi.fn();
        setNotification(ctor);
        await expect(showLocalNotification('Shift in 1 hour', { body: 'x' })).resolves.toBe(true);
        expect(ctor).toHaveBeenCalledWith('Shift in 1 hour', { body: 'x' });
    });
});

describe('Android: page-context Notification throws', () => {
    it('falls back to the service worker instead of silently dropping it', async () => {
        setNotification(function () { throw new TypeError("Failed to construct 'Notification': Illegal constructor"); });
        const show = vi.fn().mockResolvedValue(undefined);
        setServiceWorker(show);

        await expect(showLocalNotification('Shift in 1 hour', { tag: 't' })).resolves.toBe(true);
        expect(show).toHaveBeenCalledWith('Shift in 1 hour', { tag: 't' });
    });

    it('never throws when the service worker is also unavailable', async () => {
        setNotification(function () { throw new TypeError('Illegal constructor'); });
        setServiceWorker(null);
        await expect(showLocalNotification('x')).resolves.toBe(false);
    });

    it('never throws when showNotification itself rejects', async () => {
        setNotification(function () { throw new TypeError('Illegal constructor'); });
        setServiceWorker(vi.fn().mockRejectedValue(new Error('nope')));
        await expect(showLocalNotification('x')).resolves.toBe(false);
    });
});

describe('permission handling', () => {
    it('does nothing when permission was not granted', async () => {
        const ctor = vi.fn();
        setNotification(ctor, 'default');
        const show = vi.fn();
        setServiceWorker(show);
        await expect(showLocalNotification('x')).resolves.toBe(false);
        expect(ctor).not.toHaveBeenCalled();
        expect(show).not.toHaveBeenCalled();
    });

    it('tries the service worker when Notification is undefined entirely', async () => {
        globalThis.Notification = undefined;
        const show = vi.fn().mockResolvedValue(undefined);
        setServiceWorker(show);
        await expect(showLocalNotification('x', { body: 'b' })).resolves.toBe(true);
        expect(show).toHaveBeenCalledWith('x', { body: 'b' });
    });
});

describe('degenerate input', () => {
    it('substitutes a default title rather than showing "undefined"', async () => {
        const ctor = vi.fn();
        setNotification(ctor);
        await showLocalNotification(undefined);
        expect(ctor).toHaveBeenCalledWith('DD Mau', {});
    });
});
