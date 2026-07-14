#!/usr/bin/env node
// ddmau-nas-restore.mjs
// ─────────────────────────────────────────────────────────────────────────
// DISASTER RECOVERY. Re-imports a backup produced by ddmau-nas-backup.mjs
// back into a Firebase project (Firestore + Storage). Off by default: it
// prints what it WOULD do unless you pass --confirm, and it refuses to write
// to a project whose id doesn't match --project.
//
// Usage:
//   # dry run (default) — shows counts, writes nothing:
//   node ddmau-nas-restore.mjs --project dd-mau-staff-app
//   # for real:
//   node ddmau-nas-restore.mjs --project dd-mau-staff-app --confirm
//   # scope it:
//   ... --only firestore            (or --only storage)
//   ... --collections staff,config,health_records
//
// ENV: BACKUP_ROOT (default /cloud/backups/firebase), GOOGLE_APPLICATION_CREDENTIALS
//      or a key at ./firebase-service-account.json.
// ⚠  Restoring OVERWRITES documents/objects of the same id/path in the target.
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp, GeoPoint } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const BACKUP_ROOT = process.env.BACKUP_ROOT || '/cloud/backups/firebase';
const CONFIRM = flag('--confirm');
const ONLY = val('--only');                    // 'firestore' | 'storage' | null(both)
const WANT_PROJECT = val('--project');
const ONLY_COLS = (val('--collections') || '').split(',').map((s) => s.trim()).filter(Boolean);

function log(...a) { console.log(...a); }

const KEY_CANDIDATES = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    path.join(BACKUP_ROOT, 'firebase-service-account.json'),
    path.join(__dirname, 'firebase-service-account.json'),
    '/etc/ddmau/firebase-service-account.json',
].filter(Boolean);
let keyPath = null;
for (const p of KEY_CANDIDATES) { try { fs.accessSync(p); keyPath = p; break; } catch {} }
if (!keyPath) { console.error('FATAL: no service-account key found.'); process.exit(1); }
const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));

if (!WANT_PROJECT) { console.error('Refusing to run without --project <id> (safety).'); process.exit(1); }
if (sa.project_id !== WANT_PROJECT) {
    console.error(`Refusing: key is for '${sa.project_id}' but --project is '${WANT_PROJECT}'.`);
    process.exit(1);
}
const bucketName = process.env.STORAGE_BUCKET || `${sa.project_id}.firebasestorage.app`;
initializeApp({ credential: cert(sa), storageBucket: bucketName });

log(`RESTORE target project: ${sa.project_id}`);
log(`source: ${BACKUP_ROOT}`);
log(CONFIRM ? '*** --confirm set: WILL WRITE to the target ***' : '(dry run — no writes; pass --confirm to apply)');

// ── decode the backup markers back into Firestore native types ────────────
function deserialize(v) {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map(deserialize);
    if (typeof v === 'object') {
        if (v.__ts) return new Timestamp(v.__ts.seconds, v.__ts.nanoseconds || 0);
        if (v.__geo) return new GeoPoint(v.__geo[0], v.__geo[1]);
        if (v.__bytes) return Buffer.from(v.__bytes, 'base64');
        if (v.__ref) return getFirestore().doc(v.__ref);
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = deserialize(val);
        return out;
    }
    return v;
}

async function restoreFirestore() {
    const db = getFirestore();
    const dir = path.join(BACKUP_ROOT, 'firestore');
    let entries;
    try { entries = (await fsp.readdir(dir)).filter((f) => f.endsWith('.ndjson')); }
    catch { log('no firestore/ dir in backup — skipping'); return; }

    for (const file of entries) {
        const col = file.replace(/\.ndjson$/, '');
        if (ONLY_COLS.length && !ONLY_COLS.includes(col)) continue;
        const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, file)), crlfDelay: Infinity });
        let batch = db.batch(), inBatch = 0, total = 0;
        for await (const line of rl) {
            if (!line.trim()) continue;
            const { id, data } = JSON.parse(line);
            total++;
            if (CONFIRM) {
                batch.set(db.collection(col).doc(id), deserialize(data));
                if (++inBatch >= 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
            }
        }
        if (CONFIRM && inBatch) await batch.commit();
        log(`  ${col}: ${CONFIRM ? 'restored' : 'would restore'} ${total} docs`);
    }
}

async function restoreStorage() {
    const bucket = getStorage().bucket();
    const dir = path.join(BACKUP_ROOT, 'storage');
    let manifest;
    try { manifest = await fsp.readFile(path.join(dir, '_manifest.ndjson'), 'utf8'); }
    catch { log('no storage/_manifest.ndjson — skipping'); return; }
    const items = manifest.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let n = 0;
    for (const it of items) {
        const local = path.join(dir, it.name);
        try { await fsp.access(local); } catch { log(`  ✗ missing local file ${it.name}`); continue; }
        if (CONFIRM) await bucket.upload(local, { destination: it.name, metadata: { contentType: it.contentType || undefined } });
        n++;
    }
    log(`  storage: ${CONFIRM ? 'uploaded' : 'would upload'} ${n} objects`);
}

(async () => {
    if (ONLY !== 'storage') await restoreFirestore();
    if (ONLY !== 'firestore') await restoreStorage();
    log(CONFIRM ? 'RESTORE COMPLETE.' : 'Dry run complete. Re-run with --confirm to apply.');
    process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
