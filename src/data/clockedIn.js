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

/**
 * Subscribe to a single location's clocked-in roster.
 *
 * @param {'webster'|'maryland'} location
 * @param {(data: object|null) => void} callback — null when doc absent
 * @returns {() => void} unsubscribe
 */
export function subscribeClockedIn(location, callback) {
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
            callback(null);
        }
    );
}

/**
 * Distill the doc into a UI-ready status. Same mental model as
 * getLaborStatus() — caller asks "is this data trustworthy AND fresh?"
 * and renders accordingly.
 *
 * Stale = scraper hasn't written in >15 min (10 min nominal cadence +
 * 5 min jitter cushion).
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
        // Scraper runs every 90s; >15min = something's wrong.
        isStale: minutesAgo !== null && minutesAgo > 15,
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
        return d.toLocaleTimeString('en-US', {
            timeZone: 'America/Chicago',
            hour: 'numeric',
            minute: '2-digit',
        });
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
