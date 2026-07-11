#!/usr/bin/env node
// add_reviewer_staff.mjs
//
// 2026-06-04 — Andrew is submitting to App Store + Google Play. Apple
// Guideline 2.1 requires a working demo login or they reject. This
// one-shot creates a "App Reviewer" staff record with a fixed PIN.
//
// The record:
//   - id: 999 (well outside the real staff range 1-50; obvious in admin UI)
//   - name: "App Reviewer"
//   - role: "Reviewer" (cosmetic; not matched by manager/admin regex)
//   - pin: "9999" (provide this to App Store Connect + Play Console)
//   - location: "webster"
//   - NO opsAccess, NO admin, NO onboardingAccess, NO smsOptIn — read-only
//     staff view. Reviewer sees the lock screen → enters 9999 → sees the
//     home tile grid → can navigate Chat / Schedule / 86 board / etc.
//     They CANNOT see Operations, Admin, Inbox, Onboarding, Insurance, or
//     any owner-only data.
//
// Safety: uses runTransaction so we read the live list and append the
// reviewer record without clobbering any concurrent admin write. Idempotent —
// if id=999 already exists, the script reports and exits without writing.
//
// Run with:
//   node scripts/add_reviewer_staff.mjs

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

const REVIEWER = {
    id: 999,
    name: 'App Reviewer',
    role: 'Reviewer',
    pin: '9999',
    location: 'webster',
    // All access flags OFF — reviewer is a vanilla staff member
    opsAccess: false,
    recipesAccess: false,
    onboardingAccess: false,
    smsOptIn: false,
    phoneE164: '',
    isMinor: false,
    scheduleSide: 'FOH',
    targetHours: 0,
    availability: {},
    fcmTokens: [],
    // Hide everything that would be confusing in a 5-minute review
    hiddenPages: ['operations', 'recipes', 'menu', 'eighty6', 'training', 'catering', 'ai', 'maintenance', 'insurance', 'datestickers', 'needs', 'tardies', 'handoff', 'labor', 'menuscreens', 'health', 'errorreport', 'labels', 'admin', 'notifications', 'inbox'],
};

const ref = db.doc('config/staff');

await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
        throw new Error('config/staff doc does not exist — aborting');
    }
    const data = snap.data() || {};
    const list = Array.isArray(data.list) ? data.list : [];

    const existing = list.find(s => s && Number(s.id) === 999);
    if (existing) {
        console.log(`✓ id=999 already exists (name="${existing.name}", pin="${existing.pin}") — no write needed`);
        console.log('  If you want to reset the PIN, edit it in the app under Admin → Staff list.');
        return;
    }

    const nextList = [...list, REVIEWER];
    tx.set(ref, { list: nextList, rev: (Number(data.rev) || 0) + 1 }, { merge: true });
    console.log(`✓ Reviewer staff record added at id=999`);
    console.log(`  Name : App Reviewer`);
    console.log(`  PIN  : 9999`);
    console.log(`  Total staff records: ${nextList.length} (was ${list.length})`);
    console.log('');
    console.log('NEXT: provide PIN 9999 in:');
    console.log('  - App Store Connect → My App → App Information → "Sign-in information"');
    console.log('  - Google Play Console → App content → App access → "Account details"');
});

process.exit(0);
