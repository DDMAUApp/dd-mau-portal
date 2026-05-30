// OfferShiftModal — glass-styled "put my shift up for grabs" composer.
//
// Replaces the native browser confirm() previously thrown by
// handleOfferShift in Schedule.jsx. The native dialog had two problems:
//   1. Looks janky/phishy on iOS home-screen install (renders with the
//      "From dd-mau-staff-app" header)
//   2. Binary OK/Cancel — no way for the offerer to add context
//
// New behavior:
//   - Glass sheet with the shift summary (date, time, location)
//   - Optional NOTE field — visible to pickers in their "Available to
//     pick up" panel and on the Take modal. Examples: "Doctor's appt,
//     would really appreciate it", "I can swap if you want my Fri"
//   - URGENT toggle — sets coverNeeded:true on the shift so it gets
//     the red-card treatment AND fires push to all qualified staff
//     (same fan-out as the Find Cover flow used to do separately).
//     This unifies "casual offer" and "urgent cover" into one composer.
//
// Submit contract: parent passes `onSubmit({ note, urgent })`. The
// parent owns the Firestore write so we don't duplicate write paths
// (and so we can keep handleApproveSwap's transaction in one place).

import { useState } from 'react';
import ModalPortal from './ModalPortal';
import { Megaphone, AlertTriangle } from 'lucide-react';

export default function OfferShiftModal({
    shift,
    formatTime12h,
    locationLabel,
    onSubmit,
    onClose,
    busy = false,
    language = 'en',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [note, setNote] = useState('');
    const [urgent, setUrgent] = useState(false);

    if (!shift) return null;

    const handleSubmit = async () => {
        try {
            await onSubmit?.({ note: note.trim(), urgent });
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
                    {/* Mobile pull handle */}
                    <div className="md:hidden flex justify-center pt-2 pb-1">
                        <div className="w-10 h-1 bg-dd-line rounded-full" />
                    </div>

                    {/* Header */}
                    <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between bg-blue-50 safe-top">
                        <div>
                            <h2 className="text-lg font-black text-blue-900 flex items-center gap-2">
                                <Megaphone size={18} strokeWidth={2.25} />
                                {tx('Up for grabs', 'Para tomar')}
                            </h2>
                            <p className="text-[11px] text-blue-800 leading-tight mt-0.5">
                                {tx(
                                    "You stay responsible until someone takes it AND a manager approves.",
                                    "Sigues siendo responsable hasta que alguien lo tome Y un gerente apruebe."
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
                        {/* Shift summary card */}
                        <div className="rounded-xl bg-dd-bg/40 border border-dd-line p-3">
                            <div className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                {tx('The shift', 'El turno')}
                            </div>
                            <div className="text-sm font-black text-dd-text">{shift.date}</div>
                            <div className="text-sm text-dd-text">
                                {formatTime12h(shift.startTime)}–{formatTime12h(shift.endTime)}
                            </div>
                            {locationLabel && (
                                <div className="text-xs text-dd-text-2 mt-0.5">{locationLabel}</div>
                            )}
                            {shift.role && (
                                <div className="text-xs text-dd-text-2 mt-0.5">{shift.role}</div>
                            )}
                        </div>

                        {/* Note */}
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                {tx('Note (optional)', 'Nota (opcional)')}
                            </label>
                            <textarea
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                placeholder={tx(
                                    'e.g. Doctor appt, would really appreciate it',
                                    'p. ej. Cita médica, lo agradecería mucho'
                                )}
                                rows={3}
                                maxLength={240}
                                className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none"
                            />
                            <div className="text-[10px] text-dd-text-2 mt-0.5 text-right">
                                {note.length}/240
                            </div>
                        </div>

                        {/* Urgent toggle */}
                        <button
                            type="button"
                            onClick={() => setUrgent(u => !u)}
                            className={`w-full flex items-center gap-3 rounded-xl border-2 px-3 py-3 text-left transition ${urgent
                                ? 'border-red-500 bg-red-50'
                                : 'border-dd-line bg-white hover:bg-dd-bg'}`}
                        >
                            <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${urgent ? 'bg-red-600 text-white' : 'bg-dd-bg text-dd-text-2'}`}>
                                <AlertTriangle size={20} strokeWidth={2.25} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className={`text-sm font-black ${urgent ? 'text-red-900' : 'text-dd-text'}`}>
                                    {tx('Mark urgent', 'Marcar urgente')}
                                </div>
                                <div className="text-[11px] text-dd-text-2 leading-tight">
                                    {tx(
                                        'Pushes an immediate alert to every qualified teammate.',
                                        'Envía una alerta inmediata a cada compañero calificado.'
                                    )}
                                </div>
                            </div>
                            <div className={`shrink-0 w-10 h-6 rounded-full p-0.5 transition ${urgent ? 'bg-red-600' : 'bg-dd-line'}`}>
                                <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${urgent ? 'translate-x-4' : ''}`} />
                            </div>
                        </button>
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
                            disabled={busy}
                            className={`px-4 py-2 rounded-full font-bold text-sm shadow-sm disabled:opacity-40 min-h-[44px] ${urgent
                                ? 'bg-red-600 text-white hover:bg-red-700'
                                : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                        >
                            {busy
                                ? tx('Posting…', 'Publicando…')
                                : urgent
                                    ? tx('🆘 Post URGENT', '🆘 Publicar URGENTE')
                                    : tx('📢 Post offer', '📢 Publicar oferta')}
                        </button>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}
