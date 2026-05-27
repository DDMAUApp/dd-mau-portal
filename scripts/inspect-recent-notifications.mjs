#!/usr/bin/env node
// inspect-recent-notifications.mjs
//
// Read-only diagnostic. Lists notification volume by type for the last
// 48h so we can see what the actual "spam" was. Doesn't delete anything.
//
// Usage:
//   node scripts/inspect-recent-notifications.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

const HOURS = 48;
const keyPath = path.join(repoRoot, 'firebase-service-account.json');
const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const cutoffMs = Date.now() - HOURS * 60 * 60 * 1000;
console.log(`\nFetching ALL notifications collection (will filter to last ${HOURS}h in memory)…`);

const snap = await db.collection('notifications').get();
console.log(`Total docs in collection: ${snap.size}`);

const recent = [];
snap.forEach((d) => {
    const v = d.data();
    const ts = v.createdAt?.toMillis ? v.createdAt.toMillis() : 0;
    if (ts >= cutoffMs) recent.push({ id: d.id, ...v, _ts: ts });
});

console.log(`In last ${HOURS}h: ${recent.length}\n`);

if (recent.length === 0) {
    process.exit(0);
}

// Group by type
const byType = new Map();
recent.forEach((n) => {
    const t = n.type || '(none)';
    if (!byType.has(t)) byType.set(t, { count: 0, sample: n, staff: new Set() });
    const entry = byType.get(t);
    entry.count++;
    entry.staff.add(n.forStaff);
});

console.log(`By type (last ${HOURS}h):`);
const sorted = [...byType.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [type, info] of sorted) {
    const ts = new Date(info.sample._ts).toISOString();
    console.log(`  ${info.count.toString().padStart(4)} docs · ${info.staff.size} staff · type=${type}`);
    console.log(`         latest: ${ts} | "${info.sample.title}"`);
}

// Show timeline buckets (per 6h)
console.log(`\nTimeline (6h buckets):`);
const buckets = new Map();
recent.forEach((n) => {
    const hoursAgo = Math.floor((Date.now() - n._ts) / (60 * 60 * 1000));
    const bucket = Math.floor(hoursAgo / 6) * 6;
    const key = `${bucket}-${bucket + 6}h ago`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
});
const bucketOrder = [...buckets.keys()].sort((a, b) =>
    parseInt(a.split('-')[0]) - parseInt(b.split('-')[0])
);
for (const k of bucketOrder) {
    console.log(`  ${k.padEnd(12)} ${'█'.repeat(Math.min(buckets.get(k), 40))} ${buckets.get(k)}`);
}

process.exit(0);
