// TvTemplatesModal — gallery picker for starting a new TV config
// from one of the templates in src/data/tvTemplates.js.
//
// Andrew 2026-05-23 audit follow-up. The "Templates" button on
// MenuScreensPage was a disabled placeholder; this modal completes
// it. Same UX pattern as Yodeck / OptiSigns / Raydiant: pick the
// kind of screen you want, name it, point it at a location, and
// land in the editor ready to customize.
//
// Flow:
//   1. Gallery — 8 templates as cards (icon, name, description).
//      Tap one → step 2.
//   2. Name + location — auto-suggests a label like "Webster Food",
//      lets admin tweak.
//   3. Create — calls saveTvConfig with the template payload +
//      label + location. The saveTvConfig auto-generates the tvId
//      from the label, so the result has a sensible slug like
//      "webster-food".
//   4. Open editor — dispatches the same `ddmau:openTvEditor`
//      event the dashboard's Edit buttons use, so the admin lands
//      straight in the editor to fine-tune photos, dayparts, etc.

import { useEffect, useMemo, useState } from 'react';
import { TV_TEMPLATES } from '../data/tvTemplates';
import { saveTvConfig, makeTvId } from '../data/tvConfigs';
import ModalPortal from './ModalPortal';

const LOC_LABEL = { webster: 'Webster', maryland: 'MD Heights' };

export default function TvTemplatesModal({
    language = 'en', staffName, defaultLocation = 'webster', existingTvIds = [], onClose,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [step, setStep]         = useState('pick');     // pick | name | creating | error
    const [chosen, setChosen]     = useState(null);
    const [label, setLabel]       = useState('');
    const [location, setLocation] = useState(defaultLocation === 'maryland' ? 'maryland' : 'webster');
    const [error, setError]       = useState(null);

    // When admin picks a template, seed the label with a sensible
    // default ("Webster Food") so they can hit Create immediately
    // if they don't care about the name.
    function pickTemplate(t) {
        setChosen(t);
        setLabel(`${LOC_LABEL[location] || ''} ${t.labelPrefix}`.trim());
        setStep('name');
    }

    // Compute the would-be tvId so we can show "this becomes
    // /?tv=<slug>" inline and warn on collisions. Pure derivation
    // from the current label + location.
    const proposedTvId = useMemo(() => {
        if (!label.trim()) return '';
        return makeTvId(label, location);
    }, [label, location]);

    const collision = !!proposedTvId && existingTvIds.includes(proposedTvId);

    async function handleCreate() {
        if (!chosen || !label.trim() || collision) return;
        setStep('creating');
        setError(null);
        try {
            const finalId = proposedTvId || makeTvId(label, location);
            const payload = {
                ...chosen.payload,
                label: label.trim(),
                location,
            };
            await saveTvConfig({ tvId: finalId, payload, byName: staffName });
            // Jump straight into the editor for this new config —
            // mirrors the "Edit" button pattern on dashboard cards.
            try {
                window.dispatchEvent(new CustomEvent('ddmau:openTvEditor', {
                    detail: { tvId: finalId, presetLocation: location },
                }));
            } catch {}
            onClose?.();
        } catch (e) {
            setError(e?.message || 'Save failed');
            setStep('name');
        }
    }

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4" onClick={onClose}>
            <div className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-dd-line shrink-0">
                    <div>
                        <h2 className="text-lg font-black text-dd-text">
                            🎨 {tx('Pick a template', 'Elige una plantilla')}
                        </h2>
                        <p className="text-[11px] text-dd-text-2 mt-0.5">
                            {step === 'pick' && tx('Start a new TV menu screen from one of these starting points.', 'Crea una nueva pantalla a partir de uno de estos puntos de partida.')}
                            {step === 'name' && tx('Name your screen and pick a location.', 'Nombra tu pantalla y elige un local.')}
                            {step === 'creating' && tx('Creating…', 'Creando…')}
                        </p>
                    </div>
                    <button onClick={onClose}
                        className="w-8 h-8 rounded-full hover:bg-dd-bg text-dd-text-2 text-lg font-bold shrink-0">×</button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-5 py-4">
                    {step === 'pick' && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {TV_TEMPLATES.map(t => (
                                <button key={t.id} onClick={() => pickTemplate(t)}
                                    className="text-left p-3 rounded-xl border border-dd-line hover:border-dd-green hover:bg-dd-sage-50/40 transition group">
                                    <div className="flex items-start gap-3">
                                        <span className="text-3xl shrink-0 leading-none">{t.icon}</span>
                                        <div className="min-w-0 flex-1">
                                            <div className="text-sm font-black text-dd-text">
                                                {isEs && t.nameEs ? t.nameEs : t.name}
                                            </div>
                                            <div className="text-[11.5px] text-dd-text-2 mt-0.5 leading-relaxed">
                                                {isEs && t.descriptionEs ? t.descriptionEs : t.description}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="mt-2 text-[10px] font-bold text-dd-text-2/70 uppercase tracking-widest">
                                        {(t.payload?.mode || 'menu').toUpperCase()}
                                        {t.payload?.layout && ` · ${t.payload.layout.toUpperCase()}`}
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}

                    {step === 'name' && chosen && (
                        <div className="space-y-4">
                            <div className="flex items-center gap-3 bg-dd-sage-50/40 border border-dd-green/30 rounded-xl p-3">
                                <span className="text-3xl shrink-0 leading-none">{chosen.icon}</span>
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-black text-dd-text">
                                        {isEs && chosen.nameEs ? chosen.nameEs : chosen.name}
                                    </div>
                                    <div className="text-[11px] text-dd-text-2 mt-0.5 leading-relaxed">
                                        {isEs && chosen.descriptionEs ? chosen.descriptionEs : chosen.description}
                                    </div>
                                </div>
                                <button onClick={() => setStep('pick')}
                                    className="text-[11px] font-bold text-dd-text-2 hover:text-dd-text shrink-0">
                                    {tx('Change', 'Cambiar')}
                                </button>
                            </div>

                            <div>
                                <label className="text-[11px] font-black uppercase tracking-widest text-dd-text-2 block mb-1">
                                    {tx('Screen name', 'Nombre de la pantalla')}
                                </label>
                                <input type="text" value={label} onChange={(e) => setLabel(e.target.value)}
                                    placeholder={tx('e.g. Webster Front Counter', 'p.ej. Webster Mostrador')}
                                    autoFocus
                                    className="w-full px-3 py-2.5 rounded-lg bg-white border-2 border-dd-line focus:border-dd-green focus:outline-none text-sm" />
                                {proposedTvId && (
                                    <p className={`text-[11px] mt-1.5 font-mono ${collision ? 'text-red-700 font-bold' : 'text-dd-text-2'}`}>
                                        URL: <span className="text-dd-text">/?tv={proposedTvId}</span>
                                        {collision && <span> ⚠ {tx('this slug already exists — change the name', 'este slug ya existe — cambia el nombre')}</span>}
                                    </p>
                                )}
                            </div>

                            <div>
                                <label className="text-[11px] font-black uppercase tracking-widest text-dd-text-2 block mb-1">
                                    {tx('Location', 'Local')}
                                </label>
                                <div className="flex gap-2">
                                    {['webster', 'maryland'].map(loc => (
                                        <button key={loc} onClick={() => setLocation(loc)}
                                            className={`flex-1 py-2 rounded-lg text-sm font-bold border transition ${
                                                location === loc
                                                    ? 'bg-dd-green text-white border-dd-green'
                                                    : 'bg-white text-dd-text border-dd-line hover:bg-dd-bg'
                                            }`}>
                                            {LOC_LABEL[loc]}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {error && (
                                <p className="text-sm text-red-700 font-bold">⚠ {error}</p>
                            )}
                        </div>
                    )}

                    {step === 'creating' && (
                        <div className="text-center py-12">
                            <div className="text-5xl mb-2">⏳</div>
                            <p className="text-sm text-dd-text-2">{tx('Creating screen + opening editor…', 'Creando pantalla y abriendo editor…')}</p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t border-dd-line shrink-0 flex items-center justify-end gap-2">
                    {step === 'name' && (
                        <>
                            <button onClick={() => setStep('pick')}
                                className="px-3 py-2 rounded-lg bg-white border border-dd-line text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                                ← {tx('Back', 'Atrás')}
                            </button>
                            <button onClick={handleCreate}
                                disabled={!label.trim() || collision}
                                className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-dd-green-700">
                                {tx('Create + open editor', 'Crear y abrir editor')} →
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
