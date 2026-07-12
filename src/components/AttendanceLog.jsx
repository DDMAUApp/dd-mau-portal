import { useState, useEffect, useMemo } from 'react';
import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import ModalPortal from './ModalPortal';

// Attendance Log — Andrew 2026-06-25: "a log for who's clocked in. all staff
// names in a list; next to each show on-time / late / no-show counts + shifts
// worked over the past 4 weeks; click a staff → month or week view we can
// scroll back through, each with its own count."
//
// Reads the append-only /attendance collection written by the recordAttendance
// Cloud Function (see functions/attendance.js). Each doc = one staff/day:
//   { staffName, staffKey, date 'YYYY-MM-DD', status: on_time|late|no_show,
//     clockedInAt, minutesLate, scheduledStart, location }
//
// Counts: shifts worked = on_time + late (actually clocked in). Dates are
// Central calendar keys; the viewer (Central) uses local date math to match.

const STATUS = {
    on_time: { dot: 'bg-dd-green',  text: 'text-dd-green-700', chip: 'bg-dd-green text-white',        en: 'On time', es: 'A tiempo' },
    late:    { dot: 'bg-amber-500', text: 'text-amber-700',    chip: 'bg-amber-100 text-amber-800 border border-amber-300', en: 'Late', es: 'Tarde' },
    no_show: { dot: 'bg-red-500',   text: 'text-red-700',      chip: 'bg-red-100 text-red-700 border border-red-300',       en: 'No show', es: 'Falta' },
};

function ymd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function addDays(d, n) { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; } // Sunday
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1, 12); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1, 12); }

// Tally an array of attendance records into { on_time, late, no_show, worked }.
function tally(records) {
    const c = { on_time: 0, late: 0, no_show: 0 };
    for (const r of records) if (c[r.status] != null) c[r.status]++;
    return { ...c, worked: c.on_time + c.late };
}

// ── Per-staff drill-down modal (month / week, scrollable back) ──────────────
function AttendanceDetailModal({ staffName, staffKey, language, onClose }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [view, setView] = useState('month');   // 'month' | 'week'
    const [anchor, setAnchor] = useState(() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; });

    useEffect(() => {
        let alive = true;
        (async () => {
            setLoading(true);
            try {
                const snap = await getDocs(query(
                    collection(db, 'attendance'),
                    where('staffKey', '==', staffKey),
                    orderBy('date', 'desc'),
                    limit(400),
                ));
                const rows = [];
                snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
                if (alive) setRecords(rows);
            } catch (e) {
                console.warn('attendance detail load failed:', e);
                if (alive) setRecords([]);
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [staffKey]);

    // date 'YYYY-MM-DD' → record (prefer an actual clock-in if a day somehow
    // has two location rows).
    const byDate = useMemo(() => {
        const m = new Map();
        for (const r of records) {
            const prev = m.get(r.date);
            if (!prev || (!prev.clockedInAt && r.clockedInAt)) m.set(r.date, r);
        }
        return m;
    }, [records]);

    // Visible period bounds + day cells.
    const period = useMemo(() => {
        if (view === 'week') {
            const start = startOfWeek(anchor);
            const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
            const end = days[6];
            const label = `${start.toLocaleDateString(isEn ? 'en-US' : 'es-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(isEn ? 'en-US' : 'es-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
            return { days, startKey: ymd(start), endKey: ymd(end), label, leadBlanks: 0 };
        }
        const first = startOfMonth(anchor);
        const lead = first.getDay(); // blanks before the 1st
        const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
        const days = Array.from({ length: daysInMonth }, (_, i) => new Date(anchor.getFullYear(), anchor.getMonth(), i + 1, 12));
        const label = first.toLocaleDateString(isEn ? 'en-US' : 'es-US', { month: 'long', year: 'numeric' });
        return { days, startKey: ymd(days[0]), endKey: ymd(days[days.length - 1]), label, leadBlanks: lead };
    }, [view, anchor, isEn]);

    const periodCounts = useMemo(() => {
        const inRange = records.filter(r => r.date >= period.startKey && r.date <= period.endKey);
        return tally(inRange);
    }, [records, period]);

    // Per-shift detail rows for the visible period (newest first) — the "more
    // info" list under the calendar: exact clock-in vs scheduled time, late
    // minutes, and location, per shift.
    const periodRecords = useMemo(() =>
        records
            .filter(r => r.date >= period.startKey && r.date <= period.endKey)
            .sort((a, b) => (b.date || '').localeCompare(a.date || '')),
        [records, period]);
    // Format an ISO datetime OR an "HH:MM" string to a localized clock time.
    const fmtHM = (v) => {
        if (!v) return '';
        const s = String(v);
        let d = null;
        if (s.includes('T')) { d = new Date(s); }
        else { const m = s.match(/^(\d{1,2}):(\d{2})/); if (m) { d = new Date(); d.setHours(+m[1], +m[2], 0, 0); } }
        if (!d || Number.isNaN(d.getTime())) return '';
        return d.toLocaleTimeString(isEn ? 'en-US' : 'es-US', { hour: 'numeric', minute: '2-digit' });
    };

    const goBack = () => setAnchor(a => (view === 'week' ? addDays(startOfWeek(a), -7) : addMonths(a, -1)));
    const goFwd = () => setAnchor(a => (view === 'week' ? addDays(startOfWeek(a), 7) : addMonths(a, 1)));
    const todayKey = ymd(new Date());
    const dayNames = isEn ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] : ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá'];

    return (
        <ModalPortal onBackPress={onClose}>
            {/* z-[80]: this per-staff detail opens FROM the Clock-in history modal,
                which the Clocked-In panel renders at z-[70]. At the old z-50 the
                detail rendered BEHIND the history popup (tapping a name looked like
                nothing happened). Must sit above any modal it can be launched from. */}
            <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 bg-black/40" onClick={onClose} role="dialog" aria-modal="true">
                <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-dd-line overflow-hidden flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
                    {/* Header */}
                    <div className="px-4 py-3 bg-dd-green-50 border-b border-dd-line flex items-center justify-between gap-2">
                        <div className="min-w-0">
                            <div className="text-base font-black text-dd-text truncate">{staffName}</div>
                            <div className="text-[11px] text-dd-text-2">{tx('Attendance', 'Asistencia')}</div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                            <div className="flex rounded-lg overflow-hidden border border-dd-line">
                                {['month', 'week'].map(v => (
                                    <button key={v} onClick={() => setView(v)}
                                        className={`px-2.5 py-1 text-[11px] font-bold ${view === v ? 'bg-dd-green text-white' : 'bg-white text-dd-text-2 hover:bg-dd-bg'}`}>
                                        {v === 'month' ? tx('Month', 'Mes') : tx('Week', 'Semana')}
                                    </button>
                                ))}
                            </div>
                            <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/70 text-dd-text-2 hover:bg-white text-lg leading-none">✕</button>
                        </div>
                    </div>

                    {/* Period nav + counts */}
                    <div className="px-4 py-2 flex items-center justify-between border-b border-dd-line">
                        <button onClick={goBack} className="px-2 py-1 rounded-lg bg-dd-bg text-dd-text font-bold hover:bg-dd-line">‹</button>
                        <div className="text-sm font-bold text-dd-text text-center">{period.label}</div>
                        <button onClick={goFwd} className="px-2 py-1 rounded-lg bg-dd-bg text-dd-text font-bold hover:bg-dd-line">›</button>
                    </div>
                    <div className="px-4 py-2 flex items-center justify-center gap-2 flex-wrap border-b border-dd-line bg-dd-bg/40">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${STATUS.on_time.chip}`}>{periodCounts.on_time} {tx('on time', 'a tiempo')}</span>
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${STATUS.late.chip}`}>{periodCounts.late} {tx('late', 'tarde')}</span>
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${STATUS.no_show.chip}`}>{periodCounts.no_show} {tx('no show', 'faltas')}</span>
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-dd-bg text-dd-text-2 border border-dd-line">{periodCounts.worked} {tx('worked', 'trabajados')}</span>
                    </div>

                    {/* Calendar body */}
                    <div className="p-3 overflow-y-auto">
                        {loading ? (
                            <p className="text-[12px] text-dd-text-2 italic text-center py-8">{tx('Loading…', 'Cargando…')}</p>
                        ) : (
                            <div className="grid grid-cols-7 gap-1">
                                {dayNames.map(dn => (
                                    <div key={dn} className="text-[10px] font-bold text-dd-text-2 text-center pb-1">{dn}</div>
                                ))}
                                {Array.from({ length: period.leadBlanks }).map((_, i) => <div key={`b${i}`} />)}
                                {period.days.map(d => {
                                    const key = ymd(d);
                                    const rec = byDate.get(key);
                                    const st = rec ? STATUS[rec.status] : null;
                                    const isToday = key === todayKey;
                                    return (
                                        <div key={key}
                                            className={`aspect-square rounded-lg border flex flex-col items-center justify-center text-center p-0.5 ${isToday ? 'border-dd-green border-2' : 'border-dd-line'} ${st ? '' : 'bg-white'}`}
                                            title={rec ? `${STATUS[rec.status][isEn ? 'en' : 'es']}${rec.minutesLate > 5 ? ` (+${rec.minutesLate}m)` : ''}` : ''}>
                                            <span className="text-[11px] font-bold text-dd-text leading-none">{d.getDate()}</span>
                                            {st && <span className={`mt-0.5 w-2.5 h-2.5 rounded-full ${st.dot}`} />}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {/* Legend */}
                        <div className="flex items-center justify-center gap-3 mt-3 flex-wrap">
                            {Object.entries(STATUS).map(([k, s]) => (
                                <span key={k} className="inline-flex items-center gap-1 text-[10px] text-dd-text-2">
                                    <span className={`w-2.5 h-2.5 rounded-full ${s.dot}`} /> {isEn ? s.en : s.es}
                                </span>
                            ))}
                        </div>

                        {/* Per-shift detail — exact clock-in vs scheduled, lateness, location */}
                        {!loading && periodRecords.length > 0 && (
                            <div className="mt-3 border-t border-dd-line pt-2">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                    {view === 'week' ? tx('Shifts this week', 'Turnos esta semana') : tx('Shifts this month', 'Turnos este mes')}
                                </div>
                                <ul className="space-y-1">
                                    {periodRecords.map(r => {
                                        const st = STATUS[r.status];
                                        const wd = new Date(`${r.date}T12:00:00`).toLocaleDateString(isEn ? 'en-US' : 'es-US', { weekday: 'short', month: 'short', day: 'numeric' });
                                        return (
                                            <li key={r.id} className="flex items-center gap-2 text-[12px] bg-dd-bg/40 rounded-lg px-2.5 py-1.5">
                                                <span className="w-[5.5rem] shrink-0 font-bold text-dd-text">{wd}</span>
                                                <span className={`shrink-0 text-[10px] font-black px-1.5 py-0.5 rounded-full ${st?.chip || 'bg-dd-bg text-dd-text-2'}`}>{st ? (isEn ? st.en : st.es) : r.status}</span>
                                                <span className="flex-1 min-w-0 text-dd-text-2 truncate">
                                                    {r.status !== 'no_show' && r.clockedInAt && <>{tx('in', 'entró')} {fmtHM(r.clockedInAt)}</>}
                                                    {r.scheduledStart && <span className="text-dd-text-2/70"> · {tx('sched', 'prog')} {fmtHM(r.scheduledStart)}</span>}
                                                    {Number(r.minutesLate) > 0 && <span className="text-amber-700 font-bold"> · +{r.minutesLate}m</span>}
                                                </span>
                                                {r.location && <span className="shrink-0 text-[9px] uppercase font-bold text-dd-text-2/70">{r.location}</span>}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}

// ── Main: collapsible admin section ─────────────────────────────────────────
export default function AttendanceLog({ language, staffList, startExpanded = false }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);
    const [expanded, setExpanded] = useState(startExpanded);
    const [loading, setLoading] = useState(false);
    const [records, setRecords] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [selected, setSelected] = useState(null); // { staffName, staffKey }
    const [search, setSearch] = useState('');

    const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

    const load = async () => {
        setLoading(true);
        try {
            const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 28);
            const cutoffKey = ymd(cutoff);
            const snap = await getDocs(query(
                collection(db, 'attendance'),
                where('date', '>=', cutoffKey),
                orderBy('date', 'desc'),
            ));
            const rows = [];
            snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
            setRecords(rows);
            setLoaded(true);
        } catch (e) {
            console.warn('attendance load failed:', e);
            setRecords([]);
            setLoaded(true);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (expanded && !loaded) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expanded]);

    // Per-staffKey 4-week tally.
    const byStaff = useMemo(() => {
        const m = new Map();
        for (const r of records) {
            if (!r.staffKey) continue;
            if (!m.has(r.staffKey)) m.set(r.staffKey, []);
            m.get(r.staffKey).push(r);
        }
        return m;
    }, [records]);

    // Row list: every active staffer (from staffList), annotated with counts.
    // Staff with no attendance show zeros. Sorted by most no-shows, then late.
    const rows = useMemo(() => {
        const seenKeys = new Set();
        const out = [];
        for (const s of (staffList || [])) {
            if (!s?.name) continue;
            if (s.active === false) continue;
            const key = normName(s.name);
            seenKeys.add(key);
            const recs = byStaff.get(key) || [];
            out.push({ staffName: s.name, staffKey: key, ...tally(recs) });
        }
        // Include any attendance names not in the staff list (e.g. since-removed).
        for (const [key, recs] of byStaff.entries()) {
            if (seenKeys.has(key)) continue;
            out.push({ staffName: recs[0]?.staffName || key, staffKey: key, ...tally(recs), former: true });
        }
        out.sort((a, b) => (b.no_show - a.no_show) || (b.late - a.late) || a.staffName.localeCompare(b.staffName));
        return out;
    }, [staffList, byStaff]);

    const filtered = rows.filter(r => !search.trim() || r.staffName.toLowerCase().includes(search.trim().toLowerCase()));
    const totals = useMemo(() => tally(records), [records]);

    return (
        <div className="mb-3">
            <button onClick={() => setExpanded(v => !v)} aria-expanded={expanded}
                className="glass-section-head tint-cyan">
                <div className="flex items-center gap-3 min-w-0">
                    <span className="glass-icon-tile" aria-hidden="true">🕐</span>
                    <h3 className="font-bold text-[15px] text-dd-text">{tx("Attendance — who's clocked in", 'Asistencia — quién fichó')}</h3>
                </div>
                <span className="section-chevron text-xl" aria-hidden="true">›</span>
            </button>
            {expanded && (
                <div className="glass-card p-3 mt-2">
                    <p className="text-[11px] text-dd-text-2 mb-2 px-1">
                        {tx('On-time / late / no-show + shifts worked over the past 4 weeks (from clock-ins vs the schedule). Tap a name for the month or week view.',
                            'A tiempo / tarde / faltas + turnos trabajados en las últimas 4 semanas (fichajes vs el horario). Toca un nombre para ver el mes o la semana.')}
                    </p>
                    <div className="flex items-center justify-between gap-2 mb-2">
                        <input value={search} onChange={(e) => setSearch(e.target.value)}
                            placeholder={tx('Search a name…', 'Buscar un nombre…')}
                            className="flex-1 px-2.5 py-1.5 text-base border border-dd-line rounded-lg focus:border-dd-green focus:ring-1 focus:ring-dd-green-50 outline-none" />
                        <button onClick={load} className="text-[11px] text-dd-green-700 underline hover:no-underline shrink-0">
                            {loading ? tx('Loading…', 'Cargando…') : tx('Refresh', 'Actualizar')}
                        </button>
                    </div>

                    {loading && !loaded ? (
                        <p className="text-[12px] text-dd-text-2 italic px-2 py-3">{tx('Loading…', 'Cargando…')}</p>
                    ) : records.length === 0 ? (
                        <p className="text-[12px] text-dd-text-2 italic px-2 py-3">
                            {tx("No attendance recorded yet. This fills in automatically as staff clock in — it started recording on the day this shipped, so the past won't show until the Toast backfill runs.",
                                'Aún no hay asistencia. Se llena automáticamente cuando el personal ficha.')}
                        </p>
                    ) : (
                        <>
                            {/* Header row */}
                            <div className="grid grid-cols-[1fr_auto] gap-2 px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                                <span>{tx('Staff', 'Personal')}</span>
                                <span className="text-right">{tx('On time · Late · No show · Worked', 'A tiempo · Tarde · Falta · Trab.')}</span>
                            </div>
                            <div className="space-y-1 max-h-[26rem] overflow-y-auto overscroll-contain pr-1">
                                {filtered.map(r => (
                                    <button key={r.staffKey} onClick={() => setSelected({ staffName: r.staffName, staffKey: r.staffKey })}
                                        className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white border border-dd-line hover:bg-dd-bg active:scale-[0.99] transition text-left">
                                        <span className="text-sm font-bold text-dd-text truncate">
                                            {r.staffName}{r.former && <span className="ml-1 text-[9px] text-dd-text-2/70">({tx('former', 'ex')})</span>}
                                        </span>
                                        <span className="flex items-center gap-1.5 shrink-0 tabular-nums">
                                            <span className="inline-flex items-center justify-center min-w-[1.4rem] px-1 py-0.5 rounded text-[11px] font-bold bg-dd-green text-white" title={tx('On time', 'A tiempo')}>{r.on_time}</span>
                                            <span className="inline-flex items-center justify-center min-w-[1.4rem] px-1 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300" title={tx('Late', 'Tarde')}>{r.late}</span>
                                            <span className="inline-flex items-center justify-center min-w-[1.4rem] px-1 py-0.5 rounded text-[11px] font-bold bg-red-100 text-red-700 border border-red-300" title={tx('No show', 'Falta')}>{r.no_show}</span>
                                            <span className="inline-flex items-center justify-center min-w-[1.4rem] px-1 py-0.5 rounded text-[11px] font-bold bg-dd-bg text-dd-text-2 border border-dd-line" title={tx('Shifts worked', 'Turnos trabajados')}>{r.worked}</span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                            <div className="text-[10px] text-dd-text-2 mt-2 px-1 text-center">
                                {tx(`Last 4 weeks · ${totals.on_time} on time · ${totals.late} late · ${totals.no_show} no-show · ${totals.worked} shifts worked`,
                                    `Últimas 4 semanas · ${totals.on_time} a tiempo · ${totals.late} tarde · ${totals.no_show} faltas · ${totals.worked} turnos`)}
                            </div>
                        </>
                    )}
                </div>
            )}
            {selected && (
                <AttendanceDetailModal
                    staffName={selected.staffName}
                    staffKey={selected.staffKey}
                    language={language}
                    onClose={() => setSelected(null)}
                />
            )}
        </div>
    );
}
