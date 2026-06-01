// MenuConfigEditor — full admin editor for the SaaS-ready menu config.
//
// Andrew 2026-05-30, Phase 1.B–1.D. Replaces the previous overlay-only
// MenuEditor with a full CRUD editor backed by the Firestore docs
// declared in src/data/menuConfig.js:
//
//     /config/menu_v2        — categories + items
//     /config/brand          — restaurant name, cuisine, location labels
//     /config/build_sheet    — toppings/modifiers/broths/sauces
//
// Tabs:
//   • Items     — list items by category, search/filter, full edit modal
//   • Categories — rename, reorder, archive; per-category notes
//   • Brand     — name, cuisine, location labels
//   • Build Sheet — per-section item editor (toppings, broths, etc.)
//
// Important design choices:
//   - All edits live in a LOCAL draft (React state) until Save. This is
//     a single-doc atomic write (50 categories cap on the Firestore
//     rule), so partial saves are impossible. If two admins are editing
//     simultaneously, last-write-wins — a `lastSeenAt` ref + a
//     "doc changed, reload?" toast is the next iteration. For DD Mau
//     today (Andrew + Julie), good enough.
//   - Drag-and-drop reorder uses up/down arrows for now. Cleaner than
//     pulling in a DnD library; can upgrade in a follow-up.
//   - Empty Firestore doc → "Seed from legacy menu" banner that calls
//     migrateLegacyToFirestore(). First-time-setup flow.
//   - Every Save writes an audit row to /menu_audits via recordAudit.
//
// Bilingual via tx(en, es) per the codebase convention.

import { useState, useEffect, useMemo, useRef } from 'react';
import {
    useMenuConfig, useBrandConfig, useBuildSheetConfig,
    writeMenuConfig, writeBrandConfig, writeBuildSheetConfig,
    migrateLegacyToFirestore,
    slugifyText, makeItemSlug, makeCategorySlug,
    DEFAULT_BRAND,
} from '../data/menuConfig';
import { toast } from '../toast';
import { recordAudit } from '../data/audit';
import ModalPortal from './ModalPortal';
import ConfirmModal from './ConfirmModal';
import {
    Layers, Tags, Sparkles, FileText, Plus, Trash2, ArrowUp, ArrowDown,
    ChevronRight, X, Search, AlertTriangle, Edit3, Save, Copy, Archive,
} from 'lucide-react';

const TABS = [
    { id: 'items',      labelEn: 'Items',        labelEs: 'Artículos',   Icon: Layers },
    { id: 'categories', labelEn: 'Categories',   labelEs: 'Categorías',  Icon: Tags },
    { id: 'brand',      labelEn: 'Brand',        labelEs: 'Marca',       Icon: Sparkles },
    { id: 'buildsheet', labelEn: 'Build sheet',  labelEs: 'Build sheet', Icon: FileText },
];

// Build-sheet section IDs come from the legacy converter so a missing
// section is still represented (empty array).
const BUILD_SECTIONS = [
    { id: 'bowls',      labelEn: 'Bowls',       labelEs: 'Bowls' },
    { id: 'handhelds',  labelEn: 'Handhelds',   labelEs: 'Handhelds' },
    { id: 'friedRice',  labelEn: 'Fried Rice',  labelEs: 'Arroz Frito' },
    { id: 'pho',        labelEn: 'Pho',         labelEs: 'Pho' },
    { id: 'sauces',     labelEn: 'Sauces',      labelEs: 'Salsas' },
    { id: 'snacks',     labelEn: 'Snacks',      labelEs: 'Snacks' },
];

export default function MenuConfigEditor({ language = 'en', byName }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [activeTab, setActiveTab] = useState('items');

    return (
        <section className="mt-6 mb-4 bg-white border-2 border-emerald-200 rounded-xl shadow-card overflow-hidden">
            <header className="px-4 py-3 bg-emerald-50 border-b border-emerald-200">
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-white text-emerald-700 flex items-center justify-center shrink-0 shadow-sm">
                        <Layers size={20} strokeWidth={2.25} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-base font-black text-emerald-900">
                            {tx('Menu, brand & build sheet', 'Menú, marca y build sheet')}
                        </h2>
                        <p className="text-[11px] text-emerald-800/85 leading-snug mt-0.5">
                            {tx(
                                'Edit every item, category, brand string, and prep instruction without a code push. Saves go live on TVs + staff phones within seconds.',
                                'Edita cada artículo, categoría, texto de marca e instrucción sin tocar el código. Los cambios se reflejan en TVs y teléfonos en segundos.'
                            )}
                        </p>
                    </div>
                </div>
                {/* Tabs */}
                <div className="mt-3 flex gap-1 overflow-x-auto -mb-px">
                    {TABS.map(t => {
                        const sel = activeTab === t.id;
                        return (
                            <button key={t.id}
                                onClick={() => setActiveTab(t.id)}
                                className={`shrink-0 px-3 py-1.5 rounded-t-lg text-xs font-bold transition flex items-center gap-1.5 ${
                                    sel
                                        ? 'bg-white text-emerald-700 border-2 border-emerald-200 border-b-white'
                                        : 'bg-emerald-100/60 text-emerald-800/70 hover:bg-emerald-100 border-2 border-transparent'
                                }`}>
                                <t.Icon size={14} strokeWidth={2.25} />
                                {tx(t.labelEn, t.labelEs)}
                            </button>
                        );
                    })}
                </div>
            </header>
            <div className="p-4 bg-white">
                {activeTab === 'items'      && <ItemsTab      language={language} byName={byName} />}
                {activeTab === 'categories' && <CategoriesTab language={language} byName={byName} />}
                {activeTab === 'brand'      && <BrandTab      language={language} byName={byName} />}
                {activeTab === 'buildsheet' && <BuildSheetTab language={language} byName={byName} />}
            </div>
        </section>
    );
}

// ─── Shared bits ────────────────────────────────────────────────────────

// First-run banner that appears whenever the Firestore doc is empty.
// Offers a one-tap migration of the hardcoded legacy data so admins
// arent staring at an empty editor.
function SeedFromLegacyBanner({ language, byName, onDone }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const [busy, setBusy] = useState(false);
    const handleSeed = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const r = await migrateLegacyToFirestore({ byName });
            toast(tx(
                `Seeded ${r.menuItemCount} items + ${r.buildSheetItemCount} build sheet rows + brand.`,
                `Sembrado ${r.menuItemCount} artículos + ${r.buildSheetItemCount} filas de build sheet + marca.`
            ));
            try {
                await recordAudit({
                    kind: 'menu_seed',
                    detail: { itemCount: r.menuItemCount, buildSheetItemCount: r.buildSheetItemCount },
                    byName,
                });
            } catch {}
            onDone && onDone();
        } catch (e) {
            console.error('seed-from-legacy failed', e);
            toast(tx('Could not seed: ', 'No se pudo sembrar: ') + (e?.message || 'error'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200">
            <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="text-amber-700 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-amber-900">
                        {tx('No Firestore menu yet', 'Aún no hay menú en Firestore')}
                    </div>
                    <div className="text-[11px] text-amber-800/85 mt-0.5 leading-snug">
                        {tx(
                            'The editor falls back to the hardcoded menu until you seed Firestore. Tap below to copy the current menu, brand strings, and build sheet into Firestore so you can edit them.',
                            'El editor usa el menú codificado hasta que siembres Firestore. Toca abajo para copiar el menú actual, marca y build sheet a Firestore para poder editarlos.'
                        )}
                    </div>
                    <button onClick={handleSeed} disabled={busy}
                        className="mt-2 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 active:scale-95 text-white text-xs font-bold transition disabled:opacity-60">
                        {busy
                            ? tx('Seeding…', 'Sembrando…')
                            : tx('Seed Firestore from legacy menu', 'Sembrar Firestore desde menú legado')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Compact reorder controls used in every list (up/down arrows).
function ReorderButtons({ canUp, canDown, onUp, onDown, language }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    return (
        <div className="flex items-center gap-0.5">
            {/* 36pt visible buttons; combined with normal fingertip
                contact area (~40-50pt) this comfortably clears the
                Apple HIG minimum without breaking the tight row
                layout that 44pt buttons would force. Mobile audit
                2026-05-31. */}
            <button onClick={onUp} disabled={!canUp}
                aria-label={tx('Move up', 'Subir')}
                className="w-9 h-9 rounded-md text-dd-text-2 hover:bg-dd-bg disabled:opacity-25 disabled:hover:bg-transparent flex items-center justify-center transition">
                <ArrowUp size={16} strokeWidth={2.5} />
            </button>
            <button onClick={onDown} disabled={!canDown}
                aria-label={tx('Move down', 'Bajar')}
                className="w-9 h-9 rounded-md text-dd-text-2 hover:bg-dd-bg disabled:opacity-25 disabled:hover:bg-transparent flex items-center justify-center transition">
                <ArrowDown size={16} strokeWidth={2.5} />
            </button>
        </div>
    );
}

// Generic small input + label combo so the editor's form bodies stay
// dense and readable.
function Field({ label, value, onChange, placeholder, multiline, type = 'text', className = '' }) {
    if (multiline) {
        return (
            <label className={`block ${className}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">{label}</div>
                <textarea
                    value={value || ''}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    rows={3}
                    className="w-full px-2 py-1.5 rounded-lg border border-dd-line bg-white text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                />
            </label>
        );
    }
    return (
        <label className={`block ${className}`}>
            <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">{label}</div>
            <input
                type={type}
                value={value || ''}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full px-2 py-1.5 rounded-lg border border-dd-line bg-white text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
            />
        </label>
    );
}

// ─── ItemsTab ───────────────────────────────────────────────────────────
// List items grouped by category. Click an item to open the edit modal.

function ItemsTab({ language, byName }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const { menu, ready, fromFirestore } = useMenuConfig();
    const [draft, setDraft] = useState(null);
    const [activeCatId, setActiveCatId] = useState(null);
    const [search, setSearch] = useState('');
    const [editing, setEditing] = useState(null);   // { catId, itemId, isNew }
    const [confirming, setConfirming] = useState(null);
    const [saving, setSaving] = useState(false);
    const lastSavedRef = useRef(null);

    // Initialize draft from the live menu the first time the tab paints,
    // and any time the live menu actually changes (fromFirestore flips
    // or the doc itself reloads). Use a JSON-string compare so we don't
    // clobber unsaved edits on every snapshot tick.
    useEffect(() => {
        if (!ready) return;
        const hash = JSON.stringify(menu);
        if (hash === lastSavedRef.current) return;
        setDraft(JSON.parse(hash));
        lastSavedRef.current = hash;
    }, [menu, ready]);

    // Default category selection.
    useEffect(() => {
        if (!draft) return;
        if (activeCatId && draft.find(c => c.id === activeCatId)) return;
        if (draft.length) setActiveCatId(draft[0].id);
    }, [draft, activeCatId]);

    if (!ready || !draft) {
        return <div className="text-sm text-dd-text-2 italic p-4">{tx('Loading menu…', 'Cargando menú…')}</div>;
    }

    const activeCat = draft.find(c => c.id === activeCatId);
    const items = activeCat?.items || [];
    const filteredItems = items.filter(it => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (it.nameEn || '').toLowerCase().includes(q)
            || (it.nameEs || '').toLowerCase().includes(q)
            || (it.descEn || '').toLowerCase().includes(q);
    });

    const dirty = JSON.stringify(draft) !== lastSavedRef.current;

    const updateCategoryItems = (newItems) => {
        setDraft(prev => prev.map(c => c.id === activeCatId ? { ...c, items: newItems } : c));
    };

    const moveItem = (idx, dir) => {
        const newItems = [...items];
        const swapIdx = idx + dir;
        if (swapIdx < 0 || swapIdx >= newItems.length) return;
        [newItems[idx], newItems[swapIdx]] = [newItems[swapIdx], newItems[idx]];
        // Reassign order so the new positions stick.
        const reordered = newItems.map((it, i) => ({ ...it, order: i }));
        updateCategoryItems(reordered);
    };

    const archiveItem = (itemId) => {
        const updated = items.map(it => it.id === itemId ? { ...it, archived: !it.archived } : it);
        updateCategoryItems(updated);
    };

    const deleteItem = (itemId) => {
        setConfirming({
            title: tx('Delete item permanently?', '¿Eliminar artículo permanentemente?'),
            body: tx(
                'This removes the item from the menu data. Archived items stay hidden but can be restored — delete cannot be undone.',
                'Esto elimina el artículo de los datos del menú. Los artículos archivados quedan ocultos pero recuperables — eliminar no se puede deshacer.'
            ),
            tone: 'danger',
            confirmLabel: tx('Delete', 'Eliminar'),
            onConfirm: () => {
                const updated = items.filter(it => it.id !== itemId);
                updateCategoryItems(updated);
                setConfirming(null);
            },
        });
    };

    const startAdd = () => {
        if (!activeCat) return;
        const blank = {
            id: makeItemSlug(activeCat.id, `new-item-${Date.now()}`),
            nameEn: '',
            nameEs: '',
            nameVi: '',
            price: '',
            descEn: '',
            descEs: '',
            allergens: '',
            spicy: false, vegan: false, glutenFree: false, popular: false,
            photoUrl: '',
            order: items.length,
            archived: false,
        };
        setEditing({ catId: activeCat.id, itemId: blank.id, isNew: true, draft: blank });
    };

    const startEdit = (item) => {
        setEditing({ catId: activeCat.id, itemId: item.id, isNew: false, draft: { ...item } });
    };

    const commitEdit = (savedItem) => {
        const updated = editing.isNew
            ? [...items, savedItem]
            : items.map(it => it.id === editing.itemId ? savedItem : it);
        // If the name changed AND this is an existing item, the slug
        // could drift. We deliberately do NOT regenerate the slug on
        // rename — the whole point of stable IDs is rename-safe. A
        // separate "regenerate slug" button could be exposed later if
        // somebody really needs URL hygiene; for now we lock the id
        // forever once written.
        updateCategoryItems(updated);
        setEditing(null);
    };

    const onSave = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await writeMenuConfig({ categories: draft, byName });
            lastSavedRef.current = JSON.stringify(draft);
            try {
                await recordAudit({ kind: 'menu_save', detail: { categoriesCount: draft.length }, byName });
            } catch {}
            toast(tx('Menu saved.', 'Menú guardado.'));
        } catch (e) {
            console.error('menu save failed', e);
            toast(tx('Save failed: ', 'Error al guardar: ') + (e?.message || 'error'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            {!fromFirestore && <SeedFromLegacyBanner language={language} byName={byName} />}

            {/* Category sidebar + items list, two-column on md+ */}
            <div className="flex flex-col md:flex-row gap-3">
                {/* Sidebar: category list */}
                <div className="md:w-56 shrink-0">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                        {tx('Categories', 'Categorías')}
                    </div>
                    <div className="rounded-lg border border-dd-line bg-dd-bg/40 overflow-hidden">
                        {draft.map(cat => {
                            const sel = cat.id === activeCatId;
                            const liveCount = (cat.items || []).filter(it => !it.archived).length;
                            return (
                                <button key={cat.id}
                                    onClick={() => setActiveCatId(cat.id)}
                                    className={`w-full px-3 py-2 text-left text-sm transition flex items-center justify-between gap-2 ${
                                        sel
                                            ? 'bg-emerald-50 text-emerald-900 font-bold'
                                            : 'hover:bg-white text-dd-text'
                                    } ${cat.archived ? 'opacity-50' : ''}`}>
                                    <span className="truncate">{isEs(language) ? (cat.nameEs || cat.nameEn) : cat.nameEn}</span>
                                    <span className="text-[10px] tabular-nums text-dd-text-2/70">{liveCount}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Items list for the selected category */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                        <div className="relative flex-1 min-w-0">
                            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-dd-text-2/70" />
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder={tx('Search items…', 'Buscar artículos…')}
                                className="w-full pl-7 pr-2 py-1.5 rounded-lg border border-dd-line bg-white text-sm focus:border-emerald-500 focus:outline-none"
                            />
                        </div>
                        <button onClick={startAdd}
                            disabled={!activeCat || activeCat.archived}
                            className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-bold flex items-center gap-1 transition disabled:opacity-40">
                            <Plus size={14} strokeWidth={2.5} /> {tx('Add', 'Agregar')}
                        </button>
                    </div>
                    <div className="rounded-lg border border-dd-line overflow-hidden">
                        {filteredItems.length === 0 ? (
                            <div className="p-4 text-center text-sm text-dd-text-2 italic">
                                {tx('No items.', 'Sin artículos.')}
                            </div>
                        ) : (
                            filteredItems.map((it, i) => {
                                const idx = items.indexOf(it);
                                return (
                                    <div key={it.id}
                                        className={`px-3 py-2 border-b border-dd-line/60 last:border-b-0 flex items-center gap-2 ${
                                            it.archived ? 'bg-dd-bg/40 opacity-60' : 'bg-white hover:bg-dd-bg/50'
                                        }`}>
                                        <ReorderButtons
                                            canUp={idx > 0}
                                            canDown={idx < items.length - 1}
                                            onUp={() => moveItem(idx, -1)}
                                            onDown={() => moveItem(idx, +1)}
                                            language={language}
                                        />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-dd-text truncate flex items-center gap-1.5">
                                                {(isEs(language) && it.nameEs) ? it.nameEs : (it.nameEn || tx('(no name)', '(sin nombre)'))}
                                                {it.archived && (
                                                    <span className="text-[9px] font-black uppercase text-dd-text-2/70 px-1 rounded bg-dd-bg border border-dd-line">
                                                        {tx('Archived', 'Archivado')}
                                                    </span>
                                                )}
                                                {it.popular && <span className="text-[9px] font-bold text-pink-600">★</span>}
                                                {it.spicy && <span className="text-[10px]">🌶</span>}
                                                {it.vegan && <span className="text-[9px] font-bold text-emerald-700">VG</span>}
                                                {it.glutenFree && <span className="text-[9px] font-bold text-amber-700">GF</span>}
                                            </div>
                                            <div className="text-[11px] text-dd-text-2 leading-tight truncate">
                                                {it.price} {it.descEn ? ' · ' + it.descEn : ''}
                                            </div>
                                        </div>
                                        <button onClick={() => startEdit(it)}
                                            aria-label={tx('Edit', 'Editar')}
                                            className="w-8 h-8 rounded-lg text-dd-text-2 hover:bg-dd-bg flex items-center justify-center transition">
                                            <Edit3 size={14} strokeWidth={2.25} />
                                        </button>
                                        <button onClick={() => archiveItem(it.id)}
                                            aria-label={it.archived ? tx('Restore', 'Restaurar') : tx('Archive', 'Archivar')}
                                            className="w-8 h-8 rounded-lg text-dd-text-2 hover:bg-dd-bg flex items-center justify-center transition">
                                            <Archive size={14} strokeWidth={2.25} />
                                        </button>
                                        <button onClick={() => deleteItem(it.id)}
                                            aria-label={tx('Delete', 'Eliminar')}
                                            className="w-8 h-8 rounded-lg text-red-600 hover:bg-red-50 flex items-center justify-center transition">
                                            <Trash2 size={14} strokeWidth={2.25} />
                                        </button>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>

            {/* Save bar */}
            <div className="mt-4 flex items-center justify-between gap-3 sticky bottom-0 bg-white pt-3 border-t border-dd-line">
                <div className="text-[11px] text-dd-text-2">
                    {dirty
                        ? tx('Unsaved changes.', 'Cambios sin guardar.')
                        : tx('All changes saved.', 'Todos los cambios guardados.')}
                </div>
                <button onClick={onSave} disabled={!dirty || saving}
                    className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-bold flex items-center gap-1.5 transition disabled:opacity-40 disabled:cursor-not-allowed">
                    <Save size={14} strokeWidth={2.5} />
                    {saving ? tx('Saving…', 'Guardando…') : tx('Save menu', 'Guardar menú')}
                </button>
            </div>

            {/* Edit modal */}
            {editing && (
                <ItemEditModal
                    item={editing.draft}
                    isNew={editing.isNew}
                    onSubmit={commitEdit}
                    onCancel={() => setEditing(null)}
                    language={language}
                />
            )}
            {confirming && (
                <ConfirmModal {...confirming} onClose={() => setConfirming(null)} language={language} />
            )}
        </div>
    );
}

function isEs(language) { return language === 'es'; }

// Item edit modal — full per-item form.
function ItemEditModal({ item, isNew, onSubmit, onCancel, language }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const [draft, setDraft] = useState(item);
    const upd = (patch) => setDraft(prev => ({ ...prev, ...patch }));
    const dirty = JSON.stringify(draft) !== JSON.stringify(item);

    const handleSubmit = () => {
        if (!draft.nameEn || !draft.nameEn.trim()) {
            toast(tx('Name (English) is required.', 'El nombre (inglés) es obligatorio.'));
            return;
        }
        onSubmit({ ...draft, nameEn: draft.nameEn.trim() });
    };

    return (
        <ModalPortal>
            <div className="fixed inset-0 z-[60] bg-black/50 flex items-end md:items-center justify-center p-3"
                onClick={onCancel} role="dialog" aria-modal="true">
                <div className="bg-white w-full md:max-w-2xl md:rounded-2xl rounded-t-2xl shadow-xl max-h-[92vh] flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                    style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                    <header className="px-4 py-3 border-b border-dd-line bg-dd-sage-50 flex items-center justify-between">
                        <div>
                            <h3 className="text-base font-black text-dd-text">
                                {isNew ? tx('New item', 'Nuevo artículo') : tx('Edit item', 'Editar artículo')}
                            </h3>
                            <p className="text-[10px] text-dd-text-2 font-mono mt-0.5">id: {draft.id}</p>
                        </div>
                        <button onClick={onCancel} aria-label={tx('Close', 'Cerrar')}
                            className="w-9 h-9 rounded-full hover:bg-white/60 flex items-center justify-center text-dd-text-2">
                            <X size={16} strokeWidth={2.5} />
                        </button>
                    </header>
                    <div className="p-4 overflow-y-auto flex-1 min-h-0 space-y-3">
                        {/* Names */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                            <Field label={tx('Name (EN)', 'Nombre (EN)')}
                                value={draft.nameEn} onChange={(v) => upd({ nameEn: v })} />
                            <Field label={tx('Name (ES)', 'Nombre (ES)')}
                                value={draft.nameEs} onChange={(v) => upd({ nameEs: v })} />
                            <Field label={tx('Name (VI, optional)', 'Nombre (VI, opcional)')}
                                value={draft.nameVi} onChange={(v) => upd({ nameVi: v })} />
                        </div>
                        {/* Price */}
                        <Field label={tx('Price', 'Precio')}
                            value={draft.price} onChange={(v) => upd({ price: v })}
                            placeholder="$10.00"
                            className="md:max-w-xs" />
                        {/* Descriptions */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <Field label={tx('Description (EN)', 'Descripción (EN)')}
                                value={draft.descEn} onChange={(v) => upd({ descEn: v })}
                                multiline />
                            <Field label={tx('Description (ES)', 'Descripción (ES)')}
                                value={draft.descEs} onChange={(v) => upd({ descEs: v })}
                                multiline />
                        </div>
                        {/* Allergens — freeform for now (Phase 2 adds structured chips) */}
                        <Field label={tx('Allergens (freeform)', 'Alérgenos (texto libre)')}
                            value={draft.allergens} onChange={(v) => upd({ allergens: v })}
                            placeholder="Soy, Wheat, Fish (vinaigrette). Optional peanut."
                            multiline />
                        {/* Badges */}
                        <div>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                                {tx('Badges', 'Etiquetas')}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {[
                                    { key: 'spicy',      labelEn: '🌶 Spicy',     labelEs: '🌶 Picante' },
                                    { key: 'vegan',      labelEn: 'VG Vegan',     labelEs: 'VG Vegano' },
                                    { key: 'glutenFree', labelEn: 'GF Gluten-Free', labelEs: 'GF Sin Gluten' },
                                    { key: 'popular',    labelEn: '★ Popular',    labelEs: '★ Popular' },
                                ].map(({ key, labelEn, labelEs }) => {
                                    const on = !!draft[key];
                                    return (
                                        <button key={key}
                                            onClick={() => upd({ [key]: !on })}
                                            className={`px-2.5 py-1 rounded-full text-xs font-bold border transition ${
                                                on
                                                    ? 'bg-emerald-100 border-emerald-300 text-emerald-900'
                                                    : 'bg-white border-dd-line text-dd-text-2 hover:bg-dd-bg'
                                            }`}>
                                            {tx(labelEn, labelEs)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        {/* Photo URL */}
                        <Field label={tx('Photo URL (optional)', 'URL de foto (opcional)')}
                            value={draft.photoUrl} onChange={(v) => upd({ photoUrl: v })}
                            placeholder="https://…" />
                    </div>
                    <footer className="px-4 py-3 border-t border-dd-line bg-dd-bg/40 flex items-center justify-end gap-2">
                        <button onClick={onCancel}
                            className="px-3 py-2 rounded-lg bg-white border border-dd-line text-sm font-bold text-dd-text hover:bg-dd-bg transition">
                            {tx('Cancel', 'Cancelar')}
                        </button>
                        <button onClick={handleSubmit} disabled={!dirty && !isNew}
                            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-bold transition disabled:opacity-50">
                            {isNew ? tx('Add item', 'Agregar') : tx('Save changes', 'Guardar')}
                        </button>
                    </footer>
                </div>
            </div>
        </ModalPortal>
    );
}

// ─── CategoriesTab ──────────────────────────────────────────────────────

function CategoriesTab({ language, byName }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const { menu, ready, fromFirestore } = useMenuConfig();
    const [draft, setDraft] = useState(null);
    const [confirming, setConfirming] = useState(null);
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState(null);
    const lastSavedRef = useRef(null);

    useEffect(() => {
        if (!ready) return;
        const hash = JSON.stringify(menu);
        if (hash === lastSavedRef.current) return;
        setDraft(JSON.parse(hash));
        lastSavedRef.current = hash;
    }, [menu, ready]);

    if (!ready || !draft) {
        return <div className="text-sm text-dd-text-2 italic p-4">{tx('Loading categories…', 'Cargando categorías…')}</div>;
    }

    const dirty = JSON.stringify(draft) !== lastSavedRef.current;

    const move = (idx, dir) => {
        const arr = [...draft];
        const swap = idx + dir;
        if (swap < 0 || swap >= arr.length) return;
        [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
        setDraft(arr.map((c, i) => ({ ...c, order: i })));
    };

    const archive = (id) => {
        setDraft(prev => prev.map(c => c.id === id ? { ...c, archived: !c.archived } : c));
    };

    const remove = (id) => {
        const cat = draft.find(c => c.id === id);
        const itemCount = (cat?.items || []).length;
        setConfirming({
            title: tx(`Delete "${cat?.nameEn}" permanently?`, `¿Eliminar "${cat?.nameEn}" permanentemente?`),
            body: tx(
                `This removes the category AND all ${itemCount} items inside it. Archived items inside can still be lost. This cannot be undone.`,
                `Esto elimina la categoría Y los ${itemCount} artículos adentro. Los archivados también. No se puede deshacer.`
            ),
            tone: 'danger',
            confirmLabel: tx('Delete', 'Eliminar'),
            onConfirm: () => {
                setDraft(prev => prev.filter(c => c.id !== id));
                setConfirming(null);
            },
        });
    };

    const startAdd = () => {
        const blank = {
            id: makeCategorySlug(`new-category-${Date.now()}`),
            nameEn: '',
            nameEs: '',
            noteEn: '',
            noteEs: '',
            customizable: [],
            order: draft.length,
            archived: false,
            items: [],
        };
        setEditing({ ...blank, _isNew: true });
    };

    const commitEdit = (saved) => {
        const { _isNew, ...catData } = saved;
        if (_isNew) {
            setDraft(prev => [...prev, catData]);
        } else {
            setDraft(prev => prev.map(c => c.id === catData.id ? { ...c, ...catData } : c));
        }
        setEditing(null);
    };

    const onSave = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await writeMenuConfig({ categories: draft, byName });
            lastSavedRef.current = JSON.stringify(draft);
            try { await recordAudit({ kind: 'menu_categories_save', detail: { count: draft.length }, byName }); } catch {}
            toast(tx('Categories saved.', 'Categorías guardadas.'));
        } catch (e) {
            console.error('save failed', e);
            toast(tx('Save failed: ', 'Error: ') + (e?.message || ''));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            {!fromFirestore && <SeedFromLegacyBanner language={language} byName={byName} />}
            <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                    {tx('Categories', 'Categorías')} <span className="text-dd-text-2/70">({draft.length})</span>
                </div>
                <button onClick={startAdd}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-bold flex items-center gap-1 transition">
                    <Plus size={14} strokeWidth={2.5} /> {tx('Add category', 'Agregar')}
                </button>
            </div>
            <div className="rounded-lg border border-dd-line overflow-hidden">
                {draft.map((cat, idx) => (
                    <div key={cat.id}
                        className={`px-3 py-2 border-b border-dd-line/60 last:border-b-0 flex items-center gap-2 ${
                            cat.archived ? 'bg-dd-bg/40 opacity-60' : 'bg-white hover:bg-dd-bg/50'
                        }`}>
                        <ReorderButtons
                            canUp={idx > 0}
                            canDown={idx < draft.length - 1}
                            onUp={() => move(idx, -1)}
                            onDown={() => move(idx, +1)}
                            language={language}
                        />
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-dd-text truncate flex items-center gap-1.5">
                                {language === 'es' ? (cat.nameEs || cat.nameEn) : (cat.nameEn || tx('(no name)', '(sin nombre)'))}
                                {cat.archived && (
                                    <span className="text-[9px] font-black uppercase text-dd-text-2/70 px-1 rounded bg-dd-bg border border-dd-line">
                                        {tx('Archived', 'Archivado')}
                                    </span>
                                )}
                                <span className="text-[10px] font-bold text-dd-text-2/70 tabular-nums">
                                    {(cat.items || []).filter(it => !it.archived).length} {tx('items', 'art.')}
                                </span>
                            </div>
                            {cat.noteEn && (
                                <div className="text-[11px] text-dd-text-2 leading-tight truncate">
                                    {language === 'es' ? (cat.noteEs || cat.noteEn) : cat.noteEn}
                                </div>
                            )}
                        </div>
                        <button onClick={() => setEditing({ ...cat })}
                            aria-label={tx('Edit', 'Editar')}
                            className="w-8 h-8 rounded-lg text-dd-text-2 hover:bg-dd-bg flex items-center justify-center transition">
                            <Edit3 size={14} strokeWidth={2.25} />
                        </button>
                        <button onClick={() => archive(cat.id)}
                            aria-label={cat.archived ? tx('Restore', 'Restaurar') : tx('Archive', 'Archivar')}
                            className="w-8 h-8 rounded-lg text-dd-text-2 hover:bg-dd-bg flex items-center justify-center transition">
                            <Archive size={14} strokeWidth={2.25} />
                        </button>
                        <button onClick={() => remove(cat.id)}
                            aria-label={tx('Delete', 'Eliminar')}
                            className="w-8 h-8 rounded-lg text-red-600 hover:bg-red-50 flex items-center justify-center transition">
                            <Trash2 size={14} strokeWidth={2.25} />
                        </button>
                    </div>
                ))}
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 sticky bottom-0 bg-white pt-3 border-t border-dd-line">
                <div className="text-[11px] text-dd-text-2">
                    {dirty
                        ? tx('Unsaved changes.', 'Cambios sin guardar.')
                        : tx('All changes saved.', 'Todos los cambios guardados.')}
                </div>
                <button onClick={onSave} disabled={!dirty || saving}
                    className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-bold flex items-center gap-1.5 transition disabled:opacity-40">
                    <Save size={14} strokeWidth={2.5} />
                    {saving ? tx('Saving…', 'Guardando…') : tx('Save categories', 'Guardar')}
                </button>
            </div>

            {editing && (
                <CategoryEditModal
                    cat={editing}
                    isNew={!!editing._isNew}
                    onSubmit={commitEdit}
                    onCancel={() => setEditing(null)}
                    language={language}
                />
            )}
            {confirming && (
                <ConfirmModal {...confirming} onClose={() => setConfirming(null)} language={language} />
            )}
        </div>
    );
}

function CategoryEditModal({ cat, isNew, onSubmit, onCancel, language }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const [draft, setDraft] = useState(cat);
    const upd = (patch) => setDraft(prev => ({ ...prev, ...patch }));
    const handleSubmit = () => {
        if (!draft.nameEn || !draft.nameEn.trim()) {
            toast(tx('Name (English) is required.', 'El nombre (inglés) es obligatorio.'));
            return;
        }
        const finalDraft = {
            ...draft,
            nameEn: draft.nameEn.trim(),
            // Lock the slug on first save for new categories; existing
            // categories never re-slug (rename-safe).
            id: isNew ? makeCategorySlug(draft.nameEn.trim()) : draft.id,
        };
        onSubmit(finalDraft);
    };
    return (
        <ModalPortal>
            <div className="fixed inset-0 z-[60] bg-black/50 flex items-end md:items-center justify-center p-3"
                onClick={onCancel} role="dialog" aria-modal="true">
                <div className="bg-white w-full md:max-w-xl md:rounded-2xl rounded-t-2xl shadow-xl max-h-[92vh] flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                    style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                    <header className="px-4 py-3 border-b border-dd-line bg-dd-sage-50 flex items-center justify-between">
                        <div>
                            <h3 className="text-base font-black text-dd-text">
                                {isNew ? tx('New category', 'Nueva categoría') : tx('Edit category', 'Editar categoría')}
                            </h3>
                            {!isNew && <p className="text-[10px] text-dd-text-2 font-mono mt-0.5">id: {draft.id}</p>}
                        </div>
                        <button onClick={onCancel} className="w-9 h-9 rounded-full hover:bg-white/60 flex items-center justify-center text-dd-text-2">
                            <X size={16} strokeWidth={2.5} />
                        </button>
                    </header>
                    <div className="p-4 overflow-y-auto flex-1 min-h-0 space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <Field label={tx('Name (EN)', 'Nombre (EN)')}
                                value={draft.nameEn} onChange={(v) => upd({ nameEn: v })} />
                            <Field label={tx('Name (ES)', 'Nombre (ES)')}
                                value={draft.nameEs} onChange={(v) => upd({ nameEs: v })} />
                        </div>
                        <Field label={tx('Note (EN)', 'Nota (EN)')}
                            value={draft.noteEn} onChange={(v) => upd({ noteEn: v })}
                            multiline placeholder={tx('Shown above the category — allergen warnings, prep notes, etc.', 'Mostrada encima — alergias, notas de prep, etc.')} />
                        <Field label={tx('Note (ES)', 'Nota (ES)')}
                            value={draft.noteEs} onChange={(v) => upd({ noteEs: v })}
                            multiline />
                        <Field label={tx('Customizable tags (comma-separated)', 'Etiquetas (separadas por coma)')}
                            value={(draft.customizable || []).join(', ')}
                            onChange={(v) => upd({ customizable: v.split(',').map(s => s.trim()).filter(Boolean) })}
                            placeholder="gluten-free, vegan, vegetarian" />
                    </div>
                    <footer className="px-4 py-3 border-t border-dd-line bg-dd-bg/40 flex items-center justify-end gap-2">
                        <button onClick={onCancel}
                            className="px-3 py-2 rounded-lg bg-white border border-dd-line text-sm font-bold text-dd-text hover:bg-dd-bg transition">
                            {tx('Cancel', 'Cancelar')}
                        </button>
                        <button onClick={handleSubmit}
                            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-bold transition">
                            {isNew ? tx('Add category', 'Agregar') : tx('Save', 'Guardar')}
                        </button>
                    </footer>
                </div>
            </div>
        </ModalPortal>
    );
}

// ─── BrandTab ───────────────────────────────────────────────────────────

function BrandTab({ language, byName }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const { brand, ready, fromFirestore } = useBrandConfig();
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    const lastSavedRef = useRef(null);

    useEffect(() => {
        if (!ready) return;
        const hash = JSON.stringify(brand);
        if (hash === lastSavedRef.current) return;
        setDraft(JSON.parse(hash));
        lastSavedRef.current = hash;
    }, [brand, ready]);

    if (!ready || !draft) {
        return <div className="text-sm text-dd-text-2 italic p-4">{tx('Loading brand…', 'Cargando marca…')}</div>;
    }

    const upd = (patch) => setDraft(prev => ({ ...prev, ...patch }));
    const updLoc = (key, value) => setDraft(prev => ({
        ...prev,
        locationLabels: { ...(prev.locationLabels || {}), [key]: value },
    }));
    const dirty = JSON.stringify(draft) !== lastSavedRef.current;

    const onSave = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await writeBrandConfig({ brand: draft, byName });
            lastSavedRef.current = JSON.stringify(draft);
            try { await recordAudit({ kind: 'brand_save', detail: { restaurantName: draft.restaurantName }, byName }); } catch {}
            toast(tx('Brand saved.', 'Marca guardada.'));
        } catch (e) {
            console.error('brand save failed', e);
            toast(tx('Save failed: ', 'Error: ') + (e?.message || ''));
        } finally {
            setSaving(false);
        }
    };

    const locKeys = Object.keys(draft.locationLabels || {});

    return (
        <div>
            {!fromFirestore && <SeedFromLegacyBanner language={language} byName={byName} />}
            <div className="space-y-4 max-w-2xl">
                <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-2">
                        {tx('Restaurant name', 'Nombre del restaurante')}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <Field label={tx('Name (EN)', 'Nombre (EN)')}
                            value={draft.restaurantName} onChange={(v) => upd({ restaurantName: v })} />
                        <Field label={tx('Name (ES)', 'Nombre (ES)')}
                            value={draft.restaurantNameEs} onChange={(v) => upd({ restaurantNameEs: v })} />
                    </div>
                </div>
                <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-2">
                        {tx('Cuisine / tagline', 'Cocina / lema')}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <Field label={tx('Cuisine (EN)', 'Cocina (EN)')}
                            value={draft.cuisineTypeEn} onChange={(v) => upd({ cuisineTypeEn: v })}
                            placeholder="Vietnamese Fast Casual" />
                        <Field label={tx('Cuisine (ES)', 'Cocina (ES)')}
                            value={draft.cuisineTypeEs} onChange={(v) => upd({ cuisineTypeEs: v })}
                            placeholder="Comida Rápida Vietnamita" />
                    </div>
                </div>
                <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-2">
                        {tx('Location labels', 'Etiquetas de ubicación')}
                    </div>
                    <p className="text-[11px] text-dd-text-2 mb-2 leading-snug">
                        {tx(
                            'Display name for each location key. Used on TV menu headers + the header location chip in the staff app.',
                            'Nombre mostrado por clave de ubicación. Usado en encabezados de TVs y en el chip de ubicación del header.'
                        )}
                    </p>
                    <div className="space-y-2">
                        {locKeys.map(k => (
                            <div key={k} className="flex items-center gap-2">
                                <code className="text-[11px] font-mono text-dd-text-2 bg-dd-bg/60 px-2 py-1 rounded shrink-0 min-w-[100px]">{k}</code>
                                <input
                                    value={draft.locationLabels?.[k] || ''}
                                    onChange={(e) => updLoc(k, e.target.value)}
                                    className="flex-1 px-2 py-1.5 rounded-lg border border-dd-line bg-white text-sm focus:border-emerald-500 focus:outline-none"
                                />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 sticky bottom-0 bg-white pt-3 border-t border-dd-line">
                <div className="text-[11px] text-dd-text-2">
                    {dirty
                        ? tx('Unsaved changes.', 'Cambios sin guardar.')
                        : tx('All changes saved.', 'Todos los cambios guardados.')}
                </div>
                <button onClick={onSave} disabled={!dirty || saving}
                    className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-bold flex items-center gap-1.5 transition disabled:opacity-40">
                    <Save size={14} strokeWidth={2.5} />
                    {saving ? tx('Saving…', 'Guardando…') : tx('Save brand', 'Guardar marca')}
                </button>
            </div>
        </div>
    );
}

// ─── BuildSheetTab ──────────────────────────────────────────────────────

function BuildSheetTab({ language, byName }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const { sections, ready, fromFirestore } = useBuildSheetConfig();
    const [draft, setDraft] = useState(null);
    const [activeSection, setActiveSection] = useState('bowls');
    const [editing, setEditing] = useState(null);
    const [confirming, setConfirming] = useState(null);
    const [saving, setSaving] = useState(false);
    const lastSavedRef = useRef(null);

    useEffect(() => {
        if (!ready) return;
        const hash = JSON.stringify(sections);
        if (hash === lastSavedRef.current) return;
        setDraft(JSON.parse(hash));
        lastSavedRef.current = hash;
    }, [sections, ready]);

    if (!ready || !draft) {
        return <div className="text-sm text-dd-text-2 italic p-4">{tx('Loading build sheet…', 'Cargando build sheet…')}</div>;
    }

    const dirty = JSON.stringify(draft) !== lastSavedRef.current;
    // Andrew 2026-05-30 bugfix: force-array. Some legacy build-sheet
    // sections (PHO, FRIED_RICE) are single objects in the hardcoded
    // file; the converter wraps them into a single-element array, but
    // a future schema drift could still hand us a non-array here.
    // Belt-and-suspenders so `.indexOf`, `[...rows]`, and `.map` never
    // throw at render time and bring down the whole admin page.
    const rows = Array.isArray(draft[activeSection]) ? draft[activeSection] : [];

    const updateRows = (next) => setDraft(prev => ({ ...prev, [activeSection]: next }));
    const move = (idx, dir) => {
        const arr = [...rows];
        const swap = idx + dir;
        if (swap < 0 || swap >= arr.length) return;
        [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
        updateRows(arr.map((it, i) => ({ ...it, order: i })));
    };
    const remove = (id) => {
        setConfirming({
            title: tx('Delete row?', '¿Eliminar fila?'),
            body: tx('This removes the row from the build sheet. Cannot be undone.', 'Esto elimina la fila. No se puede deshacer.'),
            tone: 'danger',
            confirmLabel: tx('Delete', 'Eliminar'),
            onConfirm: () => { updateRows(rows.filter(it => it.id !== id)); setConfirming(null); },
        });
    };
    const startAdd = () => {
        const blank = {
            id: makeItemSlug(activeSection, `new-${Date.now()}`),
            nameEn: '', nameEs: '', baseEn: '', baseEs: '',
            standardToppings: [], notes: [], piecesByProtein: {},
            order: rows.length, archived: false,
        };
        setEditing({ ...blank, _isNew: true });
    };
    const commitEdit = (saved) => {
        const { _isNew, ...row } = saved;
        if (_isNew) updateRows([...rows, row]);
        else updateRows(rows.map(it => it.id === row.id ? row : it));
        setEditing(null);
    };
    const onSave = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await writeBuildSheetConfig({ sections: draft, byName });
            lastSavedRef.current = JSON.stringify(draft);
            try { await recordAudit({ kind: 'build_sheet_save', detail: { sections: Object.keys(draft) }, byName }); } catch {}
            toast(tx('Build sheet saved.', 'Build sheet guardado.'));
        } catch (e) {
            console.error('build sheet save failed', e);
            toast(tx('Save failed: ', 'Error: ') + (e?.message || ''));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            {!fromFirestore && <SeedFromLegacyBanner language={language} byName={byName} />}
            {/* Section tabs */}
            <div className="flex gap-1 overflow-x-auto pb-2 mb-2 border-b border-dd-line/60">
                {BUILD_SECTIONS.map(s => {
                    const sel = activeSection === s.id;
                    const count = (draft[s.id] || []).length;
                    return (
                        <button key={s.id}
                            onClick={() => setActiveSection(s.id)}
                            className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-bold border transition ${
                                sel
                                    ? 'bg-emerald-600 text-white border-emerald-600'
                                    : 'bg-white text-dd-text border-dd-line hover:bg-dd-bg'
                            }`}>
                            {tx(s.labelEn, s.labelEs)} <span className="opacity-70">({count})</span>
                        </button>
                    );
                })}
            </div>
            <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                    {tx('Rows', 'Filas')} <span className="text-dd-text-2/70">({rows.length})</span>
                </div>
                <button onClick={startAdd}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-bold flex items-center gap-1 transition">
                    <Plus size={14} strokeWidth={2.5} /> {tx('Add row', 'Agregar')}
                </button>
            </div>
            <div className="rounded-lg border border-dd-line overflow-hidden">
                {rows.length === 0 ? (
                    <div className="p-4 text-center text-sm text-dd-text-2 italic">{tx('No rows.', 'Sin filas.')}</div>
                ) : (
                    rows.map((it, idx) => (
                        <div key={it.id}
                            className="px-3 py-2 border-b border-dd-line/60 last:border-b-0 bg-white hover:bg-dd-bg/50 flex items-center gap-2">
                            <ReorderButtons
                                canUp={idx > 0} canDown={idx < rows.length - 1}
                                onUp={() => move(idx, -1)} onDown={() => move(idx, +1)}
                                language={language}
                            />
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-bold text-dd-text truncate">
                                    {language === 'es' ? (it.nameEs || it.nameEn) : (it.nameEn || tx('(no name)', '(sin nombre)'))}
                                </div>
                                <div className="text-[11px] text-dd-text-2 leading-tight truncate">
                                    {(it.standardToppings || []).length} {tx('toppings', 'toppings')} · {(it.notes || []).length} {tx('notes', 'notas')}
                                </div>
                            </div>
                            <button onClick={() => setEditing({ ...it })}
                                aria-label={tx('Edit', 'Editar')}
                                className="w-8 h-8 rounded-lg text-dd-text-2 hover:bg-dd-bg flex items-center justify-center transition">
                                <Edit3 size={14} strokeWidth={2.25} />
                            </button>
                            <button onClick={() => remove(it.id)}
                                aria-label={tx('Delete', 'Eliminar')}
                                className="w-8 h-8 rounded-lg text-red-600 hover:bg-red-50 flex items-center justify-center transition">
                                <Trash2 size={14} strokeWidth={2.25} />
                            </button>
                        </div>
                    ))
                )}
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 sticky bottom-0 bg-white pt-3 border-t border-dd-line">
                <div className="text-[11px] text-dd-text-2">
                    {dirty
                        ? tx('Unsaved changes.', 'Cambios sin guardar.')
                        : tx('All changes saved.', 'Todos los cambios guardados.')}
                </div>
                <button onClick={onSave} disabled={!dirty || saving}
                    className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-bold flex items-center gap-1.5 transition disabled:opacity-40">
                    <Save size={14} strokeWidth={2.5} />
                    {saving ? tx('Saving…', 'Guardando…') : tx('Save build sheet', 'Guardar')}
                </button>
            </div>
            {editing && (
                <BuildRowEditModal
                    row={editing}
                    isNew={!!editing._isNew}
                    onSubmit={commitEdit}
                    onCancel={() => setEditing(null)}
                    language={language}
                />
            )}
            {confirming && (
                <ConfirmModal {...confirming} onClose={() => setConfirming(null)} language={language} />
            )}
        </div>
    );
}

function BuildRowEditModal({ row, isNew, onSubmit, onCancel, language }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const [draft, setDraft] = useState(row);
    const upd = (patch) => setDraft(prev => ({ ...prev, ...patch }));
    const setTopping = (i, key, val) => {
        const next = [...(draft.standardToppings || [])];
        next[i] = { ...next[i], [key]: val };
        upd({ standardToppings: next });
    };
    const addTopping = () => upd({ standardToppings: [...(draft.standardToppings || []), { en: '', es: '' }] });
    const removeTopping = (i) => upd({ standardToppings: (draft.standardToppings || []).filter((_, idx) => idx !== i) });

    const setNote = (i, key, val) => {
        const next = [...(draft.notes || [])];
        next[i] = { ...next[i], [key]: val };
        upd({ notes: next });
    };
    const addNote = () => upd({ notes: [...(draft.notes || []), { en: '', es: '' }] });
    const removeNote = (i) => upd({ notes: (draft.notes || []).filter((_, idx) => idx !== i) });

    const handleSubmit = () => {
        if (!draft.nameEn || !draft.nameEn.trim()) {
            toast(tx('Name (English) is required.', 'El nombre (inglés) es obligatorio.'));
            return;
        }
        // Clean empties.
        const standardToppings = (draft.standardToppings || []).filter(t => (t.en || '').trim() || (t.es || '').trim());
        const notes = (draft.notes || []).filter(n => (n.en || '').trim() || (n.es || '').trim());
        onSubmit({ ...draft, standardToppings, notes, nameEn: draft.nameEn.trim() });
    };

    return (
        <ModalPortal>
            <div className="fixed inset-0 z-[60] bg-black/50 flex items-end md:items-center justify-center p-3"
                onClick={onCancel} role="dialog" aria-modal="true">
                <div className="bg-white w-full md:max-w-3xl md:rounded-2xl rounded-t-2xl shadow-xl max-h-[92vh] flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                    style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                    <header className="px-4 py-3 border-b border-dd-line bg-dd-sage-50 flex items-center justify-between">
                        <div>
                            <h3 className="text-base font-black text-dd-text">
                                {isNew ? tx('New row', 'Nueva fila') : tx('Edit row', 'Editar fila')}
                            </h3>
                            <p className="text-[10px] text-dd-text-2 font-mono mt-0.5">id: {draft.id}</p>
                        </div>
                        <button onClick={onCancel} className="w-9 h-9 rounded-full hover:bg-white/60 flex items-center justify-center text-dd-text-2">
                            <X size={16} strokeWidth={2.5} />
                        </button>
                    </header>
                    <div className="p-4 overflow-y-auto flex-1 min-h-0 space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <Field label={tx('Name (EN)', 'Nombre (EN)')}
                                value={draft.nameEn} onChange={(v) => upd({ nameEn: v })} />
                            <Field label={tx('Name (ES)', 'Nombre (ES)')}
                                value={draft.nameEs} onChange={(v) => upd({ nameEs: v })} />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <Field label={tx('Base (EN)', 'Base (EN)')}
                                value={draft.baseEn} onChange={(v) => upd({ baseEn: v })}
                                placeholder="rice noodle base" />
                            <Field label={tx('Base (ES)', 'Base (ES)')}
                                value={draft.baseEs} onChange={(v) => upd({ baseEs: v })}
                                placeholder="base de fideos de arroz" />
                        </div>
                        {/* Toppings */}
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                                    {tx('Standard toppings', 'Toppings estándar')}
                                </div>
                                <button onClick={addTopping}
                                    className="px-2 py-1 rounded bg-emerald-100 text-emerald-700 text-[11px] font-bold hover:bg-emerald-200 transition flex items-center gap-1">
                                    <Plus size={12} strokeWidth={2.5} /> {tx('Add', 'Agregar')}
                                </button>
                            </div>
                            <div className="space-y-1.5">
                                {(draft.standardToppings || []).map((t, i) => (
                                    <div key={i} className="flex items-center gap-1.5">
                                        <input value={t.en || ''} onChange={(e) => setTopping(i, 'en', e.target.value)}
                                            placeholder="EN" className="flex-1 px-2 py-1 rounded border border-dd-line text-sm" />
                                        <input value={t.es || ''} onChange={(e) => setTopping(i, 'es', e.target.value)}
                                            placeholder="ES" className="flex-1 px-2 py-1 rounded border border-dd-line text-sm" />
                                        <button onClick={() => removeTopping(i)}
                                            className="w-8 h-8 rounded text-red-600 hover:bg-red-50 flex items-center justify-center">
                                            <X size={14} strokeWidth={2.5} />
                                        </button>
                                    </div>
                                ))}
                                {(draft.standardToppings || []).length === 0 && (
                                    <div className="text-[11px] text-dd-text-2 italic">{tx('No toppings yet.', 'Sin toppings.')}</div>
                                )}
                            </div>
                        </div>
                        {/* Notes */}
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                                    {tx('Notes', 'Notas')}
                                </div>
                                <button onClick={addNote}
                                    className="px-2 py-1 rounded bg-emerald-100 text-emerald-700 text-[11px] font-bold hover:bg-emerald-200 transition flex items-center gap-1">
                                    <Plus size={12} strokeWidth={2.5} /> {tx('Add', 'Agregar')}
                                </button>
                            </div>
                            <div className="space-y-1.5">
                                {(draft.notes || []).map((n, i) => (
                                    <div key={i} className="flex items-start gap-1.5">
                                        <textarea value={n.en || ''} onChange={(e) => setNote(i, 'en', e.target.value)}
                                            placeholder="EN" rows={2}
                                            className="flex-1 px-2 py-1 rounded border border-dd-line text-sm" />
                                        <textarea value={n.es || ''} onChange={(e) => setNote(i, 'es', e.target.value)}
                                            placeholder="ES" rows={2}
                                            className="flex-1 px-2 py-1 rounded border border-dd-line text-sm" />
                                        <button onClick={() => removeNote(i)}
                                            className="w-8 h-8 rounded text-red-600 hover:bg-red-50 flex items-center justify-center mt-1">
                                            <X size={14} strokeWidth={2.5} />
                                        </button>
                                    </div>
                                ))}
                                {(draft.notes || []).length === 0 && (
                                    <div className="text-[11px] text-dd-text-2 italic">{tx('No notes yet.', 'Sin notas.')}</div>
                                )}
                            </div>
                        </div>
                        {/* piecesByProtein (raw JSON for now; cleaner editor in a follow-up) */}
                        <div>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                {tx('Pieces by protein (JSON)', 'Piezas por proteína (JSON)')}
                            </div>
                            <textarea
                                value={JSON.stringify(draft.piecesByProtein || {}, null, 2)}
                                onChange={(e) => {
                                    try { upd({ piecesByProtein: JSON.parse(e.target.value || '{}') }); } catch { /* keep typing */ }
                                }}
                                rows={3}
                                className="w-full px-2 py-1.5 rounded-lg border border-dd-line bg-white text-xs font-mono focus:border-emerald-500 focus:outline-none"
                                placeholder='{"shrimp": 8}' />
                            <p className="text-[10px] text-dd-text-2 mt-0.5">
                                {tx('Optional. e.g. {"shrimp": 8, "shrimp (combo)": 2}', 'Opcional. ej. {"shrimp": 8, "shrimp (combo)": 2}')}
                            </p>
                        </div>
                    </div>
                    <footer className="px-4 py-3 border-t border-dd-line bg-dd-bg/40 flex items-center justify-end gap-2">
                        <button onClick={onCancel}
                            className="px-3 py-2 rounded-lg bg-white border border-dd-line text-sm font-bold text-dd-text hover:bg-dd-bg transition">
                            {tx('Cancel', 'Cancelar')}
                        </button>
                        <button onClick={handleSubmit}
                            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-bold transition">
                            {isNew ? tx('Add row', 'Agregar') : tx('Save', 'Guardar')}
                        </button>
                    </footer>
                </div>
            </div>
        </ModalPortal>
    );
}
