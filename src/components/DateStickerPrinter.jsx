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

import { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue, lazy, Suspense, memo } from 'react';
import {
    getMenuItemBuild,
    findSubRecipe,
    COMPONENT_KIND_TONE,
} from '../data/itemBuild';
// Andrew 2026-06-11: "there are too many items. alot of doubles…
// we dont need the menu items unless its things like sweets and
// snacks." The menu-item browse (Bowls / Handhelds / Fried Rice /
// Pho drill-downs) is GONE from this page — the browse view is now
// exactly the seven deduped prep sections in STICKER_SECTIONS, and
// search covers those rows + admin custom items (no static menu
// items). The Menu tab's cashier build-sheet reference is untouched.
// Live-editable flat lists — Andrew 2026-05-20: "make the items all
// editable". The five flat sections (3 protein lists + sauces +
// snacks) now read from /config/sticker_lists with the hardcoded
// buildSheet.js arrays as defaults. Admin edits inline via the
// Edit Mode toggle.
import {
    subscribeStickerLists,
    saveStickerList,
    saveSections,
    addStickerRow,
    moveStickerRow,
    stickerNameKey,
    makeStickerRowId,
    getStampedDefaults,
    STICKER_SECTIONS,
} from '../data/stickerListsOverride';
import { normalize, expandQueryTermsTight, haystackMatches } from '../data/chatSearch';
import { useAiSearch } from '../data/aiSearch';
import { isAdmin } from '../data/staff';
import { warmPrintConfigs } from '../data/labelPrinting';
import { subscribeAllBuildOverrides, applyBuildOverride } from '../data/buildOverrides';
import { subscribeAllCustomItems } from '../data/customItems';
import ExpiringPanel from './ExpiringPanel';

const PrintLabelModal = lazy(() => import('./PrintLabelModal'));
const BuildEditorModal = lazy(() => import('./BuildEditorModal'));
const ShelfLifeMatrix = lazy(() => import('./ShelfLifeMatrix'));
const PrintCenter = lazy(() => import('./PrintCenter'));

// MM/DD/YY for the Today's Date quick sticker — ONE format for both
// languages and for both the button text and the printed title, so
// what the cook reads is exactly what comes out of the printer.
// Short chip labels for the wrapped category bar — the full section titles
// ("🥬 Veggies & Toppings") pushed the bar to 4+ rows on phones. [EN, ES].
const CHIP_LABELS = {
    proteins: ['🥩 Proteins', '🥩 Proteínas'],
    vegetables: ['🥬 Veggies', '🥬 Verduras'],
    riceNoodles: ['🍜 Noodles', '🍜 Fideos'],
    sauces: ['🥢 Sauces', '🥢 Salsas'],
    stocks: ['🍲 Broths', '🍲 Caldos'],
    madeAhead: ['🥟 Made Ahead', '🥟 Pre-Hechos'],
    snacks: ['🍪 Sweets', '🍪 Dulces'],
    drinks: ['🧋 Drinks', '🧋 Bebidas'],
    chemicals: ['🧪 Chemicals', '🧪 Químicos'],
    statusLabels: ['⚠️ Use First', '⚠️ Usar Primero'],
    other: ['📦 Other', '📦 Otros'],
};

// Short label for a section chip/option. The hardcoded CHIP_LABELS only
// apply while the category still has its DEFAULT title — once an admin
// renames a category, the live title must show here too (chip bar +
// Edit-Mode category mover), or the rename looks like it didn't take.
const DEFAULT_SECTION_TITLES = new Map(STICKER_SECTIONS.map(s => [s.key, s]));
function sectionChipLabel(s, isEs) {
    const chip = CHIP_LABELS[s.key];
    if (chip) {
        const def = DEFAULT_SECTION_TITLES.get(s.key);
        const cur = isEs ? s.titleEs : s.titleEn;
        if (!def || cur === (isEs ? def.titleEs : def.titleEn)) {
            return isEs ? chip[1] : chip[0];
        }
    }
    return (isEs ? (s.titleEs || s.titleEn) : (s.titleEn || s.titleEs)) || s.key;
}

function fmtTodaySticker() {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}`;
}

export default function DateStickerPrinter({
    language = 'en',
    staffName,
    storeLocation,
    staffList = [],
}) {
    const isEs = language === 'es';
    // Stable identity — tx is passed into memo'd children; a fresh
    // arrow per render would defeat their bail-out.
    const tx = useCallback((en, es) => (isEs ? es : en), [isEs]);
    const adminUser = isAdmin(staffName, staffList);

    const [search, setSearch] = useState('');
    // Category filter driven by the top chip bar (Andrew 2026-07-24: "at the
    // top have all the category buttons that help bring up that category").
    // null = show every section; a section key = show just that one;
    // 'custom' = just the ⭐ Custom items.
    const [sectionFilter, setSectionFilter] = useState(null);
    // 2026-05-30 perf — defer the search value used by the heavy filter
    // pipeline (queryTokens + AI dispatch + per-row substring + 3-way
    // union). Input reads `search` for instant feedback; downstream
    // consumers read `searchDeferred` so React updates them at lower
    // priority and keystrokes never block paint.
    const searchDeferred = useDeferredValue(search);
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
    // Dynamic section list (2026-07-24) — titles are renameable and admins
    // can add whole new categories, so the section list itself is live data
    // (doc field `sectionsOverride`), defaulting to the hardcoded sections.
    const [stickerSections, setStickerSections] = useState(STICKER_SECTIONS);
    useEffect(() => {
        return subscribeStickerLists((lists, sections) => {
            setStickerLists(lists);
            if (Array.isArray(sections) && sections.length) setStickerSections(sections);
        });
    }, []);
    // Pre-load the print modal's lazy chunk while the user is still
    // browsing — the first 🏷 tap used to pay the chunk download
    // (black-overlay flash = "glitchy" open, Andrew 2026-06-12).
    // Idle-time fetch; by tap time the modal mounts instantly.
    useEffect(() => {
        const warm = () => { import('./PrintLabelModal').catch(() => {}); };
        if (typeof requestIdleCallback === 'function') {
            const id = requestIdleCallback(warm, { timeout: 3000 });
            return () => cancelIdleCallback(id);
        }
        const t = setTimeout(warm, 800);
        return () => clearTimeout(t);
    }, []);
    // Wake the ACTUAL printers the moment the sticker page mounts, then keep
    // them warm every 25s while the page is open — so by the time staff pick
    // an item and the print window opens, the status strip is already green.
    // 2026-07-23 (Andrew: "when we go into the page it still takes a while
    // to load the printer"): this effect used to warm ONLY the Pi print
    // bridge — which is retired (the Pis are TVs now) — and never touched
    // the Epson/Brother, so the real warm-up didn't start until the modal
    // opened. Now it runs the full warm (config live-mirror + Epson HTTP
    // wake + Brother IPP wake) for the store the user is on.
    // One resolved location for EVERY print surface (2026-07-26 platform
    // audit M3): admins on "Both" used to warm Webster but hand the raw
    // 'both' to PrintLabelModal (→ printers_both_kitchen → misleading "no
    // printer configured") and ExpiringPanel. Normalize once, use it for
    // the warm-up, the print modal, and the expiring view alike.
    const printLoc = storeLocation === 'both' ? 'webster' : storeLocation;
    useEffect(() => {
        if (printLoc !== 'webster' && printLoc !== 'maryland') return;
        warmPrintConfigs(printLoc);
        const id = setInterval(() => warmPrintConfigs(printLoc), 25000);
        return () => clearInterval(id);
    }, [printLoc]);
    // Edit Mode — admin-only. When ON, each row in the flat sections
    // becomes an editable form with delete + add-row buttons. Off
    // by default so the normal print-a-sticker flow stays clean.
    const [editMode, setEditMode] = useState(false);

    // Save handler — given a section key + updated rows array,
    // pushes to Firestore. The live subscription will mirror the
    // change back, so the UI updates without needing optimistic
    // state. Errors toast but don't crash the editor. useCallback so
    // the memo'd sections don't re-render on unrelated state changes.
    const handleSaveSection = useCallback(async (sectionKey, rows) => {
        try {
            await saveStickerList(sectionKey, rows, staffName);
        } catch (e) {
            console.warn('saveStickerList failed:', e);
        }
    }, [staffName]);

    // Move a row into a DIFFERENT category (Andrew 2026-07-24: "when I press
    // edit I want to be able to move items to different categories").
    // 2026-07-26 audit fix: the old two-step (append to target, then let the
    // source's debounced delete land separately) could strand the row in
    // both sections — or, raced by a stale pending save, in neither.
    // moveStickerRow commits BOTH section arrays in ONE transaction; a
    // same-name row already in the target makes the move a dedupe.
    const handleMoveRow = useCallback(async (row, fromKey, toKey) => {
        try {
            await moveStickerRow(fromKey, toKey, row, staffName);
            return true;
        } catch (e) {
            console.warn('handleMoveRow failed:', e);
            return false;
        }
    }, [staffName]);

    // Admin-created custom items only — static menu items no longer
    // appear on this page (2026-06-11). Synthesized shape so the
    // existing renderers / build resolver treat them as items.
    const allItems = useMemo(() => {
        return customItems.map(ci => ({
            id: ci.slug,
            nameEn: ci.nameEn,
            nameEs: ci.nameEs,
            category: ci.category || 'Custom',
            categoryEs: ci.categoryEs || ci.category || 'Personalizado',
            allergens: ci.allergens || '',
            isCustom: true,
        }));
    }, [customItems]);

    // Flat searchable index: every row of the seven prep sections
    // (live override or default) + custom items + their components.
    // Section rows carry their section title as `category` so typing
    // "protein" or "salsa" matches the whole group.
    const searchIndex = useMemo(() => {
        const base = [];
        // Precompute each row's normalized search haystack ONCE here
        // (2026-07-26 perf audit): it used to be rebuilt + NFD-normalized
        // per row per keystroke inside the filter pass — a few ms per
        // keystroke on old kitchen iPads for pure throwaway work.
        const stampHay = (row) => {
            row.hay = normalize([
                row.nameEn, row.nameEs,
                row.descEn, row.descEs,
                row.category, row.categoryEs,
                row.allergens || '',
                (row.usedIn || []).join(' '),
                (row.usedInEs || []).join(' '),
                row.componentKind || '',
            ].filter(Boolean).join(' '));
            return row;
        };
        for (const section of stickerSections) {
            const rows = stickerLists?.[section.key] || section.defaults;
            for (const [i, row] of rows.entries()) {
                base.push(stampHay({
                    id: `sec::${section.key}::${row.id || i}`,
                    kind: 'component',
                    componentKind: section.kind,
                    nameEn: row.nameEn,
                    nameEs: row.nameEs,
                    descEn: row.descEn || '',
                    descEs: row.descEs || '',
                    category: section.titleEn,
                    categoryEs: section.titleEs,
                    // Carry the per-item shelf lives so printing from SEARCH
                    // results uses the same use-by default as the browse grid
                    // (audit finding 4: same item, different date by path).
                    ...(row.shelfLifeDays ? { shelfLifeDays: row.shelfLifeDays } : {}),
                    ...(row.shelfLifeHours ? { shelfLifeHours: row.shelfLifeHours } : {}),
                    ...(row.thawedDays ? { thawedDays: row.thawedDays } : {}),
                }));
            }
        }
        for (const ci of customItems) {
            base.push(stampHay({
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
            }));
            for (const c of (ci.components || [])) {
                base.push(stampHay({
                    id: `cpcustom::${ci.slug}::${c.id}`,
                    kind: 'component',
                    componentKind: c.kind,
                    nameEn: c.nameEn,
                    nameEs: c.nameEs,
                    descEn: c.descEn || '',
                    descEs: c.descEs || '',
                    usedIn: [ci.nameEn],
                    usedInEs: [ci.nameEs || ci.nameEn],
                }));
            }
        }
        return base;
    }, [customItems, stickerLists, stickerSections]);

    // AI items mirror the index. 2026-06-13 perf — `searchIndex` gets a new
    // reference on every Firestore snapshot echo (subscribeStickerLists /
    // subscribeAllCustomItems rebuild fresh arrays each tick), which churned
    // `aiItems` identity and re-fired the useAiSearch effect mid-typing —
    // restarting its debounce and re-billing the Claude search call. Key the
    // memo on the searchable CONTENT (id+name) instead of the array reference,
    // so unrelated echoes (a row's lastSeen, another section's edit) no longer
    // invalidate it. The AI CF already caches on the same fingerprint, so
    // behavior is identical — just far fewer effect runs.
    const aiItemsKey = useMemo(
        () => searchIndex.map(r => r.id + '|' + (r.nameEn || '')).join(''),
        [searchIndex]);
    const aiItems = useMemo(() => {
        return searchIndex.map(row => ({
            id: row.id,
            name: row.nameEn,
            category: row.kind === 'menuItem'
                ? (row.category || 'Custom')
                : (row.category || COMPONENT_KIND_TONE[row.componentKind]?.labelEn || row.componentKind),
            subcat: [row.descEn, row.allergens].filter(Boolean).join(' | ').slice(0, 180),
        }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [aiItemsKey]);

    const queryTokens = useMemo(() => expandQueryTermsTight(searchDeferred), [searchDeferred]);
    const hasQuery = queryTokens.length > 0;

    // AI hook — MUST sit above any conditional return (the React #300
    // hooks-after-early-return lesson from Recipes still applies).
    const {
        loading: aiLoading,
        matchingIds: aiIds,
        error: aiError,
    } = useAiSearch({
        query: searchDeferred,
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
        // `hay` is precomputed in the searchIndex memo — per keystroke this
        // is now just the substring scan, no string building/normalizing.
        return haystackMatches(row.hay || '', queryTokens);
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

    // (searchGridComponents + handleSearchPrint moved BELOW
    // handlePrintComponent — its useCallback dep array evaluated the
    // not-yet-initialized const during render: the 2026-07-26 "date
    // stickers can't load" TDZ crash. Same bug class as the Operations
    // 2026-07-01 incident — in these giant components, anything a hook's
    // DEP ARRAY references must be declared above it.)

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
            const noteComps = (Array.isArray(ci.notes) ? ci.notes : []).map((n, i) => ({
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
    // 📅 Bulk shelf-life matrix (admin) — set the use-by days for every item at once.
    const [shelfMatrixOpen, setShelfMatrixOpen] = useState(false);
    // Expiring-soon panel (2026-07-26 feature #7) — open to all staff.
    const [expiringOpen, setExpiringOpen] = useState(false);

    // Handler: take a component (from the build), synthesize a
    // recipe-shaped object, and hand to PrintLabelModal in editable
    // mode. Allergens carry over from the menu item. Shelf-life
    // override (if set on the menu item) propagates so the modal's
    // slider default is the admin-set value, not the category fallback.
    // Stable identity (openBuild read through a ref) so the memo'd
    // browse sections don't re-render on every keystroke/snapshot.
    const openBuildRef = useRef(null);
    openBuildRef.current = openBuild;
    const handlePrintComponent = useCallback((component, menuItem) => {
        if (component.kind === 'note') return;
        const allergenStr = component.allergens || menuItem?.allergens || '';
        const allergens = parseAllergenString(allergenStr);
        // Pull shelf-life from open build (custom items + overrides
        // already merge it onto the build object).
        const shelfFromBuild = component.shelfLifeDays ?? openBuildRef.current?.shelfLifeDays;
        setPrintingComponent({
            titleEn: component.nameEn,
            titleEs: component.nameEs || component.nameEn,
            allergens,
            ingredientsEn: [],
            ingredientsEs: [],
            category: KIND_TO_CATEGORY[component.kind] || 'Other',
            // kind drives the per-category label format (sanitizer =
            // 'chemical' → name-first/big). 2026-07-27: this synthesized
            // recipe never carried it, so the override silently no-opped
            // for every sticker-page print even after the modal-side fix.
            kind: component.kind || null,
            ...(shelfFromBuild ? { shelfLifeDays: shelfFromBuild } : {}),
            ...(component.shelfLifeHours ? { shelfLifeHours: component.shelfLifeHours } : {}),
            ...(component.thawedDays ? { thawedDays: component.thawedDays } : {}),
        });
    }, []);
    const handleBrowsePrint = useCallback((c) => handlePrintComponent(c, null), [handlePrintComponent]);

    // Grid-shaped search hits, memoized (2026-07-26 perf audit): the inline
    // `.map(c => ({...c}))` minted fresh cell objects per keystroke and
    // defeated StickerCell's memo for every visible match. MUST live below
    // handlePrintComponent (see the TDZ note at the old site above).
    const searchGridComponents = useMemo(
        () => (flatResults.components || []).map(c => ({ ...c, kind: c.componentKind || 'side' })),
        [flatResults]);
    const handleSearchPrint = useCallback((c) => handlePrintComponent({
        kind: c.kind,
        nameEn: c.nameEn,
        nameEs: c.nameEs,
        descEn: c.descEn,
        descEs: c.descEs,
        // Same use-by default as the browse grid (audit finding 4).
        ...(c.shelfLifeDays ? { shelfLifeDays: c.shelfLifeDays } : {}),
        ...(c.shelfLifeHours ? { shelfLifeHours: c.shelfLifeHours } : {}),
        ...(c.thawedDays ? { thawedDays: c.thawedDays } : {}),
    }, null), [handlePrintComponent]);

    // Anyone-can-add (2026-07-26 audit fix): the add now goes through a
    // Firestore TRANSACTION (addStickerRow) instead of rewriting the full
    // array from client state — two cooks adding to the same category at
    // the same moment can no longer clobber each other's item.
    const handleAddItem = useCallback(async (sectionKey, nameEn, nameEs) => {
        try {
            return await addStickerRow(sectionKey, { nameEn, nameEs }, staffName);
        } catch (e) {
            console.warn('addStickerRow failed:', e);
            return 'error';
        }
    }, [staffName]);

    return (
        <div className="p-4 pb-bottom-nav">
            <div className="max-w-3xl mx-auto">
                {/* Header */}
                <div className="flex items-center gap-3 mb-3">
                    <span className="text-3xl">🏷</span>
                    <div className="flex-1 min-w-0">
                        <h1 className="text-xl font-black text-dd-text">
                            {tx('Date Stickers', 'Etiquetas de Fecha')}
                        </h1>
                        <p className="text-xs text-dd-text-2">
                            {tx(
                                'Tap any sticker to print it with today’s date.',
                                'Toca cualquier etiqueta para imprimirla con la fecha de hoy.',
                            )}
                        </p>
                    </div>
                    {/* Expiring-soon walk-in check (2026-07-26 feature #7) —
                        everything printed whose use-by is today/tomorrow/past. */}
                    <button
                        type="button"
                        onClick={() => setExpiringOpen(true)}
                        className="flex-shrink-0 px-3 py-2 rounded-xl bg-amber-100 border border-amber-300 text-amber-800 text-xs font-black active:scale-95">
                        📅 {tx('Expiring', 'Por caducar')}
                    </button>
                </div>

                {/* Sticky command bar — search + category buttons together
                    (Andrew 2026-07-24). Stays pinned while the grids scroll so
                    a cook can always jump straight to a category. */}
                <div className="sticky top-0 z-10 -mx-2 px-2 pt-1 pb-2 mb-2 bg-dd-bg/95 backdrop-blur-sm rounded-b-xl">
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
                {/* Category buttons — tap one to bring up just that category
                    (tap again, or All, to clear). WRAPPED into 2–3 short rows
                    that always fit the page width — no sideways scrolling
                    (Andrew 2026-07-24). Short chip labels keep the row count
                    down; the full titles still head each section below. */}
                <div className="flex flex-wrap gap-1.5" role="tablist"
                    aria-label={tx('Sticker categories', 'Categorías de etiquetas')}>
                    <button type="button" role="tab" aria-selected={sectionFilter === null}
                        onClick={() => { setSectionFilter(null); setSearch(''); }}
                        className={`px-2.5 py-1.5 rounded-full text-[11.5px] font-bold border-2 transition whitespace-nowrap ${sectionFilter === null
                            ? 'bg-purple-600 text-white border-purple-700'
                            : 'bg-white text-dd-text-2 border-dd-line hover:bg-purple-50'}`}>
                        {tx('All', 'Todo')}
                    </button>
                    {stickerSections.map((s) => {
                        const on = sectionFilter === s.key;
                        const tone = COMPONENT_KIND_TONE[s.kind] || COMPONENT_KIND_TONE.side;
                        const label = sectionChipLabel(s, isEs);
                        return (
                            <button key={s.key} type="button" role="tab" aria-selected={on}
                                onClick={() => { setSectionFilter(prev => prev === s.key ? null : s.key); setSearch(''); }}
                                className={`px-2.5 py-1.5 rounded-full text-[11.5px] font-bold border-2 transition whitespace-nowrap ${on
                                    ? 'bg-purple-600 text-white border-purple-700'
                                    : `${tone.bg} ${tone.text} border-black/10 hover:brightness-95`}`}>
                                {label}
                            </button>
                        );
                    })}
                    {allItems.length > 0 && (
                        <button type="button" role="tab" aria-selected={sectionFilter === 'custom'}
                            onClick={() => { setSectionFilter(prev => prev === 'custom' ? null : 'custom'); setSearch(''); }}
                            className={`px-2.5 py-1.5 rounded-full text-[11.5px] font-bold border-2 transition whitespace-nowrap ${sectionFilter === 'custom'
                                ? 'bg-purple-600 text-white border-purple-700'
                                : 'bg-white text-dd-text border-dd-line hover:bg-purple-50'}`}>
                            ⭐ {tx('Custom', 'Personal.')}
                        </button>
                    )}
                </div>
                </div>{/* /sticky command bar */}

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
                {/* ➕ Add a custom item — admin only. Andrew 2026-06-24: "when a
                    new item is added to the stickers make it live + stay." Opens
                    the new-item form; on save it persists to /custom_items and
                    immediately appears in the ⭐ Custom items section below
                    (live subscription). */}
                {adminUser && (
                    <button onClick={() => setNewItemModal(true)}
                        className="w-full mb-2 py-2.5 rounded-lg bg-white border-2 border-purple-300 text-purple-700 text-sm font-bold hover:bg-purple-50 active:scale-95 transition shadow-sm">
                        ➕ {tx('Add a custom item (sauce, prep, drink…)', 'Agregar artículo personalizado')}
                    </button>
                )}
                {adminUser && (
                    <button onClick={() => setShelfMatrixOpen(true)}
                        title={tx('Bulk-edit the use-by days for every item', 'Edita en bloque los días de caducidad de cada artículo')}
                        className="w-full mb-2 py-2.5 rounded-lg bg-white border-2 border-dd-green/40 text-dd-green-700 text-sm font-bold hover:bg-dd-green-50 active:scale-95 transition shadow-sm">
                        📅 {tx('Shelf life table (set use-by days)', 'Tabla de vida útil (días de caducidad)')}
                    </button>
                )}
                {editMode && (
                    <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 mb-2 leading-snug">
                        {tx(
                            '✏️ Edit Mode — type to rename, 🗑 to delete, + Add row at section bottom. Changes save automatically across all devices. Tap "Done editing" when finished.',
                            '✏️ Modo edición — escribe para renombrar, 🗑 para borrar, + Agregar fila al final de cada sección. Los cambios se guardan automáticamente en todos los dispositivos.',
                        )}
                    </div>
                )}
                {/* Category editor (Andrew 2026-07-24): rename any category and
                    add brand-new ones. Built-in categories can't be deleted
                    (their lists must always exist); custom ones can be, once
                    their list is empty. */}
                {editMode && (
                    <CategoryEditor
                        sections={stickerSections}
                        stickerLists={stickerLists}
                        staffName={staffName}
                        isEs={isEs}
                        tx={tx}
                    />
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
                        {flatResults.components.length} {tx(
                            `prep item${flatResults.components.length === 1 ? '' : 's'}`,
                            `artículo${flatResults.components.length === 1 ? '' : 's'}`,
                        )}
                        {flatResults.items.length > 0 && (
                            <>
                                {' · '}
                                {flatResults.items.length} {tx(
                                    `custom item${flatResults.items.length === 1 ? '' : 's'}`,
                                    `personalizado${flatResults.items.length === 1 ? '' : 's'}`,
                                )}
                            </>
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
                            {flatResults.components.length > 0 && (
                                <section>
                                    <h2 className="text-[11px] font-black uppercase tracking-widest text-dd-text-2 mb-1.5 pl-1">
                                        🏷 {tx('Prep items', 'Artículos de preparación')}
                                    </h2>
                                    {/* Search hits use the SAME sticker-button
                                        grid as browse (2026-07-24) — tap the
                                        sticker, it prints. */}
                                    <StickerGrid
                                        components={searchGridComponents}
                                        toneFor={searchToneFor}
                                        isEs={isEs}
                                        tx={tx}
                                        onPrint={handleSearchPrint}
                                    />
                                </section>
                            )}
                            {flatResults.items.length > 0 && (
                                <section>
                                    <h2 className="text-[11px] font-black uppercase tracking-widest text-dd-text-2 mb-1.5 pl-1">
                                        ⭐ {tx('Custom items', 'Personalizados')}
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
                        </div>
                    )
                ) : (
                    // Idle / browse view — the seven deduped prep
                    // sections from STICKER_SECTIONS (Andrew
                    // 2026-06-11: one of each item, categorized).
                    <>
                        {/* 📅 Pinned quick print — Andrew 2026-06-11: "at the
                            top of the list print todays date. somtimes we only
                            need to print today date. so where the name of the
                            item is we can just put todays date." Opens the
                            print modal with the date as the item name; size,
                            copies, shelf life stay adjustable as usual. */}
                        <button
                            onClick={() => {
                                // Recompute fresh at tap time (a tablet can sit on
                                // this page across midnight). Same MM/DD/YY string
                                // in BOTH languages so the button text always
                                // matches what prints — es-MX locale formatting
                                // showed DD/MM on the button while printing MM/DD.
                                handlePrintComponent({ kind: 'base', nameEn: fmtTodaySticker(), nameEs: fmtTodaySticker() }, null);
                            }}
                            className="w-full mb-4 flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-purple-600 text-white shadow-sm hover:bg-purple-700 active:scale-[0.99] transition">
                            <span className="text-left min-w-0">
                                <span className="block text-sm font-black truncate">
                                    📅 {tx("Today's date", 'Fecha de hoy')} — {fmtTodaySticker()}
                                </span>
                                <span className="block text-[11px] opacity-90">
                                    {tx('Print a sticker with just the date', 'Imprime una etiqueta sólo con la fecha')}
                                </span>
                            </span>
                            <span className="text-xl shrink-0">🏷</span>
                        </button>
                        <BuildSheetBrowse
                            isEs={isEs}
                            tx={tx}
                            onPrint={handleBrowsePrint}
                            stickerLists={stickerLists}
                            editMode={editMode}
                            onSaveSection={handleSaveSection}
                            onMoveRow={handleMoveRow}
                            onAddItem={handleAddItem}
                            sectionFilter={sectionFilter}
                            sections={stickerSections}
                        />
                        {/* ⭐ Custom items — Andrew 2026-06-24: "when a new item
                            is added to the stickers make it live + stay." These
                            used to appear ONLY in search; now they're a permanent
                            section in the idle browse view too, so a freshly-added
                            item shows up and stays (live /custom_items subscription). */}
                        {allItems.length > 0 && (sectionFilter === null || sectionFilter === 'custom') && (
                            <section className="mt-5">
                                <h2 className="text-[11px] font-black uppercase tracking-widest text-dd-text-2 mb-1.5 pl-1">
                                    ⭐ {tx('Custom items', 'Personalizados')}
                                </h2>
                                <div className="space-y-1.5">
                                    {[...allItems].sort((a, b) => {
                                        const an = (isEs ? (a.nameEs || a.nameEn) : a.nameEn) || '';
                                        const bn = (isEs ? (b.nameEs || b.nameEn) : b.nameEn) || '';
                                        return an.localeCompare(bn, isEs ? 'es' : 'en', { sensitivity: 'base' });
                                    }).map(item => (
                                        <MenuItemRow
                                            key={item.id}
                                            item={item}
                                            isOpen={openItemId === item.id}
                                            onToggle={() => setOpenItemId(prev => prev === item.id ? null : item.id)}
                                            isEs={isEs}
                                            tx={tx}
                                            build={openItemId === item.id ? openBuild : null}
                                            onPrintComponent={handlePrintComponent}
                                            adminUser={adminUser}
                                            onEdit={() => setEditingItem({ id: item.id, nameEn: item.nameEn, nameEs: item.nameEs })}
                                            hasOverride={overrides.has(item.id)}
                                        />
                                    ))}
                                </div>
                            </section>
                        )}
                    </>
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
                        location={printLoc}
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
                        location={printLoc}
                        staffName={staffName}
                        language={language}
                        isAdmin={adminUser}
                        onClose={() => setCustomPrintOpen(false)}
                    />
                </Suspense>
            )}

            {/* 📅 Bulk shelf-life matrix — admin sets the use-by days for every
                sticker item at once; the date sticker then auto-fills each. */}
            {shelfMatrixOpen && (
                <Suspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                    <ShelfLifeMatrix
                        language={language}
                        byName={staffName}
                        onClose={() => setShelfMatrixOpen(false)}
                    />
                </Suspense>
            )}

            {expiringOpen && (
                <ExpiringPanel
                    location={printLoc}
                    staffName={staffName}
                    language={language}
                    onClose={() => setExpiringOpen(false)}
                />
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
                        <StickerGrid
                            components={items}
                            toneFor={() => tone}
                            isEs={isEs}
                            tx={tx}
                            onPrint={onPrint}
                        />
                    </div>
                );
            })}
        </div>
    );
}


// ── StickerCell + StickerGrid — KEPS-style button grid (Andrew 2026-07-24) ──
// "instead of items and at the end there are print sticker buttons i want
// buttons with the sticker and thats it. no one line sticker." Every printable
// item is now ONE big tappable button that IS the sticker — tone-colored,
// name centered, whole surface prints (the same layout the KEPS / DateCodeGenie
// food-safety label apps use). Rows/columns instead of one-line rows:
// 2 columns on phones, 3–4 on tablets/desktop. Items with a matching
// sub-recipe get a small corner "+N" toggle that opens the ingredients as
// their own grid of sticker buttons right below.
//
// Accessibility: cells are real <button>s ≥64px tall (comfortably above the
// 44px HIG / 48dp Material minimums), aria-labels say "Print sticker: {name}",
// the sub-recipe toggle is its own sibling button (never nested), and both
// keep visible focus rings for keyboard/switch users.
const StickerCell = memo(function StickerCell({ component, tone, isEs, tx, onPrint, subCount = 0, subOpen = false, onToggleSub }) {
    const name = isEs ? (component.nameEs || component.nameEn) : component.nameEn;
    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => onPrint(component)}
                aria-label={tx(`Print sticker: ${name}`, `Imprimir etiqueta: ${name}`)}
                title={tx('Tap to print this sticker', 'Toca para imprimir esta etiqueta')}
                className={`w-full min-h-[64px] rounded-xl border-2 border-black/10 ${tone.bg} ${tone.text} px-2 py-2.5 flex items-center justify-center text-center text-[13px] font-extrabold leading-tight shadow-sm hover:brightness-[0.97] active:scale-95 transition select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500`}
            >
                <span className="break-words">{name}</span>
            </button>
            {subCount > 0 && (
                <button
                    type="button"
                    onClick={() => onToggleSub?.(component.id)}
                    aria-label={tx(`Show ${subCount} ingredients`, `Ver ${subCount} ingredientes`)}
                    aria-expanded={subOpen}
                    className={`absolute -top-1.5 -right-1.5 min-w-[26px] h-[22px] px-1 rounded-full text-[10px] font-black border shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 ${subOpen
                        ? 'bg-purple-600 text-white border-purple-700'
                        : 'bg-white text-purple-700 border-purple-300 hover:bg-purple-50'}`}
                >
                    +{subCount}
                </button>
            )}
        </div>
    );
});

// Grid wrapper: lays cells out in responsive rows/columns, renders 'note'
// kind entries as full-width text (guidance, not printable), and hosts the
// one-open-at-a-time sub-recipe ingredients panel.
function StickerGrid({ components, toneFor, isEs, tx, onPrint }) {
    const [subOpenId, setSubOpenId] = useState(null);
    // Stable id-based toggle (2026-07-26 perf audit): the per-cell arrow
    // closure minted a new function per cell per render, defeating
    // StickerCell's memo in EVERY grid on the page.
    const toggleSub = useCallback((id) => setSubOpenId((prev) => (prev === id ? null : id)), []);
    const open = subOpenId ? components.find((c) => c.id === subOpenId) : null;
    const openSub = open ? findSubRecipe(open.nameEn) : null;
    return (
        <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {components.map((c) => {
                    if (c.kind === 'note') {
                        return (
                            <div key={c.id} className="col-span-full text-[12px] italic text-dd-text-2 px-1 py-0.5">
                                ℹ️ {isEs ? (c.nameEs || c.nameEn) : c.nameEn}
                            </div>
                        );
                    }
                    const sub = findSubRecipe(c.nameEn);
                    return (
                        <StickerCell
                            key={c.id}
                            component={c}
                            tone={toneFor(c)}
                            isEs={isEs}
                            tx={tx}
                            onPrint={onPrint}
                            subCount={sub ? sub.ingredients.length : 0}
                            subOpen={subOpenId === c.id}
                            onToggleSub={toggleSub}
                        />
                    );
                })}
            </div>
            {open && openSub && (
                <div className="mt-2 rounded-xl border-2 border-purple-200 bg-purple-50/40 p-2">
                    <div className="text-[10px] font-black uppercase tracking-widest text-purple-800 mb-1.5 px-1">
                        🧪 {tx(`Ingredients in ${open.nameEn}`, `Ingredientes en ${open.nameEn}`)}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                        {openSub.ingredients.map((ing, i) => (
                            <StickerCell
                                key={`${open.id}-ing-${i}`}
                                component={{ kind: 'topping', nameEn: ing.nameEn, nameEs: ing.nameEs }}
                                tone={COMPONENT_KIND_TONE.topping}
                                isEs={isEs}
                                tx={tx}
                                onPrint={onPrint}
                            />
                        ))}
                    </div>
                </div>
            )}
        </>
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
function BuildSheetBrowse({ isEs, tx, onPrint, stickerLists, editMode, onSaveSection, onMoveRow, onAddItem, sectionFilter = null, sections = STICKER_SECTIONS }) {
    // Andrew 2026-06-11: "too many items. alot of doubles… categorize
    // it by veggie, protein, noodles, rice and so on. we dont need the
    // menu items unless its things like sweets and snacks." The browse
    // is now driven entirely by STICKER_SECTIONS (one deduped list per
    // category) — the menu-item drill-downs (Bowls / Handhelds / Fried
    // Rice / Pho) are gone from this page. Helper pulls a section's
    // live list out of the subscription, falling back to the section's
    // hardcoded defaults during the first paint.
    const listFor = (key) => {
        const fromSub = stickerLists?.[key];
        if (Array.isArray(fromSub)) return fromSub;
        // Pre-subscription first paint — stamped defaults so rows
        // already carry the same stable ids the subscription will use.
        return getStampedDefaults(key);
    };
    // Category-chip filter (2026-07-24): a non-null filter shows just that
    // section. 'custom' is handled by the parent (the ⭐ section lives there).
    const visibleSections = sectionFilter && sectionFilter !== 'custom'
        ? sections.filter(s => s.key === sectionFilter)
        : (sectionFilter === 'custom' ? [] : sections);
    return (
        <div className="space-y-5">
            {visibleSections.map(section => (
                <BuildSheetFlatSection
                    key={section.key}
                    sectionKey={section.key}
                    titleEn={section.titleEn}
                    titleEs={section.titleEs}
                    items={listFor(section.key)}
                    kind={section.kind}
                    isEs={isEs}
                    tx={tx}
                    onPrint={onPrint}
                    editMode={editMode}
                    onSaveSection={onSaveSection}
                    onMoveRow={onMoveRow}
                    onAddItem={onAddItem}
                    allSections={sections}
                />
            ))}
        </div>
    );
}

// (BuildSheetCategory / BuildSheetItemCard / PhoBuildSheetSection deleted
// 2026-06-11 — the menu-item drill-downs left this page; the Menu tab
// keeps its own copies of the build-sheet data.)


// Flat sections (Bowl/Fried Rice/Pho Proteins, Sauces, Snacks) —
// each row IS the prep item, no nested toppings/notes. Description
// renders under the name; Print button on every row.
//
// Edit Mode (admin only, Andrew 2026-05-20 "make the items all
// editable"): rows turn into inline name (EN + ES) inputs with a
// delete button. Section gets a "+ Add row" button at the bottom.
// Saves debounce to /config/sticker_lists via onSaveSection.
// memo: the seven sections are siblings of the search input — without
// bail-out, every keystroke re-rendered all ~68 rows twice (urgent +
// deferred pass). All props are stable now (tx/onPrint/onSaveSection
// useCallback'd; items arrays identity-stable via STAMPED_DEFAULTS).
const BuildSheetFlatSection = memo(function BuildSheetFlatSection({
    sectionKey, titleEn, titleEs, items, kind, isEs, tx, onPrint,
    editMode = false, onSaveSection, onMoveRow, onAddItem, allSections = STICKER_SECTIONS,
}) {
    const tone = COMPONENT_KIND_TONE[kind] || COMPONENT_KIND_TONE.side;

    // Local working copy while editing. We mirror the subscription
    // list when not editing, but in edit mode we keep our own copy
    // so per-keystroke typing doesn't fight with debounced Firestore
    // round-trips. When edit mode flips off we re-sync from props.
    const [draft, setDraft] = useState(() => normalizeForEdit(items));
    // Track ids the user deleted locally so a subscription update
    // (live `items` push from another device or our own pending save)
    // doesn't re-introduce the just-deleted row inside mergeDrafts.
    // Cleared when the user exits edit mode.
    const deletedIdsRef = useRef(new Set());

    // Debounced save — flush 600ms after the last edit. Firing
    // immediately on every keystroke would burn write quota and
    // race with the live subscription.
    //
    // 2026-05-24 fix: the 600ms timer used to evaporate if the user
    // turned off edit mode (or unmounted the component) within the
    // debounce window — their last keystroke never reached Firestore.
    // We now stash the pending flush in a ref and synchronously fire
    // it from flushPendingSave() before tearing the draft state down.
    const saveTimer = useRef(null);
    const pendingDirty = useRef(false);
    // 2026-07-26 audit fix (finding 2): the flush used to save the array
    // CAPTURED at keystroke time. If a subscription echo merged new rows
    // into `draft` inside the 600ms window (e.g. a row moved IN from
    // another section/device), the stale payload rewrote the section
    // WITHOUT them — the moved row vanished from both sections. Flush now
    // reads the LIVE draft through a ref.
    const draftRef = useRef(null);
    const queueSave = () => {
        pendingDirty.current = true;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            saveTimer.current = null;
            flushPendingSave();
        }, 600);
    };
    // Idempotent — no-op if nothing's pending. Called from the
    // editMode→false branch below AND from the unmount cleanup.
    const flushPendingSave = () => {
        if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
        if (!pendingDirty.current) return;
        pendingDirty.current = false;
        if (onSaveSection && draftRef.current) onSaveSection(sectionKey, draftRef.current);
    };

    useEffect(() => {
        // When edit mode is off, always mirror props. When edit mode
        // is on, also mirror props if the lengths/ids changed (e.g.
        // another admin added a row from another device) but keep
        // the user's in-progress text otherwise.
        if (!editMode) {
            // Flush any in-flight debounce BEFORE we wipe the draft —
            // otherwise the user's last edit (within the 600ms window)
            // is lost when we overwrite with normalizeForEdit(items).
            flushPendingSave();
            // Leaving edit mode resets the per-session deletion log;
            // next time they re-enter we trust the live items[].
            deletedIdsRef.current = new Set();
            const next = normalizeForEdit(items);
            draftRef.current = next;
            setDraft(next);
        } else {
            setDraft(prev => {
                const merged = mergeDrafts(prev, normalizeForEdit(items), deletedIdsRef.current);
                draftRef.current = merged;
                return merged;
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, editMode]);

    // Unmount safety net: if the user navigates away (closes Sticker
    // Center, switches Operations tab) inside the 600ms window we
    // still want their last edit to land. Re-runs when onSaveSection
    // or sectionKey change so the closure always sees the current
    // callback at flush time.
    useEffect(() => {
        return () => { flushPendingSave(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onSaveSection, sectionKey]);

    // Edit handlers — keep `draft` authoritative locally, fire
    // queueSave on every change.
    const updateRow = (id, patch) => {
        setDraft(prev => {
            const next = prev.map(r => r.id === id ? { ...r, ...patch } : r);
            draftRef.current = next;
            return next;
        });
        queueSave();
    };
    const deleteRow = (id, { save = true } = {}) => {
        // Remember this deletion so mergeDrafts doesn't undo it on
        // the next live subscription tick (before our save lands).
        deletedIdsRef.current.add(id);
        setDraft(prev => {
            const next = prev.filter(r => r.id !== id);
            draftRef.current = next;
            return next;
        });
        if (save) queueSave();
    };
    // Cross-category move: the parent commits BOTH sections in one atomic
    // Firestore write (moveStickerRow transaction), so this side only
    // updates the local draft — no debounced source save needed, and a
    // stale echo can't resurrect the row thanks to deletedIdsRef.
    const moveRow = async (id, toKey) => {
        if (!onMoveRow || toKey === sectionKey) return;
        const row = draft.find(r => r.id === id);
        if (!row || !String(row.nameEn || '').trim()) return; // unnamed new row — nothing to move
        // Any pending rename in THIS section must land first, or the move
        // transaction reads the server's pre-rename copy of the row.
        flushPendingSave();
        const ok = await onMoveRow(row, sectionKey, toKey);
        if (ok) deleteRow(id, { save: false });
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
                                sectionKey={sectionKey}
                                sections={allSections}
                                onUpdate={(patch) => updateRow(row.id, patch)}
                                onDelete={() => deleteRow(row.id)}
                                onMove={(toKey) => moveRow(row.id, toKey)}
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
    // Alphabetical within the category (Andrew 2026-07-24), by the DISPLAYED
    // name so the EN and ES views are each properly sorted. Edit Mode keeps
    // the stored order on purpose — rows jumping around mid-rename would be
    // maddening — and the sanitizer never persists this sort.
    const components = [...items].sort((a, b) => {
        const an = (isEs ? (a.nameEs || a.nameEn) : a.nameEn) || '';
        const bn = (isEs ? (b.nameEs || b.nameEn) : b.nameEn) || '';
        return an.localeCompare(bn, isEs ? 'es' : 'en', { sensitivity: 'base' });
    }).map((s, i) => ({
        id: s.id || `bs-flat::${kind}::${i}`,
        kind,
        nameEn: s.nameEn,
        nameEs: s.nameEs || s.nameEn,
        descEn: s.descEn || '',
        descEs: s.descEs || '',
        // Carry the per-item shelf lives so the date sticker auto-fills
        // the right use-by (set in the Shelf life table): days, hour-based
        // clocks, and the thawed life for the Fresh/Thawed toggle.
        ...(s.shelfLifeDays ? { shelfLifeDays: s.shelfLifeDays } : {}),
        ...(s.shelfLifeHours ? { shelfLifeHours: s.shelfLifeHours } : {}),
        ...(s.thawedDays ? { thawedDays: s.thawedDays } : {}),
    }));
    // Empty sections still render (2026-07-24) — a brand-new category needs
    // its header + "+ Add item" visible or nobody could put the first item in.
    return (
        <section>
            <h2 className="text-sm font-black uppercase tracking-widest text-dd-text mb-2 px-1">
                {tx(titleEn, titleEs)}
                <span className="ml-2 text-[10px] font-bold text-dd-text-2/60">
                    · {components.length} {tx('printable', 'imprimibles')}
                </span>
            </h2>
            {/* KEPS-style grid (2026-07-24): each cell IS the sticker —
                tap anywhere on it to print. No per-row Print buttons. */}
            <StickerGrid
                components={components}
                toneFor={() => tone}
                isEs={isEs}
                tx={tx}
                onPrint={onPrint}
            />
            {/* Anyone-can-add (Andrew 2026-07-24: "at the end of each
                category there is an add button so anyone can write items
                in and it stays"). Not admin-gated on purpose — a cook who
                spots a missing prep item types it in on the spot; the row
                persists to /config/sticker_lists like any admin edit. */}
            <AddItemCell
                isEs={isEs}
                tx={tx}
                existing={items}
                sectionKey={sectionKey}
                onAdd={onAddItem}
            />
        </section>
    );
});

// ── CategoryEditor — rename categories + add new ones (2026-07-24) ────────
// Renders in Edit Mode above the sections. Local draft; explicit Save button
// (saveSections → doc field `sectionsOverride`) so half-typed titles don't
// stream to every device. Built-in categories always exist (resolveSections
// re-appends any that a save dropped); only custom ones show 🗑, and only
// while their item list is empty — deleting a category must never orphan
// items silently (move or delete the items first).
const SECTION_KIND_CHOICES = [
    ['other', 'Gray'], ['protein', 'Red'], ['topping', 'Green'], ['base', 'Tan'],
    ['sauce', 'Orange'], ['broth', 'Yellow'], ['side', 'Purple'], ['drink', 'Blue'],
    ['chemical', 'Pink'], ['status', 'Bright yellow'],
];
function CategoryEditor({ sections, stickerLists, staffName, isEs, tx }) {
    const [draft, setDraft] = useState(() => sections.map(s => ({ ...s })));
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    // Re-sync from live sections whenever they change UNLESS the admin has
    // unsaved edits (their draft wins until Save/discard).
    useEffect(() => {
        if (!dirty) setDraft(sections.map(s => ({ ...s })));
    }, [sections, dirty]);

    const update = (key, patch) => {
        setDraft(d => d.map(s => (s.key === key ? { ...s, ...patch } : s)));
        setDirty(true);
    };
    const remove = (key) => {
        setDraft(d => d.filter(s => s.key !== key));
        setDirty(true);
    };
    const addCategory = () => {
        const name = window.prompt(tx('New category name (English):', 'Nombre de la nueva categoría (Inglés):'));
        if (!name || !name.trim()) return;
        const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'category';
        let key = `c_${slug}`;
        let n = 2;
        while (draft.some(s => s.key === key)) key = `c_${slug}_${n++}`;
        setDraft(d => [...d, { key, kind: 'other', titleEn: name.trim(), titleEs: name.trim(), defaults: [] }]);
        setDirty(true);
    };
    const save = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await saveSections(draft, staffName);
            setDirty(false);
        } catch (e) {
            console.warn('saveSections failed:', e);
            window.alert(tx('Could not save categories: ', 'No se pudieron guardar: ') + (e?.message || e));
        } finally { setBusy(false); }
    };

    const isBuiltin = (key) => STICKER_SECTIONS.some(b => b.key === key);
    const listCount = (key) => (stickerLists?.[key] || []).length;

    return (
        <div className="mb-3 rounded-xl border-2 border-purple-300 bg-white p-3">
            <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-black uppercase tracking-widest text-purple-800">
                    🗂 {tx('Categories', 'Categorías')}
                </h3>
                {dirty && (
                    <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                        {tx('unsaved changes', 'cambios sin guardar')}
                    </span>
                )}
            </div>
            <div className="space-y-1.5">
                {draft.map((s) => {
                    const tone = COMPONENT_KIND_TONE[s.kind] || COMPONENT_KIND_TONE.other;
                    const builtin = isBuiltin(s.key);
                    const count = listCount(s.key);
                    return (
                        <div key={s.key} className={`flex flex-wrap items-center gap-1.5 rounded-lg ${tone.bg} border border-black/10 p-1.5`}>
                            <input type="text" value={s.titleEn}
                                onChange={(e) => update(s.key, { titleEn: e.target.value })}
                                placeholder={tx('Title (English)', 'Título (Inglés)')}
                                className="flex-1 min-w-[9rem] px-2 py-1.5 text-xs font-bold border border-dd-line rounded bg-white" />
                            <input type="text" value={s.titleEs}
                                onChange={(e) => update(s.key, { titleEs: e.target.value })}
                                placeholder={tx('Title (Spanish)', 'Título (Español)')}
                                className="flex-1 min-w-[9rem] px-2 py-1.5 text-xs border border-dd-line rounded bg-white" />
                            <select value={s.kind} onChange={(e) => update(s.key, { kind: e.target.value })}
                                title={tx('Sticker color', 'Color de etiqueta')}
                                className="flex-shrink-0 px-1 py-1.5 text-[11px] border border-dd-line rounded bg-white">
                                {SECTION_KIND_CHOICES.map(([k, label]) => (
                                    <option key={k} value={k}>{label}</option>
                                ))}
                            </select>
                            <span className="text-[10px] text-dd-text-2 tabular-nums">{count} {tx('items', 'artículos')}</span>
                            {!builtin && (
                                <button type="button"
                                    onClick={() => {
                                        if (count > 0) {
                                            window.alert(tx('Move or delete its items first, then delete the category.',
                                                'Primero mueve o borra sus artículos, luego borra la categoría.'));
                                            return;
                                        }
                                        remove(s.key);
                                    }}
                                    title={tx('Delete category (must be empty)', 'Borrar categoría (debe estar vacía)')}
                                    className="flex-shrink-0 px-2 py-1 rounded-lg bg-red-100 border border-red-300 text-red-700 text-xs active:scale-95">
                                    🗑
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="flex gap-2 mt-2.5">
                <button type="button" onClick={addCategory}
                    className="flex-1 py-2 rounded-lg border-2 border-dashed border-purple-300 text-purple-700 text-xs font-bold hover:bg-purple-50">
                    + {tx('Add category', 'Agregar categoría')}
                </button>
                <button type="button" onClick={save} disabled={!dirty || busy}
                    className="flex-1 py-2 rounded-lg bg-purple-600 text-white text-xs font-bold disabled:opacity-40 active:scale-95">
                    {busy ? tx('Saving…', 'Guardando…') : tx('Save categories', 'Guardar categorías')}
                </button>
            </div>
        </div>
    );
}

// Collapsed "+ Add item" dashed button → tiny inline form (EN + optional ES
// name). Saves the row to the section's live list; the subscription echoes
// it back into the grid (in its alphabetical spot) within a second.
function AddItemCell({ isEs, tx, existing, sectionKey, onAdd }) {
    const [open, setOpen] = useState(false);
    const [nameEn, setNameEn] = useState('');
    const [nameEs, setNameEs] = useState('');
    const [busy, setBusy] = useState(false);
    const save = async () => {
        const en = nameEn.trim();
        if (!en || busy) return;
        // Quick local check (accent/case-insensitive — "Jalapeño" ==
        // "jalapeno"); the transaction re-checks against the live server
        // array, so a race with another device is caught there too.
        if ((existing || []).some(r => stickerNameKey(r.nameEn) === stickerNameKey(en))) {
            window.alert(tx('That item is already in this category.', 'Ese artículo ya está en esta categoría.'));
            return;
        }
        setBusy(true);
        try {
            const outcome = await onAdd(sectionKey, en, nameEs.trim());
            if (outcome === 'duplicate') {
                window.alert(tx('That item is already in this category.', 'Ese artículo ya está en esta categoría.'));
                return;
            }
            if (outcome === 'error') {
                window.alert(tx('Could not save — try again.', 'No se pudo guardar — inténtalo de nuevo.'));
                return;
            }
            setNameEn(''); setNameEs(''); setOpen(false);
        } finally { setBusy(false); }
    };
    if (!open) {
        return (
            <button type="button" onClick={() => setOpen(true)}
                className="mt-2 w-full py-2.5 rounded-xl border-2 border-dashed border-purple-300 text-purple-700 text-xs font-bold hover:bg-purple-50 active:scale-[0.99] transition">
                + {tx('Add item', 'Agregar artículo')}
            </button>
        );
    }
    return (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl border-2 border-purple-300 bg-purple-50/50 p-2">
            <input autoFocus type="text" value={nameEn} onChange={(e) => setNameEn(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && save()}
                placeholder={tx('Item name (English)', 'Nombre (Inglés)')}
                className="flex-1 min-w-[8rem] px-2 py-2 text-sm font-bold border border-dd-line rounded-lg bg-white" />
            <input type="text" value={nameEs} onChange={(e) => setNameEs(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && save()}
                placeholder={tx('Spanish (optional)', 'Español (opcional)')}
                className="flex-1 min-w-[8rem] px-2 py-2 text-sm border border-dd-line rounded-lg bg-white" />
            <button type="button" onClick={save} disabled={!nameEn.trim() || busy}
                className="px-3 py-2 rounded-lg bg-purple-600 text-white text-xs font-bold disabled:opacity-40 active:scale-95">
                {busy ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
            </button>
            <button type="button" onClick={() => { setOpen(false); setNameEn(''); setNameEs(''); }}
                className="px-2.5 py-2 rounded-lg bg-white border border-dd-line text-dd-text-2 text-xs font-bold active:scale-95">
                ✕
            </button>
        </div>
    );
}

// Normalize rows for the edit form: guarantee the four editable fields +
// id, but PRESERVE everything else on the row (spread first). Stripping to
// only the editable fields silently wiped `shelfLifeDays` for the whole
// section on every Edit-Mode save — the admin would fill the Shelf life
// table, fix one typo in Edit Mode, and lose all of it (audit 2026-07-26
// finding 1; this predates v317 and likely caused "most of them were
// wrong"). Generates an id if the source row lacks one.
function normalizeForEdit(items) {
    return (Array.isArray(items) ? items : []).map((row, i) => ({
        ...row,
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
// get appended. Best-effort — no MVCC, last write wins on conflicts.
//
// 2026-05-24 fix: pass `deletedIds` so a row the user just deleted
// locally doesn't reappear on the next subscription tick before our
// save has propagated. Without this, deleteRow → 600ms debounce →
// subscription fires with stale items[] → the deleted row is
// resurrected into draft, confusing the user.
function mergeDrafts(draft, incoming, deletedIds) {
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
    // Any incoming rows not in draft = new from another device …
    // UNLESS the user just deleted that id locally and the save is
    // still in flight. In that case the incoming row is the stale
    // pre-delete version — skip it.
    for (const i of incomingById.values()) {
        if (deletedIds && deletedIds.has(i.id)) continue;
        out.push(i);
    }
    return out;
}

// One inline-edit row. Name EN + Name ES side by side, with a
// trash button at the right.
function EditableFlatRow({ row, tone, isEs, tx, sectionKey, sections = STICKER_SECTIONS, onUpdate, onDelete, onMove }) {
    return (
        // flex-WRAP + real min widths (Andrew 2026-07-26 — "when we edit
        // the item names and they are longer its difficult since the
        // window is small"): on phones the two name inputs + mover +
        // trash used to split one row six ways, leaving each input a few
        // characters wide. Now an input claims at least ~11rem and the
        // controls wrap to a second line when the row runs out of room.
        <div className={`flex flex-wrap items-stretch gap-1.5 rounded-lg ${tone.bg} border border-dd-line p-1.5`}>
            <input
                type="text"
                value={row.nameEn}
                onChange={(e) => onUpdate({ nameEn: e.target.value })}
                placeholder={tx('Name (English)', 'Nombre (Inglés)')}
                className="flex-1 min-w-[11rem] px-2 py-1.5 text-sm font-bold border border-dd-line rounded bg-white"
            />
            <input
                type="text"
                value={row.nameEs}
                onChange={(e) => onUpdate({ nameEs: e.target.value })}
                placeholder={tx('Name (Spanish)', 'Nombre (Español)')}
                className="flex-1 min-w-[11rem] px-2 py-1.5 text-sm border border-dd-line rounded bg-white"
            />
            {/* Category mover (Andrew 2026-07-24) — pick a different category
                and the row jumps there (saves live to both sections). Shows
                the short chip labels; current category selected. */}
            {onMove && (
                <select
                    value={sectionKey}
                    onChange={(e) => { if (e.target.value !== sectionKey) onMove(e.target.value); }}
                    title={tx('Move to another category', 'Mover a otra categoría')}
                    aria-label={tx('Move to another category', 'Mover a otra categoría')}
                    className="flex-shrink-0 w-[86px] px-1 py-1.5 text-[11px] border border-dd-line rounded bg-white text-dd-text"
                >
                    {sections.map((s) => (
                        <option key={s.key} value={s.key}>
                            {sectionChipLabel(s, isEs)}
                        </option>
                    ))}
                </select>
            )}
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
    // 2026-07-26 audit: the newer kinds fell through to 'Other' implicitly;
    // explicit entries so a future category-default change can't surprise.
    drink:    'Other',
    other:    'Other',
    chemical: 'Other',
    status:   'Other',
});

// Stable tone lookup for the search-results grid (identity-stable so the
// memo'd StickerGrid/StickerCell props don't churn per render).
const searchToneFor = (c) => COMPONENT_KIND_TONE[c.kind] || COMPONENT_KIND_TONE.side;
