import { describe, it, expect } from 'vitest';
import {
    mergeSavedInventory, layerMasterFields, isListOverride, findItemById,
    mergedCategoryIndex, allocateItemId, nextCatalogItemId, insertNearSameSubcat,
    planIdRemapWrites, planItemPatch, planItemMove, planItemDelete, planItemSwap,
    locateOnScreenItem,
} from './inventoryCatalog';
import { INVENTORY_CATEGORIES } from './inventory';

const DEL = { __del: true };

const MASTER = [
    { name: 'Produce', nameEs: 'Verduras', items: [
        { id: '0-0', name: 'Lettuce', vendor: 'Sysco', pack: '24ct' },
        { id: '0-1', name: 'Tomato', vendor: 'Sysco', pack: '25lb' },
        { id: '0-2', name: 'Onion' },
    ] },
    { name: 'Proteins', nameEs: 'Proteínas', items: [
        { id: '1-0', name: 'Chicken', subcat: 'Chicken' },
        { id: '1-1', name: 'Beef', subcat: 'Beef' },
    ] },
    { name: 'Paper', items: [{ id: '2-0', name: 'Napkins' }] },
];
const clone = (x) => JSON.parse(JSON.stringify(x));
const savedFull = () => clone(MASTER).map(c => ({ name: c.name, items: c.items }));
const ctxFor = (data = {}) => ({ masterCategories: MASTER, deletedMasterIds: data.deletedMasterIds || [], counts: data.counts || {}, countMeta: data.countMeta || {} });
const allIds = (list) => list.flatMap(c => c.items.map(i => i.id));
const names = (list, catName) => list.find(c => c.name === catName).items.map(i => i.name);

// ── Verbatim copy of the merge that lived inline in Operations.jsx before the
// extraction (2026-09-23). The randomized test below proves the extracted
// function returns exactly the same thing.
function legacyMerge(INVENTORY_CATEGORIES, data) {
    const tombstones = new Set(data.deletedMasterIds || []);
    const idMigration = {};
    const merged = INVENTORY_CATEGORIES.map((masterCat, masterIdx) => {
        const savedCat = data.customInventory.find(sc => sc.name === masterCat.name);
        const liveMasterItems = masterCat.items.filter(it => !tombstones.has(it.id));
        if (!savedCat) return { ...masterCat, items: [...liveMasterItems] };
        const masterIds = new Set(liveMasterItems.map(it => it.id));
        const masterById = new Map(liveMasterItems.map(it => [it.id, it]));
        const expectedPrefix = `${masterIdx}-`;
        const mergedItems = [];
        const seenIds = new Set();
        (savedCat.items || []).forEach(si => {
            let newId = si.id;
            if (typeof si.id === "string" && !si.id.startsWith(expectedPrefix) && !masterIds.has(si.id)) {
                let n = mergedItems.length;
                while (seenIds.has(`${masterIdx}-${n}`) || masterIds.has(`${masterIdx}-${n}`)) n++;
                newId = `${masterIdx}-${n}`;
                idMigration[si.id] = newId;
            }
            if (seenIds.has(newId)) {
                let n = mergedItems.length;
                while (seenIds.has(`${masterIdx}-${n}`) || masterIds.has(`${masterIdx}-${n}`)) n++;
                const reId = `${masterIdx}-${n}`;
                idMigration[si.id] = reId;
                seenIds.add(reId);
                mergedItems.push({ ...si, id: reId });
                return;
            }
            seenIds.add(newId);
            const mi = masterById.get(newId);
            if (mi) {
                const merged = { ...mi };
                for (const k of Object.keys(si)) {
                    const v = si[k];
                    if (v !== "" && v !== null && v !== undefined) merged[k] = v;
                }
                merged.id = newId;
                mergedItems.push(merged);
            } else {
                mergedItems.push({ ...si, id: newId });
            }
        });
        liveMasterItems.forEach(mi => {
            if (seenIds.has(mi.id)) return;
            seenIds.add(mi.id);
            mergedItems.push({ ...mi });
        });
        return { ...masterCat, items: mergedItems };
    });
    data.customInventory.forEach(sc => {
        if (INVENTORY_CATEGORIES.find(mc => mc.name === sc.name)) return;
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
            return { ...si, id: newId };
        });
        merged.push({ ...sc, items: renumbered });
    });
    return { merged, idMigration };
}

// Tiny deterministic PRNG so the fuzz is reproducible.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

describe('mergeSavedInventory — parity with the original inline merge', () => {
    it('matches the legacy merge on 400 random saved docs (real catalog)', () => {
        const r = rng(42);
        const pick = (arr) => arr[Math.floor(r() * arr.length)];
        const master = INVENTORY_CATEGORIES;
        const allMasterIds = master.flatMap(c => c.items.map(i => i.id));
        for (let t = 0; t < 400; t++) {
            const saved = [];
            const catNames = [...master.map(c => c.name), 'Custom A', 'Custom B', 'Hallway'];
            const nCats = 1 + Math.floor(r() * catNames.length);
            for (let c = 0; c < nCats; c++) {
                const name = pick(catNames);
                const items = [];
                const nItems = Math.floor(r() * 8);
                for (let i = 0; i < nItems; i++) {
                    const kind = r();
                    const id = kind < 0.5 ? pick(allMasterIds)
                        : kind < 0.8 ? `${Math.floor(r() * 14)}-${Math.floor(r() * 30)}`
                            : kind < 0.9 ? 12345 : `weird${i}`;
                    items.push({ id, name: `n${i}`, vendor: r() < 0.5 ? '' : 'V', pack: r() < 0.3 ? null : 'p' });
                }
                saved.push({ name, items });
            }
            const tomb = allMasterIds.filter(() => r() < 0.05);
            const a = mergeSavedInventory(master, clone(saved), tomb);
            const b = legacyMerge(master, { customInventory: clone(saved), deletedMasterIds: tomb });
            expect(a).toEqual(b);
        }
    });

    it('is idempotent: merging its own output needs no migration', () => {
        const saved = [{ name: 'Proteins', items: [{ id: '0-1', name: 'Tomato' }, { id: '1-0', name: 'Chicken' }] }, { name: 'Hallway', items: [{ id: 'x', name: 'Tongs' }] }];
        const once = mergeSavedInventory(MASTER, saved, []);
        expect(Object.keys(once.idMigration).length).toBeGreaterThan(0);
        const twice = mergeSavedInventory(MASTER, once.merged, []);
        expect(twice.idMigration).toEqual({});
        expect(twice.merged).toEqual(once.merged);
    });

    it('re-adds a built-in the saved doc lacks unless tombstoned', () => {
        const saved = [{ name: 'Produce', items: [{ id: '0-0', name: 'Lettuce' }, { id: '0-2', name: 'Onion' }] }];
        expect(names(mergeSavedInventory(MASTER, saved, []).merged, 'Produce')).toEqual(['Lettuce', 'Onion', 'Tomato']);
        expect(names(mergeSavedInventory(MASTER, saved, ['0-1']).merged, 'Produce')).toEqual(['Lettuce', 'Onion']);
    });

    it('layers master fields under saved ones (saved non-empty wins)', () => {
        expect(layerMasterFields({ id: '0-0', vendor: '', pack: '6ct', name: 'L2' }, MASTER[0].items[0]))
            .toEqual({ id: '0-0', name: 'L2', vendor: 'Sysco', pack: '6ct' });
    });
});

describe('C1 — moving an item across categories', () => {
    it('OLD behavior (kept id) duplicated the built-in and forced a migration — documents the bug', () => {
        const saved = savedFull();
        const tomato = saved[0].items.splice(1, 1)[0];
        saved[1].items.push(tomato);                         // id '0-1' now under Proteins
        const { merged, idMigration } = mergeSavedInventory(MASTER, saved, []);
        expect(names(merged, 'Produce')).toContain('Tomato'); // re-added from master
        expect(names(merged, 'Proteins')).toContain('Tomato');
        expect(idMigration['0-1']).toBeDefined();            // every device would migrate
    });

    it('new id in the destination + tombstone → one copy, no migration', () => {
        const saved = savedFull();
        const plan = planItemMove({ list: saved, id: '0-1', fromCatName: 'Produce', destCatName: 'Proteins', patch: { subcat: '' } }, ctxFor());
        expect(plan.error).toBeUndefined();
        expect(plan.newId).toBe('1-2');
        expect(plan.idMigration).toEqual({ '0-1': '1-2' });
        expect(plan.tombstones).toEqual(['0-1']);
        const { merged, idMigration } = mergeSavedInventory(MASTER, plan.customInventory, ['0-1']);
        expect(idMigration).toEqual({});
        expect(names(merged, 'Produce')).toEqual(['Lettuce', 'Onion']);
        expect(names(merged, 'Proteins')).toEqual(['Chicken', 'Beef', 'Tomato']);
        // master fields ride along (the new id has no master twin to layer from)
        const moved = merged[1].items.find(i => i.id === '1-2');
        expect(moved).toMatchObject({ name: 'Tomato', vendor: 'Sysco', pack: '25lb' });
    });

    it('carries sparse saved fields through the master layer', () => {
        const saved = savedFull();
        saved[0].items[1] = { id: '0-1', name: 'Roma', vendor: '', pack: '' };
        const plan = planItemMove({ list: saved, id: '0-1', fromCatName: 'Produce', destCatName: 'Paper', patch: {} }, ctxFor());
        const moved = plan.customInventory.find(c => c.name === 'Paper').items.find(i => i.id === plan.newId);
        expect(moved).toMatchObject({ name: 'Roma', vendor: 'Sysco', pack: '25lb' });
        expect(plan.newId).toBe('2-1');
    });

    it('lands next to its subcat siblings', () => {
        const saved = savedFull();
        const plan = planItemMove({ list: saved, id: '0-2', fromCatName: 'Produce', destCatName: 'Proteins', patch: { subcat: 'Chicken' } }, ctxFor());
        expect(names(plan.customInventory, 'Proteins')).toEqual(['Chicken', 'Onion', 'Beef']);
    });

    it('a custom item moves without a tombstone', () => {
        const saved = savedFull();
        saved[0].items.push({ id: '0-3', name: 'Basil' });
        const plan = planItemMove({ list: saved, id: '0-3', fromCatName: 'Produce', destCatName: 'Paper', patch: {} }, ctxFor());
        expect(plan.tombstones).toEqual([]);
        expect(mergeSavedInventory(MASTER, plan.customInventory, []).idMigration).toEqual({});
    });

    it('resolves the item by id even if it sits in another live category', () => {
        const saved = savedFull();
        saved[2].items.push({ id: '2-1', name: 'Cups' });
        const plan = planItemMove({ list: saved, id: '2-1', fromCatName: 'Produce', destCatName: 'Proteins', patch: {} }, ctxFor());
        expect(names(plan.customInventory, 'Paper')).toEqual(['Napkins']);
        expect(names(plan.customInventory, 'Proteins')).toContain('Cups');
    });

    it('already in the destination on the live doc → plain patch, id kept', () => {
        const saved = savedFull();
        const plan = planItemMove({ list: saved, id: '1-1', fromCatName: 'Produce', destCatName: 'Proteins', patch: { pack: 'x' } }, ctxFor());
        expect(plan.idMigration).toEqual({});
        expect(plan.customInventory[1].items[1]).toMatchObject({ id: '1-1', pack: 'x' });
    });

    it('never-saved built-in moves using the on-screen copy', () => {
        const saved = [{ name: 'Proteins', items: clone(MASTER[1].items) }];
        const plan = planItemMove({ list: saved, id: '0-1', fromCatName: 'Produce', destCatName: 'Proteins', patch: {}, fallbackItem: { ...MASTER[0].items[1], catIdx: 0, itemIdx: 1, catName: 'Produce' } }, ctxFor());
        expect(plan.error).toBeUndefined();
        const moved = plan.customInventory[0].items.find(i => i.id === plan.newId);
        expect(moved).toEqual({ id: '1-2', name: 'Tomato', vendor: 'Sysco', pack: '25lb' });
        expect(plan.tombstones).toEqual(['0-1']);
    });

    it('unknown item / unknown destination → missing', () => {
        expect(planItemMove({ list: savedFull(), id: '9-9', fromCatName: 'Produce', destCatName: 'Paper', patch: {} }, ctxFor()).error).toBe('missing');
        expect(planItemMove({ list: savedFull(), id: '0-1', fromCatName: 'Produce', destCatName: 'Nope', patch: {} }, ctxFor()).error).toBe('missing');
    });

    it('creates a master destination the saved doc lacks, with a merge-stable id', () => {
        const saved = savedFull().slice(0, 2);
        const plan = planItemMove({ list: saved, id: '0-0', fromCatName: 'Produce', destCatName: 'Paper', patch: {} }, ctxFor());
        expect(plan.newId).toBe('2-1');
        expect(mergeSavedInventory(MASTER, plan.customInventory, ['0-0']).idMigration).toEqual({});
    });
});

describe('C2 — deleting built-ins + id allocation', () => {
    it('delete tombstones a built-in so the merge does not bring it back', () => {
        const saved = savedFull();
        const plan = planItemDelete({ list: saved, id: '0-1', catName: 'Produce' }, ctxFor());
        expect(plan.tombstones).toEqual(['0-1']);
        expect(plan.clearCountIds).toEqual(['0-1']);
        expect(names(mergeSavedInventory(MASTER, plan.customInventory, plan.tombstones).merged, 'Produce')).toEqual(['Lettuce', 'Onion']);
    });
    it('custom delete: no tombstone; never-saved built-in: tombstone only', () => {
        const saved = savedFull();
        saved[2].items.push({ id: '2-1', name: 'Cups' });
        expect(planItemDelete({ list: saved, id: '2-1', catName: 'Paper' }, ctxFor()).tombstones).toEqual([]);
        const onlyProteins = [{ name: 'Proteins', items: clone(MASTER[1].items) }];
        const p = planItemDelete({ list: onlyProteins, id: '0-1', catName: 'Produce' }, ctxFor());
        expect(p.customInventory).toBe(onlyProteins);
        expect(p.tombstones).toEqual(['0-1']);
        expect(p.missing).toBe(false);
        expect(planItemDelete({ list: saved, id: 'gone', catName: 'Paper' }, ctxFor()).missing).toBe(true);
    });
    it('new ids skip deleted (tombstoned) and hidden built-in ids', () => {
        const saved = savedFull();
        saved[0].items = saved[0].items.filter(i => i.id !== '0-1'); // [0-0, 0-2], 0-1 deleted
        const id = nextCatalogItemId(saved, 'Produce', ctxFor({ deletedMasterIds: ['0-1'] }));
        expect(id).toBe('0-3');
        // even with startAt below the built-ins
        expect(allocateItemId({ catIdx: 0, lists: [], masterCategories: MASTER, startAt: 0 })).toBe('0-3');
    });
    it('new ids skip leftover counts / countMeta keys', () => {
        expect(allocateItemId({ catIdx: 2, lists: [savedFull()], masterCategories: MASTER, counts: { '2-1': 4 }, countMeta: { '2-2': {} }, startAt: 1 })).toBe('2-3');
    });
    it('new ids use the MERGED index, not the saved-array position', () => {
        // saved doc lists Paper first and has a custom category in between
        const saved = [{ name: 'Paper', items: [] }, { name: 'Hallway', items: [{ id: '3-0', name: 'Tongs' }] }, { name: 'Produce', items: [] }];
        expect(mergedCategoryIndex(saved, 'Paper', MASTER)).toBe(2);
        expect(mergedCategoryIndex(saved, 'Hallway', MASTER)).toBe(3);
        expect(mergedCategoryIndex(saved, 'New custom', MASTER)).toBe(4);
        expect(nextCatalogItemId(saved, 'Paper', ctxFor())).toBe('2-1');
        expect(nextCatalogItemId(saved, 'Hallway', ctxFor())).toBe('3-1');
    });
    it('new ids avoid ids the merge will present for not-yet-migrated items', () => {
        // Proteins holds an off-prefix item the merge renumbers to 1-2
        const saved = savedFull();
        saved[1].items.push({ id: '7-7', name: 'Pork' });
        const presented = mergeSavedInventory(MASTER, saved, []).idMigration['7-7'];
        const id = nextCatalogItemId(saved, 'Proteins', ctxFor());
        expect(id).not.toBe(presented);
        const withNew = clone(saved); withNew[1].items.push({ id, name: 'Lamb' });
        const m = mergeSavedInventory(MASTER, withNew, []).merged;
        expect(new Set(allIds(m)).size).toBe(allIds(m).length);
        expect(m[1].items.find(i => i.name === 'Lamb').id).toBe(id);
    });
});

describe('planIdRemapWrites — counts follow the id, dotted paths only', () => {
    it('moves count + meta and deletes the old keys', () => {
        expect(planIdRemapWrites({ '0-1': '1-2' }, { '0-1': 3, '0-0': 1 }, { '0-1': { by: 'A' } }, DEL)).toEqual({
            'counts.1-2': 3, 'counts.0-1': DEL, 'countMeta.1-2': { by: 'A' }, 'countMeta.0-1': DEL,
        });
    });
    it('no count → no writes', () => {
        expect(planIdRemapWrites({ '0-1': '1-2' }, {}, {}, DEL)).toEqual({});
        expect(planIdRemapWrites({}, { a: 1 }, {}, DEL)).toEqual({});
    });
    it('clears a stale count on the target when the source had none', () => {
        expect(planIdRemapWrites({ a: 'b' }, { b: 9 }, {}, DEL)).toEqual({ 'counts.b': DEL });
    });
    it('resolves chains (A→B, B→C) to the final state', () => {
        expect(planIdRemapWrites({ A: 'B', B: 'C' }, { A: 1, B: 2 }, {}, DEL)).toEqual({ 'counts.B': 1, 'counts.C': 2, 'counts.A': DEL });
        expect(planIdRemapWrites({ A: 'B', B: 'C' }, { B: 2 }, {}, DEL)).toEqual({ 'counts.B': DEL, 'counts.C': 2 });
    });
});

describe('M3 — edits resolve by id', () => {
    it('patches the item by id wherever it lives', () => {
        const saved = savedFull();
        const p = planItemPatch({ list: saved, id: '1-1', catName: 'Produce', patch: { min: 2 } }, ctxFor());
        expect(p.customInventory[1].items[1]).toMatchObject({ id: '1-1', min: 2 });
        expect(saved[1].items[1].min).toBeUndefined(); // input untouched
    });
    it('materializes a never-saved built-in into its home category', () => {
        const saved = [{ name: 'Proteins', items: clone(MASTER[1].items) }];
        const p = planItemPatch({ list: saved, id: '0-1', catName: 'Produce', patch: { min: 4 }, fallbackItem: { ...MASTER[0].items[1], catIdx: 0 } }, ctxFor());
        const produce = p.customInventory.find(c => c.name === 'Produce');
        expect(produce.items).toEqual([{ id: '0-1', name: 'Tomato', vendor: 'Sysco', pack: '25lb', min: 4 }]);
        expect(mergeSavedInventory(MASTER, p.customInventory, []).idMigration).toEqual({});
    });
    it('refuses a missing custom item or a tombstoned built-in', () => {
        expect(planItemPatch({ list: savedFull(), id: '5-5', catName: 'Paper', patch: {} }, ctxFor()).error).toBe('missing');
        expect(planItemPatch({ list: [], id: '0-1', catName: 'Produce', patch: {}, fallbackItem: { id: '0-1' } }, ctxFor({ deletedMasterIds: ['0-1'] })).error).toBe('missing');
    });
    it('findItemById prefers the hinted category', () => {
        const list = [{ name: 'A', items: [{ id: 'x' }] }, { name: 'B', items: [{ id: 'x', n: 2 }] }];
        expect(findItemById(list, 'x', 'B')).toMatchObject({ catIdx: 1, itemIdx: 0 });
        expect(findItemById(list, 'x', 'Z')).toMatchObject({ catIdx: 0 });
        expect(findItemById(list, 'y')).toBeNull();
    });
    it('swap uses the neighbor the user saw, by id', () => {
        const saved = savedFull();
        saved[0].items = [saved[0].items[2], saved[0].items[0], saved[0].items[1]]; // Onion, Lettuce, Tomato (live order drifted)
        const p = planItemSwap({ list: saved, id: '0-0', neighborId: '0-1', direction: 1 }, ctxFor());
        expect(names(p.customInventory, 'Produce')).toEqual(['Onion', 'Tomato', 'Lettuce']);
        const fb = planItemSwap({ list: saved, id: '0-2', neighborId: 'gone', direction: 1 }, ctxFor());
        expect(names(fb.customInventory, 'Produce')).toEqual(['Lettuce', 'Onion', 'Tomato']);
        expect(planItemSwap({ list: saved, id: '0-2', neighborId: null, direction: -1 }, ctxFor()).noop).toBe(true);
        expect(planItemSwap({ list: saved, id: 'nope', neighborId: null, direction: 1 }, ctxFor()).error).toBe('missing');
    });
});

describe('small helpers', () => {
    it('isListOverride only for a list with categories', () => {
        expect(isListOverride(null)).toBe(false);
        expect(isListOverride({ categories: [] })).toBe(false);
        expect(isListOverride({ categories: [{ name: 'x', items: [] }] })).toBe(true);
    });
    it('insertNearSameSubcat appends when no sibling', () => {
        expect(insertNearSameSubcat([{ subcat: 'a' }], { subcat: 'b' })).toEqual([{ subcat: 'a' }, { subcat: 'b' }]);
        expect(insertNearSameSubcat([{ subcat: 'a' }, { subcat: 'b' }], { subcat: 'a', n: 1 })).toEqual([{ subcat: 'a' }, { subcat: 'a', n: 1 }, { subcat: 'b' }]);
    });
});

describe('legacy duplicate (a pre-fix move the migration has not persisted yet)', () => {
    // Proteins still stores Tomato under its OLD built-in id '0-1': the merge
    // shows it as '1-2' and ALSO re-adds the built-in '0-1' in Produce.
    const legacy = () => {
        const saved = savedFull();
        const tomato = saved[0].items.splice(1, 1)[0];
        saved[1].items.push({ ...tomato, name: 'Tomato (moved)' });
        return saved;
    };
    it('locateOnScreenItem maps what the user sees to the saved position', () => {
        const saved = legacy();
        expect(locateOnScreenItem(saved, '1-2', ctxFor())).toMatchObject({ catIdx: 1, itemIdx: 2, savedId: '0-1' });
        expect(locateOnScreenItem(saved, '0-1', ctxFor())).toMatchObject({ neverSaved: true });
        expect(locateOnScreenItem(saved, '9-9', ctxFor())).toBeNull();
    });
    it('deleting the re-added twin only tombstones it — the moved copy survives', () => {
        const saved = legacy();
        const p = planItemDelete({ list: saved, id: '0-1' }, ctxFor());
        expect(p.customInventory).toBe(saved);
        expect(p.tombstones).toEqual(['0-1']);
        expect(names(mergeSavedInventory(MASTER, p.customInventory, ['0-1']).merged, 'Proteins')).toContain('Tomato (moved)');
    });
    it('deleting the moved copy removes it, keeps the twin, clears both count keys', () => {
        const saved = legacy();
        const p = planItemDelete({ list: saved, id: '1-2' }, ctxFor());
        expect(p.tombstones).toEqual([]);
        expect(p.clearCountIds).toEqual(['0-1', '1-2']);
        const m = mergeSavedInventory(MASTER, p.customInventory, []).merged;
        expect(names(m, 'Proteins')).not.toContain('Tomato (moved)');
        expect(names(m, 'Produce')).toContain('Tomato');
    });
    it('editing the moved copy patches IT, not the twin', () => {
        const saved = legacy();
        const p = planItemPatch({ list: saved, id: '1-2', patch: { min: 7 } }, ctxFor());
        expect(p.customInventory[1].items[2]).toMatchObject({ id: '0-1', name: 'Tomato (moved)', min: 7 });
        expect(p.customInventory[0].items.some(i => i.id === '0-1')).toBe(false);
    });
    it('moving the moved copy re-keys its saved id and does not tombstone the twin', () => {
        const saved = legacy();
        const p = planItemMove({ list: saved, id: '1-2', destCatName: 'Paper', patch: {} }, ctxFor({ counts: { '0-1': 2 } }));
        expect(p.idMigration).toEqual({ '0-1': p.newId });
        expect(p.newId.startsWith('2-')).toBe(true);
        expect(p.tombstones).toEqual([]);
    });
});
