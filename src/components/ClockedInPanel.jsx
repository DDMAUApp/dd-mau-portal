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
//   - Owns the Firestore subscription via subscribeClockedIn (one
//     location, or both when location='both').
//   - Renders an empty/stale/loaded state per location.
//   - When parent passes `todaysShifts` + `staffList`, each row is
//     matched (by employeeName ↔ staff.name, case-insensitive) to
//     today's scheduled shift, which drives:
//       1. punctuality pill (early / on-time / 5+ / 10+ / 15+ late)
//       2. expanded row reveal showing breaks + scheduled times
//       3. "no-show" ghost rows for scheduled staff who haven't
//          clocked in 20+ minutes after their scheduled start
//
// Permissioning:
//   - The PARENT decides whether to render this component at all,
//     gated on canViewClockedIn(viewerStaffRecord). We don't gate
//     here to keep the component simple.

import { useEffect, useState, useMemo } from 'react';
import {
    Users, Clock, Coffee, AlertTriangle, ChevronRight, ChevronDown,
    X, RefreshCw, Calendar, UserX, LogOut,
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

// ── Helpers: schedule matching + punctuality pill ───────────────────────────

// Lowercase + collapse whitespace. Toast firstName+lastName and DD Mau
// staff.name are typed by humans; case-insensitive trim match catches
// 95% of the cases without needing a per-employee mapping table.
function normName(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Combine today's local date with an "HH:MM" string into a Date in
// local time. The schedule grid stores shift times as local HH:MM with
// no zone info; the staff app's viewers are all in Central where the
// restaurant lives, so local-time interpretation is correct.
// Returns Date or null on bad input.
function todayAtHHMM(hhmm) {
    if (!hhmm || typeof hhmm !== 'string') return null;
    const [h, m] = hhmm.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
}

// Pick the most plausible scheduled shift for a clocked-in event:
// from candidate shifts on today's date, pick the one whose startTime
// is the closest match to the clock-in time (within ±4h window). If
// no candidates have startTime, return the first. If none qualify,
// return null.
function pickBestShift(candidates, clockedInIso) {
    if (!candidates?.length) return null;
    const inMs = clockedInIso ? new Date(clockedInIso).getTime() : null;
    if (!inMs) return candidates[0];
    let best = null;
    let bestDelta = Infinity;
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    for (const sh of candidates) {
        const startDt = todayAtHHMM(sh.startTime);
        if (!startDt) continue;
        const delta = Math.abs(inMs - startDt.getTime());
        if (delta < bestDelta && delta <= FOUR_HOURS) {
            best = sh;
            bestDelta = delta;
        }
    }
    return best || candidates[0];
}

// Punctuality bucket — Andrew's spec (2026-05-30):
//   - early (clocked in BEFORE scheduled): light green
//   - 0-5 min late: green ("on time")
//   - 5-10 min late: yellow ("approaching")
//   - 10-15 min late: red ("late")
//   - 15+ min late: purple ("very late")
//
// Returns { label, tone, minutesLate } or null when we can't compute
// (no scheduled shift or no clock-in time).
function getPunctuality(clockedInIso, scheduledShift, isEs) {
    if (!clockedInIso || !scheduledShift?.startTime) return null;
    const startDt = todayAtHHMM(scheduledShift.startTime);
    if (!startDt) return null;
    const inMs = new Date(clockedInIso).getTime();
    if (!inMs) return null;
    const diffMin = Math.round((inMs - startDt.getTime()) / 60000);
    const tx = (en, es) => (isEs ? es : en);
    if (diffMin < 0) {
        const absM = Math.abs(diffMin);
        return {
            label: tx(`${absM}m early`, `${absM}m antes`),
            tone:  'bg-dd-green-50 text-dd-green-700 border-dd-green/30',
            minutesLate: diffMin,
        };
    }
    if (diffMin <= 5) {
        return {
            label: tx('On time', 'A tiempo'),
            tone:  'bg-dd-green text-white border-dd-green',
            minutesLate: diffMin,
        };
    }
    if (diffMin <= 10) {
        return {
            label: tx(`${diffMin}m late`, `${diffMin}m tarde`),
            tone:  'bg-amber-100 text-amber-800 border-amber-300',
            minutesLate: diffMin,
        };
    }
    if (diffMin <= 15) {
        return {
            label: tx(`${diffMin}m late`, `${diffMin}m tarde`),
            tone:  'bg-red-100 text-red-700 border-red-300',
            minutesLate: diffMin,
        };
    }
    return {
        label: tx(`${diffMin}m late`, `${diffMin}m tarde`),
        tone:  'bg-purple-100 text-purple-700 border-purple-300',
        minutesLate: diffMin,
    };
}

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
                count:   mergedEntries.filter(e => !e.clockedOut).length,  // on the clock now
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

function InitialsAvatar({ name, onBreak, overtimeRisk, isNoShow, isOut }) {
    const initials = (name || '??').split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
    const ring = isNoShow
        ? 'ring-2 ring-red-500 ring-offset-1'
        : isOut
            ? ''
            : onBreak
                ? 'ring-2 ring-amber-400 ring-offset-1'
                : overtimeRisk
                    ? 'ring-2 ring-red-400 ring-offset-1'
                    : '';
    const tone = isNoShow
        ? 'bg-red-50 text-red-700'
        : isOut
            ? 'bg-dd-bg text-dd-text-2'
            : 'bg-dd-green-50 text-dd-green-700';
    return (
        <div className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-xs font-black ${tone} ${ring}`}>
            {initials}
        </div>
    );
}

// EntryRow — single roster line. Click anywhere on the row to expand
// the detail panel (breaks + scheduled-shift summary). The row itself
// always shows: avatar / name / clock-in line / break badge (if on
// break) / weekly-hours pill on the right. The punctuality pill sits
// under the name when we have a matched scheduled shift.
//
// isNoShow rows (scheduled, not clocked in 20+ min after start) skip
// the clock-in line and render the name struck-through + red.
function EntryRow({ entry, language, showLocation, isExpanded, onToggle }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const isEs = language === 'es';
    const onBreak = !!entry.onBreakSince;
    const ot     = !!entry.overtimeRisk;
    const locBadge = showLocation && entry._loc ? LOC_BADGE[entry._loc] : null;
    const isNoShow = !!entry.isNoShow;
    // Clocked in today but now clocked out (done, or on a clock-out break) —
    // kept on the list, shown muted at the bottom with their clock-out time.
    const isOut = !isNoShow && !!entry.clockedOut;

    // Punctuality still computed for clocked-out people (their arrival was
    // still on-time/late). No-shows render their own red strike treatment.
    const punct = isNoShow ? null : getPunctuality(entry.clockedInAt, entry.scheduledShift, isEs);

    const sched = entry.scheduledShift;
    const hasBreaks = Array.isArray(entry.breaksToday) && entry.breaksToday.length > 0;

    return (
        <li className={`border-b border-dd-line/60 last:border-0 ${isNoShow ? 'bg-red-50/40' : isOut ? 'bg-dd-bg/40' : ''}`}>
            <button
                type="button"
                onClick={onToggle}
                className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-dd-bg/50 transition rounded-md px-1 -mx-1 active:scale-[0.998]"
                aria-expanded={isExpanded}
                aria-label={tx(`Toggle details for ${entry.employeeName}`, `Mostrar/ocultar detalles de ${entry.employeeName}`)}
            >
                <InitialsAvatar name={entry.employeeName} onBreak={onBreak} overtimeRisk={ot} isNoShow={isNoShow} isOut={isOut} />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-sm font-bold truncate ${isNoShow ? 'text-red-700 line-through decoration-red-600 decoration-[1.5px]' : isOut ? 'text-dd-text-2 line-through decoration-dd-text-2/40 decoration-[1.5px]' : 'text-dd-text'}`}>
                            {entry.employeeName}
                        </span>
                        {isOut && (
                            <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-black px-1.5 py-0.5 rounded-full border bg-dd-bg text-dd-text-2 border-dd-line">
                                <LogOut size={10} strokeWidth={2.5} />
                                {tx('OUT', 'SALIÓ')}
                            </span>
                        )}
                        {locBadge && (
                            <span className={`shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded-full border ${locBadge.tone}`}>
                                {locBadge.label}
                            </span>
                        )}
                        {isNoShow && (
                            <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-black px-1.5 py-0.5 rounded-full border bg-red-100 text-red-700 border-red-300">
                                <UserX size={10} strokeWidth={2.5} />
                                {tx('NO SHOW', 'NO LLEGÓ')}
                            </span>
                        )}
                        {punct && (
                            <span className={`shrink-0 text-[10px] font-black px-1.5 py-0.5 rounded-full border ${punct.tone}`}>
                                {punct.label}
                            </span>
                        )}
                    </div>
                    {!isNoShow && (
                        <div className="text-[11px] text-dd-text-2 flex items-center gap-1.5 mt-0.5">
                            <Clock size={11} strokeWidth={2.25} className="shrink-0" />
                            <span>
                                {tx('In at', 'Entró a las')} {fmtClockTime(entry.clockedInAt)}
                                {isOut && entry.clockedOutAt && (
                                    <span className="text-dd-text-2"> · {tx('out', 'salió')} {fmtClockTime(entry.clockedOutAt)}</span>
                                )}
                            </span>
                            {entry.jobName && entry.jobName !== '—' && (
                                <>
                                    <span className="text-dd-text-2/50">·</span>
                                    <span className="truncate">{entry.jobName}</span>
                                </>
                            )}
                        </div>
                    )}
                    {isNoShow && sched && (
                        <div className="text-[11px] text-red-700/80 font-bold flex items-center gap-1.5 mt-0.5">
                            <Calendar size={11} strokeWidth={2.25} className="shrink-0" />
                            <span>{tx('Scheduled', 'Programado')} {fmtClockTime(todayAtHHMM(sched.startTime)?.toISOString())}–{fmtClockTime(todayAtHHMM(sched.endTime)?.toISOString())}</span>
                        </div>
                    )}
                    {onBreak && (
                        <div className="text-[11px] text-amber-700 font-bold flex items-center gap-1 mt-0.5">
                            <Coffee size={11} strokeWidth={2.5} />
                            {tx(`On break since ${fmtClockTime(entry.onBreakSince)}`,
                                 `En descanso desde ${fmtClockTime(entry.onBreakSince)}`)}
                        </div>
                    )}
                </div>
                <div className="text-right shrink-0 flex items-center gap-1">
                    {!isNoShow && (
                        <div>
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
                    )}
                    {isExpanded
                        ? <ChevronDown size={14} className="text-dd-text-2 shrink-0 ml-1" />
                        : <ChevronRight size={14} className="text-dd-text-2 shrink-0 ml-1" />}
                </div>
            </button>

            {/* Expanded detail — breaks + scheduled shift */}
            {isExpanded && (
                <div className="pl-12 pr-2 pb-3 space-y-2">
                    {/* Scheduled shift */}
                    {sched ? (
                        <div className="glass-sheet rounded-lg px-3 py-2 border border-dd-line">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-0.5 flex items-center gap-1">
                                <Calendar size={11} strokeWidth={2.25} />
                                {tx('Scheduled today', 'Programado hoy')}
                            </div>
                            <div className="text-sm font-bold text-dd-text">
                                {fmtClockTime(todayAtHHMM(sched.startTime)?.toISOString())}
                                {' – '}
                                {fmtClockTime(todayAtHHMM(sched.endTime)?.toISOString())}
                            </div>
                            <div className="text-[11px] text-dd-text-2">
                                {sched.role && <span>{sched.role}</span>}
                                {sched.role && sched.location && <span className="text-dd-text-2/50"> · </span>}
                                {sched.location && <span className="capitalize">{sched.location}</span>}
                                {sched.notes && (
                                    <div className="text-dd-text-2 italic mt-0.5">"{sched.notes}"</div>
                                )}
                            </div>
                        </div>
                    ) : !isNoShow && (
                        <div className="text-[11px] text-dd-text-2 italic px-1">
                            {tx('No matching shift found in today\'s schedule.', 'No se encontró turno programado para hoy.')}
                        </div>
                    )}

                    {/* Breaks list (with both in + out times so the admin can
                        audit total break minutes and break compliance) */}
                    {!isNoShow && (
                        <div className="glass-sheet rounded-lg px-3 py-2 border border-dd-line">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1 flex items-center gap-1">
                                <Coffee size={11} strokeWidth={2.25} />
                                {tx(`Breaks today (${entry.breaksToday?.length || 0})`,
                                     `Descansos hoy (${entry.breaksToday?.length || 0})`)}
                            </div>
                            {hasBreaks ? (
                                <ul className="space-y-1">
                                    {entry.breaksToday.map((b, i) => {
                                        const stillOnBreak = !b.out;
                                        return (
                                            <li key={i} className="flex items-center justify-between gap-2 text-[11px]">
                                                <span className="text-dd-text">
                                                    {fmtClockTime(b.in)}
                                                    {' → '}
                                                    {b.out ? fmtClockTime(b.out) : (
                                                        <span className="text-amber-700 font-bold">
                                                            {tx('still on break', 'en descanso')}
                                                        </span>
                                                    )}
                                                </span>
                                                <span className={`tabular-nums font-bold ${stillOnBreak ? 'text-amber-700' : 'text-dd-text-2'}`}>
                                                    {b.minutes ?? '—'}m
                                                    {b.paid && (
                                                        <span className="ml-1 text-[9px] uppercase text-dd-green-700">
                                                            {tx('paid', 'pagado')}
                                                        </span>
                                                    )}
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                            ) : (
                                <div className="text-[11px] text-dd-text-2 italic">
                                    {tx('No breaks yet today.', 'Sin descansos hoy.')}
                                </div>
                            )}
                        </div>
                    )}

                    {/* No-show explanation */}
                    {isNoShow && (
                        <div className="glass-sheet rounded-lg px-3 py-2 border border-red-200 bg-red-50/50">
                            <div className="text-[11px] text-red-700 font-bold">
                                {tx('This person has not clocked in yet.',
                                     'Esta persona aún no ha marcado entrada.')}
                            </div>
                            <div className="text-[10px] text-red-700/80 mt-0.5">
                                {tx('20+ minutes past their scheduled start time.',
                                     'Más de 20 minutos después de su hora programada.')}
                            </div>
                        </div>
                    )}
                </div>
            )}
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
    onClose,            // optional — only used by strip's expand modal
    todaysShifts = [],  // Array of shift docs for today (filtered by location upstream)
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const { combined } = useClockedIn(location);
    const [expanded, setExpanded] = useState(false);
    // Single-row expansion state — only one row open at a time. Keyed by
    // toastEmployeeId (or synthetic noshow:{shiftId} for ghost rows).
    const [expandedRowId, setExpandedRowId] = useState(null);

    const showLocation = location === 'both';

    // Build a fast staffName → today's shifts map. Multiple shifts per
    // staff are common (split shifts), so the value is an array and
    // pickBestShift narrows to the one closest to their clock-in time.
    const todaysShiftsByName = useMemo(() => {
        const map = new Map();
        for (const sh of todaysShifts) {
            if (!sh?.staffName) continue;
            if (sh.published === false) continue; // drafts don't count for live tracking
            const key = normName(sh.staffName);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(sh);
        }
        return map;
    }, [todaysShifts]);

    // Combined feed: clocked-in employees first (annotated with their
    // scheduled shift), then any scheduled-but-not-clocked-in entries
    // whose start time was 20+ minutes ago.
    const fedEntries = useMemo(() => {
        const out = [];
        const seenNames = new Set();
        // Step 1 — annotate clocked-in entries with their scheduled shift.
        for (const e of combined.entries) {
            const key = normName(e.employeeName);
            seenNames.add(key);
            const candidates = todaysShiftsByName.get(key) || [];
            const scheduledShift = pickBestShift(candidates, e.clockedInAt);
            out.push({ ...e, scheduledShift, isNoShow: false });
        }
        // Step 2 — add no-show ghosts for scheduled people who haven't
        // clocked in yet AND are 20+ min past their scheduled start.
        const now = Date.now();
        for (const [key, shifts] of todaysShiftsByName.entries()) {
            if (seenNames.has(key)) continue; // they clocked in already
            for (const sh of shifts) {
                const startDt = todayAtHHMM(sh.startTime);
                if (!startDt) continue;
                const minutesPast = (now - startDt.getTime()) / 60000;
                if (minutesPast < 20) continue;
                // Skip already-ended shifts so the panel doesn't keep
                // surfacing yesterday's missed shifts later in the day.
                const endDt = todayAtHHMM(sh.endTime);
                if (endDt && now > endDt.getTime()) continue;
                out.push({
                    toastEmployeeId: `noshow:${sh.id}`,
                    employeeName:    sh.staffName,
                    jobName:         sh.role || '',
                    clockedInAt:     null,
                    onBreakSince:    null,
                    breaksToday:     [],
                    hoursToday:      0,
                    hoursThisWeek:   0,
                    overtimeRisk:    false,
                    scheduledShift:  sh,
                    isNoShow:        true,
                    _loc:            sh.location,
                });
            }
        }
        return out;
    }, [combined.entries, todaysShiftsByName]);

    // For mobile (strip variant modal), sort no-shows first (urgency)
    // then by weekly-hours desc so OT-risk staff bubble up.
    const fedSortedForModal = useMemo(() => {
        // Group order: no-shows (0, urgent) → on the clock (1) → clocked out (2).
        const rank = (e) => (e.isNoShow ? 0 : e.clockedOut ? 2 : 1);
        return [...fedEntries].sort((a, b) => {
            const ra = rank(a), rb = rank(b);
            if (ra !== rb) return ra - rb;
            if (a.clockedOut && b.clockedOut) return (b.clockedOutAt || '').localeCompare(a.clockedOutAt || '');
            const aw = Number(a.hoursThisWeek) || 0;
            const bw = Number(b.hoursThisWeek) || 0;
            return bw - aw;
        });
    }, [fedEntries]);

    // Card variant sort: no-shows first (urgency), then by scheduled
    // start, then by clock-in time. Surfacing no-shows at the top
    // matches the user intent ("hey, this person hasn't shown up").
    const fedSortedForCard = useMemo(() => {
        const rank = (e) => (e.isNoShow ? 0 : e.clockedOut ? 2 : 1);
        return [...fedEntries].sort((a, b) => {
            const ra = rank(a), rb = rank(b);
            if (ra !== rb) return ra - rb;
            if (a.clockedOut && b.clockedOut) return (b.clockedOutAt || '').localeCompare(a.clockedOutAt || '');
            const aStart = a.scheduledShift?.startTime || '';
            const bStart = b.scheduledShift?.startTime || '';
            if (aStart !== bStart) return aStart.localeCompare(bStart);
            return (a.clockedInAt || '').localeCompare(b.clockedInAt || '');
        });
    }, [fedEntries]);

    const toggleRow = (id) => setExpandedRowId(prev => prev === id ? null : id);

    const cardCount   = fedEntries.filter(e => !e.isNoShow && !e.clockedOut).length;  // on the clock now
    const outCount    = fedEntries.filter(e => e.clockedOut).length;                  // clocked out today
    const noShowCount = fedEntries.filter(e => e.isNoShow).length;

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
                        {noShowCount > 0 && (
                            <span className="text-xs font-black text-red-700 bg-red-50 px-2.5 py-1 rounded-full border border-red-300">
                                ⚠ {noShowCount} {tx('no-show', 'no llegó')}
                            </span>
                        )}
                        <span className="text-xs font-black text-dd-green-700 bg-dd-green-50 px-2.5 py-1 rounded-full border border-dd-green/30">
                            {cardCount} {tx('on now', 'ahora')}
                        </span>
                        {outCount > 0 && (
                            <span className="text-xs font-black text-dd-text-2 bg-dd-bg px-2.5 py-1 rounded-full border border-dd-line">
                                {outCount} {tx('out', 'salió')}
                            </span>
                        )}
                    </div>
                </div>

                {!combined.hasData ? (
                    <LoadingState language={language} />
                ) : fedEntries.length === 0 ? (
                    <EmptyState language={language} />
                ) : (
                    <ul className="divide-y divide-dd-line/40 max-h-[520px] overflow-y-auto -mx-1 px-1">
                        {fedSortedForCard.map(e => (
                            <EntryRow
                                key={e.toastEmployeeId || `${e._loc || ''}:${e.employeeName}`}
                                entry={e}
                                language={language}
                                showLocation={showLocation}
                                isExpanded={expandedRowId === e.toastEmployeeId}
                                onToggle={() => toggleRow(e.toastEmployeeId)}
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
                            : cardCount === 0 && noShowCount === 0
                                ? tx('Nobody right now', 'Nadie ahora')
                                : tx(`${cardCount} on the clock`, `${cardCount} marcados`)}
                        {noShowCount > 0 && (
                            <span className="ml-1 text-red-700">· ⚠ {noShowCount}</span>
                        )}
                        {outCount > 0 && (
                            <span className="ml-1 text-dd-text-2 font-bold">· {outCount} {tx('out', 'salió')}</span>
                        )}
                    </div>
                </div>
                {combined.isStale && <StaleBadge minutesAgo={combined.minutesAgo} language={language} />}
                {/* Avatar stack (first 3, no-shows first) */}
                <div className="flex -space-x-2 shrink-0">
                    {fedSortedForModal.slice(0, 3).map(e => (
                        <div key={e.toastEmployeeId}
                             className={`w-7 h-7 rounded-full border-2 border-white flex items-center justify-center text-[10px] font-black ${
                                 e.isNoShow
                                     ? 'bg-red-50 text-red-700 ring-1 ring-red-400'
                                     : e.clockedOut
                                         ? 'bg-dd-bg text-dd-text-2'
                                         : 'bg-dd-green-50 text-dd-green-700'
                             }`}>
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
                                        {noShowCount > 0 && ' · ' + tx(`${noShowCount} no-show`, `${noShowCount} no llegó`)}
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
                                ) : fedEntries.length === 0 ? (
                                    <EmptyState language={language} />
                                ) : (
                                    <ul className="divide-y divide-dd-line/40">
                                        {fedSortedForModal.map(e => (
                                            <EntryRow
                                                key={e.toastEmployeeId || `${e._loc || ''}:${e.employeeName}`}
                                                entry={e}
                                                language={language}
                                                showLocation={showLocation}
                                                isExpanded={expandedRowId === e.toastEmployeeId}
                                                onToggle={() => toggleRow(e.toastEmployeeId)}
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
