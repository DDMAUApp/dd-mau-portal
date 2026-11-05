// The privacy promise, on the real page: only the signed-in person's confirmed
// record reaches the screen, and only after their own onboarding password.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ rows: [], listed: [], updates: [], listens: 0, testMode: null, shared: false, notified: [] }));
vi.mock('../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
    collection: () => ({ path: 'onboarding_hires' }),
    where: (f, op, v) => ({ f, v }),
    query: (_c, w) => ({ where: w }),
    doc: (_d, c, id) => ({ path: `${c}/${id}` }),
    onSnapshot: (q, cb) => {
        h.listens++;
        const rows = q.where ? h.rows.filter(r => String(r.documentsLink?.staffId) === String(q.where.v)) : h.rows;
        cb({ docs: rows.map(r => ({ id: r.id, data: () => r })) });
        return () => {};
    },
    updateDoc: vi.fn(async (ref, patch) => { h.updates.push({ path: ref.path, patch }); }),
    addDoc: vi.fn(async () => ({})),
    writeBatch: () => ({ update: (ref, patch) => h.updates.push({ path: ref.path, patch }), commit: async () => {} }),
    arrayUnion: (v) => ({ arrayUnion: v }),
    deleteField: () => 'DELETE',
    serverTimestamp: () => 'now',
}));
vi.mock('firebase/storage', () => ({
    ref: (_s, path) => ({ path }),
    listAll: vi.fn(async (r) => {
        h.listed.push(r.path);
        return { items: ['filled_100.pdf', 'filled_200.pdf'].map(name => ({ name, fullPath: `${r.path}/${name}` })) };
    }),
    getBytes: vi.fn(async () => new ArrayBuffer(0)),
}));
vi.mock('../data/testMode', () => ({ get TEST_MODE() { return h.testMode; } }));
vi.mock('../messaging', () => ({ isSharedDeviceModeEnabled: () => h.shared }));
vi.mock('../data/notify', () => ({ notifyAdmins: vi.fn(async (n) => { h.notified.push(n); }) }));
vi.mock('../toast', () => ({ toast: vi.fn() }));
vi.mock('../data/firestoreRevive', () => ({
    watchdogWrite: (p) => p,
    resilientSnapshot: (_label, attach) => attach(() => {}, () => {}),
}));
vi.mock('./OnboardingPortal', () => ({
    DocCard: ({ doc, onSetStatus, onSaveForm }) => (
        <div>
            <button onClick={() => onSetStatus(doc.id, 'started')}>fake start</button>
            <button onClick={() => onSetStatus(doc.id, 'submitted', { submittedAt: 'later' })}>fake submit</button>
            <button onClick={() => onSaveForm(doc.id, { legalName: 'New Name' })}>fake form</button>
        </div>
    ),
}));
vi.mock('./DocumentFileViewer', () => ({ default: ({ path, older }) => <div>viewing {path} {older ? 'WATERMARKED' : 'clean'}</div> }));

import DocumentsPage from './DocumentsPage';
import { hashPortalPassword } from '../data/onboardingAuth';

const ana = { id: 7, name: 'Ana Ruiz' };
const ben = { id: 8, name: 'Ben Lee' };
const link = (s) => ({ staffId: s.id, staffName: s.name });
const unlock = async (pw) => {
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: pw } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open my documents' })); });
    // The password check is real and finishes on its own time.
    await waitFor(() => expect(screen.queryByRole('alert') || screen.queryAllByText(/Personal info/)[0]).toBeTruthy());
};
const row = (name) => screen.getByRole('button', { name: new RegExp(name) });

beforeEach(async () => {
    cleanup();
    localStorage.clear();
    Object.assign(h, { listed: [], updates: [], listens: 0, testMode: null, shared: false, notified: [] });
    h.rows = [
        { id: 'hire-ana', name: 'Ana Ruiz', documentsLink: link(ana), portalAuth: await hashPortalPassword('ana-secret'), checklist: { w4_fed: { status: 'approved', employerPdfPath: 'x', employerCompletedAt: 'y' } }, subsetDocs: ['w4_fed', 'personal_info', 'offer_letter'], personal: { legalName: 'Ana Ruiz' } },
        { id: 'hire-ben', name: 'Ben Lee', documentsLink: link(ben), portalAuth: await hashPortalPassword('ben-secret'), checklist: {}, subsetDocs: ['w4_fed'] },
        { id: 'hire-unlinked', name: 'Cara Diaz', portalAuth: await hashPortalPassword('cara-secret') },
    ];
});

describe('Documents privacy', () => {
    it('asks for the password from onboarding, and shows nothing before it', async () => {
        render(<DocumentsPage staffRecord={ana} />);
        expect(screen.getByText(/password you made when you started onboarding/)).toBeTruthy();
        expect(screen.queryByText(/Personal info/)).toBe(null);
        await unlock('wrong');
        expect(screen.getByRole('alert').textContent).toBe('Wrong password.');
        expect(screen.queryByText(/Personal info/)).toBe(null);
        await unlock('ana-secret');
        expect(screen.getByText(/Personal info/)).toBeTruthy();
    });
    it("a coworker's password doesn't open it", async () => {
        render(<DocumentsPage staffRecord={ana} />);
        await unlock('ben-secret');
        expect(screen.getByRole('alert').textContent).toBe('Wrong password.');
        expect(screen.queryByText(/Personal info/)).toBe(null);
    });
    it('files come only from their own folder', async () => {
        render(<DocumentsPage staffRecord={ana} />);
        await unlock('ana-secret');
        await act(async () => { fireEvent.click(row('W-4')); });
        await waitFor(() => expect(h.listed.length).toBe(1));
        expect(h.listed[0].startsWith('onboarding/hire-ana/')).toBe(true);
    });
    it('switching people drops the unlock and the other person\'s record', async () => {
        const r = render(<DocumentsPage key="7" staffRecord={ana} />);
        await unlock('ana-secret');
        r.rerender(<DocumentsPage key="8" staffRecord={ben} />);
        expect(screen.queryByText(/Personal info/)).toBe(null);
        expect(screen.getByLabelText('Password')).toBeTruthy();
    });
    it('the same page instance handed a new person also relocks', async () => {
        const r = render(<DocumentsPage staffRecord={ana} />);
        await unlock('ana-secret');
        await act(async () => { r.rerender(<DocumentsPage staffRecord={ben} />); });
        expect(screen.queryByText(/Personal info/)).toBe(null);
    });
    it('no confirmed link: no documents, even with a matching name', () => {
        render(<DocumentsPage staffRecord={{ id: 9, name: 'Cara Diaz' }} />);
        expect(screen.getByText(/No documents on file/)).toBeTruthy();
        expect(screen.queryByLabelText('Password')).toBe(null);
    });
    it('a name that no longer matches the link: no documents', () => {
        render(<DocumentsPage staffRecord={{ id: 7, name: 'Someone New' }} />);
        expect(screen.getByText(/No documents on file/)).toBeTruthy();
    });
    it('test mode and shared iPads never even ask for the record', () => {
        h.testMode = { name: 'Test', id: 83 };
        render(<DocumentsPage staffRecord={ana} isAdmin />);
        expect(screen.getByText(/not shown in test mode/)).toBeTruthy();
        expect(h.listens).toBe(0);
        cleanup();
        h.testMode = null; h.shared = true;
        render(<DocumentsPage staffRecord={ana} />);
        expect(screen.getByText(/shared iPad/)).toBeTruthy();
        expect(h.listens).toBe(0);
    });
    it('no onboarding password: they can\'t make one without a manager', () => {
        h.rows[0].portalAuth = null;
        render(<DocumentsPage staffRecord={ana} />);
        expect(screen.getByText(/Ask a manager to let you set one/)).toBeTruthy();
        expect(screen.queryByLabelText('Password')).toBe(null);
    });
    it('the match list won\'t move a record already confirmed for someone else', async () => {
        const twin = { id: 20, name: 'Ana Ruiz' };
        render(<DocumentsPage staffRecord={ben} staffList={[twin]} isAdmin />);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Match staff' })); });
        const select = screen.getByLabelText(/Onboarding record for Ana Ruiz/);
        expect(select.value).toBe('');
        expect(screen.getByRole('button', { name: 'Confirm' }).disabled).toBe(true);
        expect(screen.getByRole('option', { name: /^Ana Ruiz.*\(taken\)/ }).disabled).toBe(true);
    });
    it('only an admin gets the match list', () => {
        render(<DocumentsPage staffRecord={ana} />);
        expect(screen.queryByRole('button', { name: 'Match staff' })).toBe(null);
    });
});

describe('Versions and resubmitting', () => {
    const openUnlocked = async (name) => {
        render(<DocumentsPage staffRecord={ana} />);
        await unlock('ana-secret');
        await act(async () => { fireEvent.click(row(name)); });
    };
    it('the older file opens watermarked, the newest clean', async () => {
        await openUnlocked('W-4');
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /OLDER VERSION/ })); });
        expect(screen.getByText(/filled_100\.pdf WATERMARKED/)).toBeTruthy();
    });
    it('starting an edit changes nothing; submitting goes back for review and tells the managers', async () => {
        await openUnlocked('W-4');
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Edit and resubmit' })); });
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'fake start' })); });
        expect(h.updates).toHaveLength(0);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'fake submit' })); });
        expect(h.updates).toHaveLength(1);
        expect(h.updates[0].path).toBe('onboarding_hires/hire-ana');
        const patch = h.updates[0].patch;
        expect(patch['checklist.w4_fed.status']).toBe('submitted');
        expect(patch['checklist.w4_fed.employerPdfPath']).toBe('DELETE');
        expect(patch['checklist.w4_fed.replacedBefore']).toBeGreaterThan(0);
        expect(patch['checklist.w4_fed']).toBeUndefined();
        expect(h.notified).toHaveLength(1);
    });
    it('adding a page to an ID marks nothing older; replacing it does', async () => {
        h.rows[0].subsetDocs = ['id_doc_1', 'personal_info'];
        h.rows[0].checklist.id_doc_1 = { status: 'submitted', submittedAt: 'x' };
        await openUnlocked('ID');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add another page' })); });
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'fake submit' })); });
        expect(h.updates[0].patch['checklist.id_doc_1.replacedBefore']).toBeUndefined();
        expect(screen.queryByText('fake submit')).toBe(null);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit and resubmit' })); });
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'fake submit' })); });
        expect(h.updates[1].patch['checklist.id_doc_1.replacedBefore']).toBeGreaterThan(0);
    });
    it('replacing a rejected document tells the managers too', async () => {
        h.rows[0].checklist.w4_fed = { status: 'rejected', note: 'blurry' };
        await openUnlocked('W-4');
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Edit and resubmit' })); });
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'fake submit' })); });
        expect(h.updates[0].patch['checklist.w4_fed.replacedBefore']).toBeGreaterThan(0);
        expect(h.notified).toHaveLength(1);
    });
    it('an edited form keeps the old answers', async () => {
        h.rows[0].checklist.personal_info = { status: 'approved' };
        await openUnlocked('Personal info');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit and resubmit' })); });
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'fake form' })); });
        const patch = h.updates[0].patch;
        expect(patch.personal).toEqual({ legalName: 'New Name' });
        expect(patch['formHistory.personal_info'].arrayUnion.values).toEqual({ legalName: 'Ana Ruiz' });
    });
    it('a signed offer letter can be read but not redone', async () => {
        h.rows[0].checklist.offer_letter = { status: 'approved' };
        await openUnlocked('Offer letter');
        expect(screen.queryByRole('button', { name: 'Edit and resubmit' })).toBe(null);
    });
});
