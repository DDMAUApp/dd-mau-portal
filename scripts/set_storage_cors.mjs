// Apply cors.json to the Firebase Storage bucket via the Admin SDK.
// (No gsutil/gcloud on this machine; the Admin SDK bucket is a
//  @google-cloud/storage Bucket, which exposes setCorsConfiguration.)
//
//   node scripts/set_storage_cors.mjs
//
// Needed because the in-app Picture Editor bakes edits onto a <canvas>
// and calls toBlob() — that requires the source image to load with CORS.
// The Capacitor native app's webview origin (capacitor://localhost on iOS,
// https://localhost on Android) must be in the bucket CORS allowlist or the
// bake throws and "Save picture" fails. This applies on the SERVER, so it
// fixes already-installed apps with no rebuild.
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const sa = JSON.parse(readFileSync('./firebase-service-account.json'));
const cors = JSON.parse(readFileSync('./cors.json'));

// Try the bucket name from firebase config first, then the legacy alias.
const CANDIDATES = ['dd-mau-staff-app.firebasestorage.app', 'dd-mau-staff-app.appspot.com'];

admin.initializeApp({ credential: admin.credential.cert(sa) });

let applied = false;
for (const name of CANDIDATES) {
    try {
        const bucket = admin.storage().bucket(name);
        const [exists] = await bucket.exists();
        if (!exists) { console.log(`· ${name} — not found, trying next`); continue; }
        await bucket.setCorsConfiguration(cors);
        const [meta] = await bucket.getMetadata();
        console.log(`✓ CORS applied to gs://${name}`);
        console.log(JSON.stringify(meta.cors, null, 2));
        applied = true;
        break;
    } catch (e) {
        console.warn(`· ${name} — ${e?.message || e}`);
    }
}
if (!applied) { console.error('✗ Could not apply CORS to any candidate bucket.'); process.exit(1); }
process.exit(0);
