// AppVersion — tiny footer badge showing the current build version + operator.
// Tappable: opens a small panel with full build info plus a "Refresh now"
// self-service button (uses the same forceRefresh() flow as pull-to-refresh).
//
// Mounted twice in App.jsx — once at the bottom of the desktop sidebar,
// once just above the mobile bottom-nav. Conditional CSS in App.jsx hides
// the wrong one per breakpoint.

import { useState } from 'react';
import { forceRefresh } from './hooks/usePullToRefresh';

// __APP_VERSION__ / __APP_BUILT_AT__ / __APP_OPERATOR__ are injected at
// build time by Vite (see vite.config.js define block).
const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const BUILT_AT = typeof __APP_BUILT_AT__ !== 'undefined' ? __APP_BUILT_AT__ : '';
const OPERATOR = typeof __APP_OPERATOR__ !== 'undefined' ? __APP_OPERATOR__ : '';

export default function AppVersion({ language, className = '' }) {
    const [open, setOpen] = useState(false);
    const isEs = language === 'es';
    const builtLabel = (() => {
        if (!BUILT_AT) return '';
        try {
            const d = new Date(BUILT_AT);
            return d.toLocaleString(isEs ? 'es' : 'en', {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            });
        } catch { return BUILT_AT; }
    })();

    return (
        <>
            <button
                onClick={() => setOpen(true)}
                className={`text-[10px] text-gray-400 hover:text-gray-600 transition px-2 py-1 ${className}`}
                title={isEs ? 'Información de versión' : 'Version info'}>
                {OPERATOR && <span>{OPERATOR} · </span>}
                <span className="font-mono">{VERSION}</span>
            </button>
            {open && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
                    onClick={() => setOpen(false)}>
                    <div onClick={(e) => e.stopPropagation()}
                        className="bg-white rounded-2xl max-w-sm w-full p-5 space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="text-base font-bold text-mint-700">ℹ {isEs ? 'Versión de la app' : 'App version'}</h3>
                            <button onClick={() => setOpen(false)}
                                className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200">×</button>
                        </div>
                        <dl className="text-xs space-y-2">
                            {OPERATOR && (
                                <div className="flex justify-between gap-3">
                                    <dt className="text-gray-500">{isEs ? 'Operador' : 'Operator'}</dt>
                                    <dd className="font-bold text-gray-800 text-right">{OPERATOR}</dd>
                                </div>
                            )}
                            <div className="flex justify-between gap-3">
                                <dt className="text-gray-500">{isEs ? 'Versión' : 'Version'}</dt>
                                <dd className="font-mono text-gray-800 text-right">{VERSION}</dd>
                            </div>
                            {builtLabel && (
                                <div className="flex justify-between gap-3">
                                    <dt className="text-gray-500">{isEs ? 'Compilado' : 'Built'}</dt>
                                    <dd className="text-gray-800 text-right">{builtLabel}</dd>
                                </div>
                            )}
                        </dl>
                        <button onClick={() => forceRefresh()}
                            className="w-full py-2 rounded-lg bg-mint-700 text-white text-sm font-bold hover:bg-mint-800">
                            🔄 {isEs ? 'Refrescar ahora' : 'Refresh now'}
                        </button>
                        <p className="text-[10px] text-gray-400 text-center">
                            {isEs
                                ? 'Si los cambios recientes no aparecen, refrescar fuerza la versión más nueva.'
                                : 'If recent changes don\'t appear, refresh forces the newest version.'}
                        </p>
                    </div>
                </div>
            )}
        </>
    );
}
