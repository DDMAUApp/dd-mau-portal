// OnboardingEmployerFill — admin completes employer-only fields on a
// template AFTER the hire has submitted their portion.
//
// Use case: I-9 Section 2. The hire fills Section 1, signs, submits.
// Admin reviews their docs, then comes here to fill in document details,
// employer signature, etc. — all the fields marked filledBy='employer'
// in the template editor.
//
// Flow:
//   1. Load the template definition (we need field positions)
//   2. Load the hire's submitted PDF as the background image (so admin
//      sees what the hire filled before completing their part)
//   3. Render ONLY employer-fill fields as interactive inputs
//   4. Admin fills, signs (same Draw/Type pad the hire uses), hits Finalize
//   5. We open the hire's submitted PDF with pdf-lib, draw the employer
//      values on top — signatures get the same DocuSign-style
//      "Electronically signed by" stamp as hire signatures, with the
//      ADMIN's staff name as signer — upload as a NEW version
//      (complete_TS.pdf)
//   6. Audit log entry + status flip to 'approved' + employerCompleted*
//      markers on the checklist entry (cleared again if the hire
//      re-submits — see OnboardingPortal's setDocStatus)
//
// The hire's original submission is preserved alongside the completed
// version so we have an audit trail of who filled what when (the admin
// Files expander prunes per-kind, never across — partitionTemplateFiles).

import { useEffect, useState } from 'react';
import { db, storage } from '../firebase';
import { collection, query, where, getDocs, updateDoc, doc, addDoc, serverTimestamp } from 'firebase/firestore';
import { ref as sref, uploadBytes, getBytes, listAll, getMetadata } from 'firebase/storage';
import { DOC_STATUS } from '../data/onboarding';
import ModalPortal from './ModalPortal';
import { SignatureModal } from './OnboardingFillablePdf';

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

// Keep drawText from throwing on emoji / non-Latin glyphs (WinAnsi can't encode
// them), which would abort the whole finalize. See OnboardingFillablePdf for the
// full rationale.
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

export default function OnboardingEmployerFill({
    docDef,
    hire,
    hireId,
    isEs,
    staffName,
    onWriteAudit,
    onClose,
    onCompleted,
}) {
    const tx = (en, es) => (isEs ? es : en);
    const [template, setTemplate] = useState(null);     // template doc with fields
    const [pdfBytes, setPdfBytes] = useState(null);     // hire's submitted PDF
    const [pageImages, setPageImages] = useState([]);
    const [values, setValues] = useState({});           // employer field inputs
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [err, setErr] = useState('');
    const [sigField, setSigField] = useState(null);

    // Load template + hire's submitted PDF together.
    useEffect(() => {
        let alive = true;
        (async () => {
            setLoading(true);
            setErr('');
            try {
                // 1. Find the fillable template for this doc.
                const tSnap = await getDocs(query(
                    collection(db, 'onboarding_templates'),
                    where('forDocId', '==', docDef.id),
                ));
                const fillable = [];
                tSnap.forEach(d => {
                    const data = { id: d.id, ...d.data() };
                    if ((data.mode || 'fillable') === 'fillable') fillable.push(data);
                });
                if (fillable.length === 0) {
                    throw new Error('No fillable template found for this doc.');
                }
                let chosen = fillable[0];
                for (const data of fillable) {
                    if ((data.updatedAt || '') > (chosen.updatedAt || '')) chosen = data;
                }
                if (!alive) return;
                setTemplate(chosen);

                // 2. Find the hire's most-recent submitted PDF in Storage.
                const folderRef = sref(storage, `onboarding/${hireId}/${docDef.id}`);
                const list = await listAll(folderRef);
                if (list.items.length === 0) {
                    throw new Error('Hire has not submitted this doc yet.');
                }
                // Prefer files starting with "filled_" (hire's submission)
                // over "complete_" (already-finalized). If admin re-opens
                // after a previous complete, we re-process from the hire's
                // original to avoid drawing on top of already-drawn values.
                const submittedItems = await Promise.all(list.items.map(async (it) => {
                    let m = null;
                    try { m = await getMetadata(it); } catch {}
                    return { it, name: it.name, updated: m?.updated || '' };
                }));
                submittedItems.sort((a, b) => {
                    const aFilled = a.name.startsWith('filled_') ? 1 : 0;
                    const bFilled = b.name.startsWith('filled_') ? 1 : 0;
                    if (aFilled !== bFilled) return bFilled - aFilled;
                    return (b.updated || '').localeCompare(a.updated || '');
                });
                const chosenFile = submittedItems[0];
                // Same CORS-resistant SDK path used by OnboardingFillablePdf
                // and the template editor — see those for rationale.
                const buf = await getBytes(chosenFile.it);
                if (!alive) return;
                setPdfBytes(buf);

                // 3. Render hire's PDF as backdrop.
                const pdfjs = await loadPdfJs();
                const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
                const imgs = [];
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
                if (!alive) return;
                setPageImages(imgs);
            } catch (e) {
                console.error('employer-fill load failed', e);
                if (alive) setErr(e.message || String(e));
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [docDef.id, hireId]);

    // Restrict to fields actually marked employer-fill.
    const employerFields = (template?.fields || []).filter(f => f.filledBy === 'employer');

    const setValue = (fieldId, v) => setValues(prev => ({ ...prev, [fieldId]: v }));

    const submit = async () => {
        if (!template || !pdfBytes) return;
        // Validate — same rule as the hire side: only fields explicitly
        // marked `required` in the template editor block finalize. The
        // real I-9 Section 2 has ~28 employer fields of which most stay
        // legitimately BLANK (you fill ONE List A document OR List B+C;
        // every "if any" box is conditional), so requiring all of them
        // made the doc impossible to finalize honestly.
        const missing = employerFields.filter(f => {
            if (f.type === 'checkbox') return false;
            if (f.required !== true) return false;
            const v = values[f.id];
            return !v || (typeof v === 'string' && !v.trim());
        });
        if (missing.length > 0) {
            setErr(tx(
                `Fill ${missing.length} more required field${missing.length === 1 ? '' : 's'} before finalizing.`,
                `Llena ${missing.length} campo${missing.length === 1 ? '' : 's'} requerido${missing.length === 1 ? '' : 's'} antes de finalizar.`,
            ));
            return;
        }
        // With no required flags set, still refuse an entirely blank
        // finalize — a complete_ PDF with an untouched Section 2 would
        // read as done in the admin list while being federally empty.
        const anyFilled = employerFields.some(f => {
            const v = values[f.id];
            return f.type === 'checkbox' ? !!v : !!(v && String(v).trim());
        });
        if (!anyFilled) {
            setErr(tx(
                'Nothing is filled in yet — complete the employer fields first.',
                'Aún no has llenado nada — completa los campos del empleador primero.',
            ));
            return;
        }
        setSubmitting(true);
        setErr('');
        try {
            const pdfLib = await loadPdfLib();
            const { PDFDocument, StandardFonts, rgb, PDFName } = pdfLib;
            const pdfDoc = await PDFDocument.load(pdfBytes);
            const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
            const pages = pdfDoc.getPages();

            // One signing moment + record ID for the employer completion —
            // same scheme as the hire-side submit so the inline stamp, the
            // Certificate of Completion page, and the Firestore signature
            // event all agree. Signer here is the ADMIN, not the hire.
            const signedAt = new Date();
            const signId = 'DDM-' + signedAt.getTime().toString(36).toUpperCase()
                + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
            const stampWhen = signedAt.toLocaleString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            });

            for (const f of employerFields) {
                const page = pages[f.page];
                if (!page) continue;
                const { width: pw, height: ph } = page.getSize();
                const x = f.x * pw;
                const yTop = f.y * ph;
                const w = f.w * pw;
                const h = f.h * ph;
                const yPdf = ph - yTop - h;
                const val = values[f.id];
                if (f.type === 'signature' || f.type === 'initials') {
                    if (!val || !val.startsWith('data:image')) continue;
                    const pngBytes = Uint8Array.from(atob(val.split(',')[1]), c => c.charCodeAt(0));
                    const sigImg = await pdfDoc.embedPng(pngBytes);
                    page.drawImage(sigImg, { x, y: yPdf, width: w, height: h });
                    // Same DocuSign-style inline stamp the hire's signature
                    // gets, so the employer signature line carries its own
                    // audit caption too — signer is the ADMIN's staff name.
                    if (f.type === 'signature') {
                        const sz = 5.2;
                        const blue = rgb(0.13, 0.32, 0.55);
                        const grey = rgb(0.42, 0.45, 0.5);
                        const line1 = winAnsiSafe(helvBold, `Electronically signed by ${staffName}`);
                        const line2 = winAnsiSafe(helvetica, `${stampWhen}  -  ID ${signId}`);
                        // Just below the box; if too close to the page bottom,
                        // stack it just above so it can never fall off-page.
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
                    const text = winAnsiSafe(helvetica, val);
                    const fontSize = f.fontSize || Math.max(8, Math.min(h * 0.7, 12));
                    page.drawText(text, {
                        x: x + 1,
                        y: yPdf + (h - fontSize) - 1,
                        size: fontSize,
                        font: helvetica,
                        color: rgb(0, 0, 0),
                        maxWidth: w,
                    });
                }
            }

            // Strip the interactive form layer (XFA + AcroForm + Widget
            // annotations) so the completed PDF is flat and renders the drawn
            // values identically in every viewer. See OnboardingFillablePdf for
            // the full rationale ("I only see his signature" blank-doc bug).
            // Hardened so it can never throw + silently save an un-stripped PDF.
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

            const outBytes = await pdfDoc.save({ updateFieldAppearances: false });

            // Wave 2 — tamper-evidence + Certificate of Completion (employer signing).
            let pdfHash = '';
            let finalBytes = outBytes;
            const sigCount = employerFields
                .filter((f) => (f.type === 'signature' || f.type === 'initials') && values[f.id]).length;
            try {
                const cert = await import('../data/signingCertificate');
                pdfHash = await cert.sha256HexBytes(outBytes);
                await cert.appendCompletionCertificate(pdfDoc, pdfLib, {
                    signerName: staffName + ' (employer)',
                    docTitle: (docDef.en || docDef.id) + ' - Employer Section',
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

            const ts = Date.now();
            const path = `onboarding/${hireId}/${docDef.id}/complete_${ts}.pdf`;
            await uploadBytes(sref(storage, path), new Blob([finalBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
            try {
                await addDoc(collection(db, 'onboarding_signature_events'), {
                    hireId, hireName: hire?.name || '', signerRole: 'employer', signerName: staffName,
                    docId: docDef.id, docTitle: docDef.en, docVersion: `complete_${ts}`,
                    signatureCount: sigCount, pdfHash, pdfPath: path, signId, signedAt: serverTimestamp(),
                    platform: (typeof window !== 'undefined' && window.Capacitor?.getPlatform?.()) || 'web',
                });
            } catch (logErr) { console.warn('signature event log skipped:', logErr?.message || logErr); }

            // Flip the doc's checklist to approved + audit who completed it.
            // employerPdfPath is the Storage PATH, deliberately not a
            // download URL — the raw file (I-9 = SSN + document numbers)
            // stays behind just-in-time getDownloadURL like everything else
            // in this subsystem; a stored URL would be a durable bearer link
            // to PII sitting in Firestore.
            await updateDoc(doc(db, 'onboarding_hires', hireId), {
                [`checklist.${docDef.id}.status`]: DOC_STATUS.APPROVED,
                [`checklist.${docDef.id}.employerCompletedBy`]: staffName,
                [`checklist.${docDef.id}.employerCompletedAt`]: new Date().toISOString(),
                [`checklist.${docDef.id}.employerPdfPath`]: path,
                ...(pdfHash ? { [`checklist.${docDef.id}.employerPdfHash`]: pdfHash } : {}),
            });
            if (typeof onWriteAudit === 'function') {
                onWriteAudit('employer_section_completed', {
                    hireId, docId: docDef.id, hireName: hire?.name,
                    employerFieldCount: employerFields.length,
                });
            }
            onCompleted?.();
        } catch (e) {
            console.error('employer fill submit failed', e);
            setErr(tx('Failed: ', 'Falló: ') + (e.message || e));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        // ModalPortal so `position: fixed` measures against the viewport —
        // the Onboarding page sits inside glass-card backdrop-filter
        // ancestors that would otherwise hijack the containing block and
        // strand this sheet off-screen on a scrolled page (see ModalPortal).
        <ModalPortal onBackPress={onClose}>
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3">
            <div className="bg-white w-full max-w-3xl rounded-2xl flex flex-col max-h-[95vh]">
                <div className="border-b border-gray-200 p-3 flex items-center justify-between gap-2 flex-shrink-0">
                    <div className="min-w-0">
                        <h3 className="font-black text-sm sm:text-base text-dd-text truncate">
                            👔 {tx('Complete employer section', 'Completar sección del empleador')}
                        </h3>
                        <p className="text-[11px] text-dd-text-2 truncate">
                            {hire?.name} · {isEs ? docDef.es : docDef.en}
                        </p>
                    </div>
                    <button onClick={onClose} className="w-9 h-9 rounded-full bg-gray-100 text-gray-600 text-lg flex-shrink-0">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                    {loading && <p className="text-xs text-gray-500 italic">{tx('Loading…', 'Cargando…')}</p>}
                    {!loading && err && <p className="text-xs text-red-600">{err}</p>}
                    {!loading && template && pageImages.length > 0 && employerFields.length === 0 && (
                        <p className="text-xs text-gray-500 italic">
                            {tx('No employer-fill fields on this template. Nothing to complete.',
                                'No hay campos para el empleador. Nada que completar.')}
                        </p>
                    )}
                    {!loading && pageImages.length > 0 && employerFields.length > 0 && (
                        <>
                            <div className="bg-purple-50 border border-purple-200 rounded-lg p-2 text-[11px] text-purple-900">
                                {tx(
                                    `${employerFields.length} field${employerFields.length === 1 ? '' : 's'} need your input. The hire's already-filled values show in the background; only the purple boxes are yours to complete.`,
                                    `${employerFields.length} campo${employerFields.length === 1 ? '' : 's'} requieren tu información. Lo que ya llenó el contratado se ve de fondo; solo las cajas moradas te tocan a ti.`,
                                )}
                            </div>
                            <div className="space-y-2 bg-gray-100 p-2 rounded-lg">
                                {pageImages.map((src, idx) => (
                                    <div key={idx} className="relative bg-white shadow">
                                        <img src={src} alt={`Page ${idx + 1}`} className="w-full h-auto block" draggable={false} />
                                        {employerFields.filter(f => f.page === idx).map(f => (
                                            <EmployerFieldInput key={f.id}
                                                field={f}
                                                value={values[f.id]}
                                                onChange={(v) => setValue(f.id, v)}
                                                onOpenSig={() => setSigField(f)}
                                                isEs={isEs} />
                                        ))}
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>
                <div className="border-t border-gray-200 p-3 flex gap-2 flex-shrink-0">
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold text-sm">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={submit} disabled={submitting || loading || employerFields.length === 0}
                        className="flex-1 py-2 rounded-lg bg-purple-600 text-white font-bold text-sm disabled:opacity-50">
                        {submitting ? tx('Finalizing…', 'Finalizando…') : tx('✓ Finalize doc', '✓ Finalizar documento')}
                    </button>
                </div>
            </div>
            {sigField && (
                // The hire-side pad, reused verbatim — Draw + Type modes,
                // ESIGN consent line. Renders after the sheet in the same
                // portal so DOM order stacks it on top.
                <SignatureModal field={sigField} isEs={isEs}
                    initial={values[sigField.id] || null}
                    onClose={() => setSigField(null)}
                    onSave={(dataUrl) => { setValue(sigField.id, dataUrl); setSigField(null); }} />
            )}
        </div>
        </ModalPortal>
    );
}

function EmployerFieldInput({ field, value, onChange, onOpenSig, isEs }) {
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
                // Empty-state opacity dropped to /30 so the printed
                // "Signature of Employer" line underneath stays readable —
                // same fix as the hire-side signature button.
                className={`absolute border rounded text-[10px] font-bold flex items-center justify-center transition ${
                    signed ? 'border-green-500 bg-green-100/50'
                        : 'border-purple-500 bg-purple-100/30 animate-pulse'
                }`}
                // UA-min-height defeat (see hire-side FieldInput) — Andrew
                // reviews these on the iPad, where mobile Safari would grow
                // the button past the field slot and cover PDF text.
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
                    className="w-full h-full accent-purple-600"
                    style={{ minHeight: 0, minWidth: 0, margin: 0 }} />
            </label>
        );
    }
    return (
        <input
            type={field.type === 'date' ? 'date' : 'text'}
            value={value || ''}
            onChange={e => onChange(e.target.value)}
            // Keyboard-covers-field fix, same as hire-side: scroll the
            // focused overlay input to mid-viewport after the on-screen
            // keyboard animates in.
            onFocus={e => { const el = e.currentTarget; setTimeout(() => { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ } }, 300); }}
            // Opacity conditional on value state (hire-side "text bubble
            // covers the label" fix): near-transparent while empty so the
            // printed I-9 label reads through, opaque once filled so the
            // typed text doesn't collide with it.
            className={`absolute border rounded px-1 text-[11px] ${
                value ? 'border-green-500 bg-purple-50/80' : 'border-purple-500 bg-purple-50/20'
            }`}
            // minHeight/minWidth 0 + lineHeight 1 defeat the UA input
            // min-height; ≥16px font kills iOS Safari's focus auto-zoom.
            // On-screen only — the PDF draws at the field's own fontSize.
            style={{
                ...style,
                minHeight: 0,
                minWidth: 0,
                lineHeight: 1,
                fontSize: Math.max(16, field.fontSize || 11) + 'px',
            }}
            placeholder={field.label || ''} />
    );
}

