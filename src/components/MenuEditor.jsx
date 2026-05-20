// MenuEditor — admin UI for editing the public menu shown on TVs.
//
// Andrew 2026-05-20 — Phase 2 of menu-TV feature. Lets owners
// change prices, descriptions, photos, add brand-new items, and
// hide items WITHOUT editing code. Writes to /menu_items/{slug}
// overrides; MenuDisplay applies on top of the static MENU_DATA
// base in real time.
//
// ─── UI flow ──────────────────────────────────────────────────
// Grouped by category:
//   • Each row: name, price (overridden price highlighted), badges
//     (custom / hidden), Edit button.
//   • Edit modal: name EN/ES, price, desc EN/ES, photo upload,
//     badge toggles, Save / Restore default / Hide / Delete custom.
//   • "Add custom item" button per category for menu items not in
//     MENU_DATA (e.g. specials, off-menu requests, new tests).
//
// ─── Data ─────────────────────────────────────────────────────
// Reads MENU_DATA + subscribes to /menu_items overrides.
// Photos upload to Firebase Storage at menu_photos/{slug}_{ts}.{ext}.
// All edits are logged via the audit trail in menuOverrides.js.

import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { storage } from '../firebase';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { MENU_DATA } from '../data/menu';
import {
    subscribeMenuOverrides, saveMenuOverride, deleteMenuOverride,
    applyMenuOverrides, makeMenuItemSlug,
} from '../data/menuOverrides';
import { toast } from '../toast';

// Lazy because the import modal pulls in pdfjs + the Claude vision
// pipeline. Most admin views don't need it.
const MenuImportModal = lazy(() => import('./MenuImportModal'));

export default function MenuEditor({ language = 'en', byName }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [overrides, setOverrides] = useState(() => new Map());
    const [editing, setEditing] = useState(null);   // { slug, baseItem, category, isCustom, isNew }
    const [filter, setFilter] = useState('all');     // all | edited | hidden | custom
    const [importing, setImporting] = useState(false);

    useEffect(() => {
        const unsub = subscribeMenuOverrides(setOverrides);
        return unsub;
    }, []);

    // Merge MENU_DATA + overrides for rendering. Each item carries
    // a _slug + an optional override doc for the editor.
    const merged = useMemo(() => {
        const out = applyMenuOverrides(MENU_DATA, overrides);
        // Attach override doc reference so the Edit button has it.
        return out.map(cat => ({
            ...cat,
            items: cat.items.map(item => ({
                ...item,
                _override: overrides.get(item._slug || makeMenuItemSlug(item.nameEn)) || null,
            })),
        }));
    }, [overrides]);

    // Also surface hidden items (applyMenuOverrides drops them, but
    // admin needs to be able to un-hide). Build a list of "hidden
    // entries" by looking up overrides that are hidden=true and
    // matching them back to MENU_DATA.
    const hiddenEntries = useMemo(() => {
        const hidden = [];
        for (const ov of overrides.values()) {
            if (ov.hidden !== true || ov.isCustom) continue;
            // Find base item from MENU_DATA
            for (const cat of MENU_DATA) {
                for (const baseItem of (cat.items || [])) {
                    if (makeMenuItemSlug(baseItem.nameEn) === ov.slug) {
                        hidden.push({ category: cat.category, baseItem, override: ov });
                    }
                }
            }
        }
        return hidden;
    }, [overrides]);

    // Categories list (for "add custom item" + sectioning).
    const categories = useMemo(() => MENU_DATA.map(c => c.category), []);

    const openEdit = (categoryName, baseItem, opts = {}) => {
        const slug = baseItem
            ? makeMenuItemSlug(baseItem.nameEn)
            : opts.slug || makeMenuItemSlug(opts.newName || `new-${Date.now()}`);
        const override = overrides.get(slug) || null;
        setEditing({
            slug,
            category: categoryName,
            baseItem: baseItem || null,
            override,
            isCustom: opts.isCustom === true,
            isNew: opts.isNew === true,
        });
    };

    return (
        <div className="mt-6 mb-4 bg-white border-2 border-amber-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-2xl">🍽</span>
                <h3 className="text-base font-bold text-amber-900">
                    {tx('Public menu (TV boards)', 'Menú público (TVs)')}
                </h3>
                <span className="text-[10px] font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-300">
                    {overrides.size} {tx('overrides', 'cambios')}
                </span>
                <button onClick={() => setImporting(true)}
                    className="ml-auto px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white text-xs font-black hover:opacity-90 transition shadow-sm">
                    🤖 {tx('Import from PDF / JPEG', 'Importar de PDF / JPEG')}
                </button>
            </div>
            <p className="text-[11px] text-amber-700 mb-3 leading-snug">
                {tx(
                    'Edit prices / descriptions / photos for menu items shown on the TV boards. Changes propagate to all TVs within seconds. Hidden items stay in the DB but disappear from the boards. Add custom items for specials or off-menu prep.',
                    'Edita precios / descripciones / fotos del menú en TVs. Los cambios se reflejan en segundos. Los ocultos siguen en la base pero desaparecen de las pantallas. Añade items personalizados para especiales.',
                )}
            </p>

            {/* Filter chips */}
            <div className="flex items-center gap-1.5 flex-wrap mb-3">
                {[
                    { k: 'all',     en: 'All items',      es: 'Todos' },
                    { k: 'edited',  en: '✏️ Edited',       es: '✏️ Editados' },
                    { k: 'custom',  en: '➕ Custom',       es: '➕ Personalizados' },
                    { k: 'hidden',  en: '🙈 Hidden',       es: '🙈 Ocultos' },
                ].map(f => (
                    <button key={f.k}
                        onClick={() => setFilter(f.k)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${
                            filter === f.k
                                ? 'bg-amber-600 text-white border-amber-700'
                                : 'bg-white text-amber-800 border-amber-300 hover:bg-amber-50'
                        }`}>
                        {tx(f.en, f.es)}
                    </button>
                ))}
            </div>

            <div className="space-y-4">
                {merged.map(cat => {
                    const visibleItems = cat.items.filter(item => {
                        if (filter === 'edited') return !!item._override && !item._override.hidden;
                        if (filter === 'custom') return item._isCustom;
                        if (filter === 'hidden') return false;
                        return true;
                    });
                    if (visibleItems.length === 0 && filter !== 'all') return null;
                    return (
                        <section key={cat.category}>
                            <div className="flex items-center justify-between mb-1.5 px-1">
                                <h4 className="text-xs font-black uppercase tracking-widest text-amber-800">
                                    {cat.category}
                                </h4>
                                {filter === 'all' && (
                                    <button onClick={() => openEdit(cat.category, null, { isCustom: true, isNew: true })}
                                        className="text-[11px] font-bold text-amber-700 hover:text-amber-900 hover:underline">
                                        + {tx('Add item', 'Agregar')}
                                    </button>
                                )}
                            </div>
                            <div className="space-y-1">
                                {visibleItems.map(item => (
                                    <MenuItemRow key={item._slug || item.nameEn}
                                        item={item}
                                        category={cat.category}
                                        onEdit={() => openEdit(cat.category, item.nameEn ? { nameEn: item.nameEn } : null, {
                                            isCustom: item._isCustom === true,
                                            slug: item._slug,
                                        })}
                                        tx={tx} />
                                ))}
                            </div>
                        </section>
                    );
                })}

                {/* Hidden section — only shown in 'all' or 'hidden' filter */}
                {(filter === 'all' || filter === 'hidden') && hiddenEntries.length > 0 && (
                    <section>
                        <h4 className="text-xs font-black uppercase tracking-widest text-amber-800 mb-1.5 px-1">
                            🙈 {tx('Hidden from TVs', 'Ocultos en TVs')}
                        </h4>
                        <div className="space-y-1">
                            {hiddenEntries.map(({ category, baseItem, override }) => (
                                <div key={override.slug}
                                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-stone-100 border border-stone-300 opacity-70">
                                    <span className="flex-1 text-sm font-bold text-stone-700 line-through">{baseItem.nameEn}</span>
                                    <span className="text-[10px] text-stone-500 font-mono">{category}</span>
                                    <button onClick={() => openEdit(category, baseItem, { slug: override.slug })}
                                        className="px-2 py-1 text-[10px] font-bold text-amber-700 hover:bg-amber-50 rounded">
                                        {tx('Edit', 'Editar')}
                                    </button>
                                </div>
                            ))}
                        </div>
                    </section>
                )}
            </div>

            {editing && (
                <EditModal editing={editing}
                    categories={categories}
                    onClose={() => setEditing(null)}
                    byName={byName}
                    tx={tx} />
            )}

            {importing && (
                <Suspense fallback={null}>
                    <MenuImportModal language={language}
                        byName={byName}
                        onClose={() => setImporting(false)} />
                </Suspense>
            )}
        </div>
    );
}

// One row in the editor list. Shows current price (overridden in
// amber when it's been changed), edit button, and any badges.
function MenuItemRow({ item, category, onEdit, tx }) {
    const ov = item._override;
    const hasOverride = ov && !ov.hidden && !ov.isCustom;
    const priceChanged = hasOverride && ov.price && ov.price !== '';
    return (
        <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border ${
            item._isCustom
                ? 'bg-purple-50/50 border-purple-200'
                : hasOverride
                    ? 'bg-amber-50/50 border-amber-200'
                    : 'bg-white border-dd-line'
        }`}>
            {item.photoUrl && (
                <img src={item.photoUrl} alt=""
                    className="w-8 h-8 rounded object-cover bg-dd-bg flex-shrink-0" />
            )}
            <span className="flex-1 text-sm font-bold text-dd-text">{item.nameEn}</span>
            <span className={`text-sm font-black tabular-nums ${priceChanged ? 'text-amber-700' : 'text-dd-text-2'}`}>
                {item.price}
            </span>
            {item._isCustom && (
                <span className="text-[9px] font-black uppercase tracking-wide text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">
                    {tx('Custom', 'Custom')}
                </span>
            )}
            {hasOverride && !item._isCustom && (
                <span className="text-[9px] font-black uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                    {tx('Edited', 'Editado')}
                </span>
            )}
            <button onClick={onEdit}
                className="px-2 py-1 text-[11px] font-bold text-amber-700 hover:bg-amber-100 rounded transition">
                {tx('Edit', 'Editar')}
            </button>
        </div>
    );
}

// Edit modal — handles both override-existing and add-custom flows.
// Photo upload is in-modal; we upload to Storage on Save, not on
// pick, so a cancelled edit doesn't orphan a file.
function EditModal({ editing, categories, onClose, byName, tx }) {
    const { slug, baseItem, override, isCustom, isNew, category } = editing;
    // Form state — initialized from override > baseItem.
    const [nameEn, setNameEn] = useState(override?.nameEn || baseItem?.nameEn || '');
    const [nameEs, setNameEs] = useState(override?.nameEs || baseItem?.nameEs || '');
    const [price, setPrice]   = useState(override?.price  || baseItem?.price  || '');
    const [descEn, setDescEn] = useState(override?.descEn || baseItem?.descEn || '');
    const [descEs, setDescEs] = useState(override?.descEs || baseItem?.descEs || '');
    const [categoryDraft, setCategoryDraft] = useState(category || categories[0] || '');
    const [photoUrl, setPhotoUrl] = useState(override?.photoUrl || baseItem?.photoUrl || '');
    const [photoFile, setPhotoFile] = useState(null);
    const [photoPreview, setPhotoPreview] = useState(null);
    const [spicy, setSpicy] = useState(override?.spicy ?? baseItem?.spicy ?? false);
    const [vegan, setVegan] = useState(override?.vegan ?? baseItem?.vegan ?? false);
    const [glutenFree, setGlutenFree] = useState(override?.glutenFree ?? baseItem?.glutenFree ?? false);
    const [popular, setPopular] = useState(override?.popular ?? baseItem?.popular ?? false);
    const [hidden, setHidden] = useState(override?.hidden === true);
    const [saving, setSaving] = useState(false);

    const handlePhotoSelect = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 4 * 1024 * 1024) {
            toast(tx('Photo too large (max 4 MB).', 'Foto muy grande (máx 4 MB).'), { kind: 'error' });
            return;
        }
        setPhotoFile(file);
        const reader = new FileReader();
        reader.onload = (ev) => setPhotoPreview(ev.target.result);
        reader.readAsDataURL(file);
    };

    const save = async () => {
        if (saving) return;
        if (!nameEn.trim()) {
            toast(tx('Name is required.', 'El nombre es obligatorio.'), { kind: 'error' });
            return;
        }
        setSaving(true);
        try {
            // Re-derive slug for custom NEW items so it tracks the
            // current name. For existing items keep the original slug
            // so the override binds back to the same MENU_DATA entry
            // even if admin tweaks the display name.
            const finalSlug = isNew ? makeMenuItemSlug(nameEn) : slug;

            // Photo upload (if a new file was picked).
            let finalPhotoUrl = photoUrl;
            if (photoFile) {
                const ext = (photoFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
                const path = `menu_photos/${finalSlug}_${Date.now()}.${ext}`;
                const pref = storageRef(storage, path);
                await uploadBytes(pref, photoFile);
                finalPhotoUrl = await getDownloadURL(pref);
            }

            // Build payload — only fields the admin actually set, so
            // empty/unchanged fields fall back to MENU_DATA at render.
            const payload = {
                slug: finalSlug,
                category: categoryDraft,
                isCustom,
                hidden,
                nameEn: nameEn.trim(),
                nameEs: nameEs.trim() || null,
                price: price.trim() || null,
                descEn: descEn.trim() || null,
                descEs: descEs.trim() || null,
                photoUrl: finalPhotoUrl || null,
                spicy: !!spicy,
                vegan: !!vegan,
                glutenFree: !!glutenFree,
                popular: !!popular,
            };
            await saveMenuOverride({ slug: finalSlug, payload, byName });
            toast(tx('✓ Saved', '✓ Guardado'), { kind: 'success' });
            onClose();
        } catch (e) {
            console.warn('saveMenuOverride failed:', e);
            toast(tx('Save failed: ', 'Error al guardar: ') + (e?.message || ''), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const restoreDefault = async () => {
        if (!override) { onClose(); return; }
        const ok = window.confirm(tx(
            'Drop all overrides for this item and restore the default price/description?',
            '¿Restaurar precio/descripción por defecto?',
        ));
        if (!ok) return;
        setSaving(true);
        try {
            // Best-effort: also delete the uploaded photo from Storage.
            if (override.photoUrl && override.photoUrl.includes('menu_photos%2F')) {
                try {
                    // Reconstruct the storage path from the download URL.
                    const m = decodeURIComponent(override.photoUrl).match(/menu_photos\/[^?]+/);
                    if (m) await deleteObject(storageRef(storage, m[0]));
                } catch (e) { console.warn('photo cleanup skipped:', e); }
            }
            await deleteMenuOverride({ slug: override.slug, byName });
            toast(tx('✓ Restored to default', '✓ Restaurado'), { kind: 'success' });
            onClose();
        } catch (e) {
            console.warn('restoreDefault failed:', e);
            toast(tx('Restore failed', 'Error al restaurar'), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/40"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
                <header className="bg-amber-600 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                    <div>
                        <div className="text-base font-black">
                            {isNew
                                ? tx('Add custom item', 'Agregar item')
                                : tx('Edit item', 'Editar item')}
                        </div>
                        <div className="text-[11px] opacity-90">{category || categoryDraft}</div>
                    </div>
                    <button onClick={onClose}
                        className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 transition text-lg font-black">
                        ✕
                    </button>
                </header>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {/* Photo */}
                    <div className="flex items-start gap-3">
                        <div className="w-24 h-24 rounded-lg bg-dd-bg border border-dd-line overflow-hidden flex items-center justify-center flex-shrink-0">
                            {photoPreview || photoUrl ? (
                                <img src={photoPreview || photoUrl} alt="" className="w-full h-full object-cover" />
                            ) : (
                                <span className="text-3xl opacity-40">🍽</span>
                            )}
                        </div>
                        <div className="flex-1 space-y-1.5">
                            <label className="block">
                                <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                    {tx('Photo (optional)', 'Foto (opcional)')}
                                </span>
                                <input type="file" accept="image/*"
                                    onChange={handlePhotoSelect}
                                    className="w-full text-[11px]" />
                            </label>
                            {photoUrl && (
                                <button onClick={() => { setPhotoUrl(''); setPhotoFile(null); setPhotoPreview(null); }}
                                    type="button"
                                    className="text-[11px] text-red-600 hover:underline">
                                    {tx('Remove photo', 'Quitar foto')}
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Category (only editable for custom NEW items) */}
                    {(isCustom && isNew) && (
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                {tx('Category', 'Categoría')}
                            </span>
                            <select value={categoryDraft}
                                onChange={(e) => setCategoryDraft(e.target.value)}
                                className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white">
                                {categories.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </label>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                {tx('Name (English)', 'Nombre (Inglés)')}
                            </span>
                            <input type="text" value={nameEn}
                                onChange={(e) => setNameEn(e.target.value)}
                                className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white" />
                        </label>
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                {tx('Name (Español)', 'Nombre (Español)')}
                            </span>
                            <input type="text" value={nameEs}
                                onChange={(e) => setNameEs(e.target.value)}
                                placeholder={tx('Optional', 'Opcional')}
                                className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white" />
                        </label>
                    </div>

                    <label className="block">
                        <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                            {tx('Price (e.g. $18)', 'Precio (ej. $18)')}
                        </span>
                        <input type="text" value={price}
                            onChange={(e) => setPrice(e.target.value)}
                            placeholder="$18"
                            className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white font-bold tabular-nums" />
                    </label>

                    <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                {tx('Description (EN)', 'Descripción (EN)')}
                            </span>
                            <textarea value={descEn}
                                onChange={(e) => setDescEn(e.target.value)}
                                rows={2}
                                className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white" />
                        </label>
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                {tx('Description (ES)', 'Descripción (ES)')}
                            </span>
                            <textarea value={descEs}
                                onChange={(e) => setDescEs(e.target.value)}
                                rows={2}
                                className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white" />
                        </label>
                    </div>

                    {/* Badges */}
                    <div>
                        <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-1">
                            {tx('Badges', 'Distintivos')}
                        </span>
                        <div className="flex items-center gap-2 flex-wrap">
                            {[
                                { k: 'popular',    val: popular,    set: setPopular,    en: '⭐ Popular',     es: '⭐ Popular' },
                                { k: 'spicy',      val: spicy,      set: setSpicy,      en: '🌶 Spicy',       es: '🌶 Picante' },
                                { k: 'vegan',      val: vegan,      set: setVegan,      en: '🌱 Vegan',       es: '🌱 Vegano' },
                                { k: 'glutenFree', val: glutenFree, set: setGlutenFree, en: '🌾 Gluten-free', es: '🌾 Sin gluten' },
                            ].map(b => (
                                <button key={b.k} type="button"
                                    onClick={() => b.set(!b.val)}
                                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border-2 transition ${
                                        b.val
                                            ? 'bg-amber-600 text-white border-amber-700'
                                            : 'bg-white text-amber-800 border-amber-200 hover:bg-amber-50'
                                    }`}>
                                    {tx(b.en, b.es)}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Hide toggle */}
                    {!isNew && (
                        <label className="flex items-center gap-2 p-2 rounded-lg bg-stone-50 border border-stone-200">
                            <input type="checkbox" checked={hidden}
                                onChange={(e) => setHidden(e.target.checked)}
                                className="w-4 h-4 accent-stone-700" />
                            <span className="text-[12px] font-bold text-stone-700">
                                🙈 {tx('Hide from TV boards', 'Ocultar en TVs')}
                            </span>
                            <span className="text-[10px] text-stone-500 ml-auto italic">
                                {tx('keeps history', 'mantiene historial')}
                            </span>
                        </label>
                    )}
                </div>

                <footer className="border-t border-dd-line p-3 flex gap-2 flex-shrink-0">
                    {override && !isNew && (
                        <button onClick={restoreDefault}
                            disabled={saving}
                            className="px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-700 text-xs font-bold hover:bg-stone-50 disabled:opacity-40">
                            {tx('Restore default', 'Restaurar')}
                        </button>
                    )}
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-white border border-dd-line text-dd-text font-bold hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={save} disabled={saving || !nameEn.trim()}
                        className="flex-1 py-2 rounded-lg bg-amber-600 text-white font-bold hover:bg-amber-700 disabled:opacity-40">
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                </footer>
            </div>
        </div>
    );
}
