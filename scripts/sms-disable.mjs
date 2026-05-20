#!/usr/bin/env node
// sms-disable.mjs — flips /config/sms.enabled to false.
//
// SMS infrastructure stays in place (functions deployed, secrets stored,
// templates compiled, opt-in audit trail ready). dispatchSms simply
// bails on the first eligibility check, so notifications still fire
// via FCM push but never trigger Twilio sends.
//
// To re-enable later, set /config/sms.enabled = true in the Firebase
// Console or run a counterpart script.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credPath = path.join(__dirname, '..', 'firebase-service-account.json');
const { default: serviceAccount } = await import(credPath, { with: { type: 'json' } });
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

await db.doc('config/sms').set({
    enabled: false,
    testMode: true,                           // keep testMode on for safety if re-enabled
    disabledAt: FieldValue.serverTimestamp(),
    disabledReason: 'manually disabled — push notifications cover the use case',
}, { merge: true });

const snap = await db.doc('config/sms').get();
console.log('✓ /config/sms updated:');
console.log(snap.data());
