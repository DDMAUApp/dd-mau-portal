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
import { burstUnitPoints, BURST_DEFAULT_FILL, BURST_DEFAULT_TEXT } from './burstShapes';
import { getEditorFont, ensureFontsForTexts } from './editorFonts';

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
// TV signage. Andrew 2026-06-10: the webster-photos TV is a 4K panel
// (Pi 5 outputs 3840×2160) and 1920px uploads looked visibly softer
// than the same photo on his phone — raised 1920 → 3840 so photos
// keep native-4K detail. Most modern phone cameras produce 4000-6000px
// images, so the resize still runs; bytes roughly 3-4× but it's a
// handful of signage photos, not user content at scale.
const TV_MAX_IMAGE_WIDTH = 3840;
// JPEG quality used when re-encoding downsized images. Bumped 0.85 →
// 0.9 alongside the 4K raise — at TV size, compression artifacts read
// as "cheap screen" faster than they do on a phone.
const TV_JPEG_QUALITY = 0.9;
// Minimum dimensions we expect for a "looks good on TV" upload.
// Smaller than this and the image will be visibly soft on a 4K
// screen viewed from across the restaurant; we surface a warning
// to the caller but still allow the upload (the admin might
// genuinely WANT a small / pixelated retro look).
const TV_MIN_GOOD_WIDTH = 1920;
// Auto-crop tolerance band. 16:9 = 1.7778. We crop anything OUTSIDE
// this band to fill the TV without letterboxing — phone-portrait
// (0.5625), square (1.0), 4:3 (1.333), and ultrawide (> 1.95) all
// get center-cropped to 1.7778. Images already close to 16:9 (e.g.
// 1.7, 1.85) pass through unchanged because the small letterbox
// strips look fine and we'd rather not re-encode and lose quality
// for a barely-noticeable correction.
const TV_TARGET_ASPECT = 16 / 9;
const TV_ASPECT_TOLERANCE_LOW  = 1.65;
const TV_ASPECT_TOLERANCE_HIGH = 1.95;

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

// Two-step image optimization for TV signage:
//   1. Center-crop to 16:9 if the source is meaningfully off-aspect.
//      Phone-portrait, square, 4:3 → 16:9. Sources already close to
//      16:9 (within TV_ASPECT_TOLERANCE_LOW..HIGH) skip the crop so
//      we don't re-encode for an imperceptible correction.
//   2. Resize to TV_MAX_IMAGE_WIDTH if wider than that. Saves
//      Storage bytes + Pi decode cycles on the common case of
//      multi-megapixel phone photos.
//
// Both steps share a single canvas pass when both are needed.
// Returns `{ blob, width, height, optimized, cropped, original }`
// so callers can surface what happened in toasts. `cropped: true`
// indicates the aspect was changed; `optimized: true` indicates
// the bytes were re-encoded for any reason (resize OR crop OR
// both — they always go together when we re-encode).
//
// Pass `opts.skipCrop: true` to disable the aspect crop and only
// downscale. Future use case: a "preserve aspect" toggle on the
// upload UI.
export async function optimizeImageForTv(file, opts = {}) {
    const maxWidth   = opts.maxWidth || TV_MAX_IMAGE_WIDTH;
    const quality    = opts.quality  || TV_JPEG_QUALITY;
    const skipCrop   = opts.skipCrop === true;
    try {
        const dim = await getImageDimensions(file);
        const aspect = dim.height > 0 ? dim.width / dim.height : 0;
        // Decide whether to crop. We only crop when the source is
        // noticeably off-aspect — within tolerance we'd rather
        // preserve the original pixels.
        const needsCrop = !skipCrop && aspect > 0 && (aspect < TV_ASPECT_TOLERANCE_LOW || aspect > TV_ASPECT_TOLERANCE_HIGH);

        // Compute the source rectangle (the slice of the original
        // we'll draw onto the canvas). When cropping is off, that's
        // the whole image. When cropping is on, we center-crop to
        // a 16:9 window of the largest possible size.
        let srcX = 0, srcY = 0, srcW = dim.width, srcH = dim.height;
        if (needsCrop) {
            if (aspect < TV_TARGET_ASPECT) {
                // Source is too tall — crop top + bottom equally.
                srcH = Math.round(dim.width / TV_TARGET_ASPECT);
                srcY = Math.round((dim.height - srcH) / 2);
            } else {
                // Source is too wide — crop left + right equally.
                srcW = Math.round(dim.height * TV_TARGET_ASPECT);
                srcX = Math.round((dim.width - srcW) / 2);
            }
        }

        // Compute the destination size. We start from the source
        // rectangle's width and downscale to maxWidth if needed.
        let destW = srcW;
        let destH = srcH;
        const needsResize = destW > maxWidth;
        if (needsResize) {
            const scale = maxWidth / destW;
            destW = Math.round(destW * scale);
            destH = Math.round(destH * scale);
        }

        // Skip the canvas pass entirely if NEITHER crop nor resize
        // is needed — preserves the original file bytes (no re-encode
        // quality loss).
        if (!needsCrop && !needsResize) {
            return {
                blob: file,
                width: dim.width, height: dim.height,
                optimized: false, cropped: false,
                original: dim,
            };
        }

        const canvas = document.createElement('canvas');
        canvas.width  = destW;
        canvas.height = destH;
        const ctx = canvas.getContext('2d');
        // High-quality resampling for the downscale — the default
        // bilinear pass visibly softens fine detail (menu text, food
        // texture) on big TV panels.
        ctx.imageSmoothingQuality = 'high';
        // White background — keeps transparent PNGs from rendering
        // black after JPEG re-encode (JPEG has no alpha channel).
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, destW, destH);
        // Decode + draw via Image so we don't have to depend on
        // createImageBitmap (mobile Safari support is patchy).
        const url = URL.createObjectURL(file);
        try {
            await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    // 9-arg drawImage — pick a source rectangle from
                    // the original, paint it onto the canvas at the
                    // destination size. Handles crop + resize in one
                    // pass.
                    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, destW, destH);
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
            // Fallback: if toBlob fails (extremely rare), upload
            // the original rather than failing the whole upload.
            return {
                blob: file,
                width: dim.width, height: dim.height,
                optimized: false, cropped: false,
                original: dim,
            };
        }
        return {
            blob,
            width: destW, height: destH,
            optimized: true,
            cropped: needsCrop,
            original: dim,
        };
    } catch (e) {
        console.warn('optimizeImageForTv failed, using original:', e);
        // Fallback to the original — bad optimization shouldn't
        // block a working upload.
        return {
            blob: file,
            width: 0, height: 0,
            optimized: false, cropped: false,
            original: { width: 0, height: 0 },
        };
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

// Load an image so it can be drawn to a <canvas> and read back (toBlob)
// WITHOUT tainting it. Prefers fetch → blob → object URL: a blob: URL is
// same-origin, so the canvas stays clean even if the original response was
// cached earlier WITHOUT CORS headers (e.g. an <img> that displayed it first —
// a well-known WebKit/Chromium taint gotcha). Falls back to a classic
// crossOrigin <img>. Either path needs this origin in the bucket CORS
// allowlist (cors.json) — incl. the Capacitor native origins
// capacitor://localhost (iOS) and https://localhost (Android).
// Returns { img, release } — call release() once the canvas draw is done.
async function loadImageForCanvas(url) {
    try {
        const resp = await fetch(url, { mode: 'cors', cache: 'reload' });
        if (resp.ok) {
            const blob = await resp.blob();
            const objUrl = URL.createObjectURL(blob);
            try {
                const img = await new Promise((resolve, reject) => {
                    const im = new Image();
                    im.onload = () => resolve(im);
                    im.onerror = () => reject(new Error('decode failed'));
                    im.src = objUrl;
                });
                return { img, release: () => { try { URL.revokeObjectURL(objUrl); } catch {} } };
            } catch (e) {
                try { URL.revokeObjectURL(objUrl); } catch {}
                throw e;
            }
        }
    } catch {
        // fetch blocked / network issue → fall back to crossOrigin <img>
    }
    const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error(`failed to load image for baking: ${url}`));
        im.src = url;
    });
    return { img, release: () => {} };
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

    // Load image so the canvas stays exportable (untainted) — see
    // loadImageForCanvas; works on web + the Capacitor native origins.
    const { img, release } = await loadImageForCanvas(imageUrl);

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');

    // Paint the original image first.
    ctx.drawImage(img, 0, 0);
    release();   // pixels are on the canvas now — free the blob URL

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

// Bake the picture-editor recipe (crop + text + starbursts) into a single flat
// PNG and upload it, returning the new download URL. Non-destructive: the caller
// keeps the originalUrl + recipe so the picture can be re-opened and re-edited.
//
// Coordinate model (matches PictureEditor): `crop` is fractions of the ORIGINAL
// image; `texts`/`bursts` are fractions of the FINAL (cropped) output — x,y is
// the element anchor, sizes are fractions of the output HEIGHT. So element
// fractions map straight onto the output canvas with no conversion at bake time.
//
//   texts[]:  { x, y, text, size, color, align?, weight?, outline? }
//   bursts[]: { x, y, size, shape, fill, textColor, text }
export async function bakePictureEdits({ originalUrl, crop = null, texts = [], bursts = [], slugPrefix = 'pic' }) {
    if (!originalUrl) throw new Error('originalUrl required');

    const { img, release } = await loadImageForCanvas(originalUrl);

    const natW = img.naturalWidth, natH = img.naturalHeight;
    // Source rectangle (the crop), in original pixels. Default = whole image.
    let sx = 0, sy = 0, sw = natW, sh = natH;
    if (crop && typeof crop.w === 'number' && crop.w > 0 && crop.h > 0) {
        sx = Math.round(Math.max(0, Math.min(1, crop.x)) * natW);
        sy = Math.round(Math.max(0, Math.min(1, crop.y)) * natH);
        sw = Math.round(Math.max(0.01, Math.min(1, crop.w)) * natW);
        sh = Math.round(Math.max(0.01, Math.min(1, crop.h)) * natH);
        sw = Math.min(sw, natW - sx);
        sh = Math.min(sh, natH - sy);
    }

    // Output = source rect, downscaled to ≤ TV_MAX_IMAGE_WIDTH wide.
    let outW = sw, outH = sh;
    if (outW > TV_MAX_IMAGE_WIDTH) {
        const scale = TV_MAX_IMAGE_WIDTH / outW;
        outW = Math.round(outW * scale);
        outH = Math.round(outH * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, outW);
    canvas.height = Math.max(1, outH);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
    release();   // pixels are on the canvas now — free the blob URL

    // Elements are stored as fractions of the ORIGINAL image (stable across
    // re-crops). Convert each to output pixels through the crop window.
    const cX = (crop && crop.w > 0) ? crop.x : 0;
    const cY = (crop && crop.h > 0) ? crop.y : 0;
    const cW = (crop && crop.w > 0) ? crop.w : 1;
    const cH = (crop && crop.h > 0) ? crop.h : 1;
    const toOutX = (ox) => ((ox - cX) / cW) * outW;
    const toOutY = (oy) => ((oy - cY) / cH) * outH;
    const outPx  = (origHeightFrac) => (origHeightFrac / cH) * outH;   // size frac → px

    // ── Text elements ──────────────────────────────────────────
    // Webfonts must be DOWNLOADED before canvas fillText, or it silently
    // paints a default face. Pre-load every font these texts use (best-
    // effort, internally timed out so a blocked CDN can't hang Save).
    await ensureFontsForTexts(texts, Math.max(24, outH * 0.1));
    for (const t of (texts || [])) {
        const str = String(t.text ?? '').trim();
        if (!str) continue;
        const fnt = getEditorFont(t.font);
        const fontPx = Math.max(8, outPx(t.size || 0.06));
        ctx.font = `${t.weight || fnt.weight || 900} ${fontPx}px ${fnt.stack}`;
        ctx.textAlign = t.align || 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        const px = toOutX(t.x ?? 0.5);
        const lines = str.split('\n');
        const lineH = fontPx * 1.12;
        const startY = toOutY(t.y ?? 0.5) - ((lines.length - 1) * lineH) / 2;
        lines.forEach((ln, i) => {
            const ly = startY + i * lineH;
            if (t.outline !== false) {
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.lineWidth = Math.max(1, fontPx * 0.16);
                ctx.strokeText(ln, px, ly);
            }
            ctx.fillStyle = t.color || '#ffffff';
            ctx.fillText(ln, px, ly);
        });
    }

    // ── Starburst badges ───────────────────────────────────────
    for (const b of (bursts || [])) {
        const diameter = Math.max(12, outPx(b.size || 0.22));
        const R = diameter / 2;
        const cx = toOutX(b.x ?? 0.5);
        const cy = toOutY(b.y ?? 0.5);
        const pts = burstUnitPoints(b.shape || 'star');
        ctx.beginPath();
        pts.forEach((p, i) => {
            const X = cx + p.x * R, Y = cy + p.y * R;
            if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        });
        ctx.closePath();
        ctx.fillStyle = b.fill || BURST_DEFAULT_FILL;
        ctx.fill();
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = Math.max(1, R * 0.04);
        ctx.stroke();

        const str = String(b.text ?? '').trim();
        if (str) {
            const target = diameter * 0.62;           // fit single line to ~62% of diameter
            let fontPx = diameter * 0.40;
            ctx.font = `900 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
            const w = ctx.measureText(str).width || 1;
            if (w > target) fontPx = Math.max(8, fontPx * (target / w));
            ctx.font = `900 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
            ctx.fillStyle = b.textColor || BURST_DEFAULT_TEXT;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(str, cx, cy);
        }
    }

    // JPEG, not PNG — the canvas is always painted on an opaque white
    // background (no alpha to preserve), and a 3840px photo as PNG is
    // 10-25 MB vs ~2-3 MB at JPEG 0.92. At TV viewing distance 0.92 is
    // indistinguishable; the Pi decodes + caches it far faster too.
    const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92));
    if (!blob) throw new Error('canvas.toBlob returned null (image may be tainted)');
    const path = `tv_images/${slugPrefix || 'pic'}_edit_${Date.now()}.jpg`;
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
        // Optimize first. optimizeImageForTv now does TWO things:
        //   • Center-crop to 16:9 if the source is off-aspect
        //     (phone-portrait, square, 4:3 → 16:9 by cropping).
        //     Images already close to 16:9 pass through.
        //   • Downscale to 1920px width if wider than that.
        // Both share a single canvas re-encode pass (JPEG q=0.85).
        // Meta surfaces what happened so the editor can toast it.
        const opt = await optimizeImageForTv(file);
        const urls = await uploadImageBlobs({ blobs: [opt.blob], folder, slugPrefix });
        const origW = opt.original?.width || 0;
        const origH = opt.original?.height || 0;
        const origAspect = origH > 0 ? origW / origH : 0;
        urls.meta = {
            optimized: opt.optimized,
            wasCropped: opt.cropped,
            uploadedDimensions: { width: opt.width, height: opt.height },
            originalDimensions: opt.original,
            originalAspect: origAspect,
            wasResized: opt.optimized && !opt.cropped
                ? true
                : (opt.optimized && origW > TV_MAX_IMAGE_WIDTH),
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
