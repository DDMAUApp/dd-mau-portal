#!/usr/bin/env node
// strip-guid-86-items.mjs — one-off cleanup for /ops/86_{loc}.
//
// Andrew 2026-05-26: "the 86 is broken. its showing 2 new items but
// no name". The Toast scraper on Railway is writing raw Toast item
// GUIDs to items[].name when it can't resolve them to a human name.
// The dashboard now hides those (Eighty6Dashboard.jsx filter), the
// realtime push handler skips them (functions/index.js looks86NameValid),
// but the existing bad rows still live in /ops/86_webster + maryland.
// This script removes them from items[] AND drops the corresponding
// attribution.{guid} entries.
//
// Usage:
//   node scripts/strip-guid-86-items.mjs
//
// Safety:
//   - Dry-runs by default — shows preview, requires typed "DELETE" to commit.
//   - Operates on each location independently with a runTransaction so
//     a concurrent staff 86 add can't be clobbered.
//   - Only removes items where name matches the GUID regex. Anything
//     with a human name is left alone.

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

const keyPath = path.join(repoRoot, 'firebase-service-account.json');
const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const looksGuid = (s) => GUID_RE.test(String(s || '').trim());

// ── Preview ────────────────────────────────────────────────────────────
const targets = [];
for (const loc of ['webster', 'maryland']) {
    const snap = await db.doc(`ops/86_${loc}`).get();
    if (!snap.exists) continue;
    const data = snap.data() || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const bad = items.filter((i) => looksGuid(i?.name));
    if (bad.length === 0) continue;
    targets.push({ loc, bad, data });
    console.log(`\n── /ops/86_${loc} ──`);
    console.log(`  ${bad.length} GUID-named item(s) to remove:`);
    bad.forEach((i) => console.log(`    · ${i.name}  (status=${i.status} source=${i.source || '?'})`));
    const attrToRemove = Object.keys(data.attribution || {}).filter((k) => looksGuid(k));
    if (attrToRemove.length > 0) {
        console.log(`  ${attrToRemove.length} matching attribution entr${attrToRemove.length === 1 ? 'y' : 'ies'} to drop`);
    }
}

if (targets.length === 0) {
    console.log('\nNothing to clean up — no GUID-named items found.');
    process.exit(0);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`About to clean up ${targets.length} location(s).`);
console.log(`${'─'.repeat(60)}`);

const rl = readline.createInterface({ input, output });
const answer = (await rl.question('Type DELETE to commit: ')).trim();
rl.close();
if (answer !== 'DELETE') {
    console.log('\nCanceled. No changes made.');
    process.exit(0);
}

// ── Apply ──────────────────────────────────────────────────────────────
for (const { loc } of targets) {
    const ref = db.doc(`ops/86_${loc}`);
    await db.runTransaction(async (txn) => {
        const snap = await txn.get(ref);
        if (!snap.exists) return;
        const data = snap.data() || {};
        const items = Array.isArray(data.items) ? data.items : [];
        const cleanItems = items.filter((i) => !looksGuid(i?.name));
        // Drop attribution entries keyed by a GUID. We use deleteField()
        // for each so the rest of the map survives.
        const attr = data.attribution || {};
        const deletes = {};
        for (const k of Object.keys(attr)) {
            if (looksGuid(k)) deletes[`attribution.${k}`] = FieldValue.delete();
        }
        txn.update(ref, {
            items: cleanItems,
            count: cleanItems.filter((i) => i.status === 'OUT_OF_STOCK').length,
            updatedAt: FieldValue.serverTimestamp(),
            ...deletes,
        });
    });
    console.log(`  ✓ cleaned /ops/86_${loc}`);
}

console.log('\nDone. Refresh the 86 dashboard to verify.');
process.exit(0);
