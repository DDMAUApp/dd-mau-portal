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
//   - Owns the Firestore subscriptions via subscribeClockedIn. Since
//     2026-08-29 (CI7a) BOTH locations are always subscribed and the
//     `location` prop only filters the display — toggling W↔M no longer
//     tears listeners down. State is warm-seeded from localStorage (CI1)
//     so reopening the app paints instantly.
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

import { useEffect, useState, useMemo, useCallback, useRef, memo, lazy, Suspense } from 'react';
import {
    Users, Clock, Coffee, AlertTriangle, ChevronRight, ChevronDown,
    X, RefreshCw, Calendar, UserX, LogOut, History,
} from 'lucide-react';
import {
    subscribeClockedIn, getClockedInStatus,
    subscribeClockSessions, earlierSessionsFor,
    fmtClockTime, hoursWeekTone,
    readClockedInCache, writeClockedInCache,
    readClockSessionsCache, writeClockSessionsCache,
} from '../data/clockedIn';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

// Lazy — the attendance/clock-in history (the same one in Admin) only loads
// when an admin/manager taps the "History" button in this panel.
const AttendanceLog = lazy(() => import('./AttendanceLog'));

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

// ── Hook: subscribe to BOTH locations, return status for the displayed one ──
function useClockedIn(location) {
    // CI1 (2026-08-29): seed BOTH locations from the localStorage warm cache
    // (≤10 min old) so reopening the app paints the roster instantly instead
    // of spinning while the first snapshot round-trips. The seed is honest:
    // the freshness memo below always derives minutesAgo/isStale from the
    // seeded doc's own updatedAt, so an old seed shows its true age (and the
    // Stale badge) on the very first paint — the 2026-08-12 "badge must fire
    // without a snapshot" invariant holds for seeded paints too.
    const [webster, setWebster]   = useState(() => readClockedInCache('webster'));
    const [maryland, setMaryland] = useState(() => readClockedInCache('maryland'));
    // clock_sessions seeded too (my call, CI1): earlierSessionsFor()
    // date-guards on the doc's own `date` field, so seeding a prior day's
    // doc is inert — and a same-day seed makes "Earlier today" lines paint
    // with the roster instead of popping in a beat later.
    const [wSess, setWSess] = useState(() => readClockSessionsCache('webster'));   // ops/clock_sessions_webster
    const [mSess, setMSess] = useState(() => readClockSessionsCache('maryland'));  // ops/clock_sessions_maryland
    const [tick, setTick] = useState(0);

    // CI8 (2026-08-29): per-stream error tracking + one coalesced retry.
    // A snapshot error must NOT wipe data (null is the doc-absent signal,
    // see subscribeClockedIn) — keep the prior roster, flag the error, and
    // drive ALL failing streams through a single pending backoff timer.
    const streamErrorsRef = useRef({});                       // { webster: bool, maryland: bool, wSess: bool, mSess: bool }
    const [hasStreamError, setHasStreamError] = useState(false);
    const retryTimerRef = useRef(null);
    const backoffIdxRef = useRef(0);

    const scheduleRetry = useCallback(() => {
        if (retryTimerRef.current) return; // one pending timer covers all streams
        const BACKOFFS = [15_000, 30_000, 60_000, 300_000];   // 15s→30s→60s→5min cap
        const delay = BACKOFFS[Math.min(backoffIdxRef.current, BACKOFFS.length - 1)];
        backoffIdxRef.current = Math.min(backoffIdxRef.current + 1, BACKOFFS.length - 1);
        retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            setTick(t => t + 1); // re-attach all listeners
        }, delay);
    }, []);

    const noteSuccess = useCallback((stream) => {
        backoffIdxRef.current = 0; // any successful snapshot resets the backoff
        if (streamErrorsRef.current[stream]) streamErrorsRef.current[stream] = false;
        const anyLeft = Object.values(streamErrorsRef.current).some(Boolean);
        // Only cancel the pending retry when EVERY stream has recovered —
        // clearing it on a partial success would strand the still-failing ones.
        if (!anyLeft && retryTimerRef.current) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
        }
        setHasStreamError(anyLeft);
    }, []);

    const noteError = useCallback((stream) => {
        streamErrorsRef.current[stream] = true;
        setHasStreamError(true);
        scheduleRetry();
    }, [scheduleRetry]);

    // Manual refresh — cancel any pending backoff and re-attach now.
    const refresh = useCallback(() => {
        if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
        }
        backoffIdxRef.current = 0;
        setTick(t => t + 1);
    }, []);

    // Clear the pending retry timer on unmount.
    useEffect(() => () => {
        if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
        }
    }, []);

    // 15s wall clock (2026-08-12, Andrew: "i keep seeing the stale") — the
    // freshness memo below only recomputed when a SNAPSHOT arrived, so if the
    // scraper stalled, "updated 3m ago" froze at 3m and the STALE badge
    // could never fire (no new snapshot = no recompute — the exact moment
    // staleness matters). This clock keeps minutesAgo/isStale honest
    // between writes. (CI2 2026-08-29: was 30s; tightened to 15s so the
    // seconds-granularity "updated 40s ago" stamp stays fresh under 2 min.)
    const [clock, setClock] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setClock(c => c + 1), 15_000);
        return () => clearInterval(id);
    }, []);

    // Re-establish the realtime listener whenever the app returns to the
    // foreground. On Android (and a backgrounded PWA/WebView) the Firestore
    // onSnapshot stream goes idle while the app is suspended and can show a STALE
    // roster on resume — the doc is fresh server-side but the client never got the
    // update. Bumping `tick` tears the listener down and recreates it, forcing a
    // fresh server snapshot so reopening the app always shows who's on the clock now.
    useEffect(() => {
        // CI7c (2026-08-29): focus + visibilitychange usually fire together on
        // foreground, which double-bumped tick and tore down/rebuilt all four
        // listeners twice back-to-back. Coalesce by timestamp (1s window).
        // BOTH listeners stay registered — some platforms only fire one.
        let lastBump = 0;
        const bump = () => {
            const now = Date.now();
            if (now - lastBump < 1000) return;
            lastBump = now;
            setTick(t => t + 1);
        };
        const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') bump(); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
        if (typeof window !== 'undefined') window.addEventListener('focus', bump);
        return () => {
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
            if (typeof window !== 'undefined') window.removeEventListener('focus', bump);
        };
    }, []);

    useEffect(() => {
        // CI7a (2026-08-29): subscribe BOTH locations unconditionally and let
        // the display layer filter by `location`. Toggling W↔M used to tear
        // every listener down and recreate it — a full server round-trip on
        // each toggle was the "slow, not smooth" feel. Four tiny-doc
        // listeners are cheap. NOTE: revisit this if ops/ rules are ever
        // carved per-location — a viewer without cross-location read would
        // make the extra pair error instead of stream.
        //
        // CI1: cache writes are SUCCESS-PATH ONLY. Error and doc-absent both
        // surface as null and must never clobber the warm cache.
        const uW1 = subscribeClockedIn('webster', (d) => {
            noteSuccess('webster');
            setWebster(d);
            if (d) writeClockedInCache('webster', d);
        }, () => noteError('webster'));
        const uW2 = subscribeClockSessions('webster', (d) => {
            noteSuccess('wSess');
            setWSess(d);
            if (d) writeClockSessionsCache('webster', d);
        }, () => noteError('wSess'));
        const uM1 = subscribeClockedIn('maryland', (d) => {
            noteSuccess('maryland');
            setMaryland(d);
            if (d) writeClockedInCache('maryland', d);
        }, () => noteError('maryland'));
        const uM2 = subscribeClockSessions('maryland', (d) => {
            noteSuccess('mSess');
            setMSess(d);
            if (d) writeClockSessionsCache('maryland', d);
        }, () => noteError('mSess'));
        return () => { uW1(); uW2(); uM1(); uM2(); };
        // `location` intentionally NOT a dep (CI7a) — display filters instead,
        // so a W↔M toggle never tears the listeners down. `tick` stays.
    }, [tick, noteSuccess, noteError]);

    // CI4 (2026-08-29): entries enrichment — identity MUST NOT change on
    // clock ticks. This is what fedEntries/sorts/memoized EntryRows hang off;
    // when it churned every 30s (old single memo dep'd on `clock`), every row
    // re-rendered twice a minute for no data change. Re-derives only when a
    // doc actually changes or the displayed location flips.
    const entries = useMemo(() => {
        // Enrich each entry with TODAY's earlier completed sessions (clock out →
        // clock back in), captured by the recordCompletedSessions Cloud Function.
        const wE = (Array.isArray(webster?.entries) ? webster.entries : [])
            .map(e => ({ ...e, _loc: 'webster', earlierSessions: earlierSessionsFor(wSess, e.toastEmployeeId) }));
        const mE = (Array.isArray(maryland?.entries) ? maryland.entries : [])
            .map(e => ({ ...e, _loc: 'maryland', earlierSessions: earlierSessionsFor(mSess, e.toastEmployeeId) }));
        if (location === 'webster')  return wE;
        if (location === 'maryland') return mE;
        // 'both' — merge, oldest clock-in first.
        return [...wE, ...mE].sort((a, b) => (a.clockedInAt || '').localeCompare(b.clockedInAt || ''));
    }, [webster, maryland, wSess, mSess, location]);

    // CI2: freshness — minutesAgo/secondsAgo/isStale for the displayed
    // location. The wall-clock dep MUST stay HERE (2026-08-12 invariant:
    // the stale badge has to fire even when no new snapshot arrives) — it
    // was deliberately split away from the entries memo above.
    const freshness = useMemo(() => {
        const w = getClockedInStatus(webster);
        const m = getClockedInStatus(maryland);
        let hasData, updatedAt, isStale;
        if (location === 'webster')       { hasData = w.hasData; updatedAt = w.updatedAt; isStale = w.isStale; }
        else if (location === 'maryland') { hasData = m.hasData; updatedAt = m.updatedAt; isStale = m.isStale; }
        else {
            hasData = w.hasData || m.hasData;
            // Combined stamp: oldest updatedAt is the "least fresh" one.
            updatedAt = w.updatedAt && m.updatedAt
                ? (w.updatedAt < m.updatedAt ? w.updatedAt : m.updatedAt)
                : (w.updatedAt || m.updatedAt);
            isStale = w.isStale || m.isStale;
        }
        const ageMs = updatedAt ? Math.max(0, Date.now() - updatedAt.getTime()) : null;
        return {
            hasData,
            updatedAt,
            minutesAgo: ageMs !== null ? Math.round(ageMs / 60000) : null,
            secondsAgo: ageMs !== null ? Math.round(ageMs / 1000) : null,
            isStale,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [webster, maryland, location, clock]);

    return {
        combined: {
            ...freshness,
            entries,                                            // identity-stable across clock ticks
            count: entries.filter(e => !e.clockedOut).length,   // on the clock now
            error: hasStreamError,                              // CI8 — any stream currently failing
        },
        refresh,
    };
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StaleBadge({ minutesAgo, language }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    // CI8: the badge also fires for stream errors, where there may be no
    // timestamped doc at all — guard so we never print "Stale (nullm)".
    const label = minutesAgo != null
        ? tx(`Stale (${minutesAgo}m)`, `Atrasado (${minutesAgo}m)`)
        : tx('Stale', 'Atrasado');
    return (
        <div className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded-full">
            <AlertTriangle size={11} strokeWidth={2.5} />
            {label}
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
//
// CI5 (2026-08-29): React.memo + a stable (rowKey, onToggle) contract.
// The parent passes ONE useCallback'd toggle plus this row's key instead
// of a fresh closure per row per render — so expanding one row re-renders
// only the two affected rows, and clock-tick re-renders of the parent
// skip every row (entry identity is stable across ticks, see CI4).
const EntryRow = memo(function EntryRow({ entry, language, showLocation, isExpanded, rowKey, onToggle }) {
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
    // Anchored to the FIRST clock-in of the day so a break clock-out/in
    // never rewrites the arrival pill (firstClockInAt, 2026-07-11).
    const punct = isNoShow ? null : getPunctuality(entry.firstClockInAt || entry.clockedInAt, entry.scheduledShift, isEs);

    const sched = entry.scheduledShift;
    const hasBreaks = Array.isArray(entry.breaksToday) && entry.breaksToday.length > 0;

    return (
        <li className={`border-b border-dd-line/60 last:border-0 ${isNoShow ? 'bg-red-50/40' : isOut ? 'bg-dd-bg/40' : ''}`}>
            <button
                type="button"
                onClick={() => onToggle(rowKey)}
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
                        {!isNoShow && entry.notScheduled && (
                            <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-black px-1.5 py-0.5 rounded-full border bg-amber-100 text-amber-800 border-amber-300">
                                <Calendar size={10} strokeWidth={2.5} />
                                {tx('NOT SCHEDULED', 'SIN HORARIO')}
                            </span>
                        )}
                    </div>
                    {!isNoShow && (
                        <div className="text-[11px] text-dd-text-2 flex items-center gap-1.5 mt-0.5">
                            <Clock size={11} strokeWidth={2.25} className="shrink-0" />
                            <span>
                                {tx('In at', 'Entró a las')} {fmtClockTime(entry.firstClockInAt || entry.clockedInAt)}
                                {entry.isReturnFromBreak && (
                                    <span className="text-amber-700"> · {tx('back from break', 'volvió del descanso')} {fmtClockTime(entry.clockedInAt)}</span>
                                )}
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
                    {entry.earlierSessions && entry.earlierSessions.length > 0 && (
                        <div className="text-[11px] text-dd-text-2/90 flex items-start gap-1.5 mt-0.5">
                            <History size={11} strokeWidth={2.25} className="shrink-0 mt-px" />
                            <span>
                                {tx('Earlier today', 'Antes hoy')}:{' '}
                                {entry.earlierSessions.map((s, i) => (
                                    <span key={i}>{i > 0 ? ', ' : ''}{fmtClockTime(s.clockIn)}–{s.clockOut ? fmtClockTime(s.clockOut) : '…'}</span>
                                ))}
                            </span>
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
});

// CI5 — row identity: toastEmployeeId when present, else location+name.
// MUST be the same value used for the React key, the expansion check, AND
// the toggle argument. (The old check compared expandedRowId against a
// possibly-undefined e.toastEmployeeId, so once one id-less row was
// toggled, EVERY id-less row read as expanded.)
const rowKeyOf = (e) => e.toastEmployeeId || `${e._loc || ''}:${e.employeeName}`;

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

// CI8 — explicit couldn't-load state. Renders when every stream errored
// before ANY data (live or cache-seeded) arrived; replaces the old infinite
// "Loading from Toast…" spinner that an error would leave up forever.
function ErrorState({ language, onRetry }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    return (
        <div className="text-center py-6">
            <div className="w-11 h-11 mx-auto mb-2 rounded-full bg-red-50 flex items-center justify-center text-red-700">
                <AlertTriangle size={20} strokeWidth={2.25} />
            </div>
            <p className="text-sm font-bold text-dd-text">{tx("Couldn't load who's clocked in", 'No se pudo cargar')}</p>
            <p className="text-[11px] text-dd-text-2 mt-0.5">
                {tx('Check your connection — retrying automatically.', 'Revisa tu conexión — reintentando automáticamente.')}
            </p>
            <button type="button" onClick={onRetry}
                className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-dd-text bg-dd-bg hover:bg-dd-line px-3 py-1.5 rounded-full border border-dd-line active:scale-95 transition">
                <RefreshCw size={12} strokeWidth={2.5} /> {tx('Retry', 'Reintentar')}
            </button>
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
    staffList = [],     // for the history modal's name matching
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const { combined, refresh } = useClockedIn(location);
    const [expanded, setExpanded] = useState(false);
    // Single-row expansion state — only one row open at a time. Keyed by
    // toastEmployeeId (or synthetic noshow:{shiftId} for ghost rows).
    const [expandedRowId, setExpandedRowId] = useState(null);
    // Clock-in history modal (same AttendanceLog as the admin page).
    const [historyOpen, setHistoryOpen] = useState(false);

    // Shared history modal — rendered in both card + strip variants.
    const historyModal = historyOpen && (
        <ModalPortal onBackPress={() => setHistoryOpen(false)}>
            <div className="fixed inset-0 z-[70] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
                onClick={() => setHistoryOpen(false)} role="dialog" aria-modal="true">
                <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden"
                    onClick={(e) => e.stopPropagation()} style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                    <div className="flex items-center justify-between p-3 border-b border-dd-line bg-dd-green-50 flex-shrink-0 safe-top">
                        <h2 className="text-base font-black text-dd-green-700 flex items-center gap-2">
                            <History size={18} strokeWidth={2.25} /> {tx('Clock-in history', 'Historial de fichaje')}
                        </h2>
                        <button onClick={() => setHistoryOpen(false)} className="w-10 h-10 rounded-full hover:bg-white/60 flex items-center justify-center" aria-label={tx('Close', 'Cerrar')}><X size={18} /></button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-3" style={{ overscrollBehavior: 'contain' }}>
                        <Suspense fallback={<LoadingState language={language} />}>
                            <AttendanceLog language={language} staffList={staffList} startExpanded />
                        </Suspense>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );

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
            // Anchor punctuality + shift matching to the FIRST clock-in
            // of the day, not the latest punch. Toast's clockedInAt is
            // the CURRENT session's start — someone who clocked out for
            // a break and back in used to get the lateness math re-run
            // against the return time ("10m late" became "300m late",
            // Andrew 2026-07-11). Earlier completed sessions come from
            // the clock_sessions doc; the earliest clockIn wins.
            let firstIn = e.clockedInAt || null;
            for (const s of (e.earlierSessions || [])) {
                if (s?.clockIn && (!firstIn || new Date(s.clockIn).getTime() < new Date(firstIn).getTime())) {
                    firstIn = s.clockIn;
                }
            }
            out.push({
                ...e,
                scheduledShift: pickBestShift(candidates, firstIn),
                isNoShow: false,
                firstClockInAt: firstIn,
                // Current session started after an earlier one ended =
                // they're back from a clock-out break; the row labels
                // the re-entry as a break return instead of a fresh
                // arrival.
                isReturnFromBreak: (e.earlierSessions || []).length > 0
                    && !!firstIn && firstIn !== e.clockedInAt,
                // On the clock with NO shift on today's schedule —
                // surfaced with its own pill + header count.
                notScheduled: candidates.length === 0,
            });
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

    // CI5 — one stable toggle shared by every row (see EntryRow memo note).
    const toggleRow = useCallback((id) => setExpandedRowId(prev => (prev === id ? null : id)), []);

    // CI2 — honest Refresh: re-attaching the listeners is ALL this button can
    // do (fresh data lands on Toast's ~90s scrape cadence, not on demand), so
    // show a brief spin and say so instead of implying an instant re-fetch.
    const [refreshSpin, setRefreshSpin] = useState(false);
    const spinTimerRef = useRef(null);
    useEffect(() => () => clearTimeout(spinTimerRef.current), []);
    const handleRefresh = () => {
        refresh(); // tears down + re-attaches the listeners (unchanged behavior)
        setRefreshSpin(true);
        clearTimeout(spinTimerRef.current);
        spinTimerRef.current = setTimeout(() => setRefreshSpin(false), 900);
        toast(tx('Reconnected — Toast updates every ~90s', 'Reconectado — Toast actualiza cada ~90s'), { duration: 3500 });
    };

    // CI2 — freshness stamp: seconds granularity under 2 min ("updated 40s
    // ago"), minutes above. The hook's wall clock ticks every 15s so the
    // seconds read stays honest.
    const agoShort = combined.updatedAt
        ? (combined.secondsAgo != null && combined.secondsAgo < 120
            ? `${combined.secondsAgo}s`
            : `${combined.minutesAgo}m`)
        : null;
    // CI8 — stale-badge treatment also covers "stream errored but we still
    // have data" (live-or-seeded); an error with NO data gets ErrorState.
    const showStaleBadge = combined.isStale || (combined.error && combined.hasData);

    const cardCount   = fedEntries.filter(e => !e.isNoShow && !e.clockedOut).length;  // on the clock now
    const outCount    = fedEntries.filter(e => e.clockedOut).length;                  // clocked out today
    const noShowCount = fedEntries.filter(e => e.isNoShow).length;
    // On the clock right now with no shift on today's schedule.
    const notSchedCount = fedEntries.filter(e => e.notScheduled && !e.isNoShow && !e.clockedOut).length;

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
                                {agoShort && (
                                    <span> · {tx(`updated ${agoShort} ago`, `hace ${agoShort}`)}</span>
                                )}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {showStaleBadge && <StaleBadge minutesAgo={combined.minutesAgo} language={language} />}
                        {noShowCount > 0 && (
                            <span className="text-xs font-black text-red-700 bg-red-50 px-2.5 py-1 rounded-full border border-red-300">
                                ⚠ {noShowCount} {tx('no-show', 'no llegó')}
                            </span>
                        )}
                        {notSchedCount > 0 && (
                            <span className="text-xs font-black text-amber-800 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-300">
                                📋 {notSchedCount} {tx('not scheduled', 'sin horario')}
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
                        <button onClick={handleRefresh}
                            title={tx('Reconnect — Toast updates every ~90s', 'Reconectar — Toast actualiza cada ~90s')}
                            className="inline-flex items-center justify-center w-7 h-7 text-dd-text-2 bg-dd-bg hover:bg-dd-line rounded-full border border-dd-line active:scale-95 transition"
                            aria-label={tx('Refresh', 'Actualizar')}>
                            <RefreshCw size={13} strokeWidth={2.5} className={refreshSpin ? 'animate-spin' : ''} />
                        </button>
                        <button onClick={() => setHistoryOpen(true)}
                            className="inline-flex items-center gap-1 text-xs font-bold text-dd-text-2 bg-dd-bg hover:bg-dd-line px-2.5 py-1 rounded-full border border-dd-line active:scale-95 transition">
                            <History size={13} strokeWidth={2.5} /> {tx('History', 'Historial')}
                        </button>
                    </div>
                </div>

                {!combined.hasData ? (
                    // CI8 — error with no data is an explicit couldn't-load
                    // row with retry, never the infinite spinner.
                    combined.error
                        ? <ErrorState language={language} onRetry={handleRefresh} />
                        : <LoadingState language={language} />
                ) : fedEntries.length === 0 ? (
                    <EmptyState language={language} />
                ) : (
                    <ul className="divide-y divide-dd-line/40 max-h-[520px] overflow-y-auto -mx-1 px-1">
                        {fedSortedForCard.map(e => {
                            const rk = rowKeyOf(e); // CI5 — same key for React key + expansion + toggle
                            return (
                                <EntryRow
                                    key={rk}
                                    rowKey={rk}
                                    entry={e}
                                    language={language}
                                    showLocation={showLocation}
                                    isExpanded={expandedRowId === rk}
                                    onToggle={toggleRow}
                                />
                            );
                        })}
                    </ul>
                )}
                {historyModal}
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
                        {/* CI2 — freshness stamp on the collapsed strip too. */}
                        {agoShort && <span className="normal-case font-semibold text-dd-text-2/70"> · {agoShort}</span>}
                    </div>
                    <div className="text-sm font-black text-dd-text">
                        {!combined.hasData
                            ? (combined.error
                                ? tx("Couldn't load", 'No se pudo cargar')
                                : tx('Loading…', 'Cargando…'))
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
                {showStaleBadge && <StaleBadge minutesAgo={combined.minutesAgo} language={language} />}
                {/* Avatar stack (first 3, no-shows first) */}
                <div className="flex -space-x-2 shrink-0">
                    {fedSortedForModal.slice(0, 3).map(e => (
                        <div key={rowKeyOf(e)}
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
                                        {agoShort
                                            ? tx(`Updated ${agoShort} ago`, `Actualizado hace ${agoShort}`)
                                            : tx('Live from Toast', 'En vivo desde Toast')}
                                        {showStaleBadge && ' · ' + tx('STALE', 'ATRASADO')}
                                        {noShowCount > 0 && ' · ' + tx(`${noShowCount} no-show`, `${noShowCount} no llegó`)}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <button onClick={() => setHistoryOpen(true)}
                                        className="inline-flex items-center gap-1 text-xs font-bold text-dd-green-700 bg-white/70 hover:bg-white px-2.5 py-1.5 rounded-full active:scale-95 transition"
                                        aria-label={tx('Clock-in history', 'Historial de fichaje')}>
                                        <History size={14} strokeWidth={2.5} /> {tx('History', 'Historial')}
                                    </button>
                                    <button
                                        onClick={() => { setExpanded(false); onClose?.(); }}
                                        className="w-11 h-11 rounded-full hover:bg-white/60 flex items-center justify-center"
                                        aria-label={tx('Close', 'Cerrar')}
                                    >
                                        <X size={18} />
                                    </button>
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto p-3" style={{ overscrollBehavior: 'contain' }}>
                                {!combined.hasData ? (
                                    // CI8 — explicit error row w/ retry, never the infinite spinner.
                                    combined.error
                                        ? <ErrorState language={language} onRetry={handleRefresh} />
                                        : <LoadingState language={language} />
                                ) : fedEntries.length === 0 ? (
                                    <EmptyState language={language} />
                                ) : (
                                    <ul className="divide-y divide-dd-line/40">
                                        {fedSortedForModal.map(e => {
                                            const rk = rowKeyOf(e); // CI5
                                            return (
                                                <EntryRow
                                                    key={rk}
                                                    rowKey={rk}
                                                    entry={e}
                                                    language={language}
                                                    showLocation={showLocation}
                                                    isExpanded={expandedRowId === rk}
                                                    onToggle={toggleRow}
                                                />
                                            );
                                        })}
                                    </ul>
                                )}
                            </div>
                        </div>
                    </div>
                </ModalPortal>
            )}
            {historyModal}
        </>
    );
}
