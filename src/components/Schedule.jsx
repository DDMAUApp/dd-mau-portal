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
    serverTimestamp,
} from 'firebase/firestore';
import { canEditSchedule, isAdmin, LOCATION_LABELS } from '../data/staff';

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

export default function Schedule({ staffName, language, storeLocation, staffList }) {
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
        try {
            await updateDoc(doc(db, 'shifts', shift.id), {
                staffName: shift.pendingClaimBy,
                offerStatus: null,
                offeredBy: null,
                offeredAt: null,
                pendingClaimBy: null,
                claimedAt: null,
                approvedBy: staffName,
                approvedAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            });
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

            <div className="flex items-baseline justify-between mb-1 print:hidden">
                <h2 className="text-2xl font-bold text-mint-700">📅 {tx('Schedule', 'Horario')}</h2>
                <span className="text-xs text-gray-500">{LOCATION_LABELS[storeLocation] || storeLocation}</span>
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
                <button onClick={() => window.print()}
                    title={tx('Print this view', 'Imprimir esta vista')}
                    className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 text-xs font-bold">
                    🖨 {tx('Print', 'Imprimir')}
                </button>
                {canEdit && (
                    <>
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
                                openAddModal({ staffName: staff.name, date: dateStr, location: staff.location });
                            }}
                            onDeleteShift={handleDeleteShift}
                            onStaffClick={(name) => setPersonFilter(name)}
                            onOfferShift={handleOfferShift}
                            onTakeShift={handleTakeShift}
                            onCancelOffer={handleCancelOffer}
                            blocksByDate={blocksByDate}
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

function WeeklyGrid({ weekStart, staffSummary, shifts, isEn, currentStaffName, canEdit, onCellClick, onDeleteShift, onStaffClick, onOfferShift, onTakeShift, onCancelOffer, blocksByDate }) {
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
                                <th key={i} className={`border-b border-gray-200 px-1 py-2 min-w-[110px] ${closed ? 'bg-gray-200' : isToday ? 'bg-mint-50' : ''}`}>
                                    <div className={`text-[10px] uppercase font-semibold ${closed ? 'text-gray-600' : isToday ? 'text-mint-700' : 'text-gray-500'}`}>{dayLabels[i]}</div>
                                    <div className={`text-sm font-bold ${closed ? 'text-gray-700' : isToday ? 'text-mint-800' : 'text-gray-700'}`}>{d.getDate()}</div>
                                    {closed && <div className="text-[9px] font-bold text-gray-700 mt-0.5">🚫 {isEn ? 'Closed' : 'Cerrado'}</div>}
                                    {!closed && noTimeoff && <div className="text-[9px] font-bold text-amber-700 mt-0.5">🛑 {isEn ? 'No PTO' : 'Sin PTO'}</div>}
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
                                return (
                                    <td key={i}
                                        onClick={() => canEdit && cellShifts.length === 0 && !closed && onCellClick(s, dStr)}
                                        className={`border-b border-r border-gray-200 align-top p-1 ${closed ? 'bg-gray-100' : isToday ? 'bg-mint-50/30' : ''} ${canEdit && cellShifts.length === 0 && !closed ? 'cursor-pointer hover:bg-mint-50' : ''}`}>
                                        <div className="space-y-1">
                                            {cellShifts.map(sh => (
                                                <ShiftCube key={sh.id} shift={sh} staffRole={s.role} isMinor={s.isMinor} canEdit={canEdit} onDelete={onDeleteShift} isEn={isEn} compact
                                                    currentStaffName={currentStaffName} onOfferShift={onOfferShift} onCancelOffer={onCancelOffer} />
                                            ))}
                                            {canEdit && cellShifts.length === 0 && (
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

function ShiftCube({ shift, staffRole, isMinor, canEdit, onDelete, isEn, compact, currentStaffName, onOfferShift, onCancelOffer }) {
    const colors = roleColors(staffRole);
    const warnings = isMinor ? minorShiftWarnings(shift, isEn) : [];
    const hasWarning = warnings.length > 0;
    const hours = hoursBetween(shift.startTime, shift.endTime, shift.isDouble);
    const isMine = shift.staffName === currentStaffName;
    const isOffered = shift.offerStatus === 'open';
    const isPending = shift.offerStatus === 'pending';
    return (
        <div className={`schedule-shift-cube relative rounded border ${hasWarning ? 'border-amber-500 border-2' : colors.border} ${isOffered ? 'ring-2 ring-blue-400 opacity-80' : ''} ${isPending ? 'ring-2 ring-purple-400' : ''} ${colors.bg} ${colors.text} px-1.5 py-1 ${compact ? 'text-[10px] leading-tight' : 'text-xs'}`}>
            <div className="font-bold">{formatTime12h(shift.startTime)}–{formatTime12h(shift.endTime)}</div>
            <div className="opacity-80">
                {formatHours(hours)}
                {shift.isShiftLead && <span title="Shift Lead this shift" className="ml-0.5">🛡️</span>}
                {shift.isDouble && <span title="Double shift" className="ml-0.5">⏱</span>}
            </div>
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

// ── SwapPanels: open offers + pending approval queue ───────────────────────
function SwapPanels({ shifts, staffName, canEdit, isEn, onTake, onCancelOffer, onApprove, onDeny, storeLocation }) {
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

    // Pending approvals — managers/admin only.
    const pending = canEdit
        ? shifts.filter(s => s.offerStatus === 'pending' && s.date >= today)
            .filter(s => storeLocation === 'both' || s.location === storeLocation)
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
        : [];

    if (openOffers.length === 0 && pending.length === 0 && myOpenOffers.length === 0) return null;

    const renderShiftLine = (sh) => `${sh.date} · ${formatTime12h(sh.startTime)}–${formatTime12h(sh.endTime)} · ${LOCATION_LABELS[sh.location] || sh.location}`;

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
