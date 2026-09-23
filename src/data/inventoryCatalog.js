// inventoryCatalog.js — pure helpers for the inventory CATALOG (the item list
// stored as ops/inventory_{loc}.customInventory, merged with the built-in
// INVENTORY_CATEGORIES on load).
//
// Extracted from Operations.jsx (2026-09-23 inventory bug batch) so the load
// merge and every catalog edit (edit / move / delete / reorder / new id) run
// the SAME tested logic, and so the edits can be planned inside a Firestore
// transaction against the LIVE doc.
//
// Id model (unchanged): an item id is "{mergedCatIdx}-{n}". The load merge
// RENUMBERS any saved item whose id prefix doesn't match the category it sits
// in, and RE-ADDS every built-in item the saved doc lacks unless its id is in
// deletedMasterIds (a tombstone). Two bugs came from edits that ignored this:
//   C1 — a cross-category move kept the old id, so the merge renumbered it
//        (every open device then ran the id migration) AND re-added the
//        built-in in its old category (duplicate).
//   C2 — deleting a built-in never tombstoned it, so it came back on reload;
//        and new ids could re-use a deleted built-in id.
// The planners below give a moved item a fresh, collision-free id in its new
// category, tombstone built-ins that leave their home, and report the
// old→new id map so the caller can move counts/countMeta with dotted paths.

// ── Load merge ───────────────────────────────────────────────────────────────
// Byte-for-byte the merge that lived inline in the Operations inventory
// listener (perf-fix 2026-05-22 / audit O6 2026-07-27). Returns the merged
// list and the ids it had to renumber ({ oldId: newId }).
// Optional `sourcesOut` (a Map) is filled with presentedId → { ci, j } (the
// saved position the on-screen item came from) or null (a built-in only the
// merge supplies). It never changes the result.
export function mergeSavedInventory(masterCategories, saved, deletedMasterIds, sourcesOut) {
    const src = (id, pos) => { if (sourcesOut) sourcesOut.set(id, pos); };
    // Tombstones (deletedMasterIds) record master items the user
    // intentionally removed; without them the merge would re-include every
    // master item every time, undoing the delete on next reload.
    const tombstones = new Set(deletedMasterIds || []);
    const idMigration = {};
    const merged = masterCategories.map((masterCat, masterIdx) => {
        const savedIdx = saved.findIndex(sc => sc.name === masterCat.name);
        const savedCat = savedIdx === -1 ? undefined : saved[savedIdx];
        const liveMasterItems = masterCat.items.filter(it => !tombstones.has(it.id));
        if (!savedCat) {
            liveMasterItems.forEach(mi => src(mi.id, null));
            return { ...masterCat, items: [...liveMasterItems] };
        }
        const masterIds = new Set(liveMasterItems.map(it => it.id));
        const masterById = new Map(liveMasterItems.map(it => [it.id, it]));
        const expectedPrefix = `${masterIdx}-`;
        // Walk savedCat.items in saved order so user reorders persist.
        // Then append any master items the saved doc didn't have yet
        // (newly-added entries in inventory.js).
        const mergedItems = [];
        const seenIds = new Set();
        (savedCat.items || []).forEach((si, j) => {
            let newId = si.id;
            if (typeof si.id === "string" && !si.id.startsWith(expectedPrefix) && !masterIds.has(si.id)) {
                // Item from a renamed/moved category. Renumber under the new
                // prefix so it can't collide with another category's master ids.
                let n = mergedItems.length;
                while (seenIds.has(`${masterIdx}-${n}`) || masterIds.has(`${masterIdx}-${n}`)) n++;
                newId = `${masterIdx}-${n}`;
                idMigration[si.id] = newId;
            }
            // NEVER silently drop a user's item on an id collision — re-id the
            // collider so BOTH survive (a genuine accidental dup then shows
            // twice — visible + deletable — instead of vanishing).
            if (seenIds.has(newId)) {
                let n = mergedItems.length;
                while (seenIds.has(`${masterIdx}-${n}`) || masterIds.has(`${masterIdx}-${n}`)) n++;
                const reId = `${masterIdx}-${n}`;
                idMigration[si.id] = reId;
                seenIds.add(reId);
                mergedItems.push({ ...si, id: reId });
                src(reId, { ci: savedIdx, j });
                return;
            }
            seenIds.add(newId);
            src(newId, { ci: savedIdx, j });
            // If a master twin exists, layer master fields under saved
            // (saved wins on every non-empty field).
            const mi = masterById.get(newId);
            if (mi) {
                const m = layerMasterFields(si, mi);
                m.id = newId;
                mergedItems.push(m);
            } else {
                mergedItems.push({ ...si, id: newId });
            }
        });
        // Append any master items the saved doc didn't have yet.
        liveMasterItems.forEach(mi => {
            if (seenIds.has(mi.id)) return;
            seenIds.add(mi.id);
            mergedItems.push({ ...mi });
            src(mi.id, null);
        });
        return { ...masterCat, items: mergedItems };
    });
    // Saved categories that don't match a master by name (custom categories,
    // or an old name from before a rename): append them and renumber their
    // ids under the new merged index so they can't collide with master items.
    saved.forEach((sc, ci) => {
        if (masterCategories.find(mc => mc.name === sc.name)) return;
        const newIdx = merged.length;
        const expectedPrefix = `${newIdx}-`;
        const seenIds = new Set();
        const renumbered = (sc.items || []).map((si, n) => {
            let newId = si.id;
            if (typeof si.id !== "string" || !si.id.startsWith(expectedPrefix) || seenIds.has(si.id)) {
                let j = n;
                while (seenIds.has(`${newIdx}-${j}`)) j++;
                newId = `${newIdx}-${j}`;
                if (newId !== si.id) idMigration[si.id] = newId;
            }
            seenIds.add(newId);
            src(newId, { ci, j: n });
            return { ...si, id: newId };
        });
        merged.push({ ...sc, items: renumbered });
    });
    return { merged, idMigration };
}

// Master fields under saved ones — saved wins on every non-empty field.
export function layerMasterFields(savedItem, masterItem) {
    const out = { ...masterItem };
    for (const k of Object.keys(savedItem || {})) {
        const v = savedItem[k];
        if (v !== "" && v !== null && v !== undefined) out[k] = v;
    }
    return out;
}

// True when an admin-activated inventory list actually overrides the
// catalog (same test the listener has always used).
export function isListOverride(list) {
    return !!(list && Array.isArray(list.categories) && list.categories.length > 0);
}

// ── Lookups ──────────────────────────────────────────────────────────────────
// id → { catIdx, item } for every built-in item.
export function builtInIndex(masterCategories) {
    const out = new Map();
    masterCategories.forEach((c, catIdx) => (c.items || []).forEach(it => out.set(it.id, { catIdx, item: it })));
    return out;
}

// Locate an item by ID (never by position). Looks in the category named
// `preferCatName` first, then everywhere. → { catIdx, itemIdx, item } | null
export function findItemById(list, id, preferCatName) {
    if (id == null || !Array.isArray(list)) return null;
    const scan = (ci) => {
        const items = (list[ci] && list[ci].items) || [];
        for (let j = 0; j < items.length; j++) if (items[j] && items[j].id === id) return { catIdx: ci, itemIdx: j, item: items[j] };
        return null;
    };
    if (preferCatName != null) {
        for (let ci = 0; ci < list.length; ci++) {
            if (list[ci] && list[ci].name === preferCatName) {
                const hit = scan(ci);
                if (hit) return hit;
            }
        }
    }
    for (let ci = 0; ci < list.length; ci++) {
        const hit = scan(ci);
        if (hit) return hit;
    }
    return null;
}

// The index the LOAD MERGE will give the category named `name`, given the
// saved list: master categories by name; custom ones after all masters, in
// saved order; a name not present yet lands at the end (it will be appended).
// New ids must use THIS index as their prefix or the merge renumbers them.
export function mergedCategoryIndex(list, name, masterCategories) {
    const mi = masterCategories.findIndex(c => c.name === name);
    if (mi !== -1) return mi;
    const masterNames = new Set(masterCategories.map(c => c.name));
    let n = masterCategories.length;
    for (const c of (list || [])) {
        if (!c || masterNames.has(c.name)) continue;
        if (c.name === name) return n;
        n++;
    }
    return n;
}

// First "{catIdx}-{n}" (n from startAt) not taken by ANY of: an item in the
// given lists, a built-in id (even one not shown — it may be re-added by the
// merge or be tombstoned), a tombstone, or a leftover counts/countMeta key
// (a re-used id would inherit a stale count).
export function allocateItemId({ catIdx, lists = [], masterCategories = [], deletedMasterIds, counts, countMeta, startAt = 0 }) {
    const taken = new Set();
    for (const list of lists) for (const c of (list || [])) for (const it of ((c && c.items) || [])) if (it && it.id != null) taken.add(String(it.id));
    for (const c of masterCategories) for (const it of (c.items || [])) taken.add(it.id);
    for (const id of (deletedMasterIds || [])) taken.add(id);
    for (const k of Object.keys(counts || {})) taken.add(k);
    for (const k of Object.keys(countMeta || {})) taken.add(k);
    let n = Math.max(0, startAt | 0);
    while (taken.has(`${catIdx}-${n}`)) n++;
    return `${catIdx}-${n}`;
}

// A new id for an item being added to (or moved into) the category named
// `catName` of the saved `list`. ctx = { masterCategories, deletedMasterIds,
// counts, countMeta } (the last three straight off the live doc).
export function nextCatalogItemId(list, catName, ctx) {
    const master = ctx.masterCategories || [];
    const catIdx = mergedCategoryIndex(list, catName, master);
    const cat = (list || []).find(c => c && c.name === catName);
    // Ids the merge will PRESENT (renumbers of not-yet-migrated items) are
    // taken too, so the new item can't land on one of them.
    let presented = [];
    try { presented = mergeSavedInventory(master, (list || []).filter(Boolean), ctx.deletedMasterIds).merged; } catch { /* best-effort */ }
    return allocateItemId({
        catIdx,
        lists: [list, presented],
        masterCategories: master,
        deletedMasterIds: ctx.deletedMasterIds,
        counts: ctx.counts,
        countMeta: ctx.countMeta,
        startAt: cat ? (cat.items || []).length : 0,
    });
}

// Insert `item` right after the LAST item sharing its subcat (else append),
// so a moved item lands inside its subcategory bucket.
export function insertNearSameSubcat(items, item) {
    const targetSub = (item.subcat || '').trim();
    let lastIdx = -1;
    for (let i = 0; i < items.length; i++) {
        if (((items[i] && items[i].subcat) || '').trim() === targetSub) lastIdx = i;
    }
    if (lastIdx === -1) return [...items, item];
    return [...items.slice(0, lastIdx + 1), item, ...items.slice(lastIdx + 1)];
}

// ── Counts follow a renamed id ───────────────────────────────────────────────
// Dotted-path writes that re-key counts/countMeta per idMigration, computed
// from the LIVE maps. Never rewrites a whole map, so taps on other items that
// land concurrently are untouched. Chains (A→B while B→C) resolve to the
// final state. `del` is the deleteField() sentinel.
export function planIdRemapWrites(idMigration, counts, countMeta, del) {
    const out = {};
    const mig = idMigration || {};
    const olds = Object.keys(mig).filter(o => mig[o] != null && mig[o] !== o);
    if (!olds.length) return out;
    const sourceOf = new Map(olds.map(o => [mig[o], o]));
    const touched = new Set([...olds, ...sourceOf.keys()]);
    const has = (m, k) => Object.prototype.hasOwnProperty.call(m, k);
    for (const [field, src0] of [['counts', counts], ['countMeta', countMeta]]) {
        const src = src0 || {};
        for (const key of touched) {
            const from = sourceOf.get(key);
            if (from !== undefined) {
                if (has(src, from)) out[`${field}.${key}`] = src[from];
                else if (has(src, key)) out[`${field}.${key}`] = del;
            } else if (has(src, key)) {
                out[`${field}.${key}`] = del;
            }
        }
    }
    return out;
}

// ── Edit planners (run inside the transaction against the LIVE list) ────────
// Every planner takes the id the user SAW (the merged, on-screen id) and maps
// it to the exact saved position through the merge itself (locateOnScreenItem)
// — so an item the merge presents under a different id than it is saved with
// (a not-yet-migrated legacy move), or a built-in only the merge supplies,
// is always the one that gets edited. Each returns { customInventory, ... }
// or { error: 'missing' }.
// ctx = { masterCategories, deletedMasterIds, counts, countMeta }.

// presentedId → { catIdx, itemIdx, item, savedId } for a saved item,
// { neverSaved: true, masterItem, homeIdx } for a built-in only the merge
// supplies, or null when nothing with that id is on screen any more.
export function locateOnScreenItem(list, presentedId, ctx) {
    const master = ctx.masterCategories || [];
    const sources = new Map();
    try { mergeSavedInventory(master, list || [], ctx.deletedMasterIds, sources); } catch { return null; }
    if (!sources.has(presentedId)) return null;
    const pos = sources.get(presentedId);
    if (!pos) {
        const bi = builtInIndex(master).get(presentedId);
        return bi ? { neverSaved: true, masterItem: bi.item, homeIdx: bi.catIdx } : null;
    }
    const item = list[pos.ci] && list[pos.ci].items && list[pos.ci].items[pos.j];
    return item ? { catIdx: pos.ci, itemIdx: pos.j, item, savedId: item.id } : null;
}

// Patch fields on an item in place (id unchanged). A built-in the saved doc
// never stored is materialized into its home category with the patch.
export function planItemPatch({ list, id, patch }, ctx) {
    const at = locateOnScreenItem(list, id, ctx);
    if (!at) return { error: 'missing' };
    if (at.neverSaved) {
        const home = ctx.masterCategories[at.homeIdx].name;
        let working = list;
        let idx = working.findIndex(c => c && c.name === home);
        if (idx === -1) { working = [...working, { name: home, items: [] }]; idx = working.length - 1; }
        const item = { ...at.masterItem, ...patch, id };
        return { customInventory: working.map((c, i) => i === idx ? { ...c, items: [...(c.items || []), item] } : c) };
    }
    return {
        customInventory: list.map((c, i) => i !== at.catIdx ? c : {
            ...c, items: c.items.map((it, j) => j === at.itemIdx ? { ...it, ...patch } : it),
        }),
    };
}

// Move an item to another category (optionally patching it). The moved item
// gets a NEW id under the destination's merged index; a built-in shown under
// its own id is tombstoned so the merge doesn't re-add it where it came from.
// → { customInventory, newId, idMigration: { [savedId]: newId }, tombstones }
export function planItemMove({ list, id, destCatName, patch }, ctx) {
    const master = ctx.masterCategories || [];
    const at = locateOnScreenItem(list, id, ctx);
    if (!at) return { error: 'missing' };
    // Already in the destination on the live doc (e.g. another device moved
    // it) — nothing to move, just patch it in place.
    if (!at.neverSaved && list[at.catIdx] && list[at.catIdx].name === destCatName) {
        const p = planItemPatch({ list, id, patch: patch || {} }, ctx);
        return { ...p, newId: id, idMigration: {}, tombstones: [] };
    }
    if (at.neverSaved && master[at.homeIdx].name === destCatName) {
        const p = planItemPatch({ list, id, patch: patch || {} }, ctx);
        return { ...p, newId: id, idMigration: {}, tombstones: [] };
    }
    const bIdx = builtInIndex(master);
    let working = list;
    let source;
    let savedId;
    if (at.neverSaved) {
        source = { ...at.masterItem };
        savedId = id;
    } else {
        savedId = at.savedId;
        // Master fields ride along where the merge was layering them (a
        // built-in shown under its own id in its home) — the new id has no
        // master twin to layer from.
        const bi = bIdx.get(savedId);
        const tomb = new Set(ctx.deletedMasterIds || []);
        const layered = !!bi && !tomb.has(savedId) && savedId === id && list[at.catIdx].name === master[bi.catIdx].name;
        source = layered ? layerMasterFields(at.item, bi.item) : { ...at.item };
        working = list.map((c, i) => i !== at.catIdx ? c : { ...c, items: c.items.filter((_, j) => j !== at.itemIdx) });
    }
    let destIdx = working.findIndex(c => c && c.name === destCatName);
    if (destIdx === -1) {
        if (!master.some(c => c.name === destCatName)) return { error: 'missing' };
        working = [...working, { name: destCatName, items: [] }];
        destIdx = working.length - 1;
    }
    // Fresh id under the destination's MERGED index — skips live ids, ids the
    // merge presents, every built-in id, tombstones and leftover count keys.
    const newId = nextCatalogItemId(working, destCatName, ctx);
    // Copy without view-only decorations (vendor/split rows carry these).
    const { catIdx: _ci, itemIdx: _ii, catName: _cn, catNameEs: _ce, ...clean } = source;
    const moved = { ...clean, ...(patch || {}), id: newId };
    working = working.map((c, i) => i === destIdx ? { ...c, items: insertNearSameSubcat(c.items || [], moved) } : c);
    // Tombstone only a built-in shown under its OWN id (a legacy renumbered
    // copy has a separate on-screen twin that must stay).
    const tombstones = bIdx.has(savedId) && savedId === id ? [savedId] : [];
    return { customInventory: working, newId, idMigration: { [savedId]: newId }, tombstones };
}

// Delete an item. A built-in shown under its own id is tombstoned (else the
// merge re-adds it on the next load); its count + meta are cleared in the
// same write.
export function planItemDelete({ list, id }, ctx) {
    const master = ctx.masterCategories || [];
    const at = locateOnScreenItem(list, id, ctx);
    if (!at) return { customInventory: list, tombstones: [], clearCountIds: [id], missing: true };
    if (at.neverSaved) return { customInventory: list, tombstones: [id], clearCountIds: [id], missing: false };
    const savedId = at.savedId;
    const working = list.map((c, i) => i !== at.catIdx ? c : { ...c, items: c.items.filter((_, j) => j !== at.itemIdx) });
    const isBuiltIn = builtInIndex(master).has(savedId);
    return {
        customInventory: working,
        tombstones: isBuiltIn && savedId === id ? [savedId] : [],
        clearCountIds: savedId === id ? [id] : [savedId, id],
        missing: false,
    };
}

// Reorder: swap the item with the neighbor the user SAW (by id); falls back
// to the adjacent live position when that neighbor isn't in the same saved
// category.
export function planItemSwap({ list, id, neighborId, direction }, ctx) {
    const at = locateOnScreenItem(list, id, ctx);
    if (!at || at.neverSaved) return { error: 'missing' };
    const items = [...(list[at.catIdx].items || [])];
    const nb = neighborId != null ? locateOnScreenItem(list, neighborId, ctx) : null;
    let j = nb && !nb.neverSaved && nb.catIdx === at.catIdx ? nb.itemIdx : -1;
    if (j === -1) j = at.itemIdx + (direction < 0 ? -1 : 1);
    if (j < 0 || j >= items.length || j === at.itemIdx) return { customInventory: list, noop: true };
    [items[at.itemIdx], items[j]] = [items[j], items[at.itemIdx]];
    return { customInventory: list.map((c, i) => i === at.catIdx ? { ...c, items } : c) };
}
