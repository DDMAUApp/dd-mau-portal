// PageErrorBoundary — shared error boundary for top-level routes.
//
// Andrew 2026-05-23 audit follow-up: previously a sync render crash
// inside Schedule / Operations / etc. would surface through App's
// global ErrorBoundary, which is tuned for stale-chunk recovery
// (auto-reload once). For non-chunk errors that's the wrong UX —
// the global boundary tries a refresh, the refresh hits the same
// bug, and the user lands on "Something went wrong" with nothing
// to do.
//
// This boundary is route-scoped. A crash in Schedule doesn't blank
// the whole shell — the sidebar + bottom nav stay, the user can
// jump to a different tab, come back, and the boundary remounts
// (we key on tabName).
//
// We deliberately match the ChatThreadErrorBoundary + TvErrorBoundary
// patterns already in the codebase — same recovery UX (icon, title,
// description, primary action) so users see one consistent error
// state across the app instead of three different "oh no" screens.
//
// 2026-05-26 — added logError() call in componentDidCatch so every
// route crash also writes a row to /error_logs with the full stack +
// recent breadcrumbs. Plus a "Report this" button that opens the
// global ReportProblemButton sheet pre-filled with the crash context,
// so a staff member who hits a route crash can flag it in one tap
// instead of needing to remember what they were doing.

import { Component } from 'react';
import { logError, breadcrumb } from '../data/logger';

// Chunk-load error pattern — matches Safari/Chrome/Firefox wording for
// "the lazy-imported JS file no longer exists." This is ALWAYS a
// stale-cache situation: the user has an old index.html cached that
// references chunk hashes that have been rotated by subsequent deploys.
// The fix is to force-reload once. We MUST NOT log these to /error_logs
// at severity=critical because they're noise — every staff member on
// every deploy boundary would generate one and bury real bugs.
//
// Mirror of the pattern in src/App.jsx for the global ErrorBoundary.
// Keep them in sync.
const CHUNK_ERR_PATTERN = /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|dynamically imported module|Failed to load module/i;
const RELOAD_FLAG_KEY = 'ddmau:errorBoundaryReloaded';

function isChunkError(err) {
    if (!err) return false;
    const msg = String(err.message || err || '');
    const name = err.name || '';
    return CHUNK_ERR_PATTERN.test(msg) || name === 'ChunkLoadError';
}

export default class PageErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorLogId: null, isReloading: false };
    }
    static getDerivedStateFromError(error) {
        // Andrew 2026-05-31: chunk-load errors trigger a 50ms-deferred
        // auto-reload (see componentDidCatch). For the gap between
        // catch and reload, render a calm "Updating..." spinner
        // instead of the alarming "Something broke" panel. Previous
        // behavior flashed the error UI for ~1s on every deploy
        // boundary; the spinner is honest about what is happening.
        return { hasError: true, error, isReloading: isChunkError(error) };
    }
    componentDidCatch(error, info) {
        const tab = this.props.tabName || 'page';
        // Keep the console line — it's load-bearing for live debugging
        // in dev (the page chrome only shows the error name, the
        // console has the full stack with HMR symbol mapping).
        // eslint-disable-next-line no-console
        console.error(`[${tab}] render crashed:`, error, info);

        // 2026-05-27 — stale-cache chunk-load errors get the auto-reload
        // path and are NEVER logged to /error_logs. A Kitchen Manager
        // iPad with an old index.html bundle caught this hitting the
        // Operations tab, generating a noise row in the Error Report.
        // The global ErrorBoundary in App.jsx already does this for
        // top-level catches; PageErrorBoundary needs the same logic
        // because lazy chunks inside a route can throw THERE, not at
        // the top level. The sessionStorage flag prevents reload-loop
        // if the reload itself fails for some other reason — flag is
        // cleared by ChunkReloadFlagReset on first successful render.
        if (isChunkError(error)) {
            let alreadyTried = null;
            try { alreadyTried = sessionStorage.getItem(RELOAD_FLAG_KEY); } catch {}
            if (!alreadyTried) {
                try { sessionStorage.setItem(RELOAD_FLAG_KEY, String(Date.now())); } catch {}
                // Defer so React can finish painting the fallback in case
                // reload is blocked or fails — same pattern as the global
                // ErrorBoundary in App.jsx.
                setTimeout(() => { try { window.location.reload(); } catch {} }, 50);
            }
            // Either way (auto-reloading OR already tried), we skip the
            // /error_logs write. Chunk errors aren't actionable bugs.
            return;
        }

        // Drop a breadcrumb FIRST so the error_logs row's recentActions
        // array captures the boundary trip itself (helps disambiguate
        // "crashed on mount" vs "crashed after N actions").
        try { breadcrumb('react.error', tab); } catch {}

        // Best-effort write to /error_logs. Fire-and-forget — we don't
        // want to await a Firestore round-trip during a render crash.
        // Stash the resulting doc id (when it arrives) on state so the
        // fallback UI can render a "Report this (ref: …)" link.
        Promise.resolve(logError({
            error,
            severity: 'critical',
            feature: this.props.feature || tab,
            meta: {
                tabName: tab,
                componentStack: typeof info?.componentStack === 'string'
                    ? info.componentStack.slice(0, 4000)
                    : null,
            },
        })).then((id) => {
            if (id) this.setState({ errorLogId: id });
        }).catch(() => {
            // logError already swallows its own write failures, but
            // belt-and-suspenders so a thrown promise here doesn't
            // unmount the boundary itself.
        });
    }

    // 2026-05-27 — handleReport (dispatched ddmau:open-bug-report
    // for ReportProblemButton to pick up) is gone along with the
    // staff bug-report feature. Errors still log to /error_logs +
    // Sentry; only the staff-initiated report path is removed.

    render() {
        if (!this.state.hasError) return this.props.children;
        const tab = this.props.tabName || 'This page';
        const isEs = this.props.language === 'es';
        const tx = (en, es) => (isEs ? es : en);

        // Chunk-load case — auto-reload is firing in ~50ms (see
        // componentDidCatch). Show a friendly spinner instead of the
        // error panel so the user does not see "Something broke" flash
        // and reach for the panic button. The reload happens before
        // most users finish reading the message.
        if (this.state.isReloading) {
            return (
                <div className="flex flex-col items-center justify-center min-h-[60vh] bg-dd-bg text-center px-6 py-12 gap-3">
                    <div className="w-10 h-10 rounded-full border-4 border-dd-line border-t-dd-green animate-spin" />
                    <h3 className="text-sm font-bold text-dd-text">
                        {tx('Updating app…', 'Actualizando app…')}
                    </h3>
                    <p className="text-[11px] text-dd-text-2 max-w-xs leading-relaxed">
                        {tx(
                            'A new version just shipped. Loading the latest files — one moment.',
                            'Acaba de salir una nueva versión. Cargando los archivos más recientes — un momento.',
                        )}
                    </p>
                </div>
            );
        }

        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] bg-dd-bg text-center px-6 py-12 gap-3">
                <div className="text-5xl">⚠️</div>
                <h3 className="text-lg font-black text-dd-text">
                    {tx(`${tab} couldn't load`, `${tab} no se pudo cargar`)}
                </h3>
                <p className="text-sm text-dd-text-2 max-w-md leading-relaxed">
                    {tx(
                        "Something broke rendering this page. The rest of the app is fine — switch tabs and come back, or refresh. If it keeps happening, send us a report and we'll fix it.",
                        "Algo falló al cargar esta página. El resto de la app funciona — cambia de pestaña y vuelve, o recarga. Si sigue pasando, envíanos un reporte y lo arreglaremos.",
                    )}
                </p>
                <div className="flex gap-2 mt-2 flex-wrap justify-center">
                    <button
                        onClick={() => this.setState({ hasError: false, error: null, errorLogId: null })}
                        className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 active:scale-95 transition shadow-sm">
                        ↻ {tx('Try again', 'Reintentar')}
                    </button>
                    {/* 2026-05-27 — "🪲 Report this" button removed.
                        It dispatched ddmau:open-bug-report which only
                        the now-deleted ReportProblemButton listened to,
                        so the button would have been a no-op. Errors
                        still auto-log to /error_logs + Sentry. */}
                    <button
                        onClick={() => { try { window.location.reload(); } catch {} }}
                        className="px-4 py-2 rounded-lg bg-white border border-dd-line text-dd-text text-sm font-bold hover:bg-dd-bg active:scale-95 transition">
                        {tx('Refresh app', 'Recargar app')}
                    </button>
                </div>
                {/* Surface the error_log ref so a manager handing it to
                    Andrew has a stable id to reference. Falls back to
                    "(pending)" until the Firestore write resolves. */}
                <div className="text-[10.5px] text-dd-text-2 mt-2 font-mono">
                    {tx('Ref:', 'Ref:')} {this.state.errorLogId || tx('(pending)', '(pendiente)')}
                </div>
                {this.state.error?.message && (
                    <details className="mt-3 text-[11px] text-dd-text-2 max-w-md">
                        <summary className="cursor-pointer">{tx('Technical details', 'Detalles técnicos')}</summary>
                        <pre className="text-left whitespace-pre-wrap break-words bg-white border border-dd-line rounded px-2 py-1.5 mt-1 font-mono">
                            {String(this.state.error.message).slice(0, 500)}
                        </pre>
                    </details>
                )}
            </div>
        );
    }
}
