import { useState } from 'react';
import ModalPortal from './ModalPortal';
import { openExternalUrl } from '../capacitor-bridge';
import { db } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { notifyManagement } from '../data/notify';

// Native-app store links.
//   • iOS — the unlisted App Store build (only reachable via this direct link).
//   • Android — INTERNAL testing track. A manager adds the staffer's Google
//     email in Play Console → Internal testing → Testers; the staffer then
//     opens this internal-test opt-in link, taps "Become a tester," and
//     installs. Andrew 2026-06-25 — this is the correct opt-in URL (the old
//     /apps/testing/<package> closed-test link showed "not available"; the
//     internal track uses the /apps/internaltest/<id> form below).
//     NOTE: the opt-in only resolves once the staffer's email is on the
//     internal tester list; until then Play shows "not available".
const IOS_APP_URL = 'https://apps.apple.com/us/app/dd-mau-staff/id6776881912';
const ANDROID_APP_URL = 'https://play.google.com/apps/internaltest/4701656348790704265';

// Loose email shape check — we only need to reject obvious typos / empty
// submits before writing. Play Console does the authoritative validation
// when Andrew pastes the address into the tester list.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function InstallAppButton({ language, compact = false }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [open, setOpen] = useState(false);

    // Android tester-email capture (Andrew 2026-06-25). See the comment
    // block on the form below for why this exists.
    const [email, setEmail] = useState('');
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState(false);
    const [error, setError] = useState('');

    // Nothing to install if we're already the installed app (PWA standalone or
    // the native shell — both report false for the display-mode/navigator
    // checks inside a Capacitor WebView, so check Capacitor too).
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone || window.Capacitor?.isNativePlatform?.()) return null;

    // Reset the form alongside the sheet so a shared restaurant phone doesn't
    // show the previous staffer's "Sent!" confirmation to the next person.
    const close = () => {
        setOpen(false);
        setEmail('');
        setError('');
        setSent(false);
        setSending(false);
    };
    // Open the store, then dismiss the sheet.
    const go = (url) => { close(); openExternalUrl(url); };

    // ── Android tester self-service ────────────────────────────────────────
    // Andrew 2026-06-25: replaces the old "text Andrew your Google email"
    // copy with an in-app capture form. The closed-test opt-in only resolves
    // once the staffer's Google email is on the Play Console tester list, and
    // asking them to text it was easy to miss / fat-finger. Now they type it
    // right here and submit:
    //   1. The address lands in /tester_requests (durable record).
    //   2. notifyManagement pushes every owner/manager a bell + FCM ping with
    //      the email in the body, so Andrew can paste it into Play Console →
    //      Closed testing → Testers right away.
    // Best-effort: the Firestore doc is the source of truth; if the push
    // write fails we still treat the submit as sent. No PIN / lock-screen
    // logic is touched — this is additive UI on the install helper only.
    const submitEmail = async () => {
        const value = email.trim();
        if (!EMAIL_RE.test(value)) {
            setError(tx('Enter a valid email address.', 'Ingresa un correo válido.'));
            return;
        }
        setSending(true);
        setError('');
        try {
            await addDoc(collection(db, 'tester_requests'), {
                email: value,
                platform: 'android',
                status: 'pending',
                createdAt: serverTimestamp(),
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
            });
            // Push owners + managers so the request surfaces immediately.
            // Non-fatal: the /tester_requests doc above is the record of truth.
            try {
                await notifyManagement({
                    type: 'tester_email_request',
                    title: { en: 'New Android tester request', es: 'Nueva solicitud de probador Android' },
                    body: {
                        en: `${value} — add to Play Console testers.`,
                        es: `${value} — agregar a probadores de Play Console.`,
                    },
                    tag: `tester_email_request:${value}`,
                    createdBy: 'install_button',
                });
            } catch (e) {
                console.warn('tester_email_request notify failed (non-fatal):', e);
            }
            setSent(true);
        } catch (e) {
            console.warn('tester_request write failed:', e);
            setError(tx('Could not send — check your connection and try again.',
                'No se pudo enviar — revisa tu conexión e inténtalo de nuevo.'));
        } finally {
            setSending(false);
        }
    };

    const sheet = open && (
        <ModalPortal>
            <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-3"
                onClick={close} role="dialog" aria-modal="true">
                <div className="glass-sheet w-full sm:max-w-xs rounded-2xl p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-1">
                        <h3 className="text-base font-bold text-dd-text">📲 {tx('Get the app', 'Obtener la app')}</h3>
                        <button onClick={close} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 text-lg">×</button>
                    </div>
                    <p className="text-xs text-dd-text-2 mb-3">{tx('Which phone do you have?', '¿Qué teléfono tienes?')}</p>
                    <div className="space-y-2">
                        <button onClick={() => go(IOS_APP_URL)}
                            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white border border-dd-line hover:bg-dd-bg active:scale-95 transition">
                            <span className="text-2xl">📱</span>
                            <div className="text-left flex-1">
                                <div className="font-bold text-dd-text text-sm">iPhone</div>
                                <div className="text-[11px] text-dd-text-2">{tx('Open the App Store', 'Abrir el App Store')}</div>
                            </div>
                        </button>
                        <button onClick={() => go(ANDROID_APP_URL)}
                            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white border border-dd-line hover:bg-dd-bg active:scale-95 transition">
                            <span className="text-2xl">🤖</span>
                            <div className="text-left flex-1">
                                <div className="font-bold text-dd-text text-sm">Android</div>
                                <div className="text-[11px] text-dd-text-2">{tx('Become a tester, then install', 'Conviértete en probador e instala')}</div>
                            </div>
                        </button>
                    </div>
                    {/* Android tester onboarding — Andrew 2026-06-25: closed-test
                        opt-in only resolves once the staffer's Google email is on
                        the tester list. Instead of telling them to text Andrew,
                        capture the email in-app and ping the owners so Andrew can
                        add it in Play Console right away. iPhone path is
                        unaffected. See submitEmail() above for the write path. */}
                    <div className="mt-3 rounded-xl border border-dd-line bg-dd-bg/60 p-3">
                        {sent ? (
                            <p className="text-[12px] text-green-700 leading-snug">
                                ✅ {tx("Sent! Andrew will add you as a tester shortly — reopen Google Play once he gives you the OK.",
                                    "¡Enviado! Andrew te agregará como probador pronto — vuelve a abrir Google Play cuando te avise.")}
                            </p>
                        ) : (
                            <>
                                <p className="text-[11px] text-dd-text-2 mb-2 leading-tight">
                                    🤖 {tx('Android: if Google Play says “not available,” enter your Google email and Andrew will add you as a tester.',
                                        'Android: si Google Play dice “no disponible”, ingresa tu correo de Google y Andrew te agregará como probador.')}
                                </p>
                                <input
                                    type="email"
                                    inputMode="email"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    value={email}
                                    onChange={(e) => { setEmail(e.target.value); setError(''); }}
                                    placeholder={tx('you@gmail.com', 'tu@gmail.com')}
                                    className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm text-dd-text bg-white focus:outline-none focus:ring-2 focus:ring-cyan-300"
                                />
                                {error && <p className="text-[11px] text-red-600 mt-1">{error}</p>}
                                <button
                                    onClick={submitEmail}
                                    disabled={sending}
                                    className="mt-2 w-full px-3 py-2 rounded-lg bg-cyan-600 text-white text-sm font-semibold hover:bg-cyan-700 active:scale-95 transition disabled:opacity-60"
                                >
                                    {sending
                                        ? tx('Sending…', 'Enviando…')
                                        : tx('Send my email to Andrew', 'Enviar mi correo a Andrew')}
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </ModalPortal>
    );

    // Compact variant — slim chip on the lock screen (compact={true}).
    if (compact) {
        return (
            <div>
                <button
                    onClick={() => setOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-cyan-50 border border-cyan-200 rounded-full text-[12px] font-semibold text-cyan-700 hover:bg-cyan-100 transition"
                >
                    <span className="text-base leading-none">📲</span>
                    <span>{tx('Install app', 'Instalar app')}</span>
                </button>
                {sheet}
            </div>
        );
    }

    return (
        <div>
            <button
                onClick={() => setOpen(true)}
                className="w-full p-4 bg-gradient-to-br from-cyan-50 to-cyan-100 border-2 border-cyan-300 rounded-lg hover:shadow-lg transition text-left"
            >
                <div className="text-3xl mb-2">📲</div>
                <div className="font-bold text-cyan-700">{tx('Download App', 'Descargar App')}</div>
                <div className="text-xs text-cyan-600">
                    {tx('Install DD Mau on your phone for quick access', 'Instala DD Mau en tu teléfono para acceso rápido')}
                </div>
            </button>
            {sheet}
        </div>
    );
}
