// Menu-item build resolver — what's IN every menu item.
//
// Andrew 2026-05-20 — "Date Sticker Printer page... staff should
// search/select a menu item, prep item, sauce, protein, drink,
// dessert, or batch recipe, and the app should generate the correct
// date sticker label."
//
// This module unifies two sources of truth:
//   • src/data/menu.js          — customer-facing items (names + allergens + price)
//   • src/data/buildSheet.js    — what's IN each item (base, toppings, proteins, notes)
//
// Phase 1: a flat resolver — given a menu item name, return its build
// as a unified array of components (base, topping, protein, sauce,
// note) each with EN/ES labels + allergens carried through.
//
// Future phases (queued — not in this build):
//   • Recursive getFullItemBuild(itemId) — walk sub-recipes
//     (e.g. "Peanut Sauce" → masterRecipes['Peanut Sauce'].ingredients)
//   • Shelf-life registry at /config/shelf_life/{itemId} — per-item
//     override stored in Firestore so kitchen can edit defaults.
//     Missing entry → component renders with a "Manager review
//     required" badge and Print is gated until admin sets days.
//   • Editable build sheets at /config/build_sheet/{menuItemId} —
//     admin override that takes precedence over the static JS file.

import { MENU_DATA } from './menu';
import {
    BUILD_SHEET_BOWLS,
    BUILD_SHEET_HANDHELDS,
    BUILD_SHEET_FRIED_RICE,
    BUILD_SHEET_PHO,
    BUILD_SHEET_SAUCES,
    BUILD_SHEET_SNACKS,
} from './buildSheet';
import { MASTER_RECIPES } from './masterRecipes';

// Component kinds we render — drives the icon + tone in the UI.
export const COMPONENT_KIND = Object.freeze({
    BASE:    'base',
    TOPPING: 'topping',
    PROTEIN: 'protein',
    SAUCE:   'sauce',
    BROTH:   'broth',
    NOTE:    'note',
    SIDE:    'side',
    GARNISH: 'garnish',
});

// Stable id helper. We don't have ids on the static JS objects so we
// derive a slug from the English name. Same name → same id.
function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

// Map BUILD_SHEET_BOWLS / HANDHELDS / etc. into a uniform lookup
// keyed by lowercased name fragments. We use STARTSWITH + INCLUDES
// against the menu item's name so e.g. "Salmon Bowl" matches
// BUILD_SHEET_BOWLS["Vermicelli Bowl" | "Salad Bowl" | "Rice Bowl"]
// for the base+topping rules. Bowl style is then derived from the
// menu item name itself (e.g. "Salmon Bowl" → rice/vermicelli/salad
// are all valid; we surface ALL three bases as printable.)
const BOWL_STYLES = ['Vermicelli', 'Salad', 'Rice'];

function findBowlBuilds() {
    // Return a map keyed by lowercased name → bowl build object.
    const out = {};
    for (const b of BUILD_SHEET_BOWLS) {
        out[b.nameEn.toLowerCase()] = b;
    }
    return out;
}
function findHandheldBuild(name) {
    const lc = name.toLowerCase();
    return BUILD_SHEET_HANDHELDS.find(h =>
        lc.includes(h.nameEn.toLowerCase())
        || h.nameEn.toLowerCase().includes(lc)
    );
}
function findSauce(name) {
    const lc = name.toLowerCase();
    return BUILD_SHEET_SAUCES.find(s =>
        s.nameEn.toLowerCase() === lc
        || lc.includes(s.nameEn.toLowerCase())
    );
}

// Resolve a single menu-item's component list. Returns:
//   {
//     menuItem: { id, nameEn, nameEs, category, allergens, ... },
//     components: [{ id, kind, nameEn, nameEs, descEn?, descEs?,
//                    allergens?, shelfLifeDays? }],
//     unresolved: [string] // names we couldn't tie to a build entry
//   }
export function getMenuItemBuild(menuItemNameEn) {
    if (!menuItemNameEn) return { menuItem: null, components: [], unresolved: [] };

    // Find the menu entry across all categories.
    let menuItem = null;
    let categoryName = '';
    let categoryNameEs = '';
    for (const cat of MENU_DATA) {
        for (const item of (cat.items || [])) {
            if (item.nameEn === menuItemNameEn) {
                menuItem = item;
                categoryName = cat.category;
                categoryNameEs = cat.categoryEs;
                break;
            }
        }
        if (menuItem) break;
    }
    if (!menuItem) return { menuItem: null, components: [], unresolved: [] };

    const components = [];
    const unresolved = [];
    const seen = new Set();
    const push = (kind, nameEn, nameEs, extra = {}) => {
        const id = `${slugify(menuItemNameEn)}::${kind}::${slugify(nameEn)}`;
        if (seen.has(id)) return;
        seen.add(id);
        components.push({
            id, kind, nameEn, nameEs: nameEs || nameEn,
            ...extra,
        });
    };

    const catLower = categoryName.toLowerCase();
    const nameLower = menuItemNameEn.toLowerCase();

    // ── Bowls ──────────────────────────────────────────────────
    if (catLower === 'bowls') {
        // All three bowl styles share the same topping pattern with
        // small variants. Surface every style as a printable BASE so
        // the cook can pick which one they prepped.
        const bowlBuilds = findBowlBuilds();
        const variants = [
            bowlBuilds['vermicelli bowl'],
            bowlBuilds['salad bowl'],
            bowlBuilds['rice bowl'],
        ].filter(Boolean);

        for (const b of variants) {
            if (b.baseEn) {
                push(COMPONENT_KIND.BASE, b.baseEn, b.baseEs, { variant: b.nameEn });
            }
        }
        // Toppings — dedup across variants. Default to Vermicelli's
        // list (it's the most complete for non-rice styles).
        const merged = new Set();
        for (const b of variants) {
            for (const t of (b.standardToppings || [])) {
                if (merged.has(t.en)) continue;
                merged.add(t.en);
                push(COMPONENT_KIND.TOPPING, t.en, t.es);
            }
        }
        // Protein — surface the menu item's protein as a component
        // since each bowl carries it in the name (e.g. Salmon Bowl).
        if (menuItem.descEn) {
            push(COMPONENT_KIND.PROTEIN,
                stripPrice(menuItem.nameEn),
                stripPrice(menuItem.nameEs || menuItem.nameEn),
                { allergens: menuItem.allergens });
        }
        // Sauces — bowls come with a choice of sauce.
        for (const s of BUILD_SHEET_SAUCES) {
            push(COMPONENT_KIND.SAUCE, s.nameEn, s.nameEs, {
                descEn: s.descEn, descEs: s.descEs,
            });
        }
        // Notes from the first available variant — same across all.
        if (variants[0]) {
            for (const n of (variants[0].notes || [])) {
                push(COMPONENT_KIND.NOTE, n.en, n.es);
            }
        }
    }

    // ── Pho ────────────────────────────────────────────────────
    else if (catLower === 'pho' || nameLower.includes('pho')) {
        // Toppings + garnish plate
        for (const t of (BUILD_SHEET_PHO.standardToppings || [])) {
            push(COMPONENT_KIND.TOPPING, t.en, t.es);
        }
        // Broths
        for (const br of (BUILD_SHEET_PHO.broths || [])) {
            push(COMPONENT_KIND.BROTH, br.nameEn, br.nameEs);
        }
        // Protein — pull from this specific pho item's name +
        // description.
        push(COMPONENT_KIND.PROTEIN,
            stripPrice(menuItem.nameEn),
            stripPrice(menuItem.nameEs || menuItem.nameEn),
            { allergens: menuItem.allergens });
    }

    // ── Fried Rice ─────────────────────────────────────────────
    else if (catLower === 'fried rice' || nameLower.includes('fried rice')) {
        push(COMPONENT_KIND.BASE, 'Jasmine rice (cooked)', 'Arroz jazmín cocido');
        for (const t of (BUILD_SHEET_FRIED_RICE.standardToppings || [])) {
            push(COMPONENT_KIND.TOPPING, t.en, t.es);
        }
        push(COMPONENT_KIND.PROTEIN,
            stripPrice(menuItem.nameEn),
            stripPrice(menuItem.nameEs || menuItem.nameEn),
            { allergens: menuItem.allergens });
        for (const n of (BUILD_SHEET_FRIED_RICE.notes || [])) {
            push(COMPONENT_KIND.NOTE, n.en, n.es);
        }
    }

    // ── Handhelds (Banh Mi / etc.) ────────────────────────────
    else if (catLower === 'handhelds' || catLower === 'sandwiches') {
        const h = findHandheldBuild(menuItemNameEn);
        if (h) {
            if (h.bunEn) push(COMPONENT_KIND.BASE, h.bunEn, h.bunEs);
            for (const t of (h.standardToppings || [])) {
                push(COMPONENT_KIND.TOPPING, t.en, t.es);
            }
            for (const s of (h.spreads || [])) {
                push(COMPONENT_KIND.SAUCE, s.en, s.es);
            }
            push(COMPONENT_KIND.PROTEIN,
                stripPrice(menuItem.nameEn),
                stripPrice(menuItem.nameEs || menuItem.nameEn),
                { allergens: menuItem.allergens });
            for (const n of (h.notes || [])) {
                push(COMPONENT_KIND.NOTE, n.en, n.es);
            }
        } else {
            push(COMPONENT_KIND.PROTEIN,
                stripPrice(menuItem.nameEn),
                stripPrice(menuItem.nameEs || menuItem.nameEn),
                { allergens: menuItem.allergens });
            unresolved.push(menuItemNameEn);
        }
    }

    // ── Snacks / Sides / Drinks / Desserts ───────────────────
    else if (catLower === 'snacks' || catLower === 'sides') {
        // Just the item itself — kitchen prepares it as a unit,
        // single sticker covers it.
        push(COMPONENT_KIND.SIDE,
            stripPrice(menuItem.nameEn),
            stripPrice(menuItem.nameEs || menuItem.nameEn),
            { allergens: menuItem.allergens });
    }
    else if (catLower === 'sauces' || nameLower.includes('sauce') || nameLower.includes('dressing')) {
        const s = findSauce(menuItemNameEn);
        push(COMPONENT_KIND.SAUCE,
            stripPrice(menuItem.nameEn),
            stripPrice(menuItem.nameEs || menuItem.nameEn),
            {
                descEn: s?.descEn,
                descEs: s?.descEs,
                allergens: menuItem.allergens,
            });
    }
    else {
        // Drinks / desserts / catering / anything else — single-
        // component default.
        push(COMPONENT_KIND.SIDE,
            stripPrice(menuItem.nameEn),
            stripPrice(menuItem.nameEs || menuItem.nameEn),
            { allergens: menuItem.allergens });
    }

    return {
        menuItem: {
            ...menuItem,
            id: slugify(menuItem.nameEn),
            category: categoryName,
            categoryEs: categoryNameEs,
        },
        components,
        unresolved,
    };
}

// Strip a leading dollar amount + extras that snuck into the name
// (rare but defensive). Doesn't change names like "Banh Mi #5".
function stripPrice(s) {
    return String(s || '').replace(/^\$\s*\d+(\.\d+)?\s*[-:]?\s*/, '').trim();
}

// All menu items across categories, flat. Feeds the search bar +
// the top-level browse list. Items keep a reference to their category
// so the UI can group on render.
export function getAllMenuItems() {
    const out = [];
    for (const cat of MENU_DATA) {
        for (const item of (cat.items || [])) {
            out.push({
                ...item,
                id: slugify(item.nameEn),
                category: cat.category,
                categoryEs: cat.categoryEs,
            });
        }
    }
    return out;
}

// ── Category component aggregator ─────────────────────────────
// Andrew 2026-05-20: "in the day stickers window in the bowls we
// dont need all the bowls listed like this. make it vermicelli
// noodles, salad, rice, list the protiens, toppings."
//
// Aggregates components ACROSS every item in a category. The Date
// Sticker Printer page uses this to render each category as a card
// of grouped components (bases / proteins / toppings / sauces) —
// what the kitchen actually preps in batches — instead of listing
// every menu item individually.
//
// For categories without a build sheet (Snacks, Drinks, Sweets),
// falls back to the menu items themselves as printable rows since
// each item is its own batch.
//
// Returns:
//   {
//     category: 'Bowls',
//     categoryEs: 'Bowls',
//     byKind: {
//       base:    [{ id, kind, nameEn, nameEs, usedIn:[itemName...] }],
//       protein: [...],
//       topping: [...],
//       sauce:   [...],
//       broth:   [...],   // only for Pho
//       garnish: [...],
//       side:    [...],
//       note:    [...],   // shown but not printable
//       item:    [...],   // fallback for build-sheet-less categories
//     }
//   }
export function getCategoryComponents(categoryName) {
    if (!categoryName) return null;
    const cat = MENU_DATA.find(c => c.category === categoryName);
    if (!cat) return null;

    const byKind = {};
    const seen = new Map();   // key → entry, so we can merge usedIn
    const push = (kind, nameEn, nameEs, extra = {}) => {
        const key = `${kind}::${normalizeName(nameEn)}`;
        if (seen.has(key)) {
            const entry = seen.get(key);
            for (const u of (extra.usedIn || [])) {
                if (!entry.usedIn.includes(u)) entry.usedIn.push(u);
            }
            return;
        }
        const entry = {
            id: `cat::${slugify(categoryName)}::${kind}::${slugify(nameEn)}`,
            kind,
            nameEn,
            nameEs: nameEs || nameEn,
            usedIn: extra.usedIn || [],
            allergens: extra.allergens || '',
            ...(extra.descEn ? { descEn: extra.descEn } : {}),
            ...(extra.descEs ? { descEs: extra.descEs } : {}),
        };
        seen.set(key, entry);
        if (!byKind[kind]) byKind[kind] = [];
        byKind[kind].push(entry);
    };

    for (const item of (cat.items || [])) {
        const build = getMenuItemBuild(item.nameEn);
        if (build.components.length === 0) {
            // No build sheet for this item — surface the item itself
            // as a printable row (Snacks / Drinks / Sweets fall here).
            push('item', item.nameEn, item.nameEs, {
                allergens: item.allergens,
                descEn: item.descEn,
                descEs: item.descEs,
                usedIn: [item.nameEn],
            });
            continue;
        }
        for (const c of build.components) {
            push(c.kind, c.nameEn, c.nameEs, {
                allergens: c.allergens,
                descEn: c.descEn,
                descEs: c.descEs,
                usedIn: [item.nameEn],
            });
        }
    }

    return {
        category: cat.category,
        categoryEs: cat.categoryEs,
        byKind,
    };
}

// All categories aggregated. Convenience for the Date Sticker Printer
// to render every category card without N calls.
export function getAllCategoryComponents() {
    return MENU_DATA.map(cat => getCategoryComponents(cat.category)).filter(Boolean);
}

// ── Shared vs category-specific component split ────────────────
// Andrew 2026-05-20: "but bowls, sliders and rolls, tacos, all
// share the same protiens". The kitchen preps ONE pot of pork and
// it serves bowls, banh mi, sliders, tacos. Listing "Pork" under
// each category's protein section was duplicative noise.
//
// This function partitions components by KIND:
//   • protein / sauce  → globally shared. Aggregated once at top,
//     deduplicated by name. Carries `usedInCategories` for the UI
//     to show "used in: Bowls · Bánh Mì · Tacos" hint chips.
//   • base / topping / garnish / broth / side / item / note
//     → category-specific. Rice noodles belong to Pho, vermicelli
//     to Bowls, etc. Stay nested inside each category card.
//
// Returns:
//   {
//     shared: {
//       protein: [{ id, kind, nameEn, nameEs, usedInCategories: [...], allergens }],
//       sauce:   [...],
//     },
//     categories: [
//       { category: 'Bowls', categoryEs: 'Bowls', byKind: { base: [...], topping: [...] } },
//       ...
//     ]
//   }
const SHARED_KINDS = new Set(['protein', 'sauce']);

export function getGlobalComponentSections() {
    const sharedMaps = new Map();   // kind → Map<normalizedName, entry>
    const categories = [];

    for (const cat of MENU_DATA) {
        const catBuild = getCategoryComponents(cat.category);
        if (!catBuild) continue;

        const localByKind = {};
        for (const [kind, items] of Object.entries(catBuild.byKind)) {
            if (SHARED_KINDS.has(kind)) {
                if (!sharedMaps.has(kind)) sharedMaps.set(kind, new Map());
                const sharedMap = sharedMaps.get(kind);
                for (const item of items) {
                    const key = normalizeName(item.nameEn);
                    if (sharedMap.has(key)) {
                        const existing = sharedMap.get(key);
                        if (!existing.usedInCategories.includes(cat.category)) {
                            existing.usedInCategories.push(cat.category);
                        }
                    } else {
                        sharedMap.set(key, {
                            ...item,
                            usedInCategories: [cat.category],
                        });
                    }
                }
            } else {
                localByKind[kind] = items;
            }
        }
        // Only include the category in the per-category list if it
        // has at least one non-shared component. A category whose
        // entire build was shared (rare) would otherwise render as
        // an empty card.
        if (Object.keys(localByKind).length > 0) {
            categories.push({
                category: cat.category,
                categoryEs: cat.categoryEs,
                byKind: localByKind,
            });
        }
    }

    const shared = {};
    for (const [kind, map] of sharedMaps.entries()) {
        shared[kind] = Array.from(map.values());
    }
    return { shared, categories };
}

// ── Searchable index — every menu item AND every component ────────
//
// Andrew 2026-05-20 — "also make a search bar for everything and add
// the ai to help optimize the search. for example if i type pho it
// will pop up all phos and the ingredents, rare steak for pho and
// etc."
//
// Returns a flat array of search-targetable rows. Two kinds:
//   • menuItem  — a full menu entry (category: Bowls, Pho, etc.)
//   • component — a deduped component across all menu items, with
//                 `usedIn: [menuItemName...]` listing every menu
//                 item that has it. This is the "rare steak" row
//                 that surfaces when you type "pho".
//
// Component dedup key: (componentKind, normalized-name). Cilantro
// shows up once even though it's in 20+ menu items; we list its
// parents under `usedIn` so the UI can show "Used in: Bowls · Pho
// · Fried Rice". The AI subcat field also packs `usedIn` so Claude
// learns "rare steak is a pho thing" without needing the literal
// word "pho" in the name.
export function getSearchableIndex() {
    const out = [];
    const seenItems = new Set();
    const componentMap = new Map(); // key -> component entry

    for (const item of getAllMenuItems()) {
        if (seenItems.has(item.id)) continue;
        seenItems.add(item.id);
        out.push({
            id: `mi::${item.id}`,
            kind: 'menuItem',
            menuItemId: item.id,
            nameEn: item.nameEn,
            nameEs: item.nameEs || item.nameEn,
            category: item.category,
            categoryEs: item.categoryEs,
            descEn: item.descEn,
            descEs: item.descEs,
            allergens: item.allergens,
            price: item.price,
            usedIn: [],
        });

        // Resolve this item's build + collect / dedup components.
        const build = getMenuItemBuild(item.nameEn);
        for (const c of build.components) {
            if (c.kind === 'note') continue; // notes aren't printable
            const key = `${c.kind}::${normalizeName(c.nameEn)}`;
            if (!componentMap.has(key)) {
                componentMap.set(key, {
                    id: `cp::${key}`,
                    kind: 'component',
                    componentKind: c.kind,
                    nameEn: c.nameEn,
                    nameEs: c.nameEs || c.nameEn,
                    descEn: c.descEn || '',
                    descEs: c.descEs || '',
                    usedIn: [],
                    usedInEs: [],
                });
            }
            const entry = componentMap.get(key);
            // Track every menu item that uses this component (dedup).
            if (!entry.usedIn.includes(item.nameEn)) {
                entry.usedIn.push(item.nameEn);
                entry.usedInEs.push(item.nameEs || item.nameEn);
            }
        }
    }
    for (const c of componentMap.values()) {
        out.push(c);
    }
    return out;
}

// Build the AI-search items array from the searchable index. This
// is what gets sent to the aiSearch Cloud Function. We pack the
// component's parents into `subcat` so Claude can reason about "pho
// → rare steak" without needing the literal word "pho" in the
// component name. Trimmed to keep token cost low.
export function getAiSearchItems() {
    const idx = getSearchableIndex();
    return idx.map(row => {
        if (row.kind === 'menuItem') {
            return {
                id: row.id,
                name: row.nameEn,
                category: row.category || '',
                // Pack short description + allergens so semantic
                // searches like "vegan" / "spicy" reason correctly.
                subcat: [
                    row.descEn || '',
                    row.allergens || '',
                ].filter(Boolean).join(' | ').slice(0, 180),
            };
        }
        // Component — subcat carries the kind + truncated parents list.
        return {
            id: row.id,
            name: row.nameEn,
            category: COMPONENT_KIND_TONE[row.componentKind]?.labelEn || row.componentKind,
            subcat: [
                row.descEn || '',
                row.usedIn.slice(0, 6).join(', '),
            ].filter(Boolean).join(' | ').slice(0, 180),
        };
    });
}

// Cheap normalize for dedup keys — same shape as recipeSearch's
// helper but inlined so itemBuild stays self-contained.
function normalizeName(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── Recursive sub-recipe resolver ─────────────────────────────────
//
// Andrew 2026-05-20 Phase 2: "Recursive getFullItemBuild() walks
// sub-recipes (sauce -> recipe -> ingredients tree)".
//
// Given a component (typically a sauce or broth), tries to find a
// matching recipe in MASTER_RECIPES. If found, returns the recipe's
// top-level ingredients as a list of "sub-components" the cook can
// also print labels for. Example: Vermicelli Bowl -> sauce: Vietnamese
// Vinaigrette -> sub-recipe finds the vinaigrette in MASTER_RECIPES ->
// returns: Fish sauce, Sugar, Vinegar, Hot water, Thai chili, Garlic,
// Sambal — each individually printable.
//
// Matching is fuzzy: exact title match first, then includes-substring
// in either direction. Keeps "Peanut Dressing" finding "Peanut Sauce"
// or vice versa.
//
// Returns:
//   { recipe, ingredients: [{ nameEn, nameEs }] }  on match
//   null                                            on no match
export function findSubRecipe(componentNameEn) {
    if (!componentNameEn) return null;
    const target = normalizeName(componentNameEn);
    if (!target) return null;
    let best = null;
    for (const r of MASTER_RECIPES) {
        const rname = normalizeName(r.titleEn);
        if (!rname) continue;
        if (rname === target) { best = r; break; }
        if (!best && (rname.includes(target) || target.includes(rname))) {
            best = r;
        }
    }
    if (!best) return null;
    const ingredientsEn = Array.isArray(best.ingredientsEn) ? best.ingredientsEn : [];
    const ingredientsEs = Array.isArray(best.ingredientsEs) ? best.ingredientsEs : ingredientsEn;
    // Strip leading qty + unit so the label says "fish sauce" not
    // "4 bottles fish sauce". Same trick labelPrinting.js uses.
    const stripQty = (line) => {
        const m = String(line).match(/^(?:\d+\s*[/\-]?\s*\d*\s*\w{0,12}\s*)?(.*)$/);
        return ((m && m[1]) || line || '').trim();
    };
    const ingredients = ingredientsEn.map((en, i) => ({
        nameEn: stripQty(en).slice(0, 80) || en,
        nameEs: stripQty(ingredientsEs[i] || en).slice(0, 80) || en,
    })).filter(x => x.nameEn);
    return {
        recipe: best,
        ingredients,
        allergens: Array.isArray(best.allergens) ? best.allergens : [],
        shelfLifeDays: best.shelfLifeDays || null,
    };
}

// Tone tokens for the UI per component kind.
export const COMPONENT_KIND_TONE = Object.freeze({
    base:    { bg: 'bg-amber-50',   text: 'text-amber-900',   icon: '🍚', labelEn: 'Base',     labelEs: 'Base' },
    topping: { bg: 'bg-green-50',   text: 'text-green-900',   icon: '🥬', labelEn: 'Topping',  labelEs: 'Topping' },
    protein: { bg: 'bg-red-50',     text: 'text-red-900',     icon: '🍤', labelEn: 'Protein',  labelEs: 'Proteína' },
    sauce:   { bg: 'bg-orange-50',  text: 'text-orange-900',  icon: '🥣', labelEn: 'Sauce',    labelEs: 'Salsa' },
    broth:   { bg: 'bg-yellow-50',  text: 'text-yellow-900',  icon: '🍲', labelEn: 'Broth',    labelEs: 'Caldo' },
    side:    { bg: 'bg-purple-50',  text: 'text-purple-900',  icon: '🍙', labelEn: 'Item',     labelEs: 'Artículo' },
    garnish: { bg: 'bg-emerald-50', text: 'text-emerald-900', icon: '🌿', labelEn: 'Garnish',  labelEs: 'Guarnición' },
    note:    { bg: 'bg-blue-50',    text: 'text-blue-900',    icon: 'ℹ️', labelEn: 'Note',     labelEs: 'Nota' },
});
