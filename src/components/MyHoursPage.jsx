// MyHoursPage — every staffer's own Toast timecards (Andrew 2026-07-24).
//
// "a staff wants to see how many hours they have worked this week so far —
// a time clock in and out for each day, total hours, total overtime … click
// on the timecard [to] tell the admin this date's timecard is wrong."
//
// Data: /timecards docs (see src/data/timecards.js + functions/attendance.js).
// One card per worked day: every clock in/out, breaks, day total. Header
// shows this-week total + overtime (>40h) and the running month total.
// Tapping a day opens the dispute modal → writes /timecard_disputes, which
// the admins review on the Admin page ("Timecard fix requests").
//
// History accrues from the day the recorder shipped (the Toast feed keeps no
// past days) — the empty state says so, so early sparse weeks aren't read as
// "my hours are missing."
import { useEffect, useMemo, useState } from 'react';
import { Clock, AlertTriangle, ChevronRight, Coffee } from 'lucide-react';
import ModalPortal from './ModalPortal';
import { toast } from '../toast';
import {
    subscribeMyTimecards, cardHours, submitTimecardDispute,
} from '../data/timecards';

const DAY_MS = 86400000;

function fmtTime(iso, isEs) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleTimeString(isEs ? 'es' : 'en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    });
}
function fmtDay(dateStr, isEs) {
    const d = new Date(`${dateStr}T12:00:00`);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString(isEs ? 'es' : 'en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
    });
}
const h1 = (n) => (Math.round((Number(n) || 0) * 10) / 10).toFixed(1);

// Sunday-start week key for a 'YYYY-MM-DD' (matches the scraper's weekStart).
function weekKey(dateStr) {
    const d = new Date(`${dateStr}T12:00:00`);
    if (isNaN(d)) return dateStr;
    const sun = new Date(d.getTime() - d.getDay() * DAY_MS);
    return sun.toISOString().slice(0, 10);
}
function toDateStrLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function MyHoursPage({ staffName, language }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [cards, setCards] = useState(null);      // null = loading
    const [disputing, setDisputing] = useState(null); // day row being disputed

    // Window: whole current month PLUS the last 5 weeks (whichever reaches
    // further back) so both "this month" and a full OT week are covered.
    const sinceStr = useMemo(() => {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const fiveWeeks = new Date(now.getTime() - 35 * DAY_MS);
        return toDateStrLocal(monthStart < fiveWeeks ? monthStart : fiveWeeks);
    }, []);

    useEffect(() => {
        if (!staffName) return undefined;
        // Instant first paint (2026-07-27, Andrew: "my hours loads slow") —
        // same localStorage pattern as recipes/sticker lists: show the
        // last-seen cards immediately, let the live snapshot correct them.
        // Keyed per staff so a shared-iPad user switch never shows someone
        // else's hours. 2026-07-27 (audit): key also includes sinceStr so a
        // range change doesn't flash out-of-range cached rows.
        const CACHE_KEY = `ddmau:myhours:${staffName}:${sinceStr}`;
        try {
            const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            if (Array.isArray(cached) && cached.length > 0) setCards(cached);
        } catch { /* corrupt/absent cache — spinner until snapshot */ }
        return subscribeMyTimecards(staffName, sinceStr, (list) => {
            // 2026-07-27 (audit) — the error path reports null (NOT []).
            // Ignore it so a network blip keeps the cached cards on screen
            // instead of swapping them for "No timecards yet".
            if (!Array.isArray(list)) return;
            setCards(list);
            if (list.length > 0) {
                try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch { /* quota */ }
            }
        });
    }, [staffName, sinceStr]);

    // A person can have a card at each store the same day (cross-location
    // cover) — merge per DATE for display, keeping both cards for detail.
    const days = useMemo(() => {
        const byDate = new Map();
        for (const c of (cards || [])) {
            const row = byDate.get(c.date) || { date: c.date, cards: [] };
            row.cards.push(c);
            byDate.set(c.date, row);
        }
        const out = Array.from(byDate.values());
        for (const r of out) {
            r.hours = r.cards.reduce((s, c) => s + cardHours(c), 0);
            r.open = r.cards.some((c) => !!c.openClockIn);
        }
        out.sort((a, b) => b.date.localeCompare(a.date));
        return out;
    }, [cards]);

    // Does this person's loaded history span BOTH stores? (e.g. Yency works
    // Webster + MH.) When true, EVERY row gets its store tag — before
    // 2026-08-26 the tag only appeared when one DAY had cards at both
    // stores, so a Maryland-only day rendered identical to a Webster day
    // and staff couldn't tell both stores were being counted (they are:
    // the timecards query is location-blind, keyed on the shared name).
    const multiLoc = useMemo(() => {
        const locs = new Set();
        for (const c of (cards || [])) locs.add(c.location || '');
        return locs.size > 1;
    }, [cards]);

    const totals = useMemo(() => {
        const now = new Date();
        const thisWeek = weekKey(toDateStrLocal(now));
        const thisMonth = toDateStrLocal(now).slice(0, 7);
        let week = 0, month = 0;
        for (const r of days) {
            if (weekKey(r.date) === thisWeek) week += r.hours;
            if (r.date.slice(0, 7) === thisMonth) month += r.hours;
        }
        // Prefer Toast's own running week total when the feed has one for
        // today (it's break-adjusted upstream and matches the POS screen).
        // 2026-07-27 (audit) — hoursThisWeek is ONE store's running total,
        // so for cross-location staff it UNDERSTATES the summed week (and
        // hid real overtime). Only let it override when every card in the
        // current week is from a single location.
        const weekLocs = new Set();
        for (const r of days) {
            if (weekKey(r.date) !== thisWeek) continue;
            for (const c of r.cards) weekLocs.add(c.location || '');
        }
        const todayCard = days.find((r) => r.date === toDateStrLocal(now));
        const toastWeek = todayCard?.cards.map((c) => c.hoursThisWeek).find((v) => v != null);
        if (toastWeek != null && Number(toastWeek) > 0 && weekLocs.size <= 1) week = Number(toastWeek);
        return { week, month, overtime: Math.max(0, week - 40) };
    }, [days]);

    if (!staffName) return null;

    return (
        <div className="max-w-2xl mx-auto px-3 pb-24">
            {/* Header totals */}
            <div className="glass-card p-4 mb-3 mt-2">
                <div className="flex items-center gap-3 mb-3">
                    <span className="glass-icon-tile tint-teal shrink-0">
                        <Clock size={22} strokeWidth={2.25} aria-hidden="true" />
                    </span>
                    <div>
                        <h2 className="text-headline text-dd-text">{tx('My Hours', 'Mis Horas')}</h2>
                        <p className="text-caption-md text-dd-text-2">
                            {staffName}
                            {multiLoc && (
                                <span className="ml-2 px-1.5 py-0.5 rounded-full bg-dd-sage-50 border border-dd-green/20 text-[10px] font-bold text-dd-green-700 align-middle">
                                    {tx('Webster + MH included', 'Webster + MH incluidos')}
                                </span>
                            )}
                        </p>
                    </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-glass-md border border-dd-green/20 bg-dd-sage-50 p-2.5">
                        <div className="text-overline text-dd-green-700">{tx('This week', 'Esta semana')}</div>
                        <div className="text-title-3 tabular-nums text-dd-green-700 mt-1">{h1(totals.week)}h</div>
                    </div>
                    <div className={`rounded-glass-md border p-2.5 ${totals.overtime > 0 ? 'bg-amber-50 border-amber-200' : 'bg-dd-bg/60 border-dd-line'}`}>
                        <div className={`text-overline ${totals.overtime > 0 ? 'text-amber-700' : 'text-dd-text-2'}`}>{tx('Overtime', 'Horas extra')}</div>
                        <div className={`text-title-3 tabular-nums mt-1 ${totals.overtime > 0 ? 'text-amber-700' : 'text-dd-text-2'}`}>{h1(totals.overtime)}h</div>
                    </div>
                    <div className="rounded-glass-md border border-dd-line bg-dd-bg/60 p-2.5">
                        <div className="text-overline text-dd-text-2">{tx('This month', 'Este mes')}</div>
                        <div className="text-title-3 tabular-nums text-dd-text mt-1">{h1(totals.month)}h</div>
                    </div>
                </div>
                <p className="text-caption-md text-dd-text-2/80 mt-2">
                    {tx('Times come straight from Toast. Something wrong? Tap that day and tell us.',
                        'Los horarios vienen directo de Toast. ¿Algo mal? Toca ese día y avísanos.')}
                </p>
            </div>

            {/* Day cards */}
            {cards === null ? (
                <p className="text-footnote-md text-dd-text-2 text-center py-8">{tx('Loading…', 'Cargando…')}</p>
            ) : days.length === 0 ? (
                <div className="glass-card p-5 text-center">
                    <p className="text-body-md text-dd-text-2">
                        {tx('No timecards yet. Your days appear here automatically starting from your next clock-in — history builds from today forward.',
                            'Aún no hay tarjetas de horario. Tus días aparecerán aquí automáticamente desde tu próxima entrada — el historial se construye de hoy en adelante.')}
                    </p>
                </div>
            ) : (
                <div className="space-y-2">
                    {days.map((r) => (
                        <button key={r.date} type="button"
                            onClick={() => setDisputing(r)}
                            className="w-full text-left glass-card p-3 hover:bg-white/70 active:scale-[0.99] transition">
                            <div className="flex items-center gap-2">
                                <div className="flex-1 min-w-0">
                                    <div className="text-body-md font-bold text-dd-text flex items-center gap-2">
                                        {fmtDay(r.date, isEs)}
                                        {r.open && (
                                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-dd-sage-50 text-dd-green-700 border border-dd-green/30">
                                                {tx('On the clock', 'En turno')}
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-1 space-y-0.5">
                                        {r.cards.map((c) => (
                                            <div key={c.id} className="text-caption-md text-dd-text-2">
                                                {(multiLoc || r.cards.length > 1) && <span className="font-bold">{c.location === 'maryland' ? 'MH' : 'WG'} · </span>}
                                                {(c.sessions || []).map((s, i) => (
                                                    <span key={i}>{fmtTime(s.clockIn, isEs)} → {fmtTime(s.clockOut, isEs)}{'  '}</span>
                                                ))}
                                                {c.openClockIn && <span>{fmtTime(c.openClockIn, isEs)} → {tx('now', 'ahora')}</span>}
                                                {(c.breaks || []).length > 0 && (
                                                    <span className="ml-1 inline-flex items-center gap-0.5 text-dd-text-2/70">
                                                        <Coffee size={10} aria-hidden="true" />
                                                        {(c.breaks || []).length}× {tx('break', 'descanso')}
                                                    </span>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div className="shrink-0 text-right">
                                    <div className="text-title-3 tabular-nums text-dd-text">{h1(r.hours)}h</div>
                                    <div className="text-[10px] text-dd-text-2 flex items-center justify-end gap-0.5">
                                        {tx('report issue', 'reportar')} <ChevronRight size={11} aria-hidden="true" />
                                    </div>
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            )}

            {disputing && (
                <DisputeModal
                    day={disputing}
                    staffName={staffName}
                    isEs={isEs}
                    multiLoc={multiLoc}
                    onClose={() => setDisputing(null)}
                />
            )}
        </div>
    );
}

// ── Dispute modal — "this date's timecard is wrong" ─────────────────────────
function DisputeModal({ day, staffName, isEs, onClose, multiLoc = false }) {
    const tx = (en, es) => (isEs ? es : en);
    const [issues, setIssues] = useState([]);
    const [expectedClockIn, setExpectedClockIn] = useState('');
    const [expectedClockOut, setExpectedClockOut] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const toggle = (k) => setIssues((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));

    const ISSUE_OPTS = [
        { k: 'clock_in', en: 'Clock-in time is wrong', es: 'La hora de entrada está mal' },
        { k: 'clock_out', en: 'Clock-out time is wrong', es: 'La hora de salida está mal' },
        { k: 'break', en: 'Break is wrong / missing', es: 'Descanso mal registrado o falta' },
        { k: 'missing', en: 'Hours are missing', es: 'Faltan horas' },
    ];

    const submit = async () => {
        if (busy) return;
        if (issues.length === 0) { toast(tx('Pick what\'s wrong first.', 'Primero elige qué está mal.'), { kind: 'error' }); return; }
        if (!note.trim() && !expectedClockIn && !expectedClockOut) {
            toast(tx('Tell us what the time should be.', 'Dinos cuál debería ser la hora.'), { kind: 'error' });
            return;
        }
        setBusy(true);
        try {
            // A person can have a card per store the same day — file one
            // request per card so the admin sees the right location.
            for (const card of day.cards) {
                // eslint-disable-next-line no-await-in-loop
                await submitTimecardDispute({
                    staffName, card, issues, expectedClockIn, expectedClockOut, note,
                });
            }
            toast(tx('✅ Sent — a manager will review this timecard.', '✅ Enviado — un gerente revisará este horario.'), { kind: 'success' });
            onClose();
        } catch (e) {
            console.warn('submitTimecardDispute failed:', e);
            toast(tx('Could not send: ', 'No se pudo enviar: ') + (e?.message || e), { kind: 'error' });
        } finally { setBusy(false); }
    };

    return (
        <ModalPortal>
            <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
                <div className="glass-sheet bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                    <div className="border-b border-dd-line p-4 flex items-center justify-between">
                        <div>
                            <h3 className="text-lg font-bold text-dd-text flex items-center gap-2">
                                <AlertTriangle size={18} className="text-amber-600" aria-hidden="true" />
                                {tx('Report a timecard problem', 'Reportar problema de horario')}
                            </h3>
                            <p className="text-xs text-dd-text-2">{fmtDay(day.date, isEs)} · {staffName}</p>
                        </div>
                        <button onClick={onClose} aria-label={tx('Close', 'Cerrar')}
                            className="w-8 h-8 rounded-full bg-dd-bg text-dd-text-2 text-lg">×</button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        {/* What's recorded */}
                        <div className="rounded-xl bg-dd-bg/70 border border-dd-line p-3 text-xs text-dd-text-2 space-y-0.5">
                            <div className="font-bold text-dd-text mb-1">{tx('Recorded in Toast:', 'Registrado en Toast:')}</div>
                            {day.cards.map((c) => (
                                <div key={c.id}>
                                    {(multiLoc || day.cards.length > 1) && <b>{c.location === 'maryland' ? 'MH' : 'WG'} · </b>}
                                    {(c.sessions || []).map((s, i) => (
                                        <span key={i}>{fmtTime(s.clockIn, isEs)} → {fmtTime(s.clockOut, isEs)}{'  '}</span>
                                    ))}
                                    {c.openClockIn && <span>{fmtTime(c.openClockIn, isEs)} → {tx('now', 'ahora')}</span>}
                                </div>
                            ))}
                        </div>
                        {/* What's wrong */}
                        <div>
                            <div className="text-[11px] font-bold uppercase text-dd-text-2 mb-1.5">{tx("What's wrong?", '¿Qué está mal?')}</div>
                            <div className="space-y-1.5">
                                {ISSUE_OPTS.map((o) => (
                                    <label key={o.k} className="flex items-center gap-2 text-sm text-dd-text">
                                        <input type="checkbox" checked={issues.includes(o.k)} onChange={() => toggle(o.k)} />
                                        {tx(o.en, o.es)}
                                    </label>
                                ))}
                            </div>
                        </div>
                        {/* What it should be */}
                        <div>
                            <div className="text-[11px] font-bold uppercase text-dd-text-2 mb-1.5">{tx('What should it be?', '¿Cuál debería ser?')}</div>
                            <div className="flex gap-3">
                                <label className="block flex-1">
                                    <span className="block text-[11px] text-dd-text-2 mb-0.5">{tx('Clock in', 'Entrada')}</span>
                                    <input type="time" value={expectedClockIn} onChange={(e) => setExpectedClockIn(e.target.value)}
                                        className="w-full px-2 py-2 text-base border border-dd-line rounded-lg" />
                                </label>
                                <label className="block flex-1">
                                    <span className="block text-[11px] text-dd-text-2 mb-0.5">{tx('Clock out', 'Salida')}</span>
                                    <input type="time" value={expectedClockOut} onChange={(e) => setExpectedClockOut(e.target.value)}
                                        className="w-full px-2 py-2 text-base border border-dd-line rounded-lg" />
                                </label>
                            </div>
                        </div>
                        <label className="block">
                            <span className="block text-[11px] font-bold uppercase text-dd-text-2 mb-0.5">{tx('Details', 'Detalles')}</span>
                            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                                placeholder={tx('e.g. I clocked in at 10 but it shows 10:45 — the iPad was frozen', 'ej. Entré a las 10 pero marca 10:45 — el iPad estaba congelado')}
                                className="w-full px-3 py-2 text-base border border-dd-line rounded-lg" />
                        </label>
                    </div>
                    <div className="border-t border-dd-line p-4 flex gap-2">
                        <button onClick={onClose} className="flex-1 py-2.5 rounded-lg bg-dd-bg text-dd-text-2 font-bold">{tx('Cancel', 'Cancelar')}</button>
                        <button onClick={submit} disabled={busy}
                            className="flex-1 py-2.5 rounded-lg bg-dd-green text-white font-bold disabled:opacity-50">
                            {busy ? tx('Sending…', 'Enviando…') : tx('Send to managers', 'Enviar a gerentes')}
                        </button>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}
