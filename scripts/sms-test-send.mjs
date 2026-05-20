#!/usr/bin/env node
// sms-test-send.mjs — fires a test SMS to a specific staff member.
//
// Creates a /notifications doc with type=shift_reminder_1h. The
// dispatchSms Cloud Function picks it up via onDocumentCreated, runs
// eligibility (phone + opt-in + not stopped + testMode rule), and
// sends via Twilio.
//
// Usage:
//   node scripts/sms-test-send.mjs "Andrew Shih"
//
// Requires: firebase-service-account.json at repo root.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credPath = path.join(__dirname, '..', 'firebase-service-account.json');
const { default: serviceAccount } = await import(credPath, { with: { type: 'json' } });
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const targetName = process.argv[2] || 'Andrew Shih';

// Sanity-check the staff record so we can give a clear error before
// firing into the void.
const staffSnap = await db.doc('config/staff').get();
const list = staffSnap.exists ? (staffSnap.data().list || []) : [];
const me = list.find(s => s && s.name === targetName);
if (!me) {
    console.error(`✗ No staff record found for "${targetName}"`);
    process.exit(1);
}
console.log(`Target: ${me.name} (id=${me.id})`);
console.log(`  phoneE164:   ${me.phoneE164 || '(not set)'}`);
console.log(`  smsOptIn:    ${me.smsOptIn}`);
console.log(`  smsStopped:  ${me.smsStopped === true}`);
if (!me.phoneE164) {
    console.error(`✗ Staff has no phoneE164 — go set it in AdminPanel first.`);
    process.exit(1);
}
if (me.smsOptIn !== true) {
    console.error(`✗ smsOptIn is not true — opt them in via AdminPanel first.`);
    process.exit(1);
}
if (me.smsStopped === true) {
    console.error(`✗ smsStopped is true — staff replied STOP, can only be cleared by inbound START.`);
    process.exit(1);
}

const settingsSnap = await db.doc('config/sms').get();
const settings = settingsSnap.exists ? settingsSnap.data() : {};
console.log(`Settings: enabled=${settings.enabled} testMode=${settings.testMode}`);

// Fire the notification.
const ref = await db.collection('notifications').add({
    forStaff: targetName,
    type: 'shift_reminder_1h',
    title: 'DD Mau — Test shift in 1 hour',
    body: 'Test SMS — your shift starts at 5:00 PM at Webster.',
    link: '/',
    tag: `sms-test:${Date.now()}`,
    createdAt: FieldValue.serverTimestamp(),
    read: false,
    createdBy: 'sms-test-send.mjs',
    smsVars: {
        time: '5:00 PM',
        location: 'Webster',
    },
});
console.log(`\n✓ Notification created: notifications/${ref.id}`);
console.log(`  dispatchSms should fire within 5-15 seconds.`);
console.log(`  Watch logs: firebase functions:log --only dispatchSms`);
console.log(`  Then check your phone for the SMS.`);
