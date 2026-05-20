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

// One-shot: take a user-picked File, render pages (PDF) or wrap a
// single image, and upload all results. Returns the URLs.
export async function uploadMenuFile({ file, folder = 'tv_images', slugPrefix }) {
    if (!file) throw new Error('file required');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    let blobs;
    if (isPdf) {
        blobs = await renderPdfPagesToBlobs(file);
        if (blobs.length === 0) throw new Error('PDF had no renderable pages');
    } else if (file.type?.startsWith('image/')) {
        blobs = [file];
    } else {
        throw new Error('Unsupported file type. Use PDF or image.');
    }
    return await uploadImageBlobs({ blobs, folder, slugPrefix });
}
