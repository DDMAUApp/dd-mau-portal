// pendingReports.js: forced-reload reports waiting to reach the server.
//
// A reload report is written just before the page goes away, and the line it
// needs is the one that is stuck, so it's parked and sent on a later boot. The
// old single sessionStorage slot lost reports two ways: a second reload
// overwrote the first, and closing the app wiped it. It was also removed
// before the write was even sent. This list survives a close, holds up to
// MAX_PARKED reports, and a report leaves only once its write resolves.
//
// Each report carries an ID that becomes its error_logs document ID, so sending
// one twice can't make two rows (rules refuse updates to error_logs).
//
// No firebase import: main.jsx parks crash reports with this while the SDK is
// the thing that crashed.

import { deviceShortId } from './deviceId';

export const PENDING_REPORTS_KEY = 'ddmau:pendingReloadReports';
export const LEGACY_REPORT_KEY = 'ddmau:pendingReloadReport';
const BOOT_SEQ_KEY = 'ddmau:bootSeq';
export const MAX_PARKED = 20;
export const DROPPED_REPORTS_KEY = 'ddmau:droppedReports';
export const MAX_DROPPED_KEPT = 20;

let _bootSeq = null;

/** Counts page loads on this device. Same answer for the life of the page. */
export function getBootSeq() {
    if (_bootSeq != null) return _bootSeq;
    let n = 0;
    try { n = Number(localStorage.getItem(BOOT_SEQ_KEY)) || 0; } catch { /* treat as 0 */ }
    _bootSeq = n + 1;
    try { localStorage.setItem(BOOT_SEQ_KEY, String(_bootSeq)); } catch { /* still usable in memory */ }
    return _bootSeq;
}

function _read() {
    try {
        const arr = JSON.parse(localStorage.getItem(PENDING_REPORTS_KEY) || '[]');
        return Array.isArray(arr) ? arr.filter((r) => r && typeof r === 'object' && r.reportId) : [];
    } catch { return []; }
}

function _write(list) {
    localStorage.setItem(PENDING_REPORTS_KEY, JSON.stringify(list.slice(-MAX_PARKED)));
}

function _mintId(at) {
    const rand = Math.random().toString(36).slice(2, 8);
    return `rr_${deviceShortId()}_${Number(at || Date.now()).toString(36)}_${rand}`;
}

/** Parks a report and returns its ID. Never throws. */
export function parkReport(report) {
    const reportId = report?.reportId || _mintId(report?.at);
    const entry = { ...report, reportId, reloadId: reportId, parkedBoot: getBootSeq() };
    try {
        _write([..._read(), entry]);
    } catch {
        // localStorage is full or broken. The old slot is better than nothing.
        try { sessionStorage.setItem(LEGACY_REPORT_KEY, JSON.stringify(entry)); } catch { /* best-effort */ }
    }
    return reportId;
}

function _readSlot() {
    try {
        const raw = sessionStorage.getItem(LEGACY_REPORT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* a broken slot is an empty slot */ }
    _clearSlot();
    return null;
}

function _clearSlot() {
    try { sessionStorage.removeItem(LEGACY_REPORT_KEY); } catch { /* nothing to clear */ }
}

/**
 * Everything waiting, oldest first. A report in the old slot moves onto the list
 * once. It leaves the slot only after the list really holds it, and while
 * localStorage is broken it's returned from the slot, so it still gets sent.
 */
export function readParkedReports() {
    const slot = _readSlot();
    if (!slot) return _read();
    const entry = slot.reportId
        ? slot
        : { ...slot, reportId: _mintId(slot.at), reloadId: _mintId(slot.at), parkedBoot: getBootSeq() };
    if (!slot.reportId) entry.reloadId = entry.reportId;
    const list = _read();
    if (list.some((r) => r.reportId === entry.reportId)) {
        _clearSlot();
        return list;
    }
    try {
        _write([...list, entry]);
        const after = _read();
        if (after.some((r) => r.reportId === entry.reportId)) {
            _clearSlot();
            return after;
        }
    } catch { /* still broken: the slot keeps it */ }
    // Keep the minted ID, so the next read and the eventual removal agree on it.
    try { sessionStorage.setItem(LEGACY_REPORT_KEY, JSON.stringify(entry)); } catch { /* best-effort */ }
    return [...list, entry];
}

export function removeParkedReport(reportId) {
    if (_readSlot()?.reportId === reportId) _clearSlot();
    try { _write(_read().filter((r) => r.reportId !== reportId)); } catch { /* resent next boot, and the server refuses a repeat */ }
}

function _patch(reportId, patch) {
    const slot = _readSlot();
    if (slot?.reportId === reportId) {
        try { sessionStorage.setItem(LEGACY_REPORT_KEY, JSON.stringify({ ...slot, ...patch(slot) })); } catch { /* best-effort */ }
    }
    try { _write(_read().map((r) => (r.reportId === reportId ? { ...r, ...patch(r) } : r))); } catch { /* best-effort */ }
}

/** Remembers that the person was told, so a re-send can't show the toast twice. */
export function markReportNotified(reportId) {
    _patch(reportId, () => ({ notified: true }));
}

/** Counts a send as it goes out, so a hung write still counts. */
export function noteReportSent(reportId, at = Date.now()) {
    _patch(reportId, (r) => ({ attempts: (Number(r.attempts) || 0) + 1, lastSentAt: at }));
}

// Reports given up on at the send limit, with no write ever confirmed. Most of them
// land anyway from the SDK's durable queue, but a wipe or a force-quit can lose them,
// and those are the devices this telemetry exists to count. So the loss is recorded
// here and carried on the daily device row, and silence can't read as success.
function _readDropped() {
    try {
        const v = JSON.parse(localStorage.getItem(DROPPED_REPORTS_KEY) || 'null');
        return {
            entries: Array.isArray(v?.entries) ? v.entries : [],
            overflow: Number(v?.overflow) || 0,
        };
    } catch { return { entries: [], overflow: 0 }; }
}

function _writeDropped(v) {
    try { localStorage.setItem(DROPPED_REPORTS_KEY, JSON.stringify(v)); } catch { /* best-effort */ }
}

export function readDroppedReports() {
    return _readDropped();
}

/** Records a report given up on. Never throws. */
export function noteReportDropped(report, at = Date.now()) {
    const { entries, overflow } = _readDropped();
    if (entries.some((e) => e.id === report?.reportId)) return;
    const entry = {
        id: report?.reportId || null,
        reason: report?.reason || null,
        cls: report?.cls || null,
        attempts: Number(report?.attempts) || 0,
        at,
    };
    const next = [...entries, entry];
    const extra = Math.max(0, next.length - MAX_DROPPED_KEPT);
    _writeDropped({ entries: next.slice(extra), overflow: overflow + extra });
}

/** Clears what a landed row carried. Anything added since then stays. */
export function clearDroppedReports(sent) {
    const ids = new Set((sent?.entries || []).map((e) => e.id));
    const { entries, overflow } = _readDropped();
    _writeDropped({
        entries: entries.filter((e) => !ids.has(e.id)),
        overflow: Math.max(0, overflow - (Number(sent?.overflow) || 0)),
    });
}

export function deliveredBootLabel(report, bootSeq = getBootSeq()) {
    return bootSeq - (report?.parkedBoot || 0) <= 1 ? 'next' : 'later';
}
