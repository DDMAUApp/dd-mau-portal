// Test mode: owner PIN re-confirm, owner access, boot order, print guards.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const ROSTER = [
    { id: 40, name: 'Andrew Shih', pin: '1111', fcmTokens: [{ token: 'real-push-token' }] },
    { id: 41, name: 'Julie Shih', pin: '2222' },
    { id: 55, name: 'Laura Hurtado', pin: '3333', role: 'Asst Manager' },
    { id: 56, name: 'Nine Thousand', pin: '9000' },   // a real PIN in the fake range
    { id: 77, name: 'Bryan Test', pin: '4444', testMode: true },
];

function setTestMode(on) {
    localStorage.clear();
    sessionStorage.clear();
    if (on) {
        localStorage.setItem('ddmau:testMode', JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1' }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 't1');
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
        const chatQueries = [];
        vi.doMock('../firebase', () => ({ db: {} }));
        vi.doMock('@firebase/firestore', () => ({
            collection: vi.fn((...a) => ({ path: a.slice(1).join('/') })),
            documentId: vi.fn(() => '__name__'),
            doc: vi.fn((...a) => ({ path: a.slice(1).join('/') })),
            query: vi.fn((c, ...cs) => { if (c.path === 'chats') { chatQueries.push(...cs.filter(Boolean)); return { path: 'chats?members' }; } return c; }),
            where: vi.fn((...w) => w), orderBy: vi.fn(), limit: vi.fn(),
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
        // Rice log rows come along whole, new fields included.
        expect(calls).toContain('read:rice_log');
        expect(calls).toContain('get:config/recipes');
        const bryan = calls.patched.list.find((s) => s.name === 'Bryan Test');
        expect(bryan).toMatchObject({ canViewOnboarding: true, opsAccess: true, canEditScheduleFOH: true, hiddenPages: [] });
        expect(calls.patched.list.find((s) => s.name === 'Laura Hurtado').opsAccess).toBeUndefined();
        // No real PIN survives in the test copy (an owner's PIN on screen would
        // be a real owner login after Exit); fake PINs stay unique 4 digits.
        const pins = calls.patched.list.filter((s) => s.name !== 'Bryan Test').map((s) => s.pin);
        for (const real of ROSTER.map((s) => s.pin)) expect(pins).not.toContain(real);
        expect(new Set(pins).size).toBe(pins.length);
        // The tester keeps their own PIN (Recipes re-asks for it).
        expect(calls.patched.list.find((s) => s.name === 'Bryan Test').pin).toBe('4444');
        pins.forEach((p) => expect(p).toMatch(/^\d{4}$/));
        expect(calls.patched.list.some((s) => 'fcmTokens' in s)).toBe(false);
        // Private records are never copied.
        for (const c of ['read:onboarding_hires', 'read:onboarding_applications', 'read:onboarding_invites', 'read:health_records', 'read:insurance', 'read:payroll_runs', 'read:staff_archive', 'read:pin_audits', 'read:onboarding_audits', 'read:email_intel', 'read:email_intel_corrections', 'read:sms_inbound_events', 'read:sms_delivery_logs', 'read:sms_opt_in_events', 'get:config/payroll_meta', 'get:config/payroll_roster', 'get:config/print_bridge', 'get:config/secrets']) {
            expect(calls).not.toContain(c);
        }
        // Every chat read is the tester's own (membership query), never the whole collection.
        expect(calls).not.toContain('read:chats');
        expect(chatQueries.some((w) => w[0] === 'members' && w[1] === 'array-contains' && w[2] === 'Bryan Test')).toBe(true);
        vi.doUnmock('../firebase');
        vi.doUnmock('@firebase/firestore');
        vi.doUnmock('../testmode/firestoreShim');
    });
});

describe('boot failure', () => {
    it('if the roster scrub fails, prepare throws (main.jsx then leaves test mode) and the gate stays shut', async () => {
        setTestMode(true);
        vi.resetModules();
        vi.doMock('../firebase', () => ({ db: {} }));
        vi.doMock('@firebase/firestore', () => ({
            collection: vi.fn((...a) => ({ path: a.slice(1).join('/') })),
            doc: vi.fn((...a) => ({ path: a.slice(1).join('/') })),
            documentId: vi.fn(), query: vi.fn((c) => c), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(),
            getDocs: vi.fn(async () => ({ forEach: () => {} })),
            getDoc: vi.fn(async (ref) => { if (ref.path === 'config/staff' && getDocCalls++ > 0) throw new Error('cache read failed'); return { exists: () => false, data: () => undefined }; }),
            disableNetwork: vi.fn(async () => {}),
            updateDoc: vi.fn(async () => {}),
        }));
        let getDocCalls = 0;
        const gateOpened = vi.fn();
        vi.doMock('../testmode/firestoreShim', () => ({ __openTestModeGate: gateOpened }));
        const { prepareTestMode } = await import('./testModePrefetch');
        await expect(prepareTestMode({ budgetMs: 5000 })).rejects.toThrow(/roster scrub failed/);
        expect(gateOpened).not.toHaveBeenCalled();
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
        expect(await lp.printRiceLabel({ location: 'webster', rows: [{ text: 'x', width: 1, height: 1 }] })).toMatchObject({ ok: true, testMode: true });
        expect(await lp.sendToPrinter({ ip: '10.0.0.9' }, '<xml/>')).toMatchObject({ ok: true, testMode: true });
        const { printBrotherDirect } = await import('./brotherIpp');
        expect(await printBrotherDirect({ ip: '10.0.0.8', lines: [] })).toMatchObject({ ok: true, testMode: true });
    });
});
