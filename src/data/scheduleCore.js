// scheduleCore.js — the scheduling system's pure brain, extracted from
// Schedule.jsx (Phase 1 of the 2026-08-09 stabilization plan, SCHEDULING-
// FORENSICS.md §13). Every export here is a PURE function or constant:
// no React, no Firestore, no window. That's the point — this is the code
// that had zero test coverage while living inside a 14k-line component.
// Behavior is byte-identical to the in-component originals; the component
// imports these back. Golden-dataset tests live in scheduleCore.test.js.

// ── Constants ──────────────────────────────────────────────────────────────

export const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Stable empty array for empty grid cells (identity-stable so memo'd cell
// consumers don't churn).
export const EMPTY_CELL_SHIFTS = Object.freeze([]);
export const DAYS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
export const DAYS_FULL_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAYS_FULL_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
// Day-of-week IDs — index-aligned with DAYS_EN (so DAY_IDS[d.getDay()] gives
// the id). Used by RecurringShiftsModal and TemplateEditorModal's daysOfWeek
// picker. Single source of truth so the two day pickers stay visually
// consistent and the apply-template day-of-week guard can read the field
// without any conversion.
export const DAY_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const dayIdFromDateStr = (dateStr) => {
    // parseLocalDate avoids the UTC drift that `new Date('YYYY-MM-DD')`
    // hits in time zones west of UTC (the date string is interpreted as
    // UTC midnight, which becomes the previous evening locally).
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return null;
    return DAY_IDS[new Date(y, m - 1, d).getDay()];
};

// FLSA workweek per Andrew's spec: Sunday through Saturday.
export const WEEK_START_DOW = 0; // 0 = Sunday

// OT thresholds for color coding (federal-only, MO follows federal).
export const HOURS_GREEN_MAX = 30;
export const HOURS_YELLOW_MAX = 40;

// Minor labor thresholds (kept conservative — 16-17 yo can technically work
// any hours under federal law, but DD Mau is being defensive).
export const MINOR_LATE_HOUR = 22; // shifts past 10 PM flagged
export const MINOR_DAILY_HOURS_MAX = 8;
export const MINOR_WEEKLY_HOURS_MAX = 30;

// ── Schedule sides (FOH / BOH) ─────────────────────────────────────────────
// Two separate schedules. Each staff member belongs to ONE side via the
// `scheduleSide` field on their staff record (managed in AdminPanel). FOH and
// BOH have their own managers, shift leads, and crew — they don't share staff.
//
// Role-based inference is used when scheduleSide hasn't been set explicitly
// yet (transition state — every staff record will get an explicit value).

// Roles that obviously belong to BOH (kitchen).
export const BOH_ROLE_HINTS = new Set([
    'BOH', 'Pho', 'Pho Station', 'Grill', 'Fryer', 'Fried Rice', 'Dish',
    'Bao/Tacos/Banh Mi', 'Spring Rolls/Prep', 'Prep',
    'Kitchen Manager', 'Asst Kitchen Manager',
]);

// Resolve a staff member's side from their explicit scheduleSide field,
// falling back to role inference. Default = 'foh'.
export const resolveStaffSide = (staff) => {
    if (!staff) return 'foh';
    if (staff.scheduleSide === 'foh' || staff.scheduleSide === 'boh') return staff.scheduleSide;
    if (BOH_ROLE_HINTS.has(staff.role)) return 'boh';
    return 'foh';
};

// scheduleSide:'both' is a supported value (managers/floaters who work both
// sides) — they belong to EVERY side's roster. resolveStaffSide stays
// single-valued ('both' → foh fallback) for contexts that need one home side
// (legacy shift-side resolution); membership checks must come through here.
export const isOnSide = (staff, side) => {
    if (staff?.scheduleSide === 'both') return true;
    return resolveStaffSide(staff) === side;
};

// Role groups — used by staffing-need slots and day templates to scope which
// staff can fill a given slot. "any" = no role filter (legacy / catch-all).
export const SLOT_ROLE_GROUPS = [
    { id: "any",             labelEn: "Any",              labelEs: "Cualquiera",       emoji: "👥", roles: null },
    { id: "foh-staff",       labelEn: "FOH",              labelEs: "FOH",              emoji: "🧑‍💼", roles: ["FOH"] },
    { id: "shift-lead",      labelEn: "Shift Lead",       labelEs: "Líder de Turno",   emoji: "🛡️", roles: ["Shift Lead"] },
    { id: "manager",         labelEn: "Manager",          labelEs: "Gerente",          emoji: "👔", roles: ["Manager", "Asst Manager", "Owner"] },
    { id: "kitchen-manager", labelEn: "Kitchen Manager",  labelEs: "Gerente Cocina",   emoji: "🧑‍🍳", roles: ["Kitchen Manager", "Asst Kitchen Manager"] },
    { id: "boh-staff",       labelEn: "BOH",              labelEs: "BOH",              emoji: "🔥", roles: ["BOH", "Pho", "Pho Station", "Grill", "Fryer", "Fried Rice", "Dish", "Bao/Tacos/Banh Mi", "Spring Rolls/Prep", "Prep"] },
];
export const SLOT_ROLE_BY_ID = Object.fromEntries(SLOT_ROLE_GROUPS.map(g => [g.id, g]));
export const isRoleEligible = (staffRole, roleGroupId) => {
    if (!roleGroupId || roleGroupId === "any") return true;
    const group = SLOT_ROLE_BY_ID[roleGroupId];
    if (!group || !group.roles) return true;
    return group.roles.includes(staffRole);
};

// Common shift presets surfaced as one-tap chips in the empty-cell quick-add
// flow AND as preset chips inside the full Add Shift modal. Single source of
// truth so manager edits to either flow stay in sync.
export const SHIFT_PRESETS_FOH = [
    { label: '10–3', start: '10:00', end: '15:00', isDouble: false },
    { label: '11–4', start: '11:00', end: '16:00', isDouble: false },
    { label: '3–8',  start: '15:00', end: '20:00', isDouble: false },
    { label: '4–8',  start: '16:00', end: '20:00', isDouble: false },
    { label: '12–7', start: '12:00', end: '19:00', isDouble: false },
    { label: '10–8 (double)', start: '10:00', end: '20:00', isDouble: true },
];
export const SHIFT_PRESETS_BOH = [
    { label: '10–8 (double)', start: '10:00', end: '20:00', isDouble: true },
    { label: '10–3', start: '10:00', end: '15:00', isDouble: false },
    { label: '4–8',  start: '16:00', end: '20:00', isDouble: false },
];
export const getShiftPresets = (side) => (side === 'boh' ? SHIFT_PRESETS_BOH : SHIFT_PRESETS_FOH);

// Sanitize a manager-saved preset list (config/schedule_settings.shiftPresets).
// Drops malformed rows; falls back to the built-in defaults if empty/missing,
// so a bad/empty config can never leave the quick-add with zero chips.
export const sanitizeShiftPresets = (arr, fallback) => {
    if (!Array.isArray(arr)) return fallback;
    const clean = arr.map(p => ({
        label: String(p?.label || '').slice(0, 24).trim(),
        start: /^\d{1,2}:\d{2}$/.test(p?.start) ? p.start : '',
        end: /^\d{1,2}:\d{2}$/.test(p?.end) ? p.end : '',
        isDouble: !!p?.isDouble,
    })).filter(p => p.label && p.start && p.end);
    return clean.length ? clean : fallback;
};

// Role-tier color tokens. Three tiers:
//   ORANGE  = manager-tier (Owner, Manager, Asst Manager, Kitchen Manager,
//             Asst Kitchen Manager). They run the floor.
//   GREEN   = shift lead (either dedicated "Shift Lead" role OR the
//             per-staff shiftLead flag set by an admin). Floor captain.
//   BLUE    = everyone else (regular FOH or BOH).
// Used by every shift cube AND by the left-column staff name in the
// weekly grid, so the same person reads the same color everywhere.
export const MANAGER_ROLES = new Set([
    'Owner', 'Manager', 'Asst Manager',
    'Kitchen Manager', 'Asst Kitchen Manager',
]);
export const roleColors = (role, shiftLead) => {
    if (MANAGER_ROLES.has(role)) {
        return { bg: 'bg-orange-100', border: 'border-orange-400', text: 'text-orange-900', dot: 'bg-orange-500', tier: 'manager' };
    }
    if (shiftLead || role === 'Shift Lead') {
        return { bg: 'bg-green-100',  border: 'border-green-400',  text: 'text-green-800',  dot: 'bg-green-500',  tier: 'lead' };
    }
    return { bg: 'bg-blue-100',  border: 'border-blue-300',  text: 'text-blue-800',  dot: 'bg-blue-500',   tier: 'staff' };
};

// ── Date helpers ───────────────────────────────────────────────────────────

export const pad2 = (n) => String(n).padStart(2, '0');
export const toDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// Parse YYYY-MM-DD as a LOCAL date (not UTC). new Date('2026-05-08') interprets
// as UTC midnight, which slides a day in negative-UTC timezones. This matters
// — schedule data is local-business-day, never UTC.
export const parseLocalDate = (dateStr) => {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
};

export const startOfWeek = (date) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const offset = (d.getDay() - WEEK_START_DOW + 7) % 7;
    d.setDate(d.getDate() - offset);
    return d;
};

export const addDays = (date, n) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + n);
    return d;
};

// Whole weeks between two week-start Dates (both local-midnight). DST-safe:
// a transition between them makes the raw delta N×168h ± 1h, so Math.floor
// flips parity — Math.round recovers the true week count. (This IS the
// 2026-05-22 bi-weekly-cadence fix, extracted so it's finally testable.)
export const weeksBetween = (fromWeekStart, toWeekStart) => {
    return Math.round((toWeekStart.getTime() - fromWeekStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
};

// blockedDatesInRange — every day in [startStr, endStr] that lands on a
// no-time-off / closed blackout, as [{date, reason}]. Single source of truth
// for BOTH the staff self-serve guard (hard stop) AND the manager add-entry
// form (surfaced as an overridable warning so a manager can make an exception).
// `blocksByDate` is the component's Map<'YYYY-MM-DD', block[]>. Iterates by
// addDays() (DST-safe, unlike Date.setDate mutation) and caps at 120 days.
export function blockedDatesInRange(startStr, endStr, blocksByDate) {
    const out = [];
    if (!startStr || !endStr || !blocksByDate) return out;
    const startD = parseLocalDate(startStr);
    const endD = parseLocalDate(endStr);
    if (!startD || !endD) return out;
    const sStr = toDateStr(startD);
    const eStr = toDateStr(endD);
    for (let i = 0; i < 120; i++) {
        const d = addDays(startD, i);
        const dStr = toDateStr(d);
        if (dStr > eStr) break;
        if (dStr < sStr) continue;
        const hit = (blocksByDate.get(dStr) || []).find(b => b.type === 'no_timeoff' || b.type === 'closed');
        if (hit) out.push({ date: dStr, reason: hit.reason || 'blocked' });
    }
    return out;
}

// localStorage round-trip helpers for shifts. JSON.stringify turns a
// Firestore Timestamp into `{seconds, nanoseconds}` which doesn't
// have .toMillis() — downstream code that calls .toMillis() crashes.
// stripShiftTimestamps replaces Timestamp instances with plain
// `{__ts: millis}` markers; rehydrateShiftTimestamps reverses it on
// load with a minimal shim exposing .toMillis() + .seconds.
// Production audit 2026-05-22.
export const stripShiftTimestamps = (sh) => {
    if (!sh || typeof sh !== 'object') return sh;
    const out = { ...sh };
    for (const k of ['createdAt', 'updatedAt', 'publishedAt', 'pendingOfferAt', 'coverRequestedAt']) {
        const v = sh[k];
        if (v && typeof v === 'object' && typeof v.toMillis === 'function') {
            out[k] = { __ts: v.toMillis() };
        }
    }
    return out;
};
export const rehydrateShiftTimestamps = (sh) => {
    if (!sh || typeof sh !== 'object') return sh;
    const out = { ...sh };
    for (const k of ['createdAt', 'updatedAt', 'publishedAt', 'pendingOfferAt', 'coverRequestedAt']) {
        const v = sh[k];
        if (v && typeof v === 'object' && typeof v.__ts === 'number') {
            const ms = v.__ts;
            out[k] = { toMillis: () => ms, seconds: Math.floor(ms / 1000) };
        }
    }
    return out;
};

export const formatDateShort = (date, isEn) => {
    const m = date.getMonth() + 1;
    const d = date.getDate();
    return isEn ? `${m}/${d}` : `${d}/${m}`;
};

export const formatTime12h = (time24) => {
    if (!time24) return '';
    const [h, m] = time24.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return m === 0 ? `${h12}${period}` : `${h12}:${pad2(m)}${period}`;
};

// Partial time-off helpers (Andrew 2026-06-17: staff can request a specific
// window off — e.g. 3–8pm — not just a whole day). A whole-day entry has no
// startTime/endTime; a partial entry has partial:true + startTime/endTime.
export const ptoIsPartial = (t) => !!(t && t.partial && t.startTime && t.endTime);
export const ptoWindowLabel = (t) => (ptoIsPartial(t) ? `${formatTime12h(t.startTime)}–${formatTime12h(t.endTime)}` : '');
export const hhmmToMin = (hhmm) => {
    const [h, m] = String(hhmm || '').split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};
// Do two HH:mm ranges overlap? Half-open, so touching edges (10–3 vs 3–8) don't.
export const timeRangesOverlap = (aS, aE, bS, bE) => {
    if (!aS || !aE || !bS || !bE) return false;
    return hhmmToMin(aS) < hhmmToMin(bE) && hhmmToMin(bS) < hhmmToMin(aE);
};

// Calculate hours between two HH:mm times, handling overnight shifts.
export const hoursBetween = (start, end, isDouble = false) => {
    if (!start || !end) return 0;
    const [sH, sM] = start.split(':').map(Number);
    const [eH, eM] = end.split(':').map(Number);
    let mins = (eH * 60 + eM) - (sH * 60 + sM);
    if (mins <= 0) mins += 24 * 60; // overnight wrap
    let hrs = mins / 60;
    // Double-shift = 1 hr unpaid break (matches M2 L2 policy).
    if (isDouble) hrs = Math.max(0, hrs - 1);
    return hrs;
};

// Paid hours for ONE day given that day's shifts. If 2+ shifts that day
// (e.g. morning 10-3 + evening 4-8), it's a double — subtract the unpaid
// 1-hr break ONCE for the day. Otherwise honor the legacy single-shift
// isDouble flag (for shifts recorded as a single 10-8 double with built-in
// break). One source of truth for hours math.
export const dayPaidHours = (dayShifts) => {
    if (!dayShifts || dayShifts.length === 0) return 0;
    if (dayShifts.length === 1) {
        const sh = dayShifts[0];
        return hoursBetween(sh.startTime, sh.endTime, !!sh.isDouble);
    }
    // 2+ shifts on the same day → automatic double, deduct 1h break once.
    const raw = dayShifts.reduce((sum, sh) => sum + hoursBetween(sh.startTime, sh.endTime, false), 0);
    return Math.max(0, raw - 1);
};

// True if a staff has 2+ shifts on the given date OR a single shift flagged
// isDouble. Used for the visual badge on shift cubes.
export const isDoubleDay = (dayShifts) => {
    if (!dayShifts || dayShifts.length === 0) return false;
    if (dayShifts.length >= 2) return true;
    return !!dayShifts[0].isDouble;
};

export const formatHours = (h) => {
    if (h === Math.floor(h)) return `${h}h`;
    return `${h.toFixed(1)}h`;
};

export const hoursColor = (h) => {
    if (h >= HOURS_YELLOW_MAX) return 'bg-red-100 text-red-800 border-red-300';
    if (h >= HOURS_GREEN_MAX) return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    return 'bg-green-100 text-green-800 border-green-300';
};

// ── Minor-labor warning logic ──────────────────────────────────────────────

export const minorShiftWarnings = (shift, isEn) => {
    const warnings = [];
    if (!shift.endTime) return warnings;
    const [eH] = shift.endTime.split(':').map(Number);
    if (eH >= MINOR_LATE_HOUR || eH === 0) {
        warnings.push(isEn ? `Past ${MINOR_LATE_HOUR - 12}PM` : `Después de las ${MINOR_LATE_HOUR - 12}PM`);
    }
    const hrs = hoursBetween(shift.startTime, shift.endTime, shift.isDouble);
    if (hrs > MINOR_DAILY_HOURS_MAX) {
        warnings.push(isEn ? `>${MINOR_DAILY_HOURS_MAX}h/day` : `>${MINOR_DAILY_HOURS_MAX}h/día`);
    }
    return warnings;
};

// Andrew 2026-05-21: "the schedule app was running a little glitchy".
// Module-level helpers + a memoized AvailabilityBadge moved out of
// the grid render (the badge component itself stays in Schedule.jsx —
// it's JSX; these are its pure inputs).
export const SCHEDULE_DAY_KEYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

export function shortTime12h(t) {
    if (!t) return '';
    const [h, m] = String(t).split(':').map(Number);
    const period = h >= 12 ? 'p' : 'a';
    const h12 = ((h + 11) % 12) + 1;
    return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}
