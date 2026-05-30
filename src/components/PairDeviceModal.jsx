// PairDeviceModal — admin-side counterpart of PairDevicePage.
//
// Opens from the "Pair Device" button on MenuScreensPage. Walks
// the admin through the three states of pairing:
//
//   1. SHOW CODE          — generates a 6-digit code, displays it
//                           BIG so the admin can read it out to
//                           whoever's at the Pi. Subscribes to the
//                           code doc so the modal flips to step 2
//                           automatically when the Pi claims it.
//   2. ASSIGN TV          — Pi has claimed; admin picks which tvId
//                           this Pi should display. Existing
//                           configured screens shown in a list;
//                           "Use the default for <location>" is the
//                           fallback option if they haven't built
//                           a custom config yet.
//   3. DONE               — admin clicked Confirm; Pi is mid-redirect
//                           to /?tv=<tvId>. Modal shows a success
//                           state with a "Pair another" button.
//
// Cancel at any step deletes the code doc so it doesn't linger
// (helps audit replay and prevents code reuse).

import { useEffect, useMemo, useState } from 'react';
import {
    createPairingCode, formatPairingCode, subscribePairingCode,
    assignTvIdToCode, cancelPairingCode, PAIRING_TTL_MS,
} from '../data/devicePairing';
import ModalPortal from './ModalPortal';

const LOC_LABEL = { webster: 'Webster', maryland: 'MD Heights' };

export default function PairDeviceModal({ language = 'en', staffName, configs = [], heartbeats = {}, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [step, setStep]           = useState('loading'); // loading|show|assign|done|error
    const [code, setCode]           = useState(null);
    const [doc, setDoc]             = useState(null);      // live subscription data
    const [error, setError]         = useState(null);
    const [secondsLeft, setSecondsLeft] = useState(PAIRING_TTL_MS / 1000);
    const [selectedTvId, setSelectedTvId] = useState('');
    const [assigning, setAssigning] = useState(false);

    // Generate the code on mount. We do this synchronously up-front
    // so the admin doesn't see a stale-cached "previous code" flash.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { code: c } = await createPairingCode({ byName: staffName });
                if (cancelled) return;
                setCode(c);
                setStep('show');
            } catch (e) {
                if (cancelled) return;
                setError(e?.message || 'Could not generate code');
                setStep('error');
            }
        })();
        return () => { cancelled = true; };
    }, [staffName]);

    // Live subscription — fires when the Pi claims the code, and
    // again when admin clicks Confirm (we both write the same doc).
    useEffect(() => {
        if (!code) return;
        const unsub = subscribePairingCode(code, (data) => {
            setDoc(data);
            if (data?.claimedAt && step === 'show') {
                setStep('assign');
            }
        });
        return unsub;
    }, [code, step]);

    // 10-minute countdown so the admin can see how much time the
    // person at the Pi has. Updates once per second.
    useEffect(() => {
        if (!code || step === 'done') return;
        const id = setInterval(() => setSecondsLeft(s => Math.max(0, s - 1)), 1000);
        return () => clearInterval(id);
    }, [code, step]);

    // Close handler — cancel the code on the way out so an
    // abandoned modal doesn't leave a live code in Firestore.
    function handleClose() {
        if (code && step !== 'done') cancelPairingCode({ code }).catch(() => {});
        onClose?.();
    }

    async function handleAssign() {
        if (!code || !selectedTvId) return;
        setAssigning(true);
        try {
            await assignTvIdToCode({ code, tvId: selectedTvId, byName: staffName });
            setStep('done');
        } catch (e) {
            setError(e?.message || 'Failed to assign');
        } finally {
            setAssigning(false);
        }
    }

    // Synthesize the choice list: existing configured TVs (with
    // optional live-status badges) + the two reserved defaults.
    // We pull configs + heartbeats from the parent so the modal
    // doesn't duplicate the subscription.
    const tvOptions = useMemo(() => {
        const seen = new Set();
        const out = [];
        for (const c of configs || []) {
            seen.add(c.tvId);
            out.push({
                tvId: c.tvId,
                label: c.label || c.tvId,
                location: c.location || 'webster',
                hb: heartbeats[c.tvId] || null,
                isDefault: false,
            });
        }
        for (const loc of ['webster', 'maryland']) {
            if (!seen.has(loc)) {
                out.push({
                    tvId: loc,
                    label: `${LOC_LABEL[loc]} default menu`,
                    location: loc,
                    hb: heartbeats[loc] || null,
                    isDefault: true,
                });
            }
        }
        return out;
    }, [configs, heartbeats]);

    // ── Render ────────────────────────────────────────────────
    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4" onClick={handleClose}>
            <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-dd-line">
                    <div>
                        <h2 className="text-lg font-black text-dd-text">
                            🔗 {tx('Pair a TV', 'Vincular un TV')}
                        </h2>
                        <p className="text-[11px] text-dd-text-2 mt-0.5">
                            {step === 'show'    && tx('Read the code to the person at the Pi.', 'Léele el código a quien está en el Pi.')}
                            {step === 'assign'  && tx("Pi connected. Pick which menu it should display.", 'Pi conectado. Elige qué menú debe mostrar.')}
                            {step === 'done'    && tx('Paired! The TV is loading its menu now.', '¡Vinculado! El TV está cargando su menú.')}
                            {step === 'loading' && tx('Generating code…', 'Generando código…')}
                            {step === 'error'   && tx('Something went wrong.', 'Algo falló.')}
                        </p>
                    </div>
                    <button onClick={handleClose}
                        className="w-8 h-8 rounded-full hover:bg-dd-bg text-dd-text-2 text-lg font-bold shrink-0">
                        ×
                    </button>
                </div>

                {/* Body — branches by step */}
                <div className="px-5 py-5">
                    {step === 'loading' && (
                        <div className="text-center text-sm text-dd-text-2 py-8 italic">
                            {tx('Generating…', 'Generando…')}
                        </div>
                    )}

                    {step === 'error' && (
                        <div className="text-center py-6">
                            <div className="text-4xl mb-2">⚠️</div>
                            <p className="text-sm text-red-700 font-bold">{error}</p>
                            <button onClick={handleClose} className="mt-4 px-4 py-2 rounded-lg bg-dd-bg text-dd-text text-sm font-bold border border-dd-line">
                                {tx('Close', 'Cerrar')}
                            </button>
                        </div>
                    )}

                    {step === 'show' && code && (
                        <div className="text-center">
                            <div className="text-[11px] uppercase tracking-widest font-black text-dd-text-2 mb-2">
                                {tx('Pairing code', 'Código de vinculación')}
                            </div>
                            <div className="text-5xl md:text-6xl font-black tabular-nums tracking-widest text-dd-green leading-none">
                                {formatPairingCode(code)}
                            </div>
                            <p className="text-sm text-dd-text-2 mt-4 max-w-md mx-auto leading-relaxed">
                                {tx(
                                    'On the Pi, open ',
                                    'En el Pi, abre ',
                                )}
                                <span className="font-mono font-bold text-dd-text">app.ddmaustl.com/?pair=1</span>
                                {tx(' and type this code.', ' y escribe este código.')}
                            </p>
                            <div className="mt-5 inline-flex items-center gap-1.5 text-xs font-bold text-dd-text-2 bg-dd-bg border border-dd-line rounded-full px-3 py-1.5">
                                <span>⏳</span>
                                {tx('Expires in', 'Expira en')} {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
                            </div>
                            <div className="mt-5 text-[11px] text-dd-text-2 italic">
                                {tx('Waiting for device…', 'Esperando dispositivo…')}
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-dd-green ml-2 animate-pulse" />
                            </div>
                        </div>
                    )}

                    {step === 'assign' && (
                        <>
                            <div className="text-xs text-dd-text-2 mb-2">
                                {tx('Device:', 'Dispositivo:')} <span className="font-mono text-dd-text break-all">{shortenUA(doc?.claimedByUserAgent)}</span>
                            </div>
                            <div className="text-sm font-bold text-dd-text mb-2">
                                {tx('Pick a screen to assign:', 'Elige una pantalla para asignar:')}
                            </div>
                            <div className="space-y-1.5 max-h-[40vh] overflow-y-auto pr-1">
                                {tvOptions.map(o => {
                                    const active = selectedTvId === o.tvId;
                                    return (
                                        <button key={o.tvId} onClick={() => setSelectedTvId(o.tvId)}
                                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition ${
                                                active
                                                    ? 'bg-dd-sage-50 border-dd-green'
                                                    : 'bg-white border-dd-line hover:bg-dd-bg'
                                            }`}>
                                            <span className={`w-3 h-3 rounded-full border ${active ? 'bg-dd-green border-dd-green' : 'border-dd-line'}`} />
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-black text-dd-text truncate">{o.label}</div>
                                                <div className="text-[11px] text-dd-text-2">
                                                    {LOC_LABEL[o.location] || o.location} · <span className="font-mono">{o.tvId}</span>
                                                    {o.isDefault && ` · ${tx('default', 'predeterminado')}`}
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                            <button onClick={handleAssign}
                                disabled={!selectedTvId || assigning}
                                className="w-full mt-4 py-3 rounded-xl bg-dd-green text-white text-base font-black disabled:opacity-50 disabled:cursor-not-allowed shadow active:scale-95 transition">
                                {assigning
                                    ? tx('Assigning…', 'Asignando…')
                                    : tx('Confirm → send menu to this TV', 'Confirmar → enviar menú a este TV')}
                            </button>
                        </>
                    )}

                    {step === 'done' && (
                        <div className="text-center py-6">
                            <div className="text-5xl mb-2">🎉</div>
                            <div className="text-lg font-black text-dd-text mb-1">
                                {tx('TV paired', 'TV vinculado')}
                            </div>
                            <p className="text-sm text-dd-text-2 mb-5">
                                {tx(
                                    "The Pi is loading its menu now. You'll see it appear as a Live card in the dashboard within a minute.",
                                    'El Pi está cargando su menú. Aparecerá como tarjeta en vivo en el panel en un minuto.',
                                )}
                            </p>
                            <button onClick={onClose}
                                className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold shadow">
                                {tx('Done', 'Listo')}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// Shortens a UA string to something human-readable for the
// "device connected" line. Recognizes the most common Pi browsers
// (Chromium, Firefox) and falls back to the first 60 chars.
function shortenUA(ua) {
    if (!ua) return 'unknown device';
    const s = String(ua);
    const chromiumM = /Chrom(?:e|ium)\/(\d+)/.exec(s);
    if (chromiumM) {
        const isPi = /armv|aarch64|Linux arm/i.test(s);
        return `Chromium ${chromiumM[1]}${isPi ? ' · Raspberry Pi' : ''}`;
    }
    if (/Firefox\//.test(s)) return s.match(/Firefox\/[\d.]+/)?.[0] || 'Firefox';
    return s.slice(0, 60);
}
