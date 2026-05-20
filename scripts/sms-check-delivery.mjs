#!/usr/bin/env node
// sms-check-delivery.mjs — inspect the latest /sms_delivery_logs rows
// to see what Twilio actually did with our send.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credPath = path.join(__dirname, '..', 'firebase-service-account.json');
const { default: serviceAccount } = await import(credPath, { with: { type: 'json' } });
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const snap = await db.collection('sms_delivery_logs')
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();

if (snap.empty) {
    console.log('No sms_delivery_logs rows yet.');
    process.exit(0);
}

for (const d of snap.docs) {
    const r = d.data();
    const at = r.createdAt?.toDate?.()?.toISOString() ?? '(no createdAt)';
    console.log(`\n── ${d.id} ──`);
    console.log(`  createdAt:           ${at}`);
    console.log(`  forStaff:            ${r.forStaff}`);
    console.log(`  type:                ${r.type}`);
    console.log(`  phoneE164:           ${r.phoneE164}`);
    console.log(`  status:              ${r.status}`);
    console.log(`  twilioSid:           ${r.twilioSid || '(none)'}`);
    console.log(`  errorCode:           ${r.errorCode || '(none)'}`);
    console.log(`  errorMessage:        ${r.errorMessage || '(none)'}`);
    console.log(`  deliveredAt:         ${r.deliveredAt?.toDate?.()?.toISOString() ?? '(not delivered)'}`);
    console.log(`  lastStatusAt:        ${r.lastStatusAt?.toDate?.()?.toISOString() ?? '(no status callback)'}`);
    console.log(`  body:                ${r.body}`);
}
