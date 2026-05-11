// MobileBottomNav — fixed 5-tab bar at the bottom of the screen on phones.
//
// Why: the v2 sidebar is great on desktop but becomes a hamburger drawer on
// mobile. Restaurant staff use this app one-handed during a rush — often
// with wet/gloved hands, holding plates or trays. A two-tap drawer pattern
// is wrong here. A fixed bottom bar with the 4-5 most-used destinations is
// always one tap away and always within thumb reach.
//
// Visual design (iteration 2 — 2026-05-10):
//   • Active state is a SOLID sage-green pill behind the icon+label, not a
//     thin top bar. This matches Sling / Toast / Apple's Human Interface
//     Guidelines for tab bars and reads as "selected" at a glance from
//     across the kitchen.
//   • Backdrop blur on the nav itself (bg-white/85 backdrop-blur-md) so
//     content doesn't visually jam against a hard line — feels native iOS.
//   • Icons sized text-2xl (24px) — was text-xl (20px); now in the comfort
//     zone for tap-target perception.
//   • Composite emoji avoided. The original 🧑‍🍳 (man + cooking) is a multi-
//     codepoint sequence that renders as separate characters or oddly on
//     many Android devices. Recipes uses 📖 instead — universal.
//
// Tab strategy (5 slots):
//   1. 🏠 Home
//   2. 📅 Schedule  (badge: draft shifts)
//   3. Operations OR Recipes  (gated; falls back to 🍜 Menu)
//   4. 🚫 86 Board  (badge: 86 count)
//   5. ⋯ More       (opens the side drawer with everything else + Lock)
//
// Safe area: parent uses bottom-nav-safe so the bar sits above the iPhone
// home indicator. z-40 — modals (z-50) layer above this; sidebar (z-40)
// equal but the drawer scrim covers the nav too while it's open.

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
    hiddenPages = [],
}) {
    const isEs = language === 'es';

    // ── Live badge subscriptions — same logic as the desktop Sidebar.
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

    // Slot 3 is dynamic — Operations for staff with ops access (pre-shift
    // checklists, inventory), Recipes for those who only have recipes
    // access, Menu as a fallback.
    // Slot 3 — pick the most relevant tab the user can access. Skip anything
    // in their hiddenPages list so we don't surface a tab the admin hid.
    const slot3 = hasOpsAccess && !hiddenPages.includes('operations')
        ? { tab: 'operations', icon: '📋', en: 'Ops', es: 'Ops' }
        : hasRecipesAccess && !hiddenPages.includes('recipes')
        ? { tab: 'recipes', icon: '📖', en: 'Recipes', es: 'Recetas' }
        : !hiddenPages.includes('menu')
        ? { tab: 'menu', icon: '🍜', en: 'Menu', es: 'Menú' }
        : { tab: 'training', icon: '📚', en: 'Train', es: 'Capac.' };

    const tabs = [
        { tab: 'home',     icon: '🏠', en: 'Home',     es: 'Inicio',  badge: unreadNotifs, badgeTone: 'bg-dd-green' },
        { tab: 'schedule', icon: '📅', en: 'Schedule', es: 'Horario', badge: draftCount,    badgeTone: 'bg-amber-500' },
        slot3,
        { tab: 'eighty6',  icon: '🚫', en: '86',       es: '86',      badge: eighty6Count,  badgeTone: 'bg-red-500' },
        { tab: '__more',   icon: '☰',  en: 'More',     es: 'Más' },
    ];

    return (
        <nav
            className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/85 backdrop-blur-xl border-t border-dd-line/60 shadow-[0_-8px_24px_-4px_rgba(15,23,42,0.08)] bottom-nav-safe"
            aria-label={isEs ? 'Navegación principal' : 'Primary navigation'}
        >
            {/* Hairline accent above the active tab — Toast-style indicator */}
            <div className="grid grid-cols-5 px-1.5 pt-2 pb-0.5">
                {tabs.map((t) => {
                    const active = activeTab === t.tab;
                    const isMore = t.tab === '__more';
                    const showBadge = !isMore && t.badge > 0;
                    return (
                        <button
                            key={t.tab}
                            onClick={() => isMore ? onMoreClick?.() : onNavigate?.(t.tab)}
                            className="relative flex flex-col items-center justify-center py-1 gap-1 transition active:scale-95 group"
                            aria-current={active ? 'page' : undefined}
                            aria-label={isEs ? t.es : t.en}
                        >
                            {/* Top accent — 3px dd-green bar over the active tab.
                                Toast / Sling pattern: makes the active state
                                unmissable even when the screen is bright. */}
                            {active && (
                                <span className="absolute -top-2 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-full bg-dd-green" />
                            )}
                            {/* Icon pill — solid sage when active, transparent
                                otherwise. Slightly larger active state. */}
                            <span className={`relative flex items-center justify-center w-12 h-7 rounded-full transition-all duration-200 ${
                                active
                                    ? 'bg-dd-sage-50'
                                    : 'scale-95 group-active:bg-dd-bg'
                            }`}>
                                <span className={`text-[20px] leading-none transition-transform ${active ? 'scale-110' : ''}`}>{t.icon}</span>
                                {showBadge && (
                                    <span className={`absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full flex items-center justify-center text-[9px] font-black text-white ${t.badgeTone} ring-2 ring-white`}>
                                        {t.badge > 9 ? '9+' : t.badge}
                                    </span>
                                )}
                            </span>
                            <span className={`text-[10px] leading-none tracking-tight transition-colors ${
                                active ? 'font-black text-dd-green-700' : 'font-semibold text-dd-text-2'
                            }`}>
                                {isEs ? t.es : t.en}
                            </span>
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}
