#!/usr/bin/env node
// map-86-guid.mjs — manually map a Toast GUID → human name.
//
// Andrew 2026-05-26: filling /config/toast_menu_items.map[<guid>]
// directly when the full Toast sync hasn't run yet (or doesn't have
// the GUID indexed). Once the entry's in this doc, Eighty6Dashboard
// resolves the GUID to the real menu name at render time — even for
// rows already in /ops/86_{loc}.items[].
//
// Usage:
//   node scripts/map-86-guid.mjs <guid> "<name>" [<guid> "<name>" ...]
//
// Examples:
//   node scripts/map-86-guid.mjs d77ac06e-6527-467c-a505-28a1fb8ef895 "Red Jujube Tea"
//   node scripts/map-86-guid.mjs \
//     d77ac06e-6527-467c-a505-28a1fb8ef895 "Red Jujube Tea" \
//     bacd5a1d-1879-4f89-aebb-67b532958540 "Some Other Item"
//
// Safe to re-run — uses merge so existing entries stick around.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2 !== 0) {
    console.error('\nUsage:');
    console.error('  node scripts/map-86-guid.mjs <guid> "<name>" [<guid> "<name>" ...]\n');
    console.error('Example:');
    console.error('  node scripts/map-86-guid.mjs d77ac06e-6527-467c-a505-28a1fb8ef895 "Red Jujube Tea"\n');
    process.exit(1);
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Build the pairs and validate.
const pairs = [];
for (let i = 0; i < args.length; i += 2) {
    const guid = String(args[i] || '').trim();
    const name = String(args[i + 1] || '').trim();
    if (!GUID_RE.test(guid)) {
        console.error(`✗ Not a GUID: "${guid}"`);
        process.exit(1);
    }
    if (!name) {
        console.error(`✗ Empty name for GUID ${guid}`);
        process.exit(1);
    }
    pairs.push({ guid, name });
}

// Service account.
const keyPath = path.join(repoRoot, 'firebase-service-account.json');
const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// Merge each pair into /config/toast_menu_items.map. Using dotted
// field paths with update so other entries in `map` survive untouched.
const ref = db.collection('config').doc('toast_menu_items');
const patch = {
    entriesAddedAt: FieldValue.serverTimestamp(),
    lastManualMapBy: 'map-86-guid.mjs',
};
for (const { guid, name } of pairs) {
    patch[`map.${guid}`] = name;
}

// Use set with merge in case the doc doesn't exist yet (first run).
await ref.set(patch, { merge: true });

console.log(`\n✓ Wrote ${pairs.length} mapping(s) to /config/toast_menu_items.map:\n`);
for (const { guid, name } of pairs) {
    console.log(`    ${guid}  →  ${name}`);
}
console.log('\nRefresh the 86 board — these items should now show their real names.\n');

process.exit(0);
