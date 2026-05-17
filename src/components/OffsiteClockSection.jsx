// OffsiteClockSection — admin-side UI for off-site clock-in.
//
// Lives inside AdminPanel as a collapsible section. Lets owners
// schedule an off-site assignment (catering event, supply run,
// supplier visit, etc.) for a staff member. The staff app prompts
// them to clock in / out on next login.
//
// Three areas:
//   1. New assignment form — staff dropdown + location text +
//      arrival date+time + optional note + "Schedule" button.
//   2. Active list — every pending + active shift across the team,
//      with status badge, scheduled time, location label.
//      Actions per row: Cancel (pending only) + Force clock-out
//      (active only).
//   3. Recent history — last 30 days of completed/cancelled
//      assignments, collapsed by default. Lets admins audit what
//      happened without bloating the live view.
//
// Why no per-staff view here: the admin watches every assignment
// at once; the staff-side prompt is the per-staff view.

import { useState, useEffect, useMemo } from 'react';
import {
    OFFSITE_STATUS,
    createOffsiteShift,
    cancelOffsiteShift,
    forceClockOut,
    subscribeAllOffsite,
    formatOffsiteWhen,
} from '../data/offsiteClock';
import { toast } from '../toast';

export default function OffsiteClockSection({
    language = 'en', staffName, staffList, viewer,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const locale = isEs ? 'es' : 'en-US';

    const [expanded, setExpanded] = useState(false);
    const [shifts, setShifts] = useState([]);
    const [showHistory, setShowHistory] = useState(false);

    // Subscribe to every off-site shift in the last 90 days. The
    // helper sorts newest-first; we re-split in render for the
    // active vs history blocks.
    useEffect(() => {
        if (!expanded) return;
        return subscribeAllOffsite(setShifts);
    }, [expanded]);

    const { active, history } = useMemo(() => {
        const a = [];
        const h = [];
        for (const s of shifts) {
            if (s.status === OFFSITE_STATUS.PENDING || s.status === OFFSITE_STATUS.ACTIVE) {
                a.push(s);
            } else {
                h.push(s);
            }
        }
        // Active list sorted by scheduledArrivalAt ascending — soonest first.
        a.sort((x, y) => {
            const xms = x.scheduledArrivalAt?.toMillis ? x.scheduledArrivalAt.toMillis() : 0;
            const yms = y.scheduledArrivalAt?.toMillis ? y.scheduledArrivalAt.toMillis() : 0;
            return xms - yms;
        });
        // history stays newest-first from the helper.
        return { active: a, history: h };
    }, [shifts]);

    // ── Add-new form state ────────────────────────────────────────
    const [selStaff, setSelStaff] = useState('');
    const [location, setLocation] = useState('');
    const [dateStr, setDateStr] = useState(() => {
        // Default to today's date in the staff's local timezone.
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    const [timeStr, setTimeStr] = useState('09:00');
    const [notes, setNotes] = useState('');
    const [busy, setBusy] = useState(false);
    const [savedFlash, setSavedFlash] = useState('');
    const [err, setErr] = useState('');

    const candidates = useMemo(() => {
        return (staffList || [])
            .filter(s => s && s.name)
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [staffList]);

    async function handleAdd() {
        setErr('');
        if (!selStaff) { setErr(tx('Pick a staff member.', 'Elige un miembro.')); return; }
        if (!location.trim()) { setErr(tx('Add a location.', 'Añade una ubicación.')); return; }
        if (!dateStr || !timeStr) { setErr(tx('Set arrival date + time.', 'Indica la fecha y hora.')); return; }
        setBusy(true);
        try {
            const target = candidates.find(s => s.name === selStaff);
            const dt = new Date(`${dateStr}T${timeStr}:00`);
            if (isNaN(dt.getTime())) { setErr(tx('Bad date/time.', 'Fecha/hora inválida.')); setBusy(false); return; }
            await createOffsiteShift({
                staffName: selStaff,
                staffId: target?.id ?? null,
                location: location.trim(),
                scheduledArrivalAt: dt,
                notes: notes.trim() || null,
                createdBy: staffName || 'admin',
            });
            // Reset the form so the next entry is one-tap.
            setSelStaff('');
            setLocation('');
            setNotes('');
            setSavedFlash(tx('Scheduled ✓', 'Programado ✓'));
            setTimeout(() => setSavedFlash(''), 2500);
        } catch (e) {
            console.warn('createOffsiteShift failed:', e);
            setErr(tx('Save failed.', 'Error al guardar.'));
        } finally {
            setBusy(false);
        }
    }

    async function handleCancel(shift) {
        if (!window.confirm(tx(
            `Cancel the off-site assignment for ${shift.staffName}?`,
            `¿Cancelar la asignación fuera de sitio para ${shift.staffName}?`,
        ))) return;
        try {
            await cancelOffsiteShift({
                id: shift.id, adminName: staffName, adminId: viewer?.id,
            });
        } catch (e) {
            console.warn('cancel failed:', e);
            toast(tx('Cancel failed', 'Error al cancelar'), { kind: 'error' });
        }
    }

    async function handleForceOut(shift) {
        if (!window.confirm(tx(
            `Force-clock-out ${shift.staffName}? Use this when they forgot to clock themselves out.`,
            `¿Cerrar turno de ${shift.staffName}? Úsalo cuando olviden cerrarlo.`,
        ))) return;
        try {
            await forceClockOut({
                id: shift.id, adminName: staffName, adminId: viewer?.id,
            });
        } catch (e) {
            console.warn('force-out failed:', e);
            toast(tx('Force clock-out failed', 'Error al cerrar turno'), { kind: 'error' });
        }
    }

    return (
        <div className="mb-6">
            {/* Collapsible header — same shape as Maintenance + Staff sections so
                the admin page reads as a single rhythm. */}
            <button
                onClick={() => setExpanded(e => !e)}
                className="w-full flex items-center justify-between bg-purple-50 border-2 border-purple-200 rounded-xl p-4 hover:bg-purple-100 transition"
            >
                <div className="flex items-center gap-2">
                    <span className="text-2xl">🚐</span>
                    <div className="text-left">
                        <h3 className="font-bold text-purple-700">
                            {tx('Off-Site Clock-In', 'Fichaje Fuera de Sitio')}
                        </h3>
                        <p className="text-xs text-purple-600/80">
                            {active.length > 0
                                ? tx(
                                    `${active.length} ${active.length === 1 ? 'assignment' : 'assignments'} open`,
                                    `${active.length} ${active.length === 1 ? 'asignación' : 'asignaciones'} abiertas`,
                                  )
                                : tx('Schedule catering / off-site work', 'Programar trabajo fuera del local')}
                        </p>
                    </div>
                </div>
                <span className="text-gray-400 text-xl">{expanded ? '▼' : '▶'}</span>
            </button>

            {expanded && (
                <div className="mt-2 space-y-3">
                    {/* ── Add-new form ─────────────────────────────────── */}
                    <div className="bg-white border border-purple-200 rounded-xl p-3 space-y-2">
                        <div className="text-[11px] font-black uppercase tracking-wider text-purple-700 mb-1">
                            ➕ {tx('Schedule a new assignment', 'Programar nueva asignación')}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">{tx('Staff', 'Personal')}</span>
                                <select
                                    value={selStaff}
                                    onChange={(e) => setSelStaff(e.target.value)}
                                    className="w-full px-2 py-1.5 rounded-lg border border-gray-300 text-sm bg-white"
                                >
                                    <option value="">{tx('Pick someone…', 'Elige a alguien…')}</option>
                                    {candidates.map(s => (
                                        <option key={s.id || s.name} value={s.name}>
                                            {s.name}{s.role ? ` · ${s.role}` : ''}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">{tx('Location', 'Ubicación')}</span>
                                <input
                                    type="text"
                                    value={location}
                                    onChange={(e) => setLocation(e.target.value)}
                                    maxLength={200}
                                    placeholder={tx('e.g. Catering @ Forest Park', 'ej. Catering en Forest Park')}
                                    className="w-full px-2 py-1.5 rounded-lg border border-gray-300 text-sm"
                                />
                            </label>
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">{tx('Arrival date', 'Fecha de llegada')}</span>
                                <input
                                    type="date"
                                    value={dateStr}
                                    onChange={(e) => setDateStr(e.target.value)}
                                    className="w-full px-2 py-1.5 rounded-lg border border-gray-300 text-sm"
                                />
                            </label>
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">{tx('Arrival time', 'Hora de llegada')}</span>
                                <input
                                    type="time"
                                    value={timeStr}
                                    onChange={(e) => setTimeStr(e.target.value)}
                                    className="w-full px-2 py-1.5 rounded-lg border border-gray-300 text-sm"
                                />
                            </label>
                        </div>
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">{tx('Notes (optional)', 'Notas (opcional)')}</span>
                            <input
                                type="text"
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                maxLength={500}
                                placeholder={tx('Anything they need to know', 'Algo que deban saber')}
                                className="w-full px-2 py-1.5 rounded-lg border border-gray-300 text-sm"
                            />
                        </label>

                        {err && (
                            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{err}</div>
                        )}
                        {savedFlash && (
                            <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1 font-bold">{savedFlash}</div>
                        )}

                        <div className="flex justify-end">
                            <button
                                onClick={handleAdd}
                                disabled={busy}
                                className="px-4 py-1.5 rounded-full bg-purple-600 text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-purple-700 active:scale-95 transition"
                            >
                                {busy ? tx('Saving…', 'Guardando…') : tx('Schedule', 'Programar')}
                            </button>
                        </div>
                        <p className="text-[10px] text-gray-500 italic">
                            {tx(
                                'The staff member will see a "Clock in?" prompt the next time they open the app. After they tap yes, the app will keep asking to clock out until they confirm or you force-clock-out from below.',
                                'El staff verá un mensaje "¿Marcar entrada?" la próxima vez que abra la app. Tras confirmar, la app pedirá marcar la salida hasta que lo hagan o tú lo cierres desde abajo.',
                            )}
                        </p>
                    </div>

                    {/* ── Active list ───────────────────────────────────── */}
                    {active.length > 0 ? (
                        <div className="border border-purple-200 rounded-xl bg-white divide-y divide-purple-100">
                            <div className="px-3 py-2 text-[10px] font-black uppercase tracking-wider text-purple-700">
                                {tx('Open assignments', 'Asignaciones abiertas')}
                            </div>
                            {active.map(shift => (
                                <ShiftRow
                                    key={shift.id}
                                    shift={shift}
                                    isEs={isEs}
                                    locale={locale}
                                    onCancel={() => handleCancel(shift)}
                                    onForceOut={() => handleForceOut(shift)}
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="text-center text-xs text-gray-500 py-2">
                            {tx('No off-site assignments scheduled.', 'No hay asignaciones programadas.')}
                        </div>
                    )}

                    {/* ── History (collapsed) ───────────────────────────── */}
                    {history.length > 0 && (
                        <div className="border border-gray-200 rounded-xl bg-gray-50">
                            <button
                                onClick={() => setShowHistory(h => !h)}
                                className="w-full px-3 py-2 flex items-center justify-between text-left"
                            >
                                <span className="text-[10px] font-black uppercase tracking-wider text-gray-600">
                                    {tx('History (last 90 days)', 'Historial (últimos 90 días)')} · {history.length}
                                </span>
                                <span className="text-gray-400">{showHistory ? '▼' : '▶'}</span>
                            </button>
                            {showHistory && (
                                <div className="divide-y divide-gray-200 max-h-[300px] overflow-y-auto">
                                    {history.slice(0, 60).map(shift => (
                                        <ShiftRow
                                            key={shift.id}
                                            shift={shift}
                                            isEs={isEs}
                                            locale={locale}
                                            readOnly
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function ShiftRow({ shift, isEs, locale, onCancel, onForceOut, readOnly }) {
    const tx = (en, es) => (isEs ? es : en);
    const status = shift.status;
    const badge = {
        pending:   { label: tx('PENDING', 'PENDIENTE'),  cls: 'bg-amber-100 text-amber-900 border-amber-300' },
        active:    { label: tx('ON THE CLOCK', 'EN TURNO'), cls: 'bg-blue-100 text-blue-900 border-blue-300' },
        completed: { label: tx('DONE', 'TERMINADO'),     cls: 'bg-green-100 text-green-900 border-green-300' },
        cancelled: { label: tx('CANCELLED', 'CANCELADO'), cls: 'bg-gray-100 text-gray-700 border-gray-300' },
    }[status] || { label: status, cls: 'bg-gray-100 text-gray-700 border-gray-300' };

    const inMs = shift.clockedInAt?.toMillis ? shift.clockedInAt.toMillis() : null;
    const outMs = shift.clockedOutAt?.toMillis ? shift.clockedOutAt.toMillis() : null;
    const minutes = (inMs && outMs) ? Math.max(0, Math.round((outMs - inMs) / 60_000)) : null;

    return (
        <div className="px-3 py-2 flex items-start gap-2">
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-black text-gray-800 truncate">{shift.staffName}</span>
                    <span className={`text-[10px] font-black uppercase px-1.5 py-0.5 rounded-full border ${badge.cls}`}>
                        {badge.label}
                    </span>
                </div>
                <div className="text-xs text-gray-600 truncate mt-0.5">
                    📍 {shift.location}
                </div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                    {tx('Arrives', 'Llega')}: {formatOffsiteWhen(shift.scheduledArrivalAt, locale)}
                </div>
                {(inMs || outMs) && (
                    <div className="text-[10px] text-gray-500 mt-0.5">
                        {inMs && <>{tx('In', 'Entrada')}: {new Date(inMs).toLocaleString(locale, { hour: 'numeric', minute: '2-digit' })}</>}
                        {inMs && outMs && ' → '}
                        {outMs && <>{tx('Out', 'Salida')}: {new Date(outMs).toLocaleString(locale, { hour: 'numeric', minute: '2-digit' })}</>}
                        {minutes != null && (
                            <span className="ml-2 font-bold">
                                {Math.floor(minutes / 60)}h {minutes % 60}m
                            </span>
                        )}
                        {shift.forcedOut && (
                            <span className="ml-1 text-orange-700">({tx('forced', 'forzado')})</span>
                        )}
                    </div>
                )}
                {shift.notes && (
                    <div className="text-[11px] text-gray-700 italic mt-0.5">"{shift.notes}"</div>
                )}
            </div>
            {!readOnly && (
                <div className="flex flex-col gap-1 shrink-0">
                    {status === 'pending' && onCancel && (
                        <button
                            onClick={onCancel}
                            className="px-2 py-1 rounded-full text-[10px] font-bold bg-white text-red-700 border border-red-300 hover:bg-red-50"
                        >
                            {tx('Cancel', 'Cancelar')}
                        </button>
                    )}
                    {status === 'active' && onForceOut && (
                        <button
                            onClick={onForceOut}
                            className="px-2 py-1 rounded-full text-[10px] font-bold bg-white text-orange-700 border border-orange-300 hover:bg-orange-50"
                        >
                            {tx('Force out', 'Cerrar turno')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
