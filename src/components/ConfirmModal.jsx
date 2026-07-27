// ConfirmModal — reusable glass "are you sure?" dialog.
//
// Replaces the native browser `confirm()` everywhere a destructive or
// state-changing action would otherwise commit on a single tap. Native
// confirm() is janky on iOS PWA (renders with a "From dd-mau-staff-app"
// header that looks phishy), can't be styled, and disappears on a
// background tap on iOS Safari.
//
// Usage pattern — declarative state in the parent:
//
//   const [confirm, setConfirm] = useState(null);
//   // ... somewhere:
//   onClick={() => setConfirm({
//       title: 'Cancel offer?',
//       body: 'This puts the shift back on you. Staff who saw it will lose the invite.',
//       confirmLabel: 'Cancel offer',
//       tone: 'danger',                  // 'danger' | 'primary' | 'neutral'
//       onConfirm: () => doTheThing(),   // closing is automatic — we always
//                                        // call setConfirm(null) after onConfirm
//   })}
//
//   {confirm && (
//       <ConfirmModal
//           {...confirm}
//           onClose={() => setConfirm(null)}
//       />
//   )}
//
// Why state-driven rather than imperative (`await confirmGlass(...)`):
//   - React-friendly (no microtask wrapping)
//   - Easy to test
//   - The parent owns the action; we never "smuggle" callbacks across
//     async boundaries the way an imperative wrapper would
//
// Tone affects only the confirm button color:
//   - danger:  red (deletes, cancels, denies)
//   - primary: green (approves, takes, posts)
//   - neutral: blue (general "OK" actions)
//
// Always uses ModalPortal so the modal escapes any backdrop-filter
// containing-block in the page tree (the same root-cause we hit with
// every other modal — see ModalPortal.jsx comment).

import { useState } from 'react';
import ModalPortal from './ModalPortal';

const TONE_CLS = {
    danger:  'bg-red-600 hover:bg-red-700 text-white',
    primary: 'bg-dd-green hover:bg-dd-green-700 text-white',
    neutral: 'bg-blue-600 hover:bg-blue-700 text-white',
};

export default function ConfirmModal({
    title,
    body,
    confirmLabel,
    cancelLabel,
    tone = 'primary',
    onConfirm,
    onClose,
    busy = false,
    language = 'en',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // 2026-07-26 audit: almost no caller passes `busy`, so during a slow
    // onConfirm await the buttons stayed ARMED — the dialog looked frozen
    // and a second tap re-ran the action (double delete/notify). Track
    // in-flight state internally so every call site gets the disabled
    // buttons + "Working…" label for free. The `busy` prop still works.
    const [submitting, setSubmitting] = useState(false);
    const isBusy = busy || submitting;

    const handleConfirm = async () => {
        if (isBusy) return;
        setSubmitting(true);
        try {
            await onConfirm?.();
        } finally {
            // Always close, even if onConfirm threw — the caller is responsible
            // for surfacing the error via toast(). Leaving the modal open on
            // failure would be confusing ("did it work?").
            onClose?.();
        }
    };

    return (
        <ModalPortal>
            <div
                className="fixed inset-0 z-[70] bg-black/50 flex items-end md:items-center justify-center p-3"
                onClick={onClose}
                role="dialog"
                aria-modal="true"
            >
                <div
                    className="bg-white w-full md:max-w-sm md:rounded-2xl rounded-t-2xl shadow-xl flex flex-col max-h-[90vh]"
                    onClick={(e) => e.stopPropagation()}
                    style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
                >
                    {/* Mobile pull handle */}
                    <div className="md:hidden flex justify-center pt-2 pb-1">
                        <div className="w-10 h-1 bg-dd-line rounded-full" />
                    </div>

                    {/* Body */}
                    <div className="px-5 pt-4 pb-3 flex-1 overflow-y-auto">
                        <h2 className="text-base font-black text-dd-text mb-1.5">{title}</h2>
                        {body && (
                            <div className="text-sm text-dd-text-2 leading-relaxed whitespace-pre-line">
                                {body}
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="px-4 py-3 border-t border-dd-line flex items-center justify-end gap-2 shrink-0">
                        <button
                            onClick={onClose}
                            disabled={isBusy}
                            className="px-4 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg disabled:opacity-40 min-h-[44px]"
                        >
                            {cancelLabel || tx('Cancel', 'Cancelar')}
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={isBusy}
                            className={`px-4 py-2 rounded-full text-sm font-bold shadow-sm disabled:opacity-40 min-h-[44px] ${TONE_CLS[tone] || TONE_CLS.primary}`}
                        >
                            {isBusy ? tx('Working…', 'Procesando…') : (confirmLabel || tx('Confirm', 'Confirmar'))}
                        </button>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}
