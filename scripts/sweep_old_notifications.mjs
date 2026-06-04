#!/usr/bin/env node
// sweep_old_notifications.mjs
//
// 2026-06-03 — Andrew: "the badge on the phone home screen says 174 on
// the ios side. where are all thoes notifications coming from?"
//
// Answer: real unread notifications in the /notifications collection
// for his account, accumulated over the lifetime of the app because:
//   1. Many notification types (shift, sauce, 86, schedule events) only
//      mark themselves read when the user taps into the specific UI that
//      created them.
//   2. iOS home-screen badge ONLY decrements on the NEXT push arriving
//      after the user reads — no @capacitor/badge wiring yet to clear
//      it client-side.
//
// This script is the one-shot cleanup:
//   - Sweep all notifications older than CUTOFF_DAYS days
//   - Where read === false
//   - Mark them read: true in batches of 450 (Firestore caps writes at
//     500/batch; we leave headroom for atomic transaction safety)
//
// Run with:
//   node scripts/sweep_old_notifications.mjs            # default 7 days
//   node scripts/sweep_old_notifications.mjs --days=14  # explicit
//   node scripts/sweep_old_notifications.mjs --dry      # report only
//
// Safe to re-run. After the sweep:
//   - The /notifications collection still HAS the docs (UI history intact)
//   - But forStaff='Andrew Shih' unread count goes from 174 → near 0
//   - Next push to Andrew will recompute the badge from the new low
//     unread count and his home-screen icon will drop to the real number.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

// ── Args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY  = args.includes('--dry');
const daysArg = args.find(a => a.startsWith('--days='));
const CUTOFF_DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;
if (!Number.isFinite(CUTOFF_DAYS) || CUTOFF_DAYS < 1) {
    console.error('Bad --days value. Use a positive integer.');
    process.exit(1);
}

// ── Init Firestore ───────────────────────────────────────────────────
const keyPath = path.join(repoRoot, 'firebase-service-account.json');
const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Compute cutoff ───────────────────────────────────────────────────
const cutoffMs = Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000;
const cutoffTs = Timestamp.fromMillis(cutoffMs);
console.log(`Cutoff: notifications older than ${CUTOFF_DAYS} day(s) — ${new Date(cutoffMs).toISOString()}`);
console.log(`Mode: ${DRY ? 'DRY RUN (no writes)' : 'LIVE (will mark read)'}`);
console.log('');

// ── Query: unread (single-field, no composite index needed) ──────────
// 2026-06-03 — Initial version had a where(read)==false + where(createdAt)<X
// compound filter that needed a composite index Andrew hadn't created.
// To avoid the manual index-creation step, we query on read==false only
// (single-field index is automatic) and filter by createdAt client-side.
// Slightly more network traffic but zero setup. Still uses pagination so
// a huge backlog doesn't OOM. orderBy(__name__) is the default and is
// safe to paginate with even without an explicit secondary order.
const PAGE = 500;
let totalScanned   = 0;
let totalEligible  = 0;
let totalMarked    = 0;
const byStaff = new Map(); // forStaff -> eligible count
let lastDoc = null;
let pageNum = 0;

while (true) {
    pageNum++;
    let q = db.collection('notifications')
        .where('read', '==', false)
        .limit(PAGE);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    totalScanned += snap.size;
    lastDoc = snap.docs[snap.docs.length - 1];

    // Client-side filter by createdAt < cutoff. Notifications without a
    // createdAt field (legacy data) are treated as "old enough" — they
    // would be impossible to date anyway and are presumably stale.
    const eligible = snap.docs.filter(d => {
        const data = d.data();
        const ts = data.createdAt;
        if (!ts) return true;
        const ms = typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
        return ms < cutoffMs;
    });

    // Tally by staff for the per-user report.
    for (const doc of eligible) {
        const forStaff = doc.data().forStaff || '(none)';
        byStaff.set(forStaff, (byStaff.get(forStaff) || 0) + 1);
    }
    totalEligible += eligible.length;

    if (!DRY && eligible.length > 0) {
        // 450-per-batch leaves margin under the 500 hard cap.
        for (let i = 0; i < eligible.length; i += 450) {
            const slice = eligible.slice(i, i + 450);
            const batch = db.batch();
            for (const d of slice) batch.update(d.ref, { read: true });
            await batch.commit();
            totalMarked += slice.length;
        }
    }

    console.log(`  page ${pageNum}: scanned=${snap.size} eligible=${eligible.length} (running: scanned=${totalScanned}, eligible=${totalEligible}, marked=${totalMarked})`);

    if (snap.size < PAGE) break;
}

console.log('');
console.log(`Total scanned : ${totalScanned}`);
console.log(`Total marked  : ${DRY ? '(dry run — 0 writes)' : totalMarked}`);
console.log('');
console.log('Per-staff breakdown:');
const rows = [...byStaff.entries()].sort((a, b) => b[1] - a[1]);
for (const [staff, count] of rows) {
    console.log(`  ${count.toString().padStart(5)} · ${staff}`);
}

console.log('');
console.log(DRY
    ? 'Dry run complete. Re-run without --dry to actually mark them read.'
    : 'Done. The home-screen badge will update on the NEXT push that arrives.');
process.exit(0);
