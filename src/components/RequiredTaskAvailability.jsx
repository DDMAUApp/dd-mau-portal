// Task type: availability
//
// Forces the staffer to set their weekly availability before
// reaching the rest of the app. The actual editor lives inside
// Schedule.jsx (already used by AdminPanel for per-staff availability
// edits). We don't reimplement it here — we link the staffer to the
// schedule tab with a flag that opens the availability editor for
// THEM specifically.
//
// Auto-complete: once staff.availability has at least one slot, the
// app-shell interceptor's autoResolveTasksFor() will mark the task
// done on next refresh. The "I'm done" button is an explicit fallback
// for the case where the editor is in a different tab and the staffer
// has already filled it in elsewhere.

import { useState } from 'react';
import { db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { TASK_TYPES } from '../data/requiredTasks';
import { toast } from '../toast';

export default function RequiredTaskAvailability({
    task,
    staff,
    staffName,
    language,
    onComplete,
    onSkip,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const [checking, setChecking] = useState(false);
    const typeDef = TASK_TYPES.availability;

    // Sanity-recheck against Firestore. The staff prop is from the
    // App.jsx-level snapshot which may be a tick behind; if the user
    // just edited their availability in another tab, hitting "I'm
    // done" should succeed not "no availability set yet". So we
    // refetch before allowing completion.
    const handleDone = async () => {
        setChecking(true);
        try {
            const ref = doc(db, 'config', 'staff');
            const snap = await getDoc(ref);
            const list = (snap.exists() ? snap.data().list : []) || [];
            const me = list.find(s => s.name === staffName);
            if (!me || !typeDef.autoComplete(me)) {
                toast(tx(
                    'You have not set any availability yet. Fill in at least one day.',
                    'Aún no has configurado disponibilidad. Llena al menos un día.',
                ), { kind: 'error' });
                return;
            }
            await onComplete({
                answer: 'set',
                snapshot: me.availability,
                at: new Date().toISOString(),
            });
        } catch (e) {
            console.error('availability task check failed:', e);
            toast(tx('Could not verify. Try again.', 'No se pudo verificar. Intenta de nuevo.'), { kind: 'error' });
        } finally {
            setChecking(false);
        }
    };

    return (
        <div className="p-5 max-w-md mx-auto">
            <div className="text-5xl mb-3 text-center">📅</div>
            <h2 className="text-xl font-black text-dd-text mb-2 text-center">
                {tx('Set your weekly availability', 'Define tu disponibilidad semanal')}
            </h2>
            <p className="text-sm text-dd-text-2 mb-4 text-center leading-relaxed">
                {tx(
                    'Tell us which days and hours you can work. Managers use this to build the schedule.',
                    'Dinos qué días y horas puedes trabajar. Los gerentes usan esto para hacer el horario.',
                )}
            </p>

            {/* Tip block — sets expectations for what the editor looks
                like and how this task closes. */}
            <div className="bg-white border-2 border-dd-line rounded-xl p-4 mb-4">
                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-2">
                    {tx('How this works', 'Cómo funciona')}
                </div>
                <ul className="space-y-2 text-sm text-dd-text">
                    <li className="flex items-start gap-2">
                        <span className="text-dd-green flex-shrink-0">1.</span>
                        <span>{tx('Tap the button below to open your availability editor.', 'Toca el botón para abrir tu editor de disponibilidad.')}</span>
                    </li>
                    <li className="flex items-start gap-2">
                        <span className="text-dd-green flex-shrink-0">2.</span>
                        <span>{tx('Set windows for any day you can work — even just one day is enough to continue.', 'Marca horarios para los días que puedes trabajar — con uno basta para continuar.')}</span>
                    </li>
                    <li className="flex items-start gap-2">
                        <span className="text-dd-green flex-shrink-0">3.</span>
                        <span>{tx('Come back here and tap "I have set my availability".', 'Vuelve aquí y toca "Listo".')}</span>
                    </li>
                </ul>
            </div>

            {/* Open the schedule tab and route to the availability
                editor. Two-part dispatch:
                  1. sessionStorage key — Schedule's mount effect reads
                     this to auto-open the MyAvailabilityModal.
                  2. CustomEvent — App.jsx switches the active tab AND
                     temporarily bypasses the required-task gate so the
                     user actually lands on Schedule instead of being
                     bounced back to this screen. Gate re-evaluates on
                     next sign-in / staffName change. (Bug 2026-05-20:
                     this button did nothing because the gate didn't
                     yield even though setActiveTab fired.) */}
            <button
                onClick={() => {
                    try { sessionStorage.setItem('ddmau:scheduleOpenModal', 'availability'); } catch {}
                    window.dispatchEvent(new CustomEvent('ddmau:navigate', {
                        detail: { tab: 'schedule', sub: 'availability', fromRequiredTask: true },
                    }));
                }}
                className="w-full py-3 rounded-xl bg-dd-green text-white font-black text-base active:scale-95 transition mb-2">
                🗓 {tx('Open availability editor', 'Abrir editor de disponibilidad')}
            </button>

            <button
                onClick={handleDone}
                disabled={checking}
                className="w-full py-3 rounded-xl bg-white border-2 border-dd-green text-dd-green font-bold text-sm active:scale-95 transition disabled:opacity-50">
                {checking
                    ? tx('Checking…', 'Verificando…')
                    : tx('✓ I have set my availability', '✓ Listo, ya la configuré')}
            </button>

            {onSkip && (
                <button
                    onClick={onSkip}
                    className="w-full mt-2 py-2 text-[11px] text-dd-text-2 underline">
                    {tx('Skip for now', 'Saltar por ahora')}
                </button>
            )}
        </div>
    );
}
