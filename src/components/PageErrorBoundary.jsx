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

import { Component } from 'react';

export default class PageErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, info) {
        const tab = this.props.tabName || 'page';
        console.error(`[${tab}] render crashed:`, error, info);
    }
    render() {
        if (!this.state.hasError) return this.props.children;
        const tab = this.props.tabName || 'This page';
        const isEs = this.props.language === 'es';
        const tx = (en, es) => (isEs ? es : en);
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] bg-dd-bg text-center px-6 py-12 gap-3">
                <div className="text-5xl">⚠️</div>
                <h3 className="text-lg font-black text-dd-text">
                    {tx(`${tab} couldn't load`, `${tab} no se pudo cargar`)}
                </h3>
                <p className="text-sm text-dd-text-2 max-w-md leading-relaxed">
                    {tx(
                        "Something broke rendering this page. The rest of the app is fine — switch tabs and come back, or refresh. If it keeps happening, a manager can check the console for the error trace.",
                        "Algo falló al cargar esta página. El resto de la app funciona — cambia de pestaña y vuelve, o recarga. Si sigue pasando, un gerente puede revisar la consola.",
                    )}
                </p>
                <div className="flex gap-2 mt-2">
                    <button
                        onClick={() => this.setState({ hasError: false, error: null })}
                        className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 active:scale-95 transition shadow-sm">
                        ↻ {tx('Try again', 'Reintentar')}
                    </button>
                    <button
                        onClick={() => { try { window.location.reload(); } catch {} }}
                        className="px-4 py-2 rounded-lg bg-white border border-dd-line text-dd-text text-sm font-bold hover:bg-dd-bg active:scale-95 transition">
                        {tx('Refresh app', 'Recargar app')}
                    </button>
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
