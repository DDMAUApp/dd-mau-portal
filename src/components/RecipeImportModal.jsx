// RecipeImportModal — admin-only "📥 Import" flow on the Recipes tab.
//
// Andrew 2026-08-18: photos / files / pasted text → Claude reads them into
// the app's bilingual recipe schema → admin reviews each recipe (edit,
// replace-existing, skip) → saved through the same race-safe transaction
// every manual save uses (one recipe per write — firestore.rules caps list
// growth at +10 per write). Pipeline lives in src/data/recipeImport.js.
//
// Stages: pick → reading → review → saving → done

import { useMemo, useRef, useState } from 'react';
import ModalPortal from './ModalPortal';
import RecipeForm from './RecipeForm';
import { importRecipes, MAX_PAGES, PAGES_PER_JOB } from '../data/recipeImport';
import { allergenEmoji, allergenLabel, allergenTone, sortAllergens } from '../data/allergens';
import { toast } from '../toast';

function normTitle(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export default function RecipeImportModal({
    language, categories = [], existingRecipes = [], onSaveRecipes, onClose,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [stage, setStage] = useState('pick');          // pick | reading | review | saving | done
    const [progress, setProgress] = useState('');
    const [pasted, setPasted] = useState('');
    const [pickedFiles, setPickedFiles] = useState([]);   // File[] queued before "Read"
    const [items, setItems] = useState([]);               // [{ draft, checked, mode:'add'|'replace'|'skip', existingId }]
    const [warnings, setWarnings] = useState([]);
    const [saved, setSaved] = useState({ added: 0, replaced: 0, failed: 0 });
    const [editingIdx, setEditingIdx] = useState(null);   // review → full RecipeForm for one draft
    const cameraRef = useRef(null);
    const fileRef = useRef(null);
    const existingByTitle = useMemo(() => {
        const m = new Map();
        for (const r of existingRecipes) m.set(normTitle(r.titleEn), r);
        return m;
    }, [existingRecipes]);

    const queueFiles = (list) => {
        const arr = Array.from(list || []);
        if (!arr.length) return;
        setPickedFiles((prev) => [...prev, ...arr]);
    };

    const startRead = async () => {
        if (!pickedFiles.length && !pasted.trim()) {
            toast(tx('Add a photo, a file, or paste text first.', 'Agrega una foto, un archivo o pega texto primero.'));
            return;
        }
        setStage('reading');
        setProgress(tx('Preparing…', 'Preparando…'));
        try {
            const res = await importRecipes({
                files: pickedFiles,
                text: pasted,
                categories,
                existingTitles: existingRecipes.map((r) => r.titleEn).filter((t) => typeof t === 'string' && t),
                onProgress: setProgress,
            });
            const next = (res.recipes || []).map((draft) => {
                const norm = normTitle(draft.titleEn);
                // Guard: a title that normalizes to nothing (symbols/non-Latin)
                // must never "match" a blank-titled existing recipe.
                const dup = norm ? existingByTitle.get(norm) : null;
                // 2026-08-25: duplicates default to UNCHECKED. "Replace
                // existing" pre-checked meant one hasty "Save N" could
                // overwrite live book recipes with AI extractions (including
                // low-confidence ones) — replacing now requires an explicit
                // tick per duplicate.
                return { draft, checked: !dup, mode: dup ? 'replace' : 'add', existingId: dup ? dup.id : null, existingTitle: dup ? dup.titleEn : '' };
            });
            setItems(next);
            setWarnings(res.warnings || []);
            setStage('review');
            if (next.length === 0) {
                toast(tx('No recipes found in that — try a clearer photo or paste the text.', 'No se encontraron recetas — intenta una foto más clara o pega el texto.'), { kind: 'error' });
            }
        } catch (err) {
            console.warn('recipe import failed:', err);
            toast((tx('Import failed: ', 'Error al importar: ')) + (err?.message || err), { kind: 'error' });
            setStage('pick');
        }
    };

    const selectedCount = items.filter((it) => it.checked && it.mode !== 'skip').length;

    const saveAll = async () => {
        const todo = items.filter((it) => it.checked && it.mode !== 'skip');
        if (!todo.length) return;
        setStage('saving');
        let added = 0, replaced = 0, failed = 0;
        for (let i = 0; i < todo.length; i++) {
            const it = todo[i];
            setProgress(tx(`Saving ${i + 1} / ${todo.length}: ${it.draft.titleEn}`, `Guardando ${i + 1} / ${todo.length}: ${it.draft.titleEn}`));
            try {
                // eslint-disable-next-line no-await-in-loop
                await onSaveRecipes(stripMeta(it.draft), it.mode === 'replace' ? it.existingId : null);
                if (it.mode === 'replace') replaced += 1; else added += 1;
            } catch (err) {
                console.warn('import save failed:', it.draft.titleEn, err);
                failed += 1;
            }
        }
        setSaved({ added, replaced, failed });
        setStage('done');
    };

    // Only the SAVE stage locks the modal — an in-flight AI read can be
    // abandoned (the job settles on its own; the staged photos are deleted
    // when it does) so an admin is never stuck staring at a robot for 4 min.
    const busy = stage === 'saving';

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-3 bg-black/50"
            onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
            <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[94vh] flex flex-col overflow-hidden shadow-2xl">
                <header className="bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                    <div className="min-w-0">
                        <div className="text-base font-black flex items-center gap-2">📥 {tx('Import recipes', 'Importar recetas')}</div>
                        <div className="text-[11px] opacity-90 truncate">
                            {stage === 'pick' && tx('Photo, PDF, Word/text file, or pasted text → AI reads it → you review → saved', 'Foto, PDF, archivo Word/texto o texto pegado → la IA lo lee → revisas → se guarda')}
                            {stage === 'reading' && `${progress} · ${tx('close to cancel', 'cierra para cancelar')}`}
                            {stage === 'review' && tx(`${selectedCount} of ${items.length} selected`, `${selectedCount} de ${items.length} seleccionadas`)}
                            {stage === 'saving' && progress}
                            {stage === 'done' && tx('Done', 'Listo')}
                        </div>
                    </div>
                    {!busy && (
                        <button onClick={onClose} aria-label="Close"
                            className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 transition text-lg font-black flex-shrink-0">✕</button>
                    )}
                </header>

                {/* ── Pick ─────────────────────────────────────────── */}
                {stage === 'pick' && (
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        <div className="grid grid-cols-2 gap-2">
                            <button type="button" onClick={() => cameraRef.current?.click()}
                                className="rounded-xl border-2 border-purple-200 bg-purple-50 hover:bg-purple-100 active:scale-[0.98] transition p-4 text-left">
                                <div className="text-3xl mb-1">📷</div>
                                <div className="font-black text-sm text-purple-900">{tx('Take a photo', 'Tomar foto')}</div>
                                <div className="text-[11px] text-purple-800/80 leading-snug">{tx('Recipe card, prep sheet, handwritten notes — one or several.', 'Tarjeta, hoja de prep, notas a mano — una o varias.')}</div>
                            </button>
                            <button type="button" onClick={() => fileRef.current?.click()}
                                className="rounded-xl border-2 border-purple-200 bg-purple-50 hover:bg-purple-100 active:scale-[0.98] transition p-4 text-left">
                                <div className="text-3xl mb-1">📁</div>
                                <div className="font-black text-sm text-purple-900">{tx('Choose files', 'Elegir archivos')}</div>
                                <div className="text-[11px] text-purple-800/80 leading-snug">{tx('PDF (whole book OK), photos, Word .docx, .txt', 'PDF (libro completo OK), fotos, Word .docx, .txt')}</div>
                            </button>
                        </div>
                        <input ref={cameraRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
                            onChange={(e) => { queueFiles(e.target.files); e.target.value = ''; }} />
                        <input ref={fileRef} type="file" multiple className="hidden"
                            accept="image/*,application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,.md,.csv,text/plain"
                            onChange={(e) => { queueFiles(e.target.files); e.target.value = ''; }} />

                        {pickedFiles.length > 0 && (
                            <div className="rounded-xl border border-gray-200 bg-gray-50 p-2">
                                <div className="text-[11px] font-bold text-gray-600 mb-1">{tx('Queued', 'En cola')} ({pickedFiles.length})</div>
                                <ul className="space-y-1">
                                    {pickedFiles.map((f, i) => (
                                        <li key={i} className="flex items-center justify-between text-xs text-gray-700 bg-white rounded-lg px-2 py-1 border border-gray-200">
                                            <span className="truncate">{f.type?.startsWith('image/') ? '🖼' : '📄'} {f.name || tx('photo', 'foto')} <span className="text-gray-400">({Math.max(1, Math.round((f.size || 0) / 1024))} KB)</span></span>
                                            <button type="button" onClick={() => setPickedFiles((p) => p.filter((_, k) => k !== i))} className="text-red-500 font-bold px-1">✕</button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        <div>
                            <div className="text-xs font-bold text-gray-700 mb-1">📋 {tx('…or paste recipe text', '…o pega el texto de la receta')}</div>
                            <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={5}
                                placeholder={tx('Paste from a text message, email, Google Doc… English or Spanish. Several recipes at once is fine.', 'Pega desde un mensaje, correo, Google Doc… en inglés o español. Varias recetas a la vez está bien.')}
                                className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400" />
                        </div>

                        <p className="text-[11px] text-gray-500 leading-snug">
                            {tx(
                                `Tips: one recipe per photo reads best · make sure quantities are in the frame · a PDF is split into pages (up to ${MAX_PAGES}, read ${PAGES_PER_JOB} at a time) · nothing is saved until you press Save on the review screen · photos are deleted from storage right after reading.`,
                                `Consejos: una receta por foto se lee mejor · asegúrate de que las cantidades salgan en la foto · un PDF se divide en páginas (hasta ${MAX_PAGES}, se leen ${PAGES_PER_JOB} a la vez) · nada se guarda hasta que presiones Guardar en la revisión · las fotos se borran del almacenamiento después de leerlas.`,
                            )}
                        </p>

                        <button type="button" onClick={startRead}
                            className="w-full py-3 rounded-xl bg-purple-600 text-white font-black text-base hover:bg-purple-700 active:scale-[0.99] transition shadow-md">
                            ✨ {tx('Read with AI', 'Leer con IA')}
                        </button>
                    </div>
                )}

                {/* ── Reading ──────────────────────────────────────── */}
                {stage === 'reading' && (
                    <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
                        <div className="text-5xl mb-3 animate-bounce">🤖</div>
                        <div className="text-base font-bold text-gray-800 mb-1">{progress}</div>
                        <p className="text-[11px] text-gray-500 mt-2 max-w-sm">
                            {tx('Reading and translating usually takes 20–60 seconds per batch of pages. Keep this open.', 'Leer y traducir suele tardar 20–60 segundos por lote de páginas. Mantén esto abierto.')}
                        </p>
                    </div>
                )}

                {/* ── Review → edit one draft in the full editor ──── */}
                {stage === 'review' && editingIdx != null && items[editingIdx] && (
                    <div className="flex-1 overflow-y-auto">
                        <RecipeForm
                            language={language}
                            recipe={{ ...stripMeta(items[editingIdx].draft), ...(items[editingIdx].existingId != null ? { id: items[editingIdx].existingId } : {}) }}
                            categories={categories}
                            embedded
                            onSave={(cleaned) => {
                                // eslint-disable-next-line no-unused-vars
                                const { id, ...draft } = cleaned;
                                setItems((p) => p.map((x, i) => (i === editingIdx ? { ...x, draft: { ...x.draft, ...draft } } : x)));
                                setEditingIdx(null);
                            }}
                            onCancel={() => setEditingIdx(null)}
                        />
                    </div>
                )}

                {/* ── Review ───────────────────────────────────────── */}
                {stage === 'review' && editingIdx == null && (
                    <>
                        <div className="flex-1 overflow-y-auto p-3 space-y-3">
                            {warnings.length > 0 && (
                                <div className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
                                    <div className="font-bold mb-0.5">⚠ {tx('Notes from the read', 'Notas de la lectura')}</div>
                                    <ul className="list-disc pl-4 space-y-0.5">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                                </div>
                            )}
                            {items.length === 0 && (
                                <div className="text-center py-8 text-sm text-gray-500">
                                    {tx('Nothing extracted.', 'No se extrajo nada.')}
                                    <div className="mt-3"><button onClick={() => setStage('pick')} className="px-4 py-2 rounded-lg bg-gray-100 text-sm font-bold">{tx('← Try again', '← Intentar de nuevo')}</button></div>
                                </div>
                            )}
                            {items.map((it, idx) => {
                                const d = it.draft;
                                const title = isEs ? (d.titleEs || d.titleEn) : d.titleEn;
                                const enN = d.ingredientsEn?.length || 0, esN = d.ingredientsEs?.length || 0;
                                const stN = d.instructionsEn?.length || 0, stEsN = d.instructionsEs?.length || 0;
                                const mismatch = enN !== esN || stN !== stEsN;
                                const conf = d.confidence || 'medium';
                                return (
                                    <div key={idx} className={`rounded-xl border-2 p-3 ${it.checked && it.mode !== 'skip' ? 'border-purple-200 bg-white' : 'border-gray-200 bg-gray-50 opacity-70'}`}>
                                        <div className="flex items-start gap-2">
                                            <input type="checkbox" checked={it.checked} onChange={(e) => setItems((p) => p.map((x, i) => (i === idx ? { ...x, checked: e.target.checked } : x)))}
                                                className="mt-1 w-5 h-5 accent-purple-600" />
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-xl">{d.emoji}</span>
                                                    <span className="font-black text-gray-900">{title}</span>
                                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${conf === 'high' ? 'bg-green-100 text-green-800' : conf === 'low' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>
                                                        {tx(`${conf} confidence`, `confianza ${conf === 'high' ? 'alta' : conf === 'low' ? 'baja' : 'media'}`)}
                                                    </span>
                                                </div>
                                                <div className="text-[11px] text-gray-500 mt-0.5">
                                                    {d.category || tx('(no category)', '(sin categoría)')} · {isEs ? d.titleEn : d.titleEs || tx('(no Spanish title)', '(sin título en español)')}
                                                    {d.sourceLabel ? ` · ${d.sourceLabel}` : ''}
                                                </div>
                                                <div className="text-[11px] text-gray-600 mt-1">
                                                    {tx(`${enN} ingredients · ${stN} steps`, `${enN} ingredientes · ${stN} pasos`)}
                                                    {mismatch && <span className="text-amber-700 font-bold"> · {tx(`ES ${esN}/${stEsN} — check translation`, `ES ${esN}/${stEsN} — revisar traducción`)}</span>}
                                                    {d.yieldsEn ? ` · ${d.yieldsEn}` : ''}
                                                </div>
                                                <div className="flex flex-wrap gap-1 mt-1">
                                                    {sortAllergens(d.allergens).map((c) => (
                                                        <span key={c} className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${allergenTone(c)}`}>{allergenEmoji(c)} {allergenLabel(c, language)}</span>
                                                    ))}
                                                    {(!d.allergens || d.allergens.length === 0) && <span className="text-[10px] text-gray-400">{tx('no allergens tagged', 'sin alérgenos')}</span>}
                                                </div>
                                                {d.warnings?.length > 0 && (
                                                    <ul className="text-[11px] text-amber-800 mt-1 list-disc pl-4">{d.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                                                )}
                                                {it.existingId != null && (
                                                    <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 p-2 text-[11px] text-amber-900">
                                                        <div className="font-bold mb-1">⚠ {tx(`"${it.existingTitle}" already exists in the book`, `"${it.existingTitle}" ya existe en el libro`)}</div>
                                                        <div className="flex gap-1 flex-wrap">
                                                            {[['replace', tx('Replace existing', 'Reemplazar')], ['add', tx('Add as new', 'Agregar como nueva')], ['skip', tx('Skip', 'Omitir')]].map(([m, label]) => (
                                                                <button key={m} type="button" onClick={() => setItems((p) => p.map((x, i) => (i === idx ? { ...x, mode: m } : x)))}
                                                                    className={`px-2 py-1 rounded-full font-bold border ${it.mode === m ? 'bg-amber-600 text-white border-amber-700' : 'bg-white text-amber-900 border-amber-300'}`}>{label}</button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                <details className="mt-2">
                                                    <summary className="text-[11px] font-bold text-purple-700 cursor-pointer">{tx('Preview', 'Vista previa')}</summary>
                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1 text-[11px] text-gray-700">
                                                        <div>
                                                            <div className="font-bold text-gray-800">EN</div>
                                                            <ul className="list-disc pl-4">{(d.ingredientsEn || []).map((l, i) => <li key={i}>{l}</li>)}</ul>
                                                            <ol className="list-decimal pl-4 mt-1">{(d.instructionsEn || []).map((l, i) => <li key={i}>{l}</li>)}</ol>
                                                        </div>
                                                        <div>
                                                            <div className="font-bold text-gray-800">ES</div>
                                                            <ul className="list-disc pl-4">{(d.ingredientsEs || []).map((l, i) => <li key={i}>{l}</li>)}</ul>
                                                            <ol className="list-decimal pl-4 mt-1">{(d.instructionsEs || []).map((l, i) => <li key={i}>{l}</li>)}</ol>
                                                        </div>
                                                    </div>
                                                </details>
                                                <div className="mt-2 flex gap-2">
                                                    <button type="button" onClick={() => setEditingIdx(idx)}
                                                        className="text-[11px] font-bold px-2 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-300">✏️ {tx('Edit before saving', 'Editar antes de guardar')}</button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        {items.length > 0 && (
                            <div className="p-3 border-t border-gray-200 flex gap-2 flex-shrink-0 pb-bottom-nav sm:pb-3">
                                <button type="button" onClick={() => setStage('pick')} className="px-3 py-2.5 rounded-xl bg-gray-100 text-gray-700 text-sm font-bold">{tx('← Back', '← Atrás')}</button>
                                <button type="button" onClick={saveAll} disabled={selectedCount === 0}
                                    className="flex-1 py-2.5 rounded-xl bg-mint-700 text-white text-sm font-black disabled:opacity-50">
                                    💾 {tx(`Save ${selectedCount} recipe${selectedCount === 1 ? '' : 's'}`, `Guardar ${selectedCount} receta${selectedCount === 1 ? '' : 's'}`)}
                                </button>
                            </div>
                        )}
                    </>
                )}

                {/* ── Saving / Done ────────────────────────────────── */}
                {stage === 'saving' && (
                    <div className="flex-1 p-6 flex flex-col items-center justify-center text-center">
                        <div className="text-5xl mb-3">💾</div>
                        <div className="text-base font-bold text-gray-800">{progress}</div>
                    </div>
                )}
                {stage === 'done' && (
                    <div className="flex-1 p-6 flex flex-col items-center justify-center text-center">
                        <div className="text-5xl mb-3">✅</div>
                        <div className="text-base font-bold text-gray-800">
                            {tx(`${saved.added} added · ${saved.replaced} replaced${saved.failed ? ` · ${saved.failed} failed` : ''}`,
                                `${saved.added} agregadas · ${saved.replaced} reemplazadas${saved.failed ? ` · ${saved.failed} fallaron` : ''}`)}
                        </div>
                        <p className="text-[11px] text-gray-500 mt-2">{tx('Every save is in the recipe audit log, so anything can be rolled back.', 'Cada guardado queda en el registro de auditoría — todo se puede revertir.')}</p>
                        <button type="button" onClick={onClose} className="mt-4 px-5 py-2.5 rounded-xl bg-mint-700 text-white text-sm font-black">{tx('Done', 'Listo')}</button>
                    </div>
                )}
            </div>
        </div>
        </ModalPortal>
    );
}

function stripMeta(d) {
    // Drop review-only fields before the draft becomes a recipe document.
    // eslint-disable-next-line no-unused-vars
    const { confidence, warnings, sourceLabel, _batch, _idx, ...rest } = d || {};
    return rest;
}
