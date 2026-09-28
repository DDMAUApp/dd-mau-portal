// RecipeForm — add / edit one recipe (admin only).
//
// Moved out of Recipes.jsx on 2026-08-18 so the AI import review screen
// (RecipeImportModal) can reuse the exact same editor. Additions in the
// same pass:
//   • category chips from the live book (free text still allowed) — the
//     book had drifted into "Sauces" vs "Sauces & Dressings"
//   • ✨ Auto-fill: fills the empty Spanish side + allergen tags from the
//     English text via the recipe-import Cloud Function (Andrew types EN
//     only; nobody was tagging allergens by hand)
//   • EN/ES line-count hint so mismatched translations are visible before
//     save (the on-screen list falls back EN↔ES per language, so a missing
//     Spanish line silently showed English before)

//   • 2026-09-28 — 📷 photos/videos on any English ingredient/step line +
//     an optional 🔥 Cook-to-order (service) section next to 🥣 Prep
//     (data/recipeMedia.js has the storage shape). Crash-safe draft in
//     localStorage (camera round-trips can kill the WebView).

import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../data/translations';
import { ALLERGEN_ORDER, allergenLabel, allergenEmoji, allergenTone } from '../data/allergens';
import { splitIngredientLine, joinIngredientParts, unitsFor } from '../data/ingredientParts';
import { toast } from '../toast';
import {
    FIELD_MEDIA_KEY, SERVICE_FIELDS, hasServiceSection, mediaAt, mediaCount, allMediaItems,
    shiftMediaOnRemove, shiftMediaOnSplice, addMediaItem, removeMediaItem, compactListWithMedia, applyVideoResults,
} from '../data/recipeMedia';
import { uploadRecipeMedia, fetchVideoResult, deleteRecipeMediaFiles } from '../data/recipeMediaUpload';
import { RecipeMediaTile } from './RecipeMedia';

const DRAFT_PREFIX = 'ddmau:recipeEditDraft:';
const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
const readDraft = (key) => {
    if (!key) return null;
    try {
        const d = JSON.parse(localStorage.getItem(DRAFT_PREFIX + key) || 'null');
        if (!d || !d.form || !(Date.now() - d.at < DRAFT_TTL_MS)) return null;
        return d;
    } catch { return null; }
};
const clearDraft = (key) => { if (key) { try { localStorage.removeItem(DRAFT_PREFIX + key); } catch { /* storage blocked */ } } };

export const BLANK_RECIPE = {
    titleEn: "", titleEs: "", emoji: "🍽️", category: "",
    prepTimeEn: "", cookTimeEn: "",
    yieldsEn: "", yieldsEs: "",
    allergens: [],
    ingredientsEn: [""], ingredientsEs: [""],
    instructionsEn: [""], instructionsEs: [""],
    // 2026-09-28 — Cook-to-order lists MUST exist on a blank recipe too:
    // "+ Add a Cook-to-order section" on a NEW recipe crashed on
    // form.serviceIngredientsEn.map (v1.0.487).
    serviceIngredientsEn: [""], serviceIngredientsEs: [""],
    serviceInstructionsEn: [""], serviceInstructionsEs: [""],
    media: {},
};
// Every editor list read goes through this — a missing list (older draft,
// partial import doc) shows one blank row instead of crashing.
const rows = (v) => (Array.isArray(v) && v.length > 0 ? v : [""]);

export default function RecipeForm({ language, recipe, categories = [], embedded = false, onSave, onCancel, draftKey = null, staffName = '' }) {
    const isEdit = !!recipe;
    const isEs = language === "es";
    const tx = (en, es) => (isEs ? es : en);
    const [form, setForm] = useState(() => {
        if (!recipe) return { ...BLANK_RECIPE };
        // Normalize legacy/partial docs — a recipe missing one of the list
        // fields crashed the editor on `.map`/`.filter` of undefined. Lists
        // are coerced to non-empty arrays (blank row, NOT the other
        // language — copying EN into ES here would silently save it as ES).
        const list = (v) => (Array.isArray(v) && v.length > 0 ? v.map((x) => (typeof x === 'string' ? x : '')) : [""]);
        return {
            ...BLANK_RECIPE,
            ...recipe,
            allergens: Array.isArray(recipe.allergens) ? recipe.allergens : [],
            ingredientsEn: list(recipe.ingredientsEn),
            ingredientsEs: list(recipe.ingredientsEs),
            instructionsEn: list(recipe.instructionsEn),
            instructionsEs: list(recipe.instructionsEs),
            serviceIngredientsEn: list(recipe.serviceIngredientsEn),
            serviceIngredientsEs: list(recipe.serviceIngredientsEs),
            serviceInstructionsEn: list(recipe.serviceInstructionsEn),
            serviceInstructionsEs: list(recipe.serviceInstructionsEs),
            media: recipe.media && typeof recipe.media === 'object' ? recipe.media : {},
        };
    });
    const [aiBusy, setAiBusy] = useState(false);
    const [hasService, setHasService] = useState(() => hasServiceSection(recipe));
    const allowMedia = !embedded;

    // ── crash-safe draft (restore banner) ──
    const initialJsonRef = useRef(null);
    if (initialJsonRef.current == null) initialJsonRef.current = JSON.stringify({ form, hasService });
    const [draftOffer, setDraftOffer] = useState(() => {
        const d = readDraft(draftKey);
        return d && JSON.stringify({ form: d.form, hasService: !!d.hasService }) !== initialJsonRef.current ? d : null;
    });
    useEffect(() => {
        if (!draftKey || draftOffer) return undefined;
        const json = JSON.stringify({ form, hasService });
        const t = setTimeout(() => {
            try {
                if (json === initialJsonRef.current) localStorage.removeItem(DRAFT_PREFIX + draftKey);
                else localStorage.setItem(DRAFT_PREFIX + draftKey, JSON.stringify({ at: Date.now(), form, hasService }));
            } catch { /* storage full / blocked — the draft is a convenience */ }
        }, 600);
        return () => clearTimeout(t);
    }, [form, hasService, draftKey, draftOffer]);

    // ── media uploads ──
    const [uploads, setUploads] = useState([]);           // { uid, field, idx, kind, pct, name }
    const tasksRef = useRef(new Map());                     // uid → upload task (cancel)
    const sessionUploadsRef = useRef(new Map());            // id → item uploaded in THIS edit (cleanup on cancel)
    const fileInputRef = useRef(null);
    const pickTargetRef = useRef(null);                     // { field, idx }
    const uploading = uploads.length > 0;
    useEffect(() => () => { for (const t of tasksRef.current.values()) { try { t.cancel(); } catch { /* done */ } } }, []);

    const toggleAllergen = (code) => {
        setForm(prev => {
            const cur = Array.isArray(prev.allergens) ? prev.allergens : [];
            return { ...prev, allergens: cur.includes(code) ? cur.filter(c => c !== code) : [...cur, code] };
        });
    };
    const updateField = (field, val) => setForm(prev => ({ ...prev, [field]: val }));
    const updateListItem = (field, idx, val) => setForm(prev => {
        const arr = [...rows(prev[field])];
        arr[idx] = val;
        return { ...prev, [field]: arr };
    });
    const addListItem = (field) => setForm(prev => ({ ...prev, [field]: [...rows(prev[field]), ""] }));
    const removeListItem = (field, idx) => setForm(prev => {
        const key = FIELD_MEDIA_KEY[field];
        const media = key ? shiftMediaOnRemove(prev.media, key, idx) : prev.media;
        const cur = rows(prev[field]);
        if (cur.length <= 1) return { ...prev, [field]: [""], media };
        return { ...prev, [field]: cur.filter((_, i) => i !== idx), media };
    });
    // Paste a whole list at once: if a pasted value contains newlines,
    // split it into rows (Andrew pastes ingredient blocks from notes).
    const pasteList = (field, idx, e) => {
        const text = e.clipboardData?.getData('text') || '';
        if (!text.includes('\n')) return;
        e.preventDefault();
        // Strip list markers ("- ", "• ", "1. ", "2) ") but NOT decimals —
        // "2.5 lb chicken" must stay "2.5 lb chicken".
        const rows = text.split(/\r?\n/).map(s => s.replace(/^\s*(?:[-•*·]\s+|\d+[.)](?=\s)\s*)/, '').trim()).filter(Boolean);
        if (!rows.length) return;
        setForm(prev => {
            const arr = [...rows(prev[field])];
            const cur = (arr[idx] || '').trim();
            const added = cur ? [cur + ' ' + rows[0], ...rows.slice(1)] : rows;
            arr.splice(idx, 1, ...added);
            const key = FIELD_MEDIA_KEY[field];
            return { ...prev, [field]: arr, media: key ? shiftMediaOnSplice(prev.media, key, idx, added.length) : prev.media };
        });
    };

    const categoryOptions = useMemo(() => {
        const seen = new Set();
        const out = [];
        for (const c of categories) { const k = String(c || '').trim(); if (k && !seen.has(k)) { seen.add(k); out.push(k); } }
        return out;
    }, [categories]);

    // Blank lines drop out on save; media follows its line (English lists
    // are the anchor). `blanks` = lines that would lose a photo.
    const buildSave = () => {
        const clean = (arr) => (Array.isArray(arr) ? arr.map(s => String(s ?? '').trim()).filter(Boolean) : []);
        const out = {
            ...form,
            titleEn: form.titleEn.trim(),
            titleEs: (form.titleEs || '').trim(),
            category: (form.category || '').trim(),
            emoji: (form.emoji || '').trim() || '🍽️',
            allergens: Array.isArray(form.allergens) ? form.allergens : [],
            ingredientsEs: clean(form.ingredientsEs),
            instructionsEs: clean(form.instructionsEs),
        };
        let media = { ...(form.media || {}) };
        const blanks = [];
        const anchors = ['ingredientsEn', 'instructionsEn', ...(hasService ? ['serviceIngredientsEn', 'serviceInstructionsEn'] : [])];
        for (const f of anchors) {
            const key = FIELD_MEDIA_KEY[f];
            const r = compactListWithMedia(form[f], media[key]);
            out[f] = r.list;
            if (Object.keys(r.bucket).length) media[key] = r.bucket; else delete media[key];
            r.blankWithMedia.forEach(n => blanks.push({ field: f, n }));
        }
        if (hasService) {
            out.serviceIngredientsEs = clean(form.serviceIngredientsEs);
            out.serviceInstructionsEs = clean(form.serviceInstructionsEs);
        }
        if (!hasService || !hasServiceSection(out)) {
            SERVICE_FIELDS.forEach(f => { delete out[f]; });
            delete media.svcIng; delete media.svcStep;
        }
        if (mediaCount(media)) out.media = media; else delete out.media;
        return { out, blanks };
    };
    const cleanedForm = () => buildSave().out;

    const [saving, setSaving] = useState(false);
    const handleSave = async () => {
        if (!form.titleEn.trim()) { toast(tx("English title is required", "Se requiere título en inglés")); return; }
        if (uploading) { toast(tx("Wait for the photo/video upload to finish", "Espera a que termine de subir la foto/video")); return; }
        const { out: cleaned, blanks } = buildSave();
        if (blanks.length) {
            const b = blanks[0];
            const what = /ngredient/.test(b.field) ? tx('Ingredient', 'Ingrediente') : tx('Step', 'Paso');
            toast(tx(`${what} ${b.n} has a photo/video but no words — type something for it (or remove the photo).`,
                `${what} ${b.n} tiene foto/video pero no tiene texto — escribe algo (o quita la foto).`), { kind: 'warn' });
            return;
        }
        const ingCount = cleaned.ingredientsEn.length + cleaned.ingredientsEs.length
            + (cleaned.serviceIngredientsEn?.length || 0) + (cleaned.serviceIngredientsEs?.length || 0);
        if (ingCount === 0) {
            toast(tx("Add at least one ingredient", "Agrega al menos un ingrediente")); return;
        }
        setSaving(true);
        try {
            // Videos: copy in the Cloud Function's phone-friendly copy +
            // poster if it's ready (≤4s; otherwise the viewer asks later).
            const pendingVideos = allMediaItems(cleaned.media).filter(it => it.kind === 'video' && !it.playbackUrl);
            if (pendingVideos.length) {
                const results = await Promise.all(pendingVideos.map(it => Promise.race([
                    fetchVideoResult(it.id), new Promise(res => setTimeout(() => res(null), 4000)),
                ])));
                const byId = {};
                pendingVideos.forEach((it, i) => { if (results[i]) byId[it.id] = results[i]; });
                cleaned.media = applyVideoResults(cleaned.media, byId);
            }
            const ok = await onSave(cleaned);
            if (ok !== false) { clearDraft(draftKey); sessionUploadsRef.current.clear(); }
        } finally {
            setSaving(false);
        }
    };

    const handleCancel = () => {
        for (const t of tasksRef.current.values()) { try { t.cancel(); } catch { /* done */ } }
        // Uploaded during this edit and never saved → delete (best-effort).
        for (const it of sessionUploadsRef.current.values()) deleteRecipeMediaFiles(it);
        sessionUploadsRef.current.clear();
        clearDraft(draftKey);
        onCancel?.();
    };

    // ── 📷 attach: one hidden picker, aimed at a line before it opens ──
    const openPicker = (field, idx) => {
        pickTargetRef.current = { field, idx };
        fileInputRef.current?.click();
    };
    const onFilesPicked = async (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        const target = pickTargetRef.current;
        if (!files.length || !target) return;
        const key = FIELD_MEDIA_KEY[target.field];
        for (const file of files) {
            const uid = Math.random().toString(36).slice(2);
            setUploads(u => [...u, { uid, field: target.field, idx: target.idx, pct: 0, name: file.name || '' }]);
            try {
                const item = await uploadRecipeMedia(file, {
                    staffName,
                    onTask: (task) => tasksRef.current.set(uid, task),
                    onProgress: (pct) => setUploads(u => u.map(x => (x.uid === uid && x.pct !== pct ? { ...x, pct } : x))),
                });
                sessionUploadsRef.current.set(item.id, item);
                setForm(prev => ({ ...prev, media: addMediaItem(prev.media, key, target.idx, item) }));
            } catch (err) {
                const code = err?.code || err?.message || '';
                if (code !== 'storage/canceled') {
                    console.warn('recipe media upload failed:', err);
                    toast(code === 'too_big'
                        ? tx('Too large — videos up to 250 MB.', 'Muy grande — videos hasta 250 MB.')
                        : code === 'unsupported'
                            ? tx('Pick a photo or a video.', 'Elige una foto o un video.')
                            : tx("Upload didn't finish — check Wi-Fi and try again.", 'No se terminó de subir — revisa el Wi-Fi e inténtalo de nuevo.'),
                    { kind: 'error' });
                }
            } finally {
                tasksRef.current.delete(uid);
                setUploads(u => u.filter(x => x.uid !== uid));
            }
        }
    };
    const cancelUpload = (uid) => { try { tasksRef.current.get(uid)?.cancel(); } catch { /* done */ } };
    const removeMedia = (field, idx, item) => {
        const key = FIELD_MEDIA_KEY[field];
        setForm(prev => ({ ...prev, media: removeMediaItem(prev.media, key, idx, item.id) }));
        if (sessionUploadsRef.current.has(item.id)) {
            sessionUploadsRef.current.delete(item.id);
            deleteRecipeMediaFiles(item);
        }
    };
    const attachButton = (field, idx) => (allowMedia && FIELD_MEDIA_KEY[field]) ? (
        <button type="button" onClick={() => openPicker(field, idx)}
            className="flex-shrink-0 w-8 rounded border border-gray-300 bg-white text-sm leading-none"
            title={tx('Add photo or video', 'Agregar foto o video')} aria-label={tx('Add photo or video', 'Agregar foto o video')}>📷</button>
    ) : null;
    const rowMedia = (field, idx) => {
        const key = FIELD_MEDIA_KEY[field];
        if (!allowMedia || !key) return null;
        const items = mediaAt(form.media, key, idx);
        const pending = uploads.filter(u => u.field === field && u.idx === idx);
        if (!items.length && !pending.length) return null;
        return (
            <div className="flex flex-wrap gap-2 pl-6 pt-1.5 pb-1 mb-1">
                {items.map(it => (
                    <RecipeMediaTile key={it.id} item={it} size="sm" isEs={isEs}
                        onRemove={() => removeMedia(field, idx, it)} removeLabel={tx('Remove photo', 'Quitar foto')} />
                ))}
                {pending.map(u => (
                    <span key={u.uid} className="relative w-14 h-14 rounded-lg border border-dashed border-mint-600 bg-mint-50 flex flex-col items-center justify-center text-[10px] font-bold text-mint-700 tabular-nums">
                        <span>{u.pct}%</span>
                        <button type="button" onClick={() => cancelUpload(u.uid)} className="text-[10px] underline text-gray-500">{tx('cancel', 'cancelar')}</button>
                    </span>
                ))}
            </div>
        );
    };

    // ✨ Auto-fill Spanish + allergens from the English side. Only EMPTY
    // Spanish fields are filled; the English text is never touched.
    const handleAiFill = async () => {
        const src = cleanedForm();
        if (!src.titleEn && !src.titleEs && src.ingredientsEn.length === 0 && src.ingredientsEs.length === 0) {
            toast(tx('Type the recipe first (either language)', 'Escribe primero la receta (en cualquier idioma)')); return;
        }
        setAiBusy(true);
        try {
            const { completeRecipeDraft } = await import('../data/recipeImport');
            // The AI only knows one ingredient + one step list: send Prep as
            // is, and Cook-to-order as its own small "recipe" alongside.
            const { media: _m, serviceIngredientsEn: sIe, serviceIngredientsEs: sIs, serviceInstructionsEn: sSe, serviceInstructionsEs: sSs, ...mainSrc } = src;
            const svcSrc = hasService && ((sIe || []).length || (sSe || []).length || (sIs || []).length || (sSs || []).length)
                ? { titleEn: src.titleEn, titleEs: src.titleEs, ingredientsEn: sIe || [], ingredientsEs: sIs || [], instructionsEn: sSe || [], instructionsEs: sSs || [], allergens: [] }
                : null;
            const [ai, aiSvc] = await Promise.all([
                completeRecipeDraft(mainSrc, { categories: categoryOptions }),
                svcSrc ? completeRecipeDraft(svcSrc, { categories: categoryOptions }).catch(() => null) : null,
            ]);
            setForm(prev => {
                const emptyList = (arr) => !Array.isArray(arr) || arr.every(s => !String(s || '').trim());
                const next = { ...prev };
                if (!prev.titleEs?.trim() && ai.titleEs) next.titleEs = ai.titleEs;
                if (!prev.yieldsEs?.trim() && ai.yieldsEs) next.yieldsEs = ai.yieldsEs;
                if (emptyList(prev.ingredientsEs) && ai.ingredientsEs?.length) next.ingredientsEs = ai.ingredientsEs;
                if (emptyList(prev.instructionsEs) && ai.instructionsEs?.length) next.instructionsEs = ai.instructionsEs;
                if (!prev.titleEn?.trim() && ai.titleEn) next.titleEn = ai.titleEn;
                if (emptyList(prev.ingredientsEn) && ai.ingredientsEn?.length) next.ingredientsEn = ai.ingredientsEn;
                if (emptyList(prev.instructionsEn) && ai.instructionsEn?.length) next.instructionsEn = ai.instructionsEn;
                if (!prev.category?.trim() && ai.category) next.category = ai.category;
                if ((!prev.emoji || prev.emoji === '🍽️') && ai.emoji) next.emoji = ai.emoji;
                if (aiSvc) {
                    if (emptyList(prev.serviceIngredientsEs) && aiSvc.ingredientsEs?.length) next.serviceIngredientsEs = aiSvc.ingredientsEs;
                    if (emptyList(prev.serviceInstructionsEs) && aiSvc.instructionsEs?.length) next.serviceInstructionsEs = aiSvc.instructionsEs;
                    if (emptyList(prev.serviceIngredientsEn) && aiSvc.ingredientsEn?.length) next.serviceIngredientsEn = aiSvc.ingredientsEn;
                    if (emptyList(prev.serviceInstructionsEn) && aiSvc.instructionsEn?.length) next.serviceInstructionsEn = aiSvc.instructionsEn;
                }
                const merged = new Set([...(prev.allergens || []), ...(ai.allergens || []), ...(aiSvc?.allergens || [])]);
                next.allergens = ALLERGEN_ORDER.filter(c => merged.has(c));
                return next;
            });
            const addedTags = [...new Set([...(ai.allergens || []), ...(aiSvc?.allergens || [])])].filter(c => !(cleanedForm().allergens || []).includes(c));
            toast(tx(
                `✨ Filled Spanish${addedTags.length ? ` + tagged ${addedTags.map(c => allergenLabel(c, 'en')).join(', ')}` : ''} — please double-check`,
                `✨ Español completado${addedTags.length ? ` + alérgenos: ${addedTags.map(c => allergenLabel(c, 'es')).join(', ')}` : ''} — revísalo`,
            ));
        } catch (err) {
            console.warn('recipe ai fill failed:', err);
            toast(tx('AI fill failed: ', 'Error de IA: ') + (err?.message || err), { kind: 'error' });
        } finally {
            setAiBusy(false);
        }
    };

    const countHint = (enField, esField) => {
        const n = (arr) => (arr || []).filter(s => String(s || '').trim()).length;
        const a = n(form[enField]), b = n(form[esField]);
        if (a === b || b === 0) return null;
        return <span className="text-[10px] font-bold text-amber-700 ml-2">EN {a} · ES {b} — {tx('line counts differ', 'las líneas no coinciden')}</span>;
    };

    // ── Ingredient rows: [amount][unit ▾][ingredient] (Andrew 2026-09-01:
    // "the amount on a box and the measurement in one … with the cup it
    // can come from a drop down menu"). STORAGE UNCHANGED — each row still
    // saves as the same single string ("1 cup sugar"), split/joined by the
    // round-trip-tested ingredientParts helpers, so display, ×-scaling,
    // search and the AI import see exactly what they always did.
    //
    // rowDraft: while a row is being edited, the WHOLE row {qty, unit,
    // rest} lives in a draft — all three boxes display from it and every
    // keystroke writes join(draft) into the row string. The string is
    // always current (no reliance on blur firing), and the split's
    // auto-classification ("2 limes" → amount 2, item limes) only happens
    // when the row draft clears, never mid-typing under the cursor.
    const [rowDraft, setRowDraft] = useState(null); // { key, qty, unit, rest }
    const renderIngredientEditor = (field, label) => {
        const lang = field === 'ingredientsEs' ? 'es' : 'en';
        const units = unitsFor(lang);
        return (
            <div className="mb-3">
                <label className="block text-xs font-bold text-gray-600 mb-1">{label} <span className="text-gray-400 font-normal">({(form[field] || []).filter(s => String(s || '').trim()).length})</span></label>
                {rows(form[field]).map((item, i) => {
                    const key = `${field}:${i}`;
                    const active = rowDraft?.key === key ? rowDraft : null;
                    const parts = active || splitIngredientLine(item, lang);
                    // Edit = update the row draft AND write the composed
                    // string into the form in the same handler (functional
                    // update, so batched edits can't clobber each other).
                    const edit = (patch) => {
                        const next = { key, qty: parts.qty, unit: parts.unit, rest: parts.rest, ...patch };
                        setRowDraft(next);
                        updateListItem(field, i, joinIngredientParts(next));
                    };
                    const seed = () => { if (!active) setRowDraft({ key, qty: parts.qty, unit: parts.unit, rest: parts.rest }); };
                    const unseed = () => setRowDraft(d => (d?.key === key ? null : d));
                    // A unit spelled outside the list (or with different
                    // casing) stays selectable so nothing silently rewrites.
                    const unitOptions = parts.unit && !units.includes(parts.unit) ? [parts.unit, ...units] : units;
                    return (
                        <div key={i}>
                        <div className="flex gap-1 mb-1">
                            <span className="text-xs text-gray-400 mt-2 w-5 text-right flex-shrink-0">{i + 1}.</span>
                            <input
                                className="w-14 flex-shrink-0 border border-gray-300 rounded px-1 py-1.5 text-sm text-center"
                                value={parts.qty}
                                inputMode="decimal"
                                placeholder="#"
                                aria-label={tx('amount', 'cantidad')}
                                onFocus={seed}
                                onChange={e => edit({ qty: e.target.value })}
                                onBlur={unseed}
                            />
                            <select
                                className="w-24 flex-shrink-0 border border-gray-300 rounded px-1 py-1.5 text-sm bg-white"
                                value={parts.unit}
                                aria-label={tx('measurement', 'medida')}
                                onChange={e => edit({ unit: e.target.value })}
                            >
                                <option value="">—</option>
                                {unitOptions.map(u => <option key={u} value={u}>{u}</option>)}
                            </select>
                            <input
                                className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1.5 text-sm"
                                value={parts.rest}
                                placeholder={tx('ingredient', 'ingrediente')}
                                onFocus={seed}
                                onChange={e => edit({ rest: e.target.value })}
                                onBlur={unseed}
                                onPaste={e => {
                                    // Multi-line paste replaces rows below via
                                    // pasteList (which preventDefaults) — drop
                                    // the row draft so it can't mask them.
                                    if ((e.clipboardData?.getData('text') || '').includes('\n')) setRowDraft(null);
                                    pasteList(field, i, e);
                                }}
                            />
                            {attachButton(field, i)}
                            <button type="button" disabled={uploading && !!FIELD_MEDIA_KEY[field]} onClick={() => { setRowDraft(null); removeListItem(field, i); }} className="text-red-400 text-sm px-1 disabled:opacity-30" aria-label="remove">✕</button>
                        </div>
                        {rowMedia(field, i)}
                        </div>
                    );
                })}
                <button type="button" onClick={() => addListItem(field)} className="text-xs text-mint-700 font-bold mt-1">{tx("+ Add", "+ Agregar")}</button>
            </div>
        );
    };

    const renderListEditor = (field, label) => (
        <div className="mb-3">
            <label className="block text-xs font-bold text-gray-600 mb-1">{label} <span className="text-gray-400 font-normal">({(form[field] || []).filter(s => String(s || '').trim()).length})</span></label>
            {rows(form[field]).map((item, i) => (
                <div key={i}>
                <div className="flex gap-1 mb-1">
                    <span className="text-xs text-gray-400 mt-2 w-5 text-right flex-shrink-0">{i + 1}.</span>
                    <textarea
                        rows={1}
                        className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1.5 text-sm resize-none [field-sizing:content] min-h-[34px]"
                        value={item}
                        onChange={e => updateListItem(field, i, e.target.value.replace(/\r?\n/g, ' '))}
                        onPaste={e => pasteList(field, i, e)}
                        placeholder={`${label} ${i + 1}`}
                    />
                    {attachButton(field, i)}
                    <button type="button" disabled={uploading && !!FIELD_MEDIA_KEY[field]} onClick={() => removeListItem(field, i)} className="text-red-400 text-sm px-1 disabled:opacity-30" aria-label="remove">✕</button>
                </div>
                {rowMedia(field, i)}
                </div>
            ))}
            <button type="button" onClick={() => addListItem(field)} className="text-xs text-mint-700 font-bold mt-1">{tx("+ Add", "+ Agregar")}</button>
        </div>
    );

    const inputCls = "w-full border border-gray-300 rounded px-2 py-1.5 text-sm";

    return (
        <div className={embedded ? "p-4" : "p-4 md:p-5"}>
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-mint-700">
                    {isEdit ? tx("Edit Recipe", "Editar Receta") : tx("New Recipe", "Nueva Receta")}
                </h2>
                <button type="button" onClick={handleCancel} className="text-gray-500 text-sm underline">{tx("Cancel", "Cancelar")}</button>
            </div>
            {draftOffer && (
                <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 flex items-center gap-2 flex-wrap">
                    <span className="flex-1 min-w-[12rem]">
                        {tx('You have unsaved changes from ', 'Tienes cambios sin guardar de las ')}
                        <b>{new Date(draftOffer.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b>
                        {tx(' — restore them?', ' — ¿recuperarlos?')}
                    </span>
                    <button type="button" onClick={() => { setForm({ ...BLANK_RECIPE, ...draftOffer.form }); setHasService(!!draftOffer.hasService); setDraftOffer(null); }}
                        className="px-3 py-1 rounded-full bg-amber-600 text-white text-xs font-bold">{tx('Restore', 'Recuperar')}</button>
                    <button type="button" onClick={() => { clearDraft(draftKey); setDraftOffer(null); }}
                        className="px-3 py-1 rounded-full bg-white border border-amber-300 text-amber-800 text-xs font-bold">{tx('Discard', 'Descartar')}</button>
                </div>
            )}
            {allowMedia && (
                <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple className="hidden" onChange={onFilesPicked} />
            )}

            <div className="space-y-3">
                <div className="flex gap-2">
                    <div className="w-16 flex-shrink-0">
                        <label className="block text-xs font-bold text-gray-600 mb-1">{tx("Emoji", "Ícono")}</label>
                        <input className="w-full border border-gray-300 rounded px-2 py-1 text-center text-xl" value={form.emoji} onChange={e => updateField("emoji", e.target.value)} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <label className="block text-xs font-bold text-gray-600 mb-1">{tx("Category", "Categoría")}</label>
                        <input className={inputCls} value={form.category} onChange={e => updateField("category", e.target.value)} placeholder={tx("e.g. Sauces & Dressings", "ej. Sauces & Dressings")} list="recipe-category-options" />
                        <datalist id="recipe-category-options">{categoryOptions.map(c => <option key={c} value={c} />)}</datalist>
                        {categoryOptions.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                                {categoryOptions.map(c => (
                                    <button key={c} type="button" onClick={() => updateField("category", c)}
                                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${form.category === c ? 'bg-mint-700 text-white border-mint-700' : 'bg-white text-gray-600 border-gray-300'}`}>{c}</button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                        <label className="block text-xs font-bold text-gray-600 mb-1">{tx("Title (English) *", "Título (Inglés) *")}</label>
                        <input className={inputCls} value={form.titleEn} onChange={e => updateField("titleEn", e.target.value)} placeholder={tx("Recipe name in English", "Nombre en inglés")} />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-gray-600 mb-1">{tx("Title (Spanish)", "Título (Español)")}</label>
                        <input className={inputCls} value={form.titleEs} onChange={e => updateField("titleEs", e.target.value)} placeholder={tx("Recipe name in Spanish", "Nombre en español")} />
                    </div>
                </div>

                <div className="flex gap-2">
                    <div className="flex-1">
                        <label className="block text-xs font-bold text-gray-600 mb-1">{t("prepTime", language)}</label>
                        <input className={inputCls} value={form.prepTimeEn} onChange={e => updateField("prepTimeEn", e.target.value)} placeholder={tx("e.g. 30 min", "ej. 30 min")} />
                    </div>
                    <div className="flex-1">
                        <label className="block text-xs font-bold text-gray-600 mb-1">{t("cookTime", language)}</label>
                        <input className={inputCls} value={form.cookTimeEn} onChange={e => updateField("cookTimeEn", e.target.value)} placeholder={tx("e.g. 2 hours", "ej. 2 horas")} />
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                        <label className="block text-xs font-bold text-gray-600 mb-1">{t("yields", language)} (EN)</label>
                        <input className={inputCls} value={form.yieldsEn} onChange={e => updateField("yieldsEn", e.target.value)} placeholder={tx("e.g. 16 qt bucket · lasts 3–7 days", "ej. 16 qt bucket · lasts 3–7 days")} />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-gray-600 mb-1">{t("yields", language)} (ES)</label>
                        <input className={inputCls} value={form.yieldsEs} onChange={e => updateField("yieldsEs", e.target.value)} placeholder="ej. Balde de 16 cuartos · dura 3–7 días" />
                    </div>
                </div>

                <div className="border-t pt-3 mt-3">
                    <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                        <h3 className="font-bold text-sm text-amber-800">⚠️ {tx("Allergens", "Alérgenos")}</h3>
                        <button type="button" onClick={handleAiFill} disabled={aiBusy}
                            className="text-[11px] font-bold px-3 py-1.5 rounded-full bg-purple-600 text-white disabled:opacity-60 shadow-sm">
                            {aiBusy ? tx('✨ Working…', '✨ Trabajando…') : tx('✨ Auto-fill Spanish + allergens', '✨ Completar español + alérgenos')}
                        </button>
                    </div>
                    <p className="text-[10px] text-gray-500 mb-2">
                        {tx("Tap to toggle. Shows as a banner on the recipe and drives the Avoid-allergen filter — tag EVERY allergen an ingredient carries (soy sauce = soy + wheat, oyster sauce = shellfish, hoisin = soy + wheat).",
                            "Toca para activar/desactivar. Se muestra como banner en la receta y alimenta el filtro Evitar alérgeno — marca TODOS los alérgenos (salsa de soya = soya + trigo, salsa de ostión = mariscos, hoisin = soya + trigo).")}
                    </p>
                    <div className="flex flex-wrap gap-1">
                        {ALLERGEN_ORDER.map(code => {
                            const active = (form.allergens || []).includes(code);
                            return (
                                <button key={code} type="button"
                                    onClick={() => toggleAllergen(code)}
                                    className={`text-[11px] font-bold px-2 py-1 rounded-full border ${active ? allergenTone(code) : 'bg-white text-gray-400 border-gray-300'}`}>
                                    {allergenEmoji(code)} {allergenLabel(code, language)}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {allowMedia && (
                    <p className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5">
                        📷 {tx('Tap 📷 on any English line to add photos or videos — they show on that line in both languages. Great for training: show the knife cut, the color when it’s done, the plating.',
                            'Toca 📷 en cualquier línea en inglés para agregar fotos o videos — se ven en esa línea en los dos idiomas. Ideal para entrenar: el corte, el color cuando está listo, el emplatado.')}
                    </p>
                )}

                {hasService && (
                    <div className="border-t-2 border-mint-600 pt-3 mt-3">
                        <h3 className="font-extrabold text-base text-mint-800">🥣 {tx('Prep', 'Preparación')}</h3>
                        <p className="text-[11px] text-gray-500">{tx('Made ahead in a batch — the multiplier scales this part.', 'Se prepara antes en lote — el multiplicador escala esta parte.')}</p>
                    </div>
                )}

                <div className="border-t pt-3 mt-3">
                    <h3 className="font-bold text-sm text-amber-800 mb-2">📝 {t("ingredients", language)} {countHint('ingredientsEn', 'ingredientsEs')}</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 md:gap-4">
                        {renderIngredientEditor("ingredientsEn", tx("English", "Inglés"))}
                        {renderIngredientEditor("ingredientsEs", tx("Spanish", "Español"))}
                    </div>
                </div>

                <div className="border-t pt-3 mt-3">
                    <h3 className="font-bold text-sm text-amber-800 mb-2">👨‍🍳 {t("instructions", language)} {countHint('instructionsEn', 'instructionsEs')}</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 md:gap-4">
                        {renderListEditor("instructionsEn", tx("English", "Inglés"))}
                        {renderListEditor("instructionsEs", tx("Spanish", "Español"))}
                    </div>
                </div>

                {hasService ? (
                    <>
                        <div className="border-t-2 border-orange-500 pt-3 mt-4 flex items-start justify-between gap-2">
                            <div>
                                <h3 className="font-extrabold text-base text-orange-700">🔥 {tx('Cook to order (service)', 'Al momento (servicio)')}</h3>
                                <p className="text-[11px] text-gray-500">{tx('What the line does for each order — amounts are per order and never multiplied.', 'Lo que hace la línea por cada orden — cantidades por orden, nunca se multiplican.')}</p>
                            </div>
                            <button type="button" disabled={uploading}
                                onClick={() => {
                                    const n = ['serviceIngredientsEn', 'serviceIngredientsEs', 'serviceInstructionsEn', 'serviceInstructionsEs']
                                        .reduce((a, f) => a + (form[f] || []).filter(x => String(x || '').trim()).length, 0);
                                    if (n && !confirm(tx('Remove the Cook-to-order section and its lines?', '¿Quitar la sección Al momento y sus líneas?'))) return;
                                    setHasService(false);
                                    setForm(prev => {
                                        const media = { ...(prev.media || {}) };
                                        delete media.svcIng; delete media.svcStep;
                                        return { ...prev, serviceIngredientsEn: [''], serviceIngredientsEs: [''], serviceInstructionsEn: [''], serviceInstructionsEs: [''], media };
                                    });
                                }}
                                className="text-[11px] text-red-600 font-bold underline flex-shrink-0 disabled:opacity-40">{tx('Remove section', 'Quitar sección')}</button>
                        </div>
                        <div className="border-t pt-3 mt-3">
                            <h3 className="font-bold text-sm text-orange-800 mb-2">📝 {tx('Ingredients per order', 'Ingredientes por orden')} {countHint('serviceIngredientsEn', 'serviceIngredientsEs')}</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 md:gap-4">
                                {renderIngredientEditor("serviceIngredientsEn", tx("English", "Inglés"))}
                                {renderIngredientEditor("serviceIngredientsEs", tx("Spanish", "Español"))}
                            </div>
                        </div>
                        <div className="border-t pt-3 mt-3">
                            <h3 className="font-bold text-sm text-orange-800 mb-2">👨‍🍳 {tx('Cook-to-order steps', 'Pasos al momento')} {countHint('serviceInstructionsEn', 'serviceInstructionsEs')}</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 md:gap-4">
                                {renderListEditor("serviceInstructionsEn", tx("English", "Inglés"))}
                                {renderListEditor("serviceInstructionsEs", tx("Spanish", "Español"))}
                            </div>
                        </div>
                    </>
                ) : (
                    <button type="button" onClick={() => setHasService(true)}
                        className="w-full mt-3 py-2.5 rounded-lg border-2 border-dashed border-orange-300 text-orange-700 text-sm font-bold bg-orange-50/50">
                        🔥 {tx('+ Add a Cook-to-order (service) section', '+ Agregar sección Al momento (servicio)')}
                    </button>
                )}

                <button
                    type="button"
                    onClick={handleSave}
                    disabled={aiBusy || saving || uploading}
                    className="w-full bg-mint-700 text-white font-bold py-3 rounded-lg text-lg mt-4 disabled:opacity-60"
                >
                    {uploading ? tx("Uploading…", "Subiendo…")
                        : saving ? tx("Saving…", "Guardando…")
                        : embedded ? tx("Done editing", "Listo") : isEdit ? tx("Save Changes", "Guardar Cambios") : tx("Add Recipe", "Agregar Receta")}
                </button>
            </div>
        </div>
    );
}
