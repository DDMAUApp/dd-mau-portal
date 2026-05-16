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
import { useState, useEffect, useMemo, useRef } from 'react';
import { db } from '../firebase';
import { toast, undoToast } from '../toast';
import {
    collection, doc, onSnapshot, query, where, addDoc, deleteDoc, updateDoc,
    setDoc, serverTimestamp, writeBatch, runTransaction,
} from 'firebase/firestore';
import { canEditSchedule, isAdmin, LOCATION_LABELS, isOnScheduleAt } from '../data/staff';
import { notifyAdmins } from '../data/notify';
import { enableFcmPush } from '../messaging';
import { DAYPARTS, DOW_EN, DOW_ES, aggregateSplh, scheduledHoursByDayPart, fmtUSD, splhTone, variance } from '../data/splh';

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

// ── Component ──────────────────────────────────────────────────────────────

export default function Schedule({ staffName, language, storeLocation, staffList, setStaffList }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);

    const [shifts, setShifts] = useState([]);
    const [loading, setLoading] = useState(true);
    // Default view mode: 'day' on mobile (the week-grid is too wide to read
    // comfortably on a phone — staff end up pinch-zooming and scrolling
    // horizontally), 'grid' on tablet/desktop where there's room. Detected
    // once at mount; the user can switch via the segmented control any time.
    const [viewMode, setViewMode] = useState(() => {
        if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) return 'day';
        return 'grid';
    });
    const [side, setSide] = useState('foh'); // 'foh' | 'boh'
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
    const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
    const [selectedDayIdx, setSelectedDayIdx] = useState(() => (new Date().getDay() - WEEK_START_DOW + 7) % 7);
    const [showAddModal, setShowAddModal] = useState(false);
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
    // Time-off entries (Phase 2: admin-entered on behalf of staff. Phase 3: staff self-serve).
    const [timeOff, setTimeOff] = useState([]);
    const [showTimeOffModal, setShowTimeOffModal] = useState(false);
    // Auto-populate modal
    const [showAutoFillModal, setShowAutoFillModal] = useState(false);
    // Phase 3: staff self-serve PTO request modal + my-availability modal
    const [showPtoRequestModal, setShowPtoRequestModal] = useState(false);
    const [showMyAvailModal, setShowMyAvailModal] = useState(false);
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
        window.addEventListener('resize', recompute);
        window.addEventListener('scroll', recompute, true);
        return () => {
            window.removeEventListener('resize', recompute);
            window.removeEventListener('scroll', recompute, true);
        };
    }, [showMoreActions]);
    // Staffing-needs (a.k.a. shift slots) — manager-defined "we need N people in this time block"
    // Each filled slot becomes a real shift.
    const [staffingNeeds, setStaffingNeeds] = useState([]);
    const [showNeedModal, setShowNeedModal] = useState(false);
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
    const [notifications, setNotifications] = useState([]);
    // SPLH historical data — last 28 days of laborHistory_{location} feeds
    // the per-daypart staffing advisor that sits above the weekly grid.
    // Same shape used by LaborDashboard; helpers in src/data/splh.js.
    const [splhHistory, setSplhHistory] = useState([]);
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
                    setShifts(cached.items);
                    setLoading(false);
                    hadCache = true;
                }
            }
        } catch { /* storage broken — fall through to live query */ }
        if (!hadCache) setLoading(true);

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
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify({ items, savedAt: Date.now() }));
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
    useEffect(() => {
        const q = query(collection(db, 'time_off'), where('startDate', '>=', sixMonthsAgo));
        const unsub = onSnapshot(q, (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setTimeOff(items);
        }, (err) => console.error('time_off snapshot error:', err));
        return unsub;
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
    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'schedule_templates'), (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setScheduleTemplates(items);
        }, (err) => console.error('schedule_templates snapshot error:', err));
        return unsub;
    }, []);

    // ── SPLH historical pull (last 28 days of laborHistory_{location}) ──
    // Powers the Schedule SPLH advisor — same data source as Labor Dashboard.
    //
    // 2026-05-15 perf — biggest single contributor to Schedule load time.
    // laborHistory_{location} has 18-20k docs total across a year; 28 days
    // filtered is ~1,500 docs. Each cold mount pulls all 1,500 over the
    // wire, parses, and runs aggregateSplh() on them. localStorage cache
    // with 30-min TTL skips the round-trip on repeat mounts (week
    // navigation, tab return, deploy reload). Historical aggregation
    // tolerates 30-min staleness fine — the data is used for forecasting
    // typical-week patterns, not real-time anything.
    useEffect(() => {
        const queryLoc = storeLocation === 'both' ? 'webster' : storeLocation;
        const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
        const cutoffKey = cutoff.getFullYear() + '-' + String(cutoff.getMonth() + 1).padStart(2, '0') + '-' + String(cutoff.getDate()).padStart(2, '0');
        const CACHE_KEY = `ddmau:splh:${queryLoc}`;
        const CACHE_TTL_MS = 30 * 60 * 1000;
        // Hydrate from cache first — skip waiting on the live query when
        // we have something fresh enough to forecast with.
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (raw) {
                const cached = JSON.parse(raw);
                if (cached?.savedAt && (Date.now() - cached.savedAt) < CACHE_TTL_MS && Array.isArray(cached.items)) {
                    setSplhHistory(cached.items);
                    // Don't return — still fire the live listener in the
                    // background so the cache stays warm. The setSplhHistory
                    // above is the "fast path" for perceived speed; the
                    // listener result will overwrite it with the same-or-
                    // fresher data once Firestore answers.
                }
            }
        } catch { /* fall through */ }
        const unsub = onSnapshot(
            query(collection(db, 'laborHistory_' + queryLoc), where('date', '>=', cutoffKey)),
            (snap) => {
                const arr = [];
                snap.forEach(d => arr.push(d.data()));
                setSplhHistory(arr);
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify({ items: arr, savedAt: Date.now() }));
                } catch { /* storage full — non-fatal */ }
            },
            (err) => console.warn('SPLH history snapshot error:', err)
        );
        return () => unsub();
    }, [storeLocation]);

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
    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'recurring_shifts'), (snap) => {
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
    const seenNotifIds = useMemo(() => new Set(), [staffName]);
    useEffect(() => {
        if (!staffName) return;
        const q = query(collection(db, 'notifications'), where('forStaff', '==', staffName));
        const unsub = onSnapshot(q, (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            items.sort((a, b) => {
                const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
                const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
                return bt - at;
            });
            setNotifications(items);
            // Foreground browser-notification fire for fresh unread items
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                const cutoff = Date.now() - 30 * 1000;
                for (const n of items) {
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
            }
        }, (err) => console.error('notifications snapshot error:', err));
        return unsub;
    }, [staffName, seenNotifIds]);

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
        try {
            await addDoc(collection(db, 'notifications'), {
                forStaff, type,
                title: resolveText(title, recipient),
                body: resolveText(body, recipient),
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
            const start = t.startDate || t.date;
            const end = t.endDate || t.date;
            return dateStr >= start && dateStr <= end;
        });
    };

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

    const dateClosed = (dateStr) => (blocksByDate.get(dateStr) || []).some(b => b.type === 'closed');

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
                return { ...s, totalHours, shiftCount: sideShiftCount };
            })
            .sort((a, b) => {
                if ((b.shiftCount > 0) !== (a.shiftCount > 0)) return b.shiftCount - a.shiftCount;
                return a.name.localeCompare(b.name);
            });
    }, [sideStaff, viewerShifts, visibleShifts, storeLocation]);

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
            await addDoc(collection(db, 'shifts'), {
                ...shiftData,
                published: false, // draft — manager hits Publish to release
                createdBy: staffName,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            });
            setShowAddModal(false);
            setAddPrefill(null);

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
            notifyAdmins({
                type: 'shift_deleted_admin',
                title: { en: '🗑 Shift deleted', es: '🗑 Turno eliminado' },
                body: { en: `${sh.staffName || 'Unassigned'} • ${detail} • by ${staffName}`,
                        es: `${sh.staffName || 'Sin asignar'} • ${detail} • por ${staffName}` },
                link: '/schedule',
                tag: `shift_deleted:${shiftId}`,
                createdBy: staffName,
                excludeStaff: staffName,
            }).catch(() => {});
        };
        if (opts.immediate) {
            try {
                await deleteDoc(doc(db, 'shifts', shiftId));
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
                updatedAt: serverTimestamp(),
                updatedBy: staffName,
            });
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
        // Refuse to drop on a closed date.
        if (dateClosed(newDate)) {
            toast(tx('Cannot drop on a closed date.', 'No puedes soltar en una fecha cerrada.'));
            return;
        }
        // Refuse to drop on a staffer's PTO date.
        if (isStaffOffOn(newStaffName, newDate)) {
            toast(tx(`${newStaffName} is on approved time-off that date.`, `${newStaffName} tiene tiempo libre aprobado esa fecha.`));
            return;
        }
        const wasPublished = shift.published !== false;
        const oldStaff = shift.staffName;
        const oldDate = shift.date;
        const detail = `${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)}`;
        try {
            await updateDoc(doc(db, 'shifts', shiftId), {
                staffName: newStaffName,
                date: newDate,
                updatedAt: serverTimestamp(),
            });
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
    const handleOfferShift = async (shift) => {
        const ok = confirm(tx(
            `⚠ This shift on ${shift.date} from ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} is YOUR responsibility until someone takes it. You'll be notified when a manager approves the takeover. Confirm offer?`,
            `⚠ Este turno el ${shift.date} de ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} es TU responsabilidad hasta que alguien lo tome. Te notificaremos cuando un gerente apruebe el cambio. ¿Confirmar oferta?`,
        ));
        if (!ok) return;
        try {
            await updateDoc(doc(db, 'shifts', shift.id), {
                offerStatus: 'open',
                offeredBy: staffName,
                offeredAt: serverTimestamp(),
                pendingClaimBy: null,
                claimedAt: null,
                updatedAt: serverTimestamp(),
            });
        } catch (e) {
            console.error('Offer shift failed:', e);
            toast(tx('Could not offer shift: ', 'No se pudo ofrecer: ') + e.message);
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
        clearSelection();
        undoToast(
            tx(`🗑 Deleted ${snapshot.length} shifts`, `🗑 Eliminados ${snapshot.length} turnos`),
            async () => {
                for (const sh of snapshot) {
                    try { await deleteDoc(doc(db, 'shifts', sh.id)); }
                    catch (e) { console.warn('bulk-delete failed for', sh.id, e); }
                }
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
                        { allowSelf: true, tagSuffix: `bulk:${Date.now()}` }
                    ).catch(() => {});
                }
                // Admin summary — single roll-up so other managers know a
                // bulk delete just happened. Only counts PUBLISHED shifts;
                // pure draft cleanups are silent (no admin push, no staff
                // push) — drafts haven't been released so co-managers don't
                // need a ping.
                const pubCount = snapshot.filter(s => s.published !== false).length;
                if (pubCount > 0) {
                    notifyAdmins({
                        type: 'shift_deleted_admin',
                        title: { en: `🗑 Bulk delete: ${pubCount} shift${pubCount === 1 ? '' : 's'}`,
                                 es: `🗑 Eliminación masiva: ${pubCount} turno${pubCount === 1 ? '' : 's'}` },
                        body: { en: `Published shifts removed • by ${staffName}`,
                                es: `Turnos publicados eliminados • por ${staffName}` },
                        link: '/schedule',
                        tag: `bulk_delete:${Date.now()}`,
                        createdBy: staffName,
                        excludeStaff: staffName,
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
        let okCount = 0, failCount = 0;
        for (const sh of candidates) {
            try {
                await updateDoc(doc(db, 'shifts', sh.id), {
                    offerStatus: 'open',
                    offeredBy: staffName,
                    offeredAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
                okCount += 1;
            } catch (e) {
                console.warn('bulk-offer failed for', sh.id, e);
                failCount += 1;
            }
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
                pendingClaimBy: null,
                claimedAt: null,
                updatedAt: serverTimestamp(),
            });
        } catch (e) {
            console.error('Cancel offer failed:', e);
        }
    };

    // Race-safe shift take. Two staff hitting "Take" within the same snapshot
    // tick used to BOTH succeed locally (each updateDoc would overwrite the
    // other's pendingClaimBy). The transaction reads the live shift, refuses
    // if it's not still 'open', and writes atomically — first writer wins,
    // second gets a clear error.
    const handleTakeShift = async (shift) => {
        const ok = confirm(tx(
            `✅ This shift on ${shift.date} from ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} is now YOUR responsibility (pending manager approval). Confirm?`,
            `✅ Este turno el ${shift.date} de ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} ahora es TU responsabilidad (pendiente de aprobación del gerente). ¿Confirmar?`,
        ));
        if (!ok) return;
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
                    updatedAt: serverTimestamp(),
                });
            });
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
                detail = `${live.date} ${formatTime12h(live.startTime)}–${formatTime12h(live.endTime)}`;
                txn.update(ref, {
                    staffName: live.pendingClaimBy, // use live value, not stale snapshot
                    offerStatus: null,
                    offeredBy: null,
                    offeredAt: null,
                    pendingClaimBy: null,
                    claimedAt: null,
                    approvedBy: staffName,
                    approvedAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
            });
            // Notifications outside the transaction — they hit a different
            // collection and shouldn't roll back the swap if push fails.
            await notify(oldOwner, 'swap_approved',
                { en: 'Swap approved', es: 'Cambio aprobado' },
                { en: `Your shift on ${detail} is now ${newOwner}'s.`,
                  es: `Tu turno del ${detail} ahora es de ${newOwner}.` });
            await notify(newOwner, 'swap_approved',
                { en: 'Shift assigned', es: 'Turno asignado' },
                { en: `The shift on ${detail} is now yours.`,
                  es: `El turno del ${detail} ahora es tuyo.` });
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
    const handleAddNeed = async (need) => {
        if (!canEditSide(need?.side)) return;
        try {
            await addDoc(collection(db, 'staffing_needs'), {
                ...need,
                filledStaff: [],
                filledShiftIds: [],
                createdBy: staffName,
                createdAt: serverTimestamp(),
            });
            setShowNeedModal(false);
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
            await updateDoc(doc(db, 'staffing_needs', id), {
                ...data,
                updatedAt: serverTimestamp(),
                updatedBy: staffName,
            });
            setEditingNeed(null);
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
            const newFilledStaff = [...(need.filledStaff || []), staffMember.name];
            const newFilledShiftIds = [...(need.filledShiftIds || []), shiftRef.id];
            await updateDoc(doc(db, 'staffing_needs', need.id), {
                filledStaff: newFilledStaff,
                filledShiftIds: newFilledShiftIds,
            });
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
            // Outer loop is per-date so a failure on one day doesn't block
            // the other days — we collect failures and toast a partial-
            // success summary at the end.
            for (const dateStr of dateStrs) {
                try {
                    for (const block of (tpl.blocks || [])) {
                        for (const slot of (block.slots || [])) {
                            if (!slot.count || slot.count <= 0) continue;
                            await addDoc(collection(db, 'staffing_needs'), {
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
                    successes.push(dateStr);
                } catch (perDateErr) {
                    console.error('Apply template per-date failed:', dateStr, perDateErr);
                    failures.push(dateStr);
                }
            }
            setShowApplyTemplate(false);
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
                const weeksSince = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
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
                if (dateClosed(dStr)) { skipped.push(`${rule.staffName} ${dStr}: closed`); continue; }
                if (isStaffOffOn(rule.staffName, dStr)) { skipped.push(`${rule.staffName} ${dStr}: PTO`); continue; }
                // Don't double-book: any existing shift overlapping this time block
                const conflict = shifts.some(sh =>
                    sh.staffName === rule.staffName && sh.date === dStr &&
                    !(sh.endTime <= rule.startTime || sh.startTime >= rule.endTime));
                if (conflict) { skipped.push(`${rule.staffName} ${dStr}: existing shift`); continue; }
                try {
                    await addDoc(collection(db, 'shifts'), {
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
                } catch (e) {
                    console.error('Recurring shift create failed:', e);
                }
            }
        }
        if (created.length === 0) {
            toast(tx(`No shifts generated.${skipped.length ? '\n\nSkipped:\n' + skipped.slice(0, 8).join('\n') : ''}`,
                `No se generaron turnos.${skipped.length ? '\n\nOmitidos:\n' + skipped.slice(0, 8).join('\n') : ''}`));
        } else {
            toast(tx(`✅ Generated ${created.length} draft shifts.${skipped.length ? `\n\nSkipped ${skipped.length}.` : ''}`,
                `✅ Se generaron ${created.length} turnos borrador.${skipped.length ? `\n\nOmitidos ${skipped.length}.` : ''}`));
        }
    };

    // ── Date blocks (closed days / no-time-off days) ───────────────────────
    const handleAddBlock = async (block) => {
        if (!canEdit) return;
        try {
            await addDoc(collection(db, 'date_blocks'), {
                ...block,
                createdBy: staffName,
                createdAt: serverTimestamp(),
            });
            setShowBlockModal(false);
        } catch (e) {
            console.error('Add block failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    const handleRemoveBlock = async (blockId) => {
        if (!canEdit) return;
        if (!confirm(tx('Remove this date block?', '¿Quitar este bloqueo?'))) return;
        try {
            await deleteDoc(doc(db, 'date_blocks', blockId));
        } catch (e) {
            console.error('Remove block failed:', e);
        }
    };

    // ── Time-off (Phase 2: admin-entered) ──
    const handleAddTimeOff = async (entry) => {
        if (!canEdit) return;
        try {
            await addDoc(collection(db, 'time_off'), {
                ...entry,
                status: 'approved', // admin-entered = pre-approved
                createdBy: staffName,
                createdAt: serverTimestamp(),
            });
            setShowTimeOffModal(false);
        } catch (e) {
            console.error('Add time-off failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    const handleRemoveTimeOff = async (id) => {
        if (!canEdit) return;
        if (!confirm(tx('Remove this time-off?', '¿Quitar este tiempo libre?'))) return;
        try {
            await deleteDoc(doc(db, 'time_off', id));
        } catch (e) {
            console.error('Remove time-off failed:', e);
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
        // Status-aware confirm copy. Pending is one-tap (low stakes).
        // Approved gets an explicit confirm because withdrawing it
        // could leave gaps the manager needs to re-fill.
        if (status === 'approved') {
            if (!confirm(tx(
                'Withdraw this approved time-off? Your manager will be notified so they can re-schedule you.',
                '¿Retirar este tiempo libre aprobado? Tu gerente será notificado para poder volver a programarte.'
            ))) return;
        } else if (status === 'pending') {
            if (!confirm(tx('Cancel this pending request?', '¿Cancelar esta solicitud pendiente?'))) return;
        } // denied = no confirm, just dismiss
        try {
            await deleteDoc(doc(db, 'time_off', entry.id));
            // Approved withdraws notify admins. Pending cancels stay
            // silent — the original "pto_request" notification's tag
            // (pto_request:<id>) collapses naturally when clicked since
            // the doc is gone.
            if (status === 'approved') {
                try {
                    const dates = entry.startDate === entry.endDate
                        ? entry.startDate
                        : `${entry.startDate} → ${entry.endDate || entry.startDate}`;
                    await notifyAdmins({
                        type: 'pto_withdrawn',
                        title: `↩ PTO withdrawn: ${staffName}`,
                        body: `${dates}${entry.reason ? ` · ${entry.reason}` : ''} · ${tx('they can now be scheduled', 'pueden ser programados')}`,
                        link: '/schedule',
                        tag: `pto_withdrawn:${entry.id}`,
                        createdBy: staffName || 'staff',
                        excludeStaff: staffName,
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
            setShowPtoRequestModal(false);
            toast(tx('✅ Request submitted. A manager will review it.', '✅ Solicitud enviada. Un gerente la revisará.'));
            // Ping admins so they actually know to go review it. Tag
            // includes the request doc id so a resubmit (which would
            // be a new doc) gets its own slot; same-request retries
            // collapse via tag.
            try {
                const dates = entry.startDate === entry.endDate
                    ? entry.startDate
                    : `${entry.startDate} → ${entry.endDate}`;
                await notifyAdmins({
                    type: 'pto_request',
                    title: `🌴 PTO request: ${staffName}`,
                    body: `${dates}${entry.reason ? ` · ${entry.reason}` : ''}`,
                    link: '/schedule',
                    tag: `pto_request:${ref.id}`,
                    createdBy: staffName || 'staff',
                    excludeStaff: staffName,
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
        // Conflict-detection: warn if approving leaves published shifts orphaned.
        const start = entry.startDate || entry.date;
        const end = entry.endDate || entry.date;
        const conflicts = shifts.filter(sh =>
            sh.staffName === entry.staffName && sh.published !== false &&
            sh.date >= start && sh.date <= end);
        if (conflicts.length > 0) {
            const lines = conflicts.slice(0, 8).map(sh =>
                `  · ${sh.date} ${formatTime12h(sh.startTime)}–${formatTime12h(sh.endTime)}${sh.location ? ` · ${LOCATION_LABELS[sh.location] || sh.location}` : ''}`
            ).join('\n');
            const more = conflicts.length > 8 ? `\n  · ${tx(`...and ${conflicts.length - 8} more`, `...y ${conflicts.length - 8} más`)}` : '';
            const ok = confirm(tx(
                `⚠️ Approving this PTO will leave ${conflicts.length} published shift(s) UNCOVERED:\n\n${lines}${more}\n\nApprove anyway? (You'll need to reassign these shifts.)`,
                `⚠️ Aprobar este tiempo libre dejará ${conflicts.length} turno(s) publicado(s) SIN CUBRIR:\n\n${lines}${more}\n\n¿Aprobar de todas formas?`,
            ));
            if (!ok) return;
        }
        try {
            await updateDoc(doc(db, 'time_off', entry.id), {
                status: 'approved',
                reviewedBy: staffName,
                reviewedAt: serverTimestamp(),
            });
            const range = start + (end !== start ? ` → ${end}` : '');
            await notify(entry.staffName, 'pto_approved',
                { en: 'Time-off approved', es: 'Tiempo libre aprobado' },
                { en: `Your time-off for ${range} was approved.`,
                  es: `Tu tiempo libre del ${range} fue aprobado.` });
        } catch (e) {
            console.error('Approve PTO failed:', e);
        }
    };
    const handleDenyPto = async (entry) => {
        if (!canEdit) return;
        try {
            await updateDoc(doc(db, 'time_off', entry.id), {
                status: 'denied',
                reviewedBy: staffName,
                reviewedAt: serverTimestamp(),
            });
            const range = entry.startDate + (entry.endDate && entry.endDate !== entry.startDate ? ` → ${entry.endDate}` : '');
            await notify(entry.staffName, 'pto_denied',
                { en: 'Time-off denied', es: 'Tiempo libre negado' },
                { en: `Your time-off for ${range} was denied.`,
                  es: `Tu tiempo libre del ${range} fue negado.` });
        } catch (e) {
            console.error('Deny PTO failed:', e);
        }
    };

    // ── Phase 3: staff self-serve availability ──
    // Lifts the same pattern from AdminPanel: read-modify-write the staff list.
    const handleSaveMyAvailability = async (newAvailability) => {
        if (!staffList || !setStaffList) return;
        const updated = staffList.map(s => s.name === staffName ? { ...s, availability: newAvailability } : s);
        // PIN INTEGRITY GATE — same defense as in AdminPanel. If any staff
        // record in `updated` has a missing/invalid PIN, refuse the save
        // entirely. This blocks the bug pattern that wiped PINs on
        // 2026-05-09: stale React state writing empty/missing PINs back
        // to Firestore.
        const bad = updated.find(s => {
            const p = String(s.pin ?? '').trim();
            return !p || !/^\d{4}$/.test(p);
        });
        if (bad) {
            console.error('Refusing availability save — invalid PIN on:', bad.name, 'pin=', bad.pin);
            toast(tx(`Save blocked: invalid PIN on ${bad.name}. Reload the app and try again.`,
                     `Guardado bloqueado: PIN inválido en ${bad.name}. Recarga la app.`),
                  { kind: 'error', duration: 8000 });
            return;
        }
        setStaffList(updated);
        try {
            await setDoc(doc(db, 'config', 'staff'), { list: updated });
        } catch (e) {
            console.error('Save availability failed:', e);
            toast(tx('Could not save availability: ', 'No se pudo guardar: ') + e.message);
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
            const myShifts = visibleShifts.filter(sh => sh.staffName === personFilter && sh.published !== false);
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
                    return `<div class="shift-row">
                        <span class="time">${escape(formatTime12h(sh.startTime))} – ${escape(formatTime12h(sh.endTime))}</span>
                        <span class="hrs">${escape(formatHours(hrs))}</span>
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
            const w = window.open('', '_blank', 'width=800,height=1000');
            if (!w) { toast(tx('Pop-up blocked.', 'Ventana bloqueada.')); return; }
            w.document.open(); w.document.write(personHtml); w.document.close();
            return;
        }

        // Build cell HTML for each staff/day (escape() is hoisted at top of fn)
        const shiftsByCell = new Map();
        for (const sh of visibleShifts) {
            if (sh.published === false) continue; // skip drafts
            const key = `${sh.staffName}|${sh.date}`;
            if (!shiftsByCell.has(key)) shiftsByCell.set(key, []);
            shiftsByCell.get(key).push(sh);
        }
        const rowsToShow = staffSummary.filter(s => s.shiftCount > 0); // only scheduled

        let bodyRows = '';
        for (const s of rowsToShow) {
            let cells = '';
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
                        // Compact time (10a–3p) keeps the cell to ONE line in
                        // the narrow weekday columns. Hours pill appended on
                        // the same line. Was: 10:00 AM–3:00 PM 5h (wrapped).
                        return `<div class="shift">
                            <b>${escape(compactTime(sh.startTime))}–${escape(compactTime(sh.endTime))}</b>
                            <span class="hrs">${escape(formatHours(hrs))}</span>
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
                    <div class="hours ${hoursClass}">${escape(formatHours(s.totalHours))}</div>
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
    * { box-sizing: border-box; }
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
    .shift { background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 3px; padding: 2px 4px; margin-bottom: 2px; }
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
    <span>Drafts excluded. Closed dates shown in grey. Today highlighted in mint.</span>
    <span>Printed ${new Date().toLocaleString()}</span>
</div>
<script>setTimeout(() => window.print(), 300);</script>
</body></html>`;

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
    const handleExportIcs = () => {
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
            const summary = `${sh.staffName} (${sh.location || ''})${sh.isShiftLead ? ' 🛡️' : ''}${sh.isDouble ? ' ⏱' : ''}`;
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
        const url = URL.createObjectURL(blob);
        const filename = `dd-mau-${side}-${toDateStr(weekStart)}${personFilter ? '-' + personFilter.replace(/\s+/g, '_') : ''}.ics`;
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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
        try {
            const batch = writeBatch(db);
            for (const s of drafts) {
                batch.update(doc(db, 'shifts', s.id), {
                    published: true,
                    publishedBy: staffName,
                    publishedAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                });
            }
            await batch.commit();
            setPublishPreview(null);
            toast(tx(`✅ Published ${drafts.length} shifts.`, `✅ Se publicaron ${drafts.length} turnos.`));
            // Notify each staffer whose shifts were published — one notification per person.
            const byStaff = new Map();
            for (const s of drafts) {
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
            // Admin summary — one roll-up so co-managers see the publish
            // even if it was tiny (e.g. one shift). excludeStaff skips the
            // publisher (they already got the toast).
            const weekStartStr = toDateStr(weekStart);
            notifyAdmins({
                type: 'week_published_admin',
                title: { en: `📢 Schedule published (week of ${weekStartStr})`,
                         es: `📢 Horario publicado (semana del ${weekStartStr})` },
                body: { en: `${drafts.length} shift${drafts.length === 1 ? '' : 's'} • ${byStaff.size} staff • by ${staffName}`,
                        es: `${drafts.length} turno${drafts.length === 1 ? '' : 's'} • ${byStaff.size} persona(s) • por ${staffName}` },
                link: '/schedule',
                tag: `week_published_admin:${weekStartStr}`,
                createdBy: staffName,
                excludeStaff: staffName,
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
            // Read last week directly with a one-shot query (no listener needed).
            const q = query(
                collection(db, 'shifts'),
                where('date', '>=', lastWeekStartStr),
                where('date', '<', lastWeekEndStr),
            );
            const snap = await new Promise((resolve, reject) => {
                const unsub = onSnapshot(q, (s) => { unsub(); resolve(s); }, reject);
            });
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
            // Create new docs with date shifted +7
            for (const sh of filtered) {
                const oldDate = parseLocalDate(sh.date);
                if (!oldDate) continue;
                const newDate = new Date(oldDate);
                newDate.setDate(newDate.getDate() + 7);
                const newDateStr = toDateStr(newDate);
                if (dateClosed(newDateStr)) continue;
                if (isStaffOffOn(sh.staffName, newDateStr)) continue;
                await addDoc(collection(db, 'shifts'), {
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
            toast(tx(`✅ Copied ${filtered.length} shifts as drafts.`, `✅ Se copiaron ${filtered.length} turnos como borradores.`));
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
                if (dateClosed(dStr)) continue;
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
            // Sequential writes — small batch, no need for batched writes.
            for (const sh of created) {
                await addDoc(collection(db, 'shifts'), sh);
            }
            toast(tx(`✅ Auto-filled ${created.length} draft shifts.${skipped.length ? `\n\nSkipped:\n${skipped.slice(0,5).join('\n')}` : ''}`,
                `✅ Se auto-rellenaron ${created.length} turnos borrador.${skipped.length ? `\n\nOmitidos:\n${skipped.slice(0,5).join('\n')}` : ''}`));
            setShowAutoFillModal(false);
        } catch (e) {
            console.error('Auto-fill failed:', e);
            toast(tx('Auto-fill error: ', 'Error de auto-rellenar: ') + e.message);
        }
    };

    const openAddModal = (prefill = null) => {
        setAddPrefill(prefill);
        setShowAddModal(true);
    };

    // ── Render ──
    return (
        <div className="p-4 pb-bottom-nav print:p-2 print:pb-0">
            {/* Inline print stylesheet — keep schedule readable on paper */}
            <style>{`
                @media print {
                    @page { margin: 0.4in; }
                    body { background: white !important; }
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
                    <p className="text-xs text-dd-text-2 mt-0.5">
                        📍 {LOCATION_LABELS[storeLocation] || storeLocation} · {side === 'foh' ? tx('Front of House', 'Front of House') : tx('Back of House', 'Back of House')}
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
                        className="relative p-2 rounded-lg bg-white border border-dd-line hover:bg-dd-bg transition shadow-card">
                        <span className="text-base">🔔</span>
                        <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                            {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                    </button>
                )}
            </div>

            {/* FOH / BOH segmented control — matches the v2 segmented pattern
                from HomeV2's "All/FOH/BOH" filter on upcoming shifts. */}
            <div className="flex gap-1 mb-3 bg-white border border-dd-line rounded-lg p-1 print:hidden">
                <button onClick={() => setSide('foh')}
                    className={`flex-1 py-2 rounded-md text-sm font-bold transition ${side === 'foh' ? 'bg-dd-green text-white shadow-sm' : 'text-dd-text-2 hover:bg-dd-bg'}`}>
                    🪑 {tx('Front of House', 'Front of House')}
                </button>
                <button onClick={() => setSide('boh')}
                    className={`flex-1 py-2 rounded-md text-sm font-bold transition ${side === 'boh' ? 'bg-orange-600 text-white shadow-sm' : 'text-dd-text-2 hover:bg-dd-bg'}`}>
                    🍳 {tx('Back of House', 'Back of House')}
                </button>
            </div>

            {/* Week navigator */}
            <WeekNav weekStart={weekStart} setWeekStart={setWeekStart} isEn={isEn} />

            {/* View mode segmented control */}
            <div className="flex gap-1 mb-3 bg-white border border-dd-line rounded-lg p-1 print:hidden">
                {[
                    { key: 'grid', labelEn: 'Week', labelEs: 'Semana', icon: '⊞' },
                    { key: 'day', labelEn: 'Day', labelEs: 'Día', icon: '☰' },
                    { key: 'list', labelEn: 'List', labelEs: 'Lista', icon: '≡' },
                    { key: 'pto', labelEn: 'Time Off', labelEs: 'Tiempo libre', icon: '🌴' },
                ].map(v => (
                    <button key={v.key} onClick={() => setViewMode(v.key)}
                        className={`flex-1 py-1.5 rounded-md text-xs font-bold transition ${viewMode === v.key ? 'bg-dd-green text-white shadow-sm' : 'text-dd-text-2 hover:bg-dd-bg'}`}>
                        <span className="mr-1">{v.icon}</span>{tx(v.labelEn, v.labelEs)}
                    </button>
                ))}
            </div>

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
                <label className="flex-1 min-w-[180px] flex items-center gap-2 bg-white border border-dd-line rounded-lg px-3 py-1.5 hover:border-dd-green/40 focus-within:border-dd-green focus-within:ring-2 focus-within:ring-dd-green-50 transition cursor-pointer">
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
                            className={`relative inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition shadow-sm ${draftCount > 0 ? 'bg-dd-green text-white hover:bg-dd-green-700 animate-pulse' : 'bg-dd-bg text-dd-text-2 border border-dd-line'}`}>
                            📢 {tx('Publish', 'Publicar')}
                            {draftCount > 0 && (
                                <span className="bg-amber-400 text-amber-950 text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center">
                                    {draftCount}
                                </span>
                            )}
                        </button>
                        <button onClick={() => openAddModal()}
                            className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-dd-green text-white text-xs font-bold hover:bg-dd-green-700 shadow-sm active:scale-95 transition">
                            + {tx('Shift', 'Turno')}
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
                        className="px-4 py-2 rounded-lg bg-white border border-dd-line text-dd-text hover:bg-dd-bg active:scale-95 text-xs font-semibold flex items-center gap-1.5 transition">
                        ⋯ {tx('More', 'Más')}
                        <span className="text-dd-text-2 text-[10px]">{showMoreActions ? '▲' : '▼'}</span>
                    </button>
                    {showMoreActions && (
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
                                internal scroll picks up the rest. */}
                            <div
                                style={{
                                    position: 'fixed',
                                    left: `${moreMenuPos.left}px`,
                                    top: `${moreMenuPos.top}px`,
                                    maxHeight: `${moreMenuMaxH}px`,
                                    maxWidth: 'calc(100vw - 24px)',
                                }}
                                className="w-64 bg-white border border-dd-line rounded-xl shadow-card-hov z-40 overflow-y-auto">
                                {/* TOOLS */}
                                <div className="px-3 py-2 border-b border-dd-line">
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">{tx('Tools', 'Herramientas')}</div>
                                    <button onClick={() => { setShowMoreActions(false); handlePrintWeek(); }}
                                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                        <span>🖨</span>{personFilter ? tx('Print', 'Imprimir') : tx('Print Week', 'Imprimir Semana')}
                                    </button>
                                    <button onClick={() => { setShowMoreActions(false); handleExportIcs(); }}
                                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                        <span>📅</span>{tx('Export iCal', 'Exportar iCal')}
                                    </button>
                                </div>
                                {/* MY ACTIONS */}
                                <div className="px-3 py-2 border-b border-dd-line">
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">{tx('My Actions', 'Mis Acciones')}</div>
                                    <button onClick={() => { setShowMoreActions(false); setShowPtoRequestModal(true); }}
                                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                        <span>🌴</span>{tx('Request Time Off', 'Pedir Tiempo Libre')}
                                    </button>
                                    <button onClick={() => { setShowMoreActions(false); setShowMyAvailModal(true); }}
                                        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                        <span>🗓</span>{tx('My Availability', 'Mi Disponibilidad')}
                                    </button>
                                </div>
                                {/* ADMIN */}
                                {canEdit && (
                                    <div className="px-3 py-2">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">{tx('Admin', 'Admin')}</div>
                                        <button onClick={() => { setShowMoreActions(false); handleAutoPopulate(); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-sage-50 flex items-center gap-2 text-sm text-dd-green-700 font-semibold">
                                            <span>✨</span>{tx('Auto-fill week', 'Auto-rellenar')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); setShowNeedModal(true); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span>👥</span>{tx('Add open slot', 'Agregar espacio')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); setShowTimeOffModal(true); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span>🌴</span>{tx('All Time Off requests', 'Todas las solicitudes')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); handleCopyLastWeek(); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span>📋</span>{tx('Copy last week', 'Copiar semana anterior')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); setShowApplyTemplate(true); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span>📋</span>{tx('Apply template', 'Aplicar plantilla')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); setShowRecurringModal(true); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span>🔁</span>{tx('Recurring shifts', 'Turnos recurrentes')}
                                        </button>
                                        <button onClick={() => { setShowMoreActions(false); setShowBlockModal(true); }}
                                            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-dd-bg flex items-center gap-2 text-sm text-dd-text">
                                            <span>🚫</span>{tx('Blackout dates', 'Bloqueos de fechas')}
                                        </button>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
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
                return (
                    <div className="mb-3 rounded-xl p-2 bg-white border border-dd-line shadow-card">
                        <div className="flex items-center gap-2 mb-1.5">
                            <span className="w-1 h-4 bg-blue-500 rounded-full" />
                            <h3 className="text-xs font-bold text-dd-text">👥 {tx('Open slots', 'Abiertos')}</h3>
                            <span className="text-[10px] font-bold text-dd-text-2">{side === 'foh' ? 'FOH' : 'BOH'} · {weekNeeds.length}</span>
                        </div>
                        <div className="space-y-1">
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
                                                    className="px-1.5 py-0.5 rounded bg-white border border-dd-line text-dd-text-2 text-[10px] hover:bg-dd-bg">✏</button>
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
                onCancelOffer={handleCancelOffer}
                onApprove={handleApproveSwap}
                onDeny={handleDenySwap}
                storeLocation={storeLocation}
                timeOff={viewerTimeOff}
                onApprovePto={handleApprovePto}
                onDenyPto={handleDenyPto}
                onCancelOwnPto={handleCancelOwnPto}
            />

            {loading ? (
                <div className="space-y-3 mt-4">
                    <div className="h-20 bg-white border border-dd-line rounded-xl animate-pulse" />
                    <div className="h-32 bg-white border border-dd-line rounded-xl animate-pulse" />
                    <div className="h-64 bg-white border border-dd-line rounded-xl animate-pulse" />
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
                                onCancelOffer={handleCancelOffer}
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
                                onCancelOffer={handleCancelOffer}
                            />
                        </>
                    )}

                    {/* Grid view fills the page (already wide). HoursSummary at the bottom. */}
                    {viewMode === 'grid' && (
                        <>
                            {/* Scoreboard + SPLH advisor are scheduler-only.
                                Per Andrew (2026-05-12): staff without an
                                editor toggle shouldn't see forecast / target
                                / weekly-hours bars — those are planning
                                tools for the scheduler, not status info for
                                the line. Hidden entirely if !canEdit. */}
                            {canEdit && (
                                <>
                                    <HoursScoreboard scoreboard={hoursScoreboard} side={side} isEn={isEn} />
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
                            <WeeklyGrid
                                weekStart={weekStart}
                                staffSummary={staffSummary}
                                shifts={visibleShifts}
                                isEn={isEn}
                                currentStaffName={staffName}
                                canEdit={canEdit}
                                side={side}
                                storeLocation={storeLocation}
                                // Open Shifts data for the Sling-style rows at
                                // the top of the table.
                                openSlots={(staffingNeeds || []).filter(n =>
                                    n.date >= toDateStr(weekStart) &&
                                    n.date < toDateStr(addDays(weekStart, 7)) &&
                                    n.side === side &&
                                    (storeLocation === 'both' || n.location === 'both' || n.location === storeLocation) &&
                                    ((n.filledStaff || []).length < (n.count || 0)))}
                                openOffers={visibleShifts.filter(s =>
                                    s.offerStatus === 'open' &&
                                    s.date >= toDateStr(weekStart) &&
                                    s.date < toDateStr(addDays(weekStart, 7)) &&
                                    (!s.side || s.side === side))}
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
                                selectedShiftIds={selectedShiftIds}
                                onToggleShiftSelection={toggleShiftSelection}
                                onCellClick={(staff, dateStr) => {
                                    if (!canEdit) return;
                                    if (dateClosed(dateStr)) {
                                        toast(tx('Restaurant is marked closed on this date.', 'El restaurante está marcado como cerrado en esta fecha.'));
                                        return;
                                    }
                                    if (isStaffOffOn(staff.name, dateStr)) {
                                        toast(tx(`${staff.name} is on approved time-off for this date.`, `${staff.name} tiene tiempo libre aprobado para esta fecha.`));
                                        return;
                                    }
                                    // If there are open slots on this day that match this staff's
                                    // role + side + location, surface them as a chooser instead of
                                    // jumping straight to the free-form Add Shift modal.
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
                                        // Show inline chip strip — one tap = shift created.
                                        // The "✏️ custom" chip in the strip opens the full modal.
                                        setQuickAddCell({ staff, dateStr });
                                    }
                                }}
                                quickAddCell={quickAddCell}
                                onQuickAddSelect={(preset) => {
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
                                }}
                                onQuickAddCustom={() => {
                                    if (!quickAddCell) return;
                                    const { staff, dateStr } = quickAddCell;
                                    setQuickAddCell(null);
                                    openAddModal({ staffName: staff.name, date: dateStr, location: staff.location });
                                }}
                                onQuickAddClose={() => setQuickAddCell(null)}
                                weekNeeds={staffingNeeds.filter(n =>
                                    n.side === side &&
                                    (storeLocation === 'both' || n.location === 'both' || n.location === storeLocation)
                                )}
                                onDeleteShift={handleDeleteShift}
                                onStaffClick={(name) => setPersonFilter(name)}
                                onOfferShift={handleOfferShift}
                                onTakeShift={handleTakeShift}
                                onCancelOffer={handleCancelOffer}
                                blocksByDate={blocksByDate}
                                onDropShift={handleDropShift}
                                onUpdateShiftTimes={handleUpdateShiftTimes}
                                isStaffOffOn={isStaffOffOn}
                                timeOff={viewerTimeOff}
                                onDayHeaderClick={canEdit ? (dStr) => setAvailableForDate(dStr) : null}
                            />
                            <HoursSummary staffSummary={staffSummary} isEn={isEn} currentStaffName={staffName} />
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
                                        onCancelOffer={handleCancelOffer}
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
                                        onCancelOffer={handleCancelOffer}
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
                                        onApprove={handleApprovePto}
                                        onDeny={handleDenyPto}
                                        onRemove={handleRemoveTimeOff}
                                    />
                                )}
                            </div>
                            {/* Desktop: sticky right sidebar with hours summary */}
                            <aside className="hidden lg:block lg:w-72 lg:flex-shrink-0 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
                                <HoursSummary staffSummary={staffSummary} isEn={isEn} currentStaffName={staffName} />
                            </aside>
                            {/* Mobile + tablet: hours summary at bottom (sidebar hidden). lg:hidden ensures
                                we don't render twice. */}
                            <div className="lg:hidden">
                                <HoursSummary staffSummary={staffSummary} isEn={isEn} currentStaffName={staffName} />
                            </div>
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
                            📣 {tx('Give up', 'Liberar')}
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
                />
            )}
            {showBlockModal && canEdit && (
                <BlackoutsModal
                    onClose={() => setShowBlockModal(false)}
                    onAdd={handleAddBlock}
                    onRemove={handleRemoveBlock}
                    blocks={dateBlocks}
                    storeLocation={storeLocation}
                    isEn={isEn}
                />
            )}
            {showTimeOffModal && (
                <TimeOffModal
                    onClose={() => setShowTimeOffModal(false)}
                    onAdd={handleAddTimeOff}
                    onRemove={handleRemoveTimeOff}
                    entries={timeOff}
                    staffList={staffList}
                    isEn={isEn}
                    canEdit={canEdit}
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
                    onClose={() => setShowNeedModal(false)}
                    onSave={handleAddNeed}
                    storeLocation={storeLocation}
                    side={side}
                    weekStart={weekStart}
                    isEn={isEn}
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
        </div>
    );
}

// ── Sub-components ─────────────────────────────────────────────────────────

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
        <div className="mb-3 bg-white border border-dd-line rounded-xl shadow-card p-3 print:hidden">
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

// Coverage heatmap config — service window the strip covers (10 AM → 10 PM).
// 12 blocks per day. Color by headcount in that hour:
//   0 = red gap, 1 = yellow thin, 2 = teal ok, 3+ = green well-staffed.
// Tweak HEATMAP_THIN / HEATMAP_OK if a location wants different thresholds.
// SPLH Advisor — sits above the weekly grid. Compares scheduled hours
// per (day-of-week, daypart) against historical typical hours from Toast.
// Surfaces under-/over-staffed slots with a one-line "+1 / -1" hint plus
// any weather warnings from NWS forecast for the next several days.
function SplhAdvisor({ splhForecast, advisory, weatherTips, weather, open, onToggle, isEn, side }) {
    const tx = (en, es) => (isEn ? en : es);
    const hasData = advisory.haveData;
    // Headline chip (always visible). Compact summary so the advisor adds
    // signal even when collapsed.
    const headline = (() => {
        if (!hasData) return tx('Forecast: no historical data yet.', 'Pronóstico: sin datos históricos.');
        if (advisory.under === 0 && advisory.over === 0) return tx('Forecast: schedule looks balanced ✓', 'Pronóstico: horario balanceado ✓');
        const bits = [];
        if (advisory.under > 0) bits.push(tx(`${advisory.under} under-staffed`, `${advisory.under} con poco personal`));
        if (advisory.over > 0)  bits.push(tx(`${advisory.over} over-staffed`, `${advisory.over} con exceso`));
        return tx(`Forecast: ${bits.join(', ')}`, `Pronóstico: ${bits.join(', ')}`);
    })();
    const headlineTone = !hasData ? 'bg-white text-dd-text-2 border-dd-line'
        : (advisory.under > 0 || advisory.over > 0) ? 'bg-amber-50 text-amber-800 border-amber-200'
        : 'bg-dd-green-50 text-dd-green-700 border-dd-green/30';
    // Today's weather summary for the collapsed header chip. Pulls the
    // first daytime period so the user sees the current forecast at a
    // glance without having to expand the advisor. Per Andrew (2026-05-14):
    // "above the schedule there used to be a weather" — this restores
    // the at-a-glance visibility while keeping the full forecast inside
    // the expanded advisor.
    const todayWeather = weather?.periods?.find(p => p.isDaytime);
    return (
        <div className="mb-3">
            <button onClick={onToggle}
                className={`w-full text-left flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border shadow-card hover:shadow-card-hov transition ${headlineTone}`}>
                <span className="text-xs font-bold flex items-center gap-2 flex-wrap">
                    <span className="w-7 h-7 rounded-lg bg-white/70 flex items-center justify-center text-sm shadow-sm">📊</span>
                    {headline}
                    {todayWeather && (
                        <span className="px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-bold whitespace-nowrap">
                            🌤 {todayWeather.temperature}°{todayWeather.temperatureUnit || 'F'} · {todayWeather.shortForecast}
                        </span>
                    )}
                    {(weatherTips?.length || 0) > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-300 text-[10px] font-bold">⚠️ {weatherTips.length} {tx('weather tip', 'aviso clima')}{weatherTips.length === 1 ? '' : 's'}</span>}
                </span>
                <span className="text-xs font-bold opacity-60">{open ? '▼' : '▶'}</span>
            </button>
            {open && (
                <div className="mt-2 bg-white border border-dd-line rounded-xl p-4 space-y-3 shadow-card">
                    {!hasData && (
                        <p className="text-xs text-dd-text-2">
                            {tx('No labor history yet — once the Toast scraper has 7+ days of hourly data, forecasts will populate.',
                                'Sin historial — una vez que el scraper de Toast tenga 7+ días, el pronóstico aparecerá.')}
                        </p>
                    )}
                    {hasData && (
                        <div className="overflow-x-auto -mx-2 px-2">
                            <table className="w-full text-[11px] border-collapse">
                                <thead>
                                    <tr className="text-dd-text-2">
                                        <th className="text-left p-1 font-bold uppercase tracking-wider text-[10px]">{tx('Day', 'Día')}</th>
                                        {DAYPARTS.map(p => (
                                            <th key={p.id} className="text-center p-1 font-bold uppercase tracking-wider text-[10px] whitespace-nowrap">
                                                {isEn ? p.enLabel : p.esLabel}<br />
                                                <span className="text-[9px] font-normal normal-case text-dd-text-2/60 tracking-normal">{p.startHr}-{p.endHr}</span>
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {[0,1,2,3,4,5,6].map(i => {
                                        const dayCells = splhForecast.filter(f => f.dow === i || (() => {
                                            // splhForecast is built per-day-of-week-of-the-current-week.
                                            // Each entry's dateStr is unique per row index. We render in
                                            // calendar-week order — re-bucket properly:
                                            return false;
                                        })());
                                        // Re-bucket: take the entries whose displayed row should be `i`.
                                        const rowEntries = splhForecast.slice(i * DAYPARTS.length, (i + 1) * DAYPARTS.length);
                                        if (rowEntries.length === 0) return null;
                                        const dow = rowEntries[0]?.dow;
                                        const labels = isEn ? DOW_EN : DOW_ES;
                                        return (
                                            <tr key={i} className="border-t border-dd-line/50">
                                                <td className="p-1 font-bold text-dd-text">
                                                    {labels[dow]}
                                                    <span className="text-[9px] text-dd-text-2/70 block tabular-nums">{rowEntries[0]?.dateStr?.slice(5)}</span>
                                                </td>
                                                {rowEntries.map(f => {
                                                    const v = f.variance;
                                                    const tone = v.status === 'over' ? 'bg-red-50 text-red-700 border-red-200'
                                                              : v.status === 'under' ? 'bg-amber-50 text-amber-800 border-amber-300'
                                                              : v.status === 'on' ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                                              : 'bg-gray-50 text-gray-400 border-gray-200';
                                                    const icon = v.status === 'over' ? '⬇' : v.status === 'under' ? '⬆' : v.status === 'on' ? '✓' : '—';
                                                    const deltaHrs = v.recommendedDelta;
                                                    const recommend = (v.status !== 'unknown' && Math.abs(deltaHrs) >= 1)
                                                        ? `${deltaHrs > 0 ? '+' : ''}${deltaHrs.toFixed(1)}h`
                                                        : '';
                                                    return (
                                                        <td key={f.part.id} className="p-1">
                                                            <div className={`text-center rounded border ${tone} px-1 py-1`}
                                                                title={f.hist
                                                                    ? `Scheduled ${f.scheduled.toFixed(1)}h vs typical ${f.hist.avgHours.toFixed(1)}h · typical sales ${fmtUSD(f.hist.avgSales)} (n=${f.hist.n})`
                                                                    : 'no historical data for this slot'}>
                                                                <div className="font-bold text-[11px] leading-tight">
                                                                    {icon} {f.scheduled.toFixed(0)}h
                                                                </div>
                                                                {f.hist?.avgHours > 0 && (
                                                                    <div className="text-[8px] text-gray-500 leading-none mt-0.5">
                                                                        {tx('typ', 'típ')} {f.hist.avgHours.toFixed(0)}h
                                                                    </div>
                                                                )}
                                                                {recommend && (
                                                                    <div className="text-[8px] font-bold leading-none mt-0.5">{recommend}</div>
                                                                )}
                                                            </div>
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                            <p className="text-[10px] text-dd-text-2/70 mt-2 italic">
                                {tx(`Scheduled ${side.toUpperCase()} hours per slot vs typical from last 28 days. ⬆ = under-staffed, ⬇ = over-staffed, ✓ = on target. Tooltip shows raw numbers.`,
                                    `Horas programadas ${side.toUpperCase()} vs típicas (28 días). ⬆ = poco, ⬇ = exceso, ✓ = bien. Pasa el cursor para detalles.`)}
                            </p>
                        </div>
                    )}
                    {/* Weather forecast — always renders when we have data,
                        not just when there's a notable tip. Andrew (2026-05-14):
                        previously this section was gated on weatherTips.length>0,
                        which meant mild St. Louis weeks hid the forecast
                        entirely. Restored to "always show the next few days
                        when forecast data is loaded; layer tip warnings on
                        top when present." */}
                    {weather?.periods?.length > 0 && (
                        <div className="border-t border-dd-line pt-3">
                            <h4 className="text-[11px] font-bold text-blue-700 mb-1.5 uppercase tracking-wider">
                                🌤 {tx(`Weather: ${weather?.location || ''}`, `Clima: ${weather?.location || ''}`)}
                            </h4>
                            <ul className="text-[11px] text-dd-text space-y-1.5">
                                {weather.periods.filter(p => p.isDaytime).slice(0, 4).map((p, idx) => {
                                    // Find the matching tip for this day (if any) so warnings
                                    // ride alongside the regular forecast row instead of
                                    // appearing as a separate "tips only" section.
                                    const tip = (weatherTips || []).find(t => t.name === p.name);
                                    const rain = p.probabilityOfPrecipitation?.value || 0;
                                    const tF = Number(p.temperature) || null;
                                    return (
                                        <li key={idx} className="flex items-start gap-2">
                                            <span className="font-bold whitespace-nowrap text-dd-text">{p.name}:</span>
                                            <span>
                                                <span className="text-dd-text-2">{p.shortForecast}{tF != null && ` · ${tF}°F`}{rain > 0 && ` · ${rain}% rain`}</span>
                                                {tip?.parts?.map((part, j) => (
                                                    <div key={j} className="text-[11px] text-amber-800 mt-0.5">⚠️ {isEn ? part.text : part.esText}</div>
                                                ))}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

const HEATMAP_FIRST_HOUR = 10;
const HEATMAP_LAST_HOUR = 22; // exclusive upper bound (block-of-22:00 = 9-10pm)
const HEATMAP_THIN = 1;       // <= this is "thin" (yellow)
const HEATMAP_OK = 2;         // <= this is "ok" (teal); above is "well-staffed" (green)

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
    if (total === 0) return null;

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
            icon: '📋',
            titleEn: 'Unassigned Shifts',     titleEs: 'Turnos Sin Asignar',
            countEn: 'unfilled',              countEs: 'sin llenar',
            footerEn: 'Tap a slot to fill',  footerEs: 'Toca para llenar',
            headerBg: 'from-blue-50 via-blue-50/40 to-white',
            countBg:  'bg-blue-50 text-blue-700 border-blue-200',
            iconBg:   'bg-blue-50 text-blue-700',
        }
        : {
            icon: '📣',
            titleEn: 'Available to Claim',    titleEs: 'Disponibles para Tomar',
            countEn: 'up for grabs',          countEs: 'disponibles',
            footerEn: 'Tap to claim',         footerEs: 'Toca para tomar',
            headerBg: 'from-purple-50 via-purple-50/40 to-white',
            countBg:  'bg-purple-50 text-purple-700 border-purple-200',
            iconBg:   'bg-purple-50 text-purple-700',
        };

    return (
        <div className="mb-3 bg-white border border-dd-line rounded-xl shadow-card overflow-hidden print:hidden">
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

                                {items.length === 0 && (
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

function WeeklyGrid({ weekStart, staffSummary, shifts, isEn, currentStaffName, canEdit, onCellClick, onDeleteShift, onStaffClick, onOfferShift, onTakeShift, onCancelOffer, blocksByDate, onDropShift, isStaffOffOn, onDayHeaderClick, timeOff, weekNeeds, quickAddCell, onQuickAddSelect, onQuickAddCustom, onQuickAddClose, onUpdateShiftTimes,
    // Open Shifts data — rendered as Sling-style rows AT THE TOP of the
    // schedule table so they share column widths with the days below.
    // openSlots: from staffingNeeds, per-day chips ("📋 4p")
    // openOffers: from shifts.offerStatus === 'open', per-day chips ("📣 Sara")
    openSlots = [], openOffers = [], side = 'foh', storeLocation = 'webster',
    onFillSlot,
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
    // Helper: is staff PENDING (not approved) for date? Visual only — doesn't block.
    const isStaffPendingOff = (staffName, dateStr) => (timeOff || []).some(t => {
        if (t.status !== 'pending') return false;
        if (t.staffName !== staffName) return false;
        const start = t.startDate || t.date;
        const end = t.endDate || t.date;
        return dateStr >= start && dateStr <= end;
    });
    const [dragOverCell, setDragOverCell] = useState(null); // "staffName|date" while dragging
    const days = DAYS_EN.map((_, i) => addDays(weekStart, i));
    const dayLabels = isEn ? DAYS_EN : DAYS_ES;
    const today = toDateStr(new Date());

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

    // Coverage heatmap data — for each day, how many distinct people are
    // on the floor at each hour of the service window. A shift covers an
    // hour H when startTime <= H:00 AND endTime > H:00. Counts unique
    // staff names so two shifts by the same person on the same day still
    // count as one body in the building during overlap (which can't
    // physically happen anyway, but the de-dupe protects against shift
    // overlap data bugs).
    const coverageByDate = useMemo(() => {
        const out = new Map();
        const days = DAYS_EN.map((_, i) => addDays(weekStart, i));
        const toMin = (t) => {
            if (!t) return null;
            const [h, m] = t.split(':').map(Number);
            return h * 60 + (m || 0);
        };
        for (const d of days) {
            const dStr = toDateStr(d);
            const dayShifts = shifts.filter(sh => sh.date === dStr);
            const hours = [];
            for (let h = HEATMAP_FIRST_HOUR; h < HEATMAP_LAST_HOUR; h++) {
                const hourMin = h * 60;
                const namesOn = new Set();
                for (const sh of dayShifts) {
                    const sm = toMin(sh.startTime);
                    const em = toMin(sh.endTime);
                    if (sm == null || em == null) continue;
                    if (sm <= hourMin && em > hourMin) {
                        namesOn.add(sh.staffName);
                    }
                }
                hours.push(namesOn.size);
            }
            out.set(dStr, hours);
        }
        return out;
    }, [shifts, weekStart]);

    const heatmapColor = (count) => {
        if (count === 0) return 'bg-red-400';
        if (count <= HEATMAP_THIN) return 'bg-yellow-300';
        if (count <= HEATMAP_OK) return 'bg-teal-300';
        return 'bg-emerald-500';
    };

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
                    <tr>
                        <th className="sticky left-0 bg-white z-10 border-b border-dd-line px-3 py-2.5 text-left min-w-[120px]">
                            <span className="text-[10px] uppercase text-dd-text-2 font-bold tracking-wider">{isEn ? 'Staff' : 'Personal'}</span>
                        </th>
                        {days.map((d, i) => {
                            const dStr = toDateStr(d);
                            const isToday = dStr === today;
                            const dayBlocks = (blocksByDate && blocksByDate.get(dStr)) || [];
                            const closed = dayBlocks.some(b => b.type === 'closed');
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
                                    {closed && <div className="text-[9px] font-bold text-dd-text-2 mt-1">🚫 {isEn ? 'Closed' : 'Cerrado'}</div>}
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
                                    {/* Coverage heatmap — one block per service hour
                                        (10am→10pm). Color shows headcount on the floor.
                                        Hover any block to see exact count + hour. */}
                                    {!closed && (() => {
                                        const hours = coverageByDate.get(dStr) || [];
                                        const minHere = Math.min(...hours);
                                        const hasGap = minHere === 0;
                                        return (
                                            <div className={`mt-1 flex gap-px rounded overflow-hidden border ${hasGap ? 'border-red-300' : 'border-gray-200'} print:hidden`}
                                                title={isEn
                                                    ? `${hours.join(', ')} (${HEATMAP_FIRST_HOUR}am–${HEATMAP_LAST_HOUR === 24 ? '12am' : HEATMAP_LAST_HOUR > 12 ? `${HEATMAP_LAST_HOUR - 12}pm` : `${HEATMAP_LAST_HOUR}am`})`
                                                    : `Personal por hora: ${hours.join(', ')}`}>
                                                {hours.map((cnt, hi) => {
                                                    const hour = HEATMAP_FIRST_HOUR + hi;
                                                    const hourLabel = hour === 12 ? '12pm' : hour > 12 ? `${hour - 12}pm` : `${hour}am`;
                                                    return (
                                                        <div key={hi}
                                                            className={`flex-1 h-2 ${heatmapColor(cnt)}`}
                                                            title={`${hourLabel}: ${cnt} ${cnt === 1 ? (isEn ? 'person' : 'persona') : (isEn ? 'people' : 'personas')}`} />
                                                    );
                                                })}
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
                    {openSlots.length > 0 && (
                        <tr className="bg-blue-50/40">
                            <td className="sticky left-0 z-10 bg-blue-50 border-b border-r border-dd-line px-2.5 py-2 align-middle">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-base">📋</span>
                                    <div className="min-w-0">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-blue-700 leading-none">
                                            {isEn ? 'Unassigned' : 'Sin asignar'}
                                        </div>
                                        <div className="text-[10px] font-semibold text-blue-700/70 leading-tight mt-0.5">
                                            {openSlots.reduce((s, n) => s + Math.max(0, (n.count || 0) - (n.filledStaff || []).length), 0)} {isEn ? 'open' : 'abiertos'}
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
                                            {slots.length === 0 && !closed && (
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
                                {/* Per-staff weekly-hours pill — scheduler-only. */}
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
                                const closed = dayBlocks.some(b => b.type === 'closed');
                                const cellKey = `${s.name}|${dStr}`;
                                const isDragOver = dragOverCell === cellKey;
                                const onPTO = isStaffOffOn && isStaffOffOn(s.name, dStr);
                                const onPendingPTO = !onPTO && isStaffPendingOff(s.name, dStr);
                                return (
                                    <td key={i}
                                        onClick={() => {
                                            if (!canEdit || closed) return;
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
                                        className={`border-b border-r border-dd-line align-top p-1.5 transition ${isToday ? 'border-l-2 border-l-dd-green' : ''} ${closed ? 'bg-dd-bg' : onPTO ? 'bg-amber-50' : onPendingPTO ? 'bg-yellow-50' : isDragOver ? 'bg-blue-50 ring-2 ring-blue-400 ring-inset' : isToday ? 'bg-dd-sage-50/40' : ''} ${canEdit && cellShifts.length === 0 && !closed ? 'cursor-pointer hover:bg-dd-sage-50' : ''}`}>
                                        <div className="space-y-1">
                                            {onPTO && cellShifts.length === 0 && (
                                                <div className="text-center text-amber-700 text-[9px] font-bold py-1">🌴 {isEn ? 'Time Off' : 'Libre'}</div>
                                            )}
                                            {onPendingPTO && cellShifts.length === 0 && (
                                                <div className="text-center text-yellow-700 text-[9px] font-bold py-1">⏳ {isEn ? 'Time off pending' : 'Libre pendiente'}</div>
                                            )}
                                            {cellShifts.map(sh => (
                                                <ShiftCube key={sh.id} shift={sh} staffRole={s.role} staffScheduleSide={s.scheduleSide} isMinor={s.isMinor} isShiftLead={s.shiftLead} canEdit={canEdit} onDelete={onDeleteShift} isEn={isEn} compact
                                                    currentStaffName={currentStaffName} onOfferShift={onOfferShift} onCancelOffer={onCancelOffer}
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
                                                    const presets = getShiftPresets(resolveStaffSide(s));
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
                                                                <button type="button"
                                                                    onClick={() => onQuickAddClose && onQuickAddClose()}
                                                                    className="flex-1 px-1 py-1 rounded-md bg-white border border-dd-line text-dd-text-2 text-[10px] font-bold hover:bg-dd-bg active:scale-95 transition"
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
}

function ShiftCube({ shift, staffRole, staffScheduleSide, isMinor, isShiftLead, canEdit, onDelete, isEn, compact, currentStaffName, onOfferShift, onCancelOffer, draggable, isDoubleDay, dayShiftCount, onUpdateShiftTimes,
    // Multi-select: shift+click toggles. Parent owns the Set of selected ids.
    isSelected = false, onToggleSelection,
}) {
    // Inline resize picker — opens via the right-edge handle. Lets the user
    // nudge the end time by ±15min / ±30min / ±1h with one tap. Real
    // pointer-drag on a scrolling table cell is finicky; this gives the
    // same outcome (quick shift extend/shorten) without the math.
    const [resizePickerOpen, setResizePickerOpen] = useState(false);
    // Inline delete-confirm. Click the X → flips to a tiny "Sure?
    // ✓ ✗" pill in the same corner. ✓ deletes immediately (no undo
    // toast — the confirm IS the safety net). ✗ or outside-tap reverts.
    // Faster than the old "X → 5-second bottom toast" flow which felt
    // laggy because the confirmation lived far from the cube.
    const [confirmingDelete, setConfirmingDelete] = useState(false);
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
            onContextMenu={(e) => { if (!canEdit) return; e.preventDefault(); setMenuOpen(true); }}
            onTouchStart={beginLongPress}
            onTouchEnd={cancelLongPress}
            onTouchMove={cancelLongPress}
            onTouchCancel={cancelLongPress}
            title={auditLines.join('\n') || undefined}
            className={`schedule-shift-cube relative rounded-md shadow-sm ${shift.published === false ? 'border-2 border-dashed border-dd-text-2/40 opacity-80' : 'border'} ${hasWarning ? 'border-amber-500 border-2' : colors.border} ${isOffered ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-white' : ''} ${isPending ? 'ring-2 ring-purple-400 ring-offset-1 ring-offset-white' : ''} ${isSelected ? 'ring-2 ring-dd-green ring-offset-1 ring-offset-white' : ''} ${colors.bg} ${colors.text} px-2 py-1.5 ${compact ? 'text-[10px] leading-tight' : 'text-xs'} ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} hover:shadow-card-hov hover:-translate-y-px transition group/cube`}>
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
                            className="px-2 py-0.5 rounded bg-white border border-dd-line text-dd-text-2 text-[10px] font-bold hover:bg-dd-bg">✕</button>
                    </div>
                </div>
            ) : (
                <button type="button" onClick={beginTimeEdit}
                    title={canEdit && onUpdateShiftTimes ? (isEn ? 'Tap to edit times' : 'Toca para editar horas') : undefined}
                    className={`block w-full text-left font-black tabular-nums tracking-tight ${canEdit && onUpdateShiftTimes ? 'hover:underline decoration-dotted underline-offset-2 cursor-text' : ''}`}>
                    {formatTime12h(shift.startTime)}–{formatTime12h(shift.endTime)}
                </button>
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
            {/* Offer / cancel-offer buttons (own-shift only, not when pending) */}
            {isMine && !isPending && onOfferShift && (
                <button onClick={(e) => { e.stopPropagation(); isOffered ? onCancelOffer(shift) : onOfferShift(shift); }}
                    className={`mt-1 w-full text-[9px] font-bold px-1 py-1 rounded print:hidden transition ${isOffered ? 'bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'}`}>
                    {isOffered ? (isEn ? 'Cancel offer' : 'Cancelar') : (isEn ? '📣 Give up' : '📣 Liberar')}
                </button>
            )}
            {canEdit && !confirmingDelete && (
                <button onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true); }}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-[11px] leading-none hover:bg-red-600 print:hidden shadow-md opacity-0 group-hover/cube:opacity-100 transition"
                    title={isEn ? 'Delete shift' : 'Eliminar turno'}>
                    ×
                </button>
            )}
            {canEdit && confirmingDelete && (
                <>
                    {/* Outside-tap dismiss layer — clicking anywhere else
                        cancels the confirm. z-30 sits below the confirm pill. */}
                    <div className="fixed inset-0 z-30"
                        onClick={(e) => { e.stopPropagation(); setConfirmingDelete(false); }} />
                    <div onClick={(e) => e.stopPropagation()}
                        className="absolute -top-3 -right-2 z-40 flex items-center gap-1 px-1.5 py-1 rounded-full bg-white border-2 border-red-400 shadow-card-hov print:hidden">
                        <span className="text-[9px] font-bold text-red-700 mr-1">
                            {isEn ? 'Sure?' : '¿Seguro?'}
                        </span>
                        <button onClick={(e) => {
                            e.stopPropagation();
                            setConfirmingDelete(false);
                            onDelete(shift.id, { immediate: true });
                        }}
                            className="w-5 h-5 rounded-full bg-red-600 text-white text-[10px] font-black leading-none hover:bg-red-700 active:scale-90"
                            title={isEn ? 'Yes, delete' : 'Sí, eliminar'}>
                            ✓
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); setConfirmingDelete(false); }}
                            className="w-5 h-5 rounded-full bg-gray-200 text-gray-700 text-[10px] font-black leading-none hover:bg-gray-300 active:scale-90"
                            title={isEn ? 'Cancel' : 'Cancelar'}>
                            ✗
                        </button>
                    </div>
                </>
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
                        {isMine && !isPending && onOfferShift && (
                            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); isOffered ? onCancelOffer(shift) : onOfferShift(shift); }}
                                className="w-full px-3 py-2 text-left text-xs font-semibold text-blue-700 hover:bg-blue-50 flex items-center gap-2">
                                <span>📣</span>{isOffered ? (isEn ? 'Cancel offer' : 'Cancelar') : (isEn ? 'Give up shift' : 'Liberar turno')}
                            </button>
                        )}
                        {onUpdateShiftTimes && (
                            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setResizePickerOpen(true); }}
                                className="w-full px-3 py-2 text-left text-xs font-semibold text-dd-text hover:bg-dd-bg flex items-center gap-2">
                                <span>↔</span>{isEn ? 'Extend / shorten' : 'Extender / acortar'}
                            </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setConfirmingDelete(true); }}
                            className="w-full px-3 py-2 text-left text-xs font-semibold text-red-700 hover:bg-red-50 flex items-center gap-2 border-t border-dd-line">
                            <span>🗑</span>{isEn ? 'Delete shift' : 'Eliminar turno'}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

function DailyView({ weekStart, selectedDayIdx, setSelectedDayIdx, shifts, staffSummary, isEn, currentStaffName, canEdit, onDeleteShift, onOfferShift, onTakeShift, onCancelOffer }) {
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
                                dayShiftCount={dayCount} />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function DayRow({ shift, staffRole, isMinor, isShiftLead, isCurrentStaff, canEdit, onDelete, isEn, currentStaffName, onOfferShift, onCancelOffer, dayShiftCount }) {
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
    return (
        <div className={`flex items-center justify-between gap-2 p-3 rounded-lg border-2 transition shadow-sm hover:shadow-card-hov ${colors.border} ${isCurrentStaff ? 'bg-dd-green-50' : colors.bg} ${warnings.length ? 'ring-2 ring-amber-400 ring-offset-1' : ''} ${isOffered ? 'ring-2 ring-blue-400 ring-offset-1' : ''} ${isPending ? 'ring-2 ring-purple-400 ring-offset-1' : ''}`}>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`font-bold ${isCurrentStaff ? 'text-dd-green-700' : colors.text}`}>
                        {isCurrentStaff && '✓ '}{shift.staffName}
                    </span>
                    {staffRole && <span className={`text-[10px] font-semibold ${colors.text} opacity-70`}>· {staffRole}</span>}
                    {shift.isShiftLead && <span title="Shift Lead">🛡️</span>}
                    {shift.isDouble && <span title="Double shift">⏱</span>}
                    {isAutoDouble && <span title={isEn ? "Double day — two shifts. 1h unpaid break deducted from total." : "Día doble — dos turnos. Se resta 1h de descanso del total."} className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">🔁 {isEn ? 'Double day' : 'Día doble'}</span>}
                    {isOffered && <span className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">📣 {isEn ? 'Up for grabs' : 'Disponible'}</span>}
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
                {isMine && !isPending && onOfferShift && (
                    <button onClick={() => isOffered ? onCancelOffer(shift) : onOfferShift(shift)}
                        className={`px-2.5 py-1.5 text-xs rounded-md font-bold transition ${isOffered ? 'bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'}`}>
                        {isOffered ? (isEn ? 'Cancel' : 'Cancelar') : (isEn ? '📣 Give up' : '📣 Liberar')}
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

function ListView({ shifts, isEn, currentStaffName, canEdit, onDeleteShift, staffSummary, onOfferShift, onTakeShift, onCancelOffer }) {
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
                    className="bg-white border border-dd-line rounded-lg px-2.5 py-2 text-dd-text font-semibold focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50">
                    <option value="date">{isEn ? 'Sort: Date' : 'Ordenar: Fecha'}</option>
                    <option value="staff">{isEn ? 'Sort: Staff' : 'Ordenar: Personal'}</option>
                </select>
                <select value={filterStaff} onChange={e => setFilterStaff(e.target.value)}
                    className="bg-white border border-dd-line rounded-lg px-2.5 py-2 text-dd-text flex-1 focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50">
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
                                    {sh.staffName === currentStaffName && sh.offerStatus !== 'pending' && onOfferShift && (
                                        <button onClick={() => sh.offerStatus === 'open' ? onCancelOffer(sh) : onOfferShift(sh)}
                                            className={`px-2 py-1.5 rounded-md font-bold text-[11px] transition ${sh.offerStatus === 'open' ? 'bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'}`}>
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
function SwapPanels({ shifts, staffName, canEdit, isEn, onTake, onCancelOffer, onApprove, onDeny, storeLocation, timeOff, onApprovePto, onDenyPto, onCancelOwnPto }) {
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

    if (openOffers.length === 0 && pending.length === 0 && myOpenOffers.length === 0 && pendingPto.length === 0 && myPto.length === 0) return null;

    const renderShiftLine = (sh) => `${sh.date} · ${formatTime12h(sh.startTime)}–${formatTime12h(sh.endTime)} · ${LOCATION_LABELS[sh.location] || sh.location}`;
    const renderPtoLine = (t) => t.startDate + (t.endDate && t.endDate !== t.startDate ? ` → ${t.endDate}` : '') + (t.reason ? ` · ${t.reason}` : '');

    // Reusable card chrome — clean white card with semantic accent stripe.
    const Panel = ({ accent, icon, title, count, children }) => (
        <div className="rounded-xl bg-white border border-dd-line shadow-card overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-dd-line bg-dd-bg/40">
                <span className={`w-1 h-5 rounded-full ${accent}`} />
                <span className="text-sm font-bold text-dd-text flex items-center gap-1.5">
                    <span>{icon}</span> {title}
                </span>
                {count != null && <span className="ml-auto text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{count}</span>}
            </div>
            <div className="p-2.5 space-y-1.5">{children}</div>
        </div>
    );
    return (
        <div className="mb-3 space-y-2 print:hidden">
            {/* My own open offers — gentle reminder this is still mine */}
            {myOpenOffers.length > 0 && (
                <Panel accent="bg-blue-500" icon="📣" title={tx('Your offered shifts', 'Tus turnos ofrecidos')} count={`${myOpenOffers.length} ${tx('still yours', 'aún tuyos')}`}>
                    {myOpenOffers.map(sh => (
                        <div key={sh.id} className="flex items-center justify-between gap-2 text-xs">
                            <span className="text-dd-text">{renderShiftLine(sh)}</span>
                            <button onClick={() => onCancelOffer(sh)}
                                className="px-2 py-1 rounded-md bg-white border border-dd-line text-dd-text-2 font-bold hover:bg-dd-bg text-[11px]">{tx('Cancel offer', 'Cancelar oferta')}</button>
                        </div>
                    ))}
                </Panel>
            )}

            {/* Open shifts up for grabs (others can take) */}
            {openOffers.length > 0 && (
                <Panel accent="bg-blue-500" icon="📣" title={tx('Available to pick up', 'Disponibles para tomar')} count={openOffers.length}>
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
                <Panel accent="bg-purple-500" icon="⏳" title={tx('Pending swap approvals', 'Cambios pendientes')} count={pending.length}>
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
                                    className="flex-1 px-2 py-1.5 rounded-md bg-white border border-dd-line text-dd-text-2 font-bold hover:bg-dd-bg text-[11px]">✕ {tx('Deny', 'Negar')}</button>
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
                <Panel accent="bg-amber-500" icon="🌴" title={tx('My time-off requests', 'Mis solicitudes')} count={myPto.length}>
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
                        return (
                            <div key={t.id} className="flex items-center justify-between gap-2 bg-amber-50 rounded-lg p-2 border border-amber-200 text-xs">
                                <div className="min-w-0 text-dd-text flex-1">{renderPtoLine(t)}</div>
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
                <Panel accent="bg-amber-500" icon="🌴" title={tx('Pending time-off requests', 'Solicitudes pendientes')} count={pendingPto.length}>
                    {pendingPto.map(t => (
                        <div key={t.id} className="bg-amber-50 rounded-lg p-2 border border-amber-200 text-xs">
                            <div className="font-bold text-dd-text">{t.staffName}</div>
                            <div className="text-dd-text-2 text-[11px]">{renderPtoLine(t)}</div>
                            <div className="flex gap-1.5 mt-2">
                                <button onClick={() => onApprovePto(t)}
                                    className="flex-1 px-2 py-1.5 rounded-md bg-dd-green text-white font-bold hover:bg-dd-green-700 shadow-sm text-[11px]">✓ {tx('Approve', 'Aprobar')}</button>
                                <button onClick={() => onDenyPto(t)}
                                    className="flex-1 px-2 py-1.5 rounded-md bg-white border border-dd-line text-dd-text-2 font-bold hover:bg-dd-bg text-[11px]">✕ {tx('Deny', 'Negar')}</button>
                            </div>
                        </div>
                    ))}
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
        <div className="mt-6 bg-white border border-dd-line rounded-xl shadow-card overflow-hidden">
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

function AddShiftModal({ onClose, onSave, staffList, storeLocation, isEn, prefill, weekStart, dateClosed, existingShifts, timeOff = [], canEditFOH = true, canEditBOH = true }) {
    const today = toDateStr(new Date());
    const tx = (en, es) => (isEn ? en : es);

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
    const SHIFT_PRESETS = getShiftPresets(presetSide);
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

    const isOnClosedDate = dateClosed && dateClosed(form.date);

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
    const weekStartStr = weekStart ? toDateStr(weekStart) : null;
    const weekEndStr   = weekStart ? toDateStr(addDays(weekStart, 7)) : null;
    const weekHoursForStaff = (existingShifts || [])
        .filter(s => s.staffName === form.staffName && s.date >= weekStartStr && s.date < weekEndStr)
        .reduce((sum, s) => sum + hoursBetween(s.startTime, s.endTime, s.isDouble), 0);
    const targetHours = selectedStaff?.targetHours || 0;
    const projectedTotal = weekHoursForStaff + hours;
    const overHours = targetHours > 0 && projectedTotal > targetHours;
    const overOT = projectedTotal > 40;

    const canSubmit = form.staffName && form.date && form.startTime && form.endTime && hours > 0 && !isOnClosedDate;

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto sm:shadow-2xl">
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
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Quick presets', 'Presets rápidos')}</label>
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

                    {/* Closed-date guard */}
                    {isOnClosedDate && (
                        <div className="p-2 rounded-lg bg-gray-200 border border-gray-400 text-xs text-gray-800">
                            🚫 <b>{tx('Restaurant closed', 'Restaurante cerrado')}</b> {tx('on this date — pick another.', 'en esta fecha — elige otra.')}
                        </div>
                    )}
                </div>

                <div className="sticky bottom-0 bg-white border-t border-dd-line p-4 flex gap-2 shadow-[0_-4px_8px_-4px_rgba(15,23,42,0.06)]">
                    <button onClick={onClose}
                        className="flex-1 py-2.5 rounded-lg bg-white border border-dd-line text-dd-text font-bold hover:bg-dd-bg transition">{tx('Cancel', 'Cancelar')}</button>
                    <button onClick={() => {
                        if (!canSubmit) return;
                        // If the manager never tapped the side toggle, default to
                        // the staff's home side. This way every saved shift carries
                        // an explicit side field.
                        const finalSide = form.side || staffDefaultSide || 'foh';
                        onSave({ ...form, side: finalSide });
                    }} disabled={!canSubmit}
                        className={`flex-1 py-2.5 rounded-lg font-bold text-white shadow-sm transition ${canSubmit ? 'bg-dd-green hover:bg-dd-green-700' : 'bg-dd-text-2/30 cursor-not-allowed'}`}>
                        {tx('Save Shift', 'Guardar Turno')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── BlackoutsModal ─────────────────────────────────────────────────────────
// Manager UI for two kinds of blackouts:
//   • CLOSED — restaurant is closed (no shifts can be scheduled, no time-off needed)
//   • NO TIME OFF — restaurant is open, but no PTO requests will be approved
//                   (busy season, holiday weekends, special events)
function BlackoutsModal({ onClose, onAdd, onRemove, blocks, storeLocation, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const today = toDateStr(new Date());
    const [form, setForm] = useState({
        date: today,
        type: 'closed',
        location: storeLocation && storeLocation !== 'both' ? storeLocation : 'both',
        reason: '',
    });

    // Sort upcoming blocks first; past blocks at the bottom dimmed.
    const sorted = [...blocks].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const upcoming = sorted.filter(b => b.date >= today);
    const past = sorted.filter(b => b.date < today);

    const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const canSubmit = form.date && form.type;

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto sm:shadow-2xl">
                <div className="sticky top-0 bg-white border-b border-dd-line p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-gray-800">🚫 {tx('Date Blackouts', 'Bloqueos de Fechas')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg">×</button>
                </div>

                <div className="p-4 space-y-3">
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
                        <input type="date" value={form.date} onChange={e => update('date', e.target.value)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                        <select value={form.location} onChange={e => update('location', e.target.value)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition">
                            <option value="both">{LOCATION_LABELS.both}</option>
                            <option value="webster">{LOCATION_LABELS.webster}</option>
                            <option value="maryland">{LOCATION_LABELS.maryland}</option>
                        </select>
                        <input type="text" value={form.reason} onChange={e => update('reason', e.target.value)}
                            placeholder={tx('Reason (e.g. Christmas Day)', 'Razón (ej. Navidad)')}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                        <button onClick={() => canSubmit && onAdd(form)} disabled={!canSubmit}
                            className={`w-full py-2 rounded-lg font-bold text-white ${canSubmit ? 'bg-dd-green hover:bg-dd-green-700' : 'bg-gray-300'}`}>
                            {tx('Add Blackout', 'Agregar Bloqueo')}
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
                </div>

                <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4">
                    <button onClick={onClose} className="w-full py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">{tx('Done', 'Listo')}</button>
                </div>
            </div>
        </div>
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


// ── TimeOffModal ───────────────────────────────────────────────────────────
// Phase 2: admin-entered. Phase 3 will add staff self-serve form + manager queue.
function TimeOffModal({ onClose, onAdd, onRemove, entries, staffList, isEn, canEdit }) {
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
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
                    {upcoming.length > 0 && (
                        <div>
                            <div className="text-xs font-bold text-gray-700 mb-1">{tx("Upcoming", "Próximos")}</div>
                            <div className="space-y-1">
                                {upcoming.map(e => (
                                    <div key={e.id} className="flex items-center justify-between gap-2 p-2 rounded border bg-amber-50 border-amber-300 text-xs">
                                        <div className="min-w-0 flex-1">
                                            <div className="font-bold text-gray-800">{e.staffName}</div>
                                            <div className="text-gray-600">{e.startDate}{e.endDate && e.endDate !== e.startDate ? ` → ${e.endDate}` : ""}{e.reason ? ` · ${e.reason}` : ""}</div>
                                            {e.status && e.status !== "approved" && (
                                                <div className="text-[10px] mt-0.5 font-bold uppercase">
                                                    {e.status === "pending" ? `⏳ ${tx("pending", "pendiente")}` : `❌ ${tx("denied", "negado")}`}
                                                </div>
                                            )}
                                        </div>
                                        {canEdit && (
                                            <button onClick={() => onRemove(e.id)}
                                                className="px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200">×</button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {past.length > 0 && (
                        <details>
                            <summary className="text-xs font-bold text-gray-500 cursor-pointer">{tx("Past", "Pasados")} ({past.length})</summary>
                            <div className="space-y-1 mt-1 opacity-60">
                                {past.map(e => (
                                    <div key={e.id} className="flex items-center justify-between gap-2 p-2 rounded border bg-gray-50 border-gray-300 text-xs">
                                        <div className="min-w-0 flex-1">
                                            <div className="font-bold text-gray-800">{e.staffName}</div>
                                            <div className="text-gray-600">{e.startDate}{e.endDate && e.endDate !== e.startDate ? ` → ${e.endDate}` : ""}{e.reason ? ` · ${e.reason}` : ""}</div>
                                        </div>
                                        {canEdit && (
                                            <button onClick={() => onRemove(e.id)}
                                                className="px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200">×</button>
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
    });
    const update = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const canSubmit = form.startDate && form.endDate && form.startDate <= form.endDate;
    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-amber-700">🌴 {tx('Request Time Off', 'Pedir Tiempo Libre')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-text text-lg">×</button>
                </div>
                <div className="p-4 space-y-3">
                    <div className="text-xs text-gray-600 bg-amber-50 rounded-lg p-2 border border-amber-200">
                        {tx('Submitting as:', 'Enviando como:')} <b>{staffName}</b>. {tx('Your manager will approve or deny.', 'Tu gerente aprobará o negará.')}
                    </div>
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
                    <div>
                        <label className="text-[11px] font-bold text-dd-text-2 uppercase tracking-wider block mb-1.5">{tx('Reason', 'Razón')}</label>
                        <input type="text" value={form.reason} onChange={e => update('reason', e.target.value)}
                            placeholder={tx('e.g. vacation, family, doctor', 'p.ej. vacaciones, familia, doctor')}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition" />
                    </div>
                </div>
                <div className="border-t border-gray-200 p-4 flex gap-2">
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">{tx('Cancel', 'Cancelar')}</button>
                    <button onClick={() => canSubmit && onSubmit(form)} disabled={!canSubmit}
                        className={`flex-1 py-2 rounded-lg font-bold text-white ${canSubmit ? 'bg-amber-600 hover:bg-amber-700' : 'bg-gray-300'}`}>
                        {tx('Submit Request', 'Enviar Solicitud')}
                    </button>
                </div>
            </div>
        </div>
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
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
                    <button onClick={onClose} className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">{tx('Cancel', 'Cancelar')}</button>
                    <button onClick={handleSave} className="flex-1 py-2 rounded-lg bg-purple-700 text-white font-bold">{tx('Save', 'Guardar')}</button>
                </div>
            </div>
        </div>
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                        <h3 className="text-lg font-bold text-dd-text">👥 {tx('Who can work?', '¿Quién puede trabajar?')}</h3>
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
    );
}


// ── PtoView ────────────────────────────────────────────────────────────────
// 4th view mode (next to Grid/Day/List). Calendar of all time-off entries
// for the current week + side, color-coded by status.
function PtoView({ weekStart, timeOff, locationStaffNames, sideStaffNames, isEn, currentStaffName, canEdit, onApprove, onDeny, onRemove }) {
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
                                        return (
                                            <div key={t.id} className={`flex items-center justify-between gap-2 p-2 rounded border ${b.border} ${b.bg}`}>
                                                <div className="min-w-0 flex-1">
                                                    <div className={`font-bold text-xs ${b.text}`}>
                                                        {b.icon} {isMine && '✓ '}{t.staffName}
                                                    </div>
                                                    <div className="text-[10px] text-gray-700">
                                                        {t.startDate}{t.endDate && t.endDate !== t.startDate ? ` → ${t.endDate}` : ''}
                                                        {t.reason && <span className="italic ml-2">"{t.reason}"</span>}
                                                    </div>
                                                </div>
                                                {canEdit && t.status === 'pending' && (
                                                    <div className="flex gap-1 print:hidden">
                                                        <button onClick={() => onApprove(t)} className="px-2 py-1 rounded bg-green-600 text-white text-[10px] font-bold">✓</button>
                                                        <button onClick={() => onDeny(t)} className="px-2 py-1 rounded bg-gray-300 text-gray-700 text-[10px] font-bold">✕</button>
                                                    </div>
                                                )}
                                                {canEdit && t.status !== 'pending' && (
                                                    <button onClick={() => onRemove(t.id)} className="px-2 py-1 rounded bg-red-100 text-red-700 text-[10px] font-bold print:hidden">×</button>
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
        <div className="fixed inset-0 bg-black/40 z-50 flex justify-end"
            onMouseDown={handleBackdrop}
            onTouchStart={handleBackdrop}>
            <div className="bg-white w-full max-w-sm h-full overflow-y-auto shadow-2xl"
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
                <div className="sticky top-0 bg-white border-b border-dd-line p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-blue-700">
                        👥 {isEditing ? tx('Edit Slot', 'Editar Espacio') : tx('Add Staffing Need', 'Agregar Necesidad')}
                    </h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 text-lg">×</button>
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
                </div>
                <div className="sticky bottom-0 bg-white border-t border-dd-line p-4 space-y-2">
                    {!canSubmit && (
                        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 text-center font-semibold">
                            ⚠ {submitBlockedReason}
                        </div>
                    )}
                    <div className="flex gap-2">
                        <button onClick={onClose} className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">{tx('Cancel', 'Cancelar')}</button>
                        <button onClick={handleSave} disabled={!canSubmit}
                            title={canSubmit ? '' : submitBlockedReason}
                            className={`flex-1 py-2 rounded-lg font-bold text-white ${canSubmit ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-300 cursor-not-allowed'}`}>
                            {isEditing ? tx('Save Changes', 'Guardar Cambios') : tx('Save Need', 'Guardar Necesidad')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
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
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
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
                        className="flex-1 sm:flex-initial px-4 py-2 rounded-lg bg-gray-200 text-gray-700 text-sm font-bold hover:bg-gray-300">
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
    );
}

function FillSlotChooserModal({ chooser, onClose, onAssignSlot, onCustomShift, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const { staff, dateStr, needs } = chooser;
    const date = parseLocalDate(dateStr);
    const dayLabel = date ? (isEn ? DAYS_EN : DAYS_ES)[date.getDay()] : '';
    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between flex-shrink-0">
                    <div>
                        <h3 className="text-lg font-bold text-blue-700">
                            👥 {tx('Open Slots', 'Espacios Abiertos')}
                        </h3>
                        <p className="text-xs text-gray-600">{staff.name} · {dayLabel} {dateStr}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 text-lg">×</button>
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-indigo-700">📋 {initial ? tx("Edit Template", "Editar Plantilla") : tx("New Template", "Nueva Plantilla")}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 text-lg">×</button>
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
                        <button onClick={onClose} className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">{tx("Cancel", "Cancelar")}</button>
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-bold text-indigo-700">📋 {tx("Day Templates", "Plantillas del Día")}</h3>
                        <p className="text-xs text-gray-500">{side === "foh" ? "FOH" : "BOH"}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 text-lg">×</button>
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
                                const matchesDay = templateMatchesDay(t);
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
                                                                        pickedDayId === dId
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
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-cyan-700">🔁 {tx("Recurring Shifts", "Turnos Recurrentes")}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 text-lg">×</button>
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
                                <button onClick={() => setEditing(null)} className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold text-sm">{tx("Cancel", "Cancelar")}</button>
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
                    <button onClick={onClose} className="w-full py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">{tx("Done", "Listo")}</button>
                </div>
            </div>
        </div>
    );
}
