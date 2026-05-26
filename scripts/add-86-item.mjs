#!/usr/bin/env node
// add-86-item.mjs — add an item to /ops/86_{location}.items[] manually.
//
// Andrew 2026-05-26: needed to put Red Jujube Tea + Flan back on the
// 86 board with proper menu names after the GUID-cleanup script
// removed them. This is the "I'm telling you it's 86'd, just add it"
// path — doesn't talk to Toast at all.
//
// Usage:
//   node scripts/add-86-item.mjs <location> "<name>" [more pairs...]
//
// Examples:
//   node scripts/add-86-item.mjs webster "Red Jujube Tea"
//   node scripts/add-86-item.mjs webster "Red Jujube Tea" "Flan"
//
// Writes each item with source='manual' so the next Toast scrape
// doesn't remove it (the script + the Cloud Function only touch
// items where source==='toast'). When the item comes back in stock,
// remove it via the dashboard or by re-running with the same item
// (this script is idempotent — duplicate names skip).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('\nUsage:');
    console.error('  node scripts/add-86-item.mjs <location> "<name>" ["<name>" ...]\n');
    console.error('Locations: webster | maryland\n');
    console.error('Example:');
    console.error('  node scripts/add-86-item.mjs webster "Red Jujube Tea" "Flan"\n');
    process.exit(1);
}

const [location, ...names] = args;
if (!['webster', 'maryland'].includes(location)) {
    console.error(`✗ location must be 'webster' or 'maryland', got: "${location}"`);
    process.exit(1);
}
const cleanNames = names.map(n => String(n || '').trim()).filter(Boolean);
if (cleanNames.length === 0) {
    console.error('✗ Provide at least one item name in quotes.');
    process.exit(1);
}

const keyPath = path.join(repoRoot, 'firebase-service-account.json');
const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const ref = db.doc(`ops/86_${location}`);
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nowIso = new Date().toISOString();

const added = [];
const skipped = [];
await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.exists ? (snap.data() || {}) : {};
    const items = Array.isArray(data.items) ? data.items : [];
    const presentLower = new Set(items.map(i => slugify(i?.name)));
    const next = [...items];
    for (const name of cleanNames) {
        if (presentLower.has(slugify(name))) {
            skipped.push(name);
            continue;
        }
        next.push({
            name,
            status: 'OUT_OF_STOCK',
            source: 'manual',
            addedAt: nowIso,
        });
        presentLower.add(slugify(name));
        added.push(name);
    }
    txn.set(ref, {
        items: next,
        count: next.filter(i => i.status === 'OUT_OF_STOCK').length,
        updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
});

if (added.length > 0) {
    console.log(`\n✓ Added ${added.length} item(s) to ops/86_${location}:`);
    added.forEach(n => console.log(`    🚫 ${n}`));
}
if (skipped.length > 0) {
    console.log(`\n• ${skipped.length} already present, skipped:`);
    skipped.forEach(n => console.log(`    · ${n}`));
}
console.log('\nRefresh the 86 board to see them.\n');
process.exit(0);
