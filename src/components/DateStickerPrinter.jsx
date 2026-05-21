// DateStickerPrinter — pick a menu item, drill into its build,
// print a date sticker for any component.
//
// Andrew 2026-05-20 — "Add a print tab to the home page workspace
// list under the operations tab. Build a Date Sticker Printer page
// in my restaurant staff app. Staff should search/select a menu item,
// prep item, sauce, protein, drink, dessert, or batch recipe, and
// the app should generate the correct date sticker label."
//
// Phase 1 scope (this build):
//   ✓ Browse all menu items grouped by category
//   ✓ Search bar (accent-insensitive bilingual)
//   ✓ Tap an item → drawer shows full build (base / toppings /
//     proteins / sauces / notes), allergens carried through
//   ✓ 🏷 Print button on every component → opens PrintLabelModal in
//     editable mode with the component name + allergens pre-filled
//   ✓ Bilingual EN/ES throughout
//   ✓ Mobile-first; works on tablet + desktop
//
// Phase 2 (queued, not built):
//   - Recursive getFullItemBuild() that follows sauce → recipe →
//     ingredients → inventory items
//   - Shelf-life Firestore registry at /config/shelf_life/{itemId}
//   - "Manager review required" badge when shelf-life missing
//   - Editable build sheet (add/edit/delete components in-app)
//   - Print history dashboard filtered to this surface

import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import {
    getAllMenuItems, getMenuItemBuild,
    getSearchableIndex, getAiSearchItems,
    findSubRecipe,
    getAllCategoryComponents,
    getGlobalComponentSections,
    COMPONENT_KIND_TONE,
} from '../data/itemBuild';
import { normalize, expandQueryTermsTight, haystackMatches } from '../data/chatSearch';
import { useAiSearch } from '../data/aiSearch';
import { isAdmin } from '../data/staff';
import { subscribeAllBuildOverrides, applyBuildOverride } from '../data/buildOverrides';
import { subscribeAllCustomItems } from '../data/customItems';

const PrintLabelModal = lazy(() => import('./PrintLabelModal'));
const BuildEditorModal = lazy(() => import('./BuildEditorModal'));
const PrintCenter = lazy(() => import('./PrintCenter'));

export default function DateStickerPrinter({
    language = 'en',
    staffName,
    storeLocation,
    staffList = [],
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const adminUser = isAdmin(staffName, staffList);

    const [search, setSearch] = useState('');
    const [openItemId, setOpenItemId] = useState(null);
    // What we hand to PrintLabelModal — a recipe-shaped object so the
    // existing modal renders it without modification.
    const [printingComponent, setPrintingComponent] = useState(null);
    // AI toggle. ON by default — substring runs locally for instant
    // feedback, AI adds semantic matches ~300ms later. Flip off if
    // the AI is slow / unavailable.
    const [aiOn, setAiOn] = useState(true);
    // Admin-only build editor state. When set to a menu item, the
    // BuildEditorModal opens to edit that item's components.
    const [editingItem, setEditingItem] = useState(null);
    // Live override map keyed by menuItemSlug. Subscribed once,
    // applied to every resolved build before render. Edits made by
    // any admin (on any device) propagate live.
    const [overrides, setOverrides] = useState(new Map());
    useEffect(() => {
        return subscribeAllBuildOverrides(setOverrides);
    }, []);
    // Live custom items — admin-created, not in menu.js. Each carries
    // its own build inline. Subscribed once; merged into the search
    // index + browse view alongside menu items.
    const [customItems, setCustomItems] = useState([]);
    useEffect(() => {
        return subscribeAllCustomItems(setCustomItems);
    }, []);

    // Menu items from the static menu.js PLUS any admin-created
    // custom items. Custom items get a synthesized shape that the
    // existing renderers / build resolver treat as menu items.
    const allItems = useMemo(() => {
        const base = getAllMenuItems();
        const customAsItems = customItems.map(ci => ({
            id: ci.slug,
            nameEn: ci.nameEn,
            nameEs: ci.nameEs,
            category: ci.category || 'Custom',
            categoryEs: ci.categoryEs || ci.category || 'Personalizado',
            allergens: ci.allergens || '',
            isCustom: true,
        }));
        return [...base, ...customAsItems];
    }, [customItems]);

    // Flat searchable index: every menu item + every deduped
    // component (with usedIn list). For custom items we also push
    // their components into the index so the search reaches them.
    const searchIndex = useMemo(() => {
        const base = getSearchableIndex();
        for (const ci of customItems) {
            base.push({
                id: `mi::${ci.slug}`,
                kind: 'menuItem',
                menuItemId: ci.slug,
                nameEn: ci.nameEn,
                nameEs: ci.nameEs,
                category: ci.category,
                categoryEs: ci.categoryEs,
                allergens: ci.allergens || '',
                isCustom: true,
                usedIn: [],
            });
            for (const c of (ci.components || [])) {
                base.push({
                    id: `cpcustom::${ci.slug}::${c.id}`,
                    kind: 'component',
                    componentKind: c.kind,
                    nameEn: c.nameEn,
                    nameEs: c.nameEs,
                    descEn: c.descEn || '',
                    descEs: c.descEs || '',
                    usedIn: [ci.nameEn],
                    usedInEs: [ci.nameEs || ci.nameEn],
                });
            }
        }
        return base;
    }, [customItems]);

    // AI items mirror the index — synthesized for custom items too.
    const aiItems = useMemo(() => {
        const base = getAiSearchItems();
        for (const ci of customItems) {
            base.push({
                id: `mi::${ci.slug}`,
                name: ci.nameEn,
                category: ci.category || 'Custom',
                subcat: [ci.allergens || ''].filter(Boolean).join(' | ').slice(0, 180),
            });
            for (const c of (ci.components || [])) {
                base.push({
                    id: `cpcustom::${ci.slug}::${c.id}`,
                    name: c.nameEn,
                    category: COMPONENT_KIND_TONE[c.kind]?.labelEn || c.kind,
                    subcat: ci.nameEn,
                });
            }
        }
        return base;
    }, [customItems]);

    const queryTokens = useMemo(() => expandQueryTermsTight(search), [search]);
    const hasQuery = queryTokens.length > 0;

    // AI hook — MUST sit above any conditional return (the React #300
    // hooks-after-early-return lesson from Recipes still applies).
    const {
        loading: aiLoading,
        matchingIds: aiIds,
        error: aiError,
    } = useAiSearch({
        query: search,
        items: aiItems,
        enabled: aiOn && hasQuery,
    });
    const aiIdSet = useMemo(() => (aiIds ? new Set(aiIds) : null), [aiIds]);

    // Substring matcher on the flat index. For each row we build a
    // haystack from its name (EN+ES), category, description, and —
    // for components — its `usedIn` list. So typing "pho" matches
    // every component whose parents include a pho dish.
    const rowMatchesSubstring = (row) => {
        if (!hasQuery) return true;
        const hayParts = [
            row.nameEn, row.nameEs,
            row.descEn, row.descEs,
            row.category, row.categoryEs,
            row.allergens || '',
            (row.usedIn || []).join(' '),
            (row.usedInEs || []).join(' '),
            row.componentKind || '',
        ];
        const hay = normalize(hayParts.filter(Boolean).join(' '));
        return haystackMatches(hay, queryTokens);
    };
    // Final per-row match — substring OR AI semantic match.
    const rowMatches = (row) => {
        if (!hasQuery) return true;
        if (rowMatchesSubstring(row)) return true;
        return aiIdSet ? aiIdSet.has(row.id) : false;
    };

    // Two display modes:
    //   • No query → grouped browse view (menu items by category).
    //   • Has query → flat results: menu items + components mixed,
    //     ordered by kind (menu items first, then components).
    const filteredItems = useMemo(() => {
        if (hasQuery) return [];
        return allItems;
    }, [allItems, hasQuery]);

    const flatResults = useMemo(() => {
        if (!hasQuery) return [];
        const items = [];
        const components = [];
        for (const row of searchIndex) {
            if (!rowMatches(row)) continue;
            if (row.kind === 'menuItem') items.push(row);
            else components.push(row);
        }
        return { items, components };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchIndex, hasQuery, queryTokens, aiIdSet]);

    // Browse grouping (no-query view) — by category.
    const grouped = useMemo(() => {
        const m = new Map();
        for (const item of filteredItems) {
            const key = item.category;
            if (!m.has(key)) m.set(key, { categoryEn: item.category, categoryEs: item.categoryEs, items: [] });
            m.get(key).items.push(item);
        }
        return Array.from(m.values());
    }, [filteredItems]);

    // Andrew 2026-05-20: "but bowls, sliders and rolls, tacos, all
    // share the same protiens". Refactored to surface PROTEINS and
    // SAUCES once at the top (shared across all dishes) and only
    // show category-specific components (bases, toppings, garnishes)
    // inside each category card. The kitchen preps ONE batch of
    // pork that serves bowls + banh mi + sliders + tacos; one sticker
    // for the pot, not four duplicates.
    const sections = useMemo(() => getGlobalComponentSections(), []);

    // Open-item resolver — for the inline-expand on a row. Merges
    // any admin override on top of the static build. For custom
    // items, the build comes directly from the custom_items doc.
    const openBuild = useMemo(() => {
        if (!openItemId) return null;
        const item = allItems.find(i => i.id === openItemId);
        if (!item) return null;
        if (item.isCustom) {
            const ci = customItems.find(c => c.slug === item.id);
            if (!ci) return null;
            // Synthesize a build-shaped result. Notes go as 'note'
            // components so the renderer's existing note styling
            // works without modification.
            const noteComps = (ci.notes || []).map((n, i) => ({
                id: `note-${i}`,
                kind: 'note',
                nameEn: n.en,
                nameEs: n.es,
            }));
            return {
                menuItem: { ...ci, id: ci.slug, category: ci.category },
                components: [...(ci.components || []), ...noteComps],
                shelfLifeDays: ci.shelfLifeDays || null,
                isCustom: true,
                unresolved: [],
            };
        }
        const staticBuild = getMenuItemBuild(item.nameEn);
        const override = overrides.get(item.id) || null;
        return applyBuildOverride(staticBuild, override);
    }, [openItemId, allItems, overrides, customItems]);

    // 🆕 New custom item button state.
    const [newItemModal, setNewItemModal] = useState(false);
    // 🖨 Custom on-the-spot print modal (PrintCenter). Andrew
    // 2026-05-20: "add a custom print button so we can make custom
    // stickers on the spot".
    const [customPrintOpen, setCustomPrintOpen] = useState(false);

    // Handler: take a component (from the build), synthesize a
    // recipe-shaped object, and hand to PrintLabelModal in editable
    // mode. Allergens carry over from the menu item. Shelf-life
    // override (if set on the menu item) propagates so the modal's
    // slider default is the admin-set value, not the category fallback.
    const handlePrintComponent = (component, menuItem) => {
        if (component.kind === 'note') return;
        const allergenStr = component.allergens || menuItem?.allergens || '';
        const allergens = parseAllergenString(allergenStr);
        // Pull shelf-life from open build (custom items + overrides
        // already merge it onto the build object).
        const shelfFromBuild = openBuild?.shelfLifeDays;
        setPrintingComponent({
            titleEn: component.nameEn,
            titleEs: component.nameEs || component.nameEn,
            allergens,
            ingredientsEn: [],
            ingredientsEs: [],
            category: KIND_TO_CATEGORY[component.kind] || 'Other',
            ...(shelfFromBuild ? { shelfLifeDays: shelfFromBuild } : {}),
        });
    };

    return (
        <div className="p-4 pb-bottom-nav">
            <div className="max-w-3xl mx-auto">
                {/* Header */}
                <div className="flex items-center gap-3 mb-3">
                    <span className="text-3xl">🏷</span>
                    <div>
                        <h1 className="text-xl font-black text-dd-text">
                            {tx('Date Stickers', 'Etiquetas de Fecha')}
                        </h1>
                        <p className="text-xs text-dd-text-2">
                            {tx(
                                'Pick a menu item, see its build, print a sticker for any component.',
                                'Elige un platillo, ve su composición, imprime una etiqueta por componente.',
                            )}
                        </p>
                    </div>
                </div>

                {/* Search + AI toggle */}
                <div className="flex items-center gap-2 mb-2">
                    <div className="relative flex-1">
                        <input
                            type="search"
                            inputMode="search"
                            enterKeyHint="search"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={aiOn
                                ? tx(
                                    '🔍 Search anything — "pho" finds pho + rare steak + brisket…',
                                    '🔍 Buscar — "pho" trae pho + bistec + pecho…',
                                )
                                : tx(
                                    '🔍 Search menu + components ("pho", "wings", "cilantro")…',
                                    '🔍 Buscar menú y componentes…',
                                )}
                            className="w-full pl-9 pr-9 py-2.5 border-2 border-purple-200 rounded-xl text-sm font-bold bg-white focus:outline-none focus:border-purple-400 placeholder:font-normal placeholder:text-purple-400 shadow-sm"
                        />
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-purple-400 pointer-events-none">🔍</span>
                        {search && (
                            <button onClick={() => setSearch('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-purple-100 text-purple-700 text-xs font-bold flex items-center justify-center hover:bg-purple-200">
                                ✕
                            </button>
                        )}
                    </div>
                    {/* ✨ AI toggle — flips between substring-only and
                        substring ∪ Claude semantic match. Same pattern
                        Recipes / Operations use. ON by default. */}
                    <button onClick={() => setAiOn(v => !v)}
                        title={aiOn
                            ? tx('AI search ON — tap to use plain search', 'IA activada — toca para apagar')
                            : tx('Plain search — tap to enable AI', 'Búsqueda básica — toca para activar IA')}
                        className={`flex-shrink-0 px-3 py-2.5 rounded-xl text-sm font-bold border-2 transition ${aiOn
                            ? 'bg-purple-600 text-white border-purple-700'
                            : 'bg-white text-purple-600 border-purple-200 hover:bg-purple-50'}`}>
                        ✨ {tx('AI', 'IA')}
                    </button>
                </div>

                {/* Action row — Custom Print (everyone) +
                    New custom item (admin-only). */}
                <div className="flex gap-2 mb-2">
                    <button onClick={() => setCustomPrintOpen(true)}
                        className="flex-1 py-2.5 rounded-lg bg-purple-600 text-white text-sm font-bold hover:bg-purple-700 active:scale-95 transition shadow-sm">
                        🖨 {tx('Custom print (any text)', 'Imprimir personalizado')}
                    </button>
                    {adminUser && (
                        <button onClick={() => setNewItemModal(true)}
                            className="flex-1 py-2.5 rounded-lg border-2 border-dashed border-purple-300 text-purple-700 hover:bg-purple-50 font-bold text-sm">
                            🆕 {tx('New custom item', 'Nuevo artículo')}
                        </button>
                    )}
                </div>

                {/* AI status strip — shows during a query */}
                {hasQuery && aiOn && (
                    <div className="text-[11px] mb-2 pl-1 min-h-[14px]">
                        {aiLoading && (
                            <span className="text-purple-700 font-bold">✨ {tx('thinking…', 'pensando…')}</span>
                        )}
                        {!aiLoading && aiError && (
                            <span className="text-amber-700">⚠ {tx('AI unavailable — showing plain matches', 'IA no disponible — coincidencias básicas')}</span>
                        )}
                        {!aiLoading && !aiError && aiIds && aiIds.length > 0 && (
                            <span className="text-purple-700 font-bold">✨ {tx(`AI added ${aiIds.length} semantic matches`, `IA añadió ${aiIds.length} coincidencias`)}</span>
                        )}
                    </div>
                )}

                {/* Hit count */}
                {hasQuery && (
                    <p className="text-[11px] text-purple-800 mb-2 font-bold pl-1">
                        {flatResults.items.length} {tx(
                            `menu item${flatResults.items.length === 1 ? '' : 's'}`,
                            `platillo${flatResults.items.length === 1 ? '' : 's'}`,
                        )}
                        {' · '}
                        {flatResults.components.length} {tx(
                            `component${flatResults.components.length === 1 ? '' : 's'}`,
                            `componente${flatResults.components.length === 1 ? '' : 's'}`,
                        )}
                    </p>
                )}

                {/* Two render modes: flat results when searching,
                    grouped browse view when idle. */}
                {hasQuery ? (
                    flatResults.items.length === 0 && flatResults.components.length === 0 ? (
                        <p className="text-sm text-dd-text-2 italic text-center py-12">
                            {tx('Nothing matches that search.', 'Sin coincidencias.')}
                        </p>
                    ) : (
                        <div className="space-y-4">
                            {flatResults.items.length > 0 && (
                                <section>
                                    <h2 className="text-[11px] font-black uppercase tracking-widest text-dd-text-2 mb-1.5 pl-1">
                                        🍽 {tx('Menu items', 'Platillos')}
                                    </h2>
                                    <div className="space-y-1.5">
                                        {flatResults.items.map(item => (
                                            <MenuItemRow
                                                key={item.id}
                                                item={{ ...item, id: item.menuItemId, nameEn: item.nameEn, nameEs: item.nameEs }}
                                                isOpen={openItemId === item.menuItemId}
                                                onToggle={() => setOpenItemId(prev => prev === item.menuItemId ? null : item.menuItemId)}
                                                isEs={isEs}
                                                tx={tx}
                                                build={openItemId === item.menuItemId ? openBuild : null}
                                                onPrintComponent={handlePrintComponent}
                                                adminUser={adminUser}
                                                onEdit={() => setEditingItem({ id: item.menuItemId, nameEn: item.nameEn, nameEs: item.nameEs })}
                                                hasOverride={overrides.has(item.menuItemId)}
                                            />
                                        ))}
                                    </div>
                                </section>
                            )}
                            {flatResults.components.length > 0 && (
                                <section>
                                    <h2 className="text-[11px] font-black uppercase tracking-widest text-dd-text-2 mb-1.5 pl-1">
                                        🧩 {tx('Components & ingredients', 'Componentes e ingredientes')}
                                    </h2>
                                    <div className="space-y-1.5">
                                        {flatResults.components.map(c => (
                                            <ComponentSearchResult
                                                key={c.id}
                                                component={c}
                                                isEs={isEs}
                                                tx={tx}
                                                onPrint={() => handlePrintComponent({
                                                    kind: c.componentKind,
                                                    nameEn: c.nameEn,
                                                    nameEs: c.nameEs,
                                                    descEn: c.descEn,
                                                    descEs: c.descEs,
                                                }, null)}
                                            />
                                        ))}
                                    </div>
                                </section>
                            )}
                        </div>
                    )
                ) : (
                    // Idle / browse view — shared sections (proteins,
                    // sauces) at top with a "shared across all dishes"
                    // hint, then per-category cards with only the
                    // category-specific components below.
                    <div className="space-y-5">
                        {/* Shared sections — proteins + sauces */}
                        {Array.isArray(sections.shared?.protein) && sections.shared.protein.length > 0 && (
                            <SharedSection
                                kind="protein"
                                items={sections.shared.protein}
                                isEs={isEs}
                                tx={tx}
                                onPrint={(c) => handlePrintComponent(c, null)} />
                        )}
                        {Array.isArray(sections.shared?.sauce) && sections.shared.sauce.length > 0 && (
                            <SharedSection
                                kind="sauce"
                                items={sections.shared.sauce}
                                isEs={isEs}
                                tx={tx}
                                onPrint={(c) => handlePrintComponent(c, null)} />
                        )}

                        {/* Per-category sections — only category-specific
                            components (bases, toppings, garnishes, etc.) */}
                        {sections.categories.map(catBuild => {
                            const KIND_ORDER = ['base', 'broth', 'topping', 'garnish', 'side', 'item', 'note'];
                            const flat = [];
                            for (const k of KIND_ORDER) {
                                if (Array.isArray(catBuild.byKind[k])) {
                                    flat.push(...catBuild.byKind[k]);
                                }
                            }
                            if (flat.length === 0) return null;
                            const printableCount = flat.filter(c => c.kind !== 'note').length;
                            return (
                                <section key={catBuild.category}
                                    className="bg-white border border-dd-line rounded-xl p-3">
                                    <div className="flex items-center gap-2 mb-2 pl-0.5">
                                        <h2 className="text-sm font-black uppercase tracking-widest text-dd-text">
                                            {isEs ? (catBuild.categoryEs || catBuild.category) : catBuild.category}
                                        </h2>
                                        <span className="text-[10px] font-bold text-dd-text-2/60">
                                            · {printableCount} {tx('printable', 'imprimibles')}
                                        </span>
                                    </div>
                                    <ComponentList
                                        components={flat}
                                        isEs={isEs}
                                        tx={tx}
                                        onPrint={(c) => handlePrintComponent(c, null)}
                                    />
                                </section>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Print modal — same one Recipes + Operations use,
                editable mode so the cook can adjust the title or
                allergens before printing. */}
            {printingComponent && (
                <Suspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                    <PrintLabelModal
                        editable={true}
                        recipe={printingComponent}
                        location={storeLocation}
                        staffName={staffName}
                        language={language}
                        source="datestickers"
                        onClose={() => setPrintingComponent(null)}
                    />
                </Suspense>
            )}

            {/* Build editor — admin-only. Opens with the current
                build (static + any existing override). Custom items
                save to /custom_items; regular menu items save to
                /build_overrides. Live subscription above refreshes. */}
            {editingItem && (
                <Suspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                    <BuildEditorModal
                        menuItem={editingItem}
                        initialComponents={(() => {
                            if (editingItem.isCustom) {
                                const ci = customItems.find(c => c.slug === editingItem.id);
                                return (ci?.components || []);
                            }
                            const base = getMenuItemBuild(editingItem.nameEn);
                            const ov = overrides.get(editingItem.id) || null;
                            const merged = applyBuildOverride(base, ov);
                            return (merged?.components || []).filter(c => c.kind !== 'note');
                        })()}
                        initialNotes={(() => {
                            if (editingItem.isCustom) {
                                const ci = customItems.find(c => c.slug === editingItem.id);
                                return ci?.notes || [];
                            }
                            const ov = overrides.get(editingItem.id);
                            return ov?.notes || [];
                        })()}
                        initialShelfLifeDays={(() => {
                            if (editingItem.isCustom) {
                                const ci = customItems.find(c => c.slug === editingItem.id);
                                return ci?.shelfLifeDays || null;
                            }
                            return overrides.get(editingItem.id)?.shelfLifeDays || null;
                        })()}
                        isCustom={editingItem.isCustom === true}
                        staffName={staffName}
                        language={language}
                        onClose={() => setEditingItem(null)}
                        onSaved={() => { /* live subscription refreshes the view */ }}
                    />
                </Suspense>
            )}

            {/* 🖨 Custom Print — on-the-spot free-form sticker
                (Word-style composer). Uses the same PrintCenter
                modal home + Operations already use. */}
            {customPrintOpen && (
                <Suspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                    <PrintCenter
                        location={storeLocation}
                        staffName={staffName}
                        language={language}
                        isAdmin={adminUser}
                        onClose={() => setCustomPrintOpen(false)}
                    />
                </Suspense>
            )}

            {/* New custom item modal — admin-only. Opens with an
                empty form; on save writes a new /custom_items doc. */}
            {newItemModal && (
                <Suspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                    <BuildEditorModal
                        menuItem={{ id: '', nameEn: '', nameEs: '', category: 'Custom', allergens: '' }}
                        initialComponents={[]}
                        initialNotes={[]}
                        initialShelfLifeDays={null}
                        isCustom={true}
                        isNew={true}
                        staffName={staffName}
                        language={language}
                        onClose={() => setNewItemModal(false)}
                        onSaved={() => { /* live subscription refreshes the view */ }}
                    />
                </Suspense>
            )}
        </div>
    );
}

// ── MenuItemRow ────────────────────────────────────────────────────
function MenuItemRow({ item, isOpen, onToggle, isEs, tx, build, onPrintComponent, adminUser = false, onEdit, hasOverride = false }) {
    const allergens = parseAllergenString(item.allergens || '');
    return (
        <div className={`bg-white border-2 rounded-xl overflow-hidden ${isOpen ? 'border-purple-300 shadow-md' : 'border-dd-line'}`}>
            {/* Collapsed header — toggle for everyone; admin gets an
                additional Edit pencil pill (gated by adminUser). */}
            <div className="flex items-center">
                <button onClick={onToggle}
                    className="flex-1 min-w-0 text-left px-3 py-2.5 flex items-center gap-2 hover:bg-purple-50/40 transition">
                    <span className={`flex-1 min-w-0 text-sm font-bold text-dd-text truncate`}>
                        {isEs ? (item.nameEs || item.nameEn) : item.nameEn}
                    </span>
                    {hasOverride && (
                        <span className="flex-shrink-0 text-[10px] font-bold text-purple-700 bg-purple-100 border border-purple-200 px-1.5 py-0.5 rounded-full">
                            ✏ {tx('CUSTOM', 'CUSTOM')}
                        </span>
                    )}
                    {allergens.length > 0 && (
                        <span className="flex-shrink-0 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                            ⚠ {allergens.length}
                        </span>
                    )}
                    <span className={`flex-shrink-0 text-purple-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}>▼</span>
                </button>
                {adminUser && (
                    <button onClick={(e) => { e.stopPropagation(); onEdit?.(); }}
                        title={tx('Edit build (admin)', 'Editar (admin)')}
                        className="flex-shrink-0 m-1.5 px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-800 text-[11px] font-bold hover:bg-amber-100 active:scale-95 transition">
                        ✏️ {tx('Edit', 'Editar')}
                    </button>
                )}
            </div>

            {/* Expanded build view */}
            {isOpen && build && (
                <div className="border-t border-purple-200 bg-purple-50/30 p-3">
                    {/* Allergen banner */}
                    {item.allergens && (
                        <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-amber-900 mb-0.5">
                                ⚠ {tx('Allergens', 'Alérgenos')}
                            </div>
                            <div className="text-[12px] text-amber-900">
                                {item.allergens}
                            </div>
                        </div>
                    )}

                    {build.components.length === 0 ? (
                        <p className="text-xs text-dd-text-2 italic">
                            {tx('No build sheet for this item yet.', 'Sin composición registrada.')}
                        </p>
                    ) : (
                        <ComponentList
                            components={build.components}
                            isEs={isEs}
                            tx={tx}
                            onPrint={(c) => onPrintComponent(c, item)}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

// ── ComponentList ──────────────────────────────────────────────────
// Renders the components grouped by kind (base / topping / etc.) with
// a 🏷 Print button on every printable component. Notes show but have
// no Print button (they're guidance, not items).
// ── SharedSection ─────────────────────────────────────────────
// Andrew 2026-05-20: "but bowls, sliders and rolls, tacos, all
// share the same protiens". Renders one card per shared kind
// (proteins or sauces) at the top of the browse view. Each row
// shows the component name + chips for the categories that use it
// ("used in: Bowls · Bánh Mì · Tacos") so the cook knows one
// batch covers multiple dishes.
function SharedSection({ kind, items, isEs, tx, onPrint }) {
    const tone = COMPONENT_KIND_TONE[kind] || COMPONENT_KIND_TONE.side;
    const headerEn = kind === 'protein' ? 'Proteins (shared across dishes)'
        : kind === 'sauce' ? 'Sauces (shared across dishes)'
        : (tone.labelEn + ' (shared)');
    const headerEs = kind === 'protein' ? 'Proteínas (compartidas)'
        : kind === 'sauce' ? 'Salsas (compartidas)'
        : (tone.labelEs + ' (compartidas)');
    return (
        <section className="bg-emerald-50/40 border border-emerald-200 rounded-xl p-3">
            <div className="flex items-center gap-2 mb-2 pl-0.5">
                <span className="text-base">{tone.icon}</span>
                <h2 className="text-sm font-black uppercase tracking-widest text-emerald-900">
                    {isEs ? headerEs : headerEn}
                </h2>
                <span className="text-[10px] font-bold text-emerald-700/70">
                    · {items.length}
                </span>
            </div>
            <div className="space-y-1 pl-1">
                {items.map(c => (
                    <SharedComponentRow key={c.id}
                        component={c}
                        tone={tone}
                        isEs={isEs}
                        tx={tx}
                        onPrint={onPrint} />
                ))}
            </div>
        </section>
    );
}

function SharedComponentRow({ component, tone, isEs, tx, onPrint }) {
    const name = isEs ? (component.nameEs || component.nameEn) : component.nameEn;
    const cats = Array.isArray(component.usedInCategories) ? component.usedInCategories : [];
    return (
        <div className="flex items-center gap-2 bg-white border border-dd-line rounded-lg px-2.5 py-1.5">
            <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-dd-text">{name}</div>
                {cats.length > 0 && (
                    <div className="text-[10px] text-dd-text-2 mt-0.5 truncate">
                        {tx('Used in', 'Se usa en')}: {cats.join(' · ')}
                    </div>
                )}
            </div>
            <button onClick={() => onPrint(component)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-bold ${tone.btnClass || 'bg-dd-green text-white hover:bg-dd-green-700'} transition`}>
                🏷
            </button>
        </div>
    );
}

function ComponentList({ components, isEs, tx, onPrint }) {
    // Group by kind preserving first-seen order.
    const byKind = new Map();
    for (const c of components) {
        if (!byKind.has(c.kind)) byKind.set(c.kind, []);
        byKind.get(c.kind).push(c);
    }

    return (
        <div className="space-y-2.5">
            {Array.from(byKind.entries()).map(([kind, items]) => {
                const tone = COMPONENT_KIND_TONE[kind] || COMPONENT_KIND_TONE.side;
                return (
                    <div key={kind}>
                        <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-base">{tone.icon}</span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-dd-text-2">
                                {isEs ? tone.labelEs : tone.labelEn}
                            </span>
                            <span className="text-[10px] text-dd-text-2/60">· {items.length}</span>
                        </div>
                        <div className="space-y-1 pl-1">
                            {items.map(c => (
                                <ComponentRow key={c.id}
                                    component={c}
                                    tone={tone}
                                    isEs={isEs}
                                    tx={tx}
                                    onPrint={onPrint}
                                />
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ── ComponentSearchResult ──────────────────────────────────────────
// A search-result row for a component (not a menu item). Shows the
// component name + a small "Used in:" chip listing the menu items
// that contain it, and a Print button that opens PrintLabelModal in
// editable mode pre-filled with the component name. Allergens come
// in blank — cook can add them via the modal's allergen chips if
// they apply.
function ComponentSearchResult({ component, isEs, tx, onPrint }) {
    const tone = COMPONENT_KIND_TONE[component.componentKind] || COMPONENT_KIND_TONE.side;
    const name = isEs ? (component.nameEs || component.nameEn) : component.nameEn;
    const usedIn = isEs ? component.usedInEs : component.usedIn;
    const usedInPreview = (usedIn || []).slice(0, 3);
    const usedInExtra = Math.max(0, (usedIn || []).length - 3);
    return (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${tone.bg} border border-dd-line`}>
            <span className="flex-shrink-0 text-lg">{tone.icon}</span>
            <div className="flex-1 min-w-0">
                <div className={`text-[14px] font-bold ${tone.text}`}>
                    {name}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                        {isEs ? tone.labelEs : tone.labelEn}
                    </span>
                    {usedInPreview.length > 0 && (
                        <span className="text-[10.5px] text-dd-text-2 truncate" title={(usedIn || []).join(' · ')}>
                            · {tx('in', 'en')} {usedInPreview.join(', ')}
                            {usedInExtra > 0 && ` +${usedInExtra}`}
                        </span>
                    )}
                </div>
            </div>
            <button onClick={onPrint}
                className="flex-shrink-0 px-2.5 py-1.5 rounded-lg bg-purple-600 text-white text-[11px] font-bold hover:bg-purple-700 active:scale-95 transition shadow-sm">
                🏷 {tx('Print', 'Imprimir')}
            </button>
        </div>
    );
}

function ComponentRow({ component, tone, isEs, tx, onPrint }) {
    const isNote = component.kind === 'note';
    const name = isEs ? (component.nameEs || component.nameEn) : component.nameEn;
    // Recursive sub-recipe expansion (Phase 2b): try to find a
    // matching recipe in MASTER_RECIPES. If found, the user can
    // expand the row to see ingredients and print labels for each.
    const [expanded, setExpanded] = useState(false);
    const subRecipe = useMemo(() => isNote ? null : findSubRecipe(component.nameEn), [component.nameEn, isNote]);
    return (
        <div className={`rounded-lg ${tone.bg} border border-dd-line`}>
            <div className="flex items-center gap-2 px-2.5 py-1.5">
                <div className="flex-1 min-w-0">
                    <div className={`text-[13px] ${isNote ? 'italic text-dd-text-2 leading-snug' : `font-bold ${tone.text}`}`}>
                        {name}
                        {subRecipe && (
                            <span className="ml-1.5 text-[9px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">
                                {tx(`+${subRecipe.ingredients.length} ingredients`, `+${subRecipe.ingredients.length} ingredientes`)}
                            </span>
                        )}
                    </div>
                    {component.descEn && !isNote && (
                        <div className="text-[10.5px] text-dd-text-2 truncate">
                            {isEs ? (component.descEs || component.descEn) : component.descEn}
                        </div>
                    )}
                    {component.variant && (
                        <div className="text-[10px] text-dd-text-2 italic">
                            {tx('style', 'estilo')}: {component.variant}
                        </div>
                    )}
                </div>
                {subRecipe && (
                    <button onClick={() => setExpanded(v => !v)}
                        title={tx('Show ingredients', 'Ver ingredientes')}
                        className="flex-shrink-0 px-2 py-1 rounded-lg bg-white border border-purple-300 text-purple-700 text-[11px] font-bold hover:bg-purple-50">
                        {expanded ? '▾' : '▸'}
                    </button>
                )}
                {!isNote && (
                    <button onClick={() => onPrint(component)}
                        title={tx('Print date sticker', 'Imprimir etiqueta')}
                        className="flex-shrink-0 px-2.5 py-1.5 rounded-lg bg-purple-600 text-white text-[11px] font-bold hover:bg-purple-700 active:scale-95 transition shadow-sm">
                        🏷 {tx('Print', 'Imprimir')}
                    </button>
                )}
            </div>
            {/* Nested ingredients from the matched sub-recipe */}
            {expanded && subRecipe && (
                <div className="border-t border-dd-line/50 px-2.5 py-2 space-y-1 bg-white/40">
                    <div className="text-[9.5px] font-bold uppercase tracking-wider text-purple-800 mb-1">
                        🧪 {tx(`Ingredients in ${component.nameEn}`, `Ingredientes en ${component.nameEn}`)}
                    </div>
                    {subRecipe.ingredients.map((ing, i) => (
                        <div key={i} className="flex items-center gap-2 px-1.5 py-1 rounded bg-white border border-dd-line/60">
                            <span className="flex-1 text-[12px] text-dd-text truncate">
                                {isEs ? (ing.nameEs || ing.nameEn) : ing.nameEn}
                            </span>
                            <button
                                onClick={() => onPrint({
                                    kind: 'topping',
                                    nameEn: ing.nameEn,
                                    nameEs: ing.nameEs,
                                })}
                                title={tx('Print sticker for this ingredient', 'Imprimir etiqueta')}
                                className="flex-shrink-0 px-2 py-1 rounded-lg bg-purple-600 text-white text-[10px] font-bold hover:bg-purple-700">
                                🏷 {tx('Print', 'Imprimir')}
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Helpers ────────────────────────────────────────────────────────
// Parse the menu.js allergens string (e.g. "Soy, Fish (vinaigrette).
// Optional peanut.") into the allergen code list our label printer
// understands. Forgiving — unrecognized words just don't get added.
function parseAllergenString(s) {
    if (!s) return [];
    const lower = String(s).toLowerCase();
    const map = {
        'milk':     'milk',     'dairy':    'milk',
        'egg':      'egg',      'eggs':     'egg',
        'fish':     'fish',     'salmon':   'fish',
        'shellfish':'shellfish','shrimp':   'shellfish','crab': 'shellfish',
        'soy':      'soy',
        'wheat':    'wheat',    'gluten':   'wheat',
        'peanut':   'peanut',   'peanuts':  'peanut',
        'tree nut': 'treenut',  'treenut':  'treenut',  'coconut': 'treenut',
        'sesame':   'sesame',
        'msg':      'msg',
    };
    const out = new Set();
    for (const [key, code] of Object.entries(map)) {
        if (lower.includes(key)) out.add(code);
    }
    return Array.from(out);
}

// Component kind → recipe category (used by PrintLabelModal's
// shelf-life defaults — Sauces=7d, Proteins=3d, etc.)
const KIND_TO_CATEGORY = Object.freeze({
    base:    'Prep',
    topping: 'Vegetables',
    protein: 'Proteins',
    sauce:   'Sauces & Dressings',
    broth:   'Stocks & Broths',
    side:    'Other',
    garnish: 'Vegetables',
});
