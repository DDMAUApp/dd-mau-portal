#!/usr/bin/env node
// delete-recent-86-notifications.mjs
//
// One-off cleanup: deletes /notifications docs of the real-time 86
// types (eighty_six_new + eighty_six_back) created in the last 48
// hours. Written 2026-05-24 after a batch of 86 items spammed every
// staff member's notification drawer overnight — ~10K docs in a 6-hour
// window. Root cause looks like the 86 items[] array got rewritten with
// UUIDs as names (titles say "🚫 86: 9a239414-..." instead of human
// names), which made realtime86Handler in functions/index.js:2065 see
// every item as both "newly out" AND "back in stock." Cleanup here;
// upstream fix is a separate task.
//
// What this does:
//   1. Loads the firebase-admin SDK using the local service account JSON
//      at the repo root (same pattern as backup-firestore.mjs).
//   2. Queries notifications where type IN (eighty_six_new,
//      eighty_six_back) AND createdAt >= (now - 48h).
//   3. Prints the count, type breakdown, and per-staff impact.
//   4. Waits for you to type "DELETE" (literal, all caps) on stdin.
//   5. If confirmed, BulkWriter-deletes them all. Otherwise exits.
//
// Safety:
//   - Filters by type AND time window — won't touch chat, schedule,
//     task, or any other notification type. Also leaves the canonical
//     hourly "eighty_six_alert" rollup type alone (different type).
//   - Won't touch older 86 docs (>48h) — only the recent spam burst.
//   - Dry-runs (prints what it would do) until you type DELETE.
//
// Usage:
//   cd dd-mau-portal
//   node scripts/delete-recent-86-notifications.mjs
//
// To re-tune the window edit HOURS_BACK below.

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

// ── Config ───────────────────────────────────────────────────────────────
// Both real-time 86 types fire from the same Cloud Function handler so
// the spam includes both directions ("newly out" + "back in stock").
const TARGET_TYPES = ['eighty_six_new', 'eighty_six_back'];
const HOURS_BACK   = 48;
const SAMPLE_SIZE  = 8;           // how many to print in the preview

// ── Locate service account key (same pattern as backup-firestore.mjs) ────
const keyPath = path.join(repoRoot, 'firebase-service-account.json');

let serviceAccount;
try {
    serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
} catch (e) {
    console.error(`\nCould not load service account at ${keyPath}`);
    console.error(`${e.message}\n`);
    console.error('Fix: download the key from Firebase Console:');
    console.error('   Project Settings → Service Accounts → Generate new private key');
    console.error('Save it as `firebase-service-account.json` at the repo root.\n');
    process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Query ────────────────────────────────────────────────────────────────
const cutoff = Timestamp.fromMillis(Date.now() - HOURS_BACK * 60 * 60 * 1000);

console.log(`\nSearching notifications:`);
console.log(`  type IN (${TARGET_TYPES.map(t => `"${t}"`).join(', ')})`);
console.log(`  createdAt >= ${cutoff.toDate().toISOString()}  (last ${HOURS_BACK}h)\n`);

// Query by type only (equality, one per target type) — no composite
// index needed. Filter the date range in memory. Volume is bounded by
// the 180-day pruneAuditLogs retention; the recent spam burst put the
// total around 10K, still cheap to fetch as a single batch.
const cutoffMs = cutoff.toMillis();
const docs = [];
let totalOfTypes = 0;

for (const type of TARGET_TYPES) {
    const snap = await db.collection('notifications')
        .where('type', '==', type)
        .get();
    totalOfTypes += snap.size;
    snap.forEach((d) => {
        const v = d.data();
        const ts = v.createdAt?.toMillis ? v.createdAt.toMillis() : 0;
        if (ts >= cutoffMs) docs.push(d);
    });
}

if (docs.length === 0) {
    console.log(`No matching notifications found (${totalOfTypes} total of the target types, none within the last ${HOURS_BACK}h).`);
    process.exit(0);
}

console.log(`Found ${docs.length} notification(s) matching criteria (out of ${totalOfTypes} total of these types).\n`);

// Per-type breakdown so we can sanity-check before deleting.
const byTypeCount = new Map();
docs.forEach((d) => {
    const t = d.data().type;
    byTypeCount.set(t, (byTypeCount.get(t) || 0) + 1);
});
console.log(`Breakdown by type:`);
for (const [t, c] of byTypeCount.entries()) {
    console.log(`  ${c.toString().padStart(5)} × ${t}`);
}
console.log('');

// Group by tag so the preview is readable (one row per dedup tag instead
// of one row per recipient — 86 alerts fan-out per staff with the same tag).
const byTag = new Map();
const byStaff = new Map();
docs.forEach((d) => {
    const v = d.data();
    const tag = v.tag || '(no tag)';
    if (!byTag.has(tag)) byTag.set(tag, { count: 0, sample: v });
    byTag.get(tag).count++;
    byStaff.set(v.forStaff, (byStaff.get(v.forStaff) || 0) + 1);
});

console.log(`Grouped by tag (${byTag.size} unique tag(s)):`);
let shown = 0;
for (const [tag, info] of byTag.entries()) {
    if (shown++ >= SAMPLE_SIZE) {
        console.log(`  … and ${byTag.size - SAMPLE_SIZE} more tag(s)`);
        break;
    }
    console.log(`  ${info.count.toString().padStart(3)} × ${tag}`);
    console.log(`        title: ${info.sample.title}`);
    console.log(`        body : ${info.sample.body}`);
}

console.log(`\nAffected staff (${byStaff.size}):`);
const staffList = [...byStaff.entries()].sort((a, b) => b[1] - a[1]);
const topShown = staffList.slice(0, 10);
for (const [name, count] of topShown) {
    console.log(`  ${count.toString().padStart(3)} × ${name}`);
}
if (staffList.length > 10) {
    console.log(`  … and ${staffList.length - 10} more staff`);
}

// ── Confirm ──────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`About to DELETE ${docs.length} notification doc(s).`);
console.log(`This is permanent — there is no undo on the live collection`);
console.log(`(though Firestore PITR keeps a 7-day rolling backup).`);
console.log(`${'─'.repeat(60)}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await new Promise((resolve) => {
    rl.question(`Type DELETE to confirm, anything else to cancel: `, resolve);
});
rl.close();

if (answer.trim() !== 'DELETE') {
    console.log(`\nCanceled. No changes made.`);
    process.exit(0);
}

// ── Delete ───────────────────────────────────────────────────────────────
console.log(`\nDeleting…`);
const writer = db.bulkWriter();
let deleted = 0;
writer.onWriteResult(() => { deleted++; });
writer.onWriteError((err) => {
    // BulkWriter retries 4xx/5xx automatically up to 5 times; only return
    // false to stop retrying. We let it retry.
    console.warn(`  write retry: ${err.message}`);
    return true;
});

docs.forEach((d) => { writer.delete(d.ref); });
await writer.close();

console.log(`\nDeleted ${deleted} of ${docs.length} notification(s).`);
process.exit(0);
