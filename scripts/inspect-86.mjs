#!/usr/bin/env node
// inspect-86.mjs — read-only diagnostic for /ops/86_{loc}.
//
// Andrew 2026-05-26: "the 86 is broken. its showing 2 new items but
// no name and then is doesnt say who did it just that it could be
// the whole staff so it named all possible staff"
//
// Dumps each store's 86 doc — items[] (looking for name/blank/UUID),
// attribution map (looking for proper nesting vs dotted literals).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

const keyPath = path.join(repoRoot, 'firebase-service-account.json');
const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

for (const loc of ['webster', 'maryland']) {
    console.log(`\n──── /ops/86_${loc} ──────────────────────────────`);
    const snap = await db.doc(`ops/86_${loc}`).get();
    if (!snap.exists) {
        console.log('  (doc does not exist)');
        continue;
    }
    const data = snap.data() || {};
    const items = Array.isArray(data.items) ? data.items : [];
    console.log(`  items: ${items.length}`);
    items.slice(0, 20).forEach((it, i) => {
        const looksUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(it.name || '');
        const flag = !it.name
            ? '⚠ NO NAME'
            : looksUUID ? '⚠ UUID-as-name' : '';
        console.log(
            `    [${i}] name="${(it.name || '').slice(0, 50)}" status=${it.status} ${flag}`
        );
        const extraKeys = Object.keys(it).filter(k => !['name', 'status', 'id'].includes(k));
        if (extraKeys.length > 0) {
            console.log(`         keys: ${extraKeys.join(', ')}`);
        }
    });

    // Attribution map — check for dotted-key bug vs nested object.
    const attr = data.attribution;
    if (attr) {
        const topKeys = Object.keys(attr);
        const dotted = topKeys.filter(k => k.includes('.'));
        const nested = topKeys.filter(k => !k.includes('.') && typeof attr[k] === 'object');
        console.log(`  attribution: ${topKeys.length} top-level key(s)`);
        if (dotted.length > 0) {
            console.log(`    ⚠ dotted-key keys (LEGACY BUG): ${dotted.slice(0, 5).join(', ')}`);
        }
        if (nested.length > 0) {
            console.log(`    ✓ nested keys: ${nested.slice(0, 5).join(', ')}`);
            // Sample one nested entry
            const k = nested[0];
            const v = attr[k];
            console.log(`      sample [${k}]: outBy=${JSON.stringify(v.outBy || null)} outAt=${v.outAt ? '(ts)' : 'n/a'}`);
        }
    } else {
        console.log('  attribution: (none)');
    }

    // Top-level keys
    console.log(`  top-level keys: ${Object.keys(data).join(', ')}`);
}

process.exit(0);
