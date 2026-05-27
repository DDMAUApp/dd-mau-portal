// ErrorReportPage — owner-only "look at the error report" tab.
//
// Andrew 2026-05-27: "lets not put errors in the notifications. make
// a spot where i can say look at the error report and we both can see
// all the errors." This is that spot.
//
// What lives here:
//   • Open bug reports (filed by staff via the 🪲 button) — with
//     Resolve + Export-to-AI actions per row.
//   • Recent errors grouped by signature — so 200 of the same crash
//     show as one card with a ×200 badge instead of 200 rows. Each
//     group has Export-to-AI to copy a clean JSON dump for Claude.
//   • AI failures (last 20 from /ai_logs where ok=false) — Anthropic
//     429s, safety blocks, anything else the Cloud Functions logged.
//   • A prominent "Open Sentry" button — the canonical bug-triage UI
//     lives there; this page is the in-app glance for "is anything
//     broken right now?".
//
// Owner gate: routed only when staffIsAdmin (ids 40/41) in App.jsx.
// The data here is sensitive (stack traces can carry app internals),
// so the same gate as the rest of the admin tabs.
//
// Previously these three cards lived in AdminHealthPage; they're moved
// here so Health stays focused on systems status (TVs, printers,
// Firestore liveness, backups) and the Error Report is a single-
// purpose triage view we can say "go to" without ambiguity.

import { useEffect, useMemo, useState } from 'react';
import { db } from '../firebase';
import {
    collection, doc, query, where, orderBy, limit, onSnapshot, updateDoc,
} from 'firebase/firestore';
import { exportErrorToAI, exportBugToAI } from '../data/aiDebugReport';

// Same fmtRelative as AdminHealthPage so labels read consistently
// across the admin-side surfaces. Kept inline (vs imported) so this
// component stays self-contained.
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

// The Sentry org/project slugs — used to deep-link from each card to
// the corresponding Sentry view. Hardcoded because they're tied to the
// project's permanent identity (rotating Sentry projects is rare).
const SENTRY_ORG = 'dd-mau';
const SENTRY_PROJECT = 'dd-mau-portal';
const SENTRY_BASE = `https://${SENTRY_ORG}.sentry.io`;

export default function ErrorReportPage({ language = 'en', staffName }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // ── Open bug reports (live subscription) ─────────────────────
    // Limited to 50 newest open reports. Resolved reports live on but
    // aren't surfaced here — a future "show resolved" toggle could
    // load them on demand if you want to revisit history.
    const [bugReports, setBugReports] = useState([]);
    useEffect(() => {
        const q = query(
            collection(db, 'bug_reports'),
            where('status', '==', 'open'),
            orderBy('ts', 'desc'),
            limit(50),
        );
        const unsub = onSnapshot(q, (snap) => {
            const out = [];
            snap.forEach(d => out.push({ id: d.id, ...d.data() }));
            setBugReports(out);
        }, (err) => console.warn('ErrorReport: bug_reports error:', err));
        return unsub;
    }, []);

    // ── Recent /error_logs (live subscription, last 100) ──────────
    // Limit is higher than the Health page's 50 because this is the
    // dedicated triage view — we want enough history to spot trends.
    const [errorLogs, setErrorLogs] = useState([]);
    useEffect(() => {
        const q = query(
            collection(db, 'error_logs'),
            orderBy('ts', 'desc'),
            limit(100),
        );
        const unsub = onSnapshot(q, (snap) => {
            const out = [];
            snap.forEach(d => out.push({ id: d.id, ...d.data() }));
            setErrorLogs(out);
        }, (err) => console.warn('ErrorReport: error_logs error:', err));
        return unsub;
    }, []);

    // Group error logs by errorName + first 80 chars of message. The
    // signature is fuzzy enough that "permission-denied at inventory/foo"
    // and "permission-denied at inventory/bar" still cluster.
    const groupedErrors = useMemo(() => {
        const map = new Map();
        for (const e of errorLogs) {
            const sig = `${e.errorName || 'Error'}::${(e.errorMessage || '').slice(0, 80)}`;
            const existing = map.get(sig);
            if (existing) {
                existing.count++;
                existing.featuresSet.add(e.feature || 'unknown');
                existing.rolesSet.add(e.userRole || 'anonymous');
                if (!existing.latest || (e.occurredAt || 0) > (existing.latest.occurredAt || 0)) {
                    existing.latest = e;
                }
            } else {
                map.set(sig, {
                    sig,
                    errorName: e.errorName || 'Error',
                    errorMessage: e.errorMessage || '',
                    severity: e.severity || 'error',
                    featuresSet: new Set([e.feature || 'unknown']),
                    rolesSet: new Set([e.userRole || 'anonymous']),
                    count: 1,
                    latest: e,
                });
            }
        }
        return [...map.values()]
            .map(g => ({ ...g, features: [...g.featuresSet], roles: [...g.rolesSet] }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 30);
    }, [errorLogs]);

    // ── AI failures (last 20 where ok=false) ──────────────────────
    const [aiFailures, setAiFailures] = useState([]);
    useEffect(() => {
        const q = query(
            collection(db, 'ai_logs'),
            where('ok', '==', false),
            orderBy('ts', 'desc'),
            limit(20),
        );
        const unsub = onSnapshot(q, (snap) => {
            const out = [];
            snap.forEach(d => out.push({ id: d.id, ...d.data() }));
            setAiFailures(out);
        }, (err) => console.warn('ErrorReport: ai_logs error:', err));
        return unsub;
    }, []);

    // ── Counters for the top strip ────────────────────────────────
    const openBugCount = bugReports.length;
    const critErr24hCount = useMemo(() => {
        const cutoff = Date.now() - 24 * 3600_000;
        return errorLogs.filter(e =>
            e.severity === 'critical' && (e.occurredAt || 0) >= cutoff,
        ).length;
    }, [errorLogs]);
    const totalErrors7d = useMemo(() => {
        const cutoff = Date.now() - 7 * 24 * 3600_000;
        return errorLogs.filter(e => (e.occurredAt || 0) >= cutoff).length;
    }, [errorLogs]);

    // ── Resolve a bug report (status flip + who/when) ─────────────
    const resolveBug = async (id) => {
        try {
            await updateDoc(doc(db, 'bug_reports', id), {
                status: 'resolved',
                resolvedAt: Date.now(),
                resolvedBy: staffName || null,
            });
        } catch (e) {
            console.warn('resolveBug failed:', e);
        }
    };

    // ── Export to clipboard helpers (with inline flash toast) ─────
    const [exportingId, setExportingId] = useState(null);
    const [exportFlash, setExportFlash] = useState(null);
    const flash = (msg) => {
        setExportFlash(msg);
        setTimeout(() => setExportFlash(null), 2000);
    };

    const handleExportError = async (errorDoc) => {
        setExportingId(errorDoc.id);
        try {
            const { ok } = await exportErrorToAI(errorDoc);
            flash(ok
                ? (isEs ? '✓ Copiado al portapapeles' : '✓ Copied to clipboard')
                : (isEs ? 'No se pudo copiar' : 'Could not copy'));
        } finally {
            setExportingId(null);
        }
    };

    const handleExportBug = async (bugDoc) => {
        setExportingId(bugDoc.id);
        try {
            const attached = Array.isArray(bugDoc.attachedErrorIds)
                ? errorLogs.filter(e => bugDoc.attachedErrorIds.includes(e.id))
                : [];
            const { ok } = await exportBugToAI(bugDoc, { attachedErrors: attached });
            flash(ok
                ? (isEs ? '✓ Copiado al portapapeles' : '✓ Copied to clipboard')
                : (isEs ? 'No se pudo copiar' : 'Could not copy'));
        } finally {
            setExportingId(null);
        }
    };

    return (
        <section className="w-full max-w-6xl mx-auto px-3 md:px-6 py-4 md:py-6 space-y-5">
            {/* Header strip — name of the tab + top-line counters +
                Open Sentry button. The Sentry button is prominent
                because the full forensic UI lives there; this page
                is the in-app glance / quick-resolve surface. */}
            <header className="flex items-baseline justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                    <h1 className="text-2xl md:text-3xl font-black text-dd-text tracking-tight">
                        🐛 {tx('Error Report', 'Reporte de errores')}
                    </h1>
                    <p className="text-[12px] text-dd-text-2 mt-0.5">
                        {tx(
                            'Live feed of bug reports, crashes, and AI failures. Only you + Julie see this.',
                            'Reportes, errores y fallos de IA en vivo. Solo tú + Julie ven esto.',
                        )}
                    </p>
                </div>
                <a
                    href={`${SENTRY_BASE}/issues/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 inline-flex items-center gap-2 bg-dd-text text-white font-bold text-sm px-3 py-2 rounded-xl hover:bg-dd-text/90 active:scale-95 transition"
                >
                    <span aria-hidden>🛰</span>
                    {tx('Open Sentry', 'Abrir Sentry')}
                    <span className="opacity-60 text-[10px]">↗</span>
                </a>
            </header>

            {/* Top counters: open bugs, critical/24h, total/7d. Clicking
                each one would be a nice future filter, but keeping it
                read-only for now so the page is purely a glance. */}
            <div className="grid grid-cols-3 gap-3">
                <Stat
                    label={tx('Open reports', 'Abiertos')}
                    value={openBugCount}
                    tone={openBugCount > 0 ? 'warn' : 'good'}
                />
                <Stat
                    label={tx('Critical / 24h', 'Críticos / 24h')}
                    value={critErr24hCount}
                    tone={critErr24hCount > 0 ? 'danger' : 'good'}
                />
                <Stat
                    label={tx('Errors / 7d', 'Errores / 7d')}
                    value={totalErrors7d}
                    tone={totalErrors7d > 50 ? 'warn' : 'good'}
                />
            </div>

            {/* Open bug reports — full-width card. Higher priority than
                error groups because these are direct staff signals
                ("the screen does X weird") and only humans triage them. */}
            <div className="bg-white border border-dd-line rounded-2xl p-4">
                <div className="flex items-baseline justify-between mb-2">
                    <h2 className="text-sm font-black text-dd-text">
                        🪲 {tx('Open bug reports', 'Reportes abiertos')}
                        <span className="text-[11px] font-bold text-dd-text-2 ml-2 tabular-nums">
                            {openBugCount}
                        </span>
                    </h2>
                    {openBugCount === 0 && (
                        <span className="text-[11px] text-dd-text-2 italic">
                            {tx('All clear', 'Todo limpio')}
                        </span>
                    )}
                </div>
                {bugReports.length === 0 ? (
                    <p className="text-[12px] text-dd-text-2 italic">
                        {tx('No open reports.', 'Sin reportes abiertos.')}
                    </p>
                ) : (
                    <div className="divide-y divide-dd-line/60 -mx-1">
                        {bugReports.map(b => (
                            <div key={b.id} className="px-1 py-2.5">
                                <div className="flex items-baseline gap-2 mb-1">
                                    <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full border tabular-nums ${
                                        b.urgency === 'high'
                                            ? 'bg-red-50 border-red-200 text-red-700'
                                            : b.urgency === 'med'
                                                ? 'bg-amber-50 border-amber-200 text-amber-700'
                                                : 'bg-dd-bg border-dd-line text-dd-text-2'
                                    }`}>
                                        {(b.urgency || 'med').toUpperCase()}
                                    </span>
                                    <span className="text-[11px] font-bold text-dd-text">
                                        {b.reporterName || tx('anonymous', 'anónimo')}
                                    </span>
                                    <span className="text-[10px] text-dd-text-2 shrink-0 tabular-nums">
                                        {fmtRelative(b.ts, isEs)}
                                    </span>
                                </div>
                                <div className="text-[12.5px] text-dd-text leading-snug">
                                    {b.description}
                                </div>
                                {b.whatWereYouDoing && (
                                    <div className="text-[11px] text-dd-text-2 mt-0.5 italic">
                                        {tx('Doing:', 'Hacía:')} {b.whatWereYouDoing}
                                    </div>
                                )}
                                <div className="text-[10px] text-dd-text-2 mt-1 font-mono truncate">
                                    {b.page} · {(b.reporterLocation || '—')} · v{b.appVersion || '?'}
                                </div>
                                <div className="flex gap-1.5 mt-2">
                                    <button
                                        disabled={exportingId === b.id}
                                        onClick={() => handleExportBug(b)}
                                        className="text-[11px] font-bold px-2.5 py-1 rounded bg-dd-bg border border-dd-line text-dd-text hover:bg-white disabled:opacity-50"
                                    >
                                        {exportingId === b.id
                                            ? '…'
                                            : tx('Export to AI', 'Exportar a IA')}
                                    </button>
                                    <button
                                        onClick={() => resolveBug(b.id)}
                                        className="text-[11px] font-bold px-2.5 py-1 rounded bg-dd-green/90 text-white hover:bg-dd-green"
                                    >
                                        ✓ {tx('Resolve', 'Resolver')}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Recent errors grouped by signature. Tighter format than
                bug reports because they're machine-generated and the
                key info is the signature + count, not narrative. */}
            <div className="bg-white border border-dd-line rounded-2xl p-4">
                <div className="flex items-baseline justify-between mb-2">
                    <h2 className="text-sm font-black text-dd-text">
                        ⚠️ {tx('Recent errors', 'Errores recientes')}
                        <span className="text-[11px] font-bold text-dd-text-2 ml-2 tabular-nums">
                            {groupedErrors.length} {tx('groups', 'grupos')}
                        </span>
                    </h2>
                    <a
                        href={`${SENTRY_BASE}/issues/?project=${SENTRY_PROJECT}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] font-bold text-dd-text-2 hover:text-dd-text"
                    >
                        {tx('Full forensics in Sentry', 'Forense en Sentry')} ↗
                    </a>
                </div>
                {groupedErrors.length === 0 ? (
                    <p className="text-[12px] text-dd-text-2 italic">
                        {tx('No errors logged yet.', 'Sin errores aún.')}
                    </p>
                ) : (
                    <div className="divide-y divide-dd-line/60 -mx-1 max-h-[28rem] overflow-y-auto">
                        {groupedErrors.map((g) => (
                            <div key={g.sig} className="px-1 py-2">
                                <div className="flex items-baseline gap-2 mb-0.5">
                                    <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full border tabular-nums ${
                                        g.severity === 'critical'
                                            ? 'bg-red-50 border-red-200 text-red-700'
                                            : g.severity === 'error'
                                                ? 'bg-amber-50 border-amber-200 text-amber-700'
                                                : 'bg-dd-bg border-dd-line text-dd-text-2'
                                    }`}>
                                        ×{g.count}
                                    </span>
                                    <span className="text-[12px] font-bold text-dd-text truncate">
                                        {g.errorName}
                                    </span>
                                    <span className="text-[10px] text-dd-text-2 shrink-0 tabular-nums">
                                        {fmtRelative(g.latest?.ts, isEs)}
                                    </span>
                                </div>
                                <div className="text-[12px] text-dd-text leading-snug line-clamp-2">
                                    {g.errorMessage || tx('(no message)', '(sin mensaje)')}
                                </div>
                                <div className="text-[10px] text-dd-text-2 mt-0.5 truncate">
                                    {g.features.join(', ')} · {g.roles.join(', ')}
                                </div>
                                <button
                                    disabled={exportingId === g.latest?.id}
                                    onClick={() => handleExportError(g.latest)}
                                    className="text-[10px] font-bold px-2 py-1 rounded bg-dd-bg border border-dd-line text-dd-text hover:bg-white mt-1.5 disabled:opacity-50"
                                >
                                    {exportingId === g.latest?.id
                                        ? '…'
                                        : tx('Export to AI', 'Exportar a IA')}
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* AI failures — separate card because they're a different
                ops concern (cost/quota) than app crashes. Only renders
                when there are failures, otherwise the card is hidden
                so the page reads "everything's fine" at a glance. */}
            {aiFailures.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                    <h2 className="text-sm font-black text-amber-900 mb-2">
                        🤖 {tx('AI failures', 'Fallos de IA')}
                        <span className="text-[10px] font-bold text-amber-700 ml-2">
                            {aiFailures.length} {tx('recent', 'recientes')}
                        </span>
                    </h2>
                    <div className="divide-y divide-amber-200/70 max-h-48 overflow-y-auto">
                        {aiFailures.map(a => (
                            <div key={a.id} className="py-1.5 text-[12px] flex items-baseline gap-2">
                                <span className="text-amber-800 shrink-0 tabular-nums w-10 text-right">
                                    {fmtRelative(a.ts, isEs)}
                                </span>
                                <span className="font-bold text-amber-900 shrink-0">{a.feature || 'ai'}</span>
                                <span className="text-amber-900/80 truncate">
                                    {(a.errorMessage || a.errorCode || tx('(no message)', '(sin mensaje)'))}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Helper card: tells the owners what each card means + how
                to escalate. Especially useful for Julie if she ends up
                opening this without Andrew walking her through it. */}
            <div className="bg-dd-bg border border-dd-line rounded-2xl p-4">
                <h2 className="text-sm font-black text-dd-text mb-2">
                    📖 {tx('How to use this page', 'Cómo usar esta página')}
                </h2>
                <ul className="text-[12px] text-dd-text-2 space-y-1.5 leading-relaxed list-disc list-inside">
                    <li>
                        <strong className="text-dd-text">{tx('Open bug reports', 'Reportes abiertos')}:</strong>{' '}
                        {tx(
                            'staff used the 🪲 Report button on their screen. Tap "Export to AI" → paste into Claude → ask "what could be causing this?".',
                            'el staff usó el botón 🪲 Reportar. Toca "Exportar a IA" → pega en Claude → pregunta "¿qué podría estar causando esto?".',
                        )}
                    </li>
                    <li>
                        <strong className="text-dd-text">{tx('Recent errors', 'Errores recientes')}:</strong>{' '}
                        {tx(
                            'JS crashes auto-captured by the app. ×N badge = how many times it fired. "Export to AI" copies a full forensic JSON.',
                            'crashes JS capturados automáticamente. Insignia ×N = cuántas veces ocurrió. "Exportar a IA" copia JSON forense completo.',
                        )}
                    </li>
                    <li>
                        <strong className="text-dd-text">{tx('Open Sentry button', 'Botón Abrir Sentry')}:</strong>{' '}
                        {tx(
                            'opens dd-mau.sentry.io — the full forensic UI with stack traces, breadcrumbs, user info, deploy correlation.',
                            'abre dd-mau.sentry.io — la UI forense completa con stacks, breadcrumbs, usuario, correlación de deploy.',
                        )}
                    </li>
                    <li>
                        {tx(
                            'Sentry also sends a push to your phone (download the Sentry app from App Store, sign in with GitHub).',
                            'Sentry también envía push a tu teléfono (descarga la app de Sentry, inicia con GitHub).',
                        )}
                    </li>
                </ul>
            </div>

            {/* Floating clipboard-flash toast (lives at fixed bottom-
                center). Matches the same look as Health page. */}
            {exportFlash && (
                <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-dd-text text-white text-xs font-bold px-3 py-2 rounded-full shadow-lg z-50">
                    {exportFlash}
                </div>
            )}
        </section>
    );
}

// Small stat tile for the top counter row. Tone drives the headline
// color so a problem state catches the eye (red for crit, amber for
// "above normal", green for "fine").
function Stat({ label, value, tone }) {
    const palette = {
        good:    { bg: 'bg-white',     border: 'border-dd-line',     text: 'text-dd-text'    },
        warn:    { bg: 'bg-amber-50/40', border: 'border-amber-300', text: 'text-amber-700'  },
        danger:  { bg: 'bg-red-50/40',   border: 'border-red-300',   text: 'text-red-700'    },
    }[tone] || { bg: 'bg-white', border: 'border-dd-line', text: 'text-dd-text' };
    return (
        <div className={`${palette.bg} border ${palette.border} rounded-xl px-3 py-2.5 shadow-sm`}>
            <div className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2 leading-none">
                {label}
            </div>
            <div className={`text-2xl font-black tabular-nums mt-1.5 ${palette.text} leading-none`}>
                {value}
            </div>
        </div>
    );
}
