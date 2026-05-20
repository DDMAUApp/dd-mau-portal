// Task type: sms_optin
//
// Self-service opt-in flow shown on login when the admin pushes this
// task to a staffer. The staffer must answer one of:
//   • "Yes, opt me in" → writes phoneE164 + smsOptIn=true + audit row
//   • "No thanks, push only" → writes smsOptIn=false + audit row (
//     opt_out row from source=self_app)
//
// Either answer counts as task complete. Skip is not allowed — we
// want an explicit choice for compliance evidence. If the staffer
// closes the app without answering, the task stays pending and they
// see it again on next login.

import { useState } from 'react';
import { db } from '../firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import {
    normalizeToE164, isValidPhone, formatE164ForDisplay,
    writeClientOptInEvent, CONSENT_TEXT,
} from '../data/sms';
import { toast } from '../toast';

export default function RequiredTaskSmsOptIn({
    task,
    staff,
    staffName,
    language,
    onComplete,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const [phoneDraft, setPhoneDraft] = useState(formatE164ForDisplay(staff?.phoneE164 || ''));
    const [submitting, setSubmitting] = useState(false);

    // Common write path — updates staff record + writes opt-in event.
    // For opt-in we MUST have a valid phone; for opt-out the phone is
    // optional (some staff have no number on file).
    const applyAnswer = async (answer) => {
        if (submitting) return;
        const wantsOptIn = answer === 'yes';
        let normalized = null;
        if (wantsOptIn) {
            normalized = normalizeToE164(phoneDraft);
            if (!normalized) {
                toast(tx(
                    'Phone number looks invalid. Use 10 digits or +1 format.',
                    'Número inválido. Usa 10 dígitos o formato +1.',
                ), { kind: 'error' });
                return;
            }
        }
        setSubmitting(true);
        try {
            // Update the staff record. We do a get+merge instead of
            // touching parent state because RequiredTaskFlow doesn't
            // own the staff list — App.jsx does. We write directly to
            // Firestore + let the existing onSnapshot listener in
            // App.jsx pick the update back up.
            const ref = doc(db, 'config', 'staff');
            const snap = await getDoc(ref);
            const list = (snap.exists() ? snap.data().list : []) || [];
            const nowIso = new Date().toISOString();
            const nextList = list.map(s => {
                if (s.name !== staffName) return s;
                if (wantsOptIn) {
                    return {
                        ...s,
                        phoneE164: normalized,
                        smsOptIn: true,
                        smsOptInAt: nowIso,
                        smsOptInBy: staffName,
                        smsOptInSource: 'self_app',
                    };
                }
                return {
                    ...s,
                    smsOptIn: false,
                };
            });
            await setDoc(ref, { list: nextList });

            // Audit event — the legal evidence trail.
            await writeClientOptInEvent({
                staffId: staff?.id ?? null,
                staffName,
                phoneE164: wantsOptIn ? normalized : (staff?.phoneE164 || null),
                action: wantsOptIn ? 'opt_in' : 'opt_out',
                source: 'self_app',
                byName: staffName,
                byId: staff?.id ?? null,
                note: `Required task ${task.id}`,
            });

            // Close the task with a snapshot of what they chose. The
            // snapshot stays on the task doc as the source-of-truth
            // record (in addition to the events collection — defense
            // in depth).
            await onComplete({
                answer,
                phoneE164: wantsOptIn ? normalized : null,
                at: nowIso,
            });
        } catch (e) {
            console.error('SMS opt-in task answer failed:', e);
            toast(tx('Could not save. Try again.', 'No se pudo guardar. Intenta de nuevo.'), { kind: 'error' });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="p-5 max-w-md mx-auto">
            <div className="text-5xl mb-3 text-center">📱</div>
            <h2 className="text-xl font-black text-dd-text mb-2 text-center">
                {tx('Get urgent text alerts?', '¿Recibir alertas urgentes?')}
            </h2>
            <p className="text-sm text-dd-text-2 mb-4 text-center">
                {tx(
                    'DD Mau can text you about shift reminders, coverage requests, schedule changes, and weather closures. Routine chat stays in the app.',
                    'DD Mau puede enviarte SMS para recordatorios de turno, coberturas, cambios de horario y cierres por clima. El chat normal queda en la app.',
                )}
            </p>

            {/* Phone field — required for opt-in. Pre-fills from the
                existing staff record if a number is already on file. */}
            <label className="block text-xs font-bold text-dd-text-2 uppercase tracking-wider mb-1">
                {tx('Phone number', 'Número de teléfono')}
            </label>
            <input
                type="tel"
                inputMode="tel"
                placeholder="(314) 555-1234"
                value={phoneDraft}
                onChange={e => setPhoneDraft(e.target.value)}
                className="w-full border border-dd-line rounded-lg px-3 py-2.5 text-base font-mono text-dd-text mb-3 focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50"
            />

            {/* Required compliance disclosure. CONSENT_TEXT is the same
                language stored verbatim in every opt-in event row. */}
            <div className="bg-dd-bg border border-dd-line rounded-lg p-3 mb-4">
                <p className="text-[11px] text-dd-text-2 leading-relaxed">
                    {isEs ? CONSENT_TEXT.es : CONSENT_TEXT.en}
                </p>
            </div>

            <div className="space-y-2">
                <button
                    onClick={() => applyAnswer('yes')}
                    disabled={submitting || !isValidPhone(phoneDraft)}
                    className="w-full py-3 rounded-xl bg-dd-green text-white font-black text-base active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed">
                    {submitting
                        ? tx('Saving…', 'Guardando…')
                        : tx('Yes, opt me in', 'Sí, activar SMS')}
                </button>
                <button
                    onClick={() => applyAnswer('no')}
                    disabled={submitting}
                    className="w-full py-3 rounded-xl bg-white border-2 border-dd-line text-dd-text-2 font-bold text-sm active:scale-95 transition disabled:opacity-50">
                    {tx('No thanks — push only', 'No, gracias — solo push')}
                </button>
            </div>

            <p className="text-[10px] text-dd-text-2 mt-3 text-center leading-relaxed">
                {tx(
                    'You can change this anytime in your profile, or reply STOP to any text to opt out.',
                    'Puedes cambiar esto en cualquier momento desde tu perfil, o responder STOP a cualquier mensaje.',
                )}
            </p>
        </div>
    );
}
