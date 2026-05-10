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

import { useEffect, useState } from 'react';
import { db } from '../firebase';
import { doc, collection, onSnapshot, query, where } from 'firebase/firestore';
import { canViewLabor } from '../data/staff';

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
    isAdmin = false,
    isManager = false,
    staffList = [],
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const queryLoc = storeLocation === 'both' ? 'webster' : storeLocation;

    // ── Live data ──────────────────────────────────────────────────────
    const [todayShifts, setTodayShifts] = useState([]);
    const [draftCount, setDraftCount]   = useState(0);
    const [eighty6Count, setEighty6Count] = useState(0);
    const [pendingPto, setPendingPto]   = useState(0);
    const [unreadNotifs, setUnreadNotifs] = useState(0);
    const [labor, setLabor] = useState(null);

    useEffect(() => {
        if (!staffName) return;
        const today = todayKey();
        const q = query(
            collection(db, 'shifts'),
            where('date', '==', today),
            where('staffName', '==', staffName)
        );
        const unsub = onSnapshot(q, (snap) => {
            const arr = [];
            snap.forEach(d => {
                const sh = { id: d.id, ...d.data() };
                if (sh.published !== false) arr.push(sh);
            });
            arr.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
            setTodayShifts(arr);
        }, () => setTodayShifts([]));
        return () => unsub();
    }, [staffName]);

    useEffect(() => {
        if (!isManager && !isAdmin) return;
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
    }, [storeLocation, isManager, isAdmin]);

    useEffect(() => {
        const unsub = onSnapshot(doc(db, 'ops', `86_${queryLoc}`), (snap) => {
            setEighty6Count(snap.exists() ? (snap.data().count || 0) : 0);
        }, () => setEighty6Count(0));
        return () => unsub();
    }, [queryLoc]);

    useEffect(() => {
        if (!isManager && !isAdmin) return;
        const unsub = onSnapshot(collection(db, 'time_off'), (snap) => {
            let n = 0;
            snap.forEach(d => { if (d.data().status === 'pending') n++; });
            setPendingPto(n);
        }, () => setPendingPto(0));
        return () => unsub();
    }, [isManager, isAdmin]);

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

    // Labor — gated by canViewLabor (admins/managers default; staff opt-in).
    const me = (staffList || []).find(s => s.name === staffName);
    const canSeeLabor = canViewLabor(me);
    useEffect(() => {
        if (!canSeeLabor) return;
        const unsub = onSnapshot(doc(db, 'ops', `labor_${queryLoc}`), (snap) => {
            setLabor(snap.exists() ? snap.data() : null);
        }, () => setLabor(null));
        return () => unsub();
    }, [queryLoc, canSeeLabor]);

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
        { tab: 'catering',   icon: '🥘', en: 'Catering',     es: 'Catering' },
        ...(isManager ? [{ tab: 'tardies', icon: '⏰', en: 'Tardies', es: 'Tardanzas' }] : []),
        ...(isManager ? [{ tab: 'handoff', icon: '🤝', en: 'Handoff', es: 'Entrega' }] : []),
        ...(isAdmin   ? [{ tab: 'labor',   icon: '📊', en: 'Labor',   es: 'Mano Obra' }] : []),
        { tab: 'ai',         icon: '🤖', en: 'AI Assist',    es: 'Asistente AI' },
        { tab: 'maintenance',icon: '🔧', en: 'Maintenance',  es: 'Mantenimiento' },
        { tab: 'insurance',  icon: '📑', en: 'Insurance',    es: 'Seguro' },
        ...(isAdmin ? [{ tab: 'admin', icon: '⚙️', en: 'Admin', es: 'Admin', badge: pendingPto, badgeTone: 'amber' }] : []),
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
                Section label is bare uppercase tracking-widest with no
                decorative lines (was: ─── Open ─── 90s pattern).
                Tiles are uniform white cards with a subtle hover/press
                shadow ramp. Primary tiles (Schedule/Ops/Recipes) get a
                left accent stripe to nudge the eye. */}
            <div>
                <h2 className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2 px-1 mb-2.5">
                    {tx('Open', 'Abrir')}
                </h2>
                <div className="grid grid-cols-2 gap-2.5">
                    {allTiles.map(t => (
                        <Tile key={t.tab} {...t} onTap={() => onNavigate?.(t.tab)} isEs={isEs} />
                    ))}
                </div>
            </div>

            {/* SUBTLE FOOTER — version + signed-in name.
                Adds a finished feel to the page (Sling/Toast both have
                version footers). Doesn't compete for attention. */}
            <div className="text-center pt-4 pb-2">
                <p className="text-[10px] text-dd-text-2/60 font-semibold tracking-wide">
                    DD MAU · {staffName || 'Guest'}
                </p>
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

// Tile — single launcher destination. Designed for one-handed use:
// the entire card is the tap target. Layered shadow ramp on press
// gives clear tactile feedback without animation latency.
function Tile({ tab, icon, en, es, isEs, primary = false, badge, badgeTone, onTap }) {
    const showBadge = badge && badge > 0;
    const badgeBg = badgeTone === 'danger' ? 'bg-red-500'
                  : badgeTone === 'amber'  ? 'bg-amber-500'
                  :                          'bg-dd-green';
    return (
        <button
            onClick={onTap}
            className={`relative aspect-[5/4] flex flex-col items-center justify-center gap-1.5 rounded-2xl bg-white border ${primary ? 'border-dd-line' : 'border-dd-line'} shadow-card hover:shadow-card-hov active:shadow-card-hov active:scale-[0.97] transition p-3 overflow-hidden`}
        >
            {primary && (
                <span className="absolute top-0 left-0 w-1 h-full bg-dd-green rounded-l-2xl" />
            )}
            <span className="text-[28px] leading-none">{icon}</span>
            <span className="text-[13px] font-bold text-dd-text leading-tight text-center">
                {isEs ? es : en}
            </span>
            {showBadge && (
                <span className={`absolute top-2 right-2 min-w-[20px] h-[20px] px-1.5 rounded-full flex items-center justify-center text-[10px] font-black text-white ${badgeBg} ring-2 ring-white shadow-sm`}>
                    {badge > 99 ? '99+' : badge}
                </span>
            )}
        </button>
    );
}
