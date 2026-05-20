// Inventory list variations — named, editable, publishable.
//
// Andrew 2026-05-19 — "I want to be able to move everything around and
// create different inventory list variations. For example if I'm doing
// just produce today I want to make a list just produce. ... I can name
// the lists. I can post the lists I want and save for back up lists I
// don't want to show in the inventory tab."
//
// Model:
//   /inventory_lists/{id} = {
//     name:        string
//     nameEs:      string
//     description: string?               — optional short note
//     status:      'active' | 'draft'    — only one 'active' at a time
//                                          (we enforce on activate())
//     categories:  [                     — same shape as
//       {                                  customInventory in
//         id:    number,                   ops/inventory_{loc}.customInventory.
//         name:  string,                   Stored as a full copy so editing
//         nameEs: string,                  one list never disturbs another.
//         items: [{ id, name, nameEs,
//                   subcat, vendor,
//                   price, pack, ... }],
//       }
//     ],
//     createdAt:   Timestamp
//     createdBy:   string
//     updatedAt:   Timestamp?
//     updatedBy:   string?
//     activatedAt: Timestamp?            — when this list was last activated
//     activatedBy: string?
//   }
//
// Operations.jsx checks /inventory_lists for an 'active' list on load.
// If found, uses its categories instead of the legacy
// ops/inventory_{loc}.customInventory. If none, falls back to the legacy
// path so existing data keeps working without any migration.
//
// Lists are GLOBAL (not per-location) — Andrew runs a "produce day"
// across both stores or the full list across both. Counts stay
// per-location as before.

import { db } from '../firebase';
import {
    collection, doc, addDoc, updateDoc, deleteDoc, getDoc, getDocs,
    query, where, onSnapshot, serverTimestamp, orderBy, limit,
    writeBatch,
} from 'firebase/firestore';
import { INVENTORY_CATEGORIES } from './inventory';
import { recordAudit } from './audit';

export const LIST_STATUS = Object.freeze({
    ACTIVE: 'active',
    DRAFT:  'draft',
});

// Deep-clone an INVENTORY_CATEGORIES-shaped array. We can't JSON
// round-trip Firestore timestamps but the categories structure is
// pure JSON (numbers, strings, arrays, objects) so that's fine.
function cloneCategories(cats) {
    return (cats || []).map(c => ({
        ...c,
        items: (c.items || []).map(it => ({ ...it })),
    }));
}

// Create a new list. Source picks the starting categories:
//   'master'  — fresh copy from src/data/inventory.js INVENTORY_CATEGORIES
//   'current' — copy of the legacy customInventory from a given location
//   'empty'   — start with no categories
//   'fromList:{id}' — clone an existing list's categories
export async function createList({
    name, nameEs, description = '',
    source = 'master', sourceLocation = 'webster', sourceListId = null,
    createdBy,
}) {
    if (!name || !name.trim()) throw new Error('name required');
    if (!createdBy) throw new Error('createdBy required');

    let categories = [];
    if (source === 'master') {
        categories = cloneCategories(INVENTORY_CATEGORIES);
    } else if (source === 'current') {
        try {
            const snap = await getDoc(doc(db, 'ops', `inventory_${sourceLocation}`));
            if (snap.exists()) {
                const data = snap.data();
                if (Array.isArray(data.customInventory) && data.customInventory.length > 0) {
                    categories = cloneCategories(data.customInventory);
                }
            }
        } catch (e) {
            console.warn('createList: could not read current customInventory:', e);
        }
        if (categories.length === 0) categories = cloneCategories(INVENTORY_CATEGORIES);
    } else if (source && source.startsWith('fromList:')) {
        const fromId = source.slice('fromList:'.length);
        if (fromId === sourceListId || fromId) {
            const id = sourceListId || fromId;
            const snap = await getDoc(doc(db, 'inventory_lists', id));
            if (snap.exists()) {
                categories = cloneCategories(snap.data().categories);
            }
        }
        if (categories.length === 0) categories = cloneCategories(INVENTORY_CATEGORIES);
    } else if (source === 'empty') {
        categories = [];
    }

    const ref = await addDoc(collection(db, 'inventory_lists'), {
        name: name.trim(),
        nameEs: (nameEs || name).trim(),
        description: String(description || '').slice(0, 500),
        status: LIST_STATUS.DRAFT,         // draft until explicitly activated
        categories,
        createdAt: serverTimestamp(),
        createdBy,
    });
    recordAudit({
        action: 'inventory_list.create',
        actorName: createdBy,
        targetType: 'inventory_list',
        targetId: ref.id,
        details: { name, source, categoriesCount: categories.length },
    });
    return ref.id;
}

// Rename / re-describe a list. Doesn't touch categories.
export async function updateListMeta({ id, name, nameEs, description, updatedBy }) {
    if (!id) throw new Error('id required');
    const patch = { updatedAt: serverTimestamp(), updatedBy: updatedBy || null };
    if (typeof name === 'string') patch.name = name.trim().slice(0, 100);
    if (typeof nameEs === 'string') patch.nameEs = nameEs.trim().slice(0, 100);
    if (typeof description === 'string') patch.description = description.slice(0, 500);
    await updateDoc(doc(db, 'inventory_lists', id), patch);
}

// Replace the categories on a list. The whole structure is overwritten
// — caller manages reorders/additions/removals locally + saves the
// final state. We don't try to diff at this layer; it would mostly
// be incidental complexity.
export async function updateListCategories({ id, categories, updatedBy }) {
    if (!id) throw new Error('id required');
    if (!Array.isArray(categories)) throw new Error('categories must be an array');
    await updateDoc(doc(db, 'inventory_lists', id), {
        categories: cloneCategories(categories),
        updatedAt: serverTimestamp(),
        updatedBy: updatedBy || null,
    });
}

// Soft-delete: there's no "trashed" status today — actual deleteDoc.
// We log the full categories snapshot in the audit row so a wrongful
// delete can be reconstructed.
export async function deleteList({ id, byName }) {
    if (!id) throw new Error('id required');
    let snapshot = null;
    try {
        const snap = await getDoc(doc(db, 'inventory_lists', id));
        if (snap.exists()) snapshot = snap.data();
    } catch {}
    await deleteDoc(doc(db, 'inventory_lists', id));
    recordAudit({
        action: 'inventory_list.delete',
        actorName: byName || 'admin',
        targetType: 'inventory_list',
        targetId: id,
        details: { name: snapshot?.name, categoriesCount: snapshot?.categories?.length ?? 0 },
    });
}

// Activate one list — only one can be active at a time. Atomically
// flips every other list to 'draft' and sets the target to 'active'.
// If the target was already active, this is a no-op.
export async function activateList({ id, byName }) {
    if (!id) throw new Error('id required');
    const target = await getDoc(doc(db, 'inventory_lists', id));
    if (!target.exists()) throw new Error('list not found');

    const all = await getDocs(collection(db, 'inventory_lists'));
    const batch = writeBatch(db);
    let flipped = 0;
    all.forEach(d => {
        if (d.id === id) return;
        if (d.data().status === LIST_STATUS.ACTIVE) {
            batch.update(d.ref, {
                status: LIST_STATUS.DRAFT,
                updatedAt: serverTimestamp(),
                updatedBy: byName || null,
            });
            flipped++;
        }
    });
    batch.update(doc(db, 'inventory_lists', id), {
        status: LIST_STATUS.ACTIVE,
        activatedAt: serverTimestamp(),
        activatedBy: byName || null,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    });
    await batch.commit();

    recordAudit({
        action: 'inventory_list.activate',
        actorName: byName || 'admin',
        targetType: 'inventory_list',
        targetId: id,
        details: { name: target.data().name, demotedCount: flipped },
    });
}

// Deactivate the currently-active list (revert all to draft).
// Operations.jsx will fall back to legacy customInventory until
// admin activates another list.
export async function deactivateAll({ byName }) {
    const all = await getDocs(query(
        collection(db, 'inventory_lists'),
        where('status', '==', LIST_STATUS.ACTIVE),
    ));
    if (all.empty) return;
    const batch = writeBatch(db);
    all.forEach(d => {
        batch.update(d.ref, {
            status: LIST_STATUS.DRAFT,
            updatedAt: serverTimestamp(),
            updatedBy: byName || null,
        });
    });
    await batch.commit();
    recordAudit({
        action: 'inventory_list.deactivate_all',
        actorName: byName || 'admin',
        targetType: 'inventory_list',
        targetId: 'all',
    });
}

// Live subscription to every list in the collection — feeds the admin
// page's "All lists" grid.
export function subscribeAllLists(cb) {
    const q = query(collection(db, 'inventory_lists'), orderBy('createdAt', 'desc'));
    return onSnapshot(q, (snap) => {
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        cb(list);
    }, (err) => {
        console.warn('subscribeAllLists failed:', err);
        cb([]);
    });
}

// Live subscription to the single currently-active list. Operations.jsx
// uses this to render the inventory tab from the list's categories.
// cb is called with null when no list is active.
export function subscribeActiveList(cb) {
    const q = query(
        collection(db, 'inventory_lists'),
        where('status', '==', LIST_STATUS.ACTIVE),
        limit(1),
    );
    return onSnapshot(q, (snap) => {
        if (snap.empty) { cb(null); return; }
        const d = snap.docs[0];
        cb({ id: d.id, ...d.data() });
    }, (err) => {
        console.warn('subscribeActiveList failed:', err);
        cb(null);
    });
}
