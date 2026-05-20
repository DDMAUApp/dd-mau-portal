// Menu overrides — Firestore overlay on top of the static MENU_DATA
// (src/data/menu.js) so admins can change prices, hide items, add
// custom items, and attach photos without editing code.
//
// Andrew 2026-05-20 — Phase 2 of the menu-TV feature. The TV board
// renders MENU_DATA merged with these override docs. Changes in
// admin propagate to all TVs within seconds via onSnapshot.
//
// ─── Schema ───────────────────────────────────────────────────
// /menu_items/{slug} = {
//   slug:        'pork-bowl'          // stable, derived from default name
//   category:    'Bowls'              // category this item belongs to
//   isCustom:    boolean              // true = entirely new item (not in MENU_DATA)
//   hidden:      boolean              // true = hide from TVs (soft delete)
//   nameEn:      string?              // override item name
//   nameEs:      string?
//   price:       string?              // e.g. "$18"
//   descEn:      string?
//   descEs:      string?
//   photoUrl:    string?              // Firebase Storage URL
//   spicy:       boolean?
//   vegan:       boolean?
//   glutenFree:  boolean?
//   popular:     boolean?
//   order:       number?              // sort position within category
//   updatedAt:   serverTimestamp
//   updatedBy:   string
// }
//
// Resolution rules in applyMenuOverrides(MENU_DATA, overrides):
//   1. For each item in MENU_DATA: look up override by slug.
//        • If hidden=true → drop from output.
//        • Otherwise shallow-merge override fields on top of base.
//   2. For each override with isCustom=true and slug NOT in MENU_DATA:
//        → append to the matching category.
//   3. Within each category, sort by override.order (ascending),
//      falling back to original MENU_DATA order for items without one.
//
// Restore-to-default = delete the override doc.
// Hide-but-keep-history = set hidden=true (doesn't drop the doc).

import { db } from '../firebase';
import {
    doc, collection, getDoc, setDoc, deleteDoc, onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { recordAudit } from './audit';

const COLLECTION = 'menu_items';

// Derive a stable slug from a menu item name. Matches the
// kebab-case convention used elsewhere in the codebase (build
// overrides, custom items). NFD-normalize + strip accents first so
// "Bánh Mì" → "banh-mi" without losing the item.
export function makeMenuItemSlug(name) {
    return String(name || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'item';
}

// Live subscription. Returns a Map<slug, overrideDoc>. Maps
// (not arrays) so the apply step is O(1) per MENU_DATA item.
export function subscribeMenuOverrides(cb) {
    const unsub = onSnapshot(collection(db, COLLECTION), (snap) => {
        const map = new Map();
        snap.forEach(d => {
            const data = d.data() || {};
            map.set(d.id, { slug: d.id, ...data });
        });
        cb(map);
    }, (err) => {
        console.warn('menu_items subscription failed:', err);
        cb(new Map());
    });
    return unsub;
}

// One-shot read of a single override.
export async function getMenuOverride(slug) {
    const snap = await getDoc(doc(db, COLLECTION, slug));
    return snap.exists() ? { slug, ...snap.data() } : null;
}

// Write or update an override. Empty/undefined fields are NOT
// stored — they fall back to MENU_DATA's value at render time.
// Pass { fieldX: null } explicitly to clear an override.
export async function saveMenuOverride({ slug, payload, byName }) {
    if (!slug) throw new Error('slug required');
    const cleanSlug = String(slug).slice(0, 64);
    const data = {
        ...payload,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    };
    await setDoc(doc(db, COLLECTION, cleanSlug), data, { merge: true });
    recordAudit({
        action: 'menu.override.save',
        actorName: byName || 'admin',
        targetType: 'menu_item',
        targetId: cleanSlug,
        details: {
            category: payload?.category,
            nameEn: payload?.nameEn,
            price: payload?.price,
            hidden: payload?.hidden === true,
            isCustom: payload?.isCustom === true,
        },
    });
}

// Restore-to-default — drop the override doc entirely.
export async function deleteMenuOverride({ slug, byName }) {
    if (!slug) throw new Error('slug required');
    await deleteDoc(doc(db, COLLECTION, slug));
    recordAudit({
        action: 'menu.override.delete',
        actorName: byName || 'admin',
        targetType: 'menu_item',
        targetId: slug,
        details: {},
    });
}

// Merge MENU_DATA + overrides into the rendered menu used by the
// TV board. Pure function — no Firestore reads here so it's safe
// to call on every state update.
//
// Returns the same shape as MENU_DATA: [{ category, items: [...] }]
// with overrides applied and custom items appended.
export function applyMenuOverrides(menuData, overridesMap) {
    if (!overridesMap || overridesMap.size === 0) {
        return Array.isArray(menuData) ? menuData : [];
    }
    // Index overrides by category so we can append custom items.
    const customByCategory = new Map();
    for (const ov of overridesMap.values()) {
        if (ov.isCustom && ov.category && !ov.hidden) {
            if (!customByCategory.has(ov.category)) customByCategory.set(ov.category, []);
            customByCategory.get(ov.category).push(ov);
        }
    }
    const out = [];
    for (const cat of menuData) {
        const merged = [];
        for (const baseItem of (cat.items || [])) {
            const slug = makeMenuItemSlug(baseItem.nameEn);
            const ov = overridesMap.get(slug);
            if (ov?.hidden === true) continue;
            if (!ov) {
                merged.push({ ...baseItem, _slug: slug });
                continue;
            }
            // Shallow merge — override scalar fields, leave the
            // rest of the base intact.
            const overlay = { ...baseItem, _slug: slug };
            const fields = ['nameEn', 'nameEs', 'price', 'descEn', 'descEs',
                'photoUrl', 'spicy', 'vegan', 'glutenFree', 'popular', 'order'];
            for (const f of fields) {
                if (ov[f] !== undefined && ov[f] !== null && ov[f] !== '') {
                    overlay[f] = ov[f];
                }
            }
            overlay._overrideOrder = ov.order;
            merged.push(overlay);
        }
        // Append custom items for this category.
        const customs = customByCategory.get(cat.category) || [];
        for (const c of customs) {
            merged.push({
                ...c,
                _slug: c.slug,
                _isCustom: true,
                _overrideOrder: c.order,
            });
        }
        // Sort by explicit order when present; preserve base order
        // for the rest. items without _overrideOrder keep their
        // original index; items WITH it interleave by value.
        if (customs.length > 0 || merged.some(i => Number.isFinite(i._overrideOrder))) {
            merged.sort((a, b) => {
                const ao = Number.isFinite(a._overrideOrder) ? a._overrideOrder : 9999;
                const bo = Number.isFinite(b._overrideOrder) ? b._overrideOrder : 9999;
                return ao - bo;
            });
        }
        out.push({ ...cat, items: merged });
    }
    // Edge case: a custom item with a category not in MENU_DATA.
    // Append a synthetic category at the end so it still appears.
    for (const [category, items] of customByCategory.entries()) {
        if (!menuData.some(c => c.category === category)) {
            out.push({
                category,
                categoryEs: category,
                items: items.map(c => ({
                    ...c,
                    _slug: c.slug,
                    _isCustom: true,
                })),
            });
        }
    }
    return out;
}
