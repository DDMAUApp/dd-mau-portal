// OnboardingApply — public job application form, surfaced from the
// PIN lock screen via a "New hire? Apply" button. No PIN required.
//
// On submit:
//   1. Append a doc to /onboarding_applications — admin sees a notification
//      pill in the Onboarding tab + can convert into a hire.
//   2. Fan out push notifications to admins via /notifications (Cloud
//      Function dispatchNotification picks it up and sends FCM).
//
// This is a low-trust input surface — anyone scanning the in-store QR or
// landing on /?apply=1 can submit. Mitigations:
//   - Schema-narrowed Firestore rule on /onboarding_applications/{appId}
//     (name required, length-capped).
//   - Application docs are admin-only deletable.
//   - Front-end debounce/cooldown to prevent obvious mash-spam.

import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, addDoc, doc, getDoc, serverTimestamp } from 'firebase/firestore';

const POSITIONS = [
    { en: 'Front of House (cashier, runner)', es: 'Frente (cajero, corredor)' },
    { en: 'Back of House (cook, prep)',        es: 'Cocina (cocinero, prep)' },
    { en: 'Dishwasher',                        es: 'Lavaplatos' },
    { en: 'Manager / Shift lead',              es: 'Gerente / Líder de turno' },
    { en: 'Other / not sure',                  es: 'Otro / no estoy seguro' },
];

const COOLDOWN_KEY = 'ddmau:applyLastSubmit';
const COOLDOWN_MS = 60 * 1000;   // 1 minute between submits per device

export default function OnboardingApply({ language = 'en', onClose, onSubmitted }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [name, setName] = useState('');
    const [age18, setAge18] = useState('yes');   // 'yes' | 'no'
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [position, setPosition] = useState('');
    const [location, setLocation] = useState('webster');
    const [availability, setAvailability] = useState('');
    const [note, setNote] = useState('');
    const [saving, setSaving] = useState(false);
    const [done, setDone] = useState(false);
    const [err, setErr] = useState('');

    const ok = name.trim().length > 1 && (phone.trim() || email.trim()) && !saving;

    const submit = async (e) => {
        e?.preventDefault();
        if (!ok) return;
        // Spam guard: one submit per minute per device.
        try {
            const last = parseInt(localStorage.getItem(COOLDOWN_KEY) || '0', 10) || 0;
            if (Date.now() - last < COOLDOWN_MS) {
                setErr(tx(
                    'You just sent one — wait a moment before sending another.',
                    'Acabas de enviar una — espera un momento antes de enviar otra.',
                ));
                return;
            }
        } catch {}
        setSaving(true);
        setErr('');
        try {
            const appRef = await addDoc(collection(db, 'onboarding_applications'), {
                name: name.trim(),
                under18: age18 === 'no',
                phone: phone.trim(),
                email: email.trim(),
                position,
                location,
                availability: availability.trim(),
                note: note.trim(),
                createdAt: serverTimestamp(),
                source: 'lock_screen',
            });
            // Push notify admins. We look up canViewOnboarding admins from
            // /config/staff.list and write one notification per recipient;
            // dispatchNotification fans out to FCM. Best-effort — don't
            // block the submit on failure.
            try {
                const staffSnap = await getDoc(doc(db, 'config', 'staff'));
                const list = (staffSnap.exists() ? staffSnap.data().list : []) || [];
                const recipients = list.filter(s => s.canViewOnboarding === true
                    || s.id === 40 || s.id === 41); // owners default-on
                await Promise.all(recipients.map(s =>
                    addDoc(collection(db, 'notifications'), {
                        forStaff: s.name,
                        type: 'onboarding_application',
                        title: isEs ? '🪪 Nueva aplicación de empleo' : '🪪 New job application',
                        body: `${name.trim()} · ${position || tx('not specified', 'sin especificar')}`,
                        link: '/onboarding',
                        createdAt: serverTimestamp(),
                        read: false,
                        createdBy: 'apply_form',
                    }).catch(() => null)
                ));
            } catch (e2) { console.warn('apply notify failed (non-fatal):', e2); }
            try { localStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch {}
            setDone(true);
            onSubmitted?.(appRef.id);
        } catch (e) {
            console.error('apply submit failed', e);
            setErr(tx('Could not submit. Try again.', 'No se pudo enviar. Intenta de nuevo.'));
        } finally {
            setSaving(false);
        }
    };

    if (done) {
        return (
            <div className="fixed inset-0 z-50 bg-dd-sage flex items-center justify-center p-4">
                <div className="max-w-sm w-full bg-white rounded-2xl border-2 border-green-200 shadow-lg p-6 text-center">
                    <p className="text-5xl mb-3">🎉</p>
                    <h2 className="text-xl font-black text-green-800 mb-2">
                        {tx('Got it!', '¡Recibido!')}
                    </h2>
                    <p className="text-sm text-gray-700">
                        {tx(
                            "Your application is in front of Julie and Andrew. We'll reach out soon.",
                            'Tu aplicación está con Julie y Andrew. Te contactaremos pronto.',
                        )}
                    </p>
                    <button onClick={onClose}
                        className="mt-5 w-full py-2.5 rounded-lg bg-dd-green text-white font-bold">
                        {tx('Done', 'Listo')}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 bg-dd-sage overflow-y-auto">
            <div className="max-w-lg mx-auto p-3 sm:p-6 space-y-4">
                <header className="flex items-start justify-between gap-2 pt-2">
                    <div>
                        <p className="text-3xl">🍜</p>
                        <h1 className="text-xl font-black text-dd-green-700 mt-1">
                            {tx('Apply at DD Mau', 'Solicitud de empleo en DD Mau')}
                        </h1>
                        <p className="text-xs text-gray-600 mt-1">
                            {tx(
                                'Fill this out — Julie or Andrew will text/email you back.',
                                'Llena esto — Julie o Andrew te contactarán.',
                            )}
                        </p>
                    </div>
                    <button onClick={onClose}
                        className="w-9 h-9 rounded-full bg-white border border-gray-300 text-gray-600 text-lg flex-shrink-0 shadow-sm">
                        ×
                    </button>
                </header>

                <form onSubmit={submit} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 space-y-3">
                    <ApplyField label={tx('Your full name', 'Tu nombre completo')} required>
                        <input value={name} onChange={e => setName(e.target.value)} required
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </ApplyField>

                    <ApplyField label={tx('Are you 18 or older?', '¿Tienes 18 años o más?')} required>
                        <div className="flex gap-2">
                            {['yes', 'no'].map(v => (
                                <button key={v} type="button" onClick={() => setAge18(v)}
                                    className={`flex-1 py-2 rounded-lg text-sm font-bold border-2 transition ${
                                        age18 === v
                                            ? 'bg-dd-sage-50 border-dd-green text-dd-green-700'
                                            : 'bg-white border-gray-300 text-gray-600'
                                    }`}>
                                    {v === 'yes' ? tx('Yes', 'Sí') : tx('No (under 18)', 'No (menor de 18)')}
                                </button>
                            ))}
                        </div>
                    </ApplyField>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <ApplyField label={tx('Phone', 'Teléfono')}>
                            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                                placeholder="(314) 555-1234"
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </ApplyField>
                        <ApplyField label={tx('Email', 'Correo')}>
                            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                                placeholder="you@example.com"
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </ApplyField>
                    </div>
                    <p className="text-[10px] text-gray-500 -mt-1">
                        {tx('Phone or email required — we need a way to reach you.',
                            'Teléfono o correo requerido — necesitamos contactarte.')}
                    </p>

                    <ApplyField label={tx('Role you\'re interested in', 'Puesto que te interesa')}>
                        <div className="space-y-1.5">
                            {POSITIONS.map((p, i) => {
                                const v = p.en;
                                return (
                                    <button key={i} type="button" onClick={() => setPosition(v)}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-sm font-semibold border-2 transition ${
                                            position === v
                                                ? 'bg-dd-sage-50 border-dd-green text-dd-green-700'
                                                : 'bg-white border-gray-300 text-gray-700'
                                        }`}>
                                        {isEs ? p.es : p.en}
                                    </button>
                                );
                            })}
                        </div>
                    </ApplyField>

                    <ApplyField label={tx('Which location?', '¿Qué ubicación?')}>
                        <select value={location} onChange={e => setLocation(e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                            <option value="webster">Webster Groves</option>
                            <option value="maryland">Maryland Heights</option>
                            <option value="either">{tx('Either / both', 'Cualquiera')}</option>
                        </select>
                    </ApplyField>

                    <ApplyField label={tx('When can you work?', '¿Cuándo puedes trabajar?')}>
                        <input value={availability} onChange={e => setAvailability(e.target.value)}
                            placeholder={tx('e.g. weekends, evenings, anytime', 'ej: fines de semana, tardes, cualquier hora')}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </ApplyField>

                    <ApplyField label={tx('Anything else?', '¿Algo más?')}>
                        <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
                            placeholder={tx('Experience, languages, etc.', 'Experiencia, idiomas, etc.')}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none" />
                    </ApplyField>

                    {err && <p className="text-xs text-red-600">{err}</p>}

                    <div className="flex gap-2 pt-2">
                        <button type="button" onClick={onClose}
                            className="flex-1 py-2.5 rounded-lg bg-gray-100 text-gray-700 font-bold text-sm">
                            {tx('Cancel', 'Cancelar')}
                        </button>
                        <button type="submit" disabled={!ok}
                            className="flex-1 py-2.5 rounded-lg bg-dd-green text-white font-bold text-sm disabled:opacity-50">
                            {saving ? tx('Sending…', 'Enviando…') : tx('Send application', 'Enviar')}
                        </button>
                    </div>
                </form>

                <p className="text-[10px] text-center text-gray-400 pb-6">
                    {tx('🔒 Your info goes directly to Julie and Andrew. No third parties.',
                        '🔒 Tu información va directo a Julie y Andrew. Sin terceros.')}
                </p>
            </div>
        </div>
    );
}

function ApplyField({ label, required, children }) {
    return (
        <label className="block">
            <span className="text-xs font-bold uppercase text-gray-600">
                {label}{required ? ' *' : ''}
            </span>
            <div className="mt-1">{children}</div>
        </label>
    );
}
