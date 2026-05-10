// MobileBottomNav — fixed 5-tab bar at the bottom of the screen on phones.
//
// Why: the v2 sidebar is great on desktop but becomes a hamburger drawer on
// mobile. Restaurant staff use this app one-handed during a rush — often
// with wet/gloved hands, holding plates or trays. A two-tap drawer pattern
// is wrong here. A fixed bottom bar with the 4-5 most-used destinations is
// always one tap away and always within thumb reach.
//
// Tab strategy (5 slots):
//   1. 🏠 Home          — always
//   2. 📅 Schedule      — always (primary daily-use tab)
//   3. Operations OR Recipes — gated, picks the most relevant for this user
//   4. 🚫 86 Board      — always (cooks need fast access during service)
//   5. ⋯ More           — opens drawer with the rest
//
// Live badges mirror the sidebar exactly — same Firestore subscriptions,
// same logic. Dot-style on the corner of the icon at this size (no room
// for numeric pills).
//
// Safe area: the parent uses bottom-nav-safe class so the nav sits above
// the iPhone home indicator, not under it.

import { useEffect, useState } from 'react';
import { db } from '../firebase';
import { doc, collection, onSnapshot, query, where } from 'firebase/firestore';

export default function MobileBottomNav({
    language,
    activeTab,
    onNavigate,
    onMoreClick,
    storeLocation = 'webster',
    staffName = '',
    hasOpsAccess = true,
    hasRecipesAccess = true,
}) {
    const isEs = language === 'es';

    // ── Live badge subscriptions — same logic as the desktop Sidebar.
    // Could in theory share a hook but keeping them parallel keeps the
    // bottom nav independently mountable / testable.
    const [draftCount, setDraftCount] = useState(0);
    const [eighty6Count, setEighty6Count] = useState(0);
    const [unreadNotifs, setUnreadNotifs] = useState(0);

    useEffect(() => {
        const today = new Date();
        const cutoff = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
        const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const q = query(collection(db, 'shifts'), where('date', '>=', fmt(today)), where('date', '<', fmt(cutoff)));
        const unsub = onSnapshot(q, (snap) => {
            let n = 0;
            snap.forEach(d => {
                const sh = d.data();
                if (sh.published === false && (storeLocation === 'both' || sh.location === storeLocation)) n++;
            });
            setDraftCount(n);
        }, () => setDraftCount(0));
        return () => unsub();
    }, [storeLocation]);

    useEffect(() => {
        const loc = storeLocation === 'both' ? 'webster' : storeLocation;
        const unsub = onSnapshot(doc(db, 'ops', `86_${loc}`), (snap) => {
            setEighty6Count(snap.exists() ? (snap.data().count || 0) : 0);
        }, () => setEighty6Count(0));
        return () => unsub();
    }, [storeLocation]);

    useEffect(() => {
        if (!staffName) return;
        const q = query(collection(db, 'notifications'), where('forStaff', '==', staffName));
        const unsub = onSnapshot(q, (snap) => {
            let n = 0;
            snap.forEach(d => { if (!d.data().read) n++; });
            setUnreadNotifs(n);
        }, () => setUnreadNotifs(0));
        return () => unsub();
    }, [staffName]);

    // Build the 5-tab slot list. Slot 3 is dynamic — Operations for staff
    // who have ops access (pre-shift checklists, inventory), Recipes for
    // those who only have recipe access. If neither, falls back to Menu.
    const slot3 = hasOpsAccess
        ? { tab: 'operations', icon: '📋', en: 'Ops', es: 'Ops' }
        : hasRecipesAccess
        ? { tab: 'recipes', icon: '🧑‍🍳', en: 'Recipes', es: 'Recetas' }
        : { tab: 'menu', icon: '🍜', en: 'Menu', es: 'Menú' };

    const tabs = [
        { tab: 'home',     icon: '🏠', en: 'Home',     es: 'Inicio',   badge: unreadNotifs, badgeTone: 'bg-dd-green' },
        { tab: 'schedule', icon: '📅', en: 'Schedule', es: 'Horario',  badge: draftCount,    badgeTone: 'bg-amber-500' },
        slot3,
        { tab: 'eighty6',  icon: '🚫', en: '86',       es: '86',       badge: eighty6Count,  badgeTone: 'bg-red-500' },
        { tab: '__more',   icon: '⋯',  en: 'More',     es: 'Más' },
    ];

    return (
        <nav
            className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-dd-line shadow-[0_-2px_8px_rgba(15,23,42,0.06)] bottom-nav-safe"
            aria-label={isEs ? 'Navegación principal' : 'Primary navigation'}
        >
            <div className="grid grid-cols-5 h-16">
                {tabs.map((t) => {
                    const active = activeTab === t.tab;
                    const isMore = t.tab === '__more';
                    const showBadge = !isMore && t.badge && t.badge > 0;
                    return (
                        <button
                            key={t.tab}
                            onClick={() => isMore ? onMoreClick?.() : onNavigate?.(t.tab)}
                            className={`relative flex flex-col items-center justify-center gap-0.5 transition active:scale-95 ${
                                active
                                    ? 'text-dd-green-700'
                                    : 'text-dd-text-2 hover:text-dd-text active:bg-dd-bg'
                            }`}
                            aria-current={active ? 'page' : undefined}
                            aria-label={isEs ? t.es : t.en}
                        >
                            {/* Active indicator — top accent bar matches sidebar's left accent */}
                            {active && (
                                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[3px] bg-dd-green rounded-b" />
                            )}
                            <span className="relative text-xl leading-none">
                                {t.icon}
                                {showBadge && (
                                    <span className={`absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center text-[9px] font-bold text-white ${t.badgeTone} ring-2 ring-white`}>
                                        {t.badge > 9 ? '9+' : t.badge}
                                    </span>
                                )}
                            </span>
                            <span className={`text-[10px] font-bold leading-none ${active ? 'text-dd-green-700' : 'text-dd-text-2'}`}>
                                {isEs ? t.es : t.en}
                            </span>
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}
