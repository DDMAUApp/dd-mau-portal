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

import { useMemo, useState } from 'react';
import { t } from '../data/translations';
import { ALLERGEN_ORDER, allergenLabel, allergenEmoji, allergenTone } from '../data/allergens';
import { splitIngredientLine, joinIngredientParts, unitsFor } from '../data/ingredientParts';
import { toast } from '../toast';

export const BLANK_RECIPE = {
    titleEn: "", titleEs: "", emoji: "🍽️", category: "",
    prepTimeEn: "", cookTimeEn: "",
    yieldsEn: "", yieldsEs: "",
    allergens: [],
    ingredientsEn: [""], ingredientsEs: [""],
    instructionsEn: [""], instructionsEs: [""],
};

export default function RecipeForm({ language, recipe, categories = [], embedded = false, onSave, onCancel }) {
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
        };
    });
    const [aiBusy, setAiBusy] = useState(false);

    const toggleAllergen = (code) => {
        setForm(prev => {
            const cur = Array.isArray(prev.allergens) ? prev.allergens : [];
            return { ...prev, allergens: cur.includes(code) ? cur.filter(c => c !== code) : [...cur, code] };
        });
    };
    const updateField = (field, val) => setForm(prev => ({ ...prev, [field]: val }));
    const updateListItem = (field, idx, val) => setForm(prev => {
        const arr = [...prev[field]];
        arr[idx] = val;
        return { ...prev, [field]: arr };
    });
    const addListItem = (field) => setForm(prev => ({ ...prev, [field]: [...prev[field], ""] }));
    const removeListItem = (field, idx) => setForm(prev => {
        if (prev[field].length <= 1) return { ...prev, [field]: [""] };
        return { ...prev, [field]: prev[field].filter((_, i) => i !== idx) };
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
            const arr = [...prev[field]];
            const cur = (arr[idx] || '').trim();
            arr.splice(idx, 1, ...(cur ? [cur + ' ' + rows[0], ...rows.slice(1)] : rows));
            return { ...prev, [field]: arr };
        });
    };

    const categoryOptions = useMemo(() => {
        const seen = new Set();
        const out = [];
        for (const c of categories) { const k = String(c || '').trim(); if (k && !seen.has(k)) { seen.add(k); out.push(k); } }
        return out;
    }, [categories]);

    const cleanedForm = () => {
        const clean = (arr) => (Array.isArray(arr) ? arr.map(s => String(s ?? '').trim()).filter(Boolean) : []);
        return {
            ...form,
            titleEn: form.titleEn.trim(),
            titleEs: (form.titleEs || '').trim(),
            category: (form.category || '').trim(),
            emoji: (form.emoji || '').trim() || '🍽️',
            allergens: Array.isArray(form.allergens) ? form.allergens : [],
            ingredientsEn: clean(form.ingredientsEn),
            ingredientsEs: clean(form.ingredientsEs),
            instructionsEn: clean(form.instructionsEn),
            instructionsEs: clean(form.instructionsEs),
        };
    };

    const handleSave = () => {
        if (!form.titleEn.trim()) { toast(tx("English title is required", "Se requiere título en inglés")); return; }
        const cleaned = cleanedForm();
        if (cleaned.ingredientsEn.length === 0 && cleaned.ingredientsEs.length === 0) {
            toast(tx("Add at least one ingredient", "Agrega al menos un ingrediente")); return;
        }
        onSave(cleaned);
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
            const ai = await completeRecipeDraft(src, { categories: categoryOptions });
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
                const merged = new Set([...(prev.allergens || []), ...(ai.allergens || [])]);
                next.allergens = ALLERGEN_ORDER.filter(c => merged.has(c));
                return next;
            });
            const addedTags = (ai.allergens || []).filter(c => !(cleanedForm().allergens || []).includes(c));
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
                {form[field].map((item, i) => {
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
                        <div key={i} className="flex gap-1 mb-1">
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
                            <button type="button" onClick={() => { setRowDraft(null); removeListItem(field, i); }} className="text-red-400 text-sm px-1" aria-label="remove">✕</button>
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
            {form[field].map((item, i) => (
                <div key={i} className="flex gap-1 mb-1">
                    <span className="text-xs text-gray-400 mt-2 w-5 text-right flex-shrink-0">{i + 1}.</span>
                    <input
                        className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1.5 text-sm"
                        value={item}
                        onChange={e => updateListItem(field, i, e.target.value)}
                        onPaste={e => pasteList(field, i, e)}
                        placeholder={`${label} ${i + 1}`}
                    />
                    <button type="button" onClick={() => removeListItem(field, i)} className="text-red-400 text-sm px-1" aria-label="remove">✕</button>
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
                <button type="button" onClick={onCancel} className="text-gray-500 text-sm underline">{tx("Cancel", "Cancelar")}</button>
            </div>

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

                <button
                    type="button"
                    onClick={handleSave}
                    disabled={aiBusy}
                    className="w-full bg-mint-700 text-white font-bold py-3 rounded-lg text-lg mt-4 disabled:opacity-60"
                >
                    {embedded ? tx("Done editing", "Listo") : isEdit ? tx("Save Changes", "Guardar Cambios") : tx("Add Recipe", "Agregar Receta")}
                </button>
            </div>
        </div>
    );
}
