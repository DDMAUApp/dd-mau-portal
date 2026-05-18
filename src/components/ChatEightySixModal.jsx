// ChatEightySixModal — compose an "86 alert" (item out of stock) from
// inside a chat thread.
//
// Flow:
//   1. Cook taps 🚫 in the composer → this modal opens
//   2. Type item name (autocompletes against the master inventory)
//   3. Pick a location if the viewer is multi-location; otherwise
//      it locks to their own location
//   4. Optional note ("running low for service tonight")
//   5. Submit → the parent handles:
//        a. Append item to /ops/86_{location}.items (so the
//           Eighty6Dashboard + sidebar pip + home tile all update)
//        b. Post an `eighty_six_alert` message to the current chat
//           (so the team gets the bubble + FCM push)
//        c. Fire postEightySixToChat() for FCM fan-out to on-duty
//           non-manager staff (managers already see the dashboard)
//
// The modal itself only collects user input — it doesn't write
// anything. Keeps Firestore + audit logic in one place (parent's
// handler) so we don't duplicate write paths.

import { useMemo, useState } from 'react';

export default function ChatEightySixModal({
    language = 'en', viewer, inventory = [], onClose, onPost, busy = false,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const [itemName, setItemName] = useState('');
    const [note, setNote] = useState('');
    // Default location: the viewer's. If they're 'both' / undefined,
    // make them pick (we don't guess — picking wrong floods the wrong
    // store's staff with a fake 86).
    const defaultLoc = (viewer?.location === 'webster' || viewer?.location === 'maryland')
        ? viewer.location
        : '';
    const [location, setLocation] = useState(defaultLoc);
    const canPickLocation = !defaultLoc || viewer?.location === 'both';

    // Tiny autocomplete — match against inventory master list. We
    // restrict to ~12 results so the dropdown stays thumb-sized on
    // mobile. Search is on lowercased substring of the name only;
    // accent-stripping isn't necessary here because inventory names
    // are stored canonical English (the bilingual `nameEs` is for
    // display, not for 86 matching).
    const suggestions = useMemo(() => {
        const q = itemName.trim().toLowerCase();
        if (!q || q.length < 2) return [];
        const out = [];
        for (const cat of (inventory || [])) {
            for (const it of (cat.items || [])) {
                const name = String(it.name || '').toLowerCase();
                const nameEs = String(it.nameEs || '').toLowerCase();
                if (name.includes(q) || nameEs.includes(q)) {
                    out.push(it.name);
                    if (out.length >= 12) return out;
                }
            }
        }
        return out;
    }, [inventory, itemName]);

    const canSubmit = itemName.trim().length > 0 && !!location && !busy;

    function submit() {
        if (!canSubmit) return;
        onPost?.({
            itemName: itemName.trim(),
            location,
            note: note.trim(),
        });
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
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between bg-red-50">
                    <div>
                        <h2 className="text-lg font-black text-red-900">🚫 {tx('86 — out of stock', '86 — sin existencia')}</h2>
                        <p className="text-[11px] text-red-800">{tx('Tell the team an item is out', 'Avisa al equipo que algo se acabó')}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-white/60 flex items-center justify-center">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ overscrollBehavior: 'contain' }}>
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Item', 'Artículo')}
                        </label>
                        <input
                            type="text"
                            value={itemName}
                            onChange={(e) => setItemName(e.target.value)}
                            autoFocus
                            placeholder={tx('e.g. Chicken Wings', 'p. ej. Alas de pollo')}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm font-bold focus:outline-none focus:ring-2 focus:ring-red-300"
                        />
                        {/* Autocomplete suggestions from master inventory. */}
                        {suggestions.length > 0 && (
                            <div className="mt-1 border border-dd-line rounded-lg max-h-40 overflow-y-auto bg-white">
                                {suggestions.map((s) => (
                                    <button
                                        key={s}
                                        type="button"
                                        onClick={() => setItemName(s)}
                                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-dd-bg border-b border-dd-line/40 last:border-0"
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {canPickLocation && (
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                {tx('Location', 'Ubicación')}
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <LocPill
                                    label="Webster"
                                    selected={location === 'webster'}
                                    onClick={() => setLocation('webster')}
                                />
                                <LocPill
                                    label="Maryland Heights"
                                    selected={location === 'maryland'}
                                    onClick={() => setLocation('maryland')}
                                />
                            </div>
                        </div>
                    )}

                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Note (optional)', 'Nota (opcional)')}
                        </label>
                        <input
                            type="text"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder={tx('Anything the team should know', 'Algo que el equipo deba saber')}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
                        />
                    </div>
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex items-center justify-between gap-3 shrink-0">
                    <button onClick={onClose} className="px-3 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={submit}
                        disabled={!canSubmit}
                        className="px-4 py-2 rounded-full bg-red-600 text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-red-700"
                    >
                        {busy ? tx('Posting…', 'Publicando…') : tx('🚫 Post 86', '🚫 Publicar 86')}
                    </button>
                </div>
            </div>
        </div>
    );
}

function LocPill({ label, selected, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`px-3 py-2 rounded-lg border-2 text-sm font-bold transition ${selected
                ? 'border-red-500 bg-red-50 text-red-900'
                : 'border-dd-line bg-white text-dd-text-2 hover:bg-dd-bg'}`}
        >
            {label}
        </button>
    );
}
