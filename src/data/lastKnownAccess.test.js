import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_KEYS, LAST_KNOWN_ACCESS_KEY, MAX_SAVED_PEOPLE, effectiveStaffRecord, pickAccessFields, readLastKnownAccess, saveLastKnownAccess } from './lastKnownAccess';

beforeEach(() => localStorage.clear());

const real = {
    id: 77, name: 'New Hire', role: 'Prep', location: 'webster', opsAccess: true, recipesAccess: false,
    canCountMoney: true, canViewClockedIn: false, shiftLead: true, hiddenPages: ['menu'], canViewOnboarding: false,
    pin: '1234', fcmTokens: ['tok'], phone: '555', payRate: 20, lastSignInAt: 1,
};

describe('saved access', () => {
    it('allows exactly these keys', () => {
        expect([...ACCESS_KEYS]).toEqual([
            'id', 'role', 'location', 'opsAccess', 'recipesAccess', 'canCountMoney',
            'canViewClockedIn', 'shiftLead', 'hiddenPages', 'canViewOnboarding',
        ]);
    });

    it('never stores pin, fcmTokens or anything else', () => {
        saveLastKnownAccess(real);
        const raw = localStorage.getItem(LAST_KNOWN_ACCESS_KEY);
        for (const word of ['pin', 'fcmTokens', '1234', 'tok', 'phone', 'payRate', 'lastSignInAt']) expect(raw).not.toContain(word);
        expect(Object.keys(readLastKnownAccess('New Hire')).sort()).toEqual([...ACCESS_KEYS].sort());
    });

    it('filters on the way out too, so a bad stored record can not widen it', () => {
        localStorage.setItem(LAST_KNOWN_ACCESS_KEY, JSON.stringify({ X: { at: 1, access: { id: 5, pin: '9', fcmTokens: ['t'] } } }));
        expect(readLastKnownAccess('X')).toEqual({ id: 5 });
        expect(pickAccessFields({ pin: '1' })).toEqual({});
    });

    it('holds only people saved here, capped, oldest going first', () => {
        expect(readLastKnownAccess('Nobody')).toBe(null);
        for (let i = 0; i <= MAX_SAVED_PEOPLE; i += 1) saveLastKnownAccess({ name: `P${i}`, id: i }, 1000 + i);
        expect(readLastKnownAccess('P0')).toBe(null);
        expect(readLastKnownAccess(`P${MAX_SAVED_PEOPLE}`)).toEqual({ id: MAX_SAVED_PEOPLE });
    });

    it('a broken store reads as nothing and never throws', () => {
        localStorage.setItem(LAST_KNOWN_ACCESS_KEY, '{not json');
        expect(readLastKnownAccess('X')).toBe(null);
        expect(() => saveLastKnownAccess({ name: 'X', id: 1 })).not.toThrow();
    });

    it('stands down in test mode', async () => {
        vi.resetModules();
        vi.doMock('./testMode', () => ({ TEST_MODE: { name: 'T', id: 9 } }));
        const m = await import('./lastKnownAccess');
        m.saveLastKnownAccess({ name: 'T', id: 9 });
        expect(localStorage.getItem(m.LAST_KNOWN_ACCESS_KEY)).toBe(null);
        localStorage.setItem(m.LAST_KNOWN_ACCESS_KEY, JSON.stringify({ T: { at: 1, access: { id: 9 } } }));
        expect(m.readLastKnownAccess('T')).toBe(null);
        vi.doUnmock('./testMode');
        vi.resetModules();
    });
});

describe('effectiveStaffRecord', () => {
    const builtIn = { id: 5, name: 'Old Hand', role: 'Staff', location: 'webster', opsAccess: true, color: 'red' };
    it('is the plain lookup once the roster answered', () => {
        expect(effectiveStaffRecord({ staffList: [builtIn], staffName: 'Old Hand', staffListReady: true, saved: { opsAccess: false } })).toBe(builtIn);
    });
    it('is the plain lookup with nothing saved', () => {
        expect(effectiveStaffRecord({ staffList: [builtIn], staffName: 'Old Hand', staffListReady: false, saved: null })).toBe(builtIn);
        expect(effectiveStaffRecord({ staffList: [builtIn], staffName: 'New', staffListReady: false, saved: null })).toBe(null);
    });
    it('saved fields replace the built-in ones, including ones no longer set', () => {
        const rec = effectiveStaffRecord({ staffList: [builtIn], staffName: 'Old Hand', staffListReady: false, saved: { id: 5, role: 'Manager' } });
        expect(rec).toEqual({ id: 5, name: 'Old Hand', role: 'Manager', color: 'red' });
    });
    it('stands alone for someone not on the built-in list', () => {
        expect(effectiveStaffRecord({ staffList: [builtIn], staffName: 'New', staffListReady: false, saved: { id: 99, opsAccess: true } }))
            .toEqual({ name: 'New', id: 99, opsAccess: true });
    });
});
