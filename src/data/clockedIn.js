// clockedIn.js — subscribe to the live Toast clocked-in roster.
//
// The Railway scraper (see scraper.py fetch_clocked_in_data) writes a
// single doc per location every ~90s:
//
//   ops/clocked_in_{webster|maryland} = {
//     schemaVersion: 1,
//     updatedAt:   ISO UTC,         // when scraper wrote this
//     scrapedAt:   ISO Central,     // human-friendly stamp
//     entries: [
//       {
//         toastEmployeeId,
//         employeeName,
//         jobName,
//         clockedInAt:  ISO,
//         onBreakSince: ISO | null,
//         breaksToday:  [{ in, out|null, minutes, paid }],
//         hoursToday:   4.5,
//         hoursThisWeek: 33.2,
//         overtimeRisk: bool,       // hoursThisWeek > 35
//       }
//     ],
//     count, weekStart, weekEnd, source
//   }
//
// One doc per location keeps subscription cost tiny (1 read on initial
// snapshot, 1 read per scrape tick). Pairs with the existing
// AppDataContext labor subscription which uses the same pattern.

import { onSnapshot, doc } from 'firebase/firestore';
import { db } from '../firebase';

// ── Warm-paint cache (CI1, 2026-08-29) ──────────────────────────────────────
// Owner: "who's clocked in seems a little slow, not very smooth." The ops/
// docs are tiny (~6KB) and update every ~90s — the visible lag was the
// cold-mount spinner while the first snapshot round-trips. Keep the last
// good doc per location in localStorage and seed the panel from it so
// reopening the app paints the roster instantly; the live listener replaces
// it moments later. The seed stays honest: freshness/stale math always
// derives from the doc's own updatedAt, so a seeded old doc immediately
// shows its true age (and the Stale badge).
const CACHE_TTL_MS = 10 * 60 * 1000; // never seed anything older than ~10 min

function cacheKey(kind, location) {
    return `ddmau:${kind}:${location}`;
}

function readCache(kind, location) {
    try {
        const raw = localStorage.getItem(cacheKey(kind, location));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!Number.isFinite(parsed.at) || (Date.now() - parsed.at) > CACHE_TTL_MS) return null;
        return parsed.data || null;
    } catch {
        return null; // private mode / quota / corrupt JSON — warm paint is best-effort
    }
}

function writeCache(kind, location, data) {
    // Callers must never write from a null callback — error and doc-absent
    // both surface as null, and a null write would poison the warm seed.
    // Guard here too, belt and suspenders.
    if (!data) return;
    try {
        localStorage.setItem(cacheKey(kind, location), JSON.stringify({ data, at: Date.now() }));
    } catch { /* best-effort */ }
}

/** Warm-cache seed for ops/clocked_in_{location}. null when absent/expired. */
export function readClockedInCache(location) { return readCache('clockedin', location); }
/** Store the latest good clocked_in doc. NEVER call with null. */
export function writeClockedInCache(location, data) { writeCache('clockedin', location, data); }
// clock_sessions cached identically — safe to seed because
// earlierSessionsFor() date-guards on the doc's own `date` field, so a
// stale prior-day seed is inert downstream.
export function readClockSessionsCache(location) { return readCache('clocksessions', location); }
export function writeClockSessionsCache(location, data) { writeCache('clocksessions', location, data); }

/**
 * Subscribe to a single location's clocked-in roster.
 *
 * @param {'webster'|'maryland'} location
 * @param {(data: object|null) => void} callback — null when doc absent
 * @param {(err: Error) => void} [onError] — CI8: when provided, snapshot
 *   errors go HERE instead of callback(null). null means doc-absent, not
 *   error — reusing it as the error signal made an outage wipe data the
 *   panel already had. Callers with onError keep prior data and drive
 *   their own retry; legacy callers keep the old null-on-error behavior.
 * @returns {() => void} unsubscribe
 */
export function subscribeClockedIn(location, callback, onError) {
    if (!location) {
        callback(null);
        return () => {};
    }
    const ref = doc(db, 'ops', `clocked_in_${location}`);
    return onSnapshot(
        ref,
        (snap) => callback(snap.exists() ? snap.data() : null),
        (err) => {
            console.warn(`clocked_in_${location} snapshot failed:`, err);
            if (onError) onError(err);
            else callback(null);
        }
    );
}

/**
 * Subscribe to a location's COMPLETED-sessions doc (ops/clock_sessions_{location}),
 * written by the recordCompletedSessions Cloud Function. Shape:
 *   { date: 'YYYY-MM-DD', location, employees: { [toastEmployeeId]: { name, sessions: [{clockIn, clockOut}] } } }
 * Lets the panel show every clock in/out today, not just the latest punch.
 * Optional onError — same CI8 contract as subscribeClockedIn above.
 */
export function subscribeClockSessions(location, callback, onError) {
    if (!location) {
        callback(null);
        return () => {};
    }
    const ref = doc(db, 'ops', `clock_sessions_${location}`);
    return onSnapshot(
        ref,
        (snap) => callback(snap.exists() ? snap.data() : null),
        (err) => {
            console.warn(`clock_sessions_${location} snapshot failed:`, err);
            if (onError) onError(err);
            else callback(null);
        }
    );
}

// ── Cached Intl formatters (CI3, 2026-08-29) ────────────────────────────────
// Intl.DateTimeFormat construction is expensive (allocates locale data every
// time) and fmtClockTime runs 40-100× per panel render. Build each formatter
// once — lazily, so an environment that throws on the timeZone option can't
// crash module load — and reuse .format(d). Output is byte-identical to the
// old per-call toLocaleTimeString / new-Intl paths (node-verified).
let _clockTimeFmt = null;
function clockTimeFmt() {
    if (!_clockTimeFmt) {
        _clockTimeFmt = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Chicago',
            hour: 'numeric',
            minute: '2-digit',
        });
    }
    return _clockTimeFmt;
}

let _centralDateFmt = null;
function centralDateFmt() {
    if (!_centralDateFmt) {
        _centralDateFmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
        });
    }
    return _centralDateFmt;
}

/** Today's earlier sessions for a person, from a clock_sessions doc.
 *  Returns [] unless the doc is for TODAY (Central) — so a stale doc from a
 *  prior day never bleeds in. */
export function earlierSessionsFor(sessionsDoc, toastEmployeeId) {
    if (!sessionsDoc || !toastEmployeeId) return [];
    // CI3 — cached formatter; was a fresh Intl.DateTimeFormat per entry.
    const todayCT = centralDateFmt().format(new Date());
    if (sessionsDoc.date !== todayCT) return [];
    const emp = sessionsDoc.employees && sessionsDoc.employees[String(toastEmployeeId)];
    return (emp && Array.isArray(emp.sessions)) ? emp.sessions : [];
}

/**
 * Distill the doc into a UI-ready status. Same mental model as
 * getLaborStatus() — caller asks "is this data trustworthy AND fresh?"
 * and renders accordingly.
 *
 * Stale = scraper hasn't written in >5 min (the scraper's real cadence is
 * ~90s per write, so 5 min ≈ 3 missed ticks — clearly wrong, not jitter).
 *
 * @param {object|null} data
 * @returns {{
 *   hasData: boolean,
 *   entries: Array,
 *   count: number,
 *   updatedAt: Date|null,
 *   minutesAgo: number|null,
 *   isStale: boolean,
 * }}
 */
export function getClockedInStatus(data) {
    if (!data) {
        return { hasData: false, entries: [], count: 0, updatedAt: null, minutesAgo: null, isStale: false };
    }
    const updatedAt = data.updatedAt ? new Date(data.updatedAt) : null;
    const validUpdated = updatedAt && !isNaN(updatedAt.getTime());
    const minutesAgo = validUpdated
        ? Math.round((Date.now() - updatedAt.getTime()) / 60000)
        : null;
    return {
        hasData: true,
        entries: Array.isArray(data.entries) ? data.entries : [],
        count: data.count || 0,
        updatedAt: validUpdated ? updatedAt : null,
        minutesAgo,
        // Scraper writes every ~90s; >5 min (~3 missed ticks) = something's
        // wrong. (CI2 2026-08-29 — was >15, left over from an old "10 min
        // nominal cadence" assumption that never matched the real scraper.)
        isStale: minutesAgo !== null && minutesAgo > 5,
    };
}

/**
 * Format an ISO timestamp as "9:12 AM" in Central Time.
 * Returns '—' on bad input.
 */
export function fmtClockTime(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '—';
        // CI3 — cached formatter (see clockTimeFmt above); was a fresh
        // Intl.DateTimeFormat built inside toLocaleTimeString per call.
        return clockTimeFmt().format(d);
    } catch {
        return '—';
    }
}

/**
 * Bucket weekly-hours into a color band. Mirrors Schedule.jsx OT bands:
 *   < 30  → green ("comfortable")
 *   30-39 → amber ("watch")
 *   ≥ 40  → red ("overtime")
 * Returns a Tailwind class fragment for tone-tinted text/border.
 */
export function hoursWeekTone(h) {
    const n = Number(h) || 0;
    if (n >= 40) return 'text-red-700';
    if (n >= 30) return 'text-amber-700';
    return 'text-dd-green-700';
}
