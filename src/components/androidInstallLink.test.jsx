// Every web-app surface that tells an Android staffer to install must open
// the SAME Google Play page (Andrew 2026-09-25):
//   https://play.google.com/store/apps/details?id=com.ddmau.staff
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const PLAY = 'https://play.google.com/store/apps/details?id=com.ddmau.staff';
const opened = vi.hoisted(() => []);
vi.mock('../capacitor-bridge', () => ({ openExternalUrl: (u) => { opened.push(u); } }));
vi.mock('./ModalPortal', () => ({ default: ({ children }) => children }));
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({ collection: vi.fn(), addDoc: vi.fn(async () => ({})), serverTimestamp: vi.fn() }));
vi.mock('../data/notify', () => ({ notifyManagement: vi.fn(async () => {}) }));
vi.mock('../data/staffDoc', () => ({ patchStaffRecordByName: vi.fn(async () => ({ ok: true })) }));
vi.mock('../toast', () => ({ toast: vi.fn() }));

import InstallAppButton, { ANDROID_APP_URL } from './InstallAppButton';
import DownloadAppGate from './DownloadAppGate';
import InstallSplash from './InstallSplash';
import RequiredTaskInstallPwa from './RequiredTaskInstallPwa';

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';
let uaSpy;
beforeEach(() => {
    opened.length = 0;
    uaSpy = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ANDROID_UA);
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
});
afterEach(() => { uaSpy.mockRestore(); });

describe('Android install → the one Google Play page', () => {
    it('the constant is the Play listing', () => {
        expect(ANDROID_APP_URL).toBe(PLAY);
    });
    it('lock-screen "Install app" sheet → Android', () => {
        render(<InstallAppButton language="en" compact />);
        fireEvent.click(screen.getByText('Install app'));
        fireEvent.click(screen.getByText('Android'));
        expect(opened).toEqual([PLAY]);
    });
    it('phone-browser download gate → Android', () => {
        const { container } = render(<DownloadAppGate language="en" staffName="Maria Lopez" onSignOut={() => {}} />);
        const a = [...container.querySelectorAll('a')].find(x => x.textContent.includes('Android'));
        expect(a.getAttribute('href')).toBe(PLAY);
    });
    it('NFC-sticker install page (?install=1) on Android → Play, not "Add to Home screen"', () => {
        render(<InstallSplash language="en" onSkip={() => {}} />);
        expect(screen.queryByText(/Add to Home screen/i)).toBeNull();
        fireEvent.click(screen.getByText('Get the app on Google Play'));
        expect(opened).toEqual([PLAY]);
    });
    it('"Get the app" required task on Android → Play', () => {
        render(<RequiredTaskInstallPwa task={{}} staff={{}} staffName="Maria Lopez" language="en" onComplete={async () => {}} />);
        expect(screen.getByText('Get the DD Mau app')).toBeTruthy();
        expect(screen.queryByText(/three-dot menu/i)).toBeNull();
        fireEvent.click(screen.getByText('Get the app on Google Play'));
        expect(opened).toEqual([PLAY]);
    });
    it('Spanish copy too', () => {
        render(<InstallSplash language="es" onSkip={() => {}} />);
        fireEvent.click(screen.getByText('Obtén la app en Google Play'));
        expect(opened).toEqual([PLAY]);
    });
});
