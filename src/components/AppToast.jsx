// Renders the in-app toast queue from src/toast.js. Mount ONCE inside App.jsx.
// Visual: stack in the top-center on mobile, top-right on desktop. Tap to
// dismiss. Slides in, auto-fades. No layout shift — fixed-position overlay.

import { useEffect, useState } from 'react';
import { subscribeToasts, dismissToast } from '../toast';

const KIND_TONE = {
    success: 'bg-emerald-600 text-white border-emerald-700',
    error:   'bg-red-600 text-white border-red-700',
    warn:    'bg-amber-500 text-white border-amber-600',
    info:    'bg-gray-800 text-white border-gray-900',
};

const KIND_ICON = {
    success: '✓',
    error:   '⚠️',
    warn:    '⚠️',
    info:    'ℹ️',
};

export default function AppToast() {
    const [list, setList] = useState([]);
    useEffect(() => subscribeToasts(setList), []);

    if (list.length === 0) return null;
    return (
        <div
            // Higher z-index than the bottom nav (z-30) and the modal overlays
            // (z-50) so toasts always sit on top, including over the screen-blur
            // and PIN prompts.
            className="fixed top-3 left-1/2 -translate-x-1/2 sm:left-auto sm:right-3 sm:translate-x-0 z-[60] flex flex-col gap-2 max-w-[92vw] sm:max-w-sm w-full sm:w-auto pointer-events-none"
            role="region"
            aria-label="Notifications"
        >
            {list.map(t => (
                <button
                    key={t.id}
                    onClick={() => dismissToast(t.id)}
                    className={`pointer-events-auto rounded-xl border-2 px-4 py-3 shadow-lg text-left flex items-start gap-2 animate-toast-in ${KIND_TONE[t.kind] || KIND_TONE.info}`}
                    title="Tap to dismiss"
                >
                    <span className="text-base leading-none mt-0.5">{KIND_ICON[t.kind] || KIND_ICON.info}</span>
                    <span className="text-sm font-semibold whitespace-pre-line flex-1">{t.message}</span>
                </button>
            ))}
            <style>{`
                @keyframes toast-in {
                    from { opacity: 0; transform: translateY(-8px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
                .animate-toast-in { animation: toast-in 0.18s ease-out; }
            `}</style>
        </div>
    );
}
