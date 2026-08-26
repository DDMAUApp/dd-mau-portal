// AI recipe import — client side (Recipes tab → "Import" button).
//
// Andrew 2026-08-18: "add a recipe import. either by file, picture and any
// other way that would make it easier to enter the recipe … use ai or some
// picture or file reading software to import the recipe."
//
// Three inputs, one pipeline:
//   • photos (camera / library, several at once)  ─┐
//   • files: PDF (rendered to one PNG per page),   ├─ upload → Storage → job
//     images, .txt/.md/.csv (read as text),        │  doc → Cloud Function
//     .docx (text pulled from word/document.xml)   │  (processRecipeImportJob)
//   • pasted text                                  ─┘  → recipes[] in the
//                                                       app's own schema
//
// Transport is the job-doc pattern from health.js (write
// recipe_import_jobs/{id}, listen for status done/error) — the one path
// that has proven reliable on the native iPad WebView. Long documents are
// split into batches of ≤ PAGES_PER_JOB pages and run as parallel jobs.
//
// Everything here is admin-only by construction (the Import button only
// renders for admins) but the pipeline itself has no PII: staged images
// are deleted from Storage as soon as the job settles.

import { db, storage } from '../firebase';
import { collection, doc, setDoc, onSnapshot, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

const JOBS = 'recipe_import_jobs';
const JOB_TIMEOUT_MS = 240_000;     // trigger ceiling is 300 s; Sonnet on 6 pages ≈ 30-90 s
const OFFLINE_FAIL_MS = 10_000;
export const PAGES_PER_JOB = 6;      // images per Claude call (CF cap is 8)
export const MAX_PAGES = 30;         // whole recipe book = 38 pages; cap keeps one import bounded
// Staged under menu_imports/ — that Storage path already allows image/pdf
// writes + deletes (see storage.rules) so no rules deploy is needed. The
// files are deleted right after extraction.
const STAGING_FOLDER = 'menu_imports';
const MAX_EDGE_PX = 2200;            // plenty for handwriting; keeps uploads ~300-600 KB
const JPEG_Q = 0.85;

// ── Job transport ────────────────────────────────────────────────────
export function runRecipeImportJob(payload) {
    const ref = doc(collection(db, JOBS));
    return new Promise((resolve, reject) => {
        let settled = false;
        let unsub = null;
        let timer = null;
        const cleanup = () => {
            settled = true;
            if (unsub) { try { unsub(); } catch { /* noop */ } }
            if (timer) clearTimeout(timer);
            deleteDoc(ref).catch(() => {});
        };
        const fail = (err) => { if (!settled) { cleanup(); reject(err); } };
        let acked = false;
        setTimeout(() => {
            if (!acked && !settled) fail(new Error('no connection — check the internet and try again'));
        }, OFFLINE_FAIL_MS);
        // JSON round-trip: Firestore rejects `undefined` anywhere in the doc.
        const clean = JSON.parse(JSON.stringify(payload || {}));
        setDoc(ref, { ...clean, status: 'pending', createdAt: serverTimestamp() })
            .then(() => {
                acked = true;
                if (settled) return;
                unsub = onSnapshot(ref, (snap) => {
                    const d = snap.data();
                    if (!d || settled) return;
                    if (d.status === 'done') { cleanup(); resolve(d.result || { recipes: [], warnings: [] }); }
                    else if (d.status === 'error') fail(new Error(d.error || 'import failed'));
                }, (err) => fail(err));
            })
            .catch((err) => fail(err));
        timer = setTimeout(() => fail(new Error('AI read timed out — try fewer pages at once')), JOB_TIMEOUT_MS);
    });
}

// ── File preparation ─────────────────────────────────────────────────
function isPdf(file)   { return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''); }
function isImage(file) { return (file.type || '').startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(file.name || ''); }
function isDocx(file)  { return /\.docx$/i.test(file.name || '') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; }
function isText(file)  { return (file.type || '').startsWith('text/') || /\.(txt|md|csv|json|rtf)$/i.test(file.name || ''); }

async function loadImageForCanvas(file) {
    if (typeof createImageBitmap === 'function') {
        try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
    }
    const url = URL.createObjectURL(file);
    try {
        return await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('could not decode image'));
            im.src = url;
        });
    } finally {
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* noop */ } }, 5000);
    }
}

// Downscale to MAX_EDGE_PX on the long side, re-encode JPEG. NO cropping —
// (menuImageUpload's optimizer crops to 16:9 for TVs; a portrait photo of a
// recipe card would lose its top and bottom).
export async function normalizeRecipeImage(file) {
    let img;
    try { img = await loadImageForCanvas(file); }
    catch { return file; }              // HEIC on a browser that can't decode → upload as-is; server accepts jpeg/png/webp
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    if (!w || !h) return file;
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(w, h));
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    if (typeof img.close === 'function') { try { img.close(); } catch { /* noop */ } }
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_Q));
    // Free the canvas backing store now — Safari holds it until GC and
    // enforces a total canvas budget (30-page book imports were at risk).
    canvas.width = 0; canvas.height = 0;
    return blob || file;
}

async function docxToText(file) {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const xml = await zip.file('word/document.xml')?.async('string');
    if (!xml) throw new Error('not a valid .docx');
    return xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:br[^>]*\/>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Turn a list of File objects into { imageBlobs: Blob[], text: string, notes: string[] }.
// PDFs → one PNG per page (pdfjs, lazy), images → normalized JPEG,
// text-ish files → text. onProgress(label) is optional.
export async function prepareRecipeFiles(files, { onProgress } = {}) {
    const imageBlobs = [];
    const textParts = [];
    const notes = [];
    for (const file of Array.from(files || [])) {
        if (isPdf(file)) {
            onProgress?.(`Rendering ${file.name}…`);
            const remaining = MAX_PAGES - imageBlobs.length;
            if (remaining <= 0) { notes.push(`${file.name}: beyond the ${MAX_PAGES}-page cap — not read`); continue; }
            const { renderPdfPagesToBlobs } = await import('./menuImageUpload');
            const pages = await renderPdfPagesToBlobs(file, { scale: 2, maxPages: remaining });
            if (pages.length === 0) { notes.push(`${file.name}: no readable pages`); continue; }
            // Re-encode each page as JPEG (a scanned page can be a multi-MB
            // PNG; the AI vendor caps images at 5 MB per image).
            for (let i = 0; i < pages.length; i++) {
                onProgress?.(`Preparing ${file.name} page ${i + 1} / ${pages.length}…`);
                // eslint-disable-next-line no-await-in-loop
                imageBlobs.push(await normalizeRecipeImage(pages[i]));
            }
        } else if (isImage(file)) {
            // Skip (don't normalize) photos beyond the page cap — they'd be
            // truncated after the work anyway.
            if (imageBlobs.length >= MAX_PAGES) { notes.push(`${file.name || 'photo'}: beyond the ${MAX_PAGES}-page cap — not read`); continue; }
            onProgress?.(`Preparing ${file.name || 'photo'}…`);
            imageBlobs.push(await normalizeRecipeImage(file));
        } else if (isDocx(file)) {
            onProgress?.(`Reading ${file.name}…`);
            textParts.push(await docxToText(file));
        } else if (isText(file)) {
            textParts.push(await file.text());
        } else {
            notes.push(`${file.name}: unsupported type (use photos, PDF, .docx or .txt)`);
        }
    }
    if (imageBlobs.length > MAX_PAGES) {
        notes.push(`Only the first ${MAX_PAGES} pages are read per import — split the rest into a second import.`);
        imageBlobs.length = MAX_PAGES;
    }
    return { imageBlobs, text: textParts.join('\n\n---\n\n').trim(), notes };
}

async function stageBlobs(blobs, onProgress) {
    // On a mid-way failure the caller gets the partial list via the error so
    // it can still delete what was uploaded.
    // Random suffix: the folder is world-readable by URL, so a guessable
    // timestamp-only name is not acceptable for confidential recipe photos.
    const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const staged = [];
    for (let i = 0; i < blobs.length; i++) {
        onProgress?.(`Uploading ${i + 1} / ${blobs.length}…`);
        const ext = blobs[i].type === 'image/png' ? 'png' : 'jpg';
        const path = `${STAGING_FOLDER}/recipe_${ts}_p${i + 1}.${ext}`;
        const sref = storageRef(storage, path);
        try {
            await uploadBytes(sref, blobs[i], { contentType: blobs[i].type || 'image/jpeg' });
            staged.push({ path, url: await getDownloadURL(sref) });
        } catch (e) {
            unstage(staged);
            throw e;
        }
    }
    return staged;
}

function unstage(staged) {
    for (const s of staged) deleteObject(storageRef(storage, s.path)).catch(() => {});
}

// ── Public entry: files/photos/text → { recipes, warnings } ──────────
export async function importRecipes({ files = [], text = '', categories = [], existingTitles = [], onProgress } = {}) {
    const prepared = files.length ? await prepareRecipeFiles(files, { onProgress }) : { imageBlobs: [], text: '', notes: [] };
    const allText = [text, prepared.text].filter((t) => t && t.trim()).join('\n\n---\n\n');
    const jobs = [];
    let staged = [];
    if (prepared.imageBlobs.length) {
        staged = await stageBlobs(prepared.imageBlobs, onProgress);
        for (let i = 0; i < staged.length; i += PAGES_PER_JOB) {
            const urls = staged.slice(i, i + PAGES_PER_JOB).map((s) => s.url);
            jobs.push({ kind: 'images', imageUrls: urls, categories, existingTitles });
        }
    }
    if (allText) jobs.push({ kind: 'text', text: allText.slice(0, 60_000), categories, existingTitles });
    if (jobs.length === 0) throw new Error('Nothing to import — add a photo, a file, or paste text.');
    onProgress?.(jobs.length > 1 ? `Reading ${jobs.length} batches with AI…` : 'Reading with AI…');
    let results;
    try {
        results = await Promise.allSettled(jobs.map((j) => runRecipeImportJob(j)));
    } finally {
        unstage(staged);
    }
    const recipes = [];
    const warnings = [...prepared.notes];
    let failed = 0;
    results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
            recipes.push(...(r.value?.recipes || []).map((rec, k) => ({ ...rec, _batch: i + 1, _idx: k })));
            warnings.push(...(r.value?.warnings || []));
        } else {
            failed += 1;
            warnings.push(`Batch ${i + 1}: ${r.reason?.message || 'failed'}`);
        }
    });
    if (failed === jobs.length) throw new Error(warnings[warnings.length - 1] || 'AI read failed');
    return { recipes, warnings, batches: jobs.length, failedBatches: failed };
}

// ── Editor helper: fill the Spanish side + allergens of a draft ──────
export async function completeRecipeDraft(draft, { categories = [] } = {}) {
    // JSON round-trip strips `undefined` values (Firestore setDoc rejects
    // them) — the editor form can carry `id: undefined` for a new draft.
    const recipe = JSON.parse(JSON.stringify(draft || {}));
    const res = await runRecipeImportJob({ kind: 'translate', recipe, categories });
    const r = res?.recipes?.[0];
    if (!r) throw new Error('AI returned nothing — try again');
    return r;
}
