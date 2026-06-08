// Task type: install_pwa
//
// Forces the staffer to add DD Mau to their home screen before
// reaching the rest of the app. Critical because:
//   • iPhone Safari only delivers web push notifications when the
//     PWA is installed to the home screen. Plain-Safari iPhone
//     users get ZERO notifications otherwise.
//   • Android Chrome supports push from a regular tab but installs
//     are nicer (full screen, app icon, no URL bar).
//   • Desktop browsers usually deliver push fine from a tab, but
//     install is still a UX win.
//
// Detection chain:
//   1. Already in standalone display mode (window.matchMedia
//      '(display-mode: standalone)' OR iOS navigator.standalone) →
//      we silently mark pwaInstalled=true and complete the task.
//      No screen shown.
//   2. iOS in Safari → show iOS-specific instructions with the
//      Share-button → "Add to Home Screen" copy.
//   3. Android in Chrome → show Android-specific instructions.
//   4. iOS in a non-Safari browser (Chrome/Firefox) → tell them to
//      open the URL in Safari first (iOS limits PWA install to
//      Safari only).
//   5. Desktop / unknown → soft copy + a "share the link to my
//      phone" affordance (mailto:/tel:) so they can finish on
//      their phone.
//
// The task auto-resolves the next time the user opens the app in
// standalone mode (App.jsx writes staff.pwaInstalled = true; the
// requiredTasks framework's autoComplete predicate then closes
// the task on the next interceptor pass).

import { useEffect, useState } from 'react';
import { db } from '../firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { toast } from '../toast';

// Detect environment once per render. Cheap.
function detectEnv() {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isAndroid = /Android/.test(ua);
    const isMobile = isIOS || isAndroid;
    // iOS Safari requires the URL be opened in Safari to install.
    // Chrome on iOS will NOT show "Add to Home Screen" — it shows
    // a different (less useful) menu. So we need to detect Safari
    // specifically. The signature: Safari UA includes "Safari/" AND
    // does NOT include "CriOS" (Chrome iOS) or "FxiOS" (Firefox iOS).
    const isSafariOnIOS = isIOS && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    const isInStandalone = typeof window !== 'undefined' && (
        window.matchMedia?.('(display-mode: standalone)')?.matches === true
        || window.navigator.standalone === true
        || window.Capacitor?.isNativePlatform?.() === true
    );
    return { ua, isIOS, isAndroid, isMobile, isSafariOnIOS, isInStandalone };
}

export default function RequiredTaskInstallPwa({
    task,
    staff,
    staffName,
    language,
    onComplete,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const env = detectEnv();
    const [confirming, setConfirming] = useState(false);

    // If somehow we're already in standalone mode and the task is
    // still showing, just auto-complete. This catches the edge case
    // where the page-load detection effect in App.jsx didn't run
    // (e.g., this gate rendered before the staff record refreshed).
    useEffect(() => {
        if (env.isInStandalone && !confirming) {
            (async () => { await markInstalled('auto'); })();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [env.isInStandalone]);

    // Write pwaInstalled to the staff record + close the task.
    // method: 'auto' | 'manual' — included in the snapshot so admins
    // can tell auto-detected installs from "I-promise" manual taps.
    async function markInstalled(method) {
        if (confirming) return;
        setConfirming(true);
        try {
            const ref = doc(db, 'config', 'staff');
            const snap = await getDoc(ref);
            const list = (snap.exists() ? snap.data().list : []) || [];
            const nowIso = new Date().toISOString();
            const next = list.map(s => s.name === staffName
                ? { ...s, pwaInstalled: true, pwaInstalledAt: nowIso, pwaInstalledMethod: method }
                : s);
            await setDoc(ref, { list: next });
            await onComplete({
                method,
                userAgent: env.ua,
                isStandalone: env.isInStandalone,
                confirmedAt: nowIso,
            });
        } catch (e) {
            console.error('mark pwa installed failed:', e);
            toast(tx('Could not save. Try again.', 'No se pudo guardar. Intenta de nuevo.'), { kind: 'error' });
            setConfirming(false);
        }
    }

    // Build a URL the staffer can text/email to themselves so they
    // can finish the install on their phone. Same canonical URL the
    // hiring QR uses.
    const appUrl = (() => {
        try {
            const isProdLike = /ddmaustl\.com|github\.io/.test(window.location.hostname);
            return isProdLike ? 'https://app.ddmaustl.com' : window.location.origin;
        } catch { return 'https://app.ddmaustl.com'; }
    })();

    return (
        <div className="p-5 max-w-md mx-auto">
            <div className="text-5xl mb-3 text-center">📲</div>
            <h2 className="text-xl font-black text-dd-text mb-2 text-center">
                {tx('Add DD Mau to your home screen', 'Agrega DD Mau a tu pantalla')}
            </h2>
            <p className="text-sm text-dd-text-2 mb-4 text-center leading-relaxed">
                {tx(
                    'On iPhone, you only get notifications (shift reminders, coverage, schedule changes) when the app is on your home screen. This takes 30 seconds.',
                    'En iPhone, solo recibes notificaciones (recordatorios de turno, cobertura, cambios de horario) cuando la app está en tu pantalla. Toma 30 segundos.',
                )}
            </p>

            {/* ── iOS Safari path ────────────────────────────────────── */}
            {env.isIOS && env.isSafariOnIOS && (
                <div className="bg-white border-2 border-dd-line rounded-xl p-4 mb-4">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-3">
                        {tx('Steps on iPhone (Safari)', 'Pasos en iPhone (Safari)')}
                    </div>
                    <ol className="space-y-3 text-sm text-dd-text">
                        <li className="flex items-start gap-3">
                            <span className="bg-dd-green text-white rounded-full w-6 h-6 flex items-center justify-center font-black text-xs flex-shrink-0">1</span>
                            <span>{tx(
                                'Tap the share button at the bottom of Safari (a square with an arrow pointing up).',
                                'Toca el botón compartir abajo en Safari (un cuadrado con flecha hacia arriba).',
                            )}</span>
                        </li>
                        <li className="flex items-start gap-3">
                            <span className="bg-dd-green text-white rounded-full w-6 h-6 flex items-center justify-center font-black text-xs flex-shrink-0">2</span>
                            <span>{tx(
                                'Scroll down in the share menu and tap “Add to Home Screen.”',
                                'Desliza hacia abajo y toca “Añadir a inicio.”',
                            )}</span>
                        </li>
                        <li className="flex items-start gap-3">
                            <span className="bg-dd-green text-white rounded-full w-6 h-6 flex items-center justify-center font-black text-xs flex-shrink-0">3</span>
                            <span>{tx(
                                'Tap “Add” in the top-right corner.',
                                'Toca “Añadir” arriba a la derecha.',
                            )}</span>
                        </li>
                        <li className="flex items-start gap-3">
                            <span className="bg-dd-green text-white rounded-full w-6 h-6 flex items-center justify-center font-black text-xs flex-shrink-0">4</span>
                            <span>{tx(
                                'Find the DD Mau icon on your home screen. Open it from there from now on.',
                                'Busca el ícono DD Mau en tu pantalla. Ábrelo desde ahí de ahora en adelante.',
                            )}</span>
                        </li>
                    </ol>
                </div>
            )}

            {/* ── iOS but non-Safari browser ─────────────────────────── */}
            {env.isIOS && !env.isSafariOnIOS && (
                <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 mb-4">
                    <div className="text-sm font-black text-amber-900 mb-2">
                        ⚠️ {tx('Switch to Safari first', 'Cambia a Safari primero')}
                    </div>
                    <p className="text-sm text-amber-800 leading-relaxed mb-3">
                        {tx(
                            'On iPhone, only Safari can add this app to your home screen. Chrome and Firefox cannot.',
                            'En iPhone, solo Safari puede agregar esta app. Chrome y Firefox no pueden.',
                        )}
                    </p>
                    <p className="text-sm text-amber-800 leading-relaxed">
                        {tx(
                            'Open Safari → paste this address into the URL bar → then follow the share button steps:',
                            'Abre Safari → pega esta dirección en la barra → sigue los pasos del botón compartir:',
                        )}
                    </p>
                    <p className="text-sm font-mono bg-white border border-amber-200 rounded p-2 mt-2 break-all">
                        {appUrl}
                    </p>
                </div>
            )}

            {/* ── Android Chrome path ────────────────────────────────── */}
            {env.isAndroid && (
                <div className="bg-white border-2 border-dd-line rounded-xl p-4 mb-4">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-3">
                        {tx('Steps on Android (Chrome)', 'Pasos en Android (Chrome)')}
                    </div>
                    <ol className="space-y-3 text-sm text-dd-text">
                        <li className="flex items-start gap-3">
                            <span className="bg-dd-green text-white rounded-full w-6 h-6 flex items-center justify-center font-black text-xs flex-shrink-0">1</span>
                            <span>{tx(
                                'Tap the three-dot menu in the top-right of Chrome.',
                                'Toca el menú de tres puntos arriba a la derecha en Chrome.',
                            )}</span>
                        </li>
                        <li className="flex items-start gap-3">
                            <span className="bg-dd-green text-white rounded-full w-6 h-6 flex items-center justify-center font-black text-xs flex-shrink-0">2</span>
                            <span>{tx(
                                'Tap “Install app” or “Add to Home screen” (wording varies by Chrome version).',
                                'Toca “Instalar app” o “Añadir a la pantalla principal.”',
                            )}</span>
                        </li>
                        <li className="flex items-start gap-3">
                            <span className="bg-dd-green text-white rounded-full w-6 h-6 flex items-center justify-center font-black text-xs flex-shrink-0">3</span>
                            <span>{tx(
                                'Confirm the install. The DD Mau icon will appear on your home screen — open from there.',
                                'Confirma la instalación. El ícono DD Mau aparecerá en tu pantalla — ábrelo desde ahí.',
                            )}</span>
                        </li>
                    </ol>
                </div>
            )}

            {/* ── Desktop or unknown ─────────────────────────────────── */}
            {!env.isMobile && (
                <div className="bg-white border-2 border-dd-line rounded-xl p-4 mb-4">
                    <div className="text-sm font-bold text-dd-text mb-2">
                        💻 {tx('Looks like you are on a computer', 'Parece que estás en una computadora')}
                    </div>
                    <p className="text-sm text-dd-text-2 leading-relaxed mb-3">
                        {tx(
                            'Desktop browsers get notifications without an install — but you still want the app on your phone, where you actually receive shift alerts. Send yourself the link:',
                            'Las computadoras reciben notificaciones sin instalar — pero quieres la app en tu teléfono. Envíate el enlace:',
                        )}
                    </p>
                    <p className="text-sm font-mono bg-dd-bg border border-dd-line rounded p-2 mb-3 break-all">{appUrl}</p>
                    <button
                        onClick={async () => {
                            try {
                                await navigator.clipboard.writeText(appUrl);
                                toast(tx('Link copied — paste it to yourself', 'Enlace copiado — envíatelo'));
                            } catch {
                                toast(tx('Could not copy. Select the link and copy manually.', 'No se pudo copiar. Selecciona el enlace y cópialo a mano.'));
                            }
                        }}
                        className="w-full py-2 rounded-lg bg-white border-2 border-dd-line text-dd-text font-bold text-sm hover:bg-dd-bg">
                        📋 {tx('Copy link', 'Copiar enlace')}
                    </button>
                </div>
            )}

            {/* ── Manual confirm — works on every path. The framework
                ALSO auto-resolves the task next time the user opens
                the app in standalone mode (App.jsx writes
                staff.pwaInstalled = true on cold-start in standalone),
                so this button is the redundant "I promise I did it"
                fallback for paths where the standalone signal does
                not propagate fast enough. ────────────────────────── */}
            <button
                onClick={() => markInstalled('manual')}
                disabled={confirming}
                className="w-full py-3 rounded-xl bg-dd-green text-white font-black text-base active:scale-95 transition disabled:opacity-50">
                {confirming
                    ? tx('Saving…', 'Guardando…')
                    : tx('✓ I have added DD Mau to my home screen', '✓ Listo, ya la agregué')}
            </button>

            <p className="text-[10px] text-dd-text-2 mt-3 text-center leading-relaxed">
                {tx(
                    'Once installed, always open DD Mau from the home-screen icon — not from your browser — so notifications keep working.',
                    'Una vez instalada, abre DD Mau desde el ícono — no desde el navegador — para que las notificaciones sigan funcionando.',
                )}
            </p>
        </div>
    );
}
