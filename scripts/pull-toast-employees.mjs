#!/usr/bin/env node
// pull-toast-employees.mjs
// Pulls the full employee list from Toast Labor API and writes it to
// Firestore at /ops/toast_employees so the in-app "🔄 Fetch from Toast"
// button (ImportStaffModal Stage 1) can read fresh data.
//
// Why this script lives here:
// Andrew wanted the import flow's Fetch button to work without standing
// up a Railway-side scraper. Toast exposes /labor/v1/employees via the
// same OAuth credentials pull-toast-menu.mjs already uses, so this is
// a one-shot Node command he can run on his Mac.
//
// Usage:
//   1. Make sure your Toast credentials are in .env (same as the menu
//      pull script):
//        TOAST_CLIENT_ID="..."
//        TOAST_CLIENT_SECRET="..."
//
//      AND restaurant GUID(s). Pick one of two patterns:
//
//      a. Single restaurant:
//           TOAST_RESTAURANT_GUID="webster-guid"
//
//      b. Both restaurants (recommended for DD Mau — pulls both Webster
//         and Maryland and tags each employee with their store):
//           TOAST_RESTAURANT_GUID_WEBSTER="webster-guid"
//           TOAST_RESTAURANT_GUID_MARYLAND="maryland-guid"
//
//   2. Also need firebase-service-account.json at repo root (same key
//      the backup script uses — already set up).
//
//   3. Run:
//        npm run sync-toast-employees
//      OR:
//        node scripts/pull-toast-employees.mjs
//
//   4. Output:
//        - Writes /ops/toast_employees with shape:
//            { employees: [{ name, role?, location? }, ...],
//              updatedAt: serverTimestamp,
//              source: "toast",
//              counts: { webster?: N, maryland?: M, total: K } }
//        - Prints a summary of who was pulled.
//
//   5. Back in the app: Admin → Staff → 📥 Import Staff → 🔄 Fetch
//      from Toast. The button should now show "Fetched N employees".
//
// Re-run whenever Toast employees change (new hire, role move, etc.).
// You can also schedule this on a cron later — same machine that
// runs Backup.command works fine.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

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
            process.env[k] = raw.replace(/^['"]|['"]$/g, '');
        }
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
}

await loadDotEnv();

const CLIENT_ID     = process.env.TOAST_CLIENT_ID;
const CLIENT_SECRET = process.env.TOAST_CLIENT_SECRET;
const HOST = process.env.TOAST_API_HOST || 'https://ws-api.toasttab.com';

// Build the list of (location, restaurantGuid) pairs to pull. Per-
// location env vars win over the legacy single GUID.
const RESTAURANTS = [];
if (process.env.TOAST_RESTAURANT_GUID_WEBSTER) {
    RESTAURANTS.push({ location: 'webster', guid: process.env.TOAST_RESTAURANT_GUID_WEBSTER });
}
if (process.env.TOAST_RESTAURANT_GUID_MARYLAND) {
    RESTAURANTS.push({ location: 'maryland', guid: process.env.TOAST_RESTAURANT_GUID_MARYLAND });
}
if (RESTAURANTS.length === 0 && process.env.TOAST_RESTAURANT_GUID) {
    // Legacy single-GUID fallback. We don't know which store this is,
    // so we leave location undefined and let the app's normalizeLocation
    // fall back to defaultLocation (admin's current store).
    RESTAURANTS.push({ location: undefined, guid: process.env.TOAST_RESTAURANT_GUID });
}

if (!CLIENT_ID || !CLIENT_SECRET || RESTAURANTS.length === 0) {
    console.error('');
    console.error('❌ Missing Toast credentials.');
    console.error('   Set TOAST_CLIENT_ID + TOAST_CLIENT_SECRET in .env');
    console.error('   AND one of:');
    console.error('     TOAST_RESTAURANT_GUID                 (single restaurant)');
    console.error('     TOAST_RESTAURANT_GUID_WEBSTER         (recommended)');
    console.error('     TOAST_RESTAURANT_GUID_MARYLAND        (recommended)');
    process.exit(1);
}

// ── Firebase Admin SDK (same service account as backup script) ──────────
const KEY_CANDIDATES = [
    path.join(repoRoot, 'firebase-service-account.json'),
    path.join(repoRoot, 'serviceAccountKey.json'),
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
].filter(Boolean);

let keyPath = null;
for (const p of KEY_CANDIDATES) {
    try { await fs.access(p); keyPath = p; break; } catch {}
}
if (!keyPath) {
    console.error('');
    console.error('❌ Could not find a Firebase service account key.');
    console.error('   Drop firebase-service-account.json at the repo root.');
    console.error('   See BACKUP.md for setup if you haven\'t done it before.');
    process.exit(1);
}

const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Toast OAuth → bearer token ───────────────────────────────────────────
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
    console.error(`✗ Auth failed: ${authRes.status} ${authRes.statusText}`);
    console.error(await authRes.text());
    process.exit(1);
}
const authJson = await authRes.json();
const token = authJson?.token?.accessToken;
if (!token) {
    console.error('✗ Auth succeeded but no accessToken in response:', authJson);
    process.exit(1);
}
console.log('✓ Got bearer token');

// ── Per-restaurant pull: jobs (for role name resolution) + employees ────
async function pullFor(restaurant) {
    const headers = {
        Authorization: `Bearer ${token}`,
        'Toast-Restaurant-External-ID': restaurant.guid,
        Accept: 'application/json',
    };

    // STEP A: Pull jobs first so we can map jobReferences[].guid →
    // job title (Server / Line Cook / Manager / …). Toast's employees
    // endpoint only includes job GUIDs, not the human-readable name.
    const jobsRes = await fetch(`${HOST}/labor/v1/jobs`, { headers });
    if (!jobsRes.ok) {
        const body = await jobsRes.text().catch(() => '');
        console.error(`✗ Jobs fetch failed (${restaurant.location || restaurant.guid}): ${jobsRes.status}`);
        console.error('  Body:', body.slice(0, 500));
        return { employees: [], location: restaurant.location };
    }
    const jobs = await jobsRes.json();
    const jobMap = new Map();
    for (const j of (Array.isArray(jobs) ? jobs : [])) {
        if (j?.guid) jobMap.set(j.guid, j.title || j.name || null);
    }
    console.log(`  ✓ ${restaurant.location || restaurant.guid}: ${jobMap.size} job titles loaded`);

    // STEP B: Pull employees. /labor/v1/employees returns the full list
    // (Toast paginates above ~100; we follow pageToken if present).
    const allEmployees = [];
    let pageToken = null;
    do {
        const url = new URL(`${HOST}/labor/v1/employees`);
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const empRes = await fetch(url.toString(), { headers });
        if (!empRes.ok) {
            const body = await empRes.text().catch(() => '');
            console.error(`✗ Employees fetch failed (${restaurant.location || restaurant.guid}): ${empRes.status}`);
            console.error('  Body:', body.slice(0, 500));
            break;
        }
        const page = await empRes.json();
        // Response can be either an array directly OR a paginated object.
        const list = Array.isArray(page) ? page : (page?.employees || page?.data || []);
        allEmployees.push(...list);
        // Pagination: Toast uses Toast-Next-Page-Token header for some
        // labor endpoints; others return pageToken in the body. Handle
        // both. If neither is present, we're done.
        pageToken = empRes.headers.get('Toast-Next-Page-Token')
                 || page?.nextPageToken
                 || page?.pageToken
                 || null;
    } while (pageToken);

    // Transform Toast's response into the shape /ops/toast_employees
    // expects (matches what ImportStaffModal's parser handles).
    const out = [];
    for (const e of allEmployees) {
        if (e?.deleted) continue;          // skip archived employees
        if (!e?.firstName && !e?.lastName) continue;
        const name = [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
        if (!name) continue;
        // Role = first non-deleted job reference's title (Toast supports
        // multiple jobs per employee, but for staff-list display the
        // primary job is fine — admin can refine in Configure stage).
        let role = null;
        const refs = Array.isArray(e.jobReferences) ? e.jobReferences : [];
        for (const ref of refs) {
            const title = jobMap.get(ref?.guid);
            if (title) { role = title; break; }
        }
        out.push({
            name,
            ...(role && { role }),
            ...(restaurant.location && { location: restaurant.location }),
        });
    }
    console.log(`  ✓ ${restaurant.location || restaurant.guid}: ${out.length} active employees`);
    return { employees: out, location: restaurant.location };
}

// ── Pull everyone, merge by name (in case the same person exists at
// both restaurants — gets tagged "both") ─────────────────────────────────
console.log('→ Pulling employee data…');
const allPulls = [];
for (const r of RESTAURANTS) {
    const result = await pullFor(r);
    allPulls.push(result);
}

// Merge by normalized name. If a person appears in both locations,
// their location becomes 'both' and we keep the first-seen role.
function normName(s) {
    return (s || '').toString().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}
const merged = new Map();
const counts = { total: 0 };
for (const pull of allPulls) {
    if (pull.location) counts[pull.location] = pull.employees.length;
    for (const emp of pull.employees) {
        const key = normName(emp.name);
        if (!key) continue;
        if (merged.has(key)) {
            // Already seen at another restaurant — tag as 'both'.
            const existing = merged.get(key);
            if (existing.location && emp.location && existing.location !== emp.location) {
                existing.location = 'both';
            }
            // Keep first-seen role.
            if (!existing.role && emp.role) existing.role = emp.role;
        } else {
            merged.set(key, { ...emp });
        }
    }
}
const finalEmployees = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
counts.total = finalEmployees.length;

console.log('');
console.log(`✓ Pulled ${counts.total} unique employees`);
if (counts.webster != null) console.log(`  • Webster:  ${counts.webster}`);
if (counts.maryland != null) console.log(`  • Maryland: ${counts.maryland}`);

// ── Write to Firestore ──────────────────────────────────────────────────
console.log('→ Writing /ops/toast_employees…');
await db.collection('ops').doc('toast_employees').set({
    employees: finalEmployees,
    updatedAt: FieldValue.serverTimestamp(),
    source: 'toast',
    counts,
});
console.log('✓ Done.');
console.log('');
console.log('Open the app: Admin → Staff → 📥 Import Staff → 🔄 Fetch from Toast');
console.log('You should now see the employees ready to diff against your staff list.');
process.exit(0);
