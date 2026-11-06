// riceLog.js — Fried Rice Rice batches: the log behind the stickers.
//
// Andrew 2026-11-02: the health department wants a log for the rice that
// becomes fried rice, 6-7 batches a day. Rebuilt 2026-11-03 on two routes,
// picked by which print button the cook taps:
//   • For Today   (route 'time_control'): 4-hour time control, FDA 2005
//     3-501.19. Served or tossed by the toss time. Never goes in a fridge.
//   • For the Fridge (route 'cooling'): 70F by +2h, 41F by +6h, 3-501.14. Goes
//     in the walk-in and cools overnight if it has to (owner's call). The
//     opener probes in the morning: above 41F, toss. Readings nobody took stay
//     blank and are never filled in later.
// The sticker layouts and deadlines live in riceSticker.js (pure).
//
// /rice_log/{autoId}: one doc per batch. Rows from before 2026-11-03 have no
// schemaVersion or route, and they still read and close correctly here. The
// fields old builds need (cookedAt, fridgeByAt, tossByAt) are still written,
// and fridgeByAt is never shown. Status 'cooling' means open on either route.
// Never hard-deleted: "printed by mistake" is a soft delete (deletedAt) that
// keeps the document, and the batch number stays used. firestore.rules blocks
// the rest, but rules can't check who someone is, so role limits (shift lead
// and above) are enforced by the app, here and in the screens.
//
// A reading below 135F is its own write-once doc in the same collection
// (recordType 'low_reading'), logged the moment it's taken, so it stays on the
// record even if nobody ever finishes the batch. It has no cookDay or status,
// so old builds' lists never see it.
//
// Not built on purpose (owner's plan, later phases): lock-screen Rice Out,
// 3:30/4:00 banners, server alarms and reminders, COOLED and PULLED stickers,
// date-range export, any county form.

import { db } from '../firebase';
import {
    collection, query, where, onSnapshot, doc,
    setDoc as _fsSetDoc, updateDoc as _fsUpdateDoc, arrayUnion, increment, serverTimestamp,
} from 'firebase/firestore';
import { watchdogWrite, resilientSnapshot } from './firestoreRevive';
import { printRiceLabel } from './labelPrinting';
import { TEST_MODE } from './testMode';
import {
    RICE_ROUTE_TODAY, RICE_ROUTE_FRIDGE, RICE_TOSS_HOURS, RICE_70F_HOURS,
    riceRouteDeadlines, buildRiceStickerRows, stickerDay,
} from './riceSticker';

export { RICE_ROUTE_TODAY, RICE_ROUTE_FRIDGE, RICE_TOSS_HOURS };

const setDoc = (...a) => watchdogWrite(_fsSetDoc(...a));
const updateDoc = (...a) => watchdogWrite(_fsUpdateDoc(...a));

export const RICE_LOG_COLLECTION = 'rice_log';
export const RICE_SCHEMA_VERSION = 2;
// Sticker section kind — the sticker page routes taps on this kind to the
// rice screen instead of the generic print modal.
export const RICE_BATCH_KIND = 'rice_batch';
// A below-135F reading's own doc in this collection.
export const RICE_LOW_READING = 'low_reading';

// The temperature wheel. It opens here at both stores (Andrew's number). It
// isn't a reading, and it's never saved unless the cook touches the wheel.
export const RICE_WHEEL_START_F = 200;
export const RICE_WHEEL_MAX_F = 212;
export const RICE_WHEEL_MIN_F = 100;

export const RICE_MIN_START_F = 135;    // below this at the start: no sticker
export const RICE_MAX_70F = 70;
export const RICE_MAX_41F = 41;
export const RICE_MAX_COPIES = 4;
// For Today only, and each one flags the row. Owner raised it from 10 minutes to an
// hour on 2026-11-05: the 135F+ probe still has to pass.
export const RICE_MAX_LATE_MINUTES = 60;
export const RICE_OPEN_WINDOW_MIN = 10;      // any staff may edit or delete inside this
export const RICE_UNDO_MS = 15000;           // All Gone / Tossed hold their write this long
export const RICE_AFTER_DELETE_FLAG_MIN = 30;
export const RICE_OLDER_LINE_MIN = 90;       // rice screen's older-batches line; adjust after the pilot
const RICE_ATTEMPT_TTL_MS = 30 * 60000;      // a low reading stays with the next start this long

export const RICE_STATUS = Object.freeze({
    COOLING: 'cooling',     // open on either route
    FRIDGE: 'fridge',       // in the walk-in. Still open on a Fridge batch; final on an old row
    USED: 'used',
    TOSSED: 'tossed',
    UNKNOWN: 'unknown',     // "Don't know, or used late"
    VOID: 'void',           // old builds' misprint. New code soft-deletes instead
});

const HOUR = 3600000;
const MINUTE = 60000;
const clip = (s, n) => String(s ?? '').slice(0, n);
const who = (name) => clip(name || 'unknown', 60);
const timeMs = (iso) => {
    const t = new Date(iso ?? NaN).getTime();
    return Number.isNaN(t) ? null : t;
};

export const riceDayStr = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const riceStoreLabel = (loc) => (loc === 'maryland' ? 'Maryland Heights' : 'Webster Groves');

// ── Reading a row, old or new ───────────────────────────────────────
export const riceMadeAt = (row) => row?.madeAt || row?.cookedAt || '';
export const isRiceFridgeRoute = (row) => row?.route === RICE_ROUTE_FRIDGE;
export const isRiceDeleted = (row) => !!row?.deletedAt;

// Open = still needs someone to say how it ended. An old row's 'fridge' was
// final, so only a Fridge-route batch stays open in the walk-in.
export function isRiceOpen(row) {
    if (!row || isRiceDeleted(row)) return false;
    if (row.status === RICE_STATUS.COOLING) return true;
    return row.status === RICE_STATUS.FRIDGE && isRiceFridgeRoute(row);
}

// When the row was created: the earlier of the server time and the device
// stamp written with it. A row printed offline can reach the server hours
// later, and that must not reopen its 10-minute window. Old rows have only the
// server time, and a row still queued offline only the device stamp. Last
// comes its made time.
export function riceCreatedMs(row) {
    const c = row?.createdAt;
    let server = null;
    if (c && typeof c.toMillis === 'function') server = c.toMillis();
    else if (c && typeof c.seconds === 'number') server = c.seconds * 1000;
    const device = Number.isFinite(row?.createdMs) ? row.createdMs : null;
    if (server != null && device != null) return Math.min(server, device);
    if (server != null) return server;
    if (device != null) return device;
    const made = Date.parse(riceMadeAt(row));
    return Number.isNaN(made) ? 0 : made;
}

const insideOpenWindow = (row, now) => now.getTime() - riceCreatedMs(row) <= RICE_OPEN_WINDOW_MIN * MINUTE;

// What the batch needs from someone right now. Finished rows return their
// status. Open rows return one of:
//   'ok'         For Today (or an old row), before the toss time
//   'tossNow'    For Today (or an old row), past the toss time
//   'cooling'    Fridge batch out of the walk-in, before 70F BY
//   'past70'     Fridge batch still not in the walk-in, past 70F BY
//   'inFridge'   Fridge batch in the walk-in, day it was made
//   'morning'    Fridge batch on a later day, on or before its use-by
//   'pastUseBy'  Fridge batch past its use-by: toss it
export function riceBatchState(row, now = new Date()) {
    if (!row) return 'ok';
    if (isRiceDeleted(row)) return 'deleted';
    if (!isRiceOpen(row)) return row.status;
    if (isRiceFridgeRoute(row)) {
        const today = riceDayStr(now);
        if (row.useByDay && today > row.useByDay) return 'pastUseBy';
        if (row.cookDay && today > row.cookDay) return 'morning';
        if (row.status === RICE_STATUS.FRIDGE) return 'inFridge';
        return now.getTime() >= new Date(row.seventyByAt).getTime() ? 'past70' : 'cooling';
    }
    return now.getTime() >= new Date(row.tossByAt).getTime() ? 'tossNow' : 'ok';
}

// The "I saw it gone in time" answer. Rows before closeAnswer existed have
// only closedLate.
export function riceSawGone(row) {
    return row?.status === RICE_STATUS.USED && !!row.closedLate
        && (!row.closeAnswer || row.closeAnswer === 'saw_gone');
}

// Logged as used up at or after the toss time with nobody answering "I saw it
// gone in time": an edit, a stale screen, or an old build. Read from the
// timestamps, so all three are caught.
function riceUsedLate(row) {
    if (row?.status !== RICE_STATUS.USED || isRiceFridgeRoute(row) || riceSawGone(row)) return false;
    const used = timeMs(row.usedAt);
    const toss = timeMs(row.tossByAt);
    return used != null && toss != null && used >= toss;
}

// A Fridge batch not in the walk-in at `when` (ms), past its 70F time.
function riceMissed70(row, when) {
    if (!isRiceFridgeRoute(row) || row.fridgedAt || when == null) return false;
    const by = timeMs(row.seventyByAt);
    return by != null && when >= by;
}

// Typed readings over a limit, past that limit's time. Lateness goes by when it
// was tapped in, if that's later than the time typed, so back-dating a high
// reading can't dodge the flag.
function riceLateReadings(row) {
    if (!isRiceFridgeRoute(row) || !Array.isArray(row.readings)) return { over70: null, over41: null };
    const past = (r, by) => {
        const t = Math.max(timeMs(r.at) ?? -Infinity, timeMs(r.enteredAt) ?? -Infinity);
        const b = timeMs(by);
        return t > -Infinity && b != null && t >= b;
    };
    const over41 = row.readings.find((r) => r.tempF > RICE_MAX_41F && past(r, row.fortyOneByAt)) || null;
    const over70 = row.readings.find((r) => r !== over41 && r.tempF > RICE_MAX_70F && past(r, row.seventyByAt)) || null;
    return { over70, over41 };
}

// Past its limit: left open past the deadline, closed as a miss, a reading over
// its limit, or nobody knows. Tossing on time isn't a miss, and neither is "I
// saw it gone in time".
export function ricePastLimit(row, now = new Date()) {
    if (!row || isRiceDeleted(row) || row.status === RICE_STATUS.VOID) return false;
    if (row.status === RICE_STATUS.UNKNOWN) return true;
    const { over70, over41 } = riceLateReadings(row);
    if (over70 || over41) return true;
    if (row.status === RICE_STATUS.TOSSED) {
        return ['past_4h', 'past_70f', 'past_use_by', 'morning_above_41'].includes(row.tossReason);
    }
    if (row.status === RICE_STATUS.USED) return riceUsedLate(row) || riceMissed70(row, timeMs(row.usedAt));
    if (!isRiceOpen(row)) return false;
    const state = riceBatchState(row, now);
    return state === 'tossNow' || state === 'pastUseBy' || riceMissed70(row, now.getTime());
}

// Numbers two devices both picked. Void and deleted rows don't count.
export function duplicateBatchNumbers(rows) {
    const seen = new Map();
    for (const r of rows || []) {
        if (!r || r.status === RICE_STATUS.VOID || isRiceDeleted(r)) continue;
        seen.set(r.batchNo, (seen.get(r.batchNo) || 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([no]) => no));
}

// One past the highest logged today. Voided and deleted rows still hold
// their number, so a number is never reused.
export function nextBatchNo(rows) {
    let max = 0;
    for (const r of rows || []) {
        const n = Number(r?.batchNo);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
}

// ── New rows ────────────────────────────────────────────────────────
function startFields({ madeAt, route, location, cookedBy, batchNo, startTempF, startAttempts, lowReadingIds, startSetBy, timeSource, minutesLate, pans }) {
    const d = riceRouteDeadlines(route, madeAt);
    const iso = (x) => x.toISOString();
    return {
        schemaVersion: RICE_SCHEMA_VERSION,
        route,
        location,
        cookDay: riceDayStr(madeAt),
        batchNo,
        madeAt: iso(madeAt),
        // Old builds and the create rule read these two names. A Fridge
        // batch's "toss" for an old build is its 41F deadline. This app never
        // shows either one for a Fridge batch, or shows fridgeByAt at all.
        cookedAt: iso(madeAt),
        fridgeByAt: iso(new Date(madeAt.getTime() + RICE_70F_HOURS * HOUR)),
        tossByAt: iso(route === RICE_ROUTE_FRIDGE ? d.fortyOneByAt : d.tossByAt),
        ...(route === RICE_ROUTE_FRIDGE
            ? { seventyByAt: iso(d.seventyByAt), fortyOneByAt: iso(d.fortyOneByAt), useByDay: d.useByDay }
            : { wokByAt: iso(d.wokByAt) }),
        timeSource,
        minutesLate,
        startTempF: Number.isFinite(startTempF) ? startTempF : null,
        startAttempts: Array.isArray(startAttempts) ? startAttempts : [],
        ...(Array.isArray(lowReadingIds) && lowReadingIds.length ? { lowReadingIds } : {}),
        ...(startSetBy ? { startSetBy } : {}),
        cookedBy: who(cookedBy),
        pans: Math.max(1, Math.min(RICE_MAX_COPIES, Math.floor(Number(pans) || 1))),
        stickerCount: 0,
        prints: [],
        notes: '',
        createdMs: Date.now(),
        createdAt: serverTimestamp(),
    };
}

// A batch that got a sticker and is now open.
export function buildRiceBatchDoc({
    madeAt, route = RICE_ROUTE_TODAY, location, cookedBy, batchNo,
    startTempF, startAttempts, lowReadingIds, startSetBy, timeSource = 'now', minutesLate = 0, pans = 1,
}) {
    return {
        ...startFields({ madeAt, route, location, cookedBy, batchNo, startTempF, startAttempts, lowReadingIds, startSetBy, timeSource, minutesLate, pans }),
        status: RICE_STATUS.COOLING,
    };
}

// A batch tossed at the start, with no sticker: reading stayed below 135F
// ('below_135'), or unmarked more than 10 minutes ('no_sticker', whose time
// nobody knows, so it's stamped when found).
export function buildRiceTossedStartDoc({
    now, reason, route = RICE_ROUTE_TODAY, location, cookedBy, batchNo,
    startAttempts = [], lowReadingIds, startSetBy, pans = 1,
}) {
    const attempts = startAttempts.filter((t) => Number.isFinite(t));
    return {
        ...startFields({
            madeAt: now, route, location, cookedBy, batchNo,
            startTempF: attempts.length ? attempts[attempts.length - 1] : null,
            startAttempts: attempts,
            lowReadingIds,
            startSetBy,
            timeSource: 'now',
            minutesLate: 0,
            pans,
        }),
        ...(reason === 'no_sticker' ? { timeUnknown: true } : {}),
        status: RICE_STATUS.TOSSED,
        tossedAt: now.toISOString(),
        tossedBy: who(cookedBy),
        tossReason: reason,
    };
}

// ── Live rows ───────────────────────────────────────────────────────
// A listener that errors is dead for good, so these re-attach by themselves
// (resilientSnapshot). onRows also gets whether the rows came from the
// device's saved copy, so the screen never says "no batches" when it just
// couldn't reach the server.
function listenRiceRows(label, q, onRows, onError) {
    return resilientSnapshot(label, (onHealthy, onDead) => onSnapshot(
        q,
        { includeMetadataChanges: true },
        (snap) => {
            onHealthy();
            const rows = [];
            snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
            rows.sort((a, b) => String(riceMadeAt(a)).localeCompare(String(riceMadeAt(b))));
            // Test mode cuts the network on purpose, so every answer is "from
            // cache" and its writes never finish. Its copy is the whole story.
            onRows(rows, {
                fromCache: !TEST_MODE && !!snap.metadata?.fromCache,
                pending: !TEST_MODE && !!snap.metadata?.hasPendingWrites,
            });
        },
        (err) => {
            console.warn(`${label} subscription failed:`, err);
            onError?.(err);
            onDead(err);
        },
    ));
}

// One store's day. Two equality filters, no composite index.
export function subscribeRiceLog(location, cookDay, onRows, onError) {
    return listenRiceRows('rice_log_day', query(
        collection(db, RICE_LOG_COLLECTION),
        where('location', '==', location),
        where('cookDay', '==', cookDay),
    ), onRows, onError);
}

// Every batch still open at this store, from any day. Also no composite index
// (equalities only). Old rows' final 'fridge' status is filtered out here.
export function subscribeOpenRice(location, onRows, onError) {
    return listenRiceRows('rice_log_open', query(
        collection(db, RICE_LOG_COLLECTION),
        where('location', '==', location),
        where('status', 'in', [RICE_STATUS.COOLING, RICE_STATUS.FRIDGE]),
    ), (rows, meta) => onRows(rows.filter(isRiceOpen), meta), onError);
}

// The low readings logged at one store on one day, oldest first. They have a
// readingDay and no cookDay, so the day's batch list never sees them.
export function subscribeRiceLowReadings(location, day, onRows, onError) {
    return listenRiceRows('rice_log_low', query(
        collection(db, RICE_LOG_COLLECTION),
        where('location', '==', location),
        where('readingDay', '==', day),
    ), (rows, meta) => onRows(
        rows.slice().sort((a, b) => String(a.at).localeCompare(String(b.at))),
        meta,
    ), onError);
}

// The rice screen's older-batches line: anything overdue first, then oldest
// first. The line only has room for a few, and Fridge batches can sit open in
// the walk-in for two days, so they can't push an overdue pan out of sight. A
// For Today batch joins after 90 minutes, since the newest pan is probably
// still in use. A Fridge batch joins right away, because it needs Into Fridge.
const RICE_OVERDUE_STATES = ['tossNow', 'pastUseBy', 'past70'];
export function riceOlderOpen(openRows, now = new Date()) {
    const overdue = (r) => (RICE_OVERDUE_STATES.includes(riceBatchState(r, now)) ? 0 : 1);
    return (openRows || [])
        .filter((r) => isRiceOpen(r) && (isRiceFridgeRoute(r)
            || now.getTime() - new Date(riceMadeAt(r)).getTime() >= RICE_OLDER_LINE_MIN * MINUTE))
        .sort((a, b) => overdue(a) - overdue(b) || String(riceMadeAt(a)).localeCompare(String(riceMadeAt(b))));
}

// ── Stickers ────────────────────────────────────────────────────────
// Print a batch's sticker and add the attempt to its print history, success
// or not. Never re-sends: a timed-out job often did print, so the cook checks
// and taps Reprint themselves.
export async function printRiceSticker({ row, location, staffName, copies = 1 }) {
    const c = Math.max(1, Math.min(RICE_MAX_COPIES, Math.floor(Number(copies) || 1)));
    const res = await printRiceLabel({
        location,
        rows: buildRiceStickerRows(row),
        copies: c,
        byName: staffName,
        title: `Fried Rice Rice #${row.batchNo}`,
    }).catch((e) => ({ ok: false, error: e?.message || 'print_failed' }));
    // A job can fail partway: the Brother sends copies one at a time and says
    // which one failed.
    const printed = res.ok ? c : Math.max(0, (Number(res.copyFailed) || 1) - 1);
    const entry = {
        at: new Date().toISOString(),
        by: who(staffName),
        copies: c,
        ok: !!res.ok,
        ...(res.ok ? {} : { error: clip(res.error || 'print_failed', 80) }),
        ...(!res.ok && printed > 0 ? { copiesPrinted: printed } : {}),
    };
    updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), {
        prints: arrayUnion(entry),
        // increment(): two devices reprinting the same batch both count.
        ...(printed > 0 ? { stickerCount: increment(printed) } : {}),
    }).catch((e) => console.warn('rice_log print entry failed:', e));
    return { ...res, copiesPrinted: printed };
}

// The reply timed out but the sticker did come out: the cook says so, and
// nothing prints. `seen` keeps this apart from a reply from the printer.
export function confirmRicePrinted(row, staffName, copies = 1) {
    const c = Math.max(1, Math.min(RICE_MAX_COPIES, Math.floor(Number(copies) || 1)));
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), {
        prints: arrayUnion({ at: new Date().toISOString(), by: who(staffName), copies: c, ok: true, seen: true }),
        stickerCount: increment(c),
    });
}

// Log a new batch and print its sticker. The log write goes first and is
// never awaited before printing: kitchen Wi-Fi drops, and the sticker must
// still print. Firestore queues the row and it shows up right away. If the
// printer can't print, the row is still saved with the failure on it.
export async function startRiceBatch({
    madeAt, route, location, staffName, batchNo, copies = 1,
    startTempF, startAttempts, lowReadingIds, startSetBy, timeSource, minutesLate,
}) {
    const ref = doc(collection(db, RICE_LOG_COLLECTION));
    const data = buildRiceBatchDoc({
        madeAt, route, location, cookedBy: staffName, batchNo,
        startTempF, startAttempts, lowReadingIds, startSetBy, timeSource, minutesLate, pans: copies,
    });
    const logWrite = setDoc(ref, data).catch((e) => {
        console.warn('rice_log create failed:', e);
        return e;
    });
    const row = { id: ref.id, ...data };
    const res = await printRiceSticker({ row, location, staffName, copies });
    const logErr = await Promise.race([logWrite, new Promise((r) => setTimeout(() => r(null), 4000))]);
    return { res, id: ref.id, row, logFailed: logErr instanceof Error };
}

// A batch tossed at the start. No sticker, so nothing to wait on.
export function logRiceTossedAtStart(args) {
    const ref = doc(collection(db, RICE_LOG_COLLECTION));
    return setDoc(ref, buildRiceTossedStartDoc(args));
}

// A reading below 135F, logged as it's taken. No batch number or made time
// exists yet, so it can't be a batch row. The next start carries its id in
// lowReadingIds, and one that nothing ever points to shows on the day's log as
// a reading with no batch after it. Never awaited: nothing here stops a cook.
export function buildRiceLowReadingDoc({ now, tempF, setBy, location, staffName }) {
    return {
        recordType: RICE_LOW_READING,
        schemaVersion: RICE_SCHEMA_VERSION,
        location,
        readingDay: riceDayStr(now),
        tempF,
        at: now.toISOString(),
        by: who(staffName),
        ...(setBy ? { setBy } : {}),
        createdAt: serverTimestamp(),
    };
}

export function logRiceLowReading(args) {
    const ref = doc(collection(db, RICE_LOG_COLLECTION));
    return { id: ref.id, write: setDoc(ref, buildRiceLowReadingDoc(args)) };
}

// The batch this low reading led to, if any.
export function riceLowReadingBatch(reading, rows) {
    return (rows || []).find((r) => Array.isArray(r?.lowReadingIds) && r.lowReadingIds.includes(reading.id)) || null;
}

// "re-probed: batch #4", or that nothing followed it.
export function riceLowReadingText(reading, rows, isEs = false) {
    const batch = riceLowReadingBatch(reading, rows);
    if (!batch) return isEs ? 'ningún lote después de esta lectura' : 'no batch logged after this reading';
    if (batch.status === RICE_STATUS.TOSSED && batch.tossReason === 'below_135') {
        return isEs ? `lote #${batch.batchNo}, tirado` : `batch #${batch.batchNo}, tossed`;
    }
    return isEs ? `se midió otra vez: lote #${batch.batchNo}` : `re-probed: batch #${batch.batchNo}`;
}

// ── Closing a batch ─────────────────────────────────────────────────
// `kind`:
//   'used'     All Gone. Everything with this number is used up
//   'tossed'   Tossed. Reason from the clock
//   'saw_gone' past the toss time: "I saw it gone in time"
//   'unknown'  past the toss time: "Don't know, or used late"
// `at` is when the cook tapped, not when the undo window ended.
//
// A toss's reason comes from the deadlines at `at`, not from the row's state,
// because a correction on a closed row has no open state to read.
function riceTossReason(row, at) {
    const t = at.getTime();
    if (isRiceFridgeRoute(row)) {
        if (row.useByDay && riceDayStr(at) > row.useByDay) return 'past_use_by';
        return riceMissed70(row, t) ? 'past_70f' : 'leftover';
    }
    // An old row that went in the fridge left the 4-hour clock.
    if (row.fridgedAt) return 'leftover';
    const toss = timeMs(row.tossByAt);
    return toss != null && t >= toss ? 'past_4h' : 'leftover';
}

export function riceCloseFields(row, kind, staffName, at = new Date()) {
    const by = who(staffName);
    const iso = at.toISOString();
    if (kind === 'used') return { status: RICE_STATUS.USED, usedAt: iso, usedBy: by };
    if (kind === 'saw_gone') return { status: RICE_STATUS.USED, usedAt: iso, usedBy: by, closedLate: true, closeAnswer: 'saw_gone' };
    if (kind === 'unknown') return { status: RICE_STATUS.UNKNOWN, unknownAt: iso, unknownBy: by, closeAnswer: 'unknown' };
    return {
        status: RICE_STATUS.TOSSED,
        tossedAt: iso,
        tossedBy: by,
        tossReason: riceTossReason(row, at),
    };
}

export function closeRiceBatch(row, kind, staffName, at = new Date()) {
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), riceCloseFields(row, kind, staffName, at));
}

// ── Fridge batches ──────────────────────────────────────────────────
// A typed reading: an int in range, or null. Nothing is ever pre-filled.
export function parseRiceTemp(value) {
    if (value === '' || value == null) return null;
    const t = Math.round(Number(value));
    return Number.isFinite(t) && t >= 0 && t <= 250 ? t : null;
}

const readingEntry = (tempF, at, by, kind) => ({
    tempF, at: at.toISOString(), enteredAt: new Date().toISOString(), by: who(by), kind,
});

// The reading is optional. `at` is when it was taken.
export function riceIntoFridgeFields(staffName, { tempF = null, at = new Date(), now = new Date() } = {}) {
    return {
        status: RICE_STATUS.FRIDGE,
        fridgedAt: now.toISOString(),
        fridgedBy: who(staffName),
        ...(Number.isFinite(tempF)
            ? { fridgeTempF: tempF, readings: arrayUnion(readingEntry(tempF, at, staffName, 'fridge')) }
            : {}),
    };
}

export function markRiceIntoFridge(row, staffName, opts) {
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), riceIntoFridgeFields(staffName, opts));
}

export function addRiceReading(row, staffName, { tempF, at = new Date() }) {
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), {
        readings: arrayUnion(readingEntry(tempF, at, staffName, 'fridge')),
    });
}

// Next-morning probe. Above 41F logs the toss right then, and the screen says
// to toss it. A closed row can't go back to open, and readings are never
// overwritten, so the form repeats a high number for a yes before it gets here.
export function riceMorningFields(staffName, { tempF, at = new Date() }) {
    const over = tempF > RICE_MAX_41F;
    return {
        readings: arrayUnion(readingEntry(tempF, at, staffName, 'morning')),
        ...(over ? {
            status: RICE_STATUS.TOSSED,
            tossedAt: new Date().toISOString(),
            tossedBy: who(staffName),
            tossReason: 'morning_above_41',
        } : {}),
    };
}

export function logRiceMorningReading(row, staffName, opts) {
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), riceMorningFields(staffName, opts));
}

// Today's morning reading, once one has passed. The newest counts: a later
// re-probe above 41F closes the batch anyway.
export function riceGoodMorningReading(row, now = new Date()) {
    const taken = (Array.isArray(row?.readings) ? row.readings : []).filter((r) => r.kind === 'morning');
    const last = taken[taken.length - 1];
    if (!last || !(last.tempF <= RICE_MAX_41F)) return null;
    return riceDayStr(new Date(last.at)) === riceDayStr(now) ? last : null;
}

// ── Printed by mistake: delete ──────────────────────────────────────
// Inside 10 minutes anyone may, with one confirm. After that, shift lead or
// above with a typed reason. A batch tossed or past its limit always needs
// shift lead or above and a reason, so a delete can't erase a miss.
export function riceDeletePolicy(row, { now = new Date(), isLead = false } = {}) {
    if (!row || isRiceDeleted(row) || row.status === RICE_STATUS.VOID) {
        return { canDelete: false, needsReason: false, why: 'gone' };
    }
    const miss = row.status === RICE_STATUS.TOSSED || ricePastLimit(row, now);
    if (!miss && insideOpenWindow(row, now)) return { canDelete: true, needsReason: false, why: null };
    if (isLead) return { canDelete: true, needsReason: true, why: null };
    return { canDelete: false, needsReason: true, why: miss ? 'miss' : 'window' };
}

export function softDeleteRiceBatch(row, staffName, reason, at = new Date()) {
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), {
        deletedAt: at.toISOString(),
        deletedBy: who(staffName),
        deleteReason: clip(String(reason || '').trim() || 'Printed by mistake', 200),
    });
}

// ── Edits ───────────────────────────────────────────────────────────
// The reading, pans, how it ended and a note. Inside 10 minutes anyone may
// edit an open batch; after that, or once it's closed, shift lead or above.
// Made time and route are never editable: the sticker already printed them.
export function riceEditPolicy(row, { now = new Date(), isLead = false } = {}) {
    if (!row || isRiceDeleted(row) || row.status === RICE_STATUS.VOID) return { canEdit: false, why: 'gone' };
    if (isLead) return { canEdit: true, why: null };
    if (!isRiceOpen(row)) return { canEdit: false, why: 'closed' };
    return insideOpenWindow(row, now) ? { canEdit: true, why: null } : { canEdit: false, why: 'window' };
}

// Turn the edit form's values into the update. Blank means leave it alone.
// Every change gets its own edits[] entry: who, when, field, old and new.
// Returns { error } if a value is no good.
export function buildRiceEdit(row, draft, staffName, at = new Date()) {
    const by = who(staffName);
    const iso = at.toISOString();
    const fields = {};
    const entries = [];
    const change = (field, oldValue, newValue) => {
        entries.push({ field, old: oldValue ?? null, new: newValue ?? null, by, at: iso });
    };
    if (draft.startTempF !== undefined && draft.startTempF !== '') {
        const t = parseRiceTemp(draft.startTempF);
        if (t == null) return { error: 'reading' };
        if (t !== row.startTempF) {
            fields.startTempF = t;
            change('startTempF', row.startTempF, t);
        }
    }
    if (draft.pans !== undefined && draft.pans !== '') {
        const p = Math.floor(Number(draft.pans));
        if (!Number.isFinite(p) || p < 1 || p > RICE_MAX_COPIES) return { error: 'pans' };
        if (p !== row.pans) {
            fields.pans = p;
            change('pans', row.pans, p);
        }
    }
    if (draft.notes !== undefined) {
        const n = clip(String(draft.notes).trim(), 200);
        if (n !== (row.notes || '')) {
            fields.notes = n;
            change('notes', row.notes || '', n);
        }
    }
    if (draft.outcome && draft.outcome !== row.status) {
        Object.assign(fields, riceCloseFields(row, draft.outcome, staffName, at));
        change('status', row.status, draft.outcome);
    }
    return { fields, entries };
}

export function editRiceBatch(row, draft, staffName, at = new Date()) {
    const { error, fields, entries } = buildRiceEdit(row, draft, staffName, at);
    if (error) return Promise.reject(new Error(error));
    if (entries.length === 0) return Promise.resolve();
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), { ...fields, edits: arrayUnion(...entries) });
}

// ── A low reading waiting on the next one ───────────────────────────
// The reading itself is already logged (logRiceLowReading). This only keeps it
// with the same cook's next try on this device, so closing the screen can't
// turn a re-probe into a clean first reading. Another cook's start doesn't
// inherit it, because the batch in front of them may not be the same one. Runs
// fine with storage blocked.
const attemptsKey = (loc) => `ddmau:riceLowReadings:${loc}`;
const NO_ATTEMPTS = Object.freeze({ attempts: Object.freeze([]), ids: Object.freeze([]) });

export function loadRiceAttempts(loc, by, now = Date.now()) {
    try {
        const saved = JSON.parse(localStorage.getItem(attemptsKey(loc)) || 'null');
        if (saved && Array.isArray(saved.attempts) && saved.by === by && now - saved.at < RICE_ATTEMPT_TTL_MS) {
            return {
                attempts: saved.attempts.filter((t) => Number.isFinite(t)),
                ids: Array.isArray(saved.ids) ? saved.ids.filter((id) => typeof id === 'string') : [],
            };
        }
    } catch { /* no storage: the attempts just live on screen */ }
    return NO_ATTEMPTS;
}

export function saveRiceAttempts(loc, by, attempts, ids = [], now = Date.now()) {
    try {
        if (attempts && attempts.length) localStorage.setItem(attemptsKey(loc), JSON.stringify({ attempts, ids, by, at: now }));
        else localStorage.removeItem(attemptsKey(loc));
    } catch { /* no storage: the attempts just live on screen */ }
}

// ── Words ───────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function fmtRiceTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

// TUE 11/03 for the screen. The sticker stays in English (stickerDay).
const WEEKDAY_ES = { SUN: 'DOM', MON: 'LUN', TUE: 'MAR', WED: 'MIÉ', THU: 'JUE', FRI: 'VIE', SAT: 'SÁB' };
export function riceScreenDay(day, isEs = false) {
    const label = stickerDay(day);
    return isEs ? label.replace(/^[A-Z]{3}/, (w) => WEEKDAY_ES[w] || w) : label;
}

// TUE 11/03/2026 from a 'YYYY-MM-DD' day.
export function fmtRiceDay(day, isEs = false) {
    const label = riceScreenDay(day, isEs);
    return label ? `${label}/${String(day).slice(0, 4)}` : String(day || '');
}

// An ending recorded on a later day than the batch was made leads with the
// date, so the log never reads as if it was tossed before it was made. That's
// late for a For Today batch. A Fridge batch is meant to end on a later day.
function fmtOutcomeTime(iso, row, isEs) {
    const t = fmtRiceTime(iso);
    if (!iso || !t) return t;
    const d = new Date(iso);
    if (riceDayStr(d) === row.cookDay) return t;
    const date = `${d.getMonth() + 1}/${d.getDate()}`;
    if (isRiceFridgeRoute(row)) return `${date} ${t}`;
    return isEs ? `${date} ${t} (registrado tarde)` : `${date} ${t} (logged late)`;
}

// A reading's time as typed. Both times show when it was tapped in more than 2
// minutes later, or when a deadline falls between them, so a reading is never
// back-dated without showing it.
const RICE_READING_GAP_MIN = 2;
export function riceReadingTime(reading, row, isEs = false) {
    const typed = fmtRiceTime(reading?.at);
    const at = timeMs(reading?.at);
    const entered = timeMs(reading?.enteredAt);
    if (at == null || entered == null) return typed;
    const crossed = [row?.seventyByAt, row?.fortyOneByAt].some((by) => {
        const b = timeMs(by);
        return b != null && at < b && entered >= b;
    });
    if (Math.abs(entered - at) <= RICE_READING_GAP_MIN * MINUTE && !crossed) return typed;
    return `${typed} (${isEs ? 'anotada' : 'entered'} ${fmtRiceTime(reading.enteredAt)})`;
}

const TOSS_REASON_TEXT = {
    past_4h: [' (4-hour limit)', ' (límite de 4 horas)'],
    past_70f: [' (past its 70F time, not in the fridge)', ' (pasó su hora de 70F, no entró al refri)'],
    leftover: [' (leftover)', ' (sobrante)'],
    below_135: [' (below 135F, no sticker)', ' (bajo 135F, sin etiqueta)'],
    no_sticker: [' (unmarked over 10 minutes, no sticker)', ' (sin marcar más de 10 minutos, sin etiqueta)'],
    morning_above_41: [' (morning reading above 41F)', ' (lectura de la mañana sobre 41F)'],
    past_use_by: [' (past use-by)', ' (pasó la fecha de uso)'],
};

// How the batch ended, in plain words.
export function riceOutcomeText(row, isEs = false) {
    const tx = (en, es) => (isEs ? es : en);
    const when = (iso) => fmtOutcomeTime(iso, row, isEs);
    const name = (n) => (n ? ` — ${n}` : '');
    switch (row.status) {
        case RICE_STATUS.USED:
            if (riceSawGone(row)) {
                return `${tx('Used up, closed late: saw it gone in time. Logged', 'Se acabó, cerrado tarde: lo vi acabarse a tiempo. Registrado')} ${when(row.usedAt)}${name(row.usedBy)}`;
            }
            return `${tx('Used up, logged', 'Se acabó, registrado')} ${when(row.usedAt)}${name(row.usedBy)}`;
        case RICE_STATUS.FRIDGE:
            return `${tx('Into fridge', 'Al refri')} ${when(row.fridgedAt)}`
                + (row.fridgeTempF != null ? ` @ ${row.fridgeTempF}F` : '')
                + name(row.fridgedBy);
        case RICE_STATUS.TOSSED: {
            const reason = TOSS_REASON_TEXT[row.tossReason];
            return `${tx('Tossed', 'Tirado')} ${when(row.tossedAt)}${name(row.tossedBy)}`
                + (reason ? tx(reason[0], reason[1]) : '');
        }
        case RICE_STATUS.UNKNOWN:
            return `${tx("Don't know, or used late. Logged", 'No se sabe, o se usó tarde. Registrado')} ${when(row.unknownAt)}${name(row.unknownBy)}`;
        case RICE_STATUS.VOID:
            return `${tx('Voided (printed by mistake)', 'Anulado (impreso por error)')}${name(row.voidedBy)}`;
        default:
            return tx('Still open', 'Sigue abierto');
    }
}

// What a manager should look at on this row. dayRows lets a row see its
// neighbors: the same number twice, or a batch started right after a delete.
export function riceRowFlags(row, dayRows = [], now = new Date()) {
    const flags = [];
    const add = (code, en, es) => flags.push({ code, en, es });
    if (!row || isRiceDeleted(row) || row.status === RICE_STATUS.VOID) return flags;
    const tossedAtStart = row.status === RICE_STATUS.TOSSED && ['below_135', 'no_sticker'].includes(row.tossReason);
    const attempts = Array.isArray(row.startAttempts) ? row.startAttempts : [];

    if (row.minutesLate > 0) {
        add('late_start', `Stickered ${row.minutesLate} minutes after it came out.`, `Etiquetado ${row.minutesLate} minutos después de salir.`);
    }
    if (tossedAtStart && row.tossReason === 'below_135') {
        const seen = attempts.map((t) => `${t}F`).join(', ');
        add('below_135', `Stayed below 135F (${seen}). Tossed, no sticker.`, `Siguió bajo 135F (${seen}). Tirado, sin etiqueta.`);
    } else if (tossedAtStart) {
        add('no_sticker', 'Unmarked over 10 minutes. Tossed, no sticker.', 'Sin marcar más de 10 minutos. Tirado, sin etiqueta.');
    } else if (attempts.length > 1) {
        const first = attempts.slice(0, -1).map((t) => `${t}F`).join(', ');
        add('reprobed', `First reading ${first} was below 135F. Re-probed: ${attempts[attempts.length - 1]}F.`, `Primera lectura ${first} bajo 135F. Se midió otra vez: ${attempts[attempts.length - 1]}F.`);
    }
    if (!tossedAtStart && Number.isFinite(row.startTempF) && row.startTempF < RICE_MIN_START_F) {
        add('reading_low', `Reading on this row is below 135F (${row.startTempF}F).`, `La lectura de este lote está bajo 135F (${row.startTempF}F).`);
    }
    if (riceSawGone(row)) {
        add('closed_late', 'Closed after the toss time: "I saw it gone in time".', 'Cerrado después de la hora de tirar: "Lo vi acabarse a tiempo".');
    }
    if (riceUsedLate(row)) {
        add('used_late', 'Logged as used up after the toss time, and nobody said it was gone in time.', 'Registrado como usado después de la hora de tirar, y nadie dijo que se acabó a tiempo.');
    }
    if (row.status === RICE_STATUS.UNKNOWN) {
        add('unknown', "Closed as don't know, or used late.", 'Cerrado como no se sabe, o se usó tarde.');
    }
    if (row.status === RICE_STATUS.TOSSED && row.tossReason === 'past_4h') {
        add('tossed_late', 'Tossed after the toss time.', 'Tirado después de la hora de tirar.');
    }
    if (row.status === RICE_STATUS.TOSSED && row.tossReason === 'past_70f') {
        add('tossed_past_70f', 'Tossed after its 70F time, never in the fridge.', 'Tirado después de su hora de 70F, nunca entró al refri.');
    }
    if (row.status === RICE_STATUS.TOSSED && row.tossReason === 'morning_above_41') {
        add('morning_above_41', 'Morning reading above 41F. Tossed.', 'Lectura de la mañana sobre 41F. Tirado.');
    }
    const state = riceBatchState(row, now);
    if (isRiceOpen(row) && (state === 'tossNow' || state === 'pastUseBy')) {
        add('past_limit', isRiceFridgeRoute(row) ? 'Past its use-by, still open.' : 'Past the toss time, still open.', isRiceFridgeRoute(row) ? 'Pasó la fecha de uso, sigue abierto.' : 'Pasó la hora de tirar, sigue abierto.');
    }
    if (isRiceFridgeRoute(row)) {
        const fridged = row.fridgedAt ? new Date(row.fridgedAt).getTime() : null;
        if (fridged && fridged > new Date(row.seventyByAt).getTime()) {
            add('fridge_late', 'Went in the fridge after its 70F time.', 'Entró al refri después de su hora de 70F.');
        }
        // Still not in the walk-in past its 70F time, or closed that way. A
        // toss says so in its own flag.
        const missedAt = isRiceOpen(row) ? now.getTime()
            : row.status === RICE_STATUS.USED ? timeMs(row.usedAt)
                : row.status === RICE_STATUS.UNKNOWN ? timeMs(row.unknownAt) : null;
        if (riceMissed70(row, missedAt)) {
            add('not_in_fridge', 'Not in the walk-in by its 70F time.', 'No entró al refri antes de su hora de 70F.');
        }
        const { over70, over41 } = riceLateReadings(row);
        if (over70) {
            add('over_70', `Read ${over70.tempF}F at ${riceReadingTime(over70, row)}: above 70F, past its 70F time.`, `Lectura de ${over70.tempF}F a las ${riceReadingTime(over70, row, true)}: sobre 70F, pasada su hora de 70F.`);
        }
        if (over41 && row.tossReason !== 'morning_above_41') {
            add('over_41', `Read ${over41.tempF}F at ${riceReadingTime(over41, row)}: above 41F, past its 41F time.`, `Lectura de ${over41.tempF}F a las ${riceReadingTime(over41, row, true)}: sobre 41F, pasada su hora de 41F.`);
        }
        const readings = Array.isArray(row.readings) ? row.readings : [];
        if (row.status === RICE_STATUS.USED && riceDayStr(new Date(row.usedAt)) > row.cookDay && !readings.some((r) => r.kind === 'morning')) {
            add('no_morning_reading', 'Used on a later day with no morning reading.', 'Usado otro día sin lectura de la mañana.');
        }
    }
    if (Array.isArray(row.prints) && row.prints.length > 0) {
        const printed = riceStickersPrinted(row);
        if (printed === 0) {
            // A timed-out job often did print, so nobody knows either way.
            if (row.prints.some((p) => p.error === 'printer timeout')) {
                add('print_unconfirmed', 'Printer timed out. A sticker may have printed.', 'La impresora no respondió a tiempo. Puede que sí haya salido una etiqueta.');
            } else {
                add('no_print', 'No sticker printed.', 'No se imprimió etiqueta.');
            }
        } else if (Number.isFinite(row.pans) && printed < row.pans) {
            add('short_print', `${printed} of ${row.pans} stickers confirmed.`, `${printed} de ${row.pans} etiquetas confirmadas.`);
        }
    }
    if (duplicateBatchNumbers(dayRows).has(row.batchNo)) {
        add('duplicate_number', 'Same number as another batch.', 'Mismo número que otro lote.');
    }
    // Either order: a busy cook may print the replacement first and delete the
    // old ticket a minute later. A batch older than the deleted ticket can't be
    // its replacement.
    const created = riceCreatedMs(row);
    const afterDelete = (dayRows || []).find((d) => {
        if (!isRiceDeleted(d) || d.id === row.id) return false;
        const gone = new Date(d.deletedAt).getTime();
        return created >= riceCreatedMs(d) && Math.abs(created - gone) <= RICE_AFTER_DELETE_FLAG_MIN * MINUTE;
    });
    if (afterDelete) {
        add('after_delete', `Started within 30 minutes of deleted ticket #${afterDelete.batchNo}.`, `Empezó dentro de 30 minutos del ticket borrado #${afterDelete.batchNo}.`);
    }
    return flags;
}

// The day's numbers. Deleted and voided rows aren't batches. A low reading no
// batch ever followed counts as a flag, because nothing else shows it.
export function riceDaySummary(rows, now = new Date(), lowReadings = []) {
    const all = rows || [];
    const live = all.filter((r) => !isRiceDeleted(r) && r.status !== RICE_STATUS.VOID);
    return {
        batches: live.length,
        used: live.filter((r) => r.status === RICE_STATUS.USED).length,
        open: live.filter(isRiceOpen).length,
        tossed: live.filter((r) => r.status === RICE_STATUS.TOSSED).length,
        unknown: live.filter((r) => r.status === RICE_STATUS.UNKNOWN).length,
        // An old row that went in the fridge ended there.
        fridged: live.filter((r) => r.status === RICE_STATUS.FRIDGE && !isRiceFridgeRoute(r)).length,
        voided: all.filter((r) => !isRiceDeleted(r) && r.status === RICE_STATUS.VOID).length,
        deleted: all.filter(isRiceDeleted).length,
        pastLimit: live.filter((r) => ricePastLimit(r, now)).length,
        flags: live.reduce((n, r) => n + riceRowFlags(r, all, now).length, 0)
            + (lowReadings || []).filter((l) => !riceLowReadingBatch(l, all)).length,
    };
}

// "3 batches: 2 used up, 1 open. 0 past limit. 0 flags."
export function riceSummaryLine(s, isEs = false) {
    const parts = isEs
        ? [`${s.used} usados`, `${s.open} abiertos`]
        : [`${s.used} used up`, `${s.open} open`];
    if (s.tossed) parts.push(isEs ? `${s.tossed} tirados` : `${s.tossed} tossed`);
    if (s.unknown) parts.push(isEs ? `${s.unknown} sin saber` : `${s.unknown} unknown`);
    if (s.fridged) parts.push(isEs ? `${s.fridged} al refri` : `${s.fridged} into fridge`);
    if (s.voided) parts.push(isEs ? `${s.voided} anulados` : `${s.voided} void`);
    return isEs
        ? `${s.batches} ${s.batches === 1 ? 'lote' : 'lotes'}: ${parts.join(', ')}. ${s.pastLimit} pasados del límite. ${s.flags} alertas.`
        : `${s.batches} ${s.batches === 1 ? 'batch' : 'batches'}: ${parts.join(', ')}. ${s.pastLimit} past limit. ${s.flags} ${s.flags === 1 ? 'flag' : 'flags'}.`;
}

const EDIT_FIELD_NAMES = {
    startTempF: ['reading', 'lectura'],
    pans: ['pans', 'bandejas'],
    notes: ['note', 'nota'],
    status: ['how it ended', 'cómo terminó'],
};
const EDIT_STATUS_NAMES = {
    cooling: ['open', 'abierto'],
    fridge: ['in the fridge', 'en el refri'],
    used: ['used up', 'se acabó'],
    tossed: ['tossed', 'tirado'],
    unknown: ["don't know", 'no se sabe'],
    void: ['void', 'anulado'],
    saw_gone: ['saw it gone in time', 'lo vi acabarse a tiempo'],
};

// "reading: 190 to 198, Maria Lopez, 12:45 PM"
export function riceEditText(entry, isEs = false) {
    const i = isEs ? 1 : 0;
    const name = EDIT_FIELD_NAMES[entry.field]?.[i] || entry.field;
    const show = (v) => {
        if (v === null || v === undefined || v === '') return isEs ? '(vacío)' : '(blank)';
        if (entry.field === 'status') return EDIT_STATUS_NAMES[v]?.[i] || String(v);
        if (entry.field === 'startTempF') return `${v}F`;
        return String(v);
    };
    return `${name}: ${show(entry.old)} ${isEs ? 'a' : 'to'} ${show(entry.new)}, ${entry.by || ''}, ${fmtRiceTime(entry.at)}`;
}

// ── The printed log ─────────────────────────────────────────────────
// One portrait page, always English, whoever is signed in. It says what's
// true: no cooling at room temperature, and no fridge deadline for For Today
// rice. A day with Fridge batches gets its own table; other days don't
// advertise that route. The app can't stop a Firebase console edit, so this
// doesn't claim entries can never change.
const shortName = (name) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return parts[0] || '';
    return `${parts[0][0]}. ${parts[parts.length - 1]}`;
};

// Who closed it the way it reads now. A correction keeps the earlier ending's
// fields, and edits[] holds the history.
function closedBy(row) {
    switch (row.status) {
        case RICE_STATUS.USED: return row.usedBy || '';
        case RICE_STATUS.TOSSED: return row.tossedBy || '';
        case RICE_STATUS.UNKNOWN: return row.unknownBy || '';
        case RICE_STATUS.FRIDGE: return row.fridgedBy || '';
        case RICE_STATUS.VOID: return row.voidedBy || '';
        default: return '';
    }
}

// Stickers known to have come out: whole jobs that went through, plus the
// copies a failed job got out first.
export function riceStickersPrinted(row) {
    return (Array.isArray(row?.prints) ? row.prints : []).reduce(
        (n, p) => n + (p.ok ? (Number(p.copies) || 1) : (Number(p.copiesPrinted) || 0)),
        0,
    );
}

// An old row never saved a pan count, so it reads as the stickers it printed.
export function ricePans(row) {
    if (Number.isFinite(row?.pans)) return row.pans;
    return riceStickersPrinted(row);
}

// What a reprint should send: the pans still without a sticker, or 1 when every
// pan has one and a sticker got lost.
export function riceReprintCopies(row) {
    return Math.max(1, Math.min(RICE_MAX_COPIES, ricePans(row) - riceStickersPrinted(row)));
}

const probeText = (row) => (Number.isFinite(row.startTempF) ? `${row.startTempF}F` : '----');

// `notConfirmed` means the server hasn't answered for this day: the page came
// from this device's saved copy, which may be missing batches. It says so at the
// top, and it never says the day had no batches.
export function buildRiceLogHtml({
    rows, cookDay, locationLabel, printedBy = '', now = new Date(), lowReadings = [], notConfirmed = false, lastServerAt = null,
}) {
    const all = rows || [];
    const shown = all.filter((r) => !isRiceDeleted(r));
    const deleted = all.filter(isRiceDeleted);
    const fridgeRows = shown.filter(isRiceFridgeRoute);
    const todayRows = shown.filter((r) => !isRiceFridgeRoute(r));
    const summary = riceDaySummary(all, now, lowReadings);
    const flagged = shown
        .map((r) => ({ r, flags: riceRowFlags(r, all, now) }))
        .filter((x) => x.flags.length > 0);
    const flaggedIds = new Set(flagged.map((x) => x.r.id));
    const edited = shown.filter((r) => Array.isArray(r.edits) && r.edits.length > 0);
    const dups = duplicateBatchNumbers(all);

    const mark = (r) => `#${esc(r.batchNo)}${flaggedIds.has(r.id) ? '*' : ''}`
        + `${dups.has(r.batchNo) && r.status !== RICE_STATUS.VOID ? ' (number used twice)' : ''}`
        + `${Array.isArray(r.edits) && r.edits.length ? ' (edited)' : ''}`;
    const byCell = (r) => {
        const closer = shortName(closedBy(r));
        const starter = shortName(r.cookedBy);
        return closer && !isRiceOpen(r) ? `${starter}/${closer}` : starter;
    };

    const todayBody = todayRows.map((r) => {
        const tossedAtStart = r.status === RICE_STATUS.TOSSED && ['below_135', 'no_sticker'].includes(r.tossReason);
        return `
        <tr class="${r.status === RICE_STATUS.VOID ? 'void' : ''}">
            <td>${mark(r)}</td>
            <td>${esc(fmtRiceTime(riceMadeAt(r)))}${r.timeUnknown ? ' (found)' : ''}</td>
            <td>${esc(probeText(r))}</td>
            <td>${tossedAtStart ? '----' : esc(fmtRiceTime(r.tossByAt))}</td>
            <td>${esc(riceOutcomeText({ ...r, usedBy: '', tossedBy: '', unknownBy: '', fridgedBy: '', voidedBy: '' }))}</td>
            <td>${esc(ricePans(r))}</td>
            <td>${esc(byCell(r))}</td>
        </tr>`;
    }).join('');

    const readingsText = (r) => {
        const readings = Array.isArray(r.readings) ? r.readings : [];
        if (readings.length === 0) return 'Readings: none taken.';
        return `Readings: ${readings.map((x) => `${x.kind === 'morning' ? 'morning ' : ''}${riceReadingTime(x, r)} ${x.tempF}F`).join(', ')}.`;
    };
    const fridgeBody = fridgeRows.map((r) => `
        <tr class="top">
            <td>${mark(r)}</td>
            <td>${esc(fmtRiceTime(riceMadeAt(r)))}</td>
            <td>${esc(probeText(r))}</td>
            <td>${esc(fmtRiceTime(r.fridgedAt) || '----')}</td>
            <td>${esc(ricePans(r))}</td>
            <td>${esc(byCell(r))}</td>
        </tr>
        <tr class="sub"><td></td><td colspan="5">70F by ${esc(fmtRiceTime(r.seventyByAt))}. 41F by ${esc(fmtRiceTime(r.fortyOneByAt))}. Use by ${esc(stickerDay(r.useByDay))}. ${esc(readingsText(r))}</td></tr>
        <tr class="sub"><td></td><td colspan="5">Ended: ${esc(isRiceOpen(r) ? (r.status === RICE_STATUS.FRIDGE ? 'in the fridge' : 'still open') : riceOutcomeText({ ...r, usedBy: '', tossedBy: '', unknownBy: '', fridgedBy: '' }))}.</td></tr>`).join('');

    const flagsHtml = flagged.length === 0 ? '' : `
<h2>FLAGS</h2>
<div class="list">${flagged.map(({ r, flags }) => `<div>* #${esc(r.batchNo)} ${esc(flags.map((f) => f.en).join(' '))}</div>`).join('')}</div>`;
    const editsHtml = edited.length === 0 ? '' : `
<h2>CORRECTIONS</h2>
<div class="list">${edited.map((r) => (r.edits || []).map((e) => `<div>#${esc(r.batchNo)} ${esc(riceEditText(e))}</div>`).join('')).join('')}</div>`;
    const lowHtml = (lowReadings || []).length === 0 ? '' : `
<h2>READINGS BELOW 135F (NO STICKER)</h2>
<div class="list">${lowReadings.map((l) => `<div>${riceLowReadingBatch(l, all) ? '' : '* '}${esc(fmtRiceTime(l.at))} ${esc(l.tempF)}F, ${esc(shortName(l.by))}: ${esc(riceLowReadingText(l, all))}.</div>`).join('')}</div>`;
    const offlineHtml = !notConfirmed ? '' : `
<div class="offline">NOT CONFIRMED: printed offline from what this device has saved. It may be missing batches.${lastServerAt ? ` Last server update ${esc(fmtRiceTime(new Date(lastServerAt).toISOString()))}.` : ''}</div>`;
    // What the table says when it has no For Today rows.
    const emptyToday = fridgeRows.length
        ? (notConfirmed ? 'No For Today batches saved on this device.' : 'No For Today batches this day.')
        : (notConfirmed ? 'Nothing saved on this device for this day. This does not mean no batches were made.' : 'No rice batches logged this day.');
    // An old-format row can have gone in the fridge, so the page can't say none did.
    const notRefrigerated = todayRows.some((r) => r.fridgedAt || r.status === RICE_STATUS.FRIDGE) ? '' : ' It is not refrigerated.';
    const summaryText = !notConfirmed ? riceSummaryLine(summary)
        : shown.length > 0 ? `Saved on this device so far: ${riceSummaryLine(summary)}` : '';
    const deletedHtml = deleted.length === 0 ? '' : `
<div class="deleted">Deleted tickets: ${deleted.map((r) => esc(`#${r.batchNo} (${shortName(r.deletedBy)}, ${fmtRiceTime(r.deletedAt)}: ${r.deleteReason || 'printed by mistake'})`)).join('; ')}.</div>`;

    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DD Mau Rice Log ${esc(cookDay)}</title>
<style>
  @page { size: letter portrait; margin: 10mm; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 16px; color: #111; font-size: 11px; line-height: 1.35; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  h2 { font-size: 11px; margin: 10px 0 3px; }
  .head { display: flex; justify-content: space-between; font-size: 13px; font-weight: 700; margin-bottom: 4px; }
  .summary { font-size: 12px; font-weight: 700; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th, td { border: 1px solid #999; padding: 3px 5px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  tr.void td { color: #888; text-decoration: line-through; }
  tr.sub td { border-top: 0; }
  tr.top td { border-bottom: 0; }
  .empty { padding: 14px; text-align: center; color: #666; }
  .list div { margin-bottom: 2px; }
  .foot { margin-top: 10px; font-size: 10.5px; }
  .deleted { margin-top: 8px; font-size: 9px; color: #444; }
  .offline { border: 2px solid #111; padding: 4px 6px; font-size: 12px; font-weight: 700; margin-bottom: 6px; }
  .sign { display: flex; justify-content: space-between; margin-top: 10px; font-size: 11px; }
  .no-print { margin-bottom: 10px; }
  .no-print button { font-size: 14px; padding: 8px 14px; }
  @media print { .no-print { display: none; } body { margin: 0; } }
</style></head><body>
<div class="no-print"><button onclick="window.print()">Print</button></div>
<h1>DD MAU&nbsp; RICE FOR FRIED RICE: 4-HOUR TIME CONTROL LOG</h1>
<div class="head"><span>${esc(locationLabel)}</span><span>${esc(fmtRiceDay(cookDay))}</span></div>
${offlineHtml}${summaryText ? `<div class="summary">${esc(summaryText)}</div>` : ''}
<table>
  <thead><tr><th>Batch</th><th>Made</th><th>Probe</th><th>Toss by</th><th>How it ended</th><th>Pans</th><th>By (start/close)</th></tr></thead>
  <tbody>${todayBody || `<tr><td colspan="7" class="empty">${emptyToday}</td></tr>`}</tbody>
</table>
${fridgeRows.length === 0 ? '' : `<h2>FRIDGE BATCHES (COOLING)</h2>
<table>
  <thead><tr><th>Batch</th><th>Made</th><th>Probe</th><th>In cold</th><th>Pans</th><th>By (start/close)</th></tr></thead>
  <tbody>${fridgeBody}</tbody>
</table>`}${lowHtml}${flagsHtml}${editsHtml}
<div class="foot">
  For Today rice is on 4-hour time control under our written procedure, on file in this store.${notRefrigerated} "Made" = time the rice left the cooker.<br>
  ${fridgeRows.length ? 'Fridge batches must read 70F by 2 hours and 41F by 6 hours after Made. A blank reading means nobody took one.<br>' : ''}
  The app records when each entry was made. Corrections and deleted tickets are listed on this page.
</div>
<div class="sign"><span>Printed ${esc(fmtRiceTime(now.toISOString()))}${printedBy ? ` by ${esc(shortName(printedBy))}` : ''}.</span><span>Signature: ____________________</span></div>${deletedHtml}
</body></html>`;
}

// The honest connection line. canSayEmpty is only true when the server itself
// answered, so "no batches" never stands in for "couldn't load".
export function riceConnectionState({ rows, meta, error, waitedLong, lastServerAt }) {
    if (error) {
        return {
            tone: 'bad', canSayEmpty: false,
            en: "Can't load this day. Check the Wi-Fi. This doesn't mean no batches were made.",
            es: 'No se puede cargar este día. Revisa el Wi-Fi. Esto no significa que no se hicieron lotes.',
        };
    }
    if (rows == null) {
        return waitedLong
            ? { tone: 'bad', canSayEmpty: false, en: "Can't reach the log yet. Check the Wi-Fi.", es: 'Aún no se puede llegar al registro. Revisa el Wi-Fi.' }
            : { tone: 'quiet', canSayEmpty: false, en: 'Loading this day…', es: 'Cargando este día…' };
    }
    if (meta?.fromCache) {
        if (!waitedLong) return { tone: 'quiet', canSayEmpty: false, en: 'Connecting…', es: 'Conectando…' };
        const from = lastServerAt ? fmtRiceTime(new Date(lastServerAt).toISOString()) : '';
        return {
            tone: 'warn', canSayEmpty: false,
            en: from ? `Offline. Showing saved data from ${from}.` : 'Offline. Showing what this device has saved.',
            es: from ? `Sin conexión. Mostrando lo guardado de las ${from}.` : 'Sin conexión. Mostrando lo que este aparato tiene guardado.',
        };
    }
    if (meta?.pending) return { tone: 'quiet', canSayEmpty: true, en: 'Connected. Saving…', es: 'Conectado. Guardando…' };
    return { tone: 'good', canSayEmpty: true, en: 'Connected. Up to date.', es: 'Conectado. Al día.' };
}
