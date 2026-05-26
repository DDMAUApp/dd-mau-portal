#!/usr/bin/env node
// audit-inbox-notifications.mjs
//
// Read-only diagnostic. Andrew flagged "the notifications was to
// everyone and wasnt supposed to be that". This script answers the
// real question: did pollGmail actually write notification docs for
// any staff member other than Andrew (id 40) or Julie (id 41)?
//
// Checks three places:
//   1. /notifications where type IN (email_inquiry_*) → list forStaff
//   2. /email_intel → spot-check categories + smsSent
//   3. /config/staff.list → confirm which names map to id 40/41
//
// Outputs a clear pass/fail for the "only owners got pinged" claim.

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

// ── Resolve owner names from /config/staff ───────────────────────────────
const staffDoc = await db.doc('config/staff').get();
const list = (staffDoc.exists ? staffDoc.data().list : []) || [];
const owners = list
    .filter((s) => s && s.name && (s.id === 40 || s.id === 41))
    .map((s) => ({ id: s.id, name: s.name }));
console.log(`\n── Owners (id 40/41) ──`);
for (const o of owners) console.log(`  id=${o.id}  name=${o.name}`);
const ownerNameSet = new Set(owners.map((o) => o.name));

// ── /notifications: every email_inquiry_* doc ─────────────────────────────
const emailTypes = ['email_inquiry_catering', 'email_inquiry_complaint'];
console.log(`\n── /notifications where type IN (${emailTypes.join(', ')}) ──`);
let allNotifs = [];
for (const t of emailTypes) {
    const snap = await db.collection('notifications').where('type', '==', t).get();
    snap.forEach((d) => allNotifs.push({ id: d.id, ...d.data() }));
}
console.log(`  total docs: ${allNotifs.length}`);

const byStaff = new Map();
for (const n of allNotifs) {
    const k = n.forStaff || '(unset)';
    byStaff.set(k, (byStaff.get(k) || 0) + 1);
}
console.log(`  recipients:`);
let leaked = 0;
for (const [name, count] of [...byStaff.entries()].sort((a, b) => b[1] - a[1])) {
    const isOwner = ownerNameSet.has(name);
    const flag = isOwner ? '✓ owner' : '✗ NOT AN OWNER';
    if (!isOwner) leaked += count;
    console.log(`    ${count.toString().padStart(4)} × ${name.padEnd(28)} ${flag}`);
}
console.log('');
if (leaked > 0) {
    console.log(`  ⚠️  ${leaked} notification doc(s) went to non-owners!`);
} else {
    console.log(`  ✓ All notification docs are addressed to owners only.`);
}

// ── /email_intel: category breakdown ─────────────────────────────────────
console.log(`\n── /email_intel category breakdown ──`);
const intelSnap = await db.collection('email_intel').get();
console.log(`  total docs: ${intelSnap.size}`);
const catCounts = new Map();
let smsSentCount = 0;
intelSnap.forEach((d) => {
    const v = d.data();
    const c = v.category || '(unset)';
    catCounts.set(c, (catCounts.get(c) || 0) + 1);
    if (v.smsSent) smsSentCount++;
});
for (const [c, n] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${n.toString().padStart(4)} × ${c}`);
}
console.log(`  smsSent=true on ${smsSentCount} doc(s)`);

// ── /sms_delivery_logs: who actually got texted ──────────────────────────
console.log(`\n── /sms_delivery_logs where type IN email_inquiry_* ──`);
let smsLogs = [];
for (const t of emailTypes) {
    const snap = await db.collection('sms_delivery_logs').where('type', '==', t).get();
    snap.forEach((d) => smsLogs.push({ id: d.id, ...d.data() }));
}
console.log(`  total log rows: ${smsLogs.length}`);
if (smsLogs.length > 0) {
    const byForStaff = new Map();
    smsLogs.forEach((l) => {
        const k = l.forStaff || '(unset)';
        byForStaff.set(k, (byForStaff.get(k) || 0) + 1);
    });
    for (const [name, count] of [...byForStaff.entries()].sort((a, b) => b[1] - a[1])) {
        const isOwner = ownerNameSet.has(name);
        const flag = isOwner ? '✓ owner' : '✗ NOT AN OWNER';
        console.log(`    ${count.toString().padStart(4)} × ${name.padEnd(28)} ${flag}`);
    }
}

process.exit(0);
