#!/usr/bin/env node
// backup-firestore.mjs
// Dumps every Firestore collection (and one level of subcollections) to a
// timestamped JSON file in /backups. Local, offline copy of the live data —
// the "site got locked out, I have the file" insurance backup.
//
// Setup (one-time):
//   1. Firebase Console → Project Settings → Service Accounts
//   2. Click "Generate new private key" → downloads a .json file
//   3. Save it as `firebase-service-account.json` at the repo root
//      (gitignored — it's a credential, NEVER commit it)
//   4. From the repo root, install the admin SDK once:
//        npm install
//   5. Then run:
//        npm run backup
//
// Output: backups/firestore-YYYY-MM-DD-HHMMSS.json (gitignored).
//
// Re-run anytime you want a fresh snapshot. Old backups stay in /backups —
// rotate / archive them yourself if disk space matters.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

// ── Locate service account key ───────────────────────────────────────────
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
    console.error('');
    console.error('Looked in:');
    for (const p of KEY_CANDIDATES) console.error(`   - ${p}`);
    console.error('');
    console.error('Fix: download the key from Firebase Console:');
    console.error('   Project Settings → Service Accounts → Generate new private key');
    console.error('Save it as `firebase-service-account.json` at the repo root.');
    console.error('');
    process.exit(1);
}

console.log(`→ Using service account: ${path.relative(repoRoot, keyPath)}`);

// ── Init Admin SDK ───────────────────────────────────────────────────────
const serviceAccount = JSON.parse(await fs.readFile(keyPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Helper: serialize Firestore values to plain JSON ─────────────────────
// Timestamps → ISO string (with marker so a future restore script can
// distinguish original Timestamps from accidental ISO-string fields).
// GeoPoints, DocumentReferences, Bytes → string representations.
function serializeValue(v) {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map(serializeValue);
    if (typeof v === 'object') {
        // Firestore Timestamp
        if (typeof v.toDate === 'function' && typeof v._seconds === 'number') {
            return { __ts: v.toDate().toISOString() };
        }
        // GeoPoint
        if (typeof v.latitude === 'number' && typeof v.longitude === 'number' && Object.keys(v).length === 2) {
            return { __geo: [v.latitude, v.longitude] };
        }
        // DocumentReference
        if (typeof v.path === 'string' && typeof v.firestore === 'object') {
            return { __ref: v.path };
        }
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = serializeValue(val);
        return out;
    }
    return v;
}

// ── Recursive collection dumper ──────────────────────────────────────────
// Walks one level of subcollections per doc — that's enough for the DD Mau
// schema (no deep nesting). If a future feature adds deeper subcollections,
// bump the depth.
async function dumpCollection(colRef, depth = 0, maxDepth = 3) {
    const snap = await colRef.get();
    const docs = [];
    for (const doc of snap.docs) {
        const docOut = {
            id: doc.id,
            data: serializeValue(doc.data()),
        };
        if (depth < maxDepth) {
            const subs = await doc.ref.listCollections();
            if (subs.length > 0) {
                docOut.subcollections = {};
                for (const sub of subs) {
                    docOut.subcollections[sub.id] = await dumpCollection(sub, depth + 1, maxDepth);
                }
            }
        }
        docs.push(docOut);
    }
    return docs;
}

// ── Run the export ───────────────────────────────────────────────────────
console.log('→ Listing top-level collections…');
const topLevel = await db.listCollections();
console.log(`✓ Found ${topLevel.length} collections`);

const snapshot = {
    exportedAt: new Date().toISOString(),
    projectId: serviceAccount.project_id,
    collections: {},
};

let totalDocs = 0;
for (const col of topLevel) {
    process.stdout.write(`→ Exporting ${col.id}… `);
    const docs = await dumpCollection(col);
    snapshot.collections[col.id] = docs;
    totalDocs += docs.length;
    console.log(`${docs.length} doc(s)`);
}

// ── Write to disk ────────────────────────────────────────────────────────
await fs.mkdir(path.join(repoRoot, 'backups'), { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
const outPath = path.join(repoRoot, 'backups', `firestore-${ts}.json`);
await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2), 'utf8');

const stat = await fs.stat(outPath);
const sizeKB = (stat.size / 1024).toFixed(1);
const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

console.log('');
console.log(`✓ Backed up ${totalDocs} document(s) across ${topLevel.length} collection(s)`);
console.log(`✓ Wrote ${sizeKB > 1024 ? sizeMB + ' MB' : sizeKB + ' KB'} to ${path.relative(repoRoot, outPath)}`);
console.log('');
console.log('Backups folder is gitignored. Move these files anywhere you');
console.log("want long-term storage (Dropbox, Google Drive, external drive).");
