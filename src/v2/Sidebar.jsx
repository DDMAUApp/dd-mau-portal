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
import {
    Home,
    Calendar,
    CheckSquare,
    MessageSquare,
    ClipboardList,
    Tag,
    BookOpen,
    UtensilsCrossed,
    Ban,
    GraduationCap,
    Clock,
    Handshake,
    BarChart3,
    Monitor,
    HeartPulse,
    Bug,
    Printer,
    ChefHat,
    Bot,
    Wrench,
    FileText,
    Settings as SettingsIcon,
    Bell,
    Mail,
    ShoppingCart,
} from 'lucide-react';
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
// 2026-05-27 — every tab's `icon` field is now a Lucide SVG component
// reference (capital-letter property `Icon`) instead of an emoji
// string. The render code in this file uses `<item.Icon size={...} />`
// so the icons inherit currentColor and stroke width consistently
// across iOS / Android / desktop. Emoji icons were rendering as four
// different visual styles depending on the OS (Apple Color, Noto Color,
// Segoe UI Emoji, and a few mid-shift Linux variants on Chromebook
// kiosks) — switching to Lucide closes that gap.
const NAV_GROUPS = [
    {
        labelEn: 'WORKSPACE', labelEs: 'TRABAJO',
        items: [
            { tab: 'home',         Icon: Home,           en: 'Home',       es: 'Inicio' },
            { tab: 'schedule',     Icon: Calendar,       en: 'Schedule',   es: 'Horario' },
            // 2026-05-21 — Andrew: managers assign tasks from Operations →
            // Assign Tasks; staff see their list here. Sits right under
            // Schedule because both answer "what do I have to do today?".
            { tab: 'mytasks',      Icon: CheckSquare,    en: 'My Tasks',   es: 'Mis Tareas' },
            // Chat is available to ALL staff — no role gate. Team messaging,
            // FOH/BOH channels, DMs, groups. See ChatCenter.jsx.
            { tab: 'chat',         Icon: MessageSquare,  en: 'Chat',       es: 'Chat' },
            { tab: 'operations',   Icon: ClipboardList,  en: 'Operations', es: 'Operaciones', requires: 'opsAccess' },
            // 2026-05-20 — Andrew: "add a print tab to the home page
            // in the workspace list under the operations tab." Sits
            // right below Operations because date-coding labels is a
            // kitchen-ops responsibility (cooks who just prepped
            // something walk here, not to a separate "print" menu).
            // Distinct from the home-tile 🖨 Print (free-form text);
            // this one is structured: pick a menu item → drill into
            // its build → print sticker for any component.
            { tab: 'datestickers', Icon: Tag,            en: 'Stickers',   es: 'Etiquetas' },
        ],
    },
    {
        labelEn: 'KITCHEN', labelEs: 'COCINA',
        items: [
            { tab: 'recipes', Icon: BookOpen,         en: 'Recipes',  es: 'Recetas',   requires: 'recipesAccess' },
            { tab: 'menu',    Icon: UtensilsCrossed,  en: 'Menu',     es: 'Menú' },
            { tab: 'eighty6', Icon: Ban,              en: '86 Board', es: 'Tablero 86' },
            // 2026-06-01 — Needs Board. Admin + manager only board for
            // one-off supply requests outside the inventory system
            // (brooms, pans, stickers, anything not on a par level).
            { tab: 'needs',   Icon: ShoppingCart,     en: 'Needs Board', es: 'Lista de Pedidos', requires: 'manager' },
        ],
    },
    {
        labelEn: 'PEOPLE', labelEs: 'PERSONAL',
        items: [
            { tab: 'training', Icon: GraduationCap, en: 'Training', es: 'Capacitación' },
            { tab: 'tardies',  Icon: Clock,         en: 'Tardies',  es: 'Tardanzas',  requires: 'manager' },
            { tab: 'handoff',  Icon: Handshake,     en: 'Handoff',  es: 'Entrega',    requires: 'manager' },
        ],
    },
    {
        labelEn: 'BUSINESS', labelEs: 'NEGOCIO',
        items: [
            { tab: 'labor',       Icon: BarChart3,  en: 'Labor',          es: 'Mano Obra',  requires: 'admin' },
            { tab: 'menuscreens', Icon: Monitor,    en: 'Menu Screens',   es: 'Pantallas',  requires: 'admin' },
            { tab: 'health',      Icon: HeartPulse, en: 'System Health',  es: 'Estado',     requires: 'admin' },
            // Error Report — owner-only triage view for bug reports,
            // crashes, and AI failures (Andrew 2026-05-27).
            { tab: 'errorreport', Icon: Bug,        en: 'Error Report',   es: 'Errores',    requires: 'admin' },
            { tab: 'labels',      Icon: Printer,    en: 'Label Printing', es: 'Etiquetas',  requires: 'admin' },
            { tab: 'catering',    Icon: ChefHat,    en: 'Orders',         es: 'Pedidos' },
            { tab: 'ai',          Icon: Bot,        en: 'AI Assistant',   es: 'Asistente AI' },
        ],
    },
    {
        labelEn: 'SETTINGS', labelEs: 'AJUSTES',
        items: [
            { tab: 'maintenance',   Icon: Wrench,       en: 'Maintenance',   es: 'Mantenimiento' },
            { tab: 'insurance',     Icon: FileText,     en: 'Insurance',     es: 'Seguro' },
            { tab: 'admin',         Icon: SettingsIcon, en: 'Admin',         es: 'Admin',          requires: 'admin' },
            { tab: 'notifications', Icon: Bell,         en: 'Notifications', es: 'Notificaciones', requires: 'admin' },
            // 2026-05-26 — Andrew: "i want to make sure the notifications
            // only got to julie and andrew the owners". Owner-only inbox
            // triage tab. The 'requires: admin' gate matches owners (ids
            // 40/41) per the existing isAdmin definition in staff.js.
            { tab: 'inbox',         Icon: Mail,         en: 'Inbox',         es: 'Bandeja',        requires: 'admin' },
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
    const { shifts14, eightySixByLoc, timeOff, unreadCount: unreadNotifs, unreadChat } = useAppData();
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
        chat:     unreadChat,
    };

    // Badge tone per tab — green if positive thing (notifications), amber if
    // attention needed (drafts, PTO), red if blocking (86'd items).
    const badgeTone = (tab) => {
        if (tab === 'eighty6') return 'bg-red-500 text-white';
        if (tab === 'schedule' || tab === 'admin') return 'bg-amber-400 text-amber-950';
        if (tab === 'home' || tab === 'chat') return 'bg-dd-green text-white';
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
                        title={isEs ? 'Contraer barra lateral' : 'Collapse sidebar'}>
                        ◀
                    </button>
                )}
            </div>

            {/* Collapse toggle (collapsed mode) */}
            {collapsed && (
                <button onClick={onToggleCollapse}
                    className="hidden md:flex h-8 mx-2 mt-2 items-center justify-center rounded text-white/40 hover:text-white hover:bg-dd-charcoal-2"
                    title={isEs ? 'Expandir barra lateral' : 'Expand sidebar'}>
                    ▶
                </button>
            )}

            {/* Nav groups.
                2026-05-24 — min-h-0 is the Flexbox-overflow fix. In a flex
                column, a `flex-1 overflow-y-auto` child still grows to
                fit its content by default (min-height: auto) — items
                past the visible viewport become unreachable because the
                container won't shrink to enable scroll. min-h-0
                overrides that. Pair with the taller footer (clears the
                mobile bottom nav) and the nav now scrolls cleanly all
                the way down to SETTINGS regardless of how many groups
                exist. The trailing pb-4 keeps the LAST item visible
                above the footer's border-top during scroll. */}
            {/* 2026-06-03 ANDROID SCROLL FIX — Andrew reported the More
                drawer wouldn't scroll on Android WebView. min-h-0 +
                overflow-y-auto works on iOS Safari but Android Chrome
                WebView additionally needs:
                  - touch-action: pan-y (allow vertical pan gestures,
                    block horizontal swipes that compete with the drawer
                    open/close gesture)
                  - overscroll-behavior: contain (don't let scroll
                    momentum escape to the parent / page-pull-to-refresh)
                  - WebkitOverflowScrolling: touch (legacy iOS momentum
                    scroll; harmless on Android)
                Cheap additive fix, doesn't affect iOS or desktop. */}
            <nav
                className="flex-1 min-h-0 overflow-y-auto py-3 px-2 space-y-4 pb-4 touch-pan-y overscroll-contain"
                style={{ WebkitOverflowScrolling: 'touch' }}
            >
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
                                        <span className="relative shrink-0">
                                            {/* Lucide SVG icon. Inherits currentColor
                                                from the parent button (white/70 → white
                                                on active). Stroke 2.0 keeps lines
                                                readable at 20px in collapsed mode. */}
                                            {item.Icon && (
                                                <item.Icon
                                                    size={20}
                                                    strokeWidth={2}
                                                    aria-hidden="true"
                                                />
                                            )}
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
                pure presentational stub with no onClick handler.
                2026-05-24 — Andrew: "the more button slides over the sidebar
                and at the bottom there is refresh page. that's too low — the
                bottom bar with home / schedule / ops / 86 covers it." The
                sidebar is fixed top-0 h-screen and the MobileBottomNav is
                fixed bottom-0 — same z layer, nav sits on top. Add bottom
                padding on mobile to lift the footer above the nav + the
                iPhone home indicator. Desktop has no bottom nav so we keep
                the tight pb-2. */}
            <div
                className="border-t border-dd-charcoal-2 px-2 pt-2 space-y-1 shrink-0 pb-[calc(0.5rem+5.5rem+env(safe-area-inset-bottom))] md:pb-2"
            >
                {!collapsed && staffName && (
                    <div className="flex items-center gap-2 mb-2 px-2">
                        {/* 2026-05-27 — initials avatar swapped from solid
                            bg-dd-green / white text to .glass-avatar-green.
                            Reads as frosted sage-to-green over the dark
                            sidebar background, matching the Header
                            avatar's chrome for cross-shell consistency. */}
                        <div className="glass-avatar-green w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0">
                            {staffName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold text-white truncate">{staffName}</div>
                            <div className="text-[9px] text-white/40 leading-tight">{isEs ? 'Conectado' : 'Signed in'}</div>
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
                {/* 2026-05-31 — App Store + Play Store compliance footer.
                    In-app links to the live privacy policy + terms + the
                    account-deletion entry point. Both Apple Guideline 5.1.1(v)
                    and Google's account-deletion policy require that an
                    installed app expose its privacy policy AND offer in-app
                    account deletion. Both stores explicitly accept a small
                    footer-link pattern (Slack, Notion, Discord, Stripe use
                    this) — the deletion entry point does NOT have to be a
                    top-level button. Hidden in collapsed-rail desktop mode
                    to keep that view dense.

                    2026-06-01 — Andrew moved the Delete account UI from a
                    standalone visible button above the version footer into
                    this combined footer alongside Privacy + Terms. Reduces
                    the visual weight of a destructive action without losing
                    compliance — staff can still reach it in 2 taps (menu
                    open → "Delete account" → confirm). The confirmation
                    modal, the lazy import of accountDeletion.js, the 7-day
                    grace window, and the admin-approval flow are all
                    UNCHANGED — only the UI affordance moved. */}
                {!collapsed && (
                    <div className="flex justify-center gap-3 pt-1.5 text-[10px] text-white/40">
                        <a
                            href="https://app.ddmaustl.com/privacy.html"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-white/70 transition"
                        >
                            {isEs ? 'Privacidad' : 'Privacy'}
                        </a>
                        <span className="opacity-50">·</span>
                        <a
                            href="https://app.ddmaustl.com/terms.html"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-white/70 transition"
                        >
                            {isEs ? 'Términos' : 'Terms'}
                        </a>
                        {staffName && (
                            <>
                                <span className="opacity-50">·</span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        const msg = isEs
                                            ? '¿Eliminar tu cuenta?\n\nTu solicitud se enviará a un gerente para aprobación. Tienes 7 días para cancelar si cambias de opinión.\n\nEsta acción no se puede deshacer una vez aprobada.'
                                            : 'Delete your account?\n\nYour request will be sent to a manager for approval. You have 7 days to cancel if you change your mind.\n\nThis cannot be undone once approved.';
                                        if (!window.confirm(msg)) return;
                                        // Lazy import — 95% of staff will never tap this,
                                        // no reason to bundle the helper into the eager
                                        // sidebar chunk.
                                        import('../data/accountDeletion.js')
                                            .then(m => m.requestAccountDeletion(staffName))
                                            .then(r => {
                                                if (r?.ok) {
                                                    window.alert(isEs
                                                        ? '✓ Solicitud enviada. Un gerente revisará en los próximos días.'
                                                        : '✓ Request submitted. A manager will review within the next few days.');
                                                } else {
                                                    window.alert(isEs
                                                        ? `No se pudo enviar: ${r?.reason || 'error'}`
                                                        : `Could not submit: ${r?.reason || 'error'}`);
                                                }
                                            })
                                            .catch(e => window.alert(isEs ? `Error: ${e?.message}` : `Error: ${e?.message}`));
                                    }}
                                    title={isEs ? 'Eliminar mi cuenta' : 'Delete my account'}
                                    className="hover:text-red-300 transition"
                                >
                                    {isEs ? 'Eliminar cuenta' : 'Delete account'}
                                </button>
                            </>
                        )}
                    </div>
                )}
            </div>
        </aside>
    );
}
