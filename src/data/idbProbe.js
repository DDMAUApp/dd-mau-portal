// idbProbe.js: two read-only checks of the device's storage, each capped at 2s.
//
// They answer what the SDK's queue can't: when the queue is silent, is the
// storage itself hung, or is it fine and the SDK stuck on something else?
//
// The trap (blast-radius 6.1): indexedDB.open() on a name that doesn't exist
// CREATES it, and an empty database under Firestore's name would be treated as
// its real cache. So probeFirestoreDb asks databases() first, opens with no
// version, aborts any upgrade, and always closes. A connection left open would
// block the SDK's own future upgrades, so a late open is closed too.

import { TEST_MODE } from './testMode';

export const PROBE_CAP_MS = 2000;
const PRIVATE_DB = 'ddmau-idb-probe';
const PRIVATE_STORE = 'p';

function _capped(work, capMs = PROBE_CAP_MS) {
    const t0 = Date.now();
    return new Promise((resolve) => {
        let done = false;
        const finish = (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ r, ms: Date.now() - t0 });
        };
        const timer = setTimeout(() => finish('hang'), capMs);
        try { work(finish); } catch { finish('error'); }
    });
}

function _safeClose(conn) { try { conn?.close(); } catch { /* already gone */ } }

export function probePrivateDb(idb = typeof indexedDB !== 'undefined' ? indexedDB : null) {
    if (TEST_MODE || !idb) return Promise.resolve({ r: 'absent', ms: 0 });
    return _capped((finish) => {
        const req = idb.open(PRIVATE_DB, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(PRIVATE_STORE); };
        req.onerror = () => finish('error');
        req.onblocked = () => finish('error');
        req.onsuccess = () => {
            const conn = req.result;
            try {
                const tx = conn.transaction(PRIVATE_STORE, 'readonly');
                tx.objectStore(PRIVATE_STORE).count();
                tx.oncomplete = () => { _safeClose(conn); finish('ok'); };
                tx.onerror = () => { _safeClose(conn); finish('error'); };
                tx.onabort = () => { _safeClose(conn); finish('error'); };
            } catch { _safeClose(conn); finish('error'); }
        };
    });
}

export function probeFirestoreDb(idb = typeof indexedDB !== 'undefined' ? indexedDB : null) {
    if (TEST_MODE || !idb || typeof idb.databases !== 'function') return Promise.resolve({ r: 'absent', ms: 0 });
    return _capped((finish) => {
        Promise.resolve(idb.databases()).then((list) => {
            const name = (list || []).map((d) => d?.name).find((n) => n && /firestore/i.test(n));
            if (!name) { finish('absent'); return; }
            let req;
            try { req = idb.open(name); } catch { finish('error'); return; }
            req.onupgradeneeded = (e) => {
                // It vanished between the two calls. Undo, never create.
                try { e.target.transaction.abort(); } catch { /* the open fails anyway */ }
                finish('absent');
            };
            req.onerror = (e) => {
                try { e.preventDefault?.(); } catch { /* ignore */ }
                finish('error');
            };
            req.onblocked = () => finish('error');
            req.onsuccess = () => {
                const conn = req.result;
                try {
                    if (!conn.objectStoreNames.contains('mutations')) {
                        _safeClose(conn);
                        finish('ok');
                        return;
                    }
                    const tx = conn.transaction('mutations', 'readonly');
                    tx.objectStore('mutations').count();
                    tx.oncomplete = () => { _safeClose(conn); finish('ok'); };
                    tx.onerror = () => { _safeClose(conn); finish('error'); };
                    tx.onabort = () => { _safeClose(conn); finish('error'); };
                } catch { _safeClose(conn); finish('error'); }
            };
        }, () => finish('error'));
    });
}
