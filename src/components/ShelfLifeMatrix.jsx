// ShelfLifeMatrix — bulk-edit the shelf life (days) of every date-sticker item
// in one table. Andrew 2026-06-27: "make a matrix to bulk edit the shelf life of
// the items — most of them were wrong." Each sticker item now carries its own
// shelfLifeDays (stickerListsOverride), and the date sticker auto-fills it, so
// this is the one place to fix them all at once. Admin-gated by the caller.
import { useEffect, useMemo, useState } from 'react';
import { X, Save, CalendarClock } from 'lucide-react';
import ModalPortal from './ModalPortal';
import { toast } from '../toast';
import { subscribeStickerLists, saveStickerList, STICKER_SECTIONS } from '../data/stickerListsOverride';

export default function ShelfLifeMatrix({ language = 'en', byName, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [lists, setLists] = useState(null);          // { sectionKey: rows[] }
    const [edits, setEdits] = useState({});            // { `${key}:${rowId}`: '5' }
    const [saving, setSaving] = useState(false);

    useEffect(() => subscribeStickerLists(setLists), []);

    const key = (sk, id) => `${sk}:${id}`;
    // Current value for a row = the in-progress edit, else its saved shelfLifeDays.
    const valueFor = (sk, row) => {
        const k = key(sk, row.id);
        if (k in edits) return edits[k];
        return row.shelfLifeDays != null ? String(row.shelfLifeDays) : '';
    };
    const setOne = (sk, id, v) => setEdits((e) => ({ ...e, [key(sk, id)]: v.replace(/[^0-9]/g, '').slice(0, 2) }));

    // "Set all in this section to N" — fills every row in the section.
    const setSection = (sk, rows, v) => {
        setEdits((e) => {
            const next = { ...e };
            for (const r of rows) next[key(sk, r.id)] = String(v);
            return next;
        });
    };

    const totals = useMemo(() => {
        if (!lists) return { items: 0, set: 0 };
        let items = 0, set = 0;
        for (const s of STICKER_SECTIONS) {
            const rows = lists[s.key] || [];
            for (const r of rows) {
                items++;
                if (valueFor(s.key, r) !== '') set++;
            }
        }
        return { items, set };
    }, [lists, edits]);

    const dirty = Object.keys(edits).length > 0;

    const saveAll = async () => {
        if (saving || !lists) return;
        // Only re-save sections that actually changed.
        const changedSections = new Set(Object.keys(edits).map((k) => k.split(':')[0]));
        if (changedSections.size === 0) { onClose?.(); return; }
        setSaving(true);
        try {
            for (const sk of changedSections) {
                const rows = (lists[sk] || []).map((r) => {
                    const v = valueFor(sk, r);
                    const n = v === '' ? null : Math.min(60, Math.max(1, parseInt(v, 10) || 0));
                    const row = { ...r };
                    if (n) row.shelfLifeDays = n; else delete row.shelfLifeDays;
                    return row;
                });
                // eslint-disable-next-line no-await-in-loop
                await saveStickerList(sk, rows, byName);
            }
            toast(tx('✓ Shelf lives saved', '✓ Vidas útiles guardadas'), { kind: 'success' });
            setEdits({});
            onClose?.();
        } catch (e) {
            console.warn('shelf life save failed:', e);
            toast(tx('Save failed — try again.', 'Error al guardar — inténtalo.'), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <ModalPortal onBackPress={onClose}>
            <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
                <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                    {/* Header */}
                    <div className="flex items-center gap-2 p-3 border-t-4 border-dd-green flex-shrink-0">
                        <CalendarClock size={20} className="text-dd-green-700" />
                        <div className="flex-1 min-w-0">
                            <h2 className="text-base font-black text-dd-text leading-tight">{tx('Shelf life table', 'Tabla de vida útil')}</h2>
                            <p className="text-[11px] text-dd-text-2">{tx(`${totals.set}/${totals.items} items set · days until use-by`, `${totals.set}/${totals.items} con valor · días hasta caducar`)}</p>
                        </div>
                        <button onClick={onClose} className="p-2 -m-1 text-dd-text-2 hover:text-dd-text"><X size={20} /></button>
                    </div>

                    {/* Body */}
                    <div className="flex-1 overflow-y-auto px-3 pb-2">
                        {!lists ? (
                            <p className="text-center text-sm text-dd-text-2 py-10">{tx('Loading…', 'Cargando…')}</p>
                        ) : STICKER_SECTIONS.map((s) => {
                            const rows = lists[s.key] || [];
                            if (rows.length === 0) return null;
                            return (
                                <div key={s.key} className="mb-3">
                                    <div className="flex items-center justify-between gap-2 sticky top-0 bg-white py-1.5 z-10">
                                        <span className="text-sm font-black text-dd-text">{isEs ? s.titleEs : s.titleEn}</span>
                                        <label className="flex items-center gap-1 text-[11px] text-dd-text-2">
                                            {tx('set all', 'todos a')}
                                            <input type="number" min="1" max="60" inputMode="numeric"
                                                onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 2); if (v) setSection(s.key, rows, v); }}
                                                placeholder="—"
                                                className="w-12 px-1.5 py-1 text-center rounded border border-dd-line text-sm" />
                                        </label>
                                    </div>
                                    <div className="divide-y divide-dd-line/60 rounded-lg border border-dd-line overflow-hidden">
                                        {rows.map((r) => (
                                            <div key={r.id} className="flex items-center gap-2 px-2.5 py-1.5 bg-white">
                                                <span className="flex-1 min-w-0 text-sm text-dd-text truncate">{r.nameEn || r.nameEs}</span>
                                                <input type="number" min="1" max="60" inputMode="numeric"
                                                    value={valueFor(s.key, r)}
                                                    onChange={(e) => setOne(s.key, r.id, e.target.value)}
                                                    placeholder={tx('def', 'pred')}
                                                    className="w-16 px-2 py-1.5 text-center text-base rounded-lg border border-dd-line tabular-nums focus:border-dd-green outline-none" />
                                                <span className="text-[11px] text-dd-text-2 w-7">{tx('days', 'días')}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                        <p className="text-[11px] text-dd-text-2 px-1 pb-2 leading-snug">
                            {tx('Blank = use the category default. These feed the date sticker’s use-by date automatically.',
                                'Vacío = usa el valor por defecto de la categoría. Alimentan la fecha de caducidad de la etiqueta automáticamente.')}
                        </p>
                    </div>

                    {/* Footer */}
                    <div className="border-t border-dd-line p-3 flex gap-2 flex-shrink-0 safe-bottom">
                        <button onClick={onClose} className="flex-1 py-2.5 rounded-lg bg-white border border-dd-line text-dd-text font-bold">{tx('Cancel', 'Cancelar')}</button>
                        <button onClick={saveAll} disabled={saving || !dirty}
                            className={`flex-1 py-2.5 rounded-lg font-black text-white inline-flex items-center justify-center gap-1.5 ${saving || !dirty ? 'bg-dd-text-2/40' : 'bg-dd-green active:scale-95'}`}>
                            <Save size={16} /> {saving ? tx('Saving…', 'Guardando…') : tx('Save all', 'Guardar todo')}
                        </button>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}
