// ChatPollModal — compose a poll message inside a chat.
//
// Workflow:
//   1. Composer "📊 Poll" button → opens this modal
//   2. Question + 2-6 options + multiSelect toggle + optional close time
//   3. Save → appends a message of type 'poll' with the poll payload inline
//
// The poll payload lives on the message itself (see chat.js's POLL_LIMITS
// + pollTally helpers). Voting is dot-path arrayUnion/arrayRemove against
// `poll.votes.<optionId>` — same atomic-writer pattern reactions use.
//
// Close behavior: a poll can be closed manually by the creator (or any
// admin) OR auto-close at the configured `closesAt`. Voting is gated
// client-side via isPollOpen(); the doc never auto-mutates — we just
// stop rendering vote buttons once the deadline lapses.

import { useState } from 'react';
import { POLL_LIMITS } from '../data/chat';

const PRESETS = [
    { key: 'none',   en: 'No deadline',  es: 'Sin fecha',   hours: 0 },
    { key: '1h',     en: '1 hour',       es: '1 hora',      hours: 1 },
    { key: '24h',    en: '24 hours',     es: '24 horas',    hours: 24 },
    { key: '3d',     en: '3 days',       es: '3 días',      hours: 72 },
    { key: '7d',     en: '7 days',       es: '7 días',      hours: 168 },
];

export default function ChatPollModal({
    language = 'en', chat, onClose, onCreate, busy = false,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const [question, setQuestion] = useState('');
    const [options, setOptions] = useState(['', '']);
    const [multiSelect, setMultiSelect] = useState(false);
    const [anonymous, setAnonymous] = useState(false);
    const [closeKey, setCloseKey] = useState('24h');

    function setOpt(i, v) {
        setOptions(opts => opts.map((o, j) => j === i ? v : o));
    }
    function addOption() {
        if (options.length >= POLL_LIMITS.maxOptions) return;
        setOptions(opts => [...opts, '']);
    }
    function removeOption(i) {
        if (options.length <= POLL_LIMITS.minOptions) return;
        setOptions(opts => opts.filter((_, j) => j !== i));
    }

    const trimmedOptions = options.map(o => o.trim()).filter(Boolean);
    const canSubmit = question.trim().length > 0
        && trimmedOptions.length >= POLL_LIMITS.minOptions
        && !busy;

    function handleSubmit() {
        if (!canSubmit) return;
        const preset = PRESETS.find(p => p.key === closeKey);
        const closesAt = preset && preset.hours > 0
            ? new Date(Date.now() + preset.hours * 3600_000)
            : null;
        // Build option list with deterministic ids — these are referenced
        // by `poll.votes.<id>` arrays, so stability matters.
        const payload = {
            question: question.trim().slice(0, POLL_LIMITS.maxQuestion),
            options: trimmedOptions.slice(0, POLL_LIMITS.maxOptions).map((label, i) => ({
                id: `opt_${i}`,
                label: label.slice(0, POLL_LIMITS.maxOption),
            })),
            multiSelect,
            anonymous,
            closesAt,
            closedAt: null,
            votes: {},
        };
        onCreate?.(payload);
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div
                className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl flex flex-col max-h-[92vh] shadow-xl"
                onClick={(e) => e.stopPropagation()}
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between safe-top">
                    <div>
                        <h2 className="text-lg font-black text-dd-text">📊 {tx('New poll', 'Nueva encuesta')}</h2>
                        <p className="text-[11px] text-dd-text-2">{tx('Ask the team a quick question', 'Haz una pregunta rápida al equipo')}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ overscrollBehavior: 'contain' }}>
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Question', 'Pregunta')}
                        </label>
                        <input
                            type="text"
                            value={question}
                            onChange={(e) => setQuestion(e.target.value)}
                            maxLength={POLL_LIMITS.maxQuestion}
                            autoFocus
                            placeholder={tx('Who can cover Saturday?', '¿Quién puede cubrir el sábado?')}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm font-bold focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                        />
                    </div>

                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Options', 'Opciones')}
                        </label>
                        <div className="space-y-1.5">
                            {options.map((opt, i) => (
                                <div key={i} className="flex items-center gap-1">
                                    <input
                                        type="text"
                                        value={opt}
                                        onChange={(e) => setOpt(i, e.target.value)}
                                        maxLength={POLL_LIMITS.maxOption}
                                        placeholder={`${tx('Option', 'Opción')} ${i + 1}`}
                                        className="flex-1 px-3 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                                    />
                                    {options.length > POLL_LIMITS.minOptions && (
                                        <button
                                            onClick={() => removeOption(i)}
                                            className="w-9 h-9 rounded-lg text-dd-text-2 hover:bg-dd-bg flex items-center justify-center shrink-0"
                                            aria-label={tx('Remove', 'Eliminar')}
                                        >
                                            ✕
                                        </button>
                                    )}
                                </div>
                            ))}
                            {options.length < POLL_LIMITS.maxOptions && (
                                <button
                                    onClick={addOption}
                                    className="w-full px-3 py-2 rounded-lg border border-dashed border-dd-line text-sm text-dd-text-2 hover:bg-dd-bg hover:text-dd-text transition"
                                >
                                    + {tx('Add option', 'Añadir opción')}
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dd-line cursor-pointer hover:bg-dd-bg">
                            <input
                                type="checkbox"
                                checked={multiSelect}
                                onChange={(e) => setMultiSelect(e.target.checked)}
                                className="accent-dd-green"
                            />
                            <span className="text-xs font-bold text-dd-text">
                                {tx('Multi-select', 'Múltiples')}
                            </span>
                        </label>
                        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dd-line cursor-pointer hover:bg-dd-bg">
                            <input
                                type="checkbox"
                                checked={anonymous}
                                onChange={(e) => setAnonymous(e.target.checked)}
                                className="accent-dd-green"
                            />
                            <span className="text-xs font-bold text-dd-text">
                                {tx('Anonymous', 'Anónimo')}
                            </span>
                        </label>
                    </div>

                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Closes in', 'Cierra en')}
                        </label>
                        <div className="grid grid-cols-5 gap-1">
                            {PRESETS.map(p => (
                                <button
                                    key={p.key}
                                    onClick={() => setCloseKey(p.key)}
                                    className={`px-1 py-2 rounded-lg text-[11px] font-bold border-2 transition ${closeKey === p.key
                                        ? 'border-dd-green bg-dd-sage-50 text-dd-green-700'
                                        : 'border-dd-line text-dd-text-2 hover:bg-dd-bg'}`}
                                >
                                    {isEs ? p.es : p.en}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex items-center justify-between gap-3 shrink-0">
                    <button onClick={onClose} className="px-3 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-dd-green-700"
                    >
                        {busy ? tx('Posting…', 'Publicando…') : tx('📊 Post Poll', '📊 Publicar')}
                    </button>
                </div>
            </div>
        </div>
    );
}
