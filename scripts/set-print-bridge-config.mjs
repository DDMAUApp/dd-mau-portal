#!/usr/bin/env node
// set-print-bridge-config.mjs — writes /config/print_bridge in Firestore.
//
// Created 2026-05-22 alongside the Pi 5 print bridge rollout (commit
// 89fd52f). Lets you set or update the bridge config without manually
// fighting with Firestore Console field types (boolean vs string vs
// number — easy to typo).
//
// Usage:
//   PRINT_BRIDGE_KEY=<the 64-char hex API key from /etc/print_bridge/api_key on the Pi> \
//   node scripts/set-print-bridge-config.mjs
//
// With a custom URL (defaults to the URL Tailscale gave Andrew on 5/22):
//   PRINT_BRIDGE_KEY=<key> \
//   PRINT_BRIDGE_URL=https://<your-pi>.<tailnet>.ts.net \
//   node scripts/set-print-bridge-config.mjs
//
// To DISABLE the bridge (e.g. Pi is down for maintenance, want to fall
// back to the iOS share-sheet path):
//   PRINT_BRIDGE_KEY=<key> PRINT_BRIDGE_ENABLED=false \
//   node scripts/set-print-bridge-config.mjs
//
// To rotate ONLY the URL or timeout without re-typing the key, fetch
// the existing doc first, edit it in the Firestore console, then run
// this script with PRINT_BRIDGE_KEY=<existing key> to confirm the
// rest of the doc is intact.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const serviceAcct = JSON.parse(
    readFileSync(path.join(repoRoot, 'firebase-service-account.json'), 'utf8')
);

initializeApp({ credential: cert(serviceAcct) });
const db = getFirestore();

const apiKey = (process.env.PRINT_BRIDGE_KEY || '').trim();
const url = (process.env.PRINT_BRIDGE_URL || 'https://ddmau-pi5.tail763c0d.ts.net').trim();
const enabled = process.env.PRINT_BRIDGE_ENABLED !== 'false';
const healthCheckTimeoutMs = Number(process.env.PRINT_BRIDGE_TIMEOUT_MS) || 800;

if (!apiKey) {
    console.error('Missing PRINT_BRIDGE_KEY env var.');
    console.error('');
    console.error('Usage:');
    console.error('  PRINT_BRIDGE_KEY=<the 64-char hex key from the Pi> \\');
    console.error('  node scripts/set-print-bridge-config.mjs');
    console.error('');
    console.error('Get the key from your Pi via:');
    console.error('  ssh ddmau@ddmau-pi5.local "sudo cat /etc/print_bridge/api_key"');
    process.exit(1);
}

if (apiKey.length < 32) {
    console.error(`PRINT_BRIDGE_KEY looks too short (${apiKey.length} chars). Expected 64-char hex.`);
    console.error('Did you paste the right value from /etc/print_bridge/api_key?');
    process.exit(1);
}

if (!/^https:\/\//.test(url)) {
    console.error(`PRINT_BRIDGE_URL must be HTTPS. Got: ${url}`);
    process.exit(1);
}

const config = {
    enabled,
    url: url.replace(/\/+$/, ''),  // strip trailing slashes
    apiKey,
    healthCheckTimeoutMs,
    updatedAt: new Date().toISOString(),
};

console.log('Writing /config/print_bridge:');
console.log(`  enabled              : ${config.enabled}`);
console.log(`  url                  : ${config.url}`);
console.log(`  apiKey               : ${apiKey.slice(0, 6)}...${apiKey.slice(-4)}  (${apiKey.length} chars)`);
console.log(`  healthCheckTimeoutMs : ${config.healthCheckTimeoutMs}`);
console.log('');

try {
    await db.collection('config').doc('print_bridge').set(config, { merge: true });
    console.log('✓ Done. The DD Mau web app will start trying the bridge on next print.');
    console.log('');
    console.log('Verify by opening Date Stickers in the app and printing a test sticker —');
    console.log('label should come out of the Brother in ~2 seconds. If the iOS share-sheet');
    console.log('pops up instead, check audit logs for `transport: pdf_share_sheet (bridge');
    console.log('fallback: ...)` to see why the bridge attempt failed.');
    process.exit(0);
} catch (e) {
    console.error('Write failed:', e.message || e);
    process.exit(1);
}
