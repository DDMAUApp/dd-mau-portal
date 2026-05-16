#!/usr/bin/env node
// sync-toast-86-attribution.mjs
// Polls Toast's Stock API every N minutes (or runs as a cron), detects
// when items transition into / out of OUT_OF_STOCK, then cross-references
// against the Labor API timeEntries to figure out WHO was clocked in
// when the change happened. Writes attribution data next to each item
// in /ops/86_{location} so Eighty6Dashboard can display "86'd by Maria
// at 4:23pm".
//
// WHY THIS EXISTS (the senior-eng note):
// Toast doesn't expose menu-change attribution via any public API.
// The Publishing Center History page in Toast Web shows publisher info
// but is UI-only AND only covers menu config changes — 86 events bypass
// the publish workflow entirely. So the closest we can get to "who 86'd
// this" is: cross-reference the transition timestamp with who was on
// the clock at that moment.
//
// PRECISION CAVEAT:
// If one BOH staffer was on the clock when the 86 happened: high
// confidence — that's the person. If multiple staff overlapped, we
// store all of them as candidates. The UI surfaces this as "Maria or
// Cash" rather than guessing. Better than no attribution at all and
// better than a wrong guess.
//
// HOW IT INTEGRATES WITH THE EXISTING 86 BOARD:
// /ops/86_{location} is currently written by the existing scraper
// pipeline (items + count + updatedAt). This script does NOT overwrite
// items[]. Instead it writes a sibling field:
//
//   attribution: {
//     [itemName]: {
//       outBy: [staffName, ...],    // clocked-in BOH at out-time
//       outAt: <serverTimestamp>,
//       inBy:  [staffName, ...],    // clocked-in BOH at back-in-time
//       inAt:  <serverTimestamp>,
//     },
//     ...
//   }
//
// Eighty6Dashboard reads attribution[item.name] and renders names when
// present. Falls back to nothing when missing (e.g., legacy items, or
// items that transitioned before this script ran).
//
// CURSOR DOC:
// /ops/toast_86_cursor_{location} stores:
//   {
//     outNames: [...],         // last-seen OUT_OF_STOCK item NAMES
//     lastSyncedAt: <ts>,      // when we last polled
//   }
// Used to detect transitions between runs. On first run (no cursor),
// everything currently out is treated as "already out" — no false
// attribution.
//
// USAGE:
//   1. Set env vars in .env (same as pull-toast-employees.mjs):
//        TOAST_CLIENT_ID, TOAST_CLIENT_SECRET
//        TOAST_RESTAURANT_GUID_WEBSTER and/or TOAST_RESTAURANT_GUID_MARYLAND
//   2. firebase-service-account.json at repo root (same as backup script)
//   3. Run: npm run sync-toast-86
//   4. Schedule as a cron — every 5-10 minutes is the sweet spot
//      (faster = tighter "who was clocked in" window = more precise
//      attribution; slower = fewer API calls).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

// ── .env loader (same pattern as pull-toast-menu/employees) ────────────
async function loadDotEnv() {
    try {
        const txt = await fs.readFile(path.join(repoRoot, '.env'), 'utf8');
        for (const line of txt.split('\n')) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!m) continue;
            const [, k, raw] = m;
            if (process.env[k]) continue;
            process.env[k] = raw.replace(/^['"]|['"]$/g, '');
        }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
await loadDotEnv();

const CLIENT_ID     = process.env.TOAST_CLIENT_ID;
const CLIENT_SECRET = process.env.TOAST_CLIENT_SECRET;
const HOST          = process.env.TOAST_API_HOST || 'https://ws-api.toasttab.com';

// Per-location restaurant GUIDs — both supported.
const RESTAURANTS = [];
if (process.env.TOAST_RESTAURANT_GUID_WEBSTER) {
    RESTAURANTS.push({ location: 'webster', guid: process.env.TOAST_RESTAURANT_GUID_WEBSTER });
}
if (process.env.TOAST_RESTAURANT_GUID_MARYLAND) {
    RESTAURANTS.push({ location: 'maryland', guid: process.env.TOAST_RESTAURANT_GUID_MARYLAND });
}
if (RESTAURANTS.length === 0 && process.env.TOAST_RESTAURANT_GUID) {
    RESTAURANTS.push({ location: 'webster', guid: process.env.TOAST_RESTAURANT_GUID });
}
if (!CLIENT_ID || !CLIENT_SECRET || RESTAURANTS.length === 0) {
    console.error('❌ Missing Toast credentials or restaurant GUIDs. See script header.');
    process.exit(1);
}

// ── Firebase Admin init ────────────────────────────────────────────────
const KEY_CANDIDATES = [
    path.join(repoRoot, 'firebase-service-account.json'),
    path.join(repoRoot, 'serviceAccountKey.json'),
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
].filter(Boolean);
let keyPath = null;
for (const p of KEY_CANDIDATES) { try { await fs.access(p); keyPath = p; break; } catch {} }
if (!keyPath) {
    console.error('❌ Could not find firebase-service-account.json at repo root.');
    process.exit(1);
}
const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Toast OAuth → bearer token ─────────────────────────────────────────
console.log('→ Authenticating with Toast…');
const authRes = await fetch(`${HOST}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, userAccessType: 'TOAST_MACHINE_CLIENT' }),
});
if (!authRes.ok) {
    console.error(`✗ Auth failed: ${authRes.status} ${authRes.statusText}`);
    console.error(await authRes.text());
    process.exit(1);
}
const token = (await authRes.json())?.token?.accessToken;
if (!token) { console.error('✗ No accessToken in auth response'); process.exit(1); }
console.log('✓ Got bearer token');

// ── Toast API helpers ──────────────────────────────────────────────────
const apiHeaders = (restaurantGuid) => ({
    Authorization: `Bearer ${token}`,
    'Toast-Restaurant-External-ID': restaurantGuid,
    Accept: 'application/json',
});

// GET /stock/v1/inventory — current OUT_OF_STOCK + low-quantity items.
async function fetchInventory(restaurantGuid) {
    const r = await fetch(`${HOST}/stock/v1/inventory`, { headers: apiHeaders(restaurantGuid) });
    if (!r.ok) {
        console.error(`✗ /stock/v1/inventory failed: ${r.status}`);
        return null;
    }
    return r.json();
}

// GET /menus/v2/menuItems — resolve item guid → human-readable name.
// Cached per restaurant since menu items don't change minute-to-minute.
const itemNameCacheByRestaurant = new Map();
async function fetchItemNames(restaurantGuid) {
    if (itemNameCacheByRestaurant.has(restaurantGuid)) {
        return itemNameCacheByRestaurant.get(restaurantGuid);
    }
    const r = await fetch(`${HOST}/menus/v2/menuItems`, { headers: apiHeaders(restaurantGuid) });
    if (!r.ok) {
        console.warn(`⚠ /menus/v2/menuItems failed (${r.status}) — falling back to GUIDs`);
        itemNameCacheByRestaurant.set(restaurantGuid, new Map());
        return new Map();
    }
    const items = await r.json();
    const map = new Map();
    for (const it of (Array.isArray(items) ? items : [])) {
        if (it?.guid) map.set(it.guid, it.name || it.guid);
    }
    itemNameCacheByRestaurant.set(restaurantGuid, map);
    return map;
}

// GET /labor/v1/timeEntries — who's clocked in at this moment.
// Toast returns entries for the business date; we filter to entries
// whose start <= momentTs and (no end OR end >= momentTs).
async function fetchActiveStaffAt(restaurantGuid, momentDate) {
    const businessDate = momentDate.toISOString().slice(0, 10).replace(/-/g, '');
    const r = await fetch(`${HOST}/labor/v1/timeEntries?businessDate=${businessDate}`, {
        headers: apiHeaders(restaurantGuid),
    });
    if (!r.ok) {
        console.warn(`⚠ /labor/v1/timeEntries failed (${r.status}) — no attribution available`);
        return [];
    }
    const entries = await r.json();
    const momentMs = momentDate.getTime();
    return (Array.isArray(entries) ? entries : []).filter(e => {
        if (!e?.inDate) return false;
        const inMs = new Date(e.inDate).getTime();
        const outMs = e.outDate ? new Date(e.outDate).getTime() : Infinity;
        return inMs <= momentMs && momentMs <= outMs;
    });
}

// GET /labor/v1/employees — resolve employee guid → full name.
// Cached for the run.
const employeeNameCacheByRestaurant = new Map();
async function fetchEmployeeNames(restaurantGuid) {
    if (employeeNameCacheByRestaurant.has(restaurantGuid)) {
        return employeeNameCacheByRestaurant.get(restaurantGuid);
    }
    const r = await fetch(`${HOST}/labor/v1/employees`, { headers: apiHeaders(restaurantGuid) });
    if (!r.ok) {
        console.warn(`⚠ /labor/v1/employees failed (${r.status})`);
        employeeNameCacheByRestaurant.set(restaurantGuid, new Map());
        return new Map();
    }
    const list = await r.json();
    const map = new Map();
    for (const e of (Array.isArray(list) ? list : [])) {
        if (e?.guid) {
            const name = [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
            if (name) map.set(e.guid, name);
        }
    }
    employeeNameCacheByRestaurant.set(restaurantGuid, map);
    return map;
}

// ── Main loop — per restaurant ─────────────────────────────────────────
for (const r of RESTAURANTS) {
    console.log(`\n→ Processing ${r.location}…`);

    // 1. Pull current Toast stock state.
    const inventory = await fetchInventory(r.guid);
    if (!inventory) { console.warn(`  ⚠ skipping ${r.location} — inventory unavailable`); continue; }
    const itemNames = await fetchItemNames(r.guid);

    // 2. Resolve current OUT_OF_STOCK set as human names.
    const currentOutNames = new Set();
    for (const inv of (Array.isArray(inventory) ? inventory : [])) {
        if (inv?.status !== 'OUT_OF_STOCK') continue;
        const name = itemNames.get(inv.guid) || inv.guid;
        currentOutNames.add(name);
    }
    console.log(`  • Currently 86'd: ${currentOutNames.size} item(s)`);

    // 3. Read the previous cursor to detect transitions.
    const cursorRef = db.collection('ops').doc(`toast_86_cursor_${r.location}`);
    const cursorSnap = await cursorRef.get();
    const prevOutNames = new Set(cursorSnap.exists ? (cursorSnap.data()?.outNames || []) : null);
    const firstRun = !cursorSnap.exists;

    // On first run we don't fire attribution for anything currently out —
    // we have no idea WHEN they originally went out, so attribution would
    // be wrong. Treat first run as "everything currently out is already
    // out, only future transitions get attributed."
    if (firstRun) {
        console.log('  • First run — seeding cursor, no attribution this pass');
        await cursorRef.set({
            outNames: Array.from(currentOutNames),
            lastSyncedAt: FieldValue.serverTimestamp(),
        });
        continue;
    }

    // 4. Diff current vs previous → newly OUT and newly BACK.
    const newlyOut = Array.from(currentOutNames).filter(n => !prevOutNames.has(n));
    const newlyIn  = Array.from(prevOutNames).filter(n => !currentOutNames.has(n));
    console.log(`  • Transitions: +${newlyOut.length} out, +${newlyIn.length} back in`);

    if (newlyOut.length === 0 && newlyIn.length === 0) {
        // No transitions — just refresh the cursor's lastSyncedAt.
        await cursorRef.set({
            outNames: Array.from(currentOutNames),
            lastSyncedAt: FieldValue.serverTimestamp(),
        });
        continue;
    }

    // 5. Cross-reference: who was clocked in at the transition time?
    //    Use "now" as the transition time. This isn't precise (the actual
    //    change happened sometime between lastSyncedAt and now), but if
    //    the script runs every 5 min, "now" is a good approximation
    //    AND captures whoever's still on the clock to verify.
    const transitionMoment = new Date();
    const activeEntries = await fetchActiveStaffAt(r.guid, transitionMoment);
    const employeeNames = await fetchEmployeeNames(r.guid);
    const clockedInNames = activeEntries
        .map(e => employeeNames.get(e.employeeReference?.guid))
        .filter(Boolean);
    console.log(`  • ${clockedInNames.length} staff clocked in at transition: ${clockedInNames.join(', ') || '(none)'}`);

    // 6. Build the attribution patches.
    //    We don't try to guess BOH-vs-FOH here — that needs job-title
    //    lookup which adds another API call. Better: write ALL clocked-in
    //    names and let the manager filter by sight. Future improvement
    //    could narrow by jobReference → job title → BOH heuristic.
    const eightySixRef = db.collection('ops').doc(`86_${r.location}`);
    const patch = {};
    for (const itemName of newlyOut) {
        patch[`attribution.${itemName}.outBy`] = clockedInNames;
        patch[`attribution.${itemName}.outAt`] = FieldValue.serverTimestamp();
    }
    for (const itemName of newlyIn) {
        patch[`attribution.${itemName}.inBy`] = clockedInNames;
        patch[`attribution.${itemName}.inAt`] = FieldValue.serverTimestamp();
    }
    if (Object.keys(patch).length > 0) {
        try {
            await eightySixRef.update(patch);
        } catch (e) {
            // Doc may not exist yet (race with scraper) — set with merge.
            if (e.code === 5 /* NOT_FOUND */) {
                await eightySixRef.set({ attribution: {} }, { merge: true });
                await eightySixRef.update(patch);
            } else { throw e; }
        }
        console.log(`  ✓ Wrote attribution for ${Object.keys(patch).length / 2} item(s)`);
    }

    // 7. Update the cursor.
    await cursorRef.set({
        outNames: Array.from(currentOutNames),
        lastSyncedAt: FieldValue.serverTimestamp(),
    });
}

console.log('\n✓ Done. Run me on a cron every 5-10 minutes to keep attribution fresh.');
process.exit(0);
