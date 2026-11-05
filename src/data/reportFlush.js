// reportFlush.js: sends parked reports, and the once-a-day device row.
//
// A report leaves the list when its write resolves, so a stuck line can't turn a
// lost report into silence. The one exception is the send limit below, and a report
// given up on there is recorded and carried on the daily device row. Test mode stands down: its writes go nowhere,
// so a real report would be thrown away if a test login flushed it.
//
// Sends are limited. Each one joins the SDK's durable queue ahead of staff writes,
// and a repeat the server refuses restarts the write stream, so an unlanded report
// can't go out on every boot.

import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { TEST_MODE } from './testMode';
import { logError } from './logger';
import { dismissToast, toast } from '../toast';
import { clearDroppedReports, deliveredBootLabel, markReportNotified, noteReportDropped, noteReportSent, parkReport, readDroppedReports, readParkedReports, removeParkedReport } from './pendingReports';
import { getOrCreateDeviceId } from './deviceId';
import { getReliabilityFlag } from './reliabilityFlags';
import { placeOutcome } from './placeMemory';
import { clearPushOutcomes, readPushOutcomes } from './noChangeSaves';

// Only a reload that just happened gets a message. A report delivered days
// later would describe something the person never connects to it.
export const NOTIFY_WITHIN_MS = 10 * 60 * 1000;
export const RESEND_EVERY_MS = 30 * 60 * 1000;
export const MAX_SEND_ATTEMPTS = 3;
const _sending = new Set();

const RESTARTED = {
    en: 'The app restarted to fix a stuck connection.',
    es: 'La app se reinició para arreglar la conexión.',
};
const BACK_WHERE_YOU_WERE = {
    en: "You're back where you were.",
    es: 'Estás donde estabas.',
};
const CHECK_CHANGES = {
    en: 'Check your last changes before entering them again.',
    es: 'Revisa tus últimos cambios antes de volver a ingresarlos.',
};

function _reloadLine(lang, restored) {
    return [RESTARTED[lang], restored ? BACK_WHERE_YOU_WERE[lang] : null, CHECK_CHANGES[lang]].filter(Boolean).join(' ');
}

export function reloadToastText(language, { restored = false } = {}) {
    if (language === 'es') return _reloadLine('es', restored);
    if (language === 'en') return _reloadLine('en', restored);
    return `${_reloadLine('en', restored)} / ${_reloadLine('es', restored)}`;
}

// `place` is what the screen shows now: { tab, subTab, body, msSinceBoot }. The
// "back where you were" line and the place:restored row need it and flag placeRestore.
export async function flushParkedReports({ language, place = null } = {}) {
    if (TEST_MODE) return;
    let list = readParkedReports();
    const now = Date.now();
    const toTell = [...list].reverse().find((r) => !r.notified && r.at && now - r.at < NOTIFY_WITHIN_MS);
    if (toTell) {
        // Mark first: a hung write must not bring the message back on the next boot.
        list.filter((r) => !r.notified).forEach((r) => markReportNotified(r.reportId));
        const placeOn = !!place && getReliabilityFlag('placeRestore');
        const outcome = placeOn ? placeOutcome({ reportTab: toTell.activeTab ?? null, tab: place.tab, body: place.body }) : null;
        const id = toast(reloadToastText(language, { restored: !!outcome?.restored }), {
            kind: 'warn',
            duration: 0,
            actionLabel: 'OK',
            onAction: () => dismissToast(id),
        });
        if (outcome) {
            parkReport({
                feature: 'place:restored',
                severity: 'info',
                reason: 'place-restored',
                notified: true,
                at: now,
                reloadId: toTell.reloadId || toTell.reportId,
                tab: place.tab ?? null,
                subTab: place.subTab ?? null,
                body: place.body ?? null,
                restored: outcome.restored,
                landedHome: outcome.landedHome,
                msSinceBoot: place.msSinceBoot ?? null,
            });
            list = readParkedReports();
        }
    }
    await Promise.all(list.map(async (rep) => {
        if (_sending.has(rep.reportId)) return;
        // Too soon also protects the last send: it gets its full window to land.
        if (rep.lastSentAt && now - rep.lastSentAt < RESEND_EVERY_MS) return;
        const attempts = Number(rep.attempts) || 0;
        if (attempts >= MAX_SEND_ATTEMPTS) {
            noteReportDropped(rep, now);
            removeParkedReport(rep.reportId);
            return;
        }
        _sending.add(rep.reportId);
        try {
            const { notified: _n, attempts: _a, lastSentAt: _l, feature: _f, severity: _s, ...meta } = rep;
            const landed = await logError({
                error: new Error(rep.feature || `reload-after: ${rep.reason || '?'}`),
                severity: rep.severity || 'warning',
                feature: rep.feature || 'firestoreRevive:reload-after',
                meta: { ...meta, sendAttempt: attempts + 1, deliveredBoot: deliveredBootLabel(rep) },
                parked: true,
                docId: rep.reportId,
                onIssued: () => noteReportSent(rep.reportId, now),
            });
            if (landed) removeParkedReport(rep.reportId);
        } catch { /* stays on the list for the next boot */ } finally {
            _sending.delete(rep.reportId);
        }
    }));
}

function _chicagoDay(now = new Date()) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now); }
    catch { return now.toISOString().slice(0, 10); }
}

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
let _seenSendingDay = null;

// The device list and the honest denominator. It's also the only way to spot a
// quiet iPad, which error rows can't. On native it joins this ID to Capgo's,
// which is how iOS versions get matched up.
//
// Its own collection, not error_logs: about 60 rows a day would crowd the error
// page's window and the health checks' limit, and the logger's redaction corrupts
// some UUIDs, while these IDs have to stay exact. Nothing waits on this, a hung
// write only leaves today unmarked, and it can't stack up behind itself.
export async function logDeviceSeenOncePerDay({ staffName, now = new Date() } = {}) {
    if (TEST_MODE) return;
    const day = _chicagoDay(now);
    const KEY = 'ddmau:deviceSeenDay';
    try { if (localStorage.getItem(KEY) === day) return; } catch { /* still log */ }
    if (_seenSendingDay === day) return;
    _seenSendingDay = day;
    try {
        const deviceId = getOrCreateDeviceId();
        let capgoDeviceId = null;
        try {
            if (window.Capacitor?.isNativePlatform?.()) {
                const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
                const res = await Promise.race([CapacitorUpdater.getDeviceId(), new Promise((r) => setTimeout(() => r(null), 2000))]);
                capgoDeviceId = res?.deviceId || null;
            }
        } catch { /* older binary: join later */ }
        let screenSize = null;
        try { screenSize = `${window.screen.width}x${window.screen.height}`; } catch { /* labels only */ }
        const docId = `seen_${String(deviceId).replace(/[^A-Za-z0-9_-]/g, '')}_${day}`;
        const dropped = readDroppedReports();
        const pushOutcomes = readPushOutcomes();
        await setDoc(doc(db, 'device_seen', docId), {
            day,
            deviceId,
            capgoDeviceId,
            screenSize,
            signedIn: staffName || null,
            appVersion: APP_VERSION,
            at: serverTimestamp(),
            ...(dropped.entries.length || dropped.overflow
                ? { droppedReports: dropped.entries, droppedReportsOverflow: dropped.overflow }
                : {}),
            ...(Object.keys(pushOutcomes).length ? { pushOutcomes } : {}),
        });
        clearDroppedReports(dropped);
        clearPushOutcomes(pushOutcomes);
        // Only now: a failed or hung write gets another try.
        try { localStorage.setItem(KEY, day); } catch { /* the same ID just rewrites */ }
    } catch (e) {
        console.warn('[reportFlush] device row not written:', e?.message || e);
    } finally {
        _seenSendingDay = null;
    }
}
