// AdminHealthPage — one-glance system status for admins.
//
// Andrew 2026-05-23 (audit follow-up): the recurring "is this broken
// or is it me?" question — TVs offline, printers unreachable, backups
// stalled, FCM tokens stale — required hunting through 4 different
// pages. This page surfaces all of it at once.
//
// What we show, and where the data comes from:
//   • Firestore liveness — subscribe to /config/forceRefresh and time
//     the first snapshot. <2s = live, slower = degraded, no snapshot
//     in 10s = offline. Cheap because /config/forceRefresh is also
//     the listener the rest of the app uses for system refresh; this
//     piggybacks on it.
//   • TV displays — count /tv_heartbeats entries by status (live /
//     stale / offline) using the same thresholds as MenuScreensPage.
//   • Last Firestore backup — read /backup_history, sort desc, show
//     the most recent run. Includes "Xh ago" stamp + a red badge if
//     the run is older than 36h (we expect daily).
//   • Recent audit log entries — last 20 docs from /audit so admins
//     can see what's been happening without leaving the page.
//   • App version — uses the __APP_VERSION__ define from vite.config
//     so admins can confirm every staff member is on the same build.
//
// Read-only. No writes from this page — it's a status dashboard,
// not a control panel. If admins want to act (e.g. force-refresh
// every device), they go back to AdminPanel where that button
// already lives with its full warning + confirmation.

import { useEffect, useMemo, useState } from 'react';
import { db } from '../firebase';
import {
    collection, doc, query, where, orderBy, limit, onSnapshot,
} from 'firebase/firestore';
import { subscribePrinterConfig, PRINTER_SLOTS } from '../data/labelPrinting';

// Heartbeat thresholds — keep in sync with MenuScreensPage and the
// checkTvHeartbeats Cloud Function so the dashboard agrees with
// admin alerts and with the customer-facing menu's notion of "is
// this screen alive right now?".
const TV_LIVE_MIN    = 2;
const TV_OFFLINE_MIN = 10;

// How long /config/forceRefresh can be silent before we flag Firestore
// as degraded. The doc never changes on its own; we're just timing
// the first snapshot arrival as a proxy for "can we even reach
// Firestore from this device?".
const FIRESTORE_DEGRADED_AFTER_MS = 5_000;

function minutesSince(ts) {
    if (!ts) return null;
    const ms = ts.toMillis ? ts.toMillis()
        : ts.seconds  ? ts.seconds * 1000
        : 0;
    if (!ms) return null;
    return Math.round((Date.now() - ms) / 60000);
}

function fmtRelative(ts, isEs) {
    const m = minutesSince(ts);
    if (m === null) return isEs ? 'sin datos' : 'no data';
    if (m < 1)        return isEs ? 'ahora'    : 'just now';
    if (m < 60)       return `${m} min`;
    if (m < 60 * 24)  return `${Math.floor(m / 60)}h`;
    return `${Math.floor(m / 60 / 24)}d`;
}

export default function AdminHealthPage({ language = 'en', staffName }) {
    const isEs = language === 'es';
    const tx  = (en, es) => (isEs ? es : en);

    // ── Firestore liveness ───────────────────────────────────────
    // Timestamp when the first /config/forceRefresh snapshot fires.
    // `null` while we're waiting on it. The render below converts
    // null → "checking" pill, fast snapshot → green, slow → amber.
    const [fsConnectedAt, setFsConnectedAt] = useState(null);
    const [fsTickAt,      setFsTickAt]      = useState(null);
    const [mountedAt]                       = useState(() => Date.now());
    useEffect(() => {
        const ref = doc(db, 'config', 'forceRefresh');
        const unsub = onSnapshot(ref, () => {
            const now = Date.now();
            setFsConnectedAt(prev => prev || now);
            setFsTickAt(now);
        }, (err) => {
            console.warn('AdminHealth: forceRefresh snapshot error:', err);
        });
        return unsub;
    }, []);

    // Re-render every 5s so the "checking..." pill flips to "degraded"
    // when the snapshot doesn't arrive in time. Cheap (single state
    // tick) and keeps the rest of the page's relative-time labels
    // fresh too.
    const [, setNowTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setNowTick(n => n + 1), 5_000);
        return () => clearInterval(id);
    }, []);

    const fsStatus = (() => {
        if (fsConnectedAt) {
            const lag = fsConnectedAt - mountedAt;
            return {
                tone:  lag < 1500 ? 'good' : 'warn',
                label: lag < 1500 ? tx('Live', 'En vivo') : tx('Slow', 'Lenta'),
                detail: lag < 1500
                    ? tx(`connected in ${lag}ms`, `conexión en ${lag}ms`)
                    : tx(`first snapshot took ${(lag / 1000).toFixed(1)}s`, `${(lag / 1000).toFixed(1)}s para conectar`),
            };
        }
        const waited = Date.now() - mountedAt;
        if (waited < FIRESTORE_DEGRADED_AFTER_MS) {
            return { tone: 'neutral', label: tx('Checking…', 'Verificando…'), detail: tx(`${(waited / 1000).toFixed(1)}s elapsed`, `${(waited / 1000).toFixed(1)}s transcurrido`) };
        }
        return { tone: 'danger', label: tx('No response', 'Sin respuesta'), detail: tx('Firestore did not reply in 5s', 'Firestore no respondió en 5s') };
    })();

    // ── TV displays ──────────────────────────────────────────────
    const [heartbeats, setHeartbeats] = useState({});
    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'tv_heartbeats'), (snap) => {
            const byTvId = {};
            snap.forEach(d => { byTvId[d.id] = { tvId: d.id, ...d.data() }; });
            setHeartbeats(byTvId);
        }, (err) => console.warn('AdminHealth: tv_heartbeats error:', err));
        return unsub;
    }, []);
    const tvStats = useMemo(() => {
        const list = Object.values(heartbeats);
        let live = 0, stale = 0, offline = 0;
        for (const h of list) {
            const m = minutesSince(h.lastSeenAt);
            if (m === null)                  offline++;
            else if (m < TV_LIVE_MIN)        live++;
            else if (m < TV_OFFLINE_MIN)     stale++;
            else                              offline++;
        }
        return { total: list.length, live, stale, offline, list };
    }, [heartbeats]);

    // ── Last backup ──────────────────────────────────────────────
    // /backup_history is written by scheduledFirestoreBackup at 3am
    // Central. Query desc + limit(1) is enough; if the result is
    // older than ~36h we surface a red badge so admin notices the
    // function may have failed.
    const [latestBackup, setLatestBackup] = useState(null);
    useEffect(() => {
        // scheduledFirestoreBackup (functions/index.js) writes
        // backup_history docs with `triggeredAt` (server timestamp) +
        // `outputUriPrefix` — NOT `createdAt`/`path`. A query ordered by
        // a field the docs don't have returns ZERO rows, so ordering by
        // `createdAt` here made the card permanently show "No data" and
        // the stale-backup badge could never fire. Order/read by the
        // fields the CF actually writes.
        const q = query(collection(db, 'backup_history'), orderBy('triggeredAt', 'desc'), limit(1));
        const unsub = onSnapshot(q, (snap) => {
            setLatestBackup(snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() });
        }, (err) => console.warn('AdminHealth: backup_history error:', err));
        return unsub;
    }, []);
    const backupTone = (() => {
        const m = minutesSince(latestBackup?.triggeredAt);
        if (m === null)                      return 'neutral';
        if (m < 60 * 36)                     return 'good';
        if (m < 60 * 24 * 3)                 return 'warn';
        return                                      'danger';
    })();

    // ── Recent audit log ─────────────────────────────────────────
    // Last 20 entries from /audit. Surfaces the kind of "what's
    // happening right now" feed admins miss when nothing's visibly
    // broken but they want to know who's writing what.
    const [recentAudit, setRecentAudit] = useState([]);
    useEffect(() => {
        const q = query(collection(db, 'audit'), orderBy('createdAt', 'desc'), limit(20));
        const unsub = onSnapshot(q, (snap) => {
            const out = [];
            snap.forEach(d => out.push({ id: d.id, ...d.data() }));
            setRecentAudit(out);
        }, (err) => console.warn('AdminHealth: audit error:', err));
        return unsub;
    }, []);

    // ── Printer configs ──────────────────────────────────────────
    // We subscribe to /config/printers_{location}_{slot} for both
    // stores × both slots so the dashboard surfaces all 4 printers
    // (Webster kitchen, Webster office, Maryland kitchen, Maryland
    // office). For each we record whether the doc exists + whether
    // it's enabled. Network-reachability checks would need a live
    // probe to the printer's HTTP endpoint, which is blocked by
    // mixed-content rules in browsers (https app, http printer).
    // The Pi bridge handles the actual print job; here we're just
    // reporting "is the printer registered + enabled?".
    const [printers, setPrinters] = useState({});
    useEffect(() => {
        const unsubs = [];
        for (const loc of ['webster', 'maryland']) {
            for (const slot of PRINTER_SLOTS) {
                const key = `${loc}/${slot}`;
                const u = subscribePrinterConfig(loc, (cfg) => {
                    setPrinters(prev => ({ ...prev, [key]: cfg }));
                }, slot);
                unsubs.push(u);
            }
        }
        return () => unsubs.forEach(u => { try { u(); } catch {} });
    }, []);
    const printerStats = useMemo(() => {
        const entries = Object.entries(printers);
        let configured = 0, enabled = 0;
        for (const [, cfg] of entries) {
            if (!cfg) continue;
            configured++;
            if (cfg.enabled !== false) enabled++;
        }
        return { total: entries.length || 4, configured, enabled };
    }, [printers]);

    // ── Quick counts: staff, chats, shifts (current week) ────────
    const [chatCount, setChatCount] = useState(null);
    useEffect(() => {
        // We don't paginate — chats is bounded (~50 per restaurant).
        const unsub = onSnapshot(collection(db, 'chats'), (snap) => {
            setChatCount(snap.size);
        }, () => setChatCount(null));
        return unsub;
    }, []);

    // App version is set at build time via the __APP_VERSION__ define
    // in vite.config.js. Read once at module init (synchronous, no
    // network) so we can show admins the exact build they're on.
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';

    return (
        <section className="w-full max-w-6xl mx-auto px-3 md:px-6 py-4 md:py-6 space-y-5">
            {/* Header */}
            <header className="flex items-baseline justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                    <h1 className="text-2xl md:text-3xl font-black text-dd-text tracking-tight">
                        ❤️ {tx('System Health', 'Estado del sistema')}
                    </h1>
                    <p className="text-[12px] text-dd-text-2 mt-0.5">
                        {tx(
                            'Live status of Firestore, TVs, backups, and recent activity. Read-only.',
                            'Estado en vivo de Firestore, TVs, respaldos y actividad reciente. Solo lectura.',
                        )}
                    </p>
                </div>
                <span className="text-[11px] font-bold text-dd-text-2 shrink-0">
                    {tx('Build', 'Versión')}: <span className="text-dd-text">{appVersion}</span>
                </span>
            </header>

            {/* Top status row — Firestore + Backup + TVs grid. Each
                card is a single chunk of "is this system healthy
                right now?" information. Side-by-side on desktop,
                stacked on phones. */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <StatusCard
                    title={tx('Firestore', 'Firestore')}
                    tone={fsStatus.tone}
                    big={fsStatus.label}
                    detail={fsStatus.detail}
                    secondary={fsTickAt ? `${tx('last tick', 'último tick')}: ${fmtRelative({ toMillis: () => fsTickAt }, isEs)}` : null}
                />
                <StatusCard
                    title={tx('Last backup', 'Último respaldo')}
                    tone={backupTone}
                    big={latestBackup ? fmtRelative(latestBackup.triggeredAt, isEs) : tx('No data', 'Sin datos')}
                    detail={latestBackup?.outputUriPrefix ? String(latestBackup.outputUriPrefix).split('/').slice(-2).join('/') : tx('scheduledFirestoreBackup CF', 'Función CF programada')}
                />
                <StatusCard
                    title={tx('TV displays', 'Pantallas')}
                    tone={tvStats.offline > 0 ? 'warn' : tvStats.live > 0 ? 'good' : 'neutral'}
                    big={`${tvStats.live} / ${tvStats.total}`}
                    detail={`${tvStats.live} ${tx('live', 'en vivo')} · ${tvStats.stale} ${tx('stale', 'antiguos')} · ${tvStats.offline} ${tx('offline', 'sin conexión')}`}
                />
            </div>

            {/* Printers + per-TV detail. The printers row sits above
                the TV detail because a kitchen with no working label
                printer is more visible to staff (stickers don't come
                out) than a TV that didn't update overnight. */}
            <div className="bg-white border border-dd-line rounded-2xl p-4">
                <div className="flex items-baseline justify-between gap-2 mb-2">
                    <h2 className="text-sm font-black text-dd-text">
                        🏷 {tx('Printers', 'Impresoras')}
                    </h2>
                    <span className="text-[11px] text-dd-text-2 tabular-nums">
                        {printerStats.configured} / {printerStats.total} {tx('configured', 'configuradas')}
                        {printerStats.configured > 0 && (
                            <> · {printerStats.enabled} {tx('enabled', 'habilitadas')}</>
                        )}
                    </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {['webster', 'maryland'].map(loc => (
                        PRINTER_SLOTS.map(slot => {
                            const cfg  = printers[`${loc}/${slot}`];
                            const locLabel = loc === 'webster' ? 'Webster' : 'MD Heights';
                            const slotLabel = slot === 'kitchen' ? tx('Kitchen', 'Cocina') : tx('Office', 'Oficina');
                            const status = !cfg ? 'missing'
                                        : cfg.enabled === false ? 'disabled'
                                        : 'ok';
                            const palette = status === 'ok'
                                ? { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500', label: tx('Configured', 'Lista') }
                                : status === 'disabled'
                                ? { bg: 'bg-amber-50',   border: 'border-amber-200',   text: 'text-amber-700',   dot: 'bg-amber-500',   label: tx('Disabled',  'Deshabilitada') }
                                : { bg: 'bg-dd-bg',      border: 'border-dd-line',     text: 'text-dd-text-2',   dot: 'bg-gray-400',    label: tx('Not set up','Sin configurar') };
                            return (
                                <div key={`${loc}-${slot}`} className={`${palette.bg} border ${palette.border} rounded-lg p-2.5 flex items-center gap-2`}>
                                    <span className={`w-2 h-2 rounded-full ${palette.dot} shrink-0`} />
                                    <div className="min-w-0 flex-1">
                                        <div className={`text-[12px] font-black ${palette.text} truncate`}>
                                            {locLabel} · {slotLabel}
                                        </div>
                                        <div className="text-[10px] text-dd-text-2 truncate">
                                            {cfg
                                                ? (cfg.name || `${cfg.model || 'printer'}${cfg.ip ? ` @ ${cfg.ip}` : ''}`)
                                                : tx('No printer registered for this slot', 'Sin impresora registrada')}
                                        </div>
                                    </div>
                                    <span className={`text-[10px] font-bold ${palette.text} shrink-0`}>{palette.label}</span>
                                </div>
                            );
                        })
                    ))}
                </div>
                <p className="text-[10px] text-dd-text-2 mt-2 italic">
                    {tx(
                        'Status reflects /config/printers_{loc}_{slot} doc presence. Actual reachability is checked at print time by the Pi bridge.',
                        'El estado refleja la presencia del doc /config/printers_{loc}_{slot}. La accesibilidad real se verifica en tiempo de impresión por el puente Pi.',
                    )}
                </p>
            </div>

            {/* Secondary counts row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Mini label={tx('Chats', 'Chats')}             value={chatCount ?? '—'} />
                <Mini label={tx('Audit entries (20 most recent)', 'Entradas (20 recientes)')} value={recentAudit.length} />
                <Mini label={tx('TV heartbeats', 'Latidos TV')} value={tvStats.total} />
                <Mini label={tx('Build', 'Versión')}            value={appVersion.split(' · ')[1] || appVersion} mono />
            </div>

            {/* TV health detail — only renders if there's at least
                one heartbeat. Lets admin spot the specific TV that
                went dark without clicking through to Menu Screens. */}
            {tvStats.total > 0 && (
                <div className="bg-white border border-dd-line rounded-2xl p-4">
                    <h2 className="text-sm font-black text-dd-text mb-2">
                        📺 {tx('TV detail', 'Detalle de TV')}
                    </h2>
                    <div className="divide-y divide-dd-line/60">
                        {tvStats.list
                            .slice()
                            .sort((a, b) => (minutesSince(a.lastSeenAt) ?? 1e9) - (minutesSince(b.lastSeenAt) ?? 1e9))
                            .map(hb => {
                                const m = minutesSince(hb.lastSeenAt);
                                const tone = m === null         ? 'gray'
                                          : m < TV_LIVE_MIN     ? 'emerald'
                                          : m < TV_OFFLINE_MIN  ? 'amber'
                                          :                       'red';
                                return (
                                    <div key={hb.tvId} className="py-2 flex items-center gap-3 text-[12.5px]">
                                        <span className={`w-2 h-2 rounded-full bg-${tone}-500 shrink-0`} />
                                        <span className="font-bold text-dd-text shrink-0">{hb.tvId}</span>
                                        <span className="flex-1" />
                                        <span className="text-dd-text-2">
                                            {m === null ? tx('no heartbeat', 'sin latido') : fmtRelative(hb.lastSeenAt, isEs)}
                                        </span>
                                    </div>
                                );
                            })}
                    </div>
                </div>
            )}

            {/* Recent activity feed — last 20 audit entries. Empty
                state when nothing's there (fresh restaurant or rule
                error). Compact 1-line-per-entry format so admin can
                scan quickly. */}
            <div className="bg-white border border-dd-line rounded-2xl p-4">
                <h2 className="text-sm font-black text-dd-text mb-2">
                    🕒 {tx('Recent activity', 'Actividad reciente')}
                </h2>
                {recentAudit.length === 0 ? (
                    <p className="text-[12px] text-dd-text-2 italic">
                        {tx('No audit entries yet.', 'Sin entradas todavía.')}
                    </p>
                ) : (
                    <div className="divide-y divide-dd-line/60 max-h-96 overflow-y-auto">
                        {recentAudit.map(a => (
                            <div key={a.id} className="py-2 text-[12px] flex items-baseline gap-2">
                                <span className="text-dd-text-2 shrink-0 tabular-nums w-12 text-right">
                                    {fmtRelative(a.createdAt, isEs)}
                                </span>
                                <span className="font-bold text-dd-text shrink-0">{a.actorName || '—'}</span>
                                <span className="text-dd-text-2 truncate">
                                    {a.action}
                                    {a.targetType ? ` · ${a.targetType}` : ''}
                                    {a.targetId ? ` · ${String(a.targetId).slice(0, 40)}` : ''}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Security posture — quick recap card so admins remember
                where the rules stand. Especially useful right now
                while we're still on anonymous Firestore access. */}
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <h2 className="text-sm font-black text-amber-900 mb-1.5">
                    🔒 {tx('Security posture', 'Postura de seguridad')}
                </h2>
                <ul className="text-[12px] text-amber-900/90 space-y-1 list-disc list-inside leading-relaxed">
                    <li>{tx(
                        'Anonymous Firestore — no per-user Auth yet. Phase 2 roadmap in firestore.rules.',
                        'Firestore anónimo — sin Auth por usuario aún. Plan Fase 2 en firestore.rules.',
                    )}</li>
                    <li>{tx(
                        'Audit logs append-only (no delete from clients).',
                        'Registros de auditoría solo agregar (sin borrar desde clientes).',
                    )}</li>
                    <li>{tx(
                        'Chats + notifications + time_off: tombstone delete only.',
                        'Chats + notificaciones + PTO: solo lápida.',
                    )}</li>
                    <li>{tx(
                        'PIN screen + 5-min idle relock + cold-launch wipe.',
                        'Pantalla PIN + relock 5min inactivo + limpieza en arranque frío.',
                    )}</li>
                </ul>
            </div>
        </section>
    );
}

// StatusCard — large headline metric. The tone prop drives the
// border + headline color so admin's eye lands on the cards that
// need attention (red border > amber > green > gray).
function StatusCard({ title, tone, big, detail, secondary }) {
    const palette = {
        good:    { border: 'border-emerald-300', bg: 'bg-emerald-50/40',  text: 'text-emerald-700' },
        warn:    { border: 'border-amber-300',   bg: 'bg-amber-50/40',    text: 'text-amber-700'   },
        danger:  { border: 'border-red-300',     bg: 'bg-red-50/40',      text: 'text-red-700'     },
        neutral: { border: 'border-dd-line',     bg: 'bg-white',          text: 'text-dd-text'     },
    }[tone] || { border: 'border-dd-line', bg: 'bg-white', text: 'text-dd-text' };
    return (
        <div className={`${palette.bg} border ${palette.border} rounded-2xl p-3.5 shadow-sm`}>
            <div className="text-[10px] font-black uppercase tracking-widest text-dd-text-2">{title}</div>
            <div className={`text-2xl font-black tabular-nums mt-1 ${palette.text}`}>{big}</div>
            <div className="text-[11.5px] text-dd-text-2 mt-1">{detail}</div>
            {secondary && (
                <div className="text-[10px] text-dd-text-2/80 mt-1.5">{secondary}</div>
            )}
        </div>
    );
}

// Mini — secondary stat tile. Smaller than StatusCard, used for
// counts that don't need color-coded urgency.
function Mini({ label, value, mono }) {
    return (
        <div className="bg-white border border-dd-line rounded-xl px-3 py-2.5 shadow-sm">
            <div className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2 leading-none">{label}</div>
            <div className={`text-lg font-black mt-1.5 ${mono ? 'font-mono text-sm' : 'tabular-nums'} text-dd-text leading-none`}>{value}</div>
        </div>
    );
}
