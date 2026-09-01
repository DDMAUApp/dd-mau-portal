// parseReceipt.js — client helper for the parseReceipt Cloud Function.
// Inventory pricing redesign Phase 2. Mirrors src/data/aiSearch.js (lazy
// getFunctions + httpsCallable). Plus a downscaler so phone photos go up
// small (the function caps at ~5MB and bigger just wastes tokens/time).
import { getFunctions, httpsCallable } from 'firebase/functions';

let _callable = null;
function getCallable() {
    if (!_callable) {
        const functions = getFunctions(undefined, 'us-central1');
        _callable = httpsCallable(functions, 'parseReceipt', { timeout: 120000 });
    }
    return _callable;
}

// Read an image File → downscale (longest side ≤ maxDim) → JPEG base64.
// Returns { base64, mediaType }.
//
// MEMORY-LEAN rewrite (2026-08-31, Andrew: "my last upload just crashed"):
// the old path held the photo THREE ways at once — the whole original as a
// FileReader base64 STRING, a full-resolution <img> decode (a 48MP iPhone
// shot decodes to ~190MB of RGBA), and the modal's full-res preview <img>
// on top. That spike could blow the WKWebView's memory limit and iOS
// killed the app mid-upload — an intermittent hard crash with no JS error.
// Now: createImageBitmap(file, { resizeWidth }) lets WebKit decode AND
// downsample natively, so neither the original base64 string nor a
// full-size bitmap ever enters the JS heap. Fallback for engines without
// resize support uses an object URL (still no giant string) and releases
// everything promptly.
// Shared native-downsample draw for both exports below (2026-09-01: the
// Health Department card upload needed the same memory-lean path — see
// fileToScaledBlob).
async function drawScaledCanvas(file, maxDim) {
    let w, h;
    const canvas = document.createElement('canvas');
    let drew = false;
    if (typeof createImageBitmap === 'function') {
        try {
            // Resize by width; aspect is preserved. Receipt photos are always
            // wider than maxDim so this never upscales in practice; a portrait
            // shot's height may exceed maxDim somewhat — harmless (still far
            // under the function's ~5MB cap).
            const bmp = await createImageBitmap(file, { resizeWidth: maxDim, resizeQuality: 'high' });
            // Some older WebKit builds IGNORE the resize options instead of
            // throwing — detect that (bitmap far wider than asked) and draw
            // it CAPPED onto the canvas rather than at full size, so a giant
            // photo can never ride through to the upload.
            if (bmp.width > maxDim * 1.02) {
                const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height || 1));
                w = Math.max(1, Math.round(bmp.width * scale));
                h = Math.max(1, Math.round(bmp.height * scale));
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
            } else {
                w = bmp.width; h = bmp.height;
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(bmp, 0, 0);
            }
            bmp.close();   // release the bitmap immediately — don't wait for GC
            drew = true;
        } catch { /* resize options unsupported — fall through to the img path */ }
    }
    if (!drew) {
        const objUrl = URL.createObjectURL(file);
        try {
            const img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('decode failed'));
                im.src = objUrl;
            });
            w = img.naturalWidth || img.width;
            h = img.naturalHeight || img.height;
            const scale = Math.min(1, maxDim / Math.max(w, h || 1));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            img.src = '';   // drop the decoded bitmap reference promptly
        } finally {
            URL.revokeObjectURL(objUrl);
        }
    }
    return canvas;
}

export async function fileToScaledBase64(file, maxDim = 1600, quality = 0.82) {
    const canvas = await drawScaledCanvas(file, maxDim);
    const jpeg = canvas.toDataURL('image/jpeg', quality);
    canvas.width = 0; canvas.height = 0;   // free the canvas backing store
    return { base64: (jpeg.split(',')[1] || ''), mediaType: 'image/jpeg' };
}

// Same downsample → a JPEG Blob, for flows that upload to Storage instead
// of inlining base64 (Health Department vaccine cards). A phone camera
// shot is 2-8MB; scaled to 2000px it's ~300KB — 10-20× less time and
// memory in the fragile just-came-back-from-the-camera window where iOS
// kills the WebView under pressure. Throws when the file isn't a
// decodable image (caller falls back to uploading the original).
export async function fileToScaledBlob(file, maxDim = 2000, quality = 0.85) {
    const canvas = await drawScaledCanvas(file, maxDim);
    const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob produced no data'))), 'image/jpeg', quality));
    canvas.width = 0; canvas.height = 0;   // free the canvas backing store
    return blob;
}

// Variant that also reports the scaled dimensions (chat attachments store
// width/height for layout). Dims are captured BEFORE the backing store is
// zeroed.
export async function fileToScaledBlobWithDims(file, maxDim = 1600, quality = 0.85) {
    const canvas = await drawScaledCanvas(file, maxDim);
    const width = canvas.width, height = canvas.height;
    const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob produced no data'))), 'image/jpeg', quality));
    canvas.width = 0; canvas.height = 0;   // free the canvas backing store
    return { blob, width, height };
}

// Call the Cloud Function. Returns
//   { readable, problems[], vendor, date, lineItems:[{name,qty,price,pack}], count }
export async function parseReceiptImage({ imageBase64, mediaType }) {
    const res = await getCallable()({ imageBase64, mediaType });
    return res.data;
}
