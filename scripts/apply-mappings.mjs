#!/usr/bin/env node
// scripts/apply-mappings.mjs
//
// Companion to mapper-server.mjs. Reads an exported mappings.json,
// rewrites src/data/inventory.js using ONLY the matched + kept-separate
// items (drops + pending get deleted), and emits a remap log.
//
// Andrew: "everything i added to the new export mapping in the
// inventory, make the matched and keep separate be the only items in
// the master list. delete everything else"
//
// What the rewrite does:
//   1. New categories from the uploaded master, in this order:
//        Proteins, Veggies, Dairy, Sauces & Condiments, Dry Items,
//        Cold Items, Supplies, Cleaning Supplies, Other (catch-all).
//   2. For each matched group (multiple current items pointing to the
//      same new master item), output one consolidated entry:
//        • name + Spanish name from the uploaded master
//        • preferredVendor / vendorOptions / pack / price carried over
//          from the matched current item(s) — primary is the first
//          matched current with meaningful vendor data, others merged
//          into vendorOptions
//   3. For each keep-separate item, output it AS-IS but placed under
//      its mapped new category (e.g. current "Produce" → new "Veggies").
//      Items whose current category doesn't map cleanly land in "Other".
//   4. Dropped + pending current items are NOT carried over.
//   5. New master items that had ZERO current matches are ALSO NOT
//      carried over (per the instruction — only matched+kept).
//
// Item IDs are regenerated from scratch ({catIdx}-{itemIdx}). The
// remap log at scripts/data/inventory-remap.json records every
// old → new ID mapping so a Firestore counts migration can be run
// later if needed. Active counts in /ops/inventory_{loc}.counts will
// silently drop off the UI on next load for any item whose ID
// changed — that's an accepted consequence of the rebuild.
//
// Safety: writes src/data/inventory.js.bak (overwrites any prior
// backup) before rewriting. `mv .bak inventory.js` reverts.
//
// Usage:
//   node scripts/apply-mappings.mjs <mappings-file.json> [--pending=keep|drop]
//
// --pending=keep   Treat any current item still in "pending" state as
//                  if it were marked keep-separate. Use when the user
//                  intended every undecided item to stay in the list.
//                  Default is drop (the strict "matched + keep only"
//                  interpretation).

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const inventoryPath = path.join(repoRoot, 'src', 'data', 'inventory.js');
const backupPath = inventoryPath + '.bak';
const newMasterPath = path.join(repoRoot, 'scripts', 'data', 'new-master.json');
const remapOutPath = path.join(repoRoot, 'scripts', 'data', 'inventory-remap.json');

const args = process.argv.slice(2);
const mappingsFile = args.find(a => !a.startsWith('--'));
const pendingFlag = (args.find(a => a.startsWith('--pending=')) || '--pending=drop').split('=')[1];
const treatPendingAsKeep = pendingFlag === 'keep';
if (!mappingsFile) {
    console.error('Usage: node scripts/apply-mappings.mjs <mappings-file.json> [--pending=keep|drop]');
    process.exit(1);
}

// ── load ────────────────────────────────────────────────────────
const mappingsRaw = JSON.parse(await readFile(mappingsFile, 'utf8'));
const mappings = mappingsRaw.mappings || mappingsRaw;
const newMaster = JSON.parse(await readFile(newMasterPath, 'utf8'));
const invHref = pathToFileURL(inventoryPath).href + '?t=' + Date.now();
const invMod = await import(invHref);
const currentCategories = invMod.INVENTORY_CATEGORIES;

// Index current items by id (with their current category for keep-separate routing)
const currentById = {};
for (const cat of currentCategories) {
    for (const it of (cat.items || [])) {
        currentById[it.id] = { ...it, _curCat: cat.name };
    }
}

// Reverse-lookup for newKey → new master item
function slug(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}
const newByKey = {};
for (const cat of newMaster.categories) {
    for (const it of cat.items) {
        const key = `${slug(cat.name)}:${slug(it.en)}`;
        newByKey[key] = { ...it, _newCat: cat.name };
    }
}

// ── 1. group matched mappings by newKey ─────────────────────────
const groups = new Map(); // newKey → { newItem, currentItems: [] }
let dropped = 0, droppedPending = 0, pendingPromotedToKeep = 0;
for (const id in mappings) {
    const m = mappings[id];
    if (m.action === 'drop') { dropped++; continue; }
    if (m.action === 'pending') {
        if (treatPendingAsKeep) {
            // Re-tag as keep so the keep-collection pass below picks it up.
            m.action = 'keep';
            m.newKey = null;
            pendingPromotedToKeep++;
            continue;
        }
        droppedPending++;
        continue;
    }
    if (m.action !== 'match') continue;
    if (!m.newKey) continue;
    if (!newByKey[m.newKey]) {
        console.warn(`WARN: mapping ${id} → ${m.newKey} (new key not found)`);
        continue;
    }
    if (!groups.has(m.newKey)) {
        groups.set(m.newKey, { newKey: m.newKey, newItem: newByKey[m.newKey], currentItems: [] });
    }
    const cur = currentById[id];
    if (cur) groups.get(m.newKey).currentItems.push(cur);
}

// ── 2. collect keep-separate items ──────────────────────────────
const keepItems = [];
for (const id in mappings) {
    if (mappings[id].action !== 'keep') continue;
    const cur = currentById[id];
    if (cur) keepItems.push(cur);
}

// ── 3. build the new category structure ─────────────────────────
// Friendly names (lowercase the SHOUTING from the original xlsx).
const NEW_CAT_NICE = {
    "Proteins": "Proteins",
    "VEGGIES": "Veggies",
    "DAIRY": "Dairy",
    "SAUCES/ CONDIMENTS": "Sauces & Condiments",
    "DRY ITEMS": "Dry Items",
    "COLD ITEMS": "Cold Items",
    "SUPPLIES": "Supplies",
    "CLEANING SUPPLIES": "Cleaning Supplies",
};
const NEW_CAT_ES = {
    "Proteins": "Proteínas",
    "Veggies": "Verduras",
    "Dairy": "Lácteos",
    "Sauces & Condiments": "Salsas y Condimentos",
    "Dry Items": "Productos Secos",
    "Cold Items": "Productos Fríos",
    "Supplies": "Suministros",
    "Cleaning Supplies": "Suministros de Limpieza",
    "Other": "Otros",
};
// Map a current-list category (from before the rebuild) to a new-master friendly name.
// Anything not mapped lands in "Other".
const CURRENT_TO_NEW = {
    "Proteins": "Proteins",
    "Produce": "Veggies",
    "Dairy & Eggs": "Dairy",
    "Sauces & Seasonings": "Sauces & Condiments",
    "Pantry & Dry": "Dry Items",
    "Frozen": "Cold Items",
    "Beverages": "Dry Items",
    "Paper & Supplies": "Supplies",
    "Cleaning": "Cleaning Supplies",
};

const NEW_CAT_ORDER = [
    "Proteins", "Veggies", "Dairy", "Sauces & Condiments",
    "Dry Items", "Cold Items", "Supplies", "Cleaning Supplies",
];

// Build per-category item lists.
// First: matched groups, placed by their new master's category.
const byNiceCat = {};
for (const niceName of NEW_CAT_ORDER) byNiceCat[niceName] = [];
for (const g of groups.values()) {
    const niceName = NEW_CAT_NICE[g.newItem._newCat] || "Other";
    if (!byNiceCat[niceName]) byNiceCat[niceName] = [];
    byNiceCat[niceName].push({ kind: 'matched', group: g });
}
// Sort matched within each category by EN name for stable readable output.
for (const niceName of Object.keys(byNiceCat)) {
    byNiceCat[niceName].sort((a, b) => {
        const an = a.group.newItem.en.toLowerCase();
        const bn = b.group.newItem.en.toLowerCase();
        return an.localeCompare(bn);
    });
}
// Then: keep-separate items routed by their CURRENT category.
const otherKeeps = [];
for (const cur of keepItems) {
    const niceName = CURRENT_TO_NEW[cur._curCat];
    if (niceName && byNiceCat[niceName]) {
        byNiceCat[niceName].push({ kind: 'keep', current: cur });
    } else {
        otherKeeps.push({ kind: 'keep', current: cur });
    }
}
if (otherKeeps.length > 0) {
    byNiceCat["Other"] = otherKeeps.sort((a, b) =>
        (a.current.name || '').toLowerCase().localeCompare((b.current.name || '').toLowerCase()));
}

// ── 4. emit inventory.js source ─────────────────────────────────
function jsLit(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(jsLit).join(', ') + ']';
    if (typeof v === 'object') {
        const parts = Object.entries(v).map(([k, val]) => `${k}: ${jsLit(val)}`);
        return '{ ' + parts.join(', ') + ' }';
    }
    return JSON.stringify(v);
}

const out = [];
out.push('// src/data/inventory.js');
out.push('//');
out.push('// Master inventory catalog. Regenerated by scripts/apply-mappings.mjs');
out.push(`// from ${path.basename(mappingsFile)} on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}.`);
out.push('//');
out.push('// Source of truth for the inventory tab\'s item list (when no');
out.push('// custom /inventory_lists is active). Each item has a unique id');
out.push('// of the form "{catIdx}-{itemIdx}". Counts in Firestore at');
out.push('// /ops/inventory_{location}.counts are keyed by these ids — see');
out.push('// scripts/data/inventory-remap.json for the migration from the');
out.push('// previous id scheme if you need to remap historical counts.');
out.push('');
out.push('export const INVENTORY_CATEGORIES = [');

const remap = {}; // oldId → newId
const droppedIds = [];

const catEntries = Object.entries(byNiceCat).filter(([, items]) => items.length > 0);
let catIdx = 0;
for (const [niceName, items] of catEntries) {
    out.push('    {');
    out.push(`        id: ${catIdx},`);
    out.push(`        name: ${JSON.stringify(niceName)},`);
    out.push(`        nameEs: ${JSON.stringify(NEW_CAT_ES[niceName] || niceName)},`);
    out.push('        items: [');
    let itemIdx = 0;
    for (const slot of items) {
        const newId = `${catIdx}-${itemIdx}`;
        let item;
        if (slot.kind === 'matched') {
            const g = slot.group;
            const ni = g.newItem;
            const curs = g.currentItems;
            // primary: first current with vendorOptions or a price
            const primary = curs.find(c => (c.vendorOptions && c.vendorOptions.length > 0) || c.price != null)
                          || curs[0];
            // Merge vendorOptions across all matched currents — preserve
            // order, dedupe by vendor name (case-insensitive).
            const seen = new Set();
            const vendorOptions = [];
            for (const c of curs) {
                for (const vo of (c.vendorOptions || [])) {
                    const key = String(vo.vendor || '').toLowerCase();
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    vendorOptions.push({
                        vendor: vo.vendor,
                        price: vo.price ?? null,
                        pack: vo.pack || '',
                    });
                }
            }
            // If the new master had a vendor1/vendor2 the currents don't, add it.
            for (const v of [ni.vendor1, ni.vendor2]) {
                if (!v) continue;
                const key = v.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                vendorOptions.push({ vendor: v, price: null, pack: '' });
            }
            const preferredVendor = primary?.preferredVendor || ni.vendor1 || (vendorOptions[0]?.vendor || '');
            item = {
                id: newId,
                name: ni.en,
                nameEs: ni.es || primary?.nameEs || '',
                vendor: preferredVendor,
                pack: primary?.pack || '',
                price: primary?.price ?? null,
                preferredVendor,
                vendorOptions,
            };
            for (const c of curs) remap[c.id] = newId;
        } else {
            const cur = slot.current;
            item = {
                id: newId,
                name: cur.name,
                nameEs: cur.nameEs || '',
                vendor: cur.vendor || '',
                pack: cur.pack || '',
                price: cur.price ?? null,
                preferredVendor: cur.preferredVendor || cur.vendor || '',
                vendorOptions: cur.vendorOptions || [],
            };
            remap[cur.id] = newId;
        }
        out.push(`            ${jsLit(item)},`);
        itemIdx++;
    }
    out.push('        ]');
    out.push('    },');
    catIdx++;
}
out.push('];');
out.push('');

// Build droppedIds
for (const id in mappings) {
    const a = mappings[id].action;
    if (a === 'drop' || a === 'pending') droppedIds.push(id);
}

// ── 5. write files ──────────────────────────────────────────────
await copyFile(inventoryPath, backupPath);
await writeFile(inventoryPath, out.join('\n'), 'utf8');

const remapPayload = {
    appliedAt: new Date().toISOString(),
    sourceMappings: path.basename(mappingsFile),
    sourceXlsx: newMaster.sourceFile,
    summary: {
        matchedGroups: groups.size,
        matchedCurrentItems: Object.values(mappings).filter(m => m.action === 'match').length,
        keptSeparate: keepItems.length,
        droppedExplicit: dropped,
        droppedPending: droppedPending,
        pendingPromotedToKeep,
        pendingFlag,
        finalCategoryCount: catEntries.length,
        finalItemCount: catEntries.reduce((s, [, items]) => s + items.length, 0),
    },
    remap,
    droppedIds,
};
await writeFile(remapOutPath, JSON.stringify(remapPayload, null, 2));

console.log('');
console.log('  ✓ Wrote', inventoryPath);
console.log('  ✓ Backup at', backupPath);
console.log('  ✓ Remap log at', remapOutPath);
console.log('');
console.log('  Summary:');
console.log(`    matched groups       : ${remapPayload.summary.matchedGroups}`);
console.log(`    matched current items: ${remapPayload.summary.matchedCurrentItems}  (consolidated into the groups above)`);
console.log(`    kept separate        : ${remapPayload.summary.keptSeparate}`);
console.log(`    dropped (explicit)   : ${remapPayload.summary.droppedExplicit}`);
console.log(`    dropped (pending)    : ${remapPayload.summary.droppedPending}`);
console.log(`    pending → keep       : ${remapPayload.summary.pendingPromotedToKeep}  (--pending=${pendingFlag})`);
console.log(`    final categories     : ${remapPayload.summary.finalCategoryCount}`);
console.log(`    final items          : ${remapPayload.summary.finalItemCount}`);
console.log('');
console.log('  Restore previous inventory.js with:');
console.log(`    mv ${backupPath} ${inventoryPath}`);
console.log('');
