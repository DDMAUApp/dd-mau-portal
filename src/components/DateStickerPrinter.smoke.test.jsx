// Smoke test — does the Date Stickers page RENDER? (2026-07-26 incident:
// "date stickers can't load"). Mounts the real component + real
// stickerListsOverride/itemBuild logic with Firebase I/O mocked, then
// feeds a live-shaped sticker_lists snapshot (including the new
// shelfLifeHours/thawedDays fields and extra row fields like
// nameEsIsAuto) through the subscription.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// ── Firebase mocks ────────────────────────────────────────────────
let listsSnapshotCb = null;
vi.mock('../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn(() => ({ path: 'mock' })),
    collection: vi.fn(() => ({ path: 'mock' })),
    onSnapshot: vi.fn((ref, cb) => { listsSnapshotCb = cb; return () => {}; }),
    setDoc: vi.fn(async () => {}),
    getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
    addDoc: vi.fn(async () => ({ id: 'x' })),
    updateDoc: vi.fn(async () => {}),
    runTransaction: vi.fn(async () => {}),
    deleteField: vi.fn(() => ({})),
    serverTimestamp: vi.fn(() => ({})),
    query: vi.fn((...a) => a),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    FieldPath: class FieldPath {},
}));
vi.mock('../data/aiSearch', () => ({
    useAiSearch: () => ({ loading: false, matchingIds: null, error: null }),
}));
vi.mock('../data/labelPrinting', () => ({ warmPrintConfigs: vi.fn() }));
vi.mock('../data/buildOverrides', () => ({
    subscribeAllBuildOverrides: (cb) => { cb(new Map()); return () => {}; },
    applyBuildOverride: (b) => b,
}));
vi.mock('../data/customItems', () => ({
    subscribeAllCustomItems: (cb) => { cb([]); return () => {}; },
}));
vi.mock('./PrintLabelModal', () => ({ default: () => null }));
vi.mock('./ShelfLifeMatrix', () => ({ default: () => null }));
vi.mock('./ExpiringPanel', () => ({ default: () => null }));

import DateStickerPrinter from './DateStickerPrinter';

// Live-shaped doc: defaults-style rows + the new fields the v327 features
// added + stray extra fields real rows carry.
const LIVE_DOC = {
    proteins: [
        { id: 'p1', nameEn: 'Chicken', nameEs: 'Pollo', shelfLifeDays: 3, thawedDays: 2 },
        { id: 'p2', nameEn: 'Shrimp', nameEs: 'Camarón' },
    ],
    chemicals: [
        { id: 'c1', nameEn: 'Sanitizer', nameEs: 'Desinfectante', shelfLifeHours: 4 },
    ],
    statusLabels: [
        { id: 's1', nameEn: 'RECEIVED', nameEs: 'RECIBIDO', nameEsIsAuto: false },
        { id: 's2', nameEn: 'COOLING', nameEs: 'ENFRIANDO', shelfLifeHours: 6 },
    ],
    other: [],
    updatedAt: {}, updatedBy: 'test',
};

describe('DateStickerPrinter smoke', () => {
    it('renders with defaults, then survives a live-shaped snapshot', async () => {
        render(
            <DateStickerPrinter
                language="en"
                staffName="Andrew Shih"
                storeLocation="webster"
                staffList={[{ id: 1, name: 'Andrew Shih', role: 'Owner' }]}
            />,
        );
        // First paint (stamped defaults).
        expect(screen.getByText('Date Stickers')).toBeInTheDocument();
        // Live snapshot arrives.
        await act(async () => {
            listsSnapshotCb({ exists: () => true, data: () => LIVE_DOC });
        });
        expect(screen.getByText('Date Stickers')).toBeInTheDocument();
        expect(screen.getByText('Sanitizer')).toBeInTheDocument();
        expect(screen.getByText('RECEIVED')).toBeInTheDocument();
    });

    it('renders on "both" location (admin) without crashing', () => {
        render(
            <DateStickerPrinter
                language="es"
                staffName="Andrew Shih"
                storeLocation="both"
                staffList={[{ id: 1, name: 'Andrew Shih', role: 'Owner' }]}
            />,
        );
        expect(screen.getByText('Etiquetas de Fecha')).toBeInTheDocument();
    });
});
