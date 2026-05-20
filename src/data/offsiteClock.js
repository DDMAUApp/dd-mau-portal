// Off-site clock-in / clock-out — rare-occurrence labor tracking
// for staff working away from a DD Mau store (catering events,
// supplier runs, etc.).
//
// ── Why this exists ─────────────────────────────────────────────────
// Toast doesn't know about off-site work. Our regular labor pipeline
// (Toast scraper → ops/labor_{loc}) only sees in-store punches. When
// a staff member works a catering event, neither the schedule nor the
// time-tracking sees them — they used to text Andrew their hours and
// he'd manually adjust payroll.
//
// This feature lets an admin pre-stage an off-site assignment, the
// staff app then prompts them on next login to clock in (yes/no),
// and again later to clock out (yes/not yet). "Not yet" keeps the
// prompt re-showing every session until they tap yes OR an admin
// force-clocks them out from the admin panel.
//
// ── Schema ──────────────────────────────────────────────────────────
//   /offsite_shifts/{id} = {
//     staffName:           string             — who's working
//     staffId:             number?            — id reference (for audit)
//     location:            string             — free-text label of the
//                                                off-site location
//                                                ("Catering @ Forest Park")
//     scheduledArrivalAt:  Timestamp          — when admin says they
//                                                should arrive
//     status:              'pending' | 'active' | 'completed' | 'cancelled'
//     clockedInAt:         Timestamp?         — set when staff taps "yes"
//     clockedOutAt:        Timestamp?         — set when staff or admin
//                                                ends the shift
//     forcedOut:           boolean            — true if admin clocked
//                                                them out
//     forcedOutBy:         string?
//     notes:               string?            — optional admin notes
//     createdBy:           string             — admin who scheduled it
//     createdAt:           Timestamp
//     updatedAt:           Timestamp?
//   }
//
// ── State machine ───────────────────────────────────────────────────
//   pending  → [staff taps "Yes, clocked in"]      → active
//   pending  → [admin cancels before they show up] → cancelled
//   active   → [staff taps "Yes, clocked out"]     → completed
//   active   → [admin force-clocks-out]            → completed (forcedOut)
//
// ── Per-staff subscription ──────────────────────────────────────────
// The prompt component subscribes to
//   where('staffName','==', me) AND where('status','in', ['pending','active'])
// — array length tells the prompt to fire. We pull ALL pending/active
// for the staff (max 1-2 in practice) so the prompt can choose the
// earliest scheduledArrivalAt and walk through them in order.

import { db } from '../firebase';
import {
    collection, doc, addDoc, updateDoc, query, where, onSnapshot,
    serverTimestamp, Timestamp, getDoc, getDocs, orderBy, limit,
} from 'firebase/firestore';
import { recordAudit } from './audit';

export const OFFSITE_STATUS = Object.freeze({
    PENDING:   'pending',
    ACTIVE:    'active',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
});

// Admin schedules a new off-site shift. The staff prompt component
// will surface it as soon as the assigned staff opens the app next.
//
// Required fields: staffName, location, scheduledArrivalAt (Date or
// ISO string), createdBy. staffId + notes are optional but recorded
// in the audit log for accountability.
export async function createOffsiteShift({
    staffName, staffId, location, scheduledArrivalAt, notes, createdBy,
}) {
    if (!staffName) throw new Error('staffName required');
    if (!location) throw new Error('location required');
    if (!scheduledArrivalAt) throw new Error('scheduledArrivalAt required');
    if (!createdBy) throw new Error('createdBy required');

    // Accept Date / ISO string / millis / Firestore Timestamp. Coerce to
    // Timestamp for storage so range queries work later.
    let arrivalTs;
    if (scheduledArrivalAt instanceof Timestamp) {
        arrivalTs = scheduledArrivalAt;
    } else if (scheduledArrivalAt instanceof Date) {
        arrivalTs = Timestamp.fromDate(scheduledArrivalAt);
    } else if (typeof scheduledArrivalAt === 'number') {
        arrivalTs = Timestamp.fromMillis(scheduledArrivalAt);
    } else if (typeof scheduledArrivalAt === 'string') {
        const d = new Date(scheduledArrivalAt);
        if (isNaN(d.getTime())) throw new Error('invalid scheduledArrivalAt');
        arrivalTs = Timestamp.fromDate(d);
    } else {
        throw new Error('invalid scheduledArrivalAt');
    }

    const ref = await addDoc(collection(db, 'offsite_shifts'), {
        staffName,
        staffId: staffId ?? null,
        location: String(location).slice(0, 200),
        scheduledArrivalAt: arrivalTs,
        status: OFFSITE_STATUS.PENDING,
        clockedInAt: null,
        clockedOutAt: null,
        forcedOut: false,
        forcedOutBy: null,
        notes: notes ? String(notes).slice(0, 500) : null,
        createdBy,
        createdAt: serverTimestamp(),
    });
    recordAudit({
        action: 'offsite.create',
        actorName: createdBy,
        targetType: 'offsite_shift',
        targetId: ref.id,
        details: {
            staffName,
            location,
            scheduledArrivalAt: arrivalTs.toMillis(),
        },
    });
    return ref.id;
}

// Staff confirms they've arrived + are starting work. Transitions
// pending → active. Idempotent: if the doc isn't pending we leave
// it alone (an admin may have cancelled or someone may have raced
// us — UI shouldn't be able to call this twice but the guard is
// cheap).
export async function clockIn({ id, staffName, staffId }) {
    if (!id) throw new Error('id required');
    await updateDoc(doc(db, 'offsite_shifts', id), {
        status: OFFSITE_STATUS.ACTIVE,
        clockedInAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
    recordAudit({
        action: 'offsite.clock_in',
        actorName: staffName || 'unknown',
        actorId: staffId ?? null,
        targetType: 'offsite_shift',
        targetId: id,
    });
}

// Staff confirms they're done. Transitions active → completed. The
// clockedOutAt server timestamp + the recorded createdAt let payroll
// compute hours after the fact.
export async function clockOut({ id, staffName, staffId }) {
    if (!id) throw new Error('id required');
    await updateDoc(doc(db, 'offsite_shifts', id), {
        status: OFFSITE_STATUS.COMPLETED,
        clockedOutAt: serverTimestamp(),
        forcedOut: false,
        updatedAt: serverTimestamp(),
    });
    recordAudit({
        action: 'offsite.clock_out',
        actorName: staffName || 'unknown',
        actorId: staffId ?? null,
        targetType: 'offsite_shift',
        targetId: id,
    });
}

// Admin override — closes the shift on the staff's behalf. Used
// when the staff member forgot to clock out (left phone in the car,
// closed the app, etc.). forcedOut flag in the audit details so
// payroll knows the clockOut time is admin-stamped not staff-stamped.
export async function forceClockOut({ id, adminName, adminId }) {
    if (!id) throw new Error('id required');
    if (!adminName) throw new Error('adminName required');
    await updateDoc(doc(db, 'offsite_shifts', id), {
        status: OFFSITE_STATUS.COMPLETED,
        clockedOutAt: serverTimestamp(),
        forcedOut: true,
        forcedOutBy: adminName,
        updatedAt: serverTimestamp(),
    });
    recordAudit({
        action: 'offsite.force_clock_out',
        actorName: adminName,
        actorId: adminId ?? null,
        targetType: 'offsite_shift',
        targetId: id,
        details: { forcedOut: true },
    });
}

// Admin override — manually correct the clock-in / clock-out times
// on a shift after the fact. Use case Andrew flagged: a staff member
// clocks in 15 minutes late (or forgets to tap clock-in until they
// remember an hour later) and admin wants to set the actual time
// they started working. Same idea for clock-out — someone leaves at
// 5pm but doesn't tap until 5:30, admin trims the recorded time.
//
// Inputs:
//   id              — shift doc id
//   clockedInAt     — Date | null. null leaves the field unchanged.
//                     Pass a Date to overwrite.
//   clockedOutAt    — Date | null. Same semantics.
//   reason          — optional free-text recorded on the audit row
//   adminName, adminId — who made the edit (required for audit)
//
// Validation: if both are set, clockedOutAt must be after clockedInAt.
// The audit log captures BEFORE + AFTER for every edited timestamp so
// payroll review can reconstruct the original numbers if needed.
//
// Distinct from forceClockOut: that ends an active shift and uses
// server time. This edits stored times (in-or-out) on any shift,
// regardless of status. Editing does NOT change shift status — a
// 'completed' shift stays 'completed'; an 'active' shift stays
// 'active' (use forceClockOut to end it).
export async function editShiftTimes({
    id, clockedInAt, clockedOutAt, reason, adminName, adminId,
}) {
    if (!id) throw new Error('id required');
    if (!adminName) throw new Error('adminName required');
    if (clockedInAt == null && clockedOutAt == null) {
        throw new Error('no times to edit');
    }
    // Validate types + ordering.
    const toTs = (v, label) => {
        if (v == null) return null;
        if (v instanceof Timestamp) return v;
        if (v instanceof Date) {
            if (isNaN(v.getTime())) throw new Error(`invalid ${label}`);
            return Timestamp.fromDate(v);
        }
        if (typeof v === 'number') return Timestamp.fromMillis(v);
        if (typeof v === 'string') {
            const d = new Date(v);
            if (isNaN(d.getTime())) throw new Error(`invalid ${label}`);
            return Timestamp.fromDate(d);
        }
        throw new Error(`invalid ${label}`);
    };
    const newInTs = toTs(clockedInAt, 'clockedInAt');
    const newOutTs = toTs(clockedOutAt, 'clockedOutAt');

    // Read current values so we can:
    //   1. Validate ordering against whichever side is being changed
    //      (if admin only edits clockedOutAt, compare against existing
    //      clockedInAt)
    //   2. Record both BEFORE and AFTER in the audit row
    const docRef = doc(db, 'offsite_shifts', id);
    const snap = await getDoc(docRef);
    if (!snap.exists()) throw new Error('shift not found');
    const existing = snap.data();
    const existingInMs = existing.clockedInAt?.toMillis?.() ?? null;
    const existingOutMs = existing.clockedOutAt?.toMillis?.() ?? null;

    const finalInMs = newInTs ? newInTs.toMillis() : existingInMs;
    const finalOutMs = newOutTs ? newOutTs.toMillis() : existingOutMs;
    if (finalInMs != null && finalOutMs != null && finalOutMs <= finalInMs) {
        throw new Error('clockedOutAt must be after clockedInAt');
    }

    const updates = { updatedAt: serverTimestamp() };
    if (newInTs)  updates.clockedInAt = newInTs;
    if (newOutTs) updates.clockedOutAt = newOutTs;
    // Stamp the edit on the doc so the UI can show a "✏️ edited" badge.
    // editedTimesAt is server-stamped; editedTimesBy + editedTimesReason
    // are admin-supplied. We always overwrite — the latest edit wins,
    // and full edit history lives in the audit log.
    updates.editedTimesAt = serverTimestamp();
    updates.editedTimesBy = adminName;
    if (reason) updates.editedTimesReason = String(reason).slice(0, 300);

    await updateDoc(docRef, updates);

    recordAudit({
        action: 'offsite.edit_times',
        actorName: adminName,
        actorId: adminId ?? null,
        targetType: 'offsite_shift',
        targetId: id,
        details: {
            before: { clockedInAt: existingInMs, clockedOutAt: existingOutMs },
            after:  { clockedInAt: finalInMs,    clockedOutAt: finalOutMs    },
            reason: reason || null,
        },
    });
}

// Cancel a still-pending shift (staff never clocked in). Used to
// undo a mis-scheduled entry. Distinct from force-clock-out — the
// staff member never started, so there's no time to account for.
export async function cancelOffsiteShift({ id, adminName, adminId, reason }) {
    if (!id) throw new Error('id required');
    if (!adminName) throw new Error('adminName required');
    await updateDoc(doc(db, 'offsite_shifts', id), {
        status: OFFSITE_STATUS.CANCELLED,
        updatedAt: serverTimestamp(),
    });
    recordAudit({
        action: 'offsite.cancel',
        actorName: adminName,
        actorId: adminId ?? null,
        targetType: 'offsite_shift',
        targetId: id,
        details: reason ? { reason } : {},
    });
}

// Subscribe to pending + active off-site shifts for a single staff
// member. Used by the staff-side prompt to know whether to show the
// modal. Returns the unsubscribe.
//
// We don't use `where('status','in', [...])` because that requires a
// composite index (status + staffName) that we don't ship by default.
// Instead we fetch by staffName only and filter status client-side —
// max document count per staff is tiny (a handful) so it's cheap.
export function subscribeOpenForStaff(staffName, cb) {
    if (!staffName) return () => {};
    const q = query(
        collection(db, 'offsite_shifts'),
        where('staffName', '==', staffName),
    );
    return onSnapshot(q, (snap) => {
        const list = [];
        snap.forEach(d => {
            const data = { id: d.id, ...d.data() };
            if (data.status === OFFSITE_STATUS.PENDING
             || data.status === OFFSITE_STATUS.ACTIVE) {
                list.push(data);
            }
        });
        // Order by scheduledArrivalAt asc — earliest first so the
        // prompt walks through them in order.
        list.sort((a, b) => {
            const ams = a.scheduledArrivalAt?.toMillis ? a.scheduledArrivalAt.toMillis() : 0;
            const bms = b.scheduledArrivalAt?.toMillis ? b.scheduledArrivalAt.toMillis() : 0;
            return ams - bms;
        });
        cb(list);
    }, (err) => {
        console.warn('offsite subscribe failed:', err);
        cb([]);
    });
}

// Admin-view subscription: every off-site shift across all staff,
// sorted by recency. The admin section caps to a reasonable window
// (default 90 days back) so the list stays manageable.
export function subscribeAllOffsite(cb, { historyDays = 90 } = {}) {
    const cutoff = Timestamp.fromMillis(Date.now() - historyDays * 86400_000);
    // Order by createdAt desc (newest first). historyDays guards against
    // the list growing unbounded over years of usage.
    const q = query(
        collection(db, 'offsite_shifts'),
        where('createdAt', '>=', cutoff),
        orderBy('createdAt', 'desc'),
        limit(200),
    );
    return onSnapshot(q, (snap) => {
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        cb(list);
    }, (err) => {
        console.warn('offsite admin subscribe failed:', err);
        cb([]);
    });
}

// Format a stored Timestamp for the staff prompt + admin list. Pure
// helper — testable + reusable.
export function formatOffsiteWhen(ts, locale = 'en-US') {
    if (!ts) return '';
    const ms = ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : 0);
    if (!ms) return '';
    return new Date(ms).toLocaleString(locale, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

// Bucket a shift for UI grouping. Pure helper — no Firestore calls.
// Used by the staff prompt to decide what question to ask:
//   'clock_in_now'     — pending shift, arrival is in the past or
//                        within 15 min from now → time to clock in
//   'clock_in_soon'    — pending shift, arrival is more than 15 min
//                        away → "you'll be reminded closer to the time"
//   'clock_out'        — active shift → time to clock out
//   'done'             — completed or cancelled → no prompt
export function offsitePromptKind(shift, nowMs = Date.now()) {
    if (!shift) return 'done';
    if (shift.status === OFFSITE_STATUS.COMPLETED) return 'done';
    if (shift.status === OFFSITE_STATUS.CANCELLED) return 'done';
    if (shift.status === OFFSITE_STATUS.ACTIVE) return 'clock_out';
    // pending: did the arrival window open yet?
    const arrival = shift.scheduledArrivalAt?.toMillis
        ? shift.scheduledArrivalAt.toMillis()
        : (shift.scheduledArrivalAt?.seconds ? shift.scheduledArrivalAt.seconds * 1000 : 0);
    if (!arrival) return 'clock_in_now';   // no time stamped → show immediately
    if (nowMs >= arrival - 15 * 60_000) return 'clock_in_now';
    return 'clock_in_soon';
}

// Dismissal store — when staff taps "Not yet" we delay the next
// prompt by DISMISS_TTL_MS so we don't immediately re-modal them.
// Keyed by shift id so each pending/active shift dismisses
// independently. Stored in localStorage so a tab close + reopen
// re-shows the prompt (Andrew: "the app will keep asking until
// they press yes or i go a clock them out" — a fresh app launch
// resets the snooze, regular reloads respect it).
//
// "Reset on app launch" is implemented inside the prompt component —
// it clears every key on its first render of a fresh session via
// sessionStorage marker.
const DISMISS_TTL_MS = 10 * 60_000; // 10 min

export function snoozeOffsitePrompt(shiftId, nowMs = Date.now()) {
    if (!shiftId) return;
    try {
        localStorage.setItem(
            `ddmau:offsite_snooze_${shiftId}`,
            String(nowMs + DISMISS_TTL_MS),
        );
    } catch { /* private-mode safari — best-effort */ }
}

export function isOffsitePromptSnoozed(shiftId, nowMs = Date.now()) {
    if (!shiftId) return false;
    try {
        const v = localStorage.getItem(`ddmau:offsite_snooze_${shiftId}`);
        if (!v) return false;
        return Number(v) > nowMs;
    } catch {
        return false;
    }
}

// Clear ALL snooze keys — called by the prompt on its first render
// per app session so a freshly opened app re-asks even if the user
// dismissed earlier today.
export function clearAllOffsiteSnoozes() {
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith('ddmau:offsite_snooze_')) {
                localStorage.removeItem(k);
            }
        }
    } catch { /* best-effort */ }
}

// One-shot: get the most-recent off-site shifts (admin export later).
// Not used by the live UI but handy for a CSV dump.
export async function listRecentOffsite({ limit: lim = 100 } = {}) {
    const q = query(
        collection(db, 'offsite_shifts'),
        orderBy('createdAt', 'desc'),
        limit(lim),
    );
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(d => list.push({ id: d.id, ...d.data() }));
    return list;
}
