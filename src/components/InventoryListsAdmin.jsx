// Inventory list variations — admin sub-page.
//
// Two screens stacked inside one modal:
//   1. List of lists — every saved list with status (active / draft),
//      with actions: Edit, Activate, Duplicate, Rename, Delete.
//      Plus "+ New list" with a source picker (start from master /
//      current live list / clone existing / empty).
//   2. Editor — click Edit on any list, opens the structural editor
//      on top of the same modal: shows categories + items, with
//      move-up / move-down buttons on each, add/remove buttons,
//      and inline-editable category names.
//
// Why a modal not a tab: this is an admin-only management surface,
// not a primary destination. Mounting it as a modal keeps it off
// the bottom nav.

import { useState, useEffect, useMemo, useRef } from 'react';
import {
    LIST_STATUS,
    createList,
    updateListMeta,
    updateListCategories,
    deleteList,
    activateList,
    deactivateAll,
    subscribeAllLists,
} from '../data/inventoryLists';
import { INVENTORY_CATEGORIES } from '../data/inventory';
import { normalize, expandQueryTermsTight, haystackMatches } from '../data/chatSearch';
import { useAiSearch } from '../data/aiSearch';
import ModalPortal from './ModalPortal';
import { toast } from '../toast';

export default function InventoryListsAdmin({
    language = 'en', staffName, viewer, onClose,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const [lists, setLists] = useState([]);
    const [view, setView] = useState('grid');       // 'grid' | 'edit'
    const [editingId, setEditingId] = useState(null);
    const [showNew, setShowNew] = useState(false);

    useEffect(() => {
        return subscribeAllLists(setLists);
    }, []);

    const editing = useMemo(() => lists.find(l => l.id === editingId), [lists, editingId]);

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
            {/* Force EXPLICIT height instead of max-h-. With max-h-,
                the modal shrinks to its content, which then collapses
                the flex-1 body into a zero-height container and breaks
                its overflow-y-auto. Fixed height = stable scroll
                container. (Andrew 2026-05-19 bug: "when the inventory
                lists window is opened i cant scroll".) */}
            <div className="bg-white w-full sm:max-w-4xl h-[100dvh] sm:h-[85vh] sm:rounded-2xl flex flex-col overflow-hidden">
                {/* Header */}
                <div className="border-b border-dd-line p-4 flex items-center justify-between safe-top [--safe-top-base:1rem]">
                    <div className="flex items-center gap-2">
                        {view === 'edit' && (
                            <button onClick={() => { setView('grid'); setEditingId(null); }}
                                className="text-dd-text-2 hover:text-dd-text text-xl">←</button>
                        )}
                        <h2 className="text-lg font-bold text-dd-text">
                            📋 {view === 'edit' && editing
                                ? `${editing.name}${editing.status === 'active' ? ' · LIVE' : ''}`
                                : tx('Inventory lists', 'Listas de inventario')}
                        </h2>
                    </div>
                    <button onClick={onClose}
                        className="text-dd-text-2 hover:text-dd-text text-2xl leading-none">×</button>
                </div>

                {/* When editing a list, the split-pane manages its own
                    scrolling per-pane — don't wrap it in overflow-y-auto
                    or we get nested-scroll mess. The grid view stays
                    inside a normal scrollable body. */}
                <div className={`flex-1 min-h-0 p-4 ${view === 'edit' ? 'flex flex-col' : 'overflow-y-auto'}`}>
                    {view === 'grid' && (
                        <ListsGrid
                            lists={lists}
                            tx={tx}
                            language={language}
                            onEdit={(id) => { setEditingId(id); setView('edit'); }}
                            onActivate={async (l) => {
                                if (l.status === LIST_STATUS.ACTIVE) {
                                    if (!window.confirm(tx(
                                        'This is the live list. Deactivate it? The inventory tab will fall back to the legacy list until you activate another.',
                                        '¿Desactivar la lista activa? El inventario usará la lista anterior hasta activar otra.',
                                    ))) return;
                                    await deactivateAll({ byName: staffName });
                                    toast(tx('Deactivated', 'Desactivada'));
                                    return;
                                }
                                if (!window.confirm(tx(
                                    `Activate "${l.name}"? The inventory tab will switch to this list immediately for all staff.`,
                                    `¿Activar "${l.name}"? El inventario cambiará a esta lista inmediatamente para todo el personal.`,
                                ))) return;
                                await activateList({ id: l.id, byName: staffName });
                                toast(tx('✓ Live', '✓ Activa'));
                            }}
                            onDuplicate={async (l) => {
                                const newName = window.prompt(tx('Name for the copy:', 'Nombre para la copia:'), `${l.name} (copy)`);
                                if (!newName || !newName.trim()) return;
                                try {
                                    await createList({
                                        name: newName.trim(),
                                        nameEs: newName.trim(),
                                        source: `fromList:${l.id}`,
                                        sourceListId: l.id,
                                        createdBy: staffName || 'admin',
                                    });
                                    toast(tx('Duplicated', 'Duplicada'));
                                } catch (e) {
                                    console.error(e);
                                    toast(tx('Duplicate failed', 'Error al duplicar'), { kind: 'error' });
                                }
                            }}
                            onRename={async (l) => {
                                const newName = window.prompt(tx('Rename to:', 'Cambiar nombre a:'), l.name);
                                if (!newName || !newName.trim() || newName.trim() === l.name) return;
                                try {
                                    await updateListMeta({
                                        id: l.id,
                                        name: newName.trim(),
                                        nameEs: newName.trim(),
                                        updatedBy: staffName,
                                    });
                                    toast(tx('Renamed', 'Renombrada'));
                                } catch (e) {
                                    console.error(e);
                                    toast(tx('Rename failed', 'Error al renombrar'), { kind: 'error' });
                                }
                            }}
                            onDelete={async (l) => {
                                if (l.status === LIST_STATUS.ACTIVE) {
                                    toast(tx('Deactivate it first.', 'Desactívala primero.'), { kind: 'error' });
                                    return;
                                }
                                if (!window.confirm(tx(
                                    `Delete "${l.name}"? This cannot be undone.`,
                                    `¿Eliminar "${l.name}"? No se puede deshacer.`,
                                ))) return;
                                try {
                                    await deleteList({ id: l.id, byName: staffName });
                                    toast(tx('Deleted', 'Eliminada'));
                                } catch (e) {
                                    console.error(e);
                                    toast(tx('Delete failed', 'Error al eliminar'), { kind: 'error' });
                                }
                            }}
                            onNew={() => setShowNew(true)}
                        />
                    )}

                    {view === 'edit' && editing && (
                        <ListEditor
                            list={editing}
                            tx={tx}
                            language={language}
                            staffName={staffName}
                            onClose={() => { setView('grid'); setEditingId(null); }}
                        />
                    )}
                </div>
            </div>

            {showNew && (
                <NewListModal
                    tx={tx}
                    language={language}
                    staffName={staffName}
                    existingLists={lists}
                    onClose={() => setShowNew(false)}
                    onCreated={(id) => { setShowNew(false); setEditingId(id); setView('edit'); }}
                />
            )}
        </div>
        </ModalPortal>
    );
}

// ── Lists grid ────────────────────────────────────────────────────────
function ListsGrid({ lists, tx, language, onEdit, onActivate, onDuplicate, onRename, onDelete, onNew }) {
    const isEs = language === 'es';
    return (
        <div className="space-y-3">
            <button onClick={onNew}
                className="w-full py-3 rounded-xl border-2 border-dashed border-dd-line text-dd-text-2 hover:bg-dd-bg font-bold text-sm">
                ➕ {tx('New list', 'Nueva lista')}
            </button>

            {lists.length === 0 ? (
                <p className="text-sm text-dd-text-2 text-center py-8">
                    {tx('No lists yet. Click "+ New list" to start.', 'Aún no hay listas. Haz clic en "+ Nueva lista".')}
                </p>
            ) : (
                <div className="space-y-2">
                    {lists.map(l => {
                        const isActive = l.status === LIST_STATUS.ACTIVE;
                        const itemCount = (l.categories || []).reduce((s, c) => s + (c.items?.length || 0), 0);
                        return (
                            <div key={l.id}
                                className={`border-2 rounded-xl p-3 ${isActive ? 'border-dd-green bg-dd-green-50' : 'border-dd-line bg-white'}`}>
                                <div className="flex items-start gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-base font-black text-dd-text">
                                                {isEs ? (l.nameEs || l.name) : l.name}
                                            </span>
                                            {isActive && (
                                                <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-dd-green text-white">
                                                    ● {tx('LIVE', 'ACTIVA')}
                                                </span>
                                            )}
                                            {!isActive && (
                                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                                                    {tx('DRAFT', 'BORRADOR')}
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-[11px] text-dd-text-2 mt-0.5">
                                            {(l.categories || []).length} {tx('categories', 'categorías')} ·{' '}
                                            {itemCount} {tx('items', 'artículos')}
                                            {l.description && ` · ${l.description}`}
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-1 shrink-0">
                                        <button onClick={() => onEdit(l.id)}
                                            className="px-2 py-1 rounded-md text-[11px] font-bold bg-dd-text text-white hover:opacity-90">
                                            ✏️ {tx('Edit', 'Editar')}
                                        </button>
                                        <button onClick={() => onActivate(l)}
                                            className={`px-2 py-1 rounded-md text-[11px] font-bold ${
                                                isActive
                                                    ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                                                    : 'bg-dd-green text-white hover:opacity-90'
                                            }`}>
                                            {isActive ? tx('Deactivate', 'Desactivar') : tx('Make live', 'Hacer activa')}
                                        </button>
                                    </div>
                                </div>
                                <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-dd-line/50">
                                    <button onClick={() => onDuplicate(l)}
                                        className="text-[10px] font-bold px-2 py-1 rounded bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg">
                                        📋 {tx('Duplicate', 'Duplicar')}
                                    </button>
                                    <button onClick={() => onRename(l)}
                                        className="text-[10px] font-bold px-2 py-1 rounded bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg">
                                        🏷 {tx('Rename', 'Renombrar')}
                                    </button>
                                    <button onClick={() => onDelete(l)}
                                        disabled={l.status === LIST_STATUS.ACTIVE}
                                        className="text-[10px] font-bold px-2 py-1 rounded bg-white border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed">
                                        🗑 {tx('Delete', 'Eliminar')}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ── New-list modal — pick a starting source ──────────────────────────
function NewListModal({ tx, language, staffName, existingLists, onClose, onCreated }) {
    const [name, setName] = useState('');
    // Default to empty — Andrew 2026-05-20: "with the new list i want to
    // start with nothing in it." The new split-pane editor + sub-cat
    // grouping makes building from scratch fast, so empty is the right
    // starting point.
    const [source, setSource] = useState('empty');
    const [sourceListId, setSourceListId] = useState('');
    const [busy, setBusy] = useState(false);

    const create = async () => {
        if (!name.trim()) {
            toast(tx('Pick a name first', 'Elige un nombre primero'), { kind: 'error' });
            return;
        }
        setBusy(true);
        try {
            const srcArg = source === 'fromList' && sourceListId
                ? `fromList:${sourceListId}`
                : source;
            const id = await createList({
                name: name.trim(),
                nameEs: name.trim(),
                source: srcArg,
                sourceListId: sourceListId || null,
                sourceLocation: 'webster',
                createdBy: staffName || 'admin',
            });
            onCreated(id);
        } catch (e) {
            console.error('createList failed', e);
            toast(tx('Create failed', 'Error al crear'), { kind: 'error' });
            setBusy(false);
        }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md p-5 rounded-t-2xl sm:rounded-2xl space-y-3">
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-black text-dd-text">
                        ➕ {tx('New inventory list', 'Nueva lista de inventario')}
                    </h3>
                    <button onClick={onClose} className="text-2xl text-gray-500">×</button>
                </div>
                <label className="block">
                    <span className="block text-[10px] font-bold uppercase text-dd-text-2 mb-1">{tx('Name', 'Nombre')}</span>
                    <input type="text" value={name}
                        onChange={e => setName(e.target.value)}
                        autoFocus
                        placeholder={tx('e.g. "Produce day", "Quick prep", "Full inventory"', 'ej. "Día de verduras", "Prep rápida"')}
                        className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm" />
                </label>
                <div>
                    <span className="block text-[10px] font-bold uppercase text-dd-text-2 mb-1">{tx('Start from', 'Comenzar desde')}</span>
                    <div className="space-y-1.5">
                        <SourceOption value="empty" current={source} setSource={setSource}
                            label={tx('Empty (recommended)', 'Vacía (recomendado)')}
                            help={tx('Build from scratch — click items on the left to add them', 'Construye desde cero — haz clic en los artículos a la izquierda')} />
                        <SourceOption value="master" current={source} setSource={setSource}
                            label={tx('Master list (factory default)', 'Lista maestra (predeterminada)')}
                            help={tx('Full catalog from inventory.js', 'Catálogo completo')} />
                        <SourceOption value="current" current={source} setSource={setSource}
                            label={tx('Current live list', 'Lista actual')}
                            help={tx('Copy from the inventory tab as it is right now', 'Copia del inventario actual')} />
                        {existingLists.length > 0 && (
                            <SourceOption value="fromList" current={source} setSource={setSource}
                                label={tx('Clone an existing list', 'Clonar lista existente')}
                                help={tx('Make a copy and edit independently', 'Hacer una copia editable')} />
                        )}
                    </div>
                    {source === 'fromList' && (
                        <select value={sourceListId} onChange={e => setSourceListId(e.target.value)}
                            className="w-full mt-2 px-2 py-1.5 rounded-lg border border-dd-line text-sm bg-white">
                            <option value="">{tx('Pick a list to clone…', 'Elige una lista para clonar…')}</option>
                            {existingLists.map(l => (
                                <option key={l.id} value={l.id}>{l.name}</option>
                            ))}
                        </select>
                    )}
                </div>
                <div className="flex gap-2 pt-1">
                    <button onClick={onClose} disabled={busy}
                        className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={create} disabled={busy || !name.trim()}
                        className="flex-1 py-2 rounded-lg bg-dd-green text-white text-sm font-bold disabled:opacity-40">
                        {busy ? tx('Creating…', 'Creando…') : tx('Create + edit', 'Crear y editar')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

function SourceOption({ value, current, setSource, label, help }) {
    const sel = current === value;
    return (
        <label className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer ${sel ? 'border-dd-green bg-dd-green-50' : 'border-dd-line bg-white hover:bg-dd-bg'}`}>
            <input type="radio" checked={sel} onChange={() => setSource(value)}
                className="mt-1 accent-dd-green" />
            <div className="flex-1">
                <div className="text-sm font-bold text-dd-text">{label}</div>
                <div className="text-[11px] text-dd-text-2">{help}</div>
            </div>
        </label>
    );
}

// ── List editor — split-pane with click-to-toggle + smart search ────
//
// Andrew 2026-05-19 — "lets make the list creation look like the new
// list on the right and the items list is on the left and i can click
// the items and it will move it over to the new list. ... above the
// items i want a search window where if i say dry it pulls all dry
// ingredients up or if i say green, or anything."
//
// Layout:
//   LEFT pane  — every item in the master INVENTORY_CATEGORIES.
//                Search box at the top filters across name (EN+ES),
//                category, subcategory using the same accent-stripping
//                + bilingual-synonym matcher recipeSearch uses
//                (chicken↔pollo, lime↔limón, etc.). Click an item to
//                toggle it in the list.
//   RIGHT pane — the list under edit. Categories with ↑/↓ reorder,
//                items with ↑/↓ reorder, ✕ remove, + add empty
//                category. Items checked on the left land in their
//                native category here, creating that category if
//                it doesn't already exist on the right.
//
// State strategy unchanged from the prior single-pane version:
// edit locally, save when admin hits Save, Discard reverts.
function ListEditor({ list, tx, language, staffName, onClose }) {
    const isEs = language === 'es';
    const [cats, setCats] = useState(() => list.categories || []);
    const [origJson, setOrigJson] = useState(() => JSON.stringify(list.categories || []));
    const [saving, setSaving] = useState(false);
    const [search, setSearch] = useState('');
    // AI search toggle. When ON, queries are sent to the aiSearch
    // Cloud Function (Anthropic Claude under the hood). Substring +
    // synonym match keeps running locally — the AI ids are MERGED
    // INTO that result set, never replacing it. So if Claude takes
    // 200ms to respond, the user already sees instant substring
    // matches and the AI just adds the semantic ones on top.

    // If the underlying list changes (e.g. admin renamed it via the
    // grid before opening the editor), reset our baseline. We only
    // reset when there are no unsaved changes — never blow away
    // local edits.
    useEffect(() => {
        const incomingJson = JSON.stringify(list.categories || []);
        if (incomingJson !== origJson && JSON.stringify(cats) === origJson) {
            setCats(list.categories || []);
            setOrigJson(incomingJson);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [list.categories]);

    const isDirty = JSON.stringify(cats) !== origJson;

    const save = async () => {
        if (!isDirty) { onClose(); return; }
        setSaving(true);
        try {
            await updateListCategories({ id: list.id, categories: cats, updatedBy: staffName });
            toast(tx('✓ Saved', '✓ Guardado'));
            setOrigJson(JSON.stringify(cats));
        } catch (e) {
            console.error('save list failed', e);
            toast(tx('Save failed', 'Error al guardar'), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const discard = () => {
        if (!isDirty) return;
        if (!window.confirm(tx('Discard changes?', '¿Descartar cambios?'))) return;
        setCats(JSON.parse(origJson));
    };

    // Right-side mutators — categories + items inside the list.
    const moveCat = (idx, dir) => {
        const next = [...cats];
        const j = idx + dir;
        if (j < 0 || j >= next.length) return;
        [next[idx], next[j]] = [next[j], next[idx]];
        setCats(next);
    };
    const renameCat = (idx, newName) => {
        const next = [...cats];
        next[idx] = { ...next[idx], name: newName, nameEs: newName };
        setCats(next);
    };
    const addCat = () => {
        const name = window.prompt(tx('Category name:', 'Nombre de categoría:'));
        if (!name || !name.trim()) return;
        const maxId = cats.reduce((m, c) => Math.max(m, c.id || 0), 0);
        setCats([...cats, { id: maxId + 1, name: name.trim(), nameEs: name.trim(), items: [] }]);
    };
    const removeCat = (idx) => {
        const c = cats[idx];
        if (!window.confirm(tx(
            `Remove category "${c.name}" and its ${c.items?.length || 0} items? You can undo by clicking Discard before saving.`,
            `¿Quitar categoría "${c.name}" y sus ${c.items?.length || 0} artículos? Puedes deshacer haciendo clic en Descartar antes de guardar.`,
        ))) return;
        setCats(cats.filter((_, i) => i !== idx));
    };
    const moveItem = (catIdx, itemIdx, dir) => {
        const next = [...cats];
        const items = [...(next[catIdx].items || [])];
        const j = itemIdx + dir;
        if (j < 0 || j >= items.length) return;
        [items[itemIdx], items[j]] = [items[j], items[itemIdx]];
        next[catIdx] = { ...next[catIdx], items };
        setCats(next);
    };
    const removeItem = (catIdx, itemIdx) => {
        const next = [...cats];
        const items = (next[catIdx].items || []).filter((_, i) => i !== itemIdx);
        next[catIdx] = { ...next[catIdx], items };
        setCats(next);
    };

    // 2026-05-29 — Andrew: "the other category is at the bottom and
    // there is around 80 items. the drink has around 505 items and
    // should be around 20-30". Per-item delete already exists but
    // doesn't scale to 80+. These two bulk actions cover the cleanup
    // patterns Andrew actually needs:
    //
    //   • clearCatItems  — wipe every item in a category but keep the
    //                      category header. Useful for the "Other"
    //                      catch-all once you decide nothing in it is
    //                      worth keeping.
    //   • resetCatToMaster — find the matching category by name in
    //                        INVENTORY_CATEGORIES (the canonical seed
    //                        in src/data/inventory.js) and replace
    //                        items with that seed. The Drinks fix:
    //                        Drinks bloats to 505 over time as
    //                        scrapers add vendor SKUs; the seed has 24.
    //
    // Both confirm with the current count so Andrew can't fat-finger.
    // Both are LOCAL ONLY until Save is hit — Discard reverts.
    const clearCatItems = (catIdx) => {
        const c = cats[catIdx];
        const count = (c.items || []).length;
        if (count === 0) return;
        if (!window.confirm(tx(
            `Delete all ${count} items in "${c.name}"? The category itself stays. Discard before saving to undo.`,
            `¿Borrar los ${count} artículos en "${c.name}"? La categoría se queda. Toca Descartar antes de guardar para deshacer.`,
        ))) return;
        const next = [...cats];
        next[catIdx] = { ...next[catIdx], items: [] };
        setCats(next);
    };
    const resetCatToMaster = (catIdx) => {
        const c = cats[catIdx];
        const master = INVENTORY_CATEGORIES.find(m => m.name === c.name);
        if (!master) {
            window.alert(tx(
                `No master seed category named "${c.name}". Reset only works for canonical categories (Proteins, Veggies, Drinks, etc.).`,
                `Sin categoría maestra llamada "${c.name}". Reset solo funciona con categorías canónicas.`,
            ));
            return;
        }
        const have = (c.items || []).length;
        const seed = (master.items || []).length;
        if (!window.confirm(tx(
            `Replace the ${have} items in "${c.name}" with the ${seed} canonical seed items? You'll lose any custom items added here. Discard before saving to undo.`,
            `¿Reemplazar los ${have} artículos en "${c.name}" con los ${seed} artículos maestros? Perderás los personalizados. Toca Descartar antes de guardar para deshacer.`,
        ))) return;
        const next = [...cats];
        next[catIdx] = {
            ...next[catIdx],
            items: (master.items || []).map(it => ({ ...it })),
        };
        setCats(next);
    };

    // 2026-05-29 (round 2) — Andrew: "dry items have the same drinks
    // too get rid of the drinks in dry items". Surgical alternative
    // to Reset: walk the items in a category, and for each one parse
    // its canonical seed id ("{catIdx}-{itemIdx}") to see which
    // INVENTORY_CATEGORIES bucket it BELONGS to. If the canonical
    // bucket name differs from this category's name, the item is
    // misplaced (typically a vendor scraper miscategorized it) and
    // gets removed.
    //
    // Vendor-only items (id formats like "sysco:1234" or "1234")
    // are LEFT ALONE — we don't have enough info to know where they
    // belong, and they may have been intentionally placed here.
    //
    // Returns the misplaced items the function would remove. Used both
    // for the confirm-dialog count AND to decide whether to render
    // the button (zero misplaced = no button).
    const findMisplacedItems = (catIdx) => {
        const c = cats[catIdx];
        if (!c) return [];
        const out = [];
        for (const it of (c.items || [])) {
            const id = String(it.id || '');
            const dash = id.indexOf('-');
            if (dash <= 0) continue; // vendor-only or unrecognized — skip
            const seedCatIdx = Number(id.slice(0, dash));
            if (!Number.isFinite(seedCatIdx)) continue;
            const seedCat = INVENTORY_CATEGORIES.find(m => m.id === seedCatIdx);
            if (!seedCat) continue; // unknown seed cat — defensively skip
            if (seedCat.name !== c.name) out.push({ item: it, belongsIn: seedCat.name });
        }
        return out;
    };
    const removeMisplacedFromCat = (catIdx) => {
        const c = cats[catIdx];
        const misplaced = findMisplacedItems(catIdx);
        if (misplaced.length === 0) return;
        // Build a "belongs in X (n)" summary for the confirm.
        const byTarget = new Map();
        for (const m of misplaced) {
            byTarget.set(m.belongsIn, (byTarget.get(m.belongsIn) || 0) + 1);
        }
        const breakdown = [...byTarget.entries()]
            .map(([n, k]) => `${k} from ${n}`).join(', ');
        if (!window.confirm(tx(
            `Remove ${misplaced.length} items from "${c.name}" that belong in another category (${breakdown})? Vendor-only items will be kept. Discard before saving to undo.`,
            `¿Quitar ${misplaced.length} artículos de "${c.name}" que pertenecen a otra categoría (${breakdown})? Los artículos solo-de-proveedor se mantienen. Toca Descartar antes de guardar para deshacer.`,
        ))) return;
        const ids = new Set(misplaced.map(m => m.item.id));
        const next = [...cats];
        next[catIdx] = {
            ...next[catIdx],
            items: (next[catIdx].items || []).filter(it => !ids.has(it.id)),
        };
        setCats(next);
    };

    // Set of item ids currently in the list — fast membership check
    // for the left pane's checkmark rendering.
    const presentIds = useMemo(() => {
        const s = new Set();
        for (const c of cats) for (const it of (c.items || [])) s.add(it.id);
        return s;
    }, [cats]);

    // Click an item on the left → toggle in the right list.
    //
    // Andrew 2026-05-20 — "i want to be able to make lists to the sub
    // category." Bucket the new entry by the item's SUBCAT, not the
    // top-level master category. So clicking "Chicken Wings" lands in
    // a "Chicken" bucket instead of a giant "Proteins" bucket. Items
    // without a subcat fall back to the master category name.
    //
    // ADD: find the bucket on the right by NAME. If present, append.
    //   If absent, create it (id = max id + 1 across existing buckets
    //   so it never collides with an auto-generated one).
    // REMOVE: walk every category on the right, drop matching id.
    const toggleItem = (masterCat, item) => {
        setCats(prev => {
            if (presentIds.has(item.id)) {
                return prev
                    .map(c => ({ ...c, items: (c.items || []).filter(it => it.id !== item.id) }));
            }
            const targetName = (item.subcat && item.subcat.trim()) || masterCat.name;
            const targetIdx = prev.findIndex(c => c.name === targetName);
            if (targetIdx >= 0) {
                const next = [...prev];
                const items = [...(next[targetIdx].items || []), { ...item }];
                next[targetIdx] = { ...next[targetIdx], items };
                return next;
            }
            const maxId = prev.reduce((m, c) => Math.max(m, c.id || 0), 0);
            return [...prev, {
                id: maxId + 1,
                name: targetName,
                // Sub-cats in inventory.js are English-only; copy the
                // English label as the Spanish so the bucket isn't
                // blank in ES mode.
                nameEs: targetName,
                items: [{ ...item }],
            }];
        });
    };

    // AI toggle. Default ON — fast + free of the substring's literal-
    // matching limits. User can flip OFF if AI is slow or unavailable.
    const [aiOn, setAiOn] = useState(true);

    // Flat list of all master items (with cat name baked in) — fed
    // to both the substring matcher and the AI search. Memoized so
    // the AI cache key stays stable across renders.
    const allItemsFlat = useMemo(() => {
        const out = [];
        for (const cat of INVENTORY_CATEGORIES) {
            for (const it of (cat.items || [])) {
                out.push({
                    id: it.id,
                    name: it.name,
                    nameEs: it.nameEs,
                    category: cat.name,
                    subcat: it.subcat || '',
                });
            }
        }
        return out;
    }, []);

    // Search filter for the left pane. Tight synonyms +
    // accent-stripped substring across name/nameEs/category/subcat.
    // "chicken" expands to "pollo"; "limón" matches "lime"; etc.
    const queryTokens = useMemo(() => expandQueryTermsTight(search), [search]);
    const hasQuery = queryTokens.length > 0;
    const itemMatches = (item, catName) => {
        if (!hasQuery) return true;
        const hay = normalize([
            item.name || '',
            item.nameEs || '',
            catName || '',
            item.subcat || '',
        ].join(' '));
        return haystackMatches(hay, queryTokens);
    };

    // AI semantic match — runs in parallel with the substring matcher
    // and merges into the visible set. When aiOn=false, the hook
    // immediately returns null and we render substring-only.
    const { loading: aiLoading, matchingIds: aiIds, error: aiError } = useAiSearch({
        query: search,
        items: allItemsFlat,
        enabled: aiOn && hasQuery,
    });
    const aiIdSet = useMemo(
        () => (aiIds ? new Set(aiIds) : null),
        [aiIds],
    );
    // Final per-item match function: substring OR ai. If AI hasn't
    // responded yet (aiIdSet is null), we render substring matches
    // only — the AI ids slot in once they arrive.
    const itemMatchesUnion = (item, catName) => {
        if (!hasQuery) return true;
        if (itemMatches(item, catName)) return true;
        return aiIdSet ? aiIdSet.has(item.id) : false;
    };

    return (
        <div className="flex flex-col h-full">
            {/* Save bar (header) */}
            <div className="flex flex-wrap items-center gap-2 mb-2 py-2 px-1 border-b border-dd-line bg-white">
                <span className="text-xs text-dd-text-2">
                    {cats.length} {tx('categories', 'categorías')} ·{' '}
                    {cats.reduce((s, c) => s + (c.items?.length || 0), 0)} {tx('items', 'artículos')}
                </span>
                <div className="ml-auto flex items-center gap-2">
                    {isDirty && (
                        <span className="text-[10px] font-bold text-amber-700">
                            {tx('Unsaved changes', 'Cambios sin guardar')}
                        </span>
                    )}
                    {isDirty && (
                        <button onClick={discard}
                            className="px-3 py-1.5 rounded-lg bg-white border border-dd-line text-dd-text-2 text-xs font-bold hover:bg-dd-bg">
                            {tx('Discard', 'Descartar')}
                        </button>
                    )}
                    <button onClick={save}
                        disabled={saving || !isDirty}
                        className="px-3 py-1.5 rounded-lg bg-dd-green text-white text-xs font-bold disabled:opacity-40">
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                </div>
            </div>

            {/* Split pane — stacks on mobile, side-by-side on sm+ */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1 min-h-0">
                {/* LEFT — Available items + search */}
                <div className="flex flex-col min-h-0 border border-dd-line rounded-xl bg-white overflow-hidden">
                    <div className="px-2 py-2 border-b border-dd-line bg-dd-bg flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 flex-shrink-0">
                                {tx('Available', 'Disponibles')}
                            </span>
                            <div className="relative flex-1">
                                <input
                                    type="search"
                                    inputMode="search"
                                    enterKeyHint="search"
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    placeholder={aiOn
                                        ? tx('Search anything ("dry", "things for pho", "spicy")', 'Buscar ("seco", "cosas para pho", "picante")')
                                        : tx('Search (e.g. "green", "chicken", "lime")', 'Buscar (ej. "verde", "pollo", "limón")')}
                                    className="w-full pl-7 pr-7 py-1.5 border border-dd-line rounded-md text-xs"
                                />
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-dd-text-2 text-xs pointer-events-none">🔍</span>
                                {search && (
                                    <button onClick={() => setSearch('')}
                                        className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-gray-200 text-gray-600 text-[10px] font-bold flex items-center justify-center">
                                        ✕
                                    </button>
                                )}
                            </div>
                            {/* AI toggle — flips between substring-only and
                                substring ∪ AI semantic match. AI adds ~200ms
                                latency + small per-query cost, so it's a
                                deliberate opt-in (default ON). */}
                            <button onClick={() => setAiOn(v => !v)}
                                title={aiOn
                                    ? tx('AI search ON — click to use plain search', 'Búsqueda IA activada — clic para apagar')
                                    : tx('Plain search — click to enable AI', 'Búsqueda básica — clic para activar IA')}
                                className={`flex-shrink-0 px-2 py-1 rounded-md text-[10px] font-bold border transition ${aiOn
                                    ? 'bg-purple-600 text-white border-purple-700'
                                    : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                                ✨ {tx('AI', 'IA')}
                            </button>
                        </div>
                        {/* Status strip — shows AI loading / error / hit-count
                            when active. Stays out of the way otherwise. */}
                        {hasQuery && aiOn && (
                            <div className="text-[10px] text-dd-text-2 flex items-center gap-2">
                                {aiLoading && <span className="text-purple-700 font-bold">✨ {tx('thinking…', 'pensando…')}</span>}
                                {!aiLoading && aiError && (
                                    <span className="text-amber-700">⚠ {tx('AI unavailable — showing plain matches', 'IA no disponible — mostrando coincidencias básicas')}</span>
                                )}
                                {!aiLoading && !aiError && aiIds && (
                                    <span>✨ {tx(`AI added ${aiIds.length} semantic ${aiIds.length === 1 ? 'match' : 'matches'}`, `IA añadió ${aiIds.length} coincidencias`)}</span>
                                )}
                            </div>
                        )}
                    </div>
                    {/* Andrew 2026-05-20 — left pane groups items by SUB-
                        CATEGORY within each top-level category. Items
                        STAY in their original position when added (no
                        movement) — Andrew's revised request was "put
                        numbers on the subcatigorys so that the number i
                        see them on the list instead of moving them.
                        makes it easier". So each sub-cat header carries
                        a "{added}/{total}" counter when any are added,
                        and added items gray out + line-through in place.
                        Stable positions = muscle memory survives. */}
                    <div className="flex-1 overflow-y-auto p-2 space-y-2">
                        {INVENTORY_CATEGORIES.map(masterCat => {
                            const itemsMatching = (masterCat.items || []).filter(it => itemMatchesUnion(it, masterCat.name));
                            if (hasQuery && itemsMatching.length === 0) return null;

                            // Subcategories removed (Andrew 2026-05-22 —
                            // "lets remove the sub categories i dont think
                            // we need it"). Left pane now lists items flat
                            // within each top-level category. The
                            // X/Y-added count still shown at the category
                            // header.
                            const totalInCat = itemsMatching.length;
                            const addedInCat = itemsMatching.reduce(
                                (s, it) => s + (presentIds.has(it.id) ? 1 : 0), 0);

                            return (
                                <div key={masterCat.id} className="border border-dd-line/70 rounded-lg overflow-hidden">
                                    <div className="px-2 py-1 bg-dd-bg/50 flex items-center justify-between">
                                        <span className="text-[11px] font-black text-dd-text">
                                            {isEs ? (masterCat.nameEs || masterCat.name) : masterCat.name}
                                        </span>
                                        <span className={`text-[10px] font-bold ${addedInCat > 0 ? 'text-dd-green' : 'text-dd-text-2'}`}>
                                            {addedInCat > 0 ? `${addedInCat}/${totalInCat}` : totalInCat}
                                        </span>
                                    </div>
                                    {itemsMatching.map(item => {
                                        const inList = presentIds.has(item.id);
                                        return (
                                            <button key={item.id}
                                                onClick={() => toggleItem(masterCat, item)}
                                                className={`w-full text-left px-2 py-1.5 flex items-center gap-2 text-xs border-t border-dd-line/40 transition ${inList ? 'opacity-50 bg-gray-50 hover:bg-gray-100' : 'bg-white hover:bg-dd-bg'}`}>
                                                <span className={`w-4 h-4 rounded border-2 flex items-center justify-center text-[10px] font-black flex-shrink-0 ${inList ? 'bg-dd-green border-dd-green text-white' : 'border-dd-line bg-white text-transparent'}`}>
                                                    ✓
                                                </span>
                                                <span className={`flex-1 min-w-0 truncate ${inList ? 'line-through' : ''}`}>
                                                    {isEs ? (item.nameEs || item.name) : item.name}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            );
                        })}
                        {hasQuery && INVENTORY_CATEGORIES.every(c => (c.items || []).filter(it => itemMatchesUnion(it, c.name)).length === 0) && (
                            <p className="text-xs text-dd-text-2 text-center py-6 italic">
                                {tx('No items match. Try a different search.', 'Sin coincidencias.')}
                            </p>
                        )}
                    </div>
                </div>

                {/* RIGHT — Your list */}
                <div className="flex flex-col min-h-0 border border-dd-line rounded-xl bg-white overflow-hidden">
                    <div className="px-2 py-2 border-b border-dd-line bg-dd-bg flex items-center justify-between gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                            {tx('Your list', 'Tu lista')}
                        </span>
                        <button onClick={addCat}
                            className="px-2 py-1 rounded-md bg-white border border-dashed border-dd-line text-dd-text-2 text-[10px] font-bold hover:bg-dd-bg">
                            ➕ {tx('Add category', 'Categoría')}
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-2">
                        {cats.length === 0 ? (
                            <p className="text-xs text-dd-text-2 text-center py-6 italic">
                                {tx('Click an item on the left to add it.', 'Haz clic en un artículo a la izquierda para añadirlo.')}
                            </p>
                        ) : cats.map((cat, catIdx) => (
                            <div key={cat.id ?? catIdx}
                                className="border border-dd-line rounded-lg overflow-hidden">
                                <div className="flex items-center gap-1 p-1.5 bg-dd-bg/50">
                                    <div className="flex flex-col">
                                        <button onClick={() => moveCat(catIdx, -1)}
                                            disabled={catIdx === 0}
                                            className="text-[10px] text-dd-text-2 disabled:opacity-20 hover:text-dd-text leading-none">▲</button>
                                        <button onClick={() => moveCat(catIdx, 1)}
                                            disabled={catIdx === cats.length - 1}
                                            className="text-[10px] text-dd-text-2 disabled:opacity-20 hover:text-dd-text leading-none">▼</button>
                                    </div>
                                    <input type="text" value={isEs ? (cat.nameEs || cat.name) : cat.name}
                                        onChange={e => renameCat(catIdx, e.target.value)}
                                        className="flex-1 min-w-0 px-1.5 py-0.5 rounded border border-dd-line text-xs font-bold bg-white" />
                                    <span className="text-[10px] text-dd-text-2">{cat.items?.length || 0}</span>
                                    {/* Bulk actions — added 2026-05-29 for cleaning
                                        bloated categories (Other has 80 items,
                                        Drinks has 505 → should be 24). Reset only
                                        shows when this category has a matching
                                        canonical seed in INVENTORY_CATEGORIES. */}
                                    {INVENTORY_CATEGORIES.some(m => m.name === cat.name) && (
                                        <button onClick={() => resetCatToMaster(catIdx)}
                                            title={tx('Reset to master seed (replaces all items)',
                                                'Restaurar a la lista maestra (reemplaza todo)')}
                                            className="px-1.5 py-0.5 rounded text-[10px] text-blue-700 hover:bg-blue-50 font-bold">
                                            ↻ {tx('Reset', 'Reset')}
                                        </button>
                                    )}
                                    {/* Surgical cleanup — only shows when there
                                        are actually misplaced items (canonical
                                        seed id points to a different category).
                                        Vendor-only items are left untouched. */}
                                    {(() => {
                                        const misplaced = findMisplacedItems(catIdx);
                                        if (misplaced.length === 0) return null;
                                        return (
                                            <button onClick={() => removeMisplacedFromCat(catIdx)}
                                                title={tx(
                                                    `Remove ${misplaced.length} items that belong in another category`,
                                                    `Quitar ${misplaced.length} artículos que pertenecen a otra categoría`,
                                                )}
                                                className="px-1.5 py-0.5 rounded text-[10px] text-purple-700 hover:bg-purple-50 font-bold">
                                                🔀 {tx('Cleanup', 'Limpiar')} ({misplaced.length})
                                            </button>
                                        );
                                    })()}
                                    {(cat.items?.length || 0) > 0 && (
                                        <button onClick={() => clearCatItems(catIdx)}
                                            title={tx('Delete every item in this category (keep header)',
                                                'Borrar todos los artículos de esta categoría (mantener encabezado)')}
                                            className="px-1.5 py-0.5 rounded text-[10px] text-amber-700 hover:bg-amber-50 font-bold">
                                            🧹 {tx('Empty', 'Vaciar')}
                                        </button>
                                    )}
                                    <button onClick={() => removeCat(catIdx)}
                                        title={tx('Remove this category (and all items)',
                                            'Quitar categoría (y todos los artículos)')}
                                        className="px-1.5 py-0.5 rounded text-[10px] text-red-700 hover:bg-red-50">🗑</button>
                                </div>
                                <div className="bg-white">
                                    {(cat.items || []).length === 0 ? (
                                        <p className="px-2 py-2 text-[10px] text-dd-text-2 italic">
                                            {tx('Empty — add items from the left.', 'Vacío — añade desde la izquierda.')}
                                        </p>
                                    ) : (cat.items || []).map((item, itemIdx) => (
                                        <div key={item.id ?? itemIdx}
                                            className="flex items-center gap-1 px-2 py-1 border-t border-dd-line/40 text-xs hover:bg-dd-bg">
                                            <div className="flex flex-col">
                                                <button onClick={() => moveItem(catIdx, itemIdx, -1)}
                                                    disabled={itemIdx === 0}
                                                    className="text-[10px] text-dd-text-2 disabled:opacity-20 hover:text-dd-text leading-none">▲</button>
                                                <button onClick={() => moveItem(catIdx, itemIdx, 1)}
                                                    disabled={itemIdx === (cat.items?.length || 0) - 1}
                                                    className="text-[10px] text-dd-text-2 disabled:opacity-20 hover:text-dd-text leading-none">▼</button>
                                            </div>
                                            <div className="flex-1 min-w-0 truncate">
                                                {isEs ? (item.nameEs || item.name) : item.name}
                                                {item.subcat && (
                                                    <span className="text-[9px] text-dd-text-2 ml-1">· {item.subcat}</span>
                                                )}
                                            </div>
                                            <button onClick={() => removeItem(catIdx, itemIdx)}
                                                className="px-1 py-0.5 rounded text-[10px] text-red-700 hover:bg-red-50">✕</button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
