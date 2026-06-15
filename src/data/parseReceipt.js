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
export async function fileToScaledBase64(file, maxDim = 1600, quality = 0.82) {
    const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('read failed'));
        r.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('decode failed'));
        im.src = dataUrl;
    });
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxDim / Math.max(w, h || 1));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const jpeg = canvas.toDataURL('image/jpeg', quality);
    return { base64: (jpeg.split(',')[1] || ''), mediaType: 'image/jpeg' };
}

// Call the Cloud Function. Returns
//   { readable, problems[], vendor, date, lineItems:[{name,qty,price,pack}], count }
export async function parseReceiptImage({ imageBase64, mediaType }) {
    const res = await getCallable()({ imageBase64, mediaType });
    return res.data;
}
