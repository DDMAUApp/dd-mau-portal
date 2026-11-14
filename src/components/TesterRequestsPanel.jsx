// Admin → Staff → Android testers (Andrew 2026-11-14).
// Lists the Google emails Android staffers typed into the lock-screen
// Install app sheet (/tester_requests). Copy one (or all waiting) → paste
// into Play Console → Testing → Closed testing → Testers → mark Added.
// See src/data/testerRequests.js for the data side.
import { useEffect, useMemo, useState } from 'react';
import { subscribeTesterRequests, setTesterRequestStatus, dedupeByEmail } from '../data/testerRequests';
import { openExternalUrl } from '../capacitor-bridge';
import { toast } from '../toast';

const PLAY_CONSOLE_URL = 'https://play.google.com/console';

function fmtWhen(ts, isEs) {
    const d = ts?.toDate ? ts.toDate() : null;
    if (!d) return '';
    return d.toLocaleString(isEs ? 'es' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function TesterRequestsPanel({ language = 'en', staffName = '' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [rows, setRows] = useState(null);
    const [tab, setTab] = useState('pending');
    const [busyId, setBusyId] = useState(null);

    useEffect(() => subscribeTesterRequests(setRows), []);

    const all = useMemo(() => dedupeByEmail(rows), [rows]);
    const pending = useMemo(() => all.filter((r) => (r.status || 'pending') === 'pending'), [all]);
    const handled = useMemo(() => all.filter((r) => (r.status || 'pending') !== 'pending'), [all]);
    const visible = tab === 'pending' ? pending : handled;

    const copy = async (text, label) => {
        try {
            await navigator.clipboard.writeText(text);
            toast(tx(`Copied ${label}`, `Copiado ${label}`), { duration: 2500 });
        } catch {
            toast(tx('Copy failed — long-press the email to copy', 'No se pudo copiar — mantén presionado el correo'), { kind: 'error' });
        }
    };

    const setStatus = async (row, status) => {
        if (busyId) return;
        setBusyId(row.id);
        try { await setTesterRequestStatus(row.id, status, staffName); }
        catch (e) {
            console.warn('setTesterRequestStatus failed:', e);
            toast(tx('Could not save — try again.', 'No se pudo guardar — intenta de nuevo.'), { kind: 'error' });
        } finally { setBusyId(null); }
    };

    return (
        <div className="glass-card p-4 mb-4">
            <div className="flex items-center gap-3 mb-1">
                <span className="glass-icon-tile tint-green shrink-0" aria-hidden="true">🤖</span>
                <div className="min-w-0">
                    <h3 className="text-headline text-dd-text">{tx('Android tester emails', 'Correos de probadores Android')}</h3>
                    <p className="text-caption-md text-dd-text-2">
                        {rows === null ? tx('Loading…', 'Cargando…')
                            : pending.length > 0
                                ? tx(`${pending.length} waiting to be added`, `${pending.length} por agregar`)
                                : tx('Nobody waiting', 'Nadie esperando')}
                    </p>
                </div>
            </div>
            <p className="text-caption-md text-dd-text-2 mt-2 leading-snug">
                {tx('Emails from the “Install app” button on the login screen. Copy them into Play Console → DD Mau Staff → Testing → Closed testing → Testers, then tap Added.',
                    'Correos del botón “Instalar app” en la pantalla de inicio. Cópialos en Play Console → DD Mau Staff → Pruebas → Prueba cerrada → Probadores, y toca Agregado.')}
            </p>

            <div className="flex flex-wrap items-center gap-2 mt-3">
                <div className="flex gap-1 bg-dd-bg/60 border border-dd-line rounded-glass-sm p-1">
                    <button type="button" onClick={() => setTab('pending')}
                        className={`px-3 py-1 rounded-sm text-xs font-bold transition ${tab === 'pending' ? 'bg-amber-500 text-white' : 'text-dd-text-2'}`}>
                        {tx('Waiting', 'Esperando')} ({pending.length})
                    </button>
                    <button type="button" onClick={() => setTab('handled')}
                        className={`px-3 py-1 rounded-sm text-xs font-bold transition ${tab === 'handled' ? 'bg-dd-green text-white' : 'text-dd-text-2'}`}>
                        {tx('Done', 'Hechos')} ({handled.length})
                    </button>
                </div>
                {pending.length > 1 && (
                    <button type="button" onClick={() => copy(pending.map((r) => r.email).join(', '), tx(`${pending.length} emails`, `${pending.length} correos`))}
                        className="text-xs px-3 py-1.5 rounded-lg bg-dd-bg border border-dd-line font-bold text-dd-text hover:bg-dd-sage-50">
                        📋 {tx('Copy all waiting', 'Copiar todos')}
                    </button>
                )}
                <button type="button" onClick={() => openExternalUrl(PLAY_CONSOLE_URL)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-dd-bg border border-dd-line font-bold text-cyan-700 hover:bg-dd-sage-50">
                    ↗ {tx('Open Play Console', 'Abrir Play Console')}
                </button>
            </div>

            <div className="space-y-2 mt-3">
                {rows !== null && visible.length === 0 ? (
                    <p className="text-footnote-md text-dd-text-2 text-center py-5">
                        {tab === 'pending' ? tx('No emails waiting — all clear.', 'No hay correos pendientes.') : tx('Nothing marked yet.', 'Nada marcado aún.')}
                    </p>
                ) : visible.map((r) => (
                    <div key={r.id} className="p-3 rounded-glass-md bg-white/60 border border-glass-border-light flex flex-wrap items-center gap-2">
                        <div className="flex-1 min-w-[12rem]">
                            <div className="text-body-md font-bold text-dd-text break-all select-all">{r.email}</div>
                            <div className="text-caption-md text-dd-text-2">
                                {fmtWhen(r.createdAt, isEs)}
                                {r.status === 'added' && ` · ✓ ${tx('added', 'agregado')}${r.handledBy ? ` ${tx('by', 'por')} ${r.handledBy}` : ''}`}
                                {r.status === 'dismissed' && ` · ${tx('dismissed', 'descartado')}${r.handledBy ? ` ${tx('by', 'por')} ${r.handledBy}` : ''}`}
                            </div>
                        </div>
                        <button type="button" onClick={() => copy(r.email, r.email)}
                            className="text-xs px-2.5 py-1.5 rounded-lg bg-dd-bg border border-dd-line font-bold text-dd-text hover:bg-dd-sage-50">
                            📋 {tx('Copy', 'Copiar')}
                        </button>
                        {tab === 'pending' ? (
                            <>
                                <button type="button" disabled={busyId === r.id} onClick={() => setStatus(r, 'added')}
                                    className="text-xs px-2.5 py-1.5 rounded-lg bg-dd-green text-white font-bold hover:bg-dd-green/90 disabled:opacity-60">
                                    ✓ {tx('Added', 'Agregado')}
                                </button>
                                <button type="button" disabled={busyId === r.id} onClick={() => setStatus(r, 'dismissed')}
                                    className="text-xs px-2.5 py-1.5 rounded-lg bg-gray-200 text-gray-700 font-bold hover:bg-gray-300 disabled:opacity-60">
                                    {tx('Dismiss', 'Descartar')}
                                </button>
                            </>
                        ) : (
                            <button type="button" disabled={busyId === r.id} onClick={() => setStatus(r, 'pending')}
                                className="text-xs px-2.5 py-1.5 rounded-lg bg-amber-100 text-amber-800 font-bold hover:bg-amber-200 disabled:opacity-60">
                                ↩ {tx('Move back', 'Regresar')}
                            </button>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
