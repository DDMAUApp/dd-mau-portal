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

import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import {
    getAllMenuItems, getMenuItemBuild,
    getSearchableIndex, getAiSearchItems,
    findSubRecipe,
    COMPONENT_KIND_TONE,
} from '../data/itemBuild';
// Build sheet — Andrew 2026-05-20: "lets delete the current food
// items in the sticker tab and replace them with the build sheet in
// the menu tab. it makes more sense to use that only". The browse
// view below renders exactly the build-sheet structure the cashiers
// already learn from the laminated training pages (Menu tab → Build
// Sheet view). Single source of truth: any change to buildSheet.js
// updates both the cashier reference AND the sticker browse view.
import {
    BUILD_SHEET_BOWLS,
    BUILD_SHEET_HANDHELDS,
    BUILD_SHEET_FRIED_RICE,
    BUILD_SHEET_PHO,
} from '../data/buildSheet';
// Live-editable flat lists — Andrew 2026-05-20: "make the items all
// editable". The five flat sections (3 protein lists + sauces +
// snacks) now read from /config/sticker_lists with the hardcoded
// buildSheet.js arrays as defaults. Admin edits inline via the
// Edit Mode toggle.
import {
    subscribeStickerLists,
    saveStickerList,
    makeStickerRowId,
    STICKER_SECTIONS,
} from '../data/stickerListsOverride';
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

    // Editable flat lists (protein lists, sauces, snacks) — Andrew
    // 2026-05-20 "make the items all editable". `stickerLists` is
    // `{ bowlProteins, friedRiceProteins, phoProteins, sauces,
    // snacks }`, each an array of rows. Defaults come from
    // buildSheet.js; admin overrides live in /config/sticker_lists.
    const [stickerLists, setStickerLists] = useState(null);
    useEffect(() => {
        return subscribeStickerLists(setStickerLists);
    }, []);
    // Edit Mode — admin-only. When ON, each row in the flat sections
    // becomes an editable form with delete + add-row buttons. Off
    // by default so the normal print-a-sticker flow stays clean.
    const [editMode, setEditMode] = useState(false);

    // Save handler — given a section key + updated rows array,
    // pushes to Firestore. The live subscription will mirror the
    // change back, so the UI updates without needing optimistic
    // state. Errors toast but don't crash the editor.
    const handleSaveSection = async (sectionKey, rows) => {
        try {
            await saveStickerList(sectionKey, rows, staffName);
        } catch (e) {
            console.warn('saveStickerList failed:', e);
        }
    };

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

    // Andrew 2026-05-20 (later same day): the earlier "shared
    // proteins + per-category" browse view was replaced with the
    // build-sheet structure (see <BuildSheetBrowse/> below). The
    // sections derived from getGlobalComponentSections() are no
    // longer rendered. Search still uses the broader itemBuild
    // index as an escape hatch for items not in the curated build
    // sheet.

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

                {/* Action row — Custom Print for everyone; Edit Mode
                    toggle for admins only. Edit Mode flips the flat
                    sections (3 protein lists + sauces + snacks) into
                    inline-edit forms with delete + add-row buttons.
                    Saves live to /config/sticker_lists. */}
                <div className="flex gap-2 mb-2">
                    <button onClick={() => setCustomPrintOpen(true)}
                        className={`${adminUser ? 'flex-1' : 'flex-1'} py-2.5 rounded-lg bg-purple-600 text-white text-sm font-bold hover:bg-purple-700 active:scale-95 transition shadow-sm`}>
                        🖨 {tx('Custom print (any text)', 'Imprimir personalizado')}
                    </button>
                    {adminUser && (
                        <button onClick={() => setEditMode(v => !v)}
                            title={tx(
                                'Toggle Edit Mode — admin only. Rename, delete, or add rows in any flat list.',
                                'Modo edición — sólo admin. Renombra, borra o agrega filas en las listas planas.',
                            )}
                            className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition shadow-sm border-2 ${
                                editMode
                                    ? 'bg-amber-500 border-amber-600 text-white hover:bg-amber-600'
                                    : 'bg-white border-purple-300 text-purple-700 hover:bg-purple-50'
                            }`}>
                            {editMode
                                ? '✓ ' + tx('Done editing', 'Listo')
                                : '✏️ ' + tx('Edit items', 'Editar')}
                        </button>
                    )}
                </div>
                {editMode && (
                    <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 mb-2 leading-snug">
                        {tx(
                            '✏️ Edit Mode — type to rename, 🗑 to delete, + Add row at section bottom. Changes save automatically across all devices. Tap "Done editing" when finished.',
                            '✏️ Modo edición — escribe para renombrar, 🗑 para borrar, + Agregar fila al final de cada sección. Los cambios se guardan automáticamente en todos los dispositivos.',
                        )}
                    </div>
                )}

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
                    // Idle / browse view — Andrew 2026-05-20: "delete
                    // the current food items in the sticker tab and
                    // replace them with the build sheet in the menu
                    // tab. it makes more sense to use that only".
                    //
                    // Each section mirrors the Menu tab's Build Sheet
                    // view (MenuReference.jsx's BuildSheetView): same
                    // groupings, same item order, same toppings/notes/
                    // piece-counts copy. Difference: every prep-level
                    // row (base, topping, sauce, broth, snack) has a
                    // Print button that opens PrintLabelModal pre-
                    // filled with the component name. Notes stay
                    // read-only.
                    <BuildSheetBrowse
                        isEs={isEs}
                        tx={tx}
                        onPrint={(c) => handlePrintComponent(c, null)}
                        stickerLists={stickerLists}
                        editMode={editMode}
                        onSaveSection={handleSaveSection}
                    />
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
// SharedSection / SharedComponentRow REMOVED 2026-05-20 — the
// "shared proteins + sauces at the top" browse view was retired
// when the sticker tab switched to the build-sheet layout. See
// <BuildSheetBrowse/> below for the new browse render. Search
// results still use ComponentSearchResult for component rows.

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

// ── BuildSheetBrowse ──────────────────────────────────────────────
// Andrew 2026-05-20: "lets delete the current food items in the
// sticker tab and replace them with the build sheet in the menu
// tab. it makes more sense to use that only."
//
// Renders the same six sections as MenuReference.jsx → BuildSheetView
// (Bowls / Handhelds / Fried Rice / Pho / Sauces / Snacks) so the
// laminated cashier reference and the sticker browse view stay in
// lock-step. Each prep-level row gets a 🏷 Print button via the
// existing ComponentRow + KIND_TO_CATEGORY → shelf-life flow. Notes
// render read-only.
//
// All copy comes from src/data/buildSheet.js — that's the single
// source of truth. Update once, both surfaces update.
function BuildSheetBrowse({ isEs, tx, onPrint, stickerLists, editMode, onSaveSection }) {
    // Helper that pulls a section's live list out of the subscription,
    // falling back to the section's own hardcoded defaults if the
    // subscription hasn't loaded yet (renders something instead of
    // blank during the first paint).
    const listFor = (key) => {
        const fromSub = stickerLists?.[key];
        if (Array.isArray(fromSub)) return fromSub;
        return STICKER_SECTIONS.find(s => s.key === key)?.defaults || [];
    };
    return (
        <div className="space-y-5">
            {/* Bowl Proteins — at the very top so the most-prepped
                batches are one tap away when the kitchen starts a
                shift. Shared across Bowls / Bánh Mì / Sliders /
                Tacos / Lo Mein — one batch labels one container. */}
            <BuildSheetFlatSection
                sectionKey="bowlProteins"
                titleEn="🍤 Bowl Proteins"
                titleEs="🍤 Proteínas de Bowls"
                items={listFor('bowlProteins')}
                kind="protein"
                isEs={isEs}
                tx={tx}
                onPrint={onPrint}
                editMode={editMode}
                onSaveSection={onSaveSection}
            />

            {/* Bowls — 3 styles (Vermicelli / Salad / Rice) */}
            <BuildSheetCategory
                titleEn="🥗 Bowls"
                titleEs="🥗 Bowls"
                items={BUILD_SHEET_BOWLS}
                isEs={isEs}
                tx={tx}
                onPrint={onPrint}
            />

            {/* Handhelds — Bao, Spring Rolls, Banh Mi, Tacos */}
            <BuildSheetCategory
                titleEn="🥪 Handhelds"
                titleEs="🥪 Handhelds"
                items={BUILD_SHEET_HANDHELDS}
                isEs={isEs}
                tx={tx}
                onPrint={onPrint}
            />

            {/* Fried Rice Proteins — Ham is the one protein UNIQUE
                to Fried Rice (not in bowls combo). */}
            <BuildSheetFlatSection
                sectionKey="friedRiceProteins"
                titleEn="🍤 Fried Rice Proteins"
                titleEs="🍤 Proteínas de Fried Rice"
                items={listFor('friedRiceProteins')}
                kind="protein"
                isEs={isEs}
                tx={tx}
                onPrint={onPrint}
                editMode={editMode}
                onSaveSection={onSaveSection}
            />

            {/* Fried Rice — single item */}
            <BuildSheetCategory
                titleEn="🍚 Fried Rice"
                titleEs="🍚 Arroz Frito"
                items={[BUILD_SHEET_FRIED_RICE]}
                isEs={isEs}
                tx={tx}
                onPrint={onPrint}
            />

            {/* Pho Proteins — broth-side proteins easy to label per
                pot. Same proteins also shown under each broth in
                the Pho section below as read-only reference. */}
            <BuildSheetFlatSection
                sectionKey="phoProteins"
                titleEn="🍤 Pho Proteins"
                titleEs="🍤 Proteínas de Pho"
                items={listFor('phoProteins')}
                kind="protein"
                isEs={isEs}
                tx={tx}
                onPrint={onPrint}
                editMode={editMode}
                onSaveSection={onSaveSection}
            />

            {/* Pho — special structure: standard garnish + 3 broths,
                each broth with a protein list. */}
            <PhoBuildSheetSection isEs={isEs} tx={tx} onPrint={onPrint} />

            {/* Sauces — flat list, each sauce is itself the prep item */}
            <BuildSheetFlatSection
                sectionKey="sauces"
                titleEn="🥢 Sauces"
                titleEs="🥢 Salsas"
                items={listFor('sauces')}
                kind="sauce"
                isEs={isEs}
                tx={tx}
                onPrint={onPrint}
                editMode={editMode}
                onSaveSection={onSaveSection}
            />

            {/* Snacks — flat list, each snack is the prep item */}
            <BuildSheetFlatSection
                sectionKey="snacks"
                titleEn="🥟 Snacks"
                titleEs="🥟 Snacks"
                items={listFor('snacks')}
                kind="side"
                isEs={isEs}
                tx={tx}
                onPrint={onPrint}
                editMode={editMode}
                onSaveSection={onSaveSection}
            />
        </div>
    );
}

// One section of the build sheet that contains "item cards" — each
// card is a menu-item shape with `baseEn`, `standardToppings`,
// `notes`, `piecesByProtein`. Renders each topping + base as a
// printable component row.
function BuildSheetCategory({ titleEn, titleEs, items, isEs, tx, onPrint }) {
    return (
        <section>
            <h2 className="text-sm font-black uppercase tracking-widest text-dd-text mb-2 px-1">
                {tx(titleEn, titleEs)}
            </h2>
            <div className="space-y-3">
                {items.map((item, idx) => (
                    <BuildSheetItemCard
                        key={idx}
                        item={item}
                        isEs={isEs}
                        tx={tx}
                        onPrint={onPrint}
                    />
                ))}
            </div>
        </section>
    );
}

// One menu item from the build sheet (e.g. Vermicelli Bowl). Title
// at top, base + standard toppings as printable component rows,
// notes as read-only info, piece counts as small chips.
function BuildSheetItemCard({ item, isEs, tx, onPrint }) {
    const name = isEs ? (item.nameEs || item.nameEn) : item.nameEn;
    // Base (if present) → one component row of kind 'base'.
    const baseComponent = (item.baseEn || item.baseEs) ? {
        id: `bs-base::${item.nameEn}`,
        kind: 'base',
        nameEn: item.baseEn,
        nameEs: item.baseEs || item.baseEn,
    } : null;
    // Each standardTopping → component row of kind 'topping'.
    const toppingComponents = (item.standardToppings || []).map((tp, i) => ({
        id: `bs-top::${item.nameEn}::${i}`,
        kind: 'topping',
        nameEn: tp.en,
        nameEs: tp.es || tp.en,
    }));

    return (
        <div className="bg-white border border-dd-line rounded-xl p-3">
            <h3 className="font-black text-dd-text text-base mb-2">{name}</h3>

            {baseComponent && (
                <div className="mb-2">
                    <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-base">{COMPONENT_KIND_TONE.base.icon}</span>
                        <span className="text-[10px] font-black uppercase tracking-widest text-dd-text-2">
                            {tx(COMPONENT_KIND_TONE.base.labelEn, COMPONENT_KIND_TONE.base.labelEs)}
                        </span>
                    </div>
                    <ComponentRow
                        component={baseComponent}
                        tone={COMPONENT_KIND_TONE.base}
                        isEs={isEs}
                        tx={tx}
                        onPrint={onPrint}
                    />
                </div>
            )}

            {toppingComponents.length > 0 && (
                <div className="mb-2">
                    <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-base">{COMPONENT_KIND_TONE.topping.icon}</span>
                        <span className="text-[10px] font-black uppercase tracking-widest text-dd-text-2">
                            {tx(COMPONENT_KIND_TONE.topping.labelEn, COMPONENT_KIND_TONE.topping.labelEs)}
                        </span>
                        <span className="text-[10px] text-dd-text-2/60">· {toppingComponents.length}</span>
                    </div>
                    <div className="space-y-1">
                        {toppingComponents.map(c => (
                            <ComponentRow
                                key={c.id}
                                component={c}
                                tone={COMPONENT_KIND_TONE.topping}
                                isEs={isEs}
                                tx={tx}
                                onPrint={onPrint}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* Piece counts (chips) — informational only, no print. */}
            {item.piecesByProtein && Object.keys(item.piecesByProtein).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(item.piecesByProtein).map(([k, v]) => (
                        <span key={k} className="text-[10px] font-bold bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
                            {k}: {v}
                        </span>
                    ))}
                </div>
            )}

            {/* Notes — read-only kitchen reminders. */}
            {item.notes && item.notes.length > 0 && (
                <ul className="text-[11px] text-dd-text-2 space-y-1 border-t border-dd-line/50 pt-2 mt-2">
                    {item.notes.map((n, i) => (
                        <li key={i}>★ {tx(n.en, n.es || n.en)}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// Pho — bespoke layout because the data shape is different: the
// whole dish has a `standardToppings` garnish list, then 3 broths,
// each with its own list of protein options. Each broth gets a
// printable row (kind: 'broth') so kitchen can label the stockpots.
function PhoBuildSheetSection({ isEs, tx, onPrint }) {
    const garnishComponents = (BUILD_SHEET_PHO.standardToppings || []).map((tp, i) => ({
        id: `bs-pho-gar::${i}`,
        kind: 'garnish',
        nameEn: tp.en,
        nameEs: tp.es || tp.en,
    }));
    const brothComponents = (BUILD_SHEET_PHO.broths || []).map((b, i) => ({
        id: `bs-pho-broth::${i}`,
        kind: 'broth',
        nameEn: b.nameEn,
        nameEs: b.nameEs || b.nameEn,
        // Keep the protein list around for read-only display below.
        _proteinsEn: b.proteinsEn,
        _proteinsEs: b.proteinsEs,
    }));

    return (
        <section>
            <h2 className="text-sm font-black uppercase tracking-widest text-dd-text mb-2 px-1">
                {tx('🍲 Pho', '🍲 Pho')}
            </h2>
            <div className="bg-white border border-dd-line rounded-xl p-3 space-y-3">
                <h3 className="font-black text-dd-text text-base">
                    {tx(BUILD_SHEET_PHO.nameEn, BUILD_SHEET_PHO.nameEs)}
                </h3>

                {garnishComponents.length > 0 && (
                    <div>
                        <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-base">{COMPONENT_KIND_TONE.garnish.icon}</span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-dd-text-2">
                                {tx('Standard garnish', 'Guarnición estándar')}
                            </span>
                            <span className="text-[10px] text-dd-text-2/60">· {garnishComponents.length}</span>
                        </div>
                        <div className="space-y-1">
                            {garnishComponents.map(c => (
                                <ComponentRow
                                    key={c.id}
                                    component={c}
                                    tone={COMPONENT_KIND_TONE.garnish}
                                    isEs={isEs}
                                    tx={tx}
                                    onPrint={onPrint}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {brothComponents.length > 0 && (
                    <div>
                        <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-base">{COMPONENT_KIND_TONE.broth.icon}</span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-dd-text-2">
                                {tx(COMPONENT_KIND_TONE.broth.labelEn, COMPONENT_KIND_TONE.broth.labelEs)}
                            </span>
                            <span className="text-[10px] text-dd-text-2/60">· {brothComponents.length}</span>
                        </div>
                        <div className="space-y-2">
                            {brothComponents.map(c => (
                                <div key={c.id} className="space-y-1">
                                    <ComponentRow
                                        component={c}
                                        tone={COMPONENT_KIND_TONE.broth}
                                        isEs={isEs}
                                        tx={tx}
                                        onPrint={onPrint}
                                    />
                                    {/* Protein options inside this broth — read-only.
                                        Kitchen labels stockpots, not individual protein
                                        portions, so no print buttons here. */}
                                    <ul className="text-[11px] text-dd-text-2 space-y-0.5 pl-3">
                                        {(isEs ? c._proteinsEs : c._proteinsEn).map((p, j) => (
                                            <li key={j}>· {p}</li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}

// Flat sections (Bowl/Fried Rice/Pho Proteins, Sauces, Snacks) —
// each row IS the prep item, no nested toppings/notes. Description
// renders under the name; Print button on every row.
//
// Edit Mode (admin only, Andrew 2026-05-20 "make the items all
// editable"): rows turn into inline name (EN + ES) inputs with a
// delete button. Section gets a "+ Add row" button at the bottom.
// Saves debounce to /config/sticker_lists via onSaveSection.
function BuildSheetFlatSection({
    sectionKey, titleEn, titleEs, items, kind, isEs, tx, onPrint,
    editMode = false, onSaveSection,
}) {
    const tone = COMPONENT_KIND_TONE[kind] || COMPONENT_KIND_TONE.side;

    // Local working copy while editing. We mirror the subscription
    // list when not editing, but in edit mode we keep our own copy
    // so per-keystroke typing doesn't fight with debounced Firestore
    // round-trips. When edit mode flips off we re-sync from props.
    const [draft, setDraft] = useState(() => normalizeForEdit(items));
    useEffect(() => {
        // When edit mode is off, always mirror props. When edit mode
        // is on, also mirror props if the lengths/ids changed (e.g.
        // another admin added a row from another device) but keep
        // the user's in-progress text otherwise.
        if (!editMode) {
            setDraft(normalizeForEdit(items));
        } else {
            setDraft(prev => mergeDrafts(prev, normalizeForEdit(items)));
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, editMode]);

    // Debounced save — flush 600ms after the last edit. Firing
    // immediately on every keystroke would burn write quota and
    // race with the live subscription.
    const saveTimer = useRef(null);
    const queueSave = (next) => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            if (onSaveSection) onSaveSection(sectionKey, next);
        }, 600);
    };

    // Edit handlers — keep `draft` authoritative locally, fire
    // queueSave on every change.
    const updateRow = (id, patch) => {
        setDraft(prev => {
            const next = prev.map(r => r.id === id ? { ...r, ...patch } : r);
            queueSave(next);
            return next;
        });
    };
    const deleteRow = (id) => {
        setDraft(prev => {
            const next = prev.filter(r => r.id !== id);
            queueSave(next);
            return next;
        });
    };
    const addRow = () => {
        setDraft(prev => {
            const next = [...prev, {
                id: makeStickerRowId(`${sectionKey}-new`),
                nameEn: '',
                nameEs: '',
                descEn: '',
                descEs: '',
            }];
            // Don't queue save yet — wait for the user to type. An
            // empty row would get filtered out by saveStickerList's
            // sanitizer anyway.
            return next;
        });
    };

    // Render. In edit mode use `draft`; otherwise build print rows
    // from `items` directly.
    if (editMode) {
        return (
            <section>
                <h2 className="text-sm font-black uppercase tracking-widest text-dd-text mb-2 px-1 flex items-center gap-2">
                    {tx(titleEn, titleEs)}
                    <span className="text-[10px] font-bold text-dd-text-2/60">
                        · {draft.length} {tx('rows', 'filas')}
                    </span>
                    <span className="ml-auto text-[10px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                        ✏️ {tx('editing', 'editando')}
                    </span>
                </h2>
                <div className="bg-white border-2 border-amber-300 rounded-xl p-3">
                    <div className="space-y-1.5">
                        {draft.map(row => (
                            <EditableFlatRow
                                key={row.id}
                                row={row}
                                tone={tone}
                                isEs={isEs}
                                tx={tx}
                                onUpdate={(patch) => updateRow(row.id, patch)}
                                onDelete={() => deleteRow(row.id)}
                            />
                        ))}
                        {draft.length === 0 && (
                            <div className="text-[11px] italic text-dd-text-2 text-center py-2">
                                {tx('No rows yet — tap "Add row" to start.', 'Sin filas — toca "Agregar fila".')}
                            </div>
                        )}
                    </div>
                    <button onClick={addRow}
                        className="mt-3 w-full py-2 rounded-lg border-2 border-dashed border-purple-300 text-purple-700 hover:bg-purple-50 text-xs font-bold">
                        + {tx('Add row', 'Agregar fila')}
                    </button>
                </div>
            </section>
        );
    }

    // Normal (non-edit) render — printable component rows.
    const components = items.map((s, i) => ({
        id: s.id || `bs-flat::${kind}::${i}`,
        kind,
        nameEn: s.nameEn,
        nameEs: s.nameEs || s.nameEn,
        descEn: s.descEn || '',
        descEs: s.descEs || '',
    }));
    if (components.length === 0) return null;
    return (
        <section>
            <h2 className="text-sm font-black uppercase tracking-widest text-dd-text mb-2 px-1">
                {tx(titleEn, titleEs)}
                <span className="ml-2 text-[10px] font-bold text-dd-text-2/60">
                    · {components.length} {tx('printable', 'imprimibles')}
                </span>
            </h2>
            <div className="bg-white border border-dd-line rounded-xl p-3">
                <div className="space-y-1">
                    {components.map(c => (
                        <ComponentRow
                            key={c.id}
                            component={c}
                            tone={tone}
                            isEs={isEs}
                            tx={tx}
                            onPrint={onPrint}
                        />
                    ))}
                </div>
            </div>
        </section>
    );
}

// Strip the build-sheet rows down to the four editable fields + id
// so the edit form has clean state. Generates an id if the source
// row lacks one (hardcoded defaults sometimes do).
function normalizeForEdit(items) {
    return (items || []).map((row, i) => ({
        id:     row.id || `tmp-${i}-${row.nameEn || ''}`,
        nameEn: row.nameEn || '',
        nameEs: row.nameEs || row.nameEn || '',
        descEn: row.descEn || '',
        descEs: row.descEs || '',
    }));
}

// Merge an incoming list from the subscription with the user's
// in-progress draft. Rows the user has touched (different from
// the incoming version) win; brand-new rows from another device
// get appended; rows the user deleted but that still exist
// elsewhere get re-introduced. Best-effort — no MVCC, last write
// wins on conflicts.
function mergeDrafts(draft, incoming) {
    const incomingById = new Map(incoming.map(r => [r.id, r]));
    const out = [];
    for (const d of draft) {
        const i = incomingById.get(d.id);
        if (i) {
            // Keep the draft (user's typed value).
            out.push(d);
            incomingById.delete(d.id);
        } else {
            // Draft has an id the incoming doesn't — keep the draft
            // (it's probably a new row the user just added).
            out.push(d);
        }
    }
    // Any incoming rows not in draft = new from another device.
    for (const i of incomingById.values()) {
        out.push(i);
    }
    return out;
}

// One inline-edit row. Name EN + Name ES side by side, with a
// trash button at the right.
function EditableFlatRow({ row, tone, isEs, tx, onUpdate, onDelete }) {
    return (
        <div className={`flex items-stretch gap-1.5 rounded-lg ${tone.bg} border border-dd-line p-1.5`}>
            <input
                type="text"
                value={row.nameEn}
                onChange={(e) => onUpdate({ nameEn: e.target.value })}
                placeholder={tx('Name (English)', 'Nombre (Inglés)')}
                className="flex-1 min-w-0 px-2 py-1.5 text-xs font-bold border border-dd-line rounded bg-white"
            />
            <input
                type="text"
                value={row.nameEs}
                onChange={(e) => onUpdate({ nameEs: e.target.value })}
                placeholder={tx('Name (Spanish)', 'Nombre (Español)')}
                className="flex-1 min-w-0 px-2 py-1.5 text-xs border border-dd-line rounded bg-white"
            />
            <button
                onClick={onDelete}
                title={tx('Delete row', 'Borrar fila')}
                className="flex-shrink-0 px-2.5 rounded-lg bg-red-100 border border-red-300 text-red-700 text-sm hover:bg-red-200 active:scale-95">
                🗑
            </button>
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
