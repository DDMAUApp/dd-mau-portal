#!/usr/bin/env node
// init-sms-config.mjs
// One-shot helper: creates /config/sms with safe defaults
//   { enabled: true, testMode: true }
//
// testMode: true means ONLY owners (id 40/41) receive real SMS until
// you flip it off. This is the recommended posture for first deploy —
// you can stage opt-ins for everyone, run a real test send to yourself,
// and only then enable fan-out to the team.
//
// Re-runnable: skips if the doc already exists. To force-reset, delete
// /config/sms in Firebase Console and re-run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credPath = path.join(__dirname, '..', 'firebase-service-account.json');

const { default: serviceAccount } = await import(credPath, { with: { type: 'json' } });
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const ref = db.doc('config/sms');
const snap = await ref.get();
if (snap.exists) {
    console.log('✓ /config/sms already exists. Current values:', snap.data());
    console.log('  (skipping init — delete the doc manually if you want to reset)');
    process.exit(0);
}
await ref.set({
    enabled: true,
    testMode: true,
    createdAt: new Date().toISOString(),
    createdBy: 'init-sms-config.mjs',
});
console.log('✓ Created /config/sms with { enabled: true, testMode: true }');
console.log('  testMode is ON — only owner ids 40/41 will receive real SMS until you turn it off.');
console.log('  To go live for everyone, edit /config/sms in Firebase Console and set testMode: false.');
