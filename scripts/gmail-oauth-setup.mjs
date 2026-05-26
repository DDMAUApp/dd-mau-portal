#!/usr/bin/env node
// gmail-oauth-setup.mjs
//
// One-time interactive setup for the pollGmail Cloud Function. Walks
// through the OAuth dance and prints the refresh token + client id +
// secret to copy into Firebase secrets.
//
// PREREQUISITES (do these in Google Cloud Console FIRST):
//   1. Open https://console.cloud.google.com/ — make sure the project
//      "dd-mau-staff-app" is selected.
//   2. APIs & Services → Library → search "Gmail API" → Enable.
//   3. APIs & Services → OAuth consent screen:
//        - User type: External (or Internal if Workspace)
//        - App name: "DD Mau Inbox Triage"
//        - User support email: andrew@…
//        - Add scopes: .../auth/gmail.readonly
//        - Test users: andrew + julie's gmail addresses
//        - Save (no need to publish — Testing mode is fine)
//   4. APIs & Services → Credentials → Create credentials → OAuth client ID:
//        - Application type: Desktop app
//        - Name: "DD Mau Inbox Triage CLI"
//        - Download the JSON → save as gmail-oauth-client.json at the
//          repo root (gitignored).
//
// THEN run this script:
//   node scripts/gmail-oauth-setup.mjs
//
// It opens a browser to the Google consent screen, you sign in with the
// Gmail account whose inbox you want monitored, paste the redirect URL
// back into the terminal, and the script prints the three secrets you
// need to put into Firebase:
//
//   firebase functions:secrets:set GMAIL_OAUTH_CLIENT_ID
//   firebase functions:secrets:set GMAIL_OAUTH_CLIENT_SECRET
//   firebase functions:secrets:set GMAIL_OAUTH_REFRESH_TOKEN
//
// (Paste each value when prompted.) After that, pollGmail can read the
// inbox without you ever needing to sign in again — the refresh token
// is long-lived.

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');
const clientJsonPath = path.join(repoRoot, 'gmail-oauth-client.json');

// ── Load the OAuth client JSON ───────────────────────────────────────────
let client;
try {
    const raw = JSON.parse(await fs.readFile(clientJsonPath, 'utf8'));
    // Google Cloud Console exports either "installed" (Desktop app) or
    // "web" depending on the type. Handle both shapes.
    client = raw.installed || raw.web || raw;
    if (!client.client_id || !client.client_secret) {
        throw new Error('client_id / client_secret missing from JSON');
    }
} catch (e) {
    console.error(`\nCould not load ${clientJsonPath}`);
    console.error(`${e.message}\n`);
    console.error('Make sure you finished the prerequisites in the script header:');
    console.error('  Google Cloud Console → Credentials → Create OAuth client ID (Desktop app)');
    console.error('  Download JSON → save as gmail-oauth-client.json at the repo root.\n');
    process.exit(1);
}

// ── Build the consent URL ────────────────────────────────────────────────
// We use Google's OOB (out-of-band) flow: redirect_uri=urn:ietf:wg:oauth:2.0:oob
// is deprecated, so use loopback http://localhost — the user can copy the
// final URL out of the address bar after consent. No need to actually
// run a local server for a one-shot setup.
const REDIRECT_URI = 'http://localhost:53682';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const consentUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
consentUrl.searchParams.set('client_id', client.client_id);
consentUrl.searchParams.set('redirect_uri', REDIRECT_URI);
consentUrl.searchParams.set('response_type', 'code');
consentUrl.searchParams.set('scope', SCOPE);
consentUrl.searchParams.set('access_type', 'offline');
consentUrl.searchParams.set('prompt', 'consent'); // force refresh_token issuance every time

console.log('\n────────────────────────────────────────────────────────────');
console.log('Gmail OAuth setup — one-time consent flow');
console.log('────────────────────────────────────────────────────────────');
console.log('\nStep 1. Open this URL in a browser:\n');
console.log(consentUrl.toString());
console.log('\nStep 2. Sign in with the Gmail account you want monitored.');
console.log('Step 3. Click Continue / Allow on the scopes screen.');
console.log('Step 4. Google will redirect to a localhost URL that may');
console.log('        look broken — that is expected. Copy the FULL URL');
console.log('        from the browser address bar (it contains ?code=...).');
console.log('────────────────────────────────────────────────────────────\n');

const rl = readline.createInterface({ input, output });
const redirectUrlInput = (await rl.question('Paste the localhost URL here: ')).trim();
rl.close();

let code;
try {
    const u = new URL(redirectUrlInput);
    code = u.searchParams.get('code');
    if (!code) throw new Error('no ?code= param found in URL');
} catch (e) {
    console.error(`\nCould not parse the redirect URL: ${e.message}`);
    console.error('Make sure you pasted the FULL URL including ?code=...\n');
    process.exit(1);
}

// ── Exchange code for refresh token ──────────────────────────────────────
console.log('\nExchanging authorization code for refresh token…');
const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
    }),
});

if (!tokenResp.ok) {
    const text = await tokenResp.text();
    console.error(`\nToken exchange failed (${tokenResp.status}):`);
    console.error(text);
    console.error('\nCommon causes:');
    console.error('  - The code expired (use it within a few minutes of getting it)');
    console.error('  - The redirect_uri doesn\'t match exactly');
    console.error('  - The OAuth consent screen still has you as a Test user but the app');
    console.error('    is in Production mode without going through verification\n');
    process.exit(1);
}

const tokens = await tokenResp.json();
if (!tokens.refresh_token) {
    console.error('\nGoogle returned an access token but NOT a refresh_token.');
    console.error('This usually means you have already consented before — go to');
    console.error('https://myaccount.google.com/permissions, remove the "DD Mau');
    console.error('Inbox Triage" entry, then re-run this script.\n');
    process.exit(1);
}

console.log('\n✓ Got refresh token!\n');
console.log('────────────────────────────────────────────────────────────');
console.log('Paste each of these into Firebase secrets (one at a time):');
console.log('────────────────────────────────────────────────────────────\n');
console.log('firebase functions:secrets:set GMAIL_OAUTH_CLIENT_ID');
console.log('  Value:', client.client_id);
console.log('');
console.log('firebase functions:secrets:set GMAIL_OAUTH_CLIENT_SECRET');
console.log('  Value:', client.client_secret);
console.log('');
console.log('firebase functions:secrets:set GMAIL_OAUTH_REFRESH_TOKEN');
console.log('  Value:', tokens.refresh_token);
console.log('');
console.log('Then redeploy functions:');
console.log('  firebase deploy --only functions:pollGmail\n');

process.exit(0);
