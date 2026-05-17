// OffsiteClockPrompt — staff-side modal that fires on app open
// when the admin has scheduled an off-site assignment for this
// staff member.
//
// Two flavors of prompt, chosen by offsitePromptKind():
//   • clock_in_now — pending shift, arrival window is open
//                    ("Clock in to [location]?"  Yes / Not yet)
//   • clock_in_soon — pending shift, arrival is more than 15 min
//                    away (info-only chip, no blocking modal)
//   • clock_out    — active shift ("Clock out from [location]?"
//                    Yes / Not yet)
//   • done         — completed/cancelled, no prompt
//
// Behavior Andrew asked for:
//   • Staff taps "Yes" → clock-in or clock-out fires.
//   • Staff taps "Not yet" → modal closes, the app works normally.
//     The prompt re-shows on the next app launch automatically
//     (sessionStorage flag) AND after a 10-minute snooze even
//     within the same session — so the app keeps asking.
//   • If admin force-clocks-out from the admin panel, the shift
//     flips to status=completed and the prompt vanishes.
//
// Rendered at the top of App.jsx (outside any tab routing) so it
// surfaces regardless of which page the staff is on.

import { useState, useEffect, useMemo } from 'react';
import {
    subscribeOpenForStaff,
    offsitePromptKind,
    snoozeOffsitePrompt,
    isOffsitePromptSnoozed,
    clearAllOffsiteSnoozes,
    formatOffsiteWhen,
    clockIn,
    clockOut,
} from '../data/offsiteClock';
import { toast } from '../toast';

// Session-marker key. The presence of this in sessionStorage means
// the app has already rendered the prompt once during this browser
// tab session. On first render we clear every snooze key so a fresh
// launch re-asks the user even if they snoozed earlier today.
const SESSION_KEY = 'ddmau:offsite_session_init_v1';

export default function OffsiteClockPrompt({
    language = 'en', staffName, viewer,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const locale = isEs ? 'es' : 'en-US';

    const [shifts, setShifts] = useState([]);
    const [busyId, setBusyId] = useState(null);
    // Bumped every time we need currentShift to recompute outside of
    // a `shifts` change — i.e. when the user taps "Not yet" (writes a
    // snooze key to localStorage that the useMemo otherwise can't see)
    // and once per minute so an expired snooze re-opens the prompt
    // and a "clock_in_soon" shift transitions to "clock_in_now" when
    // its arrival window opens.
    //
    // Earlier version used `useState(0)` + `forceTick` to force a
    // render but DID NOT include the tick in the useMemo's deps. The
    // memo cached `currentShift` forever and "Not yet" looked broken
    // — modal stayed open after the tap because the cached shift
    // skipped the snooze check on every re-render. (2026-05-17 fix.)
    const [tick, setTick] = useState(0);

    // Clear snoozes on the first ever mount of this app session.
    // This is what makes "app close + reopen → re-prompt" work.
    useEffect(() => {
        try {
            if (!sessionStorage.getItem(SESSION_KEY)) {
                clearAllOffsiteSnoozes();
                sessionStorage.setItem(SESSION_KEY, String(Date.now()));
            }
        } catch { /* private-mode safari — best effort */ }
    }, []);

    // Subscribe to pending + active shifts for the signed-in staff.
    useEffect(() => {
        if (!staffName) return;
        return subscribeOpenForStaff(staffName, setShifts);
    }, [staffName]);

    // 60-second re-check tick. Drives two things:
    //   1. A snoozed shift becomes eligible again after the TTL
    //      passes — we need to re-render so the modal pops back up.
    //   2. A "clock in soon" shift transitions into "clock in now"
    //      when the arrival time arrives.
    useEffect(() => {
        const t = setInterval(() => setTick(n => n + 1), 60_000);
        return () => clearInterval(t);
    }, []);

    // Pick the highest-priority shift to surface right now. Order:
    //   1. Any active shift (clock_out) — they're already working
    //      somewhere, that's the most important state to resolve.
    //   2. Any pending shift whose arrival window has opened.
    // Snoozed shifts are skipped; we'll pick them up after the TTL.
    //
    // `tick` is in the deps so the snooze write from handleNotYet
    // (which only touches localStorage, not React state) actually
    // causes a recompute.
    const currentShift = useMemo(() => {
        const now = Date.now();
        // active first
        for (const s of shifts) {
            if (s.status !== 'active') continue;
            if (isOffsitePromptSnoozed(s.id, now)) continue;
            return s;
        }
        // pending where window is open
        for (const s of shifts) {
            if (s.status !== 'pending') continue;
            if (isOffsitePromptSnoozed(s.id, now)) continue;
            if (offsitePromptKind(s, now) === 'clock_in_now') return s;
        }
        return null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shifts, tick]);

    if (!staffName || !currentShift) return null;

    const kind = offsitePromptKind(currentShift);

    async function handleYes() {
        if (busyId) return;
        setBusyId(currentShift.id);
        try {
            if (kind === 'clock_out') {
                await clockOut({
                    id: currentShift.id,
                    staffName,
                    staffId: viewer?.id,
                });
            } else {
                await clockIn({
                    id: currentShift.id,
                    staffName,
                    staffId: viewer?.id,
                });
            }
        } catch (e) {
            console.warn('offsite yes failed:', e);
            toast(tx('Save failed — try again.', 'Error al guardar — intenta de nuevo.'), { kind: 'error' });
        } finally {
            setBusyId(null);
        }
    }

    function handleNotYet() {
        // Park it for 10 min (TTL inside snoozeOffsitePrompt).
        // The 60s re-check tick will re-open the modal once the
        // TTL expires. We bump `tick` here so the useMemo above
        // re-evaluates and sees the new snooze immediately —
        // otherwise the modal stays open after the tap.
        snoozeOffsitePrompt(currentShift.id);
        setTick(n => n + 1);
    }

    const isClockOut = kind === 'clock_out';

    return (
        <div className="fixed inset-0 z-[60] bg-black/55 flex items-end md:items-center justify-center p-3"
             role="dialog"
             aria-modal="true">
            <div className="bg-white w-full md:max-w-md md:rounded-2xl rounded-2xl shadow-2xl border-4 border-purple-300 overflow-hidden">
                {/* Header bar with the action's emoji + label */}
                <div className={`px-4 py-3 flex items-center gap-2 ${isClockOut ? 'bg-blue-100 border-b border-blue-300' : 'bg-purple-100 border-b border-purple-300'}`}>
                    <span className="text-2xl">{isClockOut ? '🏁' : '🚐'}</span>
                    <div className="flex-1 min-w-0">
                        <div className={`text-[11px] font-black uppercase tracking-widest ${isClockOut ? 'text-blue-900' : 'text-purple-900'}`}>
                            {isClockOut
                                ? tx('Clock out?', '¿Marcar salida?')
                                : tx('Off-site clock in', 'Fichaje fuera de sitio')}
                        </div>
                        <div className="text-[10px] text-gray-700 truncate">
                            {currentShift.location}
                        </div>
                    </div>
                </div>

                <div className="px-4 py-4 space-y-3">
                    {/* The actual question, in plain language */}
                    <p className="text-[15px] text-gray-800 leading-snug">
                        {isClockOut
                            ? tx(
                                <>Are you done with your shift at <b>{currentShift.location}</b>?</>,
                                <>¿Terminaste tu turno en <b>{currentShift.location}</b>?</>,
                              )
                            : tx(
                                <>Are you ready to clock in to your shift at <b>{currentShift.location}</b>?</>,
                                <>¿Listo para marcar tu entrada en <b>{currentShift.location}</b>?</>,
                              )}
                    </p>

                    {/* Context row — when it was scheduled / when they clocked in */}
                    <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 border border-gray-200 space-y-0.5">
                        <div>
                            ⏰ {tx('Scheduled arrival', 'Llegada programada')}: <b>{formatOffsiteWhen(currentShift.scheduledArrivalAt, locale)}</b>
                        </div>
                        {currentShift.clockedInAt && (
                            <div>
                                ▶️ {tx('Clocked in', 'Entrada')}: <b>{new Date(currentShift.clockedInAt.toMillis()).toLocaleString(locale, { hour: 'numeric', minute: '2-digit' })}</b>
                            </div>
                        )}
                        {currentShift.notes && (
                            <div className="italic">📝 {currentShift.notes}</div>
                        )}
                    </div>

                    {/* Yes / Not yet — yes wins by size + color */}
                    <div className="grid grid-cols-2 gap-2 pt-1">
                        <button
                            onClick={handleNotYet}
                            disabled={!!busyId}
                            className="px-4 py-3 rounded-xl bg-white text-gray-700 font-black text-base border-2 border-gray-300 hover:bg-gray-50 active:scale-[0.99] disabled:opacity-50"
                        >
                            {tx('Not yet', 'Aún no')}
                        </button>
                        <button
                            onClick={handleYes}
                            disabled={!!busyId}
                            className={`px-4 py-3 rounded-xl text-white font-black text-base shadow-md active:scale-[0.99] disabled:opacity-50 ${isClockOut ? 'bg-blue-600 hover:bg-blue-700' : 'bg-purple-600 hover:bg-purple-700'}`}
                        >
                            {busyId
                                ? tx('Saving…', 'Guardando…')
                                : isClockOut
                                ? '✓ ' + tx('Yes, clock me out', 'Sí, ciérrame')
                                : '✓ ' + tx('Yes, clock me in', 'Sí, ficha entrada')}
                        </button>
                    </div>

                    <p className="text-[10.5px] text-gray-500 italic text-center">
                        {isClockOut
                            ? tx(
                                'If you tap "Not yet" the app will keep asking. An owner can clock you out from the admin panel.',
                                'Si tocas "Aún no" la app seguirá preguntando. Un dueño puede cerrarlo desde admin.',
                              )
                            : tx(
                                'If you tap "Not yet" the app will keep asking until you arrive.',
                                'Si tocas "Aún no" la app seguirá preguntando hasta tu llegada.',
                              )}
                    </p>
                </div>
            </div>
        </div>
    );
}
