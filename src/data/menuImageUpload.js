// Menu-image upload helper — converts a user-picked file (PDF or
// JPEG/PNG) into one image per page, uploads them to Firebase
// Storage, and returns the public download URLs in order.
//
// Andrew 2026-05-20 — "if the menu comes in as pdf or jpeg how can
// you make edits". Used by:
//   • TvConfigsEditor — admin uploads a menu file to display
//     full-screen on a TV (mode='image').
//   • MenuImportModal — admin uploads a menu file for Claude to
//     extract structured data from (AI extraction flow).
//
// PDF rendering uses the same lazy-loaded pdfjs that the onboarding
// flow uses (already in the bundle, no new chunk). Each page is
// rendered to a canvas at ~150 DPI for sharp TV display.

import { storage } from '../firebase';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';

// Lazy pdfjs loader — same pattern as OnboardingFillablePdf.jsx
// so we share the chunk rather than splitting it.
async function loadPdfJs() {
    const pdfjs = await import('pdfjs-dist');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    }
    return pdfjs;
}

// Render a PDF File/Blob to an array of PNG Blobs, one per page.
// Scale=2 ≈ 144 DPI for an 8.5×11 PDF — crisp on 1080p TV.
export async function renderPdfPagesToBlobs(file, opts = {}) {
    const scale = opts.scale || 2;
    const maxPages = opts.maxPages || 12;   // safety cap; designer menus rarely exceed 2-4 pages
    const buf = await file.arrayBuffer();
    const pdfjs = await loadPdfJs();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    const blobs = [];
    const pageCount = Math.min(pdf.numPages, maxPages);
    for (let i = 1; i <= pageCount; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        // White background — PDFs are often transparent and would
        // render black on the TV's white chrome.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise((resolve) =>
            canvas.toBlob((b) => resolve(b), 'image/png', 0.92));
        if (blob) blobs.push(blob);
    }
    return blobs;
}

// Max width (in pixels) we'll let through to Firebase Storage for
// TV signage. 1920px covers 1080p TVs at native resolution; anything
// larger than this is paying Storage bytes + Pi-side decode time for
// pixels the TV can't display. Most modern phone cameras produce
// 4000-6000px images, so this is the common case.
const TV_MAX_IMAGE_WIDTH = 1920;
// JPEG quality used when re-encoding downsized images. 0.85 is the
// usual sweet spot — visually indistinguishable from the original
// at TV viewing distance, ~50% smaller bytes.
const TV_JPEG_QUALITY = 0.85;
// Minimum dimensions we expect for a "looks good on TV" upload.
// Smaller than this and the image will be visibly soft on a 1080p
// screen viewed from across the restaurant; we surface a warning
// to the caller but still allow the upload (the admin might
// genuinely WANT a small / pixelated retro look).
const TV_MIN_GOOD_WIDTH = 1280;

// Read an image File/Blob's intrinsic dimensions via the browser's
// own decoder. Resolves to { width, height }; rejects on decode
// failure. Used both for size-check warnings and as the first step
// of the optimization pass below.
async function getImageDimensions(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const out = { width: img.naturalWidth, height: img.naturalHeight };
            URL.revokeObjectURL(url);
            resolve(out);
        };
        img.onerror = (e) => {
            URL.revokeObjectURL(url);
            reject(new Error('image decode failed'));
        };
        img.src = url;
    });
}

// Resize an image File/Blob if its width is greater than maxWidth,
// re-encoding as JPEG. Returns the original file unchanged if it's
// already at or below maxWidth (avoids re-encoding a perfectly-sized
// image into a worse one). Resolves to { blob, width, height,
// optimized, original }.
//
// `optimized: true` means we ran the canvas re-encode path.
// `original.width / original.height` is always populated so callers
// can warn on small inputs even when no resize happened.
export async function optimizeImageForTv(file, opts = {}) {
    const maxWidth = opts.maxWidth || TV_MAX_IMAGE_WIDTH;
    const quality  = opts.quality  || TV_JPEG_QUALITY;
    try {
        const dim = await getImageDimensions(file);
        if (dim.width <= maxWidth) {
            return { blob: file, width: dim.width, height: dim.height, optimized: false, original: dim };
        }
        const scale = maxWidth / dim.width;
        const targetW = Math.round(dim.width * scale);
        const targetH = Math.round(dim.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width  = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        // White background — keeps transparent PNGs from rendering
        // black after JPEG re-encode (JPEG has no alpha channel).
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);
        // Decode + draw via Image so we don't have to depend on
        // createImageBitmap (mobile Safari support is patchy).
        const url = URL.createObjectURL(file);
        try {
            await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    ctx.drawImage(img, 0, 0, targetW, targetH);
                    resolve();
                };
                img.onerror = () => reject(new Error('image draw failed'));
                img.src = url;
            });
        } finally {
            URL.revokeObjectURL(url);
        }
        const blob = await new Promise((resolve) =>
            canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
        if (!blob) {
            // Fallback: if toBlob fails (extremely rare), upload the
            // original rather than failing the whole upload.
            return { blob: file, width: dim.width, height: dim.height, optimized: false, original: dim };
        }
        return { blob, width: targetW, height: targetH, optimized: true, original: dim };
    } catch (e) {
        console.warn('optimizeImageForTv failed, using original:', e);
        // Fallback to the original — bad optimization shouldn't
        // block a working upload.
        return { blob: file, width: 0, height: 0, optimized: false, original: { width: 0, height: 0 } };
    }
}

// Upload an array of Blobs (or Files) to Storage under the given
// folder, returning the download URLs in order.
export async function uploadImageBlobs({ blobs, folder, slugPrefix }) {
    if (!Array.isArray(blobs) || blobs.length === 0) return [];
    const ts = Date.now();
    const urls = [];
    for (let i = 0; i < blobs.length; i++) {
        const ext = (blobs[i].type === 'image/jpeg' ? 'jpg' : 'png');
        const path = `${folder}/${slugPrefix || 'menu'}_${ts}_p${i + 1}.${ext}`;
        const pref = storageRef(storage, path);
        await uploadBytes(pref, blobs[i]);
        urls.push(await getDownloadURL(pref));
    }
    return urls;
}

// Bake price overlays directly into a menu image, returning the
// download URL of the new (rendered) image.
//
// Andrew 2026-05-20: "with the pricing i need that to change the
// pdf at its core so it can[t] accidentally revert back to the old
// pricing". The overlay approach (PriceOverlay in MenuDisplay) is
// fragile — if the hit zone or override field gets cleared, the
// printed price shows through. This bakes the overlays into the
// PNG itself so the new prices are part of the image data, not a
// reversible layer.
//
// Workflow:
//   • Admin sets a new price on a hit zone in HitZoneEditor.
//   • Live preview uses PriceOverlay (CSS) so admin sees the
//     result without committing.
//   • When admin clicks Save, HitZoneEditor calls this for every
//     page that has price-override zones. The function:
//       1. Loads the existing image (Firebase Storage URL)
//       2. Draws a white sticker + bold green price text at each
//          override zone (same layout as PriceOverlay)
//       3. Exports the canvas as a PNG blob
//       4. Uploads the new PNG to Storage under tv_images/
//       5. Returns the new download URL
//   • Caller swaps the page's imageUrl + clears the priceOverride
//     fields. The "current image" now reflects the new prices
//     intrinsically.
//
// CORS: Image must load via crossOrigin='anonymous' so the canvas
// stays untainted and we can call toBlob(). Firebase Storage's
// cors.json (per cors-setup script) allows the GitHub Pages
// origin, so this works in prod.
export async function bakePriceOverlaysIntoImage({ imageUrl, priceZones, slugPrefix = 'menu' }) {
    if (!imageUrl) throw new Error('imageUrl required');
    if (!Array.isArray(priceZones) || priceZones.length === 0) {
        return imageUrl;   // nothing to bake — return original
    }

    // Load image with CORS so canvas is exportable.
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error(`failed to load image for baking: ${imageUrl}`));
        img.src = imageUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');

    // Paint the original image first.
    ctx.drawImage(img, 0, 0);

    // Layout constants — mirror the runtime PriceOverlay component
    // so the baked image looks identical to the live overlay.
    // Andrew 2026-05-20 (later) — bumped coverage from right-30%
    // to FULL zone after "when i overlay a box over a price and
    // change it it doesnt overlay it" — admin draws small precise
    // zones over prices; the zone IS the overlay area.
    const STICKER_BG_RGBA   = 'rgba(255, 255, 255, 0.98)';
    const STICKER_BORDER    = 'rgba(0, 0, 0, 0.10)';
    const TEXT_COLOR        = '#15803d';   // dd-green-700 equivalent

    for (const zone of priceZones) {
        if (!zone.priceOverride) continue;
        const x = zone.x * canvas.width;
        const y = zone.y * canvas.height;
        const w = zone.width * canvas.width;
        const h = zone.height * canvas.height;

        // White sticker.
        ctx.fillStyle = STICKER_BG_RGBA;
        ctx.fillRect(x, y, w, h);
        // Hairline border so the sticker reads as deliberate.
        ctx.strokeStyle = STICKER_BORDER;
        ctx.lineWidth = Math.max(1, canvas.width / 1200);
        ctx.strokeRect(x, y, w, h);

        // Price text — auto-fit to the sticker dims.
        // 65% of height is a safe text size that doesn't kiss the
        // sticker edges; pick the smaller of height-based and
        // width-based so very narrow stickers don't overflow.
        const heightBasedFont = h * 0.65;
        // Estimate text width: ~0.55 char-width for digits/$ at this weight.
        const text = String(zone.priceOverride);
        const widthBasedFont = (w * 0.85) / (text.length * 0.55);
        const fontSize = Math.max(8, Math.min(heightBasedFont, widthBasedFont));

        ctx.font = `900 ${fontSize}px Arial, "Helvetica Neue", sans-serif`;
        ctx.fillStyle = TEXT_COLOR;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + w / 2, y + h / 2);
    }

    // Export to PNG blob. Resampling 0.95 keeps the file small but
    // preserves the original menu pixels.
    const blob = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/png', 0.95);
    });
    if (!blob) throw new Error('canvas.toBlob returned null (image may be tainted)');

    // Upload the baked image as a fresh file. We don't replace the
    // original URL — Storage keeps the old file so admin could
    // theoretically re-link it if needed. (We don't surface that
    // path; the simple recovery is "re-upload the PDF".)
    const path = `tv_images/${slugPrefix}_baked_${Date.now()}.png`;
    const pref = storageRef(storage, path);
    await uploadBytes(pref, blob);
    return await getDownloadURL(pref);
}

// Detect whether a URL points at a video file. Used by MenuDisplay
// to decide between <img> and <video>. Looks at the path before
// the query string (Firebase Storage URLs end in ?alt=media&token=…).
export function urlIsVideo(url) {
    if (!url) return false;
    const pathPart = String(url).split('?')[0].toLowerCase();
    return /\.(mp4|webm|mov|m4v)$/i.test(pathPart);
}

// One-shot: take a user-picked File and upload it. Supports:
//   • PDF → split to one PNG per page, upload each
//   • Image (jpeg/png/gif/webp) → upload as-is
//   • Video (mp4/webm/mov) → upload as-is, returned URL renders via
//     <video> in MenuDisplay. Andrew 2026-05-20 Wave 4 of "match the
//     SaaS leaders" — all of them support video; some charge extra
//     for it. Ours is included.
export async function uploadMenuFile({ file, folder = 'tv_images', slugPrefix }) {
    if (!file) throw new Error('file required');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isImage = file.type?.startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(file.name);
    const isVideo = file.type?.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name);

    if (isPdf) {
        const blobs = await renderPdfPagesToBlobs(file);
        if (blobs.length === 0) throw new Error('PDF had no renderable pages');
        return await uploadImageBlobs({ blobs, folder, slugPrefix });
    }
    if (isImage) {
        // Optimize first — phone cameras commonly produce 4000-6000px
        // images that are pure storage / decode waste for a 1080p TV.
        // optimizeImageForTv resizes anything wider than 1920px and
        // re-encodes as JPEG q=0.85; smaller images pass through
        // unchanged. The result also carries the ORIGINAL dimensions
        // so callers can warn on visibly-soft inputs (< 1280px wide).
        const opt = await optimizeImageForTv(file);
        const urls = await uploadImageBlobs({ blobs: [opt.blob], folder, slugPrefix });
        // Surface optimization metadata via a non-throwing side
        // channel — we keep the legacy return shape (array of URLs)
        // for backward compat, but expose meta via a property on
        // the array. Callers that want warnings opt into reading
        // it; legacy callers ignore it and behave as before.
        const origW = opt.original?.width || 0;
        urls.meta = {
            optimized: opt.optimized,
            uploadedDimensions: { width: opt.width, height: opt.height },
            originalDimensions: opt.original,
            wasResized: opt.optimized,
            isLowResolution: origW > 0 && origW < TV_MIN_GOOD_WIDTH,
        };
        return urls;
    }
    if (isVideo) {
        // Cap video size to keep Storage costs sane. Restaurant
        // sizzle reels are typically 5-30 MB compressed; 80 MB is
        // a generous ceiling.
        if (file.size > 80 * 1024 * 1024) {
            throw new Error('video too large (max 80 MB)');
        }
        const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
        const path = `${folder}/${slugPrefix || 'menu'}_${Date.now()}.${ext}`;
        const pref = storageRef(storage, path);
        await uploadBytes(pref, file);
        return [await getDownloadURL(pref)];
    }
    throw new Error('Unsupported file type. Use PDF, image, or video.');
}
