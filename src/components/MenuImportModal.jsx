// MenuImportModal — upload a PDF/JPEG menu, AI extracts items,
// admin reviews and accepts to populate /menu_items overrides.
//
// Andrew 2026-05-20 Wave 2: "if the menu comes in as pdf or jpeg
// how can you make edits — build both [direct display + AI
// extraction]". This is the AI extraction half. The direct-display
// half is in TvConfigsEditor + MenuDisplay's image mode.
//
// ─── Flow ─────────────────────────────────────────────────────
//   1. Upload    — admin picks PDF/JPEG → menuImageUpload uploads
//                  pages to Storage, returns URLs.
//   2. Extract   — call aiExtractMenu Cloud Function with the URLs;
//                  Claude vision returns { categories: [...] }.
//   3. Review    — list extracted items grouped by category. Each
//                  row is editable + has a checkbox (default ON).
//                  Existing-MENU_DATA items show "Will update";
//                  new items show "Custom item".
//   4. Apply     — write each checked row as an override doc.

import { useState, useMemo } from 'react';
import { MENU_DATA } from '../data/menu';
import { uploadMenuFile } from '../data/menuImageUpload';
import { extractMenuFromImages } from '../data/aiExtractMenu';
import { saveMenuOverride, makeMenuItemSlug } from '../data/menuOverrides';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

export default function MenuImportModal({ language = 'en', byName, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // Stages: 'upload' → 'extracting' → 'review' → 'applying' → 'done'
    const [stage, setStage] = useState('upload');
    const [uploadedUrls, setUploadedUrls] = useState([]);
    const [extractedCategories, setExtractedCategories] = useState([]);
    const [progress, setProgress] = useState('');
    const [applyCount, setApplyCount] = useState({ done: 0, total: 0 });

    // Map: row key → row state. Each row: { nameEn, price, descEn,
    // spicy, vegan, glutenFree, popular, category, accepted }
    const [rows, setRows] = useState([]);

    // Slug → existing MENU_DATA category (so we know whether each
    // extracted item is an "update existing" vs "new custom").
    const existingByCategory = useMemo(() => {
        const map = new Map();
        for (const cat of MENU_DATA) {
            for (const it of (cat.items || [])) {
                map.set(makeMenuItemSlug(it.nameEn), cat.category);
            }
        }
        return map;
    }, []);

    // Set of MENU_DATA category names (so we can flag "category not
    // in MENU_DATA — will be auto-added").
    const existingCategoryNames = useMemo(() =>
        new Set(MENU_DATA.map(c => c.category)),
    []);

    const handleFilePick = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        if (file.size > 30 * 1024 * 1024) {
            toast(tx('File too large (max 30 MB).', 'Archivo muy grande.'), { kind: 'error' });
            return;
        }
        setStage('extracting');
        setProgress(tx('Uploading…', 'Subiendo…'));
        try {
            const urls = await uploadMenuFile({ file, folder: 'menu_imports', slugPrefix: 'import' });
            setUploadedUrls(urls);
            setProgress(tx(`Extracting from ${urls.length} page(s)…`, `Extrayendo de ${urls.length} página(s)…`));
            const result = await extractMenuFromImages({ imageUrls: urls });
            if (!result.categories.length) {
                toast(tx('No items found. Try a clearer image or PDF.', 'No se encontraron items.'), { kind: 'error' });
                setStage('upload');
                return;
            }
            // Flatten into row-shaped state with the existing-MENU_DATA
            // lookups precomputed.
            const flatRows = [];
            for (const cat of result.categories) {
                for (const it of (cat.items || [])) {
                    const slug = makeMenuItemSlug(it.nameEn);
                    const existsIn = existingByCategory.get(slug);
                    flatRows.push({
                        key: `${cat.category}::${slug}::${flatRows.length}`,
                        slug,
                        category: cat.category,
                        existsIn,
                        nameEn: it.nameEn,
                        price: it.price || '',
                        descEn: it.descEn || '',
                        spicy: it.spicy === true,
                        vegan: it.vegan === true,
                        glutenFree: it.glutenFree === true,
                        popular: it.popular === true,
                        accepted: true,    // default ON
                    });
                }
            }
            setRows(flatRows);
            setExtractedCategories(result.categories);
            setStage('review');
        } catch (err) {
            console.warn('extract failed:', err);
            toast(tx('Extract failed: ', 'Error al extraer: ') + (err?.message || ''), { kind: 'error' });
            setStage('upload');
        }
    };

    const updateRow = (key, patch) => {
        setRows(prev => prev.map(r => r.key === key ? { ...r, ...patch } : r));
    };

    const toggleAllInCategory = (cat, value) => {
        setRows(prev => prev.map(r => r.category === cat ? { ...r, accepted: value } : r));
    };

    const acceptedCount = rows.filter(r => r.accepted).length;

    const apply = async () => {
        const accepted = rows.filter(r => r.accepted);
        if (accepted.length === 0) {
            toast(tx('Select at least one item.', 'Selecciona al menos un item.'), { kind: 'error' });
            return;
        }
        const ok = window.confirm(tx(
            `Write ${accepted.length} items as menu overrides? You can still edit or restore-default each one afterwards.`,
            `¿Escribir ${accepted.length} items como cambios? Puedes editar o restaurar después.`,
        ));
        if (!ok) return;
        setStage('applying');
        setApplyCount({ done: 0, total: accepted.length });
        let done = 0;
        let failed = 0;
        for (const r of accepted) {
            try {
                // Decide: override existing item OR create custom item.
                // If a MENU_DATA item with the same slug exists in the
                // SAME category as the extracted row, treat it as an
                // override (price/desc edit). Otherwise mark isCustom.
                const isOverride = r.existsIn && r.existsIn === r.category;
                await saveMenuOverride({
                    slug: r.slug,
                    payload: {
                        slug: r.slug,
                        category: r.category,
                        isCustom: !isOverride,
                        nameEn: r.nameEn,
                        price: r.price || null,
                        descEn: r.descEn || null,
                        spicy: !!r.spicy,
                        vegan: !!r.vegan,
                        glutenFree: !!r.glutenFree,
                        popular: !!r.popular,
                    },
                    byName,
                });
                done += 1;
                setApplyCount({ done, total: accepted.length });
            } catch (e) {
                failed += 1;
                console.warn('apply override failed for', r.slug, e);
            }
        }
        if (failed > 0) {
            toast(tx(`Applied ${done}, failed ${failed}`, `Aplicados ${done}, fallaron ${failed}`), { kind: 'error' });
        } else {
            toast(tx(`✓ Applied ${done} items`, `✓ Aplicados ${done}`), { kind: 'success' });
        }
        setStage('done');
        // Auto-close after a beat so admin sees the success state.
        setTimeout(() => onClose(), 1200);
    };

    // Group rows by category for rendering.
    const grouped = useMemo(() => {
        const map = new Map();
        for (const r of rows) {
            if (!map.has(r.category)) map.set(r.category, []);
            map.get(r.category).push(r);
        }
        return Array.from(map.entries());
    }, [rows]);

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/50"
            onClick={(e) => { if (e.target === e.currentTarget && stage !== 'extracting' && stage !== 'applying') onClose(); }}>
            <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden shadow-2xl">
                <header className="bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                    <div>
                        <div className="text-base font-black flex items-center gap-2">
                            🤖 {tx('Import menu from PDF / JPEG', 'Importar menú desde PDF / JPEG')}
                        </div>
                        <div className="text-[11px] opacity-90">
                            {stage === 'upload' && tx('Upload a menu file → Claude extracts items → review + apply', 'Sube un menú → Claude extrae items → revisa y aplica')}
                            {stage === 'extracting' && progress}
                            {stage === 'review' && tx(`${acceptedCount}/${rows.length} items selected`, `${acceptedCount}/${rows.length} items seleccionados`)}
                            {stage === 'applying' && tx(`Writing ${applyCount.done}/${applyCount.total}…`, `Escribiendo ${applyCount.done}/${applyCount.total}…`)}
                            {stage === 'done' && tx(`Done — ${applyCount.done} items applied`, `Listo — ${applyCount.done} aplicados`)}
                        </div>
                    </div>
                    {stage !== 'extracting' && stage !== 'applying' && (
                        <button onClick={onClose}
                            className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 transition text-lg font-black">
                            ✕
                        </button>
                    )}
                </header>

                {/* ── Upload stage ──────────────────────────────────────────── */}
                {stage === 'upload' && (
                    <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
                        <div className="text-6xl mb-3">📄</div>
                        <h3 className="text-lg font-black text-dd-text mb-1">
                            {tx('Upload your menu', 'Sube tu menú')}
                        </h3>
                        <p className="text-sm text-dd-text-2 mb-4 max-w-md leading-snug">
                            {tx(
                                'Designer PDFs and printed-menu photos both work. Claude will read every item + price and let you review before anything is saved.',
                                'PDFs de diseñador y fotos del menú impreso funcionan. Claude leerá cada item + precio y podrás revisarlo antes de guardar.',
                            )}
                        </p>
                        <label className="px-5 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white text-sm font-black cursor-pointer hover:opacity-90 transition shadow-md">
                            {tx('Choose PDF / JPEG / PNG', 'Elegir archivo')}
                            <input type="file" accept="image/*,application/pdf"
                                onChange={handleFilePick} className="hidden" />
                        </label>
                        <p className="text-[10px] text-dd-text-2/70 mt-3 max-w-md italic">
                            {tx(
                                'Max 30 MB. PDFs are split to one image per page (up to 8 pages). Each page costs roughly half a cent to extract.',
                                'Máx 30 MB. Los PDFs se dividen en una imagen por página (hasta 8).',
                            )}
                        </p>
                    </div>
                )}

                {/* ── Extracting stage ──────────────────────────────────────── */}
                {stage === 'extracting' && (
                    <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
                        <div className="text-5xl mb-3 animate-bounce">🤖</div>
                        <div className="text-base font-bold text-dd-text mb-1">{progress}</div>
                        <p className="text-[11px] text-dd-text-2 mt-2 max-w-sm">
                            {tx(
                                'Claude is reading the menu. This usually takes 10-40 seconds depending on page count.',
                                'Claude está leyendo el menú. Suele tardar 10-40 segundos.',
                            )}
                        </p>
                    </div>
                )}

                {/* ── Review stage ──────────────────────────────────────────── */}
                {stage === 'review' && (
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        {grouped.map(([cat, items]) => {
                            const inMenuData = existingCategoryNames.has(cat);
                            const allOn = items.every(i => i.accepted);
                            return (
                                <section key={cat}>
                                    <div className="flex items-center justify-between mb-1.5 px-1">
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-xs font-black uppercase tracking-widest text-dd-text">
                                                {cat}
                                            </h4>
                                            {!inMenuData && (
                                                <span className="text-[9px] font-bold uppercase tracking-wider text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                                                    {tx('New category', 'Categoría nueva')}
                                                </span>
                                            )}
                                            <span className="text-[10px] text-dd-text-2">
                                                {items.filter(i => i.accepted).length}/{items.length}
                                            </span>
                                        </div>
                                        <button onClick={() => toggleAllInCategory(cat, !allOn)}
                                            className="text-[10px] font-bold text-purple-700 hover:underline">
                                            {allOn ? tx('Deselect all', 'Deseleccionar todo') : tx('Select all', 'Seleccionar todo')}
                                        </button>
                                    </div>
                                    <div className="space-y-1.5">
                                        {items.map(r => (
                                            <ReviewRow key={r.key} row={r} onChange={(p) => updateRow(r.key, p)} tx={tx} />
                                        ))}
                                    </div>
                                </section>
                            );
                        })}
                    </div>
                )}

                {/* ── Applying / Done stage ─────────────────────────────────── */}
                {(stage === 'applying' || stage === 'done') && (
                    <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
                        <div className="text-5xl mb-3">{stage === 'done' ? '✅' : '💾'}</div>
                        <div className="text-base font-bold text-dd-text mb-1">
                            {stage === 'done'
                                ? tx(`${applyCount.done} items applied`, `${applyCount.done} items aplicados`)
                                : tx(`Writing ${applyCount.done} / ${applyCount.total}…`, `Escribiendo ${applyCount.done} / ${applyCount.total}…`)}
                        </div>
                        {stage === 'applying' && (
                            <div className="w-64 h-2 bg-dd-bg rounded-full overflow-hidden mt-2">
                                <div className="h-full bg-purple-600 transition-all"
                                    style={{ width: `${(applyCount.done / Math.max(1, applyCount.total)) * 100}%` }} />
                            </div>
                        )}
                    </div>
                )}

                {/* ── Footer (review stage only) ────────────────────────────── */}
                {stage === 'review' && (
                    <footer className="border-t border-dd-line p-3 flex gap-2 flex-shrink-0">
                        <button onClick={onClose}
                            className="flex-1 py-2 rounded-lg bg-white border border-dd-line text-dd-text font-bold hover:bg-dd-bg">
                            {tx('Cancel', 'Cancelar')}
                        </button>
                        <button onClick={apply}
                            disabled={acceptedCount === 0}
                            className="flex-1 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white font-black hover:opacity-90 disabled:opacity-40">
                            {tx(`Apply ${acceptedCount} items`, `Aplicar ${acceptedCount}`)}
                        </button>
                    </footer>
                )}
            </div>
        </div>
        </ModalPortal>
    );
}

// One editable row in the review list.
function ReviewRow({ row, onChange, tx }) {
    const tagClass = row.existsIn
        ? 'bg-amber-100 text-amber-800 border-amber-300'
        : 'bg-purple-100 text-purple-800 border-purple-300';
    const tagLabel = row.existsIn
        ? (row.existsIn === row.category
            ? tx('Will update existing', 'Actualizar existente')
            : tx(`In MENU_DATA under "${row.existsIn}"`, `En "${row.existsIn}"`))
        : tx('New custom item', 'Item personalizado');
    return (
        <div className={`p-2.5 rounded-lg border transition ${row.accepted ? 'bg-white border-dd-line' : 'bg-stone-50 border-stone-200 opacity-60'}`}>
            <div className="flex items-start gap-2">
                <input type="checkbox"
                    checked={row.accepted}
                    onChange={(e) => onChange({ accepted: e.target.checked })}
                    className="w-4 h-4 mt-1 accent-purple-600 flex-shrink-0" />
                <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                        <input type="text" value={row.nameEn}
                            onChange={(e) => onChange({ nameEn: e.target.value })}
                            className="flex-1 min-w-[120px] px-2 py-1 rounded border border-dd-line text-sm font-bold bg-white" />
                        <input type="text" value={row.price}
                            onChange={(e) => onChange({ price: e.target.value })}
                            placeholder="$0"
                            className="w-20 px-2 py-1 rounded border border-dd-line text-sm font-black text-dd-green-700 tabular-nums bg-white" />
                        <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${tagClass}`}>
                            {tagLabel}
                        </span>
                    </div>
                    <input type="text" value={row.descEn}
                        onChange={(e) => onChange({ descEn: e.target.value })}
                        placeholder={tx('Description (optional)', 'Descripción (opcional)')}
                        className="w-full px-2 py-1 rounded border border-dd-line text-xs bg-white" />
                    <div className="flex items-center gap-1.5 flex-wrap">
                        {[
                            { k: 'popular',    en: '⭐', val: row.popular },
                            { k: 'spicy',      en: '🌶', val: row.spicy },
                            { k: 'vegan',      en: '🌱', val: row.vegan },
                            { k: 'glutenFree', en: '🌾', val: row.glutenFree },
                        ].map(b => (
                            <button key={b.k} type="button"
                                onClick={() => onChange({ [b.k]: !b.val })}
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition ${
                                    b.val
                                        ? 'bg-purple-600 text-white border-purple-700'
                                        : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'
                                }`}>
                                {b.en}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
