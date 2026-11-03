// Test-mode Firebase shims (2026-11-03). The real SDK modules are mocked
// with spies so we can prove what does — and never does — reach them.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const never = () => new Promise(() => {});   // an offline write: never acked

vi.mock('@firebase/firestore', () => {
    const batch = () => {
        const b = { ops: [], set: vi.fn((...a) => { b.ops.push(['set', ...a]); }), update: vi.fn((...a) => { b.ops.push(['update', ...a]); }), delete: vi.fn((...a) => { b.ops.push(['delete', ...a]); }), commit: vi.fn(() => never()) };
        return b;
    };
    return {
        setDoc: vi.fn(() => never()),
        updateDoc: vi.fn(() => never()),
        deleteDoc: vi.fn(() => never()),
        addDoc: vi.fn(() => never()),
        doc: vi.fn((...a) => ({ id: a.length === 1 ? 'auto-id' : String(a[a.length - 1]), path: 'p' })),
        writeBatch: vi.fn(batch),
        runTransaction: vi.fn(() => never()),
        getDoc: vi.fn(() => never()),
        getDocFromServer: vi.fn(() => never()),
        getDocFromCache: vi.fn(async (ref) => {
            if (ref.id === 'cached') return { exists: () => true, data: () => ({ n: 1 }), id: 'cached' };
            throw Object.assign(new Error('not in cache'), { code: 'unavailable' });
        }),
        getDocs: vi.fn(() => never()),
        getDocsFromServer: vi.fn(() => never()),
        getDocsFromCache: vi.fn(async () => ({ size: 3, docs: [], forEach: () => {} })),
        getCountFromServer: vi.fn(() => never()),
        waitForPendingWrites: vi.fn(() => never()),
        enableNetwork: vi.fn(async () => {}),
        disableNetwork: vi.fn(async () => {}),
        terminate: vi.fn(async () => {}),
        clearIndexedDbPersistence: vi.fn(async () => {}),
        onSnapshot: vi.fn(() => () => {}),
    };
});
vi.mock('@firebase/storage', () => ({
    uploadBytes: vi.fn(async () => ({ real: true })),
    uploadBytesResumable: vi.fn(() => ({ real: true })),
    uploadString: vi.fn(async () => ({ real: true })),
    deleteObject: vi.fn(async () => {}),
    getDownloadURL: vi.fn(async () => 'https://real/url'),
    getBytes: vi.fn(async () => new ArrayBuffer(1)),
    getBlob: vi.fn(async () => new Blob(['x'])),
    getMetadata: vi.fn(async () => ({ real: true })),
    updateMetadata: vi.fn(async () => ({ real: true })),
    listAll: vi.fn(async () => ({ items: ['real'], prefixes: [] })),
}));
vi.mock('@firebase/functions', () => ({
    httpsCallable: vi.fn(() => vi.fn(async () => ({ data: 'real' }))),
    httpsCallableFromURL: vi.fn(() => vi.fn(async () => ({ data: 'real' }))),
}));

async function loadShims({ testMode }) {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    if (testMode) {
        localStorage.setItem('ddmau:testMode', JSON.stringify({ name: 'Bryan Test', id: 77, tab: 't1' }));
        sessionStorage.setItem('ddmau:sessionAlive', '1');
        sessionStorage.setItem('ddmau:testModeTab', 't1');
    }
    const real = await import('@firebase/firestore');
    Object.values(real).forEach((f) => f?.mockClear?.());
    return {
        real,
        fsShim: await import('./firestoreShim'),
        stShim: await import('./storageShim'),
        fnShim: await import('./functionsShim'),
        realSt: await import('@firebase/storage'),
        realFn: await import('@firebase/functions'),
    };
}

beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:test-mode-1');
    globalThis.URL.revokeObjectURL = vi.fn();
});

describe('normal app — shims are pure pass-through', () => {
    it('exports the real SDK functions unchanged', async () => {
        const { real, fsShim, stShim, fnShim, realSt, realFn } = await loadShims({ testMode: false });
        for (const k of ['setDoc', 'updateDoc', 'deleteDoc', 'addDoc', 'writeBatch', 'runTransaction', 'getDoc', 'getDocs', 'enableNetwork', 'disableNetwork', 'onSnapshot']) {
            expect(fsShim[k]).toBe(real[k]);
        }
        expect(stShim.uploadBytes).toBe(realSt.uploadBytes);
        expect(stShim.getDownloadURL).toBe(realSt.getDownloadURL);
        expect(fnShim.httpsCallable).toBe(realFn.httpsCallable);
    });
});

describe('test mode — firestore', () => {
    it('holds writes until the snapshot gate opens, then applies them locally and resolves', async () => {
        const { real, fsShim } = await loadShims({ testMode: true });
        let resolved = false;
        const p = fsShim.setDoc({ id: 'a' }, { x: 1 }).then(() => { resolved = true; });
        await new Promise((r) => setTimeout(r, 10));
        expect(real.setDoc).not.toHaveBeenCalled();   // gate closed: nothing even applied
        expect(resolved).toBe(false);
        fsShim.__openTestModeGate();
        await p;
        expect(real.setDoc).toHaveBeenCalledTimes(1);   // applied to the (offline) local cache
        expect(resolved).toBe(true);                    // and resolved without a server ack
    });

    it('update / delete / add / batch all resolve immediately after the gate', async () => {
        const { real, fsShim } = await loadShims({ testMode: true });
        fsShim.__openTestModeGate();
        await fsShim.updateDoc({ id: 'cached' }, { x: 2 });
        await fsShim.deleteDoc({ id: 'a' });
        const ref = await fsShim.addDoc({ path: 'col' }, { y: 1 });
        expect(ref.id).toBe('auto-id');
        const b = fsShim.writeBatch({});
        b.set({ id: 'b' }, { z: 1 }).update({ id: 'b' }, { z: 2 }).update({ id: 'cached' }, { z: 3 });
        await b.commit();
        expect(real.updateDoc).toHaveBeenCalled();
        expect(real.deleteDoc).toHaveBeenCalled();
        expect(real.setDoc).toHaveBeenCalled();
        expect(real.addDoc).not.toHaveBeenCalled();
    });

    it('update on a doc that doesn\'t exist rejects not-found, like the server (callers fall back to setDoc merge)', async () => {
        const { real, fsShim } = await loadShims({ testMode: true });
        fsShim.__openTestModeGate();
        await expect(fsShim.updateDoc({ id: 'never-copied' }, { x: 1 })).rejects.toMatchObject({ code: 'not-found' });
        expect(real.updateDoc).not.toHaveBeenCalled();
        const b = fsShim.writeBatch({});
        b.set({ id: 'n1' }, { a: 1 }).update({ id: 'missing' }, { a: 2 });
        await expect(b.commit()).rejects.toMatchObject({ code: 'not-found' });
        expect(real.writeBatch.mock.results.at(-1).value.commit).not.toHaveBeenCalled();
        await expect(fsShim.runTransaction({}, async (tx) => { tx.update({ id: 'missing' }, { a: 1 }); })).rejects.toMatchObject({ code: 'not-found' });
    });

    it('transactions run locally on the cache (the SDK refuses them offline)', async () => {
        const { real, fsShim } = await loadShims({ testMode: true });
        fsShim.__openTestModeGate();
        const out = await fsShim.runTransaction({}, async (tx) => {
            const snap = await tx.get({ id: 'cached' });
            tx.update({ id: 'cached' }, { n: snap.data().n + 1 });
            return 'done';
        });
        expect(out).toBe('done');
        expect(real.runTransaction).not.toHaveBeenCalled();
        const batch = real.writeBatch.mock.results.at(-1).value;
        expect(batch.update).toHaveBeenCalledWith({ id: 'cached' }, { n: 2 });
        expect(batch.commit).toHaveBeenCalled();
    });

    it('reads come from the cache; a never-copied doc reads as missing instead of throwing', async () => {
        const { real, fsShim } = await loadShims({ testMode: true });
        fsShim.__openTestModeGate();
        expect((await fsShim.getDoc({ id: 'cached' })).exists()).toBe(true);
        const missing = await fsShim.getDoc({ id: 'never-copied' });
        expect(missing.exists()).toBe(false);
        expect(missing.data()).toBe(undefined);
        expect((await fsShim.getDocFromServer({ id: 'cached' })).exists()).toBe(true);
        expect((await fsShim.getDocs({})).size).toBe(3);
        expect((await fsShim.getCountFromServer({})).data().count).toBe(3);
        expect(real.getDoc).not.toHaveBeenCalled();
        expect(real.getDocFromServer).not.toHaveBeenCalled();
        expect(real.getDocs).not.toHaveBeenCalled();
    });

    it('can never reconnect or wipe anything', async () => {
        const { real, fsShim } = await loadShims({ testMode: true });
        await fsShim.enableNetwork({});
        await fsShim.waitForPendingWrites({});
        await fsShim.terminate({});
        await fsShim.clearIndexedDbPersistence({});
        expect(real.enableNetwork).not.toHaveBeenCalled();
        expect(real.waitForPendingWrites).not.toHaveBeenCalled();
        expect(real.terminate).not.toHaveBeenCalled();
        expect(real.clearIndexedDbPersistence).not.toHaveBeenCalled();
    });
});

describe('test mode — storage + functions', () => {
    it('uploads stay in memory and still show; deletes are no-ops', async () => {
        const { stShim, realSt } = await loadShims({ testMode: true });
        const ref = { fullPath: 'chat_media/x.jpg', name: 'x.jpg' };
        const res = await stShim.uploadBytes(ref, new Blob(['img'], { type: 'image/jpeg' }));
        expect(res.metadata.contentType).toBe('image/jpeg');
        expect(await stShim.getDownloadURL(ref)).toBe('blob:test-mode-1');
        await stShim.deleteObject(ref);
        expect(realSt.uploadBytes).not.toHaveBeenCalled();
        expect(realSt.deleteObject).not.toHaveBeenCalled();
        // An existing (real) file still loads from the bucket.
        expect(await stShim.getDownloadURL({ fullPath: 'real/old.jpg' })).toBe('https://real/url');
    });

    it('private documents (hire paperwork, applications, health) never open', async () => {
        const { stShim, realSt } = await loadShims({ testMode: true });
        for (const p of ['onboarding/h1/w4/w4.pdf', 'applications/a1/resume.pdf', 'health/55/hepA.jpg']) {
            await expect(stShim.getDownloadURL({ fullPath: p })).rejects.toMatchObject({ code: 'storage/unauthorized' });
            await expect(stShim.getBytes({ fullPath: p })).rejects.toMatchObject({ code: 'storage/unauthorized' });
            await expect(stShim.getBlob({ fullPath: p })).rejects.toMatchObject({ code: 'storage/unauthorized' });
        }
        expect((await stShim.listAll({ fullPath: 'onboarding/h1' })).items).toEqual([]);
        expect(realSt.getDownloadURL).not.toHaveBeenCalledWith({ fullPath: 'onboarding/h1/w4/w4.pdf' });
    });

    it('resumable uploads report 100% and complete', async () => {
        const { stShim, realSt } = await loadShims({ testMode: true });
        const task = stShim.uploadBytesResumable({ fullPath: 'v.mp4', name: 'v.mp4' }, new Blob(['v']));
        const seen = [];
        await new Promise((resolve) => task.on('state_changed', (s) => seen.push(s.bytesTransferred / s.totalBytes), null, resolve));
        expect(seen).toEqual([1]);
        expect((await task).state).toBe('success');
        expect(realSt.uploadBytesResumable).not.toHaveBeenCalled();
    });

    it('only read-only AI callables reach the server', async () => {
        const { fnShim, realFn } = await loadShims({ testMode: true });
        realFn.httpsCallable.mockClear();
        await expect(fnShim.httpsCallable({}, 'validateOnboardingInvite')({})).rejects.toMatchObject({ code: 'functions/test-mode' });
        expect(realFn.httpsCallable).not.toHaveBeenCalled();
        expect((await fnShim.httpsCallable({}, 'aiSearch')({ q: 'pho' })).data).toBe('real');
        // Menu import uploads stay on the device — the server can't read them.
        await expect(fnShim.httpsCallable({}, 'aiExtractMenu')({})).rejects.toMatchObject({ code: 'functions/test-mode' });
    });
});
