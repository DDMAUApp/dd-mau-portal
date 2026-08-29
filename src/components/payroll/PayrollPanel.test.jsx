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
    loadRunHistory: vi.fn().mockResolvedValue([]),
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

// ── 📝 Notes tab (2026-08-29) ────────────────────────────────────────────
vi.mock('../../data/payroll/payrollNotes.js', () => {
    let listeners = [];
    let notes = [];
    const emit = () => listeners.forEach((cb) => cb([...notes]));
    return {
        subscribePayrollNotes: vi.fn((cb) => { listeners.push(cb); cb([...notes]); return () => { listeners = listeners.filter((l) => l !== cb); }; }),
        addPayrollNote: vi.fn(async ({ text, byName }) => {
            notes.unshift({ id: `n${notes.length + 1}`, text, byName, createdAt: { toMillis: () => Date.now() }, done: false, doneBy: null, doneAt: null });
            emit();
            return { ok: true, id: notes[0].id };
        }),
        setPayrollNoteDone: vi.fn(async (id, done, byName) => {
            const n = notes.find((x) => x.id === id);
            if (n) { n.done = done; n.doneBy = done ? byName : null; n.doneAt = done ? { toMillis: () => Date.now() } : null; }
            emit();
            return { ok: true };
        }),
        deletePayrollNote: vi.fn(async (id) => { notes = notes.filter((x) => x.id !== id); emit(); return { ok: true }; }),
    };
});

import { fireEvent, waitFor } from '@testing-library/react';

describe('PayrollPanel notes tab', () => {
    it('adds a note with author + stamp, toggles done with strike-through', async () => {
        sessionStorage.setItem('ddmau:payrollUnlocked', '1');
        render(<PayrollPanel language="en" staffName="Andrew" staffList={OWNER} />);
        // open the Notes tab
        const tab = await screen.findByText(/📝 Notes/);
        fireEvent.click(tab);
        // add a note
        const ta = await screen.findByPlaceholderText(/Write a note or reminder/i);
        fireEvent.change(ta, { target: { value: 'Edith needs to be paid vacation pay' } });
        fireEvent.click(screen.getByText('Add'));
        const noteText = await screen.findByText('Edith needs to be paid vacation pay');
        expect(noteText).toBeTruthy();
        // author stamp
        expect(screen.getByText(/— Andrew ·/)).toBeTruthy();
        expect(noteText.className).not.toMatch(/line-through/);
        // toggle done → strike-through + done stamp
        fireEvent.click(screen.getByLabelText('Mark done'));
        await waitFor(() => expect(screen.getByText('Edith needs to be paid vacation pay').className).toMatch(/line-through/));
        expect(screen.getByText(/done by Andrew/)).toBeTruthy();
        // uncheck → line comes back off
        fireEvent.click(screen.getByLabelText('Mark not done'));
        await waitFor(() => expect(screen.getByText('Edith needs to be paid vacation pay').className).not.toMatch(/line-through/));
    });
});

describe('PayrollPanel notes popup on People & DD', () => {
    it('pops open reminders when entering People & Direct Deposit, once per session', async () => {
        sessionStorage.setItem('ddmau:payrollUnlocked', '1');
        render(<PayrollPanel language="en" staffName="Andrew" staffList={OWNER} />);
        // seed a note via the Notes tab
        fireEvent.click(await screen.findByText(/📝 Notes/));
        const ta = await screen.findByPlaceholderText(/Write a note or reminder/i);
        fireEvent.change(ta, { target: { value: 'Edith needs vacation pay' } });
        fireEvent.click(screen.getByText('Add'));
        await screen.findByText('Edith needs vacation pay');
        // enter People & DD → popup appears with the open note
        fireEvent.click(screen.getByText(/People & Direct Deposit/));
        expect(await screen.findByText(/Payroll reminders/)).toBeTruthy();
        expect(screen.getAllByText(/Edith needs vacation pay/).length).toBeGreaterThan(0);
        // close, leave, re-enter → does NOT pop again this session
        fireEvent.click(screen.getByText('Close'));
        await waitFor(() => expect(screen.queryByText(/Payroll reminders/)).toBeNull());
        fireEvent.click(screen.getByText(/📝 Notes/));
        fireEvent.click(screen.getByText(/People & Direct Deposit/));
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByText(/Payroll reminders/)).toBeNull();
    });
});
