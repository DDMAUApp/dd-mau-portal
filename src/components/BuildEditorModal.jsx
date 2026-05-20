// BuildEditorModal — admin-only editor for a menu item's build sheet.
//
// Andrew 2026-05-20 — "add a edit button that just admin can change
// to all the items".
//
// Pre-populates with the current build (static + any existing
// override). Admin can rename, change kind, add, delete components.
// Save writes a full replacement override to /build_overrides/{slug}.
// Restore-to-default deletes the override doc.

import { useEffect, useMemo, useState } from 'react';
import { toast } from '../toast';
import { COMPONENT_KIND_TONE } from '../data/itemBuild';
import { getBuildOverride, saveBuildOverride, deleteBuildOverride } from '../data/buildOverrides';
import { saveCustomItem, deleteCustomItem, makeCustomItemSlug } from '../data/customItems';

const KIND_OPTIONS = ['base', 'topping', 'protein', 'sauce', 'broth', 'side', 'garnish'];

export default function BuildEditorModal({
    menuItem,             // { id (slug), nameEn, nameEs, ... }
    initialComponents,    // static + existing-override components
    initialNotes = [],    // editable notes from override (or static)
    initialShelfLifeDays, // override shelf-life if set
    isCustom = false,     // true when this menuItem is in /custom_items
    isNew = false,        // true when creating a fresh custom item
    staffName,
    language = 'en',
    onClose,
    onSaved,              // called after a successful save
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    // Seed editable rows from the resolved build. Strip notes — those
    // come from the cashier-training source and aren't editable here.
    const seedRows = useMemo(() => {
        const printable = (initialComponents || []).filter(c => c.kind !== 'note');
        return printable.map((c, idx) => ({
            id: c.id || `row-${idx}-${Date.now().toString(36)}`,
            kind: c.kind || 'side',
            nameEn: c.nameEn || '',
            nameEs: c.nameEs || '',
            descEn: c.descEn || '',
            descEs: c.descEs || '',
        }));
    }, [initialComponents]);
    const [rows, setRows] = useState(seedRows);
    const [originalJson] = useState(() => JSON.stringify(seedRows));
    const [saving, setSaving] = useState(false);
    const [hasExistingOverride, setHasExistingOverride] = useState(false);

    // Shelf-life + notes editing (Phase 2b). Both fields are
    // OPTIONAL on the override; staff still tweak shelf-life on
    // the print modal slider, this just sets the smart default.
    const [shelfLifeDays, setShelfLifeDays] = useState(
        Number.isFinite(initialShelfLifeDays) ? initialShelfLifeDays : ''
    );
    const [notes, setNotes] = useState(
        Array.isArray(initialNotes)
            ? initialNotes.map(n => ({ ...n }))
            : []
    );

    // Custom-item-only fields. When isCustom/isNew, the menu name
    // and category are editable here. (For regular menu items the
    // name comes from menu.js and is not editable.)
    const [customName, setCustomName] = useState(menuItem?.nameEn || '');
    const [customNameEs, setCustomNameEs] = useState(menuItem?.nameEs || '');
    const [customCategory, setCustomCategory] = useState(menuItem?.category || 'Custom');
    const [customAllergens, setCustomAllergens] = useState(menuItem?.allergens || '');

    useEffect(() => {
        if (isCustom || isNew) {
            setHasExistingOverride(false);
            return;
        }
        (async () => {
            const existing = await getBuildOverride(menuItem.id);
            setHasExistingOverride(!!existing);
        })();
    }, [menuItem.id, isCustom, isNew]);

    const isDirty = JSON.stringify(rows) !== originalJson;

    const updateRow = (rowId, field, val) => {
        setRows(rs => rs.map(r => r.id === rowId ? { ...r, [field]: val } : r));
    };
    const moveRow = (rowId, dir) => {
        const idx = rows.findIndex(r => r.id === rowId);
        if (idx < 0) return;
        const j = idx + dir;
        if (j < 0 || j >= rows.length) return;
        const next = [...rows];
        [next[idx], next[j]] = [next[j], next[idx]];
        setRows(next);
    };
    const addRow = () => {
        setRows(rs => [...rs, {
            id: `row-${rs.length}-${Date.now().toString(36)}`,
            kind: 'topping',
            nameEn: '',
            nameEs: '',
            descEn: '',
            descEs: '',
        }]);
    };
    const removeRow = (rowId) => {
        setRows(rs => rs.filter(r => r.id !== rowId));
    };

    const handleSave = async () => {
        if (saving) return;
        // Custom-item path needs a name first.
        if ((isCustom || isNew) && !customName.trim()) {
            toast(tx('Type a name first.', 'Escribe un nombre primero.'), { kind: 'error' });
            return;
        }
        const cleaned = rows
            .filter(r => r.nameEn.trim())
            .map(r => ({
                id: r.id,
                kind: r.kind,
                nameEn: r.nameEn.trim(),
                nameEs: r.nameEs.trim() || r.nameEn.trim(),
                ...(r.descEn.trim() ? { descEn: r.descEn.trim() } : {}),
                ...(r.descEs.trim() ? { descEs: r.descEs.trim() } : {}),
            }));
        if (cleaned.length === 0) {
            toast(tx('Add at least one component first.', 'Añade al menos un componente.'), { kind: 'error' });
            return;
        }
        const cleanShelfLife = shelfLifeDays === '' || shelfLifeDays == null
            ? null
            : Math.max(1, Math.min(60, Math.floor(Number(shelfLifeDays))));
        const cleanNotes = notes
            .map(n => ({ en: (n.en || '').trim(), es: (n.es || n.en || '').trim() }))
            .filter(n => n.en);

        setSaving(true);
        try {
            if (isCustom || isNew) {
                const slug = isNew ? makeCustomItemSlug(customName) : menuItem.id;
                await saveCustomItem({
                    slug,
                    nameEn: customName.trim(),
                    nameEs: customNameEs.trim() || customName.trim(),
                    category: customCategory.trim() || 'Custom',
                    categoryEs: customCategory.trim() || 'Custom',
                    allergens: customAllergens.trim(),
                    components: cleaned,
                    shelfLifeDays: cleanShelfLife,
                    notes: cleanNotes,
                    byName: staffName,
                });
            } else {
                await saveBuildOverride({
                    menuItemSlug: menuItem.id,
                    menuItemName: menuItem.nameEn,
                    components: cleaned,
                    shelfLifeDays: cleanShelfLife,
                    notes: cleanNotes,
                    byName: staffName,
                });
            }
            toast(tx('✓ Saved', '✓ Guardado'), { kind: 'success' });
            onSaved?.();
            onClose();
        } catch (e) {
            console.error('save override failed:', e);
            toast(tx('Save failed: ', 'Error: ') + (e?.message || ''), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const handleRestoreDefault = async () => {
        if (isCustom) {
            if (!window.confirm(tx(
                'Delete this custom item? This cannot be undone.',
                '¿Eliminar este artículo personalizado? No se puede deshacer.',
            ))) return;
            setSaving(true);
            try {
                await deleteCustomItem({
                    slug: menuItem.id,
                    nameEn: menuItem.nameEn,
                    byName: staffName,
                });
                toast(tx('✓ Deleted', '✓ Eliminado'), { kind: 'success' });
                onSaved?.();
                onClose();
            } catch (e) {
                console.error('delete custom failed:', e);
                toast(tx('Delete failed: ', 'Error: ') + (e?.message || ''), { kind: 'error' });
            } finally {
                setSaving(false);
            }
            return;
        }
        if (!hasExistingOverride) {
            toast(tx('Already on the default.', 'Ya está en el predeterminado.'));
            return;
        }
        if (!window.confirm(tx(
            'Restore the default build sheet? Your custom edits for this item will be deleted.',
            '¿Restaurar el build predeterminado? Tus cambios se borrarán.',
        ))) return;
        setSaving(true);
        try {
            await deleteBuildOverride({
                menuItemSlug: menuItem.id,
                menuItemName: menuItem.nameEn,
                byName: staffName,
            });
            toast(tx('✓ Restored to default', '✓ Restaurado'), { kind: 'success' });
            onSaved?.();
            onClose();
        } catch (e) {
            console.error('restore default failed:', e);
            toast(tx('Restore failed: ', 'Error: ') + (e?.message || ''), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    // Notes helpers
    const addNote = () => setNotes(ns => [...ns, { en: '', es: '' }]);
    const updateNote = (i, field, val) => setNotes(ns => ns.map((n, j) => j === i ? { ...n, [field]: val } : n));
    const removeNote = (i) => setNotes(ns => ns.filter((_, j) => j !== i));

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl h-[100dvh] sm:h-auto sm:max-h-[92vh] flex flex-col">
                {/* Header */}
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between safe-top flex-shrink-0">
                    <div className="min-w-0">
                        <h2 className="text-base font-black text-dd-text truncate">
                            ✏️ {tx('Edit build', 'Editar composición')}
                        </h2>
                        <div className="text-xs text-dd-text-2 truncate">
                            {isEs ? (menuItem.nameEs || menuItem.nameEn) : menuItem.nameEn}
                            {hasExistingOverride && (
                                <span className="ml-2 text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded-full">
                                    {tx('CUSTOM', 'PERSONALIZADO')}
                                </span>
                            )}
                        </div>
                    </div>
                    <button onClick={onClose}
                        className="w-9 h-9 rounded-full bg-dd-bg text-dd-text-2 text-lg hover:bg-dd-line flex-shrink-0">×</button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {/* Custom-item identity — only when creating or
                        editing a custom item. Regular menu items get
                        their name from menu.js and are not editable
                        here. */}
                    {(isCustom || isNew) && (
                        <div className="bg-purple-50/40 border border-purple-200 rounded-lg p-3 space-y-2">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-purple-800">
                                {isNew
                                    ? tx('🆕 New custom item', '🆕 Nuevo artículo personalizado')
                                    : tx('✏️ Custom item', '✏️ Artículo personalizado')}
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <input type="text" value={customName}
                                    onChange={(e) => setCustomName(e.target.value.slice(0, 120))}
                                    placeholder={tx('Name (EN)', 'Nombre (EN)')}
                                    className="px-2 py-1.5 rounded border border-purple-200 text-sm bg-white" />
                                <input type="text" value={customNameEs}
                                    onChange={(e) => setCustomNameEs(e.target.value.slice(0, 120))}
                                    placeholder={tx('Name (ES, optional)', 'Nombre (ES, opcional)')}
                                    className="px-2 py-1.5 rounded border border-purple-200 text-sm bg-white" />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <input type="text" value={customCategory}
                                    onChange={(e) => setCustomCategory(e.target.value.slice(0, 60))}
                                    placeholder={tx('Category (e.g. "Sauces", "Prep")', 'Categoría')}
                                    className="px-2 py-1.5 rounded border border-purple-200 text-sm bg-white" />
                                <input type="text" value={customAllergens}
                                    onChange={(e) => setCustomAllergens(e.target.value.slice(0, 300))}
                                    placeholder={tx('Allergens (e.g. "Soy, Sesame")', 'Alérgenos')}
                                    className="px-2 py-1.5 rounded border border-purple-200 text-sm bg-white" />
                            </div>
                        </div>
                    )}

                    {/* Shelf-life default for this item */}
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-900 flex-1">
                                🗓 {tx('Default shelf life (days)', 'Días de vida útil')}
                            </span>
                            <input type="number" min="1" max="60"
                                value={shelfLifeDays}
                                onChange={(e) => setShelfLifeDays(e.target.value)}
                                placeholder={tx('e.g. 5', 'ej. 5')}
                                className="w-20 px-2 py-1 rounded border border-amber-300 text-sm font-bold text-center bg-white" />
                            <button onClick={() => setShelfLifeDays('')}
                                className="text-[10px] font-bold text-amber-700 hover:underline">
                                {tx('Clear', 'Limpiar')}
                            </button>
                        </div>
                        <p className="text-[10px] text-amber-800/80 italic mt-1">
                            {tx(
                                'Used as the smart default when staff print this item. Empty = use the category default (Sauces 7d, Proteins 3d, etc.). Cooks can still nudge the slider per-print.',
                                'Predeterminado al imprimir. Vacío = usar el predeterminado de la categoría (Salsas 7d, Proteínas 3d, etc.).',
                            )}
                        </p>
                    </div>

                    <p className="text-[11px] text-dd-text-2 italic mb-1">
                        {tx(
                            'Add, rename, reorder, or delete components. Each will print as a separate sticker.',
                            'Añade, renombra, reordena o elimina componentes. Cada uno imprime una etiqueta.',
                        )}
                    </p>

                    {rows.length === 0 && (
                        <p className="text-sm text-dd-text-2 italic text-center py-6">
                            {tx('No components yet. Tap "Add" below.', 'Sin componentes. Toca "Añadir".')}
                        </p>
                    )}

                    {rows.map((row, idx) => {
                        const tone = COMPONENT_KIND_TONE[row.kind] || COMPONENT_KIND_TONE.side;
                        return (
                            <div key={row.id}
                                className={`border border-dd-line rounded-lg p-2.5 ${tone.bg}`}>
                                <div className="flex items-center gap-1 mb-1">
                                    <span className="text-base">{tone.icon}</span>
                                    <select value={row.kind}
                                        onChange={(e) => updateRow(row.id, 'kind', e.target.value)}
                                        className="flex-shrink-0 text-[11px] font-bold bg-white border border-dd-line rounded px-1.5 py-0.5">
                                        {KIND_OPTIONS.map(k => (
                                            <option key={k} value={k}>
                                                {isEs
                                                    ? (COMPONENT_KIND_TONE[k]?.labelEs || k)
                                                    : (COMPONENT_KIND_TONE[k]?.labelEn || k)}
                                            </option>
                                        ))}
                                    </select>
                                    <div className="flex-1" />
                                    <button onClick={() => moveRow(row.id, -1)} disabled={idx === 0}
                                        className="w-7 h-7 rounded text-dd-text-2 disabled:opacity-30 hover:bg-white text-sm">▲</button>
                                    <button onClick={() => moveRow(row.id, 1)} disabled={idx === rows.length - 1}
                                        className="w-7 h-7 rounded text-dd-text-2 disabled:opacity-30 hover:bg-white text-sm">▼</button>
                                    <button onClick={() => removeRow(row.id)}
                                        title={tx('Delete', 'Eliminar')}
                                        className="w-7 h-7 rounded text-red-600 hover:bg-red-50 text-sm">✕</button>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <input type="text"
                                        value={row.nameEn}
                                        onChange={(e) => updateRow(row.id, 'nameEn', e.target.value)}
                                        placeholder={tx('English name', 'Nombre (EN)')}
                                        className="px-2 py-1.5 rounded border border-dd-line text-sm bg-white" />
                                    <input type="text"
                                        value={row.nameEs}
                                        onChange={(e) => updateRow(row.id, 'nameEs', e.target.value)}
                                        placeholder={tx('Spanish name (optional)', 'Nombre (ES, opcional)')}
                                        className="px-2 py-1.5 rounded border border-dd-line text-sm bg-white" />
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1.5">
                                    <input type="text"
                                        value={row.descEn}
                                        onChange={(e) => updateRow(row.id, 'descEn', e.target.value)}
                                        placeholder={tx('Description (optional)', 'Descripción (opcional)')}
                                        className="px-2 py-1.5 rounded border border-dd-line text-[12px] bg-white" />
                                    <input type="text"
                                        value={row.descEs}
                                        onChange={(e) => updateRow(row.id, 'descEs', e.target.value)}
                                        placeholder={tx('Description ES (optional)', 'Descripción ES (opcional)')}
                                        className="px-2 py-1.5 rounded border border-dd-line text-[12px] bg-white" />
                                </div>
                            </div>
                        );
                    })}

                    <button onClick={addRow}
                        className="w-full mt-2 py-3 rounded-lg border-2 border-dashed border-dd-line text-dd-text-2 hover:bg-dd-bg font-bold text-sm">
                        ➕ {tx('Add component', 'Añadir componente')}
                    </button>

                    {/* Editable notes — Phase 2b. Replaces the static
                        cashier-training notes when set; not printed
                        as labels (they're guidance for cooks). */}
                    <div className="mt-4 bg-blue-50/40 border border-blue-200 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-900">
                                ℹ️ {tx('Notes for cooks (not printed)', 'Notas para cocina (no se imprimen)')}
                            </span>
                            <button onClick={addNote}
                                className="text-[10px] font-bold text-blue-700 hover:underline">
                                ➕ {tx('Add note', 'Añadir nota')}
                            </button>
                        </div>
                        {notes.length === 0 ? (
                            <p className="text-[11px] text-blue-700/70 italic">
                                {tx(
                                    'No notes — the static cashier guidance shows on the public view. Add a note to replace it.',
                                    'Sin notas — se muestra la guía estática. Añade una para reemplazar.',
                                )}
                            </p>
                        ) : (
                            <div className="space-y-1.5">
                                {notes.map((n, i) => (
                                    <div key={i} className="flex flex-col sm:flex-row gap-1.5">
                                        <input type="text" value={n.en}
                                            onChange={(e) => updateNote(i, 'en', e.target.value)}
                                            placeholder={tx('Note (EN)', 'Nota (EN)')}
                                            className="flex-1 px-2 py-1.5 rounded border border-blue-200 text-[12.5px] bg-white" />
                                        <input type="text" value={n.es}
                                            onChange={(e) => updateNote(i, 'es', e.target.value)}
                                            placeholder={tx('Note (ES, optional)', 'Nota (ES, opcional)')}
                                            className="flex-1 px-2 py-1.5 rounded border border-blue-200 text-[12.5px] bg-white" />
                                        <button onClick={() => removeNote(i)}
                                            className="w-8 h-8 rounded text-red-600 hover:bg-red-50 text-sm self-end sm:self-auto">✕</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="border-t border-dd-line p-3 flex flex-wrap items-center gap-2 flex-shrink-0 safe-bottom">
                    {isCustom && !isNew && (
                        <button onClick={handleRestoreDefault} disabled={saving}
                            className="px-3 py-2.5 rounded-lg bg-red-50 border border-red-300 text-red-700 text-xs font-bold hover:bg-red-100 disabled:opacity-40">
                            🗑 {tx('Delete item', 'Eliminar')}
                        </button>
                    )}
                    {!isCustom && !isNew && hasExistingOverride && (
                        <button onClick={handleRestoreDefault} disabled={saving}
                            className="px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-800 text-xs font-bold hover:bg-amber-100 disabled:opacity-40">
                            ↺ {tx('Restore default', 'Restaurar')}
                        </button>
                    )}
                    <div className="flex-1" />
                    {isDirty && (
                        <span className="text-[10px] font-bold text-amber-700">
                            {tx('Unsaved changes', 'Cambios sin guardar')}
                        </span>
                    )}
                    <button onClick={onClose} disabled={saving}
                        className="px-4 py-2.5 rounded-lg bg-white border border-dd-line text-dd-text font-bold text-sm hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={handleSave}
                        disabled={saving || !isDirty}
                        className={`px-5 py-2.5 rounded-lg font-bold text-white text-sm transition ${(saving || !isDirty)
                            ? 'bg-dd-text-2/40 cursor-not-allowed'
                            : 'bg-dd-green hover:bg-dd-green-700 active:scale-95 shadow-sm'}`}>
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                </div>
            </div>
        </div>
    );
}
