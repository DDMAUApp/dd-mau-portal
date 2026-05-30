// ChatScheduleModal — pick a future date+time for a scheduled message.
//
// Flow:
//   1. User has draft text in the composer → taps 📅 schedule button
//   2. This modal opens. Quick presets ("in 1h", "tomorrow 8am",
//      "Monday 8am") plus a manual date+time picker.
//   3. Pick → modal returns the chosen Date via onPick(date). Caller
//      writes the scheduled_messages doc.
//
// Why a small modal vs. inline popover: the date+time inputs need
// breathing room, and the iOS native datetime picker takes over the
// screen anyway — a modal is the honest UX.
//
// We don't store the modal's selection; we just call back. The parent
// owns the scheduled_messages write so we don't have to wire Firestore
// through this component.

import { useState, useMemo } from 'react';
import ModalPortal from './ModalPortal';

export default function ChatScheduleModal({
    language = 'en', onPick, onClose, defaultMinutesFromNow = 60,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    // Default = an hour from now, rounded to the next 5 minutes so the
    // pre-filled picker looks intentional ("9:35 PM" not "9:34:17 PM").
    const initial = useMemo(() => {
        const d = new Date(Date.now() + defaultMinutesFromNow * 60_000);
        d.setSeconds(0, 0);
        const m = d.getMinutes();
        d.setMinutes(m + ((5 - (m % 5)) % 5));
        return d;
    }, [defaultMinutesFromNow]);

    const [dateStr, setDateStr] = useState(() => formatDateInputValue(initial));
    const [timeStr, setTimeStr] = useState(() => formatTimeInputValue(initial));

    // Build the chosen Date from the inputs. Falls back to initial if
    // the user clears a field (browsers can yield empty strings on
    // partial edits — guard so we never call new Date('') / NaN-time).
    const chosen = useMemo(() => {
        if (!dateStr || !timeStr) return initial;
        const d = new Date(`${dateStr}T${timeStr}`);
        if (Number.isNaN(d.getTime())) return initial;
        return d;
    }, [dateStr, timeStr, initial]);

    const isValid = chosen.getTime() > Date.now() + 30_000;  // must be >30s in the future
    const friendly = chosen.toLocaleString(isEs ? 'es' : 'en', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
    });

    const presets = useMemo(() => {
        const now = new Date();
        const in1h = new Date(now.getTime() + 3600_000);
        const tomorrow8 = new Date(now);
        tomorrow8.setDate(tomorrow8.getDate() + 1);
        tomorrow8.setHours(8, 0, 0, 0);
        const monday8 = (() => {
            const d = new Date(now);
            const offset = ((8 - d.getDay()) % 7) || 7;  // next Monday (or +7 if today)
            d.setDate(d.getDate() + offset);
            d.setHours(8, 0, 0, 0);
            return d;
        })();
        return [
            { key: 'in1h',    en: 'In 1 hour',    es: 'En 1 hora',     date: in1h },
            { key: 'tomorrow',en: 'Tomorrow 8am', es: 'Mañana 8am',    date: tomorrow8 },
            { key: 'monday',  en: 'Monday 8am',   es: 'Lunes 8am',     date: monday8 },
        ];
    }, []);

    function applyPreset(d) {
        setDateStr(formatDateInputValue(d));
        setTimeStr(formatTimeInputValue(d));
    }

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div
                className="bg-white w-full md:max-w-sm md:rounded-2xl rounded-t-2xl flex flex-col shadow-xl"
                onClick={(e) => e.stopPropagation()}
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between safe-top">
                    <div>
                        <h2 className="text-lg font-black text-dd-text">📅 {tx('Schedule send', 'Programar envío')}</h2>
                        <p className="text-[11px] text-dd-text-2">{tx('Pick when this message goes out', 'Elige cuándo se enviará')}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>

                <div className="p-4 space-y-3">
                    <div className="grid grid-cols-3 gap-1.5">
                        {presets.map(p => (
                            <button
                                key={p.key}
                                onClick={() => applyPreset(p.date)}
                                className="px-2 py-2 rounded-lg text-xs font-bold border-2 border-dd-line text-dd-text-2 hover:bg-dd-bg transition"
                            >
                                {isEs ? p.es : p.en}
                            </button>
                        ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                {tx('Date', 'Fecha')}
                            </label>
                            <input
                                type="date"
                                value={dateStr}
                                onChange={(e) => setDateStr(e.target.value)}
                                className="w-full px-2 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                            />
                        </div>
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                {tx('Time', 'Hora')}
                            </label>
                            <input
                                type="time"
                                value={timeStr}
                                onChange={(e) => setTimeStr(e.target.value)}
                                className="w-full px-2 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                            />
                        </div>
                    </div>
                    <div className={`text-xs text-center rounded-lg px-3 py-2 ${isValid
                        ? 'bg-dd-sage-50 border border-dd-green/30 text-dd-green-700'
                        : 'bg-amber-50 border border-amber-200 text-amber-700'}`}>
                        {isValid
                            ? `${tx('Sends', 'Envía')} ${friendly}`
                            : tx('Pick a time at least a minute from now', 'Elige al menos un minuto en el futuro')}
                    </div>
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex items-center justify-between gap-3 shrink-0">
                    <button onClick={onClose} className="px-3 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={() => isValid && onPick?.(chosen)}
                        disabled={!isValid}
                        className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-dd-green-700"
                    >
                        {tx('📅 Schedule', '📅 Programar')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

function formatDateInputValue(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function formatTimeInputValue(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
