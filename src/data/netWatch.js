// netWatch.js: notices all-or-nothing saves stuck waiting on the server.
//
// Passive wrapper on XMLHttpRequest. It records the start time and size of
// Firestore commit and batchGet requests and changes nothing about any request.
// Those are what a held line looks like from outside: the database answers in
// milliseconds, but the SDK's queue is waiting on one of these. Every other URL,
// printers above all, passes straight through without a listener.

import { TEST_MODE } from './testMode';

const WATCHED = /\/documents:(commit|batchGet)\b/;
const _open = new Map();
let _longestCommitMs = 0;
let _installed = false;

export function matchesWatchedUrl(url) {
    return WATCHED.test(String(url || ''));
}

function _bodySize(body) {
    if (body == null) return 0;
    if (typeof body === 'string') return body.length;
    return body.size ?? body.byteLength ?? null;
}

export function installNetWatch(XHR = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null) {
    if (TEST_MODE || !XHR || _installed) return false;
    _installed = true;
    const proto = XHR.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function (method, url) {
        try {
            const m = WATCHED.exec(String(url || ''));
            this.__ddmauNetKind = m ? m[1] : null;
        } catch { /* never get in the way of the request */ }
        return origOpen.apply(this, arguments);
    };
    proto.send = function (body) {
        try {
            const kind = this.__ddmauNetKind;
            if (kind) {
                const startedAt = Date.now();
                _open.set(this, { kind, startedAt, bytes: _bodySize(body) });
                this.addEventListener('loadend', () => {
                    _open.delete(this);
                    if (kind === 'commit') _longestCommitMs = Math.max(_longestCommitMs, Date.now() - startedAt);
                });
            }
        } catch { /* never get in the way of the request */ }
        try {
            return origSend.apply(this, arguments);
        } catch (e) {
            // No loadend is coming, so this entry would read as stuck forever.
            _open.delete(this);
            throw e;
        }
    };
    return true;
}

export function getNetWatchTelemetry(now = Date.now()) {
    let commitInFlight = 0;
    let oldestCommit = null;
    let oldestBatchGet = null;
    for (const req of _open.values()) {
        if (req.kind === 'commit') {
            commitInFlight += 1;
            if (!oldestCommit || req.startedAt < oldestCommit.startedAt) oldestCommit = req;
        } else if (!oldestBatchGet || req.startedAt < oldestBatchGet.startedAt) {
            oldestBatchGet = req;
        }
    }
    return {
        commitInFlight,
        oldestCommitMs: oldestCommit ? now - oldestCommit.startedAt : null,
        oldestCommitBytes: oldestCommit ? oldestCommit.bytes : null,
        oldestBatchGetMs: oldestBatchGet ? now - oldestBatchGet.startedAt : null,
        longestCommitMs: _longestCommitMs,
    };
}
