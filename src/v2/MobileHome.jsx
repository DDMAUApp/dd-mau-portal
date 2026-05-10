// MobileHome — launcher-style home for phones.
//
// Why this is different from HomeV2:
//   HomeV2 is a "dashboard" — stat cards, upcoming shifts, alerts. Great
//   on a desktop where the user is browsing or planning. On a phone,
//   restaurant staff open the app for a SPECIFIC reason: check the
//   schedule, mark something 86'd, look up a recipe. A dashboard wastes
//   a tap before they can act.
//
//   MobileHome replaces that with a launcher pattern: a clean greeting,
//   one hero card showing today's shift if any, then a 2-col tile grid
//   of every destination (the same tabs as the sidebar, but as big tap
//   targets). Each tile shows a live attention badge if relevant.
//
// Tiles are filtered by the user's role + access flags so the grid only
// shows destinations they can actually use. Order is "most-likely-needed
// first" (Schedule top-left for everyone; Operations / Recipes next based
// on access; admin/manager-only stuff at the bottom).

import { useEffect, useMemo, useState } from 'react';
import { db } from '../firebase';
import { doc, collection, onSnapshot, query, where } from 'firebase/firestore';

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

export default function MobileHome({
    language = 'en',
    staffName = '',
    storeLocation = 'webster',
    onNavigate,
    hasOpsAccess = true,
    hasRecipesAccess = true,
    isAdmin = false,
    isManager = false,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const queryLoc = storeLocation === 'both' ? 'webster' : storeLocation;

    // ── Live data: today's shift, draft count, 86 count, pending PTO ──
    // Keep subscriptions minimal — this view is action-focused, not a dashboard.
    const [todayShifts, setTodayShifts] = useState([]);
    const [draftCount, setDraftCount] = useState(0);
    const [eighty6Count, setEighty6Count] = useState(0);
    const [pendingPto, setPendingPto] = useState(0);
    const [unreadNotifs, setUnreadNotifs] = useState(0);

    // Today's shifts for THIS user only — drives the hero card.
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
                // Only show published shifts (drafts aren't visible to staff yet)
                if (sh.published !== false) arr.push(sh);
            });
            arr.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
            setTodayShifts(arr);
        }, () => setTodayShifts([]));
        return () => unsub();
    }, [staffName]);

    // Schedule drafts — only shown if user can publish (manager/admin)
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

    // ── Greeting ──
    const greeting = (() => {
        const h = new Date().getHours();
        if (h < 12) return tx('Good morning', 'Buenos días');
        if (h < 18) return tx('Good afternoon', 'Buenas tardes');
        return tx('Good evening', 'Buenas noches');
    })();
    const firstName = (staffName || '').split(' ')[0] || tx('there', '');

    // ── Tile catalog ──
    // Each tile: tab key, icon, label EN/ES, optional access flag, optional badge.
    // Order: workspace first (most-used), then kitchen, then people/admin.
    const allTiles = [
        { tab: 'schedule',   icon: '📅', en: 'Schedule',     es: 'Horario',        accent: 'sage',   badge: draftCount,  badgeTone: 'bg-amber-500',   gateAdmin: false },
        ...(hasOpsAccess ? [{ tab: 'operations', icon: '📋', en: 'Operations', es: 'Operaciones', accent: 'sage' }] : []),
        ...(hasRecipesAccess ? [{ tab: 'recipes', icon: '📖', en: 'Recipes', es: 'Recetas', accent: 'sage' }] : []),
        { tab: 'eighty6',    icon: '🚫', en: '86 Board',     es: 'Tablero 86',    accent: 'red',    badge: eighty6Count, badgeTone: 'bg-red-500' },
        { tab: 'menu',       icon: '🍜', en: 'Menu',         es: 'Menú',          accent: 'sage' },
        { tab: 'training',   icon: '📚', en: 'Training',     es: 'Capacitación',  accent: 'sage' },
        { tab: 'catering',   icon: '🥘', en: 'Catering',     es: 'Catering',      accent: 'sage' },
        ...(isManager ? [{ tab: 'tardies', icon: '⏰', en: 'Tardies', es: 'Tardanzas', accent: 'sage' }] : []),
        ...(isManager ? [{ tab: 'handoff', icon: '🤝', en: 'Handoff', es: 'Entrega', accent: 'sage' }] : []),
        ...(isAdmin ? [{ tab: 'labor',    icon: '📊', en: 'Labor',     es: 'Mano Obra',  accent: 'sage' }] : []),
        { tab: 'ai',         icon: '🤖', en: 'AI Assistant', es: 'Asistente AI',  accent: 'purple' },
        { tab: 'maintenance',icon: '🔧', en: 'Maintenance',  es: 'Mantenimiento', accent: 'sage' },
        { tab: 'insurance',  icon: '📑', en: 'Insurance',    es: 'Seguro',        accent: 'sage' },
        ...(isAdmin ? [{ tab: 'admin',    icon: '⚙️', en: 'Admin',     es: 'Admin',      accent: 'sage', badge: pendingPto, badgeTone: 'bg-amber-500' }] : []),
    ];

    // Today's-shift hero. Show if there's at least one published shift today.
    const heroShift = todayShifts[0];
    const allDayTotal = useMemo(() => {
        if (todayShifts.length === 0) return null;
        const first = todayShifts[0];
        const last = todayShifts[todayShifts.length - 1];
        return `${fmtTime12h(first.startTime)} – ${fmtTime12h(last.endTime)}`;
    }, [todayShifts]);

    return (
        <div className="space-y-5">
            {/* Greeting — large, clear, restaurant-warm */}
            <div className="px-1">
                <h1 className="text-2xl font-black text-dd-text leading-tight">
                    {greeting}, {firstName}
                </h1>
                <p className="text-sm text-dd-text-2 mt-0.5">
                    {tx('What do you need?', '¿Qué necesitas?')}
                </p>
            </div>

            {/* Today's shift hero card — only renders if user has a published
                shift today. One-tap shortcut to Schedule. */}
            {heroShift && (
                <button
                    onClick={() => onNavigate?.('schedule')}
                    className="w-full text-left bg-gradient-to-br from-dd-green to-dd-green-700 rounded-2xl p-4 shadow-card-hov active:scale-[0.99] transition"
                >
                    <div className="flex items-start justify-between gap-2">
                        <div>
                            <div className="text-[10px] uppercase tracking-widest font-bold text-white/70">
                                {tx("Today's shift", 'Tu turno hoy')}
                            </div>
                            <div className="text-2xl font-black text-white tabular-nums leading-tight mt-1">
                                {allDayTotal}
                            </div>
                            <div className="text-xs font-semibold text-white/85 mt-1">
                                {(heroShift.side || 'foh').toUpperCase()}
                                {heroShift.location && ` · ${heroShift.location === 'maryland' ? 'Maryland' : 'Webster'}`}
                                {todayShifts.length > 1 && ` · ${todayShifts.length} ${tx('shifts', 'turnos')}`}
                            </div>
                        </div>
                        <div className="text-3xl">📅</div>
                    </div>
                </button>
            )}

            {/* Tile grid — every destination as a big tap target. 2 cols
                for thumb-friendliness. Each tile is square-ish so the icon
                anchors the visual. Live badges where relevant. */}
            <div>
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-dd-text-2 px-1 mb-2 flex items-center gap-2">
                    <span className="w-4 h-px bg-dd-line" />
                    {tx('Open', 'Abrir')}
                    <span className="flex-1 h-px bg-dd-line" />
                </h2>
                <div className="grid grid-cols-2 gap-3">
                    {allTiles.map(t => (
                        <Tile key={t.tab} {...t} onTap={() => onNavigate?.(t.tab)} isEs={isEs} />
                    ))}
                </div>
            </div>

            {/* Bell affordance — quick visual cue, deep link to notifications.
                Same data the bell badge uses. Hidden when zero. */}
            {unreadNotifs > 0 && (
                <div className="bg-dd-green-50 border border-dd-green/30 rounded-xl p-3 flex items-center gap-3">
                    <span className="text-xl">🔔</span>
                    <div className="flex-1">
                        <div className="text-sm font-bold text-dd-green-700">
                            {unreadNotifs} {tx(unreadNotifs === 1 ? 'new notification' : 'new notifications', unreadNotifs === 1 ? 'notificación' : 'notificaciones')}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Single tile in the launcher grid. Big square-ish tap target with icon,
// label, optional badge. Designed for one-handed use with wet/gloved
// fingers — the entire card is the tap target, not just the icon.
function Tile({ tab, icon, en, es, isEs, accent = 'sage', badge, badgeTone, onTap }) {
    const accentClasses = accent === 'red'
        ? 'border-red-200 hover:border-red-300 hover:bg-red-50'
        : accent === 'purple'
        ? 'border-purple-200 hover:border-purple-300 hover:bg-purple-50'
        : 'border-dd-line hover:border-dd-green/40 hover:bg-dd-sage-50';
    const showBadge = badge && badge > 0;
    return (
        <button
            onClick={onTap}
            className={`relative aspect-[5/4] flex flex-col items-center justify-center gap-2 rounded-2xl bg-white border-2 ${accentClasses} shadow-card hover:shadow-card-hov active:scale-95 transition p-3`}
        >
            <span className="text-3xl leading-none">{icon}</span>
            <span className="text-sm font-bold text-dd-text leading-tight text-center">
                {isEs ? es : en}
            </span>
            {showBadge && (
                <span className={`absolute top-2 right-2 min-w-[22px] h-[22px] px-1.5 rounded-full flex items-center justify-center text-[11px] font-black text-white ${badgeTone || 'bg-dd-green'} ring-2 ring-white shadow-sm`}>
                    {badge > 99 ? '99+' : badge}
                </span>
            )}
        </button>
    );
}
