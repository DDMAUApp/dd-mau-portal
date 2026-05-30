#!/usr/bin/env node
// clean-drinks.mjs
//
// One-shot inventory cleanup on the LIVE customInventory data at
// /ops/inventory_{location}. Three operations, all surgical:
//
//   1. Drinks: replace bloated bucket (~505 items at Webster) with
//      the canonical 24 from src/data/inventory.js.
//   2. Other: empty out (Andrew: "all of the items in the other
//      category needs to be deleted"). The header stays so it can
//      be re-populated cleanly if a vendor scraper ever needs a
//      catch-all again.
//   3. Dry Items: remove items whose canonical seed id points to
//      Drinks (id starts with "8-"). Andrew: "dry items have the
//      same drinks too get rid of the drinks in dry items". Leaves
//      legit dry-goods entries alone.
//
// Safety:
//   • Pre-change snapshot of the doc written to /backups/.
//   • One Firestore write per location, atomic.
//   • Idempotent — re-running after a clean run does the same work
//     against the new state (Drinks already 24 → still 24; Other
//     already 0 → still 0; no misplaced drinks → no-op).
//
// Run from repo root:
//   node scripts/clean-drinks.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');
const credsPath  = path.join(repoRoot, 'firebase-service-account.json');

// Load the canonical seed.
const seedModuleUrl = 'file://' + path.join(repoRoot, 'src/data/inventory.js');
const { INVENTORY_CATEGORIES } = await import(seedModuleUrl);
const seedDrinks = INVENTORY_CATEGORIES.find(c => c.name === 'Drinks');
if (!seedDrinks) {
    console.error('❌ INVENTORY_CATEGORIES has no "Drinks" — bail.');
    process.exit(1);
}
const cleanDrinksItems = (seedDrinks.items || []).map(it => ({ ...it }));

// Boot admin.
const creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
initializeApp({ credential: cert(creds) });
const db = getFirestore();

const backupDir = path.join(repoRoot, 'backups');
await fs.mkdir(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// Map an item.id ("{catIdx}-{itemIdx}") onto its canonical seed
// category name. Returns null for vendor-only items (ids like
// "sysco:1234" or bare SKUs).
function seedCategoryNameFor(id) {
    const s = String(id || '');
    const dash = s.indexOf('-');
    if (dash <= 0) return null;
    const seedCatIdx = Number(s.slice(0, dash));
    if (!Number.isFinite(seedCatIdx)) return null;
    const found = INVENTORY_CATEGORIES.find(c => c.id === seedCatIdx);
    return found ? found.name : null;
}

async function cleanLocation(loc) {
    console.log(`\n=== ${loc} ===`);
    const ref = db.doc(`ops/inventory_${loc}`);
    const doc = await ref.get();
    if (!doc.exists) {
        console.log(`  (no doc — skipping)`);
        return;
    }
    const data = doc.data() || {};
    const ci = Array.isArray(data.customInventory) ? data.customInventory : null;
    if (!ci) {
        console.log(`  (no customInventory field — skipping)`);
        return;
    }

    // Snapshot before touching anything.
    const backupPath = path.join(backupDir, `inventory-${loc}-${stamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify({
        location: loc,
        capturedAt: new Date().toISOString(),
        reason: 'pre-clean-drinks-other-dryitems',
        customInventory: ci,
    }, null, 2));
    console.log(`  Backup: ${path.relative(repoRoot, backupPath)}`);

    const next = ci.map(cat => {
        const items = cat.items || [];
        if (cat.name === 'Drinks') {
            console.log(`  Drinks: ${items.length} → ${cleanDrinksItems.length} (seed)`);
            return {
                ...cat,
                nameEs: seedDrinks.nameEs || cat.nameEs || 'Bebidas',
                items: cleanDrinksItems.map(it => ({ ...it })),
            };
        }
        if (cat.name === 'Other') {
            console.log(`  Other: ${items.length} → 0 (emptied)`);
            return { ...cat, items: [] };
        }
        if (cat.name === 'Dry Items') {
            // Surgical: drop anything whose canonical seed id points
            // to a non-"Dry Items" bucket. Leaves vendor-only items
            // and legit Dry Items entries intact.
            const kept = [];
            const dropped = [];
            for (const it of items) {
                const seedName = seedCategoryNameFor(it.id);
                if (seedName && seedName !== 'Dry Items') {
                    dropped.push({ id: it.id, name: it.name, belongsIn: seedName });
                } else {
                    kept.push(it);
                }
            }
            if (dropped.length > 0) {
                const byBucket = {};
                for (const d of dropped) byBucket[d.belongsIn] = (byBucket[d.belongsIn] || 0) + 1;
                const breakdown = Object.entries(byBucket).map(([k, v]) => `${v} from ${k}`).join(', ');
                console.log(`  Dry Items: ${items.length} → ${kept.length} (removed ${dropped.length}: ${breakdown})`);
            } else {
                console.log(`  Dry Items: no misplaced items found (${items.length} kept)`);
            }
            return { ...cat, items: kept };
        }
        return cat;
    });

    await ref.update({
        customInventory: next,
        date: new Date().toISOString(),
    });
    console.log(`  ✓ Wrote ${loc} customInventory.`);
}

for (const loc of ['webster', 'maryland']) {
    await cleanLocation(loc);
}

console.log('\nDone.');
process.exit(0);
