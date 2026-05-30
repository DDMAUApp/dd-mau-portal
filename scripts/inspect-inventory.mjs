#!/usr/bin/env node
// One-shot diagnostic. Lists every inventory_lists doc + their
// Drinks count so we can pick the right target.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');
const creds = JSON.parse(await fs.readFile(path.join(repoRoot, 'firebase-service-account.json'), 'utf8'));
initializeApp({ credential: cert(creds) });
const db = getFirestore();
const snap = await db.collection('inventory_lists').get();
console.log(`Found ${snap.size} doc(s):`);
for (const d of snap.docs) {
    const x = d.data() || {};
    const cats = Array.isArray(x.categories) ? x.categories : [];
    const drinks = cats.find(c => c.name === 'Drinks');
    const drinkCount = drinks ? (drinks.items || []).length : '(no Drinks)';
    const allCats = cats.map(c => `${c.name}:${(c.items || []).length}`).join(' | ');
    console.log(`\n  ${d.id}`);
    console.log(`    name=${x.name || '(none)'} status=${x.status || '(none)'}`);
    console.log(`    Drinks count: ${drinkCount}`);
    console.log(`    All cats: ${allCats}`);
}
// Also check ops/inventory_{webster,maryland} which is where the LEGACY
// customInventory lived before /inventory_lists existed.
for (const loc of ['webster', 'maryland']) {
    const doc = await db.doc(`ops/inventory_${loc}`).get();
    if (!doc.exists) continue;
    const x = doc.data() || {};
    const ci = Array.isArray(x.customInventory) ? x.customInventory : null;
    if (!ci) { console.log(`\nops/inventory_${loc}: no customInventory`); continue; }
    const drinks = ci.find(c => c.name === 'Drinks');
    const drinkCount = drinks ? (drinks.items || []).length : '(no Drinks)';
    const allCats = ci.map(c => `${c.name}:${(c.items || []).length}`).join(' | ');
    console.log(`\nops/inventory_${loc} customInventory:`);
    console.log(`    Drinks count: ${drinkCount}`);
    console.log(`    All cats: ${allCats}`);
}
process.exit(0);
