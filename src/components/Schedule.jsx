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

    // ── Listen for in-app notifications addressed to me ──
    // Side-effect: when a NEW notification arrives (created in the last 30s)
    // AND the user has granted browser-notification permission, fire a
    // foreground browser notification so they're alerted even if they're
    // looking at another tab. True closed-app push (FCM via Cloud Functions)
    // is a follow-up; this covers app-open + PWA-backgrounded cases.
    const seenNotifIds = useState(() => new Set())[0];
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

    // ── Derived: staff list filtered by location AND current side (FOH/BOH) ──
    // Managers + Owners + Shift Leads appear on BOTH sides automatically via isOnSide().
    const sideStaff = useMemo(() => {
        if (!Array.isArray(staffList)) return [];
        return staffList.filter(s => {
            const locOk = storeLocation === 'both' || s.location === storeLocation || s.location === 'both';
            return locOk && isOnSide(s, side);
        });
    }, [staffList, storeLocation, side]);

    const sideStaffNames = useMemo(() => new Set(sideStaff.map(s => s.name)), [sideStaff]);

    // ── Derived: shifts visible in THIS view (location + side + optional person filter) ──
    const visibleShifts = useMemo(() => {
        return shifts.filter(s => {
            if (storeLocation !== 'both' && s.location !== storeLocation) return false;
            if (personFilter && s.staffName !== personFilter) return false;
            return sideStaffNames.has(s.staffName);
        });
    }, [shifts, storeLocation, sideStaffNames, personFilter]);

    // ── Derived: per-staff weekly hours summary for the current side view ──
    // Hours are calculated over ALL of this staffer's shifts (both sides) — OT
    // is per employee per week regardless of which "side" they worked.
    const staffSummary = useMemo(() => {
        return sideStaff
            .map(s => {
                const allMyShifts = shifts.filter(sh =>
                    sh.staffName === s.name &&
                    (storeLocation === 'both' || sh.location === storeLocation));
                const totalHours = allMyShifts.reduce((sum, sh) =>
                    sum + hoursBetween(sh.startTime, sh.endTime, sh.isDouble), 0);
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
            const savedSide = savedStaff ? resolveStaffSide(savedStaff) : 'foh';
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
            for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
                const dStr = toDateStr(d);
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
        try {
            await updateDoc(doc(db, 'time_off', entry.id), {
                status: 'approved',
                reviewedBy: staffName,
                reviewedAt: serverTimestamp(),
            });
            const range = entry.startDate + (entry.endDate && entry.endDate !== entry.startDate ? ` → ${entry.endDate}` : '');
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
        const days = [0,1,2,3,4,5,6].map(i => addDays(weekStart, i));
        const today = toDateStr(new Date());
        const sideLabel = side === 'foh' ? 'Front of House' : 'Back of House';
        const locLabel = LOCATION_LABELS[storeLocation] || storeLocation;
        const weekRange = `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

        // Build cell HTML for each staff/day
        const escape = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
                else cellHtml = cellShifts.map(sh => {
                    const hrs = hoursBetween(sh.startTime, sh.endTime, sh.isDouble);
                    return `<div class="shift">
                        <b>${escape(formatTime12h(sh.startTime))}–${escape(formatTime12h(sh.endTime))}</b>
                        <span class="hrs">${escape(formatHours(hrs))}</span>
                        ${sh.isShiftLead ? '<span class="lead">🛡️</span>' : ''}
                        ${sh.isDouble ? '<span class="dbl">⏱</span>' : ''}
                        ${sh.notes ? `<div class="notes">${escape(sh.notes)}</div>` : ''}
                    </div>`;
                }).join('');
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
                `DTEND:${fmt(sh.date, sh.endTime)}`,
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
        if (!confirm(tx(
            `Publish ${drafts.length} draft shift(s) for ${side === 'foh' ? 'FOH' : 'BOH'} this week?`,
            `¿Publicar ${drafts.length} turno(s) borrador para ${side === 'foh' ? 'FOH' : 'BOH'} esta semana?`,
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
            const myExisting = visibleShifts.filter(sh => sh.staffName === s.name);
            const existingHours = myExisting.reduce((sum, sh) =>
                sum + hoursBetween(sh.startTime, sh.endTime, sh.isDouble), 0);
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
        <div className="p-4 pb-24 print:p-2 print:pb-0">
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

            {/* Person filter + Print + Add Shift action bar */}
            <div className="flex gap-2 mb-3 print:hidden">
                <select value={personFilter || ''}
                    onChange={(e) => setPersonFilter(e.target.value || null)}
                    className="flex-1 border border-gray-300 rounded-lg px-2 py-2 text-xs">
                    <option value="">{tx('👥 Everyone', '👥 Todos')}</option>
                    {sideStaff.map(s => (
                        <option key={s.id || s.name} value={s.name}>{s.name}</option>
                    ))}
                </select>
                <button onClick={handlePrintWeek}
                    title={tx('Print full week as one-page calendar', 'Imprimir semana completa en una página')}
                    className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 text-xs font-bold">
                    🖨 {tx('Print Week', 'Imprimir Semana')}
                </button>
                <button onClick={handleExportIcs}
                    title={tx('Download .ics — import into Apple/Google/Outlook calendar', 'Descargar .ics — importar a calendario')}
                    className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 text-xs font-bold">
                    📅 {tx('iCal', 'iCal')}
                </button>
                {/* Self-serve buttons (visible to ALL staff) */}
                <button onClick={() => setShowPtoRequestModal(true)}
                    title={tx('Request time off', 'Pedir tiempo libre')}
                    className="px-3 py-2 rounded-lg bg-amber-100 text-amber-800 text-xs font-bold hover:bg-amber-200 border border-amber-300">
                    🌴 {tx('Request Off', 'Pedir Off')}
                </button>
                <button onClick={() => setShowMyAvailModal(true)}
                    title={tx('Set your availability', 'Configura tu disponibilidad')}
                    className="px-3 py-2 rounded-lg bg-purple-100 text-purple-800 text-xs font-bold hover:bg-purple-200 border border-purple-300">
                    🗓 {tx('My Avail', 'Mi Dispon.')}
                </button>
                <button onClick={() => setShowTimeOffModal(true)}
                    title={tx('See all time-off requests', 'Ver todas las solicitudes de tiempo libre')}
                    className="px-3 py-2 rounded-lg bg-amber-100 text-amber-800 text-xs font-bold hover:bg-amber-200 border border-amber-300">
                    🌴 {tx('All PTO', 'Todo PTO')}
                </button>
                {canEdit && (
                    <>
                        <button onClick={handlePublishDrafts}
                            title={tx('Publish all draft shifts in current week + side', 'Publicar todos los borradores de esta semana')}
                            className="px-3 py-2 rounded-lg bg-green-600 text-white text-xs font-bold hover:bg-green-700">
                            📢 {tx('Publish', 'Publicar')}
                        </button>
                        <button onClick={handleAutoPopulate}
                            title={tx('Auto-fill this week from availability + targets', 'Auto-rellenar esta semana')}
                            className="px-3 py-2 rounded-lg bg-purple-600 text-white text-xs font-bold hover:bg-purple-700">
                            ✨ {tx('Auto-fill', 'Auto-rellenar')}
                        </button>
                        <button onClick={handleCopyLastWeek}
                            title={tx('Copy last week into this week as drafts', 'Copiar semana pasada como borradores')}
                            className="px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700">
                            📋 {tx('Copy ⏪', 'Copiar ⏪')}
                        </button>
                        <button onClick={() => setShowBlockModal(true)}
                            title={tx('Manage closed dates / no-time-off dates', 'Gestionar fechas cerradas / sin tiempo libre')}
                            className="px-3 py-2 rounded-lg bg-gray-700 text-white text-xs font-bold hover:bg-gray-800">
                            🚫 {tx('Blackouts', 'Bloqueos')}
                        </button>
                        <button onClick={() => openAddModal()}
                            className="px-3 py-2 rounded-lg bg-mint-700 text-white text-xs font-bold hover:bg-mint-800">
                            + {tx('Shift', 'Turno')}
                        </button>
                    </>
                )}
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
                    {viewMode === 'grid' && (
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
                                openAddModal({ staffName: staff.name, date: dateStr, location: staff.location });
                            }}
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
                    )}
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
                            sideStaffNames={sideStaffNames}
                            isEn={isEn}
                            currentStaffName={staffName}
                            canEdit={canEdit}
                            onApprove={handleApprovePto}
                            onDeny={handleDenyPto}
                            onRemove={handleRemoveTimeOff}
                        />
                    )}

                    {/* Hours summary always visible at bottom */}
                    <HoursSummary staffSummary={staffSummary} isEn={isEn} currentStaffName={staffName} />
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
                    onClose={() => setAvailableForDate(null)}
                    sideStaff={sideStaff}
                    shifts={shifts}
                    storeLocation={storeLocation}
                    isStaffOffOn={isStaffOffOn}
                    isEn={isEn}
                    onSchedule={(staff) => {
                        setAvailableForDate(null);
                        openAddModal({ staffName: staff.name, date: availableForDate, location: staff.location });
                    }}
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

function WeeklyGrid({ weekStart, staffSummary, shifts, isEn, currentStaffName, canEdit, onCellClick, onDeleteShift, onStaffClick, onOfferShift, onTakeShift, onCancelOffer, blocksByDate, onDropShift, isStaffOffOn, onDayHeaderClick, timeOff }) {
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
                            return (
                                <th key={i}
                                    onClick={() => onDayHeaderClick && !closed && onDayHeaderClick(dStr)}
                                    className={`border-b border-gray-200 px-1 py-2 min-w-[110px] ${closed ? 'bg-gray-200' : isToday ? 'bg-mint-50' : ''} ${onDayHeaderClick && !closed ? 'cursor-pointer hover:bg-mint-100' : ''}`}>
                                    <div className={`text-[10px] uppercase font-semibold ${closed ? 'text-gray-600' : isToday ? 'text-mint-700' : 'text-gray-500'}`}>{dayLabels[i]}</div>
                                    <div className={`text-sm font-bold ${closed ? 'text-gray-700' : isToday ? 'text-mint-800' : 'text-gray-700'}`}>{d.getDate()}</div>
                                    {closed && <div className="text-[9px] font-bold text-gray-700 mt-0.5">🚫 {isEn ? 'Closed' : 'Cerrado'}</div>}
                                    {!closed && noTimeoff && <div className="text-[9px] font-bold text-amber-700 mt-0.5">🛑 {isEn ? 'No PTO' : 'Sin PTO'}</div>}
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
                                                <ShiftCube key={sh.id} shift={sh} staffRole={s.role} isMinor={s.isMinor} canEdit={canEdit} onDelete={onDeleteShift} isEn={isEn} compact
                                                    currentStaffName={currentStaffName} onOfferShift={onOfferShift} onCancelOffer={onCancelOffer}
                                                    draggable={canEdit} />
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

function ShiftCube({ shift, staffRole, isMinor, canEdit, onDelete, isEn, compact, currentStaffName, onOfferShift, onCancelOffer, draggable }) {
    const colors = roleColors(staffRole);
    const warnings = isMinor ? minorShiftWarnings(shift, isEn) : [];
    const hasWarning = warnings.length > 0;
    const hours = hoursBetween(shift.startTime, shift.endTime, shift.isDouble);
    const isMine = shift.staffName === currentStaffName;
    const isOffered = shift.offerStatus === 'open';
    const isPending = shift.offerStatus === 'pending';
    return (
        <div
            draggable={!!draggable}
            onDragStart={(e) => {
                if (!draggable) return;
                e.dataTransfer.setData('text/shift-id', shift.id);
                e.dataTransfer.effectAllowed = 'move';
            }}
            className={`schedule-shift-cube relative rounded ${shift.published === false ? 'border-2 border-dashed border-gray-400 opacity-75' : 'border'} ${hasWarning ? 'border-amber-500 border-2' : colors.border} ${isOffered ? 'ring-2 ring-blue-400 opacity-80' : ''} ${isPending ? 'ring-2 ring-purple-400' : ''} ${colors.bg} ${colors.text} px-1.5 py-1 ${compact ? 'text-[10px] leading-tight' : 'text-xs'} ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}>
            <div className="font-bold">{formatTime12h(shift.startTime)}–{formatTime12h(shift.endTime)}</div>
            <div className="opacity-80">
                {formatHours(hours)}
                {shift.isShiftLead && <span title="Shift Lead this shift" className="ml-0.5">🛡️</span>}
                {shift.isDouble && <span title="Double shift" className="ml-0.5">⏱</span>}
            </div>
            {shift.published === false && <div className="text-[9px] mt-0.5 font-bold text-gray-600">📝 {isEn ? 'Draft' : 'Borrador'}</div>}
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
                        return (
                            <DayRow key={sh.id} shift={sh} staffRole={staff?.role} isMinor={!!staff?.isMinor}
                                isCurrentStaff={sh.staffName === currentStaffName}
                                canEdit={canEdit} onDelete={onDeleteShift} isEn={isEn}
                                currentStaffName={currentStaffName}
                                onOfferShift={onOfferShift}
                                onCancelOffer={onCancelOffer} />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function DayRow({ shift, staffRole, isMinor, isCurrentStaff, canEdit, onDelete, isEn, currentStaffName, onOfferShift, onCancelOffer }) {
    const warnings = isMinor ? minorShiftWarnings(shift, isEn) : [];
    const colors = roleColors(staffRole);
    const hours = hoursBetween(shift.startTime, shift.endTime, shift.isDouble);
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
                        const hours = hoursBetween(sh.startTime, sh.endTime, sh.isDouble);
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

function AddShiftModal({ onClose, onSave, staffList, storeLocation, isEn, prefill, weekStart, dateClosed }) {
    const today = toDateStr(new Date());
    const tx = (en, es) => (isEn ? en : es);

    const [form, setForm] = useState({
        staffName: prefill?.staffName || '',
        date: prefill?.date || today,
        startTime: prefill?.startTime || '09:00',
        endTime: prefill?.endTime || '15:00',
        location: prefill?.location && prefill.location !== 'both' ? prefill.location : (storeLocation && storeLocation !== 'both' ? storeLocation : 'webster'),
        isShiftLead: false,
        isDouble: false,
        notes: '',
    });

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
                                    {s.name}{s.isMinor ? ' 🔑' : ''}{s.shiftLead ? ' 🛡️' : ''}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Date */}
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Date', 'Fecha')}</label>
                        <input type="date" value={form.date} onChange={e => updateField('date', e.target.value)}
                            min={toDateStr(addDays(weekStart, -14))}
                            max={toDateStr(addDays(weekStart, 28))}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
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
                    <button onClick={() => canSubmit && onSave(form)} disabled={!canSubmit}
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
function AvailableStaffModal({ dateStr, onClose, sideStaff, shifts, storeLocation, isStaffOffOn, isEn, onSchedule }) {
    const tx = (en, es) => (isEn ? en : es);
    const date = parseLocalDate(dateStr);
    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dayKey = date ? dayKeys[date.getDay()] : null;
    const dayName = date ? (isEn ? DAYS_FULL_EN : DAYS_FULL_ES)[date.getDay()] : '';

    // Compute each staff's weekly hours (across the FLSA week containing dateStr)
    // and their availability state for this specific day.
    const weekStartLocal = date ? startOfWeek(date) : null;
    const rows = sideStaff.map(s => {
        // Total this week's hours
        let weeklyHours = 0;
        if (weekStartLocal) {
            for (let i = 0; i < 7; i++) {
                const d = toDateStr(addDays(weekStartLocal, i));
                const myShifts = shifts.filter(sh => sh.staffName === s.name && sh.date === d
                    && (storeLocation === 'both' || sh.location === storeLocation));
                weeklyHours += myShifts.reduce((sum, sh) =>
                    sum + hoursBetween(sh.startTime, sh.endTime, sh.isDouble), 0);
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
                        <p className="text-xs text-gray-500">{dayName} · {dateStr}</p>
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
function PtoView({ weekStart, timeOff, sideStaffNames, isEn, currentStaffName, canEdit, onApprove, onDeny, onRemove }) {
    const tx = (en, es) => (isEn ? en : es);
    const days = [0,1,2,3,4,5,6].map(i => addDays(weekStart, i));
    const dayLabels = isEn ? DAYS_EN : DAYS_ES;
    const dayLabelsFull = isEn ? DAYS_FULL_EN : DAYS_FULL_ES;
    const today = toDateStr(new Date());

    // Filter time-off to entries whose range overlaps this week + side.
    const weekStartStr = toDateStr(weekStart);
    const weekEndStr = toDateStr(addDays(weekStart, 7));
    const weekTimeOff = (timeOff || []).filter(t => {
        if (!sideStaffNames.has(t.staffName)) return false;
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
