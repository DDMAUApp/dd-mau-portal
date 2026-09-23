// Smoke test — ChatSettingsModal write paths after the 2026-09-23 chat audit.
//   C1 — Leave is an atomic arrayRemove of just the viewer (never a whole-
//        array replace that could write members: [] / admins: []); Save never
//        writes `admins` unless the user toggled a co-admin, and then merges
//        onto the LIVE array; the modal follows the live chat prop.
//   M6 — Leave is blocked (with an explanation) where auto-add would re-add.
//   m1 — a failed Leave toasts instead of failing silently.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const updateDoc = vi.fn(async () => {});
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('../data/firestoreRevive', () => ({
    watchdogWrite: (p) => p,
    watchdogRead: (p) => p,
}));
vi.mock('firebase/firestore', () => ({
    doc: (_db, ...segs) => ({ path: segs.join('/') }),
    collection: (_db, ...segs) => ({ path: segs.join('/') }),
    query: (r) => r,
    limit: () => ({}),
    writeBatch: () => ({ delete() {}, commit: async () => {} }),
    serverTimestamp: () => ({ __ts: true }),
    deleteField: () => ({ __delete: true }),
    arrayUnion: (...items) => ({ __arrayUnion: items }),
    arrayRemove: (...items) => ({ __arrayRemove: items }),
    setDoc: vi.fn(async () => {}),
    deleteDoc: vi.fn(async () => {}),
    updateDoc: (...a) => updateDoc(...a),
    getDocs: vi.fn(async () => ({ empty: true, size: 0, forEach() {} })),
}));
const toast = vi.fn();
vi.mock('../toast', () => ({ toast: (...a) => toast(...a) }));
vi.mock('../data/audit', () => ({ recordAudit: vi.fn() }));

import ChatSettingsModal from './ChatSettingsModal';

const cash = { id: 10, name: 'Cash Magruder', role: 'Server', location: 'webster', scheduleSide: 'foh' };
const tom = { id: 11, name: 'Tom Lee', role: 'Line Cook', location: 'webster', scheduleSide: 'boh' };
const STAFF = [cash, tom, { id: 12, name: 'Ana Ruiz', role: 'Server', location: 'webster', scheduleSide: 'foh' }];

const baseGroup = {
    id: 'g1', type: 'group', name: 'Front crew', emoji: '🪑',
    members: ['Cash Magruder', 'Tom Lee', 'Ana Ruiz'],
    admins: ['Ana Ruiz'],
    editTier: 'staff', createdBy: 'Cash Magruder',
};

function renderModal(chat, viewer = cash, extra = {}) {
    const props = {
        chat, language: 'en', staffName: viewer.name, staffList: STAFF,
        isAdmin: false, viewer, onClose: vi.fn(), onDeleted: vi.fn(), ...extra,
    };
    const utils = render(<ChatSettingsModal {...props} />);
    return { ...utils, props };
}

let confirmSpy;
beforeEach(() => {
    updateDoc.mockClear();
    updateDoc.mockImplementation(async () => {});
    toast.mockClear();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { confirmSpy.mockRestore(); });

describe('ChatSettingsModal — Leave (C1 / M6)', () => {
    it('removes ONLY the viewer, atomically, from members and admins', async () => {
        const { props } = renderModal(baseGroup, tom);
        await act(async () => { fireEvent.click(screen.getByText('Leave')); });
        expect(updateDoc).toHaveBeenCalledTimes(1);
        const [ref, patch] = updateDoc.mock.calls[0];
        expect(ref.path).toBe('chats/g1');
        expect(patch).toEqual({
            members: { __arrayRemove: ['Tom Lee'] },
            admins: { __arrayRemove: ['Tom Lee'] },
        });
        expect(props.onDeleted).toHaveBeenCalled();
    });

    it('blocks Leave with an explanation when auto-add would re-add the viewer', async () => {
        renderModal({ ...baseGroup, autoAudience: 'foh-webster' }, cash);
        await act(async () => { fireEvent.click(screen.getByText('Leave')); });
        expect(updateDoc).not.toHaveBeenCalled();
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledTimes(1);
        expect(toast.mock.calls[0][1]).toMatchObject({ kind: 'warn' });
        expect(String(toast.mock.calls[0][0])).toMatch(/auto-add/i);
    });

    it('still lets a NON-matching member leave an auto-add group', async () => {
        renderModal({ ...baseGroup, autoAudience: 'foh-webster' }, tom);
        await act(async () => { fireEvent.click(screen.getByText('Leave')); });
        expect(updateDoc).toHaveBeenCalledTimes(1);
    });

    it('toasts when the Leave write fails (was silent)', async () => {
        updateDoc.mockImplementation(async () => { throw new Error('offline'); });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { props } = renderModal(baseGroup, tom);
        await act(async () => { fireEvent.click(screen.getByText('Leave')); });
        expect(props.onDeleted).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledWith(expect.stringMatching(/could not leave/i), { kind: 'error' });
        warn.mockRestore();
    });
});

describe('ChatSettingsModal — Save (C1)', () => {
    it('Save without touching co-admins writes nothing (no admins: [] ever)', async () => {
        const { props } = renderModal(baseGroup, cash);
        await act(async () => { fireEvent.click(screen.getByText('Save')); });
        expect(updateDoc).not.toHaveBeenCalled();
        expect(props.onClose).toHaveBeenCalled();
    });

    it('a co-admin toggle is merged onto the LIVE admins array', async () => {
        const { rerender, props } = renderModal(baseGroup, cash);
        // Someone else promotes Tom while this modal is open.
        rerender(<ChatSettingsModal {...props} chat={{ ...baseGroup, admins: ['Ana Ruiz', 'Tom Lee'] }} />);
        // The creator demotes Ana here.
        const anaRow = screen.getByText('Ana Ruiz').closest('div.flex');
        await act(async () => { fireEvent.click(anaRow.querySelector('button')); });
        await act(async () => { fireEvent.click(screen.getByText('Save')); });
        expect(updateDoc).toHaveBeenCalledTimes(1);
        expect(updateDoc.mock.calls[0][1]).toEqual({ admins: ['Tom Lee'] });
    });

    it('follows a live rename while the name field is untouched', async () => {
        const { rerender, props } = renderModal(baseGroup, cash);
        rerender(<ChatSettingsModal {...props} chat={{ ...baseGroup, name: 'Renamed elsewhere' }} />);
        expect(screen.getByDisplayValue('Renamed elsewhere')).toBeTruthy();
        // …and Save does not write the old name back.
        await act(async () => { fireEvent.click(screen.getByText('Save')); });
        expect(updateDoc).not.toHaveBeenCalled();
    });
});
