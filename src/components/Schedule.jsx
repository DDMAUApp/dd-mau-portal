/**
 * Schedule.jsx — DD Mau native scheduling (replaces Sling import view).
 *
 * Phase 1 (this file):
 *   • Read shifts from Firestore collection "shifts"
 *   • 3 view modes: Weekly Grid (staff × days), Daily, List
 *   • Per-staff weekly hour totals with OT-warning colors (<30 green, 30–39 yellow, ≥40 red)
 *   • Manager/admin-only "+ Add Shift" modal so we can seed real data without
 *     a full editor (the proper drag/drop editor is Phase 2)
 *   • Minor-labor warnings on shifts (past 10 PM, >8 hrs/day, >30 hrs/week)
 *   • Sysco/Sling import is no longer read here — old `ops/schedule_*` doc is
 *     left untouched in Firestore as a transition fallback (admins can still
 *     query it directly if needed). The legacy doc is shown collapsed at the
 *     bottom for reference until we trust the new system.
 *
 * Phase 2 (next): proper grid editor (drag, batch, copy-week, draft/publish).
 * Phase 3: time-off requests + availability windows.
 * Phase 4: shift swaps + notifications.
 *
 * Permissions:
 *   • View own shifts: all staff
 *   • View all shifts: all staff (transparent schedule)
 *   • Add/edit/delete shifts: admin OR staff with role containing "Manager"
 *     (see canEditSchedule() in src/data/staff.js)
 */
import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { db } from '../firebase';
import { toast, undoToast } from '../toast';
import {
    collection, doc, onSnapshot, query, where, addDoc, deleteDoc, updateDoc,
    setDoc, serverTimestamp, writeBatch, runTransaction, arrayUnion,
    orderBy, limit, getDocs, deleteField,
} from 'firebase/firestore';
import { canEditSchedule, isAdmin, isAdminId, LOCATION_LABELS, isOnScheduleAt } from '../data/staff';
import { getEventsForDate, EVENT_KIND_TONES } from '../data/calendarEvents';
import { notifyAdmins, notifyStaff, notifyManagement } from '../data/notify';
import { auditAvailabilityChange, auditPtoChange, auditShiftChange, auditScheduleConfig } from '../data/audit';
import { enableFcmPush } from '../messaging';
import { DAYPARTS, aggregateSplh, scheduledHoursByDayPart, variance } from '../data/splh';
// 2026-05-27 — Andrew: forecast bar redesigned to a weather-channel-
// style row of day cards. Lucide weather glyphs picked per NWS
// shortForecast keyword (sunny/cloudy/rain/etc.).
import {
    Sun, Cloud, CloudSun, CloudRain, CloudDrizzle, CloudLightning,
    CloudSnow, CloudFog, Wind, ChevronDown,
    // Schedule top-of-page chrome icons — replace bare emoji glyphs
    // for a more polished, OS-consistent look across iOS + Android.
    Sofa, Utensils, LayoutGrid, LayoutList, List, Palmtree,
    Search, User, Users, Megaphone, Plus, MoreHorizontal, Bell,
    Hourglass, RefreshCw,
    // More-menu items
    Printer, Calendar, Copy, Repeat, Ban,
} from 'lucide-react';
import ModalPortal from './ModalPortal';
import { printViaNative, downloadFile } from '../capacitor-bridge';
import ConfirmModal from './ConfirmModal';
import OfferShiftModal from './OfferShiftModal';
import TakeShiftModal from './TakeShiftModal';
import { useAppData } from '../v2/AppDataContext';

// ── Constants ──────────────────────────────────────────────────────────────

const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DAYS_FULL_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_FULL_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
// Day-of-week IDs — index-aligned with DAYS_EN (so DAY_IDS[d.getDay()] gives
// the id). Used by RecurringShiftsModal and (as of 2026-05-11) by
// TemplateEditorModal's daysOfWeek picker. Single source of truth so the
// two day pickers stay visually consistent and the apply-template
// day-of-week guard can read the field without any conversion.
const DAY_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dayIdFromDateStr = (dateStr) => {
    // parseLocalDate avoids the UTC drift that `new Date('YYYY-MM-DD')`
    // hits in time zones west of UTC (the date string is interpreted as
    // UTC midnight, which becomes the previous evening locally).
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return null;
    return DAY_IDS[new Date(y, m - 1, d).getDay()];
};

// FLSA workweek per Andrew's spec: Sunday through Saturday.
const WEEK_START_DOW = 0; // 0 = Sunday

// OT thresholds for color coding (federal-only, MO follows federal).
const HOURS_GREEN_MAX = 30;
const HOURS_YELLOW_MAX = 40;

// Minor labor thresholds (kept conservative — 16-17 yo can technically work
// any hours under federal law, but DD Mau is being defensive).
const MINOR_LATE_HOUR = 22; // shifts past 10 PM flagged
const MINOR_DAILY_HOURS_MAX = 8;
const MINOR_WEEKLY_HOURS_MAX = 30;

// ── Schedule sides (FOH / BOH) ─────────────────────────────────────────────
// Two separate schedules. Each staff member belongs to ONE side via the
// `scheduleSide` field on their staff record (managed in AdminPanel). FOH and
// BOH have their own managers, shift leads, and crew — they don't share staff.
//
// Role-based inference is used when scheduleSide hasn't been set explicitly
// yet (transition state — every staff record will get an explicit value).

// Roles that obviously belong to BOH (kitchen).
const BOH_ROLE_HINTS = new Set([
    'BOH', 'Pho', 'Pho Station', 'Grill', 'Fryer', 'Fried Rice', 'Dish',
    'Bao/Tacos/Banh Mi', 'Spring Rolls/Prep', 'Prep',
    'Kitchen Manager', 'Asst Kitchen Manager',
]);

// ── useStableCallback — "latest ref" / useEvent pattern ──────────────
// Returns a callback whose IDENTITY never changes (so React.memo'd
// children that receive it don't re-render when the parent re-renders),
// but which ALWAYS invokes the most-recent version of `fn`. We refresh
// the ref on every render, so the wrapper closes over the latest state
// at call time — there is NO dependency array to forget, hence NO
// stale-closure risk. Use ONLY for event handlers (fired after commit,
// from user interaction), never for values read synchronously during
// render. This lets us memoize WeeklyGrid below WITHOUT touching any of
// the ~50 mutation handler bodies — their logic stays byte-for-byte
// identical, we just hand stable wrappers to the children.
function useStableCallback(fn) {
    const ref = useRef(fn);
    ref.current = fn;
    return useRef((...args) => ref.current(...args)).current;
}

// Resolve a staff member's side from their explicit scheduleSide field,
// falling back to role inference. Default = 'foh'.
const resolveStaffSide = (staff) => {
    if (!staff) return 'foh';
    if (staff.scheduleSide === 'foh' || staff.scheduleSide === 'boh') return staff.scheduleSide;
    if (BOH_ROLE_HINTS.has(staff.role)) return 'boh';
    return 'foh';
};

const isOnSide = (staff, side) => resolveStaffSide(staff) === side;

// Role groups — used by staffing-need slots and day templates to scope which
// staff can fill a given slot. "any" = no role filter (legacy / catch-all).
const SLOT_ROLE_GROUPS = [
    { id: "any",             labelEn: "Any",              labelEs: "Cualquiera",       emoji: "👥", roles: null },
    { id: "foh-staff",       labelEn: "FOH",              labelEs: "FOH",              emoji: "🧑‍💼", roles: ["FOH"] },
    { id: "shift-lead",      labelEn: "Shift Lead",       labelEs: "Líder de Turno",   emoji: "🛡️", roles: ["Shift Lead"] },
    { id: "manager",         labelEn: "Manager",          labelEs: "Gerente",          emoji: "👔", roles: ["Manager", "Asst Manager", "Owner"] },
    { id: "kitchen-manager", labelEn: "Kitchen Manager",  labelEs: "Gerente Cocina",   emoji: "🧑‍🍳", roles: ["Kitchen Manager", "Asst Kitchen Manager"] },
    { id: "boh-staff",       labelEn: "BOH",              labelEs: "BOH",              emoji: "🔥", roles: ["BOH", "Pho", "Pho Station", "Grill", "Fryer", "Fried Rice", "Dish", "Bao/Tacos/Banh Mi", "Spring Rolls/Prep", "Prep"] },
];
const SLOT_ROLE_BY_ID = Object.fromEntries(SLOT_ROLE_GROUPS.map(g => [g.id, g]));
const isRoleEligible = (staffRole, roleGroupId) => {
    if (!roleGroupId || roleGroupId === "any") return true;
    const group = SLOT_ROLE_BY_ID[roleGroupId];
    if (!group || !group.roles) return true;
    return group.roles.includes(staffRole);
};

// Common shift presets surfaced as one-tap chips in the empty-cell quick-add
// flow AND as preset chips inside the full Add Shift modal. Single source of
// truth so manager edits to either flow stay in sync.
const SHIFT_PRESETS_FOH = [
    { label: '10–3', start: '10:00', end: '15:00', isDouble: false },
    { label: '11–4', start: '11:00', end: '16:00', isDouble: false },
    { label: '3–8',  start: '15:00', end: '20:00', isDouble: false },
    { label: '4–8',  start: '16:00', end: '20:00', isDouble: false },
    { label: '12–7', start: '12:00', end: '19:00', isDouble: false },
    { label: '10–8 (double)', start: '10:00', end: '20:00', isDouble: true },
];
const SHIFT_PRESETS_BOH = [
    { label: '10–8 (double)', start: '10:00', end: '20:00', isDouble: true },
    { label: '10–3', start: '10:00', end: '15:00', isDouble: false },
    { label: '4–8',  start: '16:00', end: '20:00', isDouble: false },
];
const getShiftPresets = (side) => (side === 'boh' ? SHIFT_PRESETS_BOH : SHIFT_PRESETS_FOH);

// Sanitize a manager-saved preset list (config/schedule_settings.shiftPresets).
// Drops malformed rows; falls back to the built-in defaults if empty/missing,
// so a bad/empty config can never leave the quick-add with zero chips.
const sanitizeShiftPresets = (arr, fallback) => {
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
const MANAGER_ROLES = new Set([
    'Owner', 'Manager', 'Asst Manager',
    'Kitchen Manager', 'Asst Kitchen Manager',
]);
const roleColors = (role, shiftLead) => {
    if (MANAGER_ROLES.has(role)) {
        return { bg: 'bg-orange-100', border: 'border-orange-400', text: 'text-orange-900', dot: 'bg-orange-500', tier: 'manager' };
    }
    if (shiftLead || role === 'Shift Lead') {
        return { bg: 'bg-green-100',  border: 'border-green-400',  text: 'text-green-800',  dot: 'bg-green-500',  tier: 'lead' };
    }
    return { bg: 'bg-blue-100',  border: 'border-blue-300',  text: 'text-blue-800',  dot: 'bg-blue-500',   tier: 'staff' };
};

// ── Date helpers ───────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const toDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// Parse YYYY-MM-DD as a LOCAL date (not UTC). new Date('2026-05-08') interprets
// as UTC midnight, which slides a day in negative-UTC timezones. This matters
// — schedule data is local-business-day, never UTC.
const parseLocalDate = (dateStr) => {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
};

const startOfWeek = (date) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const offset = (d.getDay() - WEEK_START_DOW + 7) % 7;
    d.setDate(d.getDate() - offset);
    return d;
};

const addDays = (date, n) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + n);
    return d;
};

// localStorage round-trip helpers for shifts. JSON.stringify turns a
// Firestore Timestamp into `{seconds, nanoseconds}` which doesn't
// have .toMillis() — downstream code that calls .toMillis() crashes.
// stripShiftTimestamps replaces Timestamp instances with plain
// `{__ts: millis}` markers; rehydrateShiftTimestamps reverses it on
// load with a minimal shim exposing .toMillis() + .seconds.
// Production audit 2026-05-22.
const stripShiftTimestamps = (sh) => {
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
const rehydrateShiftTimestamps = (sh) => {
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

const formatDateShort = (date, isEn) => {
    const m = date.getMonth() + 1;
    const d = date.getDate();
    return isEn ? `${m}/${d}` : `${d}/${m}`;
};

const formatTime12h = (time24) => {
    if (!time24) return '';
    const [h, m] = time24.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return m === 0 ? `${h12}${period}` : `${h12}:${pad2(m)}${period}`;
};

// Partial time-off helpers (Andrew 2026-06-17: staff can request a specific
// window off — e.g. 3–8pm — not just a whole day). A whole-day entry has no
// startTime/endTime; a partial entry has partial:true + startTime/endTime.
const ptoIsPartial = (t) => !!(t && t.partial && t.startTime && t.endTime);
const ptoWindowLabel = (t) => (ptoIsPartial(t) ? `${formatTime12h(t.startTime)}–${formatTime12h(t.endTime)}` : '');
const _hhmmToMin = (hhmm) => {
    const [h, m] = String(hhmm || '').split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};
// Do two HH:mm ranges overlap? Half-open, so touching edges (10–3 vs 3–8) don't.
const timeRangesOverlap = (aS, aE, bS, bE) => {
    if (!aS || !aE || !bS || !bE) return false;
    return _hhmmToMin(aS) < _hhmmToMin(bE) && _hhmmToMin(bS) < _hhmmToMin(aE);
};

// Calculate hours between two HH:mm times, handling overnight shifts.
const hoursBetween = (start, end, isDouble = false) => {
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
const dayPaidHours = (dayShifts) => {
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
const isDoubleDay = (dayShifts) => {
    if (!dayShifts || dayShifts.length === 0) return false;
    if (dayShifts.length >= 2) return true;
    return !!dayShifts[0].isDouble;
};

const formatHours = (h) => {
    if (h === Math.floor(h)) return `${h}h`;
    return `${h.toFixed(1)}h`;
};

const hoursColor = (h) => {
    if (h >= HOURS_YELLOW_MAX) return 'bg-red-100 text-red-800 border-red-300';
    if (h >= HOURS_GREEN_MAX) return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    return 'bg-green-100 text-green-800 border-green-300';
};

// ── Minor-labor warning logic ──────────────────────────────────────────────

const minorShiftWarnings = (shift, isEn) => {
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
function checkAvailabilityConflict(staff, dateStr, startTime, endTime) {
    if (!staff || !dateStr || !startTime || !endTime) return null;
    const d = parseLocalDate(dateStr);
    if (!d) return null;
    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dayKey = dayKeys[d.getDay()];
    const dayAvail = (staff.availability || {})[dayKey];
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

// Andrew 2026-05-21: "the schedule app was running a little glitchy".
// Module-level helpers + a memoized AvailabilityBadge moved out of
// the grid render. The grid was running shortTime() and a fresh IIFE
// for every (staff × 7 days) cell on every parent re-render — ~350
// invocations per render for a 50-staff week. The badge is now
// memo'd on its 4 PRIMITIVE props (available / from / to / isEn) so
// React skips the re-render when nothing about that one cell's
// availability has actually changed.
const SCHEDULE_DAY_KEYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

function shortTime12h(t) {
    if (!t) return '';
    const [h, m] = String(t).split(':').map(Number);
    const period = h >= 12 ? 'p' : 'a';
    const h12 = ((h + 11) % 12) + 1;
    return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

const AvailabilityBadge = memo(function AvailabilityBadge({ available, from, to, isEn }) {
    // Off-this-day badge — staff explicitly marked unavailable.
    if (available === false) {
        return (
            <div
                className="text-[9px] text-gray-400 italic leading-tight mt-0.5"
                title={isEn ? 'Marked unavailable' : 'Marcado no disponible'}>
                🚫 {isEn ? 'off' : 'no disp.'}
            </div>
        );
    }
    // Narrower-than-default hours = constraint worth surfacing. Defaults
    // from MyAvailabilityModal are 09:00–21:00; anything tighter shows.
    const fromOk = (from || '09:00') > '09:00';
    const toOk = (to || '21:00') < '21:00';
    if (!fromOk && !toOk) return null;
    return (
        <div
            className="text-[9px] text-gray-400 italic leading-tight mt-0.5"
            title={isEn ? 'Staff availability window' : 'Ventana de disponibilidad'}>
            ⏰ {shortTime12h(from)}–{shortTime12h(to)}
        </div>
    );
});

// ── Component ──────────────────────────────────────────────────────────────

export default function Schedule({ staffName, language, storeLocation, staffList, setStaffList }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);

    const [shifts, setShifts] = useState([]);
    const [loading, setLoading] = useState(true);
    // Tracks whether the grid is currently rendering localStorage-
    // cached data vs a live Firestore snapshot. Surfaced as a small
    // amber badge near the week header so users on flaky Wi-Fi know
    // they might be looking at a stale view. `liveAt` rolls forward
    // on every snapshot so the relative-time label stays fresh.
    const [scheduleCacheStatus, setScheduleCacheStatus] = useState({
        usingCache: false, cachedAt: null, liveAt: null,
    });
    // Default view mode: week-grid on every device (Andrew 2026-05-17 —
    // "when you start the schedule page lets start it in the week view
    // not day view"). The previous default flipped to 'day' on mobile
    // because the week-grid is wider than the viewport on a phone, but
    // the day view's narrower context made it less useful as a landing
    // screen — most staff open Schedule to scan the week, not to drill
    // into one day. The user can still switch to 'day' via the segmented
    // control any time; we just don't make that the entry point. The
    // grid handles its own horizontal scroll on narrow screens.
    const [viewMode, setViewMode] = useState('grid');
    // 2026-05-30 — Andrew "the month calendar needs to be on the bar
    // above the my schedule bar. a small button that opens up a month
    // calendar window. on the left of the week button but like 1/3 the
    // week button size." Boolean for opening the modal (lazy mount).
    const [showMonthModal, setShowMonthModal] = useState(false);
    const [showPresetEditor, setShowPresetEditor] = useState(false);
    // Mobile "fit-to-screen" zoom — Andrew 2026-05-22 "i want to be
    // able to zoom out and see the full picture of the weeks calendar
    // with everyone schedule. sling has this function". When true, the
    // WeeklyGrid renders at its natural size but a CSS scale transform
    // shrinks it to fit the viewport width so the whole week × all
    // staff fits in one screen. Useful for the at-a-glance "is anyone
    // double-booked / are there gaps" check; the user toggles back to
    // normal for editing since cells are too small to tap when fit.
    const [gridFitToScreen, setGridFitToScreen] = useState(false);
    // 2026-05-24 — Andrew: "everyone except admin should auto-route to
    // their own side." If the viewer has scheduleSide === 'foh' (or
    // 'boh'), default the Schedule grid to that side AND hide the
    // FOH/BOH tab strip below — single-side staff never need to see
    // the other side. Admins + scheduleSide === 'both' still see the
    // toggle.
    const _viewerRecord = (staffList || []).find(s => s.name === staffName);
    const _explicitSide = _viewerRecord?.scheduleSide;
    const _viewerIsBothSide = _explicitSide === 'both';
    const _viewerHasFixedSide = _explicitSide === 'foh' || _explicitSide === 'boh';
    const _viewerSide = _viewerHasFixedSide
        ? _explicitSide
        : (_viewerRecord ? resolveStaffSide(_viewerRecord) : 'foh');
    // Initialize to the viewer's resolved side (admin can still flip).
    const [side, setSide] = useState(_viewerSide); // 'foh' | 'boh'
    // Side-aware edit gates. MUST be declared AFTER `side` — used to be one
    // line before the `useState`, which threw a TDZ ReferenceError on first
    // render of Schedule and broke the whole tab. Same class of bug as the
    // May 2026 outage. Keep these BELOW the side useState always.
    //
    // Three flavors:
    //   canEditFOH     — does this user have the FOH editor toggle?
    //   canEditBOH     — does this user have the BOH editor toggle?
    //   canEdit        — page-level "are they ever an editor on any side?"
    //                    used to show/hide the editor UI at all
    //
    // For any action that targets a SPECIFIC shift (save, delete, drag,
    // resize, swap, give-up, etc.), use canEditSide(shift.side) — never
    // the plain `canEdit`, because the user's view side and the shift's
    // side can differ (e.g. they're viewing FOH but try to create a BOH
    // shift via the Add modal's side picker).
    const canEditFOH = canEditSchedule(staffName, staffList, 'foh');
    const canEditBOH = canEditSchedule(staffName, staffList, 'boh');
    const canEdit = canEditFOH || canEditBOH;
    const canEditSide = (s) => s === 'foh' ? canEditFOH : s === 'boh' ? canEditBOH : canEdit;
    // 2026-05-16 — Andrew: "only the admins are able to make blackout
    // date edits." canEdit is broad (shift leads + designated schedulers
    // can edit shifts) — closures + holidays + events + recurring
    // closure config need a TIGHTER gate. staffIsAdmin = ID 40/41
    // (owners) per data/staff.js. The day-header per-date toggle
    // ("↺ Open") and the Closures & Calendar modal open button +
    // every block/event/recurring write handler is gated on this.
    const staffIsAdmin = isAdmin(staffName, staffList);
    // Manager-or-admin gate. Used to hide weekly-hours summaries from
    // staff/shift-leads — Andrew (2026-05-17): "weekly hours need to
    // only be seen by managers and up". A shift lead with FOH/BOH
    // edit rights can still ADD shifts, but the per-staff weekly
    // totals + scoreboard + SPLH advisor stay hidden so labor-cost
    // info doesn't leak.
    const _currentStaff = (staffList || []).find(s => s.name === staffName);
    const isManagerOrAdmin = staffIsAdmin
        || (_currentStaff && /manager|owner/i.test(_currentStaff.role || ''));
    const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
    const [selectedDayIdx, setSelectedDayIdx] = useState(() => (new Date().getDay() - WEEK_START_DOW + 7) % 7);
    const [showAddModal, setShowAddModal] = useState(false);
    // Availability conflict acknowledgment modal — 2026-05-15.
    // Andrew: "lets it flash and show a small window warning and i can
    // either press delete the shift or override and schedule the shift
    // anyways." Triggered AFTER any shift mutation (add / drag-resize /
    // drag-move) that lands the shift outside the staff's declared
    // availability. Forces the manager to acknowledge — no more silent
    // misses. Shape:
    //   { shiftId, staffName, date, startTime, endTime,
    //     conflict: { type: 'off' | 'outside', from?, to? },
    //     kind: 'added' | 'resized' | 'moved' }
    const [availabilityWarn, setAvailabilityWarn] = useState(null);
    const [addPrefill, setAddPrefill] = useState(null);
    // Single-person filter — when set, every view scopes to ONE staff member.
    // Cleared with the "Show all" button.
    const [personFilter, setPersonFilter] = useState(null);
    // Multi-shift select — shift+click any cube to add it to the selection,
    // then act on all selected at once via the floating bulk-action bar.
    // Stored as a Set of shift ids so add/remove is O(1).
    const [selectedShiftIds, setSelectedShiftIds] = useState(() => new Set());
    const toggleShiftSelection = (shiftId) => {
        setSelectedShiftIds(prev => {
            const next = new Set(prev);
            if (next.has(shiftId)) next.delete(shiftId);
            else next.add(shiftId);
            return next;
        });
    };
    const clearSelection = () => setSelectedShiftIds(new Set());
    // Date blocks ("restaurant closed" / "no time-off allowed"). Manager-defined.
    const [dateBlocks, setDateBlocks] = useState([]);
    const [showBlockModal, setShowBlockModal] = useState(false);
    // 2026-05-16 — recurring weekly closure config. Lives at
    // /config/schedule_settings.closedWeekdays = { webster: [0],
    // maryland: [0,1], ... } where 0=Sunday … 6=Saturday. Any date
    // whose day-of-week is in the active location's array is treated
    // as closed (same downstream effects as a one-off date_block of
    // type=closed — see dateClosed helper below).
    const [scheduleSettings, setScheduleSettings] = useState(null);
    // 2026-05-16 — calendar events: informational chips that render above
    // the day-of-week headers on the schedule grid. Distinct from closures
    // (closures gray the cell out; events just label it). Manager-added
    // via the Closures & Calendar modal. Types:
    //   'holiday'  — federal/observed (Christmas, Thanksgiving)
    //   'national' — awareness/observance days (Mother's Day, Cinco de Mayo)
    //   'event'    — local events (food festival, marathon, sporting game)
    //   'birthday' — auto-derived from staff.birthday (NOT stored — see
    //                birthdaysByDate computation below).
    const [calendarEvents, setCalendarEvents] = useState([]);
    // Time-off entries (Phase 2: admin-entered on behalf of staff. Phase 3: staff self-serve).
    const [timeOff, setTimeOff] = useState([]);
    const [showTimeOffModal, setShowTimeOffModal] = useState(false);
    // { staffName, dateStr } from a tapped 🌴/⏳ chip in the weekly grid —
    // opens PtoDetailsModal (editors only; chip is inert for staff).
    const [ptoChipTarget, setPtoChipTarget] = useState(null);
    // STABLE identity — ModalPortal re-pushes its Android back handler when
    // onBackPress changes; an inline arrow here would hoist this modal's
    // handler above ConfirmModal's on every Schedule re-render, making
    // hardware-back close the wrong layer.
    const closePtoChipModal = useCallback(() => setPtoChipTarget(null), []);
    // DC-2, 2026-05-30: removed showAutoFillModal state — only ever set
    // to `false` from inside the success path; the modal was migrated to
    // a different gate and the open-trigger no longer wired this state.
    // Phase 3: staff self-serve PTO request modal + my-availability modal
    const [showPtoRequestModal, setShowPtoRequestModal] = useState(false);
    const [showMyAvailModal, setShowMyAvailModal] = useState(false);
    // 2026-05-16 — staff self-serve birthday. Available to every staff
    // member regardless of role; writes to their own record only.
    const [showMyBirthdayModal, setShowMyBirthdayModal] = useState(false);

    // Auto-open hook for the Home → StaffTodoCard deep-links. When a
    // staff member taps "Set your availability" or "Add your birthday"
    // on Home, the card stashes a marker in sessionStorage under
    // OPEN_MODAL_KEY and navigates here. We pick that up on first
    // mount, open the matching modal, and clear the key so a refresh
    // doesn't re-open. Per-modal one-shot — see staffTodos.js for the
    // writer side.
    useEffect(() => {
        try {
            const key = 'ddmau:scheduleOpenModal';
            const wanted = sessionStorage.getItem(key);
            if (!wanted) return;
            sessionStorage.removeItem(key);
            if (wanted === 'availability') setShowMyAvailModal(true);
            else if (wanted === 'birthday') setShowMyBirthdayModal(true);
        } catch { /* sessionStorage disabled — silent */ }
    }, []);
    // 2026-05-16 — shift SWAP request flow (separate from the existing
    // "offer to market" handleOfferShift flow). Direct trade: staff
    // picks their own shift + another staff's shift → manager approves
    // → both shifts swap staffNames. Documents live at /swap_requests:
    //   { fromStaff, fromShiftId, toStaff, toShiftId, status, ... }
    const [showSwapModal, setShowSwapModal] = useState(false);
    const [swapRequests, setSwapRequests] = useState([]);
    // Click-a-day-header → "who's available?" picker
    const [availableForDate, setAvailableForDate] = useState(null);
    // Mobile-only: collapse the secondary action buttons behind a ⋯ menu.
    const [showMoreActions, setShowMoreActions] = useState(false);
    // The More dropdown anchors immediately below the More button — but
    // the button can sit anywhere from y=80 (header just below sticky
    // nav) to y=500+ (when there's no vertical scroll). A static
    // max-height like 75vh either wastes space at the top of the page or
    // overflows at the bottom. Measure the live button bottom + clamp
    // the popover max-height to (viewport - button bottom - 24px gutter)
    // so the menu always fits and falls back to internal scroll when
    // the admin section is taller than the remaining viewport.
    const moreBtnRef = useRef(null);
    const [moreMenuMaxH, setMoreMenuMaxH] = useState(420);
    // FIX (2026-05-15, Andrew): mobile dropdown was clipping off-screen.
    // The menu is 256px wide and was anchored `right-0` to the More
    // button, meaning it extended LEFT from the button. If the button
    // sat in the middle of a narrow toolbar (mobile <360px viewport),
    // the menu's left edge would go negative. Now we measure the
    // button's position and clamp the menu's left coordinate to the
    // visible viewport with a 12px gutter on both sides.
    const [moreMenuPos, setMoreMenuPos] = useState({ left: 0, top: 0 });
    useEffect(() => {
        if (!showMoreActions) return;
        const recompute = () => {
            const rect = moreBtnRef.current?.getBoundingClientRect();
            if (!rect) return;
            const available = window.innerHeight - rect.bottom - 24;
            // Floor at 240 so the popover is always at least usable
            // (3-4 items visible) even if the button is near the
            // viewport bottom — internal scroll picks up the rest.
            setMoreMenuMaxH(Math.max(240, available));
            // Horizontal: prefer right-align to button. If that would
            // push the LEFT edge below the viewport's 12px gutter, slide
            // the menu right. If the menu wider than viewport (true on
            // <290px screens), pin to the gutter at both edges and let
            // the menu shrink.
            const MENU_W = 256;
            const GUTTER = 12;
            const vw = window.innerWidth;
            let left = rect.right - MENU_W;       // right-aligned default
            if (left < GUTTER) left = GUTTER;     // can't go below left gutter
            if (left + MENU_W > vw - GUTTER) left = vw - MENU_W - GUTTER;
            if (left < GUTTER) left = GUTTER;     // narrow phone — pin left, menu will overflow to right gutter
            setMoreMenuPos({ left, top: rect.bottom + 4 });
        };
        recompute();
        // 2026-05-30 perf — make the capture-phase scroll listener passive so it
        // doesn't block scroll on mobile while the More menu is open.
        // removeEventListener must match the same options object shape for the
        // unsub to register; pre-build it once.
        const scrollOpts = { capture: true, passive: true };
        window.addEventListener('resize', recompute);
        window.addEventListener('scroll', recompute, scrollOpts);
        return () => {
            window.removeEventListener('resize', recompute);
            window.removeEventListener('scroll', recompute, scrollOpts);
        };
    }, [showMoreActions]);
    // Staffing-needs (a.k.a. shift slots) — manager-defined "we need N people in this time block"
    // Each filled slot becomes a real shift.
    const [staffingNeeds, setStaffingNeeds] = useState([]);
    const [showNeedModal, setShowNeedModal] = useState(false);
    // 2026-05-27 — Andrew: "the open slots window make it hidden until
    // clicked." The Open Slots banner stays collapsed by default; tapping
    // the header strip toggles visibility. Preference persists per device
    // so managers who always want it open don't have to re-open every
    // page load.
    const [openSlotsExpanded, setOpenSlotsExpanded] = useState(() => {
        try { return localStorage.getItem('ddmau:openSlotsExpanded') === '1'; } catch { return false; }
    });
    useEffect(() => {
        try { localStorage.setItem('ddmau:openSlotsExpanded', openSlotsExpanded ? '1' : '0'); } catch {}
    }, [openSlotsExpanded]);
    // Optional date prefill for the StaffingNeedModal. Set when the manager
    // clicks the "+ slot" button on a specific day cell in the unassigned
    // row — pre-populates the date field so they don't have to set it
    // manually. Null = no prefill (open with the default-to-weekStart date).
    const [prefillNeedDate, setPrefillNeedDate] = useState(null);
    const [fillingNeed, setFillingNeed] = useState(null); // need being filled when AvailableStaffModal is open
    const [editingNeed, setEditingNeed] = useState(null); // existing staffing_need being edited (start/end/count)
    // When manager taps "+" on a staff cell that has matching open slots, we
    // first show a chooser of those open slots ("fill this need?") instead of
    // jumping straight to the free-form Add Shift modal.
    const [fillSlotChooser, setFillSlotChooser] = useState(null); // { staff, dateStr, needs: [...] }
    // Quick-add state: when a manager taps an empty cell with no matching
    // staffing needs, instead of jumping straight into a modal we surface a
    // chip strip of common shift presets right inside the cell. One tap on
    // a chip = shift created. "✏️" chip falls back to the full modal for
    // anything custom. Cleared on cell-click elsewhere or Esc.
    const [quickAddCell, setQuickAddCell] = useState(null); // { staff, dateStr } | null

    // 2026-05-30 — "Up for grabs" UX rebuild (Phase 1).
    //
    // Three new state cells replace native browser confirm() / prompt()
    // throughout the offer/take/approve/drag flows. Every destructive
    // or state-changing action now routes through a glass ConfirmModal
    // (per Andrew: "any delete or change always is followed by an are
    // you sure type of question so nothing is accidentally deleted or
    // moved, or dragged").
    //
    //   confirmDialog — { title, body, confirmLabel, tone, onConfirm } | null
    //                   Generic "are you sure?" prompt. Pattern:
    //                     setConfirmDialog({
    //                       title: 'Cancel offer?',
    //                       body:  '...',
    //                       confirmLabel: 'Cancel offer',
    //                       tone: 'danger',
    //                       onConfirm: () => handleCancelOffer(shift),
    //                     });
    //                   ConfirmModal closes itself after onConfirm completes.
    //
    //   offerTarget   — Shift the user is offering. Setting it opens the
    //                   OfferShiftModal (note + urgent toggle composer).
    //                   The modal's onSubmit calls commitOfferShift, which
    //                   does the actual Firestore write.
    //
    //   takeTarget    — Shift the user is taking. Setting it opens the
    //                   TakeShiftModal (offerer note, conflict warning,
    //                   hours preview, optional partial-pickup picker).
    //                   onSubmit calls commitTakeShift, which writes
    //                   pendingClaimBy + optional proposedSplit.
    const [confirmDialog, setConfirmDialog] = useState(null);
    const [offerTarget, setOfferTarget] = useState(null);
    // Andrew 2026-06-25 — shift interaction rebuild. Double-click a cube opens
    // the EDIT modal (editingShift); its "Move to" button arms move mode
    // (movingShift) where the next person-day tapped becomes the destination.
    const [editingShift, setEditingShift] = useState(null);
    const [movingShift, setMovingShift] = useState(null);
    const [takeTarget, setTakeTarget] = useState(null);
    // Publish preview modal — opened by the "Publish drafts" button. Holds
    // the precomputed list of drafts + audit warnings so the manager can
    // SEE every shift before it goes live (vs the old native confirm()
    // dialog that just showed a count).
    const [publishPreview, setPublishPreview] = useState(null);
    // Esc closes the quick-add chip strip without committing anything.
    // Mounts once; re-checks `quickAddCell` via the closure on every keydown.
    useEffect(() => {
        if (!quickAddCell) return;
        const onKey = (e) => { if (e.key === 'Escape') setQuickAddCell(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [quickAddCell]);
    // Day templates (reusable patterns: morning needs 3 FOH + 1 Lead + 1 Manager, etc.)
    const [scheduleTemplates, setScheduleTemplates] = useState([]);
    const [showTemplateEditor, setShowTemplateEditor] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState(null); // template being edited / null = creating
    const [showApplyTemplate, setShowApplyTemplate] = useState(false);
    // Recurring shifts ("Maria works Mon/Wed 9-3 every week")
    const [recurringShifts, setRecurringShifts] = useState([]);
    const [showRecurringModal, setShowRecurringModal] = useState(false);
    // In-app notifications (bell drawer)
    // Andrew 2026-05-30 audit fix — consume from AppDataContext instead
    // of subscribing here. Before this, Schedule held its own
    // limit(50) notifications listener in parallel with
    // AppDataContext's limit(100) one — two streams of identical data
    // for any user with Schedule open. The local-state shim below
    // preserves the existing code shape (notifications/setNotifications)
    // so the bell drawer + markAllRead path keeps working unchanged;
    // we just mirror context → local on every context change and
    // accept local-only optimistic edits (markAllRead) until the
    // server snapshot rebases it.
    const { notifications: ctxNotifications } = useAppData();
    const [notifications, setNotifications] = useState([]);
    useEffect(() => {
        setNotifications(ctxNotifications || []);
    }, [ctxNotifications]);
    // SPLH historical data — last 28 days of laborHistory_{location} feeds
    // the per-daypart staffing advisor that sits above the weekly grid.
    // Same shape used by LaborDashboard; helpers in src/data/splh.js.
    //
    // 2026-06-02 consolidation: this listener moved into AppDataContext.
    // Previously Schedule + LaborDashboard each ran their own
    // onSnapshot on `laborHistory_{loc}` with a 28-day cutoff — same
    // data, ~1,500 docs / mount, double-counted whenever the labor page
    // and the schedule page were open in adjacent tabs.
    //
    // The localStorage cache (30-min TTL, "fast path" perceived warmth
    // on tab return) and the 'both' → webster fallback are preserved in
    // the context; behavior here is unchanged.
    const { laborHistory: ctxLaborHistory } = useAppData();
    const splhHistory = ctxLaborHistory || [];
    // Weather forecast for the current location's lat/lng. NWS API is free
    // (no key) and returns up to 7 days of half-day periods. We use the
    // forecast to nudge "rain → trim FOH" / "extreme heat → +1 drinks".
    const [weather, setWeather] = useState(null);
    const [splhAdvisorOpen, setSplhAdvisorOpen] = useState(false);
    const [showNotifDrawer, setShowNotifDrawer] = useState(false);

    // ── Data load ──
    // 2026-05-15 — Andrew: "the schedules loads very slow take a look."
    // The previous version did setLoading(true) on every weekStart change,
    // which blanks the entire grid behind the loading skeleton until
    // Firestore answers (200-800ms each time). Now we hydrate from a
    // localStorage cache keyed by week BEFORE firing the live query, so
    // the grid renders immediately on navigation/return and only shows
    // the skeleton on a true cold cache. 5-min TTL is short enough that
    // the cached view is rarely meaningfully stale, and onSnapshot
    // overwrites within ~500ms either way.
    useEffect(() => {
        const weekEnd = addDays(weekStart, 7);
        const weekStartStr = toDateStr(weekStart);
        const weekEndStr = toDateStr(weekEnd);
        const CACHE_KEY = `ddmau:shifts:${weekStartStr}`;
        const CACHE_TTL_MS = 5 * 60 * 1000;
        let hadCache = false;
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (raw) {
                const cached = JSON.parse(raw);
                if (cached?.savedAt && (Date.now() - cached.savedAt) < CACHE_TTL_MS && Array.isArray(cached.items)) {
                    // Rehydrate Firestore Timestamps. JSON.stringify
                    // turned them into plain `{seconds, nanoseconds}`
                    // objects which DON'T have .toMillis(). Downstream
                    // consumers (shifts.find, notification scheduler at
                    // line ~948) call .toMillis() and would crash on
                    // cache-restored data. Production audit 2026-05-22.
                    setShifts(cached.items.map(rehydrateShiftTimestamps));
                    setLoading(false);
                    hadCache = true;
                    // Surface "we're showing cached data" so a user
                    // viewing a stale week (Wi-Fi flaky / Firestore
                    // slow) knows what they're looking at. Cleared
                    // when the first live snapshot lands below.
                    setScheduleCacheStatus({ usingCache: true, cachedAt: cached.savedAt, liveAt: null });
                }
            }
        } catch { /* storage broken — fall through to live query */ }
        if (!hadCache) {
            setLoading(true);
            setScheduleCacheStatus({ usingCache: false, cachedAt: null, liveAt: null });
        }

        // Fetch by date range. Location filter applied client-side because
        // managers (location='both') need to see both stores at once.
        const q = query(
            collection(db, 'shifts'),
            where('date', '>=', weekStartStr),
            where('date', '<', weekEndStr),
        );
        const unsub = onSnapshot(q, (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setShifts(items);
            setLoading(false);
            // First live snapshot — cached badge can drop, real
            // "last updated" timestamp lights up. Subsequent ticks
            // bump liveAt so the user sees the relative-time label
            // roll forward.
            setScheduleCacheStatus(prev => ({ usingCache: false, cachedAt: prev.cachedAt, liveAt: Date.now() }));
            try {
                // Strip Firestore Timestamps before caching — the
                // serializer turns them into plain objects without
                // .toMillis(). On the rehydrate path we re-wrap them
                // (see above). Symmetric round-trip.
                const cleaned = items.map(stripShiftTimestamps);
                localStorage.setItem(CACHE_KEY, JSON.stringify({ items: cleaned, savedAt: Date.now() }));
            } catch { /* storage full or disabled — non-fatal */ }
        }, (err) => {
            console.error('Schedule snapshot error:', err);
            setLoading(false);
        });
        return unsub;
    }, [weekStart]);

    // FIX (review 2026-05-14, perf): bound the collection listeners by a
    // 6-month-past cutoff. The Schedule view never references dates older
    // than what fits in the navigation window, but the full collection
    // was being replayed on every doc add anywhere — major source of
    // slowness. Future entries are unbounded (closures / time-off /
    // needs are typically planned a few weeks out, never years).
    //
    // time_off has mixed schema (some entries use `startDate`, others
    // just `date`), so we filter on `startDate` and the client-side
    // isStaffOffOn() already handles the `date` fallback. Pre-existing
    // entries without startDate would be dropped — but those are
    // historical and unused by the current schedule view anyway.
    const sixMonthsAgo = useMemo(() => {
        const d = new Date(); d.setMonth(d.getMonth() - 6);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }, []);

    // ── Listen for recurring weekly closure config ──
    // Single doc that holds per-location "we are closed every X" rules.
    // Most restaurants have one or two of these (DD Mau: Sundays).
    // Cheap subscription — one doc, low churn.
    useEffect(() => {
        const unsub = onSnapshot(doc(db, 'config', 'schedule_settings'), (snap) => {
            setScheduleSettings(snap.exists() ? snap.data() : {});
        }, (err) => console.warn('schedule_settings snapshot error:', err));
        return unsub;
    }, []);

    // ── Listen for shift swap requests ──
    // 2026-05-16. Pending + recently-decided. Cheap subscription —
    // typically <20 active at a time, decisions auto-prune to past.
    useEffect(() => {
        const unsub = onSnapshot(
            query(collection(db, 'swap_requests'), where('requestedDate', '>=', sixMonthsAgo)),
            (snap) => {
                const items = [];
                snap.forEach(d => items.push({ id: d.id, ...d.data() }));
                setSwapRequests(items);
            },
            (err) => console.error('swap_requests snapshot error:', err)
        );
        return unsub;
    }, [sixMonthsAgo]);

    // ── Listen for calendar events (holiday/national/event labels) ──
    // Same 6-month past cutoff as date_blocks so old events don't bloat
    // the in-memory list. Future entries unbounded — managers might
    // pre-plan next year's events.
    useEffect(() => {
        const q = query(collection(db, 'calendar_events'), where('date', '>=', sixMonthsAgo));
        const unsub = onSnapshot(q, (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setCalendarEvents(items);
        }, (err) => console.error('calendar_events snapshot error:', err));
        return unsub;
    }, [sixMonthsAgo]);

    // ── Listen for date blocks (restaurant closed days, no-time-off days) ──
    useEffect(() => {
        const q = query(collection(db, 'date_blocks'), where('date', '>=', sixMonthsAgo));
        const unsub = onSnapshot(q, (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setDateBlocks(items);
        }, (err) => console.error('date_blocks snapshot error:', err));
        return unsub;
    }, [sixMonthsAgo]);

    // ── Listen for time-off entries ──
    // 2026-06-20 (QA audit S1): time_off has a mixed schema — current modals
    // write `startDate`, but legacy/imported docs use only `date`. A single
    // `where('startDate','>=',cutoff)` inequality SILENTLY DROPS any doc that
    // lacks `startDate`, so approved PTO on those docs never blocked auto-fill /
    // copy-week / publish / drag, and staff could be scheduled over it. Run TWO
    // bounded queries (one per field) and merge+dedupe — keeps the 6-month read
    // bound while catching both schemas. A doc with both fields is deduped by id.
    useEffect(() => {
        let byStartDate = [];
        let byDate = [];
        const merge = () => {
            const seen = new Map();
            for (const it of byStartDate) seen.set(it.id, it);
            for (const it of byDate) if (!seen.has(it.id)) seen.set(it.id, it);
            setTimeOff([...seen.values()]);
        };
        const unsub1 = onSnapshot(
            query(collection(db, 'time_off'), where('startDate', '>=', sixMonthsAgo)),
            (snap) => { byStartDate = []; snap.forEach((d) => byStartDate.push({ id: d.id, ...d.data() })); merge(); },
            (err) => console.error('time_off(startDate) snapshot error:', err),
        );
        const unsub2 = onSnapshot(
            query(collection(db, 'time_off'), where('date', '>=', sixMonthsAgo)),
            (snap) => { byDate = []; snap.forEach((d) => byDate.push({ id: d.id, ...d.data() })); merge(); },
            (err) => console.error('time_off(date) snapshot error:', err),
        );
        return () => { try { unsub1(); } catch {} try { unsub2(); } catch {} };
    }, [sixMonthsAgo]);

    // ── Listen for staffing-needs / shift slots ──
    useEffect(() => {
        const q = query(collection(db, 'staffing_needs'), where('date', '>=', sixMonthsAgo));
        const unsub = onSnapshot(q, (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setStaffingNeeds(items);
        }, (err) => console.error('staffing_needs snapshot error:', err));
        return unsub;
    }, [sixMonthsAgo]);

    // ── Listen for day templates ──
    // MED-2, 2026-05-30: capped at 200 docs. Realistic max for DD Mau is
    // a few dozen reusable day patterns; 200 is comfortable headroom
    // while still preventing an unbounded read if a future bug starts
    // minting templates in a loop.
    useEffect(() => {
        const unsub = onSnapshot(query(collection(db, 'schedule_templates'), limit(200)), (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setScheduleTemplates(items);
        }, (err) => console.error('schedule_templates snapshot error:', err));
        return unsub;
    }, []);

    // 2026-06-02 — SPLH historical listener removed; now sourced from
    // useAppData().laborHistory above. The localStorage cache (30-min
    // TTL, "fast path" perceived warmth) and the 'both' → webster
    // fallback both moved into AppDataContext, where they serve
    // LaborDashboard too. Cuts ~1,500 docs per cold mount when both
    // Schedule and Labor are opened in the same session.

    // ── Weather forecast (NWS API, free, no key) ──
    // Two-step: lat/lng → grid point → forecast. Stored per location-coord.
    // We only need the next 7 daily periods for scheduling decisions.
    //
    // FIX (review 2026-05-14, perf): localStorage cache with 1-hour TTL.
    // Schedule re-mounts (tab switch, location flip, deploy) used to
    // fire two fresh api.weather.gov requests every time — wasteful on
    // both ends and noticeable on slow networks. NWS data has hourly
    // granularity anyway, so anything fresher than an hour is wasted.
    useEffect(() => {
        const COORDS = {
            webster:  { lat: 38.5917, lng: -90.3389, label: 'Webster Groves' },
            maryland: { lat: 38.7138, lng: -90.4391, label: 'Maryland Heights' },
        };
        const c = COORDS[storeLocation] || COORDS.webster;
        const CACHE_KEY = `ddmau:weather:${storeLocation}`;
        const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
        let cancelled = false;
        // Try cache first — instant render, no flash of empty state.
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (raw) {
                const cached = JSON.parse(raw);
                if (cached && cached.savedAt && (Date.now() - cached.savedAt) < CACHE_TTL_MS) {
                    setWeather({ location: cached.location, periods: cached.periods || [] });
                    return; // cache fresh — skip the network call entirely
                }
            }
        } catch { /* fall through to fetch */ }
        (async () => {
            try {
                // Step 1: lat/lng → forecast URL.
                const ptRes = await fetch(`https://api.weather.gov/points/${c.lat},${c.lng}`, {
                    headers: { 'User-Agent': 'dd-mau-portal (info@ddmau.com)' },
                });
                if (!ptRes.ok) return;
                const ptData = await ptRes.json();
                const fcUrl = ptData?.properties?.forecast;
                if (!fcUrl) return;
                // Step 2: pull the daily forecast.
                const fcRes = await fetch(fcUrl, {
                    headers: { 'User-Agent': 'dd-mau-portal (info@ddmau.com)' },
                });
                if (!fcRes.ok) return;
                const fcData = await fcRes.json();
                if (cancelled) return;
                const periods = (fcData?.properties?.periods || []).slice(0, 14);
                setWeather({ location: c.label, periods });
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify({
                        location: c.label, periods, savedAt: Date.now(),
                    }));
                } catch { /* storage full or disabled — non-fatal */ }
            } catch (e) {
                console.warn('Weather fetch failed (non-fatal):', e?.message || e);
            }
        })();
        return () => { cancelled = true; };
    }, [storeLocation]);

    // ── Listen for recurring shift rules ──
    // MED-2, 2026-05-30: capped at 200 docs. Realistic upper bound is
    // staff_count × rules_per_staff (≈ 25 × 4 = 100 today). 200 cap
    // protects against runaway growth or a bulk-import bug.
    useEffect(() => {
        const unsub = onSnapshot(query(collection(db, 'recurring_shifts'), limit(200)), (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setRecurringShifts(items);
        }, (err) => console.error('recurring_shifts snapshot error:', err));
        return unsub;
    }, []);

    // ── Listen for in-app notifications addressed to me ──
    // Side-effect: when a NEW notification arrives (created in the last 30s)
    // AND the user has granted browser-notification permission, fire a
    // foreground browser notification so they're alerted even if they're
    // looking at another tab. True closed-app push (FCM via Cloud Functions)
    // is a follow-up; this covers app-open + PWA-backgrounded cases.
    // Re-create the de-dup Set whenever staffName changes — otherwise IDs
    // from a previous user persist and we either silently swallow new notifs
    // or worse, re-fire alien IDs that weren't ours. useMemo([staffName]) is
    // the right scope: stable across re-renders for one user, fresh on switch.
    // 2026-05-24 audit fix: useMemo was wrong tool — React reserves the
    // right to recompute useMemo under memory pressure even when deps
    // haven't changed, which would drop the Set and re-fire OS
    // notifications for every previously-seen unread item. useRef is
    // memory-stable by design; we reset .current explicitly on
    // staffName change instead of via deps.
    const seenNotifIdsRef = useRef(new Set());
    useEffect(() => {
        seenNotifIdsRef.current = new Set();
    }, [staffName]);
    const seenNotifIds = seenNotifIdsRef.current;
    // Andrew 2026-05-30 — foreground browser-Notification toast now
    // watches the context-supplied notifications array directly. Same
    // semantics as before (fire once per fresh unread item, dedupe by
    // id, ignore items older than 30s on first sight to avoid replaying
    // a backlog when the page mounts). Just no longer holds a parallel
    // Firestore subscription to do it.
    useEffect(() => {
        if (!staffName) return;
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const cutoff = Date.now() - 30 * 1000;
        for (const n of (ctxNotifications || [])) {
            if (n.read) continue;
            if (seenNotifIds.has(n.id)) continue;
            const ts = n.createdAt?.toMillis ? n.createdAt.toMillis() : 0;
            if (ts < cutoff) { seenNotifIds.add(n.id); continue; }
            try {
                new Notification(n.title || 'DD Mau', {
                    body: n.body || '',
                    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%23255a37'/><text y='70' x='50' text-anchor='middle' font-size='60'>🍜</text></svg>",
                    tag: n.id,
                });
                seenNotifIds.add(n.id);
            } catch {}
        }
    // seenNotifIds is a useRef whose .current Set is mutated in place;
    // intentionally not in the deps. Re-runs only when context flips
    // or staffName changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [staffName, ctxNotifications]);

    // Browser notification permission state, requested on demand from drawer.
    const [notifPermission, setNotifPermission] = useState(
        typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
    );
    const requestNotifPermission = async () => {
        if (typeof Notification === 'undefined') return;
        try {
            // enableFcmPush runs the permission prompt AND fetches the FCM token
            // AND persists it on the staff record. If FCM is not configured (no
            // VAPID key yet), it still leaves the in-page permission flow intact
            // — we fall back to plain Notification.requestPermission() so
            // foreground notifications keep working.
            const result = await enableFcmPush(staffName, staffList, setStaffList);
            if (!result.ok && result.reason === 'no-vapid-key') {
                // FCM not set up yet — just request permission for foreground
                await Notification.requestPermission();
            }
            setNotifPermission(Notification.permission);
        } catch (e) {
            console.warn('Notification permission failed:', e);
            setNotifPermission(Notification.permission);
        }
    };

    // ── 1-hour-before-shift reminders ──
    // For each of MY upcoming published shifts in the next 24h, schedule a
    // setTimeout to fire a browser notification 1 hour before start time.
    // Re-scheduled whenever shifts list or permission changes.
    // LIMITATION: if the app is fully closed (PWA killed), the timer won't
    // fire. True closed-app push needs FCM + Cloud Function (Phase 4B).
    useEffect(() => {
        if (!staffName) return;
        if (typeof Notification === 'undefined' || notifPermission !== 'granted') return;

        const now = Date.now();
        const horizon = now + 24 * 60 * 60 * 1000; // only schedule next 24h
        const timers = [];
        for (const sh of shifts) {
            if (sh.staffName !== staffName) continue;
            if (sh.published === false) continue; // skip drafts
            if (!sh.date || !sh.startTime) continue;
            const [sH, sM] = sh.startTime.split(':').map(Number);
            const [y, mo, d] = sh.date.split('-').map(Number);
            const shiftStartMs = new Date(y, mo - 1, d, sH, sM).getTime();
            const oneHourBefore = shiftStartMs - 60 * 60 * 1000;
            const delay = oneHourBefore - now;
            if (delay <= 0) continue; // already past or within 1h — would've already fired
            if (delay > horizon - now) continue; // beyond 24h, defer to a later re-render
            const timerId = setTimeout(() => {
                try {
                    new Notification(tx('DD Mau — Shift in 1 hour', 'DD Mau — Turno en 1 hora'), {
                        body: tx(
                            `Your shift starts at ${formatTime12h(sh.startTime)} · ${LOCATION_LABELS[sh.location] || sh.location}`,
                            `Tu turno empieza a las ${formatTime12h(sh.startTime)} · ${LOCATION_LABELS[sh.location] || sh.location}`,
                        ),
                        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%23255a37'/><text y='70' x='50' text-anchor='middle' font-size='60'>🍜</text></svg>",
                        tag: `shift-reminder-${sh.id}`, // OS dedupes by tag
                        requireInteraction: false,
                    });
                } catch {}
            }, delay);
            timers.push(timerId);
        }
        return () => { timers.forEach(clearTimeout); };
    }, [staffName, shifts, notifPermission, isEn]);

    // Helper — write a notification doc. Cloud Function dispatchNotification
    // picks it up and fires FCM push to the recipient's tokens. Silently
    // swallows errors so a notify failure never blocks the underlying action.
    //
    // allowSelf default = false (don't push you for actions you yourself
    // performed — e.g. don't ping you when you take your own shift).
    // BUT for publish + manager-edits-to-your-shift you SHOULD self-notify,
    // because the action affects you-as-staff even though you're also the
    // one doing it. Pass { allowSelf: true } in those callers.
    //
    // LANGUAGE: title and body can be either a plain string OR an
    // {en, es} pair. When a pair is given, we resolve to the recipient's
    // preferred language (s.preferredLanguage) before writing the doc. This
    // keeps push notifications in the staff member's language — Andrew
    // publishing in English to a Spanish-only kitchen worker → that worker
    // gets Spanish on their phone.
    const resolveText = (val, recipient) => {
        if (val == null) return '';
        if (typeof val === 'string') return val;
        if (typeof val === 'object') {
            const lang = recipient?.preferredLanguage || 'en';
            return val[lang] || val.en || val.es || '';
        }
        return String(val);
    };
    // 2026-06-02 — bilingual persistence. Mirror of splitVariants() in
    // src/data/notify.js. We persist BOTH titleEn/titleEs + bodyEn/
    // bodyEs on the notification doc so the dispatchNotification Cloud
    // Function can pick per recipient at FCM-send time (FOLLOW-UP).
    // The resolved title/body fields stay for backwards-compat with the
    // current CF + NotificationsDrawer.
    const splitNotifVariants = (val) => {
        if (val == null) return { en: '', es: '' };
        if (typeof val === 'string') return { en: val, es: val };
        if (typeof val === 'object') {
            const en = val.en || val.es || '';
            const es = val.es || val.en || '';
            return { en, es };
        }
        const s = String(val);
        return { en: s, es: s };
    };
    // Schedule notifications. Builds the doc shape dispatchNotification
    // consumes (forStaff / type / title / body / link / tag) and writes
    // to /notifications.
    //
    // `tag` is computed deterministically from type + recipient + the
    // unique resource id passed via opts (shift id, swap doc id, week
    // identifier, etc). The OS dedupes by tag, so retries / rapid
    // duplicate calls collapse to one visible toast on the device.
    //
    // Pass opts.tagSuffix = a unique-per-event string. If you don't,
    // we fall back to Date.now() which means each call gets a unique
    // tag (no OS dedup, but at least matches old behavior).
    const notify = async (forStaff, type, title, body, link = null, opts = {}) => {
        if (!forStaff) return;
        if (forStaff === staffName && !opts.allowSelf) return;
        const recipient = (staffList || []).find(s => s.name === forStaff);
        const tag = `${type}:${forStaff}:${opts.tagSuffix || Date.now()}`;
        const titleVar = splitNotifVariants(title);
        const bodyVar = splitNotifVariants(body);
        try {
            await addDoc(collection(db, 'notifications'), {
                forStaff, type,
                title: resolveText(title, recipient),
                body: resolveText(body, recipient),
                // 2026-06-02 — persist both languages so the Cloud
                // Function dispatcher can pick per recipient at FCM-
                // send time (see splitNotifVariants doc block).
                titleEn: titleVar.en,
                titleEs: titleVar.es,
                bodyEn: bodyVar.en,
                bodyEs: bodyVar.es,
                link,
                tag,
                createdAt: serverTimestamp(),
                read: false,
                createdBy: staffName,
            });
        } catch (e) {
            console.warn('notify failed (non-fatal):', e);
        }
    };

    const markNotifRead = async (id) => {
        try {
            await updateDoc(doc(db, 'notifications', id), { read: true });
        } catch (e) {
            console.warn('mark read failed:', e);
        }
    };

    const markAllNotifsRead = async () => {
        const unread = notifications.filter(n => !n.read);
        if (unread.length === 0) return;
        try {
            const batch = writeBatch(db);
            for (const n of unread) batch.update(doc(db, 'notifications', n.id), { read: true });
            await batch.commit();
        } catch (e) {
            console.warn('mark all read failed:', e);
        }
    };

    const unreadCount = notifications.filter(n => !n.read).length;

    // ── Permission-filtered views — 2026-05-15 ─────────────────────────
    // Andrew: "if the staff isnt a editor of schedules then they shouldnt
    // see the shifts until its published. they should only see there own
    // pending requests too."
    //
    // For NON-editors:
    //   • Shifts where published === false (drafts) are hidden. Staff
    //     wait for the publish moment before they know "you're on
    //     Tuesday lunch" — no more "is this real?" anxiety on a
    //     half-built draft. Applied in visibleShifts below.
    //   • Time-off entries are filtered to (own entries of any status)
    //     ∪ (others' APPROVED entries). Others' pending/denied are not
    //     leaked. Approved PTO of others is still operationally visible
    //     because staff need to know "Maria's off Friday" for coverage
    //     awareness.
    //
    // For editors (managers/admins): no filtering — they see everything,
    // including the manager queue + draft grid for building the week.
    //
    // This is a privacy + UX fix at the client layer. Phase 2 (Auth +
    // custom claims) will mirror this in Firestore rules so a tampered
    // client can't bypass it.
    const viewerTimeOff = useMemo(() => {
        if (canEdit) return timeOff;
        return (timeOff || []).filter(t =>
            t.staffName === staffName || // own — any status
            t.status === 'approved'      // others' — approved only
        );
    }, [timeOff, canEdit, staffName]);

    // Permission-filtered shifts — drafts hidden for non-editors. Used by
    // any aggregation that renders to the viewer (hours scoreboard, staff
    // summary, open offers). Distinct from visibleShifts which ALSO
    // filters by side/location/personFilter for the grid; viewerShifts is
    // the raw permission gate before any view-specific filtering.
    const viewerShifts = useMemo(() => {
        if (canEdit) return shifts;
        return (shifts || []).filter(s => s.published !== false);
    }, [shifts, canEdit]);

    // Helper: is a staff member off on a given date (any non-denied time-off
    // covers it)? Reads from viewerTimeOff so non-editors don't see others'
    // pending PTO as a conflict in the grid.
    const isStaffOffOn = (staffName, dateStr) => {
        return viewerTimeOff.some(t => {
            if (t.status === 'denied') return false;
            if (t.staffName !== staffName) return false;
            if (ptoIsPartial(t)) return false; // a partial window doesn't take the whole day off — they stay schedulable
            const start = t.startDate || t.date;
            const end = t.endDate || t.date;
            return dateStr >= start && dateStr <= end;
        });
    };

    // Partial off windows for a staffer on a date — drives the overlap warning
    // when a shift is placed during their requested-off hours, and the window
    // label in the queue / PTO view. Same visibility rules as isStaffOffOn.
    const partialOffWindowsOn = (staffName, dateStr) => {
        return viewerTimeOff.filter(t => {
            if (t.status === 'denied') return false;
            if (t.staffName !== staffName) return false;
            if (!ptoIsPartial(t)) return false;
            const start = t.startDate || t.date;
            const end = t.endDate || t.date;
            return dateStr >= start && dateStr <= end;
        });
    };
    // True if a shift (startTime–endTime on dateStr) lands inside any partial
    // off window the staffer requested — used for the soft overlap warning.
    const shiftOverlapsPartialOff = (sName, dateStr, startTime, endTime) => {
        return partialOffWindowsOn(sName, dateStr)
            .some(t => timeRangesOverlap(startTime, endTime, t.startTime, t.endTime));
    };

    // ── eventsByDate: calendar_events + auto-derived staff birthdays ──
    // 2026-05-16. Keyed by 'YYYY-MM-DD'. Value is array of event objects:
    //   { id?, type, label, emoji?, isBirthday? }
    //
    // - Manager-added events come from calendarEvents (Firestore).
    // - Birthdays are derived on-the-fly from staffList[].birthday (a
    //   stored 'MM-DD' string). We can't precompute a date for them —
    //   they match ANY year — so the derivation walks the visible
    //   window. To keep it cheap we materialize a 14-month window
    //   (matches the future-event horizon for date filtering elsewhere).
    const eventsByDate = useMemo(() => {
        const map = new Map();
        // Manager-added events first.
        for (const e of (calendarEvents || [])) {
            if (!e?.date) continue;
            if (!map.has(e.date)) map.set(e.date, []);
            map.get(e.date).push(e);
        }
        // Birthdays: for each staff with a birthday MM-DD, materialize
        // an entry on this year's and next year's matching date. Cheap:
        // ~50 staff * 2 dates = 100 ops, runs once per render.
        const now = new Date();
        const thisYear = now.getFullYear();
        for (const s of (staffList || [])) {
            const bd = s?.birthday;
            if (typeof bd !== 'string' || !/^\d{2}-\d{2}$/.test(bd)) continue;
            // hideFromSchedule applies — don't render owner birthdays on
            // the grid since their row is hidden anyway.
            if (s.hideFromSchedule === true) continue;
            for (const y of [thisYear, thisYear + 1]) {
                const dateStr = `${y}-${bd}`;
                if (!map.has(dateStr)) map.set(dateStr, []);
                map.get(dateStr).push({
                    type: 'birthday',
                    label: s.name.split(' ')[0],
                    isBirthday: true,
                    emoji: '🎂',
                });
            }
        }
        return map;
    }, [calendarEvents, staffList]);

    // ── Helper: lookup blocks for a date (filtered by location). ──
    // Multiple blocks could exist for the same day — closed wins over no_timeoff.
    const blocksByDate = useMemo(() => {
        const map = new Map();
        for (const b of dateBlocks) {
            if (b.location && b.location !== 'both' && storeLocation !== 'both' && b.location !== storeLocation) continue;
            if (!map.has(b.date)) map.set(b.date, []);
            map.get(b.date).push(b);
        }
        return map;
    }, [dateBlocks, storeLocation]);

    // dateClosed — single source of truth. Returns true if:
    //   (a) the date has a one-off date_block of type='closed' applying to the current view, OR
    //   (b) the date's day-of-week is in the closedWeekdays config for the
    //       current location (recurring weekly closure — e.g. Sundays).
    //
    // 2026-05-16 (later) — added a THIRD case: type='open_override'.
    // Andrew: "toggle the sunday so sometimes if needed i can toggle it
    // back on." When a Sunday is normally closed via the recurring rule
    // but we WANT to open for a one-off (catering, holiday, special
    // event), a date_block of type='open_override' for that exact date
    // beats the recurring rule. Same opt-out structure can override a
    // one-off type='closed' too, but we don't currently surface that —
    // managers just delete the type='closed' block in that case.
    //
    // Resolution order:
    //   1. If date has an 'open_override' → OPEN (not closed). Highest priority.
    //   2. If date has a 'closed' one-off block → CLOSED.
    //   3. If recurring rule applies for this weekday + location → CLOSED.
    //   4. Otherwise → OPEN.
    const dateClosed = (dateStr, locOverride) => {
        const blocks = blocksByDate.get(dateStr) || [];
        if (blocks.some(b => b.type === 'open_override')) return false;
        if (blocks.some(b => b.type === 'closed')) return true;
        const cw = scheduleSettings?.closedWeekdays || {};
        const d = parseLocalDate(dateStr);
        if (!d) return false;
        const dow = d.getDay();
        // 2026-06-16 (#6): when a generator passes the shift's OWN location,
        // test only THAT store's closed weekdays. Without this, generating from
        // the "both" view treats a day as open unless BOTH stores are closed —
        // so a single-location closed day (e.g. a Webster-only holiday) gets
        // scheduled. No-arg callers (grid render, drag, AddShift) keep the
        // existing view-based behavior below.
        if (locOverride === 'webster' || locOverride === 'maryland') {
            const arr = Array.isArray(cw[locOverride]) ? cw[locOverride] : [];
            return arr.includes(dow);
        }
        if (storeLocation === 'both') {
            // Closed in BOTH views only when every location is closed that
            // weekday. Otherwise the open location's grid still matters.
            const w = Array.isArray(cw.webster) ? cw.webster : [];
            const m = Array.isArray(cw.maryland) ? cw.maryland : [];
            return w.includes(dow) && m.includes(dow);
        }
        const arr = Array.isArray(cw[storeLocation]) ? cw[storeLocation] : [];
        return arr.includes(dow);
    };
    // Helpers — what's the REASON a date is closed? Used by the UI so
    // we can offer the right action (delete the one-off vs add an
    // override for a recurring rule).
    const dateClosedByRecurring = (dateStr) => {
        const blocks = blocksByDate.get(dateStr) || [];
        if (blocks.some(b => b.type === 'open_override')) return false;
        const cw = scheduleSettings?.closedWeekdays || {};
        const d = parseLocalDate(dateStr);
        if (!d) return false;
        const dow = d.getDay();
        if (storeLocation === 'both') {
            const w = Array.isArray(cw.webster) ? cw.webster : [];
            const m = Array.isArray(cw.maryland) ? cw.maryland : [];
            return w.includes(dow) && m.includes(dow);
        }
        const arr = Array.isArray(cw[storeLocation]) ? cw[storeLocation] : [];
        return arr.includes(dow);
    };
    const dateHasOpenOverride = (dateStr) => {
        return (blocksByDate.get(dateStr) || []).some(b => b.type === 'open_override');
    };

    // ── Derived: which staff names have shifts on the CURRENT side this week ──
    // A FOH staff with one BOH shift this week appears in BOH view too (cross-side).
    // Uses shift.side when present (new shifts) and falls back to the staff's
    // home side for legacy shifts that don't have a `side` field yet.
    const staffByName = useMemo(() => {
        const m = new Map();
        for (const s of (staffList || [])) m.set(s.name, s);
        return m;
    }, [staffList]);

    const crossSideNames = useMemo(() => {
        const set = new Set();
        for (const sh of shifts) {
            if (storeLocation !== 'both' && sh.location !== storeLocation) continue;
            // Bug fix 2026-05-09: deleted staff still had their old shifts in
            // the shifts collection, and crossSideNames pulled their names in
            // → ghost row appeared on the schedule grid for someone who no
            // longer exists. Skip any shift whose staffName isn't in the
            // current staff list.
            if (!staffByName.has(sh.staffName)) continue;
            const shiftSide = sh.side || resolveStaffSide(staffByName.get(sh.staffName));
            if (shiftSide === side) set.add(sh.staffName);
        }
        return set;
    }, [shifts, storeLocation, side, staffByName]);

    // ── Derived: staff list filtered by location AND current side (FOH/BOH) ──
    // Managers + Owners + Shift Leads appear on BOTH sides automatically via isOnSide().
    // ALSO includes any staff with a shift on this side this week (cross-side coverage).
    const sideStaff = useMemo(() => {
        if (!Array.isArray(staffList)) return [];
        return staffList.filter(s => {
            // SCHEDULE GRID FILTER — uses scheduleHome (not location) so a
            // 'both'-location floater with scheduleHome === 'webster' only
            // appears on Webster's grid by default. Add Shift's picker
            // still uses raw `location` so they remain pickable as a
            // fill-in at Maryland. See getScheduleHome() in data/staff.js.
            if (!isOnScheduleAt(s, storeLocation)) return false;
            // 2026-05-16 — hideFromSchedule: owners/admins who don't
            // need a grid row by default. Safety net: if they actually
            // have a shift this week, crossSideNames includes them and
            // the row appears so a real assignment can't be invisible.
            // Toggled per-staff in AdminPanel + Bulk Tag modal.
            if (s.hideFromSchedule === true && !crossSideNames.has(s.name)) return false;
            // Home side OR has any cross-side shift on the current side this week.
            return isOnSide(s, side) || crossSideNames.has(s.name);
        });
    }, [staffList, storeLocation, side, crossSideNames]);

    const sideStaffNames = useMemo(() => new Set(sideStaff.map(s => s.name)), [sideStaff]);

    // ── Derived: shifts visible in THIS view (location + side + optional person filter) ──
    // Filter by shift.side when present so cross-side shifts only show in the
    // side the manager assigned them to. Legacy shifts (no side) fall back to
    // the staff's home side.
    const visibleShifts = useMemo(() => {
        return shifts.filter(s => {
            if (storeLocation !== 'both' && s.location !== storeLocation) return false;
            if (personFilter && s.staffName !== personFilter) return false;
            // Skip orphan shifts whose assignee no longer exists in staffList
            // (deleted staff). sideStaffNames already gates this for the
            // common case, but defensive double-check here too.
            if (!staffByName.has(s.staffName)) return false;
            // 2026-05-15 — hide drafts from non-editors. The publish moment
            // is the source of truth for staff; drafts are manager work-in-
            // progress and can change. See viewerTimeOff comment above.
            if (!canEdit && s.published === false) return false;
            const shiftSide = s.side || resolveStaffSide(staffByName.get(s.staffName));
            return shiftSide === side && sideStaffNames.has(s.staffName);
        });
    }, [shifts, storeLocation, sideStaffNames, personFilter, side, staffByName, canEdit]);

    // ── Conflict detection ──────────────────────────────────────
    // Audit follow-up 2026-05-23: managers were finding double-bookings
    // only AFTER staff complained at clock-in ("I'm on the schedule
    // for FOH 9-3 but also BOH 11-5"). Now we compute conflicts
    // proactively from the loaded shifts and surface a count in the
    // header — clicking it scrolls/highlights the offending rows.
    //
    // Conflict definition: same staffName, same date, overlapping
    // time ranges. Two shifts with adjacent times (one ends exactly
    // when the other starts) are NOT a conflict — common pattern
    // for "FOH lunch then BOH dinner" deliberate double-shifts.
    //
    // Performance: O(n²) on shifts-per-staff-per-day but the typical
    // input is <50 shifts/week and useMemo caches across renders,
    // so even at 200 shifts the per-week computation is <1ms.
    // Skipped on the day view because the day-view UI already shows
    // overlapping shifts visually inline. Computed only for the
    // current side so it doesn't double-count cross-side overlaps
    // (those are legitimate — staff can work FOH morning + BOH
    // afternoon at the same restaurant).
    const scheduleConflicts = useMemo(() => {
        // Local time-parser — the existing toMin helper lives inside
        // a different useMemo and isn't reachable from here. Cheap
        // to inline; called once per shift per memo recomputation.
        const parseHM = (t) => {
            if (!t || typeof t !== 'string') return null;
            const [h, m] = t.split(':').map(Number);
            if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
            return h * 60 + m;
        };
        // Group shifts by staffName + date, then check pairs.
        const byKey = new Map();
        for (const sh of visibleShifts) {
            if (!sh.staffName || !sh.date) continue;
            // Only look at published shifts unless we're in editor
            // mode — drafts are manager working state and may
            // intentionally have temporary overlaps.
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
            // Sort by start so we can compare adjacent pairs in O(n).
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
    }, [visibleShifts, canEdit]);

    // ── Derived: per-staff weekly hours summary for the current side view ──
    // Hours are calculated over ALL of this staffer's shifts (both sides) — OT
    // is per employee per week regardless of which "side" they worked.
    const staffSummary = useMemo(() => {
        return sideStaff
            .map(s => {
                // viewerShifts (not raw shifts) so non-editors don't see draft
                // hours in the right-sidebar staff summary. visibleShifts is
                // already permission-filtered downstream so sideShiftCount is
                // safe as-is.
                const allMyShifts = viewerShifts.filter(sh =>
                    sh.staffName === s.name &&
                    (storeLocation === 'both' || sh.location === storeLocation));
                // Group by date and let dayPaidHours handle the double-shift
                // break deduction (auto-detected from 2+ shifts/day OR legacy
                // isDouble flag). Important — this means weekly totals are
                // correct even when managers don't manually flag isDouble.
                const byDate = new Map();
                for (const sh of allMyShifts) {
                    const arr = byDate.get(sh.date) || [];
                    arr.push(sh);
                    byDate.set(sh.date, arr);
                }
                const totalHours = Array.from(byDate.values())
                    .reduce((sum, dayShifts) => sum + dayPaidHours(dayShifts), 0);
                const sideShiftCount = visibleShifts.filter(sh => sh.staffName === s.name).length;
                // Position classifier — used by the calendar sort
                // (regular → lead → manager) and the meal-count box
                // dots (manager-orange + lead-green per shift). Done
                // here in the parent so WeeklyGrid doesn't need to
                // re-call isAdmin (which requires staffList in scope).
                const isMgr = isAdmin(s.name, staffList) || /manager/i.test(s.role || '');
                const position = isMgr ? 'manager' : (s.shiftLead === true ? 'lead' : 'regular');
                return { ...s, totalHours, shiftCount: sideShiftCount, position };
            })
            // Sort by position rank, then alphabetical within position
            // (Andrew 2026-05-22 "organize the staff on the calendar by
            // position. all the foh first then shift leads, and then
            // manager"). Manager outranks shift-lead even if a staffer
            // is flagged both.
            .sort((a, b) => {
                const rank = (p) => p === 'manager' ? 2 : (p === 'lead' ? 1 : 0);
                const ra = rank(a.position), rb = rank(b.position);
                if (ra !== rb) return ra - rb;
                return a.name.localeCompare(b.name);
            });
    }, [sideStaff, viewerShifts, visibleShifts, storeLocation, staffList]);

    // ── Memoized props for WeeklyGrid ─────────────────────────────────
    // Andrew 2026-05-30 — these used to be inline filter() expressions
    // passed straight into WeeklyGrid (openSlots/openOffers/weekNeeds),
    // which meant a fresh array identity every parent render. That
    // defeated any future React.memo on WeeklyGrid + caused every cell
    // to re-eval its open-slot/open-offer indicator on every tick.
    // Hoisting to useMemo keyed on the actual inputs lets those props
    // be referentially stable until something real changes.
    const weekStartStr = toDateStr(weekStart);
    const weekEndStr = toDateStr(addDays(weekStart, 7));
    const memoOpenSlots = useMemo(() => (
        (staffingNeeds || []).filter(n =>
            n.date >= weekStartStr &&
            n.date < weekEndStr &&
            n.side === side &&
            (storeLocation === 'both' || n.location === 'both' || n.location === storeLocation) &&
            ((n.filledStaff || []).length < (n.count || 0)))
    ), [staffingNeeds, weekStartStr, weekEndStr, side, storeLocation]);
    const memoOpenOffers = useMemo(() => (
        visibleShifts.filter(s =>
            s.offerStatus === 'open' &&
            s.date >= weekStartStr &&
            s.date < weekEndStr &&
            (!s.side || s.side === side))
    ), [visibleShifts, weekStartStr, weekEndStr, side]);
    const memoWeekNeeds = useMemo(() => (
        (staffingNeeds || []).filter(n =>
            n.side === side &&
            (storeLocation === 'both' || n.location === 'both' || n.location === storeLocation))
    ), [staffingNeeds, side, storeLocation]);

    // ── Hours scoreboard ─────────────────────────────────────────────
    // Live, both-sides-at-once roll-up of scheduled vs target hours so a
    // manager building a week sees over/under signals BEFORE publishing.
    // Replaces the "labor cost %" idea — that needed wage data we don't
    // have. This uses only targetHours which already exists per staff.
    // SPLH grid from the last 28 days of laborHistory.
    const splhGrid = useMemo(() => aggregateSplh(splhHistory), [splhHistory]);
    // Scheduled hours per (dow, daypart) for the currently-viewed week.
    // Filtered to the active side so FOH advisor only counts FOH labor etc.
    const scheduledByDayPart = useMemo(() => {
        const sideFilter = (sh) => {
            // Match Schedule's existing visible-shift filter logic loosely.
            // If the shift has an explicit side, use it; otherwise infer from
            // staff role group.
            return sh.side === side || (!sh.side && sh.staffName && (() => {
                const s = staffList.find(x => x.name === sh.staffName);
                if (!s) return false;
                if (s.scheduleSide) return s.scheduleSide === side;
                // Fall back to role-family inference (BOH-tagged roles → boh).
                const isBoh = BOH_ROLE_HINTS.has(s.role);
                return side === (isBoh ? 'boh' : 'foh');
            })());
        };
        const weekShifts = (visibleShifts || []).filter(sh => sideFilter(sh));
        return scheduledHoursByDayPart(weekShifts, weekStart);
    }, [visibleShifts, side, staffList, weekStart]);
    // Build per-day forecast: typical sales × scheduled hours → implied SPLH
    const splhForecast = useMemo(() => {
        const out = [];
        for (let i = 0; i < 7; i++) {
            const day = addDays(weekStart, i);
            const dow = day.getDay();
            const dateStr = toDateStr(day);
            for (const part of DAYPARTS) {
                const hist = splhGrid[dow]?.[part.id];
                const scheduled = scheduledByDayPart[dow]?.[part.id] || 0;
                const v = variance(scheduled, hist?.avgHours);
                out.push({
                    dow, dateStr, part,
                    hist,
                    scheduled,
                    variance: v,
                    impliedSplh: hist?.avgSales > 0 && scheduled > 0 ? hist.avgSales / scheduled : null,
                });
            }
        }
        return out;
    }, [splhGrid, scheduledByDayPart, weekStart]);
    // Top-line advisory: how many slots are flagged?
    const splhAdvisory = useMemo(() => {
        const under = splhForecast.filter(f => f.variance.status === 'under').length;
        const over  = splhForecast.filter(f => f.variance.status === 'over').length;
        const haveData = splhHistory.length > 0;
        return { under, over, haveData };
    }, [splhForecast, splhHistory.length]);

    // Weather impact derivation. Maps each forecast period to a hint.
    // Conservative thresholds — only show a tip if the weather is genuinely
    // unusual for the region.
    const weatherTips = useMemo(() => {
        if (!weather?.periods?.length) return [];
        const tips = [];
        for (const p of weather.periods.slice(0, 8)) { // 4 days, day+night
            if (!p.isDaytime) continue;
            const rain = p.probabilityOfPrecipitation?.value || 0;
            const tF = Number(p.temperature) || null;
            const partsForDay = [];
            if (rain >= 60) partsForDay.push({ kind: 'rain', text: `${rain}% rain — walk-in traffic typically dips. Consider trimming 1 FOH from lunch.`, esText: `${rain}% lluvia — el tráfico baja. Considera quitar 1 FOH del almuerzo.` });
            if (tF != null && tF >= 95) partsForDay.push({ kind: 'heat', text: `${tF}°F — drinks demand spikes ~30%. Consider +1 at the boba station.`, esText: `${tF}°F — bebidas suben ~30%. Considera +1 en boba.` });
            if (tF != null && tF <= 25) partsForDay.push({ kind: 'cold', text: `${tF}°F — pho/hot food ramps; foot traffic drops. Same labor, watch lunch volume.`, esText: `${tF}°F — pho sube; menos tráfico. Mismo personal, vigila el almuerzo.` });
            if (partsForDay.length > 0) {
                tips.push({ name: p.name, shortForecast: p.shortForecast, tF, rain, parts: partsForDay });
            }
        }
        return tips;
    }, [weather]);

    const hoursScoreboard = useMemo(() => {
        if (!Array.isArray(staffList)) return null;
        // Hours scoreboard counts staff whose scheduleHome includes this
        // location, mirroring the grid filter. Floaters with a single
        // scheduleHome don't pad the wrong store's totals.
        const locStaff = staffList.filter(s => isOnScheduleAt(s, storeLocation));
        // Per-staff weekly hours across BOTH sides — week is the visible week.
        const weekStartStr = toDateStr(weekStart);
        const weekEndStr = toDateStr(addDays(weekStart, 7));
        const sumHoursForStaff = (staffName) => {
            // viewerShifts so the scoreboard doesn't show draft hours to
            // non-editors. For managers viewerShifts === shifts.
            const myShifts = viewerShifts.filter(sh =>
                sh.staffName === staffName &&
                sh.date >= weekStartStr && sh.date < weekEndStr &&
                (storeLocation === 'both' || sh.location === storeLocation));
            const byDate = new Map();
            for (const sh of myShifts) {
                const arr = byDate.get(sh.date) || [];
                arr.push(sh);
                byDate.set(sh.date, arr);
            }
            return Array.from(byDate.values()).reduce((sum, ds) => sum + dayPaidHours(ds), 0);
        };

        const computeFor = (sideId) => {
            const list = locStaff.filter(s => resolveStaffSide(s) === sideId);
            let scheduled = 0, target = 0;
            const perStaff = [];
            for (const s of list) {
                const sh = sumHoursForStaff(s.name);
                const tg = Number(s.targetHours) || 0;
                scheduled += sh;
                target += tg;
                perStaff.push({ name: s.name, scheduled: sh, target: tg, gap: sh - tg });
            }
            // Top under = most hours below target (ignore staff with no target — can't be "under").
            const under = perStaff
                .filter(p => p.target > 0 && p.gap < 0)
                .sort((a, b) => a.gap - b.gap)
                .slice(0, 3);
            // Top over = most hours above target (any staff).
            const over = perStaff
                .filter(p => p.gap > 2) // ignore noise — only flag >2h over
                .sort((a, b) => b.gap - a.gap)
                .slice(0, 3);
            return { scheduled, target, under, over, count: list.length };
        };

        return {
            foh: computeFor('foh'),
            boh: computeFor('boh'),
        };
    }, [staffList, viewerShifts, weekStart, storeLocation]);

    // ── Handlers ──
    // Manually-added shifts default to DRAFT (published: false). Manager taps
    // "Publish" to release the week (or this single shift) so staff get the
    // notification. Reasoning: the publish button is useless if every Add
    // Shift writes published=true — there's nothing to publish. (User-reported
    // bug 2026-05-09: "added a shift, tried to publish, said no shifts to
    // publish.") If a manager wants to push a quick mid-week add immediately,
    // they tap Publish right after Save — the badge on the button shows N drafts.
    const handleAddShift = async (shiftData) => {
        // Defense in depth — the modal restricts the side picker, but this
        // is the actual write site so we also enforce here. A FOH-only
        // editor must not be able to create a BOH shift via any path
        // (modal, dev tools, future code that calls handleAddShift, etc.).
        const targetSide = shiftData?.side
            || (() => {
                // Resolve the same way AddShiftModal does — staff's default
                // side from their record. If we can't determine, default 'foh'.
                const s = staffList?.find(x => x.name === shiftData?.staffName);
                if (!s) return 'foh';
                if (s.scheduleSide === 'foh' || s.scheduleSide === 'boh') return s.scheduleSide;
                return 'foh';
            })();
        if (!canEditSide(targetSide)) {
            console.warn(`[Schedule] blocked add for side=${targetSide} — user lacks editor toggle`);
            return;
        }
        try {
            const docRef = await addDoc(collection(db, 'shifts'), {
                ...shiftData,
                published: false, // draft — manager hits Publish to release
                createdBy: staffName,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            });
            // Audit log — Andrew 2026-06-25. Best-effort, never blocks the write.
            auditShiftChange({ shiftId: docRef.id, staffName: shiftData.staffName, action: 'created',
                after: { date: shiftData.date, startTime: shiftData.startTime, endTime: shiftData.endTime, side: shiftData.side || null } }).catch(() => {});
            setShowAddModal(false);
            setAddPrefill(null);
            // Partial off-window overlap warning — they're schedulable, but
            // flag a shift that lands in the hours they asked off (Andrew 2026-06-17).
            if (shiftOverlapsPartialOff(shiftData.staffName, shiftData.date, shiftData.startTime, shiftData.endTime)) {
                const win = partialOffWindowsOn(shiftData.staffName, shiftData.date).map(ptoWindowLabel).filter(Boolean).join(', ');
                toast(tx(`⚠ ${shiftData.staffName} asked off ${win} that day — this shift overlaps it.`,
                         `⚠ ${shiftData.staffName} pidió libre ${win} ese día — este turno se cruza.`));
            }
            // Availability acknowledgment — fires AFTER the save so it
            // catches every path (modal, quick-add, drag, etc.). Replaces
            // the passive in-modal banner Andrew was missing.
            const savedStaffRecord = (staffList || []).find(s => s.name === shiftData.staffName);
            const conflict = checkAvailabilityConflict(savedStaffRecord, shiftData.date, shiftData.startTime, shiftData.endTime);
            if (conflict) {
                setAvailabilityWarn({
                    shiftId: docRef.id,
                    staffName: shiftData.staffName,
                    date: shiftData.date,
                    startTime: shiftData.startTime,
                    endTime: shiftData.endTime,
                    conflict,
                    kind: 'added',
                });
            }

            // After save, check whether the new shift will actually be visible
            // in the current view. If not (different week / side / location /
            // person filter), auto-adjust the view so the user sees what they
            // just created. Was a real source of "I saved but nothing showed up"
            // confusion when staff scheduleSide was unset.
            const savedDate = parseLocalDate(shiftData.date);
            const targetWeekStart = savedDate ? startOfWeek(savedDate) : null;
            const savedStaff = (staffList || []).find(s => s.name === shiftData.staffName);
            // The shift's *effective* side is the explicit shift.side (set by the
            // per-shift override in AddShiftModal) when present, else the staff's
            // home side. This way cross-side shifts auto-jump to the right view.
            const savedSide = shiftData.side || (savedStaff ? resolveStaffSide(savedStaff) : 'foh');
            // Jump to the right week
            if (targetWeekStart && toDateStr(targetWeekStart) !== toDateStr(weekStart)) {
                setWeekStart(targetWeekStart);
            }
            // Jump to the right side
            if (savedSide !== side) {
                setSide(savedSide);
            }
            // Clear person filter if it would hide this shift
            if (personFilter && personFilter !== shiftData.staffName) {
                setPersonFilter(null);
            }
            // Warn about location mismatch (no auto-switch — that's an app-level setting)
            if (storeLocation !== 'both' && shiftData.location && shiftData.location !== storeLocation) {
                setTimeout(() => {
                    toast(tx(
                        `✅ Saved, but this shift is at ${LOCATION_LABELS[shiftData.location]} and you're viewing ${LOCATION_LABELS[storeLocation]}. Switch locations from the home screen to see it.`,
                        `✅ Guardado, pero este turno es en ${LOCATION_LABELS[shiftData.location]} y estás viendo ${LOCATION_LABELS[storeLocation]}. Cambia de ubicación en la pantalla de inicio para verlo.`,
                    ));
                }, 0);
            }
        } catch (e) {
            console.error('Add shift failed:', e);
            toast(tx('Could not save shift: ', 'No se pudo guardar el turno: ') + e.message);
        }
    };

    // 2026-05-15 — Andrew: "if i added a staff to the slot but then take
    // them off they didnt come off completely the open slots above still
    // showed the staff."
    //
    // Real bug: when a shift came from a staffing_need (sh.fromNeedId
    // set by fillNeedWithStaff), the need's filledStaff/filledShiftIds
    // arrays tracked it. The unfill path (× on the green chip in the
    // Open Slots panel) used unfillNeedSlot which deletes both the shift
    // AND prunes the need. But the GRID delete path (× on the shift cube,
    // drag-to-delete, bulk delete, ListView delete) just did
    // deleteDoc(shifts/{id}) — the need still thought it was filled. So
    // the green chip stayed and the X/Y ratio stayed wrong.
    //
    // Helper called after every shift delete. No-op for shifts that
    // weren't created from a staffing_need.
    const pruneNeedAfterShiftDelete = async (shift) => {
        if (!shift?.fromNeedId) return;
        const need = staffingNeeds.find(n => n.id === shift.fromNeedId);
        if (!need) return;
        const filledStaff = Array.isArray(need.filledStaff) ? need.filledStaff : [];
        const filledShiftIds = Array.isArray(need.filledShiftIds) ? need.filledShiftIds : [];
        // Prefer matching by shift ID — precise even when the same person
        // fills multiple slots in one need (e.g. they're tagged twice).
        // Fall back to staffName match for legacy slots where
        // filledShiftIds wasn't tracked (old data pre-2026-04).
        let idx = filledShiftIds.indexOf(shift.id);
        if (idx < 0) idx = filledStaff.indexOf(shift.staffName);
        if (idx < 0) return;
        try {
            await updateDoc(doc(db, 'staffing_needs', shift.fromNeedId), {
                filledStaff: filledStaff.filter((_, i) => i !== idx),
                filledShiftIds: filledShiftIds.filter((_, i) => i !== idx),
            });
        } catch (e) {
            console.warn('Need prune after shift delete failed (non-fatal):', e);
        }
    };

    const handleDeleteShift = async (shiftId, opts = {}) => {
        // Capture the shift's pre-delete details so we can notify the
        // affected staffer AFTER the delete commits — only if it was
        // published (drafts haven't been released to staff so silent
        // delete is fine).
        const sh = shifts.find(s => s.id === shiftId);
        if (!sh) return;
        // Gate by the SHIFT's side, not the page view. A FOH-only editor
        // shouldn't be able to delete BOH shifts even if the UI somehow
        // exposed them.
        if (!canEditSide(sh.side)) return;
        const wasPublished = sh.published !== false;
        const detail = `${sh.date} ${formatTime12h(sh.startTime)}–${formatTime12h(sh.endTime)}`;
        // Andrew 2026-06-25 — EVERY delete must confirm first. The cube trash
        // button, the context menu, the Open-Slots panel and bulk delete all
        // funnel through handleDeleteShift, so gating here guarantees none of
        // them can remove a shift without an explicit "are you sure?" popup.
        // opts.confirmed is set by the dialog's own onConfirm so it doesn't loop.
        // Deleting the schedule is meant to be deliberate, not a one-tap slip.
        if (!opts.confirmed) {
            setConfirmDialog({
                title: tx('Delete this shift?', '¿Eliminar este turno?'),
                body: tx(
                    `You are deleting ${sh.staffName || 'an unassigned'} shift on ${detail}. This can't be undone — are you sure?`,
                    `Estás eliminando el turno de ${sh.staffName || 'sin asignar'} el ${detail}. No se puede deshacer — ¿estás seguro?`
                ),
                confirmLabel: tx('Delete shift', 'Eliminar turno'),
                tone: 'danger',
                onConfirm: () => handleDeleteShift(shiftId, { ...opts, confirmed: true }),
            });
            return;
        }
        // Two delete paths:
        //   - opts.immediate (per-cube inline confirm flow): the user has
        //     already tapped "yes" on a 1-click inline confirm right next
        //     to the shift. Skip the 5-second undoToast and just commit —
        //     the inline confirm IS the safety net. Feels instant.
        //   - default (other call sites like drag-to-delete, bulk delete):
        //     keep the 5-second undoToast so a fat-finger has a recovery
        //     window.
        // Admin-fanout only when a PUBLISHED shift is deleted. Drafts
        // haven't been released to anyone, so silent-delete is correct
        // for both staff and admin — no point pinging co-managers about
        // schedule scratch work.
        const fanoutAdmins = () => {
            if (!wasPublished) return;
            notifyManagement({
                type: 'shift_deleted_admin',
                title: { en: '🗑 Shift deleted', es: '🗑 Turno eliminado' },
                body: { en: `${sh.staffName || 'Unassigned'} • ${detail} • by ${staffName}`,
                        es: `${sh.staffName || 'Sin asignar'} • ${detail} • por ${staffName}` },
                link: '/schedule',
                deepLink: 'schedule',
                tag: `shift_deleted:${shiftId}`,
                createdBy: staffName,
            }).catch(() => {});
        };
        if (opts.immediate) {
            try {
                await deleteDoc(doc(db, 'shifts', shiftId));
                // Prune the linked staffing_need so the Open Slots panel
                // reflects this delete (no-op when sh.fromNeedId is absent).
                await pruneNeedAfterShiftDelete(sh);
                auditShiftChange({ shiftId, staffName: sh.staffName, action: 'deleted',
                    before: { date: sh.date, startTime: sh.startTime, endTime: sh.endTime, side: sh.side || null }, surface: 'admin-dashboard' });
                if (wasPublished && sh.staffName) {
                    notify(sh.staffName, 'shift_deleted',
                        { en: `🗑 Shift removed: ${detail}`, es: `🗑 Turno eliminado: ${detail}` },
                        { en: 'Your manager removed this shift.', es: 'Tu gerente eliminó este turno.' },
                        '/schedule',
                        { tagSuffix: `shift:${shiftId}` }
                    ).catch(() => {});
                }
                fanoutAdmins();
                toast(tx(`🗑 Deleted (${detail})`, `🗑 Eliminado (${detail})`));
            } catch (e) {
                console.error('Delete shift failed:', e);
                toast(tx('Delete failed: ', 'Error al eliminar: ') + (e.message || e));
            }
            return;
        }
        // Default path — undo toast for other call sites.
        undoToast(
            tx(`🗑 Shift deleted (${detail})`, `🗑 Turno eliminado (${detail})`),
            async () => {
                try {
                    await deleteDoc(doc(db, 'shifts', shiftId));
                    // Same need-prune as the immediate path. If the user hits
                    // Undo, this callback never runs, so the need stays filled.
                    await pruneNeedAfterShiftDelete(sh);
                    auditShiftChange({ shiftId, staffName: sh.staffName, action: 'deleted',
                        before: { date: sh.date, startTime: sh.startTime, endTime: sh.endTime, side: sh.side || null }, surface: 'admin-dashboard' });
                    if (wasPublished && sh.staffName) {
                        await notify(sh.staffName, 'shift_deleted',
                            { en: 'Shift removed', es: 'Turno eliminado' },
                            { en: `Your ${detail} shift has been removed.`,
                              es: `Tu turno del ${detail} ha sido eliminado.` },
                            null, { allowSelf: true, tagSuffix: `shift:${shiftId}` });
                    }
                    fanoutAdmins();
                } catch (e) {
                    console.error('Delete shift failed:', e);
                    toast(tx('Could not delete: ', 'No se pudo eliminar: ') + e.message, { kind: 'error' });
                }
            },
            { delayMs: 5000, undoLabel: tx('Undo', 'Deshacer'), kind: 'warn' }
        );
    };

    // ── Drag-and-drop: move a shift to a different cell (date / staff). ──
    // Source = shift cube (draggable). Target = grid cell.
    // Also supports Alt-drag (or shift-drag) to COPY instead of move — Phase 2B
    // could expose a UI hint. For now: plain drag = move.
    // Inline-edit a shift's start/end times from the cube itself — no modal.
    // Validates: end > start, both present. Other edits (assignee, role,
    // notes, double-flag, location, etc.) still go through the full modal.
    const handleUpdateShiftTimes = async (shiftId, startTime, endTime) => {
        if (!startTime || !endTime) return;
        if (endTime <= startTime) {
            toast(tx('End time must be after start time.', 'La hora de fin debe ser después del inicio.'));
            return;
        }
        const sh = shifts.find(s => s.id === shiftId);
        if (!sh) return;
        if (!canEditSide(sh.side)) return;
        const wasPublished = sh && sh.published !== false;
        const oldDetail = sh ? `${formatTime12h(sh.startTime)}–${formatTime12h(sh.endTime)}` : '';
        const newDetail = `${formatTime12h(startTime)}–${formatTime12h(endTime)}`;
        try {
            await updateDoc(doc(db, 'shifts', shiftId), {
                startTime,
                endTime,
                // Re-arm the 1-hour reminder. The server cron stamps
                // reminderSent:true once it fires and skips flagged shifts,
                // so a shift moved to a new time would otherwise never
                // re-remind (sendShiftReminders, functions/index.js).
                reminderSent: false,
                reminderSentAt: null,
                updatedAt: serverTimestamp(),
                updatedBy: staffName,
            });
            auditShiftChange({ shiftId, staffName: sh.staffName, action: 'edited',
                before: { startTime: sh.startTime, endTime: sh.endTime }, after: { startTime, endTime }, surface: 'admin-dashboard' });
            // Availability acknowledgment modal on conflict (replaces the
            // toast — toast was easy to miss while the manager kept
            // dragging). See setAvailabilityWarn comment.
            const staffRecord = (staffList || []).find(x => x.name === sh.staffName);
            const conflict = checkAvailabilityConflict(staffRecord, sh.date, startTime, endTime);
            if (conflict) {
                setAvailabilityWarn({
                    shiftId,
                    staffName: sh.staffName,
                    date: sh.date,
                    startTime,
                    endTime,
                    conflict,
                    kind: 'resized',
                });
            }
            // Push to the assigned staffer if their PUBLISHED shift just
            // changed times. Drafts are silent (not released yet).
            if (wasPublished && sh.staffName && (sh.startTime !== startTime || sh.endTime !== endTime)) {
                await notify(sh.staffName, 'shift_time_changed',
                    { en: 'Shift time changed', es: 'Horario de turno cambiado' },
                    { en: `Your ${sh.date} shift moved: ${oldDetail} → ${newDetail}.`,
                      es: `Tu turno del ${sh.date} cambió: ${oldDetail} → ${newDetail}.` },
                    null, { allowSelf: true });
            }
        } catch (e) {
            console.error('Update shift times failed:', e);
            toast(tx('Could not update times: ', 'No se pudieron actualizar los horarios: ') + e.message);
        }
    };

    const handleDropShift = async (shiftId, newStaffName, newDate) => {
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) return;
        if (!canEditSide(shift.side)) return;
        // No-op if dropped on its own cell.
        if (shift.staffName === newStaffName && shift.date === newDate) return;
        // Refuse to drop on a closed date. 2026-06-20 (QA audit S2): pass the
        // shift's OWN location so a single-store closure is enforced in "both"
        // view — the no-arg form only blocks when BOTH stores are closed, so a
        // Webster shift could be dropped onto a Webster-closed Sunday.
        if (dateClosed(newDate, shift.location)) {
            toast(tx('Cannot drop on a closed date.', 'No puedes soltar en una fecha cerrada.'));
            return;
        }
        // Refuse to drop on a staffer's PTO date.
        if (isStaffOffOn(newStaffName, newDate)) {
            toast(tx(`${newStaffName} is on approved time-off that date.`, `${newStaffName} tiene tiempo libre aprobado esa fecha.`));
            return;
        }
        // Soft warning (NOT a block) when the shift overlaps a PARTIAL off
        // window — they're still schedulable, but flag it so a manager doesn't
        // accidentally book the exact hours they asked off. (Andrew 2026-06-17:
        // "schedulable + overlap warning".)
        if (shiftOverlapsPartialOff(newStaffName, newDate, shift.startTime, shift.endTime)) {
            const win = partialOffWindowsOn(newStaffName, newDate).map(ptoWindowLabel).filter(Boolean).join(', ');
            toast(tx(`⚠ ${newStaffName} asked off ${win} that day — this shift overlaps it.`,
                     `⚠ ${newStaffName} pidió libre ${win} ese día — este turno se cruza.`));
            // fall through — placement still allowed
        }
        const wasPublished = shift.published !== false;
        const oldStaff = shift.staffName;
        const oldDate = shift.date;
        const detail = `${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)}`;
        // 2026-05-24 audit fix: if the drop crosses sides (BOH shift
        // dropped onto a FOH-only staffer), keep shift.side in sync
        // with the new owner's home side. Without this, the shift
        // would carry stale side='boh' and disappear from the FOH
        // grid filter — invisible-but-existing assignment. Resolve
        // the new owner's side via the same helper used for cell
        // rendering, fall back to the current side.
        const newOwner = (staffList || []).find(x => x.name === newStaffName);
        const newOwnerSide = newOwner ? resolveStaffSide(newOwner) : shift.side;
        try {
            // Andrew 2026-05-30 audit fix — wrap the drop write in
            // runTransaction. Before this it was a plain updateDoc, so
            // two managers dragging the same shift in the same second
            // produced last-write-wins. With the transaction we re-
            // read the live doc, refuse if it was deleted, refuse if
            // someone ELSE already moved the same shift since we
            // picked it up (staff or date drifted), and only then
            // commit. The swap-approval path at 2206 already uses
            // this pattern — making drop consistent.
            await runTransaction(db, async (txn) => {
                const ref = doc(db, 'shifts', shiftId);
                const snap = await txn.get(ref);
                if (!snap.exists()) {
                    throw new Error(tx('Shift was deleted by another user.', 'Otro usuario eliminó el turno.'));
                }
                const live = snap.data() || {};
                if (live.staffName !== shift.staffName || live.date !== shift.date) {
                    throw new Error(tx(
                        'Shift was changed by another user — refresh and try again.',
                        'Otro usuario cambió el turno — actualiza e inténtalo de nuevo.',
                    ));
                }
                txn.update(ref, {
                    staffName: newStaffName,
                    date: newDate,
                    // Re-arm the 1-hour reminder when the shift moves to a new
                    // day/time (cron skips shifts already flagged reminderSent).
                    reminderSent: false,
                    reminderSentAt: null,
                    ...(newOwnerSide && newOwnerSide !== live.side ? { side: newOwnerSide } : {}),
                    // 2026-06-16 (#7): if this move changes the OWNER, cancel any
                    // open/pending offer so a stale claim can't later be approved
                    // and silently flip the shift to the old pending claimer. A
                    // same-owner date move keeps the offer intact.
                    ...(newStaffName !== shift.staffName ? {
                        offerStatus: null, offeredBy: null, offeredAt: null,
                        pendingClaimBy: null, claimedAt: null,
                        coverNeeded: false, coverNeededAt: null, proposedSplit: null,
                    } : {}),
                    updatedAt: serverTimestamp(),
                });
            });
            auditShiftChange({ shiftId, staffName: newStaffName, action: 'moved',
                before: { staffName: oldStaff, date: oldDate }, after: { staffName: newStaffName, date: newDate }, surface: 'admin-dashboard' });
            // Availability acknowledgment modal — same pattern as add and
            // drag-resize, surfaces if the move lands the shift outside
            // the (new) staff's window for the (new) day-of-week.
            const newStaffRecord = (staffList || []).find(x => x.name === newStaffName);
            const conflict = checkAvailabilityConflict(newStaffRecord, newDate, shift.startTime, shift.endTime);
            if (conflict) {
                setAvailabilityWarn({
                    shiftId,
                    staffName: newStaffName,
                    date: newDate,
                    startTime: shift.startTime,
                    endTime: shift.endTime,
                    conflict,
                    kind: 'moved',
                });
            }
            // Push notifications when a published shift moves between
            // staff or dates. Three cases:
            //   - assignee changed: notify both old (lost shift) and new (got shift)
            //   - date changed only: notify the assignee that day moved
            // Drafts are silent (not released yet).
            if (wasPublished) {
                if (oldStaff !== newStaffName) {
                    if (oldStaff) {
                        await notify(oldStaff, 'shift_reassigned',
                            { en: 'Shift reassigned', es: 'Turno reasignado' },
                            { en: `Your ${oldDate} ${detail} shift was reassigned to ${newStaffName}.`,
                              es: `Tu turno del ${oldDate} ${detail} fue reasignado a ${newStaffName}.` },
                            null, { allowSelf: true });
                    }
                    await notify(newStaffName, 'shift_added',
                        { en: 'New shift assigned', es: 'Nuevo turno asignado' },
                        { en: `You picked up the ${newDate} ${detail} shift (was ${oldStaff}'s).`,
                          es: `Tomaste el turno del ${newDate} ${detail} (antes de ${oldStaff}).` },
                        null, { allowSelf: true });
                } else if (oldDate !== newDate) {
                    await notify(newStaffName, 'shift_date_changed',
                        { en: 'Shift moved', es: 'Turno movido' },
                        { en: `Your shift moved from ${oldDate} to ${newDate} (${detail}).`,
                          es: `Tu turno se movió del ${oldDate} al ${newDate} (${detail}).` },
                        null, { allowSelf: true });
                }
            }
        } catch (e) {
            console.error('Drop shift failed:', e);
            toast(tx('Could not move shift: ', 'No se pudo mover: ') + e.message);
        }
    };

    // ── Shift offer / take / approve / deny ────────────────────────────────
    // 2026-05-16 — direct SHIFT SWAP request flow. Distinct from the
    // offer-to-market handleOfferShift below.
    //   - Staff picks one of THEIR upcoming published shifts + a
    //     specific OTHER staff's upcoming shift to swap with.
    //   - Doc written to /swap_requests with status='pending'.
    //   - Admins notified via notifyAdmins; the other staffer is NOT
    //     notified yet (manager decides first to avoid drama on
    //     unilateral requests).
    //   - On approve: both shifts swap staffName atomically (transaction).
    //   - On deny: requester is notified, doc marked status='denied'.
    const handleRequestSwap = async ({ myShift, theirShift, note }) => {
        if (!myShift || !theirShift) return;
        if (myShift.staffName !== staffName) {
            toast(tx('That shift isn\'t yours.', 'Ese turno no es tuyo.'), { kind: 'error' });
            return;
        }
        // Block past shifts on either side.
        const todayStr = toDateStr(new Date());
        if (myShift.date < todayStr || theirShift.date < todayStr) {
            toast(tx('Cannot swap past shifts.', 'No se pueden intercambiar turnos pasados.'), { kind: 'error' });
            return;
        }
        // Block self-swap (same person both sides).
        if (theirShift.staffName === staffName) {
            toast(tx('Pick someone else\'s shift to swap with.', 'Elige el turno de otra persona.'), { kind: 'error' });
            return;
        }
        // Block duplicate pending request between the same two shifts.
        const dup = swapRequests.find(r =>
            r.status === 'pending' &&
            ((r.fromShiftId === myShift.id && r.toShiftId === theirShift.id) ||
             (r.fromShiftId === theirShift.id && r.toShiftId === myShift.id))
        );
        if (dup) {
            toast(tx('A swap request between these shifts is already pending.', 'Ya hay una solicitud pendiente entre estos turnos.'), { kind: 'warn' });
            return;
        }
        try {
            const ref = await addDoc(collection(db, 'swap_requests'), {
                fromStaff: staffName,
                fromShiftId: myShift.id,
                toStaff: theirShift.staffName,
                toShiftId: theirShift.id,
                // Snapshots so the manager UI can render without re-fetching
                // shifts every time. If the underlying shift changes between
                // request and approve, we re-verify on approve.
                fromShiftSnapshot: { date: myShift.date, startTime: myShift.startTime, endTime: myShift.endTime, location: myShift.location, side: myShift.side || null },
                toShiftSnapshot:   { date: theirShift.date, startTime: theirShift.startTime, endTime: theirShift.endTime, location: theirShift.location, side: theirShift.side || null },
                // Earliest of the two shift dates — used for the 6-month
                // listener cutoff so old swap docs auto-fall-off.
                requestedDate: myShift.date < theirShift.date ? myShift.date : theirShift.date,
                note: (note || '').trim().slice(0, 200),
                status: 'pending',
                createdBy: staffName,
                createdAt: serverTimestamp(),
            });
            auditShiftChange({ shiftId: myShift.id, staffName, action: 'swap_requested',
                before: { date: myShift.date }, after: { swapWith: theirShift.staffName, theirShiftId: theirShift.id }, surface: 'self-serve' });
            const dateLine = myShift.date === theirShift.date
                ? myShift.date
                : `${myShift.date} ↔ ${theirShift.date}`;
            await notifyManagement({
                type: 'swap_request',
                title: { en: `🔄 Swap request: ${staffName} ↔ ${theirShift.staffName}`, es: `🔄 Solicitud de cambio: ${staffName} ↔ ${theirShift.staffName}` },
                body: `${dateLine} · ${formatTime12h(myShift.startTime)}–${formatTime12h(myShift.endTime)} ↔ ${formatTime12h(theirShift.startTime)}–${formatTime12h(theirShift.endTime)}`,
                link: '/schedule',
                deepLink: 'schedule',
                tag: `swap_request:${ref.id}`,
                createdBy: staffName,
                excludeStaff: staffName,  // requester is the actor, no bell needed
            }).catch(e => console.warn('swap_request management notify failed (non-fatal):', e));
            setShowSwapModal(false);
            toast(tx('✓ Swap requested — manager will review', '✓ Solicitud enviada — el gerente revisará'), { kind: 'success', duration: 4000 });
        } catch (e) {
            console.error('handleRequestSwap failed:', e);
            toast(tx('Could not send request: ', 'No se pudo enviar: ') + (e.message || e), { kind: 'error' });
        }
    };

    // Manager approves: atomically swap staffName on both shifts via a
    // Firestore transaction so we never end up half-swapped. Marks the
    // swap doc 'approved' + notifies both staff.
    const handleApproveSwapRequest = async (request) => {
        if (!canEdit) return;
        try {
            await runTransaction(db, async (tx) => {
                const fromRef = doc(db, 'shifts', request.fromShiftId);
                const toRef   = doc(db, 'shifts', request.toShiftId);
                const reqRef  = doc(db, 'swap_requests', request.id);
                const [fromSnap, toSnap, reqSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef), tx.get(reqRef)]);
                if (!fromSnap.exists() || !toSnap.exists()) {
                    throw new Error(tx_msg(
                        'One of the shifts no longer exists. Request cleared.',
                        'Uno de los turnos ya no existe. Solicitud cancelada.',
                    ));
                }
                if (!reqSnap.exists() || reqSnap.data().status !== 'pending') {
                    throw new Error(tx_msg(
                        'Request already handled.',
                        'La solicitud ya fue procesada.',
                    ));
                }
                const fromData = fromSnap.data();
                const toData = toSnap.data();
                // Verify ownership hasn't drifted since the request was filed.
                if (fromData.staffName !== request.fromStaff || toData.staffName !== request.toStaff) {
                    throw new Error(tx_msg(
                        'Shift ownership changed since the request was filed.',
                        'La asignación del turno cambió desde que se hizo la solicitud.',
                    ));
                }
                tx.update(fromRef, { staffName: request.toStaff, updatedAt: serverTimestamp(), updatedBy: staffName });
                tx.update(toRef,   { staffName: request.fromStaff, updatedAt: serverTimestamp(), updatedBy: staffName });
                tx.update(reqRef,  { status: 'approved', approvedBy: staffName, approvedAt: serverTimestamp() });
            });
            // Notify both staff (best-effort, outside the transaction).
            const detail = `${request.fromShiftSnapshot?.date || ''} ↔ ${request.toShiftSnapshot?.date || ''}`;
            // Audit log — Andrew 2026-06-25.
            auditShiftChange({ shiftId: request.id, staffName: request.fromStaff, action: 'swap_approved',
                after: { swappedWith: request.toStaff, dates: detail } }).catch(() => {});
            for (const recipient of [request.fromStaff, request.toStaff]) {
                const counterparty = recipient === request.fromStaff ? request.toStaff : request.fromStaff;
                notifyStaff({
                    forStaff: recipient,
                    type: 'swap_approved',
                    title: { en: '✓ Shift swap approved', es: '✓ Cambio de turno aprobado' },
                    body: { en: `Your swap with ${counterparty} is approved. ${detail}`,
                            es: `Tu cambio con ${counterparty} fue aprobado. ${detail}` },
                    link: '/schedule',
                    deepLink: 'schedule',
                    tag: `swap_approved:${request.id}:${recipient}`,
                    createdBy: staffName,
                }).catch(() => {});
            }
            // Roll-up to management so co-managers see the swap landed.
            // Skip the two swap participants here (they got the per-staff
            // ping above) but include the approver so they keep a record.
            notifyManagement({
                type: 'swap_approved_admin',
                title: { en: `✓ Swap approved: ${request.fromStaff} ↔ ${request.toStaff}`,
                         es: `✓ Cambio aprobado: ${request.fromStaff} ↔ ${request.toStaff}` },
                body: { en: `${detail} · by ${staffName}`,
                        es: `${detail} · por ${staffName}` },
                link: '/schedule',
                deepLink: 'schedule',
                tag: `swap_approved_admin:${request.id}`,
                createdBy: staffName,
            }).catch(() => {});
            toast(tx('✓ Swap approved', '✓ Cambio aprobado'), { kind: 'success', duration: 3000 });
        } catch (e) {
            console.error('handleApproveSwapRequest failed:', e);
            toast(tx('Could not approve: ', 'No se pudo aprobar: ') + (e.message || e), { kind: 'error' });
        }
    };

    // Manager denies: mark the doc denied + notify the requester only.
    // No state to roll back since nothing changed on the shifts.
    const handleDenySwapRequest = async (request) => {
        if (!canEdit) return;
        try {
            await updateDoc(doc(db, 'swap_requests', request.id), {
                status: 'denied',
                deniedBy: staffName,
                deniedAt: serverTimestamp(),
            });
            // Audit log — Andrew 2026-06-25.
            auditShiftChange({ shiftId: request.id, staffName: request.fromStaff, action: 'swap_denied',
                after: { swapWith: request.toStaff } }).catch(() => {});
            notifyStaff({
                forStaff: request.fromStaff,
                type: 'swap_denied',
                title: { en: '✕ Shift swap denied', es: '✕ Cambio de turno negado' },
                body: { en: `Your swap request with ${request.toStaff} was denied.`,
                        es: `Tu solicitud de cambio con ${request.toStaff} fue negada.` },
                link: '/schedule',
                deepLink: 'schedule',
                tag: `swap_denied:${request.id}`,
                createdBy: staffName,
            }).catch(() => {});
            // Roll-up so co-managers see denials too.
            notifyManagement({
                type: 'swap_denied_admin',
                title: { en: `✕ Swap denied: ${request.fromStaff} ↔ ${request.toStaff}`,
                         es: `✕ Cambio negado: ${request.fromStaff} ↔ ${request.toStaff}` },
                body: { en: `by ${staffName}`,
                        es: `por ${staffName}` },
                link: '/schedule',
                deepLink: 'schedule',
                tag: `swap_denied_admin:${request.id}`,
                createdBy: staffName,
            }).catch(() => {});
            toast(tx('Swap denied', 'Cambio negado'), { kind: 'success', duration: 2500 });
        } catch (e) {
            console.error('handleDenySwapRequest failed:', e);
            toast(tx('Could not deny: ', 'No se pudo negar: ') + (e.message || e), { kind: 'error' });
        }
    };

    // tiny inline so the transaction's error path stays terse — these
    // throw inside the runTransaction and surface to the caller's catch.
    // 2026-06-02 — was an English-only helper. Now resolves both
    // languages so the message that bubbles to the toast picks the
    // active locale. Caller still passes a single (en, es) pair, just
    // like the page-level tx() helper.
    const tx_msg = (en, es) => (isEn ? en : (es || en));

    // 2026-05-30 — replaced native confirm() with OfferShiftModal.
    // handleOfferShift now just opens the modal; the actual Firestore
    // write happens in commitOfferShift, which the modal calls on submit.
    // The modal adds two new fields the old binary confirm couldn't:
    //   • offerNote — optional context message ("doctor appt", etc.)
    //                 visible to pickers in their Take modal
    //   • offerUrgent — opting in to immediate FCM fan-out + red-card
    //                   styling (the same effect as the old Find Cover
    //                   flow, unified into one composer)
    const handleOfferShift = (shift) => {
        if (!shift) return;
        setOfferTarget(shift);
    };
    const commitOfferShift = async (shift, { note, urgent }) => {
        try {
            await updateDoc(doc(db, 'shifts', shift.id), {
                offerStatus: 'open',
                offeredBy: staffName,
                offeredAt: serverTimestamp(),
                offerNote: note || null,
                offerUrgent: !!urgent,
                // Urgent = same UX as Find Cover (red card + push fan-out).
                coverNeeded: !!urgent,
                coverNeededAt: urgent ? serverTimestamp() : null,
                pendingClaimBy: null,
                claimedAt: null,
                // arrayUnion + ISO-string timestamp because Firestore
                // disallows serverTimestamp() inside an array element.
                transferHistory: arrayUnion({
                    action: 'offered',
                    by: staffName,
                    at: new Date().toISOString(),
                    note: note || null,
                    urgent: !!urgent,
                }),
                updatedAt: serverTimestamp(),
            });
            // Audit log — Andrew 2026-06-25.
            auditShiftChange({ shiftId: shift.id, staffName: shift.staffName, action: 'offered',
                after: { offerStatus: 'open', urgent: !!urgent }, reason: note || undefined }).catch(() => {});
            // FCM fan-out when the offer is urgent. Mirrors the qualified-
            // staff filter from handleRequestCover (active, not the offerer,
            // same side, same location, not on PTO). Failures swallowed
            // per-staff so one bad token doesn't block the rest.
            if (urgent) {
                try {
                    const shiftSide = shift.side || resolveStaffSide((staffList || []).find(s => s.name === shift.staffName));
                    const sideLabel = shiftSide === 'boh' ? 'BOH' : 'FOH';
                    const shiftLoc = shift.location || 'webster';
                    const qualified = (staffList || []).filter(s =>
                        s && s.name && s.active !== false &&
                        s.name !== staffName &&
                        resolveStaffSide(s) === shiftSide &&
                        (shiftLoc === 'both' || s.location === 'both' || s.location === shiftLoc) &&
                        !isStaffOffOn(s.name, shift.date)
                    );
                    const detail = `${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)}`;
                    await Promise.allSettled(qualified.map(s =>
                        notify(s.name, 'cover_request',
                            { en: `🆘 ${staffName} needs cover`,
                              es: `🆘 ${staffName} necesita cobertura` },
                            { en: `${sideLabel} · ${detail}${note ? ` · "${note}"` : ''}`,
                              es: `${sideLabel} · ${detail}${note ? ` · "${note}"` : ''}` },
                            // notify() dedups on opts.tagSuffix (NOT `tag` — that
                            // key is silently ignored and falls back to Date.now(),
                            // so a retry/double-tap on "post urgent offer" would
                            // fan out a SECOND toast to every qualified staffer
                            // instead of the OS collapsing it). Matches the sibling
                            // handleRequestCover fan-out below, which uses tagSuffix.
                            null, { tagSuffix: `cover:${shift.id}` })
                    ));
                } catch (e) { console.warn('Cover fan-out failed:', e); }
            }
            toast(tx(urgent ? '🆘 Urgent offer posted' : '📢 Offer posted',
                      urgent ? '🆘 Oferta urgente publicada' : '📢 Oferta publicada'),
                  { kind: 'success', duration: 2500 });
        } catch (e) {
            console.error('Offer shift failed:', e);
            toast(tx('Could not offer shift: ', 'No se pudo ofrecer: ') + e.message, { kind: 'error' });
        }
    };

    // Find Cover — staff actively can't make a shift. Same data model as
    // a casual offer (offerStatus: 'open' so the existing claim flow keeps
    // working), but layered with coverNeeded: true so the UI gets the red
    // urgent treatment AND we fan out FCM push to every qualified staffer
    // immediately. First to tap "I'll take it" still races through
    // handleTakeShift's transaction — no changes to claim/approval needed.
    //
    // Qualification filter (mirrors auto-fill engine + manual fill chooser):
    //   • Active (not deactivated)
    //   • Not the offerer themself
    //   • Resolves to the same side as the shift
    //   • Location-compatible (single-store staff only see their store; 'both'
    //     staff see both)
    //   • Not already on approved time-off for that date
    //
    // No OT / availability filter here — we'd rather push to slightly more
    // people and let them self-select than miss the one staffer who'd say yes.
    // Manager still gets the final word at approval time.
    const handleRequestCover = async (shift) => {
        if (!shift) return;
        const shiftSide = shift.side || resolveStaffSide((staffList || []).find(s => s.name === shift.staffName));
        const sideLabel = shiftSide === 'boh' ? 'BOH' : 'FOH';
        const ok = confirm(tx(
            `🆘 Push a cover request to all qualified ${sideLabel} staff for your ${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} shift?\n\nThey'll get a push notification immediately. First to claim wins (pending manager approval). You're still responsible for the shift until someone takes it.`,
            `🆘 ¿Enviar solicitud de cobertura a todo el personal ${sideLabel} para tu turno del ${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)}?\n\nRecibirán una notificación push de inmediato. El primero en tomarlo gana (con aprobación del gerente). Sigues siendo responsable hasta que alguien lo tome.`,
        ));
        if (!ok) return;
        try {
            await updateDoc(doc(db, 'shifts', shift.id), {
                offerStatus: 'open',
                coverNeeded: true,
                coverNeededAt: serverTimestamp(),
                offeredBy: staffName,
                offeredAt: serverTimestamp(),
                pendingClaimBy: null,
                claimedAt: null,
                updatedAt: serverTimestamp(),
            });
            // Audit log — Andrew 2026-06-25.
            auditShiftChange({ shiftId: shift.id, staffName: shift.staffName, action: 'cover_requested',
                after: { offerStatus: 'open', coverNeeded: true } }).catch(() => {});

            // Fan-out push. Build the qualified list, then notify each in
            // parallel (Promise.all). notify() already handles per-staff
            // FCM token lookup + off-shift gating + delivery retry, so we
            // just call it once per recipient and swallow individual fails
            // so one bad push doesn't block the rest.
            const shiftLoc = shift.location || 'webster';
            const qualified = (staffList || []).filter(s =>
                s && s.name && s.active !== false &&
                s.name !== staffName &&
                resolveStaffSide(s) === shiftSide &&
                (shiftLoc === 'both' || s.location === 'both' || s.location === shiftLoc) &&
                !isStaffOffOn(s.name, shift.date)
            );

            const pushPromises = qualified.map(s =>
                notify(s.name, 'cover_request',
                    { en: `🆘 ${staffName} needs cover`,
                      es: `🆘 ${staffName} necesita cobertura` },
                    { en: `${shift.date} • ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} • Tap to claim`,
                      es: `${shift.date} • ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} • Toca para tomar` },
                    '/schedule',
                    { tagSuffix: `cover:${shift.id}` }
                ).catch(() => {})
            );
            await Promise.all(pushPromises);

            // Manager roll-up (separate channel, not as aggressive — just an
            // FYI ping so any manager opening the app sees pending requests).
            notifyManagement({
                type: 'cover_requested',
                title: { en: `🆘 Cover requested: ${staffName}`,
                         es: `🆘 Cobertura solicitada: ${staffName}` },
                body: { en: `${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} ${sideLabel} • pushed to ${qualified.length} staff`,
                        es: `${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} ${sideLabel} • enviado a ${qualified.length}` },
                link: '/schedule',
                deepLink: 'schedule',
                tag: `cover_req:${shift.id}`,
                createdBy: staffName,
            }).catch(() => {});

            toast(tx(
                qualified.length === 0
                    ? `⚠ No qualified ${sideLabel} staff available. Try contacting a manager directly.`
                    : `📣 Cover request sent to ${qualified.length} ${sideLabel} staff member${qualified.length === 1 ? '' : 's'}.`,
                qualified.length === 0
                    ? `⚠ No hay personal ${sideLabel} disponible. Contacta a un gerente directamente.`
                    : `📣 Solicitud enviada a ${qualified.length} miembro${qualified.length === 1 ? '' : 's'} de ${sideLabel}.`
            ));
        } catch (e) {
            console.error('Request cover failed:', e);
            toast(tx('Could not request cover: ', 'No se pudo solicitar cobertura: ') + e.message);
        }
    };

    // Bulk delete — deletes every selected shift in one shot. Wrapped in
    // an undoToast like single delete so an accidental click can be
    // recovered for 5 seconds. Mass deletes are higher-stakes than singles
    // so we require explicit confirm AND the undo window.
    const handleBulkDelete = async () => {
        const ids = Array.from(selectedShiftIds);
        if (ids.length === 0) return;
        const ok = confirm(tx(
            `Delete ${ids.length} selected shift${ids.length === 1 ? '' : 's'}? This will be undoable for 5 seconds.`,
            `¿Eliminar ${ids.length} turno${ids.length === 1 ? '' : 's'} seleccionado${ids.length === 1 ? '' : 's'}? Tendrás 5 segundos para deshacer.`
        ));
        if (!ok) return;
        const snapshot = ids.map(id => shifts.find(s => s.id === id)).filter(Boolean);
        // 2026-05-28 Audit #12 — compute a STABLE bulk op id so the
        // notify() dedupe tag works across accidental double-fires.
        // Previously the tag was `bulk:${Date.now()}` which produced
        // a fresh suffix every invocation, defeating dedupe entirely
        // — a user double-tapping the delete button could push two
        // notifications per affected staff. Sorted-first-id is
        // deterministic regardless of the order ids came in.
        const bulkId = snapshot.length > 0
            ? [...snapshot.map(s => s.id)].sort()[0]
            : `empty:${ids.length}`;
        clearSelection();
        undoToast(
            tx(`🗑 Deleted ${snapshot.length} shifts`, `🗑 Eliminados ${snapshot.length} turnos`),
            async () => {
                // Batched delete — production audit 2026-05-22. Previous
                // sequential await loop made a 50-shift bulk delete take
                // 10+ seconds. writeBatch collapses to one round-trip per
                // 400-shift chunk. Pruning of staffing_needs.filledStaff
                // entries still happens per-shift after the deletes are
                // committed — that's a read-modify-write so we can't
                // safely batch it (different needs may reference the
                // same shift).
                const BATCH_LIMIT = 400;
                try {
                    for (let i = 0; i < snapshot.length; i += BATCH_LIMIT) {
                        const batch = writeBatch(db);
                        for (const sh of snapshot.slice(i, i + BATCH_LIMIT)) {
                            batch.delete(doc(db, 'shifts', sh.id));
                        }
                        await batch.commit();
                    }
                    // Best-effort need-prune post-commit.
                    await Promise.all(snapshot.map(sh =>
                        pruneNeedAfterShiftDelete(sh).catch(e => console.warn('prune failed for', sh.id, e))
                    ));
                } catch (e) { console.warn('bulk-delete batch failed:', e); }
                // Audit log (roll-up) — Andrew 2026-06-25.
                auditShiftChange({ action: 'bulk_deleted', staffName: null,
                    after: { count: snapshot.length, ids: snapshot.slice(0, 25).map(s => s.id) } }).catch(() => {});
                // Per-staff push: one rolled-up notification per affected
                // staffer listing how many of THEIR shifts got cut. Only
                // counts published shifts (drafts hadn't been released).
                const byStaff = new Map();
                for (const sh of snapshot) {
                    if (sh.published === false) continue;
                    if (!sh.staffName) continue;
                    const list = byStaff.get(sh.staffName) || [];
                    list.push(sh);
                    byStaff.set(sh.staffName, list);
                }
                for (const [name, list] of byStaff) {
                    const sorted = [...list].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
                    const lines = sorted.slice(0, 3).map(s => `${s.date} ${formatTime12h(s.startTime)}–${formatTime12h(s.endTime)}`);
                    const moreEn = sorted.length > 3 ? `\n+${sorted.length - 3} more` : '';
                    const moreEs = sorted.length > 3 ? `\n+${sorted.length - 3} más` : '';
                    notify(name, 'shift_deleted',
                        { en: `🗑 ${list.length} shift${list.length === 1 ? '' : 's'} removed`,
                          es: `🗑 ${list.length} turno${list.length === 1 ? '' : 's'} eliminado${list.length === 1 ? '' : 's'}` },
                        { en: lines.join('\n') + moreEn,
                          es: lines.join('\n') + moreEs },
                        '/schedule',
                        { allowSelf: true, tagSuffix: `bulk:${bulkId}` }
                    ).catch(() => {});
                }
                // Admin summary — single roll-up so other managers know a
                // bulk delete just happened. Only counts PUBLISHED shifts;
                // pure draft cleanups are silent (no admin push, no staff
                // push) — drafts haven't been released so co-managers don't
                // need a ping.
                const pubCount = snapshot.filter(s => s.published !== false).length;
                if (pubCount > 0) {
                    notifyManagement({
                        type: 'shift_deleted_admin',
                        title: { en: `🗑 Bulk delete: ${pubCount} shift${pubCount === 1 ? '' : 's'}`,
                                 es: `🗑 Eliminación masiva: ${pubCount} turno${pubCount === 1 ? '' : 's'}` },
                        body: { en: `Published shifts removed • by ${staffName}`,
                                es: `Turnos publicados eliminados • por ${staffName}` },
                        link: '/schedule',
                        deepLink: 'schedule',
                        tag: `bulk_delete:${bulkId}`,
                        createdBy: staffName,
                    }).catch(() => {});
                }
            },
            { delayMs: 5000, undoLabel: tx('Undo', 'Deshacer'), kind: 'warn' }
        );
    };

    // Bulk give-up — staff selects all THEIR shifts (or admin selects any
    // staff's shifts) and offers them all up at once. Skips shifts that are
    // already offered or pending. Skips shifts the user doesn't own (unless
    // they're an admin).
    const handleBulkGiveUp = async () => {
        const ids = Array.from(selectedShiftIds);
        if (ids.length === 0) return;
        const candidates = ids
            .map(id => shifts.find(s => s.id === id))
            .filter(s => s && !s.offerStatus && (canEdit || s.staffName === staffName));
        if (candidates.length === 0) {
            toast(tx('No eligible shifts to offer (already offered, or not yours).',
                     'No hay turnos elegibles (ya ofrecidos o no son tuyos).'));
            return;
        }
        const ok = confirm(tx(
            `Offer ${candidates.length} shift${candidates.length === 1 ? '' : 's'} up for grabs? You're still responsible until taken.`,
            `¿Ofrecer ${candidates.length} turno${candidates.length === 1 ? '' : 's'}? Sigues siendo responsable hasta que alguien los tome.`
        ));
        if (!ok) return;
        // 2026-05-24 audit fix: was sequential await per shift — 30
        // shifts = ~9 seconds dead time on cellular. Mid-loop network
        // blip half-offered the batch; the toast showed partial
        // success but there was no retry path. writeBatch is a single
        // atomic round-trip — either all succeed or all fail.
        // Batch cap is 500; 30 shifts is comfortably under.
        let okCount = 0, failCount = 0;
        try {
            const batch = writeBatch(db);
            for (const sh of candidates) {
                batch.update(doc(db, 'shifts', sh.id), {
                    offerStatus: 'open',
                    offeredBy: staffName,
                    offeredAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
            }
            await batch.commit();
            okCount = candidates.length;
            // Audit log (roll-up) — Andrew 2026-06-25.
            auditShiftChange({ action: 'bulk_offered', staffName: null,
                after: { count: candidates.length, ids: candidates.slice(0, 25).map(s => s.id) } }).catch(() => {});
        } catch (e) {
            console.warn('bulk-offer batch failed:', e);
            failCount = candidates.length;
        }
        clearSelection();
        toast(tx(`📣 Offered ${okCount} shifts${failCount > 0 ? ` (${failCount} failed)` : ''}`,
                 `📣 Ofrecidos ${okCount} turnos${failCount > 0 ? ` (${failCount} fallidos)` : ''}`));
    };

    const handleCancelOffer = async (shift) => {
        try {
            await updateDoc(doc(db, 'shifts', shift.id), {
                offerStatus: null,
                offeredBy: null,
                offeredAt: null,
                // Also clears any cover-request flag — same UX for "cancel
                // offer" and "cancel cover request" since both come from
                // the same shift state.
                coverNeeded: false,
                coverNeededAt: null,
                pendingClaimBy: null,
                claimedAt: null,
                updatedAt: serverTimestamp(),
            });
            // Audit log — Andrew 2026-06-25.
            auditShiftChange({ shiftId: shift.id, staffName: shift.staffName, action: 'offer_cancelled',
                before: { offerStatus: shift.offerStatus || 'open' }, after: { offerStatus: null } }).catch(() => {});
        } catch (e) {
            console.error('Cancel offer failed:', e);
        }
    };

    // Race-safe shift take. Two staff hitting "Take" within the same snapshot
    // tick used to BOTH succeed locally (each updateDoc would overwrite the
    // other's pendingClaimBy). The transaction reads the live shift, refuses
    // if it's not still 'open', and writes atomically — first writer wins,
    // second gets a clear error.
    //
    // 2026-05-30 — replaced native confirm() with TakeShiftModal. The modal
    // shows the offerer's note, picker's projected weekly hours, conflict
    // warnings, and an optional PARTIAL PICKUP picker. If the picker only
    // wants part of the shift (Andrew's "10-3 offered, take 10-1, original
    // returns at 1" example), they pass { partial: { startTime, endTime } }
    // — we stash that as `proposedSplit` on the doc and the manager's
    // approval handler turns it into two shifts atomically.
    const handleTakeShift = (shift) => {
        if (!shift) return;
        setTakeTarget(shift);
    };
    const commitTakeShift = async (shift, { partial } = {}) => {
        try {
            await runTransaction(db, async (txn) => {
                const ref = doc(db, 'shifts', shift.id);
                const snap = await txn.get(ref);
                if (!snap.exists()) {
                    throw new Error(tx('Shift no longer exists.', 'El turno ya no existe.'));
                }
                const live = snap.data();
                if (live.offerStatus !== 'open') {
                    // Someone else got there first, or owner cancelled the offer.
                    throw new Error(tx('Shift is no longer open for pickup.', 'El turno ya no está disponible.'));
                }
                if (live.staffName === staffName) {
                    throw new Error(tx("You can't take your own shift.", 'No puedes tomar tu propio turno.'));
                }
                txn.update(ref, {
                    offerStatus: 'pending',
                    pendingClaimBy: staffName,
                    claimedAt: serverTimestamp(),
                    // Partial pickup ("I can only do 10-1, not the full 10-3").
                    // Manager's approval handler reads proposedSplit and, in
                    // the same approval transaction, creates a 2nd shift doc
                    // for the leftover assigned to the original holder.
                    proposedSplit: partial && partial.startTime && partial.endTime
                        ? { startTime: partial.startTime, endTime: partial.endTime }
                        : null,
                    transferHistory: arrayUnion({
                        action: 'claimed',
                        by: staffName,
                        at: new Date().toISOString(),
                        proposedSplit: partial && partial.startTime && partial.endTime
                            ? { startTime: partial.startTime, endTime: partial.endTime }
                            : null,
                    }),
                    updatedAt: serverTimestamp(),
                });
            });
            // Audit log — Andrew 2026-06-25.
            auditShiftChange({ shiftId: shift.id, staffName: shift.staffName, action: 'claimed',
                after: { pendingClaimBy: staffName, partial: partial && partial.startTime ? `${partial.startTime}-${partial.endTime}` : null } }).catch(() => {});
            // Tell management a claim is waiting — without this a pending
            // takeover sits undiscovered until a manager happens to open the
            // schedule. Reuse the existing 'swap_request' type so it routes +
            // isn't dropped by the notification whitelist. Best-effort.
            notifyManagement({
                type: 'swap_request',
                title: { en: `✋ Shift claim: ${staffName}`, es: `✋ Reclamo de turno: ${staffName}` },
                body: `${shift.staffName} · ${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)}${partial ? tx(' (partial)', ' (parcial)') : ''}`,
                link: '/schedule',
                deepLink: 'schedule',
                tag: `shift_claim:${shift.id}`,
                createdBy: staffName,
                excludeStaff: staffName,
            }).catch(e => console.warn('shift-claim management notify failed (non-fatal):', e));
            toast(tx(partial ? '✋ Partial pickup posted — waiting for manager' : '✋ Take posted — waiting for manager',
                      partial ? '✋ Toma parcial enviada — esperando gerente' : '✋ Toma enviada — esperando gerente'),
                  { kind: 'success', duration: 3000 });
        } catch (e) {
            console.error('Take shift failed:', e);
            toast((tx('Could not take shift: ', 'No se pudo tomar: ')) + (e.message || e), { kind: 'error' });
        }
    };

    // Race-safe swap approval. Two managers approving simultaneously could
    // each fire notifications and double-write. Also caught here: approving
    // a swap whose claim was just cancelled (the live shift would be back to
    // 'open' — approval is invalid, refuse). First manager wins; second sees
    // a clear "already approved by X" message.
    const handleApproveSwap = async (shift) => {
        if (!canEditSide(shift?.side)) return;
        const oldOwner = shift.staffName;
        const newOwner = shift.pendingClaimBy;
        let detail = '';
        let leftoverDetail = '';  // populated when splitting; drives notification copy
        try {
            await runTransaction(db, async (txn) => {
                const ref = doc(db, 'shifts', shift.id);
                const snap = await txn.get(ref);
                if (!snap.exists()) {
                    throw new Error(tx('Shift no longer exists.', 'El turno ya no existe.'));
                }
                const live = snap.data();
                if (live.offerStatus !== 'pending' || !live.pendingClaimBy) {
                    throw new Error(tx('No pending claim on this shift anymore.', 'Ya no hay reclamo pendiente.'));
                }
                if (live.approvedBy) {
                    throw new Error(tx(`Already approved by ${live.approvedBy}.`, `Ya aprobado por ${live.approvedBy}.`));
                }
                // ── 2026-05-30 — partial pickup / split support ─────────
                // If the picker proposed a partial range via TakeShiftModal,
                // the doc carries `proposedSplit: { startTime, endTime }`.
                // We turn that into:
                //   1. The original shift doc → picker's range only
                //      (staffName=picker, startTime/endTime = split range)
                //   2. 0, 1, or 2 NEW shift docs for the leftover, assigned
                //      back to the original holder. Leftover = original time
                //      MINUS the split range. For Andrew's example (orig 10-3,
                //      picker takes 10-1) leftover = 1-3 (1 piece). For a
                //      middle take (orig 10-3, picker takes 11-2) leftover =
                //      10-11 + 2-3 (2 pieces).
                // ALL writes happen inside this transaction, so a concurrent
                // approval of another shift can never see a half-applied
                // split. If anything throws, nothing commits.
                const split = live.proposedSplit;
                const isSplit = !!(split && split.startTime && split.endTime &&
                    split.startTime >= live.startTime &&
                    split.endTime <= live.endTime &&
                    split.startTime < split.endTime &&
                    !(split.startTime === live.startTime && split.endTime === live.endTime));

                if (isSplit) {
                    detail = `${live.date} ${formatTime12h(split.startTime)}–${formatTime12h(split.endTime)}`;
                    // 1. Shrink + reassign the original doc → picker portion.
                    txn.update(ref, {
                        staffName: live.pendingClaimBy,
                        startTime: split.startTime,
                        endTime: split.endTime,
                        offerStatus: null,
                        offeredBy: null,
                        offeredAt: null,
                        offerNote: null,
                        offerUrgent: false,
                        coverNeeded: false,
                        coverNeededAt: null,
                        pendingClaimBy: null,
                        claimedAt: null,
                        proposedSplit: null,
                        approvedBy: staffName,
                        approvedAt: serverTimestamp(),
                        transferHistory: arrayUnion({
                            action: 'split-approved-picker',
                            by: staffName,
                            at: new Date().toISOString(),
                            from: oldOwner,
                            to: newOwner,
                            startTime: split.startTime,
                            endTime: split.endTime,
                        }),
                        updatedAt: serverTimestamp(),
                    });
                    // 2. Carve leftover into 0–2 contiguous pieces.
                    const leftoverPieces = [];
                    if (live.startTime < split.startTime) {
                        leftoverPieces.push({ startTime: live.startTime, endTime: split.startTime });
                    }
                    if (split.endTime < live.endTime) {
                        leftoverPieces.push({ startTime: split.endTime, endTime: live.endTime });
                    }
                    leftoverDetail = leftoverPieces.map(p => `${formatTime12h(p.startTime)}–${formatTime12h(p.endTime)}`).join(' + ');
                    for (const piece of leftoverPieces) {
                        const newShiftRef = doc(collection(db, 'shifts'));
                        txn.set(newShiftRef, {
                            staffName: oldOwner,
                            side: live.side,
                            location: live.location,
                            date: live.date,
                            startTime: piece.startTime,
                            endTime: piece.endTime,
                            role: live.role || null,
                            notes: live.notes || null,
                            published: live.published !== false,
                            isDouble: false,
                            splitFrom: shift.id,
                            splitAt: serverTimestamp(),
                            splitBy: staffName,
                            transferHistory: [{
                                action: 'split-created-leftover',
                                by: staffName,
                                at: new Date().toISOString(),
                                from: shift.id,
                                holder: oldOwner,
                            }],
                            createdAt: serverTimestamp(),
                            updatedAt: serverTimestamp(),
                        });
                    }
                } else {
                    // FULL SWAP — no split, behave as before plus history entry.
                    detail = `${live.date} ${formatTime12h(live.startTime)}–${formatTime12h(live.endTime)}`;
                    txn.update(ref, {
                        staffName: live.pendingClaimBy, // use live value, not stale snapshot
                        offerStatus: null,
                        offeredBy: null,
                        offeredAt: null,
                        offerNote: null,
                        offerUrgent: false,
                        coverNeeded: false,
                        coverNeededAt: null,
                        pendingClaimBy: null,
                        claimedAt: null,
                        proposedSplit: null,
                        approvedBy: staffName,
                        approvedAt: serverTimestamp(),
                        transferHistory: arrayUnion({
                            action: 'swap-approved',
                            by: staffName,
                            at: new Date().toISOString(),
                            from: oldOwner,
                            to: newOwner,
                        }),
                        updatedAt: serverTimestamp(),
                    });
                }
            });
            // Audit log — Andrew 2026-06-25.
            auditShiftChange({ shiftId: shift.id, staffName: newOwner, action: 'approved',
                before: { staffName: oldOwner }, after: { staffName: newOwner, split: !!leftoverDetail } }).catch(() => {});
            // Notifications outside the transaction — they hit a different
            // collection and shouldn't roll back the swap if push fails.
            if (leftoverDetail) {
                await notify(oldOwner, 'swap_approved',
                    { en: 'Shift split approved', es: 'División de turno aprobada' },
                    { en: `Your ${detail} portion is now ${newOwner}'s. You still cover: ${leftoverDetail}.`,
                      es: `Tu porción ${detail} ahora es de ${newOwner}. Aún cubres: ${leftoverDetail}.` });
                await notify(newOwner, 'swap_approved',
                    { en: 'Partial shift assigned', es: 'Turno parcial asignado' },
                    { en: `You're now on for ${detail}.`,
                      es: `Ahora estás en ${detail}.` });
            } else {
                await notify(oldOwner, 'swap_approved',
                    { en: 'Swap approved', es: 'Cambio aprobado' },
                    { en: `Your shift on ${detail} is now ${newOwner}'s.`,
                      es: `Tu turno del ${detail} ahora es de ${newOwner}.` });
                await notify(newOwner, 'swap_approved',
                    { en: 'Shift assigned', es: 'Turno asignado' },
                    { en: `The shift on ${detail} is now yours.`,
                      es: `El turno del ${detail} ahora es tuyo.` });
            }
        } catch (e) {
            console.error('Approve failed:', e);
            toast((tx('Could not approve: ', 'No se pudo aprobar: ')) + (e.message || e), { kind: 'error' });
        }
    };

    const handleDenySwap = async (shift) => {
        if (!canEditSide(shift?.side)) return;
        try {
            await updateDoc(doc(db, 'shifts', shift.id), {
                offerStatus: 'open', // back to open offer; original owner still on hook
                pendingClaimBy: null,
                claimedAt: null,
                updatedAt: serverTimestamp(),
            });
            // Audit log — Andrew 2026-06-25.
            auditShiftChange({ shiftId: shift.id, staffName: shift.staffName, action: 'claim_denied',
                after: { claimBy: shift.pendingClaimBy, offerStatus: 'open' } }).catch(() => {});
            const detail = `${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)}`;
            await notify(shift.pendingClaimBy, 'swap_denied',
                { en: 'Swap denied', es: 'Cambio negado' },
                { en: `Manager denied your takeover of the ${detail} shift.`,
                  es: `Gerente negó tu toma del turno ${detail}.` });
        } catch (e) {
            console.error('Deny failed:', e);
        }
    };

    // ── Staffing needs (shift slots) ───────────────────────────────────────
    // Workflow: manager defines a slot ("Friday morning FOH: 5 people 9–3").
    // The slot stores a count plus a list of filledStaff names. Each fill
    // creates a real shift in the `shifts` collection so the rest of the app
    // (auto-fill, hours, swap, ICS export, etc.) treats it like any shift.
    // Broadcast a "up for grabs" slot to every eligible staffer on
    // the matching side + location. Andrew 2026-05-23: "the up for
    // grabs also gets sent to all staff in the FOH if its a FOH
    // shift and same for back through push notifications." We fan
    // out one /notifications doc per recipient; dispatchNotification
    // CF picks them up and delivers FCM pushes from there. Caller
    // is the manager who created (or just-toggled) the slot — they
    // shouldn't self-notify, so we skip their own name.
    //
    // Eligibility: a staffer matches a FOH slot if their
    // scheduleSide/side='foh', OR they're scheduleSide='both', OR
    // their role string matches the FOH role pattern. Same logic
    // mirrored for BOH. Location must align too — Webster slots
    // don't ping Maryland-only staff and vice versa. location='both'
    // staff get pings for either store.
    const broadcastUpForGrabs = async (need) => {
        if (!need || !need.openToAllStaff) return;
        const sideLc = String(need.side || 'foh').toLowerCase();
        const needLoc = String(need.location || '').toLowerCase();
        const sideMatches = (s) => {
            const explicit = String(s?.scheduleSide || s?.side || '').toLowerCase();
            if (explicit === sideLc) return true;
            if (explicit === 'both') return true;
            // Fallback to role inference when scheduleSide isn't set
            // on the record — older staff docs from before the
            // schedule rebuild may not carry the field.
            const role = String(s?.role || '').toLowerCase();
            if (sideLc === 'foh') return /foh|front|server|cashier|host|bartender/.test(role);
            if (sideLc === 'boh') return /boh|kitchen|cook|prep|dish/.test(role);
            return false;
        };
        const locMatches = (s) => {
            if (!needLoc || needLoc === 'both') return true;
            const sLoc = String(s?.location || '').toLowerCase();
            if (!sLoc) return true; // unscoped staff get the broadcast too
            return sLoc === needLoc || sLoc === 'both';
        };
        const targets = (staffList || []).filter(s => {
            if (!s?.name) return false;
            if (s.name === staffName) return false; // skip the manager who created it
            if (!sideMatches(s)) return false;
            if (!locMatches(s)) return false;
            return true;
        });
        if (targets.length === 0) return;
        const dayLabel = need.date || 'shift';
        const range = `${need.startTime || '?'}–${need.endTime || '?'}`;
        const sideName = sideLc === 'boh' ? 'BOH' : 'FOH';
        try {
            // Bounded fan-out — small restaurants top out around
            // ~50 staff per side, so a plain loop is fine. Each
            // write is independent; one failure doesn't block the
            // rest because we await per-write and catch per-iteration.
            //
            // 2026-05-24 audit fix: was writing {en, es} OBJECTS to
            // notif.title/body directly. The dispatchNotification Cloud
            // Function reads `notif.title || "DD Mau"` and stuffs the
            // object into FCM's `data.title` — FCM rejects with
            // `messaging/invalid-argument` per token and the CF token-
            // pruner deletes every recipient's tokens. Likely cause of
            // "push isn't working for some staff" reports. Route through
            // notify() instead — it calls resolveText() per recipient.
            for (const t of targets) {
                await notify(t.name, 'shift_open',
                    {
                        en: `🙋 ${sideName} shift up for grabs · ${dayLabel} ${range}`,
                        es: `🙋 Turno ${sideName} disponible · ${dayLabel} ${range}`,
                    },
                    {
                        en: `Open in Schedule and tap "I want this" to add yourself to the pickup queue.`,
                        es: `Abre Horario y toca "Lo quiero" para apuntarte.`,
                    },
                    null,
                    // allowSelf: targets[] is already filtered to exclude
                    // the actor; setting allowSelf=true skips the redundant
                    // self-skip inside notify(). tagSuffix=need.id collapses
                    // OS notifications for the same up-for-grabs broadcast
                    // (retries land as one bell, not many).
                    { allowSelf: true, tagSuffix: need.id },
                );
            }
        } catch (e) {
            console.warn('broadcastUpForGrabs failed:', e);
        }
    };

    const handleAddNeed = async (need) => {
        if (!canEditSide(need?.side)) return;
        try {
            const docRef = await addDoc(collection(db, 'staffing_needs'), {
                ...need,
                filledStaff: [],
                filledShiftIds: [],
                createdBy: staffName,
                createdAt: serverTimestamp(),
            });
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'need_created', targetType: 'staffing_need', targetId: docRef.id,
                targetName: `${need.date || ''} ${need.side || ''} need`, after: { date: need.date, count: need.count, side: need.side } }).catch(() => {});
            setShowNeedModal(false);
            // Fan out the broadcast notification AFTER the doc is
            // committed. We don't await here because the notification
            // writes can take a second or two for a big team and we
            // want the modal to feel snappy — toasts confirm the
            // creation, the pushes land asynchronously.
            broadcastUpForGrabs({ id: docRef.id, ...need }).catch(() => {});
        } catch (e) {
            console.error('Add need failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    const handleRemoveNeed = async (needId) => {
        const need = staffingNeeds.find(n => n.id === needId);
        if (!canEditSide(need?.side)) return;
        if (!confirm(tx('Remove this staffing need? Shifts already filled will NOT be deleted.', '¿Quitar esta necesidad? Los turnos ya asignados NO se eliminarán.'))) return;
        try {
            await deleteDoc(doc(db, 'staffing_needs', needId));
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'need_removed', targetType: 'staffing_need', targetId: needId,
                targetName: need ? `${need.date || ''} ${need.side || ''} need` : 'need' }).catch(() => {});
        } catch (e) {
            console.error('Remove need failed:', e);
        }
    };

    // Edit an existing staffing need (start/end times, count, role group, notes).
    // Already-filled shifts are NOT retroactively retimed — managers can choose
    // to delete + re-fill if they want the changed times to apply to the live
    // shifts too.
    const handleEditNeed = async (need) => {
        if (!canEdit || !need?.id) return;
        try {
            const { id, ...data } = need;
            // Detect transition: false (or missing) → true on
            // openToAllStaff so we can fan-out the broadcast push
            // when a previously-private slot gets flipped to up-
            // for-grabs after the fact. Editing an already-open
            // slot doesn't re-spam — that would punish the manager
            // for fixing a typo.
            const prev = staffingNeeds.find(n => n.id === id);
            const wasOpen = !!prev?.openToAllStaff;
            const isOpenNow = !!data?.openToAllStaff;
            await updateDoc(doc(db, 'staffing_needs', id), {
                ...data,
                updatedAt: serverTimestamp(),
                updatedBy: staffName,
            });
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'need_edited', targetType: 'staffing_need', targetId: id,
                targetName: `${data.date || ''} ${data.side || ''} need`,
                before: prev ? { count: prev.count, openToAllStaff: wasOpen } : null,
                after: { count: data.count, openToAllStaff: isOpenNow } }).catch(() => {});
            setEditingNeed(null);
            if (!wasOpen && isOpenNow) {
                broadcastUpForGrabs({ id, ...data }).catch(() => {});
            }
        } catch (e) {
            console.error('Edit need failed:', e);
            toast(tx('Could not update slot: ', 'No se pudo actualizar el espacio: ') + e.message);
        }
    };

    // Fill one slot of a need: create a real shift for that staff member, then
    // append to the need's filledStaff[] + filledShiftIds[]. Used by the
    // AvailableStaffModal flow when fillingNeed is set.
    //
    // 2026-05-15 — Andrew: "when the slots are there and you press it opens
    // up the who can work. lets make it so we can add one or if there is 5
    // slots we can go through and add all 5 staff with out closing the
    // window." Previously this nulled out fillingNeed + availableForDate
    // after every successful fill, closing the modal. Now we KEEP THE
    // MODAL OPEN until the slot is fully staffed (or the manager closes
    // it manually). State is reconciled by:
    //   (a) updating fillingNeed locally with the new filledStaff so the
    //       progress chip + auto-close logic see the latest count without
    //       waiting for onSnapshot, and
    //   (b) the newly-created shift lands in `shifts` via onSnapshot,
    //       which makes the just-filled staffer's row in the modal flip
    //       to status='scheduled' (or hide if hasOverlap is true), so
    //       they can't accidentally be filled twice into the same slot.
    const fillNeedWithStaff = async (need, staffMember) => {
        if (!canEditSide(need?.side)) return;
        // 2026-05-15 — Andrew: "no you didnt fix it. when ... we have slots
        // available i can just click assign and when i do that it doesnt
        // show the warning. dont make me ask again."
        //
        // The previous post-create flashing modal pattern (still in use for
        // add/resize/move) depends on React state firing in the right
        // order. For the slot-fill path the chooser modal closes via
        // setFillSlotChooser(null) at the SAME tick as fillNeedWithStaff
        // starts running async — there's a window where the chooser is
        // unmounting and the flashing modal isn't yet mounted, and the
        // visual handoff can fail. Plus PWA cache aggressively serves old
        // bundles.
        //
        // BULLETPROOF fix: native confirm() PRE-create. Blocks the thread
        // until the manager decides. Cannot be hidden by any state race,
        // any z-index issue, any cache invalidation gap. If they Cancel,
        // we abort before addDoc — no shift is ever created. If they OK,
        // we proceed as before. No double-prompt because the post-create
        // flashing-modal block is removed from this path (added/resize/
        // move still use the flashing modal — they work).
        const preConflict = checkAvailabilityConflict(staffMember, need.date, need.startTime, need.endTime);
        if (preConflict) {
            const msg = preConflict.type === 'off'
                ? tx(
                    `⚠️ AVAILABILITY CONFLICT\n\n${staffMember.name} marked this day as UNAVAILABLE.\n\nSchedule anyway?`,
                    `⚠️ CONFLICTO DE DISPONIBILIDAD\n\n${staffMember.name} marcó este día como NO DISPONIBLE.\n\n¿Programar de todos modos?`
                )
                : tx(
                    `⚠️ AVAILABILITY CONFLICT\n\n${staffMember.name} is only available ${formatTime12h(preConflict.from)}–${formatTime12h(preConflict.to)} this day.\nShift is ${formatTime12h(need.startTime)}–${formatTime12h(need.endTime)}.\n\nSchedule anyway?`,
                    `⚠️ CONFLICTO DE DISPONIBILIDAD\n\n${staffMember.name} solo está disponible ${formatTime12h(preConflict.from)}–${formatTime12h(preConflict.to)} este día.\nEl turno es ${formatTime12h(need.startTime)}–${formatTime12h(need.endTime)}.\n\n¿Programar de todos modos?`
                );
            if (!confirm(msg)) return; // bail before any write
        }
        try {
            const shiftRef = await addDoc(collection(db, 'shifts'), {
                staffName: staffMember.name,
                date: need.date,
                startTime: need.startTime,
                endTime: need.endTime,
                location: need.location,
                // The slot's side determines the shift's side — even if it's
                // a cross-side fill (FOH staff working a BOH slot, etc.).
                side: need.side || resolveStaffSide(staffMember),
                isShiftLead: false,
                isDouble: false,
                notes: need.notes || tx('From staffing need', 'De necesidad de personal'),
                published: false, // draft — same convention as handleAddShift
                createdBy: staffName,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                fromNeedId: need.id,
            });
            // arrayUnion (audit 2026-05-22) — was a read-modify-write
            // (spread the local need.filledStaff). Two managers
            // filling the same slot at the same instant both read
            // ['A'], both wrote ['A','B'] / ['A','C'] — last-writer
            // wins, one fill silently lost. arrayUnion is atomic
            // server-side and merges both updates correctly.
            await updateDoc(doc(db, 'staffing_needs', need.id), {
                filledStaff: arrayUnion(staffMember.name),
                filledShiftIds: arrayUnion(shiftRef.id),
            });
            // Audit log — Andrew 2026-06-25 (shift created by filling an open slot).
            auditShiftChange({ shiftId: shiftRef.id, staffName: staffMember.name, action: 'created',
                after: { date: need.date, side: need.side }, reason: 'filled open slot' }).catch(() => {});
            // 2026-05-24 audit fix: these were referenced below as
            // undefined symbols — the function would always throw
            // ReferenceError after a successful fill, causing managers
            // to retry → duplicate shift creation. Compute them now
            // from the latest local snapshot of `need`.
            const newFilledStaff   = [...(need.filledStaff   || []), staffMember.name];
            const newFilledShiftIds = [...(need.filledShiftIds || []), shiftRef.id];
            // Auto-close when the slot reaches its target count — manager
            // is done. Otherwise keep modal open and bump fillingNeed
            // state so the progress chip reflects the new ratio.
            const isFullyStaffed = newFilledStaff.length >= (need.count || 0);
            if (isFullyStaffed) {
                setFillingNeed(null);
                setAvailableForDate(null);
                toast(tx(`✓ All ${need.count} slot${need.count === 1 ? '' : 's'} filled`,
                          `✓ ${need.count} espacio${need.count === 1 ? '' : 's'} llenado${need.count === 1 ? '' : 's'}`),
                      { kind: 'success', duration: 3000 });
            } else {
                setFillingNeed({ ...need, filledStaff: newFilledStaff, filledShiftIds: newFilledShiftIds });
                const remaining = (need.count || 0) - newFilledStaff.length;
                toast(tx(`✓ ${staffMember.name.split(' ')[0]} added · ${remaining} more to fill`,
                          `✓ ${staffMember.name.split(' ')[0]} agregado · ${remaining} más por llenar`),
                      { kind: 'success', duration: 2000 });
            }
            // (No post-create flashing-modal check on this path — the
            // pre-create confirm() above already gated the action. Adding
            // the post-create modal would double-prompt.)
        } catch (e) {
            console.error('Fill need failed:', e);
            toast(tx('Could not fill: ', 'No se pudo asignar: ') + e.message);
        }
    };

    const unfillNeedSlot = async (need, staffMemberName) => {
        if (!canEditSide(need?.side)) return;
        // Find the matching shift and delete it, then prune the need.
        const idx = (need.filledStaff || []).indexOf(staffMemberName);
        if (idx < 0) return;
        const shiftId = (need.filledShiftIds || [])[idx];
        // Step 1: delete the underlying shift. If this fails, ABORT — pruning
        // the need without removing the shift would orphan the shift in the
        // db with a stale fromNeedId pointing at a slot that no longer
        // tracks it. (Old behavior swallowed the failure silently.)
        if (shiftId) {
            try {
                await deleteDoc(doc(db, 'shifts', shiftId));
            } catch (e) {
                console.error('Unfill: shift delete failed, aborting prune', e);
                toast(tx(
                    'Could not delete the underlying shift. The slot was NOT updated. Try again or refresh.',
                    'No se pudo borrar el turno. El espacio NO se actualizó. Intenta de nuevo.'
                ));
                return;
            }
        }
        // Step 2: prune the need now that the shift is gone.
        try {
            const newFilled = (need.filledStaff || []).filter((_, i) => i !== idx);
            const newIds = (need.filledShiftIds || []).filter((_, i) => i !== idx);
            await updateDoc(doc(db, 'staffing_needs', need.id), {
                filledStaff: newFilled,
                filledShiftIds: newIds,
            });
        } catch (e) {
            console.error('Unfill: prune failed (shift already deleted)', e);
            toast(tx(
                'Shift was deleted but the slot count did not refresh. Try refreshing the page.',
                'El turno fue borrado pero el contador no se actualizó. Refresca la página.'
            ));
        }
    };

    // ── Up-for-grabs claims ────────────────────────────────────────────────
    // Staff click "I want this" on a broadcast staffing_need to add
    // themselves to the slot's `interestedClaims` array. Order is
    // first-come — manager sees the timestamps and picks who gets
    // the shift. Same staff can withdraw before the manager acts.
    //
    // Notification fans out to ALL managers + admins via a
    // /notifications doc (the existing dispatchNotification Cloud
    // Function handles FCM delivery from there). We don't loop in
    // the codebase looking for individual manager FCM tokens —
    // notifyStaff handles the lookup. Falls back gracefully if
    // the notify import isn't reachable (offline edits, etc.).
    const claimUpForGrabsShift = async (needId) => {
        const need = staffingNeeds.find(n => n.id === needId);
        if (!need) return;
        if (!staffName) return;
        // Already in queue? Withdraw instead — single button toggles
        // the membership so staff don't need a separate "remove me".
        const existing = Array.isArray(need.interestedClaims) ? need.interestedClaims : [];
        const alreadyIn = existing.some(c => c?.name === staffName);
        try {
            const ref = doc(db, 'staffing_needs', needId);
            if (alreadyIn) {
                await updateDoc(ref, {
                    interestedClaims: existing.filter(c => c?.name !== staffName),
                });
                toast(tx('Withdrew your interest.', 'Retiraste tu interés.'), { kind: 'info' });
            } else {
                // Append (don't overwrite) — atomic via arrayUnion
                // since we want at-most-once-per-staff but with
                // first-click-wins ordering. Read-then-write would
                // race; arrayUnion is safe because the wrapper
                // object includes the deterministic name field so
                // duplicates collapse server-side.
                const claim = {
                    name: staffName,
                    claimedAt: new Date().toISOString(),
                };
                await updateDoc(ref, {
                    interestedClaims: arrayUnion(claim),
                });
                toast(tx('Added — manager will pick from the queue.', 'Agregado — el gerente elegirá de la lista.'), { kind: 'success' });
                // Notify managers + admins of this location. We
                // write one notification doc; the Cloud Function
                // fans it out to each recipient's FCM tokens.
                try {
                    const dayLabel = need.date || 'shift';
                    const range = `${need.startTime || '?'}–${need.endTime || '?'}`;
                    const targets = (staffList || []).filter(s => {
                        if (!s?.name) return false;
                        if (isAdminId(s.id)) return true; // admins
                        if (s.role && /manager/i.test(s.role)) {
                            if (!need.location || need.location === 'both') return true;
                            return s.location === need.location || s.location === 'both';
                        }
                        return false;
                    });
                    // 2026-05-24 audit fix: was writing {en, es} OBJECTS as
                    // title/body — same bug as broadcastUpForGrabs (FCM
                    // rejects + Cloud Function prunes the recipient's
                    // tokens). Route through notify() so each manager
                    // gets text resolved to their preferredLanguage.
                    for (const t of targets) {
                        await notify(t.name, 'shift_grabbed',
                            {
                                en: `🙋 ${staffName} wants ${dayLabel} ${range}`,
                                es: `🙋 ${staffName} quiere ${dayLabel} ${range}`,
                            },
                            {
                                en: `Open ${(need.side || 'foh').toUpperCase()} slot — review pickup queue in Schedule.`,
                                es: `Espacio ${(need.side || 'foh').toUpperCase()} abierto — revisa la lista en Horario.`,
                            },
                            null,
                            { allowSelf: true, tagSuffix: needId },
                        );
                    }
                } catch (e) {
                    console.warn('claim notify failed (non-fatal):', e);
                }
            }
        } catch (e) {
            console.error('claimUpForGrabsShift failed:', e);
            toast(tx('Could not save your interest. Try again.', 'No se pudo guardar tu interés. Intenta de nuevo.'), { kind: 'error' });
        }
    };

    // Manager-side — clear the entire claim queue after picking
    // someone (or marking the slot filled). Called from the
    // queue panel below. Doesn't auto-fire when filling via the
    // existing Fill modal because the manager may want to keep
    // the queue visible for record-keeping; clearing is explicit.
    const clearUpForGrabsQueue = async (needId) => {
        try {
            await updateDoc(doc(db, 'staffing_needs', needId), {
                interestedClaims: [],
            });
        } catch (e) {
            console.error('clearUpForGrabsQueue failed:', e);
        }
    };

    // ── Day templates ──────────────────────────────────────────────────────
    // A template defines a named shape for a typical day, e.g.:
    //   "Friday FOH" → Morning block 9-3 (3 FOH + 1 Lead + 1 Mgr) + Night block 4-10 (5 FOH + 2 Lead + 1 Mgr)
    // Applying the template to a date creates one staffing_need per slot
    // (so each role gets its own fillable slot). Apply is non-destructive —
    // existing needs/shifts on that date are NOT touched.
    const handleSaveTemplate = async (tpl, applyDates) => {
        // Templates can target FOH, BOH, or both. Gate by the template's
        // target side; fall back to page side if template doesn't declare.
        if (!canEditSide(tpl?.side || side)) return;
        // FIX (2026-05-15, Andrew): support "Save & Apply" flow. When
        // applyDates is a non-empty array, we save the template AND
        // immediately materialize staffing_needs for each date — no
        // need to close the editor and re-open the Apply modal.
        try {
            let savedTpl = tpl;
            if (tpl.id) {
                const { id, ...data } = tpl;
                await updateDoc(doc(db, 'schedule_templates', id), {
                    ...data,
                    updatedAt: serverTimestamp(),
                    updatedBy: staffName,
                });
                savedTpl = { ...tpl };  // id retained
            } else {
                const newRef = await addDoc(collection(db, 'schedule_templates'), {
                    ...tpl,
                    createdAt: serverTimestamp(),
                    createdBy: staffName,
                });
                savedTpl = { ...tpl, id: newRef.id };
            }
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: tpl.id ? 'template_edited' : 'template_created', targetType: 'template',
                targetId: savedTpl.id || null, targetName: tpl.name || 'template' }).catch(() => {});
            setShowTemplateEditor(false);
            setEditingTemplate(null);
            // Now apply (after-save) so the template + the staffing
            // needs land in one user-perceived action.
            if (Array.isArray(applyDates) && applyDates.length > 0) {
                await handleApplyTemplate(savedTpl, applyDates);
            } else {
                toast(tx(`✅ Template "${tpl.name}" saved.`, `✅ Plantilla "${tpl.name}" guardada.`));
            }
        } catch (e) {
            console.error('Save template failed:', e);
            toast(tx('Could not save template: ', 'No se pudo guardar la plantilla: ') + e.message);
        }
    };

    const handleDeleteTemplate = async (id) => {
        const tpl = scheduleTemplates.find(t => t.id === id);
        if (!canEditSide(tpl?.side || side)) return;
        if (!confirm(tx('Delete this template? Already-applied needs will NOT be removed.', '¿Eliminar esta plantilla? Las necesidades ya aplicadas NO se quitarán.'))) return;
        try {
            await deleteDoc(doc(db, 'schedule_templates', id));
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'template_deleted', targetType: 'template', targetId: id,
                targetName: tpl?.name || 'template' }).catch(() => {});
        } catch (e) {
            console.error('Delete template failed:', e);
        }
    };

    const handleApplyTemplate = async (tpl, dateOrDates) => {
        if (!canEditSide(tpl?.side || side)) return;
        if (!tpl || !dateOrDates) return;
        // FIX (2026-05-14): accept either a single date string (legacy
        // single-day call) OR an array of date strings (new multi-day
        // flow). Normalize to array.
        const dateStrs = Array.isArray(dateOrDates) ? dateOrDates : [dateOrDates];
        if (dateStrs.length === 0) return;
        const location = tpl.location || (storeLocation !== 'both' ? storeLocation : 'webster');
        const successes = [];
        const failures = [];
        try {
            // Batched per-day (audit 2026-05-22). Previously a triple-
            // nested sequential addDoc loop (dates × blocks × slots)
            // made applying a 7-day template with 4 blocks of 3 slots
            // each take ~10s of dead time. Now per day = one batch.
            // Outer loop is per-date so a failure on one day doesn't
            // block other days — we collect failures and toast a
            // partial-success summary at the end.
            for (const dateStr of dateStrs) {
                try {
                    const toCreate = [];
                    for (const block of (tpl.blocks || [])) {
                        for (const slot of (block.slots || [])) {
                            if (!slot.count || slot.count <= 0) continue;
                            toCreate.push({
                                date: dateStr,
                                side: tpl.side || 'foh',
                                location,
                                startTime: block.startTime,
                                endTime: block.endTime,
                                count: slot.count,
                                roleGroup: slot.roleGroup || 'any',
                                notes: block.label ? `${tpl.name} · ${block.label}` : tpl.name,
                                filledStaff: [],
                                filledShiftIds: [],
                                fromTemplateId: tpl.id,
                                createdBy: staffName,
                                createdAt: serverTimestamp(),
                            });
                        }
                    }
                    if (toCreate.length > 0) {
                        const batch = writeBatch(db);
                        for (const n of toCreate) {
                            batch.set(doc(collection(db, 'staffing_needs')), n);
                        }
                        await batch.commit();
                    }
                    successes.push(dateStr);
                } catch (perDateErr) {
                    console.error('Apply template per-date failed:', dateStr, perDateErr);
                    failures.push(dateStr);
                }
            }
            setShowApplyTemplate(false);
            // Audit log (roll-up) — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'template_applied', targetType: 'template', targetId: tpl.id || null,
                targetName: tpl.name || 'template', after: { days: successes.length, failed: failures.length } }).catch(() => {});
            if (failures.length === 0) {
                const label = dateStrs.length === 1 ? dateStrs[0] : `${dateStrs.length} ${tx('days', 'días')}`;
                toast(tx(`✅ Applied "${tpl.name}" to ${label}.`, `✅ "${tpl.name}" aplicada a ${label}.`));
            } else if (successes.length === 0) {
                toast(tx(`Apply error — no days were updated.`, `Error — no se aplicó a ningún día.`), { kind: 'error' });
            } else {
                toast(tx(
                    `✅ Applied to ${successes.length} day(s). ${failures.length} failed.`,
                    `✅ Aplicada a ${successes.length} día(s). ${failures.length} fallaron.`
                ), { kind: 'warn' });
            }
        } catch (e) {
            console.error('Apply template failed:', e);
            toast(tx('Apply error: ', 'Error al aplicar: ') + e.message);
        }
    };

    // ── Recurring shifts ───────────────────────────────────────────────────
    // A recurring rule: "Maria works Mon/Wed 9-3 every week, valid from
    // 2026-05-12 onward (no end date)." We store rules separately and generate
    // real shifts on-demand via the "Generate this week" button.
    const handleSaveRecurring = async (rule) => {
        // A recurring rule pins a staff member to a weekly shift. The
        // staff's scheduleSide drives which editor toggle is required.
        const ruleSide = rule?.side || (() => {
            const s = staffList?.find(x => x.name === rule?.staffName);
            return s?.scheduleSide || side;
        })();
        if (!canEditSide(ruleSide)) return;
        try {
            if (rule.id) {
                const { id, ...data } = rule;
                await updateDoc(doc(db, 'recurring_shifts', id), { ...data, updatedAt: serverTimestamp(), updatedBy: staffName });
            } else {
                await addDoc(collection(db, 'recurring_shifts'), { ...rule, createdAt: serverTimestamp(), createdBy: staffName });
            }
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: rule.id ? 'recurring_edited' : 'recurring_created', targetType: 'recurring_rule',
                targetId: rule.id || null, targetName: rule.staffName ? `${rule.staffName} recurring` : 'recurring rule',
                after: { staffName: rule.staffName, startTime: rule.startTime, endTime: rule.endTime } }).catch(() => {});
        } catch (e) {
            console.error('Save recurring failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    const handleDeleteRecurring = async (id) => {
        const rule = recurringShifts.find(r => r.id === id);
        const ruleSide = rule?.side || (() => {
            const s = staffList?.find(x => x.name === rule?.staffName);
            return s?.scheduleSide || side;
        })();
        if (!canEditSide(ruleSide)) return;
        if (!confirm(tx('Delete this recurring rule? Already-generated shifts stay.', '¿Eliminar esta regla? Los turnos ya generados se quedan.'))) return;
        try {
            await deleteDoc(doc(db, 'recurring_shifts', id));
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'recurring_deleted', targetType: 'recurring_rule', targetId: id,
                targetName: rule?.staffName ? `${rule.staffName} recurring` : 'recurring rule' }).catch(() => {});
        } catch (e) {
            console.error('Delete recurring failed:', e);
        }
    };

    // Generate shifts for the current week from all active recurring rules.
    // Skips: closed dates, approved PTO for the staff, days outside validFrom/validUntil,
    // and dates where the staff already has a shift in the same time block (no double-book).
    // Generated shifts are DRAFT (published=false) so manager reviews + publishes.
    const handleGenerateRecurring = async () => {
        if (!canEdit) return;
        const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        const created = [];
        const skipped = [];
        // Audit 2026-05-22: accumulate new shifts here and writeBatch
        // them at the end of the rule loop. Previously each shift was
        // a sequential `await addDoc`, making a 10-rule × 7-day pass
        // take ~10s of dead time.
        const recurringBatchShifts = [];
        for (const rule of recurringShifts) {
            if (!rule.staffName || !rule.startTime || !rule.endTime) continue;
            // Skip rules for sides the runner can't edit — a FOH-only
            // editor running Generate should produce FOH shifts only.
            const ruleStaff = staffList?.find(x => x.name === rule.staffName);
            const ruleSide = rule.side || ruleStaff?.scheduleSide || side;
            if (!canEditSide(ruleSide)) {
                skipped.push(`${rule.staffName}: ${tx('no editor access for this side', 'sin acceso de editor para este lado')}`);
                continue;
            }
            // Bi-weekly cadence: anchor off the rule's validFrom week. The rule
            // is active only on weeks where (weeksSinceAnchor % 2) === 0.
            // If validFrom is empty, REJECT — without an anchor the rule
            // would silently fire every week (the old bug). Skip these and
            // surface a message asking the manager to set validFrom.
            if (rule.cadence === 'biweekly') {
                const anchorDate = parseLocalDate(rule.validFrom);
                if (!anchorDate) {
                    skipped.push(`${rule.staffName}: bi-weekly rule has no Valid From date — set one to anchor`);
                    continue;
                }
                const anchorWeek = startOfWeek(anchorDate);
                const diffMs = weekStart.getTime() - anchorWeek.getTime();
                // FIX (review 2026-05-22): Math.floor on raw ms is off by one
                // across DST. anchorWeek and weekStart are both local-midnight
                // (startOfWeek) dates, so a DST transition between them makes
                // diffMs equal N*168h ± 1h; Math.floor((N*168h - 1h)/168h)
                // returns N-1 and flips the even/odd parity, so a bi-weekly
                // rule generates on the wrong week. The delta is always within
                // ±1h of a whole number of weeks, so round() recovers the
                // correct week count DST-safely.
                const weeksSince = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
                if (weeksSince < 0 || (weeksSince % 2) !== 0) {
                    skipped.push(`${rule.staffName}: bi-weekly off-week`);
                    continue;
                }
            }
            const days = rule.daysOfWeek || [];
            for (let i = 0; i < 7; i++) {
                const date = addDays(weekStart, i);
                const dStr = toDateStr(date);
                const dow = dayKeys[date.getDay()];
                if (!days.includes(dow)) continue;
                if (rule.validFrom && dStr < rule.validFrom) continue;
                if (rule.validUntil && dStr > rule.validUntil) continue;
                if (dateClosed(dStr, rule.location)) { skipped.push(`${rule.staffName} ${dStr}: closed`); continue; }
                if (isStaffOffOn(rule.staffName, dStr)) { skipped.push(`${rule.staffName} ${dStr}: PTO`); continue; }
                // Don't double-book: any existing shift overlapping this time block
                const conflict = shifts.some(sh =>
                    sh.staffName === rule.staffName && sh.date === dStr &&
                    !(sh.endTime <= rule.startTime || sh.startTime >= rule.endTime));
                if (conflict) { skipped.push(`${rule.staffName} ${dStr}: existing shift`); continue; }
                // Collect into the outer batch instead of awaiting per
                // shift (audit 2026-05-22) — same pattern as auto-fill.
                recurringBatchShifts.push({
                    staffName: rule.staffName,
                    date: dStr,
                    startTime: rule.startTime,
                    endTime: rule.endTime,
                    location: rule.location || (storeLocation !== 'both' ? storeLocation : 'webster'),
                    isShiftLead: !!rule.isShiftLead,
                    isDouble: !!rule.isDouble,
                    notes: tx('Recurring', 'Recurrente'),
                    published: false,
                    fromRecurringId: rule.id,
                    createdBy: staffName,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
                created.push(`${rule.staffName} ${dStr} ${rule.startTime}–${rule.endTime}`);
            }
        }
        // Commit all the recurring shifts in batches of 400.
        try {
            const BATCH_LIMIT = 400;
            for (let i = 0; i < recurringBatchShifts.length; i += BATCH_LIMIT) {
                const batch = writeBatch(db);
                for (const sh of recurringBatchShifts.slice(i, i + BATCH_LIMIT)) {
                    batch.set(doc(collection(db, 'shifts')), sh);
                }
                await batch.commit();
            }
        } catch (e) { console.error('Recurring shift batch failed:', e); }
        // Audit log (roll-up) — Andrew 2026-06-25.
        if (created.length > 0) auditScheduleConfig({ action: 'recurring_generated', targetType: 'shift',
            targetName: 'recurring → shifts', after: { generated: created.length, skipped: skipped.length } }).catch(() => {});
        if (created.length === 0) {
            toast(tx(`No shifts generated.${skipped.length ? '\n\nSkipped:\n' + skipped.slice(0, 8).join('\n') : ''}`,
                `No se generaron turnos.${skipped.length ? '\n\nOmitidos:\n' + skipped.slice(0, 8).join('\n') : ''}`));
        } else {
            toast(tx(`✅ Generated ${created.length} draft shifts.${skipped.length ? `\n\nSkipped ${skipped.length}.` : ''}`,
                `✅ Se generaron ${created.length} turnos borrador.${skipped.length ? `\n\nOmitidos ${skipped.length}.` : ''}`));
        }
    };

    // ── Date blocks (closed days / no-time-off days) ───────────────────────
    // 2026-05-27 — Andrew: "blackout dates i want to be able to select
    // more than one day at a time or choose more than one closure days
    // at a time." Accept either a single block or an array of blocks
    // from BlackoutsModal — the modal now collects a date range (From
    // / To) and passes one block per day in the range. Promise.all
    // writes them in parallel so a 14-day vacation submission completes
    // in one round-trip rather than 14 sequential.
    const handleAddBlock = async (blockOrBlocks) => {
        if (!staffIsAdmin) return; // admin-only — see staffIsAdmin comment
        const list = Array.isArray(blockOrBlocks) ? blockOrBlocks : [blockOrBlocks];
        if (list.length === 0) return;
        try {
            await Promise.all(list.map(block => addDoc(collection(db, 'date_blocks'), {
                ...block,
                createdBy: staffName,
                createdAt: serverTimestamp(),
            })));
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: list.length > 1 ? 'blackout_added_bulk' : 'blackout_added', targetType: 'date_block',
                targetName: list.length > 1 ? `${list.length} days` : (list[0]?.date || 'blackout'),
                after: { days: list.length, type: list[0]?.type || 'closed', dates: list.slice(0, 25).map(b => b.date) } }).catch(() => {});
            setShowBlockModal(false);
            if (list.length > 1) {
                toast(tx(`✅ Added ${list.length} blackout days.`, `✅ Se agregaron ${list.length} días de cierre.`));
            }
        } catch (e) {
            console.error('Add block failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    const handleRemoveBlock = async (blockId) => {
        if (!staffIsAdmin) return; // admin-only
        if (!confirm(tx('Remove this date block?', '¿Quitar este bloqueo?'))) return;
        try {
            await deleteDoc(doc(db, 'date_blocks', blockId));
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'blackout_removed', targetType: 'date_block', targetId: blockId }).catch(() => {});
        } catch (e) {
            console.error('Remove block failed:', e);
        }
    };

    // 2026-05-16 — toggle a specific date open/closed, respecting the
    // resolution order in dateClosed():
    //   - Currently OPEN via override → remove the override (returns to
    //     recurring closed).
    //   - Currently CLOSED via recurring rule → add open_override block.
    //   - Currently CLOSED via one-off block → delete that block.
    //   - Currently OPEN normally → no-op (caller shouldn't have offered
    //     a toggle; defensive return).
    const handleToggleDateOpen = async (dateStr) => {
        if (!staffIsAdmin) return; // admin-only
        const blocks = blocksByDate.get(dateStr) || [];
        const existingOverride = blocks.find(b => b.type === 'open_override');
        const existingClosedBlock = blocks.find(b => b.type === 'closed');
        try {
            if (existingOverride) {
                // Was overridden open → remove override, falls back to
                // recurring-closed (or fully open if no recurring rule).
                await deleteDoc(doc(db, 'date_blocks', existingOverride.id));
                auditScheduleConfig({ action: 'date_toggled', targetType: 'date', targetName: dateStr, reason: 'removed open-override (back to closed)' }).catch(() => {});
                return;
            }
            if (existingClosedBlock) {
                // One-off closure → just delete the block.
                await deleteDoc(doc(db, 'date_blocks', existingClosedBlock.id));
                auditScheduleConfig({ action: 'date_toggled', targetType: 'date', targetName: dateStr, reason: 'removed closure (opened)' }).catch(() => {});
                return;
            }
            if (dateClosedByRecurring(dateStr)) {
                // Recurring rule closes this date → add override.
                await addDoc(collection(db, 'date_blocks'), {
                    date: dateStr,
                    type: 'open_override',
                    location: 'both',
                    reason: tx('Open this day (one-off)', 'Abrir este día (puntual)'),
                    createdBy: staffName,
                    createdAt: serverTimestamp(),
                });
                auditScheduleConfig({ action: 'date_toggled', targetType: 'date', targetName: dateStr, reason: 'added open-override (one-off open)' }).catch(() => {});
                return;
            }
            // Already open normally — nothing to do.
        } catch (e) {
            console.error('Toggle date open failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    // 2026-05-16 — calendar event CRUD. Lightweight per-date label.
    const handleAddCalendarEvent = async (evt) => {
        if (!staffIsAdmin) return; // admin-only
        try {
            await addDoc(collection(db, 'calendar_events'), {
                date: evt.date,
                label: evt.label || '',
                type: evt.type || 'event',
                emoji: evt.emoji || '',
                createdBy: staffName,
                createdAt: serverTimestamp(),
            });
        } catch (e) {
            console.error('Add event failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };
    const handleRemoveCalendarEvent = async (id) => {
        if (!staffIsAdmin) return; // admin-only
        try { await deleteDoc(doc(db, 'calendar_events', id)); }
        catch (e) { console.error('Remove event failed:', e); }
    };

    // 2026-05-16 — toggle a single (location, dayOfWeek) on/off in the
    // recurring closure config. Uses setDoc with merge so the doc is
    // created on first toggle and a per-location array is updated
    // without clobbering siblings. Optimistic via the live snapshot.
    const handleToggleClosedWeekday = async (loc, dayOfWeek) => {
        if (!staffIsAdmin) return; // admin-only
        const cw = scheduleSettings?.closedWeekdays || {};
        const cur = Array.isArray(cw[loc]) ? cw[loc] : [];
        const next = cur.includes(dayOfWeek)
            ? cur.filter(d => d !== dayOfWeek)
            : [...cur, dayOfWeek].sort();
        try {
            await setDoc(doc(db, 'config', 'schedule_settings'), {
                closedWeekdays: { ...cw, [loc]: next },
                updatedAt: serverTimestamp(),
                updatedBy: staffName,
            }, { merge: true });
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'weekly_closure_toggled', targetType: 'config',
                targetName: `${loc} ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek] || dayOfWeek}`,
                before: { closedDays: cur }, after: { closedDays: next } }).catch(() => {});
        } catch (e) {
            console.error('Toggle weekly closure failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    // ── Editable quick-add shift presets (Andrew 2026-06-17) ──
    // The one-tap hour chips (10–3, 3–8, …) are now manager-editable and stored
    // in config/schedule_settings.shiftPresets. Falls back to the built-in
    // defaults whenever a side has no saved list, so the popup is never empty.
    const effectiveShiftPresets = useMemo(() => ({
        foh: sanitizeShiftPresets(scheduleSettings?.shiftPresets?.foh, SHIFT_PRESETS_FOH),
        boh: sanitizeShiftPresets(scheduleSettings?.shiftPresets?.boh, SHIFT_PRESETS_BOH),
    }), [scheduleSettings]);
    const handleSaveShiftPresets = async (presets) => {
        if (!canEdit) return;
        try {
            await setDoc(doc(db, 'config', 'schedule_settings'), {
                shiftPresets: {
                    foh: sanitizeShiftPresets(presets?.foh, SHIFT_PRESETS_FOH),
                    boh: sanitizeShiftPresets(presets?.boh, SHIFT_PRESETS_BOH),
                },
                updatedAt: serverTimestamp(),
                updatedBy: staffName,
            }, { merge: true });
            // Audit log — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'presets_saved', targetType: 'config', targetName: 'shift hour presets' }).catch(() => {});
            setShowPresetEditor(false);
            toast(tx('✓ Shift hours saved', '✓ Horas guardadas'), { kind: 'success' });
        } catch (e) {
            console.error('Save shift presets failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };
    const onEditPresetsCb = useStableCallback(() => setShowPresetEditor(true));

    // ── Time-off (Phase 2: admin-entered) ──
    const handleAddTimeOff = async (entry) => {
        if (!canEdit) return;
        try {
            const ref = await addDoc(collection(db, 'time_off'), {
                ...entry,
                status: 'approved', // admin-entered = pre-approved
                createdBy: staffName,
                createdAt: serverTimestamp(),
            });
            auditPtoChange({
                entryId: ref.id, staffName: entry.staffName, action: 'created',
                after: { status: 'approved', startDate: entry.startDate, endDate: entry.endDate || entry.startDate },
                reason: entry.reason, surface: 'admin-dashboard',
            });
            setShowTimeOffModal(false);
        } catch (e) {
            console.error('Add time-off failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    // 2026-06-10 reversibility pass: delete is now a first-class manager
    // action (🗑 chips in TimeOffModal / PtoView / PtoDetailsModal), so it
    // behaves like its siblings — glass ConfirmModal via askRemoveTimeOff
    // (the old native confirm() here is gone: iOS Safari can dismiss it on
    // a background tap mid-decision), staff notification when a live entry
    // vanishes, and a loud toast on failure instead of a silent
    // console.error. Accepts the full entry (preferred) or a bare id
    // (legacy callers — no notification possible without the entry).
    const handleRemoveTimeOff = async (entry) => {
        if (!canEdit) return;
        const id = typeof entry === 'string' ? entry : entry?.id;
        if (!id) return;
        const entryObj = typeof entry === 'object' ? entry : null;
        try {
            await deleteDoc(doc(db, 'time_off', id));
            auditPtoChange({
                entryId: id, staffName: entryObj?.staffName, action: 'deleted',
                before: entryObj ? { status: entryObj.status || 'approved', startDate: entryObj.startDate || entryObj.date, endDate: entryObj.endDate || entryObj.startDate || entryObj.date } : null,
                surface: 'admin-dashboard',
            });
            // Deleting an approved/pending entry changes someone's plans —
            // ping them. Denied entries vanish silently (nothing changes
            // for the staff member). Locked-on type so it can't be muted.
            if (typeof entry === 'object' && entry.staffName && entry.staffName !== staffName && (entry.status || 'approved') !== 'denied') {
                const range = (entry.startDate || entry.date) + (entry.endDate && entry.endDate !== entry.startDate ? ` → ${entry.endDate}` : '');
                notify(entry.staffName, 'pto_denied',
                    { en: 'Time-off entry removed', es: 'Tiempo libre eliminado' },
                    { en: `Your time-off entry for ${range} was removed by ${staffName}. Talk to a manager if this is a problem.`,
                      es: `Tu tiempo libre del ${range} fue eliminado por ${staffName}. Habla con un gerente si es un problema.` }
                ).catch(() => {});
            }
            toast(tx('✓ Removed', '✓ Eliminado'), { kind: 'success', duration: 2000 });
        } catch (e) {
            console.error('Remove time-off failed:', e);
            toast(tx('Could not remove: ', 'No se pudo eliminar: ') + (e.message || 'unknown'), { kind: 'error' });
        }
    };

    // ── Staff cancels / withdraws / dismisses THEIR OWN PTO request ──
    // 2026-05-15 — Andrew (testing as Cash): "i logged in as cash and tried
    // to do a time off request. i had no way to delete my request."
    //
    // Three flows based on current status:
    //   • pending  → Cancel — silent delete, manager queue cleans up
    //   • approved → Withdraw — confirm + notify admins so they know
    //                coverage is back (the restaurant gets a shift it
    //                can now re-fill — operationally a win, not a loss)
    //   • denied   → Dismiss — silent delete, just hides the row
    //
    // Permission gate: must be the OWNER of the request. Defensive
    // check even though the UI only shows this on entries where
    // staffName === current user — covers the case where someone
    // tampers with state.
    const handleCancelOwnPto = async (entry) => {
        if (!entry?.id) return;
        if (entry.staffName !== staffName) return; // not yours
        const status = entry.status || 'pending';
        // 2026-05-30 — internal native confirm() removed. The SwapPanels
        // callsite now wraps this in askCancelOwnPto which routes through
        // the glass ConfirmModal with status-aware copy. Defense for any
        // future direct callers: this is a deleteDoc, so callers must
        // already know what they're doing.
        try {
            await deleteDoc(doc(db, 'time_off', entry.id));
            auditPtoChange({
                entryId: entry.id, staffName: entry.staffName, action: 'deleted',
                before: { status, startDate: entry.startDate || entry.date, endDate: entry.endDate || entry.startDate || entry.date },
                reason: 'staff withdrew own request', surface: 'self-serve',
            });
            // Approved withdraws notify admins. Pending cancels stay
            // silent — the original "pto_request" notification's tag
            // (pto_request:<id>) collapses naturally when clicked since
            // the doc is gone.
            if (status === 'approved') {
                try {
                    const dates = entry.startDate === entry.endDate
                        ? entry.startDate
                        : `${entry.startDate} → ${entry.endDate || entry.startDate}`;
                    await notifyManagement({
                        type: 'pto_withdrawn',
                        title: { en: `↩ PTO withdrawn: ${staffName}`,
                                 es: `↩ Tiempo libre retirado: ${staffName}` },
                        body: { en: `${dates}${entry.reason ? ` · ${entry.reason}` : ''} · they can now be scheduled`,
                                es: `${dates}${entry.reason ? ` · ${entry.reason}` : ''} · ya pueden ser programados` },
                        link: '/schedule',
                        deepLink: 'schedule',
                        tag: `pto_withdrawn:${entry.id}`,
                        createdBy: staffName || 'staff',
                        excludeStaff: staffName,  // withdrawer doesn't need a bell for their own action
                    });
                } catch (e) { console.warn('PTO withdraw notify failed:', e); }
                toast(tx('↩ Withdrew your time-off. Manager has been notified.',
                          '↩ Retiraste tu tiempo libre. El gerente fue notificado.'),
                      { kind: 'success', duration: 4000 });
            } else if (status === 'pending') {
                toast(tx('Request canceled', 'Solicitud cancelada'), { kind: 'success', duration: 2500 });
            } else {
                // denied — silent dismiss; no toast needed
            }
        } catch (e) {
            console.error('Cancel own PTO failed:', e);
            toast(tx('Could not cancel — try again.', 'No se pudo cancelar — intenta de nuevo.'), { kind: 'error' });
        }
    };

    // ── Phase 3: staff submits a PTO request (status='pending') ──
    // Validates against no-PTO blackout dates before submitting.
    const handleSubmitPtoRequest = async (entry) => {
        // Check every date in range against no_timeoff blackouts
        const start = entry.startDate;
        const end = entry.endDate || entry.startDate;
        // 2026-06-16 (#9): belt-and-suspenders. Both PTO UIs already disable
        // submit when end<start, but guard the handler too — an inverted range
        // would silently protect ZERO days (isStaffOffOn needs start<=end), so
        // the staffer thinks they're off while the schedule still books them.
        {
            const _s = parseLocalDate(start), _e = parseLocalDate(end);
            if (_s && _e && _e < _s) {
                toast(tx('End date must be on or after the start date.', 'La fecha final debe ser igual o posterior a la inicial.'));
                return;
            }
        }
        const blockedDates = [];
        const startD = parseLocalDate(start);
        const endD = parseLocalDate(end);
        if (startD && endD) {
            // Iterate by day-count using addDays() rather than mutating a
            // Date in-place. d.setDate() across DST transitions can either
            // skip a day (spring forward) or get stuck (fall back), and the
            // mutation interacts badly with parseLocalDate's noon anchor.
            const startStr = toDateStr(startD);
            const endStr = toDateStr(endD);
            // Cap at ~120 iterations to defend against absurd ranges /
            // misformatted inputs causing an unbounded loop.
            for (let i = 0; i < 120; i++) {
                const d = addDays(startD, i);
                const dStr = toDateStr(d);
                if (dStr > endStr) break;
                if (dStr < startStr) continue;
                const dayBlocks = (blocksByDate.get(dStr) || []);
                if (dayBlocks.some(b => b.type === 'no_timeoff' || b.type === 'closed')) {
                    blockedDates.push(`${dStr} (${dayBlocks.find(b => b.type === 'no_timeoff' || b.type === 'closed').reason || 'blocked'})`);
                }
            }
        }
        if (blockedDates.length > 0) {
            toast(tx(
                `🛑 Time-off cannot be requested for these dates:\n${blockedDates.join('\n')}\n\nPlease pick different dates.`,
                `🛑 No se puede pedir tiempo libre para estas fechas:\n${blockedDates.join('\n')}\n\nPor favor elige otras fechas.`,
            ));
            return;
        }
        try {
            const ref = await addDoc(collection(db, 'time_off'), {
                ...entry,
                staffName, // always the submitter for self-serve
                status: 'pending',
                submittedBy: staffName,
                submittedAt: serverTimestamp(),
                createdAt: serverTimestamp(),
            });
            auditPtoChange({
                entryId: ref.id, staffName, action: 'created',
                after: { status: 'pending', startDate: entry.startDate, endDate: entry.endDate || entry.startDate },
                reason: entry.reason, surface: 'self-serve',
            });
            setShowPtoRequestModal(false);
            toast(tx('✅ Request submitted. A manager will review it.', '✅ Solicitud enviada. Un gerente la revisará.'));
            // Ping admins so they actually know to go review it. Tag
            // includes the request doc id so a resubmit (which would
            // be a new doc) gets its own slot; same-request retries
            // collapse via tag.
            try {
                const win = ptoWindowLabel(entry);
                const dates = (entry.startDate === entry.endDate
                    ? entry.startDate
                    : `${entry.startDate} → ${entry.endDate}`) + (win ? ` · ⛔ ${win}` : '');
                await notifyManagement({
                    type: 'pto_request',
                    title: { en: `🌴 PTO request: ${staffName}`,
                             es: `🌴 Solicitud de tiempo libre: ${staffName}` },
                    body: { en: `${dates}${entry.reason ? ` · ${entry.reason}` : ''}`,
                            es: `${dates}${entry.reason ? ` · ${entry.reason}` : ''}` },
                    link: '/schedule',
                    deepLink: 'schedule',
                    tag: `pto_request:${ref.id}`,
                    createdBy: staffName || 'staff',
                    excludeStaff: staffName,  // requester doesn't need a bell for their own request
                });
            } catch (e) { console.warn('PTO admin notify failed:', e); }
        } catch (e) {
            console.error('Submit PTO failed:', e);
            toast(tx('Could not submit: ', 'No se pudo enviar: ') + e.message);
        }
    };

    // Manager approves / denies a pending PTO request
    const handleApprovePto = async (entry) => {
        if (!canEdit) return;
        // 2026-05-30 — internal native confirm() removed. The SwapPanels
        // callsite wraps this in askApprovePto, which computes conflicts
        // and renders them in the glass ConfirmModal body. Trust the
        // caller: by the time this runs, the manager has acknowledged.
        try {
            // 2026-05-24 audit fix: was a bare updateDoc with no
            // current-status check. Two managers tapping Approve on the
            // same pending request within ms of each other both wrote
            // approved + both fired the notification + both fired the
            // mgmt rollup → staff got 2 pings, mgmt got 2 mirror
            // notifs. runTransaction reads-and-acts atomically: if the
            // entry is already past 'pending' we no-op with a toast.
            await runTransaction(db, async (txn) => {
                const ref = doc(db, 'time_off', entry.id);
                const snap = await txn.get(ref);
                if (!snap.exists()) {
                    throw new Error(tx_msg(
                        'PTO request no longer exists',
                        'La solicitud de tiempo libre ya no existe',
                    ));
                }
                const live = snap.data() || {};
                if (live.status !== 'pending') {
                    const reviewer = live.reviewedBy || 'someone';
                    throw new Error(tx_msg(
                        `Already ${live.status} by ${reviewer}`,
                        `Ya fue ${live.status === 'approved' ? 'aprobado' : 'negado'} por ${reviewer}`,
                    ));
                }
                txn.update(ref, {
                    status: 'approved',
                    reviewedBy: staffName,
                    reviewedAt: serverTimestamp(),
                });
            });
            // Was `start + (end !== start ? …)` — neither identifier exists in
            // this scope (they live in handleSubmitPtoRequest), so every approve
            // threw a ReferenceError HERE, after the transaction committed: PTO
            // saved as approved, but the staff notify below never fired and the
            // manager saw a false "Could not approve" toast. Same expression as
            // handleDenyPto. Audit 2026-06-09.
            auditPtoChange({
                entryId: entry.id, staffName: entry.staffName, action: 'approved',
                before: { status: 'pending' }, after: { status: 'approved' },
                surface: 'admin-dashboard',
            });
            const range = entry.startDate + (entry.endDate && entry.endDate !== entry.startDate ? ` → ${entry.endDate}` : '');
            await notify(entry.staffName, 'pto_approved',
                { en: 'Time-off approved', es: 'Tiempo libre aprobado' },
                { en: `Your time-off for ${range} was approved.`,
                  es: `Tu tiempo libre del ${range} fue aprobado.` });
            // Ping the rest of management so they all see PTO decisions
            // in one place. Includes the approver so they get a bell
            // record of what they just decided (no excludeStaff).
            notifyManagement({
                type: 'pto_approved',
                title: { en: `✅ PTO approved: ${entry.staffName}`,
                         es: `✅ PTO aprobado: ${entry.staffName}` },
                body: { en: `${range} · by ${staffName}`,
                        es: `${range} · por ${staffName}` },
                link: '/schedule',
                deepLink: 'schedule',
                tag: `pto_approved_mgmt:${entry.id}`,
                createdBy: staffName,
            }).catch(() => {});
        } catch (e) {
            console.error('Approve PTO failed:', e);
            toast(tx('Could not approve: ', 'No se pudo aprobar: ') + (e.message || 'unknown'));
        }
    };
    // ── PTO reversals — change an already-decided request ──
    // Andrew 2026-06-10: "the timeoff request need to be reversible... either
    // change it to deny or delete it all together or send it back to pending."
    // First decisions on PENDING requests stay on handleApprovePto/handleDenyPto
    // (queue-tuned copy + idempotency); this handles every OTHER transition and
    // tells the staff member their time-off CHANGED — they may have already
    // made plans on the old answer.
    const handleChangePtoStatus = async (entry, newStatus) => {
        if (!canEdit) return;
        if (!entry?.id || !['pending', 'approved', 'denied'].includes(newStatus)) return;
        const fromStatus = entry.status || 'pending';
        if (fromStatus === newStatus) return;
        try {
            await runTransaction(db, async (txn) => {
                const ref = doc(db, 'time_off', entry.id);
                const snap = await txn.get(ref);
                if (!snap.exists()) {
                    throw new Error(tx_msg(
                        'This request no longer exists',
                        'La solicitud ya no existe',
                    ));
                }
                const live = snap.data() || {};
                // Guard against a concurrent manager: only flip from the
                // status THIS manager was looking at when they clicked.
                if ((live.status || 'pending') !== fromStatus) {
                    const liveEs = live.status === 'approved' ? 'aprobada' : live.status === 'denied' ? 'negada' : 'pendiente';
                    throw new Error(tx_msg(
                        `Request is now "${live.status}" (changed by ${live.reviewedBy || 'someone'}) — review it again`,
                        `La solicitud ahora está "${liveEs}" (cambiada por ${live.reviewedBy || 'alguien'}) — revísala de nuevo`,
                    ));
                }
                if (newStatus === 'pending') {
                    txn.update(ref, {
                        status: 'pending',
                        // Clear the decision so queues treat it as fresh…
                        reviewedBy: deleteField(),
                        reviewedAt: deleteField(),
                        // …but keep who sent it back for the audit trail.
                        reopenedBy: staffName,
                        reopenedAt: serverTimestamp(),
                    });
                } else {
                    txn.update(ref, {
                        status: newStatus,
                        reviewedBy: staffName,
                        reviewedAt: serverTimestamp(),
                    });
                }
            });
            auditPtoChange({
                entryId: entry.id, staffName: entry.staffName,
                action: newStatus === 'pending' ? 'reopened' : newStatus,
                before: { status: fromStatus }, after: { status: newStatus },
                surface: 'admin-dashboard',
            });
            const range = (entry.startDate || entry.date) + (entry.endDate && entry.endDate !== entry.startDate ? ` → ${entry.endDate}` : '');
            const copy = {
                approved: {
                    type: 'pto_approved',
                    title: { en: 'Time-off approved', es: 'Tiempo libre aprobado' },
                    body: { en: `Update: your time-off for ${range} is now APPROVED.`,
                            es: `Actualización: tu tiempo libre del ${range} ahora está APROBADO.` },
                },
                denied: {
                    type: 'pto_denied',
                    title: { en: 'Time-off changed to denied', es: 'Tiempo libre cambiado a negado' },
                    body: { en: `Update: your time-off for ${range} was changed to DENIED${fromStatus === 'approved' ? ' (it was approved before)' : ''}. Talk to a manager if this is a problem.`,
                            es: `Actualización: tu tiempo libre del ${range} fue cambiado a NEGADO${fromStatus === 'approved' ? ' (antes estaba aprobado)' : ''}. Habla con un gerente si es un problema.` },
                },
                pending: {
                    // 'pto_reopened' (NOT 'pto_request') — pto_request is the
                    // mutable mgmt-queue type staff can opt out of; a revoked
                    // approval must always reach the person it affects, so
                    // this type is in LOCKED_ON_TYPE_IDS (notificationTypes.js
                    // + functions/index.js dispatchNotification).
                    type: 'pto_reopened',
                    title: { en: 'Time-off back under review', es: 'Tiempo libre en revisión otra vez' },
                    body: { en: `Your time-off for ${range} went back to PENDING — a manager will decide again.`,
                            es: `Tu tiempo libre del ${range} volvió a PENDIENTE — un gerente decidirá de nuevo.` },
                },
            }[newStatus];
            await notify(entry.staffName, copy.type, copy.title, copy.body);
            // Mgmt rollup so every manager sees the reversal (and a
            // back-to-pending re-alerts the queue). Tag is per-target-status
            // so repeated flips collapse sensibly instead of stacking.
            notifyManagement({
                type: copy.type,
                title: { en: `🔁 PTO ${newStatus === 'pending' ? 'back to pending' : newStatus}: ${entry.staffName}`,
                         es: `🔁 PTO ${newStatus === 'pending' ? 'a pendiente' : newStatus === 'approved' ? 'aprobado' : 'negado'}: ${entry.staffName}` },
                body: { en: `${range} · was ${fromStatus} · by ${staffName}`,
                        es: `${range} · era ${fromStatus === 'approved' ? 'aprobado' : fromStatus === 'denied' ? 'negado' : 'pendiente'} · por ${staffName}` },
                link: '/schedule',
                deepLink: 'schedule',
                tag: `pto_change_mgmt:${entry.id}:${newStatus}`,
                createdBy: staffName,
            }).catch(() => {});
            toast(tx('✓ Time-off updated', '✓ Tiempo libre actualizado'), { kind: 'success', duration: 2500 });
        } catch (e) {
            console.error('Change PTO status failed:', e);
            toast(tx('Could not update: ', 'No se pudo actualizar: ') + (e.message || 'unknown'));
        }
    };

    const handleDenyPto = async (entry) => {
        if (!canEdit) return;
        try {
            // 2026-05-24 audit fix: same idempotency wrap as approve.
            await runTransaction(db, async (txn) => {
                const ref = doc(db, 'time_off', entry.id);
                const snap = await txn.get(ref);
                if (!snap.exists()) {
                    throw new Error(tx_msg(
                        'PTO request no longer exists',
                        'La solicitud de tiempo libre ya no existe',
                    ));
                }
                const live = snap.data() || {};
                if (live.status !== 'pending') {
                    const reviewer = live.reviewedBy || 'someone';
                    throw new Error(tx_msg(
                        `Already ${live.status} by ${reviewer}`,
                        `Ya fue ${live.status === 'approved' ? 'aprobado' : 'negado'} por ${reviewer}`,
                    ));
                }
                txn.update(ref, {
                    status: 'denied',
                    reviewedBy: staffName,
                    reviewedAt: serverTimestamp(),
                });
            });
            auditPtoChange({
                entryId: entry.id, staffName: entry.staffName, action: 'denied',
                before: { status: 'pending' }, after: { status: 'denied' },
                surface: 'admin-dashboard',
            });
            const range = entry.startDate + (entry.endDate && entry.endDate !== entry.startDate ? ` → ${entry.endDate}` : '');
            await notify(entry.staffName, 'pto_denied',
                { en: 'Time-off denied', es: 'Tiempo libre negado' },
                { en: `Your time-off for ${range} was denied.`,
                  es: `Tu tiempo libre del ${range} fue negado.` });
            notifyManagement({
                type: 'pto_denied',
                title: { en: `✕ PTO denied: ${entry.staffName}`,
                         es: `✕ PTO negado: ${entry.staffName}` },
                body: { en: `${range} · by ${staffName}`,
                        es: `${range} · por ${staffName}` },
                link: '/schedule',
                deepLink: 'schedule',
                tag: `pto_denied_mgmt:${entry.id}`,
                createdBy: staffName,
            }).catch(() => {});
        } catch (e) {
            console.error('Deny PTO failed:', e);
            toast(tx('Could not deny: ', 'No se pudo negar: ') + (e.message || 'unknown'));
        }
    };

    // ── Phase 3: staff self-serve availability ──
    // Lifts the same pattern from AdminPanel: read-modify-write the staff list.
    // 2026-05-16 — staff self-serve birthday save. Same PIN integrity
    // gate as handleSaveMyAvailability. Accepts an MM-DD string OR
    // empty (to clear). Only writes the current staff member's own
    // record — defensive: even if someone tampered with state to
    // target another staffName, the filter limits the write to their
    // own row.
    const handleSaveMyBirthday = async (birthday) => {
        if (!staffList || !setStaffList) return;
        // Accept MM-DD or empty string (clear). Reject anything else.
        const clean = (typeof birthday === 'string' ? birthday.trim() : '');
        if (clean !== '' && !/^\d{2}-\d{2}$/.test(clean)) {
            toast(tx('Birthday must be MM-DD format (e.g. 03-15).',
                     'El cumpleaños debe ser en formato MM-DD (ej. 03-15).'),
                  { kind: 'error', duration: 5000 });
            return;
        }
        // Optimistic local update.
        const updatedLocal = staffList.map(s => s.name === staffName ? { ...s, birthday: clean } : s);
        setStaffList(updatedLocal);
        try {
            // Audit 2026-05-22 fix: txn re-reads /config/staff so a
            // concurrent admin edit (role change, etc.) isn't lost
            // when we write back. PIN-integrity gate runs on the
            // live list, not our stale local copy.
            await runTransaction(db, async (tx) => {
                const ref = doc(db, 'config', 'staff');
                const snap = await tx.get(ref);
                const liveList = (snap.exists() && Array.isArray(snap.data().list)) ? snap.data().list : updatedLocal;
                const next = liveList.map(s => s.name === staffName ? { ...s, birthday: clean } : s);
                const bad = next.find(s => {
                    const p = String(s.pin ?? '').trim();
                    return !p || !/^\d{4}$/.test(p);
                });
                if (bad) {
                    throw new Error(`PIN integrity check failed on ${bad.name}`);
                }
                tx.set(ref, { list: next });
            });
            toast(tx('🎂 Birthday saved', '🎂 Cumpleaños guardado'), { kind: 'success', duration: 2500 });
        } catch (e) {
            console.error('Save birthday failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message, { kind: 'error' });
        }
    };

    const handleSaveMyAvailability = async (newAvailability) => {
        if (!staffList || !setStaffList) return;
        // Snapshot the pre-change availability for the audit trail (read
        // before the optimistic update swaps the record out).
        const meRec = staffList.find(s => s.name === staffName);
        const beforeAvail = meRec ? (meRec.availability || null) : null;
        // Optimistic local update for snappy UI.
        const updatedLocal = staffList.map(s => s.name === staffName ? { ...s, availability: newAvailability } : s);
        setStaffList(updatedLocal);
        try {
            // Audit 2026-05-22 fix: was a read-modify-write of
            // /config/staff.list from local state. If an admin edited
            // a different staffer's role in AdminPanel mid-save, the
            // admin's edit got clobbered (last-writer-wins on the
            // whole list). Transaction re-reads the live list, applies
            // ONLY this staffer's availability change, writes back.
            await runTransaction(db, async (tx) => {
                const ref = doc(db, 'config', 'staff');
                const snap = await tx.get(ref);
                const liveList = (snap.exists() && Array.isArray(snap.data().list)) ? snap.data().list : updatedLocal;
                const next = liveList.map(s => s.name === staffName ? { ...s, availability: newAvailability } : s);
                // PIN integrity gate — same defense as before. Refuse
                // the save if ANY row has a missing/invalid PIN. This
                // catches the 2026-05-09 wipe pattern: stale React
                // state writing empty PINs back. Run on the txn-read
                // result so we check live data, not stale local.
                const bad = next.find(s => {
                    const p = String(s.pin ?? '').trim();
                    return !p || !/^\d{4}$/.test(p);
                });
                if (bad) {
                    throw new Error(`PIN integrity check failed on ${bad.name}`);
                }
                tx.set(ref, { list: next });
            });
            // Audit 2026-06-24: log every availability change (who / old /
            // new / where / how) for the Debug/QA change-history. Best-effort.
            auditAvailabilityChange({
                staffId: meRec?.id, staffName,
                before: beforeAvail, after: newAvailability,
                surface: 'self-serve',
            });
        } catch (e) {
            console.error('Save availability failed:', e);
            toast(tx('Could not save availability: ', 'No se pudo guardar: ') + e.message,
                  { kind: 'error', duration: 8000 });
            // Roll back the optimistic local update — caller will see the snapshot fix it.
        }
    };

    // ── Printable week (landscape HTML page in a new window) ──
    // Builds a self-contained HTML document with the full week grid laid out
    // for letter-sized paper (landscape). Replaces window.print() of the live
    // app, which was just a screenshot of the responsive layout.
    const handlePrintWeek = () => {
        const dayLabels = isEn ? DAYS_EN : DAYS_ES;
        const dayLabelsFull = isEn ? DAYS_FULL_EN : DAYS_FULL_ES;
        const days = [0,1,2,3,4,5,6].map(i => addDays(weekStart, i));
        const today = toDateStr(new Date());
        // Compact time format JUST for print — "10:00 AM" becomes "10a",
        // "3:30 PM" becomes "3:30p". On a 7-day landscape grid each cell is
        // only ~100px wide; the full formatTime12h output ("10:00 AM–3:00 PM")
        // wrapped to two lines per shift and bloated every cell with a
        // shift in it. Andrew flagged this — "the hours is long that make
        // the box too big". The screen UI keeps the full format.
        const compactTime = (t) => {
            if (!t) return '';
            const [hh, mm] = String(t).split(':').map(Number);
            if (Number.isNaN(hh)) return t;
            const h12 = hh % 12 === 0 ? 12 : hh % 12;
            const ampm = hh < 12 ? 'a' : 'p';
            return mm === 0 ? `${h12}${ampm}` : `${h12}:${String(mm).padStart(2, '0')}${ampm}`;
        };
        const sideLabel = side === 'foh' ? 'Front of House' : 'Back of House';
        const locLabel = LOCATION_LABELS[storeLocation] || storeLocation;
        const weekRange = `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        const escape = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

        // Per-person mode: when personFilter is set, render a clean day-by-day
        // list instead of the multi-staff wide grid. Better for handing to one
        // staff member.
        if (personFilter) {
            // 2026-05-30 — Andrew: include DRAFT shifts in the printable
            // sheet so managers can hand a paper version that reflects
            // every shift currently on the grid, not just the published
            // ones. Drafts render with a dashed amber border + DRAFT pill
            // so the printee can see which are still subject to change.
            const myShifts = visibleShifts.filter(sh => sh.staffName === personFilter);
            // Group by date so the per-day double-shift break gets deducted once.
            const byDate = new Map();
            for (const sh of myShifts) {
                const arr = byDate.get(sh.date) || [];
                arr.push(sh);
                byDate.set(sh.date, arr);
            }
            const totalHours = Array.from(byDate.values()).reduce((sum, dayShifts) => sum + dayPaidHours(dayShifts), 0);
            const dayBlocks = days.map((d, i) => {
                const dStr = toDateStr(d);
                const todayShifts = (byDate.get(dStr) || []).slice().sort((a,b) => (a.startTime||'').localeCompare(b.startTime||''));
                const onPto = isStaffOffOn(personFilter, dStr);
                const closed = dateClosed(dStr);
                const isDoubleDayPrint = todayShifts.length >= 2;
                let body = '';
                if (closed) body = '<div class="closed">CLOSED</div>';
                else if (onPto && todayShifts.length === 0) body = '<div class="pto">🌴 Time Off</div>';
                else if (todayShifts.length === 0) body = '<div class="empty">— Off —</div>';
                else body = todayShifts.map(sh => {
                    // Per-day total handles the break deduction; shift line shows raw hours.
                    const hrs = isDoubleDayPrint
                        ? hoursBetween(sh.startTime, sh.endTime, false)
                        : hoursBetween(sh.startTime, sh.endTime, sh.isDouble);
                    const isDraft = sh.published === false;
                    return `<div class="shift-row${isDraft ? ' draft' : ''}">
                        <span class="time">${escape(formatTime12h(sh.startTime))} – ${escape(formatTime12h(sh.endTime))}</span>
                        <span class="hrs">${escape(formatHours(hrs))}</span>
                        ${isDraft ? '<span class="draft-tag">DRAFT</span>' : ''}
                        ${sh.isShiftLead ? '<span class="lead">🛡️ LEAD</span>' : ''}
                        ${sh.isDouble ? '<span class="dbl">⏱ DOUBLE</span>' : ''}
                        ${sh.notes ? `<div class="notes">${escape(sh.notes)}</div>` : ''}
                    </div>`;
                }).join('') + (isDoubleDayPrint ? `<div class="dbl-day">🔁 DOUBLE DAY · ${escape(formatHours(dayPaidHours(todayShifts)))} paid (1h break)</div>` : '');
                return `<div class="day ${dStr === today ? 'today' : ''} ${closed ? 'closed-day' : ''}">
                    <div class="day-header">
                        <span class="dow">${escape(dayLabelsFull[d.getDay()])}</span>
                        <span class="dnum">${d.getMonth() + 1}/${d.getDate()}</span>
                    </div>
                    <div class="day-body">${body}</div>
                </div>`;
            }).join('');
            const personHtml = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>${escape(personFilter)} — ${escape(weekRange)}</title>
<style>
    @page { size: letter portrait; margin: 0.5in; }
    /* 2026-06-06 — force background colors to print (browsers strip them by
       default), so each shift row renders its mint fill instead of just the
       left border line. */
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 0; color: #1f2937; }
    .header { padding-bottom: 8px; margin-bottom: 12px; border-bottom: 2px solid #255a37; display: flex; justify-content: space-between; align-items: baseline; }
    h1 { font-size: 22px; margin: 0; color: #255a37; }
    .subhead { font-size: 12px; color: #6b7280; }
    .day { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
    .day.today { background: #ecfdf5; }
    .day.closed-day { background: #f3f4f6; opacity: 0.7; }
    .day-header { width: 110px; flex-shrink: 0; }
    .dow { display: block; font-weight: 700; font-size: 13px; color: #1f2937; }
    .dnum { font-size: 11px; color: #6b7280; }
    .day-body { flex: 1; }
    .shift-row { padding: 4px 8px; background: #ecfdf5; border-left: 3px solid #10b981; margin-bottom: 4px; border-radius: 2px; }
    .shift-row.draft { background: #fef3c7; border-left-color: #d97706; border: 1px dashed #d97706; border-left-width: 3px; }
    .draft-tag { display: inline-block; margin-left: 8px; font-size: 9px; padding: 1px 5px; background: #fde68a; color: #78350f; font-weight: 700; border-radius: 8px; letter-spacing: 0.5px; }
    .time { font-weight: 700; font-size: 13px; }
    .hrs { font-size: 11px; color: #6b7280; margin-left: 8px; }
    .lead { display: inline-block; margin-left: 8px; font-size: 9px; padding: 1px 5px; background: #ddd6fe; color: #5b21b6; font-weight: 700; border-radius: 8px; }
    .dbl { display: inline-block; margin-left: 4px; font-size: 9px; padding: 1px 5px; background: #dbeafe; color: #1e40af; font-weight: 700; border-radius: 8px; }
    .notes { font-size: 11px; font-style: italic; color: #4b5563; margin-top: 2px; }
    .empty, .pto, .closed { font-size: 11px; color: #9ca3af; padding: 4px; }
    .pto { color: #92400e; font-weight: 700; }
    .closed { color: #6b7280; font-weight: 700; }
    .summary { margin-top: 14px; padding: 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb; }
    .summary b { color: #255a37; font-size: 16px; }
    .footer { margin-top: 12px; font-size: 9px; color: #9ca3af; text-align: center; }
    /* Top toolbar — shown only on-screen, hidden during print. Lets the
       user get back to the schedule (close this tab) or re-trigger the
       print dialog. Earlier the print window was a dead end. */
    .toolbar { position: sticky; top: 0; background: white; border-bottom: 1px solid #e5e7eb; padding: 10px 16px; display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .toolbar button { padding: 8px 14px; border-radius: 8px; border: 1px solid #d1d5db; background: white; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; }
    .toolbar button.primary { background: #255a37; color: white; border-color: #255a37; }
    .toolbar .left { display: flex; gap: 8px; align-items: center; }
    @media print { .toolbar { display: none !important; } }
</style>
</head><body>
<div class="toolbar">
    <div class="left">
        <button onclick="window.close()" title="Close this tab and go back">← ${escape(isEn ? 'Done · Close' : 'Listo · Cerrar')}</button>
        <span style="font-size: 12px; color: #6b7280;">${escape(isEn ? 'Print preview' : 'Vista previa')}</span>
    </div>
    <button class="primary" onclick="window.print()">🖨 ${escape(isEn ? 'Print' : 'Imprimir')}</button>
</div>
<div class="header">
    <h1>📅 ${escape(personFilter)}</h1>
    <span class="subhead">${escape(weekRange)} · ${escape(locLabel)}</span>
</div>
${dayBlocks}
<div class="summary"><b>Total: ${escape(formatHours(totalHours))}</b> · ${myShifts.length} shifts this week</div>
<div class="footer">Printed ${new Date().toLocaleString()} · DD Mau</div>
<script>setTimeout(() => window.print(), 300);</script>
</body></html>`;
            if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(personHtml, 'DD Mau Schedule'); return; }
            const w = window.open('', '_blank', 'width=800,height=1000');
            if (!w) { toast(tx('Pop-up blocked.', 'Ventana bloqueada.')); return; }
            w.document.open(); w.document.write(personHtml); w.document.close();
            return;
        }

        // Build cell HTML for each staff/day (escape() is hoisted at top of fn)
        // 2026-05-30 — Andrew: drafts now print too. Each shift cell tags
        // unpublished entries with a `.draft` class (dashed amber border +
        // DRAFT pill) so the printee sees at a glance which entries are
        // still subject to change. Removing the skip means a draft-only
        // staffer also appears in rowsToShow (staffSummary.shiftCount
        // counts drafts for editors, so this works out).
        const shiftsByCell = new Map();
        for (const sh of visibleShifts) {
            const key = `${sh.staffName}|${sh.date}`;
            if (!shiftsByCell.has(key)) shiftsByCell.set(key, []);
            shiftsByCell.get(key).push(sh);
        }
        const rowsToShow = staffSummary.filter(s => s.shiftCount > 0); // only scheduled

        let bodyRows = '';
        for (const s of rowsToShow) {
            let cells = '';
            // Tier → solid role color in print, mirroring the on-screen
            // ShiftCube (roleColors). All of one person's shifts share their
            // tier color, exactly like the live grid.
            const tierClass = roleColors(s.role, s.shiftLead).tier; // 'manager' | 'lead' | 'staff'
            for (const d of days) {
                const dStr = toDateStr(d);
                const cellShifts = (shiftsByCell.get(`${s.name}|${dStr}`) || [])
                    .sort((a,b) => (a.startTime||'').localeCompare(b.startTime||''));
                const cellOnPto = isStaffOffOn(s.name, dStr);
                const cellClosed = dateClosed(dStr);
                const isToday = dStr === today;
                let cellHtml = '';
                if (cellClosed) cellHtml = '<div class="closed">CLOSED</div>';
                else if (cellOnPto && cellShifts.length === 0) cellHtml = '<div class="pto">🌴 PTO</div>';
                else if (cellShifts.length === 0) cellHtml = '<div class="empty">—</div>';
                else {
                    const cellIsDoubleDay = cellShifts.length >= 2;
                    cellHtml = cellShifts.map(sh => {
                        const hrs = cellIsDoubleDay
                            ? hoursBetween(sh.startTime, sh.endTime, false)
                            : hoursBetween(sh.startTime, sh.endTime, sh.isDouble);
                        const isDraft = sh.published === false;
                        // Compact time (10a–3p) keeps the cell to ONE line in
                        // the narrow weekday columns. Hours pill appended on
                        // the same line. Was: 10:00 AM–3:00 PM 5h (wrapped).
                        // Drafts get a dashed amber border + tiny DRAFT pill.
                        return `<div class="shift ${tierClass}${isDraft ? ' draft' : ''}">
                            <b>${escape(compactTime(sh.startTime))}–${escape(compactTime(sh.endTime))}</b>
                            <span class="hrs">${escape(formatHours(hrs))}</span>
                            ${isDraft ? '<span class="draft-pill">DRAFT</span>' : ''}
                            ${sh.isShiftLead ? '<span class="lead">🛡️</span>' : ''}
                            ${sh.isDouble ? '<span class="dbl">⏱</span>' : ''}
                            ${sh.notes ? `<div class="notes">${escape(sh.notes)}</div>` : ''}
                        </div>`;
                    }).join('') + (cellIsDoubleDay ? '<div class="dbl-tag">🔁 Double</div>' : '');
                }
                cells += `<td class="${isToday ? 'today' : ''} ${cellClosed ? 'closed-cell' : ''}">${cellHtml}</td>`;
            }
            const hoursClass = s.totalHours >= HOURS_YELLOW_MAX ? 'h-red' : s.totalHours >= HOURS_GREEN_MAX ? 'h-yellow' : 'h-green';
            bodyRows += `<tr>
                <td class="staff-cell">
                    <div class="staff-name">${escape(s.name)}${s.shiftLead ? ' 🛡️' : ''}${s.isMinor ? ' 🔑' : ''}</div>
                    <div class="staff-meta">${escape(s.role || '')}</div>
                    ${canEdit ? `<div class="hours ${hoursClass}">${escape(formatHours(s.totalHours))}</div>` : ''}
                </td>
                ${cells}
            </tr>`;
        }

        const headerRow = `<tr>
            <th class="staff-cell">${isEn ? 'Staff' : 'Personal'}</th>
            ${days.map((d, i) => {
                const dStr = toDateStr(d);
                const isToday = dStr === today;
                const dayBlocks = (blocksByDate.get(dStr) || []);
                const isClosed = dayBlocks.some(b => b.type === 'closed');
                return `<th class="${isToday ? 'today' : ''} ${isClosed ? 'closed-cell' : ''}">
                    <div class="dow">${escape(dayLabels[i])}</div>
                    <div class="dnum">${d.getDate()}</div>
                    ${isClosed ? '<div class="closed">🚫 CLOSED</div>' : ''}
                </th>`;
            }).join('')}
        </tr>`;

        const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>DD Mau Schedule — ${escape(weekRange)} — ${escape(sideLabel)}</title>
<style>
    @page { size: letter landscape; margin: 0.4in; }
    /* 2026-06-06 — force background colors to print. Browsers strip them by
       default, which is why shifts printed as "just a box line" (border only,
       no fill). With this every tint below (shifts, today, closed, hours
       pills) actually renders on paper. */
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 0; color: #1f2937; }
    .header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 2px solid #255a37; }
    h1 { font-size: 18px; margin: 0; color: #255a37; }
    .subhead { font-size: 11px; color: #4b5563; }
    table { width: 100%; border-collapse: collapse; font-size: 9px; }
    th, td { border: 1px solid #d1d5db; padding: 3px; vertical-align: top; }
    th { background: #f3f4f6; text-align: left; font-weight: 600; }
    th.today, td.today { background: #ecfdf5; }
    th.closed-cell, td.closed-cell { background: #e5e7eb; }
    .staff-cell { width: 14%; min-width: 90px; background: #f9fafb !important; }
    .staff-name { font-weight: 700; font-size: 10px; }
    .staff-meta { font-size: 8px; color: #6b7280; margin-top: 1px; }
    .hours { display: inline-block; margin-top: 2px; padding: 1px 5px; border-radius: 8px; font-size: 9px; font-weight: 700; border: 1px solid; }
    .h-green { background: #d1fae5; border-color: #6ee7b7; color: #065f46; }
    .h-yellow { background: #fef3c7; border-color: #fcd34d; color: #92400e; }
    .h-red { background: #fee2e2; border-color: #fca5a5; color: #991b1b; }
    .dow { font-size: 9px; text-transform: uppercase; color: #6b7280; }
    .dnum { font-size: 14px; font-weight: 700; color: #1f2937; }
    /* Shifts get a solid role tint that mirrors the on-screen glass cubes
       (roleColors): manager = orange, lead = green, staff = blue. Same hex
       as the live grid so paper matches screen. Solid fills, not outlines. */
    .shift { background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 3px; padding: 2px 4px; margin-bottom: 2px; }
    .shift.manager { background: #ffedd5; border-color: #fb923c; color: #7c2d12; }
    .shift.lead    { background: #dcfce7; border-color: #4ade80; color: #166534; }
    .shift.staff   { background: #dbeafe; border-color: #93c5fd; color: #1e40af; }
    .shift.draft { background: #fef3c7; border: 1px dashed #d97706; color: #78350f; }
    .draft-pill { display: inline-block; margin-left: 3px; font-size: 7px; padding: 0 3px; background: #fde68a; color: #78350f; font-weight: 700; border-radius: 6px; letter-spacing: 0.3px; vertical-align: middle; }
    .shift b { font-size: 9px; }
    .shift .hrs { display: inline-block; margin-left: 4px; font-size: 8px; opacity: 0.7; }
    .shift .notes { font-size: 8px; font-style: italic; color: #4b5563; margin-top: 1px; }
    .empty { color: #d1d5db; text-align: center; }
    .pto { color: #92400e; text-align: center; font-size: 8px; font-weight: 700; padding: 8px 0; }
    .closed { color: #6b7280; text-align: center; font-size: 8px; font-weight: 700; padding: 8px 0; }
    .footer { margin-top: 8px; font-size: 8px; color: #6b7280; display: flex; justify-content: space-between; }
    /* Top toolbar — on-screen only, hidden during print. Without this the
       print window was a dead end after the print dialog closed. */
    .toolbar { position: sticky; top: 0; background: white; border-bottom: 1px solid #e5e7eb; padding: 10px 16px; display: flex; gap: 8px; align-items: center; justify-content: space-between; margin: -10px -10px 12px -10px; }
    .toolbar button { padding: 8px 14px; border-radius: 8px; border: 1px solid #d1d5db; background: white; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; }
    .toolbar button.primary { background: #255a37; color: white; border-color: #255a37; }
    .toolbar .left { display: flex; gap: 8px; align-items: center; }
    @media print { .noprint { display: none; } .toolbar { display: none !important; } }
</style>
</head><body>
<div class="toolbar">
    <div class="left">
        <button onclick="window.close()" title="Close this tab and go back">← ${escape(isEn ? 'Done · Close' : 'Listo · Cerrar')}</button>
        <span style="font-size: 12px; color: #6b7280;">${escape(isEn ? 'Print preview' : 'Vista previa')}</span>
    </div>
    <button class="primary" onclick="window.print()">🖨 ${escape(isEn ? 'Print' : 'Imprimir')}</button>
</div>
<div class="header">
    <h1>📅 DD Mau Schedule — ${escape(sideLabel)}</h1>
    <div class="subhead">${escape(weekRange)} · ${escape(locLabel)}${personFilter ? ` · ${escape(personFilter)}` : ''}</div>
</div>
<table>
    <thead>${headerRow}</thead>
    <tbody>${bodyRows || `<tr><td colspan="8" style="text-align:center;padding:30px;color:#9ca3af">No published shifts.</td></tr>`}</tbody>
</table>
<div class="footer">
    <span>Drafts shown with dashed amber border. Closed dates shown in grey. Today highlighted in mint.</span>
    <span>Printed ${new Date().toLocaleString()}</span>
</div>
<script>setTimeout(() => window.print(), 300);</script>
</body></html>`;

        if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Schedule'); return; }
        const w = window.open('', '_blank', 'width=1100,height=850');
        if (!w) {
            toast(tx('Pop-up blocked. Allow pop-ups for this site to print.', 'Ventana emergente bloqueada. Permite ventanas emergentes para imprimir.'));
            return;
        }
        w.document.open();
        w.document.write(html);
        w.document.close();
    };

    // ── ICS calendar export (current view's shifts → .ics file) ──
    // Phase 4: each scheduled shift becomes a VEVENT. Filtered same as the view
    // (location + side + person filter). Imports cleanly into Apple Calendar,
    // Google Calendar, Outlook. No server needed.
    const handleExportIcs = async () => {
        const events = visibleShifts.filter(s => s.published !== false); // skip drafts
        if (events.length === 0) {
            toast(tx('No published shifts to export.', 'Sin turnos publicados para exportar.'));
            return;
        }
        const pad = (n) => String(n).padStart(2, '0');
        // Format date+time for ICS as floating local time (no Z, no TZID).
        // Floating = whatever local TZ the calendar user is in. For staff who
        // open this on their phone, that's the same time DD Mau means.
        const fmt = (dateStr, timeStr) => {
            const [y, m, d] = dateStr.split('-').map(Number);
            const [h, mi] = (timeStr || '09:00').split(':').map(Number);
            return `${y}${pad(m)}${pad(d)}T${pad(h)}${pad(mi)}00`;
        };
        // Roll DTEND forward one calendar day if endTime <= startTime.
        // Without this, an overnight shift (e.g. 22:00–02:00) writes
        // DTEND <= DTSTART, which calendars reject or render as
        // negative-duration. parseLocalDate handles the +1 day rollover
        // correctly across month/year/DST boundaries.
        const fmtEnd = (dateStr, startTime, endTime) => {
            const sameOrLater = (endTime || '') > (startTime || '');
            if (sameOrLater) return fmt(dateStr, endTime);
            const next = addDays(parseLocalDate(dateStr), 1);
            return fmt(toDateStr(next), endTime);
        };
        const escape = (s) => (s || '').replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');
        const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//DD Mau//Schedule//EN',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
            `X-WR-CALNAME:DD Mau ${side === 'foh' ? 'FOH' : 'BOH'} ${LOCATION_LABELS[storeLocation] || storeLocation}${personFilter ? ' — ' + personFilter : ''}`,
        ];
        for (const sh of events) {
            // Andrew 2026-05-30 — guard against legacy shifts where
            // location is undefined; without this the ICS event title
            // reads "Maria ()" which is ugly. Only show the loc tag
            // when we actually have a label for it.
            const locLabel = LOCATION_LABELS[sh.location] || sh.location || '';
            const summary = `${sh.staffName}${locLabel ? ` (${locLabel})` : ''}${sh.isShiftLead ? ' 🛡️' : ''}${sh.isDouble ? ' ⏱' : ''}`;
            lines.push(
                'BEGIN:VEVENT',
                `UID:${sh.id}@ddmau`,
                `DTSTAMP:${dtstamp}`,
                `DTSTART:${fmt(sh.date, sh.startTime)}`,
                `DTEND:${fmtEnd(sh.date, sh.startTime, sh.endTime)}`,
                `SUMMARY:${escape(summary)}`,
                sh.notes ? `DESCRIPTION:${escape(sh.notes)}` : 'DESCRIPTION:',
                `LOCATION:${escape(LOCATION_LABELS[sh.location] || sh.location || '')}`,
                'END:VEVENT',
            );
        }
        lines.push('END:VCALENDAR');
        const ics = lines.join('\r\n');
        const blob = new Blob([ics], { type: 'text/calendar' });
        const filename = `dd-mau-${side}-${toDateStr(weekStart)}${personFilter ? '-' + personFilter.replace(/\s+/g, '_') : ''}.ics`;
        await downloadFile({ data: blob, fileName: filename, mimeType: 'text/calendar' });
    };

    // ── Phase 3: bulk publish drafts in current week + side ──
    // Step 1 of publish — collect the drafts + audit, open the preview modal.
    // The actual write happens in confirmPublishDrafts after the manager
    // sees what they're about to publish (and can cancel if anything
    // looks wrong).
    const handlePublishDrafts = () => {
        if (!canEdit) return;
        const drafts = visibleShifts.filter(s => s.published === false);
        if (drafts.length === 0) {
            toast(tx('No drafts to publish.', 'Sin borradores para publicar.'));
            return;
        }
        const weekStartStr = toDateStr(weekStart);
        const weekEndStr = toDateStr(addDays(weekStart, 7));
        const relevantNeeds = staffingNeeds.filter(n =>
            n.date >= weekStartStr && n.date < weekEndStr && n.side === side &&
            (storeLocation === 'both' || n.location === 'both' || n.location === storeLocation)
        );
        const underFilled = relevantNeeds.filter(n => (n.filledStaff || []).length < (n.count || 0));
        const overFilled = relevantNeeds.filter(n => (n.filledStaff || []).length > (n.count || 0));
        setPublishPreview({ drafts, underFilled, overFilled });
    };

    // Step 2 of publish — runs when the manager confirms in the preview modal.
    const confirmPublishDrafts = async () => {
        if (!publishPreview) return;
        const { drafts } = publishPreview;
        // 2026-05-24 audit fix: re-check approved time-off RIGHT BEFORE
        // we publish. Without this, a draft built Monday + PTO approved
        // for that staffer Tuesday + publish Wednesday would still go
        // out as a published shift on top of approved time-off. The
        // PTO subscription in this component is live so this is just a
        // belt-and-suspenders check at the commit boundary.
        const ptoConflicts = drafts.filter(s => isStaffOffOn(s.staffName, s.date));
        if (ptoConflicts.length > 0) {
            const sample = ptoConflicts.slice(0, 8).map(s =>
                `  · ${s.staffName} · ${s.date} ${formatTime12h(s.startTime)}–${formatTime12h(s.endTime)}`
            ).join('\n');
            const more = ptoConflicts.length > 8 ? `\n  · ...+${ptoConflicts.length - 8}` : '';
            const proceed = confirm(tx(
                `⚠️ ${ptoConflicts.length} shift(s) in this batch conflict with approved time-off:\n\n${sample}${more}\n\nPublish the rest and SKIP these? (Click Cancel to abort.)`,
                `⚠️ ${ptoConflicts.length} turno(s) en este lote chocan con tiempo libre aprobado:\n\n${sample}${more}\n\n¿Publicar el resto y OMITIR estos? (Cancelar para abortar.)`,
            ));
            if (!proceed) return;
        }
        const safeDrafts = drafts.filter(s => !isStaffOffOn(s.staffName, s.date));
        if (safeDrafts.length === 0) {
            toast(tx('Nothing to publish (all conflicts).', 'Nada que publicar (todos en conflicto).'));
            setPublishPreview(null);
            return;
        }
        try {
            const batch = writeBatch(db);
            for (const s of safeDrafts) {
                batch.update(doc(db, 'shifts', s.id), {
                    published: true,
                    publishedBy: staffName,
                    publishedAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
            }
            await batch.commit();
            // Audit log (one roll-up row for the publish) — Andrew 2026-06-25.
            auditShiftChange({ action: 'published', staffName: null,
                after: { count: safeDrafts.length, skipped: ptoConflicts.length || 0 } }).catch(() => {});
            setPublishPreview(null);
            // Non-blocking heads-up: published shifts that land in a PARTIAL
            // off window (those aren't skipped — they stay scheduled — but the
            // manager should double-check the hours). Andrew 2026-06-17.
            const partialOverlaps = safeDrafts.filter(s => shiftOverlapsPartialOff(s.staffName, s.date, s.startTime, s.endTime));
            if (partialOverlaps.length > 0) {
                const names = [...new Set(partialOverlaps.map(s => s.staffName))].join(', ');
                toast(tx(`⚠ ${partialOverlaps.length} shift(s) overlap a partial time-off window (${names}) — double-check those hours.`,
                         `⚠ ${partialOverlaps.length} turno(s) se cruzan con tiempo libre parcial (${names}) — revisa esas horas.`));
            }
            const skippedNote = ptoConflicts.length > 0
                ? tx(` (skipped ${ptoConflicts.length} PTO conflicts)`, ` (omitidos ${ptoConflicts.length} conflictos de PTO)`)
                : '';
            toast(tx(`✅ Published ${safeDrafts.length} shifts${skippedNote}.`, `✅ Se publicaron ${safeDrafts.length} turnos${skippedNote}.`));
            // Notify each staffer whose shifts were published — one notification per person.
            // Use safeDrafts (PTO conflicts excluded above) so we don't ping
            // someone about a shift that didn't actually get published.
            const byStaff = new Map();
            for (const s of safeDrafts) {
                const list = byStaff.get(s.staffName) || [];
                list.push(s);
                byStaff.set(s.staffName, list);
            }
            for (const [name, list] of byStaff) {
                // Build a date+time summary so the staff push tells them WHAT
                // shifts were just released, not just "you have N shifts."
                // Two parallel summaries (EN+ES) so the recipient sees their
                // preferred language regardless of who published.
                const sorted = [...list].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''));
                const fmtLines = (lng) => {
                    const lines = sorted.slice(0, 3).map(s => {
                        const d = parseLocalDate(s.date);
                        const dayLbl = d ? (lng === 'es' ? DAYS_ES : DAYS_EN)[d.getDay()].slice(0, 3) : s.date;
                        return `${dayLbl} ${s.date.slice(5)} ${formatTime12h(s.startTime)}–${formatTime12h(s.endTime)}`;
                    });
                    if (sorted.length > 3) lines.push(lng === 'es' ? `+${sorted.length - 3} más` : `+${sorted.length - 3} more`);
                    return lines.join('\n');
                };
                await notify(name, 'week_published',
                    {
                        en: `📢 Schedule published: ${list.length} shift${list.length === 1 ? '' : 's'}`,
                        es: `📢 Horario publicado: ${list.length} turno${list.length === 1 ? '' : 's'}`,
                    },
                    { en: fmtLines('en'), es: fmtLines('es') },
                    null,
                    // Tag = week_published:{recipient}:{weekStart} — if the
                    // same week gets republished after a small edit, the
                    // notification replaces instead of stacking on the
                    // recipient's device.
                    { allowSelf: true, tagSuffix: `week:${toDateStr(weekStart)}` });
            }
            // Management summary — every owner + manager gets one roll-up
            // bell entry so the publish is visible to the whole leadership
            // team. INCLUDES the publisher (no excludeStaff) — Andrew
            // explicitly asked for the bell-drawer record of his own
            // publishes since he doesn't get a per-staff notification
            // (he has no shifts assigned).
            const weekStartStr = toDateStr(weekStart);
            notifyManagement({
                type: 'week_published_admin',
                title: { en: `📢 Schedule published (week of ${weekStartStr})`,
                         es: `📢 Horario publicado (semana del ${weekStartStr})` },
                body: { en: `${safeDrafts.length} shift${safeDrafts.length === 1 ? '' : 's'} • ${byStaff.size} staff • by ${staffName}`,
                        es: `${safeDrafts.length} turno${safeDrafts.length === 1 ? '' : 's'} • ${byStaff.size} persona(s) • por ${staffName}` },
                link: '/schedule',
                deepLink: 'schedule',
                tag: `week_published_admin:${weekStartStr}`,
                createdBy: staffName,
            }).catch(() => {});
        } catch (e) {
            console.error('Publish failed:', e);
            toast(tx('Publish error: ', 'Error al publicar: ') + e.message);
        }
    };

    // ── Phase 3: copy last week's shifts into this week ──
    const handleCopyLastWeek = async () => {
        // Copies last week's shifts for the currently-viewed side. Gate
        // against the editor toggle for that specific side.
        if (!canEditSide(side)) return;
        const lastWeekStart = addDays(weekStart, -7);
        const lastWeekStartStr = toDateStr(lastWeekStart);
        const lastWeekEndStr = toDateStr(weekStart);
        try {
            // 2026-05-24 audit fix: was using onSnapshot-as-getDocs which
            // has a real race — the SDK can invoke the callback BEFORE
            // the assignment `unsub = …` completes (Firestore fires
            // cached snapshots synchronously). Then `unsub` is undefined,
            // the listener leaks, and any future write to /shifts in
            // that date range re-fires the resolve() (which is a no-op
            // since the Promise already settled, but the leak persists).
            // getDocs is the right tool for a one-shot read.
            const q = query(
                collection(db, 'shifts'),
                where('date', '>=', lastWeekStartStr),
                where('date', '<', lastWeekEndStr),
            );
            const snap = await getDocs(q);
            const sourceShifts = [];
            snap.forEach(d => sourceShifts.push({ id: d.id, ...d.data() }));
            // Filter to side + location
            const filtered = sourceShifts.filter(sh => {
                if (storeLocation !== 'both' && sh.location !== storeLocation) return false;
                return sideStaffNames.has(sh.staffName);
            });
            if (filtered.length === 0) {
                toast(tx('No shifts found in last week.', 'No hay turnos en la semana anterior.'));
                return;
            }
            if (!confirm(tx(
                `Copy ${filtered.length} shift(s) from last week into this week (${toDateStr(weekStart)})? They'll be created as DRAFTS.`,
                `¿Copiar ${filtered.length} turno(s) de la semana anterior a esta semana (${toDateStr(weekStart)})? Se crearán como BORRADORES.`,
            ))) return;
            // Create new docs with date shifted +7. Batched (audit
            // 2026-05-22) — same reasoning as auto-fill: 50 sequential
            // addDocs was 10+ seconds dead time on copy-week.
            const toCreate = [];
            for (const sh of filtered) {
                const oldDate = parseLocalDate(sh.date);
                if (!oldDate) continue;
                const newDate = new Date(oldDate);
                newDate.setDate(newDate.getDate() + 7);
                const newDateStr = toDateStr(newDate);
                if (dateClosed(newDateStr, sh.location)) continue;
                if (isStaffOffOn(sh.staffName, newDateStr)) continue;
                toCreate.push({
                    staffName: sh.staffName,
                    date: newDateStr,
                    startTime: sh.startTime,
                    endTime: sh.endTime,
                    location: sh.location,
                    // Preserve the per-shift side override on copy. Without
                    // this, a cross-side shift (FOH cook covering BOH)
                    // would revert to the staff's home side on the new
                    // week's draft, silently breaking the assignment.
                    side: sh.side || null,
                    isShiftLead: !!sh.isShiftLead,
                    isDouble: !!sh.isDouble,
                    notes: sh.notes || '',
                    published: false, // DRAFT
                    createdBy: staffName,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
            }
            const BATCH_LIMIT = 400;
            for (let i = 0; i < toCreate.length; i += BATCH_LIMIT) {
                const batch = writeBatch(db);
                for (const sh of toCreate.slice(i, i + BATCH_LIMIT)) {
                    batch.set(doc(collection(db, 'shifts')), sh);
                }
                await batch.commit();
            }
            // Audit log (roll-up) — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'copied_week', targetType: 'shift', targetName: 'copy last week',
                after: { count: toCreate.length } }).catch(() => {});
            toast(tx(`✅ Copied ${toCreate.length} shifts as drafts.`, `✅ Se copiaron ${toCreate.length} turnos como borradores.`));
        } catch (e) {
            console.error('Copy week failed:', e);
            toast(tx('Copy error: ', 'Error al copiar: ') + e.message);
        }
    };

    // ── Auto-populate engine ──
    // For each side-staff with availability + targetHours, distribute their target
    // hours across the week's available days (skipping closed dates and approved
    // time-off). Greedy strategy: spread hours roughly evenly across available days.
    // Generated shifts are marked published=false (drafts) so manager can review.
    const handleAutoPopulate = async () => {
        // Auto-fill operates on the CURRENTLY-VIEWED side. If the user
        // lacks the toggle for that side they can't run it. (FOH-only
        // editor on the BOH tab gets blocked.)
        if (!canEditSide(side)) return;
        const ok = confirm(tx(
            `Auto-fill the week of ${toDateStr(weekStart)} for ${side === 'foh' ? 'FOH' : 'BOH'}?\n\nThis will generate DRAFT shifts based on each staff's availability + target hours, skipping closed dates and approved time-off. Existing shifts are NOT overwritten.`,
            `¿Auto-rellenar la semana de ${toDateStr(weekStart)} para ${side === 'foh' ? 'FOH' : 'BOH'}?\n\nEsto generará turnos BORRADOR según la disponibilidad y horas objetivo de cada persona, saltando fechas cerradas y tiempo libre aprobado. Los turnos existentes NO se sobrescriben.`,
        ));
        if (!ok) return;

        const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        const created = [];
        const skipped = [];

        for (const s of sideStaff) {
            const target = Number(s.targetHours) || 0;
            if (target <= 0) { skipped.push(`${s.name}: ${tx('no target hours', 'sin horas objetivo')}`); continue; }
            const avail = s.availability || {};
            // Already-scheduled hours for this person this week (don't double-book).
            // IMPORTANT: must use `shifts` (location-filtered), NOT visibleShifts —
            // visibleShifts is side-filtered, so a FOH cook with a Tuesday BOH
            // shift would be considered "free" by FOH auto-fill and end up
            // double-booked against themselves.
            const myExisting = shifts.filter(sh =>
                sh.staffName === s.name &&
                (storeLocation === 'both' || sh.location === storeLocation));
            // Group by date so the auto-double break gets deducted once per day
            // (e.g. existing 10–3 + 4–8 same day → 8h paid, not 9h).
            const myByDate = new Map();
            for (const sh of myExisting) {
                const arr = myByDate.get(sh.date) || [];
                arr.push(sh);
                myByDate.set(sh.date, arr);
            }
            const existingHours = Array.from(myByDate.values()).reduce((sum, dayShifts) => sum + dayPaidHours(dayShifts), 0);
            const remaining = target - existingHours;
            if (remaining <= 0) { skipped.push(`${s.name}: ${tx('already at target', 'ya alcanzó objetivo')}`); continue; }

            // Build candidate days: must be available, not closed, not on approved PTO.
            const candidates = [];
            for (let i = 0; i < 7; i++) {
                const date = addDays(weekStart, i);
                const dStr = toDateStr(date);
                // #6: this person's shifts land at their own store, so check
                // that store's closed days (matches the location written below).
                const sLoc = (s.location && s.location !== 'both') ? s.location : (storeLocation !== 'both' ? storeLocation : 'webster');
                if (dateClosed(dStr, sLoc)) continue;
                if (isStaffOffOn(s.name, dStr)) continue;
                // Don't double-book this person on a day they already have a shift.
                if (myExisting.some(sh => sh.date === dStr)) continue;
                const dayAvail = avail[dayKeys[date.getDay()]];
                // Skip ONLY when the staff explicitly marked the day off.
                // Empty / partial availability now defaults to AVAILABLE
                // (per Andrew 2026-05-12): staff opt OUT of days, not in.
                if (dayAvail && dayAvail.available === false) continue;
                // Resolve a working time window. Use the staff's explicit
                // from/to if they set one; otherwise default to a generic
                // 10am–9pm window covering DD Mau's normal operating hours.
                const from = (dayAvail && dayAvail.from) || '10:00';
                const to = (dayAvail && dayAvail.to) || '21:00';
                const slotHours = hoursBetween(from, to, false);
                if (slotHours <= 0) continue;
                candidates.push({ date: dStr, from, to, slotHours });
            }

            if (candidates.length === 0) { skipped.push(`${s.name}: ${tx('no available days', 'sin días disponibles')}`); continue; }

            // Spread target hours across candidate days.
            // Simple greedy: target shift length = remaining / candidates.length, capped to slotHours.
            const targetPerDay = Math.min(8, remaining / candidates.length);
            let leftover = remaining;
            for (const c of candidates) {
                if (leftover <= 0) break;
                const desiredHours = Math.min(targetPerDay, c.slotHours, leftover);
                if (desiredHours < 2) continue; // don't schedule sub-2hr shifts
                // Use the from-time as the start; end = from + desiredHours.
                const [fH, fM] = c.from.split(':').map(Number);
                const startMin = fH * 60 + fM;
                const endMin = startMin + Math.round(desiredHours * 60);
                const endH = Math.floor(endMin / 60);
                const endM = endMin % 60;
                if (endH >= 24) continue; // would cross midnight; skip for simplicity
                const endTime = `${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}`;
                created.push({
                    staffName: s.name,
                    date: c.date,
                    startTime: c.from,
                    endTime,
                    location: (s.location && s.location !== 'both') ? s.location : (storeLocation !== 'both' ? storeLocation : 'webster'),
                    isShiftLead: false,
                    isDouble: false,
                    notes: tx('auto-filled', 'auto-rellenado'),
                    published: false, // DRAFT
                    createdBy: staffName,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
                leftover -= desiredHours;
            }
        }

        if (created.length === 0) {
            toast(tx(`Nothing to schedule. Reasons:\n${skipped.slice(0, 8).join('\n')}`,
                `Nada que programar. Razones:\n${skipped.slice(0, 8).join('\n')}`));
            return;
        }

        try {
            // Batched writes — production audit 2026-05-22. Previously
            // this was a sequential `for ... await addDoc()` loop. For
            // a 30-staff × 5-day week that's 150 round-trips ≈ 30s of
            // dead time with no progress UI. writeBatch commits up to
            // 500 ops in a single round-trip; we chunk in 400s to leave
            // safety headroom. Auto-fill now completes in ≤1s for
            // typical weeks.
            const BATCH_LIMIT = 400;
            for (let i = 0; i < created.length; i += BATCH_LIMIT) {
                const batch = writeBatch(db);
                const slice = created.slice(i, i + BATCH_LIMIT);
                for (const sh of slice) {
                    batch.set(doc(collection(db, 'shifts')), sh);
                }
                await batch.commit();
            }
            // Audit log (roll-up) — Andrew 2026-06-25.
            auditScheduleConfig({ action: 'auto_filled', targetType: 'shift', targetName: 'auto-fill engine',
                after: { generated: created.length, skipped: skipped.length } }).catch(() => {});
            toast(tx(`✅ Auto-filled ${created.length} draft shifts.${skipped.length ? `\n\nSkipped:\n${skipped.slice(0,5).join('\n')}` : ''}`,
                `✅ Se auto-rellenaron ${created.length} turnos borrador.${skipped.length ? `\n\nOmitidos:\n${skipped.slice(0,5).join('\n')}` : ''}`));
        } catch (e) {
            console.error('Auto-fill failed:', e);
            toast(tx('Auto-fill error: ', 'Error de auto-rellenar: ') + e.message);
        }
    };

    const openAddModal = (prefill = null) => {
        setAddPrefill(prefill);
        setShowAddModal(true);
    };

    // ── 2026-05-30 — confirmation wrappers (askXxx pattern) ─────────────
    // Every destructive or state-changing action in SwapPanels + the
    // schedule grid drag-drop routes through these wrappers, which open
    // a glass ConfirmModal before calling the real handler. Per Andrew:
    // "any delete or change always is followed a are you sure type of
    // question so nothing is accidentally deleted or moved, or dragged."
    //
    // Each wrapper builds the action-specific copy (status-aware for
    // PTO, conflict-aware for approve-PTO, split-aware for approve-swap)
    // and seeds setConfirmDialog. ConfirmModal owns its close lifecycle
    // so we never call setConfirmDialog(null) from here.
    //
    // NOT wrapped — handleOfferShift / handleTakeShift open their own
    // dedicated modals (OfferShiftModal / TakeShiftModal) which ARE the
    // confirmation. Double-confirming would be annoying.
    const askCancelOffer = (shift) => {
        if (!shift) return;
        setConfirmDialog({
            title: tx('Cancel offer?', '¿Cancelar oferta?'),
            body: tx(
                "Staff who saw the offer will lose it. You will still be responsible for the shift.",
                "El personal que vio la oferta la perderá. Seguirás siendo responsable del turno."
            ),
            confirmLabel: tx('Cancel offer', 'Cancelar oferta'),
            tone: 'danger',
            onConfirm: () => handleCancelOffer(shift),
        });
    };
    const askApproveSwap = (shift) => {
        if (!shift) return;
        const splitInfo = shift.proposedSplit && shift.proposedSplit.startTime && shift.proposedSplit.endTime
            ? tx(
                `\n\nProposed partial pickup: ${shift.pendingClaimBy} takes ${formatTime12h(shift.proposedSplit.startTime)}–${formatTime12h(shift.proposedSplit.endTime)}. ${shift.staffName} keeps the leftover.`,
                `\n\nToma parcial propuesta: ${shift.pendingClaimBy} toma ${formatTime12h(shift.proposedSplit.startTime)}–${formatTime12h(shift.proposedSplit.endTime)}. ${shift.staffName} mantiene el resto.`
            )
            : '';
        setConfirmDialog({
            title: tx('Approve this swap?', '¿Aprobar este cambio?'),
            body: tx(
                `${shift.pendingClaimBy} will take ${shift.staffName}'s ${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} shift. Both will be notified.`,
                `${shift.pendingClaimBy} tomará el turno de ${shift.staffName} del ${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)}. Ambos serán notificados.`
            ) + splitInfo,
            confirmLabel: tx('Approve', 'Aprobar'),
            tone: 'primary',
            onConfirm: () => handleApproveSwap(shift),
        });
    };
    const askDenySwap = (shift) => {
        if (!shift) return;
        setConfirmDialog({
            title: tx('Deny this swap?', '¿Negar este cambio?'),
            body: tx(
                `${shift.pendingClaimBy} will not take the shift. It goes back to open offer (${shift.staffName} still responsible).`,
                `${shift.pendingClaimBy} no tomará el turno. Volverá a oferta abierta (${shift.staffName} sigue responsable).`
            ),
            confirmLabel: tx('Deny', 'Negar'),
            tone: 'danger',
            onConfirm: () => handleDenySwap(shift),
        });
    };
    const askApproveSwapRequest = (request) => {
        if (!request) return;
        const f = request.fromShiftSnapshot || {};
        const t = request.toShiftSnapshot || {};
        setConfirmDialog({
            title: tx('Approve this swap request?', '¿Aprobar esta solicitud?'),
            body: tx(
                `${request.fromStaff} and ${request.toStaff} will exchange shifts:\n· ${request.fromStaff}: ${f.date} ${formatTime12h(f.startTime)}–${formatTime12h(f.endTime)}\n· ${request.toStaff}: ${t.date} ${formatTime12h(t.startTime)}–${formatTime12h(t.endTime)}`,
                `${request.fromStaff} y ${request.toStaff} intercambiarán turnos:\n· ${request.fromStaff}: ${f.date} ${formatTime12h(f.startTime)}–${formatTime12h(f.endTime)}\n· ${request.toStaff}: ${t.date} ${formatTime12h(t.startTime)}–${formatTime12h(t.endTime)}`
            ),
            confirmLabel: tx('Approve swap', 'Aprobar'),
            tone: 'primary',
            onConfirm: () => handleApproveSwapRequest(request),
        });
    };
    const askDenySwapRequest = (request) => {
        if (!request) return;
        setConfirmDialog({
            title: tx('Deny this swap request?', '¿Negar esta solicitud?'),
            body: tx(
                `${request.fromStaff} and ${request.toStaff} will not exchange shifts.`,
                `${request.fromStaff} y ${request.toStaff} no intercambiarán turnos.`
            ),
            confirmLabel: tx('Deny', 'Negar'),
            tone: 'danger',
            onConfirm: () => handleDenySwapRequest(request),
        });
    };
    const askApprovePto = (entry) => {
        if (!entry) return;
        // Compute conflicts so manager sees orphaned shifts inline.
        // (Was a native confirm() inside handleApprovePto — moved here.)
        const start = entry.startDate || entry.date;
        const end = entry.endDate || entry.date;
        const conflicts = shifts.filter(sh =>
            sh.staffName === entry.staffName && sh.published !== false &&
            sh.date >= start && sh.date <= end);
        const range = start + (end !== start ? ` → ${end}` : '');
        let body = tx(
            `Approve ${entry.staffName}'s time-off for ${range}? They will be notified.`,
            `¿Aprobar el tiempo libre de ${entry.staffName} del ${range}? Será notificado.`
        );
        if (conflicts.length > 0) {
            const lines = conflicts.slice(0, 6).map(sh =>
                `· ${sh.date} ${formatTime12h(sh.startTime)}–${formatTime12h(sh.endTime)}`
            ).join('\n');
            const more = conflicts.length > 6 ? tx(`\n· ...and ${conflicts.length - 6} more`, `\n· ...y ${conflicts.length - 6} más`) : '';
            body += tx(
                `\n\n⚠️ This will leave ${conflicts.length} published shift(s) UNCOVERED:\n${lines}${more}\n\nYou will need to reassign these.`,
                `\n\n⚠️ Esto dejará ${conflicts.length} turno(s) SIN CUBRIR:\n${lines}${more}\n\nTendrás que reasignarlos.`
            );
        }
        setConfirmDialog({
            title: tx('Approve PTO?', '¿Aprobar PTO?'),
            body,
            confirmLabel: tx('Approve PTO', 'Aprobar PTO'),
            tone: conflicts.length > 0 ? 'danger' : 'primary',
            onConfirm: () => handleApprovePto(entry),
        });
    };
    const askDenyPto = (entry) => {
        if (!entry) return;
        const range = (entry.startDate || entry.date) + (entry.endDate && entry.endDate !== entry.startDate ? ` → ${entry.endDate}` : '');
        setConfirmDialog({
            title: tx('Deny PTO?', '¿Negar PTO?'),
            body: tx(
                `${entry.staffName} will be notified that the time-off for ${range} was denied.`,
                `${entry.staffName} será notificado que el tiempo libre del ${range} fue negado.`
            ),
            confirmLabel: tx('Deny', 'Negar'),
            tone: 'danger',
            onConfirm: () => handleDenyPto(entry),
        });
    };
    // Glass-confirm wrapper for the 🗑 Delete chip — consistent with the
    // other three chips (the handler no longer carries its own confirm).
    const askRemoveTimeOff = (entry) => {
        if (!entry?.id) return;
        const status = entry.status || 'approved';
        const range = (entry.startDate || entry.date) + (entry.endDate && entry.endDate !== entry.startDate ? ` → ${entry.endDate}` : '');
        setConfirmDialog({
            title: tx('Delete this time-off entry?', '¿Borrar este tiempo libre?'),
            body: status === 'denied'
                ? tx(
                    `Permanently delete ${entry.staffName}'s denied request for ${range}? No record will remain.`,
                    `¿Borrar permanentemente la solicitud negada de ${entry.staffName} del ${range}? No quedará registro.`
                )
                : tx(
                    `Permanently delete ${entry.staffName}'s ${status} time-off for ${range}? No record will remain — they will be notified.`,
                    `¿Borrar permanentemente el tiempo libre (${status === 'approved' ? 'aprobado' : 'pendiente'}) de ${entry.staffName} del ${range}? No quedará registro — será notificado.`
                ),
            confirmLabel: tx('Delete', 'Borrar'),
            tone: 'danger',
            onConfirm: () => handleRemoveTimeOff(entry),
        });
    };

    // One confirm wrapper for the full PTO status matrix. First decisions on
    // pending requests route to the original ask/handle pair (conflict-aware
    // copy, queue semantics); reversals route to handleChangePtoStatus.
    const askSetPtoStatus = (entry, newStatus) => {
        if (!entry) return;
        const fromStatus = entry.status || 'pending';
        if (fromStatus === newStatus) return;
        if (fromStatus === 'pending' && newStatus === 'approved') return askApprovePto(entry);
        if (fromStatus === 'pending' && newStatus === 'denied') return askDenyPto(entry);
        const start = entry.startDate || entry.date;
        const end = entry.endDate || entry.date;
        const range = start + (end !== start ? ` → ${end}` : '');
        const fromEs = fromStatus === 'approved' ? 'aprobado' : fromStatus === 'denied' ? 'negado' : 'pendiente';
        let title, body, confirmLabel, tone = 'primary';
        if (newStatus === 'approved') {
            // Same uncovered-shift warning as askApprovePto — approving PTO
            // over published shifts orphans them no matter which path got here.
            const conflicts = shifts.filter(sh =>
                sh.staffName === entry.staffName && sh.published !== false &&
                sh.date >= start && sh.date <= end);
            title = tx('Change to approved?', '¿Cambiar a aprobado?');
            body = tx(
                `${entry.staffName}'s time-off for ${range} is currently ${fromStatus} — approve it instead? They will be notified.`,
                `El tiempo libre de ${entry.staffName} del ${range} está ${fromEs} — ¿aprobarlo? Será notificado.`
            );
            if (conflicts.length > 0) {
                const lines = conflicts.slice(0, 6).map(sh =>
                    `· ${sh.date} ${formatTime12h(sh.startTime)}–${formatTime12h(sh.endTime)}`
                ).join('\n');
                const more = conflicts.length > 6 ? tx(`\n· ...and ${conflicts.length - 6} more`, `\n· ...y ${conflicts.length - 6} más`) : '';
                body += tx(
                    `\n\n⚠️ This will leave ${conflicts.length} published shift(s) UNCOVERED:\n${lines}${more}\n\nYou will need to reassign these.`,
                    `\n\n⚠️ Esto dejará ${conflicts.length} turno(s) SIN CUBRIR:\n${lines}${more}\n\nTendrás que reasignarlos.`
                );
                tone = 'danger';
            }
            confirmLabel = tx('Approve', 'Aprobar');
        } else if (newStatus === 'denied') {
            title = tx('Change to denied?', '¿Cambiar a negado?');
            body = fromStatus === 'approved'
                ? tx(
                    `${entry.staffName}'s time-off for ${range} is currently APPROVED. Deny it instead? They will be notified — they may have already made plans.`,
                    `El tiempo libre de ${entry.staffName} del ${range} está APROBADO. ¿Negarlo? Será notificado — puede que ya tenga planes.`
                )
                : tx(
                    `Deny ${entry.staffName}'s time-off for ${range}? They will be notified.`,
                    `¿Negar el tiempo libre de ${entry.staffName} del ${range}? Será notificado.`
                );
            confirmLabel = tx('Deny', 'Negar');
            tone = 'danger';
        } else {
            title = tx('Send back to pending?', '¿Devolver a pendiente?');
            body = tx(
                `${entry.staffName}'s time-off for ${range} (currently ${fromStatus}) will go back to the pending queue for a fresh decision. They will be notified.`,
                `El tiempo libre de ${entry.staffName} del ${range} (ahora ${fromEs}) volverá a la cola de pendientes. Será notificado.`
            );
            confirmLabel = tx('Back to pending', 'A pendiente');
        }
        setConfirmDialog({
            title, body, confirmLabel, tone,
            onConfirm: () => handleChangePtoStatus(entry, newStatus),
        });
    };

    const askCancelOwnPto = (entry) => {
        if (!entry) return;
        const status = entry.status || 'pending';
        const range = (entry.startDate || entry.date) + (entry.endDate && entry.endDate !== entry.startDate ? ` → ${entry.endDate}` : '');
        // Denied entries skip confirmation (silent dismiss) — matches the
        // old native-confirm behavior in handleCancelOwnPto.
        if (status === 'denied') {
            handleCancelOwnPto(entry);
            return;
        }
        setConfirmDialog({
            title: status === 'approved'
                ? tx('Withdraw this approved time-off?', '¿Retirar este tiempo libre aprobado?')
                : tx('Cancel this pending request?', '¿Cancelar esta solicitud pendiente?'),
            body: status === 'approved'
                ? tx(
                    `Your manager will be notified so they can re-schedule you for ${range}.`,
                    `Tu gerente será notificado para volver a programarte para ${range}.`
                )
                : tx(
                    `Your request for ${range} will be removed.`,
                    `Tu solicitud para ${range} será eliminada.`
                ),
            confirmLabel: status === 'approved' ? tx('Withdraw', 'Retirar') : tx('Cancel request', 'Cancelar'),
            tone: 'danger',
            onConfirm: () => handleCancelOwnPto(entry),
        });
    };
    const askDropShift = (shiftId, newStaffName, newDate) => {
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) return;
        if (shift.staffName === newStaffName && shift.date === newDate) return; // no-op
        // Hard-reject guards (closed date / PTO) stay as toast — those
        // are not "are you sure?" questions, they're rejections.
        if (dateClosed(newDate)) {
            toast(tx('Cannot drop on a closed date.', 'No puedes soltar en una fecha cerrada.'));
            return;
        }
        if (isStaffOffOn(newStaffName, newDate)) {
            toast(tx(`${newStaffName} is on approved time-off that date.`, `${newStaffName} tiene tiempo libre aprobado esa fecha.`));
            return;
        }
        const detail = `${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)}`;
        setConfirmDialog({
            title: tx('Move shift?', '¿Mover turno?'),
            body: tx(
                `Move ${shift.staffName}'s ${shift.date} ${detail} shift to ${newDate} (${newStaffName}).`,
                `Mover el turno de ${shift.staffName} del ${shift.date} ${detail} al ${newDate} (${newStaffName}).`
            ),
            confirmLabel: tx('Move', 'Mover'),
            tone: 'primary',
            onConfirm: () => handleDropShift(shiftId, newStaffName, newDate),
        });
    };

    // Hours/conflict helpers for TakeShiftModal — show the picker what
    // taking the shift would do to their week and warn about overlaps.
    // Both run only when the modal is mounted, so cost is bounded.
    const computeWeeklyHoursFor = (targetDate) => {
        if (!targetDate || !staffName) return 0;
        const d = parseLocalDate(targetDate);
        if (!d) return 0;
        const dayOfWeek = d.getDay();
        const wStart = addDays(d, -dayOfWeek);
        const wEnd = addDays(wStart, 7);
        const wStartStr = toDateStr(wStart);
        const wEndStr = toDateStr(wEnd);
        let hours = 0;
        for (const sh of shifts) {
            if (sh.staffName !== staffName) continue;
            if (sh.published === false) continue;
            if (sh.date < wStartStr || sh.date >= wEndStr) continue;
            hours += hoursBetween(sh.startTime, sh.endTime, !!sh.isDouble);
        }
        return hours;
    };
    const computeConflictsFor = (targetShift) => {
        if (!targetShift || !staffName) return [];
        return shifts.filter(sh =>
            sh.staffName === staffName &&
            sh.id !== targetShift.id &&
            sh.date === targetShift.date &&
            sh.startTime < targetShift.endTime &&
            sh.endTime > targetShift.startTime
        );
    };

    // ── Stable callbacks for WeeklyGrid (2026-06-14 perf, item #8) ──────
    // WeeklyGrid is React.memo'd below. For that memo to actually skip
    // re-renders, every function prop it receives must keep a stable
    // identity across parent re-renders. These useStableCallback wrappers
    // give a constant identity but always invoke the latest closure (so
    // they read fresh state at call time) — no dependency arrays, no
    // stale-closure risk. The underlying handler bodies are untouched.
    // The three "selector" wrappers (isStaffOffOn / dateHasOpenOverride /
    // dateClosedByRecurring) are called during WeeklyGrid's render; their
    // backing data is also passed as props (timeOff / blocksByDate /
    // closedWeekdays) so the memo still invalidates when that data moves.
    const onFillSlotCb = useStableCallback((n) => {
        if (canEdit) {
            setFillingNeed(n);
            setAvailableForDate(n.date);
        } else {
            toast(tx(
                `Open ${formatTime12h(n.startTime)}–${formatTime12h(n.endTime)} slot on ${n.date}. Ask a manager to assign you.`,
                `Espacio abierto ${formatTime12h(n.startTime)}–${formatTime12h(n.endTime)} el ${n.date}. Pídele al gerente que te asigne.`
            ));
        }
    });
    const onAddSlotCb = useStableCallback((dStr) => { setPrefillNeedDate(dStr); setShowNeedModal(true); });
    const onCellClickCb = useStableCallback((staff, dateStr) => {
        if (!canEdit) return;
        if (dateClosed(dateStr)) {
            toast(tx('Restaurant is marked closed on this date.', 'El restaurante está marcado como cerrado en esta fecha.'));
            return;
        }
        if (isStaffOffOn(staff.name, dateStr)) {
            toast(tx(`${staff.name} is on approved time-off for this date.`, `${staff.name} tiene tiempo libre aprobado para esta fecha.`));
            return;
        }
        const matchingNeeds = staffingNeeds.filter(n =>
            n.date === dateStr &&
            n.side === side &&
            (storeLocation === 'both' || n.location === 'both' || n.location === storeLocation || n.location === staff.location) &&
            ((n.filledStaff || []).length < (n.count || 0)) &&
            isRoleEligible(staff.role, n.roleGroup) &&
            !((n.filledStaff || []).includes(staff.name))
        );
        if (matchingNeeds.length > 0) {
            setFillSlotChooser({ staff, dateStr, needs: matchingNeeds });
        } else {
            setQuickAddCell({ staff, dateStr });
        }
    });
    const onQuickAddSelectCb = useStableCallback((preset) => {
        if (!quickAddCell) return;
        const { staff, dateStr } = quickAddCell;
        const inferredSide = resolveStaffSide(staff);
        handleAddShift({
            staffName: staff.name,
            date: dateStr,
            startTime: preset.start,
            endTime: preset.end,
            location: (staff.location && staff.location !== 'both')
                ? staff.location
                : (storeLocation !== 'both' ? storeLocation : 'webster'),
            side: inferredSide,
            isShiftLead: !!staff.shiftLead,
            isDouble: !!preset.isDouble,
            notes: '',
        });
        setQuickAddCell(null);
    });
    const onQuickAddCustomCb = useStableCallback(() => {
        if (!quickAddCell) return;
        const { staff, dateStr } = quickAddCell;
        setQuickAddCell(null);
        openAddModal({ staffName: staff.name, date: dateStr, location: staff.location });
    });
    const onQuickAddCloseCb = useStableCallback(() => setQuickAddCell(null));
    const onStaffClickCb = useStableCallback((name) => setPersonFilter(name));
    const onPtoChipClickCb = useStableCallback((sn, dStr) => setPtoChipTarget({ staffName: sn, dateStr: dStr }));
    const onDayHeaderClickCb = useStableCallback((dStr) => setAvailableForDate(dStr));
    const onToggleShiftSelectionCb = useStableCallback(toggleShiftSelection);
    const onDeleteShiftCb = useStableCallback(handleDeleteShift);
    // Double-click a cube → open the edit modal (clears any pending move).
    const requestEditShift = (shift) => { setMovingShift(null); setEditingShift(shift); };
    // Move mode: after the user picks a destination person-day, reuse the
    // proven askDropShift confirm ("Move X's shift to (name)?") + handleDropShift.
    const handleMoveToCell = (targetStaffName, dateStr) => {
        const sh = movingShift;
        setMovingShift(null);
        if (sh) askDropShift(sh.id, targetStaffName, dateStr);
    };
    const onEditShiftCb = useStableCallback(requestEditShift);
    const onMoveToCellCb = useStableCallback(handleMoveToCell);
    const onOfferShiftCb = useStableCallback(handleOfferShift);
    const onTakeShiftCb = useStableCallback(handleTakeShift);
    const onCancelOfferCb = useStableCallback(askCancelOffer);
    const onRequestCoverCb = useStableCallback(handleRequestCover);
    const onDropShiftCb = useStableCallback(askDropShift);
    const onUpdateShiftTimesCb = useStableCallback(handleUpdateShiftTimes);
    const onToggleDateOpenCb = useStableCallback(handleToggleDateOpen);
    const isStaffOffOnCb = useStableCallback(isStaffOffOn);
    const dateHasOpenOverrideCb = useStableCallback(dateHasOpenOverride);
    const dateClosedByRecurringCb = useStableCallback(dateClosedByRecurring);

    // ── Render ──
    return (
        <div className="p-4 pb-bottom-nav print:p-2 print:pb-0">
            {/* Inline print stylesheet — keep schedule readable on paper */}
            <style>{`
                @media print {
                    @page { margin: 0.4in; }
                    /* Force the role-tinted cube backgrounds to print (Cmd+P
                       of the live page) — browsers strip bg colors otherwise. */
                    body { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                    .print\\:hidden { display: none !important; }
                    .schedule-grid-wrap { overflow: visible !important; }
                    .schedule-grid-wrap table { font-size: 9px !important; }
                    .schedule-shift-cube button { display: none !important; }
                }
            `}</style>

            {/* v2-themed title row + bell + location pill. Bigger type,
                cleaner hierarchy, matches HomeV2 typography. */}
            <div className="flex items-start justify-between mb-4 print:hidden">
                <div>
                    <h2 className="text-2xl font-bold text-dd-text">📅 {tx('Schedule', 'Horario')}</h2>
                    <p className="text-xs text-dd-text-2 mt-0.5 flex items-center gap-2 flex-wrap">
                        <span>📍 {LOCATION_LABELS[storeLocation] || storeLocation} · {side === 'foh' ? tx('Front of House', 'Servicio') : tx('Back of House', 'Cocina')}</span>
                        {/* Cache + freshness indicator. Shown only after the
                            page has settled (no flash on cold load). Three
                            states:
                              • usingCache=true → amber pill: "Cached · 4m old".
                                User is looking at last-known schedule until
                                Firestore answers. Disappears on first live tick.
                              • liveAt set, no cache flag → green dot + "Live ·
                                synced 30s ago". Roll-forward keeps the user
                                aware the feed is current.
                              • Neither → render nothing (cold load skeleton
                                covers that case visually). */}
                        {scheduleCacheStatus.usingCache ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-[10px] font-bold">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                {tx('Cached', 'Caché')}
                            </span>
                        ) : scheduleCacheStatus.liveAt ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-[10px] font-bold" title={tx('Last live update', 'Última actualización en vivo')}>
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                {tx('Live', 'En vivo')}
                            </span>
                        ) : null}
                        {/* Conflict count — surfaces overlapping shifts
                            (same staff, same date, overlapping times)
                            that managers might otherwise discover at
                            clock-in. The tooltip lists the affected
                            staff + date so admin can jump straight
                            to them. Hidden when there are no
                            conflicts so a clean week doesn't show a
                            zero-state pill. */}
                        {scheduleConflicts.length > 0 && (
                            <span
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-700 text-[10px] font-bold"
                                title={scheduleConflicts.slice(0, 5).map(c => `${c.staffName} · ${c.date} · ${c.label}`).join('\n')}>
                                <span>⚠️</span>
                                {scheduleConflicts.length} {scheduleConflicts.length === 1 ? tx('conflict', 'conflicto') : tx('conflicts', 'conflictos')}
                            </span>
                        )}
                    </p>
                </div>
                {/* Schedule's own notification bell — opens the schedule-specific
                    notif drawer (shift offers / swap approvals / PTO updates).
                    Distinct from the v2 header's global bell, but visually
                    redundant when both are on screen. Only shown when there
                    ARE unread notifs so users don't see two bells in normal
                    operation. */}
                {unreadCount > 0 && (
                    <button onClick={() => setShowNotifDrawer(true)}
                        title="Schedule notifications"
                        className="relative p-2 rounded-lg glass-sheet hover:bg-dd-bg transition shadow-card">
                        <Bell size={18} strokeWidth={2.25} aria-hidden="true" className="text-dd-green-700" />
                        <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                            {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                    </button>
                )}
            </div>

            {/* FOH / BOH segmented control — matches the v2 segmented pattern
                from HomeV2's "All/FOH/BOH" filter on upcoming shifts.
                2026-05-24 — Andrew: hidden for single-side staff. They
                already landed on their side at mount time (state init
                above); the toggle would only let them peek at the
                other side, which adds confusion. Admins and explicit
                'both'-side staff still see + use it. */}
            {(staffIsAdmin || _viewerIsBothSide) && (
                <div className="flex gap-1 mb-3 glass-sheet rounded-lg p-1 print:hidden">
                    <button onClick={() => setSide('foh')}
                        className={`flex-1 py-2 rounded-md text-sm font-bold transition flex items-center justify-center gap-1.5 ${side === 'foh' ? 'bg-dd-green/90 text-white shadow-sm backdrop-blur-sm' : 'text-dd-text-2 hover:bg-dd-bg'}`}>
                        <Sofa size={16} strokeWidth={2.25} aria-hidden="true"
                            className={side === 'foh' ? 'text-white' : 'text-dd-green-700'} />
                        {tx('Front of House', 'Servicio')}
                    </button>
                    <button onClick={() => setSide('boh')}
                        className={`flex-1 py-2 rounded-md text-sm font-bold transition flex items-center justify-center gap-1.5 ${side === 'boh' ? 'bg-orange-600/90 text-white shadow-sm backdrop-blur-sm' : 'text-dd-text-2 hover:bg-dd-bg'}`}>
                        <Utensils size={16} strokeWidth={2.25} aria-hidden="true"
                            className={side === 'boh' ? 'text-white' : 'text-dd-green-700'} />
                        {tx('Back of House', 'Cocina')}
                    </button>
                </div>
            )}

            {/* Week navigator */}
            <WeekNav weekStart={weekStart} setWeekStart={setWeekStart} isEn={isEn} />

            {/* 2026-05-30 — Andrew "small Month button on the left of
                the Week button, about 1/3 the Week buttons size, opens
                a month-calendar window." Icon-only Month pill sits to
                the LEFT of the segmented view-mode control; tapping
                opens the MonthMiniCal in a modal. View modes (Week /
                Day / List / Time Off) stay flex-1 inside their own
                segmented control to the right. */}
            <div className="flex items-stretch gap-1 mb-3 print:hidden">
                <button
                    type="button"
                    onClick={() => setShowMonthModal(true)}
                    aria-label={tx('Open month calendar', 'Abrir calendario mensual')}
                    title={tx('Month calendar', 'Calendario mensual')}
                    className="shrink-0 glass-sheet rounded-lg px-3 inline-flex items-center justify-center text-dd-green-700 hover:bg-dd-bg transition active:scale-95"
                >
                    <Calendar size={16} strokeWidth={2.25} aria-hidden="true" />
                </button>
                <div className="flex flex-1 gap-1 glass-sheet rounded-lg p-1">
                    {[
                        { key: 'grid', labelEn: 'Week', labelEs: 'Semana', Icon: LayoutGrid },
                        { key: 'day',  labelEn: 'Day',  labelEs: 'Día',    Icon: LayoutList },
                        { key: 'list', labelEn: 'List', labelEs: 'Lista',  Icon: List },
                        { key: 'pto',  labelEn: 'Time Off', labelEs: 'Tiempo libre', Icon: Palmtree },
                    ].map(v => {
                        const Icon = v.Icon;
                        const isActive = viewMode === v.key;
                        return (
                            <button key={v.key} onClick={() => setViewMode(v.key)}
                                className={`flex-1 py-1.5 rounded-md text-xs font-bold transition inline-flex items-center justify-center gap-1 ${isActive ? 'bg-dd-green/90 text-white shadow-sm backdrop-blur-sm' : 'text-dd-text-2 hover:bg-dd-bg'}`}>
                                <Icon size={14} strokeWidth={2.25} aria-hidden="true"
                                    className={isActive ? 'text-white' : 'text-dd-green-700'} />
                                {tx(v.labelEn, v.labelEs)}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Mobile "fit to screen" zoom toggle — only relevant for
                the Week grid view and only on phones (the desktop
                grid already fits the screen). Tapping shrinks the
                full week × all staff to fit the viewport for an
                at-a-glance overview, then tap again to return to the
                normal scrollable size. Andrew 2026-05-22. */}
            {viewMode === 'grid' && (
                <button onClick={() => setGridFitToScreen(v => !v)}
                    className={`md:hidden w-full flex items-center justify-center gap-2 py-1.5 mb-3 rounded-lg border text-xs font-bold transition print:hidden ${
                        gridFitToScreen
                            ? 'bg-dd-green/90 text-white border-dd-green backdrop-blur-sm'
                            : 'glass-sheet text-dd-text-2 hover:bg-dd-bg'
                    }`}>
                    <Search size={14} strokeWidth={2.25} aria-hidden="true"
                        className={gridFitToScreen ? 'text-white' : 'text-dd-green-700'} />
                    {gridFitToScreen
                        ? tx('Overview — pinch to zoom in · tap to exit', 'Vista general — pellizca para acercar · toca para salir')
                        : tx('Overview: fit week to screen', 'Vista general: ajustar semana a pantalla')}
                </button>
            )}

            {/* "My Schedule" quick-toggle button — Andrew (2026-05-17):
                "i want a my schedule button. so a staff member can see
                only their schedule." One-tap shortcut to filter every
                view to just the viewer's own shifts. Toggle behavior:
                tap to filter, tap again to clear. Works alongside the
                detailed person-dropdown filter in the action bar below
                — both write to the same personFilter state. Visible to
                everyone (managers also benefit from a quick "show me
                just my own shifts" shortcut). */}
            {staffName && (
                <div className="mb-3 flex print:hidden">
                    <button
                        onClick={() => setPersonFilter(personFilter === staffName ? null : staffName)}
                        className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-black transition shadow-sm active:scale-[0.99] ${
                            personFilter === staffName
                                ? 'bg-dd-green/90 text-white hover:bg-dd-green-700 backdrop-blur-sm'
                                : 'glass-sheet border-2 !border-dd-green/40 text-dd-green hover:bg-dd-sage-50'
                        }`}
                        title={personFilter === staffName
                            ? tx('Tap to see everyone', 'Toca para ver a todos')
                            : tx('Tap to see only your shifts', 'Toca para ver solo tus turnos')}
                    >
                        <User size={16} strokeWidth={2.25} aria-hidden="true"
                            className={personFilter === staffName ? 'text-white' : 'text-dd-green-700'} />
                        <span>
                            {personFilter === staffName
                                ? tx('Showing my shifts · tap to clear', 'Mostrando mis turnos · toca para quitar')
                                : tx('My Schedule', 'Mi Horario')}
                        </span>
                    </button>
                </div>
            )}

            {/* Action bar — v2 button hierarchy.
                  PRIMARY (dd-green):  Publish (when drafts exist), + Shift
                  SECONDARY (white):   Print, iCal, person filter, "More" toggle
                  TERTIARY (subtle):   Request Off, My Avail, All PTO, Auto-fill,
                                        Recurring, Copy, Blackouts, Templates, + Slot
                Two flat rows of equal-weight pills replaced by a single primary
                row + a "More" expander on mobile. */}
            <div className="flex flex-wrap gap-2 mb-3 print:hidden">
                {/* View / person filter — wrapped in a labeled control so it
                    reads as an interactive picker instead of a generic input.
                    On mobile the wrapper expands full-width so the names list
                    is easy to scroll. */}
                <label className="flex-1 min-w-[180px] flex items-center gap-2 glass-sheet rounded-lg px-3 py-1.5 hover:border-dd-green/40 focus-within:border-dd-green focus-within:ring-2 focus-within:ring-dd-green-50 transition cursor-pointer">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 whitespace-nowrap">
                        {tx('View', 'Ver')}:
                    </span>
                    <select value={personFilter || ''}
                        onChange={(e) => setPersonFilter(e.target.value || null)}
                        className="flex-1 min-w-0 bg-transparent text-sm font-bold text-dd-text focus:outline-none cursor-pointer truncate">
                        <option value="">{tx('Everyone', 'Todos')} ({sideStaff.length})</option>
                        {sideStaff.map(s => (
                            <option key={s.id || s.name} value={s.name}>{s.name}</option>
                        ))}
                    </select>
                    <span className="text-dd-text-2 text-xs">▾</span>
                </label>
                {/* PRIMARY group — Publish + Add Shift always visible.
                    Reorganized 2026-05-10: was a single flat row of 13
                    equal-weight buttons that wrapped to 2-3 lines and
                    overwhelmed the page. Now: ONE primary group + ONE
                    "More" dropdown that holds everything else. */}
                {canEdit && (() => {
                    const draftCount = visibleShifts.filter(s => s.published === false).length;
                    return (
                    <>
                        <button onClick={handlePublishDrafts}
                            title={tx('Publish all draft shifts in current week + side', 'Publicar todos los borradores')}
                            className={`relative inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition shadow-sm ${draftCount > 0 ? 'bg-dd-green/90 text-white hover:bg-dd-green-700 animate-pulse backdrop-blur-sm' : 'glass-sheet text-dd-text-2'}`}>
                            <Megaphone size={14} strokeWidth={2.25} aria-hidden="true"
                                className={draftCount > 0 ? 'text-white' : 'text-dd-green-700'} />
                            {tx('Publish', 'Publicar')}
                            {draftCount > 0 && (
                                <span className="bg-amber-400 text-amber-950 text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                                    {draftCount}
                                </span>
                            )}
                        </button>
                        <button onClick={() => openAddModal()}
                            className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-dd-green/90 text-white text-xs font-bold hover:bg-dd-green-700 shadow-sm backdrop-blur-sm active:scale-95 transition">
                            <Plus size={14} strokeWidth={2.5} aria-hidden="true" />
                            {tx('Shift', 'Turno')}
                        </button>
                    </>
                    );
                })()}

                {/* MORE menu — single dropdown holding everything secondary.
                    Replaces the old "13 chips wrap to 3 rows" mess. Click
                    opens a popover with grouped sections (Tools / My
                    actions / Admin). */}
                <div className="relative">
                    <button ref={moreBtnRef} onClick={() => setShowMoreActions(s => !s)}
                        className="px-4 py-2 rounded-lg glass-sheet text-dd-text hover:bg-dd-bg active:scale-95 text-xs font-semibold flex items-center gap-1.5 transition">
                        <MoreHorizontal size={14} strokeWidth={2.25} aria-hidden="true"
                            className="text-dd-green-700" />
                        {tx('More', 'Más')}
                        <ChevronDown size={10} strokeWidth={2.5} aria-hidden="true"
                            className={`text-dd-green-700 transition-transform ${showMoreActions ? 'rotate-180' : ''}`} />
                    </button>
                    {showMoreActions && createPortal((
                        <>
                            {/* Click-outside backdrop */}
                            <div className="fixed inset-0 z-30" onClick={() => setShowMoreActions(false)} />
                            {/* Fixed-positioned popover with viewport-clamped
                                coords (see moreBtnRef + moreMenuPos effect
                                above). Stays in the visible viewport on
                                every screen size — previously we used
                                `absolute right-0` which clipped on mobile
                                when the More button was anywhere except the
                                far right edge. Max-height is JS-driven so
                                the menu always fits below the button;
                                internal scroll picks up the rest.

                                2026-05-28 — Portal-mount via createPortal()
                                to document.body. Without this, an ancestor
                                up the chain (the WeekNav wrapper has
                                .bg-dd-surface.border.border-dd-line.rounded-xl.shadow-card
                                which the index.css auto-port rule decorates
                                with `backdrop-filter: blur(20px)`) becomes
                                the containing block for our `position:
                                fixed` per CSS spec, and the menu drifts
                                ~70px below where its inline `top` says it
                                should be — pushing the menu off-screen on
                                mobile. Portal'd into <body> the popover's
                                containing block is the viewport again and
                                getBoundingClientRect coords land exactly. */}
                            <div
                                style={{
                                    position: 'fixed',
                                    left: `${moreMenuPos.left}px`,
                                    top: `${moreMenuPos.top}px`,
                                    maxHeight: `${moreMenuMaxH}px`,
                                    maxWidth: 'calc(100vw - 24px)',
                                }}
                                className="w-64 glass-sheet rounded-xl shadow-card-hov z-40 overflow-y-auto">
                                {/* TOOLS */}
                                <div className="px-3 py-2 border-b border-dd-line">
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">{tx('Tools', 'Herramientas')}</div>
                                    <button onClick={() => { setShowMoreActions(false); handlePrintWeek(); }}
                                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                        <span className="w-6 h-6 rounded-md bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                            <Printer size={12} strokeWidth={2.25} aria-hidden="true" />
                                        </span>
                                        {personFilter ? tx('Print', 'Imprimir') : tx('Print Week', 'Imprimir Semana')}
                                    </button>
                                    <button onClick={() => { setShowMoreActions(false); handleExportIcs(); }}
                                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                        <span className="w-6 h-6 rounded-md bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                            <Calendar size={12} strokeWidth={2.25} aria-hidden="true" />
                                        </span>
                                        {tx('Export iCal', 'Exportar iCal')}
                                    </button>
                                </div>
                                {/* MY ACTIONS */}
                                <div className="px-3 py-2 border-b border-dd-line">
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">{tx('My Actions', 'Mis Acciones')}</div>
                                    <button onClick={() => { setShowMoreActions(false); setShowPtoRequestModal(true); }}
                                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                        <span className="w-6 h-6 rounded-md bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                            <Palmtree size={12} strokeWidth={2.25} aria-hidden="true" />
                                        </span>
                                        {tx('Request Time Off', 'Pedir Tiempo Libre')}
                                    </button>
                                    <button onClick={() => { setShowMoreActions(false); setShowMyAvailModal(true); }}
                                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                        <span>🗓</span>{tx('My Availability', 'Mi Disponibilidad')}
                                    </button>
                                    {/* My Birthday — self-serve. Anyone can set
                                        their own MM-DD. Drives the auto-derived
                                        birthday chip on the schedule events strip. */}
                                    <button onClick={() => { setShowMoreActions(false); setShowMyBirthdayModal(true); }}
                                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                        <span>🎂</span>{tx('My Birthday', 'Mi Cumpleaños')}
                                    </button>
                                    {/* Shift swap — direct trade with a teammate.
                                        Distinct from "offer to market" (open swap)
                                        which uses the cube's per-shift offer
                                        menu. This is the picker-flow swap. */}
                                    <button onClick={() => { setShowMoreActions(false); setShowSwapModal(true); }}
                                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                        <span>🔄</span>{tx('Swap a Shift', 'Cambiar un Turno')}
                                    </button>
                                </div>
                                {/* ADMIN */}
                                {canEdit && (
                                    <div className="px-3 py-2">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">{tx('Admin', 'Administración')}</div>
                                        <button onClick={() => { setShowMoreActions(false); handleAutoPopulate(); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-sage-50 flex items-center gap-2 text-sm text-dd-green-700 font-semibold">
                                            <span>✨</span>{tx('Auto-fill week', 'Auto-rellenar')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); setShowNeedModal(true); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span className="w-6 h-6 rounded-md bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                                <Users size={12} strokeWidth={2.25} aria-hidden="true" />
                                            </span>
                                            {tx('Add open slot', 'Agregar espacio')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); setShowTimeOffModal(true); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span className="w-6 h-6 rounded-md bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                                <Palmtree size={12} strokeWidth={2.25} aria-hidden="true" />
                                            </span>
                                            {tx('All Time Off requests', 'Todas las solicitudes')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); handleCopyLastWeek(); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span className="w-6 h-6 rounded-md bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                                <Copy size={12} strokeWidth={2.25} aria-hidden="true" />
                                            </span>
                                            {tx('Copy last week', 'Copiar semana anterior')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); setShowApplyTemplate(true); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span className="w-6 h-6 rounded-md bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                                <LayoutGrid size={12} strokeWidth={2.25} aria-hidden="true" />
                                            </span>
                                            {tx('Apply template', 'Aplicar plantilla')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); setShowRecurringModal(true); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span className="w-6 h-6 rounded-md bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                                <Repeat size={12} strokeWidth={2.25} aria-hidden="true" />
                                            </span>
                                            {tx('Recurring shifts', 'Turnos recurrentes')}
                                        </button>
                                        {/* Closures & Calendar entry — admin-only.
                                            Hides the button entirely for non-admin
                                            schedule editors so they don't see a
                                            no-op tap target. */}
                                        {staffIsAdmin && (
                                            <button onClick={() => { setShowMoreActions(false); setShowBlockModal(true); }}
                                                className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                                <span className="w-6 h-6 rounded-md bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                                    <Ban size={12} strokeWidth={2.25} aria-hidden="true" />
                                                </span>
                                                {tx('Closures & Calendar', 'Cierres y Calendario')}
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </>
                    ), document.body)}
                </div>
            </div>
            {personFilter && (
                <div className="mb-3 px-3 py-2 rounded-lg bg-dd-green-50 border border-dd-green/30 text-xs text-dd-green-700 flex items-center justify-between print:hidden shadow-sm">
                    <span className="font-semibold">👤 {tx('Showing only:', 'Mostrando solo:')} <b>{personFilter}</b></span>
                    <button onClick={() => setPersonFilter(null)}
                        className="px-2 py-1 rounded-md bg-white border border-dd-green/30 text-dd-green-700 font-bold hover:bg-dd-sage-50 transition text-[11px]">
                        {tx('Show all', 'Mostrar todos')}
                    </button>
                </div>
            )}
            {/* Print-only header so the printout has context */}
            <div className="hidden print:block mb-2">
                <div className="font-bold text-lg">DD Mau Schedule — {side === 'foh' ? 'Front of House' : 'Back of House'} — {LOCATION_LABELS[storeLocation] || storeLocation}</div>
                <div className="text-sm">{personFilter ? `For: ${personFilter}` : 'All staff'}</div>
            </div>

            {/* Staffing-needs banner — open slots for the current week, side-filtered.
                Visible to managers/admin only. Tap 'Fill 1' to open the available-staff picker. */}
            {canEdit && (() => {
                const weekStartStr = toDateStr(weekStart);
                const weekEndStr = toDateStr(addDays(weekStart, 7));
                const weekNeeds = staffingNeeds.filter(n =>
                    n.date >= weekStartStr && n.date < weekEndStr &&
                    (storeLocation === 'both' || n.location === 'both' || n.location === storeLocation) &&
                    (n.side === side)
                ).sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
                if (weekNeeds.length === 0) return null;
                // 2026-05-15 — Andrew: "the open staffing slots is too big.
                // lets make the lines shorter no need for all that."
                // Compacted from a 4-line-per-row card (title + stats + filled
                // chips + 3 stacked buttons) to a single-line row with icon
                // action buttons. Drops the location string (always matches
                // the current page anyway), drops the "of"/"filled" words
                // (the X/Y ratio reads fine on its own), and stacks filled-
                // staff chips below only when present. Times shortened too
                // (9:00 AM → 9a, 9:30 AM → 9:30a).
                const shortTime = (t) => {
                    if (!t) return '';
                    const [h, m] = t.split(':').map(Number);
                    const period = h >= 12 ? 'p' : 'a';
                    const h12 = ((h + 11) % 12) + 1;
                    return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
                };
                // 2026-05-27 — header strip is now a tappable toggle.
                // Collapsed by default (saves a bunch of mobile real
                // estate); expanded state persists in localStorage. When
                // collapsed, only the row count + a chevron show; tapping
                // anywhere on the strip flips the state. When expanded,
                // the slot list renders underneath.
                const openCount = weekNeeds.reduce((acc, n) => {
                    const filled = (n.filledStaff || []).length;
                    return acc + Math.max(0, (n.count || 0) - filled);
                }, 0);
                return (
                    <div className="mb-3 rounded-xl glass-sheet shadow-card overflow-hidden">
                        <button
                            type="button"
                            onClick={() => setOpenSlotsExpanded(v => !v)}
                            className="w-full flex items-center gap-2 p-2 hover:bg-dd-bg/40 active:bg-dd-bg/60 transition-colors text-left"
                            aria-expanded={openSlotsExpanded}
                            aria-controls="open-slots-list"
                        >
                            <span className="w-1 h-4 bg-blue-500 rounded-full shrink-0" />
                            <h3 className="text-xs font-bold text-dd-text inline-flex items-center gap-2">
                                <span className="w-6 h-6 rounded-md bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                    <Users size={12} strokeWidth={2.25} aria-hidden="true" />
                                </span>
                                {tx('Open slots', 'Abiertos')}
                            </h3>
                            <span className="text-[10px] font-bold text-dd-text-2">{side === 'foh' ? 'FOH' : 'BOH'} · {weekNeeds.length}</span>
                            {openCount > 0 && (
                                <span className="text-[10px] font-bold text-amber-700 bg-amber-100 border border-amber-300 px-1.5 py-0.5 rounded-full">
                                    {openCount} {tx('unfilled', 'sin llenar')}
                                </span>
                            )}
                            <span className={`ml-auto text-dd-text-2/60 text-xs shrink-0 transition-transform duration-glass-fast ease-glass-out ${openSlotsExpanded ? 'rotate-180' : ''}`} aria-hidden="true">
                                ▾
                            </span>
                        </button>
                        {openSlotsExpanded && (
                        <div id="open-slots-list" className="space-y-1 px-2 pb-2">
                            {weekNeeds.map(n => {
                                const filled = (n.filledStaff || []).length;
                                const open = Math.max(0, (n.count || 0) - filled);
                                const overFilled = filled > (n.count || 0);
                                const fullyStaffed = open === 0 && !overFilled;
                                const date = parseLocalDate(n.date);
                                const dayLabel = date ? (isEn ? DAYS_EN : DAYS_ES)[date.getDay()] : '';
                                const dayShort = date ? `${date.getMonth() + 1}/${date.getDate()}` : '';
                                const roleGroup = n.roleGroup ? SLOT_ROLE_BY_ID[n.roleGroup] : null;
                                return (
                                    <div key={n.id} className={`px-2 py-1 rounded-md border text-xs ${overFilled ? 'bg-red-50 border-red-200' : fullyStaffed ? 'bg-dd-green-50 border-dd-green/30' : 'bg-dd-bg border-dd-line'}`}>
                                        <div className="flex items-center gap-1.5">
                                            <span className="font-bold text-gray-800 truncate flex-1 min-w-0">
                                                {overFilled ? '⚠️' : fullyStaffed ? '✅' : ''}
                                                {' '}{dayLabel} {dayShort} · {shortTime(n.startTime)}–{shortTime(n.endTime)}
                                                {roleGroup && roleGroup.id !== 'any' && (
                                                    <span className="ml-1 text-blue-700 font-bold">{roleGroup.emoji}</span>
                                                )}
                                            </span>
                                            <span className={`font-mono text-[11px] flex-shrink-0 ${overFilled ? 'text-red-700 font-bold' : 'text-gray-600'}`}>
                                                {filled}/{n.count}{overFilled && '!'}
                                            </span>
                                            {n.notes && (
                                                <span className="italic text-gray-500 text-[10px] truncate max-w-[80px]" title={n.notes}>({n.notes})</span>
                                            )}
                                            <div className="flex gap-0.5 flex-shrink-0">
                                                {!fullyStaffed && (
                                                    <button onClick={() => { setFillingNeed(n); setAvailableForDate(n.date); }}
                                                        title={tx('Fill', 'Llenar')}
                                                        className="px-2 py-0.5 rounded bg-dd-green text-white text-[10px] font-bold hover:bg-dd-green-700">
                                                        {tx('Fill', 'Llenar')}
                                                    </button>
                                                )}
                                                <button onClick={() => setEditingNeed(n)}
                                                    title={tx('Edit slot times / count', 'Editar horario / cantidad')}
                                                    className="px-1.5 py-0.5 rounded glass-sheet text-dd-text-2 text-[10px] hover:bg-dd-bg">✏</button>
                                                <button onClick={() => handleRemoveNeed(n.id)}
                                                    title={tx('Remove slot', 'Eliminar')}
                                                    className="px-1.5 py-0.5 rounded bg-white border border-red-200 text-red-700 text-[10px] font-bold hover:bg-red-50">×</button>
                                            </div>
                                        </div>
                                        {filled > 0 && (
                                            <div className="flex flex-wrap gap-0.5 mt-0.5">
                                                {(n.filledStaff || []).map((name, i) => (
                                                    <span key={i} className="inline-flex items-center gap-0.5 px-1.5 py-0 bg-green-100 text-green-800 rounded-full text-[10px] font-bold">
                                                        ✓ {name.split(' ')[0]}
                                                        <button onClick={() => unfillNeedSlot(n, name)}
                                                            className="text-green-600 hover:text-red-600 ml-0.5">×</button>
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                        {/* Up-for-grabs queue display — visible only
                                            when this slot is broadcast and at least
                                            one staff has clicked "I want this". Order
                                            is first-come (sorted by claimedAt).
                                            Clicking a queue entry opens the existing
                                            Fill flow pre-targeting that staff member,
                                            so the manager's confirmation muscle memory
                                            (the Fill modal) still drives the actual
                                            shift creation. */}
                                        {n.openToAllStaff && Array.isArray(n.interestedClaims) && n.interestedClaims.length > 0 && (
                                            <div className="mt-1 pt-1 border-t border-amber-200">
                                                <div className="flex items-center gap-1.5 mb-1">
                                                    <span className="text-[10px] font-black uppercase tracking-widest text-amber-700">
                                                        🙋 {tx('Pickup queue', 'En espera')} · {n.interestedClaims.length}
                                                    </span>
                                                    <button onClick={() => clearUpForGrabsQueue(n.id)}
                                                        className="ml-auto text-[10px] text-amber-700 hover:text-amber-900 underline">
                                                        {tx('Clear', 'Limpiar')}
                                                    </button>
                                                </div>
                                                <div className="flex flex-col gap-0.5">
                                                    {[...n.interestedClaims]
                                                        .sort((a, b) => String(a?.claimedAt || '').localeCompare(String(b?.claimedAt || '')))
                                                        .map((c, i) => {
                                                            const ms = c?.claimedAt ? Date.parse(c.claimedAt) : 0;
                                                            const when = ms
                                                                ? new Date(ms).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                                                                : '—';
                                                            const alreadyFilled = (n.filledStaff || []).includes(c.name);
                                                            return (
                                                                <button
                                                                    key={`${c.name}_${i}`}
                                                                    onClick={() => {
                                                                        if (alreadyFilled) return;
                                                                        // Reuse the existing Fill flow — opens
                                                                        // the chooser with this staff pre-selected.
                                                                        setFillingNeed(n);
                                                                        setAvailableForDate(n.date);
                                                                    }}
                                                                    disabled={alreadyFilled}
                                                                    className={`flex items-center gap-1.5 px-1.5 py-1 rounded text-left text-[11px] ${
                                                                        alreadyFilled
                                                                            ? 'bg-emerald-50 text-emerald-800 cursor-default'
                                                                            : 'bg-amber-50 hover:bg-amber-100 text-amber-900'
                                                                    }`}>
                                                                    <span className="font-mono font-black text-amber-700 w-4 shrink-0">{i + 1}.</span>
                                                                    <span className="font-bold flex-1 min-w-0 truncate">{c.name}</span>
                                                                    <span className="text-[10px] opacity-70">{when}</span>
                                                                    {alreadyFilled ? (
                                                                        <span className="text-[10px] font-black">✓</span>
                                                                    ) : (
                                                                        <span className="text-[10px] font-bold text-amber-700">{tx('Pick →', 'Elegir →')}</span>
                                                                    )}
                                                                </button>
                                                            );
                                                        })}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        )}
                    </div>
                );
            })()}

            {/* Up-for-grabs panel — staff-side. Renders the broadcast
                open slots (n.openToAllStaff === true) so non-editor
                staff can volunteer to pick up a shift the manager
                can't fill. Each card has a "🙋 I want this" toggle:
                first tap adds the staffer to interestedClaims with
                a timestamp, second tap withdraws. The viewer also
                sees who else is in the queue so they know if they're
                first or just one of many — sets honest expectations
                about pickup chances. Hidden entirely for managers
                (they get the richer queue in the panel above). */}
            {!canEdit && (() => {
                const weekStartStr = toDateStr(weekStart);
                const weekEndStr = toDateStr(addDays(weekStart, 7));
                // Show only future-or-today, broadcast, not-yet-fully-filled
                // slots matching the viewer's location.
                const todayStr = toDateStr(new Date());
                const grabbable = staffingNeeds.filter(n => {
                    if (!n.openToAllStaff) return false;
                    if (!n.date || n.date < todayStr) return false;
                    if (n.date >= weekEndStr) return false; // current week only
                    if (n.date < weekStartStr) return false;
                    const loc = (staffByName.get(staffName) || {}).location;
                    if (loc && loc !== 'both' && n.location && n.location !== 'both' && n.location !== loc) return false;
                    const filled = (n.filledStaff || []).length;
                    if (filled >= (n.count || 0)) return false;
                    return true;
                }).sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
                if (grabbable.length === 0) return null;
                const shortTime = (t) => {
                    if (!t) return '';
                    const [h, m] = t.split(':').map(Number);
                    if (!Number.isFinite(h)) return t;
                    const period = h < 12 ? 'a' : 'p';
                    const h12 = ((h + 11) % 12) + 1;
                    return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
                };
                return (
                    <div className="mb-3 rounded-xl p-2.5 bg-amber-50 border border-amber-200 shadow-card">
                        <div className="flex items-center gap-2 mb-1.5">
                            <span className="w-1 h-4 bg-amber-500 rounded-full" />
                            <h3 className="text-xs font-black text-amber-900">🙋 {tx('Shifts up for grabs', 'Turnos disponibles')}</h3>
                            <span className="text-[10px] font-bold text-amber-700">{grabbable.length}</span>
                        </div>
                        <p className="text-[11px] text-amber-800/85 mb-2 leading-snug">
                            {tx(
                                "Manager's looking for help on these. Tap to add yourself — a manager picks from the list.",
                                'El gerente busca ayuda en estos. Toca para apuntarte — el gerente elige de la lista.',
                            )}
                        </p>
                        <div className="space-y-1.5">
                            {grabbable.map(n => {
                                const date = parseLocalDate(n.date);
                                const dayLabel = date ? (isEn ? DAYS_EN : DAYS_ES)[date.getDay()] : '';
                                const dayShort = date ? `${date.getMonth() + 1}/${date.getDate()}` : '';
                                const filled = (n.filledStaff || []).length;
                                const open = Math.max(0, (n.count || 0) - filled);
                                const claims = Array.isArray(n.interestedClaims) ? n.interestedClaims : [];
                                const youAreIn = claims.some(c => c?.name === staffName);
                                const yourSlot = (() => {
                                    if (!youAreIn) return null;
                                    const sorted = [...claims].sort((a, b) =>
                                        String(a?.claimedAt || '').localeCompare(String(b?.claimedAt || '')));
                                    return sorted.findIndex(c => c?.name === staffName) + 1;
                                })();
                                return (
                                    <div key={n.id} className="bg-white border border-amber-200 rounded-lg p-2">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-black text-amber-900 text-[13px] flex-1 min-w-0 truncate">
                                                {dayLabel} {dayShort} · {shortTime(n.startTime)}–{shortTime(n.endTime)}
                                                <span className="ml-1.5 text-[10px] font-bold text-amber-700">
                                                    {(n.side || 'foh').toUpperCase()} · {open} {tx('open', 'abierto')}
                                                </span>
                                            </span>
                                            <button onClick={() => claimUpForGrabsShift(n.id)}
                                                className={`px-3 py-1.5 rounded-lg text-[12px] font-bold active:scale-95 transition ${
                                                    youAreIn
                                                        ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                                                        : 'bg-amber-600 text-white hover:bg-amber-700'
                                                }`}>
                                                {youAreIn
                                                    ? `✓ ${tx(`You're #${yourSlot}`, `Estás #${yourSlot}`)}`
                                                    : `🙋 ${tx('I want this', 'Lo quiero')}`}
                                            </button>
                                        </div>
                                        {n.notes && (
                                            <p className="text-[11px] italic text-amber-800/85 mt-0.5">"{n.notes}"</p>
                                        )}
                                        {claims.length > 0 && (
                                            <p className="text-[10px] text-amber-700 mt-1">
                                                {tx(`${claims.length} in queue`, `${claims.length} en cola`)}
                                                {claims.length > 1 && (
                                                    <>: {[...claims]
                                                        .sort((a, b) => String(a?.claimedAt || '').localeCompare(String(b?.claimedAt || '')))
                                                        .slice(0, 3)
                                                        .map(c => c?.name?.split(' ')[0])
                                                        .filter(Boolean)
                                                        .join(', ')}
                                                        {claims.length > 3 && ` +${claims.length - 3}`}
                                                    </>
                                                )}
                                            </p>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })()}

            {/* Open offers + pending approvals (drawn from ALL visible shifts, both sides).
                viewerShifts (not raw shifts) so the offers list respects the
                permission gate — non-editors don't see offers on draft shifts. */}
            <SwapPanels
                shifts={viewerShifts}
                staffName={staffName}
                canEdit={canEdit}
                isEn={isEn}
                onTake={handleTakeShift}
                onCancelOffer={askCancelOffer}
                onApprove={askApproveSwap}
                onDeny={askDenySwap}
                storeLocation={storeLocation}
                timeOff={viewerTimeOff}
                onApprovePto={askApprovePto}
                onDenyPto={askDenyPto}
                onCancelOwnPto={askCancelOwnPto}
                swapRequests={swapRequests}
                onApproveSwapRequest={askApproveSwapRequest}
                onDenySwapRequest={askDenySwapRequest}
            />

            {loading ? (
                <div className="space-y-3 mt-4">
                    <div className="h-20 glass-sheet rounded-xl animate-pulse" />
                    <div className="h-32 glass-sheet rounded-xl animate-pulse" />
                    <div className="h-64 glass-sheet rounded-xl animate-pulse" />
                    <p className="text-center text-dd-text-2 text-xs">{tx('Loading schedule…', 'Cargando horario…')}</p>
                </div>
            ) : (
                <>
                    {/* Open Shifts bars — Sling-style.
                        IN GRID VIEW: rendered as TABLE ROWS at the top of the
                        schedule grid (see WeeklyGrid below) so they share
                        column widths with the day columns of the staff rows
                        beneath. This is the layout the user wanted.
                        IN DAY/LIST VIEWS: rendered as standalone cards above
                        the content (no grid to align with). */}
                    {(viewMode === 'day' || viewMode === 'list') && (
                        <>
                            <OpenShiftsCalendarBar
                                mode="unassigned"
                                weekStart={weekStart}
                                staffingNeeds={staffingNeeds}
                                shifts={visibleShifts}
                                side={side}
                                storeLocation={storeLocation}
                                isEn={isEn}
                                canEdit={canEdit}
                                currentStaffName={staffName}
                                blocksByDate={blocksByDate}
                                onFillSlot={(n) => {
                                    if (canEdit) {
                                        setFillingNeed(n);
                                        setAvailableForDate(n.date);
                                    } else {
                                        toast(tx(
                                            `Open ${formatTime12h(n.startTime)}–${formatTime12h(n.endTime)} slot on ${n.date}. Ask a manager to assign you.`,
                                            `Espacio abierto ${formatTime12h(n.startTime)}–${formatTime12h(n.endTime)} el ${n.date}. Pídele al gerente que te asigne.`
                                        ));
                                    }
                                }}
                                onTakeShift={handleTakeShift}
                                onCancelOffer={askCancelOffer}
                                /* Speed slot add — day/list views. Click a "+ slot"
                                   chip on a day cell → opens the StaffingNeedModal
                                   pre-filled to that date. */
                                onAddSlot={(dStr) => { setPrefillNeedDate(dStr); setShowNeedModal(true); }}
                            />
                            <OpenShiftsCalendarBar
                                mode="available"
                                weekStart={weekStart}
                                staffingNeeds={staffingNeeds}
                                shifts={visibleShifts}
                                side={side}
                                storeLocation={storeLocation}
                                isEn={isEn}
                                canEdit={canEdit}
                                currentStaffName={staffName}
                                blocksByDate={blocksByDate}
                                onFillSlot={() => {}}
                                onTakeShift={handleTakeShift}
                                onCancelOffer={askCancelOffer}
                            />
                        </>
                    )}

                    {/* Grid view fills the page (already wide). HoursSummary at the bottom. */}
                    {viewMode === 'grid' && (
                        <>
                            {/* Scoreboard + SPLH advisor are managers-only.
                                Andrew (2026-05-17): "weekly hours need to
                                only be seen by managers and up" — was
                                previously gated by canEdit (which includes
                                shift leads with FOH/BOH scheduling toggles).
                                Tightened to isManagerOrAdmin so labor-cost
                                + forecast info is restricted to managers +
                                owners regardless of who has scheduling rights. */}
                            {isManagerOrAdmin && (
                                <>
                                    {/* 2026-05-27 — Andrew: "lets get rid
                                        of the bar above the forcast. dont
                                        need it." HoursScoreboard removed
                                        from the render. The function
                                        definition is left in place (dead
                                        code) so any future revert is a
                                        one-line restore; it's not
                                        exported so leaving it costs
                                        nothing at runtime. */}
                                    <SplhAdvisor
                                        splhForecast={splhForecast}
                                        advisory={splhAdvisory}
                                        weatherTips={weatherTips}
                                        weather={weather}
                                        open={splhAdvisorOpen}
                                        onToggle={() => setSplhAdvisorOpen(o => !o)}
                                        isEn={isEn}
                                        side={side}
                                    />
                                </>
                            )}
                            {/* Fit-to-screen wrapper (Andrew 2026-05-22).
                                When gridFitToScreen is on, we measure the
                                natural width of the inner grid and apply a
                                CSS transform: scale to shrink the whole
                                week × all staff down to fit the viewport
                                width. The outer container's height shrinks
                                in lockstep so the page doesn't have a
                                giant gap of empty space below. Cells are
                                too small to interact with at this zoom
                                level — by design, this is the at-a-glance
                                view, not an editing view. Tap the toggle
                                again to return to normal. */}
                            <GridFitWrapper enabled={gridFitToScreen}>
                            <WeeklyGrid
                                weekStart={weekStart}
                                staffSummary={staffSummary}
                                shifts={visibleShifts}
                                isEn={isEn}
                                currentStaffName={staffName}
                                canEdit={canEdit}
                                isManagerOrAdmin={isManagerOrAdmin}
                                side={side}
                                storeLocation={storeLocation}
                                // Open Shifts data for the Sling-style rows at
                                // the top of the table. Memoized upstream
                                // (memoOpenSlots/memoOpenOffers) so identity
                                // is stable until real inputs change — keeps
                                // WeeklyGrid from re-rendering on every parent tick.
                                openSlots={memoOpenSlots}
                                openOffers={memoOpenOffers}
                                onFillSlot={onFillSlotCb}
                                /* Speed slot add — wires the "+ slot" inline
                                    button on each unassigned-row day cell to
                                    open the StaffingNeedModal pre-filled with
                                    that day's date. */
                                onAddSlot={onAddSlotCb}
                                selectedShiftIds={selectedShiftIds}
                                onToggleShiftSelection={onToggleShiftSelectionCb}
                                onCellClick={onCellClickCb}
                                quickAddCell={quickAddCell}
                                onQuickAddSelect={onQuickAddSelectCb}
                                onQuickAddCustom={onQuickAddCustomCb}
                                onQuickAddClose={onQuickAddCloseCb}
                                shiftPresets={effectiveShiftPresets}
                                onEditPresets={onEditPresetsCb}
                                weekNeeds={memoWeekNeeds}
                                onDeleteShift={onDeleteShiftCb}
                                onEditShift={onEditShiftCb}
                                movingShiftId={movingShift?.id || null}
                                onMoveToCell={onMoveToCellCb}
                                onStaffClick={onStaffClickCb}
                                onOfferShift={onOfferShiftCb}
                                onTakeShift={onTakeShiftCb}
                                onCancelOffer={onCancelOfferCb}
                                /* Find Cover — urgent push to qualified staff.
                                   See handleRequestCover above for filter logic
                                   (same side, location-compat, not on PTO). */
                                onRequestCover={onRequestCoverCb}
                                blocksByDate={blocksByDate}
                                eventsByDate={eventsByDate}
                                onDropShift={onDropShiftCb}
                                onUpdateShiftTimes={onUpdateShiftTimesCb}
                                isStaffOffOn={isStaffOffOnCb}
                                timeOff={viewerTimeOff}
                                onPtoChipClick={canEdit ? onPtoChipClickCb : null}
                                onDayHeaderClick={canEdit ? onDayHeaderClickCb : null}
                                onToggleDateOpen={staffIsAdmin ? onToggleDateOpenCb : null}
                                dateHasOpenOverride={dateHasOpenOverrideCb}
                                dateClosedByRecurring={dateClosedByRecurringCb}
                                // closedWeekdays is passed ONLY so React.memo
                                // re-renders the grid when recurring-closure
                                // config changes: dateClosedByRecurringCb reads
                                // it but has a stable identity, so without this
                                // prop the memo wouldn't notice the change.
                                closedWeekdays={scheduleSettings?.closedWeekdays}
                            />
                            </GridFitWrapper>
                            {/* Weekly hours summary — managers-only per
                                Andrew (2026-05-17). Was rendered for
                                everyone; now hidden for staff + shift
                                leads who shouldn't see total scheduled
                                hours or OT warnings across the team. */}
                            {isManagerOrAdmin && (
                                <HoursSummary staffSummary={staffSummary} isEn={isEn} currentStaffName={staffName} />
                            )}
                        </>
                    )}

                    {/* Day / List / PTO views — at lg+, main content + sticky HoursSummary sidebar.
                        On smaller screens they stack as before. */}
                    {['day', 'list', 'pto'].includes(viewMode) && (
                        <div className="lg:flex lg:gap-4">
                            <div className="lg:flex-1 min-w-0">
                                {viewMode === 'day' && (
                                    <DailyView
                                        weekStart={weekStart}
                                        selectedDayIdx={selectedDayIdx}
                                        setSelectedDayIdx={setSelectedDayIdx}
                                        shifts={visibleShifts}
                                        staffSummary={staffSummary}
                                        isEn={isEn}
                                        currentStaffName={staffName}
                                        canEdit={canEdit}
                                        onDeleteShift={handleDeleteShift}
                                        onOfferShift={handleOfferShift}
                                        onTakeShift={handleTakeShift}
                                        onCancelOffer={askCancelOffer}
                                        onRequestCover={handleRequestCover}
                                    />
                                )}
                                {viewMode === 'list' && (
                                    <ListView
                                        shifts={visibleShifts}
                                        isEn={isEn}
                                        currentStaffName={staffName}
                                        canEdit={canEdit}
                                        onDeleteShift={handleDeleteShift}
                                        staffSummary={staffSummary}
                                        onOfferShift={handleOfferShift}
                                        onTakeShift={handleTakeShift}
                                        onCancelOffer={askCancelOffer}
                                        onRequestCover={handleRequestCover}
                                    />
                                )}
                                {viewMode === 'pto' && (
                                    <PtoView
                                        weekStart={weekStart}
                                        timeOff={viewerTimeOff}
                                        // Use the full location-eligible staff
                                        // list, NOT sideStaffNames — PTO is
                                        // person-scoped, not side-scoped.
                                        // Filtering by sideStaffNames hid
                                        // pending PTO from staff with no
                                        // shifts this week.
                                        locationStaffNames={new Set((staffList || [])
                                            .filter(s => isOnScheduleAt(s, storeLocation))
                                            .map(s => s.name))}
                                        isEn={isEn}
                                        currentStaffName={staffName}
                                        canEdit={canEdit}
                                        onRemove={askRemoveTimeOff}
                                        onSetStatus={askSetPtoStatus}
                                    />
                                )}
                            </div>
                            {/* Desktop: sticky right sidebar with hours summary.
                                Manager-gated (Andrew 2026-05-17 — weekly hours
                                are managers-only across the app). */}
                            {isManagerOrAdmin && (
                                <aside className="hidden lg:block lg:w-72 lg:flex-shrink-0 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
                                    <HoursSummary staffSummary={staffSummary} isEn={isEn} currentStaffName={staffName} />
                                </aside>
                            )}
                            {/* Mobile + tablet: hours summary at bottom (sidebar hidden). lg:hidden ensures
                                we don't render twice. Same manager gate. */}
                            {isManagerOrAdmin && (
                                <div className="lg:hidden">
                                    <HoursSummary staffSummary={staffSummary} isEn={isEn} currentStaffName={staffName} />
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}

            {/* FLOATING BULK ACTION BAR — appears when shifts are selected
                via shift+click. Sits fixed above the bottom nav so it
                doesn't compete with primary scroll content. Closes on
                Clear or after a successful bulk action. */}
            {selectedShiftIds.size > 0 && (
                <div className="fixed bottom-4 md:bottom-6 left-1/2 -translate-x-1/2 z-30 print:hidden bottom-nav-safe">
                    <div className="flex items-center gap-2 bg-dd-charcoal text-white px-3 py-2 rounded-2xl shadow-card-hov">
                        <span className="px-2 py-1 rounded-full bg-white/15 text-xs font-bold tabular-nums">
                            {selectedShiftIds.size} {tx('selected', 'sel.')}
                        </span>
                        <button onClick={handleBulkGiveUp}
                            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-700 active:scale-95 transition">
                            <Megaphone size={14} strokeWidth={2.25} className="inline-block mr-1 -mt-0.5" aria-hidden="true" />{tx('Give up', 'Liberar')}
                        </button>
                        {canEdit && (
                            <button onClick={handleBulkDelete}
                                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-700 active:scale-95 transition">
                                🗑 {tx('Delete', 'Eliminar')}
                            </button>
                        )}
                        <button onClick={clearSelection}
                            className="px-2 py-1.5 rounded-lg text-xs font-semibold text-white/70 hover:text-white hover:bg-white/10 transition">
                            ✕ {tx('Clear', 'Limpiar')}
                        </button>
                    </div>
                    <p className="mt-1 text-center text-[10px] text-dd-text-2 bg-white/80 backdrop-blur rounded-md mx-2 px-2 py-0.5">
                        {tx('Shift-click any cube to add', 'Mayús+clic para agregar')}
                    </p>
                </div>
            )}

            {showAddModal && canEdit && (
                <AddShiftModal
                    onClose={() => { setShowAddModal(false); setAddPrefill(null); }}
                    onSave={handleAddShift}
                    staffList={staffList}
                    storeLocation={storeLocation}
                    isEn={isEn}
                    prefill={addPrefill}
                    weekStart={weekStart}
                    dateClosed={dateClosed}
                    existingShifts={shifts}
                    canEditFOH={canEditFOH}
                    canEditBOH={canEditBOH}
                    timeOff={viewerTimeOff}
                    shiftPresets={effectiveShiftPresets}
                    onEditPresets={canEdit ? () => setShowPresetEditor(true) : null}
                />
            )}
            {showPresetEditor && canEdit && (
                <ShiftPresetsEditor
                    presets={effectiveShiftPresets}
                    onSave={handleSaveShiftPresets}
                    onClose={() => setShowPresetEditor(false)}
                    isEn={isEn}
                />
            )}
            {showBlockModal && staffIsAdmin && (
                <BlackoutsModal
                    onClose={() => setShowBlockModal(false)}
                    onAdd={handleAddBlock}
                    onRemove={handleRemoveBlock}
                    blocks={dateBlocks}
                    storeLocation={storeLocation}
                    isEn={isEn}
                    closedWeekdays={scheduleSettings?.closedWeekdays || {}}
                    onToggleClosedWeekday={handleToggleClosedWeekday}
                    events={calendarEvents}
                    onAddEvent={handleAddCalendarEvent}
                    onRemoveEvent={handleRemoveCalendarEvent}
                />
            )}
            {/* Availability conflict acknowledgment modal — flashing red
                interrupt that fires after add / drag-resize / drag-move
                if the resulting shift lands outside the staff's declared
                availability. Forces a decision: Delete or Override. */}
            {availabilityWarn && (() => {
                const w = availabilityWarn;
                const d = parseLocalDate(w.date);
                const dayName = d ? (isEn ? DAYS_FULL_EN : DAYS_FULL_ES)[d.getDay()] : w.date;
                const kindLabel = w.kind === 'added'
                    ? tx('Shift you just added', 'Turno que acabas de agregar')
                    : w.kind === 'resized'
                        ? tx('Shift you just resized', 'Turno que acabas de cambiar')
                        : tx('Shift you just moved', 'Turno que acabas de mover');
                return (
                    <ModalPortal>
                    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4">
                        <div className="relative max-w-sm w-full">
                            {/* Flashing red ring layer — pulses without
                                fading the content. */}
                            <div className="absolute inset-0 rounded-2xl ring-4 ring-red-500 pointer-events-none animate-pulse" />
                            <div className="relative bg-white rounded-2xl shadow-2xl">
                                <div className="p-5 text-center">
                                    <div className="text-4xl mb-1">⚠️</div>
                                    <h3 className="text-lg font-bold text-red-700 mb-1">
                                        {tx('Availability conflict', 'Conflicto de disponibilidad')}
                                    </h3>
                                    <p className="text-[11px] uppercase tracking-wider text-dd-text-2 font-bold mb-3">
                                        {kindLabel}
                                    </p>
                                    {w.conflict.type === 'off' ? (
                                        <p className="text-sm text-dd-text leading-snug">
                                            <span className="font-bold">{w.staffName}</span>{' '}
                                            {tx(`marked ${dayName} as`, `marcó ${dayName} como`)}{' '}
                                            <span className="font-bold text-red-700">{tx('unavailable', 'no disponible')}</span>.
                                        </p>
                                    ) : (
                                        <p className="text-sm text-dd-text leading-snug">
                                            <span className="font-bold">{w.staffName}</span>{' '}
                                            {tx('is only available', 'solo está disponible')}{' '}
                                            <span className="font-bold">{formatTime12h(w.conflict.from)}–{formatTime12h(w.conflict.to)}</span>{' '}
                                            {tx(`on ${dayName}.`, `el ${dayName}.`)}
                                            <br />
                                            {tx('Shift is', 'El turno es')}{' '}
                                            <span className="font-bold text-red-700">{formatTime12h(w.startTime)}–{formatTime12h(w.endTime)}</span>.
                                        </p>
                                    )}
                                </div>
                                <div className="border-t border-dd-line p-3 flex gap-2">
                                    <button onClick={() => {
                                        handleDeleteShift(w.shiftId, { immediate: true });
                                        setAvailabilityWarn(null);
                                    }}
                                        className="flex-1 py-3 rounded-lg bg-red-600 text-white font-bold hover:bg-red-700 shadow-sm">
                                        🗑 {tx('Delete shift', 'Eliminar turno')}
                                    </button>
                                    <button onClick={() => setAvailabilityWarn(null)}
                                        className="flex-1 py-3 rounded-lg bg-white border-2 border-dd-line text-dd-text font-bold hover:bg-dd-bg">
                                        {tx('Override', 'Anular')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                    </ModalPortal>
                );
            })()}
            {showTimeOffModal && (
                <TimeOffModal
                    onClose={() => setShowTimeOffModal(false)}
                    onAdd={handleAddTimeOff}
                    onRemove={askRemoveTimeOff}
                    onSetStatus={askSetPtoStatus}
                    entries={timeOff}
                    staffList={staffList}
                    isEn={isEn}
                    canEdit={canEdit}
                />
            )}
            {/* Calendar-chip popup — entries derived live from the timeOff
                snapshot so a status change updates the open modal in place.
                Renders BEFORE the confirmDialog block below so ConfirmModal
                mounts later → stacks on top. */}
            {ptoChipTarget && (
                <PtoDetailsModal
                    target={ptoChipTarget}
                    entries={(timeOff || []).filter(t => {
                        if (t.staffName !== ptoChipTarget.staffName) return false;
                        const s = t.startDate || t.date;
                        const e = t.endDate || t.date;
                        return ptoChipTarget.dateStr >= s && ptoChipTarget.dateStr <= e;
                    })}
                    isEn={isEn}
                    canEdit={canEdit}
                    onSetStatus={askSetPtoStatus}
                    onRemove={askRemoveTimeOff}
                    onClose={closePtoChipModal}
                />
            )}
            {showPtoRequestModal && (
                <PtoRequestModal
                    onClose={() => setShowPtoRequestModal(false)}
                    onSubmit={handleSubmitPtoRequest}
                    staffName={staffName}
                    isEn={isEn}
                />
            )}
            {showMyAvailModal && (
                <MyAvailabilityModal
                    onClose={() => setShowMyAvailModal(false)}
                    staffList={staffList}
                    staffName={staffName}
                    onSave={handleSaveMyAvailability}
                    isEn={isEn}
                />
            )}
            {showMyBirthdayModal && (
                <MyBirthdayModal
                    onClose={() => setShowMyBirthdayModal(false)}
                    staffList={staffList}
                    staffName={staffName}
                    onSave={handleSaveMyBirthday}
                    isEn={isEn}
                />
            )}
            {showSwapModal && (
                <SwapShiftModal
                    onClose={() => setShowSwapModal(false)}
                    shifts={shifts}
                    staffList={staffList}
                    staffName={staffName}
                    storeLocation={storeLocation}
                    swapRequests={swapRequests}
                    onRequest={handleRequestSwap}
                    isEn={isEn}
                />
            )}
            {availableForDate && (
                <AvailableStaffModal
                    dateStr={availableForDate}
                    onClose={() => { setAvailableForDate(null); setFillingNeed(null); }}
                    sideStaff={sideStaff}
                    shifts={shifts}
                    storeLocation={storeLocation}
                    isStaffOffOn={isStaffOffOn}
                    isEn={isEn}
                    requiredRoleGroup={fillingNeed?.roleGroup || null}
                    slotStart={fillingNeed?.startTime || null}
                    slotEnd={fillingNeed?.endTime || null}
                    // Progress chip + remaining-count math for the multi-fill
                    // flow. Modal stays open until filled === count or the
                    // manager closes manually — see fillNeedWithStaff comment.
                    fillProgress={fillingNeed ? {
                        filled: (fillingNeed.filledStaff || []).length,
                        count: fillingNeed.count || 0,
                        filledStaff: fillingNeed.filledStaff || [],
                    } : null}
                    onSchedule={(staff) => {
                        // If we're filling a staffing need, create the shift via the
                        // need handler (so the slot is marked filled). Otherwise it's
                        // a free-form schedule action — open the Add Shift modal.
                        if (fillingNeed) {
                            fillNeedWithStaff(fillingNeed, staff);
                            return;
                        }
                        setAvailableForDate(null);
                        openAddModal({ staffName: staff.name, date: availableForDate, location: staff.location });
                    }}
                />
            )}
            {showNeedModal && canEdit && (
                <StaffingNeedModal
                    onClose={() => { setShowNeedModal(false); setPrefillNeedDate(null); }}
                    onSave={(form) => { handleAddNeed(form); setPrefillNeedDate(null); }}
                    storeLocation={storeLocation}
                    side={side}
                    weekStart={weekStart}
                    isEn={isEn}
                    /* Per-day prefill from the "+ slot" inline button in the
                       unassigned row. Without an id the modal renders in
                       "Add" mode (not Edit) so handleAddNeed still gets
                       called on save. */
                    initial={prefillNeedDate ? { date: prefillNeedDate, side } : undefined}
                />
            )}
            {editingNeed && canEdit && (
                <StaffingNeedModal
                    initial={editingNeed}
                    onClose={() => setEditingNeed(null)}
                    onSave={handleEditNeed}
                    storeLocation={storeLocation}
                    side={side}
                    weekStart={weekStart}
                    isEn={isEn}
                />
            )}
            {fillSlotChooser && canEdit && (
                <FillSlotChooserModal
                    chooser={fillSlotChooser}
                    onClose={() => setFillSlotChooser(null)}
                    onAssignSlot={(need) => {
                        // Use the existing fill-need flow so the slot ticks down.
                        fillNeedWithStaff(need, fillSlotChooser.staff);
                        setFillSlotChooser(null);
                    }}
                    onCustomShift={() => {
                        const { staff, dateStr } = fillSlotChooser;
                        setFillSlotChooser(null);
                        openAddModal({ staffName: staff.name, date: dateStr, location: staff.location });
                    }}
                    isEn={isEn}
                />
            )}
            {publishPreview && canEdit && (
                <PublishPreviewModal
                    preview={publishPreview}
                    side={side}
                    weekStart={weekStart}
                    isEn={isEn}
                    onCancel={() => setPublishPreview(null)}
                    onConfirm={confirmPublishDrafts}
                    onRemoveDraft={async (shiftId) => {
                        // Manager spotted a bad draft in the preview — let them
                        // delete it without leaving the modal. The list re-renders
                        // immediately because the preview is recomputed from
                        // visibleShifts (snapshot listener handles it).
                        await handleDeleteShift(shiftId);
                        setPublishPreview(prev => prev
                            ? { ...prev, drafts: prev.drafts.filter(d => d.id !== shiftId) }
                            : null);
                    }}
                />
            )}
            {showTemplateEditor && canEdit && (
                <TemplateEditorModal
                    initial={editingTemplate}
                    onClose={() => { setShowTemplateEditor(false); setEditingTemplate(null); }}
                    onSave={handleSaveTemplate}
                    storeLocation={storeLocation}
                    side={side}
                    weekStart={weekStart}
                    isEn={isEn}
                />
            )}
            {showRecurringModal && canEdit && (
                <RecurringShiftsModal
                    rules={recurringShifts}
                    staffList={staffList}
                    storeLocation={storeLocation}
                    side={side}
                    weekStart={weekStart}
                    isEn={isEn}
                    onSave={handleSaveRecurring}
                    onDelete={handleDeleteRecurring}
                    onGenerateThisWeek={handleGenerateRecurring}
                    onClose={() => setShowRecurringModal(false)}
                />
            )}
            {showApplyTemplate && canEdit && (
                <ApplyTemplateModal
                    templates={scheduleTemplates}
                    onClose={() => setShowApplyTemplate(false)}
                    onApply={handleApplyTemplate}
                    onEdit={(tpl) => { setEditingTemplate(tpl); setShowTemplateEditor(true); setShowApplyTemplate(false); }}
                    onCreate={() => { setEditingTemplate(null); setShowTemplateEditor(true); setShowApplyTemplate(false); }}
                    onDelete={handleDeleteTemplate}
                    weekStart={weekStart}
                    side={side}
                    isEn={isEn}
                />
            )}
            {showNotifDrawer && (
                <NotificationsDrawer
                    notifications={notifications}
                    onClose={() => setShowNotifDrawer(false)}
                    onMarkRead={markNotifRead}
                    onMarkAllRead={markAllNotifsRead}
                    isEn={isEn}
                    notifPermission={notifPermission}
                    onRequestPermission={requestNotifPermission}
                />
            )}

            {/* 2026-05-30 — confirmation + offer/take modals. Mounted at
                the end of the JSX so they paint on top of everything else.
                Each is rendered conditionally based on its target-state
                cell (confirmDialog / offerTarget / takeTarget). */}
            {/* 2026-05-30 — Month-calendar modal. Lazy-mount (only when
                showMonthModal is true). Tap any day in the cal to jump
                weekStart + auto-close the modal so the manager lands
                directly on the chosen week. Same content as the prior
                left-sidebar version, now invoked from the small Month
                button in the toolbar above. */}
            {showMonthModal && (
                <ModalPortal>
                    {/* Andrew 2026-05-30 — modal upsized to max-w-6xl (1152px)
                        on desktop so a full month grid fits with every day's
                        holiday/birthday names readable inline. Was previously
                        max-w-sm (384px) which only had room for dots. On
                        mobile it still stacks full-width from the bottom
                        sheet; height-capped to 90vh with scroll for short
                        viewports. */}
                    <div className="fixed inset-0 z-[60] bg-black/50 flex items-end md:items-center justify-center p-3"
                        onClick={() => setShowMonthModal(false)}
                        role="dialog" aria-modal="true">
                        <div className="bg-white w-full md:max-w-6xl md:rounded-2xl rounded-t-2xl shadow-xl md:max-h-[90vh] max-h-[92vh] flex flex-col"
                            onClick={(e) => e.stopPropagation()}
                            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                            <div className="md:hidden flex justify-center pt-2 pb-1 shrink-0">
                                <div className="w-10 h-1 bg-dd-line rounded-full" />
                            </div>
                            <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between bg-dd-sage-50 safe-top shrink-0">
                                <div className="flex items-center gap-2">
                                    <div className="w-9 h-9 rounded-full bg-dd-green-50 text-dd-green-700 flex items-center justify-center">
                                        <Calendar size={18} strokeWidth={2.25} />
                                    </div>
                                    <div>
                                        <h2 className="text-base font-black text-dd-text">
                                            {tx('Month calendar', 'Calendario mensual')}
                                        </h2>
                                        <p className="text-[11px] text-dd-text-2 leading-tight">
                                            {tx('Tap a day to jump the week', 'Toca un día para saltar a esa semana')}
                                        </p>
                                    </div>
                                </div>
                                <button onClick={() => setShowMonthModal(false)}
                                    className="w-11 h-11 rounded-full hover:bg-white/60 flex items-center justify-center text-dd-text-2"
                                    aria-label={tx('Close', 'Cerrar')}>
                                    ✕
                                </button>
                            </div>
                            <div className="p-3 md:p-4 overflow-y-auto flex-1 min-h-0">
                                <MonthMiniCal
                                    weekStart={weekStart}
                                    setWeekStart={(d) => { setWeekStart(d); setShowMonthModal(false); }}
                                    eventsByDate={eventsByDate}
                                    blocksByDate={blocksByDate}
                                    isEn={isEn}
                                />
                            </div>
                        </div>
                    </div>
                </ModalPortal>
            )}

            {confirmDialog && (
                <ConfirmModal
                    {...confirmDialog}
                    onClose={() => setConfirmDialog(null)}
                    language={language}
                />
            )}
            {offerTarget && (
                <OfferShiftModal
                    shift={offerTarget}
                    formatTime12h={formatTime12h}
                    locationLabel={LOCATION_LABELS[offerTarget.location] || offerTarget.location}
                    onClose={() => setOfferTarget(null)}
                    onSubmit={(payload) => commitOfferShift(offerTarget, payload)}
                    language={language}
                />
            )}
            {/* Andrew 2026-06-25 — the shift EDIT modal (double-click a cube).
                Bundles time edit + Move to + Up for grabs + Delete; closes on
                outside click via ModalPortal. Up-for-grabs opens the existing
                OfferShiftModal; delete + move both route through their confirms. */}
            {editingShift && (
                <ShiftEditModal
                    shift={editingShift}
                    isEn={isEn}
                    locationLabel={LOCATION_LABELS[editingShift.location] || editingShift.location}
                    onClose={() => setEditingShift(null)}
                    onSaveTimes={(start, end) => { handleUpdateShiftTimes(editingShift.id, start, end); setEditingShift(null); }}
                    onMove={() => { setMovingShift(editingShift); setEditingShift(null); }}
                    onOffer={() => { const s = editingShift; setEditingShift(null); handleOfferShift(s); }}
                    onDelete={() => { const s = editingShift; setEditingShift(null); handleDeleteShift(s.id, { immediate: true }); }}
                />
            )}
            {/* Move mode — tap any person's day to drop the picked shift there. */}
            {movingShift && (
                <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] print:hidden px-3 w-full max-w-md">
                    <div className="flex items-center justify-center gap-3 px-4 py-2.5 rounded-full bg-dd-green text-white shadow-2xl border border-white/20">
                        <span className="text-sm font-bold text-center">
                            📍 {isEn
                                ? `Moving ${movingShift.staffName || 'shift'} — tap a person's day`
                                : `Moviendo ${movingShift.staffName || 'turno'} — toca el día`}
                        </span>
                        <button onClick={() => setMovingShift(null)}
                            className="px-2.5 py-1 rounded-full bg-white/20 hover:bg-white/30 text-xs font-bold whitespace-nowrap shrink-0">
                            {isEn ? 'Cancel' : 'Cancelar'}
                        </button>
                    </div>
                </div>
            )}
            {takeTarget && (
                <TakeShiftModal
                    shift={takeTarget}
                    formatTime12h={formatTime12h}
                    locationLabel={LOCATION_LABELS[takeTarget.location] || takeTarget.location}
                    weeklyHoursBefore={computeWeeklyHoursFor(takeTarget.date)}
                    conflicts={computeConflictsFor(takeTarget)}
                    onClose={() => setTakeTarget(null)}
                    onSubmit={(payload) => commitTakeShift(takeTarget, payload)}
                    language={language}
                />
            )}
        </div>
    );
}

// ── Sub-components ─────────────────────────────────────────────────────────

// Fit-to-screen wrapper for the WeeklyGrid on mobile. Andrew
// 2026-05-22 — "i want to be able to zoom out and see the full
// picture of the weeks calendar with everyone schedule. sling has
// this function". When enabled, we measure the inner grid's natural
// scroll width and apply a CSS transform: scale so the whole week ×
// all staff fits in the viewport width. Outer container's height
// shrinks in lockstep so there's no big empty gap below.
//
// Implementation notes:
//   • Measurement runs in useLayoutEffect so the scaled size is
//     correct on first paint (no flash of unscaled content).
//   • Recalculated on window resize (rotation, keyboard show/hide).
//   • Pointer-events: none on the scaled content because cells are
//     too small to interact with at this zoom — the toggle button
//     in the schedule header switches back out for editing.
//   • When disabled, we render children with no wrapper transforms
//     so the existing overflow-x-auto inside WeeklyGrid keeps
//     working normally for desktop + horizontal-scroll mobile users.
// Max pinch-zoom level for the fit-to-screen overview.
const GRID_MAX_ZOOM = 1.6;

function GridFitWrapper({ enabled, children }) {
    const outerRef = useRef(null);
    const innerRef = useRef(null);
    const [scaledHeight, setScaledHeight] = useState(null);
    // ALL zoom/pan math lives in this ref (not React state) so:
    //   1. the non-passive touch listeners below read/write live values
    //      without re-subscribing on every change, and
    //   2. we drive the transform IMPERATIVELY for smooth 60fps gestures
    //      without thrashing React.
    // fit = baseline "whole week fits the width" scale; scale = current
    // zoom (>= fit, user pinches IN); tx/ty = pan offset once zoomed.
    const g = useRef({ fit: 1, scale: 1, tx: 0, ty: 0, natW: 1, natH: 0, outW: 0 });

    // Push current zoom/pan to the DOM. transform / pointerEvents /
    // touchAction are set ONLY here (never in JSX) so a React re-render of
    // this wrapper can't clobber an in-progress zoom.
    const rafRef = useRef(null);
    const lastZoomedRef = useRef(null);
    const apply = () => {
        const inner = innerRef.current, outer = outerRef.current;
        if (!inner || !outer) return;
        const { fit, scale, tx, ty } = g.current;
        // translate3d (not translate) keeps the grid on a GPU-composited layer
        // so a pinch is a cheap composite. Android's WebView REPAINTS the whole
        // 60+ cell grid every frame without this (the lag on the Android app);
        // iOS WKWebView composited it regardless, so it was smooth there.
        inner.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
        const zoomed = scale > fit * 1.02;
        // Only touch pointerEvents/touchAction when the zoomed state actually
        // flips — re-writing touch-action every frame can hitch Android's
        // input pipeline mid-gesture.
        if (zoomed !== lastZoomedRef.current) {
            lastZoomedRef.current = zoomed;
            // Look-only at the fit baseline (cells too tiny to tap accurately);
            // tappable once pinched in so shifts can be edited.
            inner.style.pointerEvents = zoomed ? 'auto' : 'none';
            // At fit: 1-finger scrolls the page, our 2-finger pinch zooms in.
            // Zoomed: we own pan + pinch (no native scroll/zoom interference).
            outer.style.touchAction = zoomed ? 'none' : 'pan-y';
        }
    };
    // Coalesce rapid touchmove events into one transform write per frame.
    const scheduleApply = () => {
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(() => { rafRef.current = null; apply(); });
    };

    const clampPan = (s, x, y) => {
        const { natW, natH, outW, fit } = g.current;
        const frameH = natH * fit;                 // overview frame height
        const minX = Math.min(0, outW - natW * s);
        const minY = Math.min(0, frameH - natH * s);
        return [Math.max(minX, Math.min(0, x)), Math.max(minY, Math.min(0, y))];
    };

    // Measure → fit (and reset any zoom/pan to the at-a-glance baseline).
    useEffect(() => {
        if (!enabled) { setScaledHeight(null); return; }
        // outerRef.offsetWidth = available viewport space (stable, not
        // affected by our transform). innerRef.scrollWidth = natural content
        // width — stable because the inner uses width: max-content, so it
        // doesn't grow with our CSS (a 2026-05-22 ResizeObserver version fed
        // back on itself and shrank the grid every tick; intrinsic width +
        // no observer fixed it).
        const compute = () => {
            const outer = outerRef.current, inner = innerRef.current;
            if (!outer || !inner) return;
            const outW = outer.offsetWidth || window.innerWidth;
            const natW = inner.scrollWidth || 1;
            const natH = inner.scrollHeight || 0;
            const fit = Math.min(1, outW / natW);
            g.current = { fit, scale: fit, tx: 0, ty: 0, natW, natH, outW };
            setScaledHeight(natH * fit);
            apply();
        };
        const raf = requestAnimationFrame(compute);
        // One remeasure a beat later in case fonts/images shift width after
        // first paint. NOT a loop.
        const t = setTimeout(compute, 100);
        window.addEventListener('resize', compute);
        return () => {
            cancelAnimationFrame(raf);
            clearTimeout(t);
            window.removeEventListener('resize', compute);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);

    // ── Pinch-to-zoom + drag-to-pan (Andrew 2026-06-14: "i cant zoom into
    //    calendar of shifts" in the fit-to-screen overview) ───────────────
    // Listeners are attached NATIVELY with { passive: false } — NOT via
    // React's onTouchMove, which React registers as passive, so its
    // preventDefault() is ignored and the iOS WKWebView's own pinch-zoom /
    // scroll would fight us (the whole app would zoom on a real iPhone).
    // All gesture math is anchored to the gesture START values, so it stays
    // correct regardless of event timing.
    useEffect(() => {
        if (!enabled) return;
        const outer = outerRef.current;
        if (!outer) return;
        let gesture = null;
        const onStart = (e) => {
            const cur = g.current;
            if (e.touches.length === 2) {
                const [a, b] = e.touches;
                const rect = outer.getBoundingClientRect();
                gesture = {
                    mode: 'pinch',
                    dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1,
                    midX: (a.clientX + b.clientX) / 2 - rect.left,
                    midY: (a.clientY + b.clientY) / 2 - rect.top,
                    s0: cur.scale, tx0: cur.tx, ty0: cur.ty,
                };
            } else if (e.touches.length === 1 && cur.scale > cur.fit * 1.02) {
                gesture = { mode: 'pan', x0: e.touches[0].clientX, y0: e.touches[0].clientY, tx0: cur.tx, ty0: cur.ty };
            } else {
                gesture = null; // let taps fall through (look at fit / edit when zoomed)
            }
        };
        const onMove = (e) => {
            if (!gesture) return;
            const cur = g.current;
            if (gesture.mode === 'pinch' && e.touches.length === 2) {
                e.preventDefault();
                const [a, b] = e.touches;
                const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
                const ns = Math.max(cur.fit, Math.min(GRID_MAX_ZOOM, gesture.s0 * (dist / gesture.dist)));
                // Keep the content point under the pinch midpoint fixed.
                const cx = (gesture.midX - gesture.tx0) / gesture.s0;
                const cy = (gesture.midY - gesture.ty0) / gesture.s0;
                const [nx, ny] = clampPan(ns, gesture.midX - cx * ns, gesture.midY - cy * ns);
                cur.scale = ns; cur.tx = nx; cur.ty = ny;
                scheduleApply();
            } else if (gesture.mode === 'pan' && e.touches.length === 1) {
                e.preventDefault();
                const t0 = e.touches[0];
                const [nx, ny] = clampPan(cur.scale, gesture.tx0 + (t0.clientX - gesture.x0), gesture.ty0 + (t0.clientY - gesture.y0));
                cur.tx = nx; cur.ty = ny;
                scheduleApply();
            }
        };
        const onEnd = (e) => { if (e.touches.length === 0) gesture = null; };
        outer.addEventListener('touchstart', onStart, { passive: false });
        outer.addEventListener('touchmove', onMove, { passive: false });
        outer.addEventListener('touchend', onEnd, { passive: false });
        outer.addEventListener('touchcancel', onEnd, { passive: false });
        return () => {
            outer.removeEventListener('touchstart', onStart);
            outer.removeEventListener('touchmove', onMove);
            outer.removeEventListener('touchend', onEnd);
            outer.removeEventListener('touchcancel', onEnd);
            if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);

    if (!enabled) return <>{children}</>;
    // NOTE: transform / pointerEvents / touchAction are intentionally NOT in
    // these style objects — apply() owns them imperatively (see above).
    return (
        <div ref={outerRef} style={{ overflow: 'hidden', width: '100%', height: scaledHeight ?? 'auto' }}>
            <div ref={innerRef} style={{ transformOrigin: 'top left', width: 'max-content', pointerEvents: 'none', willChange: 'transform', backfaceVisibility: 'hidden' }}>
                {children}
            </div>
        </div>
    );
}

// 2026-05-30 — Andrew "make a month view of the schedule, small box on
// left of week view, not the default."
//
// Compact reference calendar that sits left of the WeeklyGrid on lg+
// screens (hidden on mobile — too narrow for both to coexist). Click any
// day to jump the WeeklyGrid to that day's week. Manager-added events
// from /calendar_events render as a tiny purple dot; staff birthdays
// render as a tiny pink dot; closed-day blocks render as a gray stripe.
//
// Own its own "displayed month" state (initialized from weekStart) so
// the manager can scroll months ahead to plan without yanking the main
// grid around. Sync resets only when weekStart jumps far enough that
// the current week isn't in the displayed month.
function MonthMiniCal({ weekStart, setWeekStart, eventsByDate, blocksByDate, isEn }) {
    const [displayMonth, setDisplayMonth] = useState(() => {
        const d = new Date(weekStart);
        return new Date(d.getFullYear(), d.getMonth(), 1);
    });
    // Resync displayed month if weekStart moves outside it (e.g. user
    // jumped 6 weeks in the main grid). Keeps the mini-cal relevant to
    // what the manager is editing without trapping them on this month.
    //
    // BUG FIX (Andrew 2026-06-17 "next-month arrow doesn't work"): this effect
    // used to depend on [weekStart, displayMonth]. Paging with ‹/› changes
    // displayMonth, which re-ran the effect — and since weekStart was still in
    // the OLD month, it immediately snapped displayMonth back. Now it keys on
    // weekStart ONLY (read displayMonth via a ref so there's no stale-closure
    // bug), so manual month paging sticks.
    const displayMonthRef = useRef(displayMonth);
    displayMonthRef.current = displayMonth;
    useEffect(() => {
        const ws = new Date(weekStart);
        const we = addDays(ws, 6);
        const dm = displayMonthRef.current;
        const inDispMonth = (d) =>
            d.getFullYear() === dm.getFullYear() &&
            d.getMonth() === dm.getMonth();
        if (!inDispMonth(ws) && !inDispMonth(we)) {
            setDisplayMonth(new Date(ws.getFullYear(), ws.getMonth(), 1));
        }
    }, [weekStart]);

    const monthLabel = displayMonth.toLocaleDateString(isEn ? 'en-US' : 'es-MX',
        { month: 'long', year: 'numeric' });
    // Full day-of-week headers on desktop; single letters on mobile so
    // narrow cells aren't cramped.
    const dayHeadersShort = isEn
        ? ['S', 'M', 'T', 'W', 'T', 'F', 'S']
        : ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
    const dayHeadersLong = isEn
        ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        : ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    // Build the 6×7 = 42 cell grid. Start on the Sunday on/before
    // the 1st of displayMonth, then walk 42 days.
    const firstOfMonth = displayMonth;
    const gridStart = addDays(firstOfMonth, -firstOfMonth.getDay()); // back to Sunday
    const cells = [];
    for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));

    const todayStr = toDateStr(new Date());
    const weekStartStr = toDateStr(weekStart);
    const weekEndStr = toDateStr(addDays(weekStart, 6));

    const isInCurrentWeek = (d) => {
        const ds = toDateStr(d);
        return ds >= weekStartStr && ds <= weekEndStr;
    };

    const prevMonth = () => setDisplayMonth(new Date(displayMonth.getFullYear(), displayMonth.getMonth() - 1, 1));
    const nextMonth = () => setDisplayMonth(new Date(displayMonth.getFullYear(), displayMonth.getMonth() + 1, 1));
    const goToday = () => {
        const t = new Date();
        setDisplayMonth(new Date(t.getFullYear(), t.getMonth(), 1));
        setWeekStart(startOfWeek(t));
    };

    // Andrew 2026-05-30 — read-friendly redesign. Each day cell now
    // shows the actual holiday/birthday/observance label (truncated)
    // instead of just a colored dot, since the modal is now 6× wider
    // and has room. Pulls TWO sources:
    //   1) eventsByDate from the parent — manager-added events + auto
    //      staff birthdays
    //   2) getEventsForDate(ds) — federal holidays + national food
    //      days bundled in src/data/calendarEvents.js. These never
    //      made it into eventsByDate (parent uses a different source)
    //      so the mini-cal was previously missing things like
    //      "Thanksgiving" or "Natl. Pho Day". Surfaced here so the
    //      month view becomes a true at-a-glance overview.
    const labelFor = (e) => {
        if (e.isBirthday) return `${e.emoji || '🎂'} ${e.label || ''}`.trim();
        if (e.en || e.es) return `${e.icon || ''} ${isEn ? e.en : e.es}`.trim();
        if (e.label) return `${e.emoji || ''} ${e.label}`.trim();
        return '';
    };
    const toneClassFor = (e) => {
        if (e.isBirthday) return 'bg-pink-50 text-pink-800 border-pink-200';
        if (e.kind === 'holiday') return 'bg-amber-50 text-amber-800 border-amber-200';
        if (e.kind === 'food') return 'bg-rose-50 text-rose-800 border-rose-200';
        if (e.kind === 'observance') return 'bg-indigo-50 text-indigo-800 border-indigo-200';
        // Manager-added (no kind) → purple
        return 'bg-purple-50 text-purple-800 border-purple-200';
    };

    return (
        <div className="bg-white rounded-xl border border-dd-line shadow-card p-3 md:p-4 print:hidden">
            {/* Header — month + arrows */}
            <div className="flex items-center justify-between mb-3">
                <button onClick={prevMonth}
                    aria-label={isEn ? 'Previous month' : 'Mes anterior'}
                    className="w-9 h-9 rounded-lg text-dd-text-2 hover:bg-dd-bg flex items-center justify-center text-xl font-bold transition active:scale-95">‹</button>
                <div className="text-sm md:text-base font-black uppercase tracking-wider text-dd-text capitalize">
                    {monthLabel}
                </div>
                <button onClick={nextMonth}
                    aria-label={isEn ? 'Next month' : 'Mes siguiente'}
                    className="w-9 h-9 rounded-lg text-dd-text-2 hover:bg-dd-bg flex items-center justify-center text-xl font-bold transition active:scale-95">›</button>
            </div>
            {/* Day-of-week header — letter on mobile, full name on md+ */}
            <div className="grid grid-cols-7 gap-1 mb-1">
                {dayHeadersShort.map((d, i) => (
                    <div key={i} className="text-center text-[10px] md:text-xs font-bold uppercase text-dd-text-2/70 py-1">
                        <span className="md:hidden">{d}</span>
                        <span className="hidden md:inline">{dayHeadersLong[i]}</span>
                    </div>
                ))}
            </div>
            {/* 42 day cells — much taller on md+ so event labels fit. */}
            <div className="grid grid-cols-7 gap-1">
                {cells.map((d, i) => {
                    const ds = toDateStr(d);
                    const inMonth = d.getMonth() === displayMonth.getMonth();
                    const isToday = ds === todayStr;
                    const inWeek = isInCurrentWeek(d);
                    // Merge parent eventsByDate (calendarEvents + birthdays)
                    // with calendarEvents.js federal/food/observance days.
                    const parentEvents = eventsByDate.get(ds) || [];
                    const codedEvents = getEventsForDate(ds);
                    const allEvents = [...parentEvents, ...codedEvents];
                    const blocks = blocksByDate.get(ds) || [];
                    const isClosed = blocks.some(b => b.type === 'closed');
                    return (
                        <button key={i}
                            onClick={() => setWeekStart(startOfWeek(d))}
                            aria-label={`Jump to week of ${ds}`}
                            className={`group relative rounded-lg text-left transition flex flex-col p-1 md:p-1.5 min-h-[64px] md:min-h-[110px] overflow-hidden border ${
                                inWeek
                                    ? 'bg-dd-green-50 ring-2 ring-dd-green text-dd-green-700 border-dd-green'
                                    : isToday
                                        ? 'bg-dd-sage-50 text-dd-text border-dd-green/40'
                                        : inMonth
                                            ? 'text-dd-text hover:bg-dd-bg border-dd-line/60'
                                            : 'text-dd-text-2/50 hover:bg-dd-bg/60 border-dd-line/30 bg-dd-bg/30'
                            } ${isClosed ? 'opacity-70 line-through' : ''}`}>
                            {/* Day number — top row */}
                            <div className="flex items-center justify-between mb-0.5 md:mb-1">
                                <span className={`text-xs md:text-sm font-black tabular-nums ${
                                    isToday && !inWeek ? 'inline-flex items-center justify-center w-5 h-5 md:w-6 md:h-6 rounded-full bg-dd-green text-white' : ''
                                }`}>
                                    {d.getDate()}
                                </span>
                                {isClosed && (
                                    <span className="text-[8px] md:text-[9px] font-black uppercase tracking-wider text-dd-text-2/70 px-1 rounded bg-dd-bg">
                                        {isEn ? 'Closed' : 'Cerrado'}
                                    </span>
                                )}
                            </div>
                            {/* Event labels — full text, truncated per pill.
                                Stack up to 3 on desktop; mobile shows up to 2
                                with a +N pill for overflow. */}
                            {allEvents.length > 0 && (
                                <div className="flex flex-col gap-0.5 min-w-0">
                                    {allEvents.slice(0, 3).map((e, idx) => (
                                        <span key={idx}
                                            title={labelFor(e)}
                                            className={`text-[9px] md:text-[10px] font-bold px-1 py-0.5 rounded border truncate leading-tight ${toneClassFor(e)}`}>
                                            {labelFor(e)}
                                        </span>
                                    ))}
                                    {allEvents.length > 3 && (
                                        <span className="text-[9px] md:text-[10px] font-bold text-dd-text-2/70 px-1">
                                            +{allEvents.length - 3} {isEn ? 'more' : 'más'}
                                        </span>
                                    )}
                                </div>
                            )}
                        </button>
                    );
                })}
            </div>
            {/* Footer — legend + jump-to-today */}
            <div className="mt-3 pt-3 border-t border-dd-line/60 space-y-2">
                <div className="flex items-center gap-3 flex-wrap text-[10px] md:text-xs text-dd-text-2">
                    <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded border border-amber-200 bg-amber-50" />
                        {isEn ? 'Holiday' : 'Feriado'}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded border border-rose-200 bg-rose-50" />
                        {isEn ? 'Food day' : 'Día de comida'}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded border border-indigo-200 bg-indigo-50" />
                        {isEn ? 'Observance' : 'Conmemoración'}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded border border-pink-200 bg-pink-50" />
                        {isEn ? 'Birthday' : 'Cumpleaños'}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded border border-purple-200 bg-purple-50" />
                        {isEn ? 'Event' : 'Evento'}
                    </span>
                    <span className="inline-flex items-center gap-1.5 ml-auto">
                        <span className="inline-block w-3 h-3 rounded-full bg-dd-green-50 ring-2 ring-dd-green" />
                        {isEn ? 'Selected week' : 'Semana actual'}
                    </span>
                </div>
                <button onClick={goToday}
                    className="w-full text-xs md:text-sm text-dd-text-2 hover:text-dd-green-700 font-semibold py-2 rounded-lg hover:bg-dd-bg transition active:scale-[0.99]">
                    ↺ {isEn ? 'Jump to today' : 'Ir a hoy'}
                </button>
            </div>
        </div>
    );
}

function WeekNav({ weekStart, setWeekStart, isEn }) {
    const weekEnd = addDays(weekStart, 6);
    const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
    const fmt = (d) => d.toLocaleDateString(isEn ? 'en-US' : 'es-MX', { month: 'short', day: 'numeric' });
    const range = sameMonth
        ? `${fmt(weekStart)} – ${weekEnd.getDate()}, ${weekStart.getFullYear()}`
        : `${fmt(weekStart)} – ${fmt(weekEnd)}, ${weekStart.getFullYear()}`;
    const today = startOfWeek(new Date());
    const isCurrentWeek = toDateStr(today) === toDateStr(weekStart);
    return (
        <div className="flex items-center justify-between mb-3 bg-white rounded-lg p-2 border border-dd-line shadow-card print:bg-white print:border-0 print:p-0 print:mb-2">
            <button onClick={() => setWeekStart(addDays(weekStart, -7))}
                aria-label="Previous week"
                className="w-10 h-10 rounded-lg bg-dd-bg text-dd-text font-bold hover:bg-dd-sage-50 transition print:hidden">
                ‹
            </button>
            <div className="text-center">
                <div className="text-base font-bold text-dd-text print:text-lg leading-tight">{range}</div>
                {isCurrentWeek ? (
                    <div className="text-[10px] text-dd-green-700 font-bold uppercase tracking-wider mt-0.5 print:hidden">
                        ● {isEn ? 'This week' : 'Esta semana'}
                    </div>
                ) : (
                    <button onClick={() => setWeekStart(today)}
                        className="text-[11px] text-dd-text-2 hover:text-dd-green-700 font-semibold mt-0.5 print:hidden">
                        ↺ {isEn ? 'Jump to today' : 'Ir a hoy'}
                    </button>
                )}
            </div>
            <button onClick={() => setWeekStart(addDays(weekStart, 7))}
                aria-label="Next week"
                className="w-10 h-10 rounded-lg bg-dd-bg text-dd-text font-bold hover:bg-dd-sage-50 transition print:hidden">
                ›
            </button>
        </div>
    );
}

// HoursScoreboard — sticky-ish panel above the grid showing both sides'
// scheduled-vs-target totals + who's most under or most over. The point is
// to make over/under signals visible BEFORE the manager publishes a draft,
// not after staff start complaining about hours.
function HoursScoreboard({ scoreboard, side, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    if (!scoreboard) return null;
    const computeStatus = (data) => {
        const pct = data.target > 0 ? Math.round((data.scheduled / data.target) * 100) : null;
        const status =
            pct == null   ? { label: tx('No target', 'Sin objetivo'), tone: 'text-dd-text-2', dot: 'bg-gray-300', bar: 'bg-gray-300' }
          : pct < 80      ? { label: tx('Under', 'Bajo'),     tone: 'text-amber-700',  dot: 'bg-amber-500', bar: 'bg-amber-400' }
          : pct <= 104    ? { label: tx('On target', 'En meta'), tone: 'text-emerald-700', dot: 'bg-emerald-500', bar: 'bg-emerald-500' }
          : pct <= 114    ? { label: tx('Trending OT', 'Hacia OT'), tone: 'text-amber-700', dot: 'bg-amber-500', bar: 'bg-amber-500' }
          :                 { label: tx('Over budget', 'Excedido'), tone: 'text-red-700', dot: 'bg-red-500', bar: 'bg-red-500' };
        return { pct, status };
    };
    const foh = computeStatus(scoreboard.foh);
    const boh = computeStatus(scoreboard.boh);

    // Compact compound row — both sides side-by-side in ONE card. Was two
    // separate cards eating ~200px of vertical real estate. The compact
    // version puts both summaries in a single horizontal strip with all
    // the same info but ~50% the vertical footprint.
    const sideRow = (label, data, computed, isActive, accentColor) => (
        <div className={`flex-1 min-w-0 ${isActive ? 'pr-3' : 'pl-3'}`}>
            <div className="flex items-center gap-2 mb-1">
                <span className={`w-2 h-2 rounded-full ${accentColor}`} />
                <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{label}</span>
                <span className={`ml-auto text-[10px] font-bold ${computed.status.tone} flex items-center gap-1`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${computed.status.dot}`} />
                    {computed.status.label}
                </span>
            </div>
            <div className="flex items-baseline gap-1.5">
                <span className="text-xl font-black text-dd-text tabular-nums leading-none">{formatHours(data.scheduled)}</span>
                {data.target > 0 && (
                    <span className="text-xs text-dd-text-2 font-semibold">/ {formatHours(data.target)}</span>
                )}
                {computed.pct != null && (
                    <span className={`text-xs font-bold ${computed.status.tone}`}>{computed.pct}%</span>
                )}
            </div>
            {computed.pct != null && (
                <div className="mt-1.5 h-1 w-full bg-dd-bg rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${computed.status.bar}`}
                        style={{ width: `${Math.min(150, computed.pct) / 150 * 100}%` }} />
                </div>
            )}
        </div>
    );

    // Aggregate under/over chips from BOTH sides (so the manager sees the
    // full picture without scanning two separate cards).
    const allUnder = [...scoreboard.foh.under, ...scoreboard.boh.under];
    const allOver  = [...scoreboard.foh.over,  ...scoreboard.boh.over];

    return (
        <div className="mb-3 glass-sheet rounded-xl shadow-card p-3 print:hidden">
            <div className="flex items-stretch divide-x divide-dd-line">
                {sideRow(tx('FOH', 'FOH'), scoreboard.foh, foh, side === 'foh', 'bg-dd-green')}
                {sideRow(tx('BOH', 'BOH'), scoreboard.boh, boh, side === 'boh', 'bg-orange-500')}
            </div>
            {(allUnder.length > 0 || allOver.length > 0) && (
                <div className="mt-2 pt-2 border-t border-dd-line/60 flex flex-wrap gap-1">
                    {allUnder.map(p => (
                        <span key={'u-' + p.name}
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200"
                            title={tx(`${p.name}: ${formatHours(p.scheduled)} of ${formatHours(p.target)} target`,
                                     `${p.name}: ${formatHours(p.scheduled)} de ${formatHours(p.target)} objetivo`)}>
                            ↓ {p.name.split(' ')[0]} {formatHours(p.gap)}
                        </span>
                    ))}
                    {allOver.map(p => (
                        <span key={'o-' + p.name}
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-50 text-red-800 border border-red-200"
                            title={tx(`${p.name}: ${formatHours(p.scheduled)} of ${formatHours(p.target)} target — over by ${formatHours(p.gap)}`,
                                     `${p.name}: ${formatHours(p.scheduled)} de ${formatHours(p.target)} objetivo — sobre por ${formatHours(p.gap)}`)}>
                            ↑ {p.name.split(' ')[0]} +{formatHours(p.gap)}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

// Meal-window staffing counter config (2026-05-16 — replaced the hourly
// red/green coverage heatmap with a single lunch/dinner headcount per day).
//
// Operationally, the question Andrew asks while building the schedule is
// NOT "is hour 14 covered?" — it's "how many bodies do I have on lunch
// vs dinner?" So the per-day cell shows two compact pills:
//
//     🥗 L: 3   🍜 D: 5
//
// A staff member is counted in the lunch tally if their shift overlaps
// at any point with the lunch window (12:00–13:00). Dinner = 17:00–19:00.
// Examples:
//   • 10am–3pm  → lunch ✓     (covers 12-1)
//   • 12pm–4pm  → lunch ✓     (covers 12-1)
//   • 12pm–4pm  → dinner ✗   (ends before 5pm)
//   • 4pm–10pm  → dinner ✓   (covers 5-7)
//   • 9am–11am  → neither
// A shift can count for both meals (e.g. 11am–8pm hits lunch AND dinner).
// One person on multiple shifts the same day counts once per meal.
// SPLH Advisor — sits above the weekly grid. Compares scheduled hours
// per (day-of-week, daypart) against historical typical hours from Toast.
// Surfaces under-/over-staffed slots with a one-line "+1 / -1" hint plus
// any weather warnings from NWS forecast for the next several days.
// 2026-05-27 — Andrew: "in the schedule page the forcast bar lets
// let it open to a actual whether channel type report with days of
// the week and that weather in separate day weather flags. get rid
// of everything else in that bar."
//
// Component name kept (SplhAdvisor) to minimize churn at call sites,
// but the SPLH grid + variance advisory copy are GONE. The bar now
// shows ONLY the NWS weather forecast as a row of day cards
// (weather-channel pattern: day label, glyph, temp, condition,
// precipitation chance). On mobile the row scrolls horizontally; on
// desktop it lays out as a 7-column grid.
//
// Args still accepted (splhForecast, advisory, weatherTips, side)
// but only `weather`, `open`, `onToggle`, and `isEn` are used. Kept
// the prop signature so the call site doesn't have to change.

// Map an NWS shortForecast string to a Lucide weather glyph.
// Conservative keyword matching — order matters (thunderstorm
// before "rain", drizzle before "rain", etc.).
function pickWeatherIcon(forecast) {
    const f = (forecast || '').toLowerCase();
    if (f.includes('thunder') || f.includes('lightning')) return CloudLightning;
    if (f.includes('snow') || f.includes('flurr') || f.includes('sleet')) return CloudSnow;
    if (f.includes('drizzle')) return CloudDrizzle;
    if (f.includes('rain') || f.includes('shower')) return CloudRain;
    if (f.includes('fog') || f.includes('mist') || f.includes('haze')) return CloudFog;
    if (f.includes('wind')) return Wind;
    if (f.includes('partly') || f.includes('mostly sunny') || f.includes('mostly clear')) return CloudSun;
    if (f.includes('cloudy') || f.includes('overcast')) return Cloud;
    if (f.includes('sunny') || f.includes('clear') || f.includes('fair')) return Sun;
    return CloudSun;
}

function SplhAdvisor({ splhForecast, advisory, weatherTips, weather, open, onToggle, isEn, side }) {
    const tx = (en, es) => (isEn ? en : es);
    // Daytime periods only — that's "Mon / Tue / Wed / …" or
    // "Today / Tonight / Tomorrow …". NWS returns up to 14 periods
    // (7 days × day+night); slicing daytime gets us the 7-ish forward
    // days that managers care about for staffing decisions.
    const days = (weather?.periods || []).filter(p => p.isDaytime).slice(0, 7);
    const todayWeather = days[0] || null;
    const TodayIcon = todayWeather ? pickWeatherIcon(todayWeather.shortForecast) : CloudSun;

    return (
        <div className="mb-3">
            {/* Collapsed header — today's weather chip + tap-to-expand.
                Same glass-card chrome as the rest of the app; no more
                amber/green tonal flips (we no longer carry the SPLH
                advisory state). */}
            <button onClick={onToggle}
                className="w-full text-left flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl glass-sheet shadow-card hover:shadow-card-hov transition">
                <span className="flex items-center gap-2 min-w-0">
                    <span className="w-9 h-9 rounded-lg bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                        <TodayIcon size={20} strokeWidth={2.25} aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                        <span className="block text-[10px] font-black uppercase tracking-widest text-dd-text-2 leading-none">
                            {tx('Weather forecast', 'Pronóstico del clima')}
                        </span>
                        <span className="block text-sm font-bold text-dd-text leading-tight mt-0.5 truncate">
                            {todayWeather
                                ? `${todayWeather.temperature}°${todayWeather.temperatureUnit || 'F'} · ${todayWeather.shortForecast}`
                                : tx('Loading forecast…', 'Cargando pronóstico…')}
                        </span>
                    </span>
                </span>
                <ChevronDown
                    size={18}
                    strokeWidth={2.25}
                    aria-hidden="true"
                    className={`shrink-0 text-dd-text-2 transition-transform duration-glass-fast ease-glass-out ${open ? 'rotate-180' : ''}`}
                />
            </button>

            {/* Expanded body — row of day cards (weather-channel style).
                Mobile scrolls horizontally so 7 days don't crush; sm+
                lays out as a flex row that wraps on narrow desktop
                widths. Each card = one "weather flag" per day. */}
            {open && (
                <div className="mt-2 glass-sheet rounded-xl p-3 shadow-card">
                    {days.length === 0 ? (
                        <p className="text-xs text-dd-text-2 text-center py-4">
                            {tx('Loading forecast…', 'Cargando pronóstico…')}
                        </p>
                    ) : (
                        <>
                            {weather?.location && (
                                <div className="text-[10px] font-black uppercase tracking-widest text-dd-text-2 mb-2 px-1">
                                    {weather.location}
                                </div>
                            )}
                            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                                {days.map((p, idx) => {
                                    const Icon = pickWeatherIcon(p.shortForecast);
                                    const rain = p.probabilityOfPrecipitation?.value || 0;
                                    const tF = Number(p.temperature) || null;
                                    return (
                                        <div key={idx}
                                            className="shrink-0 w-[112px] rounded-xl bg-dd-sage-50/40 border border-dd-line p-2.5 flex flex-col items-center text-center">
                                            <div className="text-[10px] font-black uppercase tracking-widest text-dd-text-2 truncate w-full">
                                                {p.name}
                                            </div>
                                            <Icon size={32} strokeWidth={1.75} aria-hidden="true" className="my-2 text-dd-green-700" />
                                            <div className="text-2xl font-black tabular-nums text-dd-text leading-none">
                                                {tF != null ? `${tF}°` : '—'}
                                            </div>
                                            <div className="text-[10px] text-dd-text-2 mt-1.5 line-clamp-2 leading-tight">
                                                {p.shortForecast}
                                            </div>
                                            {rain > 0 && (
                                                <div className="mt-1.5 text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-1.5 py-0.5">
                                                    💧 {rain}%
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

// Meal windows in minutes-since-midnight. A shift "hits" the window if
// its half-open interval [start, end) overlaps the window's half-open
// interval [winStart, winEnd) — i.e. start < winEnd AND end > winStart.
const LUNCH_WIN_START = 12 * 60;  // 12:00 pm
const LUNCH_WIN_END   = 13 * 60;  // 1:00  pm
const DINNER_WIN_START = 17 * 60; // 5:00  pm
const DINNER_WIN_END   = 19 * 60; // 7:00  pm

// ── OpenShiftsCalendarBar ──────────────────────────────────────────────────
// Sling-style horizontal week strip pinned above the schedule grid.
//
// Renders ONE category at a time (split into two stacked bars by the parent
// so each category — manager-created openings vs staff-offered shifts — has
// its own header, color story, and counts). Original combined version
// mixed both, which made it harder to glance and tell what kind of action
// each chip required.
//
// Modes:
//   "unassigned" — 📋 staffing needs the MANAGER created that haven't
//                  been filled yet. BLUE palette. Tap → opens the available-
//                  staff picker for that slot (managers) or nudges staff to
//                  ask the manager.
//   "available"  — 📣 shifts STAFF have offered up. PURPLE palette (your
//                  own offers show in AMBER so you can spot them). Tap →
//                  claim (other staff) or cancel-offer (own).
//
// Hidden entirely if there's nothing for this category in the current week.
function OpenShiftsCalendarBar({
    mode,                 // 'unassigned' | 'available'
    weekStart, staffingNeeds, shifts, side, storeLocation, isEn,
    canEdit, currentStaffName, blocksByDate,
    onFillSlot, onTakeShift, onCancelOffer,
    // Speed slot add (unassigned mode only — managers tap a "+ slot"
    // chip per day to open the StaffingNeedModal pre-filled to that date).
    onAddSlot,
}) {
    const tx = (en, es) => (isEn ? en : es);
    const days = DAYS_EN.map((_, i) => addDays(weekStart, i));
    const dayLabels = isEn ? DAYS_EN : DAYS_ES;
    const today = toDateStr(new Date());
    const weekStartStr = toDateStr(weekStart);
    const weekEndStr = toDateStr(addDays(weekStart, 7));

    // Build per-mode data + visual config.
    const isUnassigned = mode === 'unassigned';

    const openSlots = isUnassigned
        ? (staffingNeeds || []).filter(n =>
            n.date >= weekStartStr && n.date < weekEndStr &&
            n.side === side &&
            (storeLocation === 'both' || n.location === 'both' || n.location === storeLocation) &&
            ((n.filledStaff || []).length < (n.count || 0)))
        : [];

    const openOffers = !isUnassigned
        ? (shifts || []).filter(s =>
            s.offerStatus === 'open' &&
            s.date >= weekStartStr && s.date < weekEndStr &&
            (storeLocation === 'both' || s.location === storeLocation) &&
            (!s.side || s.side === side))
        : [];

    const total = isUnassigned
        ? openSlots.reduce((sum, n) => sum + Math.max(0, (n.count || 0) - (n.filledStaff || []).length), 0)
        : openOffers.length;
    // Keep the unassigned bar visible for managers even when nothing is
    // unfilled, so the "+ slot" speed-add stays reachable. Available-
    // mode bar still hides on empty (no manager action to surface there).
    const showSpeedAdd = isUnassigned && canEdit && typeof onAddSlot === 'function';
    if (total === 0 && !showSpeedAdd) return null;

    const itemsByDate = new Map();
    if (isUnassigned) {
        for (const n of openSlots) {
            if (!itemsByDate.has(n.date)) itemsByDate.set(n.date, []);
            itemsByDate.get(n.date).push(n);
        }
    } else {
        for (const o of openOffers) {
            if (!itemsByDate.has(o.date)) itemsByDate.set(o.date, []);
            itemsByDate.get(o.date).push(o);
        }
    }

    // Per-mode visual + copy.
    const cfg = isUnassigned
        ? {
            // icon is a React node (Lucide); rendered inside an iconBg disc
            icon: <Users size={14} strokeWidth={2.25} aria-hidden="true" />,
            titleEn: 'Unassigned Shifts',     titleEs: 'Turnos Sin Asignar',
            countEn: 'unfilled',              countEs: 'sin llenar',
            footerEn: 'Tap a slot to fill',  footerEs: 'Toca para llenar',
            headerBg: 'from-blue-50 via-blue-50/40 to-white',
            countBg:  'bg-blue-50 text-blue-700 border-blue-200',
            iconBg:   'bg-blue-50 text-blue-700',
        }
        : {
            icon: <Megaphone size={14} strokeWidth={2.25} aria-hidden="true" />,
            titleEn: 'Available to Claim',    titleEs: 'Disponibles para Tomar',
            countEn: 'up for grabs',          countEs: 'disponibles',
            footerEn: 'Tap to claim',         footerEs: 'Toca para tomar',
            headerBg: 'from-purple-50 via-purple-50/40 to-white',
            countBg:  'bg-purple-50 text-purple-700 border-purple-200',
            iconBg:   'bg-purple-50 text-purple-700',
        };

    return (
        <div className="mb-3 glass-sheet rounded-xl shadow-card overflow-hidden print:hidden">
            {/* Header strip — title + count, color-coded per mode */}
            <div className={`flex items-center justify-between gap-2 px-3 py-2 border-b border-dd-line bg-gradient-to-r ${cfg.headerBg}`}>
                <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-7 h-7 rounded-lg ${cfg.iconBg} flex items-center justify-center text-sm flex-shrink-0`}>{cfg.icon}</span>
                    <h3 className="text-sm font-bold text-dd-text truncate">{tx(cfg.titleEn, cfg.titleEs)}</h3>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 hidden sm:inline">
                        {side === 'foh' ? 'FOH' : 'BOH'}
                    </span>
                </div>
                <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${cfg.countBg}`}>
                    {total} {tx(cfg.countEn, cfg.countEs)}
                </span>
            </div>

            {/* 7 day columns. md+ uses grid (aligns to the weekly grid below).
                Mobile uses horizontal scroll-snap with 96px columns so each
                gets a tappable chip width instead of being crushed to ~50px. */}
            <div className="flex md:grid md:grid-cols-7 md:divide-x md:divide-dd-line overflow-x-auto md:overflow-visible snap-x snap-mandatory scrollbar-thin">
                {days.map((d, i) => {
                    const dStr = toDateStr(d);
                    const isToday = dStr === today;
                    const items = itemsByDate.get(dStr) || [];
                    const dayBlocks = (blocksByDate && blocksByDate.get(dStr)) || [];
                    const closed = dayBlocks.some(b => b.type === 'closed');

                    return (
                        <div key={i} className={`shrink-0 w-[96px] md:w-auto snap-start p-1.5 min-w-0 border-r border-dd-line md:border-r-0 ${isToday ? 'bg-dd-sage-50/40' : ''} ${closed ? 'opacity-60' : ''}`}>
                            <div className={`text-center pb-1.5 mb-1.5 border-b ${isToday ? 'border-dd-green/30' : 'border-dd-line/60'}`}>
                                <div className={`text-[9px] uppercase font-bold tracking-wider ${isToday ? 'text-dd-green-700' : 'text-dd-text-2'}`}>
                                    {dayLabels[i]}
                                </div>
                                <div className={`text-xs font-black tabular-nums leading-none mt-0.5 ${isToday ? 'text-dd-green-700' : 'text-dd-text'}`}>
                                    {d.getDate()}
                                </div>
                            </div>

                            <div className="space-y-1">
                                {isUnassigned && items.map(n => {
                                    const remaining = Math.max(0, (n.count || 0) - (n.filledStaff || []).length);
                                    const roleGroup = n.roleGroup ? SLOT_ROLE_BY_ID[n.roleGroup] : null;
                                    return (
                                        <button key={'slot-' + n.id}
                                            onClick={() => onFillSlot && onFillSlot(n)}
                                            title={`${formatTime12h(n.startTime)}–${formatTime12h(n.endTime)} · ${remaining} ${tx('open', 'abierto')}${roleGroup ? ' · ' + (isEn ? roleGroup.labelEn : roleGroup.labelEs) : ''}`}
                                            className="w-full text-left rounded-md bg-blue-50 hover:bg-blue-100 border border-blue-200 px-1.5 py-1 transition active:scale-95">
                                            <div className="flex items-center justify-between gap-1">
                                                <span className="text-[10px] font-black text-blue-700 tabular-nums truncate">
                                                    📋 {formatTime12h(n.startTime).replace(':00','')}
                                                </span>
                                                {remaining > 1 && (
                                                    <span className="text-[9px] font-bold text-blue-700 bg-white rounded-full px-1 border border-blue-200 leading-tight">
                                                        ×{remaining}
                                                    </span>
                                                )}
                                            </div>
                                            {roleGroup && roleGroup.id !== 'any' && (
                                                <div className="text-[9px] font-semibold text-blue-600 truncate">
                                                    {roleGroup.emoji} {isEn ? roleGroup.labelEn : roleGroup.labelEs}
                                                </div>
                                            )}
                                        </button>
                                    );
                                })}

                                {!isUnassigned && items.map(o => {
                                    const isMine = o.staffName === currentStaffName;
                                    const tone = isMine
                                        ? 'bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-800'
                                        : 'bg-purple-50 hover:bg-purple-100 border-purple-200 text-purple-700';
                                    return (
                                        <button key={'off-' + o.id}
                                            onClick={() => {
                                                if (isMine) onCancelOffer && onCancelOffer(o);
                                                else onTakeShift && onTakeShift(o);
                                            }}
                                            title={isMine
                                                ? tx('Tap to cancel your offer', 'Toca para cancelar oferta')
                                                : tx(`Take ${o.staffName}'s shift (${formatTime12h(o.startTime)}–${formatTime12h(o.endTime)})`,
                                                     `Tomar turno de ${o.staffName} (${formatTime12h(o.startTime)}–${formatTime12h(o.endTime)})`)}
                                            className={`w-full text-left rounded-md border px-1.5 py-1 transition active:scale-95 ${tone}`}>
                                            <div className="text-[10px] font-black tabular-nums truncate">
                                                📣 {formatTime12h(o.startTime).replace(':00','')}
                                            </div>
                                            <div className="text-[9px] font-semibold truncate opacity-80">
                                                {isMine ? tx('You offered', 'Tú ofreciste') : (o.staffName?.split(' ')[0] || '?')}
                                            </div>
                                        </button>
                                    );
                                })}

                                {/* Speed slot add — same button the weekly grid
                                    uses. Renders only in unassigned mode + when
                                    a manager is viewing. */}
                                {showSpeedAdd && !closed && (
                                    <QuickAddSlot
                                        dateStr={dStr}
                                        isEn={isEn}
                                        onAddSlot={onAddSlot}
                                    />
                                )}
                                {items.length === 0 && !showSpeedAdd && (
                                    <div className="text-center text-dd-text-2/30 text-[10px] py-2 leading-none">
                                        {closed ? '🚫' : '·'}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Footer hint — single-action explanation per mode */}
            <div className="flex items-center justify-center gap-2 px-3 py-1.5 border-t border-dd-line bg-dd-bg/50 text-[10px] font-semibold text-dd-text-2">
                <span>{cfg.icon}</span>
                <span>{tx(cfg.footerEn, cfg.footerEs)}</span>
            </div>
        </div>
    );
}

// Speed slot-add — single-tap "+ slot" button in each day cell of the
// unassigned row. Opens the StaffingNeedModal pre-filled to this date so
// the manager just sets time + count + role and saves. Replaced the
// earlier QuickAddTemplate popover (2026-05-21, Andrew: "switch the
// template plus to slots plus") — direct slot creation is the common
// case; the multi-day template apply still lives in More Actions →
// Apply Template for power use.
function QuickAddSlot({ dateStr, isEn, onAddSlot }) {
    const tx = (en, es) => (isEn ? en : es);
    return (
        <button
            onClick={(e) => { e.stopPropagation(); onAddSlot(dateStr); }}
            title={tx(`Add an open slot on ${dateStr}`, `Añadir espacio el ${dateStr}`)}
            className="w-full rounded-md border border-dashed border-blue-300 text-blue-600 hover:bg-blue-100 hover:border-blue-400 px-1.5 py-1 text-[10px] font-bold leading-none transition active:scale-95">
            + {tx('slot', 'espacio')}
        </button>
    );
}

// 2026-06-14 perf (item #8) — memo-wrapped. All function props now arrive
// as stable identities (useStableCallback in the parent) and all data props
// are memoized upstream, so this skips the re-render storm that fired on
// every unrelated parent tick (notifications, clock, modals). Inner name
// kept as WeeklyGrid for clean React DevTools display, same pattern as
// ShiftCube below.
const WeeklyGrid = memo(function WeeklyGrid({ weekStart, staffSummary, shifts, isEn, currentStaffName, canEdit, isManagerOrAdmin, onCellClick, onDeleteShift, onEditShift, movingShiftId, onMoveToCell, onStaffClick, onOfferShift, onTakeShift, onCancelOffer, onRequestCover, blocksByDate, eventsByDate, onDropShift, isStaffOffOn, onDayHeaderClick, onToggleDateOpen, dateHasOpenOverride, dateClosedByRecurring, timeOff, weekNeeds, quickAddCell, onQuickAddSelect, onQuickAddCustom, onQuickAddClose, shiftPresets, onEditPresets, onUpdateShiftTimes, onPtoChipClick,
    // Open Shifts data — rendered as Sling-style rows AT THE TOP of the
    // schedule table so they share column widths with the days below.
    // openSlots: from staffingNeeds, per-day chips ("📋 4p")
    // openOffers: from shifts.offerStatus === 'open', per-day chips ("📣 Sara")
    openSlots = [], openOffers = [], side = 'foh', storeLocation = 'webster',
    onFillSlot,
    // Speed slot add — surfaces a "+ slot" button in each unassigned-row
    // day cell. Always visible when canEdit so managers can drop slots
    // onto a fresh empty week in one tap each. (Replaced earlier
    // template-add popover — Apply Template still lives in More Actions.)
    onAddSlot,
    // Multi-select pass-through for ShiftCube children
    selectedShiftIds, onToggleShiftSelection,
}) {
    // Pre-compute per-day staffing-need stats (filled / total / open) so the
    // day header can show a live countdown badge as slots get assigned.
    const needStatsByDate = useMemo(() => {
        const map = new Map();
        for (const n of (weekNeeds || [])) {
            const filled = (n.filledStaff || []).length;
            const total = n.count || 0;
            const cur = map.get(n.date) || { filled: 0, total: 0, open: 0 };
            cur.filled += Math.min(filled, total);
            cur.total += total;
            cur.open = Math.max(0, cur.total - cur.filled);
            map.set(n.date, cur);
        }
        return map;
    }, [weekNeeds]);
    // Helper: status-aware PTO lookup for the VISUAL chips. Do NOT use the
    // isStaffOffOn prop here — that guard deliberately counts PENDING as off
    // too (autofill / drag-drop safety), which made "!off && pending"
    // unreachable: pending cells rendered the approved 🌴 look and the ⏳
    // chip was dead code. Visual only — doesn't block anything. Entries
    // with no status field are legacy admin-entered pre-approvals.
    const staffPtoOn = (staffName, dateStr, status) => (timeOff || []).some(t => {
        if ((t.status || 'approved') !== status) return false;
        if (t.staffName !== staffName) return false;
        const start = t.startDate || t.date;
        const end = t.endDate || t.date;
        return dateStr >= start && dateStr <= end;
    });
    const [dragOverCell, setDragOverCell] = useState(null); // "staffName|date" while dragging
    // Memoized on weekStart so the closedByDate useMemo below (which lists
    // `days` in its deps) actually skips recompute when WeeklyGrid re-renders
    // for a reason other than the week changing.
    const days = useMemo(() => DAYS_EN.map((_, i) => addDays(weekStart, i)), [weekStart]);

    // ── Auto-scroll the page while dragging a shift near a screen edge ──
    // 2026-06-06 — Andrew: "we can drag a shift from one staff to another
    // but it gets hung up at the bottom of the page — no way to drag AND
    // scroll down." Native HTML5 drag doesn't auto-scroll, so a cube dragged
    // toward a staff row below the fold had nowhere to go. This document-
    // level dragover watcher scrolls the window when the pointer enters a
    // band near the top/bottom edge (faster the closer to the edge). Gated
    // to OUR shift drags only by checking for the 'text/shift-id'
    // dataTransfer type (set in ShiftCube.onDragStart) so it never hijacks
    // text/file/other drags. The rAF loop keeps scrolling even when the
    // pointer is held still at the edge; cleared on drop / dragend / unmount.
    useEffect(() => {
        let raf = null;
        let vy = 0;            // scroll velocity, px/frame (+down / −up)
        const EDGE = 100;      // px band at top & bottom that triggers scroll
        const MAX = 24;        // max px/frame at the very edge
        const tick = () => {
            if (vy !== 0) {
                window.scrollBy(0, vy);
                raf = requestAnimationFrame(tick);
            } else {
                raf = null;
            }
        };
        const onDragOver = (e) => {
            const types = e.dataTransfer && e.dataTransfer.types;
            if (!types || !Array.from(types).includes('text/shift-id')) return;
            const h = window.innerHeight;
            const y = e.clientY;
            if (y >= h - EDGE) {
                vy = Math.ceil(Math.min(1, (y - (h - EDGE)) / EDGE) * MAX);
            } else if (y <= EDGE) {
                vy = -Math.ceil(Math.min(1, (EDGE - y) / EDGE) * MAX);
            } else {
                vy = 0;
            }
            if (vy !== 0 && raf === null) raf = requestAnimationFrame(tick);
        };
        const stop = () => { vy = 0; if (raf) { cancelAnimationFrame(raf); raf = null; } };
        document.addEventListener('dragover', onDragOver);
        document.addEventListener('drop', stop);
        document.addEventListener('dragend', stop);
        return () => {
            document.removeEventListener('dragover', onDragOver);
            document.removeEventListener('drop', stop);
            document.removeEventListener('dragend', stop);
            stop();
        };
    }, []);
    const dayLabels = isEn ? DAYS_EN : DAYS_ES;
    const today = toDateStr(new Date());

    // 2026-05-16 — Per-day metadata for the closed-overlay watermark.
    // Andrew: "when the black out day is set lets gray out that day with
    // the name of the reason. for days that we are closed maybe a light
    // font almost a watermark going over up that whole day with CLOSED."
    //
    // Resolves the closed state CORRECTLY (recurring + one-off blocks +
    // open overrides — same priority order as parent dateClosed()) and
    // computes the reason string to display:
    //   - One-off block with a non-empty reason  → that reason text
    //     (e.g. "Memorial Day", "Christmas")
    //   - One-off block with no reason           → "Closed"
    //   - Recurring weekly rule                  → "Closed"
    //
    // Used by both the day-header rendering (big "Memorial Day" label)
    // and the body cell watermark (light translucent text in each
    // closed cell — stacked vertically they form a column watermark).
    const closedByDate = useMemo(() => {
        const map = new Map();
        for (const d of days) {
            const dStr = toDateStr(d);
            const dayBlocks = (blocksByDate?.get(dStr)) || [];
            const hasOverride = !!(dateHasOpenOverride && dateHasOpenOverride(dStr));
            const oneOff = !hasOverride && dayBlocks.find(b => b.type === 'closed');
            const recurringClosed = !hasOverride && !oneOff && !!(dateClosedByRecurring && dateClosedByRecurring(dStr));
            const closed = !!oneOff || recurringClosed;
            let reason = null;
            if (oneOff) {
                reason = (oneOff.reason && oneOff.reason.trim())
                    || (isEn ? 'Closed' : 'Cerrado');
            } else if (recurringClosed) {
                reason = isEn ? 'Closed' : 'Cerrado';
            }
            map.set(dStr, { closed, reason, hasOverride, oneOff, recurringClosed });
        }
        return map;
    }, [days, blocksByDate, dateHasOpenOverride, dateClosedByRecurring, isEn]);

    // Group shifts by staff and date for fast lookup.
    const shiftsByCell = useMemo(() => {
        const map = new Map();
        for (const sh of shifts) {
            const key = `${sh.staffName}|${sh.date}`;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(sh);
        }
        return map;
    }, [shifts]);

    // Meal-window staff counts — for each day, how many distinct people
    // have shifts that overlap the lunch window (12-1) and the dinner
    // window (5-7). De-dupes by staffName so one person on two shifts
    // the same day counts once per meal.
    //
    // Half-open interval overlap: [sm, em) overlaps [ws, we) iff
    //   sm < we && em > ws.
    // (em == ws means "ends exactly at window start" — no overlap, the
    // person clocks out as the window begins.)
    const mealCountsByDate = useMemo(() => {
        const out = new Map();
        const days = DAYS_EN.map((_, i) => addDays(weekStart, i));
        const toMin = (t) => {
            if (!t) return null;
            const [h, m] = t.split(':').map(Number);
            return h * 60 + (m || 0);
        };
        // Andrew 2026-05-22 — replace the emoji on the meal-count box
        // with a dot per manager + a dot per shift lead working that
        // meal. Position is pre-computed in the parent's staffSummary
        // (so it correctly includes isAdmin alongside role-Manager).
        const positionByName = new Map();
        for (const s of staffSummary) positionByName.set(s.name, s.position || 'regular');
        // Andrew 2026-05-30 — pre-bucket shifts by date once instead of
        // a .filter() scan PER day. Drops the inner work from O(7×N) to
        // O(N) where N is week-shift count. With ~50 weekly shifts this
        // is small in absolute terms but it ran every time `shifts`
        // identity changed (every Firestore snapshot).
        const shiftsByDate = new Map();
        for (const sh of shifts) {
            if (!sh.date) continue;
            const arr = shiftsByDate.get(sh.date);
            if (arr) arr.push(sh);
            else shiftsByDate.set(sh.date, [sh]);
        }
        for (const d of days) {
            const dStr = toDateStr(d);
            const dayShifts = shiftsByDate.get(dStr) || [];
            const lunch = new Set();
            const dinner = new Set();
            let lunchLeads = 0, lunchManagers = 0;
            let dinnerLeads = 0, dinnerManagers = 0;
            for (const sh of dayShifts) {
                // Don't count shifts that are up for grabs (offerStatus
                // 'open') or unassigned — nobody is committed to them, so they
                // shouldn't inflate the day's lunch/dinner staffing count
                // (esp. a removed staffer's now-open shift). Andrew 2026-06-23.
                if (sh.offerStatus === 'open' || !sh.staffName) continue;
                const sm = toMin(sh.startTime);
                const em = toMin(sh.endTime);
                if (sm == null || em == null) continue;
                const pos = positionByName.get(sh.staffName) || 'regular';
                if (sm < LUNCH_WIN_END  && em > LUNCH_WIN_START) {
                    lunch.add(sh.staffName);
                    if (pos === 'manager') lunchManagers += 1;
                    else if (pos === 'lead') lunchLeads += 1;
                }
                if (sm < DINNER_WIN_END && em > DINNER_WIN_START) {
                    dinner.add(sh.staffName);
                    if (pos === 'manager') dinnerManagers += 1;
                    else if (pos === 'lead') dinnerLeads += 1;
                }
            }
            out.set(dStr, {
                lunch: lunch.size, dinner: dinner.size,
                lunchLeads, lunchManagers, dinnerLeads, dinnerManagers,
            });
        }
        return out;
    }, [shifts, weekStart, staffSummary]);

    if (staffSummary.length === 0) {
        return <p className="text-center text-gray-400 mt-6 text-sm">{isEn ? 'No staff for this location.' : 'Sin personal para esta ubicación.'}</p>;
    }

    return (
        <div className="overflow-x-auto -mx-4 px-4 schedule-grid-wrap rounded-xl border border-dd-line bg-white shadow-card">
            {/* Tiny role-color legend so the blue/green/orange code is self-explanatory.
                Hidden when printing — the printed schedule uses its own legend block. */}
            <div className="flex items-center gap-3 px-3 py-2 border-b border-dd-line bg-dd-bg text-[10px] font-bold uppercase tracking-wider text-dd-text-2 print:hidden">
                <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-blue-500" /> {isEn ? 'Staff' : 'Personal'}</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> {isEn ? 'Shift Lead' : 'Líder'}</span>
                <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-orange-500" /> {isEn ? 'Manager' : 'Gerente'}</span>
                <span className="ml-auto hidden sm:inline text-dd-text-2/70 normal-case font-semibold tracking-normal">
                    {isEn ? 'Tap empty cell to add · Drag to move' : 'Toca celda para agregar · Arrastra para mover'}
                </span>
            </div>
            <table className="border-collapse text-xs min-w-max w-full">
                <thead>
                    {/* 2026-05-16 — Events strip ABOVE the day-of-week headers.
                        Surfaces calendar events + auto-derived birthdays per
                        day so the manager building next week can see "Tuesday
                        is Mother's Day" / "Friday is Carl's birthday" at a
                        glance. Only renders when something to show — empty
                        row hidden so the grid stays compact when there are
                        no events. */}
                    {eventsByDate && days.some(d => (eventsByDate.get(toDateStr(d)) || []).length > 0) && (
                        <tr>
                            <th className="sticky left-0 bg-white z-10 border-b border-dd-line px-3 py-1 text-left">
                                <span className="text-[9px] uppercase text-dd-text-2 font-bold tracking-wider">{isEn ? 'Events' : 'Eventos'}</span>
                            </th>
                            {days.map((d, i) => {
                                const dStr = toDateStr(d);
                                const evts = eventsByDate.get(dStr) || [];
                                return (
                                    <th key={i} className="border-b border-dd-line px-1 py-1 min-w-[110px] align-top bg-white">
                                        <div className="flex flex-wrap gap-0.5 justify-center">
                                            {evts.map((e, j) => {
                                                const tone =
                                                    e.type === 'birthday' ? 'bg-pink-100 text-pink-800 border-pink-200' :
                                                    e.type === 'holiday'  ? 'bg-red-100 text-red-800 border-red-200' :
                                                    e.type === 'national' ? 'bg-purple-100 text-purple-800 border-purple-200' :
                                                                            'bg-blue-100 text-blue-800 border-blue-200';
                                                return (
                                                    <span key={j} title={e.label}
                                                        className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold border ${tone} max-w-full`}>
                                                        {e.emoji && <span>{e.emoji}</span>}
                                                        <span className="truncate max-w-[80px]">{e.label}</span>
                                                    </span>
                                                );
                                            })}
                                        </div>
                                    </th>
                                );
                            })}
                        </tr>
                    )}
                    <tr>
                        <th className="sticky left-0 bg-white z-10 border-b border-dd-line px-3 py-2.5 text-left min-w-[120px]">
                            <span className="text-[10px] uppercase text-dd-text-2 font-bold tracking-wider">{isEn ? 'Staff' : 'Personal'}</span>
                        </th>
                        {days.map((d, i) => {
                            const dStr = toDateStr(d);
                            const isToday = dStr === today;
                            const dayBlocks = (blocksByDate && blocksByDate.get(dStr)) || [];
                            const meta = closedByDate.get(dStr) || {};
                            const closed = meta.closed;
                            const closedReason = meta.reason;
                            const noTimeoff = dayBlocks.some(b => b.type === 'no_timeoff');
                            const stats = needStatsByDate.get(dStr);
                            const fullyStaffed = stats && stats.total > 0 && stats.open === 0;
                            const partiallyFilled = stats && stats.total > 0 && stats.filled > 0 && stats.open > 0;
                            const allOpen = stats && stats.total > 0 && stats.filled === 0;
                            return (
                                <th key={i}
                                    onClick={() => onDayHeaderClick && !closed && onDayHeaderClick(dStr)}
                                    className={`border-b border-dd-line px-1.5 py-2.5 min-w-[110px] transition ${isToday ? 'border-l-2 border-l-dd-green' : ''} ${closed ? 'bg-dd-bg' : isToday ? 'bg-dd-sage-50' : 'bg-white'} ${onDayHeaderClick && !closed ? 'cursor-pointer hover:bg-dd-sage-50' : ''}`}>
                                    <div className={`text-[10px] uppercase font-bold tracking-wider ${closed ? 'text-dd-text-2' : isToday ? 'text-dd-green-700' : 'text-dd-text-2'}`}>{dayLabels[i]}</div>
                                    <div className={`text-base font-black tabular-nums leading-none mt-0.5 ${closed ? 'text-dd-text-2' : isToday ? 'text-dd-green-700' : 'text-dd-text'}`}>{d.getDate()}</div>
                                    {isToday && !closed && (
                                        <div className="inline-flex items-center gap-1 mt-1 text-[9px] font-bold text-dd-green-700 uppercase tracking-wider">
                                            <span className="w-1 h-1 rounded-full bg-dd-green animate-pulse" />
                                            {isEn ? 'Today' : 'Hoy'}
                                        </div>
                                    )}
                                    {/* 2026-05-20 — Andrew: "above or below
                                        the days i dont see the calenders.
                                        things like hoidays, today is national
                                        wings day". Tiny chip per day with up
                                        to 2 events (federal holidays + food
                                        observance days). Stays compact so the
                                        header doesn't grow. Title tooltip
                                        carries the full label. */}
                                    {(() => {
                                        const events = getEventsForDate(d);
                                        if (events.length === 0) return null;
                                        return (
                                            <div className="mt-1 flex flex-wrap gap-0.5 justify-center">
                                                {events.slice(0, 2).map((ev, ei) => {
                                                    const tone = EVENT_KIND_TONES[ev.kind] || EVENT_KIND_TONES.observance;
                                                    const label = isEn ? ev.en : ev.es;
                                                    return (
                                                        <span key={ei}
                                                            title={label}
                                                            className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded ${tone.bg} ${tone.border} ${tone.text} text-[9px] font-bold border leading-tight max-w-full truncate`}>
                                                            <span>{ev.icon}</span>
                                                            <span className="truncate">{label}</span>
                                                        </span>
                                                    );
                                                })}
                                                {events.length > 2 && (
                                                    <span className="text-[9px] text-dd-text-2 font-bold" title={events.slice(2).map(e => isEn ? e.en : e.es).join(' · ')}>
                                                        +{events.length - 2}
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })()}
                                    {closed && (
                                        <div className="mt-1 space-y-1">
                                            {/* 2026-05-16 — show the reason prominently
                                                in the header. "Memorial Day" / "Christmas"
                                                etc. when one-off, "Closed" when recurring. */}
                                            <div className="text-[10px] font-bold text-dd-text uppercase tracking-wider leading-tight" title={closedReason}>
                                                🚫 {closedReason}
                                            </div>
                                            {/* 2026-05-16 — open-this-day toggle.
                                                Available when canEdit AND the day is
                                                closed (either via recurring rule or
                                                one-off block). One tap → flip.
                                                Stops propagation so the cell's day-
                                                header click (Available Staff modal)
                                                doesn't also fire. */}
                                            {onToggleDateOpen && (
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); onToggleDateOpen(dStr); }}
                                                    title={isEn ? 'Open this day (one-off)' : 'Abrir este día (puntual)'}
                                                    className="text-[9px] font-bold px-1.5 py-0.5 rounded glass-sheet text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-green-700 hover:border-dd-green/40 transition">
                                                    ↺ {isEn ? 'Open' : 'Abrir'}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {/* Override-open indicator — date would be
                                        closed by recurring rule but a manager
                                        toggled it back on. Visible so they can
                                        re-close if they change their mind. */}
                                    {!closed && dateHasOpenOverride && dateHasOpenOverride(dStr) && (
                                        <div className="mt-1 space-y-1">
                                            <div className="text-[9px] font-bold text-amber-700">↺ {isEn ? 'Open (override)' : 'Abierto (anulado)'}</div>
                                            {onToggleDateOpen && (
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); onToggleDateOpen(dStr); }}
                                                    title={isEn ? 'Re-close this day' : 'Cerrar de nuevo'}
                                                    className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-white border border-amber-200 text-amber-700 hover:bg-amber-50 transition">
                                                    🚫 {isEn ? 'Close' : 'Cerrar'}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {!closed && noTimeoff && <div className="text-[9px] font-bold text-amber-700 mt-1">🛑 {isEn ? 'No PTO' : 'Sin PTO'}</div>}
                                    {/* Slot countdown — N/M filled. Color shifts as slots fill. */}
                                    {!closed && stats && stats.total > 0 && (
                                        <div className={`text-[9px] font-bold mt-1 inline-block px-1.5 py-0.5 rounded border ${
                                            fullyStaffed ? 'bg-dd-green-50 text-dd-green-700 border-dd-green/30' :
                                            partiallyFilled ? 'bg-amber-50 text-amber-800 border-amber-200' :
                                            allOpen ? 'bg-red-50 text-red-700 border-red-200' :
                                            'bg-blue-50 text-blue-700 border-blue-200'
                                        }`}>
                                            {fullyStaffed ? `✓ ${stats.filled}/${stats.total}` : `${stats.filled}/${stats.total} ${isEn ? 'slots' : 'esp.'}`}
                                        </div>
                                    )}
                                    {onDayHeaderClick && !closed && <div className="text-[8px] text-dd-text-2/60 mt-1 print:hidden font-semibold">👥 {isEn ? 'tap' : 'tocar'}</div>}
                                    {/* Meal-window staff counter — replaces the
                                        old hourly red/green coverage heatmap
                                        (2026-05-16). Two compact pills: lunch
                                        (12-1) + dinner (5-7) headcounts. Zero
                                        renders dim so a missing-staff day
                                        still reads as a gap. */}
                                    {!closed && (() => {
                                        const meals = mealCountsByDate.get(dStr) || {
                                            lunch: 0, dinner: 0,
                                            lunchLeads: 0, lunchManagers: 0,
                                            dinnerLeads: 0, dinnerManagers: 0,
                                        };
                                        const pillBase = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-black border tabular-nums';
                                        const lunchTone = meals.lunch === 0
                                            ? 'bg-red-50 text-red-700 border-red-200'
                                            : 'bg-amber-50 text-amber-800 border-amber-200';
                                        const dinnerTone = meals.dinner === 0
                                            ? 'bg-red-50 text-red-700 border-red-200'
                                            : 'bg-indigo-50 text-indigo-800 border-indigo-200';
                                        // Andrew 2026-05-22 — emojis (🥗 / 🍜) out, dots
                                        // in. One emerald dot per shift lead working
                                        // that meal, one orange dot per manager. Matches
                                        // the legend at the top of the grid (blue =
                                        // staff, green = lead, orange = manager).
                                        const renderDots = (leads, managers) => {
                                            if (leads === 0 && managers === 0) return null;
                                            const dots = [];
                                            for (let i = 0; i < leads; i++) {
                                                dots.push(<span key={`l${i}`} className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />);
                                            }
                                            for (let i = 0; i < managers; i++) {
                                                dots.push(<span key={`m${i}`} className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500" />);
                                            }
                                            return <span className="inline-flex gap-0.5 items-center">{dots}</span>;
                                        };
                                        const lunchTitle = isEn
                                            ? `Lunch (12-1pm): ${meals.lunch}${meals.lunchLeads ? `, ${meals.lunchLeads} shift lead${meals.lunchLeads === 1 ? '' : 's'}` : ''}${meals.lunchManagers ? `, ${meals.lunchManagers} manager${meals.lunchManagers === 1 ? '' : 's'}` : ''}`
                                            : `Almuerzo (12-1pm): ${meals.lunch}${meals.lunchLeads ? `, ${meals.lunchLeads} líder${meals.lunchLeads === 1 ? '' : 'es'}` : ''}${meals.lunchManagers ? `, ${meals.lunchManagers} gerente${meals.lunchManagers === 1 ? '' : 's'}` : ''}`;
                                        const dinnerTitle = isEn
                                            ? `Dinner (5-7pm): ${meals.dinner}${meals.dinnerLeads ? `, ${meals.dinnerLeads} shift lead${meals.dinnerLeads === 1 ? '' : 's'}` : ''}${meals.dinnerManagers ? `, ${meals.dinnerManagers} manager${meals.dinnerManagers === 1 ? '' : 's'}` : ''}`
                                            : `Cena (5-7pm): ${meals.dinner}${meals.dinnerLeads ? `, ${meals.dinnerLeads} líder${meals.dinnerLeads === 1 ? '' : 'es'}` : ''}${meals.dinnerManagers ? `, ${meals.dinnerManagers} gerente${meals.dinnerManagers === 1 ? '' : 's'}` : ''}`;
                                        return (
                                            <div className="mt-1 flex gap-1 justify-center print:hidden">
                                                <span className={`${pillBase} ${lunchTone}`} title={lunchTitle}>
                                                    <span>{isEn ? 'L' : 'A'}</span>:<span>{meals.lunch}</span>
                                                    {renderDots(meals.lunchLeads, meals.lunchManagers)}
                                                </span>
                                                <span className={`${pillBase} ${dinnerTone}`} title={dinnerTitle}>
                                                    <span>{isEn ? 'D' : 'C'}</span>:<span>{meals.dinner}</span>
                                                    {renderDots(meals.dinnerLeads, meals.dinnerManagers)}
                                                </span>
                                            </div>
                                        );
                                    })()}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {/* SLING-STYLE OPEN SHIFTS ROWS — rendered as full table
                        rows BEFORE the staff rows so they share column widths
                        with the day columns of the schedule grid below.
                        Visually: each row's day cell sits directly above the
                        Mon/Tue/Wed/etc cells in the staff rows underneath. */}
                    {/* Unassigned row — Sling-style. Always visible to managers
                        (canEdit) so the "+ template" speed-add button is
                        reachable on a fresh empty week. Read-only viewers
                        only see this row when there are actual unfilled
                        slots (otherwise it's noise). */}
                    {(openSlots.length > 0 || canEdit) && (
                        <tr className="bg-blue-50/40">
                            <td className="sticky left-0 z-10 bg-blue-50 border-b border-r border-dd-line px-2.5 py-2 align-middle">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-base">📋</span>
                                    <div className="min-w-0">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-blue-700 leading-none">
                                            {isEn ? 'Unassigned' : 'Sin asignar'}
                                        </div>
                                        <div className="text-[10px] font-semibold text-blue-700/70 leading-tight mt-0.5">
                                            {openSlots.length === 0
                                                ? (isEn ? '+ slot' : '+ espacio')
                                                : `${openSlots.reduce((s, n) => s + Math.max(0, (n.count || 0) - (n.filledStaff || []).length), 0)} ${isEn ? 'open' : 'abiertos'}`}
                                        </div>
                                    </div>
                                </div>
                            </td>
                            {days.map((d, i) => {
                                const dStr = toDateStr(d);
                                const dayBlocks = (blocksByDate && blocksByDate.get(dStr)) || [];
                                const closed = dayBlocks.some(b => b.type === 'closed');
                                const slots = openSlots.filter(n => n.date === dStr);
                                return (
                                    <td key={i} className={`border-b border-r border-dd-line align-top p-1 ${closed ? 'bg-dd-bg' : 'bg-blue-50/40'}`}>
                                        <div className="space-y-1">
                                            {slots.map(n => {
                                                const remaining = Math.max(0, (n.count || 0) - (n.filledStaff || []).length);
                                                const roleGroup = n.roleGroup ? SLOT_ROLE_BY_ID[n.roleGroup] : null;
                                                return (
                                                    <button key={'slot-' + n.id}
                                                        onClick={() => onFillSlot && onFillSlot(n)}
                                                        title={`${formatTime12h(n.startTime)}–${formatTime12h(n.endTime)}${roleGroup && roleGroup.id !== 'any' ? ' · ' + (isEn ? roleGroup.labelEn : roleGroup.labelEs) : ''}`}
                                                        className="w-full text-left rounded-md bg-white hover:bg-blue-100 border border-blue-300 px-1.5 py-1 transition active:scale-95 shadow-sm">
                                                        <div className="flex items-center justify-between gap-1">
                                                            <span className="text-[10px] font-black text-blue-700 tabular-nums truncate">
                                                                📋 {formatTime12h(n.startTime).replace(':00','')}
                                                            </span>
                                                            {remaining > 1 && (
                                                                <span className="text-[9px] font-bold text-blue-700 leading-tight">×{remaining}</span>
                                                            )}
                                                        </div>
                                                        {roleGroup && roleGroup.id !== 'any' && (
                                                            <div className="text-[9px] font-semibold text-blue-600 truncate leading-tight">
                                                                {roleGroup.emoji} {isEn ? roleGroup.labelEn : roleGroup.labelEs}
                                                            </div>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                            {/* Speed slot add — single-tap opens StaffingNeedModal
                                                pre-filled with this day's date. Manager only;
                                                closed days hide it (the blackout already says
                                                "don't schedule here"). */}
                                            {canEdit && !closed && onAddSlot && (
                                                <QuickAddSlot
                                                    dateStr={dStr}
                                                    isEn={isEn}
                                                    onAddSlot={onAddSlot}
                                                />
                                            )}
                                            {slots.length === 0 && !canEdit && !closed && (
                                                <div className="text-center text-blue-700/20 text-[10px] py-1 leading-none">·</div>
                                            )}
                                        </div>
                                    </td>
                                );
                            })}
                        </tr>
                    )}
                    {openOffers.length > 0 && (
                        <tr className="bg-purple-50/40">
                            <td className="sticky left-0 z-10 bg-purple-50 border-b border-r border-dd-line px-2.5 py-2 align-middle">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-base">📣</span>
                                    <div className="min-w-0">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-purple-700 leading-none">
                                            {isEn ? 'Available' : 'Disponibles'}
                                        </div>
                                        <div className="text-[10px] font-semibold text-purple-700/70 leading-tight mt-0.5">
                                            {openOffers.length} {isEn ? 'up for grabs' : 'disponibles'}
                                        </div>
                                    </div>
                                </div>
                            </td>
                            {days.map((d, i) => {
                                const dStr = toDateStr(d);
                                const dayBlocks = (blocksByDate && blocksByDate.get(dStr)) || [];
                                const closed = dayBlocks.some(b => b.type === 'closed');
                                const offers = openOffers.filter(o => o.date === dStr);
                                return (
                                    <td key={i} className={`border-b border-r border-dd-line align-top p-1 ${closed ? 'bg-dd-bg' : 'bg-purple-50/40'}`}>
                                        <div className="space-y-1">
                                            {offers.map(o => {
                                                const isMine = o.staffName === currentStaffName;
                                                const tone = isMine
                                                    ? 'bg-amber-50 hover:bg-amber-100 border-amber-300 text-amber-800'
                                                    : 'bg-white hover:bg-purple-100 border-purple-300 text-purple-700';
                                                return (
                                                    <button key={'off-' + o.id}
                                                        onClick={() => {
                                                            if (isMine) onCancelOffer && onCancelOffer(o);
                                                            else onTakeShift && onTakeShift(o);
                                                        }}
                                                        title={isMine
                                                            ? (isEn ? 'Tap to cancel your offer' : 'Toca para cancelar oferta')
                                                            : (isEn ? `Take ${o.staffName}'s shift` : `Tomar turno de ${o.staffName}`)}
                                                        className={`w-full text-left rounded-md border px-1.5 py-1 transition active:scale-95 shadow-sm ${tone}`}>
                                                        <div className="text-[10px] font-black tabular-nums truncate">
                                                            📣 {formatTime12h(o.startTime).replace(':00','')}
                                                        </div>
                                                        <div className="text-[9px] font-semibold truncate opacity-80 leading-tight">
                                                            {isMine ? (isEn ? 'You offered' : 'Tú ofreciste') : (o.staffName?.split(' ')[0] || '?')}
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                            {offers.length === 0 && !closed && (
                                                <div className="text-center text-purple-700/20 text-[10px] py-1 leading-none">·</div>
                                            )}
                                        </div>
                                    </td>
                                );
                            })}
                        </tr>
                    )}

                    {staffSummary.map(s => {
                        // Per-staff role tier color (blue = staff, green = shift
                        // lead, orange = manager). Used on the name + a small
                        // dot so the row is visually scannable at a glance.
                        const tierC = roleColors(s.role, s.shiftLead);
                        return (
                        <tr key={s.id || s.name} className={`group ${s.name === currentStaffName ? 'bg-dd-green-50/30' : 'odd:bg-dd-bg/30'}`}>
                            <td className={`sticky left-0 z-10 border-b border-r border-dd-line px-2.5 py-2 align-top ${s.name === currentStaffName ? 'bg-dd-green-50' : 'bg-white group-odd:bg-dd-bg/40'}`}>
                                <button onClick={() => onStaffClick && onStaffClick(s.name)}
                                    className="flex items-center gap-1.5 text-left hover:opacity-80 transition">
                                    <span className={`inline-block w-1.5 h-6 rounded-full ${tierC.dot}`} title={tierC.tier} />
                                    <span className="min-w-0">
                                        <span className={`block font-bold text-xs leading-tight truncate ${tierC.text}`}>
                                            {s.name}
                                            {s.shiftLead && <span title="Shift Lead" className="ml-1">🛡️</span>}
                                            {s.isMinor && <span title="Minor" className="ml-0.5">🔑</span>}
                                        </span>
                                    </span>
                                </button>
                                {/* Per-staff weekly-hours pill — ADMINS + SCHEDULE EDITORS only.
                                    Andrew (2026-06-09): "only let the admin and schedule
                                    editors see the staff's hours count under their name."
                                    canEdit = isAdmin OR has the canEditScheduleFOH/BOH toggle
                                    (see canEditSchedule). A manager WITHOUT a schedule-edit
                                    toggle no longer sees this — grant the toggle in the Admin
                                    Panel if they should. (Prior 2026-05-17 rule: isManagerOrAdmin.) */}
                                {canEdit && (
                                    <div className={`text-[10px] font-bold mt-1 inline-block px-1.5 py-0.5 rounded-md border ${hoursColor(s.totalHours)}`}>
                                        {formatHours(s.totalHours)}
                                    </div>
                                )}
                            </td>
                            {days.map((d, i) => {
                                const dStr = toDateStr(d);
                                const cellShifts = (shiftsByCell.get(`${s.name}|${dStr}`) || [])
                                    .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
                                const isToday = dStr === today;
                                const dayBlocks = (blocksByDate && blocksByDate.get(dStr)) || [];
                                // 2026-05-16 — use the shared closedByDate map
                                // so recurring closures (Sundays) AND one-off
                                // blocks BOTH cause the cell to display as
                                // closed. Previously this was a one-off-only
                                // check which let recurring-closed cells stay
                                // editable (visual bug Andrew spotted).
                                const cellMeta = closedByDate.get(dStr) || {};
                                const closed = cellMeta.closed;
                                const closedReason = cellMeta.reason;
                                const cellKey = `${s.name}|${dStr}`;
                                const isDragOver = dragOverCell === cellKey;
                                const onPTO = staffPtoOn(s.name, dStr, 'approved');
                                const onPendingPTO = !onPTO && staffPtoOn(s.name, dStr, 'pending');
                                return (
                                    <td key={i}
                                        onClick={() => {
                                            if (!canEdit || closed) return;
                                            // Move mode (Andrew 2026-06-25): a shift is armed via the
                                            // edit modal's "Move to" — tapping ANY person's day here
                                            // moves it (with the askDropShift confirm). Takes priority
                                            // over quick-add and works on cells that already have shifts.
                                            if (movingShiftId) { onMoveToCell?.(s.name, dStr); return; }
                                            // Empty cell → trigger quick-add chip strip (parent
                                            // decides whether to also fall through to slot
                                            // chooser or full modal). Cell with shifts → no-op.
                                            if (cellShifts.length === 0) onCellClick(s, dStr);
                                        }}
                                        onDragOver={(e) => {
                                            if (!canEdit || closed) return;
                                            e.preventDefault(); // allow drop
                                            e.dataTransfer.dropEffect = 'move';
                                            if (dragOverCell !== cellKey) setDragOverCell(cellKey);
                                        }}
                                        onDragLeave={() => { if (dragOverCell === cellKey) setDragOverCell(null); }}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            setDragOverCell(null);
                                            const shiftId = e.dataTransfer.getData('text/shift-id');
                                            if (shiftId && onDropShift) onDropShift(shiftId, s.name, dStr);
                                        }}
                                        className={`relative border-b border-r border-dd-line align-top p-1.5 transition ${isToday ? 'border-l-2 border-l-dd-green' : ''} ${closed ? 'bg-dd-bg' : onPTO ? 'bg-amber-50' : onPendingPTO ? 'bg-yellow-50' : isDragOver ? 'bg-blue-50 ring-2 ring-blue-400 ring-inset' : isToday ? 'bg-dd-sage-50/40' : ''} ${canEdit && cellShifts.length === 0 && !closed ? 'cursor-pointer hover:bg-dd-sage-50' : ''} ${movingShiftId && canEdit && !closed ? 'cursor-pointer ring-1 ring-inset ring-dd-green/50 hover:bg-dd-green-50' : ''}`}>
                                        {/* 2026-05-16 — closed-day watermark.
                                            Translucent reason text centered on
                                            the cell. Stacked vertically across
                                            all staff rows it reads like a
                                            single column-spanning watermark.
                                            pointer-events-none so the cell can
                                            still receive drag events (which
                                            already no-op on closed days). */}
                                        {closed && (
                                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
                                                <span className="text-[11px] font-black uppercase tracking-widest text-dd-text/15 whitespace-nowrap">
                                                    {closedReason}
                                                </span>
                                            </div>
                                        )}
                                        <div className="relative space-y-1">
                                            {/* Andrew 2026-06-10: time-off chips in the grid are
                                                now TAPPABLE for schedule editors — opens the
                                                PtoDetailsModal to approve/deny a pending request
                                                or reverse a decided one right from the calendar.
                                                Pending also renders when the day already has
                                                shifts (it used to hide behind them — exactly the
                                                cell a manager must act on before approving). */}
                                            {/* Editors get the chip even when the cell has shifts —
                                                an approved-PTO-over-published-shifts cell is exactly
                                                where the reversal entry point matters most. Non-
                                                editor 🌴 keeps the legacy empty-cell-only render. */}
                                            {onPTO && (
                                                onPtoChipClick ? (
                                                    <button onClick={(e) => { e.stopPropagation(); onPtoChipClick(s.name, dStr); }}
                                                        className="w-full text-center text-amber-700 text-[9px] font-bold py-1 rounded hover:bg-amber-100 active:bg-amber-200 print:hidden">
                                                        🌴 {isEn ? 'Time Off' : 'Libre'}
                                                    </button>
                                                ) : (
                                                    cellShifts.length === 0 && (
                                                        <div className="text-center text-amber-700 text-[9px] font-bold py-1">🌴 {isEn ? 'Time Off' : 'Libre'}</div>
                                                    )
                                                )
                                            )}
                                            {onPendingPTO && (
                                                onPtoChipClick ? (
                                                    <button onClick={(e) => { e.stopPropagation(); onPtoChipClick(s.name, dStr); }}
                                                        className="w-full text-center text-yellow-800 text-[9px] font-bold py-1 rounded bg-yellow-100/80 border border-yellow-300 hover:bg-yellow-200 active:bg-yellow-300 print:hidden">
                                                        ⏳ {isEn ? 'Pending — review' : 'Pendiente — revisar'}
                                                    </button>
                                                ) : (
                                                    <div className="text-center text-yellow-700 text-[9px] font-bold py-1">⏳ {isEn ? 'Time off pending' : 'Libre pendiente'}</div>
                                                )
                                            )}
                                            {/* Availability badge — MANAGER ONLY (canEdit gate).
                                                2026-05-15 — Andrew: "when a staff adds there
                                                availability i want to see it on there week but
                                                keep it small. only the schedule editors should
                                                be able to see it."
                                                Renders ONLY when:
                                                  - viewer is a schedule editor (canEdit)
                                                  - cell isn't on PTO or closed (those dominate)
                                                  - staff has set explicit availability that's
                                                    narrower than the all-day default OR is off
                                                Skips entirely when staff is "available all day"
                                                (the implicit default) so the grid doesn't get
                                                noise on every cell. */}
                                            {canEdit && !closed && !onPTO && !onPendingPTO && (() => {
                                                // Pull the per-day availability sub-object and pass
                                                // its PRIMITIVE fields into the memoized badge —
                                                // shallow memo compare on (available, from, to)
                                                // skips re-render of unchanged cells. Module-level
                                                // SCHEDULE_DAY_KEYS / AvailabilityBadge live near
                                                // the top of this file. Andrew 2026-05-21 perf.
                                                const dayAvail = (s.availability || {})[SCHEDULE_DAY_KEYS[d.getDay()]];
                                                if (!dayAvail) return null;
                                                return (
                                                    <AvailabilityBadge
                                                        available={dayAvail.available}
                                                        from={dayAvail.from}
                                                        to={dayAvail.to}
                                                        isEn={isEn}
                                                    />
                                                );
                                            })()}
                                            {cellShifts.map(sh => (
                                                <ShiftCube key={sh.id} shift={sh} staffRole={s.role} staffScheduleSide={s.scheduleSide} isMinor={s.isMinor} isShiftLead={s.shiftLead} canEdit={canEdit} onDelete={onDeleteShift} onEditShift={onEditShift} isEn={isEn} compact
                                                    currentStaffName={currentStaffName} onOfferShift={onOfferShift} onCancelOffer={onCancelOffer} onRequestCover={onRequestCover}
                                                    draggable={canEdit}
                                                    isDoubleDay={cellShifts.length >= 2}
                                                    dayShiftCount={cellShifts.length}
                                                    onUpdateShiftTimes={onUpdateShiftTimes}
                                                    isSelected={selectedShiftIds && selectedShiftIds.has(sh.id)}
                                                    onToggleSelection={onToggleShiftSelection} />
                                            ))}
                                            {canEdit && !onPTO && (() => {
                                                // Inline quick-add affordance — renders regardless
                                                // of how many shifts the cell already has so a
                                                // second/third shift can be tacked on without
                                                // re-opening the modal. Three states:
                                                //   - isActive → full chip strip (the preset picker)
                                                //   - empty cell → big "+" pill, cell-wide click opens it
                                                //   - cell w/ shifts → small "+ add" pill below them
                                                const isActive = quickAddCell
                                                    && quickAddCell.staff?.name === s.name
                                                    && quickAddCell.dateStr === dStr;
                                                if (isActive) {
                                                    const side = resolveStaffSide(s);
                                                    const presets = (shiftPresets && shiftPresets[side]) || getShiftPresets(side);
                                                    return (
                                                        <div onClick={(e) => e.stopPropagation()}
                                                            className="space-y-1 bg-dd-green-50 rounded-lg p-1.5 ring-2 ring-dd-green/40 shadow-card">
                                                            {presets.map(p => (
                                                                <button key={p.label} type="button"
                                                                    onClick={() => onQuickAddSelect && onQuickAddSelect(p)}
                                                                    className="w-full px-1.5 py-1 rounded-md bg-white border border-dd-green/30 text-dd-green-700 text-[10px] font-bold hover:bg-dd-sage-50 hover:border-dd-green active:scale-95 transition">
                                                                    {p.label}
                                                                </button>
                                                            ))}
                                                            <div className="flex gap-1">
                                                                <button type="button"
                                                                    onClick={() => onQuickAddCustom && onQuickAddCustom()}
                                                                    className="flex-1 px-1 py-1 rounded-md bg-white border border-blue-200 text-blue-700 text-[10px] font-bold hover:bg-blue-50 active:scale-95 transition"
                                                                    title={isEn ? 'Open full editor' : 'Abrir editor completo'}>
                                                                    ✏️
                                                                </button>
                                                                {canEdit && onEditPresets && (
                                                                    <button type="button"
                                                                        onClick={() => onEditPresets()}
                                                                        className="flex-1 px-1 py-1 rounded-md bg-white border border-dd-line text-dd-text-2 text-[10px] font-bold hover:bg-dd-bg active:scale-95 transition"
                                                                        title={isEn ? 'Edit these hour options' : 'Editar estas opciones de horas'}>
                                                                        ⚙
                                                                    </button>
                                                                )}
                                                                <button type="button"
                                                                    onClick={() => onQuickAddClose && onQuickAddClose()}
                                                                    className="flex-1 px-1 py-1 rounded-md glass-sheet text-dd-text-2 text-[10px] font-bold hover:bg-dd-bg active:scale-95 transition"
                                                                    title={isEn ? 'Cancel' : 'Cancelar'}>
                                                                    ✕
                                                                </button>
                                                            </div>
                                                        </div>
                                                    );
                                                }
                                                if (cellShifts.length === 0) {
                                                    return (
                                                        <div className="flex items-center justify-center py-1">
                                                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-dd-bg/60 text-dd-text-2/40 text-xs font-bold border border-dashed border-dd-line group-hover:bg-dd-green-50 group-hover:text-dd-green-700 group-hover:border-dd-green/40 transition">+</span>
                                                        </div>
                                                    );
                                                }
                                                // Cell already has a shift — render a compact
                                                // "+ add" pill so a 2nd/3rd shift can be added.
                                                // Has its own click handler since the cell-wide
                                                // onClick at the <td> level is gated to empty.
                                                return (
                                                    <button type="button"
                                                        onClick={(e) => { e.stopPropagation(); onCellClick(s, dStr); }}
                                                        title={isEn ? 'Add another shift' : 'Agregar otro turno'}
                                                        className="w-full flex items-center justify-center gap-0.5 px-1 py-0.5 rounded-md bg-dd-bg/60 hover:bg-dd-green-50 text-dd-text-2/60 hover:text-dd-green-700 border border-dashed border-dd-line hover:border-dd-green/40 text-[10px] font-bold transition">
                                                        <span>+</span>
                                                        <span className="text-[9px]">{isEn ? 'add' : 'agregar'}</span>
                                                    </button>
                                                );
                                            })()}
                                        </div>
                                    </td>
                                );
                            })}
                        </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
});

// Andrew 2026-05-21 perf: memo-wrapped so the 100+ cubes in a busy
// week's grid don't all re-render when an unrelated bit of parent
// state updates. Shallow prop compare catches the very common case
// of "this shift's data didn't change but the parent re-rendered".
// Some handler props (onDelete / onOfferShift / etc.) may still
// arrive as new refs each render — future pass can useCallback them
// at the parent for full benefit, but memo costs ~nothing so it's
// fine to land it now.
// 2026-05-30 perf — ShiftCube custom equality comparator.
//
// Schedule scroll was lagging because every parent re-render created
// new inline functions for the 6 onXxx callbacks. memo() with the
// default shallow compare saw "function ref changed" and re-rendered
// every visible cube even when its shift data was unchanged.
//
// Same proven pattern ChatThread's MessageBubble uses (line ~2626):
// explicitly compare the props we care about, ignore function refs.
// The handlers always read fresh state from their parent's closure
// when called, so ignoring identity is safe — they never get stale.
//
// shift is an object — its identity comes from the visibleShifts
// useMemo, which preserves shift refs across renders unless Firestore
// fires a snapshot for that shift. Comparing by shift.id catches the
// "different shift in same cell" case; the rest of msgFieldsEqual-
// style field checks catch "same shift, fields changed" updates.
function shiftFieldsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.id !== b.id) return false;
    if (a.startTime !== b.startTime) return false;
    if (a.endTime !== b.endTime) return false;
    if (a.staffName !== b.staffName) return false;
    if (a.date !== b.date) return false;
    if (a.location !== b.location) return false;
    if (a.side !== b.side) return false;
    if (a.published !== b.published) return false;
    if ((a.offerStatus || '') !== (b.offerStatus || '')) return false;
    if ((a.offeredBy || '') !== (b.offeredBy || '')) return false;
    if ((a.coverStatus || '') !== (b.coverStatus || '')) return false;
    if ((a.coverApprovedBy || '') !== (b.coverApprovedBy || '')) return false;
    if ((a.notes || '') !== (b.notes || '')) return false;
    if ((a.doubleDay || false) !== (b.doubleDay || false)) return false;
    if ((a.role || '') !== (b.role || '')) return false;
    return true;
}
const ShiftCube = memo(function ShiftCube({ shift, staffRole, staffScheduleSide, isMinor, isShiftLead, canEdit, onDelete, onEditShift, isEn, compact, currentStaffName, onOfferShift, onCancelOffer, onRequestCover, draggable, isDoubleDay, dayShiftCount, onUpdateShiftTimes,
    // Multi-select: shift+click toggles. Parent owns the Set of selected ids.
    isSelected = false, onToggleSelection,
}) {
    // Inline resize picker — opens via the right-edge handle. Lets the user
    // nudge the end time by ±15min / ±30min / ±1h with one tap. Real
    // pointer-drag on a scrolling table cell is finicky; this gives the
    // same outcome (quick shift extend/shorten) without the math.
    const [resizePickerOpen, setResizePickerOpen] = useState(false);
    // Delete now routes through the parent's central confirm dialog
    // (handleDeleteShift shows an "are you sure?" popup for EVERY delete
    // path). The cube's trash button just calls onDelete; no inline pill.
    // Andrew 2026-06-25.
    const nudgeEnd = async (deltaMin) => {
        if (!onUpdateShiftTimes) return;
        const [eh, em] = (shift.endTime || '00:00').split(':').map(Number);
        const total = eh * 60 + em + deltaMin;
        const newH = ((Math.floor(total / 60) % 24) + 24) % 24;
        const newM = ((total % 60) + 60) % 60;
        const newEnd = `${String(newH).padStart(2,'0')}:${String(newM).padStart(2,'0')}`;
        await onUpdateShiftTimes(shift.id, shift.startTime, newEnd);
        setResizePickerOpen(false);
    };

    // Right-click / long-press context menu state. Open via:
    //   - Desktop: right-click on cube (onContextMenu)
    //   - Mobile: long-press (~500ms touch hold)
    // Closes on: outside click, ESC, or any menu action.
    const [menuOpen, setMenuOpen] = useState(false);
    const longPressTimer = useRef(null);
    const beginLongPress = (e) => {
        if (!canEdit) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = setTimeout(() => setMenuOpen(true), 500);
    };
    const cancelLongPress = () => clearTimeout(longPressTimer.current);
    useEffect(() => {
        if (!menuOpen) return;
        const close = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
        document.addEventListener('keydown', close);
        return () => document.removeEventListener('keydown', close);
    }, [menuOpen]);
    const colors = roleColors(staffRole, isShiftLead);
    const warnings = isMinor ? minorShiftWarnings(shift, isEn) : [];
    const hasWarning = warnings.length > 0;
    // Inline time-edit state — tap the time text to morph into two time
    // inputs + Save / Cancel. Saves via onUpdateShiftTimes, no modal.
    // Falls through to the static time text if either canEdit is false or
    // the parent didn't pass an updater.
    const [editingTimes, setEditingTimes] = useState(false);
    const [draftStart, setDraftStart] = useState(shift.startTime || '');
    const [draftEnd, setDraftEnd] = useState(shift.endTime || '');
    const beginTimeEdit = (e) => {
        if (!canEdit || !onUpdateShiftTimes) return;
        e.stopPropagation();
        setDraftStart(shift.startTime || '');
        setDraftEnd(shift.endTime || '');
        setEditingTimes(true);
    };
    const commitTimeEdit = async () => {
        if (!editingTimes) return;
        // No-op if unchanged (avoids a needless write).
        if (draftStart === shift.startTime && draftEnd === shift.endTime) {
            setEditingTimes(false);
            return;
        }
        await onUpdateShiftTimes(shift.id, draftStart, draftEnd);
        setEditingTimes(false);
    };
    const cancelTimeEdit = () => setEditingTimes(false);
    // Raw shift hours — when this is one of two shifts on the same day, we
    // DON'T subtract the break here (the deduction happens once at the day
    // level in dayPaidHours). The badge below explains that to the user.
    const hours = (dayShiftCount && dayShiftCount >= 2)
        ? hoursBetween(shift.startTime, shift.endTime, false)
        : hoursBetween(shift.startTime, shift.endTime, shift.isDouble);
    const isMine = shift.staffName === currentStaffName;
    const isOffered = shift.offerStatus === 'open';
    const isPending = shift.offerStatus === 'pending';
    // Cover request — distinct from a casual offer. Set by the staff-side
    // "Find cover" button when they actively can't make a shift; triggers
    // an aggressive push to qualified available staff. Always paired with
    // offerStatus === 'open' on the same shift so the existing claim flow
    // (handleTakeShift) keeps working untouched.
    const isCoverRequest = isOffered && !!shift.coverNeeded;
    const isCasualOffer = isOffered && !isCoverRequest;
    const isDraft = shift.published === false;
    // Cross-side = this shift's side differs from the staff's home side.
    // Shown as a small badge so managers spot it at a glance.
    const homeSide = staffScheduleSide || (BOH_ROLE_HINTS.has(staffRole) ? 'boh' : 'foh');
    const isCrossSide = shift.side && shift.side !== homeSide;
    // Auto-double = 2+ shifts on this day. Different from shift.isDouble
    // (which is the legacy single-shift "had a built-in break" flag).
    const isAutoDouble = !!isDoubleDay && dayShiftCount >= 2;
    // Audit trail tooltip — managers and admins long-press / hover to see who created/edited.
    const auditLines = [];
    if (shift.createdBy) auditLines.push(`Created: ${shift.createdBy}`);
    if (shift.updatedBy) auditLines.push(`Edited: ${shift.updatedBy}`);
    if (shift.approvedBy) auditLines.push(`Approved (swap): ${shift.approvedBy}`);
    if (shift.publishedBy) auditLines.push(`Published: ${shift.publishedBy}`);
    if (shift.fromTemplateId) auditLines.push('From template');
    if (shift.fromRecurringId) auditLines.push('From recurring rule');
    if (shift.fromNeedId) auditLines.push('From staffing need');
    return (
        <div
            draggable={!!draggable}
            onDragStart={(e) => {
                if (!draggable) return;
                e.dataTransfer.setData('text/shift-id', shift.id);
                e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={(e) => {
                // Shift+click adds/removes the cube from the multi-select.
                // Plain click is a no-op (existing behaviors — time edit,
                // offer, delete — are on inner buttons).
                if (e.shiftKey && onToggleSelection) {
                    e.preventDefault();
                    onToggleSelection(shift.id);
                }
            }}
            onDoubleClick={(e) => {
                // Andrew 2026-06-25 — double-click opens the SHIFT EDIT modal
                // (time edit + Move to + Up for grabs + Delete all live inside).
                // Up-for-grabs is now a button in that modal, not the whole
                // window. Single click stays inert so a stray tap can't edit.
                // Touch users get the same modal via long-press → (context menu).
                if (!canEdit) return;
                e.preventDefault();
                onEditShift?.(shift);
            }}
            onContextMenu={(e) => { if (!canEdit) return; e.preventDefault(); setMenuOpen(true); }}
            onTouchStart={beginLongPress}
            onTouchEnd={cancelLongPress}
            onTouchMove={cancelLongPress}
            onTouchCancel={cancelLongPress}
            title={auditLines.join('\n') || undefined}
            className={`schedule-shift-cube relative rounded-md shadow-sm ${isDraft ? 'border-2 border-dashed border-dd-text-2/50 opacity-70' : 'border'} ${hasWarning ? 'border-amber-500 border-2' : colors.border} ${isCoverRequest ? 'ring-2 ring-red-500 ring-offset-1 ring-offset-white' : isCasualOffer ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-white' : ''} ${isPending ? 'ring-2 ring-purple-400 ring-offset-1 ring-offset-white' : ''} ${isSelected ? 'ring-2 ring-dd-green ring-offset-1 ring-offset-white' : ''} ${colors.bg} ${colors.text} px-2 py-1.5 ${compact ? 'text-[10px] leading-tight' : 'text-xs'} ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} hover:shadow-card-hov hover:-translate-y-px transition group/cube`}>
            {/* Status ribbon — single corner badge that wins by priority:
                cover-needed > swap-pending > casual-offer > draft. Gives
                managers a 100ms read of the shift's state without having
                to interpret 3 different ring colors. Placed inside the
                cube (top-left) so it doesn't fight with the delete × in
                top-right. */}
            {(isCoverRequest || isPending || isCasualOffer || isDraft) && !editingTimes && (
                <div className={`absolute -top-1.5 -left-1 z-10 print:hidden inline-flex items-center gap-0.5 px-1 py-px rounded text-[8px] font-black uppercase tracking-wider leading-none shadow-sm ${
                    isCoverRequest ? 'bg-red-500 text-white' :
                    isPending     ? 'bg-purple-500 text-white' :
                    isCasualOffer ? 'bg-blue-500 text-white' :
                                    'bg-dd-text-2/80 text-white'
                }`}
                    title={
                        isCoverRequest ? (isEn ? 'Cover needed — staff cannot make this shift' : 'Se necesita cobertura') :
                        isPending      ? (isEn ? `Pending takeover by ${shift.pendingClaimBy || '?'}` : `Pendiente: ${shift.pendingClaimBy || '?'}`) :
                        isCasualOffer  ? (isEn ? 'Offered up for grabs' : 'Disponible para tomar') :
                                         (isEn ? 'Draft — not yet published' : 'Borrador — no publicado')
                    }>
                    {isCoverRequest ? '🆘' : isPending ? '🤝' : isCasualOffer ? '📣' : '✏️'}
                    <span className="hidden sm:inline">
                        {isCoverRequest ? 'Cover' :
                         isPending      ? 'Pend' :
                         isCasualOffer  ? 'Open' :
                                          'Draft'}
                    </span>
                </div>
            )}
            {editingTimes ? (
                <div onClick={(e) => e.stopPropagation()} className="space-y-1">
                    <div className="flex items-center gap-1">
                        <input type="time" value={draftStart}
                            onChange={(e) => setDraftStart(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitTimeEdit(); if (e.key === 'Escape') cancelTimeEdit(); }}
                            className="w-full px-1 py-0.5 text-[10px] border border-dd-line rounded focus:border-dd-green focus:ring-1 focus:ring-dd-green-50 outline-none" />
                        <input type="time" value={draftEnd}
                            onChange={(e) => setDraftEnd(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitTimeEdit(); if (e.key === 'Escape') cancelTimeEdit(); }}
                            className="w-full px-1 py-0.5 text-[10px] border border-dd-line rounded focus:border-dd-green focus:ring-1 focus:ring-dd-green-50 outline-none" />
                    </div>
                    <div className="flex gap-1">
                        <button onClick={commitTimeEdit}
                            className="flex-1 py-0.5 rounded bg-dd-green text-white text-[10px] font-bold hover:bg-dd-green-700">✓ {isEn ? 'Save' : 'Guardar'}</button>
                        <button onClick={cancelTimeEdit}
                            className="px-2 py-0.5 rounded glass-sheet text-dd-text-2 text-[10px] font-bold hover:bg-dd-bg">✕</button>
                    </div>
                </div>
            ) : (
                // Display-only (Andrew 2026-06-25): the single-tap-to-edit time
                // was an easy mis-tap. Editing times is now in the double-click
                // edit modal + the long-press context menu ("Edit times").
                <div className="block w-full text-left font-black tabular-nums tracking-tight">
                    {formatTime12h(shift.startTime)}–{formatTime12h(shift.endTime)}
                </div>
            )}
            <div className="opacity-75 font-semibold tabular-nums flex items-center gap-1 flex-wrap">
                {formatHours(hours)}
                {shift.isShiftLead && <span title="Shift Lead this shift">🛡️</span>}
                {shift.isDouble && <span title="Double shift">⏱</span>}
                {isAutoDouble && <span title={isEn ? "Double day — two shifts. 1h unpaid break deducted from total." : "Día doble — dos turnos. Se resta 1h de descanso del total."}>🔁</span>}
            </div>
            {/* Status pills — compact, consistent shape */}
            {(shift.published === false || isAutoDouble || isCrossSide || isOffered || isPending) && (
                <div className="flex flex-wrap gap-0.5 mt-1">
                    {shift.published === false && (
                        <span className="inline-flex items-center text-[9px] font-bold px-1 py-0.5 rounded bg-white/60 text-dd-text-2 border border-dd-text-2/30">
                            📝 {isEn ? 'Draft' : 'Borrador'}
                        </span>
                    )}
                    {isAutoDouble && !compact && (
                        <span className="inline-flex items-center text-[9px] font-bold px-1 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                            🔁 {isEn ? 'Double day' : 'Día doble'}
                        </span>
                    )}
                    {isCrossSide && (
                        <span className="inline-flex items-center text-[9px] font-bold px-1 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                            🔀 {shift.side?.toUpperCase()}
                        </span>
                    )}
                    {isOffered && (
                        <span className="inline-flex items-center text-[9px] font-bold px-1 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                            📣 {isEn ? 'Up for grabs' : 'Disponible'}
                        </span>
                    )}
                    {isPending && (
                        <span className="inline-flex items-center text-[9px] font-bold px-1 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200" title={`${isEn ? 'Pending swap to' : 'Pendiente a'} ${shift.pendingClaimBy}`}>
                            ⏳ → {shift.pendingClaimBy?.split(' ')[0]}
                        </span>
                    )}
                </div>
            )}
            {shift.notes && !compact && (
                <div className="text-[10px] mt-1 italic opacity-75 truncate">{shift.notes}</div>
            )}
            {hasWarning && (
                <div className="text-[9px] mt-1 font-bold text-amber-700">⚠ {warnings.join(' • ')}</div>
            )}
            {/* Inline staff actions (own-shift, not pending).
                - If shift is NOT offered yet: two buttons stacked:
                    🆘 Find cover (urgent — red, pushes to all qualified)
                    📣 Give up   (casual — blue, marketplace only)
                - If already offered/cover-requested: single "Cancel" button
                  that clears both flags via handleCancelOffer.
                Surfaced inline (not just in context menu) so staff on mobile
                can find it without long-pressing.  */}
            {isMine && !isPending && onOfferShift && (
                <div className="mt-1 space-y-1 print:hidden">
                    {!isOffered && onRequestCover && (
                        <button onClick={(e) => { e.stopPropagation(); onRequestCover(shift); }}
                            className="w-full text-[9px] font-bold px-1 py-1 rounded bg-red-600 text-white hover:bg-red-700 shadow-sm transition">
                            {isEn ? '🆘 Find cover' : '🆘 Cobertura'}
                        </button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); isOffered ? onCancelOffer(shift) : onOfferShift(shift); }}
                        className={`w-full text-[9px] font-bold px-1 py-1 rounded transition ${isOffered ? 'glass-sheet text-dd-text-2 hover:bg-dd-bg' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'}`}>
                        {isOffered
                            ? (isEn ? (isCoverRequest ? 'Cancel cover' : 'Cancel offer') : 'Cancelar')
                            : (isEn ? '📣 Give up' : '📣 Liberar')}
                    </button>
                </div>
            )}
            {canEdit && (
                <button onClick={(e) => { e.stopPropagation(); onDelete(shift.id, { immediate: true }); }}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] leading-none hover:bg-red-600 print:hidden shadow-md opacity-0 group-hover/cube:opacity-100 transition flex items-center justify-center"
                    title={isEn ? 'Delete shift' : 'Eliminar turno'}>
                    🗑
                </button>
            )}

            {/* RIGHT-EDGE RESIZE HANDLE — desktop only. Opens an inline
                "extend by" picker that nudges the end time in 15min steps.
                Mobile users can use the time-edit (tap the time text). */}
            {canEdit && onUpdateShiftTimes && !compact && (
                <button onClick={(e) => { e.stopPropagation(); setResizePickerOpen(true); }}
                    title={isEn ? 'Extend / shorten shift' : 'Extender / acortar turno'}
                    className="hidden md:flex absolute top-0 bottom-0 right-0 w-2 items-center justify-center cursor-ew-resize opacity-0 group-hover/cube:opacity-100 hover:bg-dd-green/30 transition print:hidden"
                    aria-label={isEn ? 'Resize shift' : 'Cambiar tamaño de turno'}>
                    <span className="block w-0.5 h-4 bg-dd-green rounded-full" />
                </button>
            )}

            {/* RESIZE PICKER popover — opens from the right-edge handle.
                Quick ±15/30/60-min nudges to the end time. Saves
                immediately on tap. */}
            {resizePickerOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setResizePickerOpen(false)} />
                    <div className="absolute top-full right-0 mt-1 z-50 w-48 bg-white rounded-lg border border-dd-line shadow-card-hov p-2">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5 text-center">
                            {isEn ? 'Adjust end time' : 'Ajustar fin'}
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                            {[
                                { label: '−1h', min: -60 },
                                { label: '−30m', min: -30 },
                                { label: '−15m', min: -15 },
                                { label: '+15m', min: 15 },
                                { label: '+30m', min: 30 },
                                { label: '+1h', min: 60 },
                            ].map(o => (
                                <button key={o.label} onClick={(e) => { e.stopPropagation(); nudgeEnd(o.min); }}
                                    className={`py-1.5 rounded text-[11px] font-bold border transition active:scale-95 ${o.min < 0 ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100' : 'border-dd-green/30 bg-dd-green-50 text-dd-green-700 hover:bg-dd-sage-50'}`}>
                                    {o.label}
                                </button>
                            ))}
                        </div>
                        <div className="text-[9px] text-dd-text-2 text-center mt-1.5 tabular-nums">
                            {formatTime12h(shift.startTime)} → {formatTime12h(shift.endTime)}
                        </div>
                    </div>
                </>
            )}

            {/* CONTEXT MENU — opens via right-click (desktop) or long-press
                (mobile/touch). Quick actions without leaving the schedule. */}
            {menuOpen && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                    <div className="absolute top-full left-0 mt-1 z-50 w-44 bg-white rounded-lg border border-dd-line shadow-card-hov overflow-hidden">
                        <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); beginTimeEdit(e); }}
                            className="w-full px-3 py-2 text-left text-xs font-semibold text-dd-text hover:bg-dd-bg flex items-center gap-2">
                            <span>⏱</span>{isEn ? 'Edit times' : 'Editar horas'}
                        </button>
                        {/* Find Cover — urgent push to all qualified staff. Only
                            shown when the shift isn't already up for grabs or
                            pending. Once requested, the "Cancel offer" button
                            below handles both casual offers and cover requests
                            (handleCancelOffer clears both flags). */}
                        {isMine && !isPending && !isOffered && onRequestCover && (
                            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRequestCover(shift); }}
                                className="w-full px-3 py-2 text-left text-xs font-bold text-red-700 hover:bg-red-50 flex items-center gap-2">
                                <span>🆘</span>{isEn ? 'Find cover (urgent)' : 'Buscar cobertura (urgente)'}
                            </button>
                        )}
                        {isMine && !isPending && onOfferShift && (
                            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); isOffered ? onCancelOffer(shift) : onOfferShift(shift); }}
                                className="w-full px-3 py-2 text-left text-xs font-semibold text-blue-700 hover:bg-blue-50 flex items-center gap-2">
                                <span>📣</span>{isOffered ? (isEn ? (isCoverRequest ? 'Cancel cover request' : 'Cancel offer') : 'Cancelar') : (isEn ? 'Give up shift' : 'Liberar turno')}
                            </button>
                        )}
                        {onUpdateShiftTimes && (
                            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setResizePickerOpen(true); }}
                                className="w-full px-3 py-2 text-left text-xs font-semibold text-dd-text hover:bg-dd-bg flex items-center gap-2">
                                <span>↔</span>{isEn ? 'Extend / shorten' : 'Extender / acortar'}
                            </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(shift.id, { immediate: true }); }}
                            className="w-full px-3 py-2 text-left text-xs font-semibold text-red-700 hover:bg-red-50 flex items-center gap-2 border-t border-dd-line">
                            <span>🗑</span>{isEn ? 'Delete shift' : 'Eliminar turno'}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}, (prev, next) => {
    // Wrapped in try/catch so any unexpected throw falls through to
    // "re-render anyway" instead of crashing the schedule into the
    // ErrorBoundary. The audit catches the rare case; the comparator
    // itself never throws into React.
    try {
        if (prev.staffRole !== next.staffRole) return false;
        if (prev.staffScheduleSide !== next.staffScheduleSide) return false;
        if (prev.isMinor !== next.isMinor) return false;
        if (prev.isShiftLead !== next.isShiftLead) return false;
        if (prev.canEdit !== next.canEdit) return false;
        if (prev.isEn !== next.isEn) return false;
        if (prev.compact !== next.compact) return false;
        if (prev.currentStaffName !== next.currentStaffName) return false;
        if (prev.draggable !== next.draggable) return false;
        if (prev.isDoubleDay !== next.isDoubleDay) return false;
        if (prev.dayShiftCount !== next.dayShiftCount) return false;
        if (prev.isSelected !== next.isSelected) return false;
        if (!shiftFieldsEqual(prev.shift, next.shift)) return false;
        // onDelete/onOfferShift/onCancelOffer/onRequestCover/
        // onUpdateShiftTimes/onToggleSelection — intentionally not
        // compared. They always read fresh state when called.
        return true;
    } catch (e) {
        console.warn('ShiftCube comparator threw — falling back to re-render', e);
        return false;
    }
});

function DailyView({ weekStart, selectedDayIdx, setSelectedDayIdx, shifts, staffSummary, isEn, currentStaffName, canEdit, onDeleteShift, onOfferShift, onTakeShift, onCancelOffer, onRequestCover }) {
    const days = DAYS_EN.map((_, i) => addDays(weekStart, i));
    const dayLabelsFull = isEn ? DAYS_FULL_EN : DAYS_FULL_ES;
    const dayLabels = isEn ? DAYS_EN : DAYS_ES;
    const selectedDate = days[selectedDayIdx];
    const dStr = toDateStr(selectedDate);
    const dayShifts = shifts
        .filter(sh => sh.date === dStr)
        .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

    // How many shifts each staff has on the SELECTED day — used to spot
    // double-days (2+ shifts) and tag rows accordingly.
    const dayShiftCountByStaff = useMemo(() => {
        const map = new Map();
        for (const sh of dayShifts) {
            map.set(sh.staffName, (map.get(sh.staffName) || 0) + 1);
        }
        return map;
    }, [dayShifts]);

    // Lookup tables for staff role + minor status, used per-row
    const staffByName = useMemo(() => {
        const map = new Map();
        for (const s of staffSummary) map.set(s.name, s);
        return map;
    }, [staffSummary]);

    return (
        <div>
            {/* Day-of-week pills */}
            <div className="grid grid-cols-7 gap-1 mb-3 print:hidden">
                {days.map((d, i) => {
                    const isSelected = i === selectedDayIdx;
                    return (
                        <button key={i} onClick={() => setSelectedDayIdx(i)}
                            className={`py-2 rounded-lg text-center transition shadow-sm ${isSelected ? 'bg-dd-green text-white shadow-card' : 'bg-white text-dd-text-2 border border-dd-line hover:bg-dd-sage-50 hover:text-dd-text'}`}>
                            <div className="text-[10px] uppercase font-bold tracking-wider">{dayLabels[i]}</div>
                            <div className="text-sm font-black tabular-nums leading-tight">{d.getDate()}</div>
                        </button>
                    );
                })}
            </div>

            <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-bold text-dd-text">
                    {dayLabelsFull[selectedDayIdx]}
                </h3>
                <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 bg-dd-bg px-2 py-1 rounded-md border border-dd-line">
                    {dayShifts.length} {isEn ? 'shifts' : 'turnos'}
                </span>
            </div>

            {dayShifts.length === 0 ? (
                <div className="text-center py-8 bg-white rounded-xl border border-dashed border-dd-line">
                    <div className="text-3xl mb-1 opacity-50">😌</div>
                    <p className="text-sm text-dd-text-2">{isEn ? 'No shifts scheduled.' : 'Sin turnos programados.'}</p>
                </div>
            ) : (
                <div className="space-y-1">
                    {dayShifts.map(sh => {
                        const staff = staffByName.get(sh.staffName);
                        const dayCount = dayShiftCountByStaff.get(sh.staffName) || 1;
                        return (
                            <DayRow key={sh.id} shift={sh} staffRole={staff?.role} isMinor={!!staff?.isMinor}
                                isShiftLead={!!staff?.shiftLead}
                                isCurrentStaff={sh.staffName === currentStaffName}
                                canEdit={canEdit} onDelete={onDeleteShift} isEn={isEn}
                                currentStaffName={currentStaffName}
                                onOfferShift={onOfferShift}
                                onCancelOffer={onCancelOffer}
                                onRequestCover={onRequestCover}
                                dayShiftCount={dayCount} />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function DayRow({ shift, staffRole, isMinor, isShiftLead, isCurrentStaff, canEdit, onDelete, isEn, currentStaffName, onOfferShift, onCancelOffer, onRequestCover, dayShiftCount }) {
    const warnings = isMinor ? minorShiftWarnings(shift, isEn) : [];
    const colors = roleColors(staffRole, isShiftLead);
    // Auto-double = 2+ shifts on same day. Show raw shift hours; the per-day
    // 1h break deduction lives in the weekly total (dayPaidHours).
    const isAutoDouble = dayShiftCount && dayShiftCount >= 2;
    const hours = isAutoDouble
        ? hoursBetween(shift.startTime, shift.endTime, false)
        : hoursBetween(shift.startTime, shift.endTime, shift.isDouble);
    const isMine = shift.staffName === currentStaffName;
    const isOffered = shift.offerStatus === 'open';
    const isPending = shift.offerStatus === 'pending';
    // Match the ShiftCube visual taxonomy in the list view: cover-needed
    // overrides casual-offer (red beats blue); drafts get a dashed border
    // + 70% opacity wash.
    const isCoverRequest = isOffered && !!shift.coverNeeded;
    const isCasualOffer = isOffered && !isCoverRequest;
    const isDraft = shift.published === false;
    return (
        <div className={`flex items-center justify-between gap-2 p-3 rounded-lg border-2 transition shadow-sm hover:shadow-card-hov ${isDraft ? 'border-dashed border-dd-text-2/40 opacity-70' : colors.border} ${isCurrentStaff ? 'bg-dd-green-50' : colors.bg} ${warnings.length ? 'ring-2 ring-amber-400 ring-offset-1' : ''} ${isCoverRequest ? 'ring-2 ring-red-500 ring-offset-1' : isCasualOffer ? 'ring-2 ring-blue-400 ring-offset-1' : ''} ${isPending ? 'ring-2 ring-purple-400 ring-offset-1' : ''}`}>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`font-bold ${isCurrentStaff ? 'text-dd-green-700' : colors.text}`}>
                        {isCurrentStaff && '✓ '}{shift.staffName}
                    </span>
                    {staffRole && <span className={`text-[10px] font-semibold ${colors.text} opacity-70`}>· {staffRole}</span>}
                    {shift.isShiftLead && <span title="Shift Lead">🛡️</span>}
                    {shift.isDouble && <span title="Double shift">⏱</span>}
                    {isAutoDouble && <span title={isEn ? "Double day — two shifts. 1h unpaid break deducted from total." : "Día doble — dos turnos. Se resta 1h de descanso del total."} className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">🔁 {isEn ? 'Double day' : 'Día doble'}</span>}
                    {isDraft && <span title={isEn ? 'Draft — not yet published to staff' : 'Borrador — no publicado'} className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded bg-dd-bg text-dd-text-2 border border-dd-line">✏️ {isEn ? 'Draft' : 'Borrador'}</span>}
                    {isCoverRequest && <span className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 animate-pulse">🆘 {isEn ? 'Needs cover' : 'Necesita cobertura'}</span>}
                    {isCasualOffer && <span className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">📣 {isEn ? 'Up for grabs' : 'Disponible'}</span>}
                    {isPending && <span className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">⏳ → {shift.pendingClaimBy?.split(' ')[0]}</span>}
                </div>
                <div className="text-xs text-dd-text-2 mt-0.5 tabular-nums">
                    {formatTime12h(shift.startTime)} – {formatTime12h(shift.endTime)}
                    <span className="ml-2 font-bold text-dd-text">{formatHours(hours)}</span>
                    {shift.notes && <span className="italic ml-2">"{shift.notes}"</span>}
                </div>
                {warnings.length > 0 && (
                    <div className="text-[10px] font-bold text-amber-700 mt-1">⚠ {warnings.join(' • ')}</div>
                )}
            </div>
            <div className="flex items-center gap-1.5 print:hidden">
                {isMine && !isPending && !isOffered && onRequestCover && (
                    <button onClick={() => onRequestCover(shift)}
                        className="px-2.5 py-1.5 text-xs rounded-md font-bold transition bg-red-600 text-white hover:bg-red-700 shadow-sm">
                        {isEn ? '🆘 Cover' : '🆘 Cobertura'}
                    </button>
                )}
                {isMine && !isPending && onOfferShift && (
                    <button onClick={() => isOffered ? onCancelOffer(shift) : onOfferShift(shift)}
                        className={`px-2.5 py-1.5 text-xs rounded-md font-bold transition ${isOffered ? 'glass-sheet text-dd-text-2 hover:bg-dd-bg' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'}`}>
                        {isOffered
                            ? (isEn ? (isCoverRequest ? 'Cancel cover' : 'Cancel') : 'Cancelar')
                            : (isEn ? '📣 Give up' : '📣 Liberar')}
                    </button>
                )}
                {canEdit && (
                    <button onClick={() => onDelete(shift.id)}
                        className="px-2.5 py-1.5 text-xs rounded-md bg-white border border-red-200 text-red-700 hover:bg-red-50 font-bold transition">
                        {isEn ? 'Delete' : 'Borrar'}
                    </button>
                )}
            </div>
        </div>
    );
}

function ListView({ shifts, isEn, currentStaffName, canEdit, onDeleteShift, staffSummary, onOfferShift, onTakeShift, onCancelOffer, onRequestCover }) {
    const [sortKey, setSortKey] = useState('date');
    const [filterStaff, setFilterStaff] = useState('');

    const staffByName = useMemo(() => {
        const map = new Map();
        for (const s of staffSummary) map.set(s.name, s);
        return map;
    }, [staffSummary]);

    // Per (staff, date) shift count — used to detect double-days in this list.
    const dayShiftCountByCell = useMemo(() => {
        const map = new Map();
        for (const sh of shifts) {
            const key = `${sh.staffName}|${sh.date}`;
            map.set(key, (map.get(key) || 0) + 1);
        }
        return map;
    }, [shifts]);

    const sorted = useMemo(() => {
        const filtered = filterStaff
            ? shifts.filter(s => s.staffName === filterStaff)
            : shifts;
        return [...filtered].sort((a, b) => {
            if (sortKey === 'date') {
                if (a.date !== b.date) return a.date.localeCompare(b.date);
                return (a.startTime || '').localeCompare(b.startTime || '');
            }
            if (sortKey === 'staff') return (a.staffName || '').localeCompare(b.staffName || '');
            return 0;
        });
    }, [shifts, sortKey, filterStaff]);

    const allStaff = useMemo(() => {
        return [...new Set(shifts.map(s => s.staffName))].sort();
    }, [shifts]);

    return (
        <div>
            <div className="flex gap-2 mb-3 text-xs print:hidden">
                <select value={sortKey} onChange={e => setSortKey(e.target.value)}
                    className="glass-sheet rounded-lg px-2.5 py-2 text-dd-text font-semibold focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50">
                    <option value="date">{isEn ? 'Sort: Date' : 'Ordenar: Fecha'}</option>
                    <option value="staff">{isEn ? 'Sort: Staff' : 'Ordenar: Personal'}</option>
                </select>
                <select value={filterStaff} onChange={e => setFilterStaff(e.target.value)}
                    className="glass-sheet rounded-lg px-2.5 py-2 text-dd-text flex-1 focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50">
                    <option value="">{isEn ? 'All staff' : 'Todo el personal'}</option>
                    {allStaff.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
            </div>
            {sorted.length === 0 ? (
                <div className="text-center py-8 bg-white rounded-xl border border-dashed border-dd-line">
                    <div className="text-3xl mb-1 opacity-50">📭</div>
                    <p className="text-sm text-dd-text-2">{isEn ? 'No shifts.' : 'Sin turnos.'}</p>
                </div>
            ) : (
                <div className="space-y-1.5">
                    {sorted.map(sh => {
                        const date = parseLocalDate(sh.date);
                        const dayName = date ? (isEn ? DAYS_EN : DAYS_ES)[date.getDay()] : '';
                        const isMine = sh.staffName === currentStaffName;
                        const staff = staffByName.get(sh.staffName);
                        const warnings = staff?.isMinor ? minorShiftWarnings(sh, isEn) : [];
                        const colors = roleColors(staff?.role, staff?.shiftLead);
                        const dayCount = dayShiftCountByCell.get(`${sh.staffName}|${sh.date}`) || 1;
                        const isAutoDouble = dayCount >= 2;
                        const hours = isAutoDouble
                            ? hoursBetween(sh.startTime, sh.endTime, false)
                            : hoursBetween(sh.startTime, sh.endTime, sh.isDouble);
                        return (
                            <div key={sh.id} className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border-2 text-xs shadow-sm hover:shadow-card-hov transition ${isMine ? 'bg-dd-green-50 border-dd-green/30' : `${colors.bg} ${colors.border}`}`}>
                                <div className="text-center w-12 flex-shrink-0 border-r border-dd-line/50 pr-2">
                                    <div className="text-[9px] uppercase text-dd-text-2 font-bold tracking-wider">{dayName}</div>
                                    <div className="text-base font-black tabular-nums leading-tight text-dd-text">{date ? date.getDate() : ''}</div>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1 flex-wrap">
                                        <span className={`font-bold truncate ${isMine ? 'text-dd-green-700' : colors.text}`}>{sh.staffName}</span>
                                        {staff?.role && <span className={`text-[10px] opacity-70 ${colors.text}`}>· {staff.role}</span>}
                                        {sh.isShiftLead && <span>🛡️</span>}
                                        {sh.isDouble && <span>⏱</span>}
                                        {isAutoDouble && <span title={isEn ? 'Double day' : 'Día doble'} className="text-blue-700 font-bold">🔁</span>}
                                    </div>
                                    <div className="text-dd-text-2 tabular-nums">
                                        {formatTime12h(sh.startTime)}–{formatTime12h(sh.endTime)}
                                        <span className="ml-2 font-bold text-dd-text">{formatHours(hours)}</span>
                                    </div>
                                    {warnings.length > 0 && <div className="text-amber-700 font-bold">⚠ {warnings.join(' • ')}</div>}
                                </div>
                                <div className="flex items-center gap-1 print:hidden">
                                    {sh.staffName === currentStaffName && sh.offerStatus !== 'pending' && sh.offerStatus !== 'open' && onRequestCover && (
                                        <button onClick={() => onRequestCover(sh)}
                                            className="px-2 py-1.5 rounded-md font-bold text-[11px] transition bg-red-600 text-white hover:bg-red-700 shadow-sm"
                                            title={isEn ? 'Find cover (urgent push to qualified staff)' : 'Buscar cobertura urgente'}>
                                            🆘
                                        </button>
                                    )}
                                    {sh.staffName === currentStaffName && sh.offerStatus !== 'pending' && onOfferShift && (
                                        <button onClick={() => sh.offerStatus === 'open' ? onCancelOffer(sh) : onOfferShift(sh)}
                                            className={`px-2 py-1.5 rounded-md font-bold text-[11px] transition ${sh.offerStatus === 'open' ? 'glass-sheet text-dd-text-2 hover:bg-dd-bg' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'}`}>
                                            {sh.offerStatus === 'open' ? (isEn ? 'Cancel' : 'Cancelar') : '📣'}
                                        </button>
                                    )}
                                    {canEdit && (
                                        <button onClick={() => onDeleteShift(sh.id)}
                                            className="px-2 py-1.5 rounded-md bg-white border border-red-200 text-red-700 hover:bg-red-50 font-bold transition">×</button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ── SwapPanels: open offers + pending swap approval + pending PTO queue ────
function SwapPanels({ shifts, staffName, canEdit, isEn, onTake, onCancelOffer, onApprove, onDeny, storeLocation, timeOff, onApprovePto, onDenyPto, onCancelOwnPto, swapRequests = [], onApproveSwapRequest, onDenySwapRequest }) {
    const tx = (en, es) => (isEn ? en : es);
    const today = toDateStr(new Date());

    // Open offers — visible to everyone except the original owner.
    // Filter: future-or-today only (don't show shifts that already passed).
    const openOffers = shifts
        .filter(s => s.offerStatus === 'open' && s.date >= today && s.staffName !== staffName)
        .filter(s => storeLocation === 'both' || s.location === storeLocation)
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    // My open offers — quick reminder this is on me until taken.
    const myOpenOffers = shifts.filter(s => s.offerStatus === 'open' && s.staffName === staffName);

    // Pending swap approvals — managers/admin only.
    const pending = canEdit
        ? shifts.filter(s => s.offerStatus === 'pending' && s.date >= today)
            .filter(s => storeLocation === 'both' || s.location === storeLocation)
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
        : [];

    // Pending PTO requests — managers/admin only see queue. Staff see their own status.
    const pendingPto = (timeOff || []).filter(t => t.status === 'pending');
    const myPto = (timeOff || []).filter(t => t.staffName === staffName && (t.endDate || t.startDate) >= today);

    // 2026-05-16 — direct shift-swap requests. Manager queue + own
    // request status, parallel to the PTO pattern above.
    const pendingSwaps = (swapRequests || []).filter(r => r.status === 'pending');
    const mySwaps = (swapRequests || []).filter(r =>
        (r.fromStaff === staffName || r.toStaff === staffName) &&
        (r.requestedDate >= today || r.status === 'pending')
    );

    // 2026-05-27 — Andrew: "the time off request lets make that bar
    // collapsible." PTO panels (myPto + pendingPto) opt into a
    // collapse toggle by passing `collapsible` + `open` + `onToggle`.
    // Other panels (open offers, swap requests) keep their always-
    // rendered behavior by omitting those props. Default state for
    // the PTO panels is collapsed (saves vertical real estate on the
    // schedule page); preference persists per device via
    // localStorage('ddmau:schedulePto:*Open').
    //
    // CRITICAL (audit 2026-05-30): these 4 hooks MUST live ABOVE the
    // empty-state early-return below. They were originally placed below
    // it, which intermittently crashed the Schedule page with "Rendered
    // more hooks than during the previous render" any time the swap/PTO
    // data transitioned empty↔non-empty (a snapshot landing flipped the
    // hook count from 0 to 4 mid-session). Same bug class as the App.jsx
    // login white-screen the same day. Do NOT move these back down.
    const [myPtoOpen, setMyPtoOpen] = useState(() => {
        try { return localStorage.getItem('ddmau:schedulePto:myOpen') === '1'; } catch { return false; }
    });
    const [pendingPtoOpen, setPendingPtoOpen] = useState(() => {
        try { return localStorage.getItem('ddmau:schedulePto:pendingOpen') === '1'; } catch { return false; }
    });
    useEffect(() => {
        try { localStorage.setItem('ddmau:schedulePto:myOpen', myPtoOpen ? '1' : '0'); } catch {}
    }, [myPtoOpen]);
    useEffect(() => {
        try { localStorage.setItem('ddmau:schedulePto:pendingOpen', pendingPtoOpen ? '1' : '0'); } catch {}
    }, [pendingPtoOpen]);

    if (openOffers.length === 0 && pending.length === 0 && myOpenOffers.length === 0 && pendingPto.length === 0 && myPto.length === 0 && pendingSwaps.length === 0 && mySwaps.length === 0) return null;

    const renderShiftLine = (sh) => `${sh.date} · ${formatTime12h(sh.startTime)}–${formatTime12h(sh.endTime)} · ${LOCATION_LABELS[sh.location] || sh.location}`;
    const renderPtoLine = (t) => {
        const w = ptoWindowLabel(t);
        return t.startDate
            + (t.endDate && t.endDate !== t.startDate ? ` → ${t.endDate}` : '')
            + (w ? ` · ⛔ ${w} ${isEn ? 'off' : 'libre'}` : '')
            + (t.reason ? ` · ${t.reason}` : '');
    };

    // 2026-05-27 — Andrew: "lets put a time stamp on when the time off
    // request was put in." Core date math lives in the module-level
    // fmtPtoWhen (shared with TimeOffModal / PtoView / PtoDetailsModal);
    // this just prepends the verb. Returns '' for missing/invalid
    // timestamps so legacy requests skip the line instead of showing
    // "Invalid Date."
    const fmtSubmittedAt = (ts) => {
        const when = fmtPtoWhen(ts, isEn);
        return when ? tx(`Submitted ${when}`, `Enviado ${when}`) : '';
    };

    // Reusable card chrome — clean white card with semantic accent stripe.
    // When `collapsible` + `open` + `onToggle` are provided, the header
    // becomes a tappable button + chevron and the children render only
    // when open. Without those props, behavior is unchanged.
    const Panel = ({ accent, icon, title, count, children, collapsible = false, open = true, onToggle }) => {
        const HeaderTag = collapsible ? 'button' : 'div';
        return (
            <div className="rounded-xl glass-sheet shadow-card overflow-hidden">
                <HeaderTag
                    type={collapsible ? 'button' : undefined}
                    onClick={collapsible ? onToggle : undefined}
                    className={`w-full flex items-center gap-2 px-3 py-2 border-b border-dd-line bg-dd-bg/40 text-left ${collapsible ? 'hover:bg-dd-bg/70 active:bg-dd-bg/90 transition-colors' : ''}`}
                    aria-expanded={collapsible ? open : undefined}
                >
                    <span className={`w-1 h-5 rounded-full ${accent}`} />
                    {/* Sage-green disc treatment matches the weather-forecast
                        chip pattern that Andrew flagged: small rounded square
                        with a sage-50 fill + dd-green-700 stroke. Applied
                        uniformly across panel headers so every panel has the
                        same icon language. The accent stripe to the left
                        still carries the panel's semantic color (amber for
                        PTO, blue for offers, etc.). */}
                    <span className="text-sm font-bold text-dd-text flex items-center gap-2">
                        <span className="w-7 h-7 rounded-lg bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                            {icon}
                        </span>
                        {title}
                    </span>
                    {count != null && <span className="ml-auto text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{count}</span>}
                    {collapsible && (
                        <ChevronDown
                            size={16}
                            strokeWidth={2.25}
                            aria-hidden="true"
                            className={`shrink-0 text-dd-text-2 transition-transform duration-glass-fast ease-glass-out ${open ? 'rotate-180' : ''} ${count == null ? 'ml-auto' : ''}`}
                        />
                    )}
                </HeaderTag>
                {(!collapsible || open) && (
                    <div className="p-2.5 space-y-1.5">{children}</div>
                )}
            </div>
        );
    };
    return (
        <div className="mb-3 space-y-2 print:hidden">
            {/* My own open offers — gentle reminder this is still mine */}
            {myOpenOffers.length > 0 && (
                <Panel accent="bg-blue-500" icon={<Megaphone size={14} strokeWidth={2.25} />} title={tx('Your offered shifts', 'Tus turnos ofrecidos')} count={`${myOpenOffers.length} ${tx('still yours', 'aún tuyos')}`}>
                    {myOpenOffers.map(sh => (
                        <div key={sh.id} className="flex items-center justify-between gap-2 text-xs">
                            <span className="text-dd-text">{renderShiftLine(sh)}</span>
                            <button onClick={() => onCancelOffer(sh)}
                                className="px-2 py-1 rounded-md glass-sheet text-dd-text-2 font-bold hover:bg-dd-bg text-[11px]">{tx('Cancel offer', 'Cancelar oferta')}</button>
                        </div>
                    ))}
                </Panel>
            )}

            {/* Open shifts up for grabs (others can take) */}
            {openOffers.length > 0 && (
                <Panel accent="bg-blue-500" icon={<Megaphone size={14} strokeWidth={2.25} />} title={tx('Available to pick up', 'Disponibles para tomar')} count={openOffers.length}>
                    {openOffers.map(sh => (
                        <div key={sh.id} className="flex items-center justify-between gap-2 bg-blue-50 rounded-lg p-2 border border-blue-200 text-xs">
                            <div className="min-w-0">
                                <div className="font-bold text-dd-text">{sh.staffName}</div>
                                <div className="text-dd-text-2 text-[11px]">{renderShiftLine(sh)}</div>
                            </div>
                            <button onClick={() => onTake(sh)}
                                className="px-3 py-1.5 rounded-md bg-blue-600 text-white font-bold hover:bg-blue-700 whitespace-nowrap shadow-sm text-[11px]">{tx('Take', 'Tomar')}</button>
                        </div>
                    ))}
                </Panel>
            )}

            {/* Manager / admin pending approval queue */}
            {pending.length > 0 && (
                <Panel accent="bg-purple-500" icon={<Hourglass size={14} strokeWidth={2.25} />} title={tx('Pending swap approvals', 'Cambios pendientes')} count={pending.length}>
                    {pending.map(sh => (
                        <div key={sh.id} className="bg-purple-50 rounded-lg p-2 border border-purple-200 text-xs">
                            <div className="text-dd-text">
                                <b>{sh.staffName}</b> <span className="text-dd-text-2">→</span> <b className="text-purple-700">{sh.pendingClaimBy}</b>
                            </div>
                            <div className="text-dd-text-2 text-[11px]">{renderShiftLine(sh)}</div>
                            <div className="flex gap-1.5 mt-2">
                                <button onClick={() => onApprove(sh)}
                                    className="flex-1 px-2 py-1.5 rounded-md bg-dd-green text-white font-bold hover:bg-dd-green-700 shadow-sm text-[11px]">✓ {tx('Approve', 'Aprobar')}</button>
                                <button onClick={() => onDeny(sh)}
                                    className="flex-1 px-2 py-1.5 rounded-md glass-sheet text-dd-text-2 font-bold hover:bg-dd-bg text-[11px]">✕ {tx('Deny', 'Negar')}</button>
                            </div>
                        </div>
                    ))}
                </Panel>
            )}

            {/* My PTO requests (status visible to me).
                2026-05-15: added the Cancel/Withdraw/Dismiss button so
                staff can manage their own pending/approved/denied entries
                without flagging down a manager. See handleCancelOwnPto for
                the per-status rationale (silent vs notify). */}
            {myPto.length > 0 && (
                <Panel accent="bg-amber-500" icon={<Palmtree size={14} strokeWidth={2.25} />} title={tx('My time-off requests', 'Mis solicitudes')} count={myPto.length}
                    collapsible open={myPtoOpen} onToggle={() => setMyPtoOpen(v => !v)}>
                    {myPto.map(t => {
                        const status = t.status || 'pending';
                        // Per-status button label + tone:
                        //   pending  → "Cancel" (gray, low-stakes)
                        //   approved → "Withdraw" (amber, notifies manager)
                        //   denied   → "Dismiss" (gray)
                        const btnLabel = status === 'approved'
                            ? tx('Withdraw', 'Retirar')
                            : status === 'denied'
                                ? tx('Dismiss', 'Descartar')
                                : tx('Cancel', 'Cancelar');
                        const btnTone = status === 'approved'
                            ? 'bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-200'
                            : 'bg-white border-dd-line text-dd-text-2 hover:bg-dd-bg';
                        const submittedLabel = fmtSubmittedAt(t.submittedAt);
                        return (
                            <div key={t.id} className="flex items-center justify-between gap-2 bg-amber-50 rounded-lg p-2 border border-amber-200 text-xs">
                                <div className="min-w-0 text-dd-text flex-1">
                                    <div>{renderPtoLine(t)}</div>
                                    {submittedLabel && (
                                        <div className="text-[10px] text-dd-text-2 mt-0.5">{submittedLabel}</div>
                                    )}
                                </div>
                                <span className={`px-2 py-0.5 rounded-full font-bold whitespace-nowrap text-[10px] border ${
                                    status === 'approved' ? 'bg-dd-green-50 text-dd-green-700 border-dd-green/30' :
                                    status === 'denied'   ? 'bg-red-50 text-red-700 border-red-200' :
                                                             'bg-amber-100 text-amber-800 border-amber-300'
                                }`}>
                                    {status === 'approved' ? '✓ ' + tx('Approved', 'Aprobado') :
                                     status === 'denied'   ? '✕ ' + tx('Denied', 'Negado') :
                                                              '⏳ ' + tx('Pending', 'Pendiente')}
                                </span>
                                {onCancelOwnPto && (
                                    <button onClick={() => onCancelOwnPto(t)}
                                        className={`px-2 py-0.5 rounded-md text-[10px] font-bold border whitespace-nowrap ${btnTone}`}>
                                        {btnLabel}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </Panel>
            )}

            {/* Manager / admin pending PTO queue */}
            {canEdit && pendingPto.length > 0 && (
                <Panel accent="bg-amber-500" icon={<Palmtree size={14} strokeWidth={2.25} />} title={tx('Pending time-off requests', 'Solicitudes pendientes')} count={pendingPto.length}
                    collapsible open={pendingPtoOpen} onToggle={() => setPendingPtoOpen(v => !v)}>
                    {pendingPto.map(t => {
                        const submittedLabel = fmtSubmittedAt(t.submittedAt);
                        return (
                        <div key={t.id} className="bg-amber-50 rounded-lg p-2 border border-amber-200 text-xs">
                            <div className="font-bold text-dd-text">{t.staffName}</div>
                            <div className="text-dd-text-2 text-[11px]">{renderPtoLine(t)}</div>
                            {submittedLabel && (
                                <div className="text-[10px] text-dd-text-2/80 mt-0.5">{submittedLabel}</div>
                            )}
                            <div className="flex gap-1.5 mt-2">
                                <button onClick={() => onApprovePto(t)}
                                    className="flex-1 px-2 py-1.5 rounded-md bg-dd-green text-white font-bold hover:bg-dd-green-700 shadow-sm text-[11px]">✓ {tx('Approve', 'Aprobar')}</button>
                                <button onClick={() => onDenyPto(t)}
                                    className="flex-1 px-2 py-1.5 rounded-md glass-sheet text-dd-text-2 font-bold hover:bg-dd-bg text-[11px]">✕ {tx('Deny', 'Negar')}</button>
                            </div>
                        </div>
                        );
                    })}
                </Panel>
            )}

            {/* 2026-05-16 — pending shift-swap requests (manager queue) */}
            {canEdit && pendingSwaps.length > 0 && (
                <Panel accent="bg-blue-500" icon={<RefreshCw size={14} strokeWidth={2.25} />} title={tx('Pending swap requests', 'Solicitudes de cambio')} count={pendingSwaps.length}>
                    {pendingSwaps.map(r => {
                        const f = r.fromShiftSnapshot || {};
                        const t = r.toShiftSnapshot || {};
                        return (
                            <div key={r.id} className="bg-blue-50 rounded-lg p-2 border border-blue-200 text-xs">
                                <div className="font-bold text-dd-text">
                                    🔄 {r.fromStaff} ↔ {r.toStaff}
                                </div>
                                <div className="text-dd-text-2 text-[11px] mt-1">
                                    <div>{r.fromStaff}: {f.date} · {formatTime12h(f.startTime)}–{formatTime12h(f.endTime)}</div>
                                    <div>{r.toStaff}: {t.date} · {formatTime12h(t.startTime)}–{formatTime12h(t.endTime)}</div>
                                    {r.note && <div className="italic mt-0.5">"{r.note}"</div>}
                                </div>
                                <div className="flex gap-1.5 mt-2">
                                    <button onClick={() => onApproveSwapRequest && onApproveSwapRequest(r)}
                                        className="flex-1 px-2 py-1.5 rounded-md bg-dd-green text-white font-bold hover:bg-dd-green-700 shadow-sm text-[11px]">✓ {tx('Approve swap', 'Aprobar')}</button>
                                    <button onClick={() => onDenySwapRequest && onDenySwapRequest(r)}
                                        className="flex-1 px-2 py-1.5 rounded-md glass-sheet text-dd-text-2 font-bold hover:bg-dd-bg text-[11px]">✕ {tx('Deny', 'Negar')}</button>
                                </div>
                            </div>
                        );
                    })}
                </Panel>
            )}

            {/* My swap requests (status visible to requester + partner) */}
            {mySwaps.length > 0 && (
                <Panel accent="bg-blue-500" icon={<RefreshCw size={14} strokeWidth={2.25} />} title={tx('My swap requests', 'Mis cambios')} count={mySwaps.length}>
                    {mySwaps.map(r => {
                        const f = r.fromShiftSnapshot || {};
                        const t2 = r.toShiftSnapshot || {};
                        const youInitiated = r.fromStaff === staffName;
                        const partner = youInitiated ? r.toStaff : r.fromStaff;
                        return (
                            <div key={r.id} className="flex items-center justify-between gap-2 bg-blue-50 rounded-lg p-2 border border-blue-200 text-xs">
                                <div className="min-w-0 flex-1">
                                    <div className="font-bold text-dd-text truncate">
                                        🔄 {youInitiated ? tx('with', 'con') : tx('from', 'de')} {partner}
                                    </div>
                                    <div className="text-dd-text-2 text-[10px] mt-0.5">
                                        {f.date} {formatTime12h(f.startTime)}–{formatTime12h(f.endTime)} ↔ {t2.date} {formatTime12h(t2.startTime)}–{formatTime12h(t2.endTime)}
                                    </div>
                                </div>
                                <span className={`px-2 py-0.5 rounded-full font-bold whitespace-nowrap text-[10px] border ${
                                    r.status === 'approved' ? 'bg-dd-green-50 text-dd-green-700 border-dd-green/30' :
                                    r.status === 'denied'   ? 'bg-red-50 text-red-700 border-red-200' :
                                                              'bg-blue-100 text-blue-800 border-blue-300'
                                }`}>
                                    {r.status === 'approved' ? '✓ ' + tx('Approved', 'Aprobado') :
                                     r.status === 'denied'   ? '✕ ' + tx('Denied', 'Negado') :
                                                                '⏳ ' + tx('Pending', 'Pendiente')}
                                </span>
                            </div>
                        );
                    })}
                </Panel>
            )}
        </div>
    );
}

function HoursSummary({ staffSummary, isEn, currentStaffName }) {
    const scheduled = staffSummary.filter(s => s.shiftCount > 0);
    if (scheduled.length === 0) return null;
    const overtime = scheduled.filter(s => s.totalHours >= HOURS_YELLOW_MAX);
    const minorOver = scheduled.filter(s => s.isMinor && s.totalHours > MINOR_WEEKLY_HOURS_MAX);
    return (
        <div className="mt-6 glass-sheet rounded-xl shadow-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-dd-line bg-dd-bg/60">
                <h3 className="text-sm font-bold text-dd-text flex items-center gap-2">
                    <span className="w-1 h-5 bg-dd-green rounded-full" />
                    {isEn ? 'Weekly Hours' : 'Horas Semanales'}
                </h3>
                <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                    {scheduled.length} {isEn ? 'scheduled' : 'asignados'}
                </span>
            </div>
            <div className="p-4 space-y-2">
                {overtime.length > 0 && (
                    <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                        <div className="font-bold flex items-center gap-1.5 mb-0.5">
                            <span>🚨</span> {overtime.length} {isEn ? 'at/over 40 hrs' : 'en/sobre 40 hrs'}
                        </div>
                        <div className="text-[11px] opacity-90">{overtime.map(s => s.name).join(', ')}</div>
                    </div>
                )}
                {minorOver.length > 0 && (
                    <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                        <div className="font-bold flex items-center gap-1.5 mb-0.5">
                            <span>⚠</span> {minorOver.length} {isEn ? `minor(s) over ${MINOR_WEEKLY_HOURS_MAX}h` : `menor(es) sobre ${MINOR_WEEKLY_HOURS_MAX}h`}
                        </div>
                        <div className="text-[11px] opacity-90">{minorOver.map(s => s.name).join(', ')}</div>
                    </div>
                )}
                <div className="grid grid-cols-2 gap-1.5">
                    {scheduled.map(s => (
                        <div key={s.id || s.name} className={`flex items-center justify-between gap-2 p-2 rounded-lg border text-xs transition ${s.name === currentStaffName ? 'bg-dd-green-50 border-dd-green/30' : 'bg-white border-dd-line hover:border-dd-text-2/30'}`}>
                            <span className="font-semibold truncate text-dd-text">
                                {s.name === currentStaffName && <span className="text-dd-green-700">✓ </span>}
                                {s.name}
                                {s.isMinor && <span className="ml-1">🔑</span>}
                            </span>
                            <span className={`flex-shrink-0 px-1.5 py-0.5 rounded-md border font-bold tabular-nums ${hoursColor(s.totalHours)}`}>
                                {formatHours(s.totalHours)}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ── Add Shift Modal ────────────────────────────────────────────────────────

// ── ShiftPresetsEditor ───────────────────────────────────────────────
// Manager-editable quick-add hour chips (Andrew 2026-06-17 "make those hours
// editable"). Edits the FOH + BOH preset lists stored in
// config/schedule_settings.shiftPresets. Empty/invalid rows are dropped on save
// by sanitizeShiftPresets, so a half-filled row can't corrupt the config.
function ShiftPresetsEditor({ presets, onSave, onClose, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const [side, setSide] = useState('foh');
    const [draft, setDraft] = useState(() => ({
        foh: (presets?.foh || []).map(p => ({ ...p })),
        boh: (presets?.boh || []).map(p => ({ ...p })),
    }));
    const [busy, setBusy] = useState(false);
    const list = draft[side] || [];
    const setList = (next) => setDraft(d => ({ ...d, [side]: next }));
    const updateRow = (i, k, v) => setList(list.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
    const addRow = () => setList([...list, { label: '', start: '15:00', end: '20:00', isDouble: false }]);
    const delRow = (i) => setList(list.filter((_, idx) => idx !== i));
    const save = async () => {
        if (busy) return;
        setBusy(true);
        try { await onSave(draft); } finally { setBusy(false); }
    };
    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-2 sm:p-4 pt-16 sm:pt-20">
            <div className="glass-sheet w-full sm:max-w-md rounded-2xl max-h-[calc(100vh-90px)] sm:max-h-[calc(100vh-120px)] overflow-hidden flex flex-col shadow-2xl">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between shrink-0">
                    <h3 className="text-lg font-bold text-dd-green-700">⚙ {tx('Edit shift hours', 'Editar horas de turno')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 text-lg">×</button>
                </div>
                <div className="px-4 pt-3 grid grid-cols-2 gap-2 shrink-0">
                    {['foh', 'boh'].map(sd => (
                        <button key={sd} type="button" onClick={() => setSide(sd)}
                            className={`py-2 rounded-lg text-sm font-bold border transition ${side === sd ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-dd-text-2 border-dd-line'}`}>
                            {sd.toUpperCase()}
                        </button>
                    ))}
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    <p className="text-[11px] text-dd-text-2">{tx('These are the one-tap chips shown when you press + on the schedule. The label is what shows on the chip; the times fill the shift.', 'Estos son los botones al presionar + en el horario. La etiqueta se muestra en el botón; las horas llenan el turno.')}</p>
                    {list.map((r, i) => (
                        <div key={i} className="flex items-center gap-1.5 bg-white border border-dd-line rounded-lg p-1.5">
                            <input value={r.label} onChange={e => updateRow(i, 'label', e.target.value)} placeholder={tx('Label', 'Etiqueta')}
                                className="w-14 border border-dd-line rounded px-1.5 py-1 text-xs" />
                            <input type="time" value={r.start} onChange={e => updateRow(i, 'start', e.target.value)}
                                className="border border-dd-line rounded px-1 py-1 text-xs" />
                            <span className="text-dd-text-2 text-xs">–</span>
                            <input type="time" value={r.end} onChange={e => updateRow(i, 'end', e.target.value)}
                                className="border border-dd-line rounded px-1 py-1 text-xs" />
                            <label className="text-[10px] flex items-center gap-0.5" title={tx('Double shift', 'Turno doble')}>
                                <input type="checkbox" checked={!!r.isDouble} onChange={e => updateRow(i, 'isDouble', e.target.checked)} /> 2x
                            </label>
                            <button type="button" onClick={() => delRow(i)} className="ml-auto text-red-600 text-sm px-1" title={tx('Remove', 'Quitar')}>✕</button>
                        </div>
                    ))}
                    {list.length === 0 && <p className="text-xs text-dd-text-2 py-2">{tx('No presets yet — add one.', 'Sin presets — agrega uno.')}</p>}
                    <button type="button" onClick={addRow}
                        className="w-full py-2 rounded-lg border border-dashed border-dd-green/40 text-dd-green-700 text-xs font-bold hover:bg-dd-green-50">
                        + {tx('Add preset', 'Agregar preset')}
                    </button>
                </div>
                <div className="border-t border-gray-200 p-4 flex gap-2 shrink-0">
                    <button onClick={onClose} className="flex-1 py-2 rounded-lg glass-button-apple text-dd-text-2 font-bold">{tx('Cancel', 'Cancelar')}</button>
                    <button onClick={save} disabled={busy} className="flex-1 py-2 rounded-lg font-bold text-white bg-dd-green hover:bg-dd-green-700 disabled:opacity-50">{busy ? '…' : tx('Save', 'Guardar')}</button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── Shift edit modal (Andrew 2026-06-25) ──────────────────────────────────
// Opened by DOUBLE-CLICK on a shift cube (single click is intentionally inert
// so a stray tap can't edit). One place for every per-shift action managers
// asked for: edit start/end times, "Move to" (arms tap-to-move), "Up for
// grabs" (opens the existing offer composer), and Delete (routes to the
// central are-you-sure confirm). Closes on backdrop click / ✕ / Android back
// via ModalPortal.
function ShiftEditModal({ shift, isEn, locationLabel, onClose, onSaveTimes, onMove, onOffer, onDelete }) {
    const tx = (en, es) => (isEn ? en : es);
    const [start, setStart] = useState(shift.startTime || '');
    const [end, setEnd] = useState(shift.endTime || '');
    const timesChanged = start !== (shift.startTime || '') || end !== (shift.endTime || '');
    const isOffered = shift.offerStatus === 'open';
    return (
        <ModalPortal onBackPress={onClose}>
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
                onClick={onClose} role="dialog" aria-modal="true">
                <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-dd-line overflow-hidden"
                    onClick={(e) => e.stopPropagation()}>
                    <div className="px-4 py-3 bg-dd-green-50 border-b border-dd-line flex items-start justify-between gap-2">
                        <div>
                            <div className="text-base font-black text-dd-text">{shift.staffName || tx('Unassigned', 'Sin asignar')}</div>
                            <div className="text-xs text-dd-text-2 mt-0.5">{shift.date}{locationLabel ? ` • ${locationLabel}` : ''}</div>
                        </div>
                        <button onClick={onClose} aria-label={tx('Close', 'Cerrar')}
                            className="w-8 h-8 rounded-lg bg-white/70 text-dd-text-2 hover:bg-white text-lg leading-none shrink-0">✕</button>
                    </div>
                    <div className="px-4 py-3 space-y-2 border-b border-dd-line">
                        <div className="text-[11px] font-bold uppercase tracking-wider text-dd-text-2">{tx('Shift time', 'Hora del turno')}</div>
                        <div className="flex items-center gap-2">
                            <input type="time" value={start} onChange={(e) => setStart(e.target.value)}
                                className="flex-1 px-2 py-2 text-base border border-dd-line rounded-lg focus:border-dd-green focus:ring-1 focus:ring-dd-green-50 outline-none" />
                            <span className="text-dd-text-2">–</span>
                            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)}
                                className="flex-1 px-2 py-2 text-base border border-dd-line rounded-lg focus:border-dd-green focus:ring-1 focus:ring-dd-green-50 outline-none" />
                        </div>
                        {timesChanged && (
                            <button onClick={() => onSaveTimes(start, end)}
                                className="w-full py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 active:scale-95 transition">
                                ✓ {tx('Save time', 'Guardar hora')}
                            </button>
                        )}
                    </div>
                    <div className="px-4 py-3 space-y-2">
                        <button onClick={onMove}
                            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white border border-dd-line hover:bg-dd-bg active:scale-95 transition text-left">
                            <span className="text-xl">📍</span>
                            <div className="flex-1">
                                <div className="text-sm font-bold text-dd-text">{tx('Move to…', 'Mover a…')}</div>
                                <div className="text-[11px] text-dd-text-2">{tx("Then tap the person's day to move it there", 'Luego toca el día de la persona')}</div>
                            </div>
                        </button>
                        <button onClick={onOffer}
                            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white border border-blue-200 hover:bg-blue-50 active:scale-95 transition text-left">
                            <span className="text-xl">📣</span>
                            <div className="flex-1">
                                <div className="text-sm font-bold text-blue-700">{isOffered ? tx('Already up for grabs', 'Ya disponible') : tx('Up for grabs', 'Disponible para tomar')}</div>
                                <div className="text-[11px] text-dd-text-2">{tx('Offer this shift to other staff', 'Ofrecer este turno al personal')}</div>
                            </div>
                        </button>
                        <button onClick={onDelete}
                            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white border border-red-200 hover:bg-red-50 active:scale-95 transition text-left">
                            <span className="text-xl">🗑</span>
                            <div className="flex-1">
                                <div className="text-sm font-bold text-red-700">{tx('Delete shift', 'Eliminar turno')}</div>
                                <div className="text-[11px] text-dd-text-2">{tx('Asks you to confirm first', 'Te pedirá confirmar primero')}</div>
                            </div>
                        </button>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}

function AddShiftModal({ onClose, onSave, staffList, storeLocation, isEn, prefill, weekStart, dateClosed, existingShifts, timeOff = [], canEditFOH = true, canEditBOH = true, shiftPresets = null, onEditPresets = null }) {
    const today = toDateStr(new Date());
    const tx = (en, es) => (isEn ? en : es);
    // Audit 2026-05-20 — guard against double-submit. Without this, a
    // rapid double-tap on Save (real on iPad with imprecise touch)
    // creates two shift docs before handleAddShift closes the modal.
    // Manager then has to find and delete the duplicate.
    const [saving, setSaving] = useState(false);

    const [form, setForm] = useState({
        staffName: prefill?.staffName || '',
        date: prefill?.date || today,
        startTime: prefill?.startTime || '10:00',
        endTime: prefill?.endTime || '15:00',
        location: prefill?.location && prefill.location !== 'both' ? prefill.location : (storeLocation && storeLocation !== 'both' ? storeLocation : 'webster'),
        side: prefill?.side || null, // null = use staff default; 'foh'/'boh' = explicit override
        isShiftLead: false,
        isDouble: false,
        notes: '',
    });

    // Resolve the staff member's default side (from their AdminPanel record).
    const selectedStaffForPresets = staffList?.find(s => s.name === form.staffName);
    const staffDefaultSide = (() => {
        if (!selectedStaffForPresets) return null;
        const explicit = selectedStaffForPresets.scheduleSide;
        if (explicit === 'foh' || explicit === 'boh') return explicit;
        if (BOH_ROLE_HINTS && BOH_ROLE_HINTS.has && BOH_ROLE_HINTS.has(selectedStaffForPresets.role)) return 'boh';
        return 'foh';
    })();
    // The effective side for this shift = explicit override OR staff's default.
    // Used to pick the right preset chip set.
    const presetSide = form.side || staffDefaultSide || 'foh';
    const isCrossSide = form.side && staffDefaultSide && form.side !== staffDefaultSide;

    // If the user only has one side's editor toggle, force every shift
    // they create through this modal to that side — overriding whatever
    // the staff member's default side is, whatever prefill said, etc.
    // The picker buttons are disabled for the other side, so this just
    // keeps the form in sync visually + at save time.
    useEffect(() => {
        if (canEditFOH && !canEditBOH && presetSide !== 'foh') {
            setForm(f => ({ ...f, side: 'foh' }));
        } else if (!canEditFOH && canEditBOH && presetSide !== 'boh') {
            setForm(f => ({ ...f, side: 'boh' }));
        }
    }, [canEditFOH, canEditBOH, presetSide]);
    const SHIFT_PRESETS = (shiftPresets && shiftPresets[presetSide]) || getShiftPresets(presetSide);
    const isPresetActive = (p) => form.startTime === p.start && form.endTime === p.end && form.isDouble === !!p.isDouble;

    const eligibleStaff = useMemo(() => {
        return (staffList || [])
            .filter(s => storeLocation === 'both' || s.location === 'both' || s.location === storeLocation || s.location === form.location)
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [staffList, storeLocation, form.location]);

    const updateField = (k, v) => setForm(f => ({ ...f, [k]: v }));

    const hours = hoursBetween(form.startTime, form.endTime, form.isDouble);
    const selectedStaff = staffList?.find(s => s.name === form.staffName);
    const minorWarnings = selectedStaff?.isMinor ? minorShiftWarnings(form, isEn) : [];

    // 2026-06-20 (QA audit S2) — pass the staffer's store so a single-location
    // closure is enforced when adding from the "both" view (no-arg only blocks
    // when BOTH stores are closed). Undefined location falls back to that
    // existing behavior, so this only ever tightens the check.
    const isOnClosedDate = dateClosed && dateClosed(form.date, selectedStaff?.location);

    // CONFLICT DETECTION — added 2026-05-10. Surfaces three classes of
    // "this might be wrong" warnings the manager should see BEFORE saving:
    //   1. PTO conflict — the staffer is on approved time-off this date
    //   2. Pending PTO — they have a pending request for this date
    //   3. Over hours — this shift would push them past their target
    //      hours/week (signals OT risk)
    // Warnings are non-blocking (manager can still save) but visible
    // enough that an accidental click is unlikely to slip through.
    const ptoConflict = (timeOff || []).find(t =>
        t.staffName === form.staffName &&
        (t.startDate || t.date) <= form.date &&
        (t.endDate || t.startDate || t.date) >= form.date &&
        (t.status === 'approved' || t.status === 'pending')
    );
    // AVAILABILITY CONFLICT — 2026-05-15. Andrew: "when i added a shift
    // out side of there available hours it should say something but it
    // didnt."
    //
    // Two flavors:
    //   • OFF day — staff marked this day-of-week as unavailable
    //     (dayAvail.available === false). Surfaced as red banner.
    //   • OUTSIDE HOURS — staff set a narrower-than-default window and
    //     the shift starts before / ends after that window. Surfaced as
    //     amber banner with the specific window so the manager can
    //     compare against the shift they're saving.
    //
    // Non-blocking like the other conflict warnings (PTO / over-hours /
    // minor): the manager may know "I asked Maria and she said it's OK"
    // and should be able to save anyway. The banner is the cue, not the
    // gate.
    // Delegates to checkAvailabilityConflict — same logic now also used by
    // handleUpdateShiftTimes (drag-resize) and handleDropShift (drag-to-
    // different-day) so the conflict surfaces on EVERY shift mutation path,
    // not just the modal. Kept the inline call here so React reruns it on
    // every form change without an extra memo layer.
    const availabilityConflict = checkAvailabilityConflict(selectedStaff, form.date, form.startTime, form.endTime);
    const weekStartStr = weekStart ? toDateStr(weekStart) : null;
    const weekEndStr   = weekStart ? toDateStr(addDays(weekStart, 7)) : null;
    const weekHoursForStaff = (existingShifts || [])
        .filter(s => s.staffName === form.staffName && s.date >= weekStartStr && s.date < weekEndStr)
        .reduce((sum, s) => sum + hoursBetween(s.startTime, s.endTime, s.isDouble), 0);
    const targetHours = selectedStaff?.targetHours || 0;
    const projectedTotal = weekHoursForStaff + hours;
    const overHours = targetHours > 0 && projectedTotal > targetHours;
    const overOT = projectedTotal > 40;

    // 2026-06-16 (#19): require end AFTER start. hoursBetween() wraps an
    // end<=start to a positive "overnight" value, so `hours > 0` alone let an
    // accidental overnight shift through here while inline drag-edit rejected
    // it — and overnight breaks the split-pickup math. DD Mau has no overnight
    // shifts, so block it uniformly (matches handleUpdateShiftTimes).
    const canSubmit = form.staffName && form.date && form.startTime && form.endTime && form.endTime > form.startTime && hours > 0 && !isOnClosedDate;

    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto sm:shadow-2xl">
                <div className="sticky top-0 bg-white border-b border-dd-line p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-dd-text">+ {tx('Add Shift', 'Agregar Turno')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg">×</button>
                </div>

                <div className="p-4 space-y-3">
                    {/* Staff */}
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Staff', 'Personal')}</label>
                        <select value={form.staffName} onChange={e => updateField('staffName', e.target.value)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition">
                            <option value="">{tx('— Select —', '— Selecciona —')}</option>
                            {eligibleStaff.map(s => (
                                <option key={s.id || s.name} value={s.name}>
                                    {s.name}{s.isMinor ? ' 🔑' : ''}{s.shiftLead ? ' 🛡️' : ''} · {(s.scheduleSide || (BOH_ROLE_HINTS.has(s.role) ? 'boh' : 'foh')).toUpperCase()}
                                </option>
                            ))}
                        </select>
                        {staffDefaultSide && (
                            <p className="text-[10px] text-gray-500 mt-1">
                                {tx(`Default side: ${staffDefaultSide.toUpperCase()}`, `Lado predeterminado: ${staffDefaultSide.toUpperCase()}`)}
                            </p>
                        )}
                    </div>

                    {/* Side override — defaults to staff's home side, can flip per shift */}
                    {form.staffName && staffDefaultSide && (
                        <div>
                            <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">
                                {tx('Working side this shift', 'Lado de este turno')}
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <button type="button" onClick={() => canEditFOH && updateField('side', 'foh')}
                                    disabled={!canEditFOH}
                                    title={!canEditFOH ? tx('You don\'t have FOH editor access', 'No tienes acceso de editor FOH') : ''}
                                    className={`py-2 rounded-lg text-sm font-bold border ${
                                        presetSide === 'foh'
                                            ? 'bg-dd-green text-white border-dd-green'
                                            : 'bg-white text-gray-700 border-gray-300'
                                    } ${!canEditFOH ? 'opacity-40 cursor-not-allowed line-through' : ''}`}>
                                    🧑‍💼 FOH {staffDefaultSide === 'foh' ? `(${tx('home', 'casa')})` : ''}
                                </button>
                                <button type="button" onClick={() => canEditBOH && updateField('side', 'boh')}
                                    disabled={!canEditBOH}
                                    title={!canEditBOH ? tx('You don\'t have BOH editor access', 'No tienes acceso de editor BOH') : ''}
                                    className={`py-2 rounded-lg text-sm font-bold border ${
                                        presetSide === 'boh'
                                            ? 'bg-orange-600 text-white border-orange-600'
                                            : 'bg-white text-gray-700 border-gray-300'
                                    } ${!canEditBOH ? 'opacity-40 cursor-not-allowed line-through' : ''}`}>
                                    🔥 BOH {staffDefaultSide === 'boh' ? `(${tx('home', 'casa')})` : ''}
                                </button>
                            </div>
                            {isCrossSide && (
                                <p className="text-[10px] text-amber-700 mt-1 font-bold">
                                    ⚠ {tx(`Cross-side: ${form.staffName} normally works ${staffDefaultSide.toUpperCase()}.`,
                                          `Lado cruzado: ${form.staffName} normalmente trabaja ${staffDefaultSide.toUpperCase()}.`)}
                                </p>
                            )}
                        </div>
                    )}

                    {/* Date */}
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Date', 'Fecha')}</label>
                        <input type="date" value={form.date} onChange={e => updateField('date', e.target.value)}
                            min={toDateStr(addDays(weekStart, -14))}
                            max={toDateStr(addDays(weekStart, 28))}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                    </div>

                    {/* Quick presets — tap to fill start/end. Preset list adapts to FOH/BOH. */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider">{tx('Quick presets', 'Presets rápidos')}</label>
                            {onEditPresets && (
                                <button type="button" onClick={onEditPresets}
                                    className="text-[10px] font-bold text-dd-green-700 hover:underline">
                                    ⚙ {tx('Edit hours', 'Editar horas')}
                                </button>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {SHIFT_PRESETS.map(p => (
                                <button key={p.label} type="button"
                                    onClick={() => setForm(f => ({ ...f, startTime: p.start, endTime: p.end, isDouble: !!p.isDouble }))}
                                    className={`px-2.5 py-1 rounded-md text-[11px] font-bold border ${
                                        isPresetActive(p)
                                            ? 'bg-dd-green text-white border-dd-green'
                                            : 'bg-white text-gray-700 border-gray-300 hover:border-mint-500'
                                    }`}>
                                    {p.label}
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] text-gray-500 mt-1">
                            {presetSide === 'boh'
                                ? tx('BOH presets — tap to fill, or set custom below.', 'Presets BOH — toca para llenar, o ajusta abajo.')
                                : tx('FOH presets — tap to fill, or set custom below.', 'Presets FOH — toca para llenar, o ajusta abajo.')}
                        </p>
                    </div>

                    {/* Times */}
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Start', 'Inicio')}</label>
                            <input type="time" value={form.startTime} onChange={e => updateField('startTime', e.target.value)}
                                className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                        </div>
                        <div>
                            <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('End', 'Fin')}</label>
                            <input type="time" value={form.endTime} onChange={e => updateField('endTime', e.target.value)}
                                className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                        </div>
                    </div>
                    <div className="text-xs text-gray-600">
                        {tx('Total hours:', 'Horas totales:')} <span className="font-bold">{formatHours(hours)}</span>
                        {form.isDouble && <span className="text-gray-400"> ({tx('1h break subtracted', '1h descanso restado')})</span>}
                    </div>

                    {/* Auto-double notice — staff already has another shift on this date */}
                    {(() => {
                        if (!form.staffName || !form.date || !existingShifts) return null;
                        const sameDayShifts = existingShifts.filter(sh => sh.staffName === form.staffName && sh.date === form.date);
                        if (sameDayShifts.length === 0) return null;
                        const totalRaw = sameDayShifts.reduce((sum, sh) => sum + hoursBetween(sh.startTime, sh.endTime, false), 0)
                            + hoursBetween(form.startTime, form.endTime, false);
                        const totalPaid = Math.max(0, totalRaw - 1);
                        return (
                            <div className="p-2 rounded-lg bg-blue-50 border-2 border-blue-300 text-xs text-blue-900">
                                <div className="font-bold mb-0.5">🔁 {tx('Double day detected', 'Día doble detectado')}</div>
                                <div className="text-[11px]">
                                    {tx(`${form.staffName} already has ${sameDayShifts.length} shift(s) on ${form.date}:`,
                                        `${form.staffName} ya tiene ${sameDayShifts.length} turno(s) el ${form.date}:`)}
                                </div>
                                <ul className="mt-1 space-y-0.5">
                                    {sameDayShifts.map(sh => (
                                        <li key={sh.id} className="text-[11px] ml-2">
                                            • {formatTime12h(sh.startTime)}–{formatTime12h(sh.endTime)}
                                        </li>
                                    ))}
                                </ul>
                                <div className="text-[11px] mt-1 font-bold">
                                    {tx(`Day total: ${formatHours(totalRaw)} raw → ${formatHours(totalPaid)} paid (1h unpaid break).`,
                                        `Total del día: ${formatHours(totalRaw)} bruto → ${formatHours(totalPaid)} pagado (1h descanso).`)}
                                </div>
                            </div>
                        );
                    })()}

                    {/* Location */}
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Location', 'Ubicación')}</label>
                        <div className="grid grid-cols-2 gap-2">
                            {['webster', 'maryland'].map(loc => (
                                <button key={loc} onClick={() => updateField('location', loc)}
                                    className={`py-2 rounded-lg text-sm font-bold border ${form.location === loc ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-gray-700 border-gray-300'}`}>
                                    {LOCATION_LABELS[loc]}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Toggles */}
                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-2">
                        <span className="text-xs font-bold text-gray-700">{tx('Shift Lead this shift', 'Líder en este turno')}</span>
                        <button onClick={() => updateField('isShiftLead', !form.isShiftLead)}
                            className={`w-12 h-6 rounded-full relative transition ${form.isShiftLead ? 'bg-purple-600' : 'bg-gray-300'}`}>
                            <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition ${form.isShiftLead ? 'translate-x-6' : 'translate-x-0.5'}`} />
                        </button>
                    </div>
                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-2">
                        <div>
                            <div className="text-xs font-bold text-gray-700">{tx('Double shift', 'Turno doble')}</div>
                            <div className="text-[10px] text-gray-500">{tx('Subtracts 1hr unpaid break', 'Resta 1hr descanso sin pagar')}</div>
                        </div>
                        <button onClick={() => updateField('isDouble', !form.isDouble)}
                            className={`w-12 h-6 rounded-full relative transition ${form.isDouble ? 'bg-blue-600' : 'bg-gray-300'}`}>
                            <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition ${form.isDouble ? 'translate-x-6' : 'translate-x-0.5'}`} />
                        </button>
                    </div>

                    {/* Notes */}
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Notes (optional)', 'Notas (opcional)')}</label>
                        <input type="text" value={form.notes} onChange={e => updateField('notes', e.target.value)}
                            placeholder={tx('e.g. catering, training', 'p.ej. catering, capacitación')}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                    </div>

                    {/* Minor warning */}
                    {minorWarnings.length > 0 && (
                        <div className="p-2 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-900">
                            ⚠ <b>{tx('Minor labor flag:', 'Aviso de menor:')}</b> {minorWarnings.join(' • ')}
                        </div>
                    )}
                    {/* CONFLICT WARNINGS — non-blocking but visible. */}
                    {ptoConflict && (
                        <div className="p-2.5 rounded-lg bg-red-50 border border-red-300 text-xs text-red-900">
                            <b>🌴 {ptoConflict.status === 'approved' ? tx('Time off conflict:', 'Conflicto de tiempo libre:') : tx('Pending time off:', 'Tiempo libre pendiente:')}</b>{' '}
                            {tx(`${form.staffName} requested off this date`, `${form.staffName} pidió este día libre`)}
                            {ptoConflict.reason && ` (${ptoConflict.reason})`}.
                            {tx(' You can still save, but this is unusual.', ' Puedes guardar, pero es inusual.')}
                        </div>
                    )}
                    {(overHours || overOT) && form.staffName && (
                        <div className={`p-2.5 rounded-lg border text-xs ${overOT ? 'bg-red-50 border-red-300 text-red-900' : 'bg-amber-50 border-amber-300 text-amber-900'}`}>
                            <b>⏱ {overOT ? tx('Overtime risk:', 'Riesgo de tiempo extra:') : tx('Over target hours:', 'Sobre objetivo:')}</b>{' '}
                            {tx(`This shift brings ${form.staffName} to ${formatHours(projectedTotal)} this week`, `Este turno lleva a ${form.staffName} a ${formatHours(projectedTotal)} esta semana`)}
                            {targetHours > 0 && ` (target ${formatHours(targetHours)})`}
                            {overOT && tx(' — over the 40h OT line.', ' — sobre las 40h de OT.')}
                        </div>
                    )}
                    {availabilityConflict?.type === 'off' && (
                        <div className="p-2.5 rounded-lg bg-red-50 border border-red-300 text-xs text-red-900">
                            <b>🚫 {tx('Availability conflict:', 'Conflicto de disponibilidad:')}</b>{' '}
                            {tx(`${form.staffName} marked this day as unavailable.`, `${form.staffName} marcó este día como no disponible.`)}
                            {tx(' You can still save, but verify with them first.', ' Puedes guardar, pero confirma con esta persona primero.')}
                        </div>
                    )}
                    {availabilityConflict?.type === 'outside' && (
                        <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-900">
                            <b>⏰ {tx('Outside availability:', 'Fuera del horario disponible:')}</b>{' '}
                            {tx(
                                `${form.staffName} is only available ${formatTime12h(availabilityConflict.from)}–${formatTime12h(availabilityConflict.to)} on this day.`,
                                `${form.staffName} solo está disponible ${formatTime12h(availabilityConflict.from)}–${formatTime12h(availabilityConflict.to)} este día.`
                            )}
                            {tx(' Shift', ' Turno')} {formatTime12h(form.startTime)}–{formatTime12h(form.endTime)} {tx('falls outside.', 'queda fuera.')}
                        </div>
                    )}

                    {/* Closed-date guard */}
                    {isOnClosedDate && (
                        <div className="p-2 rounded-lg bg-gray-200 border border-gray-400 text-xs text-gray-800">
                            🚫 <b>{tx('Restaurant closed', 'Restaurante cerrado')}</b> {tx('on this date — pick another.', 'en esta fecha — elige otra.')}
                        </div>
                    )}
                </div>

                <div className="sticky bottom-0 bg-white border-t border-dd-line p-4 flex gap-2 shadow-[0_-4px_8px_-4px_rgba(15,23,42,0.06)]">
                    <button onClick={onClose}
                        className="flex-1 py-2.5 rounded-lg glass-sheet text-dd-text font-bold hover:bg-dd-bg transition">{tx('Cancel', 'Cancelar')}</button>
                    <button onClick={async () => {
                        if (!canSubmit || saving) return;
                        // If the manager never tapped the side toggle, default to
                        // the staff's home side. This way every saved shift carries
                        // an explicit side field.
                        const finalSide = form.side || staffDefaultSide || 'foh';
                        setSaving(true);
                        try {
                            // onSave is async (handleAddShift in parent). Await so
                            // we stay disabled until the Firestore write resolves.
                            // If parent throws / silently returns without closing,
                            // finally clears saving so user can retry.
                            await onSave({ ...form, side: finalSide });
                        } finally {
                            setSaving(false);
                        }
                    }} disabled={!canSubmit || saving}
                        className={`flex-1 py-2.5 rounded-lg font-bold text-white shadow-sm transition ${(canSubmit && !saving) ? 'bg-dd-green hover:bg-dd-green-700' : 'bg-dd-text-2/30 cursor-not-allowed'}`}>
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save Shift', 'Guardar Turno')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── BlackoutsModal ─────────────────────────────────────────────────────────
// Manager UI for two kinds of blackouts:
//   • CLOSED — restaurant is closed (no shifts can be scheduled, no time-off needed)
//   • NO TIME OFF — restaurant is open, but no PTO requests will be approved
//                   (busy season, holiday weekends, special events)
function BlackoutsModal({ onClose, onAdd, onRemove, blocks, storeLocation, isEn, closedWeekdays = {}, onToggleClosedWeekday, events = [], onAddEvent, onRemoveEvent }) {
    const tx = (en, es) => (isEn ? en : es);
    const today = toDateStr(new Date());
    // 2026-05-27 — Andrew: "blackout dates i want to be able to select
    // more than one day at a time." Replaced the single `date` field
    // with a startDate / endDate pair so admins can stamp a vacation,
    // a holiday weekend, or a full week of training in one submission.
    // endDate defaults to startDate (single-day behavior preserved).
    // The submit handler enumerates the inclusive range and passes the
    // resulting array of blocks to handleAddBlock — which now does a
    // batched Promise.all write.
    const [form, setForm] = useState({
        startDate: today,
        endDate: today,
        type: 'closed',
        location: storeLocation && storeLocation !== 'both' ? storeLocation : 'both',
        reason: '',
    });
    // Inclusive list of YYYY-MM-DD strings from startDate to endDate.
    // Returns [] when the range is invalid (end < start) so the submit
    // button can disable cleanly. Capped at 366 days to avoid an
    // accidental "365-day closure" if someone fat-fingers a year.
    const rangeDates = useMemo(() => {
        if (!form.startDate || !form.endDate) return [];
        const a = parseLocalDate(form.startDate);
        const b = parseLocalDate(form.endDate);
        if (!a || !b || a > b) return [];
        const out = [];
        let cur = new Date(a);
        for (let i = 0; i < 366 && cur <= b; i++) {
            out.push(toDateStr(cur));
            cur = addDays(cur, 1);
        }
        return out;
    }, [form.startDate, form.endDate]);
    const rangeInvalid = form.startDate && form.endDate && rangeDates.length === 0;
    // Calendar event add-form state. Separate from closure form.
    const [evtForm, setEvtForm] = useState({
        date: today,
        label: '',
        type: 'event',
        emoji: '',
    });
    const updateEvt = (k, v) => setEvtForm(f => ({ ...f, [k]: v }));
    const canAddEvent = evtForm.date && evtForm.label.trim();
    const eventsSorted = [...(events || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const upcomingEvents = eventsSorted.filter(e => e.date >= today);
    const pastEvents = eventsSorted.filter(e => e.date < today);

    // Sort upcoming blocks first; past blocks at the bottom dimmed.
    const sorted = [...blocks].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const upcoming = sorted.filter(b => b.date >= today);
    const past = sorted.filter(b => b.date < today);

    const update = (k, v) => setForm(f => {
        const next = { ...f, [k]: v };
        // Auto-bump endDate forward if it falls before a newly-moved
        // startDate. Common case: user picks From=Christmas Eve then
        // To=Christmas Day, then changes their mind and moves From
        // back to Dec 23 — endDate should stay at Christmas Day, but
        // if they'd moved From PAST endDate we snap endDate forward
        // so the range isn't silently invalid.
        if (k === 'startDate' && next.endDate && next.endDate < v) next.endDate = v;
        return next;
    });
    const canSubmit = rangeDates.length > 0 && form.type;

    // Weekday day-pill data for the recurring section. 0=Sunday.
    const DAYS = [
        { dow: 0, labelEn: 'Sun', labelEs: 'Dom' },
        { dow: 1, labelEn: 'Mon', labelEs: 'Lun' },
        { dow: 2, labelEn: 'Tue', labelEs: 'Mar' },
        { dow: 3, labelEn: 'Wed', labelEs: 'Mié' },
        { dow: 4, labelEn: 'Thu', labelEs: 'Jue' },
        { dow: 5, labelEn: 'Fri', labelEs: 'Vie' },
        { dow: 6, labelEn: 'Sat', labelEs: 'Sáb' },
    ];

    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto sm:shadow-2xl">
                <div className="sticky top-0 bg-white border-b border-dd-line p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-gray-800">🚫 {tx('Closures & Blackouts', 'Cierres y Bloqueos')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg">×</button>
                </div>

                <div className="p-4 space-y-3">
                    {/* RECURRING WEEKLY CLOSURE — toggle days the restaurant is
                        always closed (e.g. Sundays). Saves immediately on tap.
                        Per-location: Webster could be closed Sunday while
                        Maryland is open, or vice versa. */}
                    <div className="border border-blue-300 bg-blue-50/50 rounded-lg p-3 space-y-2">
                        <div>
                            <div className="text-xs font-bold text-blue-900 mb-0.5">🔁 {tx('Closed every week on…', 'Cerrado cada semana en…')}</div>
                            <p className="text-[11px] text-blue-700">
                                {tx('Tap a day to toggle. Set once — applies to every future week of the schedule.',
                                    'Toca un día para alternar. Configura una vez — se aplica a todas las semanas futuras.')}
                            </p>
                        </div>
                        {['webster', 'maryland'].map(loc => {
                            const arr = Array.isArray(closedWeekdays[loc]) ? closedWeekdays[loc] : [];
                            return (
                                <div key={loc}>
                                    <div className="text-[10px] font-bold text-blue-900 uppercase tracking-wider mb-1">
                                        {LOCATION_LABELS[loc] || loc}
                                    </div>
                                    <div className="grid grid-cols-7 gap-1">
                                        {DAYS.map(d => {
                                            const on = arr.includes(d.dow);
                                            return (
                                                <button key={d.dow}
                                                    onClick={() => onToggleClosedWeekday && onToggleClosedWeekday(loc, d.dow)}
                                                    className={`py-1.5 rounded-md text-[11px] font-bold border transition ${on ? 'bg-gray-700 text-white border-gray-700' : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'}`}
                                                    title={on ? tx('Closed every', 'Cerrado cada') + ' ' + (isEn ? d.labelEn : d.labelEs) : tx('Tap to close every', 'Toca para cerrar cada') + ' ' + (isEn ? d.labelEn : d.labelEs)}>
                                                    {isEn ? d.labelEn : d.labelEs}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    <div className="text-xs text-gray-600 leading-relaxed bg-gray-50 rounded-lg p-2 border border-gray-200">
                        <b>{tx('Closed', 'Cerrado')}</b> = {tx('restaurant is not open. No shifts can be scheduled.', 'restaurante no está abierto. No se pueden agendar turnos.')}<br/>
                        <b>{tx('No time off', 'Sin tiempo libre')}</b> = {tx('restaurant is open, but no time-off requests will be approved (busy season, holidays, special events).', 'restaurante está abierto, pero no se aprobará tiempo libre (temporada alta, días feriados, eventos especiales).')}
                    </div>

                    {/* Add form */}
                    <div className="border border-gray-300 rounded-lg p-3 space-y-2">
                        <div className="text-xs font-bold text-gray-700">+ {tx('Add new blackout', 'Agregar bloqueo')}</div>
                        <div className="grid grid-cols-2 gap-2">
                            <button onClick={() => update('type', 'closed')}
                                className={`py-2 rounded-md text-xs font-bold border ${form.type === 'closed' ? 'bg-gray-700 text-white border-gray-700' : 'bg-white border-gray-300 text-gray-600'}`}>
                                🚫 {tx('Closed', 'Cerrado')}
                            </button>
                            <button onClick={() => update('type', 'no_timeoff')}
                                className={`py-2 rounded-md text-xs font-bold border ${form.type === 'no_timeoff' ? 'bg-amber-600 text-white border-amber-600' : 'bg-white border-gray-300 text-gray-600'}`}>
                                🛑 {tx('No time off', 'Sin tiempo libre')}
                            </button>
                        </div>
                        {/* From / To range — left field is the start, right
                            field is the inclusive end. For single-day
                            closures the user just leaves them equal (or
                            ignores To since it auto-matches From). */}
                        <div className="grid grid-cols-2 gap-2">
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                                    {tx('From', 'Desde')}
                                </span>
                                <input type="date" value={form.startDate} onChange={e => update('startDate', e.target.value)}
                                    className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                            </label>
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                                    {tx('To', 'Hasta')}
                                </span>
                                <input type="date" value={form.endDate} min={form.startDate}
                                    onChange={e => update('endDate', e.target.value)}
                                    className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                            </label>
                        </div>
                        {rangeInvalid && (
                            <p className="text-[11px] text-red-700 font-bold">
                                {tx('End date must be on or after the start date.', 'La fecha final debe ser igual o posterior a la inicial.')}
                            </p>
                        )}
                        {rangeDates.length > 1 && (
                            <p className="text-[11px] text-blue-700 font-semibold">
                                {tx(`Will add ${rangeDates.length} consecutive days.`,
                                    `Se agregarán ${rangeDates.length} días consecutivos.`)}
                            </p>
                        )}
                        <select value={form.location} onChange={e => update('location', e.target.value)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition">
                            <option value="both">{LOCATION_LABELS.both}</option>
                            <option value="webster">{LOCATION_LABELS.webster}</option>
                            <option value="maryland">{LOCATION_LABELS.maryland}</option>
                        </select>
                        <input type="text" value={form.reason} onChange={e => update('reason', e.target.value)}
                            placeholder={tx('Reason (e.g. Christmas Day)', 'Razón (ej. Navidad)')}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                        <button
                            onClick={() => {
                                if (!canSubmit) return;
                                // Build one block per day in the range; the
                                // common fields (type, location, reason)
                                // duplicate across every day.
                                const blocks = rangeDates.map(d => ({
                                    date: d,
                                    type: form.type,
                                    location: form.location,
                                    reason: form.reason,
                                }));
                                onAdd(blocks);
                            }}
                            disabled={!canSubmit}
                            className={`w-full py-2 rounded-lg font-bold text-white ${canSubmit ? 'bg-dd-green hover:bg-dd-green-700' : 'bg-gray-300'}`}>
                            {rangeDates.length > 1
                                ? tx(`Add ${rangeDates.length} Blackout Days`, `Agregar ${rangeDates.length} Días`)
                                : tx('Add Blackout', 'Agregar Bloqueo')}
                        </button>
                    </div>

                    {/* Upcoming list */}
                    {upcoming.length > 0 && (
                        <div>
                            <div className="text-xs font-bold text-gray-700 mb-1">{tx('Upcoming', 'Próximos')}</div>
                            <div className="space-y-1">
                                {upcoming.map(b => (
                                    <BlockRow key={b.id} block={b} onRemove={onRemove} isEn={isEn} />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Past list (collapsed) */}
                    {past.length > 0 && (
                        <details>
                            <summary className="text-xs font-bold text-gray-500 cursor-pointer">{tx('Past', 'Pasados')} ({past.length})</summary>
                            <div className="space-y-1 mt-1 opacity-60">
                                {past.map(b => (
                                    <BlockRow key={b.id} block={b} onRemove={onRemove} isEn={isEn} />
                                ))}
                            </div>
                        </details>
                    )}

                    {/* 2026-05-16 — Calendar events (holidays / national /
                        local events). Show as chips above the grid's day
                        headers. Distinct from closures: an event LABELS a
                        day, a closure GRAYS it out. */}
                    <div className="border-t border-gray-200 pt-3">
                        <div className="text-xs font-bold text-gray-700 mb-1">📅 {tx('Calendar events', 'Eventos del calendario')}</div>
                        <p className="text-[11px] text-gray-500 mb-2">
                            {tx('Holidays, national days, local events. Shows as a chip above the day on the grid. Birthdays are auto-derived from each staff record.',
                                'Días festivos, observancias, eventos locales. Aparecen como una etiqueta sobre el día en la cuadrícula. Los cumpleaños se derivan del perfil del personal.')}
                        </p>
                        <div className="border border-purple-200 bg-purple-50/50 rounded-lg p-3 space-y-2">
                            <div className="grid grid-cols-3 gap-1">
                                {[
                                    { id: 'holiday',  emoji: '🎄', en: 'Holiday',  es: 'Festivo' },
                                    { id: 'national', emoji: '🇺🇸', en: 'National', es: 'Nacional' },
                                    { id: 'event',    emoji: '🎉', en: 'Event',    es: 'Evento' },
                                ].map(t => (
                                    <button key={t.id} onClick={() => updateEvt('type', t.id)}
                                        className={`py-1.5 rounded-md text-[11px] font-bold border ${evtForm.type === t.id ? 'bg-purple-600 text-white border-purple-600' : 'bg-white border-gray-300 text-gray-600'}`}>
                                        {t.emoji} {tx(t.en, t.es)}
                                    </button>
                                ))}
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                <input type="date" value={evtForm.date} onChange={e => updateEvt('date', e.target.value)}
                                    className="col-span-2 border border-dd-line rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-purple-500" />
                                <input type="text" value={evtForm.emoji} maxLength={3}
                                    onChange={e => updateEvt('emoji', e.target.value)}
                                    placeholder="🎄"
                                    className="text-center border border-dd-line rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-purple-500" />
                            </div>
                            <input type="text" value={evtForm.label}
                                onChange={e => updateEvt('label', e.target.value)}
                                placeholder={tx('Label (e.g. Mother\'s Day)', 'Etiqueta (ej. Día de la Madre)')}
                                className="w-full border border-dd-line rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-purple-500" />
                            <button onClick={() => {
                                if (!canAddEvent || !onAddEvent) return;
                                onAddEvent({ ...evtForm, label: evtForm.label.trim() });
                                setEvtForm({ date: today, label: '', type: 'event', emoji: '' });
                            }}
                                disabled={!canAddEvent}
                                className={`w-full py-2 rounded-lg font-bold text-white text-sm ${canAddEvent ? 'bg-purple-600 hover:bg-purple-700' : 'bg-gray-300 cursor-not-allowed'}`}>
                                + {tx('Add event', 'Agregar evento')}
                            </button>
                        </div>
                        {upcomingEvents.length > 0 && (
                            <div className="mt-2">
                                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">
                                    {tx('Upcoming', 'Próximos')} ({upcomingEvents.length})
                                </div>
                                <div className="space-y-1">
                                    {upcomingEvents.map(e => (
                                        <div key={e.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-white border border-purple-100 text-xs">
                                            <div className="min-w-0 flex-1 flex items-center gap-1.5">
                                                <span>{e.emoji || (e.type === 'holiday' ? '🎄' : e.type === 'national' ? '🇺🇸' : '🎉')}</span>
                                                <span className="font-bold text-dd-text truncate">{e.label}</span>
                                                <span className="text-[10px] text-dd-text-2 flex-shrink-0">· {e.date}</span>
                                            </div>
                                            <button onClick={() => onRemoveEvent && onRemoveEvent(e.id)}
                                                className="text-[10px] text-red-600 hover:text-red-800 font-bold flex-shrink-0">×</button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        {pastEvents.length > 0 && (
                            <details className="mt-2">
                                <summary className="text-xs font-bold text-gray-500 cursor-pointer">{tx('Past', 'Pasados')} ({pastEvents.length})</summary>
                                <div className="space-y-1 mt-1 opacity-60">
                                    {pastEvents.map(e => (
                                        <div key={e.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-white border border-gray-200 text-xs">
                                            <div className="min-w-0 flex-1 flex items-center gap-1.5">
                                                <span>{e.emoji || '🎉'}</span>
                                                <span className="font-bold text-dd-text truncate">{e.label}</span>
                                                <span className="text-[10px] text-dd-text-2 flex-shrink-0">· {e.date}</span>
                                            </div>
                                            <button onClick={() => onRemoveEvent && onRemoveEvent(e.id)}
                                                className="text-[10px] text-red-600 hover:text-red-800 font-bold flex-shrink-0">×</button>
                                        </div>
                                    ))}
                                </div>
                            </details>
                        )}
                    </div>
                </div>

                <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4">
                    <button onClick={onClose} className="w-full py-2 rounded-lg glass-button-apple text-dd-text-2 font-bold">{tx('Done', 'Listo')}</button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

function BlockRow({ block, onRemove, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const isClosed = block.type === 'closed';
    return (
        <div className={`flex items-center justify-between gap-2 p-2 rounded border text-xs ${isClosed ? 'bg-gray-100 border-gray-300' : 'bg-amber-50 border-amber-300'}`}>
            <div className="min-w-0 flex-1">
                <div className="font-bold text-gray-800">
                    {isClosed ? '🚫' : '🛑'} {block.date} · {LOCATION_LABELS[block.location] || block.location}
                </div>
                <div className="text-gray-600">
                    {isClosed ? tx('Closed', 'Cerrado') : tx('No time off', 'Sin tiempo libre')}
                    {block.reason && <span className="ml-2 italic">— {block.reason}</span>}
                </div>
            </div>
            <button onClick={() => onRemove(block.id)}
                className="px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200">×</button>
        </div>
    );
}


// ── Shared PTO row helpers ─────────────────────────────────────────────────
// "today at 3:42 PM" / "yesterday at…" / "Mar 15 at 3:42 PM" (localized), or
// '' for missing/invalid timestamps so legacy docs just skip the line.
// Callers prepend their own verb ("Submitted …", "by Maria · …").
function fmtPtoWhen(ts, isEn) {
    if (!ts) return '';
    const d = ts?.toDate ? ts.toDate() : (ts instanceof Date ? ts : new Date(ts));
    if (!d || isNaN(d.getTime())) return '';
    const locale = isEn ? 'en-US' : 'es';
    const now = new Date();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const ymd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((todayMid - ymd) / 86400000);
    const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    if (diffDays === 0) return isEn ? `today at ${time}` : `hoy a las ${time}`;
    if (diffDays === 1) return isEn ? `yesterday at ${time}` : `ayer a las ${time}`;
    const date = d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    return isEn ? `${date} at ${time}` : `${date} a las ${time}`;
}

// Status + decision-trail + submitted lines under a time-off row. The
// submitted line is gated by showSubmitted — Andrew 2026-06-10: "let the
// schedule editors also able to see when the request was put in" (editors
// only; staff already know when they asked).
function PtoMetaLines({ entry, isEn, showSubmitted }) {
    const tx = (en, es) => (isEn ? en : es);
    const status = entry.status || 'pending';
    const submitted = fmtPtoWhen(entry.submittedAt || entry.createdAt, isEn);
    const decided = fmtPtoWhen(entry.reviewedAt, isEn);
    return (
        <div className="text-[10px] mt-0.5 space-y-0.5">
            <div className={`font-bold uppercase tracking-wide ${status === 'approved' ? 'text-green-700' : status === 'denied' ? 'text-red-700' : 'text-amber-700'}`}>
                {status === 'approved' ? `✅ ${tx('approved', 'aprobado')}` : status === 'denied' ? `❌ ${tx('denied', 'negado')}` : `⏳ ${tx('pending', 'pendiente')}`}
                {status !== 'pending' && entry.reviewedBy ? tx(` by ${entry.reviewedBy}`, ` por ${entry.reviewedBy}`) : ''}
                {status !== 'pending' && decided ? ` · ${decided}` : ''}
            </div>
            {showSubmitted && submitted && (
                <div className="text-dd-text-2/80 normal-case">
                    {tx(`Submitted ${submitted}`, `Enviado ${submitted}`)}
                </div>
            )}
        </div>
    );
}

// Manager status-change chips for one time-off entry: every status EXCEPT
// the current one, plus delete. onSetStatus/onRemove run their own confirm
// flows (askSetPtoStatus → ConfirmModal; handleRemoveTimeOff → confirm()).
function PtoActionChips({ entry, isEn, onSetStatus, onRemove }) {
    const tx = (en, es) => (isEn ? en : es);
    const status = entry.status || 'pending';
    const btn = 'px-2 py-1 rounded-md text-[10px] font-bold border transition';
    return (
        <div className="flex flex-wrap gap-1 print:hidden">
            {status !== 'approved' && (
                <button onClick={() => onSetStatus(entry, 'approved')}
                    className={`${btn} bg-dd-green text-white border-dd-green hover:bg-dd-green-700`}>
                    ✓ {tx('Approve', 'Aprobar')}
                </button>
            )}
            {status !== 'denied' && (
                <button onClick={() => onSetStatus(entry, 'denied')}
                    className={`${btn} bg-white text-red-700 border-red-200 hover:bg-red-50`}>
                    ✕ {tx('Deny', 'Negar')}
                </button>
            )}
            {status !== 'pending' && (
                <button onClick={() => onSetStatus(entry, 'pending')}
                    className={`${btn} bg-white text-amber-700 border-amber-300 hover:bg-amber-50`}>
                    ⏳ {tx('To pending', 'A pendiente')}
                </button>
            )}
            <button onClick={() => onRemove(entry)}
                className={`${btn} bg-white text-dd-text-2 border-dd-line hover:bg-red-50 hover:text-red-700`}>
                🗑 {tx('Delete', 'Borrar')}
            </button>
        </div>
    );
}

// ── PtoDetailsModal ────────────────────────────────────────────────────────
// Opened by tapping a 🌴/⏳ time-off chip in the weekly grid (editors only).
// Shows every request covering that staff + day with the full trail and the
// status-change chips, so approve/deny/reverse happens right from the
// calendar. Entries are derived live from the timeOff snapshot by the
// caller, so a status change updates this list in place.
function PtoDetailsModal({ target, entries, isEn, canEdit, onSetStatus, onRemove, onClose }) {
    const tx = (en, es) => (isEn ? en : es);
    const statusTone = (s) =>
        s === 'approved' ? 'bg-green-50 border-green-300'
        : s === 'denied' ? 'bg-red-50 border-red-200'
        : 'bg-amber-50 border-amber-300';
    return (
        <ModalPortal onBackPress={onClose}>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-2 sm:p-4 pt-16 sm:pt-20"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="glass-sheet w-full sm:max-w-md rounded-2xl max-h-[calc(100vh-90px)] overflow-hidden flex flex-col shadow-2xl">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between shrink-0">
                    <div>
                        <h3 className="text-lg font-bold text-amber-700">🌴 {tx('Time Off', 'Tiempo Libre')} — {target.staffName}</h3>
                        <div className="text-[11px] text-dd-text-2">{target.dateStr}</div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {entries.length === 0 ? (
                        <p className="text-center text-gray-400 text-sm py-6">
                            {tx('No time-off covers this day anymore.', 'Ya no hay tiempo libre para este día.')}
                        </p>
                    ) : entries.map(t => (
                        <div key={t.id} className={`rounded-lg border p-2.5 ${statusTone(t.status || 'pending')}`}>
                            <div className="text-xs font-bold text-dd-text">
                                {t.startDate}{t.endDate && t.endDate !== t.startDate ? ` → ${t.endDate}` : ''}
                            </div>
                            {t.reason && <div className="text-[11px] text-gray-700 italic">"{t.reason}"</div>}
                            <PtoMetaLines entry={t} isEn={isEn} showSubmitted={canEdit} />
                            {canEdit && (
                                <div className="mt-2">
                                    <PtoActionChips entry={t} isEn={isEn} onSetStatus={onSetStatus} onRemove={onRemove} />
                                </div>
                            )}
                        </div>
                    ))}
                </div>
                <div className="border-t border-gray-200 p-3 shrink-0">
                    <button onClick={onClose} className="w-full py-2 rounded-lg bg-amber-600 text-white font-bold">{tx('Close', 'Cerrar')}</button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── TimeOffModal ───────────────────────────────────────────────────────────
// Phase 2: admin-entered. Phase 3 will add staff self-serve form + manager queue.
function TimeOffModal({ onClose, onAdd, onRemove, onSetStatus, entries, staffList, isEn, canEdit }) {
    const tx = (en, es) => (isEn ? en : es);
    const today = toDateStr(new Date());
    const [form, setForm] = useState({
        staffName: "",
        startDate: today,
        endDate: today,
        reason: "",
    });
    const sortedStaff = [...(staffList || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const sortedEntries = [...entries].sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
    const upcoming = sortedEntries.filter(e => (e.endDate || e.startDate) >= today);
    const past = sortedEntries.filter(e => (e.endDate || e.startDate) < today);
    const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const canSubmit = form.staffName && form.startDate && form.endDate && form.startDate <= form.endDate;
    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-amber-700">🌴 {tx("Time Off", "Tiempo Libre")}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {canEdit && (
                        <div className="text-xs text-gray-600 bg-gray-50 rounded-lg p-2 border border-gray-200">
                            {tx("Manager-entered entries are pre-approved. Staff-submitted requests show in the pending queue at the top of the schedule.", "Las entradas del gerente quedan pre-aprobadas. Las solicitudes del personal aparecen en la cola pendiente en la parte superior del horario.")}
                        </div>
                    )}
                    {canEdit && (
                    <div className="border border-gray-300 rounded-lg p-3 space-y-2">
                        <div className="text-xs font-bold text-gray-700">+ {tx("Add new entry", "Agregar entrada")}</div>
                        <select value={form.staffName} onChange={e => update("staffName", e.target.value)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition">
                            <option value="">{tx("— Staff —", "— Personal —")}</option>
                            {sortedStaff.map(s => <option key={s.id || s.name} value={s.name}>{s.name}</option>)}
                        </select>
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="text-[10px] text-gray-500 block">{tx("From", "Desde")}</label>
                                <input type="date" value={form.startDate} onChange={e => update("startDate", e.target.value)}
                                    className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-500 block">{tx("To", "Hasta")}</label>
                                <input type="date" value={form.endDate} onChange={e => update("endDate", e.target.value)}
                                    className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                            </div>
                        </div>
                        <input type="text" value={form.reason} onChange={e => update("reason", e.target.value)}
                            placeholder={tx("Reason (e.g. vacation, sick)", "Razón (ej. vacaciones, enfermo)")}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                        <button onClick={() => canSubmit && onAdd(form)} disabled={!canSubmit}
                            className={`w-full py-2 rounded-lg font-bold text-white ${canSubmit ? "bg-amber-600 hover:bg-amber-700" : "bg-gray-300"}`}>
                            {tx("Approve & Save", "Aprobar y Guardar")}
                        </button>
                    </div>
                    )}
                    {/* Andrew 2026-06-10: every row — upcoming AND past — is now
                        fully editable for schedule editors: flip the decision,
                        send back to pending, or delete. Full trail (status, who
                        decided, when submitted) shown per row. */}
                    {upcoming.length > 0 && (
                        <div>
                            <div className="text-xs font-bold text-gray-700 mb-1">{tx("Upcoming", "Próximos")}</div>
                            <div className="space-y-1">
                                {upcoming.map(e => (
                                    <div key={e.id} className="p-2 rounded border bg-amber-50 border-amber-300 text-xs">
                                        <div className="font-bold text-gray-800">{e.staffName}</div>
                                        <div className="text-gray-600">{e.startDate}{e.endDate && e.endDate !== e.startDate ? ` → ${e.endDate}` : ""}{e.reason ? ` · ${e.reason}` : ""}</div>
                                        <PtoMetaLines entry={e} isEn={isEn} showSubmitted={canEdit} />
                                        {canEdit && (
                                            <div className="mt-1.5">
                                                <PtoActionChips entry={e} isEn={isEn} onSetStatus={onSetStatus} onRemove={onRemove} />
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {past.length > 0 && (
                        <details>
                            <summary className="text-xs font-bold text-gray-500 cursor-pointer">{tx("Past", "Pasados")} ({past.length})</summary>
                            <div className="space-y-1 mt-1 opacity-80">
                                {past.map(e => (
                                    <div key={e.id} className="p-2 rounded border bg-gray-50 border-gray-300 text-xs">
                                        <div className="font-bold text-gray-800">{e.staffName}</div>
                                        <div className="text-gray-600">{e.startDate}{e.endDate && e.endDate !== e.startDate ? ` → ${e.endDate}` : ""}{e.reason ? ` · ${e.reason}` : ""}</div>
                                        <PtoMetaLines entry={e} isEn={isEn} showSubmitted={canEdit} />
                                        {canEdit && (
                                            <div className="mt-1.5">
                                                <PtoActionChips entry={e} isEn={isEn} onSetStatus={onSetStatus} onRemove={onRemove} />
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </details>
                    )}
                </div>
                <div className="border-t border-gray-200 p-3">
                    <button onClick={onClose} className="w-full py-2 rounded-lg bg-amber-600 text-white font-bold">{tx("Done", "Listo")}</button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}


// ── PtoRequestModal ────────────────────────────────────────────────────────
// Phase 3: any staff member can submit a time-off request. Goes to status='pending'
// and shows up in the manager's approval queue.
function PtoRequestModal({ onClose, onSubmit, staffName, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const today = toDateStr(new Date());
    const [form, setForm] = useState({
        startDate: today,
        endDate: today,
        reason: '',
        partial: false,        // false = whole day(s); true = a time window on one day
        startTime: '15:00',
        endTime: '20:00',
    });
    const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
    // 2026-05-27 — Andrew: reason required. 2026-06-17 — Andrew: also support a
    // partial-day window (e.g. 3–8 off) instead of only whole days.
    const datesOk = form.startDate && form.endDate && form.startDate <= form.endDate;
    const timesOk = !form.partial || (form.startTime && form.endTime && form.startTime < form.endTime);
    const canSubmit = datesOk && timesOk && form.reason.trim().length > 0;
    const submit = () => {
        if (!canSubmit) return;
        const base = { reason: form.reason.trim() };
        if (form.partial) {
            // A time window applies to a single day.
            onSubmit({ ...base, startDate: form.startDate, endDate: form.startDate,
                partial: true, startTime: form.startTime, endTime: form.endTime });
        } else {
            onSubmit({ ...base, startDate: form.startDate, endDate: form.endDate });
        }
    };
    return (
        // 2026-05-27 — Andrew: "the request time off pops up at the very
        // bottom of page. bring it up the the top." Anchored to the TOP
        // of the viewport instead of bottom-on-mobile / centered-on-desktop.
        // pt-16 (mobile) / pt-20 (sm+) clears the global app header so
        // the modal sits just below it, not behind it. Inner card uses
        // rounded-2xl on all sides (no more bottom-sheet flush-to-edge
        // styling since the modal isn't at the edge anymore).
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-2 sm:p-4 pt-16 sm:pt-20">
            <div className="glass-sheet w-full sm:max-w-md rounded-2xl max-h-[calc(100vh-90px)] sm:max-h-[calc(100vh-120px)] overflow-hidden flex flex-col shadow-2xl">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between shrink-0">
                    <h3 className="text-lg font-bold text-amber-700">🌴 {tx('Request Time Off', 'Pedir Tiempo Libre')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <div className="text-xs text-gray-600 bg-amber-50 rounded-lg p-2 border border-amber-200">
                        {tx('Submitting as:', 'Enviando como:')} <b>{staffName}</b>. {tx('Your manager will approve or deny.', 'Tu gerente aprobará o negará.')}
                    </div>
                    {/* Whole day vs a specific time window (Andrew 2026-06-17). */}
                    <div className="grid grid-cols-2 gap-2">
                        <button type="button" onClick={() => update('partial', false)}
                            className={`py-2 rounded-lg text-sm font-bold border transition ${!form.partial ? 'bg-amber-600 text-white border-amber-600' : 'bg-white text-dd-text-2 border-dd-line'}`}>
                            {tx('Whole day', 'Día completo')}
                        </button>
                        <button type="button" onClick={() => update('partial', true)}
                            className={`py-2 rounded-lg text-sm font-bold border transition ${form.partial ? 'bg-amber-600 text-white border-amber-600' : 'bg-white text-dd-text-2 border-dd-line'}`}>
                            {tx('Part of a day', 'Parte del día')}
                        </button>
                    </div>
                    {!form.partial ? (
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('From', 'Desde')}</label>
                                <input type="date" value={form.startDate} onChange={e => update('startDate', e.target.value)}
                                    min={today}
                                    className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                            </div>
                            <div>
                                <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('To', 'Hasta')}</label>
                                <input type="date" value={form.endDate} onChange={e => update('endDate', e.target.value)}
                                    min={form.startDate}
                                    className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <div>
                                <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Day', 'Día')}</label>
                                <input type="date" value={form.startDate} onChange={e => update('startDate', e.target.value)}
                                    min={today}
                                    className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Off from', 'Libre desde')}</label>
                                    <input type="time" value={form.startTime} onChange={e => update('startTime', e.target.value)}
                                        className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                                </div>
                                <div>
                                    <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Off until', 'Libre hasta')}</label>
                                    <input type="time" value={form.endTime} onChange={e => update('endTime', e.target.value)}
                                        className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                                </div>
                            </div>
                            {form.partial && !timesOk && (
                                <p className="text-[11px] text-red-600">{tx('End time must be after start time.', 'La hora final debe ser después de la inicial.')}</p>
                            )}
                        </div>
                    )}
                    <div>
                        {/* 2026-05-27 — reason is now required. * indicator
                            on the label + the "required" hint in the
                            placeholder so the user knows before they
                            tap into the field. Submit button stays
                            disabled until reason.trim() is non-empty. */}
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">
                            {tx('Reason', 'Razón')} <span className="text-red-600">*</span>
                        </label>
                        <input type="text" value={form.reason} onChange={e => update('reason', e.target.value)}
                            required
                            placeholder={tx('Required — e.g. vacation, family, doctor', 'Obligatorio — p.ej. vacaciones, familia, doctor')}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                    </div>
                </div>
                <div className="border-t border-gray-200 p-4 flex gap-2 shrink-0">
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg glass-button-apple text-dd-text-2 font-bold">{tx('Cancel', 'Cancelar')}</button>
                    <button onClick={submit} disabled={!canSubmit}
                        className={`flex-1 py-2 rounded-lg font-bold text-white ${canSubmit ? 'bg-amber-600 hover:bg-amber-700' : 'bg-gray-300'}`}>
                        {tx('Submit Request', 'Enviar Solicitud')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── MyBirthdayModal ──────────────────────────────────────────────────
// 2026-05-16 — staff self-serve birthday. Mirrors MyAvailabilityModal's
// scope (writes only the current user's record) and uses native <input
// type="date"> for the picker, then strips the year before storing.
// Storage format: 'MM-DD' (no year — birthdays are recurring annual,
// year on the staff record would be misleading). Drives the auto-
// derived birthday chip on the Schedule's events strip.
// ── SwapShiftModal ───────────────────────────────────────────────────
// 2026-05-16 — direct shift-swap request flow. Two-pane picker:
//   Stage 1: "Your shift" — pick one of YOUR upcoming published shifts
//   Stage 2: "Trade with" — pick a teammate + one of their upcoming shifts
//   Stage 3: Confirm + optional note → calls onRequest → notifyAdmins
// Doesn't write directly; just builds the payload. Parent owns Firestore.
function SwapShiftModal({ onClose, shifts, staffList, staffName, storeLocation, swapRequests, onRequest, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const today = toDateStr(new Date());
    const [stage, setStage] = useState('mine');   // 'mine' → 'theirs' → 'confirm'
    const [myShift, setMyShift] = useState(null);
    const [theirShift, setTheirShift] = useState(null);
    const [filterStaff, setFilterStaff] = useState('');
    const [note, setNote] = useState('');

    // My upcoming published shifts. Filter by location for sanity (if
    // current store is 'both', show all).
    const myShifts = useMemo(() => {
        return (shifts || [])
            .filter(s => s.staffName === staffName)
            .filter(s => s.published !== false)
            .filter(s => s.date >= today)
            .filter(s => storeLocation === 'both' || s.location === storeLocation || s.location === 'both')
            .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    }, [shifts, staffName, today, storeLocation]);

    // Everyone else's upcoming published shifts.
    const theirShifts = useMemo(() => {
        return (shifts || [])
            .filter(s => s.staffName && s.staffName !== staffName)
            .filter(s => s.published !== false)
            .filter(s => s.date >= today)
            .filter(s => storeLocation === 'both' || s.location === storeLocation || s.location === 'both')
            .filter(s => !filterStaff || s.staffName === filterStaff)
            .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    }, [shifts, staffName, today, storeLocation, filterStaff]);

    // Unique staff names that have an upcoming shift, for the picker.
    const swappableStaff = useMemo(() => {
        const seen = new Set();
        const out = [];
        for (const s of (shifts || [])) {
            if (s.staffName === staffName) continue;
            if (s.staffName && !seen.has(s.staffName) && s.published !== false && s.date >= today) {
                seen.add(s.staffName);
                out.push(s.staffName);
            }
        }
        return out.sort();
    }, [shifts, staffName, today]);

    const renderShiftRow = (s, onClick, selected) => (
        <button key={s.id} onClick={() => onClick(s)}
            className={`w-full text-left p-2.5 rounded-lg border-2 transition active:scale-[0.99] ${selected ? 'bg-blue-50 border-blue-500' : 'bg-white border-dd-line hover:border-blue-300'}`}>
            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-dd-text">
                        {s.date} · {formatTime12h(s.startTime)}–{formatTime12h(s.endTime)}
                    </div>
                    <div className="text-[10px] text-dd-text-2 mt-0.5">
                        {LOCATION_LABELS[s.location] || s.location}
                        {s.staffName && s.staffName !== staffName && <> · {s.staffName}</>}
                        {s.side && <> · {s.side.toUpperCase()}</>}
                    </div>
                </div>
                {selected && <span className="text-blue-600 font-bold text-base">✓</span>}
            </div>
        </button>
    );

    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-dd-line p-4 flex items-center justify-between flex-shrink-0">
                    <div>
                        <h3 className="text-lg font-bold text-blue-700">🔄 {tx('Swap a Shift', 'Cambiar un Turno')}</h3>
                        <div className="flex items-center gap-1.5 mt-1 text-[10px]">
                            <span className={`px-2 py-0.5 rounded-full font-bold ${stage === 'mine' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>1. {tx('Your shift', 'Tu turno')}</span>
                            <span className="text-gray-400">→</span>
                            <span className={`px-2 py-0.5 rounded-full font-bold ${stage === 'theirs' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>2. {tx('Trade with', 'Cambiar con')}</span>
                            <span className="text-gray-400">→</span>
                            <span className={`px-2 py-0.5 rounded-full font-bold ${stage === 'confirm' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>3. {tx('Confirm', 'Confirmar')}</span>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 text-lg flex-shrink-0">×</button>
                </div>

                {stage === 'mine' && (
                    <div className="flex-1 overflow-y-auto p-4 space-y-2">
                        <p className="text-xs text-dd-text-2 leading-snug">
                            {tx('Pick one of your upcoming published shifts to swap. Drafts aren\'t available — only released shifts.',
                                'Elige uno de tus próximos turnos publicados para cambiar. Los borradores no están disponibles — solo turnos liberados.')}
                        </p>
                        {myShifts.length === 0 ? (
                            <div className="text-center text-sm text-dd-text-2 py-8 italic">
                                {tx('You have no upcoming published shifts to swap.', 'No tienes próximos turnos publicados para cambiar.')}
                            </div>
                        ) : (
                            myShifts.map(s => renderShiftRow(s, setMyShift, myShift?.id === s.id))
                        )}
                    </div>
                )}

                {stage === 'theirs' && (
                    <div className="flex-1 overflow-y-auto p-4 space-y-2">
                        <p className="text-xs text-dd-text-2 leading-snug">
                            {tx('Pick a teammate\'s shift you want to swap with. The manager has to approve the trade.',
                                'Elige el turno del compañero con quien quieres cambiar. El gerente debe aprobar el cambio.')}
                        </p>
                        {/* Quick staff filter */}
                        <select value={filterStaff} onChange={e => setFilterStaff(e.target.value)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm bg-white">
                            <option value="">{tx('All teammates', 'Todos los compañeros')}</option>
                            {swappableStaff.map(name => <option key={name} value={name}>{name}</option>)}
                        </select>
                        {theirShifts.length === 0 ? (
                            <div className="text-center text-sm text-dd-text-2 py-8 italic">
                                {tx('No teammate shifts to swap with.', 'No hay turnos de compañeros para cambiar.')}
                            </div>
                        ) : (
                            theirShifts.map(s => renderShiftRow(s, setTheirShift, theirShift?.id === s.id))
                        )}
                    </div>
                )}

                {stage === 'confirm' && myShift && theirShift && (
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                            <p className="text-xs font-bold text-blue-900 mb-2">{tx('Confirm the swap', 'Confirma el cambio')}</p>
                            <div className="space-y-2 text-xs">
                                <div className="p-2 rounded bg-white border border-blue-200">
                                    <div className="text-[10px] uppercase font-bold text-blue-700">{tx('You give up', 'Tú entregas')}</div>
                                    <div className="font-bold text-dd-text">{myShift.date} · {formatTime12h(myShift.startTime)}–{formatTime12h(myShift.endTime)}</div>
                                    <div className="text-[11px] text-dd-text-2">{LOCATION_LABELS[myShift.location] || myShift.location}</div>
                                </div>
                                <div className="text-center text-blue-600 font-bold">⇅</div>
                                <div className="p-2 rounded bg-white border border-blue-200">
                                    <div className="text-[10px] uppercase font-bold text-blue-700">{tx('You take', 'Tú tomas')}</div>
                                    <div className="font-bold text-dd-text">{theirShift.date} · {formatTime12h(theirShift.startTime)}–{formatTime12h(theirShift.endTime)}</div>
                                    <div className="text-[11px] text-dd-text-2">{LOCATION_LABELS[theirShift.location] || theirShift.location} · {theirShift.staffName}</div>
                                </div>
                            </div>
                        </div>
                        <div>
                            <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">
                                {tx('Note for manager (optional)', 'Nota para el gerente (opcional)')}
                            </label>
                            <textarea value={note} onChange={e => setNote(e.target.value.slice(0, 200))}
                                rows={2} maxLength={200}
                                placeholder={tx('e.g. doctor appointment, family event', 'ej. cita médica, evento familiar')}
                                className="w-full border border-dd-line rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
                        </div>
                    </div>
                )}

                <div className="border-t border-dd-line p-3 flex-shrink-0 flex justify-between gap-2">
                    {stage === 'mine' ? (
                        <>
                            <button onClick={onClose}
                                className="px-4 py-2 rounded-lg bg-gray-300 text-gray-700 font-bold text-sm">
                                {tx('Cancel', 'Cancelar')}
                            </button>
                            <button onClick={() => myShift && setStage('theirs')} disabled={!myShift}
                                className={`px-4 py-2 rounded-lg font-bold text-sm ${myShift ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}>
                                {tx('Next →', 'Siguiente →')}
                            </button>
                        </>
                    ) : stage === 'theirs' ? (
                        <>
                            <button onClick={() => setStage('mine')}
                                className="px-4 py-2 rounded-lg bg-gray-300 text-gray-700 font-bold text-sm">
                                ← {tx('Back', 'Atrás')}
                            </button>
                            <button onClick={() => theirShift && setStage('confirm')} disabled={!theirShift}
                                className={`px-4 py-2 rounded-lg font-bold text-sm ${theirShift ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}>
                                {tx('Next →', 'Siguiente →')}
                            </button>
                        </>
                    ) : (
                        <>
                            <button onClick={() => setStage('theirs')}
                                className="px-4 py-2 rounded-lg bg-gray-300 text-gray-700 font-bold text-sm">
                                ← {tx('Back', 'Atrás')}
                            </button>
                            <button onClick={() => onRequest({ myShift, theirShift, note })}
                                className="px-4 py-2 rounded-lg bg-blue-600 text-white font-bold text-sm hover:bg-blue-700">
                                🔄 {tx('Request swap', 'Solicitar cambio')}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

function MyBirthdayModal({ onClose, staffList, staffName, onSave, isEn }) {
    const lt = (en, es) => (isEn ? en : es);
    const me = (staffList || []).find(s => s.name === staffName);
    const initial = (me && typeof me.birthday === 'string' && /^\d{2}-\d{2}$/.test(me.birthday))
        ? me.birthday
        : '';
    // The <input type="date"> requires a YEAR. Use 2000 as a stable
    // placeholder — gets stripped at save time. If initial is empty,
    // leave the date input empty so the user picks first.
    const initialDateValue = initial ? `2000-${initial}` : '';
    const [dateValue, setDateValue] = useState(initialDateValue);
    const onPick = (v) => setDateValue(v);
    const handleSave = async () => {
        if (!dateValue) {
            // Empty → clear birthday.
            await onSave('');
            onClose();
            return;
        }
        // Extract MM-DD from the YYYY-MM-DD input value.
        const m = dateValue.match(/^\d{4}-(\d{2}-\d{2})$/);
        if (!m) return;
        await onSave(m[1]);
        onClose();
    };
    const handleClear = async () => {
        await onSave('');
        onClose();
    };
    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-bold text-pink-700">🎂 {lt('My Birthday', 'Mi Cumpleaños')}</h3>
                        <p className="text-xs text-gray-500">{staffName}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 text-lg">×</button>
                </div>
                <div className="p-4 space-y-3">
                    <p className="text-xs text-gray-600 leading-relaxed bg-pink-50 border border-pink-200 rounded-lg p-2">
                        {lt('Pick your birthday. The year is not saved — your birthday will show up on the schedule each year on the same day.',
                            'Elige tu cumpleaños. El año no se guarda — tu cumpleaños aparecerá en el horario cada año el mismo día.')}
                    </p>
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1">
                            {lt('Date', 'Fecha')}
                        </label>
                        <input type="date" value={dateValue} onChange={e => onPick(e.target.value)}
                            className="w-full border-2 border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-pink-500" />
                    </div>
                    {initial && (
                        <p className="text-[11px] text-gray-500">
                            {lt('Currently saved as', 'Actualmente guardado como')}: <span className="font-bold font-mono">{initial}</span>
                        </p>
                    )}
                </div>
                <div className="border-t border-gray-200 p-4 flex gap-2">
                    {initial && (
                        <button onClick={handleClear}
                            className="px-3 py-2 rounded-lg glass-sheet text-dd-text-2 hover:bg-dd-bg font-bold text-sm">
                            {lt('Clear', 'Borrar')}
                        </button>
                    )}
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg glass-button-apple text-dd-text-2 font-bold text-sm">
                        {lt('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={handleSave}
                        disabled={!dateValue && !initial}
                        className={`flex-1 py-2 rounded-lg font-bold text-sm text-white ${dateValue || initial ? 'bg-pink-600 hover:bg-pink-700' : 'bg-gray-300 cursor-not-allowed'}`}>
                        {lt('Save', 'Guardar')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── MyAvailabilityModal ────────────────────────────────────────────────────
// Phase 3: staff can edit their OWN availability. Same shape as the AdminPanel
// version, but scoped to the current user. Manager can still override via Admin.
function MyAvailabilityModal({ onClose, staffList, staffName, onSave, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const me = (staffList || []).find(s => s.name === staffName);
    const initialAvail = (me && me.availability) || {};
    const DAYS = [
        { k: 'sun', en: 'Sunday',    es: 'Domingo' },
        { k: 'mon', en: 'Monday',    es: 'Lunes' },
        { k: 'tue', en: 'Tuesday',   es: 'Martes' },
        { k: 'wed', en: 'Wednesday', es: 'Miércoles' },
        { k: 'thu', en: 'Thursday',  es: 'Jueves' },
        { k: 'fri', en: 'Friday',    es: 'Viernes' },
        { k: 'sat', en: 'Saturday',  es: 'Sábado' },
    ];
    const [avail, setAvail] = useState(initialAvail);
    const updateDay = (dayKey, patch) => {
        setAvail(a => ({ ...a, [dayKey]: { ...(a[dayKey] || { available: true, from: '09:00', to: '21:00' }), ...patch } }));
    };
    const handleSave = async () => {
        await onSave(avail);
        onClose();
    };
    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-bold text-purple-700">🗓 {tx('My Availability', 'Mi Disponibilidad')}</h3>
                        <p className="text-xs text-gray-500">{staffName}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    <p className="text-xs text-gray-500 mb-1">
                        {tx(
                            "Mark any day you can't work as Off. Leave the rest as Available — you don't need to set specific hours unless your availability is limited.",
                            "Marca como No Disponible cualquier día que no puedas trabajar. Deja el resto como Disponible — solo ajusta las horas si tu disponibilidad es limitada.",
                        )}
                    </p>
                    {DAYS.map(d => {
                        const dayData = avail[d.k] || { available: true, from: '09:00', to: '21:00' };
                        const available = dayData.available !== false;
                        return (
                            <div key={d.k} className="bg-gray-50 rounded-lg p-2">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="font-bold text-sm text-gray-800">{tx(d.en, d.es)}</span>
                                    <button onClick={() => updateDay(d.k, { available: !available })}
                                        className={`px-3 py-1 rounded-full text-xs font-bold ${available ? 'bg-green-600 text-white' : 'bg-gray-300 text-gray-600'}`}>
                                        {available ? tx('Available', 'Disponible') : tx('Off', 'No disponible')}
                                    </button>
                                </div>
                                {available && (
                                    <div className="grid grid-cols-2 gap-2">
                                        <div>
                                            <label className="text-[10px] text-gray-500 block">{tx('From', 'Desde')}</label>
                                            <input type="time" value={dayData.from || '09:00'}
                                                onChange={e => updateDay(d.k, { from: e.target.value })}
                                                className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                                        </div>
                                        <div>
                                            <label className="text-[10px] text-gray-500 block">{tx('To', 'Hasta')}</label>
                                            <input type="time" value={dayData.to || '21:00'}
                                                onChange={e => updateDay(d.k, { to: e.target.value })}
                                                className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                <div className="border-t border-gray-200 p-3 flex gap-2">
                    <button onClick={onClose} className="flex-1 py-2 rounded-lg glass-button-apple text-dd-text-2 font-bold">{tx('Cancel', 'Cancelar')}</button>
                    <button onClick={handleSave} className="flex-1 py-2 rounded-lg bg-purple-700 text-white font-bold">{tx('Save', 'Guardar')}</button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}


// ── AvailableStaffModal ────────────────────────────────────────────────────
// Click a day header in the Weekly Grid → opens this modal showing every
// staff member who is available that day (per their availability windows AND
// not on approved PTO AND not already scheduled). Each entry is color-coded
// by current weekly hours so the manager can pick the lowest-hours person to
// avoid pushing anyone into OT. Tap any name to jump straight into the
// Add Shift modal pre-filled for that staff + date.
function AvailableStaffModal({ dateStr, onClose, sideStaff, shifts, storeLocation, isStaffOffOn, isEn, onSchedule, requiredRoleGroup, slotStart, slotEnd, fillProgress }) {
    const tx = (en, es) => (isEn ? en : es);
    const date = parseLocalDate(dateStr);
    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dayKey = date ? dayKeys[date.getDay()] : null;
    const dayName = date ? (isEn ? DAYS_FULL_EN : DAYS_FULL_ES)[date.getDay()] : '';
    // Apply role filter when filling a slot that wants a specific role group.
    const roleFilteredStaff = requiredRoleGroup && requiredRoleGroup !== 'any'
        ? sideStaff.filter(s => isRoleEligible(s.role, requiredRoleGroup))
        : sideStaff;
    const requiredGroup = requiredRoleGroup ? SLOT_ROLE_BY_ID[requiredRoleGroup] : null;

    // Compute each staff's weekly hours (across the FLSA week containing dateStr)
    // and their availability state for this specific day.
    const weekStartLocal = date ? startOfWeek(date) : null;
    const rows = roleFilteredStaff.map(s => {
        // Total this week's hours
        let weeklyHours = 0;
        if (weekStartLocal) {
            for (let i = 0; i < 7; i++) {
                const d = toDateStr(addDays(weekStartLocal, i));
                const myShifts = shifts.filter(sh => sh.staffName === s.name && sh.date === d
                    && (storeLocation === 'both' || sh.location === storeLocation));
                // Per-day paid hours (auto-double deduction baked in).
                weeklyHours += dayPaidHours(myShifts);
            }
        }
        // Same-day shifts (raw list) so we can distinguish "real conflict"
        // (overlapping time) from "double-shift opportunity" (non-overlapping).
        const sameDayShifts = shifts.filter(sh => sh.staffName === s.name && sh.date === dateStr
            && (storeLocation === 'both' || sh.location === storeLocation));
        // Time overlap check — only meaningful if the slot has a time range.
        // No range (free day-header click) → we can't know, so don't treat
        // any existing shift as a hard conflict. Manager wants doubles to
        // be allowed: morning shift + evening pickup should both fly here.
        const hasOverlap = (slotStart && slotEnd) ? sameDayShifts.some(sh =>
            !(sh.endTime <= slotStart || sh.startTime >= slotEnd)
        ) : false;
        const isDoubleDay = sameDayShifts.length > 0 && !hasOverlap;
        // Availability for this weekday. Default semantics flipped per
        // Andrew (2026-05-12): missing or empty day data = AVAILABLE all
        // day. Staff only need to opt OUT of days they can't work, not
        // opt IN to days they can. Only `dayAvail.available === false` is
        // a true "unavailable" — any other shape (undefined, partial,
        // from/to set) counts as available.
        const dayAvail = (s.availability || {})[dayKey];
        const explicitlyOff = dayAvail && dayAvail.available === false;
        const availableThisDay = !explicitlyOff;
        // PTO?
        const onPto = isStaffOffOn(s.name, dateStr);

        let status = 'available';
        let reason = '';
        if (onPto) { status = 'pto'; reason = tx('on time-off', 'tiempo libre'); }
        else if (hasOverlap) { status = 'scheduled'; reason = tx('time overlaps existing shift', 'choca con turno existente'); }
        else if (!availableThisDay) { status = 'unavailable'; reason = tx('marked off this day', 'marcado como no disponible'); }

        return { ...s, weeklyHours, status, reason, dayAvail, sameDayShifts, isDoubleDay };
    });

    // Sort: available first, then by weekly hours ascending (lowest → best candidate)
    const STATUS_RANK = { available: 0, scheduled: 1, unavailable: 2, pto: 3 };
    rows.sort((a, b) => {
        if (a.status !== b.status) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
        return a.weeklyHours - b.weeklyHours;
    });

    const available = rows.filter(r => r.status === 'available');
    const otherwise = rows.filter(r => r.status !== 'available');

    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                        <h3 className="text-lg font-bold text-dd-text inline-flex items-center gap-2">
                            <span className="w-9 h-9 rounded-lg bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                <Users size={18} strokeWidth={2.25} aria-hidden="true" />
                            </span>
                            {tx('Who can work?', '¿Quién puede trabajar?')}
                        </h3>
                        <p className="text-xs text-gray-500 flex items-center gap-1.5 flex-wrap">
                            <span>{dayName} · {dateStr}</span>
                            {requiredGroup && requiredGroup.id !== 'any' && (
                                <span className="inline-block px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800 text-[10px] font-bold">
                                    {requiredGroup.emoji} {tx(requiredGroup.labelEn, requiredGroup.labelEs)} {tx('only', 'solo')}
                                </span>
                            )}
                            {/* Multi-fill progress chip — counts up as the manager
                                picks staff. Modal stays open until filled/count
                                or manager hits the X. */}
                            {fillProgress && (
                                <span className="inline-block px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold">
                                    {tx(`Pick ${Math.max(0, fillProgress.count - fillProgress.filled)} more`, `Elige ${Math.max(0, fillProgress.count - fillProgress.filled)} más`)} · {fillProgress.filled}/{fillProgress.count}
                                </span>
                            )}
                        </p>
                        {/* Just-filled chips so the manager sees who they've
                            already added in this open session. Shown only when
                            we're in fill mode AND at least one slot was filled. */}
                        {fillProgress && fillProgress.filled > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                                {fillProgress.filledStaff.map((name, i) => (
                                    <span key={i} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-green-100 text-green-800 rounded-full text-[10px] font-bold">
                                        ✓ {name.split(' ')[0]}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg flex-shrink-0">×</button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    {/* AVAILABLE — sorted by lowest hours first (best candidates) */}
                    {available.length > 0 ? (
                        <div>
                            <div className="text-xs font-bold text-green-800 mb-1">
                                ✓ {tx('Available', 'Disponible')} ({available.length})
                                <span className="font-normal text-gray-500 ml-1">— {tx('lowest hours first', 'menos horas primero')}</span>
                            </div>
                            <div className="space-y-1">
                                {available.map(r => (
                                    <button key={r.id || r.name}
                                        onClick={() => onSchedule(r)}
                                        className={`w-full flex items-center justify-between gap-2 p-2 rounded-lg border text-left ${
                                            r.isDoubleDay
                                                ? 'bg-blue-50 border-blue-300 hover:bg-blue-100'
                                                : 'bg-white hover:bg-mint-50 hover:border-mint-300'
                                        }`}>
                                        <div className="min-w-0 flex-1">
                                            <div className="font-bold text-gray-800 truncate flex items-center gap-1">
                                                {r.name}
                                                {r.shiftLead && <span title="Shift Lead">🛡️</span>}
                                                {r.isMinor && <span title="Minor">🔑</span>}
                                                {r.isDoubleDay && (
                                                    <span className="ml-1 px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[9px] font-bold whitespace-nowrap" title={tx('Already has a shift today — this would be a double', 'Ya tiene turno hoy — sería un doble')}>
                                                        🔁 {tx('double', 'doble')}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-[10px] text-gray-500">
                                                {r.role} · {r.dayAvail?.from && r.dayAvail?.to
                                                    ? `${tx('Avail', 'Disp')} ${r.dayAvail.from}–${r.dayAvail.to}`
                                                    : tx('Avail all day', 'Todo el día')}
                                                {r.targetHours ? ` · ${tx('target', 'objetivo')} ${r.targetHours}h` : ''}
                                                {r.isDoubleDay && r.sameDayShifts.length > 0 && (
                                                    <> · {tx('has', 'tiene')} {r.sameDayShifts.map(sh => `${sh.startTime}–${sh.endTime}`).join(', ')}</>
                                                )}
                                            </div>
                                        </div>
                                        <span className={`flex-shrink-0 px-2 py-1 rounded border text-[11px] font-bold ${hoursColor(r.weeklyHours)}`}>
                                            {formatHours(r.weeklyHours)}
                                        </span>
                                        <span className="flex-shrink-0 text-mint-700 font-bold text-lg">+</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className="text-center py-4 text-gray-400 text-sm">{tx('No staff available this day.', 'Sin personal disponible este día.')}</div>
                    )}

                    {/* OTHERWISE — visible but greyed, with reason */}
                    {otherwise.length > 0 && (
                        <details className="mt-3">
                            <summary className="text-xs font-bold text-gray-500 cursor-pointer">
                                {tx('Not available', 'No disponible')} ({otherwise.length})
                            </summary>
                            <div className="space-y-1 mt-1 opacity-60">
                                {otherwise.map(r => (
                                    <div key={r.id || r.name} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-gray-200 bg-gray-50 text-xs">
                                        <div className="min-w-0 flex-1">
                                            <div className="font-bold text-gray-700 truncate">{r.name}</div>
                                            <div className="text-[10px] text-gray-500">
                                                {r.status === 'pto' && '🌴 '}
                                                {r.status === 'scheduled' && '📅 '}
                                                {r.status === 'unavailable' && '🚫 '}
                                                {r.reason}
                                            </div>
                                        </div>
                                        <span className={`flex-shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-bold ${hoursColor(r.weeklyHours)}`}>
                                            {formatHours(r.weeklyHours)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </details>
                    )}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}


// ── PtoView ────────────────────────────────────────────────────────────────
// 4th view mode (next to Grid/Day/List). Calendar of all time-off entries
// for the current week + side, color-coded by status.
function PtoView({ weekStart, timeOff, locationStaffNames, sideStaffNames, isEn, currentStaffName, canEdit, onRemove, onSetStatus }) {
    const tx = (en, es) => (isEn ? en : es);
    const days = [0,1,2,3,4,5,6].map(i => addDays(weekStart, i));
    const dayLabels = isEn ? DAYS_EN : DAYS_ES;
    const dayLabelsFull = isEn ? DAYS_FULL_EN : DAYS_FULL_ES;
    const today = toDateStr(new Date());

    // Filter time-off to entries whose range overlaps this week + location.
    // We use locationStaffNames (NOT sideStaffNames) so PTO from staff who
    // happen to not have a shift this week, or who work the other side,
    // still appears in the PTO view. Falls back to sideStaffNames only when
    // locationStaffNames isn't passed (legacy callsites).
    const filterSet = locationStaffNames || sideStaffNames;
    const weekStartStr = toDateStr(weekStart);
    const weekEndStr = toDateStr(addDays(weekStart, 7));
    const weekTimeOff = (timeOff || []).filter(t => {
        if (filterSet && !filterSet.has(t.staffName)) return false;
        const start = t.startDate || t.date;
        const end = t.endDate || t.date;
        // Overlap test
        return start < weekEndStr && end >= weekStartStr;
    });

    // Group entries that touch each day for a calendar-style view
    const entriesByDay = days.map(d => {
        const dStr = toDateStr(d);
        const list = weekTimeOff.filter(t => {
            const start = t.startDate || t.date;
            const end = t.endDate || t.date;
            return dStr >= start && dStr <= end;
        });
        // Sort: pending first (manager attention), then approved, then denied
        list.sort((a, b) => {
            const rank = (s) => s === 'pending' ? 0 : s === 'approved' ? 1 : 2;
            return rank(a.status) - rank(b.status);
        });
        return { date: d, dStr, list };
    });

    const totalsByStatus = weekTimeOff.reduce((acc, t) => {
        acc[t.status || 'pending'] = (acc[t.status || 'pending'] || 0) + 1;
        return acc;
    }, {});

    const statusBadge = (status) => {
        if (status === 'approved') return { bg: 'bg-green-100', border: 'border-green-300', text: 'text-green-800', icon: '✅' };
        if (status === 'denied')   return { bg: 'bg-red-100',   border: 'border-red-300',   text: 'text-red-800',   icon: '❌' };
        return                       { bg: 'bg-yellow-100', border: 'border-yellow-300', text: 'text-yellow-800', icon: '⏳' };
    };

    return (
        <div>
            {/* Week summary */}
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
                <span className="px-2 py-1 rounded-full bg-yellow-100 text-yellow-900 font-bold border border-yellow-300">⏳ {tx('Pending', 'Pendiente')}: {totalsByStatus.pending || 0}</span>
                <span className="px-2 py-1 rounded-full bg-green-100 text-green-900 font-bold border border-green-300">✅ {tx('Approved', 'Aprobado')}: {totalsByStatus.approved || 0}</span>
                {totalsByStatus.denied > 0 && (
                    <span className="px-2 py-1 rounded-full bg-red-100 text-red-900 font-bold border border-red-300">❌ {tx('Denied', 'Negado')}: {totalsByStatus.denied}</span>
                )}
            </div>

            {/* Day-by-day list (mobile-friendly stack instead of grid) */}
            <div className="space-y-2">
                {entriesByDay.map(({ date, dStr, list }) => {
                    const isToday = dStr === today;
                    return (
                        <div key={dStr} className={`border rounded-lg ${isToday ? 'border-mint-400' : 'border-gray-200'} bg-white overflow-hidden`}>
                            <div className={`px-3 py-2 ${isToday ? 'bg-mint-50' : 'bg-gray-50'} border-b ${isToday ? 'border-mint-200' : 'border-gray-200'}`}>
                                <div className="text-xs font-bold text-gray-700">{dayLabelsFull[date.getDay()]} · {dStr}</div>
                            </div>
                            {list.length === 0 ? (
                                <div className="p-2 text-center text-gray-400 text-xs">— {tx('no time-off', 'sin tiempo libre')} —</div>
                            ) : (
                                <div className="p-2 space-y-1">
                                    {list.map(t => {
                                        const b = statusBadge(t.status);
                                        const isMine = t.staffName === currentStaffName;
                                        // Editors see when the request came in (Andrew
                                        // 2026-06-10) + get the full status-change chips
                                        // on every entry — approve, deny, back to
                                        // pending, delete — so a decision is never
                                        // locked in. onSetStatus runs the confirm flow.
                                        const submitted = canEdit ? fmtPtoWhen(t.submittedAt || t.createdAt, isEn) : '';
                                        return (
                                            <div key={t.id} className={`p-2 rounded border ${b.border} ${b.bg}`}>
                                                <div className={`font-bold text-xs ${b.text}`}>
                                                    {b.icon} {isMine && '✓ '}{t.staffName}
                                                    {t.status !== 'pending' && t.reviewedBy ? (
                                                        <span className="font-normal opacity-80">
                                                            {' '}· {isEn ? `by ${t.reviewedBy}` : `por ${t.reviewedBy}`}
                                                        </span>
                                                    ) : null}
                                                </div>
                                                <div className="text-[10px] text-gray-700">
                                                    {t.startDate}{t.endDate && t.endDate !== t.startDate ? ` → ${t.endDate}` : ''}
                                                    {ptoIsPartial(t) && <span className="font-bold text-amber-700 ml-1">· ⛔ {ptoWindowLabel(t)} {isEn ? 'off' : 'libre'}</span>}
                                                    {t.reason && <span className="italic ml-2">"{t.reason}"</span>}
                                                </div>
                                                {submitted && (
                                                    <div className="text-[10px] text-gray-500">
                                                        {isEn ? `Submitted ${submitted}` : `Enviado ${submitted}`}
                                                    </div>
                                                )}
                                                {canEdit && (
                                                    <div className="mt-1.5">
                                                        <PtoActionChips entry={t} isEn={isEn} onSetStatus={onSetStatus} onRemove={onRemove} />
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}


// ── NotificationsDrawer ────────────────────────────────────────────────────
// In-app notification list. OS-level push will be added in a follow-up (needs
// a service worker + Cloud Function to fire pushes from Firestore writes).
function NotificationsDrawer({ notifications, onClose, onMarkRead, onMarkAllRead, isEn, notifPermission, onRequestPermission }) {
    const tx = (en, es) => (isEn ? en : es);
    const fmtTime = (ts) => {
        if (!ts || !ts.toMillis) return '';
        const d = new Date(ts.toMillis());
        const now = new Date();
        const diffMin = Math.floor((now - d) / 60000);
        if (diffMin < 1) return tx('just now', 'ahora');
        if (diffMin < 60) return tx(`${diffMin}m ago`, `hace ${diffMin}m`);
        if (diffMin < 60 * 24) return tx(`${Math.floor(diffMin/60)}h ago`, `hace ${Math.floor(diffMin/60)}h`);
        return d.toLocaleDateString();
    };
    const iconFor = (type) => {
        if (type?.startsWith('swap')) return '🔄';
        if (type?.startsWith('pto')) return '🌴';
        if (type === 'week_published') return '📢';
        return '📬';
    };
    // Backdrop-close uses target-vs-currentTarget instead of bubble stopping.
    // On iOS, scrolling inside the inner panel can produce a synthetic
    // click whose target is the inner panel but whose path still reaches
    // the backdrop after stopPropagation if the gesture crosses elements.
    // Comparing target to currentTarget on the backdrop is the standard
    // fix: dismiss ONLY when the click landed on the backdrop itself.
    const handleBackdrop = (e) => {
        if (e.target === e.currentTarget) onClose();
    };
    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/40 z-50 flex justify-end"
            onMouseDown={handleBackdrop}
            onTouchStart={handleBackdrop}>
            <div className="glass-sheet w-full max-w-sm h-full overflow-y-auto shadow-2xl"
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}>
                <div className="sticky top-0 bg-white border-b border-dd-line p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-dd-text">🔔 {tx('Notifications', 'Notificaciones')}</h3>
                    <div className="flex items-center gap-2">
                        {notifications.some(n => !n.read) && (
                            <button onClick={onMarkAllRead}
                                className="text-xs text-dd-green-700 underline font-semibold">{tx('Mark all read', 'Marcar todo')}</button>
                        )}
                        <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg">×</button>
                    </div>
                </div>
                <div className="p-3 space-y-2">
                    {/* Permission prompt */}
                    {notifPermission === 'default' && (
                        <button onClick={onRequestPermission}
                            className="w-full p-3 rounded-lg bg-mint-50 border-2 border-mint-300 text-left">
                            <div className="font-bold text-sm text-mint-800">🔔 {tx('Enable browser notifications', 'Activar notificaciones del navegador')}</div>
                            <div className="text-xs text-mint-700 mt-0.5">{tx('Get pinged when a swap is approved, your time-off is decided, or a new schedule is published.', 'Recibe avisos cuando se aprueben cambios, decidan tu tiempo libre o publiquen nuevo horario.')}</div>
                        </button>
                    )}
                    {notifPermission === 'denied' && (
                        <div className="p-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                            ⚠ {tx('Browser notifications are blocked. Re-enable in your browser settings if you want to be pinged.', 'Las notificaciones están bloqueadas. Habilítalas en la configuración del navegador.')}
                        </div>
                    )}
                    {notifPermission === 'granted' && (
                        <div className="p-2 rounded-lg bg-green-50 border border-green-200 text-xs text-green-800">
                            ✓ {tx('Browser notifications enabled.', 'Notificaciones activadas.')}
                        </div>
                    )}
                    {notifications.length === 0 ? (
                        <p className="text-center text-gray-400 text-sm py-12">{tx('Nothing here yet.', 'Aún no hay nada.')}</p>
                    ) : notifications.map(n => (
                        <div key={n.id}
                            onClick={() => !n.read && onMarkRead(n.id)}
                            className={`p-4 rounded-lg border cursor-pointer ${n.read ? 'bg-white border-gray-200' : 'bg-mint-50 border-mint-300'}`}>
                            <div className="flex items-start gap-3">
                                <span className="text-2xl flex-shrink-0">{iconFor(n.type)}</span>
                                <div className="min-w-0 flex-1">
                                    <div className={`font-bold text-base ${n.read ? 'text-gray-700' : 'text-mint-800'}`}>{n.title}</div>
                                    <div className="text-sm text-gray-700 mt-1 leading-snug whitespace-pre-line">{n.body}</div>
                                    <div className="text-xs text-gray-400 mt-1.5">{fmtTime(n.createdAt)}</div>
                                </div>
                                {!n.read && <span className="w-2 h-2 rounded-full bg-mint-600 flex-shrink-0 mt-1"></span>}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}


// ── StaffingNeedModal ─────────────────────────────────────────────────────
// Manager defines a "we need N people in this time block" slot. Each slot can
// be filled later via the AvailableStaffModal flow — picking a person creates
// a real shift and ticks one of the slot's openings down.
function StaffingNeedModal({ onClose, onSave, storeLocation, side, weekStart, isEn, initial }) {
    const tx = (en, es) => (isEn ? en : es);
    const isEditing = !!initial?.id;
    const [form, setForm] = useState(() => ({
        date: initial?.date || toDateStr(weekStart),
        side: initial?.side || side,
        location: initial?.location || (storeLocation && storeLocation !== 'both' ? storeLocation : 'webster'),
        startTime: initial?.startTime || '09:00',
        endTime: initial?.endTime || '15:00',
        count: initial?.count || 5,
        roleGroup: initial?.roleGroup || 'any',
        notes: initial?.notes || '',
        // openToAllStaff — when true, this slot is broadcast to
        // every staff member as an "up for grabs" shift. Default
        // OFF for backward compat: existing slot creation flows
        // stay manager-fills-it-manually. Toggle on when the
        // manager wants the team to self-elect (Andrew 2026-05-23:
        // "if i cant find the 5th person on thursday i can add
        // one shift up for grabs"). Existing fill flow still works
        // — claims are advisory, manager still confirms who gets
        // the shift.
        openToAllStaff: initial?.openToAllStaff || false,
    }));
    const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
    // FIX (2026-05-14): surface specific reason save is blocked so user
    // isn't stuck staring at a gray button.
    const submitBlockedReason = (() => {
        if (!form.date) return tx('Pick a date', 'Elige una fecha');
        if (!form.startTime || !form.endTime) return tx('Pick start + end times', 'Elige inicio y fin');
        if (form.startTime >= form.endTime) return tx('End time must be after start time', 'La hora de fin debe ser después del inicio');
        if (!form.count || form.count < 1) return tx('Set count to at least 1', 'Cuenta mínima es 1');
        return null;
    })();
    const canSubmit = submitBlockedReason === null;
    const handleSave = () => {
        if (!canSubmit) return;
        // When editing, preserve id + filledStaff/filledShiftIds so the count
        // bookkeeping doesn't reset.
        if (isEditing) {
            onSave({
                ...form,
                id: initial.id,
                filledStaff: initial.filledStaff || [],
                filledShiftIds: initial.filledShiftIds || [],
                fromTemplateId: initial.fromTemplateId,
            });
        } else {
            onSave(form);
        }
    };
    // Common DD Mau time presets — tap to fill start/end. Different sets for
    // FOH (10-3, 3-8, 4-8, 12-7) vs BOH (10-8 double, 10-3, 4-8).
    const presets = form.side === 'boh'
        ? [
            { label: '10–8', start: '10:00', end: '20:00' },
            { label: '10–3', start: '10:00', end: '15:00' },
            { label: '4–8',  start: '16:00', end: '20:00' },
        ]
        : [
            { label: '10–3', start: '10:00', end: '15:00' },
            { label: '3–8',  start: '15:00', end: '20:00' },
            { label: '4–8',  start: '16:00', end: '20:00' },
            { label: '12–7', start: '12:00', end: '19:00' },
        ];
    const isPresetActive = (p) => form.startTime === p.start && form.endTime === p.end;
    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
                <div className="sticky top-0 bg-white border-b border-dd-line p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-blue-700 inline-flex items-center gap-2">
                        <span className="w-9 h-9 rounded-lg bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                            <Users size={18} strokeWidth={2.25} aria-hidden="true" />
                        </span>
                        {isEditing ? tx('Edit Slot', 'Editar Espacio') : tx('Add Staffing Need', 'Agregar Necesidad')}
                    </h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full glass-sheet text-dd-text-2 hover:text-dd-text text-lg">×</button>
                </div>
                <div className="p-4 space-y-3">
                    <div className="text-xs text-gray-600 bg-blue-50 rounded-lg p-2 border border-blue-200">
                        {tx('Define a time block — e.g. "morning needs 5, evening needs 7." Then assign staff one slot at a time. Each fill creates a real shift.', 'Define un bloque de tiempo — ej. "mañana 5, noche 7." Luego asigna personal un espacio a la vez. Cada asignación crea un turno real.')}
                    </div>
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Date', 'Fecha')}</label>
                        <input type="date" value={form.date} onChange={e => update('date', e.target.value)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                    </div>
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Side', 'Lado')}</label>
                        <div className="grid grid-cols-2 gap-2">
                            <button onClick={() => update('side', 'foh')}
                                className={`py-2 rounded-lg text-sm font-bold border ${form.side === 'foh' ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-gray-700 border-gray-300'}`}>FOH</button>
                            <button onClick={() => update('side', 'boh')}
                                className={`py-2 rounded-lg text-sm font-bold border ${form.side === 'boh' ? 'bg-orange-600 text-white border-orange-600' : 'bg-white text-gray-700 border-gray-300'}`}>BOH</button>
                        </div>
                    </div>
                    {/* Common time presets — tap to fill start/end */}
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Quick presets', 'Presets rápidos')}</label>
                        <div className="flex flex-wrap gap-1.5">
                            {presets.map(p => (
                                <button key={p.label} type="button"
                                    onClick={() => setForm(f => ({ ...f, startTime: p.start, endTime: p.end }))}
                                    className={`px-2.5 py-1 rounded-md text-[11px] font-bold border ${
                                        isPresetActive(p)
                                            ? 'bg-blue-600 text-white border-blue-600'
                                            : 'bg-white text-gray-700 border-gray-300 hover:border-blue-400'
                                    }`}>
                                    {p.label}
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] text-gray-500 mt-1">{tx('Or set custom times below.', 'O ingresa horario personalizado abajo.')}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Start', 'Inicio')}</label>
                            <input type="time" value={form.startTime} onChange={e => update('startTime', e.target.value)}
                                className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                        </div>
                        <div>
                            <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('End', 'Fin')}</label>
                            <input type="time" value={form.endTime} onChange={e => update('endTime', e.target.value)}
                                className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                        </div>
                    </div>
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('How many people?', '¿Cuántas personas?')}</label>
                        {/* FIX (2026-05-15, Andrew "slot box starts with a 1
                            and i cant delete the 1 to type 5"): the previous
                            onChange did Math.max(1, parseInt(v) || 1) which
                            forced empty → 1, so the user could never clear the
                            field to retype. Now we let the field hold "" while
                            typing and coerce to ≥1 on blur. canSubmit still
                            blocks save when count < 1, so the empty interim
                            state is safe. */}
                        <input type="number" min="1" max="20" value={form.count}
                            onChange={e => {
                                const v = e.target.value;
                                if (v === '') { update('count', ''); return; }
                                const n = parseInt(v, 10);
                                if (Number.isFinite(n)) update('count', Math.min(20, Math.max(1, n)));
                            }}
                            onBlur={() => {
                                if (form.count === '' || !Number.isFinite(form.count) || form.count < 1) update('count', 1);
                            }}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                        {isEditing && (initial.filledStaff || []).length > 0 && (
                            <p className="text-[10px] text-amber-700 mt-1">
                                {tx(`⚠ ${(initial.filledStaff || []).length} already assigned. Lowering below this won't unassign — remove individually.`,
                                   `⚠ ${(initial.filledStaff || []).length} ya asignados. Bajar la cuenta no los quitará — quítalos individualmente.`)}
                            </p>
                        )}
                    </div>
                    {/* Role filter — restricts who can fill the slot */}
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Role required', 'Rol requerido')}</label>
                        <div className="grid grid-cols-3 gap-1.5">
                            {SLOT_ROLE_GROUPS.map(g => (
                                <button key={g.id} type="button"
                                    onClick={() => update('roleGroup', g.id)}
                                    className={`py-1.5 px-2 rounded-md text-[10px] font-bold border ${
                                        form.roleGroup === g.id
                                            ? 'bg-indigo-600 text-white border-indigo-600'
                                            : 'bg-white text-gray-700 border-gray-300'
                                    }`}>
                                    {g.emoji} {tx(g.labelEn, g.labelEs)}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Location', 'Ubicación')}</label>
                        <div className="grid grid-cols-2 gap-2">
                            {['webster', 'maryland'].map(loc => (
                                <button key={loc} onClick={() => update('location', loc)}
                                    className={`py-2 rounded-lg text-sm font-bold border ${form.location === loc ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-gray-700 border-gray-300'}`}>
                                    {LOCATION_LABELS[loc]}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Notes (e.g. "morning crew")', 'Notas (ej. "equipo de mañana")')}</label>
                        <input type="text" value={form.notes} onChange={e => update('notes', e.target.value)}
                            placeholder={tx('Optional label', 'Etiqueta opcional')}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                    </div>
                    {/* Up-for-grabs toggle. When ON, this slot shows up on
                        the staff side of the schedule with a "🙋 I want
                        this" button. Every interest click writes a
                        timestamped entry to the slot's interestedClaims
                        array, ordered by arrival, and notifies managers +
                        admins. Manager still picks who gets it from the
                        queue — claims are advisory, not auto-fill. */}
                    <div>
                        <label className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 cursor-pointer hover:bg-amber-100 transition">
                            <input type="checkbox"
                                checked={!!form.openToAllStaff}
                                onChange={e => update('openToAllStaff', e.target.checked)}
                                className="mt-0.5 w-4 h-4 accent-amber-600" />
                            <span className="text-[12px] text-amber-900 leading-snug">
                                <span className="font-black">🙋 {tx('Up for grabs', 'Disponible')}</span>
                                <br />
                                <span className="text-amber-800/85">
                                    {tx(
                                        'Broadcast to every staff member. Anyone — even people off that day or working another shift — can tap "I want this" to join the pickup queue. Managers see the timestamped order and pick.',
                                        'Anunciar a todo el personal. Cualquiera — incluso quienes están libres o ya trabajan otro turno — puede tocar "Lo quiero". Los gerentes ven el orden por timestamp y eligen.',
                                    )}
                                </span>
                            </span>
                        </label>
                    </div>
                </div>
                <div className="sticky bottom-0 bg-white border-t border-dd-line p-4 space-y-2">
                    {!canSubmit && (
                        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 text-center font-semibold">
                            ⚠ {submitBlockedReason}
                        </div>
                    )}
                    <div className="flex gap-2">
                        <button onClick={onClose} className="flex-1 py-2 rounded-lg glass-button-apple text-dd-text-2 font-bold">{tx('Cancel', 'Cancelar')}</button>
                        <button onClick={handleSave} disabled={!canSubmit}
                            title={canSubmit ? '' : submitBlockedReason}
                            className={`flex-1 py-2 rounded-lg font-bold text-white ${canSubmit ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-300 cursor-not-allowed'}`}>
                            {isEditing ? tx('Save Changes', 'Guardar Cambios') : tx('Save Need', 'Guardar Necesidad')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── FillSlotChooserModal ──────────────────────────────────────────────────
// When manager clicks "+" on a staff cell and there are open slots that staff
// can fill, this modal pops up first. Shows the matching slots with one-tap
// "Assign here" buttons, plus a "custom shift instead" fallback.
// Preview modal that pops before the actual publish write. Shows every
// draft about to go live grouped by day, with staffing-need warnings up
// top, and lets the manager remove a bad-looking draft inline before
// pulling the trigger. Replaces the old native confirm() dialog which
// just showed a count.
function PublishPreviewModal({ preview, side, weekStart, isEn, onCancel, onConfirm, onRemoveDraft }) {
    const tx = (en, es) => (isEn ? en : es);
    const { drafts, underFilled, overFilled } = preview;
    // Group drafts by day so the manager can scan day-by-day. Sun→Sat order
    // matches the rest of the UI.
    const days = DAYS_EN.map((_, i) => addDays(weekStart, i));
    const dayLabelsFull = isEn ? DAYS_FULL_EN : DAYS_FULL_ES;
    const draftsByDate = useMemo(() => {
        const map = new Map();
        for (const d of drafts) {
            const arr = map.get(d.date) || [];
            arr.push(d);
            map.set(d.date, arr);
        }
        // Sort each day's drafts by start time so the read order matches the grid.
        for (const arr of map.values()) {
            arr.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
        }
        return map;
    }, [drafts]);

    const sideLabel = side === 'foh' ? 'FOH' : 'BOH';
    const totalHours = drafts.reduce(
        (s, d) => s + hoursBetween(d.startTime, d.endTime, !!d.isDouble), 0);

    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                {/* Header */}
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-bold text-dd-text">
                            📋 {tx('Publish drafts — preview', 'Publicar borradores — vista previa')}
                        </h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                            {tx(`${drafts.length} shift${drafts.length === 1 ? '' : 's'} · ${formatHours(totalHours)} · ${sideLabel} · week of ${toDateStr(weekStart)}`,
                                `${drafts.length} turno${drafts.length === 1 ? '' : 's'} · ${formatHours(totalHours)} · ${sideLabel} · semana del ${toDateStr(weekStart)}`)}
                        </p>
                    </div>
                    <button onClick={onCancel}
                        className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg">×</button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {/* Staffing-need warnings — same audit as before, formatted properly */}
                    {(underFilled.length > 0 || overFilled.length > 0) && (
                        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3 space-y-2 text-xs">
                            {underFilled.length > 0 && (
                                <div>
                                    <div className="font-bold text-amber-900 mb-1">
                                        ⚠️ {tx(`${underFilled.length} need(s) UNDER-FILLED`, `${underFilled.length} necesidad(es) SIN COMPLETAR`)}
                                    </div>
                                    <ul className="space-y-0.5 ml-4 text-amber-900">
                                        {underFilled.slice(0, 6).map(n => (
                                            <li key={n.id}>· {n.date} {formatTime12h(n.startTime)}–{formatTime12h(n.endTime)}: <b>{(n.filledStaff || []).length}/{n.count}</b></li>
                                        ))}
                                        {underFilled.length > 6 && <li className="text-amber-700">…+{underFilled.length - 6} {tx('more', 'más')}</li>}
                                    </ul>
                                </div>
                            )}
                            {overFilled.length > 0 && (
                                <div>
                                    <div className="font-bold text-amber-900 mb-1">
                                        ⚠️ {tx(`${overFilled.length} need(s) OVER-FILLED`, `${overFilled.length} necesidad(es) EXCEDIDAS`)}
                                    </div>
                                    <ul className="space-y-0.5 ml-4 text-amber-900">
                                        {overFilled.slice(0, 6).map(n => (
                                            <li key={n.id}>· {n.date} {formatTime12h(n.startTime)}–{formatTime12h(n.endTime)}: <b>{(n.filledStaff || []).length}/{n.count}</b></li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}
                    {/* Drafts grouped by day */}
                    {drafts.length === 0 ? (
                        <p className="text-center text-gray-400 text-sm py-8">{tx('All drafts removed.', 'Todos los borradores eliminados.')}</p>
                    ) : (
                        days.map((d, i) => {
                            const dStr = toDateStr(d);
                            const dayDrafts = draftsByDate.get(dStr) || [];
                            if (dayDrafts.length === 0) return null;
                            const dayHours = dayDrafts.reduce(
                                (s, sh) => s + hoursBetween(sh.startTime, sh.endTime, !!sh.isDouble), 0);
                            return (
                                <div key={i} className="rounded-lg border border-gray-200 overflow-hidden">
                                    <div className="bg-gray-50 px-3 py-1.5 flex items-center justify-between">
                                        <div className="text-xs font-bold text-gray-700">
                                            {dayLabelsFull[d.getDay()]} · {d.getMonth() + 1}/{d.getDate()}
                                        </div>
                                        <div className="text-[10px] text-gray-500 font-bold">
                                            {dayDrafts.length} {tx(dayDrafts.length === 1 ? 'shift' : 'shifts', dayDrafts.length === 1 ? 'turno' : 'turnos')} · {formatHours(dayHours)}
                                        </div>
                                    </div>
                                    <ul className="divide-y divide-gray-100">
                                        {dayDrafts.map(sh => (
                                            <li key={sh.id} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                                                <span className="font-bold text-gray-800 flex-1 truncate">{sh.staffName}</span>
                                                <span className="text-gray-600 whitespace-nowrap">{formatTime12h(sh.startTime)}–{formatTime12h(sh.endTime)}</span>
                                                {sh.isDouble && <span title="Double">⏱</span>}
                                                {sh.isShiftLead && <span title="Shift Lead">🛡️</span>}
                                                <button onClick={() => onRemoveDraft(sh.id)}
                                                    title={tx('Remove this draft (will not publish)', 'Quitar este borrador (no se publica)')}
                                                    className="ml-1 px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-red-700 text-[10px] font-bold hover:bg-red-100">
                                                    ✕
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Footer */}
                <div className="border-t border-gray-200 p-4 flex items-center gap-2">
                    <button onClick={onCancel}
                        className="flex-1 sm:flex-initial px-4 py-2 rounded-lg glass-button-apple text-dd-text-2 text-sm font-bold hover:bg-gray-300">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={onConfirm}
                        disabled={drafts.length === 0}
                        className={`flex-1 px-4 py-2 rounded-lg text-sm font-bold text-white ${drafts.length === 0 ? 'bg-gray-300 cursor-not-allowed' : 'bg-dd-green hover:bg-dd-green-700'}`}>
                        ✓ {tx(`Publish ${drafts.length} draft${drafts.length === 1 ? '' : 's'}`, `Publicar ${drafts.length} borrador${drafts.length === 1 ? '' : 'es'}`)}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

function FillSlotChooserModal({ chooser, onClose, onAssignSlot, onCustomShift, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const { staff, dateStr, needs } = chooser;
    const date = parseLocalDate(dateStr);
    const dayLabel = date ? (isEn ? DAYS_EN : DAYS_ES)[date.getDay()] : '';
    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between flex-shrink-0">
                    <div>
                        <h3 className="text-lg font-bold text-blue-700 inline-flex items-center gap-2">
                            <span className="w-9 h-9 rounded-lg bg-dd-sage-50 text-dd-green-700 flex items-center justify-center shrink-0">
                                <Users size={18} strokeWidth={2.25} aria-hidden="true" />
                            </span>
                            {tx('Open Slots', 'Espacios Abiertos')}
                        </h3>
                        <p className="text-xs text-gray-600">{staff.name} · {dayLabel} {dateStr}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full glass-sheet text-dd-text-2 hover:text-dd-text text-lg">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    <p className="text-xs text-gray-600 bg-blue-50 rounded-lg p-2 border border-blue-200">
                        {tx('Tap a slot below to fill it. Or create a custom shift at the bottom.',
                           'Toca un espacio para asignarlo. O crea un turno personalizado abajo.')}
                    </p>
                    {needs.map(n => {
                        const filled = (n.filledStaff || []).length;
                        const open = Math.max(0, (n.count || 0) - filled);
                        const roleGroup = n.roleGroup ? SLOT_ROLE_BY_ID[n.roleGroup] : null;
                        return (
                            <button key={n.id} onClick={() => onAssignSlot(n)}
                                className="w-full text-left p-3 rounded-lg border-2 border-blue-200 hover:border-blue-500 bg-white">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="font-bold text-gray-800 text-sm">
                                            {formatTime12h(n.startTime)}–{formatTime12h(n.endTime)}
                                            {roleGroup && roleGroup.id !== 'any' && (
                                                <span className="ml-2 inline-block px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800 text-[10px] font-bold">
                                                    {roleGroup.emoji} {tx(roleGroup.labelEn, roleGroup.labelEs)}
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-[11px] text-gray-600 mt-0.5">
                                            {filled} / {n.count} {tx('filled', 'asignados')} · {open} {tx('open', 'abierto')}
                                            {n.notes && <span className="italic"> · {n.notes}</span>}
                                        </div>
                                    </div>
                                    <span className="px-2 py-1 rounded bg-blue-600 text-white text-[11px] font-bold flex-shrink-0">
                                        {tx('Assign →', 'Asignar →')}
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
                <div className="border-t border-gray-200 p-3 flex-shrink-0">
                    <button onClick={onCustomShift}
                        className="w-full py-2 rounded-lg bg-dd-green text-white font-bold text-sm hover:bg-dd-green-700">
                        ✏ {tx('Or create a custom shift instead', 'O crear un turno personalizado')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}


// ── TemplateEditorModal ───────────────────────────────────────────────────
// Manager creates a named template: side + location + N blocks. Each block has
// a label ("Morning") + start/end + role-slot rows (FOH / Lead / Manager etc.
// with a count). Saved to schedule_templates.
function TemplateEditorModal({ initial, onClose, onSave, storeLocation, side, weekStart, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const [tpl, setTpl] = useState(() => initial || {
        name: "",
        side: side,
        location: storeLocation && storeLocation !== "both" ? storeLocation : "webster",
        // daysOfWeek: empty = "any day" (back-compat with templates created
        // before this field shipped). When non-empty, ApplyTemplateModal
        // sorts matching-day templates to the top + warns before applying
        // to a non-matching date.
        daysOfWeek: [],
        blocks: [
            { label: tx("Morning", "Mañana"), startTime: "09:00", endTime: "15:00", slots: [{ roleGroup: "foh-staff", count: 3 }] },
        ],
    });
    // FIX (2026-05-15, Andrew): integrated apply flow. Build the template
    // AND schedule it for the visible week in one window — no more
    // bouncing between Edit Template and Apply Template modals. Each chip
    // represents a date in the current week.
    const applyDays = useMemo(() => {
        if (!weekStart) return [];
        const out = [];
        for (let i = 0; i < 7; i++) {
            const d = addDays(weekStart, i);
            out.push({
                dateStr: toDateStr(d),
                dayId: DAY_IDS[d.getDay()],
                dayLabel: (isEn ? DAYS_EN : DAYS_ES)[d.getDay()],
                dayNum: d.getDate(),
            });
        }
        return out;
    }, [weekStart, isEn]);
    const [applyDates, setApplyDates] = useState(() => new Set());
    // When daysOfWeek tag changes on the template, auto-suggest the
    // matching dates in the current week. Lets the user say "this
    // template runs every Mon/Wed" and immediately see those days
    // pre-checked for application without an extra step.
    useEffect(() => {
        const tagged = Array.isArray(tpl.daysOfWeek) ? tpl.daysOfWeek : [];
        if (tagged.length === 0) return;
        const next = new Set();
        for (const d of applyDays) {
            if (tagged.includes(d.dayId)) next.add(d.dateStr);
        }
        setApplyDates(next);
    }, [tpl.daysOfWeek, applyDays]);
    const toggleApplyDate = (dateStr) => {
        setApplyDates(prev => {
            const next = new Set(prev);
            if (next.has(dateStr)) next.delete(dateStr);
            else next.add(dateStr);
            return next;
        });
    };
    // Existing templates predating daysOfWeek lack the field — guard so
    // toggleDay doesn't blow up with `undefined.includes`.
    const tplDays = Array.isArray(tpl.daysOfWeek) ? tpl.daysOfWeek : [];
    const update = (k, v) => setTpl(t => ({ ...t, [k]: v }));
    const toggleDay = (d) => setTpl(t => {
        const days = Array.isArray(t.daysOfWeek) ? t.daysOfWeek : [];
        return {
            ...t,
            daysOfWeek: days.includes(d) ? days.filter(x => x !== d) : [...days, d],
        };
    });
    const setDayGroup = (groupId) => setTpl(t => {
        const groups = {
            all: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
            weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
            weekends: ['sat', 'sun'],
            none: [],
        };
        return { ...t, daysOfWeek: groups[groupId] || [] };
    });
    const updateBlock = (bi, k, v) => setTpl(t => ({
        ...t,
        blocks: t.blocks.map((b, i) => i === bi ? { ...b, [k]: v } : b),
    }));
    const updateSlot = (bi, si, k, v) => setTpl(t => ({
        ...t,
        blocks: t.blocks.map((b, i) => i === bi ? {
            ...b,
            slots: b.slots.map((s, j) => j === si ? { ...s, [k]: v } : s),
        } : b),
    }));
    const addBlock = () => setTpl(t => ({
        ...t,
        blocks: [...t.blocks, { label: "", startTime: "16:00", endTime: "22:00", slots: [{ roleGroup: "foh-staff", count: 1 }] }],
    }));
    const removeBlock = (bi) => setTpl(t => ({ ...t, blocks: t.blocks.filter((_, i) => i !== bi) }));
    const addSlot = (bi) => setTpl(t => ({
        ...t,
        blocks: t.blocks.map((b, i) => i === bi ? { ...b, slots: [...b.slots, { roleGroup: "any", count: 1 }] } : b),
    }));
    const removeSlot = (bi, si) => setTpl(t => ({
        ...t,
        blocks: t.blocks.map((b, i) => i === bi ? { ...b, slots: b.slots.filter((_, j) => j !== si) } : b),
    }));

    // FIX (2026-05-14, Andrew "save button isn't working"): surface the
    // specific reason save is disabled. Previously the button just went
    // gray and tapping did nothing — most common cause is missing
    // template name, but a manager who's just set up time + days has no
    // way to know that's the missing piece.
    const saveBlockedReason = (() => {
        if (!tpl.name.trim()) return tx('Add a name to save', 'Agrega un nombre para guardar');
        if (tpl.blocks.length === 0) return tx('Add at least one time block', 'Agrega al menos un bloque');
        for (const b of tpl.blocks) {
            if (!b.startTime || !b.endTime) return tx('Each block needs a start + end time', 'Cada bloque necesita inicio + fin');
            if (b.startTime >= b.endTime) return tx('End time must be after start time', 'La hora de fin debe ser después del inicio');
            if (b.slots.length === 0) return tx('Each block needs at least one role slot', 'Cada bloque necesita al menos un slot');
        }
        return null;
    })();
    const canSave = saveBlockedReason === null;

    // Common time presets per block — same DD Mau set as Add Shift, scoped to side.
    const blockPresets = tpl.side === "boh"
        ? [
            { label: "10–8", start: "10:00", end: "20:00" },
            { label: "10–3", start: "10:00", end: "15:00" },
            { label: "4–8",  start: "16:00", end: "20:00" },
        ]
        : [
            { label: "10–3", start: "10:00", end: "15:00" },
            { label: "3–8",  start: "15:00", end: "20:00" },
            { label: "4–8",  start: "16:00", end: "20:00" },
            { label: "12–7", start: "12:00", end: "19:00" },
        ];
    const isBlockPresetActive = (b, p) => b.startTime === p.start && b.endTime === p.end;
    const applyBlockPreset = (bi, p) => setTpl(t => ({
        ...t,
        blocks: t.blocks.map((b, i) => i === bi ? { ...b, startTime: p.start, endTime: p.end } : b),
    }));

    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-indigo-700">📋 {initial ? tx("Edit Template", "Editar Plantilla") : tx("New Template", "Nueva Plantilla")}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full glass-sheet text-dd-text-2 hover:text-dd-text text-lg">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {/* Name + Side + Location */}
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx("Template name", "Nombre")}</label>
                        <input type="text" value={tpl.name} onChange={e => update("name", e.target.value)}
                            placeholder={tx("e.g. Friday FOH, Sunday Brunch", "ej. Viernes FOH")}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx("Side", "Lado")}</label>
                            <div className="grid grid-cols-2 gap-1">
                                <button onClick={() => update("side", "foh")} className={`py-1.5 rounded-md text-xs font-bold border ${tpl.side === "foh" ? "bg-dd-green text-white border-dd-green" : "bg-white text-gray-600 border-gray-300"}`}>FOH</button>
                                <button onClick={() => update("side", "boh")} className={`py-1.5 rounded-md text-xs font-bold border ${tpl.side === "boh" ? "bg-orange-600 text-white border-orange-600" : "bg-white text-gray-600 border-gray-300"}`}>BOH</button>
                            </div>
                        </div>
                        <div>
                            <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx("Location", "Ubicación")}</label>
                            <select value={tpl.location} onChange={e => update("location", e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs">
                                <option value="webster">{LOCATION_LABELS.webster}</option>
                                <option value="maryland">{LOCATION_LABELS.maryland}</option>
                                <option value="both">{LOCATION_LABELS.both}</option>
                            </select>
                        </div>
                    </div>

                    {/* Days of week — tag which days this template applies to.
                        Optional. If left empty, ApplyTemplateModal lets you
                        apply on any date with no warning (full back-compat
                        with templates created before this picker shipped).
                        If populated, applying to a non-matching weekday
                        shows a confirm dialog. Matches the visual language
                        of the RecurringShiftsModal day picker so the two
                        feel like the same control. */}
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">
                            {tx("Use on which days?", "¿Para qué días?")}
                            <span className="ml-1 font-normal text-dd-text-2/70 normal-case tracking-normal">
                                {tx("(optional — leave empty for any day)", "(opcional — vacío = cualquier día)")}
                            </span>
                        </label>
                        <div className="flex flex-wrap gap-1 mb-1.5">
                            <button type="button" onClick={() => setDayGroup('all')}
                                className="px-2 py-0.5 rounded text-[10px] font-bold border border-gray-300 bg-white text-gray-600 hover:border-indigo-400">
                                {tx("All", "Todos")}
                            </button>
                            <button type="button" onClick={() => setDayGroup('weekdays')}
                                className="px-2 py-0.5 rounded text-[10px] font-bold border border-gray-300 bg-white text-gray-600 hover:border-indigo-400">
                                {tx("Weekdays", "Lun–Vie")}
                            </button>
                            <button type="button" onClick={() => setDayGroup('weekends')}
                                className="px-2 py-0.5 rounded text-[10px] font-bold border border-gray-300 bg-white text-gray-600 hover:border-indigo-400">
                                {tx("Weekends", "Fin de semana")}
                            </button>
                            <button type="button" onClick={() => setDayGroup('none')}
                                className="px-2 py-0.5 rounded text-[10px] font-bold border border-gray-300 bg-white text-gray-500 hover:border-red-300 hover:text-red-600">
                                {tx("Clear", "Limpiar")}
                            </button>
                        </div>
                        <div className="grid grid-cols-7 gap-1">
                            {DAY_IDS.map((dId, i) => {
                                const picked = tplDays.includes(dId);
                                return (
                                    <button key={dId} type="button" onClick={() => toggleDay(dId)}
                                        className={`py-1 rounded text-[11px] font-bold border transition ${
                                            picked
                                                ? 'bg-indigo-600 text-white border-indigo-600'
                                                : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'
                                        }`}>
                                        {isEn ? DAYS_EN[i] : DAYS_ES[i]}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Blocks */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-gray-700">{tx("Time blocks", "Bloques de tiempo")} ({tpl.blocks.length})</span>
                            <button onClick={addBlock} className="text-xs px-2 py-1 rounded bg-indigo-100 text-indigo-700 font-bold">+ {tx("Block", "Bloque")}</button>
                        </div>
                        {tpl.blocks.map((b, bi) => (
                            <div key={bi} className="border border-gray-200 rounded-lg p-2 space-y-2 bg-gray-50">
                                <div className="flex items-center gap-1">
                                    <input type="text" value={b.label} onChange={e => updateBlock(bi, "label", e.target.value)}
                                        placeholder={tx("Label (e.g. Morning)", "Etiqueta (ej. Mañana)")}
                                        className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs" />
                                    {tpl.blocks.length > 1 && (
                                        <button onClick={() => removeBlock(bi)} className="px-2 py-1 rounded bg-red-100 text-red-700 text-xs">×</button>
                                    )}
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="text-[10px] text-gray-500 block">{tx("From", "Desde")}</label>
                                        <input type="time" value={b.startTime} onChange={e => updateBlock(bi, "startTime", e.target.value)}
                                            className="w-full border border-gray-300 rounded px-2 py-1 text-xs" />
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-gray-500 block">{tx("To", "Hasta")}</label>
                                        <input type="time" value={b.endTime} onChange={e => updateBlock(bi, "endTime", e.target.value)}
                                            className="w-full border border-gray-300 rounded px-2 py-1 text-xs" />
                                    </div>
                                </div>
                                {/* Per-block time preset chips */}
                                <div className="flex flex-wrap gap-1 -mt-1">
                                    {blockPresets.map(p => (
                                        <button key={p.label} type="button"
                                            onClick={() => applyBlockPreset(bi, p)}
                                            className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                                isBlockPresetActive(b, p)
                                                    ? 'bg-indigo-600 text-white border-indigo-600'
                                                    : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'
                                            }`}>
                                            {p.label}
                                        </button>
                                    ))}
                                </div>
                                <div className="space-y-1">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] font-bold text-gray-600">{tx("Role slots", "Slots por rol")}</span>
                                        <button onClick={() => addSlot(bi)} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-bold">+ {tx("Slot", "Slot")}</button>
                                    </div>
                                    {b.slots.map((slot, si) => (
                                        <div key={si} className="flex items-center gap-1">
                                            <select value={slot.roleGroup || "any"} onChange={e => updateSlot(bi, si, "roleGroup", e.target.value)}
                                                className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs bg-white">
                                                {SLOT_ROLE_GROUPS.map(g => (
                                                    <option key={g.id} value={g.id}>{g.emoji} {tx(g.labelEn, g.labelEs)}</option>
                                                ))}
                                            </select>
                                            {/* See StaffingNeedModal count input
                                                for the rationale — let the field
                                                hold "" so user can delete the
                                                seed value and retype. Coerce on
                                                blur. */}
                                            <input type="number" min="1" max="20" value={slot.count}
                                                onChange={e => {
                                                    const v = e.target.value;
                                                    if (v === '') { updateSlot(bi, si, "count", ''); return; }
                                                    const n = parseInt(v, 10);
                                                    if (Number.isFinite(n)) updateSlot(bi, si, "count", Math.min(20, Math.max(1, n)));
                                                }}
                                                onBlur={() => {
                                                    if (slot.count === '' || !Number.isFinite(slot.count) || slot.count < 1) updateSlot(bi, si, "count", 1);
                                                }}
                                                className="w-14 border border-gray-300 rounded px-2 py-1 text-xs text-center" />
                                            {b.slots.length > 1 && (
                                                <button onClick={() => removeSlot(bi, si)} className="px-1.5 py-1 rounded bg-red-100 text-red-700 text-xs">×</button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
                {/* APPLY TO DAYS — pick from the visible week. Lets manager
                    build a template AND schedule it in one window without
                    closing + reopening the Apply modal. Optional: leave all
                    blank to just save the template definition. */}
                {applyDays.length > 0 && (
                    <div className="border-t border-gray-200 px-4 pt-3 pb-1">
                        <div className="flex items-center justify-between mb-1.5">
                            <div className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider">
                                {tx('Apply to days (this week)', 'Aplicar a días (esta semana)')}
                            </div>
                            <div className="flex gap-1.5">
                                <button onClick={() => setApplyDates(new Set(applyDays.map(d => d.dateStr)))}
                                    className="text-[10px] font-bold text-indigo-700 hover:text-indigo-900">
                                    {tx('All', 'Todos')}
                                </button>
                                <span className="text-[10px] text-gray-400">·</span>
                                <button onClick={() => setApplyDates(new Set())}
                                    className="text-[10px] font-bold text-gray-600 hover:text-gray-900">
                                    {tx('Clear', 'Limpiar')}
                                </button>
                            </div>
                        </div>
                        <div className="grid grid-cols-7 gap-1">
                            {applyDays.map(d => {
                                const isPicked = applyDates.has(d.dateStr);
                                return (
                                    <button key={d.dateStr} onClick={() => toggleApplyDate(d.dateStr)}
                                        className={`py-2 rounded-lg border-2 text-center transition active:scale-95 ${
                                            isPicked
                                                ? 'bg-indigo-600 border-indigo-700 text-white'
                                                : 'bg-white border-gray-200 text-gray-600 hover:border-indigo-300'
                                        }`}>
                                        <div className="text-[10px] font-black uppercase tracking-wider">{d.dayLabel}</div>
                                        <div className="text-sm font-bold">{d.dayNum}</div>
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-[10px] text-gray-500 mt-1.5">
                            {tx('Optional. Pick days to schedule this template immediately. Leave empty to save the template only.',
                                'Opcional. Elige días para programar esta plantilla de inmediato. Déjalo vacío para solo guardar.')}
                        </p>
                    </div>
                )}
                <div className="border-t border-gray-200 p-3 space-y-2">
                    {!canSave && (
                        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 text-center font-semibold">
                            ⚠ {saveBlockedReason}
                        </div>
                    )}
                    <div className="flex gap-2">
                        <button onClick={onClose} className="flex-1 py-2 rounded-lg glass-button-apple text-dd-text-2 font-bold">{tx("Cancel", "Cancelar")}</button>
                        {applyDates.size === 0 ? (
                            <button onClick={() => canSave && onSave(tpl)} disabled={!canSave}
                                title={canSave ? '' : saveBlockedReason}
                                className={`flex-1 py-2 rounded-lg font-bold text-white ${canSave ? "bg-indigo-600 hover:bg-indigo-700" : "bg-gray-300 cursor-not-allowed"}`}>
                                {tx("Save Template", "Guardar Plantilla")}
                            </button>
                        ) : (
                            <button onClick={() => canSave && onSave(tpl, Array.from(applyDates))} disabled={!canSave}
                                title={canSave ? '' : saveBlockedReason}
                                className={`flex-1 py-2 rounded-lg font-bold text-white ${canSave ? "bg-green-600 hover:bg-green-700" : "bg-gray-300 cursor-not-allowed"}`}>
                                {tx(`Save & Apply (${applyDates.size})`, `Guardar y Aplicar (${applyDates.size})`)}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── ApplyTemplateModal ────────────────────────────────────────────────────
// Pick a template + a date → bulk-creates all the staffing_needs at once.
// Also lets manager edit/delete an existing template, or create a new one.
function ApplyTemplateModal({ templates, onClose, onApply, onEdit, onCreate, onDelete, weekStart, side, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const [pickedTemplate, setPickedTemplate] = useState(null);
    // FIX (2026-05-14, Andrew): multi-day apply. Previously the modal had
    // a single <input type="date"> — to apply a template to Mon + Tue +
    // Wed you had to repeat the whole flow three times. Now: 7 day chips
    // for the visible week, toggleable, applies in one shot. The chips
    // show date numbers so the manager can target a specific week, and
    // auto-pre-check when a template with daysOfWeek is selected.
    const weekDays = useMemo(() => {
        const out = [];
        for (let i = 0; i < 7; i++) {
            const d = addDays(weekStart, i);
            out.push({
                dateStr: toDateStr(d),
                dayId: DAY_IDS[d.getDay()],
                dayLabel: (isEn ? DAYS_EN : DAYS_ES)[d.getDay()],
                dayNum: d.getDate(),
            });
        }
        return out;
    }, [weekStart, isEn]);
    const [pickedDates, setPickedDates] = useState(() => new Set());
    const togglePickedDate = (dateStr) => {
        setPickedDates(prev => {
            const next = new Set(prev);
            if (next.has(dateStr)) next.delete(dateStr);
            else next.add(dateStr);
            return next;
        });
    };
    // When a template gets selected, auto-pre-check the days it's tagged
    // for so the common case ("apply Lunch Rush template to its usual
    // days") is one tap instead of seven. Manager can still adjust.
    useEffect(() => {
        if (!pickedTemplate) return;
        const tplDays = Array.isArray(pickedTemplate.daysOfWeek) ? pickedTemplate.daysOfWeek : [];
        if (tplDays.length === 0) return;
        const next = new Set();
        for (const wd of weekDays) {
            if (tplDays.includes(wd.dayId)) next.add(wd.dateStr);
        }
        setPickedDates(next);
    }, [pickedTemplate, weekDays]);

    // Filter: keep templates for the current side, sort by "any picked
    // date matches the template's day tagging" so the relevant ones
    // float to the top.
    const pickedDayIds = useMemo(() => {
        const ids = new Set();
        for (const wd of weekDays) {
            if (pickedDates.has(wd.dateStr)) ids.add(wd.dayId);
        }
        return ids;
    }, [pickedDates, weekDays]);
    const templateMatchesAnyPicked = (t) => {
        if (pickedDayIds.size === 0) return true;
        if (!Array.isArray(t.daysOfWeek) || t.daysOfWeek.length === 0) return true;
        return t.daysOfWeek.some(d => pickedDayIds.has(d));
    };
    const filtered = templates
        .filter(t => t.side === side)
        .slice()
        .sort((a, b) => {
            const am = templateMatchesAnyPicked(a) ? 0 : 1;
            const bm = templateMatchesAnyPicked(b) ? 0 : 1;
            if (am !== bm) return am - bm;
            return (a.name || '').localeCompare(b.name || '');
        });

    // Mismatch warning: any selected day that's NOT in the template's
    // daysOfWeek (when template explicitly tags days). Surfaces in the
    // apply button + a yellow banner so manager knows what's off-pattern.
    const mismatchDates = useMemo(() => {
        if (!pickedTemplate) return [];
        const tplDays = Array.isArray(pickedTemplate.daysOfWeek) ? pickedTemplate.daysOfWeek : [];
        if (tplDays.length === 0) return [];
        return weekDays.filter(wd => pickedDates.has(wd.dateStr) && !tplDays.includes(wd.dayId));
    }, [pickedTemplate, pickedDates, weekDays]);

    const handleApplyClick = () => {
        if (!pickedTemplate) return;
        const dateStrs = Array.from(pickedDates);
        if (dateStrs.length === 0) return;
        if (mismatchDates.length > 0) {
            const dayNames = mismatchDates.map(m => m.dayLabel).join(', ');
            const tplDays = (pickedTemplate.daysOfWeek || [])
                .map(d => (isEn ? DAYS_EN : DAYS_ES)[DAY_IDS.indexOf(d)] || d)
                .join(', ');
            const msg = tx(
                `"${pickedTemplate.name}" is set up for: ${tplDays}.\n\nApply to ${dayNames} anyway?`,
                `"${pickedTemplate.name}" está configurada para: ${tplDays}.\n\n¿Aplicar a ${dayNames} de todos modos?`,
            );
            if (!confirm(msg)) return;
        }
        onApply(pickedTemplate, dateStrs);
    };
    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-bold text-indigo-700">📋 {tx("Day Templates", "Plantillas del Día")}</h3>
                        <p className="text-xs text-gray-500">{side === "foh" ? "FOH" : "BOH"}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full glass-sheet text-dd-text-2 hover:text-dd-text text-lg">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <button onClick={onCreate}
                        className="w-full py-2 rounded-lg bg-indigo-600 text-white font-bold text-sm">+ {tx("New template", "Nueva plantilla")}</button>
                    {filtered.length === 0 ? (
                        <p className="text-center text-gray-400 text-sm py-6">{tx("No templates yet for this side. Create one above.", "Aún no hay plantillas para este lado. Crea una arriba.")}</p>
                    ) : (
                        <div className="space-y-2">
                            {filtered.map(t => {
                                const totalSlots = (t.blocks || []).reduce((sum, b) => sum + (b.slots || []).reduce((s, sl) => s + (sl.count || 0), 0), 0);
                                const isPicked = pickedTemplate && pickedTemplate.id === t.id;
                                const tDays = Array.isArray(t.daysOfWeek) ? t.daysOfWeek : [];
                                // BUG FIX (2026-05-21, Andrew: "apply a template in
                                // schedule is broken not opening"). Leftover from a
                                // rename — the function was called templateMatchesDay
                                // at some point but is now templateMatchesAnyPicked
                                // (defined just above). The undefined reference threw
                                // inside this map() during render, which unmounted the
                                // entire modal silently → tap "Apply template", nothing
                                // happened. Console would have shown
                                // "templateMatchesDay is not defined".
                                const matchesDay = templateMatchesAnyPicked(t);
                                return (
                                    <div key={t.id} className={`p-2 rounded-lg border-2 transition ${
                                        isPicked
                                            ? "border-indigo-500 bg-indigo-50"
                                            : matchesDay
                                                ? "border-gray-200 bg-white"
                                                : "border-gray-200 bg-white opacity-50"
                                    }`}>
                                        <div className="flex items-center justify-between gap-2">
                                            <button onClick={() => setPickedTemplate(t)} className="flex-1 text-left">
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <span className="font-bold text-sm text-gray-800">{t.name}</span>
                                                    {/* Per-template day chips — only render when the
                                                        template opted in to day tagging. Empty array
                                                        means "any day" so we don't clutter the row. */}
                                                    {tDays.length > 0 && tDays.length < 7 && (
                                                        <span className="inline-flex gap-0.5">
                                                            {tDays.map(dId => (
                                                                <span key={dId}
                                                                    className={`px-1 py-0.5 rounded text-[9px] font-black uppercase tracking-wider ${
                                                                        // Was `pickedDayId === dId` —
                                                                        // pickedDayId never existed; the
                                                                        // canonical state is `pickedDayIds`
                                                                        // (Set of day ids). Same rename
                                                                        // leftover as the matchesDay fix
                                                                        // above. See 2026-05-21 bug note.
                                                                        pickedDayIds.has(dId)
                                                                            ? 'bg-dd-green text-white'
                                                                            : 'bg-indigo-100 text-indigo-700'
                                                                    }`}>
                                                                    {(isEn ? DAYS_EN : DAYS_ES)[DAY_IDS.indexOf(dId)]}
                                                                </span>
                                                            ))}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-[10px] text-gray-500">
                                                    {(t.blocks || []).length} {tx("block(s)", "bloque(s)")} · {totalSlots} {tx("total slots", "slots totales")} · {LOCATION_LABELS[t.location] || t.location}
                                                </div>
                                                {(t.blocks || []).map((b, bi) => (
                                                    <div key={bi} className="text-[10px] text-gray-600 mt-0.5">
                                                        {b.label && <b>{b.label}: </b>}
                                                        {formatTime12h(b.startTime)}–{formatTime12h(b.endTime)} ·{" "}
                                                        {(b.slots || []).map((s, si) => {
                                                            const g = SLOT_ROLE_BY_ID[s.roleGroup || "any"];
                                                            return (
                                                                <span key={si}>
                                                                    {si > 0 && ", "}
                                                                    {s.count} {g ? (isEn ? g.labelEn : g.labelEs) : (s.roleGroup || "?")}
                                                                </span>
                                                            );
                                                        })}
                                                    </div>
                                                ))}
                                            </button>
                                            <div className="flex flex-col gap-1">
                                                <button onClick={() => onEdit(t)} className="px-2 py-0.5 rounded bg-gray-100 text-gray-700 text-[10px] font-bold hover:bg-gray-200">✏️</button>
                                                <button onClick={() => onDelete(t.id)} className="px-2 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold hover:bg-red-200">×</button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    {pickedTemplate && (
                        <div className="border-t border-gray-200 pt-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="text-xs font-bold text-gray-700">
                                    {tx("Apply", "Aplicar")} "{pickedTemplate.name}" {tx("to:", "a:")}
                                </div>
                                <div className="flex gap-1.5">
                                    <button onClick={() => setPickedDates(new Set(weekDays.map(wd => wd.dateStr)))}
                                        className="text-[10px] font-bold text-indigo-700 hover:text-indigo-900">
                                        {tx('All', 'Todos')}
                                    </button>
                                    <span className="text-[10px] text-gray-400">·</span>
                                    <button onClick={() => setPickedDates(new Set())}
                                        className="text-[10px] font-bold text-gray-600 hover:text-gray-900">
                                        {tx('Clear', 'Limpiar')}
                                    </button>
                                </div>
                            </div>
                            {/* 7 day chips for the current week. Each chip
                                shows the day label + date number, and is
                                tappable to toggle on/off. Pre-checked when
                                the picked template has matching daysOfWeek. */}
                            <div className="grid grid-cols-7 gap-1">
                                {weekDays.map(wd => {
                                    const isPicked = pickedDates.has(wd.dateStr);
                                    const tplDays = Array.isArray(pickedTemplate.daysOfWeek) ? pickedTemplate.daysOfWeek : [];
                                    const offPattern = tplDays.length > 0 && !tplDays.includes(wd.dayId);
                                    return (
                                        <button key={wd.dateStr} onClick={() => togglePickedDate(wd.dateStr)}
                                            className={`py-2 rounded-lg border-2 text-center transition active:scale-95 ${
                                                isPicked
                                                    ? (offPattern ? 'bg-amber-100 border-amber-400 text-amber-900' : 'bg-indigo-600 border-indigo-700 text-white')
                                                    : 'bg-white border-gray-200 text-gray-600 hover:border-indigo-300'
                                            }`}>
                                            <div className="text-[10px] font-black uppercase tracking-wider">{wd.dayLabel}</div>
                                            <div className="text-sm font-bold">{wd.dayNum}</div>
                                        </button>
                                    );
                                })}
                            </div>
                            {mismatchDates.length > 0 && (
                                <div className="rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-2 text-[11px] text-amber-900 leading-snug">
                                    ⚠ {tx(
                                        `Template is set up for ${(pickedTemplate.daysOfWeek || []).map(d => (isEn ? DAYS_EN : DAYS_ES)[DAY_IDS.indexOf(d)]).join(', ')}. Yellow days are off-pattern.`,
                                        `La plantilla es para ${(pickedTemplate.daysOfWeek || []).map(d => (isEn ? DAYS_EN : DAYS_ES)[DAY_IDS.indexOf(d)]).join(', ')}. Los días amarillos están fuera de patrón.`,
                                    )}
                                </div>
                            )}
                            <button onClick={handleApplyClick}
                                disabled={pickedDates.size === 0}
                                className={`w-full py-2 rounded-lg font-bold text-sm text-white transition disabled:opacity-40 disabled:cursor-not-allowed ${mismatchDates.length > 0 ? 'bg-amber-600 hover:bg-amber-700' : 'bg-green-600 hover:bg-green-700'}`}>
                                ✓ {pickedDates.size === 0
                                    ? tx('Pick at least one day', 'Elige al menos un día')
                                    : tx(
                                        `Apply to ${pickedDates.size} day${pickedDates.size === 1 ? '' : 's'}`,
                                        `Aplicar a ${pickedDates.size} día${pickedDates.size === 1 ? '' : 's'}`,
                                    )}
                            </button>
                            <p className="text-[10px] text-gray-500 text-center">
                                {tx("Creates one staffing need per role slot per selected day. You fill them next.",
                                    "Crea una necesidad por slot por cada día seleccionado. Las llenas luego.")}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}


// ── RecurringShiftsModal ─────────────────────────────────────────────────
// List existing rules + form to add a new one. Each rule:
//   { staffName, daysOfWeek: ['mon','wed'], startTime, endTime, location,
//     isShiftLead, isDouble, validFrom, validUntil }
// Manager taps "Generate this week" to materialize draft shifts for the
// current viewing week. Generated shifts skip closed dates, PTO, conflicts.
function RecurringShiftsModal({ rules, staffList, storeLocation, side, weekStart, isEn, onSave, onDelete, onGenerateThisWeek, onClose }) {
    const tx = (en, es) => (isEn ? en : es);
    const DAYS = [
        { id: "sun", labelEn: "Sun", labelEs: "Dom" },
        { id: "mon", labelEn: "Mon", labelEs: "Lun" },
        { id: "tue", labelEn: "Tue", labelEs: "Mar" },
        { id: "wed", labelEn: "Wed", labelEs: "Mié" },
        { id: "thu", labelEn: "Thu", labelEs: "Jue" },
        { id: "fri", labelEn: "Fri", labelEs: "Vie" },
        { id: "sat", labelEn: "Sat", labelEs: "Sáb" },
    ];
    const [editing, setEditing] = useState(null); // null | rule object being added/edited
    const startNewRule = () => setEditing({
        staffName: "",
        daysOfWeek: [],
        startTime: "10:00",
        endTime: "15:00",
        location: storeLocation && storeLocation !== "both" ? storeLocation : "webster",
        validFrom: toDateStr(weekStart),
        validUntil: "",
        isShiftLead: false,
        isDouble: false,
        cadence: "weekly", // 'weekly' or 'biweekly' — biweekly anchors off validFrom
    });
    const update = (k, v) => setEditing(r => ({ ...r, [k]: v }));
    const toggleDay = (d) => setEditing(r => ({
        ...r,
        daysOfWeek: r.daysOfWeek.includes(d) ? r.daysOfWeek.filter(x => x !== d) : [...r.daysOfWeek, d],
    }));
    // Quick day-group presets — one tap to fill the days array.
    const setDayGroup = (groupId) => setEditing(r => {
        const groups = {
            all: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
            weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
            weekends: ['sat', 'sun'],
            none: [],
        };
        return { ...r, daysOfWeek: groups[groupId] || [] };
    });
    const dayGroupActive = (groupId) => {
        if (!editing) return false;
        const cur = new Set(editing.daysOfWeek || []);
        if (groupId === 'all') return cur.size === 7;
        if (groupId === 'weekdays') return cur.size === 5 && ['mon','tue','wed','thu','fri'].every(d => cur.has(d));
        if (groupId === 'weekends') return cur.size === 2 && cur.has('sat') && cur.has('sun');
        return false;
    };
    // DD Mau time presets for recurring rules — same vocabulary as Add Shift.
    // "All day" = 10–8 with isDouble = true (1h unpaid break per M2 L2 policy).
    const TIME_PRESETS = [
        { label: 'All day (10–8)', start: '10:00', end: '20:00', isDouble: true },
        { label: '10–3', start: '10:00', end: '15:00', isDouble: false },
        { label: '3–8',  start: '15:00', end: '20:00', isDouble: false },
        { label: '4–8',  start: '16:00', end: '20:00', isDouble: false },
        { label: '12–7', start: '12:00', end: '19:00', isDouble: false },
    ];
    const isTimePresetActive = (p) => editing && editing.startTime === p.start && editing.endTime === p.end && !!editing.isDouble === !!p.isDouble;
    const applyTimePreset = (p) => setEditing(r => ({ ...r, startTime: p.start, endTime: p.end, isDouble: !!p.isDouble }));
    const canSave = editing && editing.staffName && editing.daysOfWeek.length > 0 && editing.startTime && editing.endTime && editing.startTime < editing.endTime;
    const sortedStaff = [...(staffList || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="glass-sheet w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-cyan-700">🔁 {tx("Recurring Shifts", "Turnos Recurrentes")}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full glass-sheet text-dd-text-2 hover:text-dd-text text-lg">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <div className="text-xs text-gray-600 bg-cyan-50 rounded-lg p-2 border border-cyan-200">
                        {tx("Define rules like \"Maria works Mon/Wed 9–3 every week\". Tap Generate to create DRAFT shifts for the current week (skipping closed dates, PTO, and existing conflicts).", "Define reglas como \"Maria trabaja Lun/Mié 9–3 cada semana\". Toca Generar para crear turnos BORRADOR para la semana actual.")}
                    </div>
                    <div className="flex gap-2">
                        <button onClick={startNewRule} className="flex-1 py-2 rounded-lg bg-cyan-600 text-white font-bold text-sm">+ {tx("New rule", "Nueva regla")}</button>
                        <button onClick={onGenerateThisWeek} className="flex-1 py-2 rounded-lg bg-green-600 text-white font-bold text-sm">⚡ {tx("Generate this week", "Generar esta semana")}</button>
                    </div>
                    {editing && (
                        <div className="border-2 border-cyan-300 rounded-lg p-3 space-y-2 bg-cyan-50">
                            <div className="text-xs font-bold text-cyan-800">{editing.id ? tx("Edit rule", "Editar regla") : tx("New rule", "Nueva regla")}</div>
                            <select value={editing.staffName} onChange={e => update("staffName", e.target.value)}
                                className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition">
                                <option value="">{tx("— Staff —", "— Personal —")}</option>
                                {sortedStaff.map(s => <option key={s.id || s.name} value={s.name}>{s.name} ({s.role || "?"})</option>)}
                            </select>
                            <div>
                                <label className="text-[10px] font-bold text-gray-600 block mb-1">{tx("Days of week", "Días de la semana")}</label>
                                {/* Quick day-group buttons */}
                                <div className="grid grid-cols-4 gap-1 mb-1">
                                    <button onClick={() => setDayGroup('all')}
                                        className={`py-1.5 rounded text-[10px] font-bold border ${dayGroupActive('all') ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-700 border-gray-300 hover:border-cyan-400"}`}>
                                        {tx("Every day", "Todos los días")}
                                    </button>
                                    <button onClick={() => setDayGroup('weekdays')}
                                        className={`py-1.5 rounded text-[10px] font-bold border ${dayGroupActive('weekdays') ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-700 border-gray-300 hover:border-cyan-400"}`}>
                                        {tx("Weekdays", "Lun–Vie")}
                                    </button>
                                    <button onClick={() => setDayGroup('weekends')}
                                        className={`py-1.5 rounded text-[10px] font-bold border ${dayGroupActive('weekends') ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-700 border-gray-300 hover:border-cyan-400"}`}>
                                        {tx("Weekends", "Sáb–Dom")}
                                    </button>
                                    <button onClick={() => setDayGroup('none')}
                                        className="py-1.5 rounded text-[10px] font-bold border bg-white text-gray-500 border-gray-300 hover:border-red-400">
                                        {tx("Clear", "Limpiar")}
                                    </button>
                                </div>
                                <div className="grid grid-cols-7 gap-1">
                                    {DAYS.map(d => (
                                        <button key={d.id} onClick={() => toggleDay(d.id)}
                                            className={`py-1.5 rounded text-[10px] font-bold border ${editing.daysOfWeek.includes(d.id) ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-600 border-gray-300"}`}>
                                            {tx(d.labelEn, d.labelEs)}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {/* Cadence — every week or every other week. Bi-weekly anchors off validFrom. */}
                            <div>
                                <label className="text-[10px] font-bold text-gray-600 block mb-1">{tx("Repeat", "Repetir")}</label>
                                <div className="grid grid-cols-2 gap-1">
                                    <button onClick={() => update("cadence", "weekly")}
                                        className={`py-1.5 rounded text-[10px] font-bold border ${(editing.cadence || "weekly") === "weekly" ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-700 border-gray-300"}`}>
                                        🔁 {tx("Every week", "Cada semana")}
                                    </button>
                                    <button onClick={() => update("cadence", "biweekly")}
                                        className={`py-1.5 rounded text-[10px] font-bold border ${editing.cadence === "biweekly" ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-700 border-gray-300"}`}>
                                        🔂 {tx("Every other week", "Quincenal")}
                                    </button>
                                </div>
                                {editing.cadence === "biweekly" && (
                                    <p className="text-[10px] text-cyan-700 mt-1">
                                        ⓘ {tx(`Active starting the week of ${editing.validFrom || "—"}, then every 2 weeks.`,
                                              `Activa desde la semana de ${editing.validFrom || "—"}, luego cada 2 semanas.`)}
                                    </p>
                                )}
                            </div>
                            {/* Time presets — same DD Mau set as Add Shift */}
                            <div>
                                <label className="text-[10px] font-bold text-gray-600 block mb-1">{tx("Quick presets", "Presets rápidos")}</label>
                                <div className="flex flex-wrap gap-1">
                                    {TIME_PRESETS.map(p => (
                                        <button key={p.label} type="button"
                                            onClick={() => applyTimePreset(p)}
                                            className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                                isTimePresetActive(p)
                                                    ? 'bg-cyan-600 text-white border-cyan-600'
                                                    : 'bg-white text-gray-700 border-gray-300 hover:border-cyan-400'
                                            }`}>
                                            {p.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[10px] text-gray-500 block">{tx("From", "Desde")}</label>
                                    <input type="time" value={editing.startTime} onChange={e => update("startTime", e.target.value)}
                                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                                </div>
                                <div>
                                    <label className="text-[10px] text-gray-500 block">{tx("To", "Hasta")}</label>
                                    <input type="time" value={editing.endTime} onChange={e => update("endTime", e.target.value)}
                                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                                </div>
                            </div>
                            {/* Double-shift toggle — exposed because "All day" preset depends on it */}
                            <div className="flex items-center justify-between bg-white rounded p-2 border border-gray-200">
                                <div>
                                    <div className="text-[11px] font-bold text-gray-700">{tx("Double shift (1h unpaid break)", "Turno doble (1h descanso)")}</div>
                                </div>
                                <button onClick={() => update("isDouble", !editing.isDouble)}
                                    className={`w-10 h-5 rounded-full relative transition ${editing.isDouble ? "bg-blue-600" : "bg-gray-300"}`}>
                                    <div className={`w-4 h-4 bg-white rounded-full shadow absolute top-0.5 transition ${editing.isDouble ? "translate-x-5" : "translate-x-0.5"}`} />
                                </button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="text-[10px] text-gray-500 block">{tx("Valid from", "Válido desde")}</label>
                                    <input type="date" value={editing.validFrom || ""} onChange={e => update("validFrom", e.target.value)}
                                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                                </div>
                                <div>
                                    <label className="text-[10px] text-gray-500 block">{tx("Valid until (optional)", "Válido hasta (opcional)")}</label>
                                    <input type="date" value={editing.validUntil || ""} onChange={e => update("validUntil", e.target.value)}
                                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                                </div>
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-500 block">{tx("Location", "Ubicación")}</label>
                                <select value={editing.location} onChange={e => update("location", e.target.value)}
                                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm">
                                    <option value="webster">{LOCATION_LABELS.webster}</option>
                                    <option value="maryland">{LOCATION_LABELS.maryland}</option>
                                </select>
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => setEditing(null)} className="flex-1 py-2 rounded-lg glass-button-apple text-dd-text-2 font-bold text-sm">{tx("Cancel", "Cancelar")}</button>
                                <button onClick={() => canSave && onSave(editing).then(() => setEditing(null))} disabled={!canSave}
                                    className={`flex-1 py-2 rounded-lg font-bold text-white text-sm ${canSave ? "bg-cyan-600" : "bg-gray-300"}`}>
                                    {tx("Save", "Guardar")}
                                </button>
                            </div>
                        </div>
                    )}
                    {rules.length === 0 ? (
                        <p className="text-center text-gray-400 text-sm py-6">{tx("No recurring rules yet.", "Aún no hay reglas recurrentes.")}</p>
                    ) : (
                        <div className="space-y-1">
                            {rules.map(r => (
                                <div key={r.id} className="p-2 rounded border border-gray-200 bg-white text-xs flex items-center justify-between gap-2">
                                    <div className="flex-1 min-w-0">
                                        <div className="font-bold text-gray-800">
                                            {r.staffName}
                                            {r.cadence === "biweekly" && (
                                                <span className="ml-1 text-[9px] font-bold px-1 py-0.5 rounded bg-purple-100 text-purple-700">🔂 {tx("Bi-weekly", "Quincenal")}</span>
                                            )}
                                            {r.isDouble && (
                                                <span className="ml-1 text-[9px] font-bold px-1 py-0.5 rounded bg-blue-100 text-blue-700">⏱ {tx("Double", "Doble")}</span>
                                            )}
                                        </div>
                                        <div className="text-[10px] text-gray-600">
                                            {(r.daysOfWeek || []).map(d => DAYS.find(x => x.id === d)).filter(Boolean).map(d => isEn ? d.labelEn : d.labelEs).join(", ")}
                                            {" · "}{formatTime12h(r.startTime)}–{formatTime12h(r.endTime)}
                                            {" · "}{LOCATION_LABELS[r.location] || r.location}
                                            {r.validUntil && ` · ${tx("until", "hasta")} ${r.validUntil}`}
                                        </div>
                                    </div>
                                    <button onClick={() => setEditing(r)} className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-bold">✏️</button>
                                    <button onClick={() => onDelete(r.id)} className="px-2 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold">×</button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div className="border-t border-gray-200 p-3">
                    <button onClick={onClose} className="w-full py-2 rounded-lg glass-button-apple text-dd-text-2 font-bold">{tx("Done", "Listo")}</button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
