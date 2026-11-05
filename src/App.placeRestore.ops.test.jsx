// Release B boot gate with the REAL Operations page: App's gate and Operations' own
// gate have to agree while the roster hasn't answered. Non-admins with saved access.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

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
vi.mock('./components/HomePage', () => ({ default: () => <div data-testid="pin-screen" /> }));
vi.mock('./components/Schedule', () => ({ default: () => <div data-testid="schedule" /> }));
vi.mock('./data/aiSearch', () => ({ useAiSearch: () => ({ loading: false, matchingIds: null, error: null }) }));

import App from './App';
import { DEFAULT_STAFF, isAdminId } from './data/staff';
import { saveLastKnownAccess } from './data/lastKnownAccess';

vi.setConfig({ testTimeout: 30000 });

const onBuiltIn = DEFAULT_STAFF.find(s => !isAdminId(s.id) && !s.opsAccess);
const HIRE = 'Julie Test Hire';
const flagOn = () => localStorage.setItem('ddmau:relFlags', JSON.stringify({ flags: { placeRestore: true } }));
const session = (name) => {
    sessionStorage.setItem('ddmau:sessionAlive', '1');
    localStorage.setItem('ddmau:staffName', name);
    localStorage.setItem('ddmau:activeTab', 'operations');
    localStorage.setItem(`ddmau:rtclear:${name}`, '1');
    localStorage.setItem('ddmau:lastActive', String(Date.now()));
};
const paint = async () => {
    render(<App />);
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
};
const realOperations = () => screen.findAllByRole('button', { name: /Inventory/ }, { timeout: 15000 });
const denied = () => screen.queryByText(/don't have access to Operations/);

beforeEach(() => {
    window.matchMedia = window.matchMedia || ((query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    localStorage.clear();
    sessionStorage.clear();
    roster.fire = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('restored session, roster not answered, not an admin', () => {
    it('on the built-in list with saved access: Operations opens, no false denial', async () => {
        flagOn();
        session(onBuiltIn.name);
        saveLastKnownAccess({ name: onBuiltIn.name, id: onBuiltIn.id, role: onBuiltIn.role, opsAccess: true });
        await paint();
        expect((await realOperations()).length).toBeGreaterThan(0);
        expect(denied()).toBe(null);
        expect(screen.queryByTestId('home')).toBe(null);
    });
    it('not on the built-in list with saved access: same', async () => {
        flagOn();
        session(HIRE);
        saveLastKnownAccess({ name: HIRE, id: 900, role: 'Prep', opsAccess: true });
        await paint();
        expect((await realOperations()).length).toBeGreaterThan(0);
        expect(denied()).toBe(null);
    });
    it('the roster landing with access revoked still takes them off the page', async () => {
        flagOn();
        session(onBuiltIn.name);
        saveLastKnownAccess({ name: onBuiltIn.name, id: onBuiltIn.id, role: onBuiltIn.role, opsAccess: true });
        await paint();
        await realOperations();
        await act(async () => {
            roster.fire({ exists: () => true, data: () => ({ list: [{ ...onBuiltIn, opsAccess: false }] }), metadata: { fromCache: false, hasPendingWrites: false } });
        });
        expect(await screen.findByTestId('home', {}, { timeout: 15000 })).toBeTruthy();
    });
    it('flag off, saved access present: Home, exactly today', async () => {
        session(onBuiltIn.name);
        saveLastKnownAccess({ name: onBuiltIn.name, id: onBuiltIn.id, role: onBuiltIn.role, opsAccess: true });
        await paint();
        expect(await screen.findByTestId('home', {}, { timeout: 15000 })).toBeTruthy();
        expect(denied()).toBe(null);
    });
});
