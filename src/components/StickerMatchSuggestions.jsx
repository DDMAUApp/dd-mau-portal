// StickerMatchSuggestions — "we already have this sticker" list shown under
// any box where a cook types a NEW sticker name (Custom Print, + Add item).
// Andrew 2026-09-23: the custom input doubles as a search bar so staff pick
// the real sticker (with its use-by date + allergens) instead of a duplicate.
// Pure presentation — matching lives in data/stickerMatch.js.

import { memo } from 'react';

function StickerMatchSuggestions({ matches, isEs, onPick, onDismiss, pickLabel }) {
    if (!matches || matches.length === 0) return null;
    const tx = (en, es) => (isEs ? es : en);
    const anyExact = matches.some(m => m.exact);
    return (
        <div className="mt-2 rounded-xl border-2 border-amber-300 bg-amber-50 p-2" role="region"
            aria-label={tx('Existing stickers', 'Etiquetas existentes')}>
            <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-[11px] font-black text-amber-900">
                    {anyExact
                        ? tx('🔎 We already have this sticker', '🔎 Ya tenemos esta etiqueta')
                        : tx('🔎 Existing stickers', '🔎 Etiquetas existentes')}
                </span>
                {onDismiss && (
                    <button type="button" onClick={onDismiss}
                        className="text-[11px] font-bold text-amber-800 underline">
                        {tx('Keep my custom', 'Usar la mía')}
                    </button>
                )}
            </div>
            <div className="space-y-1">
                {matches.map(({ row, exact }) => {
                    const name = (isEs ? (row.nameEs || row.nameEn) : row.nameEn) || row.nameEs || '';
                    const cat = isEs ? (row.categoryEs || row.category) : row.category;
                    return (
                        <button key={row.id} type="button" onClick={() => onPick(row)}
                            className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-left active:scale-[0.99] transition ${exact
                                ? 'bg-white border-2 border-amber-500 shadow-sm'
                                : 'bg-white/80 border border-amber-200 hover:bg-white'}`}>
                            <span className="min-w-0">
                                <span className="block text-sm font-bold text-dd-text truncate">{name}</span>
                                {cat && <span className="block text-[10.5px] text-dd-text-2 truncate">{cat}</span>}
                            </span>
                            <span className="flex-shrink-0 px-2 py-1 rounded-full bg-amber-500 text-white text-[11px] font-black">
                                {pickLabel || tx('Use this →', 'Usar →')}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export default memo(StickerMatchSuggestions);
