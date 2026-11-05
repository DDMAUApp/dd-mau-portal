// Release B boot gate, on the real App: a session restored on a stuck line.
// The roster listener never answers, the way it doesn't when the line is stuck.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const roster = { fire: null };
vi.mock('./firebase', () => ({ db: {}, storage: {}, functions: {}, messaging: null }));
vi.mock('firebase/firestore', async (importOriginal) => {
    const never = () => new Promise(() => {});
    const empty = async () => ({ docs: [], empty: true, size: 0, forEach: () => {}, metadata: { fromCache: false } });
    return {
        ...(await importOriginal()),
        doc: vi.fn((_db, ...segs) => ({ path: segs.join('/') })),
        collection: vi.fn((_db, ...segs) => ({ path: segs.join('/') })),
        query: vi.fn((c) => c),
        where: vi.fn(() => ({})), orderBy: vi.fn(() => ({})), limit: vi.fn(() => ({})),
        onSnapshot: vi.fn((ref, a, b) => {
            const cb = typeof a === 'function' ? a : b;
            if (ref?.path === 'config/staff') roster.fire = cb;
            return () => {};
        }),
        getDoc: vi.fn(never), getDocs: vi.fn(empty), getDocFromCache: vi.fn(never), getDocFromServer: vi.fn(never), getDocsFromServer: vi.fn(empty),
        setDoc: vi.fn(never), updateDoc: vi.fn(never), addDoc: vi.fn(never), runTransaction: vi.fn(never),
        disableNetwork: vi.fn(async () => {}), enableNetwork: vi.fn(async () => {}),
    };
});
vi.mock('./data/reportFlush', () => ({ flushParkedReports: vi.fn(async () => {}), logDeviceSeenOncePerDay: vi.fn(async () => {}) }));
vi.mock('./data/firestoreRevive', async (importOriginal) => ({ ...(await importOriginal()), installFirestoreRevive: vi.fn() }));
vi.mock('./v2/AppShellV2', () => ({ default: ({ children }) => <div data-testid="shell">{children}</div> }));
vi.mock('./v2/HomeV2', () => ({ default: () => <div data-testid="home" /> }));
vi.mock('./v2/MobileHome', () => ({ default: () => <div data-testid="home" /> }));
vi.mock('./components/Operations', () => ({ default: () => <div data-testid="operations" /> }));
vi.mock('./components/HomePage', () => ({ default: ({ onSelectStaff }) => (
    <div data-testid="pin-screen">
        <button type="button" onClick={() => onSelectStaff('Julie Test Hire')}>as hire</button>
        <button type="button" onClick={() => onSelectStaff('Somebody Else')}>as other</button>
    </div>
) }));
vi.mock('./components/Schedule', () => ({ default: () => <div data-testid="schedule" /> }));

import App from './App';
import { flushParkedReports } from './data/reportFlush';
import { PLACE_TTL_MS, readMainTab, saveMainTab } from './data/placeMemory';
import { LAST_KNOWN_ACCESS_KEY, readLastKnownAccess, saveLastKnownAccess } from './data/lastKnownAccess';

// Not on the built-in list, like a recent hire.
const NAME = 'Julie Test Hire';
const flagOn = () => localStorage.setItem('ddmau:relFlags', JSON.stringify({ flags: { placeRestore: true } }));
const session = (tab = 'operations') => {
    sessionStorage.setItem('ddmau:sessionAlive', '1');
    localStorage.setItem('ddmau:staffName', NAME);
    localStorage.setItem('ddmau:activeTab', tab);
    localStorage.setItem(`ddmau:rtclear:${NAME}`, '1');
    localStorage.setItem('ddmau:lastActive', String(Date.now()));
};
const paint = async (ui) => {
    const r = render(ui);
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
    return r;
};
const seen = async (id) => screen.findByTestId(id, {}, { timeout: 4000 });
const rosterAnswers = async (list) => {
    await act(async () => { roster.fire({ exists: () => true, data: () => ({ list }), metadata: { fromCache: false, hasPendingWrites: false } }); });
};

beforeEach(() => {
    window.matchMedia = window.matchMedia || ((query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    localStorage.clear();
    sessionStorage.clear();
    roster.fire = null;
    vi.mocked(flushParkedReports).mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('boot gate: restored session, roster not answered, on Operations, not an admin', () => {
    it('flag on, saved access: shows Operations, never Home', async () => {
        flagOn();
        session();
        saveLastKnownAccess({ name: NAME, id: 900, role: 'Prep', opsAccess: true, pin: '1234', fcmTokens: ['t'] });
        await paint(<App />);
        expect(await seen('operations')).toBeTruthy();
        expect(screen.queryByTestId('home')).toBe(null);
        expect(localStorage.getItem('ddmau:activeTab')).toBe('operations');
        expect(localStorage.getItem(LAST_KNOWN_ACCESS_KEY)).not.toContain('1234');
    });

    it('flag on, nothing saved: the connecting screen, never Home', async () => {
        flagOn();
        session();
        await paint(<App />);
        expect((await seen('connecting-screen')).textContent).toContain('Connecting…');
        expect(screen.queryByTestId('home')).toBe(null);
        expect(screen.queryByTestId('operations')).toBe(null);
        expect(screen.queryByRole('button', { name: 'Go Home' })).toBe(null);
    });

    it('after 10 s the connecting screen offers Go Home, so nobody is trapped', async () => {
        flagOn();
        session();
        await paint(<App />);
        await seen('connecting-screen');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        cleanup();
        await act(async () => { render(<App />); });
        await act(async () => { vi.advanceTimersByTime(10000); });
        fireEvent.click(screen.getByRole('button', { name: 'Go Home' }));
        await act(async () => { vi.advanceTimersByTime(1); });
        vi.useRealTimers();
        expect(await seen('home')).toBeTruthy();
    });

    it('flag off, saved access present: exactly today, Home with the tab left alone', async () => {
        session();
        saveLastKnownAccess({ name: NAME, id: 900, role: 'Prep', opsAccess: true });
        await paint(<App />);
        expect(await seen('home')).toBeTruthy();
        expect(screen.queryByTestId('operations')).toBe(null);
        expect(screen.queryByTestId('connecting-screen')).toBe(null);
        expect(localStorage.getItem('ddmau:activeTab')).toBe('operations');
        expect(readMainTab(NAME)).toBe(null);
    });
});

describe('when the roster lands', () => {
    it('real access revoked: the bounce effect still sends them Home', async () => {
        flagOn();
        session();
        saveLastKnownAccess({ name: NAME, id: 900, role: 'Prep', opsAccess: true });
        await paint(<App />);
        await seen('operations');
        await rosterAnswers([{ id: 900, name: NAME, role: 'Prep', location: 'webster', opsAccess: false }]);
        expect(await seen('home')).toBeTruthy();
        expect(screen.queryByTestId('operations')).toBe(null);
    });

    it('saves only the allowed fields, for the signed-in person only', async () => {
        flagOn();
        session();
        await paint(<App />);
        await seen('connecting-screen');
        await rosterAnswers([
            { id: 900, name: NAME, role: 'Prep', location: 'webster', opsAccess: true, pin: '1234', fcmTokens: ['t'] },
            { id: 901, name: 'Somebody Else', role: 'Prep', location: 'webster', opsAccess: true },
        ]);
        expect(await seen('operations')).toBeTruthy();
        expect(readLastKnownAccess(NAME)).toEqual({ id: 900, role: 'Prep', location: 'webster', opsAccess: true });
        expect(readLastKnownAccess('Somebody Else')).toBe(null);
    });
});

describe('the after-reload flush', () => {
    it('flag off: called at once with no place, as today', async () => {
        session();
        await paint(<App />);
        expect(flushParkedReports).toHaveBeenCalledWith({ language: 'en' });
    });

    it('flag on: waits for the tab area, then says what it is', async () => {
        flagOn();
        session();
        await paint(<App />);
        await seen('connecting-screen');
        expect(flushParkedReports).toHaveBeenCalledTimes(1);
        expect(flushParkedReports.mock.calls[0][0].place).toMatchObject({ tab: 'operations', body: 'connecting' });
    });

});

describe('coming back through the PIN screen', () => {
    const signIn = async (label) => {
        await paint(<App />);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })); });
    };

    it('flag on: the same person goes back to their saved tab', async () => {
        flagOn();
        saveMainTab(NAME, 'schedule');
        await signIn('as hire');
        expect(await seen('schedule')).toBeTruthy();
    });

    it('flag on: a different person does not get it', async () => {
        flagOn();
        saveMainTab(NAME, 'schedule');
        await signIn('as other');
        expect(await seen('home')).toBeTruthy();
        expect(readMainTab(NAME)).toBe('schedule');
    });

    it('flag on: older than 30 minutes goes Home', async () => {
        flagOn();
        saveMainTab(NAME, 'schedule', Date.now() - PLACE_TTL_MS);
        await signIn('as hire');
        expect(await seen('home')).toBeTruthy();
    });

    it('flag off: ignored', async () => {
        saveMainTab(NAME, 'schedule');
        await signIn('as hire');
        expect(await seen('home')).toBeTruthy();
    });

    it('a relock does not overwrite the saved tab, and returning restores it', async () => {
        flagOn();
        saveMainTab(NAME, 'schedule');
        await signIn('as hire');
        await seen('schedule');
        // Backgrounded past the idle limit, then back: the relock path.
        localStorage.setItem('ddmau:lastActive', String(Date.now() - 60 * 60 * 1000));
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(await seen('pin-screen')).toBeTruthy();
        expect(localStorage.getItem('ddmau:activeTab')).toBe('home');
        expect(readMainTab(NAME)).toBe('schedule');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'as hire' })); });
        expect(await seen('schedule')).toBeTruthy();
    });
});
