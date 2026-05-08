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
import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import {
    collection, doc, onSnapshot, query, where, addDoc, deleteDoc, updateDoc,
    setDoc, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { canEditSchedule, isAdmin, LOCATION_LABELS } from '../data/staff';
import { enableFcmPush } from '../messaging';

// ── Constants ──────────────────────────────────────────────────────────────

const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DAYS_FULL_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_FULL_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

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

// Role-family color tokens for shift cubes.
const roleColors = (role) => {
    if (!role) return { bg: 'bg-gray-100', border: 'border-gray-300', text: 'text-gray-800' };
    if (role === 'Shift Lead')    return { bg: 'bg-purple-100', border: 'border-purple-300', text: 'text-purple-800' };
    if (role === 'Manager' || role === 'Asst Manager' || role === 'Owner')
                                  return { bg: 'bg-amber-100',  border: 'border-amber-400',  text: 'text-amber-900' };
    if (role === 'Kitchen Manager' || role === 'Asst Kitchen Manager')
                                  return { bg: 'bg-amber-100',  border: 'border-amber-400',  text: 'text-amber-900' };
    if (BOH_ROLE_HINTS.has(role)) return { bg: 'bg-orange-100', border: 'border-orange-300', text: 'text-orange-800' };
    return { bg: 'bg-teal-100', border: 'border-teal-300', text: 'text-teal-800' };
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
    const canEdit = canEditSchedule(staffName, staffList);

    const [shifts, setShifts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [viewMode, setViewMode] = useState('grid'); // 'grid' | 'day' | 'list'
    const [side, setSide] = useState('foh'); // 'foh' | 'boh'
    const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
    const [selectedDayIdx, setSelectedDayIdx] = useState(() => (new Date().getDay() - WEEK_START_DOW + 7) % 7);
    const [showAddModal, setShowAddModal] = useState(false);
    const [addPrefill, setAddPrefill] = useState(null);
    // Single-person filter — when set, every view scopes to ONE staff member.
    // Cleared with the "Show all" button.
    const [personFilter, setPersonFilter] = useState(null);
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
    const [showNotifDrawer, setShowNotifDrawer] = useState(false);

    // ── Data load ──
    useEffect(() => {
        setLoading(true);
        const weekEnd = addDays(weekStart, 7);
        const weekStartStr = toDateStr(weekStart);
        const weekEndStr = toDateStr(weekEnd);
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
        }, (err) => {
            console.error('Schedule snapshot error:', err);
            setLoading(false);
        });
        return unsub;
    }, [weekStart]);

    // ── Listen for date blocks (restaurant closed days, no-time-off days) ──
    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'date_blocks'), (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setDateBlocks(items);
        }, (err) => console.error('date_blocks snapshot error:', err));
        return unsub;
    }, []);

    // ── Listen for time-off entries ──
    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'time_off'), (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setTimeOff(items);
        }, (err) => console.error('time_off snapshot error:', err));
        return unsub;
    }, []);

    // ── Listen for staffing-needs / shift slots ──
    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'staffing_needs'), (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setStaffingNeeds(items);
        }, (err) => console.error('staffing_needs snapshot error:', err));
        return unsub;
    }, []);

    // ── Listen for day templates ──
    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'schedule_templates'), (snap) => {
            const items = [];
            snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
            setScheduleTemplates(items);
        }, (err) => console.error('schedule_templates snapshot error:', err));
        return unsub;
    }, []);

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

    // Helper — write a notification doc. Silently swallows errors so a notify
    // failure never blocks the underlying action. Multiple recipients = multiple
    // calls (caller maps).
    const notify = async (forStaff, type, title, body, link = null) => {
        if (!forStaff || forStaff === staffName) return; // don't notify yourself
        try {
            await addDoc(collection(db, 'notifications'), {
                forStaff, type, title, body, link,
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

    // Helper: is a staff member off on a given date (any APPROVED time-off covers it)?
    const isStaffOffOn = (staffName, dateStr) => {
        return timeOff.some(t => {
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
            const locOk = storeLocation === 'both' || s.location === storeLocation || s.location === 'both';
            if (!locOk) return false;
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
            const shiftSide = s.side || resolveStaffSide(staffByName.get(s.staffName));
            return shiftSide === side && sideStaffNames.has(s.staffName);
        });
    }, [shifts, storeLocation, sideStaffNames, personFilter, side, staffByName]);

    // ── Derived: per-staff weekly hours summary for the current side view ──
    // Hours are calculated over ALL of this staffer's shifts (both sides) — OT
    // is per employee per week regardless of which "side" they worked.
    const staffSummary = useMemo(() => {
        return sideStaff
            .map(s => {
                const allMyShifts = shifts.filter(sh =>
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
    }, [sideStaff, shifts, visibleShifts, storeLocation]);

    // ── Handlers ──
    const handleAddShift = async (shiftData) => {
        try {
            await addDoc(collection(db, 'shifts'), {
                ...shiftData,
                published: true, // Phase 1: no draft state yet
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
                    alert(tx(
                        `✅ Saved, but this shift is at ${LOCATION_LABELS[shiftData.location]} and you're viewing ${LOCATION_LABELS[storeLocation]}. Switch locations from the home screen to see it.`,
                        `✅ Guardado, pero este turno es en ${LOCATION_LABELS[shiftData.location]} y estás viendo ${LOCATION_LABELS[storeLocation]}. Cambia de ubicación en la pantalla de inicio para verlo.`,
                    ));
                }, 0);
            }
        } catch (e) {
            console.error('Add shift failed:', e);
            alert(tx('Could not save shift: ', 'No se pudo guardar el turno: ') + e.message);
        }
    };

    const handleDeleteShift = async (shiftId) => {
        if (!canEdit) return;
        if (!confirm(tx('Delete this shift?', '¿Eliminar este turno?'))) return;
        try {
            await deleteDoc(doc(db, 'shifts', shiftId));
        } catch (e) {
            console.error('Delete shift failed:', e);
            alert(tx('Could not delete: ', 'No se pudo eliminar: ') + e.message);
        }
    };

    // ── Drag-and-drop: move a shift to a different cell (date / staff). ──
    // Source = shift cube (draggable). Target = grid cell.
    // Also supports Alt-drag (or shift-drag) to COPY instead of move — Phase 2B
    // could expose a UI hint. For now: plain drag = move.
    const handleDropShift = async (shiftId, newStaffName, newDate) => {
        if (!canEdit) return;
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) return;
        // No-op if dropped on its own cell.
        if (shift.staffName === newStaffName && shift.date === newDate) return;
        // Refuse to drop on a closed date.
        if (dateClosed(newDate)) {
            alert(tx('Cannot drop on a closed date.', 'No puedes soltar en una fecha cerrada.'));
            return;
        }
        // Refuse to drop on a staffer's PTO date.
        if (isStaffOffOn(newStaffName, newDate)) {
            alert(tx(`${newStaffName} is on approved time-off that date.`, `${newStaffName} tiene tiempo libre aprobado esa fecha.`));
            return;
        }
        try {
            await updateDoc(doc(db, 'shifts', shiftId), {
                staffName: newStaffName,
                date: newDate,
                updatedAt: serverTimestamp(),
            });
        } catch (e) {
            console.error('Drop shift failed:', e);
            alert(tx('Could not move shift: ', 'No se pudo mover: ') + e.message);
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
            alert(tx('Could not offer shift: ', 'No se pudo ofrecer: ') + e.message);
        }
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

    const handleTakeShift = async (shift) => {
        const ok = confirm(tx(
            `✅ This shift on ${shift.date} from ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} is now YOUR responsibility (pending manager approval). Confirm?`,
            `✅ Este turno el ${shift.date} de ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)} ahora es TU responsabilidad (pendiente de aprobación del gerente). ¿Confirmar?`,
        ));
        if (!ok) return;
        try {
            await updateDoc(doc(db, 'shifts', shift.id), {
                offerStatus: 'pending',
                pendingClaimBy: staffName,
                claimedAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            });
        } catch (e) {
            console.error('Take shift failed:', e);
            alert(tx('Could not take shift: ', 'No se pudo tomar: ') + e.message);
        }
    };

    const handleApproveSwap = async (shift) => {
        if (!canEdit) return;
        const oldOwner = shift.staffName;
        const newOwner = shift.pendingClaimBy;
        try {
            await updateDoc(doc(db, 'shifts', shift.id), {
                staffName: newOwner,
                offerStatus: null,
                offeredBy: null,
                offeredAt: null,
                pendingClaimBy: null,
                claimedAt: null,
                approvedBy: staffName,
                approvedAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            });
            const detail = `${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)}`;
            await notify(oldOwner, 'swap_approved', tx('Swap approved', 'Cambio aprobado'),
                tx(`Your shift on ${detail} is now ${newOwner}'s.`, `Tu turno del ${detail} ahora es de ${newOwner}.`));
            await notify(newOwner, 'swap_approved', tx('Shift assigned', 'Turno asignado'),
                tx(`The shift on ${detail} is now yours.`, `El turno del ${detail} ahora es tuyo.`));
        } catch (e) {
            console.error('Approve failed:', e);
            alert(tx('Could not approve: ', 'No se pudo aprobar: ') + e.message);
        }
    };

    const handleDenySwap = async (shift) => {
        if (!canEdit) return;
        try {
            await updateDoc(doc(db, 'shifts', shift.id), {
                offerStatus: 'open', // back to open offer; original owner still on hook
                pendingClaimBy: null,
                claimedAt: null,
                updatedAt: serverTimestamp(),
            });
            const detail = `${shift.date} ${formatTime12h(shift.startTime)}–${formatTime12h(shift.endTime)}`;
            await notify(shift.pendingClaimBy, 'swap_denied', tx('Swap denied', 'Cambio negado'),
                tx(`Manager denied your takeover of the ${detail} shift.`, `Gerente negó tu toma del turno ${detail}.`));
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
        if (!canEdit) return;
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
            alert(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    const handleRemoveNeed = async (needId) => {
        if (!canEdit) return;
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
            alert(tx('Could not update slot: ', 'No se pudo actualizar el espacio: ') + e.message);
        }
    };

    // Fill one slot of a need: create a real shift for that staff member, then
    // append to the need's filledStaff[] + filledShiftIds[]. Used by the
    // AvailableStaffModal flow when fillingNeed is set.
    const fillNeedWithStaff = async (need, staffMember) => {
        if (!canEdit) return;
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
                published: true,
                createdBy: staffName,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                fromNeedId: need.id,
            });
            await updateDoc(doc(db, 'staffing_needs', need.id), {
                filledStaff: [...(need.filledStaff || []), staffMember.name],
                filledShiftIds: [...(need.filledShiftIds || []), shiftRef.id],
            });
            setFillingNeed(null);
            setAvailableForDate(null);
        } catch (e) {
            console.error('Fill need failed:', e);
            alert(tx('Could not fill: ', 'No se pudo asignar: ') + e.message);
        }
    };

    const unfillNeedSlot = async (need, staffMemberName) => {
        if (!canEdit) return;
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
                alert(tx(
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
            alert(tx(
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
    const handleSaveTemplate = async (tpl) => {
        if (!canEdit) return;
        try {
            if (tpl.id) {
                const { id, ...data } = tpl;
                await updateDoc(doc(db, 'schedule_templates', id), {
                    ...data,
                    updatedAt: serverTimestamp(),
                    updatedBy: staffName,
                });
            } else {
                await addDoc(collection(db, 'schedule_templates'), {
                    ...tpl,
                    createdAt: serverTimestamp(),
                    createdBy: staffName,
                });
            }
            setShowTemplateEditor(false);
            setEditingTemplate(null);
        } catch (e) {
            console.error('Save template failed:', e);
            alert(tx('Could not save template: ', 'No se pudo guardar la plantilla: ') + e.message);
        }
    };

    const handleDeleteTemplate = async (id) => {
        if (!canEdit) return;
        if (!confirm(tx('Delete this template? Already-applied needs will NOT be removed.', '¿Eliminar esta plantilla? Las necesidades ya aplicadas NO se quitarán.'))) return;
        try {
            await deleteDoc(doc(db, 'schedule_templates', id));
        } catch (e) {
            console.error('Delete template failed:', e);
        }
    };

    const handleApplyTemplate = async (tpl, dateStr) => {
        if (!canEdit) return;
        if (!tpl || !dateStr) return;
        try {
            // Each block × slot becomes one staffing_need.
            for (const block of (tpl.blocks || [])) {
                for (const slot of (block.slots || [])) {
                    if (!slot.count || slot.count <= 0) continue;
                    await addDoc(collection(db, 'staffing_needs'), {
                        date: dateStr,
                        side: tpl.side || 'foh',
                        location: tpl.location || (storeLocation !== 'both' ? storeLocation : 'webster'),
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
            setShowApplyTemplate(false);
            alert(tx(`✅ Applied "${tpl.name}" to ${dateStr}.`, `✅ "${tpl.name}" aplicada a ${dateStr}.`));
        } catch (e) {
            console.error('Apply template failed:', e);
            alert(tx('Apply error: ', 'Error al aplicar: ') + e.message);
        }
    };

    // ── Recurring shifts ───────────────────────────────────────────────────
    // A recurring rule: "Maria works Mon/Wed 9-3 every week, valid from
    // 2026-05-12 onward (no end date)." We store rules separately and generate
    // real shifts on-demand via the "Generate this week" button.
    const handleSaveRecurring = async (rule) => {
        if (!canEdit) return;
        try {
            if (rule.id) {
                const { id, ...data } = rule;
                await updateDoc(doc(db, 'recurring_shifts', id), { ...data, updatedAt: serverTimestamp(), updatedBy: staffName });
            } else {
                await addDoc(collection(db, 'recurring_shifts'), { ...rule, createdAt: serverTimestamp(), createdBy: staffName });
            }
        } catch (e) {
            console.error('Save recurring failed:', e);
            alert(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    const handleDeleteRecurring = async (id) => {
        if (!canEdit) return;
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
            alert(tx(`No shifts generated.${skipped.length ? '\n\nSkipped:\n' + skipped.slice(0, 8).join('\n') : ''}`,
                `No se generaron turnos.${skipped.length ? '\n\nOmitidos:\n' + skipped.slice(0, 8).join('\n') : ''}`));
        } else {
            alert(tx(`✅ Generated ${created.length} draft shifts.${skipped.length ? `\n\nSkipped ${skipped.length}.` : ''}`,
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
            alert(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
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
            alert(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
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
            alert(tx(
                `🛑 Time-off cannot be requested for these dates:\n${blockedDates.join('\n')}\n\nPlease pick different dates.`,
                `🛑 No se puede pedir tiempo libre para estas fechas:\n${blockedDates.join('\n')}\n\nPor favor elige otras fechas.`,
            ));
            return;
        }
        try {
            await addDoc(collection(db, 'time_off'), {
                ...entry,
                staffName, // always the submitter for self-serve
                status: 'pending',
                submittedBy: staffName,
                submittedAt: serverTimestamp(),
                createdAt: serverTimestamp(),
            });
            setShowPtoRequestModal(false);
            alert(tx('✅ Request submitted. A manager will review it.', '✅ Solicitud enviada. Un gerente la revisará.'));
        } catch (e) {
            console.error('Submit PTO failed:', e);
            alert(tx('Could not submit: ', 'No se pudo enviar: ') + e.message);
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
            await notify(entry.staffName, 'pto_approved', tx('Time-off approved', 'Tiempo libre aprobado'),
                tx(`Your time-off for ${range} was approved.`, `Tu tiempo libre del ${range} fue aprobado.`));
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
            await notify(entry.staffName, 'pto_denied', tx('Time-off denied', 'Tiempo libre negado'),
                tx(`Your time-off for ${range} was denied.`, `Tu tiempo libre del ${range} fue negado.`));
        } catch (e) {
            console.error('Deny PTO failed:', e);
        }
    };

    // ── Phase 3: staff self-serve availability ──
    // Lifts the same pattern from AdminPanel: read-modify-write the staff list.
    const handleSaveMyAvailability = async (newAvailability) => {
        if (!staffList || !setStaffList) return;
        const updated = staffList.map(s => s.name === staffName ? { ...s, availability: newAvailability } : s);
        setStaffList(updated);
        try {
            await setDoc(doc(db, 'config', 'staff'), { list: updated });
        } catch (e) {
            console.error('Save availability failed:', e);
            alert(tx('Could not save availability: ', 'No se pudo guardar: ') + e.message);
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
</style>
</head><body>
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
            if (!w) { alert(tx('Pop-up blocked.', 'Ventana bloqueada.')); return; }
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
                        return `<div class="shift">
                            <b>${escape(formatTime12h(sh.startTime))}–${escape(formatTime12h(sh.endTime))}</b>
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
    @media print { .noprint { display: none; } }
</style>
</head><body>
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
            alert(tx('Pop-up blocked. Allow pop-ups for this site to print.', 'Ventana emergente bloqueada. Permite ventanas emergentes para imprimir.'));
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
            alert(tx('No published shifts to export.', 'Sin turnos publicados para exportar.'));
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
    const handlePublishDrafts = async () => {
        if (!canEdit) return;
        const drafts = visibleShifts.filter(s => s.published === false);
        if (drafts.length === 0) {
            alert(tx('No drafts to publish.', 'Sin borradores para publicar.'));
            return;
        }
        // Audit any open / over-filled staffing needs for this week + side and surface
        // them in the confirm dialog. The user can still publish — it's a warning,
        // not a block — but they're aware of gaps before staff get notified.
        const weekStartStr = toDateStr(weekStart);
        const weekEndStr = toDateStr(addDays(weekStart, 7));
        const relevantNeeds = staffingNeeds.filter(n =>
            n.date >= weekStartStr && n.date < weekEndStr && n.side === side &&
            (storeLocation === 'both' || n.location === 'both' || n.location === storeLocation)
        );
        const underFilled = relevantNeeds.filter(n => (n.filledStaff || []).length < (n.count || 0));
        const overFilled = relevantNeeds.filter(n => (n.filledStaff || []).length > (n.count || 0));
        let warningMsg = '';
        if (underFilled.length > 0) {
            warningMsg += '\n\n⚠️ ' + tx(`${underFilled.length} need(s) UNDER-FILLED:`, `${underFilled.length} necesidad(es) SIN COMPLETAR:`);
            for (const n of underFilled.slice(0, 5)) {
                warningMsg += `\n  · ${n.date} ${formatTime12h(n.startTime)}–${formatTime12h(n.endTime)}: ${(n.filledStaff || []).length}/${n.count}`;
            }
            if (underFilled.length > 5) warningMsg += `\n  · ${tx(`...and ${underFilled.length - 5} more`, `...y ${underFilled.length - 5} más`)}`;
        }
        if (overFilled.length > 0) {
            warningMsg += '\n\n⚠️ ' + tx(`${overFilled.length} need(s) OVER-FILLED:`, `${overFilled.length} necesidad(es) EXCEDIDAS:`);
            for (const n of overFilled.slice(0, 5)) {
                warningMsg += `\n  · ${n.date} ${formatTime12h(n.startTime)}–${formatTime12h(n.endTime)}: ${(n.filledStaff || []).length}/${n.count}`;
            }
        }
        if (!confirm(tx(
            `Publish ${drafts.length} draft shift(s) for ${side === 'foh' ? 'FOH' : 'BOH'} this week?${warningMsg}`,
            `¿Publicar ${drafts.length} turno(s) borrador para ${side === 'foh' ? 'FOH' : 'BOH'} esta semana?${warningMsg}`,
        ))) return;
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
            alert(tx(`✅ Published ${drafts.length} shifts.`, `✅ Se publicaron ${drafts.length} turnos.`));
            // Notify each staffer whose shifts were published — one notification per person.
            const byStaff = new Map();
            for (const s of drafts) {
                const list = byStaff.get(s.staffName) || [];
                list.push(s);
                byStaff.set(s.staffName, list);
            }
            for (const [name, list] of byStaff) {
                await notify(name, 'week_published', tx('Schedule published', 'Horario publicado'),
                    tx(`${list.length} new shift${list.length === 1 ? '' : 's'} for the week of ${toDateStr(weekStart)}.`,
                       `${list.length} turno${list.length === 1 ? '' : 's'} nuevo${list.length === 1 ? '' : 's'} para la semana del ${toDateStr(weekStart)}.`));
            }
        } catch (e) {
            console.error('Publish failed:', e);
            alert(tx('Publish error: ', 'Error al publicar: ') + e.message);
        }
    };

    // ── Phase 3: copy last week's shifts into this week ──
    const handleCopyLastWeek = async () => {
        if (!canEdit) return;
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
                alert(tx('No shifts found in last week.', 'No hay turnos en la semana anterior.'));
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
            alert(tx(`✅ Copied ${filtered.length} shifts as drafts.`, `✅ Se copiaron ${filtered.length} turnos como borradores.`));
        } catch (e) {
            console.error('Copy week failed:', e);
            alert(tx('Copy error: ', 'Error al copiar: ') + e.message);
        }
    };

    // ── Auto-populate engine ──
    // For each side-staff with availability + targetHours, distribute their target
    // hours across the week's available days (skipping closed dates and approved
    // time-off). Greedy strategy: spread hours roughly evenly across available days.
    // Generated shifts are marked published=false (drafts) so manager can review.
    const handleAutoPopulate = async () => {
        if (!canEdit) return;
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
                if (!dayAvail || dayAvail.available === false) continue;
                if (!dayAvail.from || !dayAvail.to) continue;
                const slotHours = hoursBetween(dayAvail.from, dayAvail.to, false);
                if (slotHours <= 0) continue;
                candidates.push({ date: dStr, from: dayAvail.from, to: dayAvail.to, slotHours });
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
            alert(tx(`Nothing to schedule. Reasons:\n${skipped.slice(0, 8).join('\n')}`,
                `Nada que programar. Razones:\n${skipped.slice(0, 8).join('\n')}`));
            return;
        }

        try {
            // Sequential writes — small batch, no need for batched writes.
            for (const sh of created) {
                await addDoc(collection(db, 'shifts'), sh);
            }
            alert(tx(`✅ Auto-filled ${created.length} draft shifts.${skipped.length ? `\n\nSkipped:\n${skipped.slice(0,5).join('\n')}` : ''}`,
                `✅ Se auto-rellenaron ${created.length} turnos borrador.${skipped.length ? `\n\nOmitidos:\n${skipped.slice(0,5).join('\n')}` : ''}`));
            setShowAutoFillModal(false);
        } catch (e) {
            console.error('Auto-fill failed:', e);
            alert(tx('Auto-fill error: ', 'Error de auto-rellenar: ') + e.message);
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

            <div className="flex items-center justify-between mb-1 print:hidden">
                <h2 className="text-2xl font-bold text-mint-700">📅 {tx('Schedule', 'Horario')}</h2>
                <div className="flex items-center gap-2">
                    <button onClick={() => setShowNotifDrawer(true)}
                        className="relative p-1.5 rounded-full bg-gray-100 hover:bg-gray-200">
                        <span className="text-lg">🔔</span>
                        {unreadCount > 0 && (
                            <span className="absolute -top-1 -right-1 bg-red-600 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                                {unreadCount > 9 ? '9+' : unreadCount}
                            </span>
                        )}
                    </button>
                    <span className="text-xs text-gray-500">{LOCATION_LABELS[storeLocation] || storeLocation}</span>
                </div>
            </div>

            {/* FOH / BOH side toggle — two separate schedules, managers & leads in both */}
            <div className="flex gap-2 mb-2 print:hidden">
                <button onClick={() => setSide('foh')}
                    className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${side === 'foh' ? 'bg-teal-600 text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    {tx('Front of House', 'Front of House')}
                </button>
                <button onClick={() => setSide('boh')}
                    className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${side === 'boh' ? 'bg-orange-600 text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    {tx('Back of House', 'Back of House')}
                </button>
            </div>

            {/* Week navigator */}
            <WeekNav weekStart={weekStart} setWeekStart={setWeekStart} isEn={isEn} />

            {/* View mode toggle */}
            <div className="flex gap-1 mb-3 bg-gray-100 rounded-lg p-1 print:hidden">
                {[
                    { key: 'grid', labelEn: 'Week', labelEs: 'Semana', icon: '⊞' },
                    { key: 'day', labelEn: 'Day', labelEs: 'Día', icon: '☰' },
                    { key: 'list', labelEn: 'List', labelEs: 'Lista', icon: '≡' },
                    { key: 'pto', labelEn: 'PTO', labelEs: 'PTO', icon: '🌴' },
                ].map(v => (
                    <button key={v.key} onClick={() => setViewMode(v.key)}
                        className={`flex-1 py-1.5 rounded-md text-xs font-bold transition ${viewMode === v.key ? 'bg-white text-mint-700 shadow' : 'text-gray-500'}`}>
                        <span className="mr-1">{v.icon}</span>{tx(v.labelEn, v.labelEs)}
                    </button>
                ))}
            </div>

            {/* Action bar — mobile collapses secondary buttons behind a ⋯ toggle.
                Tablet+ shows everything inline (more horizontal real estate). */}
            <div className="flex flex-wrap gap-2 mb-3 print:hidden">
                <select value={personFilter || ''}
                    onChange={(e) => setPersonFilter(e.target.value || null)}
                    className="flex-1 min-w-[140px] border border-gray-300 rounded-lg px-2 py-2 text-xs">
                    <option value="">{tx('👥 Everyone', '👥 Todos')}</option>
                    {sideStaff.map(s => (
                        <option key={s.id || s.name} value={s.name}>{s.name}</option>
                    ))}
                </select>
                {/* PRIMARY (always inline, mobile + desktop) */}
                {canEdit && (
                    <>
                        <button onClick={handlePublishDrafts}
                            title={tx('Publish all draft shifts in current week + side', 'Publicar todos los borradores')}
                            className="px-3 py-2 rounded-lg bg-green-600 text-white text-xs font-bold hover:bg-green-700">
                            📢 {tx('Publish', 'Publicar')}
                        </button>
                        <button onClick={() => openAddModal()}
                            className="px-3 py-2 rounded-lg bg-mint-700 text-white text-xs font-bold hover:bg-mint-800">
                            + {tx('Shift', 'Turno')}
                        </button>
                    </>
                )}
                <button onClick={handlePrintWeek}
                    title={tx('Print full week as one-page calendar', 'Imprimir semana')}
                    className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 text-xs font-bold">
                    🖨 {personFilter ? tx('Print', 'Imprimir') : tx('Print Week', 'Imprimir Semana')}
                </button>
                {/* Mobile-only "more" toggle. Hidden on md+. */}
                <button onClick={() => setShowMoreActions(s => !s)}
                    className="md:hidden px-3 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 text-xs font-bold">
                    {showMoreActions ? `× ${tx('Less', 'Menos')}` : `⋯ ${tx('More', 'Más')}`}
                </button>

                {/* SECONDARY — wrapped in a section that's collapsed on mobile, always visible on md+ */}
                <div className={`${showMoreActions ? 'flex' : 'hidden'} md:flex flex-wrap gap-2 w-full md:w-auto md:contents`}>
                    <button onClick={handleExportIcs}
                        className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 text-xs font-bold">
                        📅 {tx('iCal', 'iCal')}
                    </button>
                    <button onClick={() => setShowPtoRequestModal(true)}
                        className="px-3 py-2 rounded-lg bg-amber-100 text-amber-800 text-xs font-bold hover:bg-amber-200 border border-amber-300">
                        🌴 {tx('Request Off', 'Pedir Off')}
                    </button>
                    <button onClick={() => setShowMyAvailModal(true)}
                        className="px-3 py-2 rounded-lg bg-purple-100 text-purple-800 text-xs font-bold hover:bg-purple-200 border border-purple-300">
                        🗓 {tx('My Avail', 'Mi Dispon.')}
                    </button>
                    <button onClick={() => setShowTimeOffModal(true)}
                        className="px-3 py-2 rounded-lg bg-amber-100 text-amber-800 text-xs font-bold hover:bg-amber-200 border border-amber-300">
                        🌴 {tx('All PTO', 'Todo PTO')}
                    </button>
                    {canEdit && (
                        <>
                            <button onClick={handleAutoPopulate}
                                className="px-3 py-2 rounded-lg bg-purple-600 text-white text-xs font-bold hover:bg-purple-700">
                                ✨ {tx('Auto-fill', 'Auto-rellenar')}
                            </button>
                            <button onClick={() => setShowRecurringModal(true)}
                                className="px-3 py-2 rounded-lg bg-cyan-100 text-cyan-800 border border-cyan-300 text-xs font-bold hover:bg-cyan-200">
                                🔁 {tx('Recurring', 'Recurrentes')}
                            </button>
                            <button onClick={handleCopyLastWeek}
                                className="px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700">
                                📋 {tx('Copy ⏪', 'Copiar ⏪')}
                            </button>
                            <button onClick={() => setShowBlockModal(true)}
                                className="px-3 py-2 rounded-lg bg-gray-700 text-white text-xs font-bold hover:bg-gray-800">
                                🚫 {tx('Blackouts', 'Bloqueos')}
                            </button>
                            <button onClick={() => setShowApplyTemplate(true)}
                                className="px-3 py-2 rounded-lg bg-indigo-100 text-indigo-800 border border-indigo-300 text-xs font-bold hover:bg-indigo-200">
                                📋 {tx('Templates', 'Plantillas')}
                            </button>
                            <button onClick={() => setShowNeedModal(true)}
                                className="px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700">
                                👥 {tx('+ Slot', '+ Slot')}
                            </button>
                        </>
                    )}
                </div>
            </div>
            {personFilter && (
                <div className="mb-3 p-2 rounded bg-green-50 border border-green-300 text-xs text-green-800 flex items-center justify-between print:hidden">
                    <span>👤 {tx('Showing only:', 'Mostrando solo:')} <b>{personFilter}</b></span>
                    <button onClick={() => setPersonFilter(null)} className="underline">{tx('Show all', 'Mostrar todos')}</button>
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
                return (
                    <div className="mb-3 rounded-lg p-2 bg-blue-50 border-2 border-blue-300 text-xs">
                        <div className="font-bold text-blue-900 mb-1">👥 {tx('Staffing needs this week', 'Necesidades de personal esta semana')} — {side === 'foh' ? 'FOH' : 'BOH'}</div>
                        <div className="space-y-1">
                            {weekNeeds.map(n => {
                                const filled = (n.filledStaff || []).length;
                                const open = Math.max(0, (n.count || 0) - filled);
                                const overFilled = filled > (n.count || 0);
                                const fullyStaffed = open === 0 && !overFilled;
                                const date = parseLocalDate(n.date);
                                const dayLabel = date ? (isEn ? DAYS_EN : DAYS_ES)[date.getDay()] : '';
                                const roleGroup = n.roleGroup ? SLOT_ROLE_BY_ID[n.roleGroup] : null;
                                return (
                                    <div key={n.id} className={`p-2 rounded border ${overFilled ? 'bg-red-50 border-red-400' : fullyStaffed ? 'bg-green-50 border-green-300' : 'bg-white border-blue-200'}`}>
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="font-bold text-gray-800 flex items-center gap-1.5 flex-wrap">
                                                    {overFilled ? '⚠️ ' : fullyStaffed ? '✅ ' : ''}{dayLabel} {n.date} · {formatTime12h(n.startTime)}–{formatTime12h(n.endTime)}
                                                    {roleGroup && roleGroup.id !== 'any' && (
                                                        <span className="inline-block px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800 text-[10px] font-bold">
                                                            {roleGroup.emoji} {tx(roleGroup.labelEn, roleGroup.labelEs)}
                                                        </span>
                                                    )}
                                                    {n.notes && <span className="italic text-gray-500 font-normal text-xs">({n.notes})</span>}
                                                </div>
                                                <div className={`text-[10px] ${overFilled ? 'text-red-700 font-bold' : 'text-gray-600'}`}>
                                                    {filled} {tx('of', 'de')} {n.count} {tx('filled', 'asignados')}
                                                    {overFilled && ` · ${tx('OVER by', 'EXCESO de')} ${filled - n.count}`}
                                                    · {LOCATION_LABELS[n.location] || n.location}
                                                </div>
                                                {filled > 0 && (
                                                    <div className="flex flex-wrap gap-1 mt-1">
                                                        {(n.filledStaff || []).map((name, i) => (
                                                            <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-800 rounded-full text-[10px] font-bold">
                                                                ✓ {name.split(' ')[0]}
                                                                <button onClick={() => unfillNeedSlot(n, name)}
                                                                    className="text-green-600 hover:text-red-600 ml-0.5">×</button>
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex flex-col gap-1 flex-shrink-0">
                                                {!fullyStaffed && (
                                                    <button onClick={() => { setFillingNeed(n); setAvailableForDate(n.date); }}
                                                        className="px-2 py-1 rounded bg-blue-600 text-white text-[10px] font-bold hover:bg-blue-700">
                                                        {tx('Fill 1', 'Asignar 1')}
                                                    </button>
                                                )}
                                                <button onClick={() => setEditingNeed(n)}
                                                    title={tx('Edit slot times / count', 'Editar horario / cantidad')}
                                                    className="px-2 py-1 rounded bg-gray-200 text-gray-700 text-[10px] font-bold hover:bg-gray-300">
                                                    ✏ {tx('Edit', 'Editar')}
                                                </button>
                                                <button onClick={() => handleRemoveNeed(n.id)}
                                                    className="px-2 py-1 rounded bg-red-100 text-red-700 text-[10px] font-bold hover:bg-red-200">×</button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })()}

            {/* Open offers + pending approvals (drawn from ALL visible shifts, both sides) */}
            <SwapPanels
                shifts={shifts}
                staffName={staffName}
                canEdit={canEdit}
                isEn={isEn}
                onTake={handleTakeShift}
                onCancelOffer={handleCancelOffer}
                onApprove={handleApproveSwap}
                onDeny={handleDenySwap}
                storeLocation={storeLocation}
                timeOff={timeOff}
                onApprovePto={handleApprovePto}
                onDenyPto={handleDenyPto}
            />

            {loading ? (
                <p className="text-center text-gray-400 mt-8">{tx('Loading…', 'Cargando…')}</p>
            ) : (
                <>
                    {/* Grid view fills the page (already wide). HoursSummary at the bottom. */}
                    {viewMode === 'grid' && (
                        <>
                            <WeeklyGrid
                                weekStart={weekStart}
                                staffSummary={staffSummary}
                                shifts={visibleShifts}
                                isEn={isEn}
                                currentStaffName={staffName}
                                canEdit={canEdit}
                                onCellClick={(staff, dateStr) => {
                                    if (!canEdit) return;
                                    if (dateClosed(dateStr)) {
                                        alert(tx('Restaurant is marked closed on this date.', 'El restaurante está marcado como cerrado en esta fecha.'));
                                        return;
                                    }
                                    if (isStaffOffOn(staff.name, dateStr)) {
                                        alert(tx(`${staff.name} is on approved time-off for this date.`, `${staff.name} tiene tiempo libre aprobado para esta fecha.`));
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
                                        openAddModal({ staffName: staff.name, date: dateStr, location: staff.location });
                                    }
                                }}
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
                                isStaffOffOn={isStaffOffOn}
                                timeOff={timeOff}
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
                                        timeOff={timeOff}
                                        // Use the full location-eligible staff
                                        // list, NOT sideStaffNames — PTO is
                                        // person-scoped, not side-scoped.
                                        // Filtering by sideStaffNames hid
                                        // pending PTO from staff with no
                                        // shifts this week.
                                        locationStaffNames={new Set((staffList || [])
                                            .filter(s => storeLocation === 'both' || s.location === storeLocation || s.location === 'both')
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
            {showTemplateEditor && canEdit && (
                <TemplateEditorModal
                    initial={editingTemplate}
                    onClose={() => { setShowTemplateEditor(false); setEditingTemplate(null); }}
                    onSave={handleSaveTemplate}
                    storeLocation={storeLocation}
                    side={side}
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
        ? `${fmt(weekStart)}–${weekEnd.getDate()}`
        : `${fmt(weekStart)} – ${fmt(weekEnd)}`;
    const today = startOfWeek(new Date());
    const isCurrentWeek = toDateStr(today) === toDateStr(weekStart);
    return (
        <div className="flex items-center justify-between mb-3 bg-mint-50 rounded-lg p-2 border border-mint-200 print:bg-white print:border-0 print:p-0 print:mb-2">
            <button onClick={() => setWeekStart(addDays(weekStart, -7))}
                className="w-9 h-9 rounded-md bg-white text-mint-700 font-bold shadow-sm hover:bg-mint-100 print:hidden">‹</button>
            <div className="text-center">
                <div className="text-sm font-bold text-mint-800 print:text-base">{range}</div>
                {!isCurrentWeek && (
                    <button onClick={() => setWeekStart(today)}
                        className="text-[10px] text-mint-700 underline print:hidden">
                        {isEn ? 'Today' : 'Hoy'}
                    </button>
                )}
                {isCurrentWeek && (
                    <div className="text-[10px] text-mint-600 font-semibold print:hidden">{isEn ? 'This week' : 'Esta semana'}</div>
                )}
            </div>
            <button onClick={() => setWeekStart(addDays(weekStart, 7))}
                className="w-9 h-9 rounded-md bg-white text-mint-700 font-bold shadow-sm hover:bg-mint-100 print:hidden">›</button>
        </div>
    );
}

function WeeklyGrid({ weekStart, staffSummary, shifts, isEn, currentStaffName, canEdit, onCellClick, onDeleteShift, onStaffClick, onOfferShift, onTakeShift, onCancelOffer, blocksByDate, onDropShift, isStaffOffOn, onDayHeaderClick, timeOff, weekNeeds }) {
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

    if (staffSummary.length === 0) {
        return <p className="text-center text-gray-400 mt-6 text-sm">{isEn ? 'No staff for this location.' : 'Sin personal para esta ubicación.'}</p>;
    }

    return (
        <div className="overflow-x-auto -mx-4 px-4 schedule-grid-wrap">
            <table className="border-collapse text-xs min-w-max">
                <thead>
                    <tr>
                        <th className="sticky left-0 bg-white z-10 border-b border-gray-200 px-2 py-2 text-left min-w-[120px]">
                            <span className="text-[10px] uppercase text-gray-500 font-semibold">{isEn ? 'Staff' : 'Personal'}</span>
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
                                    className={`border-b border-gray-200 px-1 py-2 min-w-[110px] ${closed ? 'bg-gray-200' : isToday ? 'bg-mint-50' : ''} ${onDayHeaderClick && !closed ? 'cursor-pointer hover:bg-mint-100' : ''}`}>
                                    <div className={`text-[10px] uppercase font-semibold ${closed ? 'text-gray-600' : isToday ? 'text-mint-700' : 'text-gray-500'}`}>{dayLabels[i]}</div>
                                    <div className={`text-sm font-bold ${closed ? 'text-gray-700' : isToday ? 'text-mint-800' : 'text-gray-700'}`}>{d.getDate()}</div>
                                    {closed && <div className="text-[9px] font-bold text-gray-700 mt-0.5">🚫 {isEn ? 'Closed' : 'Cerrado'}</div>}
                                    {!closed && noTimeoff && <div className="text-[9px] font-bold text-amber-700 mt-0.5">🛑 {isEn ? 'No PTO' : 'Sin PTO'}</div>}
                                    {/* Slot countdown — N/M filled. Color shifts as slots fill. */}
                                    {!closed && stats && stats.total > 0 && (
                                        <div className={`text-[9px] font-bold mt-0.5 inline-block px-1 rounded border ${
                                            fullyStaffed ? 'bg-green-100 text-green-800 border-green-300' :
                                            partiallyFilled ? 'bg-yellow-100 text-yellow-800 border-yellow-300' :
                                            allOpen ? 'bg-red-100 text-red-800 border-red-300' :
                                            'bg-blue-100 text-blue-800 border-blue-300'
                                        }`}>
                                            {fullyStaffed ? `✅ ${stats.filled}/${stats.total}` : `${stats.filled}/${stats.total} ${isEn ? 'slots' : 'esp.'}`}
                                        </div>
                                    )}
                                    {onDayHeaderClick && !closed && <div className="text-[8px] text-mint-600 mt-0.5 print:hidden">👥 {isEn ? 'tap' : 'tocar'}</div>}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {staffSummary.map(s => (
                        <tr key={s.id || s.name} className={s.name === currentStaffName ? 'bg-green-50/40' : ''}>
                            <td className={`sticky left-0 z-10 border-b border-r border-gray-200 px-2 py-1.5 align-top ${s.name === currentStaffName ? 'bg-green-50' : 'bg-white'}`}>
                                <button onClick={() => onStaffClick && onStaffClick(s.name)}
                                    className="flex items-center gap-1 text-left hover:underline">
                                    <span className={`font-semibold text-xs leading-tight truncate ${s.name === currentStaffName ? 'text-green-800' : 'text-gray-800'}`}>
                                        {s.name}
                                    </span>
                                    {s.shiftLead && <span title="Shift Lead">🛡️</span>}
                                    {s.isMinor && <span title="Minor">🔑</span>}
                                </button>
                                <div className={`text-[10px] mt-0.5 inline-block px-1.5 py-0.5 rounded border ${hoursColor(s.totalHours)}`}>
                                    {formatHours(s.totalHours)}
                                </div>
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
                                        onClick={() => canEdit && cellShifts.length === 0 && !closed && onCellClick(s, dStr)}
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
                                        className={`border-b border-r border-gray-200 align-top p-1 ${closed ? 'bg-gray-100' : onPTO ? 'bg-amber-50' : onPendingPTO ? 'bg-yellow-50' : isDragOver ? 'bg-blue-100 ring-2 ring-blue-400' : isToday ? 'bg-mint-50/30' : ''} ${canEdit && cellShifts.length === 0 && !closed ? 'cursor-pointer hover:bg-mint-50' : ''}`}>
                                        <div className="space-y-1">
                                            {onPTO && cellShifts.length === 0 && (
                                                <div className="text-center text-amber-700 text-[9px] font-bold py-1">🌴 {isEn ? 'PTO' : 'PTO'}</div>
                                            )}
                                            {onPendingPTO && cellShifts.length === 0 && (
                                                <div className="text-center text-yellow-700 text-[9px] font-bold py-1">⏳ {isEn ? 'PTO pending' : 'PTO pendiente'}</div>
                                            )}
                                            {cellShifts.map(sh => (
                                                <ShiftCube key={sh.id} shift={sh} staffRole={s.role} staffScheduleSide={s.scheduleSide} isMinor={s.isMinor} canEdit={canEdit} onDelete={onDeleteShift} isEn={isEn} compact
                                                    currentStaffName={currentStaffName} onOfferShift={onOfferShift} onCancelOffer={onCancelOffer}
                                                    draggable={canEdit}
                                                    isDoubleDay={cellShifts.length >= 2}
                                                    dayShiftCount={cellShifts.length} />
                                            ))}
                                            {canEdit && cellShifts.length === 0 && !onPTO && (
                                                <div className="text-center text-gray-300 text-lg leading-none py-1">+</div>
                                            )}
                                        </div>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function ShiftCube({ shift, staffRole, staffScheduleSide, isMinor, canEdit, onDelete, isEn, compact, currentStaffName, onOfferShift, onCancelOffer, draggable, isDoubleDay, dayShiftCount }) {
    const colors = roleColors(staffRole);
    const warnings = isMinor ? minorShiftWarnings(shift, isEn) : [];
    const hasWarning = warnings.length > 0;
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
            title={auditLines.join('\n') || undefined}
            className={`schedule-shift-cube relative rounded ${shift.published === false ? 'border-2 border-dashed border-gray-400 opacity-75' : 'border'} ${hasWarning ? 'border-amber-500 border-2' : colors.border} ${isOffered ? 'ring-2 ring-blue-400 opacity-80' : ''} ${isPending ? 'ring-2 ring-purple-400' : ''} ${colors.bg} ${colors.text} px-1.5 py-1 ${compact ? 'text-[10px] leading-tight' : 'text-xs'} ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}>
            <div className="font-bold">{formatTime12h(shift.startTime)}–{formatTime12h(shift.endTime)}</div>
            <div className="opacity-80">
                {formatHours(hours)}
                {shift.isShiftLead && <span title="Shift Lead this shift" className="ml-0.5">🛡️</span>}
                {shift.isDouble && <span title="Double shift" className="ml-0.5">⏱</span>}
                {isAutoDouble && <span title={isEn ? "Double day — two shifts. 1h unpaid break deducted from total." : "Día doble — dos turnos. Se resta 1h de descanso del total."} className="ml-0.5">🔁</span>}
            </div>
            {isAutoDouble && !compact && (
                <div className="text-[9px] mt-0.5 font-bold text-blue-700">🔁 {isEn ? 'Double day' : 'Día doble'}</div>
            )}
            {shift.published === false && <div className="text-[9px] mt-0.5 font-bold text-gray-600">📝 {isEn ? 'Draft' : 'Borrador'}</div>}
            {isCrossSide && <div className="text-[9px] mt-0.5 font-bold text-amber-700">🔀 {isEn ? `Cross-side (${shift.side?.toUpperCase()})` : `Lado cruzado (${shift.side?.toUpperCase()})`}</div>}
            {isOffered && <div className="text-[9px] mt-0.5 font-bold text-blue-700">📣 {isEn ? 'Up for grabs' : 'Disponible'}</div>}
            {isPending && <div className="text-[9px] mt-0.5 font-bold text-purple-700">⏳ {isEn ? 'Pending swap to' : 'Cambio pendiente a'} {shift.pendingClaimBy}</div>}
            {shift.notes && !compact && (
                <div className="text-[10px] mt-0.5 italic opacity-80 truncate">{shift.notes}</div>
            )}
            {hasWarning && (
                <div className="text-[9px] mt-0.5 font-bold text-amber-700">⚠ {warnings.join(' • ')}</div>
            )}
            {/* Offer / cancel-offer buttons (own-shift only, not when pending) */}
            {isMine && !isPending && onOfferShift && (
                <button onClick={(e) => { e.stopPropagation(); isOffered ? onCancelOffer(shift) : onOfferShift(shift); }}
                    className={`mt-1 w-full text-[9px] font-bold px-1 py-0.5 rounded print:hidden ${isOffered ? 'bg-gray-200 text-gray-700' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                    {isOffered ? (isEn ? 'Cancel offer' : 'Cancelar') : (isEn ? '📣 Give up' : '📣 Liberar')}
                </button>
            )}
            {canEdit && (
                <button onClick={(e) => { e.stopPropagation(); onDelete(shift.id); }}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none hover:bg-red-600 print:hidden">
                    ×
                </button>
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
                            className={`py-1.5 rounded text-center transition ${isSelected ? 'bg-mint-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                            <div className="text-[10px] uppercase">{dayLabels[i]}</div>
                            <div className="text-sm font-bold">{d.getDate()}</div>
                        </button>
                    );
                })}
            </div>

            <h3 className="text-base font-bold text-mint-700 mb-2">
                {dayLabelsFull[selectedDayIdx]} • {dayShifts.length} {isEn ? 'shifts' : 'turnos'}
            </h3>

            {dayShifts.length === 0 ? (
                <p className="text-center text-gray-400 py-4 text-sm">{isEn ? 'No shifts scheduled.' : 'Sin turnos programados.'}</p>
            ) : (
                <div className="space-y-1">
                    {dayShifts.map(sh => {
                        const staff = staffByName.get(sh.staffName);
                        const dayCount = dayShiftCountByStaff.get(sh.staffName) || 1;
                        return (
                            <DayRow key={sh.id} shift={sh} staffRole={staff?.role} isMinor={!!staff?.isMinor}
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

function DayRow({ shift, staffRole, isMinor, isCurrentStaff, canEdit, onDelete, isEn, currentStaffName, onOfferShift, onCancelOffer, dayShiftCount }) {
    const warnings = isMinor ? minorShiftWarnings(shift, isEn) : [];
    const colors = roleColors(staffRole);
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
        <div className={`flex items-center justify-between p-2 rounded border-2 ${colors.border} ${isCurrentStaff ? 'bg-green-50' : colors.bg} ${warnings.length ? 'ring-2 ring-amber-400' : ''} ${isOffered ? 'ring-2 ring-blue-400' : ''} ${isPending ? 'ring-2 ring-purple-400' : ''}`}>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                    <span className={`font-bold ${isCurrentStaff ? 'text-green-800' : colors.text}`}>
                        {isCurrentStaff && '✓ '}{shift.staffName}
                    </span>
                    {staffRole && <span className={`text-[10px] font-semibold ${colors.text} opacity-70`}>· {staffRole}</span>}
                    {shift.isShiftLead && <span title="Shift Lead">🛡️</span>}
                    {shift.isDouble && <span title="Double shift">⏱</span>}
                    {isAutoDouble && <span title={isEn ? "Double day — two shifts. 1h unpaid break deducted from total." : "Día doble — dos turnos. Se resta 1h de descanso del total."} className="text-[10px] font-bold text-blue-700">🔁 {isEn ? 'Double day' : 'Día doble'}</span>}
                    {isOffered && <span className="text-[10px] font-bold text-blue-700">📣 {isEn ? 'Up for grabs' : 'Disponible'}</span>}
                    {isPending && <span className="text-[10px] font-bold text-purple-700">⏳ {isEn ? 'Pending' : 'Pendiente'}: {shift.pendingClaimBy}</span>}
                </div>
                <div className="text-xs text-gray-700">
                    {formatTime12h(shift.startTime)} – {formatTime12h(shift.endTime)}
                    <span className="ml-2 font-semibold">{formatHours(hours)}</span>
                    {shift.notes && <span className="italic ml-2">"{shift.notes}"</span>}
                </div>
                {warnings.length > 0 && (
                    <div className="text-[10px] font-bold text-amber-700 mt-0.5">⚠ {warnings.join(' • ')}</div>
                )}
            </div>
            <div className="flex items-center gap-1 print:hidden">
                {isMine && !isPending && onOfferShift && (
                    <button onClick={() => isOffered ? onCancelOffer(shift) : onOfferShift(shift)}
                        className={`px-2 py-1 text-xs rounded font-bold ${isOffered ? 'bg-gray-200 text-gray-700' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                        {isOffered ? (isEn ? 'Cancel' : 'Cancelar') : (isEn ? '📣 Give up' : '📣 Liberar')}
                    </button>
                )}
                {canEdit && (
                    <button onClick={() => onDelete(shift.id)}
                        className="px-2 py-1 text-xs rounded bg-red-100 text-red-700 hover:bg-red-200">
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
            <div className="flex gap-2 mb-2 text-xs print:hidden">
                <select value={sortKey} onChange={e => setSortKey(e.target.value)}
                    className="border border-gray-300 rounded px-2 py-1">
                    <option value="date">{isEn ? 'Sort: Date' : 'Ordenar: Fecha'}</option>
                    <option value="staff">{isEn ? 'Sort: Staff' : 'Ordenar: Personal'}</option>
                </select>
                <select value={filterStaff} onChange={e => setFilterStaff(e.target.value)}
                    className="border border-gray-300 rounded px-2 py-1 flex-1">
                    <option value="">{isEn ? 'All staff' : 'Todo el personal'}</option>
                    {allStaff.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
            </div>
            {sorted.length === 0 ? (
                <p className="text-center text-gray-400 py-4 text-sm">{isEn ? 'No shifts.' : 'Sin turnos.'}</p>
            ) : (
                <div className="space-y-1">
                    {sorted.map(sh => {
                        const date = parseLocalDate(sh.date);
                        const dayName = date ? (isEn ? DAYS_EN : DAYS_ES)[date.getDay()] : '';
                        const isMine = sh.staffName === currentStaffName;
                        const staff = staffByName.get(sh.staffName);
                        const warnings = staff?.isMinor ? minorShiftWarnings(sh, isEn) : [];
                        const colors = roleColors(staff?.role);
                        const dayCount = dayShiftCountByCell.get(`${sh.staffName}|${sh.date}`) || 1;
                        const isAutoDouble = dayCount >= 2;
                        const hours = isAutoDouble
                            ? hoursBetween(sh.startTime, sh.endTime, false)
                            : hoursBetween(sh.startTime, sh.endTime, sh.isDouble);
                        return (
                            <div key={sh.id} className={`flex items-center justify-between gap-2 p-2 rounded border-2 text-xs ${isMine ? 'bg-green-50 border-green-300' : `${colors.bg} ${colors.border}`}`}>
                                <div className="text-center w-12 flex-shrink-0">
                                    <div className="text-[10px] uppercase text-gray-500">{dayName}</div>
                                    <div className="text-sm font-bold text-gray-700">{date ? date.getDate() : ''}</div>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1">
                                        <span className={`font-bold truncate ${isMine ? 'text-green-800' : colors.text}`}>{sh.staffName}</span>
                                        {staff?.role && <span className={`text-[10px] opacity-70 ${colors.text}`}>· {staff.role}</span>}
                                        {sh.isShiftLead && <span>🛡️</span>}
                                        {sh.isDouble && <span>⏱</span>}
                                        {isAutoDouble && <span title={isEn ? 'Double day' : 'Día doble'} className="text-blue-700 font-bold">🔁</span>}
                                    </div>
                                    <div className="text-gray-700">
                                        {formatTime12h(sh.startTime)}–{formatTime12h(sh.endTime)}
                                        <span className="ml-2 font-semibold">{formatHours(hours)}</span>
                                    </div>
                                    {warnings.length > 0 && <div className="text-amber-700 font-bold">⚠ {warnings.join(' • ')}</div>}
                                </div>
                                <div className="flex items-center gap-1 print:hidden">
                                    {sh.staffName === currentStaffName && sh.offerStatus !== 'pending' && onOfferShift && (
                                        <button onClick={() => sh.offerStatus === 'open' ? onCancelOffer(sh) : onOfferShift(sh)}
                                            className={`px-2 py-1 rounded font-bold ${sh.offerStatus === 'open' ? 'bg-gray-200 text-gray-700' : 'bg-blue-600 text-white'}`}>
                                            {sh.offerStatus === 'open' ? (isEn ? 'Cancel' : 'Cancelar') : '📣'}
                                        </button>
                                    )}
                                    {canEdit && (
                                        <button onClick={() => onDeleteShift(sh.id)}
                                            className="px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200">×</button>
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
function SwapPanels({ shifts, staffName, canEdit, isEn, onTake, onCancelOffer, onApprove, onDeny, storeLocation, timeOff, onApprovePto, onDenyPto }) {
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

    return (
        <div className="mb-3 space-y-2 print:hidden">
            {/* My own open offers — gentle reminder this is still mine */}
            {myOpenOffers.length > 0 && (
                <div className="rounded-lg p-2 bg-blue-50 border border-blue-300 text-xs">
                    <div className="font-bold text-blue-800 mb-1">📣 {tx('Your offered shifts (still your responsibility)', 'Tus turnos ofrecidos (siguen siendo tu responsabilidad)')}</div>
                    {myOpenOffers.map(sh => (
                        <div key={sh.id} className="flex items-center justify-between gap-2 mt-1">
                            <span className="text-blue-900">{renderShiftLine(sh)}</span>
                            <button onClick={() => onCancelOffer(sh)}
                                className="px-2 py-0.5 rounded bg-white border border-blue-300 text-blue-700 font-bold">{tx('Cancel offer', 'Cancelar oferta')}</button>
                        </div>
                    ))}
                </div>
            )}

            {/* Open shifts up for grabs (others can take) */}
            {openOffers.length > 0 && (
                <div className="rounded-lg p-2 bg-blue-50 border-2 border-blue-400 text-xs">
                    <div className="font-bold text-blue-900 mb-1">📣 {tx('Shifts available to pick up', 'Turnos disponibles para tomar')}</div>
                    {openOffers.map(sh => (
                        <div key={sh.id} className="flex items-center justify-between gap-2 mt-1 bg-white rounded p-1.5 border border-blue-200">
                            <div className="min-w-0">
                                <div className="font-bold text-gray-800">{sh.staffName}</div>
                                <div className="text-gray-600">{renderShiftLine(sh)}</div>
                            </div>
                            <button onClick={() => onTake(sh)}
                                className="px-2 py-1 rounded bg-blue-600 text-white font-bold whitespace-nowrap">{tx('Take', 'Tomar')}</button>
                        </div>
                    ))}
                </div>
            )}

            {/* Manager / admin pending approval queue */}
            {pending.length > 0 && (
                <div className="rounded-lg p-2 bg-purple-50 border-2 border-purple-400 text-xs">
                    <div className="font-bold text-purple-900 mb-1">⏳ {tx('Pending swap approvals', 'Cambios pendientes de aprobar')} ({pending.length})</div>
                    {pending.map(sh => (
                        <div key={sh.id} className="bg-white rounded p-1.5 border border-purple-200 mt-1">
                            <div className="text-gray-800">
                                <b>{sh.staffName}</b> → <b className="text-purple-800">{sh.pendingClaimBy}</b>
                            </div>
                            <div className="text-gray-600">{renderShiftLine(sh)}</div>
                            <div className="flex gap-1 mt-1">
                                <button onClick={() => onApprove(sh)}
                                    className="flex-1 px-2 py-1 rounded bg-green-600 text-white font-bold">✓ {tx('Approve', 'Aprobar')}</button>
                                <button onClick={() => onDeny(sh)}
                                    className="flex-1 px-2 py-1 rounded bg-gray-200 text-gray-700 font-bold">✕ {tx('Deny', 'Negar')}</button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* My PTO requests (status visible to me) */}
            {myPto.length > 0 && (
                <div className="rounded-lg p-2 bg-amber-50 border border-amber-300 text-xs">
                    <div className="font-bold text-amber-800 mb-1">🌴 {tx('My time-off requests', 'Mis solicitudes de tiempo libre')}</div>
                    {myPto.map(t => (
                        <div key={t.id} className="flex items-center justify-between gap-2 mt-1 bg-white rounded p-1.5 border border-amber-200">
                            <div className="min-w-0">
                                <div className="text-gray-700">{renderPtoLine(t)}</div>
                            </div>
                            <span className={`px-2 py-0.5 rounded-full font-bold whitespace-nowrap ${
                                t.status === 'approved' ? 'bg-green-200 text-green-900' :
                                t.status === 'denied' ? 'bg-red-200 text-red-900' :
                                'bg-yellow-200 text-yellow-900'
                            }`}>
                                {t.status === 'approved' ? '✅ ' + tx('Approved', 'Aprobado') :
                                 t.status === 'denied'   ? '❌ ' + tx('Denied', 'Negado') :
                                                           '⏳ ' + tx('Pending', 'Pendiente')}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* Manager / admin pending PTO queue */}
            {canEdit && pendingPto.length > 0 && (
                <div className="rounded-lg p-2 bg-amber-50 border-2 border-amber-500 text-xs">
                    <div className="font-bold text-amber-900 mb-1">🌴 {tx('Pending time-off requests', 'Solicitudes de tiempo libre pendientes')} ({pendingPto.length})</div>
                    {pendingPto.map(t => (
                        <div key={t.id} className="bg-white rounded p-1.5 border border-amber-300 mt-1">
                            <div className="font-bold text-gray-800">{t.staffName}</div>
                            <div className="text-gray-600">{renderPtoLine(t)}</div>
                            <div className="flex gap-1 mt-1">
                                <button onClick={() => onApprovePto(t)}
                                    className="flex-1 px-2 py-1 rounded bg-green-600 text-white font-bold">✓ {tx('Approve', 'Aprobar')}</button>
                                <button onClick={() => onDenyPto(t)}
                                    className="flex-1 px-2 py-1 rounded bg-gray-200 text-gray-700 font-bold">✕ {tx('Deny', 'Negar')}</button>
                            </div>
                        </div>
                    ))}
                </div>
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
        <div className="mt-6 pt-4 border-t border-gray-200">
            <h3 className="text-sm font-bold text-gray-700 mb-2">
                {isEn ? 'Weekly Hours' : 'Horas Semanales'} ({scheduled.length})
            </h3>
            {overtime.length > 0 && (
                <div className="mb-2 p-2 rounded bg-red-50 border border-red-200 text-xs text-red-800">
                    🚨 <b>{overtime.length}</b> {isEn ? 'staff at/over 40 hrs (overtime triggered)' : 'personas en/sobre 40 hrs (tiempo extra activado)'}: {overtime.map(s => s.name).join(', ')}
                </div>
            )}
            {minorOver.length > 0 && (
                <div className="mb-2 p-2 rounded bg-amber-50 border border-amber-300 text-xs text-amber-800">
                    ⚠ <b>{minorOver.length}</b> {isEn ? `minor(s) over ${MINOR_WEEKLY_HOURS_MAX} hrs/week:` : `menor(es) sobre ${MINOR_WEEKLY_HOURS_MAX} hrs/semana:`} {minorOver.map(s => s.name).join(', ')}
                </div>
            )}
            <div className="grid grid-cols-2 gap-1.5">
                {scheduled.map(s => (
                    <div key={s.id || s.name} className={`flex items-center justify-between gap-2 p-1.5 rounded border text-xs ${s.name === currentStaffName ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200'}`}>
                        <span className="font-semibold truncate">
                            {s.name === currentStaffName && '✓ '}
                            {s.name}
                            {s.isMinor && <span className="ml-1">🔑</span>}
                        </span>
                        <span className={`flex-shrink-0 px-1.5 py-0.5 rounded border font-bold ${hoursColor(s.totalHours)}`}>
                            {formatHours(s.totalHours)}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── Add Shift Modal ────────────────────────────────────────────────────────

function AddShiftModal({ onClose, onSave, staffList, storeLocation, isEn, prefill, weekStart, dateClosed, existingShifts }) {
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
    const SHIFT_PRESETS = presetSide === 'boh'
        ? [
            { label: '10–8 (double)', start: '10:00', end: '20:00', isDouble: true },
            { label: '10–3', start: '10:00', end: '15:00', isDouble: false },
            { label: '4–8',  start: '16:00', end: '20:00', isDouble: false },
        ]
        : [
            { label: '10–3', start: '10:00', end: '15:00', isDouble: false },
            { label: '3–8',  start: '15:00', end: '20:00', isDouble: false },
            { label: '4–8',  start: '16:00', end: '20:00', isDouble: false },
            { label: '12–7', start: '12:00', end: '19:00', isDouble: false },
            { label: '10–8 (double)', start: '10:00', end: '20:00', isDouble: true },
        ];
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
    const canSubmit = form.staffName && form.date && form.startTime && form.endTime && hours > 0 && !isOnClosedDate;

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto">
                <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-mint-700">+ {tx('Add Shift', 'Agregar Turno')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
                </div>

                <div className="p-4 space-y-3">
                    {/* Staff */}
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Staff', 'Personal')}</label>
                        <select value={form.staffName} onChange={e => updateField('staffName', e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
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
                            <label className="text-xs font-bold text-gray-700 block mb-1">
                                {tx('Working side this shift', 'Lado de este turno')}
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <button type="button" onClick={() => updateField('side', 'foh')}
                                    className={`py-2 rounded-lg text-sm font-bold border ${
                                        presetSide === 'foh'
                                            ? 'bg-teal-600 text-white border-teal-600'
                                            : 'bg-white text-gray-700 border-gray-300'
                                    }`}>
                                    🧑‍💼 FOH {staffDefaultSide === 'foh' ? `(${tx('home', 'casa')})` : ''}
                                </button>
                                <button type="button" onClick={() => updateField('side', 'boh')}
                                    className={`py-2 rounded-lg text-sm font-bold border ${
                                        presetSide === 'boh'
                                            ? 'bg-orange-600 text-white border-orange-600'
                                            : 'bg-white text-gray-700 border-gray-300'
                                    }`}>
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
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Date', 'Fecha')}</label>
                        <input type="date" value={form.date} onChange={e => updateField('date', e.target.value)}
                            min={toDateStr(addDays(weekStart, -14))}
                            max={toDateStr(addDays(weekStart, 28))}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>

                    {/* Quick presets — tap to fill start/end. Preset list adapts to FOH/BOH. */}
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Quick presets', 'Presets rápidos')}</label>
                        <div className="flex flex-wrap gap-1.5">
                            {SHIFT_PRESETS.map(p => (
                                <button key={p.label} type="button"
                                    onClick={() => setForm(f => ({ ...f, startTime: p.start, endTime: p.end, isDouble: !!p.isDouble }))}
                                    className={`px-2.5 py-1 rounded-md text-[11px] font-bold border ${
                                        isPresetActive(p)
                                            ? 'bg-mint-700 text-white border-mint-700'
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
                            <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Start', 'Inicio')}</label>
                            <input type="time" value={form.startTime} onChange={e => updateField('startTime', e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </div>
                        <div>
                            <label className="text-xs font-bold text-gray-700 block mb-1">{tx('End', 'Fin')}</label>
                            <input type="time" value={form.endTime} onChange={e => updateField('endTime', e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
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
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Location', 'Ubicación')}</label>
                        <div className="grid grid-cols-2 gap-2">
                            {['webster', 'maryland'].map(loc => (
                                <button key={loc} onClick={() => updateField('location', loc)}
                                    className={`py-2 rounded-lg text-sm font-bold border ${form.location === loc ? 'bg-mint-700 text-white border-mint-700' : 'bg-white text-gray-700 border-gray-300'}`}>
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
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Notes (optional)', 'Notas (opcional)')}</label>
                        <input type="text" value={form.notes} onChange={e => updateField('notes', e.target.value)}
                            placeholder={tx('e.g. catering, training', 'p.ej. catering, capacitación')}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>

                    {/* Minor warning */}
                    {minorWarnings.length > 0 && (
                        <div className="p-2 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-900">
                            ⚠ <b>{tx('Minor labor flag:', 'Aviso de menor:')}</b> {minorWarnings.join(' • ')}
                        </div>
                    )}

                    {/* Closed-date guard */}
                    {isOnClosedDate && (
                        <div className="p-2 rounded-lg bg-gray-200 border border-gray-400 text-xs text-gray-800">
                            🚫 <b>{tx('Restaurant closed', 'Restaurante cerrado')}</b> {tx('on this date — pick another.', 'en esta fecha — elige otra.')}
                        </div>
                    )}
                </div>

                <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 flex gap-2">
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">{tx('Cancel', 'Cancelar')}</button>
                    <button onClick={() => {
                        if (!canSubmit) return;
                        // If the manager never tapped the side toggle, default to
                        // the staff's home side. This way every saved shift carries
                        // an explicit side field.
                        const finalSide = form.side || staffDefaultSide || 'foh';
                        onSave({ ...form, side: finalSide });
                    }} disabled={!canSubmit}
                        className={`flex-1 py-2 rounded-lg font-bold text-white ${canSubmit ? 'bg-mint-700 hover:bg-mint-800' : 'bg-gray-300'}`}>
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
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto">
                <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-gray-800">🚫 {tx('Date Blackouts', 'Bloqueos de Fechas')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
                </div>

                <div className="p-4 space-y-3">
                    <div className="text-xs text-gray-600 leading-relaxed bg-gray-50 rounded-lg p-2 border border-gray-200">
                        <b>{tx('Closed', 'Cerrado')}</b> = {tx('restaurant is not open. No shifts can be scheduled.', 'restaurante no está abierto. No se pueden agendar turnos.')}<br/>
                        <b>{tx('No time off', 'Sin tiempo libre')}</b> = {tx('restaurant is open, but no PTO requests will be approved (busy season, holidays, special events).', 'restaurante está abierto, pero no se aprobará tiempo libre (temporada alta, días feriados, eventos especiales).')}
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
                                🛑 {tx('No PTO', 'Sin PTO')}
                            </button>
                        </div>
                        <input type="date" value={form.date} onChange={e => update('date', e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        <select value={form.location} onChange={e => update('location', e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                            <option value="both">{LOCATION_LABELS.both}</option>
                            <option value="webster">{LOCATION_LABELS.webster}</option>
                            <option value="maryland">{LOCATION_LABELS.maryland}</option>
                        </select>
                        <input type="text" value={form.reason} onChange={e => update('reason', e.target.value)}
                            placeholder={tx('Reason (e.g. Christmas Day)', 'Razón (ej. Navidad)')}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        <button onClick={() => canSubmit && onAdd(form)} disabled={!canSubmit}
                            className={`w-full py-2 rounded-lg font-bold text-white ${canSubmit ? 'bg-mint-700 hover:bg-mint-800' : 'bg-gray-300'}`}>
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
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
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
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                            <option value="">{tx("— Staff —", "— Personal —")}</option>
                            {sortedStaff.map(s => <option key={s.id || s.name} value={s.name}>{s.name}</option>)}
                        </select>
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="text-[10px] text-gray-500 block">{tx("From", "Desde")}</label>
                                <input type="date" value={form.startDate} onChange={e => update("startDate", e.target.value)}
                                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                            </div>
                            <div>
                                <label className="text-[10px] text-gray-500 block">{tx("To", "Hasta")}</label>
                                <input type="date" value={form.endDate} onChange={e => update("endDate", e.target.value)}
                                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                            </div>
                        </div>
                        <input type="text" value={form.reason} onChange={e => update("reason", e.target.value)}
                            placeholder={tx("Reason (e.g. vacation, sick)", "Razón (ej. vacaciones, enfermo)")}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
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
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
                </div>
                <div className="p-4 space-y-3">
                    <div className="text-xs text-gray-600 bg-amber-50 rounded-lg p-2 border border-amber-200">
                        {tx('Submitting as:', 'Enviando como:')} <b>{staffName}</b>. {tx('Your manager will approve or deny.', 'Tu gerente aprobará o negará.')}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-xs font-bold text-gray-700 block mb-1">{tx('From', 'Desde')}</label>
                            <input type="date" value={form.startDate} onChange={e => update('startDate', e.target.value)}
                                min={today}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </div>
                        <div>
                            <label className="text-xs font-bold text-gray-700 block mb-1">{tx('To', 'Hasta')}</label>
                            <input type="date" value={form.endDate} onChange={e => update('endDate', e.target.value)}
                                min={form.startDate}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </div>
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Reason', 'Razón')}</label>
                        <input type="text" value={form.reason} onChange={e => update('reason', e.target.value)}
                            placeholder={tx('e.g. vacation, family, doctor', 'p.ej. vacaciones, familia, doctor')}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
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
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    <p className="text-xs text-gray-500 mb-1">{tx("This is when you're available to work each week. Auto-fill uses this.", 'Cuándo estás disponible para trabajar cada semana. Auto-rellenar lo usa.')}</p>
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
function AvailableStaffModal({ dateStr, onClose, sideStaff, shifts, storeLocation, isStaffOffOn, isEn, onSchedule, requiredRoleGroup }) {
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
        // Already scheduled this day?
        const alreadyOnDay = shifts.some(sh => sh.staffName === s.name && sh.date === dateStr
            && (storeLocation === 'both' || sh.location === storeLocation));
        // Availability for this weekday
        const dayAvail = (s.availability || {})[dayKey];
        const availableThisDay = dayAvail && dayAvail.available !== false && dayAvail.from && dayAvail.to;
        // PTO?
        const onPto = isStaffOffOn(s.name, dateStr);

        let status = 'available';
        let reason = '';
        if (onPto) { status = 'pto'; reason = tx('on time-off', 'tiempo libre'); }
        else if (alreadyOnDay) { status = 'scheduled'; reason = tx('already scheduled', 'ya programado'); }
        else if (!availableThisDay) { status = 'unavailable'; reason = tx('not available this day', 'no disponible este día'); }

        return { ...s, weeklyHours, status, reason, dayAvail };
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
                    <div>
                        <h3 className="text-lg font-bold text-mint-700">👥 {tx('Who can work?', '¿Quién puede trabajar?')}</h3>
                        <p className="text-xs text-gray-500">
                            {dayName} · {dateStr}
                            {requiredGroup && requiredGroup.id !== 'any' && (
                                <span className="ml-2 inline-block px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800 text-[10px] font-bold">
                                    {requiredGroup.emoji} {tx(requiredGroup.labelEn, requiredGroup.labelEs)} {tx('only', 'solo')}
                                </span>
                            )}
                        </p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
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
                                        className="w-full flex items-center justify-between gap-2 p-2 rounded-lg border bg-white hover:bg-mint-50 hover:border-mint-300 text-left">
                                        <div className="min-w-0 flex-1">
                                            <div className="font-bold text-gray-800 truncate flex items-center gap-1">
                                                {r.name}
                                                {r.shiftLead && <span title="Shift Lead">🛡️</span>}
                                                {r.isMinor && <span title="Minor">🔑</span>}
                                            </div>
                                            <div className="text-[10px] text-gray-500">
                                                {r.role} · {tx('Avail', 'Disp')} {r.dayAvail?.from}–{r.dayAvail?.to}
                                                {r.targetHours ? ` · ${tx('target', 'objetivo')} ${r.targetHours}h` : ''}
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
    return (
        <div className="fixed inset-0 bg-black/40 z-50 flex justify-end" onClick={onClose}>
            <div className="bg-white w-full max-w-sm h-full overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-mint-700">🔔 {tx('Notifications', 'Notificaciones')}</h3>
                    <div className="flex items-center gap-2">
                        {notifications.some(n => !n.read) && (
                            <button onClick={onMarkAllRead}
                                className="text-xs text-mint-700 underline">{tx('Mark all read', 'Marcar todo')}</button>
                        )}
                        <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
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
                            className={`p-3 rounded-lg border cursor-pointer ${n.read ? 'bg-white border-gray-200' : 'bg-mint-50 border-mint-300'}`}>
                            <div className="flex items-start gap-2">
                                <span className="text-xl flex-shrink-0">{iconFor(n.type)}</span>
                                <div className="min-w-0 flex-1">
                                    <div className={`font-bold text-sm ${n.read ? 'text-gray-700' : 'text-mint-800'}`}>{n.title}</div>
                                    <div className="text-xs text-gray-600 mt-0.5">{n.body}</div>
                                    <div className="text-[10px] text-gray-400 mt-1">{fmtTime(n.createdAt)}</div>
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
    const canSubmit = form.date && form.startTime && form.endTime && form.count >= 1 && form.startTime < form.endTime;
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
                <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
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
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Date', 'Fecha')}</label>
                        <input type="date" value={form.date} onChange={e => update('date', e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Side', 'Lado')}</label>
                        <div className="grid grid-cols-2 gap-2">
                            <button onClick={() => update('side', 'foh')}
                                className={`py-2 rounded-lg text-sm font-bold border ${form.side === 'foh' ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-gray-700 border-gray-300'}`}>FOH</button>
                            <button onClick={() => update('side', 'boh')}
                                className={`py-2 rounded-lg text-sm font-bold border ${form.side === 'boh' ? 'bg-orange-600 text-white border-orange-600' : 'bg-white text-gray-700 border-gray-300'}`}>BOH</button>
                        </div>
                    </div>
                    {/* Common time presets — tap to fill start/end */}
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Quick presets', 'Presets rápidos')}</label>
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
                            <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Start', 'Inicio')}</label>
                            <input type="time" value={form.startTime} onChange={e => update('startTime', e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </div>
                        <div>
                            <label className="text-xs font-bold text-gray-700 block mb-1">{tx('End', 'Fin')}</label>
                            <input type="time" value={form.endTime} onChange={e => update('endTime', e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </div>
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('How many people?', '¿Cuántas personas?')}</label>
                        <input type="number" min="1" max="20" value={form.count}
                            onChange={e => update('count', Math.max(1, parseInt(e.target.value) || 1))}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        {isEditing && (initial.filledStaff || []).length > 0 && (
                            <p className="text-[10px] text-amber-700 mt-1">
                                {tx(`⚠ ${(initial.filledStaff || []).length} already assigned. Lowering below this won't unassign — remove individually.`,
                                   `⚠ ${(initial.filledStaff || []).length} ya asignados. Bajar la cuenta no los quitará — quítalos individualmente.`)}
                            </p>
                        )}
                    </div>
                    {/* Role filter — restricts who can fill the slot */}
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Role required', 'Rol requerido')}</label>
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
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Location', 'Ubicación')}</label>
                        <div className="grid grid-cols-2 gap-2">
                            {['webster', 'maryland'].map(loc => (
                                <button key={loc} onClick={() => update('location', loc)}
                                    className={`py-2 rounded-lg text-sm font-bold border ${form.location === loc ? 'bg-mint-700 text-white border-mint-700' : 'bg-white text-gray-700 border-gray-300'}`}>
                                    {LOCATION_LABELS[loc]}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Notes (e.g. "morning crew")', 'Notas (ej. "equipo de mañana")')}</label>
                        <input type="text" value={form.notes} onChange={e => update('notes', e.target.value)}
                            placeholder={tx('Optional label', 'Etiqueta opcional')}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>
                </div>
                <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 flex gap-2">
                    <button onClick={onClose} className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">{tx('Cancel', 'Cancelar')}</button>
                    <button onClick={handleSave} disabled={!canSubmit}
                        className={`flex-1 py-2 rounded-lg font-bold text-white ${canSubmit ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-300'}`}>
                        {isEditing ? tx('Save Changes', 'Guardar Cambios') : tx('Save Need', 'Guardar Necesidad')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── FillSlotChooserModal ──────────────────────────────────────────────────
// When manager clicks "+" on a staff cell and there are open slots that staff
// can fill, this modal pops up first. Shows the matching slots with one-tap
// "Assign here" buttons, plus a "custom shift instead" fallback.
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
                        className="w-full py-2 rounded-lg bg-mint-600 text-white font-bold text-sm hover:bg-mint-700">
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
function TemplateEditorModal({ initial, onClose, onSave, storeLocation, side, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    const [tpl, setTpl] = useState(() => initial || {
        name: "",
        side: side,
        location: storeLocation && storeLocation !== "both" ? storeLocation : "webster",
        blocks: [
            { label: tx("Morning", "Mañana"), startTime: "09:00", endTime: "15:00", slots: [{ roleGroup: "foh-staff", count: 3 }] },
        ],
    });
    const update = (k, v) => setTpl(t => ({ ...t, [k]: v }));
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

    const canSave = tpl.name.trim() && tpl.blocks.length > 0 && tpl.blocks.every(b => b.startTime && b.endTime && b.startTime < b.endTime && b.slots.length > 0);

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
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx("Template name", "Nombre")}</label>
                        <input type="text" value={tpl.name} onChange={e => update("name", e.target.value)}
                            placeholder={tx("e.g. Friday FOH, Sunday Brunch", "ej. Viernes FOH")}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="text-xs font-bold text-gray-700 block mb-1">{tx("Side", "Lado")}</label>
                            <div className="grid grid-cols-2 gap-1">
                                <button onClick={() => update("side", "foh")} className={`py-1.5 rounded-md text-xs font-bold border ${tpl.side === "foh" ? "bg-teal-600 text-white border-teal-600" : "bg-white text-gray-600 border-gray-300"}`}>FOH</button>
                                <button onClick={() => update("side", "boh")} className={`py-1.5 rounded-md text-xs font-bold border ${tpl.side === "boh" ? "bg-orange-600 text-white border-orange-600" : "bg-white text-gray-600 border-gray-300"}`}>BOH</button>
                            </div>
                        </div>
                        <div>
                            <label className="text-xs font-bold text-gray-700 block mb-1">{tx("Location", "Ubicación")}</label>
                            <select value={tpl.location} onChange={e => update("location", e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs">
                                <option value="webster">{LOCATION_LABELS.webster}</option>
                                <option value="maryland">{LOCATION_LABELS.maryland}</option>
                                <option value="both">{LOCATION_LABELS.both}</option>
                            </select>
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
                                            <input type="number" min="1" max="20" value={slot.count}
                                                onChange={e => updateSlot(bi, si, "count", Math.max(1, parseInt(e.target.value) || 1))}
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
                <div className="border-t border-gray-200 p-3 flex gap-2">
                    <button onClick={onClose} className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">{tx("Cancel", "Cancelar")}</button>
                    <button onClick={() => canSave && onSave(tpl)} disabled={!canSave}
                        className={`flex-1 py-2 rounded-lg font-bold text-white ${canSave ? "bg-indigo-600 hover:bg-indigo-700" : "bg-gray-300"}`}>
                        {tx("Save Template", "Guardar Plantilla")}
                    </button>
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
    const [dateStr, setDateStr] = useState(toDateStr(weekStart));
    const filtered = templates.filter(t => t.side === side);
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
                                return (
                                    <div key={t.id} className={`p-2 rounded-lg border-2 ${isPicked ? "border-indigo-500 bg-indigo-50" : "border-gray-200 bg-white"}`}>
                                        <div className="flex items-center justify-between gap-2">
                                            <button onClick={() => setPickedTemplate(t)} className="flex-1 text-left">
                                                <div className="font-bold text-sm text-gray-800">{t.name}</div>
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
                            <div className="text-xs font-bold text-gray-700">{tx("Apply", "Aplicar")} "{pickedTemplate.name}" {tx("to date:", "a fecha:")}</div>
                            <input type="date" value={dateStr} onChange={e => setDateStr(e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                            <button onClick={() => onApply(pickedTemplate, dateStr)}
                                className="w-full py-2 rounded-lg bg-green-600 text-white font-bold text-sm hover:bg-green-700">
                                ✓ {tx("Apply Template", "Aplicar Plantilla")}
                            </button>
                            <p className="text-[10px] text-gray-500 text-center">{tx("Creates one staffing need per role slot. You fill them next.", "Crea una necesidad por slot. Las llenas luego.")}</p>
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
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
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
