// OnboardingFillablePdf — hire-side renderer for template-backed docs.
//
// Loads the template's source PDF + field positions, renders each page as
// a background image with absolute-positioned input fields on top. The
// hire fills inputs / draws their signature. On submit:
//   1. Use pdf-lib to write each field's value onto the corresponding
//      page at the stored fractional coordinates
//   2. Embed signature/initials canvas images as PNG
//   3. Strip the interactive form layer (XFA + AcroForm + field widgets) so
//      the output is a flat PDF that every viewer renders identically, then save
//   4. Upload to onboarding/{hireId}/{docId}/filled_{ts}.pdf
//
// Falls back to plain file upload if no template exists yet (so the admin
// can ship the doc without templates being built first).

import { useEffect, useMemo, useRef, useState } from 'react';
import { db, storage } from '../firebase';
import { collection, query, where, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { ref as sref, uploadBytes, getDownloadURL, getBytes, listAll, deleteObject } from 'firebase/storage';
import { LOCATION_INFO } from '../data/onboarding';

// Lazy loaders — keep pdfjs + pdf-lib out of the main bundle.
async function loadPdfJs() {
    const pdfjs = await import('pdfjs-dist');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    }
    return pdfjs;
}
async function loadPdfLib() {
    return await import('pdf-lib');
}

// Auto-fill values. Two source categories:
//   • From the hire's `personal` payload (filled by them when they submit
//     the personal info form).
//   • From the hire RECORD itself (admin-set when the hire is created):
//     position, location, hireDate, offerAmount. These power offer-letter
//     and other admin-prepared templates.
//
// SENSITIVE-AUTOFILL DENY-LIST — see SSN_AUTOFILL_DENYLIST below.
// W-4 templates auto-detect an "Employee's SSN" field and (before this
// fix) bound it to `autofill: 'ssn'`. Resolving that against the hire
// record meant a partially-filled W-4 PDF — emailed, saved to disk, or
// downloaded by a hire who abandons mid-form — leaked the SSN. That
// matches the audit finding: "SSN gets autofilled from the hire record
// into the W-4 PDF field, which means a partially-completed PDF
// emailed/saved has the SSN visible."
//
// IRS guidance for SSN handling in form-prep apps (Pub. 1345 § 4 and
// the W-4 / I-9 instructions) is that the SSN should be entered by the
// taxpayer at the moment of form preparation, not pre-populated from an
// upstream record. We follow that here: the autofill resolver returns
// '' for any binding name in the deny-list, forcing the hire to retype
// the SSN fresh into the PDF every time. The binding itself is kept
// (so the FieldInput renderer can recognize the field and apply masked
// input chrome) — we just never resolve it to a stored value.
const SSN_AUTOFILL_DENYLIST = new Set([
    'ssn',
    'socialSecurityNumber',
    'social',
    'ssn4',
    'ssnFull',
]);

function isSensitiveAutofill(autofillId) {
    return !!autofillId && SSN_AUTOFILL_DENYLIST.has(autofillId);
}

function autofillValue(autofillId, hire) {
    if (!autofillId) return '';
    // Sensitive bindings (SSN, etc.) intentionally never resolve to a
    // stored value — the hire types them fresh into the PDF. See the
    // SSN_AUTOFILL_DENYLIST block above for the IRS-guidance rationale.
    if (isSensitiveAutofill(autofillId)) return '';
    const p = hire?.personal || {};
    const firstName = (p.legalName || hire?.name || '').split(' ')[0] || '';
    const lastName = (p.legalName || hire?.name || '').split(' ').slice(-1)[0] || '';
    const today = new Date().toISOString().slice(0, 10);
    const locInfo = (hire?.location && LOCATION_INFO[hire.location]) || null;
    const map = {
        legalName: p.legalName || hire?.name || '',
        firstName, lastName,
        addressLine: p.addressLine || '',
        city: p.city || '',
        state: p.state || '',
        zip: p.zip || '',
        // Combined "City, State ZIP" — the federal W-4 (and many forms) use a
        // single box for all three, where MO/others split them. Lets one
        // autofill binding populate that combined box.
        cityStateZip: [
            [p.city, p.state].filter(Boolean).join(', '),
            p.zip || '',
        ].filter(Boolean).join(' '),
        dob: p.dob || '',
        phone: p.phone || hire?.phone || '',
        email: p.email || hire?.email || '',
        today,
        position: hire?.position || '',
        location: locInfo?.label || (hire?.location || ''),
        hireDate: hire?.hireDate || '',
        offerAmount: hire?.offerAmount || '',
        legalEntity: locInfo?.legalEntity || 'DD Mau',
        locationAddress: locInfo?.address || '',
    };
    return map[autofillId] || '';
}

// Helvetica (the only font we embed) uses WinAnsi/CP1252 encoding. That covers
// English + Spanish fine — accents, ñ, curly quotes and dashes all encode — but
// a stray emoji or non-Latin character (pasted in, or from a non-Latin keyboard)
// makes pdf-lib's drawText THROW "WinAnsi cannot encode", which aborts the ENTIRE
// submit and leaves the hire unable to finish. This keeps every encodable
// character and drops/normalizes only the few it can't, so one exotic glyph can
// never break submission.
const WINANSI_SUBS = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...' };
function winAnsiSafe(font, value) {
    const str = String(value == null ? '' : value);
    if (!font || typeof font.encodeText !== 'function') return str;
    try { font.encodeText(str); return str; } catch { /* contains unencodable chars */ }
    let out = '';
    for (const ch of str) {
        try { font.encodeText(ch); out += ch; }
        catch { out += (WINANSI_SUBS[ch] ?? ''); }
    }
    return out;
}

export default function OnboardingFillablePdf({
    docDef,        // ONBOARDING_DOCS entry (kind: 'template')
    hire,
    hireId,
    isEs,
    isLocked,      // hire is in admin's "Complete" folder — read-only mode
    onSubmitted,
    onStart,
}) {
    const tx = (en, es) => (isEs ? es : en);
    const [template, setTemplate] = useState(null);        // { id, fields, storagePath, pageDims }
    const [pageImages, setPageImages] = useState([]);
    const [pdfBytes, setPdfBytes] = useState(null);
    const [loading, setLoading] = useState(true);
    const [values, setValues] = useState({});               // fieldId -> string (or data URL for signature)
    // Per-signature "signed at" (epoch ms) captured the moment the hire taps
    // Done in the pad. Drives a DocuSign-style caption UNDER the signature in
    // the fill view so the hire sees the timestamp live (previously the stamp
    // only existed in the flattened PDF, so there was nothing to see on-screen).
    // Session-only — the authoritative record is the PDF stamp + the signing
    // certificate; this is just the live confirmation.
    const [sigStamps, setSigStamps] = useState({});         // fieldId -> epoch ms
    const [submitting, setSubmitting] = useState(false);
    const [progressMsg, setProgressMsg] = useState('');
    const [err, setErr] = useState('');
    const [reloadKey, setReloadKey] = useState(0);          // bump to retry a failed/timed-out template load
    const [sigField, setSigField] = useState(null);         // field currently in the signature pad modal
    // Submitted view — replaces the form with a "✓ Complete" success
    // state + an Edit button after the hire submits, instead of leaving
    // the same "Submit signed form" button hanging around (which made
    // it look like the submit didn't take). Seeded from the doc's saved
    // status so re-opening a SUBMITTED/APPROVED doc starts in this view
    // too; Edit flips back to the form to re-fill and re-submit.
    const docStatus = (hire?.checklist && hire.checklist[docDef.id] && hire.checklist[docDef.id].status) || 'needed';
    const wasSubmitted = docStatus === 'submitted' || docStatus === 'approved';
    const [showSubmitted, setShowSubmitted] = useState(wasSubmitted);

    // Look up template for this docId.
    useEffect(() => {
        let alive = true;
        (async () => {
            setLoading(true);
            setErr('');
            try {
                const snap = await getDocs(query(collection(db, 'onboarding_templates'), where('forDocId', '==', docDef.id)));
                // Filter to FILLABLE-mode templates only. Reference-mode
                // templates (admin-uploaded reference PDFs) are surfaced
                // by DocCard at the parent layer and shouldn't be loaded
                // here. Templates saved before `mode` was introduced default
                // to fillable.
                const fillable = [];
                snap.forEach(d => {
                    const data = { id: d.id, ...d.data() };
                    const m = data.mode || 'fillable';
                    if (m === 'fillable') fillable.push(data);
                });
                if (fillable.length === 0) {
                    console.warn(`[FillablePdf] no fillable template found for ${docDef.id}`);
                    if (alive) { setTemplate(null); setLoading(false); }
                    return;
                }
                // Pick the most-recently-updated.
                let chosen = fillable[0];
                for (const data of fillable) {
                    if ((data.updatedAt || '') > (chosen.updatedAt || '')) chosen = data;
                }
                if (!alive) return;
                setTemplate(chosen);
                // Initialize values from autofill bindings.
                // Static fields are admin-prefilled at template time — they're
                // not editable here, so we don't pre-populate the values map
                // for them (PDF generation reads field.staticValue directly).
                const initial = {};
                // Sign once, reuse: the hire's adopted signature persists in
                // device localStorage so it pre-fills signature fields across docs
                // AND across sessions (re-open keeps the signature too).
                let storedSig = null;
                try { storedSig = localStorage.getItem('dd:sig:' + hireId); } catch { /* ignore */ }
                // Their exact prior entries (everything they typed last submit,
                // EXCEPT SSN which is never saved) so re-opening continues where
                // they left off — overrides autofill so edited values stick.
                const prior = (hire?.checklist && hire.checklist[docDef.id] && hire.checklist[docDef.id].savedFields) || {};
                (chosen.fields || []).forEach(f => {
                    if (f.filledBy === 'static') return;
                    if (f.autofill) initial[f.id] = autofillValue(f.autofill, hire);
                    if (Object.prototype.hasOwnProperty.call(prior, f.id)) initial[f.id] = prior[f.id];
                    else if (storedSig && f.type === 'signature' && f.filledBy !== 'employer') initial[f.id] = storedSig;
                });
                setValues(initial);
                // Render PDF background. getBytes() goes through the
                // Storage SDK's XHR-based download channel + has built-in
                // retry / metadata handling — cleaner than the old
                // getDownloadURL() + plain fetch() pattern.
                //
                // IMPORTANT — CORS DEPENDENCY: Storage SDK downloads from
                // cross-origin pages still require the GCS bucket itself
                // to have a CORS config that allows the deploy origin.
                // For the 2026-05-11 "no docs loading" outage, the bucket
                // had NO cors set — every download from
                // https://ddmauapp.github.io (and localhost dev) was
                // blocked by the browser even though the file fetched
                // fine via curl. Fix: run `npm run cors-setup` once to
                // push cors.json to the bucket via firebase-admin. See
                // scripts/setup-storage-cors.mjs.
                const buf = await getBytes(sref(storage, chosen.storagePath));
                if (!alive) return;
                setPdfBytes(buf);
                // Race PDF render against a 30s timeout. If pdf.js chunk
                // fails to load (offline, GH Pages flake) or a huge PDF
                // hangs, the hire would otherwise stare at the spinner
                // forever. The thrown error surfaces in the catch below
                // which sets `err` so the existing error UI offers a
                // retry. Cap-readiness audit 2026-05-31.
                await Promise.race([
                    renderPages(buf),
                    new Promise((_, rej) => setTimeout(
                        () => rej(new Error('PDF render timed out after 30 seconds. Please reload and try again.')),
                        30000,
                    )),
                ]);
            } catch (e) {
                console.error('template load failed', e);
                if (alive) setErr(String(e.message || e));
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [docDef.id, hire?.id, reloadKey]);

    const renderPages = async (buf) => {
        const pdfjs = await loadPdfJs();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
        const total = pdf.numPages;
        const imgs = [];
        // 1.4x is the right render scale here. A US Letter page at 1.4x is
        // ~856 × 1109 px — crisp on both the desktop card and a pinch-zoomed phone.
        for (let p = 1; p <= total; p++) {
            const page = await pdf.getPage(p);
            const viewport = page.getViewport({ scale: 1.4 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport }).promise;
            // JPEG, NOT PNG. Government forms are white-background, so there's no
            // transparency to preserve, and JPEG encodes ~5-10x faster and holds
            // far less memory than a full-page PNG — the slow part on a multi-page
            // form like the 5-page federal W-4. This image is PREVIEW-ONLY; the
            // submitted PDF is rebuilt from the original bytes via pdf-lib at submit
            // time, so this compression never touches the legal document.
            imgs.push(canvas.toDataURL('image/jpeg', 0.85));
            // Progressive: show each page the instant it's ready. The hire sees
            // page 1 and can start filling while pages 2..N render in the
            // background — perceived load time ≈ one page, not five.
            setPageImages(imgs.slice());
            if (p === 1) setLoading(false);
            setProgressMsg(p < total
                ? tx(`Loading page ${p + 1} of ${total}…`, `Cargando página ${p + 1} de ${total}…`)
                : '');
        }
        setProgressMsg('');
    };

    const setValue = (fieldId, value) => {
        setValues(prev => ({ ...prev, [fieldId]: value }));
        if (!submitting && typeof onStart === 'function') onStart();
    };

    // Validate required fields are filled before submit. Skip:
    //  • static  — pre-filled by admin at template time
    //  • employer — filled by admin AFTER hire submits (I-9 Section 2 pattern)
    //  • field.required !== true — by default fields are OPTIONAL. Admin
    //    explicitly marks the few must-have boxes as required in the
    //    template editor. On 50-field forms like the I-9 the required
    //    list is short (name, SSN, signature, date); having admin tick
    //    the small handful is faster than ticking 40+ "if applicable"
    //    boxes as optional.
    // Checkboxes can be left unchecked (we don't force).
    //
    // Note: fields predating the required toggle have no `required`
    // property at all — those are now treated as optional under the new
    // default. Admin can re-mark anything that should still block submit.
    const validate = () => {
        const missing = (template?.fields || []).filter(f => {
            if (f.filledBy === 'static') return false;
            if (f.filledBy === 'employer') return false;
            if (f.required !== true) return false;
            const v = values[f.id];
            if (f.type === 'checkbox') return false;
            return !v || (typeof v === 'string' && !v.trim());
        });
        return missing;
    };

    const submit = async () => {
        if (!template || !pdfBytes) return;
        const missing = validate();
        if (missing.length > 0) {
            setErr(tx(
                `Please fill in ${missing.length} more field(s) before submitting.`,
                `Por favor llena ${missing.length} campo(s) más antes de enviar.`,
            ));
            return;
        }
        setSubmitting(true);
        setErr('');
        setProgressMsg(tx('Generating PDF…', 'Generando PDF…'));
        try {
            const pdfLib = await loadPdfLib();
            const { PDFDocument, StandardFonts, rgb, PDFName } = pdfLib;
            const pdfDoc = await PDFDocument.load(pdfBytes);
            const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            const pages = pdfDoc.getPages();

            // One signing moment + record ID for the whole submission. Stamped
            // under each signature (DocuSign-style) AND reused on the Certificate
            // of Completion page + the Firestore audit event so they all agree.
            const signedAt = new Date();
            const signerName = hire?.personal?.legalName || hire?.name || '';
            const signId = 'DDM-' + signedAt.getTime().toString(36).toUpperCase()
                + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
            const stampWhen = signedAt.toLocaleString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            });

            for (const f of template.fields || []) {
                const page = pages[f.page];
                if (!page) continue;
                const { width: pw, height: ph } = page.getSize();
                // Field coords stored as fractions. PDF origin is bottom-
                // left, our frac coords are top-left, so we flip y.
                const x = f.x * pw;
                const yTop = f.y * ph;
                const w = f.w * pw;
                const h = f.h * ph;
                const yPdf = ph - yTop - h;

                // Static fields use the admin-set staticValue; employer
                // fields are skipped (admin completes them after submit);
                // everything else reads from the hire's `values` map.
                if (f.filledBy === 'employer') continue;
                const val = f.filledBy === 'static' ? f.staticValue : values[f.id];

                if (f.type === 'signature' || f.type === 'initials') {
                    if (!val || !val.startsWith('data:image')) continue;
                    const pngBytes = Uint8Array.from(atob(val.split(',')[1]), c => c.charCodeAt(0));
                    const sigImg = await pdfDoc.embedPng(pngBytes);
                    page.drawImage(sigImg, { x, y: yPdf, width: w, height: h });
                    // DocuSign-style inline stamp under the SIGNATURE (not the tiny
                    // initials): "Electronically signed by <name>" + exact date/time
                    // + a unique e-signature ID, so the signed line carries its own
                    // audit caption. The full record also lives on the appended
                    // Certificate of Completion page.
                    if (f.type === 'signature') {
                        const sz = 5.2;
                        const blue = rgb(0.13, 0.32, 0.55);
                        const grey = rgb(0.42, 0.45, 0.5);
                        const line1 = winAnsiSafe(helvBold, `Electronically signed by ${signerName}`);
                        const line2 = winAnsiSafe(helvetica, `${stampWhen}  -  ID ${signId}`);
                        // Default just below the signature box; if it's too close to
                        // the page bottom, stack it just above the box so it can never
                        // fall off-page.
                        let y1 = yPdf - 1.5 - sz;
                        if (y1 - sz - 1 < 4) y1 = yPdf + h + 1.5 + 2 * sz + 1;
                        page.drawText(line1, { x, y: y1, size: sz, font: helvBold, color: blue });
                        page.drawText(line2, { x, y: y1 - sz - 1, size: sz, font: helvetica, color: grey });
                    }
                } else if (f.type === 'checkbox') {
                    if (val) {
                        page.drawText('X', {
                            x: x + w * 0.15,
                            y: yPdf + h * 0.15,
                            size: Math.min(w, h) * 0.9,
                            font: helvetica,
                            color: rgb(0, 0, 0),
                        });
                    }
                } else {
                    // text, date, etc — render as plain text aligned top-left.
                    // winAnsiSafe so an emoji / non-Latin glyph can't throw and
                    // abort the whole submit (see helper above).
                    const text = winAnsiSafe(helvetica, val);
                    const fontSize = f.fontSize || Math.max(8, Math.min(h * 0.7 * 72 / 96, 12));
                    page.drawText(text, {
                        x: x + 1,
                        y: yPdf + (h - fontSize) - 1, // baseline near top
                        size: fontSize,
                        font: helvetica,
                        color: rgb(0, 0, 0),
                        maxWidth: w,
                    });
                }
            }

            // CRITICAL — strip the interactive form layer before saving.
            //
            // The official tax/I-9 templates (IRS W-4, MO W-4, I-9) are
            // fillable PDFs built on XFA + AcroForm. We render the hire's
            // answers by DRAWING them onto the static page above — but the
            // original interactive form layer is still inside pdfDoc, and it
            // breaks the returned file in the viewers managers actually use
            // (Preview / Quick Look / Acrobat), even though the in-app pdf.js
            // preview looks fine:
            //   • XFA — Adobe Acrobat renders the XFA layer and IGNORES our
            //     drawn text (pdf-lib cannot edit XFA), so the PDF opens blank.
            //   • Empty AcroForm field widgets paint their own (often opaque)
            //     appearance ON TOP of our drawn text, hiding it. The signature
            //     line has no covering widget, so it's the one thing that shows
            //     through — the exact "I only see his signature" report.
            // Removing the AcroForm (which also drops its /XFA) + every Widget
            // annotation leaves a plain, flat PDF: the full form graphics live
            // in the static page content, and the hire's drawn text/signature
            // are the only field content. Every viewer then renders it the same.
            // Guarded so any low-level hiccup falls back to the prior behavior,
            // and a no-op on non-fillable templates (offer letters, scans).
            // Hardened so it can NEVER throw and silently save an un-stripped
            // (blank-in-Acrobat) PDF: guard every pdf-lib call, and on any
            // per-annotation uncertainty KEEP the annotation rather than risk
            // dropping a real one. Only confirmed /Widget annotations are removed.
            try {
                if (pdfDoc.catalog.has(PDFName.of('AcroForm'))) {
                    pdfDoc.catalog.delete(PDFName.of('AcroForm'));
                }
                for (const page of pdfDoc.getPages()) {
                    const annots = page.node && page.node.Annots && page.node.Annots();
                    if (!annots || typeof annots.size !== 'function') continue;
                    const keep = [];
                    for (let i = 0; i < annots.size(); i++) {
                        const ref = annots.get(i);
                        let isWidget = false;
                        try {
                            const a = annots.lookup(i);
                            const sub = a && a.get && a.get(PDFName.of('Subtype'));
                            isWidget = !!sub && sub.toString() === '/Widget';
                        } catch { isWidget = false; }
                        if (!isWidget) keep.push(ref);
                    }
                    page.node.set(PDFName.of('Annots'), pdfDoc.context.obj(keep));
                }
            } catch (stripErr) {
                console.warn('form-layer strip skipped:', stripErr?.message || stripErr);
            }

            // updateFieldAppearances:false — there are no fields left to update
            // and it avoids pdf-lib re-touching anything on the way out.
            const outBytes = await pdfDoc.save({ updateFieldAppearances: false });

            // Wave 2 — tamper-evidence + Certificate of Completion. Fingerprint
            // the signed document, append a DocuSign-style certificate page, and
            // record a signature event. All guarded so a hiccup never blocks the
            // hire's submission (we just upload the plain signed PDF).
            let pdfHash = '';
            let finalBytes = outBytes;
            const sigCount = (template.fields || [])
                .filter((f) => (f.type === 'signature' || f.type === 'initials') && values[f.id]).length;
            try {
                const cert = await import('../data/signingCertificate');
                pdfHash = await cert.sha256HexBytes(outBytes);
                await cert.appendCompletionCertificate(pdfDoc, pdfLib, {
                    signerName,
                    docTitle: docDef.en,
                    signedAt,
                    signId,
                    contentHash: pdfHash,
                    signatureCount: sigCount,
                    platform: (typeof window !== 'undefined' && window.Capacitor?.getPlatform?.()) || 'web',
                });
                finalBytes = await pdfDoc.save({ updateFieldAppearances: false });
            } catch (certErr) {
                console.warn('completion certificate skipped:', certErr?.message || certErr);
                finalBytes = outBytes;
            }

            setProgressMsg(tx('Uploading…', 'Subiendo…'));
            const ts = Date.now();
            const path = `onboarding/${hireId}/${docDef.id}/filled_${ts}.pdf`;
            await uploadBytes(sref(storage, path), new Blob([finalBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });

            // Keep only the NEWEST submission — a re-fill/re-sign REPLACES the prior
            // one instead of piling up (Andrew 2026-06-30: "it's basically an update,
            // not a new copy"). This component only handles single-PDF 'template' docs,
            // so every file in this doc's folder is a prior version of the same doc —
            // safe to prune all but the one we just wrote. Best-effort; never blocks.
            try {
                const folder = sref(storage, `onboarding/${hireId}/${docDef.id}`);
                const listing = await listAll(folder);
                await Promise.all(
                    listing.items
                        .filter(it => it.fullPath !== path)
                        .map(it => deleteObject(it).catch(() => {}))
                );
            } catch (pruneErr) {
                console.warn('prune old submissions skipped:', pruneErr?.message || pruneErr);
            }

            // Tamper-evidence record + per-doc hash (best-effort, never blocks).
            try {
                await addDoc(collection(db, 'onboarding_signature_events'), {
                    hireId, hireName: hire?.name || '',
                    docId: docDef.id, docTitle: docDef.en, docVersion: `filled_${ts}`,
                    signatureCount: sigCount, pdfHash, pdfPath: path, signId,
                    signedAt: serverTimestamp(),
                    platform: (typeof window !== 'undefined' && window.Capacitor?.getPlatform?.()) || 'web',
                    userAgent: (typeof navigator !== 'undefined' ? navigator.userAgent : '').slice(0, 200),
                });
                // Remember the hire's exact entries so re-opening continues where
                // they left off (not just autofill). SSN + signatures are NEVER
                // saved here — SSN stays PDF-only per IRS/PII rules; the adopted
                // signature lives in device localStorage (sign-once).
                const savedFields = {};
                for (const f of template.fields || []) {
                    if (f.filledBy === 'static' || f.filledBy === 'employer') continue;
                    if (f.type === 'signature' || f.type === 'initials') continue;
                    if (isSensitiveField(f)) continue;
                    const v = values[f.id];
                    if (v !== undefined && v !== '') savedFields[f.id] = v;
                }
                const patch = {
                    [`checklist.${docDef.id}.savedFields`]: savedFields,
                    [`checklist.${docDef.id}.signedAt`]: new Date().toISOString(),
                };
                if (pdfHash) patch[`checklist.${docDef.id}.pdfHash`] = pdfHash;
                await updateDoc(doc(db, 'onboarding_hires', hireId), patch);
            } catch (logErr) {
                console.warn('signature event log skipped:', logErr?.message || logErr);
            }
            onSubmitted?.();
            // Swap to the "✓ Complete" view so the hire sees a clear
            // success state + an Edit button, instead of the same Submit
            // button which makes it look like nothing happened.
            setShowSubmitted(true);
        } catch (e) {
            console.error('submit failed', e);
            setErr(tx('Submit failed: ', 'Falló: ') + (e.message || e));
        } finally {
            setSubmitting(false);
            setProgressMsg('');
        }
    };

    if (loading) {
        return <p className="text-xs text-gray-500 italic py-3">{tx('Loading template…', 'Cargando plantilla…')}</p>;
    }
    if (!template) {
        // No template uploaded yet — give the hire a heads-up but allow
        // plain file upload as a fallback so they can still finish.
        return (
            <div className="space-y-2">
                <div className="p-2 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
                    {tx(
                        'This form isn\'t available to fill in-app yet. Your manager will reach out with paper or a PDF to sign.',
                        'Este formulario aún no se puede llenar en la app. Tu gerente te enviará el PDF o papel.',
                    )}
                </div>
            </div>
        );
    }
    if (!pageImages.length) {
        return (
            <div className="space-y-2 py-2">
                <p className="text-xs text-red-600">
                    {err || tx('Couldn\'t load this form. Check your connection and try again.',
                        'No se pudo cargar este formulario. Revisa tu conexión e intenta de nuevo.')}
                </p>
                <button onClick={() => { setErr(''); setReloadKey((k) => k + 1); }}
                    className="px-3 py-2 rounded-lg bg-mint-700 text-white text-sm font-bold active:scale-95">
                    ↻ {tx('Reload', 'Recargar')}
                </button>
            </div>
        );
    }

    // "✓ Complete" view — shown right after a successful submit AND on
    // re-opening any doc that's already in submitted/approved state.
    // Hire taps Edit to go back to the editable form (their typed values
    // are still in `values` state from the same session; a hard reload
    // re-fetches from the template + autofill only — submitted PDF text
    // isn't reparsed, that's a Phase-2 nicety).
    //
    // When isLocked (admin moved hire to Complete folder) the Edit
    // button is hidden — hire can still see the success state but can't
    // re-open the form. Unlocking happens admin-side, not here.
    if (showSubmitted || isLocked) {
        return (
            <div className="space-y-2">
                <div className="p-4 rounded-xl bg-green-50 border-2 border-green-300 text-center">
                    <p className="text-3xl mb-1">{isLocked ? '🔒' : '✓'}</p>
                    <p className="font-black text-green-800 text-sm">
                        {isLocked
                            ? tx('Locked', 'Bloqueado')
                            : tx('Complete', 'Completado')}
                    </p>
                    <p className="text-[11px] text-green-700 mt-1">
                        {isLocked
                            ? tx('Your onboarding is locked. Ask your manager to unlock if you need to update this.',
                                'Bloqueado. Pídele al gerente que desbloquee si necesitas actualizar.')
                            : tx('Submitted to your manager. They\'ll review and follow up.',
                                'Enviado al gerente. Revisará y te avisará.')}
                    </p>
                </div>
                {!isLocked && (
                    <button onClick={() => { setShowSubmitted(false); setErr(''); }}
                        className="w-full py-2.5 rounded-xl bg-white border-2 border-mint-700 text-mint-700 font-bold text-sm hover:bg-mint-50 active:scale-95">
                        ✏️ {tx('Edit / re-submit', 'Editar / re-enviar')}
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-2">
            {/* Returning-hire banner — values reset to autofill defaults on
                hard reload, and signature canvases come back blank. Without
                this hint hires saw the form, hit Submit, got "fill N more
                fields" errors on their own signature, and thought the form
                was broken. */}
            {wasSubmitted && (
                <div className="p-2 rounded-lg bg-amber-50 border-2 border-amber-300 text-[12px] text-amber-900">
                    <p className="font-bold">
                        ✏️ {tx('Editing your submitted form', 'Editando tu formulario enviado')}
                    </p>
                    <p className="text-[11px] mt-0.5">
                        {tx(
                            'Re-fill any signatures and check your values — text fields keep what you typed this session, but signatures and unsaved edits don\'t persist across reloads. Tap Submit again when ready.',
                            'Vuelve a firmar y revisa tus valores — los campos de texto guardan lo de esta sesión, las firmas no persisten al recargar. Envía de nuevo cuando estés listo.',
                        )}
                    </p>
                </div>
            )}
            <p className="text-[11px] text-gray-600">
                {tx(
                    'Fill the highlighted fields below. Tap a signature box to sign with your finger.',
                    'Llena los campos resaltados. Toca la caja de firma para firmar con tu dedo.',
                )}
            </p>
            {/* Mobile: NO nested scroll box. A `max-h overflow-y-auto` wrapper on a
                phone shrinks a Letter page to fit a 60vh window AND traps pinch-zoom
                (the gesture gets eaten by the inner scroller), so hires couldn't
                magnify the tiny printed labels. Letting the pages flow in the normal
                page scroll gives one scroll context → pinch-zoom works. Desktop keeps
                a contained scroll area (md:) where there's room. */}
            <div className="space-y-2 bg-gray-100 p-2 rounded-lg md:max-h-[75vh] md:overflow-y-auto">
                {pageImages.map((src, idx) => (
                    <div key={idx} className="relative bg-white shadow">
                        <img src={src} alt={`Page ${idx + 1}`} className="w-full h-auto block" draggable={false} />
                        {(template.fields || []).filter(f => f.page === idx).map(f => (
                            // Employer fields are hidden from the hire entirely —
                            // they don't even see the empty box. Admin completes
                            // them after the hire submits, in a separate flow.
                            f.filledBy === 'employer' ? null
                            : f.filledBy === 'static' ? (
                                <StaticOverlay key={f.id} field={f} isEs={isEs} />
                            ) : (
                                <FieldInput key={f.id}
                                    field={f}
                                    value={values[f.id]}
                                    onChange={(v) => setValue(f.id, v)}
                                    onOpenSig={() => setSigField(f)}
                                    signerName={hire?.personal?.legalName || hire?.name || ''}
                                    signedAtMs={sigStamps[f.id]}
                                    isEs={isEs} />
                            )
                        ))}
                    </div>
                ))}
            </div>

            {err && <p className="text-xs text-red-600">{err}</p>}
            {progressMsg && <p className="text-xs text-gray-500 italic">{progressMsg}</p>}
            <button onClick={submit} disabled={submitting}
                className="w-full py-3 rounded-xl bg-mint-700 text-white font-bold text-sm hover:bg-mint-700 active:scale-95 disabled:opacity-50">
                {submitting
                    ? tx('Submitting…', 'Enviando…')
                    : tx('✓ Submit signed form', '✓ Enviar formulario firmado')}
            </button>

            {sigField && (
                <SignatureModal
                    field={sigField}
                    isEs={isEs}
                    initial={values[sigField.id] || null}
                    onClose={() => setSigField(null)}
                    onSave={(dataUrl) => {
                        // Remember the adopted signature so the hire's other docs
                        // this session pre-fill it (sign once, reuse). Signatures
                        // only — initials stay per-field.
                        if (sigField.type === 'signature') {
                            try { localStorage.setItem('dd:sig:' + hireId, dataUrl); } catch { /* ignore */ }
                        }
                        setSigStamps(prev => ({ ...prev, [sigField.id]: Date.now() }));
                        setValue(sigField.id, dataUrl);
                        setSigField(null);
                    }} />
            )}
        </div>
    );
}

// StaticOverlay — read-only display of an admin-prefilled field.
// Hire sees the value (so they know what's there) but can't interact.
// Amber chrome so it visually reads as "locked" vs the yellow editable fields.
function StaticOverlay({ field, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const style = {
        left: `${field.x * 100}%`,
        top: `${field.y * 100}%`,
        width: `${field.w * 100}%`,
        height: `${field.h * 100}%`,
    };
    const isSig = field.type === 'signature' || field.type === 'initials';
    const hasSig = isSig && typeof field.staticValue === 'string' && field.staticValue.startsWith('data:image');
    return (
        <div className="absolute border border-amber-400 bg-amber-50/70 rounded flex items-center justify-center overflow-hidden"
             style={style}
             title={tx('Pre-filled by management', 'Pre-llenado por gerencia')}>
            {hasSig ? (
                <img src={field.staticValue} alt="" className="max-w-full max-h-full" />
            ) : field.type === 'checkbox' ? (
                <span className="text-base font-black text-amber-700">{field.staticValue ? 'X' : ''}</span>
            ) : (
                <span className="text-[10px] leading-tight text-amber-900 px-1 truncate w-full text-left"
                      style={{ fontSize: (field.fontSize || 11) + 'px' }}>
                    {field.staticValue || ''}
                </span>
            )}
            <span className="absolute -top-3 -right-1 bg-amber-500 text-white text-[8px] font-black px-1 py-0.5 rounded">
                🔒
            </span>
        </div>
    );
}

// FieldInput — overlay UI on top of the PDF page.
//
// Sensitive fields (SSN, etc. — see SSN_AUTOFILL_DENYLIST above) render
// as masked password inputs so the digits the hire types aren't visible
// on-screen / in screen-recordings / over a manager's shoulder. We also
// detect SSN intent from the field label as a fallback, because admins
// occasionally drop manual fields with no autofill binding.
function isSensitiveField(field) {
    if (isSensitiveAutofill(field?.autofill)) return true;
    const label = String(field?.label || '').toLowerCase();
    if (!label) return false;
    return /\bssn\b|social\s*security|\btin\b/.test(label);
}

function FieldInput({ field, value, onChange, onOpenSig, signerName, signedAtMs, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const style = {
        left: `${field.x * 100}%`,
        top: `${field.y * 100}%`,
        width: `${field.w * 100}%`,
        height: `${field.h * 100}%`,
    };
    if (field.type === 'signature' || field.type === 'initials') {
        const signed = value && typeof value === 'string' && value.startsWith('data:image');
        // DocuSign-style live caption UNDER a signed signature so the hire sees
        // the timestamp on-screen the moment they sign (the permanent stamp is
        // baked into the flattened PDF at submit; this mirrors it live). Only
        // for full signatures, not the tiny initials boxes.
        const stampText = (field.type === 'signature' && signed)
            ? `✓ ${tx('Electronically signed', 'Firmado electrónicamente')}`
                + (signerName ? ` — ${signerName}` : '')
                + (signedAtMs
                    ? ` · ${new Date(signedAtMs).toLocaleString(isEs ? 'es' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                    : '')
            : null;
        return (
            <>
            {stampText && (
                <div className="absolute pointer-events-none z-10"
                    // Anchor the caption's BOTTOM to the bottom edge of the signature
                    // box (translateY(-100%)) so it tucks right under the signature
                    // instead of dropping a full line into the table cell below.
                    style={{ left: `${field.x * 100}%`, top: `${(field.y + field.h) * 100}%`, transform: 'translateY(-100%)' }}>
                    <span className="inline-block whitespace-nowrap rounded bg-white/90 px-1 text-[8px] leading-tight font-semibold text-blue-800 border border-blue-200">
                        {stampText}
                    </span>
                </div>
            )}
            <button onClick={onOpenSig}
                // 2026-06-01 — Same readability fix as the text input
                // below. /60 was opaque enough to hide a printed
                // "Employee Signature" line on the PDF; dropped to /30
                // when empty so the label shows. When signed the
                // signature image already fills the field so /50 is
                // fine — the image dominates anyway.
                className={`absolute border rounded text-[10px] font-bold flex items-center justify-center transition ${
                    signed ? 'border-green-500 bg-green-100/50' : 'border-amber-500 bg-amber-100/30 animate-pulse'
                }`}
                // Same UA-min-height defeat as the text input below — without
                // it, mobile browsers grow the signature button past the
                // height we asked for, shoving it down over PDF text.
                style={{ ...style, minHeight: 0, minWidth: 0, padding: 0 }}>
                {signed ? (
                    <img src={value} alt="sig" className="max-w-full max-h-full" />
                ) : (
                    <span>{field.type === 'signature' ? tx('Tap to sign', 'Toca para firmar') : tx('Initials', 'Iniciales')}</span>
                )}
            </button>
            </>
        );
    }
    if (field.type === 'checkbox') {
        return (
            <label className="absolute flex items-center justify-center cursor-pointer"
                style={{ ...style, minHeight: 0, minWidth: 0 }}>
                <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)}
                    className="w-full h-full accent-mint-700"
                    style={{ minHeight: 0, minWidth: 0, margin: 0 }} />
            </label>
        );
    }
    // SSN / sensitive fields. 2026-06-30 — Andrew: hires couldn't see what
    // they were typing into the SSN box, so these now render as VISIBLE text
    // (previously a masked password field). The at-rest protection is UNCHANGED
    // and lives elsewhere: the SSN is NEVER stored or autofilled (the
    // SSN_AUTOFILL_DENYLIST + the isSensitiveField skip at the autofill site),
    // it only flows into the flattened PDF at submit time (the IRS requires the
    // plaintext there). We still keep inputMode numeric (simple mobile keypad)
    // and autoComplete 'new-password' so the browser won't cache the SSN.
    const sensitive = isSensitiveField(field);
    const inputType = field.type === 'date' ? 'date' : 'text';
    return (
        <input
            type={inputType}
            inputMode={sensitive ? 'numeric' : undefined}
            autoComplete={sensitive ? 'new-password' : undefined}
            spellCheck={sensitive ? false : undefined}
            value={value || ''}
            onChange={e => onChange(e.target.value)}
            // Mobile: when the on-screen keyboard opens it often hides an overlay
            // field in the lower half of the page. Scroll the focused field to the
            // middle of the viewport (after the keyboard has animated in) so the
            // hire can always see what they're typing.
            onFocus={e => { const el = e.currentTarget; setTimeout(() => { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ } }, 300); }}
            // 2026-06-01 — Andrew: "for the W4 missouri, when the text
            // bubble is over the doc anything under it cant be read.
            // if it asks for first name the text bubble is covering it up."
            //
            // The input used `bg-yellow-50/90` (90% opaque) so the
            // underlying PDF label was hidden. Hires opening the form
            // saw a row of yellow boxes with no indication of what each
            // field was asking. Fix: opacity conditional on value state.
            //   • Empty field (no value yet): bg-yellow-50/15 — nearly
            //     transparent, the underlying PDF label is fully readable
            //     so the hire knows what to type.
            //   • Filled field: bg-yellow-50/70 — opaque enough that the
            //     typed text reads clearly without colliding with the
            //     printed label underneath.
            // Border colour change (amber → green) is preserved as the
            // secondary fill-state cue.
            className={`absolute border rounded px-1 text-[11px] ${
                value
                    ? 'border-green-500 bg-yellow-50/70'
                    : 'border-amber-500 bg-yellow-50/15 placeholder-amber-700/60'
            }`}
            // iOS Safari (and some Android browsers) enforce a UA min-height
            // (~32–36px) on text/date inputs to keep them tappable. That
            // min-height OVERRIDES the explicit `height: X%` we set here, so
            // a field stored at h≈0.022 (~25px on a phone-wide PDF preview)
            // renders as a 32-36px box that pushes past its slot.
            //
            // That's why the editor — which uses <div> markers, no UA
            // min-height — shows perfectly-aligned boxes, but the hire
            // portal on mobile shows them slightly oversized and shifted.
            // Forcing min-height/min-width to 0 + line-height: 1 makes the
            // input honor our exact pixel dimensions. box-sizing is already
            // border-box from Tailwind preflight so border+padding count
            // INSIDE the explicit height — no extra shift.
            style={{
                ...style,
                minHeight: 0,
                minWidth: 0,
                lineHeight: 1,
                // iOS Safari auto-zooms the whole page whenever a focused input's
                // font is < 16px — and with our overlay it never zooms back, so a
                // hire's view jumped/rescaled on EVERY field tap. Render the on-
                // screen text at ≥16px to kill that zoom. This is the input's CSS
                // only; the flattened PDF still draws at the field's own fontSize
                // at submit time, so the printed document is unchanged.
                fontSize: Math.max(16, field.fontSize || 11) + 'px',
            }}
            placeholder={field.label || ''} />
    );
}

// SignatureModal — canvas-based signature pad. Saves as a transparent PNG
// data URL on Done. Works on touch + mouse.
function SignatureModal({ field, initial, isEs, onClose, onSave }) {
    const tx = (en, es) => (isEs ? es : en);
    const canvasRef = useRef(null);
    const drawing = useRef(false);
    const lastPoint = useRef(null);
    const [empty, setEmpty] = useState(!initial);
    const [mode, setMode] = useState('draw');   // 'draw' | 'type' — DocuSign-style "adopt your signature"
    const [typed, setTyped] = useState('');
    const isInitials = field.type === 'initials';

    useEffect(() => {
        if (mode !== 'draw') return;
        const c = canvasRef.current;
        if (!c) return;
        // Match canvas backing pixel size to its display size for crisp lines.
        const r = c.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        c.width = r.width * dpr;
        c.height = r.height * dpr;
        const ctx = c.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#1f2937';
        if (initial) {
            const img = new Image();
            img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height);
            img.src = initial;
        }
    }, [mode]);

    // Lock the page behind the signature sheet while it's open — otherwise, on a
    // phone, drawing near the canvas edge or resting a palm scrolls/rubber-bands
    // the page under the finger and the stroke jumps.
    useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, []);

    const pos = (e) => {
        const c = canvasRef.current;
        const r = c.getBoundingClientRect();
        const t = e.touches ? e.touches[0] : e;
        return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const start = (e) => {
        e.preventDefault();
        drawing.current = true;
        lastPoint.current = pos(e);
        setEmpty(false);
    };
    const move = (e) => {
        if (!drawing.current) return;
        e.preventDefault();
        const c = canvasRef.current.getContext('2d');
        const p = pos(e);
        c.beginPath();
        c.moveTo(lastPoint.current.x, lastPoint.current.y);
        c.lineTo(p.x, p.y);
        c.stroke();
        lastPoint.current = p;
    };
    const end = () => { drawing.current = false; lastPoint.current = null; };
    const clear = () => {
        const c = canvasRef.current;
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
        setEmpty(true);
    };
    // Render a typed name in a script style to an offscreen canvas → PNG.
    const renderTyped = () => {
        const name = typed.trim();
        if (!name) return null;
        const oc = document.createElement('canvas');
        oc.width = 620; oc.height = 170;
        const ctx = oc.getContext('2d');
        ctx.fillStyle = '#1f2937';
        ctx.textBaseline = 'middle';
        let fs = 72;
        const setFont = () => { ctx.font = `italic ${fs}px "Brush Script MT","Snell Roundhand","Segoe Script","Apple Chancery",cursive`; };
        setFont();
        while (ctx.measureText(name).width > 580 && fs > 22) { fs -= 4; setFont(); }
        ctx.fillText(name, 20, oc.height / 2);
        return oc.toDataURL('image/png');
    };
    const canDone = mode === 'type' ? !!typed.trim() : !empty;
    const save = () => {
        if (mode === 'type') { const url = renderTyped(); if (url) onSave(url); return; }
        if (empty) return;
        onSave(canvasRef.current.toDataURL('image/png'));
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-3">
            <div className="bg-white w-full sm:max-w-md rounded-2xl">
                <div className="p-3 border-b border-gray-200">
                    <h3 className="font-bold text-sm">
                        ✍️ {isInitials ? tx('Add your initials', 'Agrega tus iniciales') : tx('Adopt your signature', 'Adopta tu firma')}
                    </h3>
                    <div className="mt-2 inline-flex rounded-lg bg-gray-100 p-0.5 text-[12px] font-bold">
                        <button onClick={() => setMode('draw')}
                            className={`px-3 py-1 rounded-md ${mode === 'draw' ? 'bg-white shadow text-mint-700' : 'text-gray-500'}`}>
                            {tx('Draw', 'Dibujar')}
                        </button>
                        <button onClick={() => setMode('type')}
                            className={`px-3 py-1 rounded-md ${mode === 'type' ? 'bg-white shadow text-mint-700' : 'text-gray-500'}`}>
                            {tx('Type', 'Escribir')}
                        </button>
                    </div>
                </div>
                <div className="p-3">
                    {mode === 'draw' ? (
                        <canvas
                            ref={canvasRef}
                            className="w-full h-44 bg-gray-50 border-2 border-dashed border-mint-300 rounded-lg touch-none"
                            onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
                            onTouchStart={start} onTouchMove={move} onTouchEnd={end} onTouchCancel={end}
                        />
                    ) : (
                        <div>
                            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)}
                                placeholder={isInitials ? tx('Your initials', 'Tus iniciales') : tx('Type your full name', 'Escribe tu nombre completo')}
                                className="w-full text-base px-3 py-2.5 rounded-xl border-2 border-gray-200 focus:border-mint-500 outline-none" />
                            <div className="mt-2 h-28 bg-gray-50 border-2 border-dashed border-mint-300 rounded-lg flex items-center justify-center overflow-hidden px-2">
                                <span style={{ fontFamily: '"Brush Script MT","Snell Roundhand","Segoe Script","Apple Chancery",cursive', fontStyle: 'italic', fontSize: '38px', color: typed.trim() ? '#1f2937' : '#9ca3af' }}>
                                    {typed.trim() || tx('Preview', 'Vista previa')}
                                </span>
                            </div>
                        </div>
                    )}
                    <p className="text-[10px] text-gray-400 mt-2 leading-tight">
                        {tx(
                            'By tapping Done, you agree this is your legal electronic signature (ESIGN Act / UETA).',
                            'Al tocar Listo, aceptas que esta es tu firma electrónica legal (ESIGN Act / UETA).',
                        )}
                    </p>
                </div>
                <div className="p-3 border-t border-gray-200 flex gap-2">
                    {mode === 'draw' && (
                        <button onClick={clear}
                            className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold">
                            {tx('Clear', 'Borrar')}
                        </button>
                    )}
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 text-sm font-bold">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={save} disabled={!canDone}
                        className="flex-1 py-2 rounded-lg bg-mint-700 text-white text-sm font-bold disabled:opacity-50">
                        {tx('Done', 'Listo')}
                    </button>
                </div>
            </div>
        </div>
    );
}
