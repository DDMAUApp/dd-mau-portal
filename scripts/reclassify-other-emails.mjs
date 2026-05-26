#!/usr/bin/env node
// reclassify-other-emails.mjs
//
// One-off backfill triggered 2026-05-26 after adding the 'toast'
// category to the inbox triage classifier. The existing ~56 emails
// currently sitting in 'other' were classified by the old prompt that
// didn't know about toast — Toast POS noise (daily summaries, receipts)
// got bucketed as 'other' and will stay there forever unless we ask
// the new prompt to re-look-at them.
//
// What this script does:
//   1. Query /email_intel where category == 'other'.
//   2. Show a preview (count, sample of from/subject).
//   3. After confirmation, clear `reasoning` to '' on each doc.
//   4. The next pollGmail run picks them up via the cleanup pass
//      (failedSnap = docs with empty reasoning) and re-classifies
//      with the new prompt that knows about 'toast'.
//
// After running this:
//   - Open Cloud Scheduler → Force run pollGmail.
//   - Watch logs: "cleanup pass — retrying N failed classification(s)."
//   - The Inbox tab will refresh as docs get bumped to their real
//     categories (toast / vendor / bill / catering / complaint).
//
// Safety:
//   - Only touches docs already in 'other' — won't disturb successful
//     classifications.
//   - smsSent + triaged flags are preserved (the pollGmail re-classify
//     path explicitly preserves them).
//   - If pollGmail's cleanup-pass cap (50/run) is below the total
//     count, it'll take 2 runs to drain.
//
// Usage:
//   cd dd-mau-portal
//   node scripts/reclassify-other-emails.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
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

// ── Find candidates ─────────────────────────────────────────────────────
const snap = await db.collection('email_intel')
    .where('category', '==', 'other')
    .get();

if (snap.empty) {
    console.log("\nNo emails currently classified as 'other'. Nothing to do.");
    process.exit(0);
}

console.log(`\nFound ${snap.size} email(s) in 'other'. Preview (first 10):`);
const sample = snap.docs.slice(0, 10);
for (const d of sample) {
    const v = d.data();
    const from = (v.fromName || v.from || '').slice(0, 30).padEnd(30);
    const subj = (v.subject || '').slice(0, 60);
    console.log(`  · ${from}  ${subj}`);
}
if (snap.size > 10) console.log(`  … and ${snap.size - 10} more`);

console.log(`\n${'─'.repeat(60)}`);
console.log(`Will clear 'reasoning' on ${snap.size} doc(s) so pollGmail's`);
console.log(`cleanup pass re-classifies them with the new prompt.`);
console.log(`smsSent + triaged flags are preserved.`);
console.log(`${'─'.repeat(60)}`);

const rl = readline.createInterface({ input, output });
const answer = (await rl.question('Type CONTINUE to proceed: ')).trim();
rl.close();
if (answer !== 'CONTINUE') {
    console.log('\nCanceled. No changes made.');
    process.exit(0);
}

// ── Clear reasoning in bulk ─────────────────────────────────────────────
console.log('\nClearing reasoning…');
const writer = db.bulkWriter();
let cleared = 0;
writer.onWriteResult(() => { cleared++; });
writer.onWriteError((err) => {
    console.warn('  write retry:', err.message);
    return true;
});
snap.forEach((d) => {
    writer.update(d.ref, { reasoning: '' });
});
await writer.close();

console.log(`\nCleared ${cleared} of ${snap.size} doc(s).`);
console.log('\nNext step:');
console.log('  Cloud Scheduler → Force run firebase-schedule-pollGmail-us-central1');
console.log('  (the cleanup pass picks up 50 per run; if you have >50 it will take');
console.log('  two runs to fully drain.)\n');
process.exit(0);
