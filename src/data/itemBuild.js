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
