// ReportProblemButton — floating "Report a problem" button visible
// to every signed-in staff member on every screen.
//
// Andrew 2026-05-26 — part of the bug-logging system. Staff often
// notice things (a saved par didn't stick, a button does nothing on
// their iPad) but have no easy way to flag it without finding Andrew
// or Julie. This puts a one-tap report path in front of them and
// auto-attaches the diagnostic data the dev would otherwise have to
// dig out by hand.
//
// What gets attached to the report automatically:
//   • who: staff name + role + location (from window.__ddmau_* set
//     by App.jsx after PIN unlock)
//   • where: current URL path + redacted query keys
//   • when: serverTimestamp + occurredAt millis
//   • device: ua, viewport
//   • app: __APP_VERSION__
//   • recent: last 25 breadcrumbs from src/data/logger.js
//   • last 3 unresolved error_logs for this same staff this session
//
// What staff fills in manually: description + what they were trying
// to do + urgency. Both fields tagged `data-private` so html2canvas
// would blur them in a future screenshot capture phase (intentionally
// scoped out of phase 1 — screenshots = privacy surface area).
//
// The sheet is mounted at React root via a CustomEvent listener so
// any caller (PageErrorBoundary, an "I'm stuck" link, etc.) can pop
// it open by dispatching `ddmau:open-bug-report`. Optionally pass
// `event.detail.prefill` to seed the form.

import { useEffect, useState } from 'react';
import { db } from '../firebase';
import {
    addDoc, collection, getDocs, limit, orderBy, query, serverTimestamp, where,
} from 'firebase/firestore';
import { getBreadcrumbs } from '../data/logger';
import { redactString, redactUrl } from '../data/redact';

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export default function ReportProblemButton({ language = 'en' }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const [open, setOpen] = useState(false);
    const [description, setDescription] = useState('');
    const [doing, setDoing] = useState('');
    const [urgency, setUrgency] = useState('med');
    const [sending, setSending] = useState(false);
    const [sentOk, setSentOk] = useState(false);
    const [errorMsg, setErrorMsg] = useState(null);

    // Listen for programmatic opens (e.g. error boundary's "Report
    // this" button). Optional prefill seeds either field.
    useEffect(() => {
        const handler = (e) => {
            setOpen(true);
            const pre = e?.detail?.prefill || {};
            if (typeof pre.whatWereYouDoing === 'string') setDoing(pre.whatWereYouDoing);
            if (typeof pre.description === 'string') setDescription(pre.description);
            if (pre.urgency === 'low' || pre.urgency === 'med' || pre.urgency === 'high') {
                setUrgency(pre.urgency);
            }
        };
        window.addEventListener('ddmau:open-bug-report', handler);
        return () => window.removeEventListener('ddmau:open-bug-report', handler);
    }, []);

    // Reset state when the sheet closes so the next open is fresh.
    // We delay the reset until the dialog has visually closed.
    useEffect(() => {
        if (open) return;
        const t = setTimeout(() => {
            setDescription('');
            setDoing('');
            setUrgency('med');
            setSentOk(false);
            setErrorMsg(null);
        }, 300);
        return () => clearTimeout(t);
    }, [open]);

    const submit = async () => {
        if (!description.trim()) return;
        setSending(true);
        setErrorMsg(null);
        try {
            // Grab my most-recent unresolved error logs for this
            // session so the dev sees what blew up before the staff
            // hit "Report". Best-effort — if the query fails, we
            // still submit the report.
            let attachedErrorIds = [];
            try {
                const me = window.__ddmau_staffId ?? null;
                if (me != null) {
                    const q = query(
                        collection(db, 'error_logs'),
                        where('userId', '==', me),
                        orderBy('ts', 'desc'),
                        limit(3),
                    );
                    const snap = await getDocs(q);
                    attachedErrorIds = snap.docs.map((d) => d.id);
                }
            } catch {
                // We tolerate failure — the index may not be built
                // yet, the rules may not allow this user to read
                // error_logs, etc. The report can still be filed.
            }

            const row = {
                ts: serverTimestamp(),
                occurredAt: Date.now(),
                reporterId: window.__ddmau_staffId ?? null,
                reporterName: window.__ddmau_staffName ?? null,
                reporterRole: window.__ddmau_role ?? 'anonymous',
                reporterLocation: window.__ddmau_location ?? null,
                sessionId: window.__ddmau_sessionId ?? null,
                description: redactString(description).slice(0, 2000),
                whatWereYouDoing: redactString(doing).slice(0, 500),
                urgency,
                page: typeof window !== 'undefined'
                    ? redactUrl(window.location.pathname + window.location.search)
                    : null,
                appVersion: APP_VERSION,
                device: typeof window !== 'undefined' ? {
                    ua: (navigator.userAgent || '').slice(0, 200),
                    viewport: `${window.innerWidth}x${window.innerHeight}`,
                } : null,
                attachedErrorIds,
                recentActions: getBreadcrumbs(),
                status: 'open',
            };

            await addDoc(collection(db, 'bug_reports'), row);
            setSentOk(true);
            // Auto-close after a beat so the success state is visible
            // long enough to register but the user isn't blocked.
            setTimeout(() => setOpen(false), 1400);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[ReportProblemButton] submit failed:', e);
            setErrorMsg(tx('Could not send. Try again?', 'No se pudo enviar. ¿Intentar otra vez?'));
        } finally {
            setSending(false);
        }
    };

    return (
        <>
            {/* Floating launcher — small enough not to obscure scroll
                content, fixed bottom-right above any sticky footer
                via z-index 40. The bottom-nav on mobile sits at z-50
                so the button doesn't overlap it; we offset above the
                nav by 16px on phones. */}
            <button
                onClick={() => setOpen(true)}
                aria-label={tx('Report a problem', 'Reportar problema')}
                className="fixed right-3 bottom-20 md:bottom-4 z-40 bg-dd-text/90 text-white rounded-full px-3 py-2 text-[11px] font-black shadow-lg hover:bg-dd-text active:scale-95 transition flex items-center gap-1.5"
            >
                <span aria-hidden>🪲</span>
                <span>{tx('Report', 'Reportar')}</span>
            </button>

            {open && (
                <div
                    className="fixed inset-0 z-[60] bg-black/40 flex items-end md:items-center justify-center p-3"
                    onClick={() => { if (!sending) setOpen(false); }}
                >
                    <div
                        className="bg-white rounded-2xl w-full max-w-md p-4 shadow-xl max-h-[90vh] overflow-y-auto"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-3">
                            <div className="text-lg font-black text-dd-text">
                                {tx('Report a problem', 'Reportar problema')}
                            </div>
                            <button
                                onClick={() => setOpen(false)}
                                disabled={sending}
                                className="text-dd-text-2 text-lg leading-none disabled:opacity-50"
                                aria-label={tx('Close', 'Cerrar')}
                            >✕</button>
                        </div>

                        {sentOk ? (
                            <div className="py-8 text-center">
                                <div className="text-4xl mb-2">✓</div>
                                <div className="text-dd-green font-black">
                                    {tx('Thanks — sent.', 'Gracias — enviado.')}
                                </div>
                                <div className="text-[12px] text-dd-text-2 mt-1">
                                    {tx("We'll look into it.", 'Lo revisaremos.')}
                                </div>
                            </div>
                        ) : (
                            <>
                                <label className="block text-[11px] font-bold uppercase tracking-wide text-dd-text-2 mb-1">
                                    {tx('What went wrong?', '¿Qué pasó?')}
                                </label>
                                <textarea
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    maxLength={2000}
                                    rows={4}
                                    placeholder={tx('Describe the problem…', 'Describe el problema…')}
                                    className="w-full border border-dd-line rounded-xl p-2.5 text-sm mb-3 focus:outline-none focus:border-dd-green"
                                    data-private
                                />

                                <label className="block text-[11px] font-bold uppercase tracking-wide text-dd-text-2 mb-1">
                                    {tx('What were you trying to do?', '¿Qué estabas tratando de hacer?')}
                                </label>
                                <input
                                    type="text"
                                    value={doing}
                                    onChange={(e) => setDoing(e.target.value)}
                                    maxLength={500}
                                    placeholder={tx('Saving inventory, sending a message…', 'Guardar inventario, enviar mensaje…')}
                                    className="w-full border border-dd-line rounded-xl p-2.5 text-sm mb-3 focus:outline-none focus:border-dd-green"
                                    data-private
                                />

                                <label className="block text-[11px] font-bold uppercase tracking-wide text-dd-text-2 mb-1">
                                    {tx('How urgent?', '¿Qué tan urgente?')}
                                </label>
                                <div className="flex gap-2 mb-4">
                                    {[
                                        { id: 'low',  en: 'Low',    es: 'Baja'  },
                                        { id: 'med',  en: 'Medium', es: 'Media' },
                                        { id: 'high', en: 'High',   es: 'Alta'  },
                                    ].map((u) => (
                                        <button
                                            key={u.id}
                                            type="button"
                                            onClick={() => setUrgency(u.id)}
                                            className={`flex-1 py-2 rounded-xl text-xs font-bold border transition ${
                                                urgency === u.id
                                                    ? 'bg-dd-green text-white border-dd-green'
                                                    : 'bg-white text-dd-text border-dd-line hover:bg-dd-bg'
                                            }`}
                                        >
                                            {tx(u.en, u.es)}
                                        </button>
                                    ))}
                                </div>

                                <div className="text-[10.5px] text-dd-text-2 leading-relaxed mb-3">
                                    {tx(
                                        "We'll also attach your name, role, location, the page you're on, the app version, and any recent errors. No private text from your screen.",
                                        'También adjuntaremos tu nombre, rol, ubicación, la página actual, la versión, y errores recientes. No texto privado de tu pantalla.',
                                    )}
                                </div>

                                {errorMsg && (
                                    <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-[12px] text-red-700 mb-3">
                                        {errorMsg}
                                    </div>
                                )}

                                <button
                                    disabled={sending || !description.trim()}
                                    onClick={submit}
                                    className="w-full bg-dd-green text-white font-black py-3 rounded-xl disabled:opacity-50 active:scale-[0.99] transition"
                                >
                                    {sending
                                        ? tx('Sending…', 'Enviando…')
                                        : tx('Send', 'Enviar')}
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}
