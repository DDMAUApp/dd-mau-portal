// V2 sidebar — grouped nav inspired by Sling. Persistent on desktop,
// drawer on mobile. Two visual modes:
//   - expanded (260px): icon + label + optional badge
//   - collapsed (72px): icon only, label as tooltip
//
// Active state = a 3px dd-green left bar + lighter charcoal background.
// Hover state = subtle wash.
//
// LIVE BADGES (added 2026-05-09): each tab can show a numeric or dot
// indicator showing how much attention it needs. Subscribes to the
// relevant Firestore collections internally so the sidebar always
// reflects current state without prop-drilling counts from App.jsx.

import { useEffect, useState } from 'react';
import { db } from '../firebase';
import { doc, collection, onSnapshot, query, where } from 'firebase/firestore';

const NAV_GROUPS = [
    {
        labelEn: 'WORKSPACE', labelEs: 'TRABAJO',
        items: [
            { tab: 'home',       icon: '🏠', en: 'Home',       es: 'Inicio' },
            { tab: 'schedule',   icon: '📅', en: 'Schedule',   es: 'Horario' },
            { tab: 'operations', icon: '📋', en: 'Operations', es: 'Operaciones' },
        ],
    },
    {
        labelEn: 'KITCHEN', labelEs: 'COCINA',
        items: [
            { tab: 'recipes', icon: '🧑‍🍳', en: 'Recipes',    es: 'Recetas' },
            { tab: 'menu',    icon: '🍜',   en: 'Menu',       es: 'Menú' },
            { tab: 'eighty6', icon: '🚫',   en: '86 Board',   es: 'Tablero 86' },
        ],
    },
    {
        labelEn: 'PEOPLE', labelEs: 'PERSONAL',
        items: [
            { tab: 'training', icon: '📚', en: 'Training',  es: 'Capacitación' },
            { tab: 'tardies',  icon: '⏰', en: 'Tardies',   es: 'Tardanzas' },
            { tab: 'handoff',  icon: '🤝', en: 'Handoff',   es: 'Entrega' },
        ],
    },
    {
        labelEn: 'BUSINESS', labelEs: 'NEGOCIO',
        items: [
            { tab: 'labor',     icon: '📊', en: 'Labor',         es: 'Labor' },
            { tab: 'orders',    icon: '🧾', en: 'Live Orders',   es: 'Órdenes en vivo' },
            { tab: 'invoices',  icon: '💵', en: 'Invoices',      es: 'Facturas' },
            { tab: 'catering',  icon: '🥘', en: 'Catering',      es: 'Catering' },
        ],
    },
    {
        labelEn: 'SETTINGS', labelEs: 'AJUSTES',
        items: [
            { tab: 'maintenance', icon: '🔧', en: 'Maintenance', es: 'Mantenimiento' },
            { tab: 'insurance',   icon: '📑', en: 'Insurance',   es: 'Seguro' },
            { tab: 'admin',       icon: '⚙️', en: 'Admin',       es: 'Admin' },
        ],
    },
];

export default function Sidebar({ language, activeTab, onNavigate, open, collapsed, onToggleCollapse, storeLocation = 'webster', staffName = '' }) {
    const isEs = language === 'es';
    // Mobile drawer is wider (88vw, capped) so the More-menu shows the full
    // group labels comfortably with thumb-friendly tap targets. Desktop keeps
    // the 260px / 72px collapsed pattern.
    const widthClass = collapsed ? 'md:w-[72px]' : 'md:w-[260px]';
    const mobileWidth = 'w-[min(88vw,320px)]';
    const positionClass = open
        ? 'translate-x-0'
        : '-translate-x-full md:translate-x-0';

    // ── Live badge subscriptions ────────────────────────────────────────
    const [draftCount, setDraftCount] = useState(0);
    const [eighty6Count, setEighty6Count] = useState(0);
    const [pendingPto, setPendingPto] = useState(0);
    const [unreadNotifs, setUnreadNotifs] = useState(0);

    // Drafts: shifts in the next 14 days that aren't published.
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

    // 86 board count.
    useEffect(() => {
        const loc = storeLocation === 'both' ? 'webster' : storeLocation;
        const unsub = onSnapshot(doc(db, 'ops', `86_${loc}`), (snap) => {
            setEighty6Count(snap.exists() ? (snap.data().count || 0) : 0);
        }, () => setEighty6Count(0));
        return () => unsub();
    }, [storeLocation]);

    // Pending PTO requests.
    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'time_off'), (snap) => {
            let n = 0;
            snap.forEach(d => { if (d.data().status === 'pending') n++; });
            setPendingPto(n);
        }, () => setPendingPto(0));
        return () => unsub();
    }, []);

    // Unread notifications for the current user.
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

    // Map: tab → badge count (or null if no badge).
    const badges = {
        schedule: draftCount,
        eighty6:  eighty6Count,
        admin:    pendingPto,
        home:     unreadNotifs,
    };

    // Badge tone per tab — green if positive thing (notifications), amber if
    // attention needed (drafts, PTO), red if blocking (86'd items).
    const badgeTone = (tab) => {
        if (tab === 'eighty6') return 'bg-red-500 text-white';
        if (tab === 'schedule' || tab === 'admin') return 'bg-amber-400 text-amber-950';
        if (tab === 'home') return 'bg-dd-green text-white';
        return 'bg-white/20 text-white';
    };

    return (
        <aside
            className={`fixed top-0 left-0 z-40 h-screen bg-dd-charcoal text-white flex flex-col transition-all duration-200 ${mobileWidth} ${widthClass} ${positionClass}`}
        >
            {/* Logo header strip — entire 64px top of the sidebar is WHITE,
                like a header bar. Logo (dark line art on transparent) sits on
                it naturally, no inversion needed. Collapsed mode shows a green
                DD badge centered. Visually echoes the white cards on the home
                page so the brand mark feels consistent across surfaces. */}
            <div className="h-24 flex items-center justify-between px-3 bg-white shrink-0">
                {collapsed ? (
                    <div className="w-11 h-11 mx-auto rounded-lg bg-dd-green flex items-center justify-center text-white font-black text-lg shrink-0">
                        DD
                    </div>
                ) : (
                    <div className="flex-1 flex items-center justify-center min-w-0 px-1">
                        <img
                            src={(import.meta.env.BASE_URL || '/') + 'dd-mau-logo.png'}
                            alt="DD Mau Vietnamese Eatery"
                            className="max-h-20 w-auto object-contain"
                            onError={(e) => {
                                e.target.style.display = 'none';
                                if (e.target.parentElement) {
                                    e.target.parentElement.innerHTML =
                                        '<div class="text-dd-charcoal text-sm font-black tracking-wider">DD MAU</div>' +
                                        '<div class="text-dd-text-2 text-[8px] font-bold tracking-widest">VIETNAMESE EATERY</div>';
                                }
                            }}
                        />
                    </div>
                )}
                {!collapsed && (
                    <button onClick={onToggleCollapse}
                        className="ml-2 hidden md:flex w-7 h-7 items-center justify-center rounded text-dd-text-2 hover:text-dd-text hover:bg-dd-bg"
                        title="Collapse sidebar">
                        ◀
                    </button>
                )}
            </div>

            {/* Collapse toggle (collapsed mode) */}
            {collapsed && (
                <button onClick={onToggleCollapse}
                    className="hidden md:flex h-8 mx-2 mt-2 items-center justify-center rounded text-white/40 hover:text-white hover:bg-dd-charcoal-2"
                    title="Expand sidebar">
                    ▶
                </button>
            )}

            {/* Nav groups */}
            <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
                {NAV_GROUPS.map(group => (
                    <div key={group.labelEn}>
                        {!collapsed && (
                            <div className="text-[10px] font-bold tracking-widest text-white/40 px-3 mb-1.5">
                                {isEs ? group.labelEs : group.labelEn}
                            </div>
                        )}
                        <div className="space-y-0.5">
                            {group.items.map(item => {
                                const active = activeTab === item.tab;
                                const badge = badges[item.tab];
                                const showBadge = badge && badge > 0;
                                return (
                                    <button
                                        key={item.tab}
                                        onClick={() => onNavigate?.(item.tab)}
                                        title={collapsed
                                            ? (isEs ? item.es : item.en) + (showBadge ? ` (${badge})` : '')
                                            : undefined}
                                        className={`w-full group relative flex items-center ${collapsed ? 'justify-center px-2' : 'px-3 gap-3'} py-3 md:py-2 min-h-[44px] md:min-h-0 rounded-lg text-sm font-medium transition active:scale-[0.98] ${active
                                            ? 'bg-dd-charcoal-2 text-white'
                                            : 'text-white/70 hover:bg-dd-charcoal-2 hover:text-white active:bg-dd-charcoal-2'}`}
                                    >
                                        {active && (
                                            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 bg-dd-green rounded-r" />
                                        )}
                                        <span className="relative text-base shrink-0">
                                            {item.icon}
                                            {/* Collapsed mode: small dot in the corner of the icon */}
                                            {collapsed && showBadge && (
                                                <span className={`absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full flex items-center justify-center text-[8px] font-bold ${badgeTone(item.tab)}`}>
                                                    {badge > 9 ? '9+' : badge}
                                                </span>
                                            )}
                                        </span>
                                        {!collapsed && (
                                            <>
                                                <span className="flex-1 text-left truncate">{isEs ? item.es : item.en}</span>
                                                {showBadge && (
                                                    <span className={`min-w-[20px] h-5 px-1.5 rounded-full flex items-center justify-center text-[10px] font-bold ${badgeTone(item.tab)}`}>
                                                        {badge > 99 ? '99+' : badge}
                                                    </span>
                                                )}
                                            </>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </nav>

            {/* Footer — version + log out */}
            <div className="border-t border-dd-charcoal-2 p-3 shrink-0">
                {!collapsed && (
                    <div className="text-[10px] text-white/40 mb-2 px-1">
                        Shih Technology · v2-preview
                    </div>
                )}
                <button className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-2 px-3'} py-2 rounded-lg text-sm font-medium text-white/70 hover:bg-dd-charcoal-2 hover:text-white transition`}>
                    <span>🚪</span>
                    {!collapsed && <span>{isEs ? 'Salir' : 'Log out'}</span>}
                </button>
            </div>
        </aside>
    );
}
