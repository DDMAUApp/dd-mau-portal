import { useState } from 'react';
import ModalPortal from './ModalPortal';
import { openExternalUrl } from '../capacitor-bridge';

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
export const IOS_APP_URL = 'https://apps.apple.com/us/app/dd-mau-staff/id6776881912';
export const ANDROID_APP_URL = 'https://play.google.com/apps/internaltest/4701656348790704265';

export default function InstallAppButton({ language, compact = false }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [open, setOpen] = useState(false);

    // Nothing to install if we're already the installed app (PWA standalone or
    // the native shell — both report false for the display-mode/navigator
    // checks inside a Capacitor WebView, so check Capacitor too).
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone || window.Capacitor?.isNativePlatform?.()) return null;

    const close = () => setOpen(false);
    // Open the store, then dismiss the sheet.
    const go = (url) => { close(); openExternalUrl(url); };

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
                        the tester list, so route them straight to Andrew. Tell
                        Android users to TEXT Andrew their Google email and he adds
                        them as a tester (replaces the generic "ask a manager"
                        copy). iPhone path is unaffected. */}
                    <p className="text-[11px] text-dd-text-2 mt-3 leading-tight">
                        {tx('Android: if Google Play says “not available,” text Andrew your Google email and he’ll add you as a tester.',
                            'Android: si Google Play dice “no disponible”, envíale a Andrew un mensaje de texto con tu correo de Google y él te agregará como probador.')}
                    </p>
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
