// TakeShiftModal — glass-styled "I'll take this shift" composer for
// the picker.
//
// Replaces the native browser confirm() previously thrown by
// handleTakeShift in Schedule.jsx. The native dialog was just a
// binary OK/Cancel — no way to:
//   • Show the picker the offerer's note ("Doctor appt, please!")
//   • Show how taking impacts the picker's weekly hours / OT risk
//   • Warn about conflicts with the picker's existing shifts
//   • Propose a partial pickup ("I can only do 10am-1pm, not the full 10-3")
//
// Partial pickup (the "split" flow Andrew wanted):
//   Original 10am-3pm shift → picker offers 10am-1pm. We stash the
//   proposed range as `proposedSplit: { startTime, endTime }` on the
//   shift doc when transitioning to status:'pending'. Manager's
//   approval handler reads proposedSplit and, in the same transaction,
//   shortens the original shift to the picker's range AND creates a
//   new shift doc for the leftover (assigned back to the original
//   holder). This way the schedule grid correctly shows two shifts
//   after approval, with a transferHistory audit trail.
//
// Submit contract: parent passes `onSubmit({ partial?: { startTime,
// endTime } })`. Omitted partial = full pickup (the original times).
// Parent owns the Firestore write.

import { useState, useMemo } from 'react';
import ModalPortal from './ModalPortal';
import { Hand, AlertTriangle, Scissors, MessageSquare } from 'lucide-react';

// Hours between two HH:MM strings, never negative.
function hoursBetween(startHHMM, endHHMM) {
    if (!startHHMM || !endHHMM) return 0;
    const [sh, sm] = startHHMM.split(':').map(Number);
    const [eh, em] = endHHMM.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    return Math.max(0, (endMin - startMin) / 60);
}

// Compare HH:MM strings as 24h times.
function timeLt(a, b) {
    if (!a || !b) return false;
    return a < b;
}

export default function TakeShiftModal({
    shift,                 // the offered shift doc
    formatTime12h,
    locationLabel,
    weeklyHoursBefore,     // picker's existing hours this week (number)
    conflicts = [],        // array of picker's existing shifts that overlap
    onSubmit,              // ({ partial?: { startTime, endTime } }) => Promise<void>
    onClose,
    busy = false,
    language = 'en',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [partial, setPartial] = useState(false);
    const [partialStart, setPartialStart] = useState('');
    const [partialEnd, setPartialEnd] = useState('');

    // Initialize partial time pickers to the original range when the
    // picker first toggles partial on. We don't initialize at mount
    // because that would re-render every prop change.
    const togglePartial = () => {
        if (!partial && shift) {
            setPartialStart(shift.startTime || '');
            setPartialEnd(shift.endTime || '');
        }
        setPartial(p => !p);
    };

    // Effective times the picker is committing to.
    const effStart = partial ? partialStart : (shift?.startTime || '');
    const effEnd   = partial ? partialEnd   : (shift?.endTime   || '');

    // Hours math — for the picker's "you'll have X hours this week" preview.
    const shiftHours = useMemo(() => hoursBetween(effStart, effEnd), [effStart, effEnd]);
    const weeklyHoursAfter = (weeklyHoursBefore || 0) + shiftHours;
    const overtimeRisk = weeklyHoursAfter > 40;

    // Validation: partial range must be inside the original AND non-empty.
    const partialValid = !partial || (
        partialStart && partialEnd &&
        partialStart >= (shift?.startTime || '') &&
        partialEnd   <= (shift?.endTime   || '') &&
        timeLt(partialStart, partialEnd)
    );
    const canSubmit = !!shift && partialValid && shiftHours > 0 && !busy;

    if (!shift) return null;

    const handleSubmit = async () => {
        if (!canSubmit) return;
        const payload = partial
            ? { partial: { startTime: partialStart, endTime: partialEnd } }
            : {};
        try {
            await onSubmit?.(payload);
        } finally {
            onClose?.();
        }
    };

    return (
        <ModalPortal>
            <div
                className="fixed inset-0 z-[60] bg-black/50 flex items-end md:items-center justify-center p-3"
                onClick={onClose}
                role="dialog"
                aria-modal="true"
            >
                <div
                    className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl shadow-xl flex flex-col max-h-[92vh]"
                    onClick={(e) => e.stopPropagation()}
                    style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
                >
                    <div className="md:hidden flex justify-center pt-2 pb-1">
                        <div className="w-10 h-1 bg-dd-line rounded-full" />
                    </div>

                    {/* Header */}
                    <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between bg-dd-green-50 safe-top">
                        <div>
                            <h2 className="text-lg font-black text-dd-green-700 flex items-center gap-2">
                                <Hand size={18} strokeWidth={2.25} />
                                {tx('Take this shift', 'Tomar este turno')}
                            </h2>
                            <p className="text-[11px] text-dd-green-700/80 leading-tight mt-0.5">
                                {tx(
                                    'Pending manager approval. They get a ping the moment you confirm.',
                                    'Pendiente de aprobación. El gerente recibirá una alerta al confirmar.'
                                )}
                            </p>
                        </div>
                        <button
                            onClick={onClose}
                            className="w-11 h-11 rounded-full hover:bg-white/60 flex items-center justify-center"
                            aria-label={tx('Close', 'Cerrar')}
                        >✕</button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ overscrollBehavior: 'contain' }}>
                        {/* Shift summary */}
                        <div className="rounded-xl bg-dd-bg/40 border border-dd-line p-3">
                            <div className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                {tx('Offered by', 'Ofrecido por')} {shift.staffName}
                            </div>
                            <div className="text-sm font-black text-dd-text">{shift.date}</div>
                            <div className="text-sm text-dd-text">
                                {formatTime12h(shift.startTime)}–{formatTime12h(shift.endTime)}
                            </div>
                            {locationLabel && (
                                <div className="text-xs text-dd-text-2 mt-0.5">{locationLabel}</div>
                            )}
                        </div>

                        {/* Offerer note (if any) */}
                        {shift.offerNote && (
                            <div className="rounded-xl bg-blue-50 border border-blue-200 p-3">
                                <div className="flex items-start gap-2">
                                    <MessageSquare size={14} strokeWidth={2.25} className="text-blue-700 mt-0.5 shrink-0" />
                                    <div className="min-w-0">
                                        <div className="text-[10px] font-bold uppercase tracking-widest text-blue-800 mb-0.5">
                                            {tx('Note from', 'Nota de')} {shift.staffName}
                                        </div>
                                        <div className="text-sm text-blue-900 whitespace-pre-line break-words">
                                            "{shift.offerNote}"
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Conflict warning — warn, don't block */}
                        {conflicts.length > 0 && (
                            <div className="rounded-xl bg-amber-50 border border-amber-300 p-3">
                                <div className="flex items-start gap-2">
                                    <AlertTriangle size={14} strokeWidth={2.25} className="text-amber-700 mt-0.5 shrink-0" />
                                    <div className="min-w-0">
                                        <div className="text-[10px] font-bold uppercase tracking-widest text-amber-800 mb-0.5">
                                            {tx('Heads up — conflict', 'Atención — conflicto')}
                                        </div>
                                        <div className="text-sm text-amber-900">
                                            {tx(
                                                "You already have a shift that overlaps:",
                                                "Ya tienes un turno que se cruza:"
                                            )}
                                        </div>
                                        <ul className="text-xs text-amber-900 mt-1 space-y-0.5">
                                            {conflicts.slice(0, 3).map(c => (
                                                <li key={c.id}>
                                                    · {c.date} {formatTime12h(c.startTime)}–{formatTime12h(c.endTime)}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Partial pickup toggle */}
                        <button
                            type="button"
                            onClick={togglePartial}
                            className={`w-full flex items-center gap-3 rounded-xl border-2 px-3 py-3 text-left transition ${partial
                                ? 'border-purple-500 bg-purple-50'
                                : 'border-dd-line bg-white hover:bg-dd-bg'}`}
                        >
                            <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${partial ? 'bg-purple-600 text-white' : 'bg-dd-bg text-dd-text-2'}`}>
                                <Scissors size={20} strokeWidth={2.25} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className={`text-sm font-black ${partial ? 'text-purple-900' : 'text-dd-text'}`}>
                                    {tx('Take part of the shift', 'Tomar parte del turno')}
                                </div>
                                <div className="text-[11px] text-dd-text-2 leading-tight">
                                    {tx(
                                        "Leftover stays with the original holder.",
                                        "El resto queda con el dueño original."
                                    )}
                                </div>
                            </div>
                            <div className={`shrink-0 w-10 h-6 rounded-full p-0.5 transition ${partial ? 'bg-purple-600' : 'bg-dd-line'}`}>
                                <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${partial ? 'translate-x-4' : ''}`} />
                            </div>
                        </button>

                        {/* Partial time pickers */}
                        {partial && (
                            <div className="rounded-xl bg-purple-50/50 border border-purple-200 p-3 space-y-2">
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="block text-[10px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                            {tx('Your start', 'Tu inicio')}
                                        </label>
                                        <input
                                            type="time"
                                            value={partialStart}
                                            onChange={(e) => setPartialStart(e.target.value)}
                                            min={shift.startTime}
                                            max={shift.endTime}
                                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm font-bold focus:outline-none focus:ring-2 focus:ring-purple-300 min-h-[44px]"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                            {tx('Your end', 'Tu fin')}
                                        </label>
                                        <input
                                            type="time"
                                            value={partialEnd}
                                            onChange={(e) => setPartialEnd(e.target.value)}
                                            min={shift.startTime}
                                            max={shift.endTime}
                                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm font-bold focus:outline-none focus:ring-2 focus:ring-purple-300 min-h-[44px]"
                                        />
                                    </div>
                                </div>
                                {!partialValid && (
                                    <div className="text-[11px] text-red-700 font-bold">
                                        {tx(
                                            "End must be after start, and both must be within the original shift.",
                                            "El fin debe ser después del inicio, y ambos dentro del turno original."
                                        )}
                                    </div>
                                )}
                                {partialValid && (
                                    <div className="text-[11px] text-purple-900">
                                        {tx(
                                            `Original holder keeps: `,
                                            `Dueño original mantiene: `
                                        )}
                                        {/* Compute leftover ranges (could be one or two slices) */}
                                        {[
                                            shift.startTime !== partialStart ? `${formatTime12h(shift.startTime)}–${formatTime12h(partialStart)}` : null,
                                            shift.endTime !== partialEnd   ? `${formatTime12h(partialEnd)}–${formatTime12h(shift.endTime)}`     : null,
                                        ].filter(Boolean).join(' + ') || tx('(none — full pickup)', '(ninguno — toma completa)')}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Hours preview */}
                        {weeklyHoursBefore != null && (
                            <div className={`rounded-xl border p-3 ${overtimeRisk ? 'bg-amber-50 border-amber-300' : 'bg-dd-green-50 border-dd-green/30'}`}>
                                <div className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2 mb-0.5">
                                    {tx('After you take', 'Después de tomar')}
                                </div>
                                <div className={`text-sm font-black ${overtimeRisk ? 'text-amber-900' : 'text-dd-green-700'}`}>
                                    {weeklyHoursAfter.toFixed(1)}h {tx('this week', 'esta semana')}
                                    {overtimeRisk && ' ⚠ OT'}
                                </div>
                                <div className="text-[11px] text-dd-text-2">
                                    {weeklyHoursBefore.toFixed(1)}h {tx('now', 'ahora')} + {shiftHours.toFixed(1)}h {tx('this shift', 'este turno')}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="px-4 py-3 border-t border-dd-line flex items-center justify-between gap-3 shrink-0">
                        <button
                            onClick={onClose}
                            disabled={busy}
                            className="px-4 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg disabled:opacity-40 min-h-[44px]"
                        >
                            {tx('Cancel', 'Cancelar')}
                        </button>
                        <button
                            onClick={handleSubmit}
                            disabled={!canSubmit}
                            className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-dd-green-700 min-h-[44px]"
                        >
                            {busy
                                ? tx('Taking…', 'Tomando…')
                                : partial
                                    ? tx('✋ Take partial', '✋ Tomar parcial')
                                    : tx('✋ Take shift', '✋ Tomar turno')}
                        </button>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}
