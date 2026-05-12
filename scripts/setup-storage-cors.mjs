#!/usr/bin/env node
// setup-storage-cors.mjs
//
// Pushes cors.json to the Firebase Storage bucket so the new-hire portal
// (and the rest of the app) can download PDFs cross-origin.
//
// THE BUG THIS FIXES (2026-05-11):
//   Hires opening their invite link from ddmauapp.github.io were seeing
//   every fillable template doc stuck on "Loading template…" with no
//   visible error. Root cause: the GCS bucket
//   `dd-mau-staff-app.firebasestorage.app` had NO CORS configuration, so
//   the browser blocked every cross-origin download even though the
//   tokenized download URL itself worked (verified by curl).
//
// SETUP (one-time):
//   1. Firebase Console → Project Settings → Service Accounts → Generate
//      new private key (saves a .json).
//   2. Save it as `firebase-service-account.json` at the repo root
//      (gitignored — never commit it).
//   3. From repo root:  npm install  (firebase-admin already in deps)
//
// RUN (every time you edit cors.json, or once after bucket creation):
//   npm run cors-setup
//
// Verify the config landed:
//   curl -I -H "Origin: https://ddmauapp.github.io" \
//     "https://firebasestorage.googleapis.com/v0/b/dd-mau-staff-app.firebasestorage.app/o/onboarding_templates%2FANYFILE.pdf?alt=media&token=ANYTOKEN"
//   The response should include  Access-Control-Allow-Origin: https://ddmauapp.github.io
//
// Reference:
//   https://firebase.google.com/docs/storage/web/download-files#cors_configuration
//   https://cloud.google.com/storage/docs/cross-origin

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

const KEY_PATH = path.join(repoRoot, 'firebase-service-account.json');
const CORS_PATH = path.join(repoRoot, 'cors.json');
const BUCKET = 'dd-mau-staff-app.firebasestorage.app';

async function main() {
    // Load service account creds.
    let keyJson;
    try {
        keyJson = JSON.parse(await fs.readFile(KEY_PATH, 'utf8'));
    } catch (e) {
        console.error(`\n❌ Could not read ${KEY_PATH}`);
        console.error('   Generate a service account key from the Firebase Console:');
        console.error('   Project Settings → Service Accounts → Generate new private key.\n');
        process.exit(1);
    }

    // Load + validate the cors config.
    let cors;
    try {
        cors = JSON.parse(await fs.readFile(CORS_PATH, 'utf8'));
        if (!Array.isArray(cors) || cors.length === 0) throw new Error('cors.json must be a non-empty array');
        for (const rule of cors) {
            if (!Array.isArray(rule.origin) || !Array.isArray(rule.method)) {
                throw new Error('each rule needs origin[] and method[]');
            }
        }
    } catch (e) {
        console.error(`\n❌ Bad ${CORS_PATH}: ${e.message}\n`);
        process.exit(1);
    }

    const app = initializeApp({
        credential: cert(keyJson),
        storageBucket: BUCKET,
    });

    const bucket = getStorage(app).bucket();
    console.log(`Pushing CORS to gs://${BUCKET} ...`);
    console.log(`Origins: ${cors[0].origin.join(', ')}`);
    console.log(`Methods: ${cors[0].method.join(', ')}`);

    await bucket.setCorsConfiguration(cors);

    // Read back to confirm.
    const [meta] = await bucket.getMetadata();
    console.log('\n✅ CORS applied. Live config on bucket:');
    console.log(JSON.stringify(meta.cors, null, 2));
    console.log('\nVerify cross-origin from a browser:');
    console.log('  https://ddmauapp.github.io/dd-mau-portal/?onboard=<token>');
    console.log('  → fillable PDF templates should render instead of hanging on "Loading template…"');
}

main().catch(e => {
    console.error('\n❌ CORS setup failed:', e);
    process.exit(1);
});
