// OnboardingFillablePdf — hire-side renderer for template-backed docs.
//
// Loads the template's source PDF + field positions, renders each page as
// a background image with absolute-positioned input fields on top. The
// hire fills inputs / draws their signature. On submit:
//   1. Use pdf-lib to write each field's value onto the corresponding
//      page at the stored fractional coordinates
//   2. Embed signature/initials canvas images as PNG
//   3. Flatten + save as a new PDF
//   4. Upload to onboarding/{hireId}/{docId}/filled_{ts}.pdf
//
// Falls back to plain file upload if no template exists yet (so the admin
// can ship the doc without templates being built first).

import { useEffect, useMemo, useRef, useState } from 'react';
import { db, storage } from '../firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { ref as sref, uploadBytes, getDownloadURL, getBytes } from 'firebase/storage';
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
function autofillValue(autofillId, hire) {
    if (!autofillId) return '';
    const p = hire?.personal || {};
    const firstName = (p.legalName || hire?.name || '').split(' ')[0] || '';
    const lastName = (p.legalName || hire?.name || '').split(' ').slice(-1)[0] || '';
    const ssn = hire?.ssn || p.ssn || '';
    const today = new Date().toISOString().slice(0, 10);
    const locInfo = (hire?.location && LOCATION_INFO[hire.location]) || null;
    const map = {
        legalName: p.legalName || hire?.name || '',
        firstName, lastName,
        addressLine: p.addressLine || '',
        city: p.city || '',
        state: p.state || '',
        zip: p.zip || '',
        dob: p.dob || '',
        phone: p.phone || hire?.phone || '',
        email: p.email || hire?.email || '',
        ssn,
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

export default function OnboardingFillablePdf({
    docDef,        // ONBOARDING_DOCS entry (kind: 'template')
    hire,
    hireId,
    isEs,
    onSubmitted,
    onStart,
}) {
    const tx = (en, es) => (isEs ? es : en);
    const [template, setTemplate] = useState(null);        // { id, fields, storagePath, pageDims }
    const [pageImages, setPageImages] = useState([]);
    const [pdfBytes, setPdfBytes] = useState(null);
    const [loading, setLoading] = useState(true);
    const [values, setValues] = useState({});               // fieldId -> string (or data URL for signature)
    const [submitting, setSubmitting] = useState(false);
    const [progressMsg, setProgressMsg] = useState('');
    const [err, setErr] = useState('');
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
                console.log(`[FillablePdf] loaded template for ${docDef.id}:`, chosen.name);
                setTemplate(chosen);
                // Initialize values from autofill bindings.
                // Static fields are admin-prefilled at template time — they're
                // not editable here, so we don't pre-populate the values map
                // for them (PDF generation reads field.staticValue directly).
                const initial = {};
                (chosen.fields || []).forEach(f => {
                    if (f.filledBy === 'static') return;
                    if (f.autofill) initial[f.id] = autofillValue(f.autofill, hire);
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
                await renderPages(buf);
            } catch (e) {
                console.error('template load failed', e);
                if (alive) setErr(String(e.message || e));
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [docDef.id, hire?.id]);

    const renderPages = async (buf) => {
        const pdfjs = await loadPdfJs();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
        const imgs = [];
        // 1.4x is the right render scale here. A US Letter page at 1.4x
        // is ~856 × 1109 px, which fills the desktop portal's
        // md:max-w-4xl card (~880 px inner width) at ~100% — already
        // crisp. We tried 2x for desktop but rendering 3-4 PDFs
        // concurrently at 2x was punishing CPU + memory with no visible
        // improvement, so we held the line at 1.4x. The visual "make
        // the docs bigger" win lives in the portal's responsive
        // max-width bump, not in raster supersampling.
        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const viewport = page.getViewport({ scale: 1.4 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport }).promise;
            imgs.push(canvas.toDataURL('image/png'));
        }
        setPageImages(imgs);
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
            const { PDFDocument, StandardFonts, rgb } = pdfLib;
            const pdfDoc = await PDFDocument.load(pdfBytes);
            const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const pages = pdfDoc.getPages();

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
                    // text, date, etc — render as plain text aligned top-left
                    const text = String(val || '');
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

            const outBytes = await pdfDoc.save();
            setProgressMsg(tx('Uploading…', 'Subiendo…'));
            const ts = Date.now();
            const path = `onboarding/${hireId}/${docDef.id}/filled_${ts}.pdf`;
            await uploadBytes(sref(storage, path), new Blob([outBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
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
        return <p className="text-xs text-red-600 py-3">{tx('Failed to render template.', 'Falló la plantilla.')}</p>;
    }

    // "✓ Complete" view — shown right after a successful submit AND on
    // re-opening any doc that's already in submitted/approved state.
    // Hire taps Edit to go back to the editable form (their typed values
    // are still in `values` state from the same session; a hard reload
    // re-fetches from the template + autofill only — submitted PDF text
    // isn't reparsed, that's a Phase-2 nicety).
    if (showSubmitted) {
        return (
            <div className="space-y-2">
                <div className="p-4 rounded-xl bg-green-50 border-2 border-green-300 text-center">
                    <p className="text-3xl mb-1">✓</p>
                    <p className="font-black text-green-800 text-sm">
                        {tx('Complete', 'Completado')}
                    </p>
                    <p className="text-[11px] text-green-700 mt-1">
                        {tx(
                            'Submitted to your manager. They\'ll review and follow up.',
                            'Enviado al gerente. Revisará y te avisará.',
                        )}
                    </p>
                </div>
                <button onClick={() => { setShowSubmitted(false); setErr(''); }}
                    className="w-full py-2.5 rounded-xl bg-white border-2 border-mint-700 text-mint-700 font-bold text-sm hover:bg-mint-50 active:scale-95">
                    ✏️ {tx('Edit / re-submit', 'Editar / re-enviar')}
                </button>
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
            <div className="space-y-2 bg-gray-100 p-2 rounded-lg max-h-[60vh] overflow-y-auto">
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
                    onSave={(dataUrl) => { setValue(sigField.id, dataUrl); setSigField(null); }} />
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
        <div className="absolute border-2 border-amber-400 bg-amber-50/70 rounded flex items-center justify-center overflow-hidden"
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
function FieldInput({ field, value, onChange, onOpenSig, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const style = {
        left: `${field.x * 100}%`,
        top: `${field.y * 100}%`,
        width: `${field.w * 100}%`,
        height: `${field.h * 100}%`,
    };
    if (field.type === 'signature' || field.type === 'initials') {
        const signed = value && typeof value === 'string' && value.startsWith('data:image');
        return (
            <button onClick={onOpenSig}
                className={`absolute border-2 rounded text-[10px] font-bold flex items-center justify-center transition ${
                    signed ? 'border-green-500 bg-green-100/60' : 'border-amber-500 bg-amber-100/60 animate-pulse'
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
    return (
        <input
            type={field.type === 'date' ? 'date' : 'text'}
            value={value || ''}
            onChange={e => onChange(e.target.value)}
            className={`absolute border-2 rounded px-1 text-[11px] bg-yellow-50/90 ${
                value ? 'border-green-500' : 'border-amber-500'
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
                fontSize: (field.fontSize || 11) + 'px',
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

    useEffect(() => {
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
    const save = () => {
        if (empty) return;
        // Export at modest resolution — the embedded PNG only needs to read
        // clearly at field box dimensions; high-res is bandwidth waste.
        const dataUrl = canvasRef.current.toDataURL('image/png');
        onSave(dataUrl);
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-3">
            <div className="bg-white w-full sm:max-w-md rounded-2xl">
                <div className="p-3 border-b border-gray-200">
                    <h3 className="font-bold text-sm">
                        ✍️ {field.type === 'initials' ? tx('Sign your initials', 'Firma con tus iniciales') : tx('Sign here', 'Firma aquí')}
                    </h3>
                    <p className="text-[11px] text-gray-500">{tx('Use your finger or mouse.', 'Usa tu dedo o el mouse.')}</p>
                </div>
                <div className="p-3">
                    <canvas
                        ref={canvasRef}
                        className="w-full h-44 bg-gray-50 border-2 border-dashed border-mint-300 rounded-lg touch-none"
                        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
                        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
                    />
                </div>
                <div className="p-3 border-t border-gray-200 flex gap-2">
                    <button onClick={clear}
                        className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold">
                        {tx('Clear', 'Borrar')}
                    </button>
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 text-sm font-bold">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={save} disabled={empty}
                        className="flex-1 py-2 rounded-lg bg-mint-700 text-white text-sm font-bold disabled:opacity-50">
                        {tx('Done', 'Listo')}
                    </button>
                </div>
            </div>
        </div>
    );
}
