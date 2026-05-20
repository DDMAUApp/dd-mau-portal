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

import { useMemo, useState, lazy, Suspense } from 'react';
import {
    getAllMenuItems, getMenuItemBuild,
    getSearchableIndex, getAiSearchItems,
    COMPONENT_KIND_TONE,
} from '../data/itemBuild';
import { normalize, expandQueryTermsTight, haystackMatches } from '../data/chatSearch';
import { useAiSearch } from '../data/aiSearch';

const PrintLabelModal = lazy(() => import('./PrintLabelModal'));

export default function DateStickerPrinter({
    language = 'en',
    staffName,
    storeLocation,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const [search, setSearch] = useState('');
    const [openItemId, setOpenItemId] = useState(null);
    // What we hand to PrintLabelModal — a recipe-shaped object so the
    // existing modal renders it without modification.
    const [printingComponent, setPrintingComponent] = useState(null);
    // AI toggle. ON by default — substring runs locally for instant
    // feedback, AI adds semantic matches ~300ms later. Flip off if
    // the AI is slow / unavailable.
    const [aiOn, setAiOn] = useState(true);

    const allItems = useMemo(() => getAllMenuItems(), []);
    // Flat searchable index: every menu item + every deduped
    // component (with usedIn list). This is what "search everything"
    // pulls from.
    const searchIndex = useMemo(() => getSearchableIndex(), []);
    // What we send to the aiSearch Cloud Function. Memoized so the
    // cache key inside aiSearch stays stable.
    const aiItems = useMemo(() => getAiSearchItems(), []);

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

    // Open-item resolver — for the inline-expand on a row.
    const openBuild = useMemo(() => {
        if (!openItemId) return null;
        const item = allItems.find(i => i.id === openItemId);
        if (!item) return null;
        return getMenuItemBuild(item.nameEn);
    }, [openItemId, allItems]);

    // Handler: take a component (from the build), synthesize a
    // recipe-shaped object, and hand to PrintLabelModal in editable
    // mode. Allergens carry over from the menu item.
    const handlePrintComponent = (component, menuItem) => {
        // Notes aren't printable as labels — they're guidance for the
        // staff. Skip the print button for them.
        if (component.kind === 'note') return;
        const allergenStr = component.allergens || menuItem?.allergens || '';
        const allergens = parseAllergenString(allergenStr);
        setPrintingComponent({
            titleEn: component.nameEn,
            titleEs: component.nameEs || component.nameEn,
            allergens,
            ingredientsEn: [],
            ingredientsEs: [],
            category: KIND_TO_CATEGORY[component.kind] || 'Other',
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
                    // Idle / browse view — menu items grouped by category.
                    <div className="space-y-4">
                        {grouped.map(group => (
                            <section key={group.categoryEn}>
                                <h2 className="text-[11px] font-black uppercase tracking-widest text-dd-text-2 mb-1.5 pl-1">
                                    {isEs ? (group.categoryEs || group.categoryEn) : group.categoryEn}
                                </h2>
                                <div className="space-y-1.5">
                                    {group.items.map(item => (
                                        <MenuItemRow
                                            key={item.id}
                                            item={item}
                                            isOpen={openItemId === item.id}
                                            onToggle={() => setOpenItemId(prev => prev === item.id ? null : item.id)}
                                            isEs={isEs}
                                            tx={tx}
                                            build={openItemId === item.id ? openBuild : null}
                                            onPrintComponent={handlePrintComponent}
                                        />
                                    ))}
                                </div>
                            </section>
                        ))}
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
                        onClose={() => setPrintingComponent(null)}
                    />
                </Suspense>
            )}
        </div>
    );
}

// ── MenuItemRow ────────────────────────────────────────────────────
function MenuItemRow({ item, isOpen, onToggle, isEs, tx, build, onPrintComponent }) {
    const allergens = parseAllergenString(item.allergens || '');
    return (
        <div className={`bg-white border-2 rounded-xl overflow-hidden ${isOpen ? 'border-purple-300 shadow-md' : 'border-dd-line'}`}>
            {/* Collapsed header */}
            <button onClick={onToggle}
                className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-purple-50/40 transition">
                <span className={`flex-1 min-w-0 text-sm font-bold text-dd-text truncate`}>
                    {isEs ? (item.nameEs || item.nameEn) : item.nameEn}
                </span>
                {allergens.length > 0 && (
                    <span className="flex-shrink-0 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                        ⚠ {allergens.length}
                    </span>
                )}
                <span className={`flex-shrink-0 text-purple-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}>▼</span>
            </button>

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
                                    onPrint={() => onPrint(c)}
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
    return (
        <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg ${tone.bg} border border-dd-line`}>
            <div className="flex-1 min-w-0">
                <div className={`text-[13px] ${isNote ? 'italic text-dd-text-2 leading-snug' : `font-bold ${tone.text}`}`}>
                    {name}
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
            {!isNote && (
                <button onClick={onPrint}
                    title={tx('Print date sticker', 'Imprimir etiqueta')}
                    className="flex-shrink-0 px-2.5 py-1.5 rounded-lg bg-purple-600 text-white text-[11px] font-bold hover:bg-purple-700 active:scale-95 transition shadow-sm">
                    🏷 {tx('Print', 'Imprimir')}
                </button>
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
