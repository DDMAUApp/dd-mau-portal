// timecards.js — staff-facing timecard history + dispute flow (2026-07-24).
//
// DATA SOURCE: /timecards docs written by functions/attendance.js
// recordDurableTimecards — one doc per (location, Central day, Toast employee),
// built from the Railway scraper's live Toast roster feed. Shape:
//   { location, date:'YYYY-MM-DD', toastEmployeeId, employeeName, staffKey,
//     sessions:[{clockIn,clockOut}], openClockIn, breaks:[{in,out,minutes,paid}],
//     hoursToday, hoursThisWeek, jobName, updatedAt }
//
// JOIN: staffKey = normName(Toast employeeName) — the same normalized-name
// join ClockedInPanel and functions/attendance.js use to match Toast names to
// app staff names. MUST stay in sync with those.
//
// LIMITATION (stated on the page too): history accrues from the day the
// recorder shipped — the scraper keeps no past days, so there is no backfill.
// Toast itself (via the manual payroll exports) stays the payroll source of
// truth; this view is for staff self-service and dispute-flagging only.
import { db } from '../firebase';
import {
    collection, query, where, orderBy, limit, onSnapshot,
    addDoc, updateDoc, doc, serverTimestamp,
} from 'firebase/firestore';
import { notifyManagement } from './notify';

export function normName(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Live-subscribe to MY timecards since a date (inclusive).
 * Requires the composite index timecards(staffKey ASC, date DESC).
 * @param {string} staffName  app staff name (joined via normName)
 * @param {string} sinceDateStr 'YYYY-MM-DD'
 * @param {(cards: object[]) => void} cb newest-first
 * @returns {() => void} unsubscribe
 */
export function subscribeMyTimecards(staffName, sinceDateStr, cb) {
    const k = normName(staffName);
    if (!k) { cb([]); return () => {}; }
    const q = query(
        collection(db, 'timecards'),
        where('staffKey', '==', k),
        where('date', '>=', sinceDateStr),
        orderBy('date', 'desc'),
        limit(120),   // ~2 locations × 60 days — plenty for a month view
    );
    return onSnapshot(q,
        (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        // 2026-07-27 (audit) — report null on error, NOT []. An empty array is
        // indistinguishable from "no timecards" and made MyHoursPage swap the
        // cached cards for the misleading empty state on a network blip.
        // (Sole caller: MyHoursPage — it ignores non-array payloads.)
        (err) => { console.warn('subscribeMyTimecards failed:', err); cb(null); });
}

/** Sum a card's hours: prefer the scraper's own hoursToday (Toast truth,
 *  already break-adjusted); fall back to summing closed sessions. */
export function cardHours(card) {
    if (card?.hoursToday != null && Number.isFinite(Number(card.hoursToday))) {
        return Number(card.hoursToday);
    }
    let ms = 0;
    for (const s of (card?.sessions || [])) {
        const a = new Date(s.clockIn).getTime();
        const b = s.clockOut ? new Date(s.clockOut).getTime() : NaN;
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) ms += b - a;
    }
    return ms / 3600000;
}

/**
 * Staff files a "this timecard is wrong" request. Admin reviews it on the
 * Admin page → Timecard fix requests. We never write to Toast — the admin
 * corrects the punch in Toast and marks the request resolved here.
 */
export async function submitTimecardDispute({
    staffName, card, issues = [], expectedClockIn = '', expectedClockOut = '',
    note = '', language = 'en',
}) {
    const body = {
        status: 'open',
        staffName,
        staffKey: normName(staffName),
        location: card?.location || null,
        date: card?.date || null,
        toastEmployeeId: card?.toastEmployeeId || null,
        // Snapshot what the staffer was LOOKING at when they disputed it, so
        // the admin sees the same card even if the recorder updates later.
        recorded: {
            sessions: card?.sessions || [],
            openClockIn: card?.openClockIn || null,
            breaks: card?.breaks || [],
            hoursToday: card?.hoursToday ?? null,
        },
        issues,                       // ['clock_in','clock_out','break','missing']
        expectedClockIn: expectedClockIn || null,   // 'HH:MM' local, staff-claimed
        expectedClockOut: expectedClockOut || null,
        note: String(note || '').slice(0, 500),
        createdAt: serverTimestamp(),
    };
    const ref = await addDoc(collection(db, 'timecard_disputes'), body);
    // Ping the admins — same pattern as PTO requests.
    notifyManagement({
        type: 'timecard_dispute',
        title: { en: `🕐 Timecard fix request: ${staffName}`, es: `🕐 Corrección de horario: ${staffName}` },
        body: {
            en: `${card?.date || ''} · ${issuesLabel(issues, 'en')}${note ? ` · ${note.slice(0, 80)}` : ''}`,
            es: `${card?.date || ''} · ${issuesLabel(issues, 'es')}${note ? ` · ${note.slice(0, 80)}` : ''}`,
        },
        link: '/admin', deepLink: 'admin',
        tag: `timecard_dispute:${ref.id}`,
        createdBy: staffName,
    }).catch(() => {});
    return ref.id;
}

export function issuesLabel(issues, lng = 'en') {
    const L = {
        clock_in: { en: 'clock-in wrong', es: 'entrada incorrecta' },
        clock_out: { en: 'clock-out wrong', es: 'salida incorrecta' },
        break: { en: 'break wrong', es: 'descanso incorrecto' },
        missing: { en: 'hours missing', es: 'faltan horas' },
    };
    return (issues || []).map((i) => L[i]?.[lng] || i).join(', ');
}

/** Admin: live-subscribe to dispute requests, newest first. Single-field
 *  orderBy — no composite index needed; status filtering happens client-side. */
export function subscribeTimecardDisputes(cb, max = 200) {
    const q = query(collection(db, 'timecard_disputes'), orderBy('createdAt', 'desc'), limit(max));
    return onSnapshot(q,
        (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => { console.warn('subscribeTimecardDisputes failed:', err); cb([]); });
}

/** Admin resolves ('fixed' — corrected in Toast) or dismisses a request. */
export async function resolveTimecardDispute(id, status, byName) {
    await updateDoc(doc(db, 'timecard_disputes', id), {
        status,                                // 'fixed' | 'dismissed'
        resolvedBy: byName || null,
        resolvedAt: serverTimestamp(),
    });
}
