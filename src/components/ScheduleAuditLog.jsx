import { useState, useEffect } from 'react';
import { collection, query, orderBy, limit, startAfter, getDocs } from 'firebase/firestore';
import { db } from '../firebase';

// Schedule Audit Log — Andrew 2026-06-25: "every shift move, every time-off
// request, everything in the schedule page so we can see what's happening."
//
// Reads the append-only /audit collection (written by recordRichAudit via the
// auditShiftChange / auditPtoChange / auditAvailabilityChange wrappers + the
// schedule_config writes). We pull recent rows by createdAt (single-field
// index, no composite index to deploy) and filter to the schedule features
// client-side, with load-more paging for deeper history.
const SCHED_FEATURES = new Set(['shift', 'pto', 'availability', 'schedule', 'schedule_config']);
const PAGE = 300;

// Map an action → a readable icon + label. action is `${feature}.${verb}`.
function describeAction(action, isEn) {
    const map = {
        'shift.created':         ['➕', isEn ? 'Shift created' : 'Turno creado'],
        'shift.edited':          ['✏️', isEn ? 'Shift time edited' : 'Hora editada'],
        'shift.moved':           ['📍', isEn ? 'Shift moved' : 'Turno movido'],
        'shift.deleted':         ['🗑', isEn ? 'Shift deleted' : 'Turno eliminado'],
        'shift.offered':         ['📣', isEn ? 'Up for grabs' : 'Disponible'],
        'shift.offer_cancelled': ['↩️', isEn ? 'Offer cancelled' : 'Oferta cancelada'],
        'shift.cover_requested': ['🆘', isEn ? 'Cover requested' : 'Cobertura pedida'],
        'shift.claimed':         ['🙋', isEn ? 'Shift claimed' : 'Turno reclamado'],
        'shift.approved':        ['✅', isEn ? 'Claim approved' : 'Reclamo aprobado'],
        'shift.claim_denied':    ['❌', isEn ? 'Claim denied' : 'Reclamo negado'],
        'shift.swap_requested':  ['🔄', isEn ? 'Swap requested' : 'Cambio pedido'],
        'shift.swap_approved':   ['✅', isEn ? 'Swap approved' : 'Cambio aprobado'],
        'shift.swap_denied':     ['❌', isEn ? 'Swap denied' : 'Cambio negado'],
        'shift.published':       ['📢', isEn ? 'Schedule published' : 'Horario publicado'],
        'shift.bulk_created':    ['📋', isEn ? 'Shifts added (bulk)' : 'Turnos agregados'],
        'shift.bulk_deleted':    ['🗑', isEn ? 'Shifts deleted (bulk)' : 'Turnos eliminados'],
        'pto.created':           ['🌴', isEn ? 'Time-off requested' : 'Tiempo libre pedido'],
        'pto.approved':          ['✅', isEn ? 'Time-off approved' : 'Tiempo libre aprobado'],
        'pto.denied':            ['❌', isEn ? 'Time-off denied' : 'Tiempo libre negado'],
        'pto.reopened':          ['↩️', isEn ? 'Time-off reopened' : 'Tiempo libre reabierto'],
        'pto.deleted':           ['🗑', isEn ? 'Time-off removed' : 'Tiempo libre eliminado'],
        'pto.edited':            ['✏️', isEn ? 'Time-off edited' : 'Tiempo libre editado'],
        'availability.edited':   ['📅', isEn ? 'Availability changed' : 'Disponibilidad cambiada'],
        'shift.bulk_offered':    ['📣', isEn ? 'Shifts offered (bulk)' : 'Turnos ofrecidos (lote)'],
        'schedule_config.need_created':   ['➕', isEn ? 'Open slot added' : 'Espacio agregado'],
        'schedule_config.need_removed':   ['🗑', isEn ? 'Open slot removed' : 'Espacio eliminado'],
        'schedule_config.need_edited':    ['✏️', isEn ? 'Open slot edited' : 'Espacio editado'],
        'schedule_config.blackout_added': ['🚫', isEn ? 'Blackout day added' : 'Día de cierre agregado'],
        'schedule_config.blackout_added_bulk': ['🚫', isEn ? 'Blackout days added' : 'Días de cierre agregados'],
        'schedule_config.blackout_removed':    ['↩️', isEn ? 'Blackout removed' : 'Cierre quitado'],
        'schedule_config.date_toggled':        ['🔁', isEn ? 'Day opened/closed' : 'Día abierto/cerrado'],
        'schedule_config.weekly_closure_toggled': ['📆', isEn ? 'Weekly closure changed' : 'Cierre semanal cambiado'],
        'schedule_config.template_created':  ['📋', isEn ? 'Template saved' : 'Plantilla guardada'],
        'schedule_config.template_edited':   ['📋', isEn ? 'Template edited' : 'Plantilla editada'],
        'schedule_config.template_deleted':  ['🗑', isEn ? 'Template deleted' : 'Plantilla eliminada'],
        'schedule_config.template_applied':  ['📋', isEn ? 'Template applied' : 'Plantilla aplicada'],
        'schedule_config.recurring_created': ['🔁', isEn ? 'Recurring rule added' : 'Regla recurrente agregada'],
        'schedule_config.recurring_edited':  ['🔁', isEn ? 'Recurring rule edited' : 'Regla recurrente editada'],
        'schedule_config.recurring_deleted': ['🗑', isEn ? 'Recurring rule deleted' : 'Regla recurrente eliminada'],
        'schedule_config.recurring_generated': ['🔁', isEn ? 'Recurring shifts generated' : 'Turnos recurrentes generados'],
        'schedule_config.presets_saved':     ['⚙️', isEn ? 'Shift hours saved' : 'Horas guardadas'],
        'schedule_config.copied_week':       ['📋', isEn ? 'Copied last week' : 'Semana copiada'],
        'schedule_config.auto_filled':       ['🪄', isEn ? 'Auto-filled week' : 'Semana auto-rellenada'],
    };
    if (map[action]) return map[action];
    const verb = (action || '').split('.').slice(1).join('.') || action || '?';
    return ['•', verb];
}

function timeAgo(ts, isEn) {
    const ms = ts?.toMillis?.() ?? (typeof ts === 'number' ? ts : 0);
    if (!ms) return '';
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 60) return isEn ? 'just now' : 'ahora';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d`;
    try {
        return new Date(ms).toLocaleDateString(isEn ? 'en-US' : 'es-US', { month: 'short', day: 'numeric' });
    } catch { return `${day}d`; }
}

// Render a compact before→after diff from the two scalar maps.
function Diff({ before, after, isEn }) {
    const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]));
    const interesting = keys.filter(k => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
    if (!interesting.length) return null;
    const fmt = (v) => v == null || v === '' ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return (
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {interesting.slice(0, 6).map(k => (
                <span key={k} className="text-[10px] text-dd-text-2">
                    <span className="font-semibold">{k}:</span>{' '}
                    <span className="line-through opacity-60">{fmt(before?.[k])}</span>
                    {' → '}
                    <span className="text-dd-text font-semibold">{fmt(after?.[k])}</span>
                </span>
            ))}
        </div>
    );
}

export default function ScheduleAuditLog({ language }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [filter, setFilter] = useState('all'); // all | shift | pto | availability | config
    const [search, setSearch] = useState('');
    const [cursor, setCursor] = useState(null);
    const [done, setDone] = useState(false);

    const load = async (more = false) => {
        setLoading(true);
        try {
            const base = [collection(db, 'audit'), orderBy('createdAt', 'desc')];
            const q = (more && cursor)
                ? query(...base, startAfter(cursor), limit(PAGE))
                : query(...base, limit(PAGE));
            const snap = await getDocs(q);
            const fetched = [];
            snap.forEach(d => fetched.push({ id: d.id, ...d.data() }));
            setCursor(snap.docs[snap.docs.length - 1] || cursor);
            if (snap.size < PAGE) setDone(true);
            const sched = fetched.filter(r =>
                SCHED_FEATURES.has(r.feature) || /^(shift|pto|availability|schedule)\./.test(r.action || ''));
            setRows(prev => more ? [...prev, ...sched] : sched);
        } catch (e) {
            console.warn('schedule audit load failed:', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (expanded && rows.length === 0 && !done) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expanded]);

    const featureOf = (r) => r.feature || (r.action || '').split('.')[0];
    const FILTERS = [
        { k: 'all', en: 'All', es: 'Todo' },
        { k: 'shift', en: '🗓 Shifts', es: '🗓 Turnos' },
        { k: 'pto', en: '🌴 Time-off', es: '🌴 Libre' },
        { k: 'availability', en: '📅 Availability', es: '📅 Disponib.' },
        { k: 'config', en: '⚙️ Setup', es: '⚙️ Config' },
    ];
    const filtered = rows.filter(r => {
        const f = featureOf(r);
        if (filter === 'config') { if (!(f === 'schedule' || f === 'schedule_config')) return false; }
        else if (filter !== 'all' && f !== filter) return false;
        if (search.trim()) {
            const hay = `${r.actorName || ''} ${r.targetName || ''} ${r.action || ''} ${JSON.stringify(r.before || '')} ${JSON.stringify(r.after || '')}`.toLowerCase();
            if (!hay.includes(search.trim().toLowerCase())) return false;
        }
        return true;
    });

    return (
        <div className="mb-3">
            <button onClick={() => setExpanded(v => !v)} aria-expanded={expanded}
                className="glass-section-head tint-indigo">
                <div className="flex items-center gap-3 min-w-0">
                    <span className="glass-icon-tile" aria-hidden="true">🗓</span>
                    <h3 className="font-bold text-[15px] text-dd-text">{tx('Schedule audit log', 'Registro del horario')}</h3>
                </div>
                <span className="section-chevron text-xl" aria-hidden="true">›</span>
            </button>
            {expanded && (
                <div className="glass-card p-3 mt-2">
                    <p className="text-[11px] text-dd-text-2 mb-2 px-1">
                        {tx('Every shift add/move/delete, time-off request, and availability change — who, what, old→new, and when.',
                            'Cada turno agregado/movido/eliminado, solicitud de tiempo libre y cambio de disponibilidad — quién, qué, antes→después y cuándo.')}
                    </p>
                    <div className="flex items-center gap-1 flex-wrap mb-2">
                        {FILTERS.map(f => (
                            <button key={f.k} onClick={() => setFilter(f.k)}
                                className={`px-2 py-1 rounded-full text-[10px] font-bold border ${filter === f.k
                                    ? 'bg-dd-green text-white border-dd-green-700'
                                    : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                                {tx(f.en, f.es)}
                            </button>
                        ))}
                        <button onClick={() => load(false)}
                            className="ml-auto text-[10px] text-dd-green-700 underline hover:no-underline">
                            {loading ? tx('Loading…', 'Cargando…') : tx('Refresh', 'Actualizar')}
                        </button>
                    </div>
                    <input value={search} onChange={(e) => setSearch(e.target.value)}
                        placeholder={tx('Search a name or action…', 'Buscar nombre o acción…')}
                        className="w-full mb-2 px-2.5 py-1.5 text-xs border border-dd-line rounded-lg focus:border-dd-green focus:ring-1 focus:ring-dd-green-50 outline-none" />
                    {loading && rows.length === 0 ? (
                        <p className="text-[11px] text-dd-text-2 italic px-2 py-3">{tx('Loading…', 'Cargando…')}</p>
                    ) : filtered.length === 0 ? (
                        <p className="text-[11px] text-dd-text-2 italic px-2 py-3">
                            {tx('No schedule activity yet for this filter.', 'Sin actividad del horario para este filtro.')}
                        </p>
                    ) : (
                        <div className="space-y-1 max-h-[28rem] overflow-y-auto overscroll-contain pr-1">
                            {filtered.map(r => {
                                const [icon, label] = describeAction(r.action, isEn);
                                const surface = r.surface === 'self-serve' ? (isEn ? 'staff' : 'personal') : (isEn ? 'manager' : 'gerente');
                                return (
                                    <div key={r.id} className="flex items-start gap-2 px-2 py-1.5 rounded-lg bg-white border border-dd-line">
                                        <span className="text-base leading-none mt-0.5 shrink-0">{icon}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-baseline gap-1.5 flex-wrap">
                                                <span className="text-xs font-bold text-dd-text">{label}</span>
                                                {r.targetName && <span className="text-[11px] text-dd-text-2 truncate">· {r.targetName}</span>}
                                            </div>
                                            <div className="text-[10px] text-dd-text-2">
                                                {tx('by', 'por')} <span className="font-semibold">{r.actorName || 'system'}</span>
                                                {' · '}{timeAgo(r.createdAt, isEn)}
                                                {' · '}<span className="opacity-70">{surface}</span>
                                                {r.platform && r.platform !== 'web' ? ` · ${r.platform}` : ''}
                                                {r.reason ? ` · ${r.reason}` : ''}
                                            </div>
                                            <Diff before={r.before} after={r.after} isEn={isEn} />
                                        </div>
                                    </div>
                                );
                            })}
                            {!done && (
                                <button onClick={() => load(true)} disabled={loading}
                                    className="w-full py-2 mt-1 rounded-lg border border-dd-line text-xs font-bold text-dd-text-2 hover:bg-dd-bg disabled:opacity-50">
                                    {loading ? tx('Loading…', 'Cargando…') : tx('Load older', 'Cargar más')}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
