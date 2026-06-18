import { useState } from 'react';
import ModalPortal from './ModalPortal';
import { openExternalUrl } from '../capacitor-bridge';

// Native-app store links (Andrew 2026-06-17: "ask iOS or Android").
//   • iOS  — the UNLISTED App Store build (only reachable via this direct link).
//   • Android — the Play *internal testing* opt-in link (Andrew 2026-06-17).
//     A staffer taps it once to join the test, then installs from Play. The
//     plain store URL won't resolve for non-testers while the app is internal.
const IOS_APP_URL = 'https://apps.apple.com/us/app/dd-mau-staff/id6776881912';
const ANDROID_APP_URL = 'https://play.google.com/apps/internaltest/4701656348790704265';

export default function InstallAppButton({ language, compact = false }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [showChooser, setShowChooser] = useState(false);

    // Nothing to install if we're already the installed app (PWA standalone or
    // the native shell — both report false for the display-mode/navigator
    // checks inside a Capacitor WebView, so check Capacitor too).
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone || window.Capacitor?.isNativePlatform?.()) return null;

    const go = (url) => { setShowChooser(false); openExternalUrl(url); };

    const chooser = showChooser && (
        <ModalPortal>
            <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-3"
                onClick={() => setShowChooser(false)} role="dialog" aria-modal="true">
                <div className="glass-sheet w-full sm:max-w-xs rounded-2xl p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-1">
                        <h3 className="text-base font-bold text-dd-text">📲 {tx('Get the app', 'Obtener la app')}</h3>
                        <button onClick={() => setShowChooser(false)}
                            className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 text-lg">×</button>
                    </div>
                    <p className="text-xs text-dd-text-2 mb-3">{tx('Which phone do you have?', '¿Qué teléfono tienes?')}</p>
                    <div className="space-y-2">
                        <button onClick={() => go(IOS_APP_URL)}
                            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white border border-dd-line hover:bg-dd-bg active:scale-95 transition">
                            <span className="text-2xl">📱</span>
                            <div className="text-left">
                                <div className="font-bold text-dd-text text-sm">iPhone</div>
                                <div className="text-[11px] text-dd-text-2">{tx('Open the App Store', 'Abrir el App Store')}</div>
                            </div>
                        </button>
                        <button onClick={() => go(ANDROID_APP_URL)}
                            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white border border-dd-line hover:bg-dd-bg active:scale-95 transition">
                            <span className="text-2xl">🤖</span>
                            <div className="text-left">
                                <div className="font-bold text-dd-text text-sm">Android</div>
                                <div className="text-[11px] text-dd-text-2">{tx('Open Google Play', 'Abrir Google Play')}</div>
                            </div>
                        </button>
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
                    onClick={() => setShowChooser(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-cyan-50 border border-cyan-200 rounded-full text-[12px] font-semibold text-cyan-700 hover:bg-cyan-100 transition"
                >
                    <span className="text-base leading-none">📲</span>
                    <span>{tx('Install app', 'Instalar app')}</span>
                </button>
                {chooser}
            </div>
        );
    }

    return (
        <div>
            <button
                onClick={() => setShowChooser(true)}
                className="w-full p-4 bg-gradient-to-br from-cyan-50 to-cyan-100 border-2 border-cyan-300 rounded-lg hover:shadow-lg transition text-left"
            >
                <div className="text-3xl mb-2">📲</div>
                <div className="font-bold text-cyan-700">{tx('Download App', 'Descargar App')}</div>
                <div className="text-xs text-cyan-600">
                    {tx('Install DD Mau on your phone for quick access', 'Instala DD Mau en tu teléfono para acceso rápido')}
                </div>
            </button>
            {chooser}
        </div>
    );
}
