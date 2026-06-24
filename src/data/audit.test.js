// Tests for the scheduling/availability audit wrappers (2026-06-24).
//
// These feed the Debug/QA change-history. We mock firebase/firestore's
// addDoc so we can assert the EXACT document shape each wrapper writes —
// feature/action routing, before/after capture, the new provenance
// context (tz / platform / surface / viewport), actor resolution from
// window globals, and the best-effort "never throws" guarantee.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const added = [];
vi.mock('firebase/firestore', () => ({
    collection: vi.fn(() => ({})),
    addDoc: vi.fn(async (_col, data) => { added.push(data); return { id: `id_${added.length}` }; }),
    serverTimestamp: () => 'SERVER_TS',
}));
vi.mock('../firebase', () => ({ db: {} }));

import { auditAvailabilityChange, auditPtoChange, auditShiftChange } from './audit';
import { addDoc } from 'firebase/firestore';

beforeEach(() => {
    added.length = 0;
    addDoc.mockClear();
    // Actor identity comes from window globals (set by App.jsx setIdentity).
    window.__ddmau_staffName = 'Manager Mike';
    window.__ddmau_staffId = 7;
    window.__ddmau_role = 'Manager';
    window.__ddmau_location = 'webster';
});

describe('auditAvailabilityChange', () => {
    it('writes feature/action + before/after + provenance + actor', async () => {
        await auditAvailabilityChange({
            staffId: 12, staffName: 'Cash',
            before: { mon: { available: true, from: '09:00', to: '17:00' } },
            after:  { mon: { available: false } },
            surface: 'self-serve',
        });
        expect(added).toHaveLength(1);
        const d = added[0];
        expect(d.feature).toBe('availability');
        expect(d.action).toBe('availability.edited');
        expect(d.targetType).toBe('staff');
        expect(d.targetId).toBe(12);
        expect(d.targetName).toBe('Cash');
        expect(d.before).toEqual({ mon: { available: true, from: '09:00', to: '17:00' } });
        expect(d.after).toEqual({ mon: { available: false } });
        // Provenance the spec asked for:
        expect(d.surface).toBe('self-serve');
        expect(d.platform).toBe('web');           // jsdom has no window.Capacitor
        expect(typeof d.tz === 'string' || d.tz === null).toBe(true);
        expect(typeof d.viewport).toBe('string');
        // Actor resolved from window globals:
        expect(d.actorName).toBe('Manager Mike');
        expect(d.actorId).toBe(7);
        expect(d.actorRole).toBe('Manager');
        expect(d.actorLocation).toBe('webster');
        expect(d.createdAt).toBe('SERVER_TS');
    });
});

describe('auditPtoChange', () => {
    it('records the action verb + time_off target + status diff', async () => {
        await auditPtoChange({
            entryId: 'pto1', staffName: 'Cash', action: 'approved',
            before: { status: 'pending' }, after: { status: 'approved' },
            surface: 'admin-dashboard',
        });
        const d = added[0];
        expect(d.feature).toBe('pto');
        expect(d.action).toBe('pto.approved');
        expect(d.targetType).toBe('time_off');
        expect(d.targetId).toBe('pto1');
        expect(d.before).toEqual({ status: 'pending' });
        expect(d.after).toEqual({ status: 'approved' });
        expect(d.surface).toBe('admin-dashboard');
    });

    it('defaults action to "edited" when omitted', async () => {
        await auditPtoChange({ entryId: 'pto2', staffName: 'Cash' });
        expect(added[0].action).toBe('pto.edited');
    });
});

describe('auditShiftChange', () => {
    it('records a move with before/after owner+date', async () => {
        await auditShiftChange({
            shiftId: 's1', staffName: 'Cash', action: 'moved',
            before: { staffName: 'Cash', date: '2026-07-01' },
            after:  { staffName: 'Lee',  date: '2026-07-02' },
            surface: 'admin-dashboard',
        });
        const d = added[0];
        expect(d.feature).toBe('shift');
        expect(d.action).toBe('shift.moved');
        expect(d.targetType).toBe('shift');
        expect(d.targetName).toBe('Cash shift');
        expect(d.after).toEqual({ staffName: 'Lee', date: '2026-07-02' });
    });
});

describe('best-effort posture', () => {
    it('returns null and never throws when the write fails', async () => {
        addDoc.mockImplementationOnce(async () => { throw new Error('offline'); });
        await expect(
            auditShiftChange({ shiftId: 's2', staffName: 'X', action: 'deleted' })
        ).resolves.toBeNull();
    });
});
