import { useState } from 'react';
import ModalPortal from './ModalPortal';
import { openExternalUrl } from '../capacitor-bridge';

// Native-app store links.
//   • iOS — the unlisted App Store build (only reachable via this direct link).
//   • Android — CLOSED testing, gated by a Google Group. A staffer must FIRST
//     join the testers group, THEN open the Play opt-in to become a tester +
//     install (group membership is what authorizes them). Andrew 2026-06-23 —
//     "make the Android side first ask to join the google group, seamless."
//     NOTE: the Play opt-in only resolves once the closed test is sent to
//     Google for review + live; until then it shows "not available".
const IOS_APP_URL = 'https://apps.apple.com/us/app/dd-mau-staff/id6776881912';
const ANDROID_GROUP_URL = 'https://groups.google.com/g/ddmau';
const ANDROID_APP_URL = 'https://play.google.com/apps/testing/com.ddmau.staff';

export default function InstallAppButton({ language, compact = false }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [open, setOpen] = useState(false);
    const [view, setView] = useState('choose');   // 'choose' | 'android'
    const [joined, setJoined] = useState(false);   // step-1 (join group) tapped

    // Nothing to install if we're already the installed app (PWA standalone or
    // the native shell — both report false for the display-mode/navigator
    // checks inside a Capacitor WebView, so check Capacitor too).
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone || window.Capacitor?.isNativePlatform?.()) return null;

    const close = () => { setOpen(false); setView('choose'); setJoined(false); };
    // Final step — open the store, then dismiss the sheet.
    const go = (url) => { close(); openExternalUrl(url); };
    // Step 1 — open the group in a new tab but KEEP the sheet so the user can
    // come back and do step 2 (openExternalUrl uses window.open(_blank) on web).
    const joinGroup = () => { setJoined(true); openExternalUrl(ANDROID_GROUP_URL); };

    const sheet = open && (
        <ModalPortal>
            <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-3"
                onClick={close} role="dialog" aria-modal="true">
                <div className="glass-sheet w-full sm:max-w-xs rounded-2xl p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>

                    {view === 'choose' && (
                        <>
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
                                <button onClick={() => setView('android')}
                                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white border border-dd-line hover:bg-dd-bg active:scale-95 transition">
                                    <span className="text-2xl">🤖</span>
                                    <div className="text-left flex-1">
                                        <div className="font-bold text-dd-text text-sm">Android</div>
                                        <div className="text-[11px] text-dd-text-2">{tx('2 quick steps', '2 pasos rápidos')}</div>
                                    </div>
                                    <span className="text-dd-text-2 text-lg leading-none">›</span>
                                </button>
                            </div>
                        </>
                    )}

                    {view === 'android' && (
                        <>
                            <div className="flex items-center justify-between mb-1">
                                <div className="flex items-center gap-1.5 min-w-0">
                                    <button onClick={() => { setView('choose'); setJoined(false); }}
                                        className="w-7 h-7 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 text-lg leading-none flex items-center justify-center"
                                        aria-label={tx('Back', 'Atrás')}>‹</button>
                                    <h3 className="text-base font-bold text-dd-text truncate">🤖 {tx('Android setup', 'Configurar Android')}</h3>
                                </div>
                                <button onClick={close} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 text-lg">×</button>
                            </div>
                            <p className="text-xs text-dd-text-2 mb-3">{tx('Two quick steps — about a minute.', 'Dos pasos rápidos — un minuto.')}</p>

                            {/* Step 1 — join the Google Group (authorizes the install) */}
                            <div className={`rounded-xl border p-3 mb-2 transition ${joined ? 'border-green-300 bg-green-50' : 'border-dd-line bg-white'}`}>
                                <div className="flex items-start gap-2.5">
                                    <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${joined ? 'bg-dd-green text-white' : 'bg-dd-bg text-dd-text-2'}`}>
                                        {joined ? '✓' : '1'}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-bold text-dd-text text-sm">{tx('Join the testers group', 'Únete al grupo de probadores')}</div>
                                        <div className="text-[11px] text-dd-text-2 leading-tight mb-2">{tx('One tap — this is what lets Google give you the app.', 'Un toque — esto permite que Google te dé la app.')}</div>
                                        <button onClick={joinGroup}
                                            className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 active:scale-95 transition">
                                            {joined ? tx('Reopen group ↗', 'Reabrir grupo ↗') : tx('Join group ↗', 'Unirse al grupo ↗')}
                                        </button>
                                        {joined && (
                                            <div className="text-[11px] text-dd-green font-semibold mt-1.5">{tx('Tap “Join group” in the new tab, then come back ↩', 'Toca “Unirse” en la pestaña, luego vuelve ↩')}</div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Step 2 — Play opt-in + install (dimmed until step 1 is done) */}
                            <div className={`rounded-xl border border-dd-line p-3 transition ${joined ? 'bg-white' : 'bg-white opacity-60'}`}>
                                <div className="flex items-start gap-2.5">
                                    <div className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold bg-dd-bg text-dd-text-2">2</div>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-bold text-dd-text text-sm">{tx('Get the app on Google Play', 'Obtén la app en Google Play')}</div>
                                        <div className="text-[11px] text-dd-text-2 leading-tight mb-2">{tx('Tap “Become a tester,” then Install.', 'Toca “Convertirme en probador”, luego Instalar.')}</div>
                                        <button onClick={() => go(ANDROID_APP_URL)}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-bold active:scale-95 transition ${joined ? 'bg-dd-green text-white hover:opacity-90' : 'bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50'}`}>
                                            {tx('Open Google Play ↗', 'Abrir Google Play ↗')}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
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
