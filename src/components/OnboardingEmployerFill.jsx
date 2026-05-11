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
//   4. Admin fills, signs, hits Finalize
//   5. We open the hire's submitted PDF with pdf-lib, draw the employer
//      values on top, upload as a NEW version (complete_TS.pdf)
//   6. Audit log entry + status flip to 'approved'
//
// The hire's original submission is preserved alongside the completed
// version so we have an audit trail of who filled what when.

import { useEffect, useRef, useState } from 'react';
import { db, storage } from '../firebase';
import { collection, query, where, getDocs, updateDoc, doc } from 'firebase/firestore';
import { ref as sref, uploadBytes, getDownloadURL, listAll, getMetadata } from 'firebase/storage';
import { DOC_STATUS } from '../data/onboarding';

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
                const url = await getDownloadURL(chosenFile.it);
                const res = await fetch(url);
                const buf = await res.arrayBuffer();
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
        // Validate — every employer field needs a value (admin chose to
        // include them; assume they're all required from admin side).
        const missing = employerFields.filter(f => {
            if (f.type === 'checkbox') return false;
            const v = values[f.id];
            return !v || (typeof v === 'string' && !v.trim());
        });
        if (missing.length > 0) {
            setErr(tx(
                `Fill ${missing.length} more field${missing.length === 1 ? '' : 's'} before finalizing.`,
                `Llena ${missing.length} campo${missing.length === 1 ? '' : 's'} más antes de finalizar.`,
            ));
            return;
        }
        setSubmitting(true);
        setErr('');
        try {
            const pdfLib = await loadPdfLib();
            const { PDFDocument, StandardFonts, rgb } = pdfLib;
            const pdfDoc = await PDFDocument.load(pdfBytes);
            const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
            const pages = pdfDoc.getPages();

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
                    const text = String(val || '');
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

            const outBytes = await pdfDoc.save();
            const ts = Date.now();
            const path = `onboarding/${hireId}/${docDef.id}/complete_${ts}.pdf`;
            await uploadBytes(sref(storage, path), new Blob([outBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });

            // Flip the doc's checklist to approved + audit who completed it.
            await updateDoc(doc(db, 'onboarding_hires', hireId), {
                [`checklist.${docDef.id}.status`]: DOC_STATUS.APPROVED,
                [`checklist.${docDef.id}.employerCompletedBy`]: staffName,
                [`checklist.${docDef.id}.employerCompletedAt`]: new Date().toISOString(),
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
                                    `${employerFields.length} campo${employerFields.length === 1 ? '' : 's'} requieren tu información.`,
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
                <EmployerSigModal field={sigField} isEs={isEs}
                    onClose={() => setSigField(null)}
                    onSave={(dataUrl) => { setValue(sigField.id, dataUrl); setSigField(null); }} />
            )}
        </div>
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
                className={`absolute border-2 rounded text-[10px] font-bold flex items-center justify-center transition ${
                    signed ? 'border-green-500 bg-green-100/60'
                        : 'border-purple-500 bg-purple-100/60 animate-pulse'
                }`}
                style={style}>
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
            <label className="absolute flex items-center justify-center cursor-pointer" style={style}>
                <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)}
                    className="w-full h-full accent-purple-600" />
            </label>
        );
    }
    return (
        <input
            type={field.type === 'date' ? 'date' : 'text'}
            value={value || ''}
            onChange={e => onChange(e.target.value)}
            className={`absolute border-2 rounded px-1 text-[11px] bg-purple-50/90 ${
                value ? 'border-green-500' : 'border-purple-500'
            }`}
            style={{ ...style, fontSize: (field.fontSize || 11) + 'px' }}
            placeholder={field.label || ''} />
    );
}

function EmployerSigModal({ field, isEs, onClose, onSave }) {
    const tx = (en, es) => (isEs ? es : en);
    const canvasRef = useRef(null);
    const drawing = useRef(false);
    const lastPoint = useRef(null);
    const [empty, setEmpty] = useState(true);

    useEffect(() => {
        const c = canvasRef.current;
        if (!c) return;
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
    }, []);

    const pos = (e) => {
        const r = canvasRef.current.getBoundingClientRect();
        const t = e.touches ? e.touches[0] : e;
        return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const start = (e) => { e.preventDefault(); drawing.current = true; lastPoint.current = pos(e); setEmpty(false); };
    const move = (e) => {
        if (!drawing.current) return;
        e.preventDefault();
        const ctx = canvasRef.current.getContext('2d');
        const p = pos(e);
        ctx.beginPath();
        ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
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
        const dataUrl = canvasRef.current.toDataURL('image/png');
        onSave(dataUrl);
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-end sm:items-center justify-center p-3">
            <div className="bg-white w-full sm:max-w-md rounded-2xl">
                <div className="p-3 border-b border-gray-200">
                    <h3 className="font-bold text-sm">
                        ✍️ {field.type === 'initials' ? tx('Initials', 'Iniciales') : tx('Sign here', 'Firma aquí')}
                    </h3>
                </div>
                <div className="p-3">
                    <canvas ref={canvasRef}
                        className="w-full h-44 bg-gray-50 border-2 border-dashed border-purple-300 rounded-lg touch-none"
                        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
                        onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
                </div>
                <div className="p-3 border-t border-gray-200 flex gap-2">
                    <button onClick={clear} className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold">
                        {tx('Clear', 'Borrar')}
                    </button>
                    <button onClick={onClose} className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 text-sm font-bold">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={save} disabled={empty}
                        className="flex-1 py-2 rounded-lg bg-purple-600 text-white text-sm font-bold disabled:opacity-50">
                        {tx('Done', 'Listo')}
                    </button>
                </div>
            </div>
        </div>
    );
}
