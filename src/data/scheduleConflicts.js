// scheduleConflicts.js — the scheduling conflict engine, extracted from
// Schedule.jsx (Phase 1, SCHEDULING-FORENSICS.md §13). Pure functions only.
//
// The component versions of staffOffOn/partialOffWindows closed over
// `viewerTimeOff`; here the time-off list is an explicit first argument so
// the exact same logic is unit-testable against the golden dataset —
// including the mixed time_off schema (`date` vs `startDate/endDate`) that
// has produced three shipped bugs. Schedule.jsx keeps thin wrappers that
// bind its live state.

import { parseLocalDate, ptoIsPartial, timeRangesOverlap, weekKeyOf } from './scheduleCore';

// ── Availability conflict helper ───────────────────────────────────────────
// Single source of truth for "does this shift fit the staff's declared
// availability?" Used by:
//   • AddShiftModal — banner in the conflict warnings stack
//   • handleUpdateShiftTimes — toast on inline drag-resize of a cube edge
//   • handleDropShift — toast on drag-to-different-day move
// Returns null when fine; otherwise:
//   { type: 'off' }                        staff marked the day unavailable
//   { type: 'outside', from, to }          shift extends past the window
// "Constrained" means the staff narrowed from the modal default 09:00–21:00.
// Default-wide availability shouldn't fire warnings on every early-open or
// late-close shift.
// ── Date-aware availability resolution (2026-08-29 multi-week) ─────────────
// THE way to read someone's availability for a concrete date. A week-
// specific entry in staff.availabilityWeeks (keyed by that week's Sunday)
// replaces the base weekly pattern for that whole week; otherwise the base
// `availability` map applies. Same opt-OUT semantics inside either map:
// an absent day key means available all day. Every consumer (conflict
// checker, auto-fill, grid badge, who-can-work modal) resolves through
// here so a week override is honored everywhere at once.
export function availabilityForDate(staff, dateStr) {
    const weeks = staff && staff.availabilityWeeks;
    if (weeks && typeof weeks === 'object' && !Array.isArray(weeks)) {
        const wk = weekKeyOf(dateStr);
        const m = wk ? weeks[wk] : null;
        if (m && typeof m === 'object' && !Array.isArray(m)) return m;
    }
    return (staff && staff.availability) || {};
}

export function checkAvailabilityConflict(staff, dateStr, startTime, endTime) {
    if (!staff || !dateStr || !startTime || !endTime) return null;
    const d = parseLocalDate(dateStr);
    if (!d) return null;
    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dayKey = dayKeys[d.getDay()];
    const dayAvail = availabilityForDate(staff, dateStr)[dayKey];
    if (!dayAvail) return null;
    if (dayAvail.available === false) return { type: 'off' };
    const from = dayAvail.from || '09:00';
    const to   = dayAvail.to   || '21:00';
    const constrained = from > '09:00' || to < '21:00';
    if (!constrained) return null;
    if (startTime < from || endTime > to) {
        return { type: 'outside', from, to };
    }
    return null;
}

// Is a staff member off on a given date? Any non-denied WHOLE-DAY time-off
// entry covering the date counts (pending counts too — deliberate: auto-fill
// and drag-drop must not schedule over a request a manager is about to
// approve). Partial windows do NOT take the day off — they stay schedulable.
// Handles the mixed schema: `startDate/endDate` (current) OR bare `date`
// (legacy docs).
export function staffOffOn(timeOff, staffName, dateStr) {
    return (timeOff || []).some(t => {
        if (t.status === 'denied') return false;
        if (t.staffName !== staffName) return false;
        if (ptoIsPartial(t)) return false; // a partial window doesn't take the whole day off — they stay schedulable
        const start = t.startDate || t.date;
        const end = t.endDate || t.date;
        return dateStr >= start && dateStr <= end;
    });
}

// Partial off windows for a staffer on a date — drives the overlap warning
// when a shift is placed during their requested-off hours, and the window
// label in the queue / PTO view. Same visibility rules as staffOffOn.
export function partialOffWindows(timeOff, staffName, dateStr) {
    return (timeOff || []).filter(t => {
        if (t.status === 'denied') return false;
        if (t.staffName !== staffName) return false;
        if (!ptoIsPartial(t)) return false;
        const start = t.startDate || t.date;
        const end = t.endDate || t.date;
        return dateStr >= start && dateStr <= end;
    });
}

// True if a shift (startTime–endTime on dateStr) lands inside any partial
// off window the staffer requested — used for the soft overlap warning.
export function shiftOverlapsPartialOff(timeOff, staffName, dateStr, startTime, endTime) {
    return partialOffWindows(timeOff, staffName, dateStr)
        .some(t => timeRangesOverlap(startTime, endTime, t.startTime, t.endTime));
}

// ── Overlap conflict engine ────────────────────────────────────────────────
// Same staffName, same date, overlapping time ranges. Two shifts with
// adjacent times (one ends exactly when the other starts) are NOT a
// conflict — common pattern for "FOH lunch then BOH dinner" deliberate
// double-shifts. Non-editors only consider published shifts (drafts are
// manager working state and may intentionally have temporary overlaps).
//
// Performance: O(n²) on shifts-per-staff-per-day but the typical input is
// <50 shifts/week; even at 200 shifts the per-week computation is <1ms.
export function computeScheduleConflicts(shifts, canEdit) {
    const parseHM = (t) => {
        if (!t || typeof t !== 'string') return null;
        const [h, m] = t.split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        return h * 60 + m;
    };
    // Group shifts by staffName + date, then check pairs.
    const byKey = new Map();
    for (const sh of (shifts || [])) {
        if (!sh.staffName || !sh.date) continue;
        if (!canEdit && sh.published === false) continue;
        const start = parseHM(sh.startTime);
        const end   = parseHM(sh.endTime);
        if (start === null || end === null) continue;
        const k = `${sh.staffName}__${sh.date}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push({ id: sh.id, staffName: sh.staffName, date: sh.date, side: sh.side, startMin: start, endMin: end, raw: sh });
    }
    const conflicts = [];
    for (const [, arr] of byKey) {
        if (arr.length < 2) continue;
        // Sort by start so pair comparison order is deterministic.
        arr.sort((a, b) => a.startMin - b.startMin);
        for (let i = 0; i < arr.length - 1; i++) {
            for (let j = i + 1; j < arr.length; j++) {
                // Overlap if a.start < b.end AND b.start < a.end.
                // Adjacency (a.end === b.start) is NOT a conflict.
                if (arr[i].endMin > arr[j].startMin && arr[j].endMin > arr[i].startMin) {
                    conflicts.push({
                        staffName: arr[i].staffName,
                        date: arr[i].date,
                        shiftIds: [arr[i].id, arr[j].id],
                        label: `${arr[i].raw.startTime}–${arr[i].raw.endTime} vs ${arr[j].raw.startTime}–${arr[j].raw.endTime}`,
                    });
                }
            }
        }
    }
    return conflicts;
}
