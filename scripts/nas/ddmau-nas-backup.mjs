#!/usr/bin/env node
// ddmau-nas-backup.mjs
// ─────────────────────────────────────────────────────────────────────────
// Pull-model backup of the DD Mau Firebase project (Firestore + Storage)
// onto the home NAS (ddmau-nas, OpenMediaVault). Designed to run nightly
// via cron and then be mirrored to the USB backup drive by the existing
// /usr/local/sbin/ddmau-backup.sh rsync job.
//
// vs. scripts/backup-firestore.mjs (the Mac, one-shot, monolithic-JSON tool):
//   • STREAMS every collection (never loads a 66k-doc collection into RAM)
//   • writes ONE FILE PER COLLECTION (rsync only moves changed collections)
//   • writes to a STABLE path (no timestamp in the name) so the USB rsync's
//     --backup-dir history captures deltas — no duplicate-snapshot bloat here
//   • also mirrors Firebase STORAGE files (incremental: size+md5 skip)
//   • has a matching restore script: ddmau-nas-restore.mjs
//
// ENV:
//   BACKUP_ROOT           output dir            (default /cloud/backups/firebase)
//   GOOGLE_APPLICATION_CREDENTIALS  or a key at ./firebase-service-account.json
//   STORAGE_BUCKET        override bucket       (default <project>.firebasestorage.app)
//   SKIP_FIRESTORE=1      Storage only
//   SKIP_STORAGE=1        Firestore only
//   MAX_STORAGE_FILES=N   cap download count    (testing only)
//   STORAGE_CONCURRENCY=N parallel downloads    (default 6)
//   DUMP_SUBCOLLECTIONS=1 recurse subcollections (off; DD Mau schema is flat)
//
// Exit codes: 0 ok, 1 fatal (bad creds / write failure). Per-item errors are
// logged and counted but do not abort the whole run.
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BACKUP_ROOT = process.env.BACKUP_ROOT || '/cloud/backups/firebase';
const MAX_STORAGE_FILES = Number(process.env.MAX_STORAGE_FILES || 0) || 0;
const STORAGE_CONCURRENCY = Number(process.env.STORAGE_CONCURRENCY || 6) || 6;
const DUMP_SUBCOLLECTIONS = process.env.DUMP_SUBCOLLECTIONS === '1';

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function fmtMB(b) { return (b / 1e6).toFixed(1) + ' MB'; }

// ── Locate + load the service-account key ────────────────────────────────
const KEY_CANDIDATES = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    path.join(BACKUP_ROOT, 'firebase-service-account.json'),
    path.join(__dirname, 'firebase-service-account.json'),
    '/etc/ddmau/firebase-service-account.json',
].filter(Boolean);

let keyPath = null;
for (const p of KEY_CANDIDATES) { try { fs.accessSync(p); keyPath = p; break; } catch {} }
if (!keyPath) {
    console.error('FATAL: no service-account key found. Looked in:\n  ' + KEY_CANDIDATES.join('\n  '));
    process.exit(1);
}
const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const projectId = sa.project_id;
const bucketName = process.env.STORAGE_BUCKET || `${projectId}.firebasestorage.app`;
log(`key: ${keyPath}`);
log(`project: ${projectId}  bucket: ${bucketName}`);
log(`output: ${BACKUP_ROOT}`);

initializeApp({ credential: cert(sa), storageBucket: bucketName });

// ── Firestore value serialization (round-trippable by the restore script) ─
function serializeValue(v) {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map(serializeValue);
    if (Buffer.isBuffer(v)) return { __bytes: v.toString('base64') };
    if (typeof v === 'object') {
        if (typeof v.toDate === 'function' && typeof v._seconds === 'number') {
            return { __ts: { seconds: v._seconds, nanoseconds: v._nanoseconds || 0 } };
        }
        if (typeof v.latitude === 'number' && typeof v.longitude === 'number' && Object.keys(v).length === 2) {
            return { __geo: [v.latitude, v.longitude] };
        }
        if (typeof v.path === 'string' && v.firestore) return { __ref: v.path };
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = serializeValue(val);
        return out;
    }
    return v;
}

// atomic write: write temp then rename
async function atomicWrite(dest, buf) {
    const tmp = dest + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, dest);
}

// ── Firestore: stream each collection to <root>/firestore/<col>.ndjson ────
async function backupFirestore() {
    const db = getFirestore();
    const outDir = path.join(BACKUP_ROOT, 'firestore');
    await fsp.mkdir(outDir, { recursive: true });

    const cols = await db.listCollections();
    log(`firestore: ${cols.length} top-level collections`);
    const manifest = { exportedAt: new Date().toISOString(), projectId, collections: {} };
    let grandDocs = 0, hadError = 0;

    for (const col of cols) {
        const dest = path.join(outDir, `${col.id}.ndjson`);
        const tmp = dest + '.tmp-' + process.pid;
        const ws = fs.createWriteStream(tmp, { encoding: 'utf8' });
        let n = 0;
        try {
            await new Promise((resolve, reject) => {
                const stream = col.stream();
                stream.on('data', (doc) => {
                    // note: subcollection recursion (rare in this schema) is intentionally
                    // omitted from the stream path; enable DUMP_SUBCOLLECTIONS for the slow path.
                    const line = JSON.stringify({ id: doc.id, data: serializeValue(doc.data()) });
                    if (!ws.write(line + '\n')) { stream.pause(); ws.once('drain', () => stream.resume()); }
                    n++;
                });
                stream.on('end', resolve);
                stream.on('error', reject);
            });
            await new Promise((res) => ws.end(res));
            await fsp.rename(tmp, dest);
            manifest.collections[col.id] = n;
            grandDocs += n;
            log(`  ${col.id}: ${n} docs`);
        } catch (e) {
            hadError++;
            try { ws.destroy(); await fsp.unlink(tmp); } catch {}
            log(`  ✗ ${col.id}: ${e.message} (kept previous file)`);
        }
    }

    if (DUMP_SUBCOLLECTIONS) log('note: DUMP_SUBCOLLECTIONS=1 requested but stream path is flat-only; deep subcollections not captured.');
    await atomicWrite(path.join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2));
    log(`firestore done: ${grandDocs} docs, ${cols.length} collections, ${hadError} errored`);
    return { docs: grandDocs, collections: cols.length, errors: hadError };
}

// ── Storage: incremental mirror to <root>/storage/<objectPath> ────────────
async function backupStorage() {
    const bucket = getStorage().bucket();
    const [exists] = await bucket.exists();
    if (!exists) { log(`✗ storage: bucket ${bucketName} not found — skipping`); return { files: 0, downloaded: 0, bytes: 0, errors: 1 }; }

    const outDir = path.join(BACKUP_ROOT, 'storage');
    await fsp.mkdir(outDir, { recursive: true });

    log('storage: listing objects…');
    let [files] = await bucket.getFiles();
    files = files.filter((f) => !f.name.endsWith('/')); // skip folder placeholders
    if (MAX_STORAGE_FILES) files = files.slice(0, MAX_STORAGE_FILES);
    log(`storage: ${files.length} objects`);

    const meta = [];      // manifest lines
    let downloaded = 0, skipped = 0, bytes = 0, errors = 0;
    const seen = new Set();

    let idx = 0;
    async function worker() {
        while (idx < files.length) {
            const f = files[idx++];
            const rel = f.name;
            seen.add(rel);
            const localPath = path.join(outDir, rel);
            const size = Number(f.metadata.size || 0);
            const md5 = f.metadata.md5Hash || null;
            meta.push({ name: rel, size, md5, contentType: f.metadata.contentType || null, updated: f.metadata.updated || null });
            try {
                // skip if a local copy already matches size (+md5 when present)
                let need = true;
                try {
                    const st = await fsp.stat(localPath);
                    if (st.size === size) {
                        if (md5) {
                            const buf = await fsp.readFile(localPath);
                            const localMd5 = crypto.createHash('md5').update(buf).digest('base64');
                            need = localMd5 !== md5;
                        } else need = false;
                    }
                } catch {}
                if (!need) { skipped++; bytes += size; continue; }
                await fsp.mkdir(path.dirname(localPath), { recursive: true });
                await f.download({ destination: localPath });
                downloaded++; bytes += size;
            } catch (e) {
                errors++;
                log(`  ✗ ${rel}: ${e.message}`);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(STORAGE_CONCURRENCY, files.length) }, worker));

    // manifest (also used by restore to re-upload with correct contentType)
    await atomicWrite(path.join(outDir, '_manifest.ndjson'), meta.map((m) => JSON.stringify(m)).join('\n') + '\n');

    // report (do NOT delete) local files that are no longer in the bucket
    let orphans = 0;
    async function scan(dir) {
        for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
            if (ent.name.startsWith('_manifest')) continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) { await scan(full); continue; }
            const rel = path.relative(outDir, full);
            if (!seen.has(rel)) orphans++;
        }
    }
    if (!MAX_STORAGE_FILES) { try { await scan(outDir); } catch {} }

    log(`storage done: ${downloaded} downloaded, ${skipped} unchanged, ${errors} errored, ${orphans} local-only (kept), ${fmtMB(bytes)} total`);
    return { files: files.length, downloaded, skipped, bytes, errors, orphans };
}

// ── Run ──────────────────────────────────────────────────────────────────
(async () => {
    const t0 = Date.now();
    await fsp.mkdir(BACKUP_ROOT, { recursive: true });
    let fs_ = null, st_ = null;
    if (process.env.SKIP_FIRESTORE !== '1') fs_ = await backupFirestore();
    if (process.env.SKIP_STORAGE !== '1') st_ = await backupStorage();

    const summary = {
        finishedAt: new Date().toISOString(),
        seconds: Math.round((Date.now() - t0) / 1000),
        firestore: fs_, storage: st_,
    };
    await atomicWrite(path.join(BACKUP_ROOT, 'LAST_BACKUP.json'), JSON.stringify(summary, null, 2));
    log(`ALL DONE in ${summary.seconds}s`);

    const errored = (fs_?.errors || 0) + (st_?.errors || 0);
    process.exit(errored > 0 ? 2 : 0); // 2 = completed with per-item errors (cron still sees non-fatal)
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
