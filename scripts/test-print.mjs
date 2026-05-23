#!/usr/bin/env node
// scripts/test-print.mjs — fire a test label print at the bridge.
//
// Reads the URL + API key directly from Firestore /config/print_bridge
// (no SSH or sudo needed). Then POSTs a minimal payload identical to
// the one the web app would send. Prints the raw response.
//
// Usage:
//   node scripts/test-print.mjs
//
// Tweak the PAYLOAD below to simulate different web-app print jobs —
// e.g. swap in real preset dims, more lines, etc.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const sa = JSON.parse(readFileSync(path.join(repoRoot, 'firebase-service-account.json'), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const cfg = (await db.collection('config').doc('print_bridge').get()).data();
if (!cfg?.apiKey || !cfg?.url) {
    console.error('Missing apiKey or url in /config/print_bridge');
    process.exit(1);
}

const PAYLOAD = {
    kind: 'prep',
    lines: [
        { text: 'TEST', scale: 3.0, bold: true },
        { text: 'From Andrew', scale: 1.5 },
    ],
    size: { widthMm: 62, heightMm: 40 },
    copies: 1,
};

console.log(`POST ${cfg.url}/print/label`);
console.log(`payload: ${JSON.stringify(PAYLOAD)}`);
console.log('');

const start = Date.now();
const res = await fetch(`${cfg.url}/print/label`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-API-Key': cfg.apiKey,
    },
    body: JSON.stringify(PAYLOAD),
});
const ms = Date.now() - start;
const body = await res.text();
console.log(`HTTP ${res.status} (${ms} ms)`);
console.log(body);
process.exit(res.ok ? 0 : 1);
