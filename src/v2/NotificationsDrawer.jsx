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
//     kind: 'shift_published' | 'shift_offered' | 'shift_taken' |
//           'pto_approved' | 'task_assigned' | ...
//     title: string,            // short headline (already localized at write time)
//     body: string,             // 1-2 line body
//     deepLink: 'schedule' | 'operations' | 'recipes' | ... (optional)
//   }
//
// The drawer subscribes to forStaff == currentStaffName and renders
// the most recent 50, sorted by createdAt desc. Tapping an item marks
// it read AND optionally navigates to its deepLink tab.

import { useState } from 'react';
import { db } from '../firebase';
import { doc, updateDoc, writeBatch } from 'firebase/firestore';
import { useAppData } from './AppDataContext';

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

const KIND_META = {
    shift_published:  { icon: '📅', tone: 'bg-dd-green-50 text-dd-green-700' },
    shift_offered:    { icon: '📣', tone: 'bg-blue-50 text-blue-700' },
    shift_taken:      { icon: '🤝', tone: 'bg-purple-50 text-purple-700' },
    shift_approved:   { icon: '✓',  tone: 'bg-dd-green-50 text-dd-green-700' },
    shift_deleted:    { icon: '🗑', tone: 'bg-red-50 text-red-700' },
    shift_edited:     { icon: '✏️', tone: 'bg-amber-50 text-amber-800' },
    pto_approved:     { icon: '🌴', tone: 'bg-dd-green-50 text-dd-green-700' },
    pto_denied:       { icon: '🌴', tone: 'bg-red-50 text-red-700' },
    pto_request:      { icon: '🌴', tone: 'bg-amber-50 text-amber-800' },
    task_assigned:    { icon: '📋', tone: 'bg-blue-50 text-blue-700' },
    task_message:     { icon: '💬', tone: 'bg-blue-50 text-blue-700' },
    task_comment:     { icon: '💬', tone: 'bg-blue-50 text-blue-700' },
    chat_message:     { icon: '💬', tone: 'bg-dd-green-50 text-dd-green-700' },
    chat_mention:     { icon: '📣', tone: 'bg-amber-50 text-amber-800' },
    shift_reminder:   { icon: '⏰', tone: 'bg-amber-50 text-amber-800' },
    swap_pending:     { icon: '⏳', tone: 'bg-purple-50 text-purple-700' },
    default:          { icon: '🔔', tone: 'bg-dd-bg text-dd-text-2' },
};

export default function NotificationsDrawer({ open, onClose, staffName, language = 'en', onNavigate }) {
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

    const handleItemClick = (item) => {
        if (!item.read) markRead(item.id);
        if (item.deepLink && onNavigate) onNavigate(item.deepLink);
        onClose?.();
    };

    if (!open) return null;

    return (
        <>
            {/* Scrim */}
            <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
            {/* Drawer — slides in from the right on desktop, bottom-sheet on
                mobile. */}
            <div className="fixed inset-x-0 bottom-0 sm:bottom-auto sm:top-0 sm:right-0 sm:left-auto sm:w-[420px] sm:max-w-[92vw] sm:h-screen z-50 flex flex-col bg-white shadow-2xl rounded-t-2xl sm:rounded-none modal-scroll-lock"
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
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
                        <button onClick={onClose}
                            className="w-9 h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg active:scale-95 text-lg transition"
                            aria-label={tx('Close', 'Cerrar')}>
                            ×
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto">
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
                                const meta = KIND_META[item.kind] || KIND_META.default;
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
