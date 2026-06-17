/** @vitest-environment jsdom */
// Render smoke test for the payroll wizard. Confirms the component tree mounts
// without crashing and the owner-gate logic branches correctly — WITHOUT any
// Firestore network/writes (the store is mocked). The money correctness is
// covered by engine.test.js + the local parity harness; this guards the UI shell.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../data/payroll/payrollStore.js', () => ({
    loadPayrollMeta: vi.fn().mockResolvedValue(null),
    loadRoster: vi.fn().mockResolvedValue({ version: 1, WG: { people: {}, salary: [] }, MH: { people: {}, salary: [] } }),
    setPayrollPassword: vi.fn().mockResolvedValue(undefined),
    verifyPayrollPassword: vi.fn().mockResolvedValue(false),
    nameAliasesFromMeta: () => ({}),
    saveRoster: vi.fn().mockResolvedValue(undefined),
    saveRun: vi.fn().mockResolvedValue(undefined),
    loadLatestRunSummary: vi.fn().mockResolvedValue(null),
}));
// capacitor-bridge pulls @capacitor/core; stub it so the import graph is clean in jsdom.
vi.mock('../../capacitor-bridge', () => ({
    downloadFile: vi.fn().mockResolvedValue({ ok: true }),
    pushBackHandler: () => () => {},
    popBackHandler: () => {},
}));
vi.mock('../../toast', () => ({ toast: vi.fn() }));

import PayrollPanel from './PayrollPanel';

const OWNER = [{ id: 40, name: 'Andrew' }, { id: 41, name: 'Julie' }];

beforeEach(() => { try { sessionStorage.clear(); } catch { /* ignore */ } });
afterEach(() => cleanup());

describe('PayrollPanel shell', () => {
    it('shows owner-only for a non-owner', () => {
        render(<PayrollPanel language="en" staffName="Bob Server" staffList={[{ id: 7, name: 'Bob Server' }]} />);
        expect(screen.getByText(/owner-only/i)).toBeTruthy();
    });

    it('shows the password gate (set-password mode) for an owner with no password yet', async () => {
        render(<PayrollPanel language="en" staffName="Andrew" staffList={OWNER} />);
        // Gate heading renders immediately; set-password copy appears after meta resolves to null.
        expect(await screen.findByText(/Set a payroll password/i)).toBeTruthy();
    });

    it('skips the gate when the session is already unlocked', async () => {
        sessionStorage.setItem('ddmau:payrollUnlocked', '1');
        render(<PayrollPanel language="en" staffName="Andrew" staffList={OWNER} />);
        // No gate; lands on the wizard's first step (Import).
        expect(await screen.findByText(/Import this period's Toast files/i)).toBeTruthy();
    });
});
