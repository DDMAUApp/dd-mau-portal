// pendingRescue.js — find saves that never left this device and send a COPY
// to the server so nothing is lost (2026-11-17, Andrew: "can you send
// something to that ipad or the catering page to find anything that hasn't
// saved yet or is hung").
//
// Why: the shared Maryland iPad's Firestore connection keeps wedging. A save
// goes into the SDK's local queue (IndexedDB store `mutations`, same Write
// shape the REST API takes) and never leaves; the auto-recovery reload then
// wipes the screen. Eduvijen's catering order (11/17 2:18 PM) died that way.
//
// What it does (read-only on the device, never replays anything):
//   • reads the queue straight out of IndexedDB — capped, never creates the
//     database (same safe-open rules as idbProbe.js)
//   • keeps batches stuck for 2+ min (normal saves are acked in seconds)
//   • adds any unsaved form drafts in localStorage (ddmau:*Draft*)
//   • POSTs one copy to /rescued_writes over plain REST fetch — a separate
//     connection from the wedged SDK. Doc id = day + content hash, so the same
//     stuck save is sent once, however often this runs.
// The owner/Claude reviews rescued_writes and re-enters what's real.
import { TEST_MODE } from './testMode';
import { getOrCreateDeviceId } from './deviceId';

const REST = 'https://firestore.googleapis.com/v1/projects/dd-mau-staff-app/databases/(default)/documents/rescued_writes';
export const STUCK_MIN_AGE_MS = 2 * 60 * 1000;
const READ_CAP_MS = 4000;
const SENT_KEY = 'ddmau:rescueSent';
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

function _safeClose(c) { try { c?.close(); } catch { /* gone */ } }

// → { r: 'ok' | 'absent' | 'hang' | 'error', batches: [] }
export function readQueuedWrites(idb = typeof indexedDB !== 'undefined' ? indexedDB : null, capMs = READ_CAP_MS) {
    if (!idb || typeof idb.databases !== 'function') return Promise.resolve({ r: 'absent', batches: [] });
    return new Promise((resolve) => {
        let done = false;
        const finish = (r, batches = []) => { if (!done) { done = true; clearTimeout(timer); resolve({ r, batches }); } };
        const timer = setTimeout(() => finish('hang'), capMs);
        Promise.resolve(idb.databases()).then((list) => {
            const name = (list || []).map(d => d?.name).find(n => n && /^firestore\//.test(n) && /dd-mau-staff-app/.test(n));
            if (!name) { finish('absent'); return; }
            let req;
            try { req = idb.open(name); } catch { finish('error'); return; }
            req.onupgradeneeded = (e) => { try { e.target.transaction.abort(); } catch { /* fails anyway */ } finish('absent'); };
            req.onerror = (e) => { try { e.preventDefault?.(); } catch { /* ignore */ } finish('error'); };
            req.onblocked = () => finish('error');
            req.onsuccess = () => {
                const conn = req.result;
                if (done) { _safeClose(conn); return; }
                try {
                    if (!conn.objectStoreNames.contains('mutations')) { _safeClose(conn); finish('ok'); return; }
                    const tx = conn.transaction('mutations', 'readonly');
                    const get = tx.objectStore('mutations').getAll();
                    get.onsuccess = () => { _safeClose(conn); finish('ok', Array.isArray(get.result) ? get.result : []); };
                    get.onerror = () => { _safeClose(conn); finish('error'); };
                    tx.onabort = () => { _safeClose(conn); finish('error'); };
                } catch { _safeClose(conn); finish('error'); }
            };
        }, () => finish('error'));
    });
}

export function pickStuck(batches, now = Date.now(), minAgeMs = STUCK_MIN_AGE_MS) {
    return (batches || []).filter(b => b && Number(b.localWriteTimeMs) > 0 && now - Number(b.localWriteTimeMs) >= minAgeMs);
}

// Readable one-liners: "set cateringOrders/abc (customer, items, total…)".
export function describeBatch(b) {
    return (b?.mutations || []).map((m) => {
        const name = m.update?.name || m.delete || m.transform?.document || '?';
        const path = String(name).split('/documents/')[1] || String(name);
        if (m.delete) return `delete ${path}`;
        const fields = Object.keys(m.update?.fields || {}).slice(0, 8).join(', ');
        return `${m.updateMask ? 'update' : 'set'} ${path}${fields ? ` (${fields})` : ''}`;
    });
}

// Only ABANDONED drafts (untouched 30+ min) — an order someone is still
// typing isn't news, and would be re-sent every time it changes.
export const DRAFT_MIN_AGE_MS = 30 * 60 * 1000;
export function collectDrafts(ls = typeof localStorage !== 'undefined' ? localStorage : null, now = Date.now()) {
    const out = {};
    if (!ls) return out;
    try {
        for (let i = 0; i < ls.length; i++) {
            const k = ls.key(i);
            if (!k || !/^ddmau:/.test(k) || !/draft/i.test(k)) continue;
            // Money Count keeps its count as a standing draft on purpose and
            // restores it itself — not lost work.
            if (/^ddmau:moneydraft:/i.test(k)) continue;
            // Private personal data stays on the device: job applications
            // (public form: name/phone/address) and health-record uploads.
            if (/^ddmau:(applyDraft|healthUploadDraft)/i.test(k)) continue;
            const v = ls.getItem(k);
            if (!v || v.length >= 200000) continue;
            let at = 0;
            try { const j = JSON.parse(v); at = Number(j?.savedAt || j?.at || 0); } catch { at = 0; }
            if (at && now - at < DRAFT_MIN_AGE_MS) continue;
            out[k] = v;
        }
    } catch { /* storage blocked */ }
    return out;
}

function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
}

// Main entry. Never throws; resolves to what happened (for logs/tests).
export async function rescuePendingWrites({
    staffName = null, reason = 'boot', now = Date.now(), minAgeMs = STUCK_MIN_AGE_MS,
    idb, ls = typeof localStorage !== 'undefined' ? localStorage : null,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
} = {}) {
    if (TEST_MODE || !fetchImpl) return { sent: false, why: 'disabled' };
    try {
        const q = await readQueuedWrites(idb);
        const stuck = pickStuck(q.batches, now, minAgeMs);
        const drafts = collectDrafts(ls, now);
        const draftKeys = Object.keys(drafts);
        // Healthy device, nothing pending → nothing to send. An UNREADABLE queue
        // is worth one note a day (it means saves there can't be checked).
        if (!stuck.length && !draftKeys.length && q.r !== 'hang' && q.r !== 'error') return { sent: false, why: 'nothing', r: q.r };
        const payload = JSON.stringify({ stuck, drafts });
        const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
        const id = `${day}_${(staffName || 'anon').toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${hash(payload + q.r)}`;
        let sentMap = {};
        try { sentMap = JSON.parse(ls?.getItem(SENT_KEY) || '{}') || {}; } catch { sentMap = {}; }
        if (sentMap[id]) return { sent: false, why: 'already-sent', id };
        const summary = [
            `queue: ${q.r}`,
            ...stuck.flatMap(b => describeBatch(b).map(l => `${new Date(Number(b.localWriteTimeMs)).toISOString()} ${l}`)),
            ...draftKeys.map(k => `draft ${k}`),
        ].join('\n').slice(0, 20000);
        const S = (v) => ({ stringValue: String(v ?? '') });
        const body = { fields: {
            staffName: S(staffName), reason: S(reason), at: { timestampValue: new Date(now).toISOString() },
            appVersion: S(APP_VERSION), deviceId: S((() => { try { return getOrCreateDeviceId(); } catch { return ''; } })()),
            userAgent: S(typeof navigator !== 'undefined' ? navigator.userAgent : ''),
            queue: S(q.r), stuckCount: { integerValue: String(stuck.length) },
            draftKeys: { arrayValue: { values: draftKeys.map(S) } },
            summary: S(summary), payload: S(payload.slice(0, 900000)),
            status: S('new'),
        } };
        const res = await Promise.race([
            fetchImpl(`${REST}?documentId=${encodeURIComponent(id)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
        ]);
        const ok = res && (res.ok || res.status === 409);   // 409 = this exact copy is already there
        if (ok) {
            try {
                sentMap[id] = now;
                for (const k of Object.keys(sentMap)) if (now - sentMap[k] > 7 * 864e5) delete sentMap[k];
                ls?.setItem(SENT_KEY, JSON.stringify(sentMap));
            } catch { /* ignore */ }
        }
        return { sent: !!ok, id, stuck: stuck.length, drafts: draftKeys.length, r: q.r };
    } catch (e) {
        return { sent: false, why: 'error', error: String(e?.message || e) };
    }
}

// App wiring: once ~15 s after start, then every 10 min. Returns stop().
export function startPendingRescue(getStaffName) {
    if (TEST_MODE || typeof window === 'undefined') return () => {};
    const run = (reason) => rescuePendingWrites({ staffName: getStaffName?.() || null, reason }).catch(() => {});
    const first = setTimeout(() => run('boot'), 15000);
    const second = setTimeout(() => run('boot+3m'), 3 * 60 * 1000);
    const every = setInterval(() => run('interval'), 10 * 60 * 1000);
    return () => { clearTimeout(first); clearTimeout(second); clearInterval(every); };
}
