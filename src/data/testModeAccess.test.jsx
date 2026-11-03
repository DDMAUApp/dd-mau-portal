// Test mode: owner PIN re-confirm, owner access, boot order, print guards.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const ROSTER = [
    { id: 40, name: 'Andrew Shih', pin: '1111' },
    { id: 41, name: 'Julie Shih', pin: '2222' },
    { id: 55, name: 'Laura Hurtado', pin: '3333', role: 'Asst Manager' },
    { id: 77, name: 'Bryan Test', pin: '4444', testMode: true },
];

function setTestMode(on) {
    localStorage.clear();
    sessionStorage.clear();
    if (on) {
        localStorage.setItem('ddmau:testMode', JSON.stringify({ name: 'Bryan Test', id: 77 }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
    }
}

describe('owner PIN re-confirm', () => {
    beforeEach(() => setTestMode(false));

    it('accepts only Andrew or Julie’s PIN', async () => {
        vi.resetModules();
        const { isOwnerPin } = await import('./staff');
        expect(isOwnerPin('1111', ROSTER)).toBe(true);
        expect(isOwnerPin('2222', ROSTER)).toBe(true);
        expect(isOwnerPin('3333', ROSTER)).toBe(false);   // a manager's PIN
        expect(isOwnerPin('4444', ROSTER)).toBe(false);   // the test user's own PIN
        expect(isOwnerPin('', ROSTER)).toBe(false);
        expect(isOwnerPin('1111', null)).toBe(false);
    });

    it('the prompt confirms on an owner PIN and refuses anyone else’s', async () => {
        vi.resetModules();
        const { default: AdminPinPrompt } = await import('../components/AdminPinPrompt');
        const onConfirm = vi.fn();
        render(<AdminPinPrompt title="Turn on test mode" staffList={ROSTER} onConfirm={onConfirm} onCancel={() => {}} />);
        const input = screen.getByLabelText('Admin PIN');
        fireEvent.change(input, { target: { value: '3333' } });
        fireEvent.click(screen.getByText('Confirm'));
        expect(onConfirm).not.toHaveBeenCalled();
        expect(screen.getByText('Wrong admin PIN')).toBeInTheDocument();
        fireEvent.change(input, { target: { value: '2222' } });
        fireEvent.click(screen.getByText('Confirm'));
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });
});

describe('owner access', () => {
    it('the test user is an owner only while test mode is on', async () => {
        setTestMode(false);
        vi.resetModules();
        let staff = await import('./staff');
        expect(staff.isAdmin('Bryan Test', ROSTER)).toBe(false);

        setTestMode(true);
        vi.resetModules();
        staff = await import('./staff');
        expect(staff.isAdmin('Bryan Test', ROSTER)).toBe(true);
        expect(staff.isAdminId(77)).toBe(true);
        expect(staff.isAdmin('Laura Hurtado', ROSTER)).toBe(false);
        // Re-confirm PINs still only trust the real owners.
        expect(staff.isOwnerPin('4444', ROSTER)).toBe(false);
    });
});

describe('boot order', () => {
    it('copies data, goes offline, THEN opens the write gate; grants the test user full access locally', async () => {
        setTestMode(true);
        vi.resetModules();
        const calls = [];
        vi.doMock('../firebase', () => ({ db: {} }));
        vi.doMock('@firebase/firestore', () => ({
            collection: vi.fn((...a) => ({ path: a.slice(1).join('/') })),
            documentId: vi.fn(() => '__name__'),
            doc: vi.fn((...a) => ({ path: a.slice(1).join('/') })),
            query: vi.fn((c) => c),
            where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(),
            getDocs: vi.fn(async (q) => { calls.push(`read:${q.path}`); return { forEach: () => {} }; }),
            getDoc: vi.fn(async (ref) => {
                calls.push(`get:${ref.path}`);
                return ref.path === 'config/staff'
                    ? { exists: () => true, data: () => ({ list: ROSTER }) }
                    : { exists: () => false, data: () => undefined };
            }),
            disableNetwork: vi.fn(async () => { calls.push('OFFLINE'); }),
            updateDoc: vi.fn(async (ref, data) => { calls.push(`localWrite:${ref.path}`); calls.patched = data; }),
        }));
        const gateOpened = vi.fn(() => calls.push('GATE'));
        vi.doMock('../testmode/firestoreShim', () => ({ __openTestModeGate: gateOpened }));
        const { prepareTestMode } = await import('./testModePrefetch');
        await prepareTestMode({ budgetMs: 5000 });
        const offline = calls.indexOf('OFFLINE');
        expect(offline).toBeGreaterThan(0);
        expect(calls.slice(0, offline).every((c) => c.startsWith('read:') || c.startsWith('get:'))).toBe(true);
        expect(calls.indexOf('localWrite:config/staff')).toBeGreaterThan(offline);
        expect(calls.indexOf('GATE')).toBeGreaterThan(offline);
        expect(calls).toContain('read:shifts');
        expect(calls).toContain('get:config/recipes');
        const bryan = calls.patched.list.find((s) => s.name === 'Bryan Test');
        expect(bryan).toMatchObject({ canViewOnboarding: true, opsAccess: true, canEditScheduleFOH: true, hiddenPages: [] });
        expect(calls.patched.list.find((s) => s.name === 'Laura Hurtado').opsAccess).toBeUndefined();
        vi.doUnmock('../firebase');
        vi.doUnmock('@firebase/firestore');
        vi.doUnmock('../testmode/firestoreShim');
    });
});

describe('printing', () => {
    it('nothing reaches a printer in test mode', async () => {
        setTestMode(true);
        vi.resetModules();
        const lp = await import('./labelPrinting');
        expect(await lp.printPrepLabel({ location: 'webster', recipe: { titleEn: 'Pho' } })).toMatchObject({ ok: true, testMode: true });
        expect(await lp.printFreeText({ location: 'webster', lines: ['x'] })).toMatchObject({ ok: true, testMode: true });
        expect(await lp.testPrint({ location: 'webster' })).toMatchObject({ ok: true, testMode: true });
        expect(await lp.printRecipeIngredients({ location: 'webster', title: 'x' })).toMatchObject({ ok: true, testMode: true });
        expect(await lp.sendToPrinter({ ip: '10.0.0.9' }, '<xml/>')).toMatchObject({ ok: true, testMode: true });
        const { printBrotherDirect } = await import('./brotherIpp');
        expect(await printBrotherDirect({ ip: '10.0.0.8', lines: [] })).toMatchObject({ ok: true, testMode: true });
    });
});
