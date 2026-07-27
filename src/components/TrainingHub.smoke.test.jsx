// Smoke test — does the Training Hub RENDER, and does the hoisted Shell
// keep its DOM across re-renders? (2026-07-26 audit: `Shell` used to be
// defined INSIDE TrainingHub's render body — a new element type every
// render — so React remounted the whole subtree on each snapshot, killing
// lesson iframes and wiping the LessonEditor's inputs.) Mounts the real
// component with Firebase I/O mocked, then feeds live-shaped snapshots
// through the captured onSnapshot callbacks — including a PARTIAL progress
// doc (module entry missing its array fields), which used to crash the
// page on `.includes`/`.length` of undefined.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// ── Firebase mocks ────────────────────────────────────────────────
// onSnapshot callbacks are captured per doc path so the test can push
// snapshots into the overrides listener and the progress listener
// independently.
const snapshotCbs = {};
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, ...segs) => ({ path: segs.join('/') })),
    collection: vi.fn((_db, ...segs) => ({ path: segs.join('/') })),
    onSnapshot: vi.fn((ref, cb) => { snapshotCbs[ref.path] = cb; return () => {}; }),
    getDocs: vi.fn(async () => ({ forEach: () => {} })),
    setDoc: vi.fn(async () => {}),
    updateDoc: vi.fn(async () => {}),
    deleteField: vi.fn(() => ({})),
    arrayUnion: vi.fn((...items) => ({ _arrayUnion: items })),
    serverTimestamp: vi.fn(() => ({})),
}));

import TrainingHub from './TrainingHub';

const STAFF_LIST = [{ id: 1, name: 'Andrew Shih', role: 'Owner' }];
const PROGRESS_PATH = 'training_v2/andrew_shih';
const OVERRIDES_PATH = 'config/training_overrides';

// Partial/legacy doc shape: module entry carries `passed` only — no
// lessonsCompleted, no attempts. Must render, not crash.
const PARTIAL_PROGRESS = {
    staffName: 'Andrew Shih',
    modules: { m1: { passed: true } },
};

describe('TrainingHub smoke', () => {
    it('renders the module list, survives a partial progress doc, and keeps Shell DOM across re-renders', async () => {
        const { container } = render(
            <TrainingHub staffName="Andrew Shih" language="en" staffList={STAFF_LIST} />,
        );

        // Both listeners subscribed on mount.
        expect(typeof snapshotCbs[OVERRIDES_PATH]).toBe('function');
        expect(typeof snapshotCbs[PROGRESS_PATH]).toBe('function');

        // Loading gate until the progress snapshot lands.
        expect(screen.getByText('Loading…')).toBeInTheDocument();

        // Partial doc arrives — page must render (finding: missing array
        // fields crashed moduleState consumers).
        await act(async () => {
            snapshotCbs[PROGRESS_PATH]({ exists: () => true, data: () => PARTIAL_PROGRESS });
        });
        expect(screen.getByText('Training Hub')).toBeInTheDocument();
        // M1 is flagged passed even though the doc entry had no arrays.
        expect(screen.getAllByText('✅').length).toBeGreaterThan(0);

        // Shell stability: the sidebar <aside> must be the SAME DOM node
        // after a state-driven re-render. Pre-hoist, Shell's identity
        // changed every render → React remounted the subtree → new node.
        const asideBefore = container.querySelector('aside');
        expect(asideBefore).not.toBeNull();
        await act(async () => {
            snapshotCbs[OVERRIDES_PATH]({ exists: () => true, data: () => ({}) });
        });
        const asideAfter = container.querySelector('aside');
        expect(asideAfter).toBe(asideBefore);
    });

    it('renders in Spanish with an empty progress doc', async () => {
        render(
            <TrainingHub staffName="Andrew Shih" language="es" staffList={STAFF_LIST} />,
        );
        await act(async () => {
            snapshotCbs[PROGRESS_PATH]({ exists: () => false, data: () => ({}) });
        });
        expect(screen.getByText('Centro de Capacitación')).toBeInTheDocument();
    });
});
