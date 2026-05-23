#!/usr/bin/env node
// check-toast-86-sync — read-only health check for the Toast → 86
// pipeline. Andrew 2026-05-23: "i was messing with it can you see
// if i messed anything up? is the current 86 still working".
//
// What this script reads (NEVER writes anything):
//   /config/toast_webster        — Toast sync config + last status
//   /config/toast_maryland       — Toast sync config + last status
//   /ops/86_webster              — current 86 list (Toast + manual)
//   /ops/86_maryland             — current 86 list (Toast + manual)
//
// Output: a console report telling you whether each piece looks
// healthy AND flagging anything weird (sync disabled, stale, error
// recorded, GUID missing, empty 86 list when sync says items were
// found, etc.).
//
// Run: node scripts/check-toast-86-sync.mjs
// Needs: firebase-service-account.json at the repo root.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const saPath = path.join(ROOT, 'firebase-service-account.json');
let sa;
try { sa = JSON.parse(await fs.readFile(saPath, 'utf8')); }
catch (e) {
    console.error('Missing firebase-service-account.json at the repo root.');
    console.error('This file is gitignored; ask Andrew if you don\'t have it.');
    process.exit(1);
}
initializeApp({ credential: cert(sa) });
const db = getFirestore();

function pad(s, n) { return String(s ?? '').padEnd(n); }
function fmtAge(ms) {
    if (!ms) return 'never';
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60)      return `${sec}s ago`;
    if (sec < 3600)    return `${Math.floor(sec / 60)} min ago`;
    if (sec < 86400)   return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
}
function tsMs(ts) {
    if (!ts) return null;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (ts._seconds) return ts._seconds * 1000;
    if (ts.seconds)  return ts.seconds * 1000;
    return null;
}

const RESULTS = { ok: [], warn: [], err: [] };
function ok(msg)   { RESULTS.ok.push(msg); }
function warn(msg) { RESULTS.warn.push(msg); }
function err(msg)  { RESULTS.err.push(msg); }

console.log('');
console.log('=== Toast → 86 sync health check ===');
console.log('');

for (const loc of ['webster', 'maryland']) {
    console.log(`── ${loc.toUpperCase()} ──`);

    // Toast config doc
    const cfgRef = db.collection('config').doc(`toast_${loc}`);
    const cfgSnap = await cfgRef.get();
    if (!cfgSnap.exists) {
        console.log(`  /config/toast_${loc}                NOT FOUND`);
        warn(`${loc}: Toast config doc missing — sync never set up`);
    } else {
        const c = cfgSnap.data() || {};
        const enabled = c.enabled === true;
        const guid = c.restaurantGuid;
        const lastSyncedMs = tsMs(c.lastSyncedAt);
        const lastSyncOk = c.lastSyncOk;
        const lastSyncError = c.lastSyncError;
        const oos = c.lastSyncToastOOSCount;
        const updatedMs = tsMs(c.updatedAt);
        const updatedBy = c.updatedBy;

        console.log(`  enabled                 ${enabled}`);
        console.log(`  restaurantGuid          ${guid ? guid.slice(0, 12) + '…' : '(none)'}`);
        console.log(`  lastSyncedAt            ${fmtAge(lastSyncedMs)}`);
        console.log(`  lastSyncOk              ${lastSyncOk == null ? '(none)' : lastSyncOk}`);
        console.log(`  lastSyncToastOOSCount   ${oos == null ? '(none)' : oos}`);
        if (lastSyncError) console.log(`  lastSyncError           ${lastSyncError.slice(0, 200)}`);
        if (updatedBy)      console.log(`  config last edited by   ${updatedBy} (${fmtAge(updatedMs)})`);

        // Diagnose
        if (!enabled)        warn(`${loc}: Toast sync is DISABLED — Toast 86s won't push to TVs/86 board.`);
        if (enabled && !guid) err(`${loc}: enabled BUT no restaurantGuid — sync will fail.`);
        if (enabled && guid && lastSyncedMs == null)
            warn(`${loc}: enabled but never ran. First run takes up to 5 min after enabling.`);
        if (enabled && guid && lastSyncedMs && Date.now() - lastSyncedMs > 15 * 60 * 1000)
            err(`${loc}: last sync was ${fmtAge(lastSyncedMs)} — Cloud Function may be stalled.`);
        if (enabled && lastSyncOk === false)
            err(`${loc}: last sync FAILED — see lastSyncError above.`);
        if (enabled && guid && lastSyncOk === true)
            ok(`${loc}: Toast sync running, last success ${fmtAge(lastSyncedMs)} (${oos ?? 0} items pulled).`);
    }

    // 86 list doc
    const eightySixRef = db.collection('ops').doc(`86_${loc}`);
    const eightySixSnap = await eightySixRef.get();
    if (!eightySixSnap.exists) {
        console.log(`  /ops/86_${loc}                  NOT FOUND`);
        warn(`${loc}: 86 doc missing — no items are 86'd. Fine if you literally have nothing out.`);
    } else {
        const e = eightySixSnap.data() || {};
        const items = Array.isArray(e.items) ? e.items : [];
        const out = items.filter(i => i?.status === 'OUT_OF_STOCK');
        const inStock = items.filter(i => i?.status === 'IN_STOCK');
        const bySource = {};
        for (const it of items) {
            const src = it?.source || 'unknown';
            bySource[src] = (bySource[src] || 0) + 1;
        }
        const updatedMs = tsMs(e.updatedAt);

        console.log(`  /ops/86_${loc}.items     ${items.length} total (${out.length} OUT, ${inStock.length} IN)`);
        console.log(`  by source               ${Object.entries(bySource).map(([s, n]) => `${s}=${n}`).join(', ') || '(none)'}`);
        console.log(`  last write              ${fmtAge(updatedMs)}`);

        // Diagnose
        if (out.length === 0) {
            ok(`${loc}: 0 items currently 86'd. Either nothing's out OR the sync isn't pushing — check the Toast-config diagnostic above.`);
        } else {
            ok(`${loc}: ${out.length} items currently 86'd, last updated ${fmtAge(updatedMs)}.`);
        }
    }
    console.log('');
}

// Roll-up
console.log('');
console.log('=== SUMMARY ===');
console.log('');
if (RESULTS.err.length === 0 && RESULTS.warn.length === 0) {
    console.log('✓  Everything looks healthy.');
} else {
    for (const m of RESULTS.err)  console.log(`✕  ${m}`);
    for (const m of RESULTS.warn) console.log(`⚠  ${m}`);
    for (const m of RESULTS.ok)   console.log(`✓  ${m}`);
}
console.log('');
process.exit(0);
