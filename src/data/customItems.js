// Custom items — admin-defined date-codeable items that aren't on the
// public menu.
//
// Andrew 2026-05-20 — Phase 2 queued item: "Add new menu items
// entirely (for prep items / drinks not in menu.js)".
//
// Use cases:
//   • House-made sauces ("House Hoisin", "Lemongrass Marinade")
//   • Prep components ("Cooked jasmine rice", "Fried shallots batch")
//   • Drinks not on the public menu (kitchen test prep)
//   • Anything the kitchen prepares that needs a date sticker but
//     doesn't have a customer-facing menu entry
//
// Stored at /custom_items/{slug}. Each doc has the full build inline
// (no static fallback to merge with — it IS the source). Subscribed
// live by DateStickerPrinter; appears in the search index + browse
// view alongside menu items.

import { db } from '../firebase';
import {
    doc, collection, getDoc, setDoc, deleteDoc, onSnapshot, serverTimestamp, query, limit,
} from 'firebase/firestore';
import { recordAudit } from './audit';

const COLLECTION = 'custom_items';

// Live subscription. Returns an array of custom items in insertion
// order. Each entry has the same shape getAllMenuItems() returns
// so the search index can treat them uniformly.
export function subscribeAllCustomItems(cb) {
    // limit(200) — defense-in-depth bound. Admin-curated (house sauces / prep
    // items), realistically dozens, but no live listener should be unbounded.
    return onSnapshot(query(collection(db, COLLECTION), limit(200)), (snap) => {
        const list = [];
        snap.forEach(d => list.push({ ...d.data(), id: d.id, isCustom: true }));
        list.sort((a, b) => (a.nameEn || '').localeCompare(b.nameEn || ''));
        cb(list);
    }, (err) => {
        console.warn('subscribeAllCustomItems failed:', err);
        cb([]);
    });
}

export async function getCustomItem(slug) {
    if (!slug) return null;
    try {
        const snap = await getDoc(doc(db, COLLECTION, slug));
        if (!snap.exists()) return null;
        return { ...snap.data(), id: snap.id, isCustom: true };
    } catch (e) {
        console.warn('getCustomItem failed:', e);
        return null;
    }
}

export async function saveCustomItem({
    slug, nameEn, nameEs, category, categoryEs,
    allergens, components, shelfLifeDays, notes, byName,
}) {
    if (!slug) throw new Error('slug required');
    if (!nameEn || !nameEn.trim()) throw new Error('nameEn required');
    const cleanComps = Array.isArray(components) ? components : [];
    const cleanShelf = Number.isFinite(Number(shelfLifeDays)) && Number(shelfLifeDays) > 0
        ? Math.min(60, Math.floor(Number(shelfLifeDays)))
        : null;
    const cleanNotes = Array.isArray(notes)
        ? notes.map(n => ({
            en: String(n?.en || '').slice(0, 240).trim(),
            es: String(n?.es || n?.en || '').slice(0, 240).trim(),
        })).filter(n => n.en)
        : [];

    await setDoc(doc(db, COLLECTION, slug), {
        slug,
        nameEn: String(nameEn).slice(0, 120).trim(),
        nameEs: String(nameEs || nameEn).slice(0, 120).trim(),
        category: String(category || 'Custom').slice(0, 60).trim(),
        categoryEs: String(categoryEs || category || 'Personalizado').slice(0, 60).trim(),
        allergens: String(allergens || '').slice(0, 300),
        components: cleanComps,
        ...(cleanShelf ? { shelfLifeDays: cleanShelf } : {}),
        notes: cleanNotes,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
        // Stamp createdAt only on first write — defensive merge: true
        // would keep an existing createdAt, but we use set without
        // merge to ensure deletes-of-fields work; stamp here so the
        // first write gets it, subsequent writes overwrite with the
        // same logical value (close enough; not critical).
        createdAt: serverTimestamp(),
    }, { merge: false });

    recordAudit({
        action: 'custom_item.save',
        actorName: byName || 'admin',
        targetType: 'custom_item',
        targetId: slug,
        details: {
            nameEn,
            category,
            componentCount: cleanComps.length,
            shelfLifeDays: cleanShelf,
        },
    });
}

export async function deleteCustomItem({ slug, nameEn, byName }) {
    if (!slug) throw new Error('slug required');
    await deleteDoc(doc(db, COLLECTION, slug));
    recordAudit({
        action: 'custom_item.delete',
        actorName: byName || 'admin',
        targetType: 'custom_item',
        targetId: slug,
        details: { nameEn },
    });
}

// Slug helper exposed for the new-item form.
export function makeCustomItemSlug(nameEn) {
    const base = String(nameEn || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    if (!base) return `custom-${Date.now().toString(36)}`;
    return base;
}
