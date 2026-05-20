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

import { useState, useEffect, useMemo } from 'react';
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
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-4xl max-h-[100dvh] sm:max-h-[90vh] sm:rounded-2xl flex flex-col overflow-hidden">
                {/* Header */}
                <div className="border-b border-dd-line p-4 flex items-center justify-between safe-top">
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

                <div className="flex-1 overflow-y-auto p-4">
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
    const [source, setSource] = useState('master');
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
                        <SourceOption value="empty" current={source} setSource={setSource}
                            label={tx('Empty', 'Vacía')}
                            help={tx('Build from scratch (no categories or items)', 'Construir desde cero')} />
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

// ── List editor — categories + items, move/add/remove ────────────────
//
// State strategy: load the list's categories into local state on
// mount, edit locally, save to Firestore when admin clicks Save.
// "Discard" reverts. Pending-changes badge in the header so admin
// can tell whether they need to save.
function ListEditor({ list, tx, language, staffName, onClose }) {
    const isEs = language === 'es';
    const [cats, setCats] = useState(() => list.categories || []);
    const [origJson, setOrigJson] = useState(() => JSON.stringify(list.categories || []));
    const [saving, setSaving] = useState(false);
    const [expandedCatIdx, setExpandedCatIdx] = useState(null);

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

    // ── Mutators (pure local state) ────────────────────────────────
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
    const addItemTo = (catIdx) => {
        const name = window.prompt(tx('Item name:', 'Nombre del artículo:'));
        if (!name || !name.trim()) return;
        const subcat = window.prompt(tx('Subcategory (optional — leave blank for none):', 'Subcategoría (opcional):'), '') || '';
        const next = [...cats];
        const items = [...(next[catIdx].items || [])];
        // Generate a unique id within this category — same prefix shape
        // as the legacy ids ("0-0", "0-1", etc.) so the existing merge
        // logic in Operations.jsx tolerates them.
        const usedNs = new Set(items.map(it => {
            const m = /^\d+-(\d+)$/.exec(String(it.id || ''));
            return m ? Number(m[1]) : -1;
        }));
        let n = 0;
        while (usedNs.has(n)) n++;
        items.push({
            id: `${cats[catIdx].id ?? catIdx}-${n}`,
            name: name.trim(),
            nameEs: name.trim(),
            subcat: subcat.trim(),
            vendor: '',
            pack: '',
            price: null,
            preferredVendor: '',
            vendorOptions: [],
        });
        next[catIdx] = { ...next[catIdx], items };
        setCats(next);
    };

    return (
        <div>
            {/* Save bar */}
            <div className="flex flex-wrap items-center gap-2 mb-3 sticky top-0 bg-white py-2 z-10 border-b border-dd-line">
                <button onClick={addCat}
                    className="px-3 py-1.5 rounded-lg bg-white border-2 border-dashed border-dd-line text-dd-text-2 hover:bg-dd-bg text-xs font-bold">
                    ➕ {tx('Add category', 'Añadir categoría')}
                </button>
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

            {cats.length === 0 && (
                <p className="text-sm text-dd-text-2 text-center py-8">
                    {tx('No categories. Click "Add category" to start.', 'Sin categorías. Haz clic en "Añadir categoría".')}
                </p>
            )}

            {cats.map((cat, catIdx) => {
                const expanded = expandedCatIdx === catIdx;
                return (
                    <div key={cat.id ?? catIdx}
                        className="border border-dd-line rounded-xl bg-white mb-2 overflow-hidden">
                        <div className="flex items-center gap-2 p-2 bg-dd-bg">
                            <div className="flex flex-col">
                                <button onClick={() => moveCat(catIdx, -1)}
                                    disabled={catIdx === 0}
                                    className="text-xs text-dd-text-2 disabled:opacity-20 hover:text-dd-text">▲</button>
                                <button onClick={() => moveCat(catIdx, 1)}
                                    disabled={catIdx === cats.length - 1}
                                    className="text-xs text-dd-text-2 disabled:opacity-20 hover:text-dd-text">▼</button>
                            </div>
                            <input type="text" value={isEs ? (cat.nameEs || cat.name) : cat.name}
                                onChange={e => renameCat(catIdx, e.target.value)}
                                className="flex-1 px-2 py-1 rounded border border-dd-line text-sm font-bold bg-white" />
                            <span className="text-[11px] text-dd-text-2">{cat.items?.length || 0}</span>
                            <button onClick={() => setExpandedCatIdx(expanded ? null : catIdx)}
                                className="px-2 py-1 rounded-md bg-white border border-dd-line text-[11px] font-bold">
                                {expanded ? tx('Hide', 'Ocultar') : tx('Items', 'Artículos')}
                            </button>
                            <button onClick={() => removeCat(catIdx)}
                                className="px-2 py-1 rounded-md bg-white border border-red-200 text-red-700 text-[11px] font-bold hover:bg-red-50">
                                🗑
                            </button>
                        </div>
                        {expanded && (
                            <div className="p-2 space-y-1">
                                {(cat.items || []).map((item, itemIdx) => (
                                    <div key={item.id ?? itemIdx}
                                        className="flex items-center gap-1 px-2 py-1.5 rounded-md hover:bg-dd-bg border border-transparent hover:border-dd-line">
                                        <div className="flex flex-col">
                                            <button onClick={() => moveItem(catIdx, itemIdx, -1)}
                                                disabled={itemIdx === 0}
                                                className="text-[10px] text-dd-text-2 disabled:opacity-20 hover:text-dd-text">▲</button>
                                            <button onClick={() => moveItem(catIdx, itemIdx, 1)}
                                                disabled={itemIdx === (cat.items?.length || 0) - 1}
                                                className="text-[10px] text-dd-text-2 disabled:opacity-20 hover:text-dd-text">▼</button>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm text-dd-text truncate">{isEs ? (item.nameEs || item.name) : item.name}</div>
                                            {item.subcat && (
                                                <div className="text-[10px] text-dd-text-2">{item.subcat}</div>
                                            )}
                                        </div>
                                        <button onClick={() => removeItem(catIdx, itemIdx)}
                                            className="px-1.5 py-0.5 rounded text-[10px] text-red-700 hover:bg-red-50">
                                            ✕
                                        </button>
                                    </div>
                                ))}
                                <button onClick={() => addItemTo(catIdx)}
                                    className="w-full mt-1 py-1.5 rounded-md bg-white border border-dashed border-dd-line text-dd-text-2 hover:bg-dd-bg text-xs font-bold">
                                    ➕ {tx('Add item', 'Añadir artículo')}
                                </button>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
