// The PIN screen's "Connecting…" never ends on a stuck line (Release B).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({ collection: vi.fn(), addDoc: vi.fn(), serverTimestamp: vi.fn(), doc: vi.fn(), getDoc: vi.fn(() => new Promise(() => {})), setDoc: vi.fn(), updateDoc: vi.fn(), onSnapshot: vi.fn(() => () => {}), query: vi.fn(), where: vi.fn(), getDocs: vi.fn(() => new Promise(() => {})), limit: vi.fn(), orderBy: vi.fn() }));
vi.mock('../messaging', () => ({ isSharedDeviceModeEnabled: () => false, setSharedDeviceMode: vi.fn(), purgeDeviceTokensAllStaff: vi.fn() }));

import HomePage, { PIN_CONNECTING_HINT_MS } from './HomePage';

const hint = () => screen.queryByTestId('pin-connecting-hint');
const on = () => localStorage.setItem('ddmau:relFlags', JSON.stringify({ flags: { placeRestore: true } }));
const show = async (props = {}) => {
    let r;
    await act(async () => { r = render(<HomePage onSelectStaff={() => {}} language="en" staffList={[]} staffListReady={false} {...props} />); });
    return r;
};
const wait = async (ms) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

beforeEach(() => { window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })); localStorage.clear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('PIN screen hint', () => {
    it('20 s, online, flag on: says what to do, in their language', async () => {
        on();
        await show();
        await wait(PIN_CONNECTING_HINT_MS - 1);
        expect(hint()).toBe(null);
        await wait(1);
        expect(hint().textContent).toBe('If this stays, close the app and reopen it.');
    });
    it('Spanish', async () => {
        on();
        await show({ language: 'es' });
        await wait(PIN_CONNECTING_HINT_MS);
        expect(hint().textContent).toBe('Si no cambia, cierra la app y ábrela de nuevo.');
    });
    it('flag off: never', async () => {
        await show();
        await wait(PIN_CONNECTING_HINT_MS);
        expect(hint()).toBe(null);
    });
    it('offline: never', async () => {
        on();
        vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
        await show();
        await wait(PIN_CONNECTING_HINT_MS);
        expect(hint()).toBe(null);
    });
    it('goes away when the roster lands', async () => {
        on();
        const r = await show();
        await wait(PIN_CONNECTING_HINT_MS);
        await act(async () => { r.rerender(<HomePage onSelectStaff={() => {}} language="en" staffList={[]} staffListReady />); });
        expect(hint()).toBe(null);
    });
});
