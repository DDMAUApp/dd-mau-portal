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
    editShiftTimes,
    subscribeAllOffsite,
    formatOffsiteWhen,
} from '../data/offsiteClock';
import { toast } from '../toast';
import AssigneePickerModal from './AssigneePickerModal';
import ModalPortal from './ModalPortal';

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
    // Multi-select: admin can schedule the same assignment for >1
    // staff in a single submit. We create one offsite_shift doc per
    // selected name (the data model stays one-staff-per-shift so the
    // staff prompt + admin active list + force-out flows don't change).
    const [selStaffNames, setSelStaffNames] = useState([]);
    const [pickerOpen, setPickerOpen] = useState(false);
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
        if (selStaffNames.length === 0) { setErr(tx('Pick at least one staff member.', 'Elige al menos un miembro.')); return; }
        if (!location.trim()) { setErr(tx('Add a location.', 'Añade una ubicación.')); return; }
        if (!dateStr || !timeStr) { setErr(tx('Set arrival date + time.', 'Indica la fecha y hora.')); return; }
        const dt = new Date(`${dateStr}T${timeStr}:00`);
        if (isNaN(dt.getTime())) { setErr(tx('Bad date/time.', 'Fecha/hora inválida.')); return; }
        setBusy(true);
        try {
            // One doc per selected staff member. Same location/time/notes
            // on each — they're all part of the same assignment from the
            // admin's POV. Run in parallel; collect partial failures so
            // we can report cleanly if one staff's write fails.
            const trimmedLocation = location.trim();
            const trimmedNotes = notes.trim() || null;
            const writers = selStaffNames.map((name) => {
                const target = candidates.find(s => s.name === name);
                return createOffsiteShift({
                    staffName: name,
                    staffId: target?.id ?? null,
                    location: trimmedLocation,
                    scheduledArrivalAt: dt,
                    notes: trimmedNotes,
                    createdBy: staffName || 'admin',
                });
            });
            const results = await Promise.allSettled(writers);
            const ok = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - ok;
            if (failed > 0) {
                const firstErr = results.find(r => r.status === 'rejected')?.reason;
                console.warn('createOffsiteShift partial failure:', firstErr);
                if (ok === 0) {
                    setErr(tx('Save failed.', 'Error al guardar.'));
                } else {
                    setErr(tx(
                        `Saved ${ok}, but ${failed} failed. Try again for: ${
                            results.map((r, i) => r.status === 'rejected' ? selStaffNames[i] : null).filter(Boolean).join(', ')
                        }`,
                        `Guardados ${ok}, pero ${failed} fallaron. Intenta de nuevo: ${
                            results.map((r, i) => r.status === 'rejected' ? selStaffNames[i] : null).filter(Boolean).join(', ')
                        }`,
                    ));
                }
            }
            if (ok > 0) {
                // Reset the form so the next entry is one-tap. Keep
                // failed names selected if any failed so the admin can
                // retry without re-picking everyone.
                const failedNames = results
                    .map((r, i) => r.status === 'rejected' ? selStaffNames[i] : null)
                    .filter(Boolean);
                setSelStaffNames(failedNames);
                if (failedNames.length === 0) {
                    setLocation('');
                    setNotes('');
                }
                setSavedFlash(ok === 1
                    ? tx('Scheduled ✓', 'Programado ✓')
                    : tx(`Scheduled for ${ok} staff ✓`, `Programado para ${ok} miembros ✓`));
                setTimeout(() => setSavedFlash(''), 2500);
            }
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

    // Edit-times modal state. Holds the shift currently being edited.
    // null = modal closed.
    const [editingShift, setEditingShift] = useState(null);

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
                            <div className="block">
                                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">
                                    {tx('Staff', 'Personal')}
                                    {selStaffNames.length > 0 && (
                                        <span className="ml-1 normal-case text-purple-700">
                                            · {selStaffNames.length} {selStaffNames.length === 1
                                                ? tx('picked', 'elegido')
                                                : tx('picked', 'elegidos')}
                                        </span>
                                    )}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setPickerOpen(true)}
                                    className="w-full text-left px-2 py-1.5 rounded-lg border border-gray-300 text-sm bg-white hover:bg-purple-50 hover:border-purple-300 transition flex items-center justify-between"
                                >
                                    <span className={selStaffNames.length === 0 ? 'text-gray-400' : 'text-gray-800 font-bold'}>
                                        {selStaffNames.length === 0
                                            ? tx('Pick staff…', 'Elige personal…')
                                            : selStaffNames.length <= 2
                                                ? selStaffNames.join(', ')
                                                : `${selStaffNames.slice(0, 2).join(', ')} +${selStaffNames.length - 2}`}
                                    </span>
                                    <span className="text-gray-400 text-xs">▾</span>
                                </button>
                                {selStaffNames.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-1">
                                        {selStaffNames.map((n) => (
                                            <span
                                                key={n}
                                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 text-[11px] font-bold border border-purple-200"
                                            >
                                                {n}
                                                <button
                                                    type="button"
                                                    onClick={() => setSelStaffNames(prev => prev.filter(x => x !== n))}
                                                    className="text-purple-500 hover:text-red-600 leading-none"
                                                    aria-label={tx(`Remove ${n}`, `Quitar ${n}`)}
                                                >
                                                    ✕
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
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
                                    onEdit={() => setEditingShift(shift)}
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
                                            onEdit={() => setEditingShift(shift)}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Edit-times modal — opens when admin clicks "Edit times"
                on any active or historical shift row. Lets admin retype
                clockedInAt and clockedOutAt with a reason; saves via
                editShiftTimes which writes the audit row + before/after. */}
            {editingShift && (
                <EditTimesModal
                    shift={editingShift}
                    isEs={isEs}
                    locale={locale}
                    onClose={() => setEditingShift(null)}
                    onSaved={() => setEditingShift(null)}
                    adminName={staffName}
                    adminId={viewer?.id}
                />
            )}

            {/* Multi-select staff picker for the "Schedule new assignment"
                form. Reuses the same modal the checklist-task editor uses
                so admins see one consistent picker across the app. */}
            <AssigneePickerModal
                open={pickerOpen}
                onClose={() => setPickerOpen(false)}
                onSave={(names) => setSelStaffNames(names || [])}
                taskTitle={tx('Schedule off-site assignment', 'Programar asignación fuera de sitio')}
                eligibleStaff={candidates}
                assignedNames={selStaffNames}
                currentStaffName={staffName}
                language={language}
            />
        </div>
    );
}

function ShiftRow({ shift, isEs, locale, onCancel, onForceOut, onEdit, readOnly }) {
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

    // Edit Times is allowed on shifts that actually have a clock-in
    // timestamp (active OR completed). Pending shifts have nothing to
    // edit yet; cancelled shifts shouldn't be rewritten.
    const canEditTimes = onEdit && (status === 'active' || status === 'completed');

    return (
        <div className="px-3 py-2 flex items-start gap-2">
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-black text-gray-800 truncate">{shift.staffName}</span>
                    <span className={`text-[10px] font-black uppercase px-1.5 py-0.5 rounded-full border ${badge.cls}`}>
                        {badge.label}
                    </span>
                    {shift.editedTimesAt && (
                        <span title={shift.editedTimesBy ? tx(`Edited by ${shift.editedTimesBy}`, `Editado por ${shift.editedTimesBy}`) : tx('Edited', 'Editado')}
                            className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                            ✏️ {tx('edited', 'editado')}
                        </span>
                    )}
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
                {shift.editedTimesReason && (
                    <div className="text-[10px] text-amber-700 mt-0.5">
                        {tx('Edit reason:', 'Motivo:')} "{shift.editedTimesReason}"
                    </div>
                )}
                {shift.notes && (
                    <div className="text-[11px] text-gray-700 italic mt-0.5">"{shift.notes}"</div>
                )}
            </div>
            <div className="flex flex-col gap-1 shrink-0">
                {/* Action buttons. Edit Times is always shown (even on
                    history rows) because retroactive payroll corrections
                    are the main use case for editing — Andrew flagged
                    "say a staff clocks in late and I need to fix it". */}
                {!readOnly && status === 'pending' && onCancel && (
                    <button
                        onClick={onCancel}
                        className="px-2 py-1 rounded-full text-[10px] font-bold bg-white text-red-700 border border-red-300 hover:bg-red-50"
                    >
                        {tx('Cancel', 'Cancelar')}
                    </button>
                )}
                {!readOnly && status === 'active' && onForceOut && (
                    <button
                        onClick={onForceOut}
                        className="px-2 py-1 rounded-full text-[10px] font-bold bg-white text-orange-700 border border-orange-300 hover:bg-orange-50"
                    >
                        {tx('Force out', 'Cerrar turno')}
                    </button>
                )}
                {canEditTimes && (
                    <button
                        onClick={onEdit}
                        title={tx('Fix the clock-in / clock-out times', 'Corregir hora de entrada / salida')}
                        className="px-2 py-1 rounded-full text-[10px] font-bold bg-white text-amber-700 border border-amber-300 hover:bg-amber-50"
                    >
                        ✏️ {tx('Edit times', 'Editar horas')}
                    </button>
                )}
            </div>
        </div>
    );
}

// EditTimesModal — admin-side retroactive time correction.
//
// Use case Andrew flagged: staff clocked in 15 min late (or forgot to
// tap clock-in until they remembered an hour later). Admin wants to
// set the actual time the staff started working so payroll is right.
// Same idea for clock-out — someone leaves at 5pm but didn't tap until
// 5:30, admin trims the recorded time.
//
// Inputs are <input type="datetime-local"> which expects "YYYY-MM-DDTHH:MM"
// format. We convert to/from Date objects on the boundary. The current
// stored values prefill so the admin can nudge a single field instead
// of re-typing both.
function EditTimesModal({ shift, isEs, locale, onClose, onSaved, adminName, adminId }) {
    const tx = (en, es) => (isEs ? es : en);
    // datetime-local input format: YYYY-MM-DDTHH:MM (no TZ — interpreted
    // as local time, which is what payroll wants).
    const dateToLocalInput = (ms) => {
        if (!ms) return '';
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const inMsOriginal = shift.clockedInAt?.toMillis?.() ?? null;
    const outMsOriginal = shift.clockedOutAt?.toMillis?.() ?? null;

    const [inStr, setInStr] = useState(dateToLocalInput(inMsOriginal));
    const [outStr, setOutStr] = useState(dateToLocalInput(outMsOriginal));
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');

    const inDirty = inStr !== dateToLocalInput(inMsOriginal);
    const outDirty = outStr !== dateToLocalInput(outMsOriginal);
    const hasChange = inDirty || outDirty;

    const formatPreview = (str) => {
        if (!str) return '—';
        try {
            const d = new Date(str);
            if (isNaN(d.getTime())) return tx('invalid', 'inválido');
            return d.toLocaleString(locale, {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit',
            });
        } catch { return tx('invalid', 'inválido'); }
    };

    const save = async () => {
        setErr('');
        if (!hasChange) {
            setErr(tx('No changes to save.', 'Sin cambios para guardar.'));
            return;
        }
        // Convert local-time strings to Date objects, only for fields
        // the admin touched. Untouched fields stay null so editShiftTimes
        // leaves them alone.
        const inDate  = inDirty  && inStr  ? new Date(inStr)  : null;
        const outDate = outDirty && outStr ? new Date(outStr) : null;
        if (inDate && isNaN(inDate.getTime())) { setErr(tx('Invalid clock-in.', 'Entrada inválida.')); return; }
        if (outDate && isNaN(outDate.getTime())) { setErr(tx('Invalid clock-out.', 'Salida inválida.')); return; }
        setBusy(true);
        try {
            await editShiftTimes({
                id: shift.id,
                clockedInAt: inDate,
                clockedOutAt: outDate,
                reason: reason.trim() || null,
                adminName,
                adminId,
            });
            onSaved && onSaved();
        } catch (e) {
            console.warn('editShiftTimes failed:', e);
            setErr(e?.message || tx('Save failed.', 'Error al guardar.'));
            setBusy(false);
        }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 space-y-3 modal-scroll-lock">
                <div className="flex items-center justify-between mb-1">
                    <h3 className="text-lg font-black text-amber-700">
                        ✏️ {tx('Edit clock times', 'Editar horas')}
                    </h3>
                    <button onClick={onClose} className="text-gray-500 text-2xl leading-none">×</button>
                </div>
                <p className="text-xs text-gray-600 leading-relaxed">
                    <span className="font-bold">{shift.staffName}</span>
                    {' · '}
                    {shift.location}
                </p>

                <div className="grid grid-cols-1 gap-3">
                    {/* Clock-in time */}
                    <label className="block">
                        <div className="flex items-center justify-between mb-0.5">
                            <span className="text-[10px] font-bold uppercase text-gray-500">
                                {tx('Clock-in', 'Entrada')}
                            </span>
                            {inDirty && (
                                <span className="text-[9px] font-bold text-amber-700">
                                    {tx('changed', 'modificado')}
                                </span>
                            )}
                        </div>
                        <input
                            type="datetime-local"
                            value={inStr}
                            onChange={e => setInStr(e.target.value)}
                            className={`w-full px-2 py-1.5 rounded-lg border text-sm ${inDirty ? 'border-amber-400 bg-amber-50' : 'border-gray-300'}`}
                        />
                        <div className="text-[10px] text-gray-500 mt-0.5">
                            {tx('Was', 'Antes')}: {formatPreview(dateToLocalInput(inMsOriginal))}
                            {inDirty && (
                                <>
                                    {' → '}
                                    <span className="font-bold text-amber-700">{formatPreview(inStr)}</span>
                                </>
                            )}
                        </div>
                    </label>

                    {/* Clock-out time — disabled with hint if no clock-out yet */}
                    <label className="block">
                        <div className="flex items-center justify-between mb-0.5">
                            <span className="text-[10px] font-bold uppercase text-gray-500">
                                {tx('Clock-out', 'Salida')}
                            </span>
                            {outDirty && (
                                <span className="text-[9px] font-bold text-amber-700">
                                    {tx('changed', 'modificado')}
                                </span>
                            )}
                        </div>
                        <input
                            type="datetime-local"
                            value={outStr}
                            onChange={e => setOutStr(e.target.value)}
                            className={`w-full px-2 py-1.5 rounded-lg border text-sm ${outDirty ? 'border-amber-400 bg-amber-50' : 'border-gray-300'}`}
                        />
                        <div className="text-[10px] text-gray-500 mt-0.5">
                            {outMsOriginal == null
                                ? tx('No clock-out recorded yet.', 'Aún no hay salida registrada.')
                                : <>
                                    {tx('Was', 'Antes')}: {formatPreview(dateToLocalInput(outMsOriginal))}
                                    {outDirty && (
                                        <>
                                            {' → '}
                                            <span className="font-bold text-amber-700">{formatPreview(outStr)}</span>
                                        </>
                                    )}
                                </>}
                        </div>
                    </label>

                    {/* Reason — optional but recommended for the audit trail */}
                    <label className="block">
                        <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">
                            {tx('Reason (optional)', 'Motivo (opcional)')}
                        </span>
                        <input
                            type="text"
                            value={reason}
                            onChange={e => setReason(e.target.value)}
                            maxLength={300}
                            placeholder={tx('e.g. "forgot to clock in, started at 9"', 'ej. "se le olvidó marcar, empezó a las 9"')}
                            className="w-full px-2 py-1.5 rounded-lg border border-gray-300 text-sm"
                        />
                    </label>
                </div>

                {err && (
                    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{err}</div>
                )}

                <div className="flex gap-2 pt-1">
                    <button
                        onClick={onClose}
                        disabled={busy}
                        className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold disabled:opacity-50"
                    >
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={save}
                        disabled={busy || !hasChange}
                        className="flex-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 disabled:opacity-40"
                    >
                        {busy ? tx('Saving…', 'Guardando…') : tx('Save changes', 'Guardar')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
