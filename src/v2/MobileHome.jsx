// MobileHome — launcher-style home for phones.
//
// 2026-05-10 redesign: elevated to a pro-SaaS feel inspired by Sling +
// Toast. Key principles applied:
//
//   - TYPOGRAPHY HIERARCHY: explicit display/title/body/caption sizes,
//     strong weight contrast, tabular nums for stats. Inter-first stack
//     (already in tailwind.config), system fallback for safety.
//
//   - COLOR DISCIPLINE: dd-green is the ONLY accent on the page. Status
//     colors (red/amber) only appear inside KPI badges where they convey
//     specific meaning. Tile cards stay neutral white-on-sage so the
//     whole grid reads as one calm surface.
//
//   - INFORMATION DENSITY: a KPI strip sits above the tile grid, giving
//     the "mission-control" glance Toast nails. 3-4 numbers a manager
//     would check FIRST upon opening the app, color-coded by state.
//
//   - LAYERED SHADOWS: tiles have shadow-sm at rest → shadow-md on press.
//     The hero card has a subtle inner-shadow plus elevated outer shadow
//     to feel "important" without being loud.
//
//   - MICRO-INTERACTIONS: active:scale-[0.97] and gentle transitions on
//     every tappable surface so the app feels responsive even on mid-tier
//     Android.

import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { canViewLabor } from '../data/staff';
import { getLaborStatus, getLaborStatusHint } from '../data/labor';
import { useAppData } from './AppDataContext';
import AppVersion from '../components/AppVersion';
import EnableNotificationsBanner from '../components/EnableNotificationsBanner';
import StaffTodoCard from '../components/StaffTodoCard';
// 2026-05-27 — Andrew: "the home screen button emojis need a
// professional look too." Tile icons now come from Lucide instead of
// the emoji set. Same chunk vendor-react already pulls in (see
// vite.config.js manualChunks — `/lucide-react/` matches into
// vendor-react after the 2026-05-27 outage fix), so this adds zero
// new chunk weight beyond the icons referenced.
import {
    Calendar,
    MessageSquare,
    ClipboardList,
    Tag,
    Tags,
    BookOpen,
    Ban,
    Printer,
    UtensilsCrossed,
    GraduationCap,
    ChefHat,
    Clock,
    Handshake,
    BarChart3,
    Monitor,
    HeartPulse,
    Bot,
    Wrench,
    FileText,
    Settings as SettingsIcon,
    ChevronRight,
} from 'lucide-react';
// 2026-05-20 — Print Center tile on the home screen. Andrew: "lets
// make a printer button on the home screen and also has all the
// same features." Lazy so the chunk only downloads when a staffer
// actually taps Print.
const PrintCenter = lazy(() => import('../components/PrintCenter'));

function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fmtTime12h(t) {
    if (!t) return '';
    const [hh, mm] = String(t).split(':').map(Number);
    if (Number.isNaN(hh)) return t;
    const h = hh % 12 === 0 ? 12 : hh % 12;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    return `${h}:${String(mm || 0).padStart(2, '0')} ${ampm}`;
}

function hoursBetween(start, end) {
    if (!start || !end) return 0;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins < 0) mins += 24 * 60;
    return Math.max(0, mins) / 60;
}

export default function MobileHome({
    language = 'en',
    staffName = '',
    storeLocation = 'webster',
    onNavigate,
    hasOpsAccess = true,
    hasRecipesAccess = true,
    hasOnboardingAccess = false,
    isAdmin = false,
    isManager = false,
    staffList = [],
    setStaffList,
    hiddenPages = [],
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const queryLoc = storeLocation === 'both' ? 'webster' : storeLocation;

    // FIX (review 2026-05-14, perf): pull from the shared AppDataContext
    // instead of 6 component-local Firestore subscriptions. The provider
    // owns one listener per data stream.
    const { shifts14, eightySixByLoc, laborByLoc, timeOff, unreadCount: unreadNotifs, unreadChat } = useAppData();

    // Today's shifts for THIS staffer — derived from the shared shifts14.
    const todayShifts = useMemo(() => {
        if (!staffName) return [];
        const today = todayKey();
        return shifts14
            .filter(sh => sh.date === today && sh.staffName === staffName && sh.published !== false)
            .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    }, [shifts14, staffName]);

    // Draft count — managers/admins only. Gated post-derivation so we
    // still read from the shared snapshot without an extra subscription.
    const draftCount = useMemo(() => {
        if (!isManager && !isAdmin) return 0;
        return shifts14.filter(sh =>
            sh.published === false &&
            (storeLocation === 'both' || sh.location === storeLocation)
        ).length;
    }, [shifts14, storeLocation, isManager, isAdmin]);

    const eighty6Count = useMemo(() => eightySixByLoc[queryLoc]?.count || 0, [eightySixByLoc, queryLoc]);

    const pendingPto = useMemo(() => {
        if (!isManager && !isAdmin) return 0;
        return timeOff.filter(t => t.status === 'pending').length;
    }, [timeOff, isManager, isAdmin]);

    // Labor — gated by canViewLabor (admins/managers default; staff opt-in).
    const me = (staffList || []).find(s => s.name === staffName);
    const canSeeLabor = canViewLabor(me);
    const labor = useMemo(() => canSeeLabor ? laborByLoc[queryLoc] : null, [canSeeLabor, laborByLoc, queryLoc]);

    // Pending lock-screen apply submissions — drives the badge on the
    // 2026-05-20 — Print Center modal state. The home tile opens the
    // PrintCenter as a full-screen modal overlay (it is not a tab/
    // route), so we manage its open/close locally here.
    const [showPrintCenter, setShowPrintCenter] = useState(false);

    // Onboarding tile. This one stays as a local subscription because
    // /onboarding_applications isn't shared by any other v2 consumer.
    const [pendingApplications, setPendingApplications] = useState(0);
    useEffect(() => {
        if (!hasOnboardingAccess) return;
        const unsub = onSnapshot(collection(db, 'onboarding_applications'), (snap) => {
            setPendingApplications(snap.size);
        }, () => setPendingApplications(0));
        return () => unsub();
    }, [hasOnboardingAccess]);

    // ── Derived ────────────────────────────────────────────────────────
    const greeting = (() => {
        const h = new Date().getHours();
        if (h < 12) return tx('Good morning', 'Buenos días');
        if (h < 18) return tx('Good afternoon', 'Buenas tardes');
        return tx('Good evening', 'Buenas noches');
    })();
    const firstName = (staffName || '').split(' ')[0] || tx('there', '');
    const todayDateLabel = (() => {
        const d = new Date();
        return d.toLocaleDateString(isEs ? 'es' : 'en', {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
        });
    })();

    const heroShift = todayShifts[0];
    const totalShiftHours = todayShifts.reduce(
        (s, sh) => s + hoursBetween(sh.startTime, sh.endTime), 0
    );
    const heroTimeRange = todayShifts.length
        ? `${fmtTime12h(todayShifts[0].startTime)} – ${fmtTime12h(todayShifts[todayShifts.length - 1].endTime)}`
        : '';

    // Labor color thresholds match LaborDashboard / HomeV2.
    // 2026-05-26 — route through getLaborStatus() so a busted scraper
    // (laborCost: 0 with real netSales) shows "—" + a "Toast scraper
    // offline" hint instead of a deceptive "0.0%" green KPI. Outage
    // context: see src/data/labor.js.
    const laborStatus = getLaborStatus(labor);
    const laborPct = laborStatus.laborPercent;
    const laborTone = laborStatus.isBroken ? 'danger'
        : laborPct == null ? 'neutral'
        : laborPct <= 22 ? 'good'
        : laborPct <= 28 ? 'warn'
        : 'danger';
    const laborHint = getLaborStatusHint(laborStatus, language);

    // KPI strip — at-most 4 stats. Filtered by role so staff don't see
    // manager metrics that aren't actionable for them.
    const kpis = [
        ...(todayShifts.length > 0 ? [{
            label: tx('Your hours', 'Tus horas'),
            value: totalShiftHours.toFixed(1),
            unit: 'h',
            tone: 'neutral',
        }] : []),
        // 2026-05-26 — Andrew: "labor percentage is broken." When the
        // Toast scraper writes laborCost: 0 with real netSales (its
        // labor endpoint failed), getLaborStatus().isBroken is true and
        // we surface a "—" KPI with a danger tone + the hint label
        // ("Toast scraper offline"). Hiding it entirely would let
        // managers silently miss that they have no labor signal at all.
        ...(canSeeLabor && (laborStatus.isBroken || laborPct != null) ? [{
            label: laborHint || tx('Labor', 'Mano obra'),
            value: laborPct != null ? laborPct.toFixed(1) : '—',
            unit: laborPct != null ? '%' : '',
            tone: laborTone,
        }] : []),
        {
            label: tx('86 items', 'Items 86'),
            value: eighty6Count,
            unit: '',
            tone: eighty6Count > 0 ? 'danger' : 'good',
        },
        ...((isManager || isAdmin) && draftCount > 0 ? [{
            label: tx('Drafts', 'Borradores'),
            value: draftCount,
            unit: '',
            tone: 'warn',
        }] : []),
        ...((isManager || isAdmin) && pendingPto > 0 ? [{
            label: tx('PTO', 'PTO'),
            value: pendingPto,
            unit: '',
            tone: 'warn',
        }] : []),
    ].slice(0, 4);

    // Tile catalog — every destination, role-filtered, ordered by
    // typical-usage frequency. PRIMARY tiles get a subtle accent; the
    // rest stay neutral so the page reads as one calm surface.
    //
    // 2026-05-27 — Andrew: "the home screen button emojis need a
    // professional look too." Each tile now carries a Lucide React
    // component (`Icon` — capitalized so JSX renders it as a
    // component, not a string) instead of an emoji glyph. The Tile
    // component below renders `<Icon size={22} ... />` inside the
    // icon disc. Visual hierarchy (primary stripe, badges) is
    // unchanged.
    const allTiles = [
        { tab: 'schedule',   Icon: Calendar,        en: 'Schedule',     es: 'Horario',        primary: true,  badge: draftCount,   badgeTone: 'amber' },
        // Chat is a PRIMARY tile because team communication runs through it
        // constantly. Badge shows total unread chat-message notifications
        // (drawn from the same /notifications feed as the bell — type
        // 'chat_message' or 'chat_mention').
        { tab: 'chat',       Icon: MessageSquare,   en: 'Chat',         es: 'Chat',           primary: true,  badge: unreadChat, badgeTone: 'amber' },
        ...(hasOpsAccess     ? [{ tab: 'operations',  Icon: ClipboardList, en: 'Operations', es: 'Operaciones', primary: true }] : []),
        // 2026-05-20 — Sticker printer for menu-item / component
        // date labels. Sits next to Operations (kitchen surface).
        { tab: 'datestickers', Icon: Tag,           en: 'Stickers',   es: 'Etiquetas',   primary: true },
        ...(hasRecipesAccess ? [{ tab: 'recipes',     Icon: BookOpen,      en: 'Recipes',    es: 'Recetas',     primary: true }] : []),
        { tab: 'eighty6',    Icon: Ban,             en: '86 Board',     es: 'Tablero 86',    badge: eighty6Count, badgeTone: 'danger' },
        // 2026-05-20 — Print Center tile. tab='print' is a virtual id
        // (not a real route); the onTap below is what fires when the
        // tile is tapped, opening the PrintCenter modal in place. All
        // staff get this — labeling is a kitchen responsibility, not
        // an admin one.
        { tab: 'print',      Icon: Printer,         en: 'Print',        es: 'Imprimir',       primary: true,  onTap: () => setShowPrintCenter(true) },
        { tab: 'menu',       Icon: UtensilsCrossed, en: 'Menu',         es: 'Menú' },
        { tab: 'training',   Icon: GraduationCap,   en: 'Training',     es: 'Capacitación' },
        { tab: 'catering',   Icon: ChefHat,         en: 'Orders',       es: 'Pedidos' },
        ...(isManager ? [{ tab: 'tardies', Icon: Clock,     en: 'Tardies', es: 'Tardanzas' }] : []),
        ...(isManager ? [{ tab: 'handoff', Icon: Handshake, en: 'Handoff', es: 'Entrega' }] : []),
        ...(isAdmin   ? [{ tab: 'labor',   Icon: BarChart3, en: 'Labor',   es: 'Mano Obra' }] : []),
        // Menu Screens — admin tile for the new TV signage dashboard.
        ...(isAdmin   ? [{ tab: 'menuscreens', Icon: Monitor,    en: 'Menu Screens', es: 'Pantallas' }] : []),
        // System Health — admin status dashboard.
        ...(isAdmin   ? [{ tab: 'health',      Icon: HeartPulse, en: 'System Health',es: 'Estado' }] : []),
        // Label Printing uses the plural `Tags` so it's distinguishable
        // from the singular date-sticker tile (`Tag`).
        ...(isAdmin   ? [{ tab: 'labels',      Icon: Tags,       en: 'Label Printing',es: 'Etiquetas' }] : []),
        { tab: 'ai',         Icon: Bot,             en: 'AI Assist',    es: 'Asistente AI' },
        { tab: 'maintenance',Icon: Wrench,          en: 'Maintenance',  es: 'Mantenimiento' },
        { tab: 'insurance',  Icon: FileText,        en: 'Insurance',    es: 'Seguro' },
        // Onboarding is intentionally NOT a top-level tile — it lives behind
        // the Admin page (owners-only PII). The Admin tile's badge reflects
        // both PTO and onboarding applications so it still surfaces here.
        ...(isAdmin ? [{ tab: 'admin', Icon: SettingsIcon, en: 'Admin', es: 'Admin', badge: pendingPto + pendingApplications, badgeTone: 'amber' }] : []),
    ];

    return (
        <div className="space-y-5 pb-2">
            {/* GREETING — display heading + factual subtext.
                Subtle: greeting on top, full date below in muted color.
                No question-mark copy — feels like a tool, not a chat. */}
            <header className="px-1">
                <h1 className="text-[26px] leading-tight font-black text-dd-text tracking-tight">
                    {greeting}, {firstName}
                </h1>
                <p className="text-[13px] text-dd-text-2 mt-0.5 capitalize">
                    {todayDateLabel}
                </p>
            </header>

            {/* Enable-notifications banner — first-sign-in nudge.
                Component renders null when Notification.permission is
                'granted' (the steady state for everyone who's already
                opted in), so it only takes up screen real estate when
                the viewer actually needs to act. iOS requires the
                requestPermission() call to come from a user gesture,
                so the button inside this banner is what makes the OS
                prompt actually appear on iPhone PWAs. (Andrew added
                2026-05-17 after Julie's PWA had FCM tokens registered
                but the iOS-level permission was never granted, so
                pushes never reached her lock screen.) */}
            <EnableNotificationsBanner
                staffName={staffName}
                staffList={staffList}
                setStaffList={setStaffList}
                language={language}
            />

            {/* Staff TO-DO card — admin-defined todos + auto-detected
                "fill out your birthday" / "set your availability" hints.
                Renders null when there's nothing to do. Sits ABOVE the
                hero shift card so action items get top billing. */}
            <StaffTodoCard
                language={language}
                staffName={staffName}
                viewer={me}
                onNavigate={onNavigate}
            />

            {/* HERO — Today's shift. Solid charcoal-2 with dd-green inner
                accent stripe instead of the previous loud green gradient.
                Reads as a "primary card" without shouting. Tap to open
                Schedule. Hidden when you have no shift today. */}
            {heroShift && (
                <button
                    onClick={() => onNavigate?.('schedule')}
                    className="relative w-full text-left bg-dd-charcoal text-white rounded-2xl p-4 shadow-card-hov active:scale-[0.99] transition overflow-hidden"
                >
                    <span className="absolute inset-y-0 left-0 w-1 bg-dd-green" />
                    <div className="pl-2 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="text-[10px] uppercase tracking-widest font-bold text-dd-green-50/70">
                                {tx("Today's shift", 'Tu turno hoy')}
                            </div>
                            <div className="text-[22px] font-black tabular-nums text-white leading-tight mt-1.5">
                                {heroTimeRange}
                            </div>
                            <div className="flex items-center gap-2 mt-1.5">
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-white/10 text-[10px] font-bold uppercase tracking-wider text-white/85">
                                    {(heroShift.side || 'foh').toUpperCase()}
                                </span>
                                <span className="text-[11px] text-white/70">
                                    {heroShift.location === 'maryland' ? 'Maryland' : 'Webster'}
                                </span>
                                {todayShifts.length > 1 && (
                                    <span className="text-[11px] text-white/70">
                                        · {todayShifts.length} {tx('shifts', 'turnos')}
                                    </span>
                                )}
                            </div>
                        </div>
                        <ChevronRight size={24} strokeWidth={2.25} className="opacity-60" aria-hidden="true" />
                    </div>
                </button>
            )}

            {/* KPI STRIP — at-a-glance numbers. Inline horizontal scroll
                if more than 3-4 (rare), otherwise grid. Each KPI is a
                thin pill, not a card, so it doesn't compete with the
                tile grid for visual weight. */}
            {kpis.length > 0 && (
                <div className="flex gap-2 -mx-1 px-1 overflow-x-auto scrollbar-thin">
                    {kpis.map((k, i) => (
                        <Kpi key={i} {...k} />
                    ))}
                </div>
            )}

            {/* TILE GRID — every destination as a tap target.
                Section header was a tiny 10px micro-cap that felt like a
                label, not a heading. Bumped to 11px sentence-case "Quick
                actions" + a thin divider underline so the grid feels like
                a deliberate section, not floating tiles below the KPIs.
                Primary tiles (Schedule/Ops/Recipes) get a left accent stripe
                to nudge the eye toward the most-used destinations. */}
            <div>
                <div className="flex items-baseline justify-between mb-2.5 px-1">
                    <h2 className="text-[11px] font-black uppercase tracking-widest text-dd-text-2">
                        {tx('Quick actions', 'Accesos rápidos')}
                    </h2>
                    <span className="text-[10px] text-dd-text-2/60 font-semibold">
                        {allTiles.filter(t => !hiddenPages.includes(t.tab)).length} {tx('tools', 'herramientas')}
                    </span>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                    {allTiles.filter(t => !hiddenPages.includes(t.tab)).map(t => (
                        // Tile fires t.onTap when present (modal tiles like
                        // Print), otherwise navigates to the named tab.
                        <Tile key={t.tab} {...t} onTap={t.onTap || (() => onNavigate?.(t.tab))} isEs={isEs} />
                    ))}
                </div>
                {/* Build version footer — tappable, opens version-info modal.
                    Always visible at the bottom of the mobile home so users
                    can verify which build is actually loaded. */}
                <div className="flex justify-center pt-4 pb-2">
                    <AppVersion language={isEs ? 'es' : 'en'} />
                </div>
            </div>

            {/* 🖨 Print Center modal — mounted at the root of the home
                screen so it overlays everything cleanly. Lazy import
                means the chunk only loads on first tap. */}
            {showPrintCenter && (
                <Suspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                    <PrintCenter
                        location={storeLocation}
                        staffName={staffName}
                        language={isEs ? 'es' : 'en'}
                        isAdmin={isAdmin}
                        onClose={() => setShowPrintCenter(false)}
                    />
                </Suspense>
            )}
        </div>
    );
}

// KPI pill — compact label-on-top stat. Color reflects state but stays
// muted so the strip doesn't visually dominate the page.
// 2026-05-27 — Phase 3: ported to .glass-card. Tone classes only set
// COLOR now (text + accent border); the chrome (translucent surface,
// shadow, rounded corners) comes from .glass-card so every stat pill
// matches every other glass surface across the app.
function Kpi({ label, value, unit, tone = 'neutral' }) {
    const toneClasses = {
        neutral: 'text-dd-text',
        good:    'text-dd-green-700',
        warn:    'text-amber-700',
        danger:  'text-red-700',
    }[tone] || 'text-dd-text';
    return (
        <div className={`glass-card flex-shrink-0 min-w-[88px] flex flex-col items-start px-3 py-2 ${toneClasses}`}>
            <span className="text-[9px] font-bold uppercase tracking-widest text-dd-text-2 leading-none">
                {label}
            </span>
            <span className="text-xl font-black tabular-nums leading-none mt-1.5">
                {value}<span className="text-xs font-bold opacity-60">{unit}</span>
            </span>
        </div>
    );
}

// Tile — single launcher destination.
//
// 2026-05-10 redesign: was square aspect-[5/4] cards (too tall — empty
// space below the label), with text-[28px] icon + text-[13px] label
// (icon way too big, label way too small). Now a wider/shorter horizontal
// pill: icon on the LEFT, label dominant on the right. Reads more like
// a modern app launcher (Linear, Notion sidebar, Sling drawer) and lets
// the label breathe at a readable size.
//
// Layout per tile:
//   ┌──────────────────────────┐
//   │ [icon]  Schedule       3 │
//   └──────────────────────────┘
// Icon is visually anchored but no longer the headline; the LABEL is.
// 2026-05-27 — Andrew: "change all buttons to a light gray glass" +
// "the home screen button emojis need a professional look too." Two
// changes here:
//   1. `icon` prop renamed to `Icon` — it's now a Lucide React
//      component, not an emoji string. Rendered with size + stroke
//      that matches Sidebar.jsx / MobileBottomNav.jsx.
//   2. Tile chrome ported from .glass-card to .glass-button-apple
//      (the new Apple-Liquid-Glass-style chip). Same rounded surface
//      + hairline border but cooler/grayer + stronger backdrop blur,
//      so the tile grid reads as one frosted sheet over the home
//      gradient. Touch-target floor unchanged (min-h-[64px] is well
//      above both iOS 44pt + Material 48dp).
function Tile({ tab, Icon, en, es, isEs, primary = false, badge, badgeTone, onTap }) {
    const showBadge = badge > 0;
    const badgeBg = badgeTone === 'danger' ? 'bg-red-500'
                  : badgeTone === 'amber'  ? 'bg-amber-500'
                  :                          'bg-dd-green';
    return (
        // 2026-05-27 — Andrew: "the schedule, chat, operations,
        // stickers, recipes, and print buttons have a green line on
        // the left side of the buttons fix it." Removed the
        // primary-tile left accent stripe. Primary tiles now
        // differentiate ONLY via the sage-tinted icon disc — no
        // colored stripe.
        <button
            onClick={onTap}
            className={`glass-button-apple relative flex items-center justify-start gap-3 px-3 py-3 overflow-hidden min-h-[64px] w-full`}
        >
            {/* Icon disc — square chip on the left so the Lucide
                glyph has a visible "container" and doesn't compete
                with the label.
                2026-05-27 — Andrew: "the home screen fix you just
                made with the green lines the same bubbles has the
                green and green tint aroung the emoji. apply that
                to the rest of the bubbles." Every tile now gets
                the sage-50 disc + dd-green-700 glyph (previously
                only primary tiles did; secondary tiles had a
                neutral white/gray disc). The whole launcher grid
                now reads as one calm sage-tinted family. */}
            <span className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center bg-dd-sage-50 text-dd-green-700">
                {Icon && <Icon size={22} strokeWidth={2.25} aria-hidden="true" />}
            </span>
            <span className="flex-1 text-[15px] font-bold text-dd-text leading-tight text-left">
                {isEs ? es : en}
            </span>
            {showBadge && (
                <span className={`flex-shrink-0 min-w-[24px] h-[24px] px-2 rounded-full flex items-center justify-center text-[11px] font-black text-white ${badgeBg} shadow-sm`}>
                    {badge > 99 ? '99+' : badge}
                </span>
            )}
        </button>
    );
}
