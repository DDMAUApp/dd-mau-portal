#!/usr/bin/env node
// scripts/reset-inventory-state.mjs
//
// Wipes the per-location inventory state in Firestore so the
// inventory tab renders ONLY from src/data/inventory.js (the new
// 243-item master list). Andrew: "this is the new master list and
// only these items are in it nothing else."
//
// What it clears in each /ops/inventory_{loc} doc:
//   • customInventory   — the per-location item list that supersedes
//                         the master. Years of write-ins live here.
//                         Cleared so the merge falls back to master.
//   • deletedMasterIds  — tombstones marking master items the user
//                         hid. Stale after the rebuild — all 243
//                         items are intentionally in the master now.
//   • counts            — active item counts. Keyed by the OLD ids
//                         which no longer exist in master, so these
//                         are orphaned. Cleared to start fresh.
//   • countMeta         — per-count author/time metadata. Cleared
//                         alongside counts.
//   • vendorCounts      — counts for vendor-only items (from imports).
//                         Also stale.
//
// What it leaves alone:
//   • inventoryHistory_{loc}/* — past snapshots stay intact (each
//                                 snapshot has the full item data
//                                 embedded, so they're self-contained)
//   • inventory_audits_{loc}/* — append-only audit log stays
//   • everything outside /ops/inventory_{loc}
//
// Usage:
//   node scripts/reset-inventory-state.mjs              # dry run — shows what would change
//   node scripts/reset-inventory-state.mjs --apply      # actually writes
//   node scripts/reset-inventory-state.mjs --apply --location=webster   # only one location
//
// Heads-up: any staff currently counting will lose their in-progress
// counts on the targeted locations. Run between inventory cycles, not
// during one.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const onlyLoc = [...args].find(a => a.startsWith('--location='))?.split('=')[1];

const sa = JSON.parse(readFileSync(path.join(repoRoot, 'firebase-service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const allLocs = ['webster', 'maryland'];
const locs = onlyLoc ? [onlyLoc] : allLocs;

console.log('');
console.log('  inventory-state reset');
console.log('  ─────────────────────');
console.log('  mode      :', apply ? '🔥 APPLY' : '🛟 dry run');
console.log('  locations :', locs.join(', '));
console.log('');

let totalCustomItems = 0;
let totalCounts = 0;
let totalNonZero = 0;

for (const loc of locs) {
    const ref = db.collection('ops').doc('inventory_' + loc);
    const snap = await ref.get();
    if (!snap.exists) {
        console.log(`  /ops/inventory_${loc} — doesn't exist, skipping`);
        continue;
    }
    const d = snap.data() || {};
    const customCats = Array.isArray(d.customInventory) ? d.customInventory.length : 0;
    const customItems = Array.isArray(d.customInventory) ? d.customInventory.reduce((s, c) => s + (c.items?.length || 0), 0) : 0;
    const tombstones = (d.deletedMasterIds || []).length;
    const counts = Object.keys(d.counts || {}).length;
    const nonZero = Object.values(d.counts || {}).filter(v => v && v > 0).length;
    const vCounts = Object.keys(d.vendorCounts || {}).length;
    const meta = Object.keys(d.countMeta || {}).length;
    totalCustomItems += customItems;
    totalCounts += counts;
    totalNonZero += nonZero;

    console.log(`  /ops/inventory_${loc}`);
    console.log(`    customInventory   : ${customCats} cats / ${customItems} items`);
    console.log(`    deletedMasterIds  : ${tombstones} tombstones`);
    console.log(`    counts            : ${counts}  (${nonZero} > 0)`);
    console.log(`    countMeta         : ${meta}`);
    console.log(`    vendorCounts      : ${vCounts}`);

    if (!apply) {
        console.log(`    → would CLEAR all five`);
        console.log('');
        continue;
    }

    await ref.update({
        customInventory: FieldValue.delete(),
        deletedMasterIds: FieldValue.delete(),
        counts: {},
        countMeta: {},
        vendorCounts: {},
        date: new Date().toISOString(),
    });
    console.log(`    ✓ cleared`);
    console.log('');
}

console.log('  totals across', locs.length, 'location(s):');
console.log(`    custom items would be removed : ${totalCustomItems}`);
console.log(`    counts would be removed       : ${totalCounts}  (${totalNonZero} > 0)`);
console.log('');

if (!apply) {
    console.log('  Dry run only — nothing changed.');
    console.log('  To actually clear, re-run with: --apply');
    console.log('');
}

process.exit(0);
