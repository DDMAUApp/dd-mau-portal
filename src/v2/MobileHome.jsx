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

import { useEffect, useMemo, useState } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { canViewLabor } from '../data/staff';
import { useAppData } from './AppDataContext';
import AppVersion from '../components/AppVersion';

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
    hiddenPages = [],
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const queryLoc = storeLocation === 'both' ? 'webster' : storeLocation;

    // FIX (review 2026-05-14, perf): pull from the shared AppDataContext
    // instead of 6 component-local Firestore subscriptions. The provider
    // owns one listener per data stream.
    const { shifts14, eightySixByLoc, laborByLoc, timeOff, unreadCount: unreadNotifs } = useAppData();

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
    const laborPct = labor?.laborPercent;
    const laborTone = laborPct == null ? 'neutral'
        : laborPct <= 22 ? 'good'
        : laborPct <= 28 ? 'warn'
        : 'danger';

    // KPI strip — at-most 4 stats. Filtered by role so staff don't see
    // manager metrics that aren't actionable for them.
    const kpis = [
        ...(todayShifts.length > 0 ? [{
            label: tx('Your hours', 'Tus horas'),
            value: totalShiftHours.toFixed(1),
            unit: 'h',
            tone: 'neutral',
        }] : []),
        ...(canSeeLabor && laborPct != null ? [{
            label: tx('Labor', 'Mano obra'),
            value: laborPct.toFixed(1),
            unit: '%',
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
    const allTiles = [
        { tab: 'schedule',   icon: '📅', en: 'Schedule',     es: 'Horario',        primary: true,  badge: draftCount,   badgeTone: 'amber' },
        ...(hasOpsAccess     ? [{ tab: 'operations', icon: '📋', en: 'Operations', es: 'Operaciones', primary: true }] : []),
        ...(hasRecipesAccess ? [{ tab: 'recipes',    icon: '📖', en: 'Recipes',    es: 'Recetas',     primary: true }] : []),
        { tab: 'eighty6',    icon: '🚫', en: '86 Board',     es: 'Tablero 86',    badge: eighty6Count, badgeTone: 'danger' },
        { tab: 'menu',       icon: '🍜', en: 'Menu',         es: 'Menú' },
        { tab: 'training',   icon: '📚', en: 'Training',     es: 'Capacitación' },
        { tab: 'catering',   icon: '🥘', en: 'Orders',       es: 'Pedidos' },
        ...(isManager ? [{ tab: 'tardies', icon: '⏰', en: 'Tardies', es: 'Tardanzas' }] : []),
        ...(isManager ? [{ tab: 'handoff', icon: '🤝', en: 'Handoff', es: 'Entrega' }] : []),
        ...(isAdmin   ? [{ tab: 'labor',   icon: '📊', en: 'Labor',   es: 'Mano Obra' }] : []),
        { tab: 'ai',         icon: '🤖', en: 'AI Assist',    es: 'Asistente AI' },
        { tab: 'maintenance',icon: '🔧', en: 'Maintenance',  es: 'Mantenimiento' },
        { tab: 'insurance',  icon: '📑', en: 'Insurance',    es: 'Seguro' },
        // Onboarding is intentionally NOT a top-level tile — it lives behind
        // the Admin page (owners-only PII). The Admin tile's badge reflects
        // both PTO and onboarding applications so it still surfaces here.
        ...(isAdmin ? [{ tab: 'admin', icon: '⚙️', en: 'Admin', es: 'Admin', badge: pendingPto + pendingApplications, badgeTone: 'amber' }] : []),
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
                        <div className="text-2xl opacity-60">→</div>
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
                        <Tile key={t.tab} {...t} onTap={() => onNavigate?.(t.tab)} isEs={isEs} />
                    ))}
                </div>
                {/* Build version footer — tappable, opens version-info modal.
                    Always visible at the bottom of the mobile home so users
                    can verify which build is actually loaded. */}
                <div className="flex justify-center pt-4 pb-2">
                    <AppVersion language={isEs ? 'es' : 'en'} />
                </div>
            </div>
        </div>
    );
}

// KPI pill — compact label-on-top stat. Color reflects state but stays
// muted so the strip doesn't visually dominate the page.
function Kpi({ label, value, unit, tone = 'neutral' }) {
    const toneClasses = {
        neutral: 'text-dd-text border-dd-line',
        good:    'text-dd-green-700 border-dd-green/30 bg-dd-green-50/40',
        warn:    'text-amber-700 border-amber-200 bg-amber-50/50',
        danger:  'text-red-700 border-red-200 bg-red-50/50',
    }[tone] || 'text-dd-text border-dd-line';
    return (
        <div className={`flex-shrink-0 min-w-[88px] flex flex-col items-start px-3 py-2 rounded-xl bg-white border shadow-card ${toneClasses}`}>
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
function Tile({ tab, icon, en, es, isEs, primary = false, badge, badgeTone, onTap }) {
    const showBadge = badge > 0;
    const badgeBg = badgeTone === 'danger' ? 'bg-red-500'
                  : badgeTone === 'amber'  ? 'bg-amber-500'
                  :                          'bg-dd-green';
    return (
        <button
            onClick={onTap}
            className={`relative flex items-center gap-3 rounded-xl bg-white border border-dd-line shadow-card hover:shadow-card-hov active:shadow-card-hov active:scale-[0.97] transition px-3 py-3 overflow-hidden min-h-[64px]`}
        >
            {primary && (
                <span className="absolute top-0 left-0 w-1 h-full bg-dd-green rounded-l-xl" />
            )}
            {/* Icon disc — square chip on the left so the icon has a
                visible "container" and doesn't compete with the label.
                Subtle sage tint for primary tiles. */}
            <span className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-[22px] leading-none ${primary ? 'bg-dd-sage-50' : 'bg-dd-bg'}`}>
                {icon}
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
