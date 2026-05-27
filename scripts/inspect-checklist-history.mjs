#!/usr/bin/env node
// inspect-checklist-history.mjs
//
// Read-only diagnostic. Lists every doc in /checklistHistory_{loc} for
// both stores and reports the last ~10 days. Used to figure out why
// Task List history isn't showing recent days.
//
// Usage: node scripts/inspect-checklist-history.mjs

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
    console.log(`\n──── checklistHistory_${loc} ────────────────────────────────`);
    const snap = await db.collection('checklistHistory_' + loc).get();
    console.log(`  total docs: ${snap.size}`);
    // Group by date prefix (YYYY-MM-DD) regardless of suffix
    const byDate = new Map();
    snap.forEach(d => {
        const m = d.id.match(/^(\d{4}-\d{2}-\d{2})/);
        const dateKey = m ? m[1] : '(no-date)';
        if (!byDate.has(dateKey)) byDate.set(dateKey, []);
        byDate.get(dateKey).push(d.id);
    });
    const sorted = [...byDate.entries()].sort(([a], [b]) => b.localeCompare(a));
    console.log(`  last 12 days (by date prefix):`);
    sorted.slice(0, 12).forEach(([date, ids]) => {
        console.log(`    ${date}: ${ids.length} doc(s) → ${ids.join(', ')}`);
    });

    // Try the same query that ChecklistHistory.jsx uses.
    console.log(`  ── fetch mirror (orderBy __name__ desc limit 60) ──`);
    try {
        const ordered = await db.collection('checklistHistory_' + loc)
            .orderBy('__name__', 'desc')
            .limit(60)
            .get();
        const ids = ordered.docs.map(d => d.id);
        const bareIds = ids.filter(d => !d.includes('_')).slice(0, 30);
        console.log(`    fetched: ${ids.length} doc ids`);
        console.log(`    after !includes("_") filter: ${bareIds.length} bare dates`);
        console.log(`    first 10 of fetched: ${ids.slice(0, 10).join(', ')}`);
        console.log(`    first 10 of bare:    ${bareIds.slice(0, 10).join(', ')}`);
    } catch (e) {
        console.log(`    ⚠️  orderBy __name__ desc failed: ${e.message?.slice(0, 200)}`);
    }
}

process.exit(0);
