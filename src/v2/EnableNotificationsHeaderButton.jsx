// EnableNotificationsHeaderButton — small "fix notifications" pill that
// sits next to the bell in the app header.
//
// Why this exists alongside the home-page banner:
// The home banner only shows on the Home tab. Staff who land directly
// in Chat or Schedule (most common path on mobile when tapping a push)
// would never see it. The header bell is visible on EVERY page, so a
// permission indicator there is impossible to miss.
//
// Behavior (four states):
//   • Notification.permission === 'granted' AND device token registered
//                                                → renders null (happy path)
//   • Notification.permission === 'granted' BUT no token for this device
//                                                → BLUE "🔄" refresh pill —
//     tap fires enableFcmPush to register fresh. (Andrew 2026-05-17:
//     when push delivery silently breaks — token rotation, cross-staff
//     sweep, FCM expiry — staff had no visible way to fix it without
//     digging into Admin → Push diagnostic. The header pill now
//     surfaces it.)
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
import { toast } from '../toast';

const DEVICE_ID_KEY = 'ddmau:fcmDeviceId';

// Resolve whether THIS device has an FCM token already registered on
// the current staff member's record. Returns true if the staff record
// has any fcmTokens entry whose deviceId matches the localStorage
// device identifier. False otherwise (including when localStorage
// is empty — fresh devices haven't run enableFcmPush yet).
function deviceHasToken(staffName, staffList) {
    if (!staffName || !Array.isArray(staffList) || staffList.length === 0) {
        // Optimistic: while staff list is still loading, assume happy
        // path so we don't briefly flash the refresh pill at sign-in.
        return true;
    }
    let deviceId = null;
    try { deviceId = localStorage.getItem(DEVICE_ID_KEY); } catch {}
    if (!deviceId) return false; // localStorage cleared / never registered
    const me = staffList.find(s => s.name === staffName);
    if (!me) return true; // not in list → don't surface the pill
    const tokens = Array.isArray(me.fcmTokens) ? me.fcmTokens : [];
    return tokens.some(t => t && t.deviceId === deviceId);
}

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

    // Resolve the four-state status. `needsRefresh` is the new state
    // for the "permission granted, but FCM token is missing" gap.
    if (permission === 'unsupported') return null;
    const hasToken = deviceHasToken(staffName, staffList);
    const needsRefresh = permission === 'granted' && !hasToken;
    // Happy path — granted AND token registered. No UI.
    if (permission === 'granted' && hasToken) return null;

    async function doRegister(successKey) {
        if (busy || !staffName) return;
        setBusy(true);
        try {
            const result = await enableFcmPush(staffName, staffList, setStaffList);
            setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
            if (result?.ok) {
                toast(
                    successKey === 'refresh'
                        ? tx('🔔 Notifications refreshed.', '🔔 Notificaciones actualizadas.')
                        : tx('🔔 Notifications enabled.', '🔔 Notificaciones activadas.'),
                    { kind: 'success', duration: 4000 }
                );
            } else if (result?.reason === 'permission-denied') {
                toast(tx('Permission denied. Open iPhone Settings → Notifications → DD Mau.',
                          'Permiso denegado. Abre Ajustes → Notificaciones → DD Mau.'),
                    { kind: 'warn', duration: 6000 });
            } else if (result?.reason) {
                toast(tx('Could not register: ', 'No se pudo registrar: ') + result.reason,
                    { kind: 'error', duration: 6000 });
            }
        } catch (e) {
            console.warn('header enable-notifications failed:', e);
            setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
            toast(tx('Something went wrong. Try again.', 'Algo salió mal. Intenta de nuevo.'),
                { kind: 'error' });
        } finally {
            setBusy(false);
        }
    }

    async function handleClick() {
        if (permission === 'denied') {
            // OS won't re-prompt once denied; show inline guidance.
            setPopoverOpen(o => !o);
            return;
        }
        if (needsRefresh) {
            // Granted but no token — fire enableFcmPush to refresh.
            await doRegister('refresh');
            return;
        }
        // 'default' — fire the OS prompt + token registration.
        await doRegister('enable');
    }

    const isDenied = permission === 'denied';
    const labelEn = isDenied
        ? 'Notifications off'
        : needsRefresh
            ? 'Refresh notifications'
            : 'Enable notifications';
    const labelEs = isDenied
        ? 'Notificaciones apagadas'
        : needsRefresh
            ? 'Actualizar notificaciones'
            : 'Activar notificaciones';

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
                        : needsRefresh
                            // Blue refresh state — distinct from the green
                            // "Enable" state so a user who's been seeing
                            // green for a while notices when the icon
                            // changes shape/color (= "your token broke,
                            // tap to fix"). Same animate-pulse so it still
                            // catches the eye.
                            ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 animate-pulse'
                            : 'bg-dd-green/10 text-dd-green-700 hover:bg-dd-green/20 border border-dd-green/30 animate-pulse'
                }`}
            >
                {isDenied ? (
                    <span className="text-base">🔕</span>
                ) : needsRefresh ? (
                    <span className="relative inline-flex items-center justify-center">
                        <span className="text-base">🔔</span>
                        <span className="absolute -top-1 -right-2 min-w-[14px] h-[14px] px-1 rounded-full bg-blue-500 text-white text-[9px] font-black flex items-center justify-center ring-2 ring-white">↻</span>
                    </span>
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
