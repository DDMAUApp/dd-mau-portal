// Test mode must never print (project_test_mode.md rule 2): Print / PDF skips
// the print dialog on every platform, and the listeners read its offline copy
// as the whole story instead of "Offline" on every screen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

const listeners = [];
vi.mock('../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn(() => ({ id: 'x' })),
    collection: vi.fn(() => ({ path: 'rice_log' })),
    onSnapshot: vi.fn((q, opts, cb) => { listeners.push(cb); return () => {}; }),
    query: vi.fn((coll, ...filters) => filters),
    where: vi.fn((...a) => a),
    setDoc: vi.fn(async () => {}),
    updateDoc: vi.fn(async () => {}),
    arrayUnion: vi.fn((...x) => x),
    increment: vi.fn((n) => n),
    serverTimestamp: vi.fn(() => 'SERVER_TS'),
}));
vi.mock('../data/firestoreRevive', () => ({
    watchdogWrite: (p) => p,
    resilientSnapshot: (label, attach) => attach(() => {}, () => {}),
}));
vi.mock('../data/labelPrinting', () => ({ printRiceLabel: vi.fn() }));
const printViaNativeMock = vi.fn();
vi.mock('../capacitor-bridge', () => ({ printViaNative: (...a) => printViaNativeMock(...a) }));
vi.mock('../toast', () => ({ toast: vi.fn() }));
const skipped = vi.hoisted(() => vi.fn(() => ({ ok: true, testMode: true })));
vi.mock('../data/testMode', () => ({
    TEST_MODE: { id: 99, name: 'Test Tess' },
    testModePrintSkipped: skipped,
}));

import RiceLogTab from './RiceLogTab';

const feedCached = () => act(async () => {
    for (const cb of listeners) cb({ metadata: { fromCache: true, hasPendingWrites: true }, forEach: () => {} });
});

beforeEach(() => {
    listeners.length = 0;
    skipped.mockClear();
    printViaNativeMock.mockClear();
});
afterEach(() => { delete window.Capacitor; vi.restoreAllMocks(); });

describe('Rice Log in test mode', () => {
    it('Print / PDF doesn\'t reach a browser print window', async () => {
        const openSpy = vi.spyOn(window, 'open').mockReturnValue({ document: { open: vi.fn(), write: vi.fn(), close: vi.fn() } });
        render(<RiceLogTab location="webster" staffName="Test Tess" staffList={[]} language="en" />);
        await feedCached();
        fireEvent.click(screen.getByText('Print / PDF'));
        expect(skipped).toHaveBeenCalledTimes(1);
        expect(openSpy).not.toHaveBeenCalled();
    });

    it('Print / PDF doesn\'t reach the native print dialog', async () => {
        window.Capacitor = { isNativePlatform: () => true };
        render(<RiceLogTab location="webster" staffName="Test Tess" staffList={[]} language="en" />);
        await feedCached();
        fireEvent.click(screen.getByText('Print / PDF'));
        expect(skipped).toHaveBeenCalledTimes(1);
        expect(printViaNativeMock).not.toHaveBeenCalled();
    });

    it('its offline copy reads as the whole story, so the summary still shows', async () => {
        render(<RiceLogTab location="webster" staffName="Test Tess" staffList={[]} language="en" />);
        await feedCached();
        expect(screen.getByTestId('rice-connection')).toHaveTextContent('Connected. Up to date.');
        expect(screen.getByTestId('rice-summary')).toHaveTextContent('0 batches');
    });
});
