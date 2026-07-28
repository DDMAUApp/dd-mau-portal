// TimecardDisputesPanel — Admin page "Timecard fix requests" (2026-07-24).
//
// Shows every staff-filed "this timecard is wrong" request from
// /timecard_disputes (written by MyHoursPage's dispute modal): the recorded
// Toast times vs what the staffer says they should be, plus their note.
// Admin fixes the punch IN TOAST (we never write to Toast), then marks the
// request Fixed — or Dismisses it. Same collapsible glass-card pattern as
// StaffUsageAudit.
import { useEffect, useMemo, useState } from 'react';
import { Clock, ChevronDown, Check, X } from 'lucide-react';
import { subscribeTimecardDisputes, resolveTimecardDispute, issuesLabel } from '../data/timecards';

function fmtTime(iso, isEs) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleTimeString(isEs ? 'es' : 'en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
}
function fmtWhen(ts, isEs) {
    const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
    if (!d || isNaN(d)) return '';
    return d.toLocaleDateString(isEs ? 'es' : 'en-US', { month: 'short', day: 'numeric' });
}

export default function TimecardDisputesPanel({ language = 'en', staffName = '' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [expanded, setExpanded] = useState(false);
    const [rows, setRows] = useState(null);   // null = never loaded (collapsed since mount)
    const [showResolved, setShowResolved] = useState(false);
    const [busyId, setBusyId] = useState(null);

    // 2026-07-27 (audit B4) — this 200-doc listener used to attach on Admin
    // mount even while the card was collapsed (its default). Same gate
    // MoneyCount uses for its history listener: subscribe only while
    // expanded. Rows persist after a collapse so the count stays fresh-ish.
    useEffect(() => {
        if (!expanded) return undefined;
        return subscribeTimecardDisputes(setRows);
    }, [expanded]);

    const open = useMemo(() => (rows || []).filter((r) => r.status === 'open'), [rows]);
    const resolved = useMemo(() => (rows || []).filter((r) => r.status !== 'open'), [rows]);
    const visible = showResolved ? resolved : open;

    const act = async (row, status) => {
        if (busyId) return;
        setBusyId(row.id);
        try { await resolveTimecardDispute(row.id, status, staffName); }
        catch (e) { console.warn('resolveTimecardDispute failed:', e); }
        finally { setBusyId(null); }
    };

    return (
        <div className="glass-card p-4 mb-4">
            <button type="button" onClick={() => setExpanded((v) => !v)}
                className="w-full flex items-center justify-between gap-3 -m-1 p-1 rounded-glass-md hover:bg-white/40 transition-colors"
                aria-expanded={expanded}>
                <div className="flex items-center gap-3 min-w-0">
                    <span className="glass-icon-tile tint-amber shrink-0">
                        <Clock size={22} strokeWidth={2.25} aria-hidden="true" />
                    </span>
                    <div className="text-left min-w-0">
                        <h3 className="text-headline text-dd-text">{tx('Timecard fix requests', 'Correcciones de horario')}</h3>
                        <p className="text-caption-md text-dd-text-2">
                            {rows === null
                                ? tx('Tap to load', 'Toca para cargar')
                                : open.length > 0
                                ? tx(`${open.length} open request${open.length === 1 ? '' : 's'}`, `${open.length} pendiente${open.length === 1 ? '' : 's'}`)
                                : tx('No open requests', 'Sin pendientes')}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {open.length > 0 && (
                        <span className="min-w-[1.4rem] h-6 px-1.5 rounded-full bg-amber-500 text-white text-xs font-bold inline-flex items-center justify-center">
                            {open.length}
                        </span>
                    )}
                    <ChevronDown size={18} strokeWidth={2.25} aria-hidden="true"
                        className={`text-dd-text-2 transition-transform duration-glass-fast ease-glass-out ${expanded ? 'rotate-180' : ''}`} />
                </div>
            </button>

            {expanded && (
                <>
                    <div className="flex gap-1 mt-3 bg-dd-bg/60 border border-dd-line rounded-glass-sm p-1 w-fit">
                        <button type="button" onClick={() => setShowResolved(false)}
                            className={`px-3 py-1 rounded-sm text-xs font-bold transition ${!showResolved ? 'bg-amber-500 text-white' : 'text-dd-text-2'}`}>
                            {tx('Open', 'Pendientes')} ({open.length})
                        </button>
                        <button type="button" onClick={() => setShowResolved(true)}
                            className={`px-3 py-1 rounded-sm text-xs font-bold transition ${showResolved ? 'bg-dd-green text-white' : 'text-dd-text-2'}`}>
                            {tx('Handled', 'Resueltos')} ({resolved.length})
                        </button>
                    </div>

                    <div className="space-y-2 mt-3">
                        {visible.length === 0 ? (
                            <p className="text-footnote-md text-dd-text-2 text-center py-5">
                                {showResolved ? tx('Nothing handled yet.', 'Nada resuelto aún.') : tx('No open requests — all clear.', 'Sin solicitudes — todo al día.')}
                            </p>
                        ) : visible.map((r) => (
                            <div key={r.id} className="p-3 rounded-glass-md bg-white/60 border border-glass-border-light">
                                <div className="flex items-start gap-2">
                                    <div className="flex-1 min-w-0">
                                        <div className="text-body-md font-bold text-dd-text">
                                            {r.staffName}
                                            <span className="text-caption-md text-dd-text-2 font-normal"> · {r.date} · {r.location === 'maryland' ? 'MH' : 'WG'}</span>
                                        </div>
                                        <div className="text-caption-md text-amber-700 font-semibold mt-0.5">
                                            {issuesLabel(r.issues, isEs ? 'es' : 'en')}
                                        </div>
                                        <div className="text-caption-md text-dd-text-2 mt-1">
                                            <b>{tx('Recorded', 'Registrado')}:</b>{' '}
                                            {(r.recorded?.sessions || []).map((s, i) => (
                                                <span key={i}>{fmtTime(s.clockIn, isEs)} → {fmtTime(s.clockOut, isEs)}{'  '}</span>
                                            ))}
                                            {r.recorded?.openClockIn && <span>{fmtTime(r.recorded.openClockIn, isEs)} → …</span>}
                                            {!(r.recorded?.sessions || []).length && !r.recorded?.openClockIn && '—'}
                                            {r.recorded?.hoursToday != null && <span> · {Number(r.recorded.hoursToday).toFixed(1)}h</span>}
                                        </div>
                                        {(r.expectedClockIn || r.expectedClockOut) && (
                                            <div className="text-caption-md text-dd-green-700 mt-0.5">
                                                <b>{tx('They say it should be', 'Dicen que debería ser')}:</b>{' '}
                                                {r.expectedClockIn && <span>{tx('in', 'entrada')} {r.expectedClockIn} </span>}
                                                {r.expectedClockOut && <span>{tx('out', 'salida')} {r.expectedClockOut}</span>}
                                            </div>
                                        )}
                                        {r.note && <div className="text-caption-md text-dd-text mt-1 italic">“{r.note}”</div>}
                                        <div className="text-[10px] text-dd-text-2/70 mt-1">
                                            {tx('sent', 'enviado')} {fmtWhen(r.createdAt, isEs)}
                                            {r.status !== 'open' && r.resolvedBy && <span> · {r.status === 'fixed' ? tx('fixed by', 'corregido por') : tx('dismissed by', 'descartado por')} {r.resolvedBy}</span>}
                                        </div>
                                    </div>
                                    {r.status === 'open' && (
                                        <div className="flex flex-col gap-1 shrink-0">
                                            <button type="button" onClick={() => act(r, 'fixed')} disabled={busyId === r.id}
                                                title={tx('I corrected this punch in Toast', 'Corregí este registro en Toast')}
                                                className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-glass-sm bg-dd-green text-white hover:bg-dd-green-700 active:scale-95 transition disabled:opacity-50">
                                                <Check size={12} strokeWidth={3} aria-hidden="true" /> {tx('Fixed in Toast', 'Corregido')}
                                            </button>
                                            <button type="button" onClick={() => act(r, 'dismissed')} disabled={busyId === r.id}
                                                className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-glass-sm bg-dd-bg text-dd-text-2 border border-dd-line hover:bg-red-50 hover:text-red-700 active:scale-95 transition disabled:opacity-50">
                                                <X size={12} strokeWidth={3} aria-hidden="true" /> {tx('Dismiss', 'Descartar')}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                    <p className="text-caption-md text-dd-text-2/70 mt-3 italic">
                        {tx('Fix the punch in Toast first (Toast web → Labor → Time Entries), then mark it Fixed here. The app never writes to Toast.',
                            'Corrige el registro en Toast primero (Toast web → Labor → Time Entries) y luego márcalo Corregido aquí. La app nunca escribe en Toast.')}
                    </p>
                </>
            )}
        </div>
    );
}
