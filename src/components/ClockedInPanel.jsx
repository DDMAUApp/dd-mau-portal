// ClockedInPanel — admin-only "Who's clocked in right now" widget.
//
// Two render modes (one component, two ergonomic faces):
//
//   <ClockedInPanel variant="card" /> — desktop HomeV2. Full card,
//     always-expanded list, header with count + last-updated stamp.
//     Drops into the same grid slot the Upcoming-shifts card used.
//
//   <ClockedInPanel variant="strip" /> — mobile MobileHome. Compact
//     1-line strip showing the count + first-two avatars. Tapping the
//     strip opens a glass modal with the full list. Sits at the top of
//     the mobile home tile grid so admins see it without scrolling.
//
// Data flow:
//   - This component owns the Firestore subscription via
//     subscribeClockedIn (one location, or both when location='both').
//   - Renders an empty/stale/loaded state per location.
//   - All entries from both locations are merged into one list when
//     location='both', with a small badge showing which store.
//
// Permissioning:
//   - The PARENT decides whether to render this component at all,
//     gated on canViewClockedIn(viewerStaffRecord). We don't gate
//     here to keep the component simple.

import { useEffect, useState, useMemo } from 'react';
import {
    Users, Clock, Coffee, AlertTriangle, ChevronRight, X, RefreshCw,
} from 'lucide-react';
import {
    subscribeClockedIn, getClockedInStatus,
    fmtClockTime, hoursWeekTone,
} from '../data/clockedIn';
import ModalPortal from './ModalPortal';

const LOC_BADGE = {
    webster:  { label: 'WBR', tone: 'bg-blue-50 text-blue-700 border-blue-200' },
    maryland: { label: 'MAR', tone: 'bg-purple-50 text-purple-700 border-purple-200' },
};

// ── Hook: subscribe to one or both locations, return merged status ──────────
function useClockedIn(location) {
    const [webster, setWebster]   = useState(null);
    const [maryland, setMaryland] = useState(null);

    useEffect(() => {
        if (location === 'webster') {
            const unsub = subscribeClockedIn('webster', setWebster);
            return () => unsub();
        }
        if (location === 'maryland') {
            const unsub = subscribeClockedIn('maryland', setMaryland);
            return () => unsub();
        }
        // 'both' — subscribe to both, merge in the consumer.
        const unsubW = subscribeClockedIn('webster',  setWebster);
        const unsubM = subscribeClockedIn('maryland', setMaryland);
        return () => { unsubW(); unsubM(); };
    }, [location]);

    return useMemo(() => {
        const w = getClockedInStatus(webster);
        const m = getClockedInStatus(maryland);
        if (location === 'webster')  return { combined: w, perLoc: { webster: w } };
        if (location === 'maryland') return { combined: m, perLoc: { maryland: m } };
        // both
        const mergedEntries = [
            ...w.entries.map(e => ({ ...e, _loc: 'webster' })),
            ...m.entries.map(e => ({ ...e, _loc: 'maryland' })),
        ].sort((a, b) => (a.clockedInAt || '').localeCompare(b.clockedInAt || ''));
        // Combined status: oldest updatedAt is the "least fresh" one.
        const updatedAt = w.updatedAt && m.updatedAt
            ? (w.updatedAt < m.updatedAt ? w.updatedAt : m.updatedAt)
            : (w.updatedAt || m.updatedAt);
        const minutesAgo = updatedAt
            ? Math.round((Date.now() - updatedAt.getTime()) / 60000)
            : null;
        return {
            combined: {
                hasData: w.hasData || m.hasData,
                entries: mergedEntries,
                count:   mergedEntries.length,
                updatedAt,
                minutesAgo,
                isStale: (w.isStale || m.isStale),
            },
            perLoc: { webster: w, maryland: m },
        };
    }, [webster, maryland, location]);
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StaleBadge({ minutesAgo, language }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    return (
        <div className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded-full">
            <AlertTriangle size={11} strokeWidth={2.5} />
            {tx(`Stale (${minutesAgo}m)`, `Atrasado (${minutesAgo}m)`)}
        </div>
    );
}

function InitialsAvatar({ name, onBreak, overtimeRisk }) {
    const initials = (name || '??').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
    const ring = onBreak
        ? 'ring-2 ring-amber-400 ring-offset-1'
        : overtimeRisk
            ? 'ring-2 ring-red-400 ring-offset-1'
            : '';
    return (
        <div className={`w-9 h-9 shrink-0 rounded-full bg-dd-green-50 text-dd-green-700 flex items-center justify-center text-xs font-black ${ring}`}>
            {initials}
        </div>
    );
}

function EntryRow({ entry, language, showLocation }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const onBreak = !!entry.onBreakSince;
    const ot     = !!entry.overtimeRisk;
    const locBadge = showLocation && entry._loc ? LOC_BADGE[entry._loc] : null;
    return (
        <li className="flex items-center gap-3 py-2.5 border-b border-dd-line/60 last:border-0">
            <InitialsAvatar name={entry.employeeName} onBreak={onBreak} overtimeRisk={ot} />
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                    <span className="text-sm font-bold text-dd-text truncate">{entry.employeeName}</span>
                    {locBadge && (
                        <span className={`shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded-full border ${locBadge.tone}`}>
                            {locBadge.label}
                        </span>
                    )}
                </div>
                <div className="text-[11px] text-dd-text-2 flex items-center gap-1.5 mt-0.5">
                    <Clock size={11} strokeWidth={2.25} className="shrink-0" />
                    <span>{tx('In at', 'Entró a las')} {fmtClockTime(entry.clockedInAt)}</span>
                    {entry.jobName && entry.jobName !== '—' && (
                        <>
                            <span className="text-dd-text-2/50">·</span>
                            <span className="truncate">{entry.jobName}</span>
                        </>
                    )}
                </div>
                {onBreak && (
                    <div className="text-[11px] text-amber-700 font-bold flex items-center gap-1 mt-0.5">
                        <Coffee size={11} strokeWidth={2.5} />
                        {tx(`On break since ${fmtClockTime(entry.onBreakSince)}`,
                             `En descanso desde ${fmtClockTime(entry.onBreakSince)}`)}
                    </div>
                )}
            </div>
            <div className="text-right shrink-0">
                <div className={`text-sm font-black tabular-nums ${hoursWeekTone(entry.hoursThisWeek)}`}>
                    {Number(entry.hoursThisWeek || 0).toFixed(1)}h
                </div>
                <div className="text-[10px] text-dd-text-2 leading-tight">
                    {tx('this week', 'esta semana')}
                </div>
                {ot && (
                    <div className="text-[9px] font-black text-red-700 mt-0.5">
                        ⚠ OT
                    </div>
                )}
            </div>
        </li>
    );
}

function EmptyState({ language }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    return (
        <div className="text-center py-6">
            <div className="w-11 h-11 mx-auto mb-2 rounded-full bg-dd-bg flex items-center justify-center text-dd-text-2/60">
                <Users size={20} strokeWidth={2.25} />
            </div>
            <p className="text-sm font-bold text-dd-text">{tx('Nobody clocked in', 'Nadie marcado')}</p>
            <p className="text-[11px] text-dd-text-2 mt-0.5">{tx('Quiet on Toast right now.', 'Tranquilo en Toast ahora.')}</p>
        </div>
    );
}

function LoadingState({ language }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    return (
        <div className="text-center py-6">
            <RefreshCw size={20} strokeWidth={2.25} className="mx-auto text-dd-text-2/60 animate-spin" />
            <p className="text-[11px] text-dd-text-2 mt-2">{tx('Loading from Toast…', 'Cargando desde Toast…')}</p>
        </div>
    );
}

// ── Public component ────────────────────────────────────────────────────────

export default function ClockedInPanel({
    location,
    language = 'en',
    variant = 'card', // 'card' | 'strip'
    onClose,           // optional — only used by strip's expand modal
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const { combined } = useClockedIn(location);
    const [expanded, setExpanded] = useState(false);

    const showLocation = location === 'both';
    const sortedByWeek = useMemo(() => {
        // Sort within the same render so OT-risk rises to the top of the
        // expanded modal (admins want the at-risk staff visible first).
        // Default view (in card mode) sorts by clock-in time — keep that
        // for "who's been here longest" intuition.
        return [...combined.entries].sort((a, b) => {
            const aw = Number(a.hoursThisWeek) || 0;
            const bw = Number(b.hoursThisWeek) || 0;
            return bw - aw;
        });
    }, [combined.entries]);

    // ── CARD variant (desktop HomeV2 replacement for upcoming-shifts) ──
    if (variant === 'card') {
        return (
            <div className="bg-white rounded-2xl border border-dd-line/70 shadow-card p-5">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                        <div className="w-9 h-9 rounded-full bg-dd-green-50 flex items-center justify-center text-dd-green-700">
                            <Users size={18} strokeWidth={2.25} />
                        </div>
                        <div>
                            <h3 className="text-base font-bold text-dd-text">
                                {tx("Who's clocked in", 'Quién está marcado')}
                            </h3>
                            <p className="text-xs text-dd-text-2">
                                {tx('Live from Toast', 'En vivo desde Toast')}
                                {combined.updatedAt && (
                                    <span> · {tx(`updated ${combined.minutesAgo}m ago`, `hace ${combined.minutesAgo}m`)}</span>
                                )}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {combined.isStale && <StaleBadge minutesAgo={combined.minutesAgo} language={language} />}
                        <span className="text-xs font-black text-dd-green-700 bg-dd-green-50 px-2.5 py-1 rounded-full border border-dd-green/30">
                            {combined.count} {tx('on now', 'ahora')}
                        </span>
                    </div>
                </div>

                {!combined.hasData ? (
                    <LoadingState language={language} />
                ) : combined.entries.length === 0 ? (
                    <EmptyState language={language} />
                ) : (
                    <ul className="divide-y divide-dd-line/40 max-h-[420px] overflow-y-auto -mx-1 px-1">
                        {combined.entries.map(e => (
                            <EntryRow
                                key={`${e._loc || ''}:${e.toastEmployeeId}`}
                                entry={e}
                                language={language}
                                showLocation={showLocation}
                            />
                        ))}
                    </ul>
                )}
            </div>
        );
    }

    // ── STRIP variant (mobile, tap to expand) ──
    return (
        <>
            <button
                type="button"
                onClick={() => setExpanded(true)}
                className="w-full glass-sheet rounded-2xl p-3 flex items-center gap-3 shadow-sm active:scale-[0.98] transition"
                aria-label={tx("Open who's clocked in", 'Abrir quién está marcado')}
            >
                <div className="w-10 h-10 rounded-full bg-dd-green-50 text-dd-green-700 flex items-center justify-center shrink-0">
                    <Users size={20} strokeWidth={2.25} />
                </div>
                <div className="flex-1 min-w-0 text-left">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                        {tx("Who's clocked in", 'Quién está marcado')}
                    </div>
                    <div className="text-sm font-black text-dd-text">
                        {!combined.hasData
                            ? tx('Loading…', 'Cargando…')
                            : combined.entries.length === 0
                                ? tx('Nobody right now', 'Nadie ahora')
                                : tx(`${combined.count} on the clock`, `${combined.count} marcados`)}
                    </div>
                </div>
                {combined.isStale && <StaleBadge minutesAgo={combined.minutesAgo} language={language} />}
                {/* Avatar stack (first 3) */}
                <div className="flex -space-x-2 shrink-0">
                    {combined.entries.slice(0, 3).map(e => (
                        <div key={e.toastEmployeeId} className="w-7 h-7 rounded-full bg-dd-green-50 border-2 border-white text-dd-green-700 flex items-center justify-center text-[10px] font-black">
                            {(e.employeeName || '??').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase()}
                        </div>
                    ))}
                </div>
                <ChevronRight size={16} className="text-dd-text-2 shrink-0" />
            </button>

            {expanded && (
                <ModalPortal>
                    <div
                        className="fixed inset-0 z-[60] bg-black/50 flex items-end md:items-center justify-center p-3"
                        onClick={() => { setExpanded(false); onClose?.(); }}
                        role="dialog"
                        aria-modal="true"
                    >
                        <div
                            className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl shadow-xl flex flex-col max-h-[92vh]"
                            onClick={(e) => e.stopPropagation()}
                            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
                        >
                            <div className="md:hidden flex justify-center pt-2 pb-1">
                                <div className="w-10 h-1 bg-dd-line rounded-full" />
                            </div>
                            <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between bg-dd-green-50 safe-top">
                                <div>
                                    <h2 className="text-lg font-black text-dd-green-700 flex items-center gap-2">
                                        <Users size={18} strokeWidth={2.25} />
                                        {tx("Who's clocked in", 'Quién está marcado')}
                                    </h2>
                                    <p className="text-[11px] text-dd-green-700/80 leading-tight mt-0.5">
                                        {combined.updatedAt
                                            ? tx(`Updated ${combined.minutesAgo}m ago`, `Actualizado hace ${combined.minutesAgo}m`)
                                            : tx('Live from Toast', 'En vivo desde Toast')}
                                        {combined.isStale && ' · ' + tx('STALE', 'ATRASADO')}
                                    </p>
                                </div>
                                <button
                                    onClick={() => { setExpanded(false); onClose?.(); }}
                                    className="w-11 h-11 rounded-full hover:bg-white/60 flex items-center justify-center"
                                    aria-label={tx('Close', 'Cerrar')}
                                >
                                    <X size={18} />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-3" style={{ overscrollBehavior: 'contain' }}>
                                {!combined.hasData ? (
                                    <LoadingState language={language} />
                                ) : combined.entries.length === 0 ? (
                                    <EmptyState language={language} />
                                ) : (
                                    // Mobile sorts by hours-desc so OT-risk
                                    // bubbles to the top of the modal.
                                    <ul className="divide-y divide-dd-line/40">
                                        {sortedByWeek.map(e => (
                                            <EntryRow
                                                key={`${e._loc || ''}:${e.toastEmployeeId}`}
                                                entry={e}
                                                language={language}
                                                showLocation={showLocation}
                                            />
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>
                    </div>
                </ModalPortal>
            )}
        </>
    );
}
