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
// HOW IT INTEGRATES WITH THE 86 BOARD (2026-05-23 — updated):
// This script writes BOTH the items[] list AND the attribution sidecar
// on /ops/86_{location}:
//
//   items: [
//     {
//       name: 'Avocado',
//       status: 'OUT_OF_STOCK',
//       source: 'toast',          // distinguishes from manual entries
//       addedBy: 'Toast POS',     // overwritten via attribution below
//       addedAt: '2026-05-23T…',
//     },
//     ...
//     // Manual entries (source != 'toast') are NEVER touched here.
//   ],
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
// Why ONE script does both: the syncToastMenuStatus Cloud Function used
// to write items[] but was a buggy duplicate of the Toast Connect API
// path AND it 401'd in production. Deleted 2026-05-23. To avoid leaving
// items[] dangling with no writer, we folded that responsibility into
// this script. One source of truth for Toast → /ops/86_*.
//
// Eighty6Dashboard reads attribution[item.name] FIRST and falls back to
// item.addedBy/item.addedAt — so on the first run the dashboard shows
// "Marked by Toast POS · at <time>", and as transitions get attributed
// (subsequent runs), the dashboard shows real clocked-in staff names.
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
// Three code paths so this script runs both locally AND in a Railway/cron
// host that can't ship a JSON file at the repo root:
//   1. FIREBASE_SERVICE_ACCOUNT_BASE64 env var — preferred for hosted cron.
//      `cat firebase-service-account.json | base64` gives a single-line
//      blob that survives every textarea/env-var quirk. Decode + JSON.parse.
//   2. FIREBASE_SERVICE_ACCOUNT_JSON env var — paste the raw JSON. Works
//      if the host preserves the file exactly (escaped \n inside private_key).
//      Some hosts mangle multi-line strings, which is why base64 is preferred.
//   3. File on disk — used locally (firebase-service-account.json at repo
//      root, gitignored) or via GOOGLE_APPLICATION_CREDENTIALS pointing at
//      a mounted secret file.
let serviceAccount = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    try {
        const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
        serviceAccount = JSON.parse(decoded);
    } catch (e) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT_BASE64 is set but failed to decode + parse.');
        console.error('   Generate with: cat firebase-service-account.json | base64');
        console.error('   (one line, no extra quotes or whitespace)');
        process.exit(1);
    }
}
if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
        console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON is set but not valid JSON.');
        console.error('   Hint: in Railway, paste the entire JSON contents (no extra quotes).');
        console.error('   Or use the BASE64 variant — set FIREBASE_SERVICE_ACCOUNT_BASE64 instead.');
        process.exit(1);
    }
}
if (!serviceAccount) {
    const KEY_CANDIDATES = [
        path.join(repoRoot, 'firebase-service-account.json'),
        path.join(repoRoot, 'serviceAccountKey.json'),
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
    ].filter(Boolean);
    let keyPath = null;
    for (const p of KEY_CANDIDATES) { try { await fs.access(p); keyPath = p; break; } catch {} }
    if (!keyPath) {
        console.error('❌ Could not find firebase-service-account.json at repo root');
        console.error('   AND FIREBASE_SERVICE_ACCOUNT_JSON env var is not set.');
        console.error('   Pick one path; see header comment for details.');
        process.exit(1);
    }
    serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
}
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
//
// Cached by `${restaurantGuid}:${businessDate}` so when we attribute
// 200 items that all share a few business dates, we only hit the
// Toast API once per date rather than 200 times.
const timeEntriesCache = new Map();
async function fetchTimeEntriesForDate(restaurantGuid, businessDate) {
    const cacheKey = `${restaurantGuid}:${businessDate}`;
    if (timeEntriesCache.has(cacheKey)) return timeEntriesCache.get(cacheKey);
    const r = await fetch(`${HOST}/labor/v1/timeEntries?businessDate=${businessDate}`, {
        headers: apiHeaders(restaurantGuid),
    });
    if (!r.ok) {
        console.warn(`⚠ /labor/v1/timeEntries failed (${r.status}) for ${businessDate}`);
        timeEntriesCache.set(cacheKey, []);
        return [];
    }
    const entries = await r.json();
    const list = Array.isArray(entries) ? entries : [];
    timeEntriesCache.set(cacheKey, list);
    return list;
}
async function fetchActiveStaffAt(restaurantGuid, momentDate) {
    const businessDate = momentDate.toISOString().slice(0, 10).replace(/-/g, '');
    const entries = await fetchTimeEntriesForDate(restaurantGuid, businessDate);
    const momentMs = momentDate.getTime();
    return entries.filter(e => {
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

    // 2026-05-26 — Andrew: "2 and 3 should be on the list but it need
    // to have the menu name not the id." The Railway scraper (and the
    // old code below) wrote raw Toast GUIDs to items[].name when it
    // couldn't resolve them. Two fixes now:
    //
    //   a. PERSIST the GUID→name map to /config/toast_menu_items so
    //      the Eighty6Dashboard can do live lookups for any GUID-named
    //      rows the Railway scraper drops in between our runs.
    //   b. REPAIR existing items[] on /ops/86_{loc} on every run: any
    //      row whose name matches a GUID and the menu map can resolve
    //      gets its name replaced inline with the resolved value. The
    //      guid sticks around in a sidecar field so future cross-refs
    //      still work.
    const GUID_RE_SYNC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    {
        // (a) Persist the map.
        const mapObj = Object.fromEntries(itemNames);
        await db.collection('config').doc('toast_menu_items').set({
            map: mapObj,
            entries: Object.keys(mapObj).length,
            updatedAt: FieldValue.serverTimestamp(),
            updatedFromRestaurant: r.guid,
            location: r.location,
        }, { merge: true });
        console.log(`  • Wrote /config/toast_menu_items (${Object.keys(mapObj).length} entries)`);

        // (b) Repair any GUID-named rows in the live 86 doc.
        const repairSnap = await eightySixRef.get();
        const existing = repairSnap.exists ? ((repairSnap.data() || {}).items || []) : [];
        let repairedCount = 0;
        const repaired = existing.map((it) => {
            if (!it?.name || !GUID_RE_SYNC.test(String(it.name))) return it;
            const resolved = itemNames.get(it.name);
            if (!resolved || GUID_RE_SYNC.test(resolved)) return it;  // still unknown — leave alone
            repairedCount++;
            return { ...it, name: resolved, guid: it.guid || it.name };
        });
        if (repairedCount > 0) {
            await eightySixRef.set(
                { items: repaired, updatedAt: FieldValue.serverTimestamp() },
                { merge: true },
            );
            console.log(`  ✓ Repaired ${repairedCount} GUID-named row(s) using menu map`);
        }
    }

    // 2. Resolve current OUT_OF_STOCK set as human names + capture each
    //    item's lastUpdated timestamp so we can attribute "who was clocked
    //    in when this item went 86." Toast's stock API field name has
    //    varied across versions (lastUpdated, modifiedDate, updatedAt) —
    //    we try all of them and fall back to "now" if none are present.
    //
    // 2026-05-26: when an item has NO menu mapping at all, SKIP it
    // instead of writing the bare GUID as its name. Better an item
    // silently miss this cycle than show up as "🚫 86: d77ac06e..."
    // for the team. Next run resolves it once the Toast menu API
    // catches up.
    const currentOutNames = new Set();
    const currentOutMetaByName = new Map();
    let skippedUnresolvable = 0;
    for (const inv of (Array.isArray(inventory) ? inventory : [])) {
        if (inv?.status !== 'OUT_OF_STOCK') continue;
        const resolved = itemNames.get(inv.guid);
        if (!resolved || GUID_RE_SYNC.test(resolved)) {
            skippedUnresolvable += 1;
            continue;
        }
        const name = resolved;
        currentOutNames.add(name);
        const lastUpdatedIso = inv.lastUpdated || inv.modifiedDate
            || inv.updatedAt || inv.lastModifiedDate || null;
        currentOutMetaByName.set(name, {
            guid: inv.guid,
            lastUpdatedIso,                                  // may be null
            lastUpdatedDate: lastUpdatedIso ? new Date(lastUpdatedIso) : null,
        });
    }
    if (skippedUnresolvable > 0) {
        console.warn(`  ⚠ skipped ${skippedUnresolvable} Toast 86 item(s) with no menu name (will retry next run)`);
    }
    console.log(`  • Currently 86'd: ${currentOutNames.size} item(s)`);

    // Helper: look up clocked-in staff at a given moment (uses caches).
    // Returns array of full names (may be empty). Falls back gracefully
    // if labor APIs are unavailable.
    async function attributedNamesAt(moment) {
        if (!moment) return [];
        try {
            const active = await fetchActiveStaffAt(r.guid, moment);
            const empNames = await fetchEmployeeNames(r.guid);
            return active
                .map(e => empNames.get(e.employeeReference?.guid))
                .filter(Boolean);
        } catch (e) {
            console.warn(`  ⚠ attribution lookup failed: ${e?.message || e}`);
            return [];
        }
    }

    // 2.5 — TRANSITION-ONLY sync. Andrew 2026-05-23:
    //   - The 86 board should reflect "what just got 86'd today" — NOT
    //     a mirror of Toast's permanent OOS list (which buried the
    //     dashboard with 155+51 items in the original bulk-sync version).
    //   - Manual chat 86s remain authoritative for items Toast doesn't
    //     track.
    //   - When Toast DOES transition an item (newly out, or back in stock)
    //     we push that ONE item to items[] — see step 6 below for the
    //     transition-handling block.
    //
    // The eightySixRef variable is declared here so both this section
    // (which preserves manual items) and step 6 (which appends/removes
    // toast transitions) can use it.
    //
    // Initial wipe pass: drop any Toast-sourced items that aren't in
    // Toast's current OOS list (item came back in stock between runs).
    // This handles the "back in stock" half of transitions without
    // needing the cursor — same idempotent name-based dedup, no extra
    // notification storm (realtime86 trigger diffs by name only).
    const eightySixRef = db.collection('ops').doc(`86_${r.location}`);
    {
        const snap = await eightySixRef.get();
        const data = snap.exists ? (snap.data() || {}) : {};
        const existingItems = Array.isArray(data.items) ? data.items : [];
        const kept = existingItems.filter(it => {
            if (it?.source === 'toast') {
                return it?.name && currentOutNames.has(String(it.name));
            }
            return true;  // manual / legacy entries — always preserved
        });
        const removed = existingItems.length - kept.length;
        if (removed > 0) {
            await eightySixRef.set({
                items: kept,
                updatedAt: FieldValue.serverTimestamp(),
                lastToastSyncAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            console.log(`  • Removed ${removed} stale Toast item(s) from items[]`);
        }
    }

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

    // 6. Apply transitions: update items[] AND write the time-only
    //    attribution sidecar.
    //
    // Andrew 2026-05-26: "the only place we put items on the 86 report
    // is toast. and it would pull the name no problem. we wanted to
    // have the name and time it was put into 86." The previous version
    // also tried to attribute each transition to "whoever was clocked
    // in at that moment", which produced the "Marked by 20 staff"
    // dump in the dashboard — Toast genuinely doesn't know which
    // specific cook caused the 86, so any attribution was a guess.
    // Dropped: addedBy on items[], outBy/inBy on the attribution map.
    // Kept: addedAt on items[], outAt/inAt on attribution (the time
    // is real and useful).
    {
        const snap = await eightySixRef.get();
        const data = snap.exists ? (snap.data() || {}) : {};
        const existingItems = Array.isArray(data.items) ? data.items : [];
        // Drop newlyIn items from items[].
        const newlyInLower = new Set(newlyIn.map(n => String(n).toLowerCase()));
        const next = existingItems.filter(it => {
            if (it?.source !== 'toast') return true;  // manual untouched
            return it?.name && !newlyInLower.has(String(it.name).toLowerCase());
        });
        // Append newlyOut items (dedup by name).
        const presentLower = new Set(next.map(i => String(i?.name || '').toLowerCase()));
        const nowIso = new Date().toISOString();
        for (const name of newlyOut) {
            if (presentLower.has(String(name).toLowerCase())) continue;
            const meta = currentOutMetaByName.get(name) || {};
            next.push({
                name,
                status: 'OUT_OF_STOCK',
                source: 'toast',
                // No addedBy — Toast doesn't know which staff 86'd it.
                // The dashboard now shows "Out since {time}" for
                // source=toast and doesn't display a "Marked by" line.
                addedAt: meta.lastUpdatedIso || nowIso,
            });
        }
        // Write items[] + attribution sidecar in one set (avoid double
        // realtime86 trigger fires from separate writes).
        const patch = {
            items: next,
            updatedAt: FieldValue.serverTimestamp(),
            lastToastSyncAt: FieldValue.serverTimestamp(),
        };
        // Attribution sidecar — kept for the time only. set(merge:true)
        // does NOT interpret dotted field names as paths (a key like
        // `attribution.Avocado.outAt` would write a literal flat field
        // named that), so we build the nested shape explicitly.
        const attribution = {};
        for (const itemName of newlyOut) {
            attribution[itemName] = {
                ...(attribution[itemName] || {}),
                outAt: FieldValue.serverTimestamp(),
            };
        }
        for (const itemName of newlyIn) {
            attribution[itemName] = {
                ...(attribution[itemName] || {}),
                inAt: FieldValue.serverTimestamp(),
            };
        }
        if (Object.keys(attribution).length > 0) patch.attribution = attribution;
        await eightySixRef.set(patch, { merge: true });
        console.log(`  ✓ Applied ${newlyOut.length} out + ${newlyIn.length} back-in (time-only attribution)`);
    }

    // 7. Update the cursor.
    await cursorRef.set({
        outNames: Array.from(currentOutNames),
        lastSyncedAt: FieldValue.serverTimestamp(),
    });
}

console.log('\n✓ Done. Run me on a cron every 5-10 minutes to keep attribution fresh.');
process.exit(0);
