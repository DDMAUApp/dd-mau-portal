// firebase/firestore, as the app sees it (vite.config.js aliases the bare
// 'firebase/firestore' import here). Outside test mode every export is the
// real SDK function — zero behavior change.
//
// In TEST MODE (src/data/testMode.js) the network is disabled for the whole
// page (main.jsx, after the data snapshot is copied into the memory cache),
// so the SDK applies writes to its local cache — every screen updates
// instantly — and never sends them. What this shim adds:
//   • writes RESOLVE right away (offline SDK write promises only settle on a
//     server ack, which never comes — every Save button would spin forever)
//     and wait for the snapshot gate first, so nothing written during boot
//     can reach the server either,
//   • transactions run locally (the SDK refuses them offline),
//   • server-only reads fall back to the cache, and a doc that was never
//     copied reads as "doesn't exist" instead of throwing 'unavailable',
//   • enableNetwork / terminate / persistence-clearing are no-ops, so
//     nothing can ever reconnect this page.
import * as fs from '@firebase/firestore';
import { TEST_MODE } from '../data/testMode';

export * from '@firebase/firestore';

const T = !!TEST_MODE;
const noop = () => {};

let _openGate = noop;
const _gate = new Promise((resolve) => { _openGate = resolve; });
// Called by prepareTestMode() once the snapshot is in cache and the network
// is off. Before that, test-mode writes and reads wait.
export function __openTestModeGate() { _openGate(); }
export const testModeGate = _gate;

// Apply a write locally (after the gate) and resolve as soon as it is
// queued — never on a server ack.
function local(apply) {
    return _gate.then(() => {
        try {
            const p = apply();
            if (p && typeof p.catch === 'function') p.catch(noop);
        } catch (e) {
            // Same synchronous validation errors the SDK would throw
            // (bad field path, undefined value) — surface them to the caller.
            return Promise.reject(e);
        }
        return undefined;
    });
}

function missingSnapshot(ref) {
    return {
        id: ref?.id,
        ref,
        exists: () => false,
        data: () => undefined,
        get: () => undefined,
        metadata: { fromCache: true, hasPendingWrites: false, isEqual: () => false },
    };
}

async function cachedDoc(ref) {
    await _gate;
    try { return await fs.getDocFromCache(ref); } catch { return missingSnapshot(ref); }
}
async function cachedDocs(q) {
    await _gate;
    return fs.getDocsFromCache(q);
}

// update() on a missing doc is rejected by the SERVER with not-found, and
// many callers rely on that to fall back to setDoc({merge}) and create the
// doc. Offline the SDK would accept it and silently drop it from the local
// view, so test mode checks the cache first and rejects the same way.
const refKey = (ref) => ref?.path || ref?.id;
async function existsLocally(ref) {
    try { return (await fs.getDocFromCache(ref)).exists(); } catch { return false; }
}
function notFound(ref) {
    const e = new Error(`No document to update: ${refKey(ref)}`);
    e.name = 'FirebaseError';
    e.code = 'not-found';
    return e;
}
// For a batch / transaction: every update() must target a doc that exists
// at that point (in cache, or set earlier in the same batch) — else the
// whole commit fails, as on the server.
async function checkUpdates(ops) {
    const known = new Map();
    for (const [kind, ref] of ops) {
        const k = refKey(ref);
        if (kind === 'set') known.set(k, true);
        else if (kind === 'delete') known.set(k, false);
        else {
            if (!known.has(k)) known.set(k, await existsLocally(ref));
            if (!known.get(k)) throw notFound(ref);
        }
    }
}

const tSetDoc = (ref, data, options) => local(() => (options === undefined ? fs.setDoc(ref, data) : fs.setDoc(ref, data, options)));
const tUpdateDoc = (ref, ...args) => _gate.then(async () => {
    if (!(await existsLocally(ref))) throw notFound(ref);
    const p = fs.updateDoc(ref, ...args);
    if (p && typeof p.catch === 'function') p.catch(noop);
});
const tDeleteDoc = (ref) => local(() => fs.deleteDoc(ref));
const tAddDoc = (collectionRef, data) => {
    const ref = fs.doc(collectionRef);
    return local(() => fs.setDoc(ref, data)).then(() => ref);
};

function tWriteBatch(firestore) {
    const b = fs.writeBatch(firestore);
    const ops = [];
    const wrapper = {
        set: (...a) => { ops.push(['set', a[0]]); b.set(...a); return wrapper; },
        update: (...a) => { ops.push(['update', a[0]]); b.update(...a); return wrapper; },
        delete: (...a) => { ops.push(['delete', a[0]]); b.delete(...a); return wrapper; },
        commit: () => _gate.then(async () => {
            await checkUpdates(ops);
            const p = b.commit();
            if (p && typeof p.catch === 'function') p.catch(noop);
        }),
    };
    return wrapper;
}

async function tRunTransaction(firestore, updateFunction) {
    await _gate;
    const b = fs.writeBatch(firestore);
    const ops = [];
    const tx = {
        get: (ref) => cachedDoc(ref),
        set: (...a) => { ops.push(['set', a[0]]); b.set(...a); return tx; },
        update: (...a) => { ops.push(['update', a[0]]); b.update(...a); return tx; },
        delete: (...a) => { ops.push(['delete', a[0]]); b.delete(...a); return tx; },
    };
    const result = await updateFunction(tx);
    await checkUpdates(ops);
    b.commit().catch(noop);
    return result;
}

async function tCount(q) {
    const snap = await cachedDocs(q);
    return { data: () => ({ count: snap.size }) };
}

const resolved = () => Promise.resolve();

export const setDoc = T ? tSetDoc : fs.setDoc;
export const updateDoc = T ? tUpdateDoc : fs.updateDoc;
export const deleteDoc = T ? tDeleteDoc : fs.deleteDoc;
export const addDoc = T ? tAddDoc : fs.addDoc;
export const writeBatch = T ? tWriteBatch : fs.writeBatch;
export const runTransaction = T ? tRunTransaction : fs.runTransaction;
export const getDoc = T ? cachedDoc : fs.getDoc;
export const getDocFromServer = T ? cachedDoc : fs.getDocFromServer;
export const getDocs = T ? cachedDocs : fs.getDocs;
export const getDocsFromServer = T ? cachedDocs : fs.getDocsFromServer;
export const getCountFromServer = T ? tCount : fs.getCountFromServer;
export const waitForPendingWrites = T ? resolved : fs.waitForPendingWrites;
export const enableNetwork = T ? resolved : fs.enableNetwork;
export const disableNetwork = T ? resolved : fs.disableNetwork;
export const terminate = T ? resolved : fs.terminate;
export const clearIndexedDbPersistence = T ? resolved : fs.clearIndexedDbPersistence;
