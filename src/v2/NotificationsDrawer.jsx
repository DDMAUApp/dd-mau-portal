// NotificationsDrawer — cross-app notifications panel.
//
// Replaces the bell-jumps-to-Schedule hack with a proper drawer that
// shows EVERY unread notification for the current user across the app.
// Mark-read is per-item; the bell red dot in the header reflects the
// unread count and disappears when nothing's pending.
//
// Data model (Firestore):
//   collections/notifications/{id} = {
//     forStaff: string,         // staff name (matches staffList.name)
//     read: boolean,
//     createdAt: timestamp,
//     type: 'shift_published' | 'shift_offered' | 'shift_taken' |
//           'swap_request' | 'pto_approved' | 'pto_denied' |
//           'task_assigned' | 'task_handoff' | 'chat_message' |
//           'eighty_six_alert' | 'tardy_logged' | 'handoff_*' | ...
//                              // (legacy: `kind`, still read as a fallback)
//     title: string,            // short headline (already localized at write time)
//     body: string,             // 1-2 line body
//     deepLink: 'schedule' | 'operations' | 'chat' | ... (optional;
//                              // inferred from type family when absent)
//   }
//
// The drawer subscribes to forStaff == currentStaffName and renders
// the most recent 50, sorted by createdAt desc. Tapping an item marks
// it read AND optionally navigates to its deepLink tab.

import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, updateDoc, writeBatch } from 'firebase/firestore';
import { useAppData } from './AppDataContext';
import { enableFcmPush } from '../messaging';
import { toast } from '../toast';

// Defensive render-time resolver for legacy notification docs whose
// title/body was written as { en, es } before the write-time fix in
// data/notify.js (commit 2026-05-16). Bell drawer used to crash on
// mobile when an object was passed to `{item.title}` ("Objects are
// not valid as a React child"). Belt + suspenders — even if a future
// write site sneaks an object through, the drawer renders.
function toText(val, isEs) {
    if (val == null) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'object') {
        return val[isEs ? 'es' : 'en'] || val.en || val.es || '';
    }
    return String(val);
}

function timeAgo(ts, isEs) {
    if (!ts) return '';
    try {
        const d = ts.toDate ? ts.toDate() : new Date(ts);
        const diffMin = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
        if (diffMin < 1) return isEs ? 'ahora' : 'just now';
        if (diffMin < 60) return isEs ? `hace ${diffMin}m` : `${diffMin}m ago`;
        const h = Math.round(diffMin / 60);
        if (h < 24) return isEs ? `hace ${h}h` : `${h}h ago`;
        const days = Math.round(h / 24);
        return isEs ? `hace ${days}d` : `${days}d ago`;
    } catch { return ''; }
}

// Type-keyed metadata.
//
// HISTORICAL NOTE (Andrew 2026-05-17 polish pass): writer sites in
// notify.js / Schedule / Eighty6 / etc. write `type:`, but this drawer
// originally read `item.kind`. Result: every notification fell through
// to the default 🔔 icon and tone — the rich KIND_META table below
// was dead code for months. The lookup now reads `item.type ?? item.kind`
// (`kind` retained for the legacy schema in the file header) and the
// table is extended with the full set of `type` values actually written
// by the app, plus a prefix-based fallback for unknown family members.
const KIND_META = {
    // Shifts
    shift_published:        { icon: '📅', tone: 'bg-dd-green-50 text-dd-green-700' },
    shift_offered:          { icon: '📣', tone: 'bg-blue-50 text-blue-700' },
    shift_taken:            { icon: '🤝', tone: 'bg-purple-50 text-purple-700' },
    shift_approved:         { icon: '✓',  tone: 'bg-dd-green-50 text-dd-green-700' },
    shift_deleted:          { icon: '🗑', tone: 'bg-red-50 text-red-700' },
    shift_deleted_admin:    { icon: '🗑', tone: 'bg-red-50 text-red-700' },
    shift_edited:           { icon: '✏️', tone: 'bg-amber-50 text-amber-800' },
    shift_reminder:         { icon: '⏰', tone: 'bg-amber-50 text-amber-800' },
    // PTO
    pto_approved:           { icon: '🌴', tone: 'bg-dd-green-50 text-dd-green-700' },
    pto_denied:             { icon: '🌴', tone: 'bg-red-50 text-red-700' },
    pto_request:            { icon: '🌴', tone: 'bg-amber-50 text-amber-800' },
    pto_withdrawn:          { icon: '🌴', tone: 'bg-dd-bg text-dd-text-2' },
    // Swap
    swap_request:           { icon: '🔄', tone: 'bg-blue-50 text-blue-700' },
    swap_approved:          { icon: '✓',  tone: 'bg-dd-green-50 text-dd-green-700' },
    swap_approved_admin:    { icon: '✓',  tone: 'bg-dd-green-50 text-dd-green-700' },
    swap_denied:            { icon: '✕',  tone: 'bg-red-50 text-red-700' },
    swap_denied_admin:      { icon: '✕',  tone: 'bg-red-50 text-red-700' },
    swap_pending:           { icon: '⏳', tone: 'bg-purple-50 text-purple-700' },
    // Tasks
    task_assigned:          { icon: '📋', tone: 'bg-blue-50 text-blue-700' },
    task_message:           { icon: '💬', tone: 'bg-blue-50 text-blue-700' },
    task_comment:           { icon: '💬', tone: 'bg-blue-50 text-blue-700' },
    task_handoff:           { icon: '🤝', tone: 'bg-purple-50 text-purple-700' },
    // Chat
    chat_message:           { icon: '💬', tone: 'bg-dd-green-50 text-dd-green-700' },
    chat_mention:           { icon: '📣', tone: 'bg-amber-50 text-amber-800' },
    // 86 board
    eighty_six_alert:       { icon: '🚫', tone: 'bg-red-50 text-red-700' },
    // Handoff / Tardies / Sauce
    handoff_acknowledged:   { icon: '✓',  tone: 'bg-dd-green-50 text-dd-green-700' },
    handoff_submitted:      { icon: '🤝', tone: 'bg-purple-50 text-purple-700' },
    tardy_logged:           { icon: '⏰', tone: 'bg-amber-50 text-amber-800' },
    sauce_urgent:           { icon: '🌶', tone: 'bg-red-50 text-red-700' },
    sauce_request:          { icon: '🥣', tone: 'bg-amber-50 text-amber-800' },
    // Diagnostic
    test:                   { icon: '🔔', tone: 'bg-dd-bg text-dd-text-2' },
    default:                { icon: '🔔', tone: 'bg-dd-bg text-dd-text-2' },
};

// Family-prefix fallback for unknown variants in the same group.
// e.g. a future 'shift_swapped_back' still gets the calendar icon.
function metaForKind(t) {
    if (!t) return KIND_META.default;
    if (KIND_META[t]) return KIND_META[t];
    if (t.startsWith('shift_'))     return { icon: '📅', tone: 'bg-dd-bg text-dd-text-2' };
    if (t.startsWith('pto_'))       return { icon: '🌴', tone: 'bg-dd-bg text-dd-text-2' };
    if (t.startsWith('swap_'))      return { icon: '🔄', tone: 'bg-dd-bg text-dd-text-2' };
    if (t.startsWith('task_'))      return { icon: '📋', tone: 'bg-dd-bg text-dd-text-2' };
    if (t.startsWith('chat_'))      return { icon: '💬', tone: 'bg-dd-bg text-dd-text-2' };
    if (t.startsWith('handoff_'))   return { icon: '🤝', tone: 'bg-dd-bg text-dd-text-2' };
    if (t.startsWith('eighty'))     return { icon: '🚫', tone: 'bg-dd-bg text-dd-text-2' };
    return KIND_META.default;
}

// Infer where to navigate on tap when the notification doc didn't carry
// an explicit `deepLink`. This lets old notifications (and writer sites
// that forgot to set deepLink) still route to the right tab.
function deepLinkFor(item) {
    if (item.deepLink) return item.deepLink;
    const t = item.type || item.kind || '';
    if (t.startsWith('shift_') || t.startsWith('pto_') || t.startsWith('swap_')) return 'schedule';
    if (t.startsWith('chat_'))      return 'chat';
    if (t.startsWith('task_'))      return 'operations';
    if (t.startsWith('handoff_'))   return 'handoff';
    if (t === 'tardy_logged')       return 'tardies';
    if (t.startsWith('sauce_'))     return 'operations';
    if (t === 'eighty_six_alert' || t.startsWith('eighty')) return 'eighty6';
    return null;
}

export default function NotificationsDrawer({ open, onClose, staffName, language = 'en', onNavigate, staffList = [], setStaffList }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    // FIX (review 2026-05-14, perf): read notifications from the shared
    // AppDataContext instead of opening a per-drawer-open Firestore
    // listener. Falls back to [] when staffName is empty (provider
    // guards that case).
    const { notifications: allNotifs, unreadCount } = useAppData();
    const items = (allNotifs || []).slice(0, 50);
    const loading = false;

    const markRead = async (id) => {
        try { await updateDoc(doc(db, 'notifications', id), { read: true }); }
        catch (e) { console.warn('markRead failed:', e); }
    };

    const markAllRead = async () => {
        const unread = items.filter(i => !i.read);
        if (unread.length === 0) return;
        try {
            const batch = writeBatch(db);
            unread.forEach(i => batch.update(doc(db, 'notifications', i.id), { read: true }));
            await batch.commit();
        } catch (e) { console.warn('markAllRead failed:', e); }
    };

    // Manual re-register affordance — lives in the bell drawer so staff
    // who wonder "are my notifications working?" can find it where they
    // naturally look (the bell itself). The header pill only renders
    // when there's a known problem (permission default/denied or no
    // token for this device); this button is always available, even on
    // the happy path, so staff can force a fresh token if pushes feel
    // stale. (Andrew 2026-05-17 — "i dont see the notification refresh
    // next to the bell where is it?")
    const [refreshing, setRefreshing] = useState(false);
    const handleRefreshTokens = async () => {
        if (refreshing || !staffName) return;
        setRefreshing(true);
        try {
            const result = await enableFcmPush(staffName, staffList, setStaffList);
            if (result?.ok) {
                toast(tx('🔔 Notifications refreshed.', '🔔 Notificaciones actualizadas.'),
                    { kind: 'success', duration: 4000 });
            } else if (result?.reason === 'permission-denied') {
                toast(tx('Permission denied. Open iPhone Settings → Notifications → DD Mau.',
                          'Permiso denegado. Abre Ajustes → Notificaciones → DD Mau.'),
                    { kind: 'warn', duration: 6000 });
            } else if (result?.reason) {
                toast(tx('Could not register: ', 'No se pudo registrar: ') + result.reason,
                    { kind: 'error', duration: 6000 });
            }
        } catch (e) {
            console.warn('drawer refresh tokens failed:', e);
            toast(tx('Refresh failed. Try again.', 'Error al actualizar. Intenta de nuevo.'),
                { kind: 'error' });
        } finally {
            setRefreshing(false);
        }
    };

    const handleItemClick = (item) => {
        if (!item.read) markRead(item.id);
        // deepLink may be explicit on the doc OR inferred from the type
        // family (notifications written before deepLink became standard
        // still navigate to the right tab).
        const target = deepLinkFor(item);
        if (target && onNavigate) onNavigate(target);
        onClose?.();
    };

    // Lock body scroll while the drawer is open. Without this, pulling
    // down at the top of the inner notification list bleeds the
    // gesture into the page below, where iOS Safari interprets it as a
    // pull-to-refresh + the chunk-reload auto-recovery in App.jsx
    // sometimes mistakes the resulting reflow for a chunk failure and
    // reloads. The user sees the drawer "crash" mid-scroll.
    // Combined with `overscroll-behavior: contain` on the inner
    // scrollable (below), this fully isolates drawer scroll from page
    // scroll on every iOS version.
    useEffect(() => {
        if (!open) return;
        const prevOverflow = document.body.style.overflow;
        const prevTouchAction = document.body.style.touchAction;
        document.body.style.overflow = 'hidden';
        document.body.style.touchAction = 'none';
        return () => {
            document.body.style.overflow = prevOverflow;
            document.body.style.touchAction = prevTouchAction;
        };
    }, [open]);

    if (!open) return null;

    return (
        <>
            {/* Scrim */}
            <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
            {/* Drawer — slides in from the right on desktop, bottom-sheet on
                mobile.
                Mobile (default): bounded between the iPhone notch (top-0
                + safe-area-inset-top) and the home-indicator. Without an
                explicit top bound, the drawer grew past the viewport
                and the inner flex-1 overflow-y-auto had no scroll
                ceiling → scrolling up thrashed the layout, perceived as
                a "crash" by the user. (Andrew 2026-05-17.)
                Desktop (sm+): unchanged — full-height side panel on
                the right.

                Height note: `top-0 bottom-0` covers the layout viewport
                on every device; the inner scrollable handles all motion
                so the outer container's exact pixel height doesn't
                matter. `overflow-hidden` on the container guarantees
                no child content escapes during overscroll bounces. */}
            <div className="fixed inset-x-0 top-0 bottom-0 sm:bottom-auto sm:right-0 sm:left-auto sm:w-[420px] sm:max-w-[92vw] sm:h-screen z-50 flex flex-col bg-white shadow-2xl rounded-t-2xl sm:rounded-none overflow-hidden"
                style={{
                    paddingBottom: 'env(safe-area-inset-bottom)',
                }}>
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-dd-line"
                     style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}>
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xl">🔔</span>
                        <h2 className="text-base font-bold text-dd-text">{tx('Notifications', 'Notificaciones')}</h2>
                        {unreadCount > 0 && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500 text-white">
                                {unreadCount}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1">
                        {unreadCount > 0 && (
                            <button onClick={markAllRead}
                                className="px-2.5 py-1 rounded-md text-[11px] font-bold text-dd-text-2 hover:bg-dd-bg active:scale-95 transition">
                                {tx('Mark all read', 'Marcar todo')}
                            </button>
                        )}
                        {/* Manual re-register button — always visible so
                            staff can fix stuck pushes without hunting
                            through Admin → Push diagnostic. Tap fires
                            enableFcmPush() which re-mints the token
                            (acts as a no-op if everything's already
                            fine). Icon-only on narrow drawers to leave
                            room for "Mark all read" alongside; full
                            label sits in `title` for hover/longpress.  */}
                        <button onClick={handleRefreshTokens}
                            disabled={refreshing || !staffName}
                            className="px-2 py-1 rounded-md text-[11px] font-bold text-dd-green-700 hover:bg-dd-sage-50 active:scale-95 disabled:opacity-50 transition flex items-center gap-1"
                            aria-label={tx('Refresh notifications', 'Actualizar notificaciones')}
                            title={tx('Re-register this device for push notifications', 'Volver a registrar este dispositivo para notificaciones push')}>
                            <span className={refreshing ? 'inline-block animate-spin' : ''}>🔄</span>
                            <span className="hidden xs:inline sm:inline">
                                {refreshing ? tx('…', '…') : tx('Refresh', 'Actualizar')}
                            </span>
                        </button>
                        <button onClick={onClose}
                            className="w-9 h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg active:scale-95 text-lg transition"
                            aria-label={tx('Close', 'Cerrar')}>
                            ×
                        </button>
                    </div>
                </div>

                {/* Body — the scrolling element.
                    `overscroll-behavior: contain` MUST live here on the
                    actual scrollable, not on the parent (overscroll
                    behavior is per-element, not inherited). Without
                    this, pulling down past the first notification
                    bounced the gesture into the page below and iOS
                    Safari interpreted it as pull-to-refresh — combined
                    with App.jsx's chunk-reload safety net, the result
                    was a perceived "crash."
                    `touch-action: pan-y` blocks horizontal scroll and
                    pinch-zoom on the scrollable so iOS doesn't try to
                    interpret a vertical drag as a different gesture
                    mid-scroll.
                    `-webkit-overflow-scrolling: touch` enables
                    momentum scroll on iOS Safari < 16 (no-op on
                    modern Safari, harmless on every other browser). */}
                <div className="flex-1 overflow-y-auto"
                    style={{
                        overscrollBehavior: 'contain',
                        WebkitOverflowScrolling: 'touch',
                        touchAction: 'pan-y',
                    }}>
                    {loading ? (
                        <div className="p-3 space-y-2">
                            {[1,2,3].map(i => (
                                <div key={i} className="h-16 bg-dd-bg rounded-lg animate-pulse" />
                            ))}
                        </div>
                    ) : items.length === 0 ? (
                        <div className="text-center py-12 px-4">
                            <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-dd-bg flex items-center justify-center text-2xl text-dd-text-2/60">
                                🔔
                            </div>
                            <p className="text-sm font-bold text-dd-text">{tx('No notifications', 'Sin notificaciones')}</p>
                            <p className="text-xs text-dd-text-2 mt-1">{tx("You'll see updates here when something needs you.", 'Aquí verás avisos cuando se necesite tu atención.')}</p>
                        </div>
                    ) : (
                        <ul className="divide-y divide-dd-line">
                            {items.map(item => {
                                // Resolve icon/tone from the doc's `type`
                                // field (canonical) and fall back to the
                                // legacy `kind` field for any pre-existing
                                // docs that used the older schema.
                                const meta = metaForKind(item.type || item.kind);
                                return (
                                    <li key={item.id}>
                                        <button onClick={() => handleItemClick(item)}
                                            className={`w-full text-left px-4 py-3 hover:bg-dd-bg active:bg-dd-bg transition flex items-start gap-3 ${item.read ? 'opacity-60' : ''}`}>
                                            <div className={`flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-base ${meta.tone}`}>
                                                {meta.icon}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-baseline gap-2">
                                                    <h3 className="text-sm font-bold text-dd-text truncate flex-1">
                                                        {toText(item.title, isEs) || tx('Notification', 'Notificación')}
                                                    </h3>
                                                    <span className="text-[10px] text-dd-text-2 shrink-0 tabular-nums">
                                                        {timeAgo(item.createdAt, isEs)}
                                                    </span>
                                                </div>
                                                {item.body && (
                                                    <p className="text-xs text-dd-text-2 mt-0.5 line-clamp-2">{toText(item.body, isEs)}</p>
                                                )}
                                            </div>
                                            {!item.read && (
                                                <span className="flex-shrink-0 mt-1.5 w-2 h-2 rounded-full bg-dd-green" />
                                            )}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </>
    );
}
