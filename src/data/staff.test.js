// Tests for the staff helpers — the foundation that every permission
// gate in the app depends on. These functions decide who can edit
// schedules, who's an admin, who sees onboarding PII, etc.
//
// Picked as the FIRST test file (2026-05-16) because:
//   1. Pure functions — no React, no Firebase, no DOM. Trivial setup.
//   2. Already well-defined inputs/outputs.
//   3. The IDs 40/41 (owner) check is a hot spot for the multi-tenant
//      migration — these tests pin the current behavior so we can
//      refactor safely.

import { describe, it, expect } from 'vitest';
import {
    isAdmin,
    ADMIN_IDS,
    canEditSchedule,
    canSeePage,
    canViewOnboarding,
    canReceive86Alerts,
    canViewLabor,
    getScheduleHome,
    isOnScheduleAt,
} from './staff';

const sampleStaff = [
    { id: 1, name: 'Cash Magruder', role: 'FOH', pin: '1111', location: 'webster' },
    { id: 2, name: 'Maria Lopez', role: 'Manager', pin: '2222', location: 'maryland', canEditScheduleBOH: true },
    { id: 3, name: 'Tom Lee', role: 'BOH', pin: '3333', location: 'both', scheduleHome: 'webster' },
    { id: 40, name: 'Andrew Shih', role: 'Owner', pin: '4040', location: 'both' },
    { id: 41, name: 'Julie Shih', role: 'Owner', pin: '4141', location: 'both' },
];

describe('isAdmin', () => {
    it('returns true for ADMIN_IDS owners (40, 41)', () => {
        expect(isAdmin('Andrew Shih', sampleStaff)).toBe(true);
        expect(isAdmin('Julie Shih', sampleStaff)).toBe(true);
    });

    it('returns false for non-admin staff regardless of role title', () => {
        expect(isAdmin('Cash Magruder', sampleStaff)).toBe(false);
        // "Manager" in role title alone does NOT confer admin — must be ID 40/41
        expect(isAdmin('Maria Lopez', sampleStaff)).toBe(false);
    });

    it('returns false for unknown names', () => {
        expect(isAdmin('Ghost Person', sampleStaff)).toBe(false);
    });

    it('returns false for empty/null name', () => {
        expect(isAdmin('', sampleStaff)).toBe(false);
        expect(isAdmin(null, sampleStaff)).toBe(false);
        expect(isAdmin(undefined, sampleStaff)).toBe(false);
    });

    it('ADMIN_IDS is exactly [40, 41]', () => {
        // Pin this. If we ever change ownership we want a test failure
        // to make us double-check every callsite.
        expect(ADMIN_IDS).toEqual([40, 41]);
    });
});

describe('canEditSchedule', () => {
    it('owners can edit both sides', () => {
        expect(canEditSchedule('Andrew Shih', sampleStaff, 'foh')).toBe(true);
        expect(canEditSchedule('Andrew Shih', sampleStaff, 'boh')).toBe(true);
        expect(canEditSchedule('Julie Shih', sampleStaff, 'foh')).toBe(true);
        expect(canEditSchedule('Julie Shih', sampleStaff, 'boh')).toBe(true);
    });

    it('respects per-staff canEditScheduleFOH / canEditScheduleBOH toggles', () => {
        // Maria has canEditScheduleBOH: true and no canEditScheduleFOH
        expect(canEditSchedule('Maria Lopez', sampleStaff, 'boh')).toBe(true);
        expect(canEditSchedule('Maria Lopez', sampleStaff, 'foh')).toBe(false);
    });

    it('staff without explicit edit toggles cannot edit', () => {
        expect(canEditSchedule('Cash Magruder', sampleStaff, 'foh')).toBe(false);
        expect(canEditSchedule('Cash Magruder', sampleStaff, 'boh')).toBe(false);
    });

    it('without `side` arg, returns true if staff has ANY edit toggle', () => {
        expect(canEditSchedule('Maria Lopez', sampleStaff)).toBe(true);
        expect(canEditSchedule('Cash Magruder', sampleStaff)).toBe(false);
    });
});

describe('canSeePage', () => {
    it('returns true when page is not in the staff hiddenPages array', () => {
        const staff = { name: 'Cash', hiddenPages: [] };
        expect(canSeePage(staff, 'recipes')).toBe(true);
        expect(canSeePage(staff, 'menu')).toBe(true);
    });

    it('returns false when page IS in the staff hiddenPages array', () => {
        const staff = { name: 'Cash', hiddenPages: ['recipes', 'training'] };
        expect(canSeePage(staff, 'recipes')).toBe(false);
        expect(canSeePage(staff, 'training')).toBe(false);
        expect(canSeePage(staff, 'menu')).toBe(true);
    });

    it('returns true (safe default) when staff record is missing', () => {
        // Pre-login state — don't false-negative.
        expect(canSeePage(null, 'recipes')).toBe(true);
        expect(canSeePage(undefined, 'recipes')).toBe(true);
    });

    it('treats missing hiddenPages as "nothing hidden"', () => {
        const staff = { name: 'Cash' }; // no hiddenPages key at all
        expect(canSeePage(staff, 'recipes')).toBe(true);
    });
});

describe('canViewOnboarding', () => {
    it('returns true for owners (40, 41) by default', () => {
        const owner = sampleStaff.find(s => s.id === 40);
        expect(canViewOnboarding(owner)).toBe(true);
    });

    it('returns true for staff with explicit canViewOnboarding: true', () => {
        expect(canViewOnboarding({ id: 99, canViewOnboarding: true })).toBe(true);
    });

    it('returns false for non-owner staff by default', () => {
        const cash = sampleStaff.find(s => s.name === 'Cash Magruder');
        expect(canViewOnboarding(cash)).toBe(false);
    });

    it('respects explicit canViewOnboarding: false even for owners', () => {
        const owner = sampleStaff.find(s => s.id === 40);
        expect(canViewOnboarding({ ...owner, canViewOnboarding: false })).toBe(false);
    });

    it('returns false for null/undefined input', () => {
        expect(canViewOnboarding(null)).toBe(false);
        expect(canViewOnboarding(undefined)).toBe(false);
    });
});

describe('canReceive86Alerts', () => {
    it('only fires for explicit canReceive86Alerts: true (opt-in)', () => {
        expect(canReceive86Alerts({ canReceive86Alerts: true })).toBe(true);
        expect(canReceive86Alerts({ canReceive86Alerts: false })).toBe(false);
        // Default OFF — these are operationally noisy notifications.
        expect(canReceive86Alerts({})).toBe(false);
        expect(canReceive86Alerts(null)).toBe(false);
    });
});

describe('canViewLabor', () => {
    it('returns true when explicitly set to true', () => {
        expect(canViewLabor({ viewLabor: true })).toBe(true);
    });

    it('returns false when explicitly set to false (even for managers)', () => {
        // Explicit false beats role inference — admin can suppress for
        // a specific manager.
        expect(canViewLabor({ viewLabor: false, role: 'Manager' })).toBe(false);
    });

    it('defaults to true for manager/owner roles', () => {
        expect(canViewLabor({ role: 'Manager' })).toBe(true);
        expect(canViewLabor({ role: 'Kitchen Manager' })).toBe(true);
        expect(canViewLabor({ role: 'Owner' })).toBe(true);
    });

    it('defaults to false for line staff', () => {
        expect(canViewLabor({ role: 'FOH' })).toBe(false);
        expect(canViewLabor({ role: 'BOH' })).toBe(false);
        expect(canViewLabor({ role: 'Server' })).toBe(false);
    });
});

describe('getScheduleHome', () => {
    it('returns scheduleHome when explicitly set', () => {
        expect(getScheduleHome({ scheduleHome: 'webster', location: 'both' })).toBe('webster');
        expect(getScheduleHome({ scheduleHome: 'maryland', location: 'both' })).toBe('maryland');
        expect(getScheduleHome({ scheduleHome: 'both', location: 'webster' })).toBe('both');
    });

    it('falls back to location when scheduleHome not set', () => {
        expect(getScheduleHome({ location: 'webster' })).toBe('webster');
        expect(getScheduleHome({ location: 'maryland' })).toBe('maryland');
    });

    it('ignores invalid scheduleHome values and falls back to location', () => {
        // Pin that string sanitization is enforced — protects against
        // legacy data with stale or bad scheduleHome strings.
        expect(getScheduleHome({ scheduleHome: 'invalid', location: 'webster' })).toBe('webster');
    });

    it('returns "both" when nothing is set', () => {
        expect(getScheduleHome({})).toBe('both');
        expect(getScheduleHome(null)).toBe('both');
    });
});

describe('isOnScheduleAt', () => {
    it('returns true regardless of staff config when storeLocation is "both"', () => {
        // "Both" view — managers see everyone across stores. Don't
        // filter out anyone.
        expect(isOnScheduleAt({ scheduleHome: 'webster' }, 'both')).toBe(true);
        expect(isOnScheduleAt({ scheduleHome: 'maryland' }, 'both')).toBe(true);
    });

    it('matches scheduleHome to storeLocation for single-store views', () => {
        expect(isOnScheduleAt({ scheduleHome: 'webster' }, 'webster')).toBe(true);
        expect(isOnScheduleAt({ scheduleHome: 'webster' }, 'maryland')).toBe(false);
        expect(isOnScheduleAt({ scheduleHome: 'maryland' }, 'maryland')).toBe(true);
    });

    it('scheduleHome=both staff appear at every store', () => {
        const floater = { scheduleHome: 'both' };
        expect(isOnScheduleAt(floater, 'webster')).toBe(true);
        expect(isOnScheduleAt(floater, 'maryland')).toBe(true);
    });

    it('falls back to location when scheduleHome not set', () => {
        // A single-location staff with no scheduleHome should still
        // appear at their location.
        expect(isOnScheduleAt({ location: 'webster' }, 'webster')).toBe(true);
        expect(isOnScheduleAt({ location: 'webster' }, 'maryland')).toBe(false);
    });
});
