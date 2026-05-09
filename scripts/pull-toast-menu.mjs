#!/usr/bin/env node
// pull-toast-menu.mjs
// One-time (or on-demand) snapshot of the live Toast menu + modifiers for
// reconciliation against the portal (training, allergen matrix, menu copy).
//
// Output: writes toast-menu-snapshot.json next to the repo root. Pretty-
// printed so a human can grep/scroll through it. NOT committed to git
// (see .gitignore) since it's large and may contain internal config.
//
// Usage:
//   1. Set the three env vars (Toast credentials — same ones the Railway
//      scraper uses for orders/invoices):
//        export TOAST_CLIENT_ID="..."
//        export TOAST_CLIENT_SECRET="..."
//        export TOAST_RESTAURANT_GUID="..."
//      Or drop them in a .env file at the repo root.
//   2. From the repo root, run:
//        node scripts/pull-toast-menu.mjs
//   3. The script:
//        a. authenticates with Toast (OAuth client_credentials),
//        b. pulls the published-menu structure (/menus/v2/menus),
//        c. ALSO pulls config/v2/menuItems + config/v2/modifierGroups +
//           config/v2/modifierOptions (more granular allergen-relevant
//           data — e.g. SKU, hidden modifiers, current 86 status),
//        d. writes everything to toast-menu-snapshot.json with timestamp.
//
// Re-run this whenever the Toast menu changes — it overwrites the file.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

// ── Lightweight .env loader (no dependency) ──────────────────────────────
async function loadDotEnv() {
    try {
        const txt = await fs.readFile(path.join(repoRoot, '.env'), 'utf8');
        for (const line of txt.split('\n')) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!m) continue;
            const [, k, raw] = m;
            if (process.env[k]) continue; // env wins over .env
            // Strip optional surrounding quotes
            process.env[k] = raw.replace(/^['"]|['"]$/g, '');
        }
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        // No .env — that's fine if shell env already has the creds.
    }
}

await loadDotEnv();

const CLIENT_ID     = process.env.TOAST_CLIENT_ID;
const CLIENT_SECRET = process.env.TOAST_CLIENT_SECRET;
const RESTAURANT    = process.env.TOAST_RESTAURANT_GUID;
// Default to production. Override with TOAST_API_HOST=https://ws-sandbox-api.toasttab.com
// if testing against sandbox.
const HOST = process.env.TOAST_API_HOST || 'https://ws-api.toasttab.com';

if (!CLIENT_ID || !CLIENT_SECRET || !RESTAURANT) {
    console.error('Missing Toast credentials. Set TOAST_CLIENT_ID,');
    console.error('TOAST_CLIENT_SECRET, and TOAST_RESTAURANT_GUID in env or .env.');
    process.exit(1);
}

// ── Step 1: OAuth → bearer token ─────────────────────────────────────────
console.log('→ Authenticating with Toast…');
const authRes = await fetch(`${HOST}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
});
if (!authRes.ok) {
    console.error(`Auth failed: ${authRes.status} ${authRes.statusText}`);
    console.error(await authRes.text());
    process.exit(1);
}
const authJson = await authRes.json();
const token = authJson?.token?.accessToken;
if (!token) {
    console.error('Auth succeeded but no accessToken in response:', authJson);
    process.exit(1);
}
console.log('✓ Got bearer token');

const headers = {
    Authorization: `Bearer ${token}`,
    'Toast-Restaurant-External-ID': RESTAURANT,
    Accept: 'application/json',
};

// ── Step 2: Helper to fetch + parse + tolerate 404 ───────────────────────
async function getJson(label, url) {
    process.stdout.write(`→ ${label}… `);
    const r = await fetch(url, { headers });
    if (!r.ok) {
        console.log(`✗ ${r.status}`);
        const body = await r.text().catch(() => '');
        return { __error: `${r.status} ${r.statusText}`, __body: body.slice(0, 500) };
    }
    const json = await r.json();
    const count = Array.isArray(json) ? json.length : (json?.menus?.length || 1);
    console.log(`✓ ${count} record(s)`);
    return json;
}

// ── Step 3: Pull all the things ──────────────────────────────────────────
const snapshot = {
    pulledAt: new Date().toISOString(),
    restaurantGuid: RESTAURANT,
    sources: {},
};

// Published customer-facing menu (most useful — items + modifier groups
// + modifier options all nested).
snapshot.sources.publishedMenu = await getJson(
    'Published menu (/menus/v2/menus)',
    `${HOST}/menus/v2/menus`,
);

// Configuration endpoints — more granular. Useful for reconciliation
// (find items that exist in config but aren't on a published menu, etc.).
snapshot.sources.menuItems = await getJson(
    'Menu items (/menus/v2/menuItems)',
    `${HOST}/menus/v2/menuItems`,
);
snapshot.sources.modifierGroups = await getJson(
    'Modifier groups (/menus/v2/modifierGroups)',
    `${HOST}/menus/v2/modifierGroups`,
);
snapshot.sources.modifierOptions = await getJson(
    'Modifier options (/menus/v2/modifierOptions)',
    `${HOST}/menus/v2/modifierOptions`,
);

// ── Step 4: Write to disk ────────────────────────────────────────────────
const outPath = path.join(repoRoot, 'toast-menu-snapshot.json');
await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2), 'utf8');

const stat = await fs.stat(outPath);
console.log('');
console.log(`✓ Wrote ${(stat.size / 1024).toFixed(1)} KB to ${path.relative(repoRoot, outPath)}`);
console.log('');
console.log('This file is gitignored. Share it back with the assistant');
console.log('(paste sections, attach, or commit to a private location).');
