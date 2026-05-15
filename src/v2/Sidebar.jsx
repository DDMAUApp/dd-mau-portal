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

import { useMemo } from 'react';
import { useAppData } from './AppDataContext';
import AppVersion from '../components/AppVersion';

// NAV_GROUPS — every tab the v2 shell can render, with per-item access keys.
// Items are filtered at render time based on the user's role/access flags
// passed in from App.jsx (hasOpsAccess, hasRecipesAccess, isManager, isAdmin).
//
// Items removed since v2 launch:
//   - 'orders'   → had no render handler in App.jsx (broken link)
//   - 'invoices' → had no render handler in App.jsx (broken link)
// Items added back to match legacy parity:
//   - 'ai' AI Assistant — surfaced in legacy as a pinned purple block
const NAV_GROUPS = [
    {
        labelEn: 'WORKSPACE', labelEs: 'TRABAJO',
        items: [
            { tab: 'home',       icon: '🏠', en: 'Home',       es: 'Inicio' },
            { tab: 'schedule',   icon: '📅', en: 'Schedule',   es: 'Horario' },
            { tab: 'operations', icon: '📋', en: 'Operations', es: 'Operaciones', requires: 'opsAccess' },
        ],
    },
    {
        labelEn: 'KITCHEN', labelEs: 'COCINA',
        items: [
            // Recipes icon mirrors MobileBottomNav (📖) so the icon doesn't
            // flip when the user switches between sidebar and bottom nav.
            // The previous 🧑‍🍳 was a ZWJ composite emoji (man + cooking) —
            // multi-codepoint, prone to rendering as two separate glyphs on
            // older Android + some Linux/Windows browsers, and visually
            // heavier than the other single-codepoint icons in this nav.
            { tab: 'recipes', icon: '📖', en: 'Recipes',    es: 'Recetas',     requires: 'recipesAccess' },
            { tab: 'menu',    icon: '🍜',   en: 'Menu',       es: 'Menú' },
            { tab: 'eighty6', icon: '🚫',   en: '86 Board',   es: 'Tablero 86' },
        ],
    },
    {
        labelEn: 'PEOPLE', labelEs: 'PERSONAL',
        items: [
            { tab: 'training', icon: '📚', en: 'Training',  es: 'Capacitación' },
            { tab: 'tardies',  icon: '⏰', en: 'Tardies',   es: 'Tardanzas',  requires: 'manager' },
            { tab: 'handoff',  icon: '🤝', en: 'Handoff',   es: 'Entrega',    requires: 'manager' },
        ],
    },
    {
        labelEn: 'BUSINESS', labelEs: 'NEGOCIO',
        items: [
            { tab: 'labor',     icon: '📊', en: 'Labor',         es: 'Mano Obra',   requires: 'admin' },
            { tab: 'catering',  icon: '🥘', en: 'Orders',        es: 'Pedidos' },
            { tab: 'ai',        icon: '🤖', en: 'AI Assistant',  es: 'Asistente AI' },
        ],
    },
    {
        labelEn: 'SETTINGS', labelEs: 'AJUSTES',
        items: [
            { tab: 'maintenance', icon: '🔧', en: 'Maintenance', es: 'Mantenimiento' },
            { tab: 'insurance',   icon: '📑', en: 'Insurance',   es: 'Seguro' },
            { tab: 'admin',       icon: '⚙️', en: 'Admin',       es: 'Admin', requires: 'admin' },
            // Onboarding is intentionally NOT in the main nav. It lives behind
            // the Admin page (owners-only PII) — admins enter it via the
            // launcher card at the top of AdminPanel.jsx.
        ],
    },
];

export default function Sidebar({
    language, activeTab, onNavigate, open, collapsed, onToggleCollapse,
    storeLocation = 'webster', staffName = '',
    // Access flags — items in NAV_GROUPS are filtered out if the user
    // doesn't have the required role. Defaults are permissive so the
    // sidebar still renders if the parent forgets to pass them.
    isAdmin = false,
    isManager = false,
    hasOpsAccess = true,
    hasRecipesAccess = true,
    hasOnboardingAccess = false,
    hiddenPages = [],
    // Action handlers — wired from App.jsx via AppShellV2.
    onLogout,
    onForceRefresh,
    onLanguageToggle,
}) {
    const isEs = language === 'es';

    // Filter nav items by required role/access flag. An item with no
    // `requires` is always shown.
    const accessOk = (req) => {
        if (!req) return true;
        if (req === 'admin') return isAdmin;
        if (req === 'manager') return isManager;
        if (req === 'opsAccess') return hasOpsAccess;
        if (req === 'recipesAccess') return hasRecipesAccess;
        if (req === 'onboardingAccess') return hasOnboardingAccess;
        return true;
    };
    const filteredGroups = NAV_GROUPS.map(g => ({
        ...g,
        items: g.items.filter(it => accessOk(it.requires) && !hiddenPages.includes(it.tab)),
    })).filter(g => g.items.length > 0);
    // Mobile drawer is wider (88vw, capped) so the More-menu shows the full
    // group labels comfortably with thumb-friendly tap targets. Desktop keeps
    // the 260px / 72px collapsed pattern.
    const widthClass = collapsed ? 'md:w-[72px]' : 'md:w-[260px]';
    const mobileWidth = 'w-[min(88vw,320px)]';
    const positionClass = open
        ? 'translate-x-0'
        : '-translate-x-full md:translate-x-0';

    // FIX (review 2026-05-14, perf): read from the shared AppDataContext
    // instead of four component-local Firestore subscriptions. Each
    // badge is now a cheap useMemo over the shared data.
    const { shifts14, eightySixByLoc, timeOff, unreadCount: unreadNotifs } = useAppData();
    const draftCount = useMemo(() => {
        return shifts14.filter(sh =>
            sh.published === false &&
            (storeLocation === 'both' || sh.location === storeLocation)
        ).length;
    }, [shifts14, storeLocation]);
    const eighty6Count = useMemo(() => {
        const loc = storeLocation === 'both' ? 'webster' : storeLocation;
        return eightySixByLoc[loc]?.count || 0;
    }, [eightySixByLoc, storeLocation]);
    const pendingPto = useMemo(() => {
        return timeOff.filter(t => t.status === 'pending').length;
    }, [timeOff]);

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
                {filteredGroups.map(group => (
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
                                // React-gotcha fix: `badge && badge > 0` returns 0
                                // when badge=0 — and React renders that 0 as
                                // literal text "0" (the "extra o's" the user
                                // saw on Schedule and 86 Board sidebar items).
                                // Strict `> 0` returns true/false, never 0.
                                const showBadge = badge > 0;
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

            {/* Footer — three quick actions: language toggle, force refresh,
                and log out (returns to the lock screen). All wired from App.jsx
                so they actually do something. The footer was the source of the
                "lock screen is gone" bug — the Log Out button used to be a
                pure presentational stub with no onClick handler. */}
            <div className="border-t border-dd-charcoal-2 p-2 space-y-1 shrink-0">
                {!collapsed && staffName && (
                    <div className="flex items-center gap-2 mb-2 px-2">
                        <div className="w-7 h-7 rounded-full bg-dd-green text-white flex items-center justify-center text-[11px] font-bold shrink-0">
                            {staffName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold text-white truncate">{staffName}</div>
                            <div className="text-[9px] text-white/40 leading-tight">Signed in</div>
                        </div>
                    </div>
                )}
                {/* Language toggle. Was "EN / ES (EN)" — redundant + ugly:
                    the parens looked like extra characters and read as noise.
                    Now: clean label + a sliding pill that shows the inactive
                    target language. EN active → button reads "Español" so the
                    user knows what tapping does. */}
                {onLanguageToggle && (
                    <button onClick={onLanguageToggle}
                        title={isEs ? 'Switch to English' : 'Cambiar a Español'}
                        className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-2 px-3'} py-2 min-h-[44px] md:min-h-0 rounded-lg text-sm font-medium text-white/70 hover:bg-dd-charcoal-2 hover:text-white active:bg-dd-charcoal-2 transition`}>
                        <span className="text-base">🌐</span>
                        {!collapsed && (
                            <span className="flex-1 flex items-center justify-between">
                                <span>{isEs ? 'Idioma' : 'Language'}</span>
                                <span className="inline-flex items-center gap-1 text-[10px] font-black tracking-wider">
                                    <span className={isEs ? 'text-white/30' : 'text-white'}>EN</span>
                                    <span className="text-white/30">·</span>
                                    <span className={isEs ? 'text-white' : 'text-white/30'}>ES</span>
                                </span>
                            </span>
                        )}
                    </button>
                )}
                {/* Force-refresh — clears caches + reloads. Same flow as
                    pull-to-refresh on mobile. */}
                {onForceRefresh && (
                    <button onClick={onForceRefresh}
                        title={isEs ? 'Refrescar app' : 'Refresh app'}
                        className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-2 px-3'} py-2 min-h-[44px] md:min-h-0 rounded-lg text-sm font-medium text-white/70 hover:bg-dd-charcoal-2 hover:text-white active:bg-dd-charcoal-2 transition`}>
                        <span className="text-base">🔄</span>
                        {!collapsed && <span>{isEs ? 'Refrescar app' : 'Refresh app'}</span>}
                    </button>
                )}
                {/* Log Out — clears staffName, sends user back to lock screen */}
                <button onClick={onLogout}
                    title={isEs ? 'Cerrar sesión' : 'Log out'}
                    className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-2 px-3'} py-2 min-h-[44px] md:min-h-0 rounded-lg text-sm font-bold bg-dd-charcoal-2 text-white hover:bg-red-900/40 hover:text-white active:bg-red-900/50 transition`}>
                    <span className="text-base">🔒</span>
                    {!collapsed && <span>{isEs ? 'Bloquear / Salir' : 'Lock / Log out'}</span>}
                </button>
                {/* Build version footer — tappable, opens version-info modal.
                    Visible whenever the sidebar is open (which means: always on
                    desktop, and inside the "More" drawer on mobile). Lets
                    Andrew verify which build is actually loaded at a glance.
                    Hidden in collapsed rail mode to keep that view dense. */}
                {!collapsed && (
                    <div className="flex justify-center pt-1">
                        <AppVersion language={language} />
                    </div>
                )}
            </div>
        </aside>
    );
}
