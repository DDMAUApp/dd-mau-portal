// InstallSplash — full-screen install guide reached via NFC sticker.
//
// Workflow:
//   1. Admin writes an NFC sticker (via "NFC Tools" or similar app)
//      with URL = https://app.ddmaustl.com/?install=1
//   2. Staff member taps phone to sticker → iOS/Android opens the URL.
//   3. App boots, detects ?install=1 (handled in App.jsx), and if the
//      page is NOT already running standalone, swaps to this splash.
//   4. Splash shows OS-specific Add-to-Home-Screen instructions.
//   5. After install, opening the new icon launches in standalone mode;
//      App.jsx detects display-mode:standalone and routes past this
//      splash to the normal lock screen.
//
// Apple does not allow programmatically triggering the Share sheet on
// iOS, so this is the closest we can get to a "frictionless install":
// a clear visual walk-through, ready the instant the URL loads.

import { useEffect, useState } from 'react';

function detectPlatform() {
    if (typeof navigator === 'undefined') return 'unknown';
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
    if (ua.includes('Mac') && navigator.maxTouchPoints > 1) return 'ios'; // iPadOS 13+
    if (/Android/i.test(ua)) return 'android';
    return 'desktop';
}

export default function InstallSplash({ onSkip, language = 'en' }) {
    const [platform] = useState(() => detectPlatform());
    const tx = (en, es) => (language === 'es' ? es : en);

    // Belt-and-suspenders: if the splash mounts while already running
    // standalone (race against App.jsx's pre-check), bail out via
    // onSkip. Without this, an installed user who scans the NFC tag
    // would see the splash even though they're already done.
    useEffect(() => {
        const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
            || window.navigator?.standalone === true;
        if (standalone) onSkip?.();
    }, [onSkip]);

    return (
        <div className="min-h-screen bg-gradient-to-b from-dd-bg to-dd-sage-100 flex flex-col items-center justify-start px-5 py-8">
            <div className="w-full max-w-md">
                <div className="text-center mb-6">
                    <div className="text-6xl mb-3">🍜</div>
                    <h1 className="text-2xl font-extrabold text-dd-text mb-1">DD Mau</h1>
                    <p className="text-sm text-dd-text-2">
                        {tx('Install on your phone to get schedules + alerts',
                            'Instala en tu teléfono para recibir horarios y alertas')}
                    </p>
                </div>

                {platform === 'ios' && (
                    <IOSSteps tx={tx} />
                )}
                {platform === 'android' && (
                    <AndroidSteps tx={tx} />
                )}
                {platform === 'desktop' && (
                    <DesktopHint tx={tx} />
                )}
                {platform === 'unknown' && (
                    <DesktopHint tx={tx} />
                )}

                <button
                    onClick={onSkip}
                    className="w-full mt-6 py-3 rounded-xl bg-white border-2 border-dd-line text-dd-text-2 text-sm font-bold hover:bg-dd-bg">
                    {tx('Skip for now — continue in browser', 'Omitir — continuar en el navegador')}
                </button>
            </div>
        </div>
    );
}

function IOSSteps({ tx }) {
    return (
        <div className="space-y-3">
            <Step n={1} title={tx('Tap the Share icon', 'Toca el ícono de Compartir')}
                body={tx('At the bottom of Safari — looks like a square with an up-arrow.',
                         'En la parte inferior de Safari — un cuadro con una flecha hacia arriba.')}
                icon="⬆️" />
            <Step n={2} title={tx('Scroll down and tap "Add to Home Screen"',
                                  'Desplázate y toca "Añadir a pantalla de inicio"')}
                body={tx('You may need to scroll the share menu down to find it.',
                         'Quizás tengas que desplazarte hacia abajo para verlo.')}
                icon="➕" />
            <Step n={3} title={tx('Tap "Add" in the top-right', 'Toca "Añadir" en la esquina superior')}
                body={tx('A DD Mau icon will appear on your Home Screen.',
                         'Un ícono de DD Mau aparecerá en tu pantalla de inicio.')}
                icon="✅" />
            <Step n={4} title={tx('Open from the Home Screen icon', 'Ábrelo desde el ícono de la pantalla de inicio')}
                body={tx('iPhone push notifications only work from the installed icon — not Safari.',
                         'iPhone solo entrega notificaciones desde el ícono instalado — no desde Safari.')}
                icon="🔔" />
            <div className="mt-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                <strong>{tx('Important:', 'Importante:')}</strong>{' '}
                {tx('this must be done in Safari, not Chrome or any other browser.',
                    'esto debe hacerse en Safari, no en Chrome ni otros navegadores.')}
            </div>
        </div>
    );
}

function AndroidSteps({ tx }) {
    return (
        <div className="space-y-3">
            <Step n={1} title={tx('Tap the three-dot menu', 'Toca el menú de tres puntos')}
                body={tx('Top-right of Chrome.', 'Esquina superior derecha de Chrome.')}
                icon="⋮" />
            <Step n={2} title={tx('Tap "Install app" or "Add to Home screen"',
                                  'Toca "Instalar app" o "Añadir a pantalla de inicio"')}
                body={tx('Some versions of Chrome show one or the other — pick whichever is there.',
                         'Algunas versiones de Chrome muestran una u otra — toca la que aparezca.')}
                icon="➕" />
            <Step n={3} title={tx('Confirm "Install"', 'Confirma "Instalar"')}
                body={tx('A DD Mau icon will be added to your Home Screen.',
                         'Un ícono de DD Mau se agregará a tu pantalla de inicio.')}
                icon="✅" />
            <Step n={4} title={tx('Open from the Home Screen icon', 'Ábrelo desde el ícono de la pantalla de inicio')}
                body={tx('You\'ll be prompted for notification permission on first open — tap Allow.',
                         'Te pedirá permiso de notificaciones al abrir — toca Permitir.')}
                icon="🔔" />
        </div>
    );
}

function DesktopHint({ tx }) {
    return (
        <div className="p-4 rounded-xl bg-white border border-dd-line text-sm text-dd-text-2">
            <p>
                {tx('Looks like you\'re on a computer. The DD Mau install is designed for phones — open this page on your iPhone or Android to install.',
                    'Parece que estás en una computadora. La instalación de DD Mau es para teléfonos — abre esta página en tu iPhone o Android para instalar.')}
            </p>
            <p className="mt-2 text-xs">
                {tx('Tip: ask the admin for an NFC sticker — just tap your phone to install instantly.',
                    'Tip: pide al administrador una calcomanía NFC — solo toca tu teléfono para instalar al instante.')}
            </p>
        </div>
    );
}

function Step({ n, title, body, icon }) {
    return (
        <div className="bg-white rounded-xl border border-dd-line p-3 flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-dd-green text-white font-bold text-sm flex items-center justify-center">
                {n}
            </div>
            <div className="flex-1 min-w-0">
                <div className="font-bold text-sm text-dd-text flex items-center gap-1.5">
                    <span>{title}</span>
                    {icon && <span className="text-base">{icon}</span>}
                </div>
                <div className="text-xs text-dd-text-2 mt-0.5 leading-relaxed">{body}</div>
            </div>
        </div>
    );
}
