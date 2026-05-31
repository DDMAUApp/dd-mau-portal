// Menu config — SaaS-ready, Firestore-backed source of truth for
// the menu, brand identity, and build sheet.
//
// ── Why this exists ────────────────────────────────────────────────
// Today (pre-2026-05-30) the menu is hardcoded in `src/data/menu.js`
// as a 246-line MENU_DATA array, with the same shape for the build
// sheet (`src/data/buildSheet.js`) and the restaurant branding
// strings (literal "DD MAU" / "Vietnamese Fast Casual" / "Webster"
// scattered across MenuDisplay + headers). That means every change
// requires a code edit + git push + GitHub Pages deploy — fine for
// DD Mau (we own the codebase), but a non-starter for SaaS sales:
// each new tenant would need their own fork of the repo.
//
// This module moves that data to Firestore docs so an admin can edit
// every part of the menu through a UI, and so a future SaaS install
// just gets pointed at a fresh Firestore project + initial config
// docs — no code changes needed.
//
// ── Phase 1 plan (the work we're shipping in chunks) ────────────────
//   1.A (this file) — schema, hooks, slug helpers, one-shot migration
//                     of legacy hardcoded data to Firestore. NO UI
//                     changes; existing menu views continue to render
//                     the hardcoded data because the hooks fall back
//                     to legacy when the Firestore doc is empty.
//   1.B  — full menu editor: CRUD items + categories, drag-reorder,
//          draft → publish flow, audit log per save.
//   1.C  — brand editor (restaurant name, cuisine, location labels).
//   1.D  — build sheet editor (toppings, broths, sauces, etc.).
//   1.E  — migrate the 9 MENU_DATA importers to use these hooks so
//          we can deprecate the hardcoded fallback.
//
// ── Tenant-isolation hook (for Phase 2 multi-tenant) ────────────────
// The single function `tenantConfigPath()` is the choke point. Today
// it returns 'config/menu_v2' (single-tenant white-label). For
// multi-tenant SaaS, swap that to 'tenants/<tid>/config/menu_v2'
// and every reader/writer in the app picks up the change for free.
// Same pattern for brand + build sheet.

import { useEffect, useState, useMemo } from 'react';
import { db } from '../firebase';
import {
    doc, getDoc, setDoc, onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { MENU_DATA } from './menu';
import {
    BUILD_SHEET_BOWLS, BUILD_SHEET_HANDHELDS, BUILD_SHEET_FRIED_RICE,
    BUILD_SHEET_PHO, BUILD_SHEET_SAUCES, BUILD_SHEET_SNACKS,
} from './buildSheet';

// ── Document paths ────────────────────────────────────────────────
// Single source of truth so the multi-tenant migration is a one-
// liner. Today: 'config/menu_v2'. Tomorrow (multi-tenant):
// 'tenants/<tid>/config/menu_v2' — every caller in the codebase
// picks up the change for free.
export const MENU_CONFIG_PATH       = 'config/menu_v2';
export const BRAND_CONFIG_PATH      = 'config/brand';
export const BUILD_SHEET_PATH       = 'config/build_sheet';

// ── Schema version ────────────────────────────────────────────────
// Bump whenever the shape of a doc changes incompatibly. Loaders
// log a warning if they read a doc with a newer schemaVersion than
// they understand so we catch missed code-update windows.
export const MENU_CONFIG_SCHEMA_VERSION  = 1;
export const BRAND_CONFIG_SCHEMA_VERSION = 1;
export const BUILD_SHEET_SCHEMA_VERSION  = 1;

// ── Slug helpers ──────────────────────────────────────────────────
// All identity in the new schema is by slug, not by display name.
// Stable across renames; never reparsed from name at runtime.
//
// Why category + item compound slugs?
//   - DD Mau today has name collisions across categories (e.g. bare
//     "Shrimp" in Sliders & Rolls vs "Shrimp Bowl" in Bowls would
//     fight if items used name-only slugs and one was renamed).
//   - Compound slugs (`sliders-rolls/shrimp`) are guaranteed
//     globally unique without per-category lookup.
//   - Self-documenting in the Firestore console.
export function slugifyText(s) {
    return String(s || '')
        .normalize('NFD')
        // Strip combining diacritics (Bánh Mì → Banh Mi).
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'untitled';
}

export function makeCategorySlug(nameEn) {
    return slugifyText(nameEn);
}

export function makeItemSlug(categorySlug, nameEn) {
    const item = slugifyText(nameEn);
    if (!categorySlug) return item;
    // Compound key: catslug/itemslug, but stored as
    // 'catslug-itemslug' to keep it path-safe.
    return `${categorySlug}-${item}`.slice(0, 96);
}

// ── Legacy → v2 converters ────────────────────────────────────────
// The old hardcoded shape (MENU_DATA array of category objects with
// `items` arrays) maps cleanly to the new v2 shape — we just need
// to assign slugs + explicit order fields. Same items, new keys.

/**
 * Convert hardcoded MENU_DATA → v2 categories array.
 * Deterministic so re-running with the same input yields the same
 * slugs, which means re-migration is safe (idempotent).
 */
export function legacyMenuToV2(legacyData = MENU_DATA) {
    return (legacyData || []).map((cat, ci) => {
        const catSlug = makeCategorySlug(cat.category);
        return {
            id:           catSlug,
            nameEn:       cat.category || '',
            nameEs:       cat.categoryEs || cat.category || '',
            noteEn:       cat.note || '',
            noteEs:       cat.noteEs || '',
            customizable: Array.isArray(cat.customizable) ? [...cat.customizable] : [],
            order:        ci,
            archived:     false,
            items: (cat.items || []).map((it, ii) => ({
                id:         makeItemSlug(catSlug, it.nameEn),
                nameEn:     it.nameEn || '',
                nameEs:     it.nameEs || '',
                nameVi:     it.nameVi || '',
                price:      it.price || '',
                descEn:     it.descEn || '',
                descEs:     it.descEs || '',
                allergens:  it.allergens || '',
                spicy:      !!it.spicy,
                vegan:      !!it.vegan,
                glutenFree: !!it.glutenFree,
                popular:    !!it.popular,
                photoUrl:   '',
                order:      ii,
                archived:   false,
            })),
        };
    });
}

/**
 * Convert hardcoded build sheet exports → v2 sections shape.
 * Each section is a slugged list of items in the same order.
 */
export function legacyBuildSheetToV2() {
    const sectionFor = (legacyArr, sectionSlug) => (legacyArr || []).map((it, i) => ({
        id:               makeItemSlug(sectionSlug, it.nameEn),
        nameEn:           it.nameEn || '',
        nameEs:           it.nameEs || '',
        baseEn:           it.baseEn || '',
        baseEs:           it.baseEs || '',
        standardToppings: Array.isArray(it.standardToppings) ? [...it.standardToppings] : [],
        notes:            Array.isArray(it.notes) ? [...it.notes] : [],
        piecesByProtein:  it.piecesByProtein && typeof it.piecesByProtein === 'object'
            ? { ...it.piecesByProtein } : {},
        order:            i,
        archived:         false,
    }));
    return {
        bowls:      sectionFor(BUILD_SHEET_BOWLS,      'bowls'),
        handhelds:  sectionFor(BUILD_SHEET_HANDHELDS,  'handhelds'),
        friedRice:  sectionFor(BUILD_SHEET_FRIED_RICE, 'fried-rice'),
        pho:        sectionFor(BUILD_SHEET_PHO,        'pho'),
        sauces:     sectionFor(BUILD_SHEET_SAUCES,     'sauces'),
        snacks:     sectionFor(BUILD_SHEET_SNACKS,     'snacks'),
    };
}

// ── Default brand fallback ────────────────────────────────────────
// Used when /config/brand is missing or fails to load (cold boot,
// permission error, etc.). DD Mau values today; a SaaS install
// would have a similar file with their own defaults, OR seed the
// doc on first launch.
export const DEFAULT_BRAND = {
    schemaVersion:   BRAND_CONFIG_SCHEMA_VERSION,
    restaurantName:   'DD MAU',
    restaurantNameEs: 'DD MAU',
    cuisineTypeEn:    'Vietnamese Fast Casual',
    cuisineTypeEs:    'Comida Rápida Vietnamita',
    // Per-location display labels. Keys MUST match the location
    // codes the app uses (webster, maryland). To add a new location
    // for SaaS, add the key here + register the matching ops
    // collections (see CLAUDE.md "Two locations" section).
    locationLabels: {
        webster:  'Webster',
        maryland: 'MD Heights',
    },
};

// ── Hook: useMenuConfig ───────────────────────────────────────────
// Subscribe to /config/menu_v2. Returns { menu, ready, fromFirestore }:
//   - menu:          categories array (v2 shape) — always populated
//                    (falls back to legacyMenuToV2(MENU_DATA))
//   - ready:         true once the first snapshot has landed (use to
//                    gate "Loading…" skeletons)
//   - fromFirestore: true when the menu came from Firestore (not the
//                    legacy fallback). Useful for the editor — it
//                    should refuse to save until fromFirestore is
//                    true (otherwise it'd be writing against stale
//                    state).
//
// Memoized fallback so the legacy conversion happens once per page
// load, not on every snapshot tick.
let _legacyMenuV2Cache = null;
function getLegacyMenuV2Cached() {
    if (!_legacyMenuV2Cache) _legacyMenuV2Cache = legacyMenuToV2(MENU_DATA);
    return _legacyMenuV2Cache;
}

export function useMenuConfig() {
    const [snap, setSnap] = useState(null);
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const unsub = onSnapshot(
            doc(db, MENU_CONFIG_PATH),
            (s) => {
                setSnap(s.exists() ? s.data() : null);
                setReady(true);
            },
            (err) => {
                console.warn('[menuConfig] menu_v2 snapshot failed:', err);
                setReady(true);
            }
        );
        return unsub;
    }, []);
    return useMemo(() => {
        const fromFirestore = !!(snap && Array.isArray(snap.categories) && snap.categories.length > 0);
        if (fromFirestore && snap.schemaVersion > MENU_CONFIG_SCHEMA_VERSION) {
            console.warn(`[menuConfig] menu_v2 schemaVersion ${snap.schemaVersion} is newer than client's ${MENU_CONFIG_SCHEMA_VERSION}; falling back to legacy.`);
            return { menu: getLegacyMenuV2Cached(), ready, fromFirestore: false };
        }
        const menu = fromFirestore ? snap.categories : getLegacyMenuV2Cached();
        return { menu, ready, fromFirestore };
    }, [snap, ready]);
}

// ── Hook: useBrandConfig ──────────────────────────────────────────
export function useBrandConfig() {
    const [snap, setSnap] = useState(null);
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const unsub = onSnapshot(
            doc(db, BRAND_CONFIG_PATH),
            (s) => {
                setSnap(s.exists() ? s.data() : null);
                setReady(true);
            },
            (err) => {
                console.warn('[menuConfig] brand snapshot failed:', err);
                setReady(true);
            }
        );
        return unsub;
    }, []);
    return useMemo(() => {
        const fromFirestore = !!(snap && snap.restaurantName);
        const brand = fromFirestore ? { ...DEFAULT_BRAND, ...snap } : DEFAULT_BRAND;
        return { brand, ready, fromFirestore };
    }, [snap, ready]);
}

// ── Hook: useBuildSheetConfig ─────────────────────────────────────
let _legacyBuildV2Cache = null;
function getLegacyBuildV2Cached() {
    if (!_legacyBuildV2Cache) _legacyBuildV2Cache = legacyBuildSheetToV2();
    return _legacyBuildV2Cache;
}

export function useBuildSheetConfig() {
    const [snap, setSnap] = useState(null);
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const unsub = onSnapshot(
            doc(db, BUILD_SHEET_PATH),
            (s) => {
                setSnap(s.exists() ? s.data() : null);
                setReady(true);
            },
            (err) => {
                console.warn('[menuConfig] build_sheet snapshot failed:', err);
                setReady(true);
            }
        );
        return unsub;
    }, []);
    return useMemo(() => {
        const fromFirestore = !!(snap && snap.sections && typeof snap.sections === 'object');
        const sections = fromFirestore ? snap.sections : getLegacyBuildV2Cached();
        return { sections, ready, fromFirestore };
    }, [snap, ready]);
}

// ── Legacy-shape adapter (for Phase 1.E migration) ─────────────────
// The v2 schema renamed a couple of category fields (category →
// nameEn, categoryEs → nameEs, note → noteEn). Existing consumers
// (MenuReference, MenuDisplay, MenuEditor, DateStickerPrinter, ...)
// were written against the old shape. Rather than touch nine files
// at once, this adapter converts v2 → legacy on the fly so callers
// can drop in the new hook with minimal diff:
//
//   - import { MENU_DATA } from '../data/menu';
//   + import { useMenuConfigLegacy } from '../data/menuConfig';
//   + const { menu: MENU_DATA } = useMenuConfigLegacy();
//
// Once all callers have migrated to the v2 shape directly, this
// adapter can be deleted.
//
// Archived items + archived categories are filtered out — the
// editor surfaces those for management, but the live menu (TVs,
// reference, stickers, recipes) should never render them.
export function v2ToLegacyShape(v2Categories) {
    if (!Array.isArray(v2Categories)) return [];
    return v2Categories
        .filter(c => !c.archived)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(c => ({
            category:    c.nameEn || '',
            categoryEs:  c.nameEs || c.nameEn || '',
            note:        c.noteEn || '',
            noteEs:      c.noteEs || '',
            customizable: Array.isArray(c.customizable) ? [...c.customizable] : [],
            items: (c.items || [])
                .filter(it => !it.archived)
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                .map(it => ({
                    // Bonus: surface the v2 slug so callers can adopt
                    // stable-id matching without changing their shape
                    // assumptions. Legacy callers ignore unknown fields.
                    _slug:      it.id,
                    nameEn:     it.nameEn || '',
                    nameEs:     it.nameEs || '',
                    nameVi:     it.nameVi || '',
                    price:      it.price || '',
                    descEn:     it.descEn || '',
                    descEs:     it.descEs || '',
                    allergens:  it.allergens || '',
                    spicy:      !!it.spicy,
                    vegan:      !!it.vegan,
                    glutenFree: !!it.glutenFree,
                    popular:    !!it.popular,
                    photoUrl:   it.photoUrl || '',
                })),
        }));
}

/**
 * Legacy-shape view of the live menu. Same returns as useMenuConfig
 * but the `menu` array uses the old MENU_DATA category/categoryEs
 * field names for drop-in compatibility.
 */
export function useMenuConfigLegacy() {
    const { menu, ready, fromFirestore } = useMenuConfig();
    const legacyMenu = useMemo(() => v2ToLegacyShape(menu), [menu]);
    return { menu: legacyMenu, ready, fromFirestore };
}

// ── Lookup helpers ────────────────────────────────────────────────
// Centralized so callers don't reinvent.

/** Find an item by its stable slug. O(N) but N is small (<200). */
export function getItemBySlug(menu, slug) {
    if (!slug || !Array.isArray(menu)) return null;
    for (const cat of menu) {
        if (!Array.isArray(cat.items)) continue;
        const hit = cat.items.find(it => it.id === slug);
        if (hit) return { item: hit, category: cat };
    }
    return null;
}

/** Fuzzy fallback: case-insensitive trim+normalize match by name.
 *  Use this for legacy callers (86-board, recipes) during the slug
 *  migration. Returns the FIRST match; ambiguous names are a hazard
 *  surfacing here is preferable to silently picking the wrong one.
 */
export function findItemByName(menu, name) {
    if (!name || !Array.isArray(menu)) return null;
    const target = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    for (const cat of menu) {
        for (const it of (cat.items || [])) {
            const candidate = String(it.nameEn || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
            if (candidate === target) return { item: it, category: cat };
        }
    }
    return null;
}

// ── One-shot writes ───────────────────────────────────────────────
// Used by the migration script and the editor's "Save" path. Both
// stamp updatedAt/updatedBy + schemaVersion so we always know which
// build wrote the doc.

export async function writeMenuConfig({ categories, byName }) {
    if (!Array.isArray(categories)) throw new Error('categories must be an array');
    await setDoc(doc(db, MENU_CONFIG_PATH), {
        schemaVersion: MENU_CONFIG_SCHEMA_VERSION,
        categories,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    });
}

export async function writeBrandConfig({ brand, byName }) {
    if (!brand || typeof brand !== 'object') throw new Error('brand must be an object');
    await setDoc(doc(db, BRAND_CONFIG_PATH), {
        schemaVersion: BRAND_CONFIG_SCHEMA_VERSION,
        ...brand,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    });
}

export async function writeBuildSheetConfig({ sections, byName }) {
    if (!sections || typeof sections !== 'object') throw new Error('sections must be an object');
    await setDoc(doc(db, BUILD_SHEET_PATH), {
        schemaVersion: BUILD_SHEET_SCHEMA_VERSION,
        sections,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    });
}

// ── One-shot migration ────────────────────────────────────────────
// Called once per Firestore project to seed the v2 docs with current
// hardcoded data. Idempotent — slugs are deterministic, so running
// twice produces the same docs.
//
// Returns { menuItemCount, buildSheetItemCount, brandWritten,
//           menuOverwritten, brandOverwritten, buildSheetOverwritten }
// so the caller (admin UI) can show a result toast.
//
// IMPORTANT: this OVERWRITES the Firestore docs. If a tenant has
// already edited their menu through the editor, calling this again
// nukes their edits. The admin UI must confirm with a "are you
// sure?" before invoking on an already-populated tenant.
//
// `overwriteEvenIfPresent` defaults to false — the safe default.
export async function migrateLegacyToFirestore({
    byName,
    overwriteEvenIfPresent = false,
} = {}) {
    const result = {
        menuItemCount: 0,
        buildSheetItemCount: 0,
        brandWritten: false,
        menuOverwritten: false,
        brandOverwritten: false,
        buildSheetOverwritten: false,
    };

    // Menu
    const menuRef = doc(db, MENU_CONFIG_PATH);
    const menuExisting = await getDoc(menuRef);
    if (!menuExisting.exists() || overwriteEvenIfPresent) {
        const v2 = legacyMenuToV2(MENU_DATA);
        await writeMenuConfig({ categories: v2, byName });
        result.menuItemCount = v2.reduce((s, c) => s + (c.items?.length || 0), 0);
        result.menuOverwritten = menuExisting.exists();
    }

    // Brand
    const brandRef = doc(db, BRAND_CONFIG_PATH);
    const brandExisting = await getDoc(brandRef);
    if (!brandExisting.exists() || overwriteEvenIfPresent) {
        await writeBrandConfig({ brand: DEFAULT_BRAND, byName });
        result.brandWritten = true;
        result.brandOverwritten = brandExisting.exists();
    }

    // Build sheet
    const bsRef = doc(db, BUILD_SHEET_PATH);
    const bsExisting = await getDoc(bsRef);
    if (!bsExisting.exists() || overwriteEvenIfPresent) {
        const v2 = legacyBuildSheetToV2();
        await writeBuildSheetConfig({ sections: v2, byName });
        result.buildSheetItemCount = Object.values(v2).reduce((s, arr) => s + (arr?.length || 0), 0);
        result.buildSheetOverwritten = bsExisting.exists();
    }

    return result;
}
