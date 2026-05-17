// EnableNotificationsBanner — first-sign-in nudge to grant push.
//
// Why this exists (2026-05-17):
// iOS Safari requires the Notification.requestPermission() call to come
// from a USER GESTURE (a click handler). Our App.jsx fires
// enableFcmPush() inside a useEffect on staff sign-in, which on iOS is
// NOT a user gesture — Safari silently blocks the prompt and the user
// never sees it. The result: tokens may or may not register, the OS
// never asks them to choose, and inbound pushes get dropped at the OS
// layer even though Firebase reports "delivered N tokens".
//
// This banner surfaces an explicit "🔔 Allow notifications" button.
// Tapping it counts as a user gesture, so the iOS prompt actually
// appears. Same component reused for the "denied" fallback message
// (which links to Settings since you can't re-prompt once denied).
//
// Visible only when Notification.permission ∈ { 'default', 'denied' }.
// Once granted, the banner returns null and the rest of the page
// reflows seamlessly.

import { useState, useEffect } from 'react';
import { enableFcmPush } from '../messaging';

export default function EnableNotificationsBanner({
    staffName, staffList, setStaffList, language = 'en',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // Permission state — read once on mount + after every tap. We don't
    // subscribe to Notification.permission because the API doesn't emit
    // a change event; the tap handler explicitly re-reads after the
    // prompt resolves.
    const [permission, setPermission] = useState(() => {
        if (typeof Notification === 'undefined') return 'unsupported';
        return Notification.permission;
    });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);

    // Re-check permission whenever the staff name changes (sign-in /
    // sign-out cycle). Also catches the case where the OS-level setting
    // was changed in a different tab.
    useEffect(() => {
        if (typeof Notification === 'undefined') {
            setPermission('unsupported');
            return;
        }
        setPermission(Notification.permission);
    }, [staffName]);

    // Hide entirely on:
    //   • already-granted devices (the happy path — no banner needed)
    //   • browsers / WebView wrappers without the Notification API
    if (permission === 'granted' || permission === 'unsupported') return null;

    async function handleEnable() {
        if (busy || !staffName) return;
        setBusy(true);
        setErr(null);
        try {
            // enableFcmPush internally calls Notification.requestPermission()
            // when current state is !== 'granted', then registers the
            // service worker + gets a token + stores it on the staff
            // record. Because we're inside an onClick handler, iOS Safari
            // accepts the requestPermission() call.
            const result = await enableFcmPush(staffName, staffList, setStaffList);
            // Re-read OS permission state — requestPermission resolved
            // either way (granted / denied / dismissed).
            setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
            if (!result.ok) {
                if (result.reason === 'permission-denied') {
                    setErr(tx(
                        'You tapped "Don\'t Allow". To turn notifications on later, go to iPhone Settings → Notifications → DD Mau.',
                        'Tocaste "No permitir". Para activar más tarde, ve a Ajustes → Notificaciones → DD Mau.',
                    ));
                } else if (result.reason === 'messaging-unsupported') {
                    setErr(tx(
                        'This device doesn\'t support push notifications.',
                        'Este dispositivo no soporta notificaciones push.',
                    ));
                } else {
                    setErr(tx('Could not enable. Try again in a minute.', 'No se pudo activar. Intenta de nuevo.'));
                }
            }
        } catch (e) {
            console.warn('enableFcmPush from banner failed:', e);
            setErr(tx('Something went wrong. Try again.', 'Algo salió mal. Intenta de nuevo.'));
        } finally {
            setBusy(false);
        }
    }

    // "denied" branch — we can't re-prompt; only iOS Settings can flip it.
    if (permission === 'denied') {
        return (
            <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-3 shadow-sm">
                <div className="flex items-start gap-2.5">
                    <span className="text-xl shrink-0">🔕</span>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-black text-amber-900">
                            {tx('Notifications are turned off', 'Notificaciones desactivadas')}
                        </div>
                        <p className="text-[11.5px] text-amber-900/85 leading-snug mt-0.5">
                            {tx(
                                "You won't get pushes for new chat messages, schedule updates, or announcements. To re-enable, open ",
                                'No recibirás avisos de chat, horario o anuncios. Para reactivar, abre ',
                            )}
                            <b>{tx('iPhone Settings', 'Ajustes')} → {tx('Notifications', 'Notificaciones')} → DD Mau</b>
                            {tx(' and turn on "Allow Notifications".', ' y activa "Permitir notificaciones".')}
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // "default" branch — the user has never granted or denied. Prompt
    // is allowed; the tap below triggers it.
    return (
        <div className="bg-gradient-to-r from-dd-sage-50 to-white border-2 border-dd-green/40 rounded-xl p-3 shadow-card">
            <div className="flex items-start gap-3">
                <span className="text-2xl shrink-0">🔔</span>
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-black text-dd-text">
                        {tx('Stay in the loop', 'Mantente al tanto')}
                    </div>
                    <p className="text-[12px] text-dd-text-2 leading-snug mt-0.5">
                        {tx(
                            'Turn on notifications to get chats, shift updates, and 86 alerts in real time.',
                            'Activa las notificaciones para recibir chats, cambios de turno y alertas 86 al instante.',
                        )}
                    </p>
                    {err && (
                        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1.5">
                            {err}
                        </p>
                    )}
                </div>
                <button
                    onClick={handleEnable}
                    disabled={busy}
                    className="shrink-0 px-3 py-2 rounded-full bg-dd-green text-white font-black text-xs shadow-sm hover:bg-dd-green-700 active:scale-95 transition disabled:opacity-50"
                >
                    {busy
                        ? tx('Enabling…', 'Activando…')
                        : tx('Allow', 'Permitir')}
                </button>
            </div>
        </div>
    );
}
