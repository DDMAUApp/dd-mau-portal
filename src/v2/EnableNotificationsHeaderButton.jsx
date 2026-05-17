// EnableNotificationsHeaderButton — small "fix notifications" pill that
// sits next to the bell in the app header.
//
// Why this exists alongside the home-page banner:
// The home banner only shows on the Home tab. Staff who land directly
// in Chat or Schedule (most common path on mobile when tapping a push)
// would never see it. The header bell is visible on EVERY page, so a
// permission indicator there is impossible to miss.
//
// Behavior:
//   • Notification.permission === 'granted'  → renders null (no UI)
//   • Notification.permission === 'default'  → small green "🔔!" pill
//     that pulses gently. Tap fires Notification.requestPermission()
//     directly (the click counts as a user gesture for iOS Safari)
//     and on grant runs enableFcmPush to register the token.
//   • Notification.permission === 'denied'   → amber "🔕" pill. Tap
//     opens a small popover with iOS Settings instructions.
//
// Renders nothing when Notification API is unavailable (e.g.
// Safari without PWA install). Self-contained — manages its own
// permission read + popover state.

import { useState, useEffect, useRef } from 'react';
import { enableFcmPush } from '../messaging';

export default function EnableNotificationsHeaderButton({
    staffName, staffList = [], setStaffList, language = 'en',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [permission, setPermission] = useState(() => {
        if (typeof Notification === 'undefined') return 'unsupported';
        return Notification.permission;
    });
    const [busy, setBusy] = useState(false);
    const [popoverOpen, setPopoverOpen] = useState(false);
    const popoverRef = useRef(null);

    // Re-read permission on sign-in change + when the popover closes
    // (the user may have toggled the OS setting in iPhone Settings).
    useEffect(() => {
        if (typeof Notification === 'undefined') {
            setPermission('unsupported');
            return;
        }
        setPermission(Notification.permission);
    }, [staffName, popoverOpen]);

    // Close popover on click-outside.
    useEffect(() => {
        if (!popoverOpen) return;
        function onClick(e) {
            if (popoverRef.current && !popoverRef.current.contains(e.target)) {
                setPopoverOpen(false);
            }
        }
        document.addEventListener('mousedown', onClick);
        document.addEventListener('touchstart', onClick);
        return () => {
            document.removeEventListener('mousedown', onClick);
            document.removeEventListener('touchstart', onClick);
        };
    }, [popoverOpen]);

    // Hide entirely on the happy path + on browsers without the API.
    if (permission === 'granted' || permission === 'unsupported') return null;

    async function handleClick() {
        if (permission === 'denied') {
            // OS won't re-prompt once denied; show inline guidance.
            setPopoverOpen(o => !o);
            return;
        }
        // 'default' — fire the OS prompt + token registration.
        if (busy || !staffName) return;
        setBusy(true);
        try {
            await enableFcmPush(staffName, staffList, setStaffList);
            setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
        } catch (e) {
            console.warn('header enable-notifications failed:', e);
            setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
        } finally {
            setBusy(false);
        }
    }

    const isDenied = permission === 'denied';
    const labelEn = isDenied ? 'Notifications off' : 'Enable notifications';
    const labelEs = isDenied ? 'Notificaciones apagadas' : 'Activar notificaciones';

    return (
        <div className="relative">
            <button
                onClick={handleClick}
                disabled={busy}
                aria-label={tx(labelEn, labelEs)}
                title={tx(labelEn, labelEs)}
                className={`min-w-[44px] min-h-[44px] md:w-9 md:h-9 rounded-lg flex items-center justify-center transition active:scale-95 disabled:opacity-60 ${
                    isDenied
                        ? 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
                        : 'bg-dd-green/10 text-dd-green-700 hover:bg-dd-green/20 border border-dd-green/30 animate-pulse'
                }`}
            >
                {isDenied ? (
                    <span className="text-base">🔕</span>
                ) : (
                    <span className="relative inline-flex items-center justify-center">
                        <span className="text-base">🔔</span>
                        <span className="absolute -top-1 -right-2 min-w-[14px] h-[14px] px-1 rounded-full bg-red-500 text-white text-[9px] font-black flex items-center justify-center ring-2 ring-white">!</span>
                    </span>
                )}
            </button>

            {/* Denied-state popover with iOS Settings guidance. Opens
                on tap (we can't reprompt from JS once denied — only the
                user's manual toggle in iPhone Settings can re-enable). */}
            {popoverOpen && (
                <div
                    ref={popoverRef}
                    className="absolute right-0 mt-2 w-72 bg-white border-2 border-amber-200 rounded-xl shadow-2xl p-3 z-50"
                >
                    <div className="flex items-start gap-2">
                        <span className="text-lg shrink-0">🔕</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-black text-dd-text">
                                {tx('Notifications are off', 'Notificaciones desactivadas')}
                            </div>
                            <p className="text-[11.5px] text-dd-text-2 leading-snug mt-1">
                                {tx(
                                    "You won't get pushes for chats, shifts, or 86 alerts. To re-enable:",
                                    'No recibirás avisos. Para reactivar:',
                                )}
                            </p>
                            <ol className="text-[11.5px] text-dd-text mt-1.5 space-y-0.5 list-decimal pl-4">
                                <li>{tx('Open iPhone Settings', 'Abre Ajustes en iPhone')}</li>
                                <li>{tx('Tap Notifications', 'Toca Notificaciones')}</li>
                                <li>{tx('Find DD Mau in the list', 'Busca DD Mau en la lista')}</li>
                                <li>{tx('Turn ON "Allow Notifications"', 'Activa "Permitir notificaciones"')}</li>
                            </ol>
                            <button
                                onClick={() => setPopoverOpen(false)}
                                className="mt-2 text-[11px] font-bold text-dd-text-2 hover:text-dd-text"
                            >
                                {tx('Close', 'Cerrar')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
