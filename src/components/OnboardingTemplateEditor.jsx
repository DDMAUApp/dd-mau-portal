// OnboardingTemplateEditor — DocuSign-lite field placement.
//
// Admin workflow:
//   1. Upload a blank PDF (W-4, MO W-4, Direct Deposit, etc.)
//   2. We render each page via pdfjs into a canvas
//   3. Click anywhere on a page to drop a field marker
//   4. Pick a type (text / date / signature / initials / checkbox) and an
//      optional auto-fill binding (pulls from hire's `personal` payload)
//   5. Drag the marker to reposition, resize via corner handle, delete via 'x'
//   6. Save → PDF uploaded to onboarding_templates/{templateId}.pdf in Storage,
//      metadata + field list saved to /onboarding_templates/{templateId}
//
// Coordinates are stored as fractions of page width/height (0-1) so they
// survive PDF resolution changes. The fill step (FillablePdfForm) reads
// these fractions and writes text at the matching absolute PDF coordinates
// via pdf-lib.
//
// pdfjs is heavy (~3 MB). Lazy-loaded so it only hits the bundle when an
// admin actually opens this editor.

import { useEffect, useRef, useState } from 'react';
import { db, storage } from '../firebase';
import { doc, setDoc, addDoc, collection, deleteDoc } from 'firebase/firestore';
import { ref as sref, uploadBytes, getDownloadURL, getBytes, deleteObject } from 'firebase/storage';
import { TEMPLATE_FIELD_TYPES, TEMPLATE_AUTOFILLS, ONBOARDING_DOCS } from '../data/onboarding';

// Lazy-load pdfjs. The worker has to be set up too; we use the modern URL form.
async function loadPdfJs() {
    const pdfjs = await import('pdfjs-dist');
    // Vite handles the worker URL via this canonical import form.
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    }
    return pdfjs;
}

export default function OnboardingTemplateEditor({
    initialTemplate,    // null = creating new; object = editing existing
    isEs,
    onClose,
    onSaved,
}) {
    const tx = (en, es) => (isEs ? es : en);
    const [name, setName] = useState(initialTemplate?.name || '');
    const [forDocId, setForDocId] = useState(initialTemplate?.forDocId || 'w4_fed');
    const [fields, setFields] = useState(initialTemplate?.fields || []);
    // mode: 'fillable' = admin places fields, hire fills them in-app
    //       'reference' = admin uploads a PDF for the hire to download/print/fill
    //                     offline; no fields, no signature pad
    const [mode, setMode] = useState(initialTemplate?.mode || 'fillable');
    // pdfDirty: true once admin uploads a fresh PDF in EDIT mode. Drives
    // whether Save uploads to Storage (replacing the old PDF) or reuses
    // the existing storagePath. Without this flag, "Replace PDF" on an
    // existing template silently no-op'd because the save logic thought
    // there was no fresh upload to push.
    const [pdfDirty, setPdfDirty] = useState(false);
    const [pdfBytes, setPdfBytes] = useState(null);       // ArrayBuffer of the PDF (new uploads)
    const [pageImages, setPageImages] = useState([]);     // rendered page data URLs
    const [pageDims, setPageDims] = useState([]);         // [{w,h}] in PDF points
    const [loadingPdf, setLoadingPdf] = useState(false);
    const [activeType, setActiveType] = useState('text'); // type to drop on next click
    const [selectedFieldId, setSelectedFieldId] = useState(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    // If editing an existing template, load its PDF from storage.
    useEffect(() => {
        // If we're editing an existing template that has a storagePath,
        // pull the PDF from Storage and render it. If storagePath is missing
        // (older templates from before the field existed), bail with a
        // clear message so admin knows to re-upload rather than seeing a
        // generic failure.
        if (!initialTemplate) return;
        if (!initialTemplate.storagePath) {
            setError(tx(
                'This template is missing a PDF file (older record). Re-upload the PDF to fix.',
                'Esta plantilla no tiene archivo PDF (registro antiguo). Vuelve a subir el PDF.',
            ));
            return;
        }
        let alive = true;
        (async () => {
            setLoadingPdf(true);
            setError('');
            try {
                console.log('[TemplateEditor] loading existing template:', initialTemplate.storagePath);
                // Use SDK getBytes() (XHR) instead of getDownloadURL()+fetch():
                // the SDK has built-in retry, returns ArrayBuffer directly,
                // and routes through the same auth-aware channel that the
                // hire portal uses. Was hitting "Failed to fetch" on the
                // template editor whenever the bucket's CORS config wasn't
                // freshly cached, leaving "10 fields placed, 0 pages" — an
                // empty editor with no PDF to anchor field positions to.
                const buf = await getBytes(sref(storage, initialTemplate.storagePath));
                console.log('[TemplateEditor] downloaded', buf.byteLength, 'bytes');
                if (!alive) return;
                if (buf.byteLength === 0) throw new Error('Downloaded PDF is empty (file missing or zero bytes in Storage)');
                setPdfBytes(buf);
                await renderPdf(buf);
            } catch (e) {
                console.error('[TemplateEditor] load failed:', e);
                // Surface the actual error so admin (or me, on next bug report)
                // sees what went wrong instead of a generic "Failed to load PDF".
                const msg = e?.code === 'storage/object-not-found'
                    ? tx('PDF file not found in Storage. It may have been deleted — re-upload.',
                         'No se encontró el PDF en Storage. Vuelve a subir.')
                    : e?.code === 'storage/unauthorized'
                        ? tx('Storage access denied. Check Storage rules / App Check.',
                             'Acceso denegado en Storage.')
                        : tx('Failed to load PDF: ', 'No se pudo cargar el PDF: ') + (e?.message || e?.code || String(e));
                setError(msg);
            } finally { if (alive) setLoadingPdf(false); }
        })();
        return () => { alive = false; };
    }, [initialTemplate?.storagePath, initialTemplate?.id]);

    const renderPdf = async (buf) => {
        try {
            const pdfjs = await loadPdfJs();
            const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
            const imgs = [];
            const dims = [];
            for (let p = 1; p <= pdf.numPages; p++) {
                const page = await pdf.getPage(p);
                // Render at a moderate scale — enough for click placement w/o
                // overwhelming the DOM. The PDF.js viewport always reports
                // page dims in points (1/72 inch).
                const viewport = page.getViewport({ scale: 1.5 });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const ctx = canvas.getContext('2d');
                await page.render({ canvasContext: ctx, viewport }).promise;
                imgs.push(canvas.toDataURL('image/png'));
                const pdfViewport = page.getViewport({ scale: 1 });
                dims.push({ w: pdfViewport.width, h: pdfViewport.height });
            }
            setPageImages(imgs);
            setPageDims(dims);
        } catch (e) {
            console.error('renderPdf failed', e);
            setError(String(e.message || e));
        }
    };

    const onFileChosen = async (file) => {
        if (!file) return;
        if (file.type !== 'application/pdf') {
            setError(tx('Please choose a PDF file.', 'Selecciona un archivo PDF.'));
            return;
        }
        setError('');
        setLoadingPdf(true);
        try {
            const buf = await file.arrayBuffer();
            setPdfBytes(buf);
            setPdfDirty(true);  // mark so Save knows to push to Storage
            if (!name) setName(file.name.replace(/\.pdf$/i, ''));
            await renderPdf(buf);
        } finally {
            setLoadingPdf(false);
        }
    };

    // Auto-detect form fields from the PDF's AcroForm metadata.
    //
    // Official forms like the IRS W-4 are "fillable PDFs" — they ship with
    // form fields (text inputs, signature blocks, checkboxes) embedded in
    // the PDF structure. pdfjs's getAnnotations() returns those widgets
    // with exact coordinates and types. We convert them to our fractional
    // coord system and drop a pre-positioned field for each.
    //
    // For non-fillable PDFs (scans, image-only exports) no AcroForm exists
    // and we fall back to a "0 detected" message — the admin keeps using
    // click-to-drop.
    //
    // We also try to guess an autofill binding from the field's name
    // ("name", "ssn", "dob", "address", etc.) so common fields land
    // pre-bound to the hire's personal payload.
    const [detecting, setDetecting] = useState(false);
    const [detectMsg, setDetectMsg] = useState('');

    const guessAutofill = (rawName, altText) => {
        const candidates = [rawName, altText].filter(Boolean).join(' ').toLowerCase();
        if (!candidates) return '';
        const n = candidates.replace(/[\s_\-\.\[\]\(\)0-9]/g, '');
        if (/(legalname|fullname)/.test(n)) return 'legalName';
        if (/firstname|givenname/.test(n)) return 'firstName';
        if (/lastname|familyname|surname/.test(n)) return 'lastName';
        if (/^name$|employeename|workername|applicantname/.test(n)) return 'legalName';
        if (/street|addressline|address1|homeaddress|mailingaddress|address(?!.*city)/.test(n)) return 'addressLine';
        if (/^city|cityname|cityof/.test(n)) return 'city';
        if (/^state(?!.*tax|wages)|statename|stateof/.test(n)) return 'state';
        if (/zip|postalcode|postal/.test(n)) return 'zip';
        if (/dob|birthdate|dateofbirth|birthday/.test(n)) return 'dob';
        if (/phone|telephone|cellphone|mobile/.test(n)) return 'phone';
        if (/email|emailaddress/.test(n)) return 'email';
        if (/ssn|socialsecurity|socialsecuritynumber|tin/.test(n)) return 'ssn';
        if (/todaysdate|signdate|datesigned|currentdate|^date$/.test(n)) return 'today';
        return '';
    };

    const detectFields = async () => {
        if (!pdfBytes) {
            setDetectMsg(tx('Upload a PDF first.', 'Sube un PDF primero.'));
            return;
        }
        setDetecting(true);
        setDetectMsg('');
        try {
            const pdfjs = await loadPdfJs();
            const pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes.slice(0)) }).promise;
            const detected = [];
            for (let p = 1; p <= pdf.numPages; p++) {
                const page = await pdf.getPage(p);
                const viewport = page.getViewport({ scale: 1 });
                const pw = viewport.width;
                const ph = viewport.height;
                const annotations = await page.getAnnotations();
                for (const ann of annotations) {
                    if (ann.subtype !== 'Widget') continue;
                    const [x1, y1, x2, y2] = ann.rect || [0, 0, 0, 0];
                    const x = Math.min(x1, x2);
                    const y = Math.min(y1, y2);
                    const w = Math.abs(x2 - x1);
                    const h = Math.abs(y2 - y1);
                    // Drop micro-fields that are almost certainly artifacts
                    // (some PDFs have invisible 1-px widgets for tab order).
                    if (w < 5 || h < 4) continue;
                    let type = 'text';
                    if (ann.fieldType === 'Sig') type = 'signature';
                    else if (ann.fieldType === 'Btn') {
                        // checkbox vs radio — both render as 'X' marks in pdf-lib
                        type = 'checkbox';
                    } else if (ann.fieldType === 'Tx') {
                        type = 'text';
                    } else {
                        // Choice, dropdowns, etc. — treat as text for v1
                        type = 'text';
                    }
                    const fxFrac = x / pw;
                    // PDF y-axis runs UP from bottom-left. Our fractional
                    // coords run DOWN from top-left. So:
                    //   yFrac_top = 1 - (y + h) / pageHeight
                    const fyFrac = 1 - (y + h) / ph;
                    detected.push({
                        id: `f_auto_${Date.now()}_${detected.length}`,
                        page: p - 1,
                        x: Math.max(0, Math.min(1, fxFrac)),
                        y: Math.max(0, Math.min(1, fyFrac)),
                        w: Math.max(0.005, Math.min(1, w / pw)),
                        h: Math.max(0.005, Math.min(1, h / ph)),
                        type,
                        label: ann.fieldName || ann.alternativeText || '',
                        autofill: type === 'text' || type === 'date'
                            ? guessAutofill(ann.fieldName, ann.alternativeText)
                            : '',
                        fontSize: Math.max(8, Math.min(14, Math.round(h * 0.65))),
                        // Default optional — see new-field handler for why.
                        required: false,
                    });
                }
            }
            if (detected.length === 0) {
                setDetectMsg(tx(
                    'No fillable form fields found in this PDF. It\'s probably a scan — drop fields manually by clicking.',
                    'No se encontraron campos en este PDF. Probablemente es un escaneo — colócalos manualmente.',
                ));
                return;
            }
            // Replace existing fields wholesale rather than append. Running
            // detect twice should be idempotent, not a multiplier.
            setFields(detected);
            setSelectedFieldId(null);
            setDetectMsg(tx(
                `Auto-detected ${detected.length} field${detected.length === 1 ? '' : 's'}. Drag any one to fine-tune.`,
                `Detectados ${detected.length} campo${detected.length === 1 ? '' : 's'}. Arrastra para ajustar.`,
            ));
        } catch (e) {
            console.error('auto-detect failed', e);
            setDetectMsg(tx('Auto-detect failed: ', 'Falló: ') + (e.message || e));
        } finally {
            setDetecting(false);
        }
    };

    // Click on a rendered page → drop a marker at the click position.
    const handlePageClick = (e, pageIdx) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const xFrac = (e.clientX - rect.left) / rect.width;
        const yFrac = (e.clientY - rect.top) / rect.height;
        const def = TEMPLATE_FIELD_TYPES.find(t => t.id === activeType) || TEMPLATE_FIELD_TYPES[0];
        const newField = {
            id: `f_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            page: pageIdx,
            x: Math.max(0, Math.min(1 - def.defaultW, xFrac - def.defaultW / 2)),
            y: Math.max(0, Math.min(1 - def.defaultH, yFrac - def.defaultH / 2)),
            w: def.defaultW,
            h: def.defaultH,
            type: activeType,
            label: '',
            autofill: '',         // empty = hire fills manually
            fontSize: 11,
            // Default optional. On long forms (I-9 has 40-50 fields, most
            // "if applicable") it's faster for admin to tick the few
            // genuinely-required boxes than to opt-out everything else.
            required: false,
        };
        setFields([...fields, newField]);
        setSelectedFieldId(newField.id);
    };

    const updateField = (id, patch) => {
        setFields(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
    };
    const deleteField = (id) => {
        setFields(prev => prev.filter(f => f.id !== id));
        if (selectedFieldId === id) setSelectedFieldId(null);
    };

    const save = async () => {
        if (!name.trim()) { setError(tx('Name is required.', 'El nombre es requerido.')); return; }
        if (!pdfBytes && !initialTemplate?.storagePath) {
            setError(tx('Upload a PDF first.', 'Sube un PDF primero.'));
            return;
        }
        setSaving(true);
        setError('');
        try {
            // 1. Upload the PDF (only if new bytes are present — re-uses existing
            //    storage path on edits that didn't replace the PDF).
            let storagePath = initialTemplate?.storagePath;
            // Upload the PDF to Storage if EITHER:
            //   • This is a new template (no initialTemplate), OR
            //   • Admin uploaded a fresh PDF in edit mode (pdfDirty)
            // The OLD check (initialTemplate.pendingNewPdf) never got set
            // anywhere, so Replace PDF silently no-op'd before this fix.
            if (pdfBytes && (!initialTemplate || pdfDirty)) {
                // Allocate a fresh storage path; templates are append-only —
                // never overwrite the original so we can roll back.
                const ts = Date.now();
                const safeId = (forDocId || 'template') + '_' + ts;
                storagePath = `onboarding_templates/${safeId}.pdf`;
                await uploadBytes(sref(storage, storagePath), new Blob([pdfBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
            }
            // 2. Save metadata + fields. Reference-mode templates discard
            //    field positions since the hire never fills them in-app.
            const meta = {
                name: name.trim(),
                forDocId,
                mode,
                storagePath,
                fields: mode === 'reference' ? [] : fields,
                pageDims,
                updatedAt: new Date().toISOString(),
            };
            if (initialTemplate?.id) {
                await setDoc(doc(db, 'onboarding_templates', initialTemplate.id), meta, { merge: true });
                onSaved({ id: initialTemplate.id, ...meta });
            } else {
                const ref = await addDoc(collection(db, 'onboarding_templates'), {
                    ...meta,
                    createdAt: new Date().toISOString(),
                });
                onSaved({ id: ref.id, ...meta });
            }
        } catch (e) {
            console.error('Template save failed', e);
            setError(tx('Save failed: ', 'Falló: ') + (e.message || e));
        } finally {
            setSaving(false);
        }
    };

    const removeTemplate = async () => {
        if (!initialTemplate?.id) { onClose(); return; }
        if (!confirm(tx('Delete this template? This cannot be undone.', '¿Eliminar esta plantilla? Es irreversible.'))) return;
        try {
            await deleteDoc(doc(db, 'onboarding_templates', initialTemplate.id));
            if (initialTemplate.storagePath) {
                try { await deleteObject(sref(storage, initialTemplate.storagePath)); } catch {}
            }
            onSaved(null);
        } catch (e) { console.error(e); }
    };

    const selected = fields.find(f => f.id === selectedFieldId) || null;

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex flex-col">
            {/* Header */}
            <div className="bg-white border-b border-gray-200 p-3 flex items-center gap-2 flex-wrap">
                <div className="flex-1 min-w-0">
                    <input
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder={tx('Template name (e.g. "Missouri W-4 2026")', 'Nombre de plantilla')}
                        className="w-full text-sm font-bold border-b border-transparent focus:border-mint-700 focus:outline-none px-1 py-1" />
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <label className="text-[10px] font-bold text-gray-500 uppercase">{tx('For doc:', 'Para doc:')}</label>
                        <select value={forDocId} onChange={e => setForDocId(e.target.value)}
                            className="text-[11px] border border-gray-300 rounded px-2 py-0.5 bg-white">
                            {/* All docs are eligible — fillable mode targets
                                kind:'template' (W-4 etc.), reference mode can
                                attach to ANY doc (Hep A form, employee
                                handbook page, you-fill-it-out PDFs etc.) */}
                            {ONBOARDING_DOCS.map(d => (
                                <option key={d.id} value={d.id}>{isEs ? d.es : d.en}</option>
                            ))}
                        </select>
                        <label className="text-[10px] font-bold text-gray-500 uppercase ml-2">{tx('Mode:', 'Modo:')}</label>
                        <div className="flex gap-1">
                            <button type="button" onClick={() => setMode('fillable')}
                                className={`px-2 py-0.5 rounded text-[11px] font-bold border ${
                                    mode === 'fillable'
                                        ? 'bg-dd-green text-white border-dd-green'
                                        : 'bg-white text-gray-700 border-gray-300'
                                }`}>
                                ✏ {tx('Fillable', 'Rellenable')}
                            </button>
                            <button type="button" onClick={() => setMode('reference')}
                                className={`px-2 py-0.5 rounded text-[11px] font-bold border ${
                                    mode === 'reference'
                                        ? 'bg-amber-500 text-white border-amber-500'
                                        : 'bg-white text-gray-700 border-gray-300'
                                }`}>
                                📎 {tx('Reference', 'Referencia')}
                            </button>
                        </div>
                    </div>
                </div>
                <button onClick={onClose} className="w-9 h-9 rounded-full bg-gray-100 text-gray-600 text-xl">×</button>
            </div>

            <div className="flex-1 flex overflow-hidden">
                {/* Left: PDF pages with overlay markers */}
                <div className="flex-1 overflow-auto bg-gray-200 p-3">
                    {!pageImages.length && !loadingPdf && (
                        <label className="block max-w-md mx-auto mt-12 p-6 bg-white border-2 border-dashed border-mint-300 rounded-2xl text-center cursor-pointer hover:border-mint-500">
                            <p className="text-4xl mb-2">📄</p>
                            <p className="text-sm font-bold text-mint-700">
                                {tx('Upload a PDF', 'Sube un PDF')}
                            </p>
                            <p className="text-[11px] text-gray-500 mt-1">
                                {tx('Drag and drop, or click. Max 15 MB.', 'Arrastra o haz clic. Máx 15 MB.')}
                            </p>
                            <input type="file" accept="application/pdf" className="hidden"
                                onChange={e => onFileChosen(e.target.files?.[0])} />
                        </label>
                    )}
                    {loadingPdf && (
                        <p className="text-center text-white py-12">{tx('Rendering PDF…', 'Renderizando PDF…')}</p>
                    )}
                    {pageImages.map((src, idx) => (
                        <div key={idx} className="relative max-w-3xl mx-auto mb-3 bg-white shadow-lg select-none"
                             onClick={(e) => handlePageClick(e, idx)}>
                            <img src={src} alt={`Page ${idx + 1}`} draggable={false}
                                 className="w-full h-auto block pointer-events-none" />
                            {fields.filter(f => f.page === idx).map(f => (
                                <FieldMarker key={f.id}
                                    field={f}
                                    selected={selectedFieldId === f.id}
                                    onSelect={(e) => { e.stopPropagation(); setSelectedFieldId(f.id); }}
                                    onMove={(newX, newY) => updateField(f.id, {
                                        x: Math.max(0, Math.min(1 - f.w, newX)),
                                        y: Math.max(0, Math.min(1 - f.h, newY)),
                                    })}
                                    onResize={(newW, newH) => updateField(f.id, {
                                        w: Math.max(0.02, Math.min(1 - f.x, newW)),
                                        h: Math.max(0.015, Math.min(1 - f.y, newH)),
                                    })}
                                    onDelete={() => deleteField(f.id)}
                                    isEs={isEs}
                                />
                            ))}
                            <div className="absolute top-1 left-1 bg-black/60 text-white text-[10px] font-bold px-2 py-0.5 rounded pointer-events-none">
                                {tx(`Page ${idx + 1}`, `Página ${idx + 1}`)}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Right: Tool palette + field details */}
                <aside className="w-72 bg-white border-l border-gray-200 overflow-y-auto p-3 space-y-3">
                    {/* Auto-detect — reads embedded form fields out of the
                        PDF's AcroForm metadata (the IRS W-4, MO W-4, and most
                        government forms are fillable PDFs and have this).
                        Drops a pre-positioned marker for every field, with
                        common autofill bindings (name/SSN/dob/address) guessed
                        from the field's internal name. Manual drag still works
                        on top for fine-tuning. */}
                    {pageImages.length > 0 && (
                        <div className="bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-200 rounded-xl p-3">
                            <p className="text-[10px] font-bold uppercase text-indigo-700 mb-1">
                                ✨ {tx('Auto-detect fields', 'Detectar campos')}
                            </p>
                            <p className="text-[11px] text-indigo-900 mb-2 leading-snug">
                                {tx(
                                    'For fillable PDFs (IRS W-4, MO W-4, etc.) this places every text/signature/checkbox automatically — drag any one after to adjust.',
                                    'Para PDFs rellenables (W-4 del IRS, W-4 de Missouri, etc.) coloca cada campo automáticamente — arrastra después para ajustar.',
                                )}
                            </p>
                            <button onClick={detectFields} disabled={detecting}
                                className="w-full py-1.5 rounded-lg text-[12px] font-bold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition">
                                {detecting
                                    ? tx('Scanning…', 'Escaneando…')
                                    : (fields.length > 0
                                        ? tx('🔄 Re-scan PDF', '🔄 Volver a escanear')
                                        : tx('🔍 Scan PDF', '🔍 Escanear PDF'))}
                            </button>
                            {detectMsg && (
                                <p className="mt-1.5 text-[10px] text-indigo-900 italic">
                                    {detectMsg}
                                </p>
                            )}
                        </div>
                    )}

                    <div>
                        <p className="text-[10px] font-bold uppercase text-gray-500 mb-1.5">
                            {tx('Drop tool', 'Herramienta')}
                        </p>
                        <p className="text-[11px] text-gray-600 mb-2">
                            {tx('Pick a type, then click on the PDF to drop a field.',
                                'Elige un tipo, luego haz clic en el PDF para colocar el campo.')}
                        </p>
                        <div className="grid grid-cols-2 gap-1.5">
                            {TEMPLATE_FIELD_TYPES.map(t => (
                                <button key={t.id} onClick={() => setActiveType(t.id)}
                                    className={`py-1.5 rounded-lg text-[11px] font-bold border transition ${
                                        activeType === t.id
                                            ? 'bg-dd-green text-white border-dd-green'
                                            : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                                    }`}>
                                    {isEs ? t.es : t.en}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Replace PDF */}
                    {pageImages.length > 0 && (
                        <div className="pt-3 border-t border-gray-200">
                            <label className="text-[10px] font-bold uppercase text-gray-500 cursor-pointer hover:text-mint-700">
                                ⟲ {tx('Replace PDF', 'Reemplazar PDF')}
                                <input type="file" accept="application/pdf" className="hidden"
                                    onChange={e => onFileChosen(e.target.files?.[0])} />
                            </label>
                            <p className="text-[10px] text-gray-400">
                                {tx('Existing fields stay; verify positions.', 'Los campos existentes se mantienen.')}
                            </p>
                        </div>
                    )}

                    {/* Selected field details */}
                    {selected && (
                        <div className="pt-3 border-t border-gray-200 space-y-2">
                            <p className="text-[10px] font-bold uppercase text-gray-500">
                                {tx('Selected field', 'Campo seleccionado')}
                            </p>

                            {/* Who fills this — three modes:
                                • hire     — new hire fills via portal (default)
                                • static   — admin pre-fills once on template (company info etc.)
                                • employer — admin fills AFTER hire submits (I-9 Section 2 pattern)
                                Employer fields are hidden from the hire portal
                                entirely; admin completes them in a separate
                                review step once the hire's portion is in. */}
                            <div>
                                <label className="text-[10px] font-bold text-gray-500">
                                    {tx('Who fills this?', '¿Quién lo llena?')}
                                </label>
                                <div className="grid grid-cols-3 gap-1 mt-0.5">
                                    <button type="button"
                                        onClick={() => updateField(selected.id, { filledBy: 'hire' })}
                                        className={`py-1 rounded text-[10px] font-bold border ${
                                            (selected.filledBy || 'hire') === 'hire'
                                                ? 'bg-blue-600 text-white border-blue-600'
                                                : 'bg-white text-gray-700 border-gray-300'
                                        }`}>
                                        {tx('🧑 Hire', '🧑 Nuevo')}
                                    </button>
                                    <button type="button"
                                        onClick={() => updateField(selected.id, { filledBy: 'static' })}
                                        className={`py-1 rounded text-[10px] font-bold border ${
                                            selected.filledBy === 'static'
                                                ? 'bg-amber-500 text-white border-amber-500'
                                                : 'bg-white text-gray-700 border-gray-300'
                                        }`}>
                                        {tx('🔒 Pre-fill', '🔒 Pre-lleno')}
                                    </button>
                                    <button type="button"
                                        onClick={() => updateField(selected.id, { filledBy: 'employer' })}
                                        className={`py-1 rounded text-[10px] font-bold border ${
                                            selected.filledBy === 'employer'
                                                ? 'bg-purple-600 text-white border-purple-600'
                                                : 'bg-white text-gray-700 border-gray-300'
                                        }`}>
                                        {tx('👔 Employer', '👔 Empleador')}
                                    </button>
                                </div>
                                {selected.filledBy === 'employer' && (
                                    <p className="text-[10px] text-purple-700 italic mt-1">
                                        {tx('Hidden from the hire. You complete this AFTER they submit.',
                                            'Oculto del nuevo. Tú lo llenas DESPUÉS de que envíen.')}
                                    </p>
                                )}
                            </div>

                            <div>
                                <label className="text-[10px] font-bold text-gray-500">
                                    {tx('Label (optional)', 'Etiqueta (opcional)')}
                                </label>
                                <input value={selected.label}
                                    onChange={e => updateField(selected.id, { label: e.target.value })}
                                    placeholder={tx('e.g. "Company name"', 'ej: "Nombre empresa"')}
                                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs" />
                            </div>

                            {/* STATIC value input — what gets baked into every
                                hire's PDF. Different control per field type:
                                  • text/date/initials → text input
                                  • checkbox          → checked toggle
                                  • signature         → inline sig pad
                            */}
                            {selected.filledBy === 'static' && (
                                <div className="bg-amber-50 border border-amber-200 rounded p-2 space-y-1.5">
                                    <p className="text-[10px] font-bold text-amber-900 uppercase">
                                        🔒 {tx('Pre-filled value', 'Valor predefinido')}
                                    </p>
                                    {(selected.type === 'text' || selected.type === 'date' || selected.type === 'initials') && (
                                        <input
                                            type={selected.type === 'date' ? 'date' : 'text'}
                                            value={selected.staticValue || ''}
                                            onChange={e => updateField(selected.id, { staticValue: e.target.value })}
                                            placeholder={tx('e.g. DD Mau LLC, EIN, address…', 'ej: DD Mau LLC, EIN, dirección…')}
                                            className="w-full border border-amber-300 rounded px-2 py-1 text-xs bg-white" />
                                    )}
                                    {selected.type === 'checkbox' && (
                                        <label className="flex items-center gap-2 text-[11px] font-bold text-amber-900">
                                            <input type="checkbox"
                                                checked={!!selected.staticValue}
                                                onChange={e => updateField(selected.id, { staticValue: e.target.checked })}
                                                className="w-4 h-4 accent-amber-600" />
                                            {tx('Pre-checked', 'Pre-marcado')}
                                        </label>
                                    )}
                                    {(selected.type === 'signature' || selected.type === 'initials') && selected.type === 'signature' && (
                                        <InlineSigPad
                                            value={typeof selected.staticValue === 'string' && selected.staticValue.startsWith('data:image') ? selected.staticValue : null}
                                            onChange={(dataUrl) => updateField(selected.id, { staticValue: dataUrl })}
                                            isEs={isEs}
                                        />
                                    )}
                                    <p className="text-[10px] text-amber-800 italic">
                                        {tx('This value goes into every hire\'s PDF. They won\'t see an input here.',
                                            'Este valor va en el PDF de cada contratado. Ellos no verán un campo aquí.')}
                                    </p>
                                </div>
                            )}

                            {/* AUTOFILL binding — only for HIRE-FILLED text fields.
                                Static fields use staticValue instead. */}
                            {(selected.filledBy || 'hire') === 'hire' && (selected.type === 'text' || selected.type === 'date') && (
                                <div>
                                    <label className="text-[10px] font-bold text-gray-500">
                                        {tx('Auto-fill from hire data', 'Auto-llenar desde datos del contratado')}
                                    </label>
                                    <select value={selected.autofill || ''}
                                        onChange={e => updateField(selected.id, { autofill: e.target.value })}
                                        className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white">
                                        <option value="">{tx('— Hire fills manually —', '— Llenar manualmente —')}</option>
                                        {TEMPLATE_AUTOFILLS.map(a => (
                                            <option key={a.id} value={a.id}>{isEs ? a.es : a.en}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {/* REQUIRED / OPTIONAL toggle — only meaningful for
                                hire-filled fields. Static is admin-prefilled
                                and employer is filled-after-submit, so neither
                                blocks the hire's submit either way. Default
                                = required (back-compat — fields predating
                                this toggle have no `required` property and
                                the hire-side validate() treats undefined as
                                required). Long forms like I-9 have dozens of
                                "if applicable" blanks; without this toggle
                                the hire couldn't submit until every box was
                                filled in. */}
                            {(selected.filledBy || 'hire') === 'hire' && (
                                <div>
                                    <label className="text-[10px] font-bold text-gray-500 block mb-1">
                                        {tx('Required to submit?', '¿Obligatorio?')}
                                    </label>
                                    <div className="grid grid-cols-2 gap-1">
                                        <button type="button"
                                            onClick={() => updateField(selected.id, { required: true })}
                                            className={`py-1.5 rounded text-[11px] font-bold border ${
                                                selected.required !== false
                                                    ? 'bg-red-100 text-red-700 border-red-300'
                                                    : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'
                                            }`}>
                                            ✱ {tx('Required', 'Obligatorio')}
                                        </button>
                                        <button type="button"
                                            onClick={() => updateField(selected.id, { required: false })}
                                            className={`py-1.5 rounded text-[11px] font-bold border ${
                                                selected.required === false
                                                    ? 'bg-gray-200 text-gray-700 border-gray-400'
                                                    : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'
                                            }`}>
                                            {tx('Optional', 'Opcional')}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {(selected.type === 'text' || selected.type === 'date' || selected.type === 'initials') && (
                                <div>
                                    <label className="text-[10px] font-bold text-gray-500">
                                        {tx('Font size', 'Tamaño de fuente')}
                                    </label>
                                    <input type="number" min="6" max="36" value={selected.fontSize || 11}
                                        onChange={e => updateField(selected.id, { fontSize: parseInt(e.target.value, 10) || 11 })}
                                        className="w-full border border-gray-300 rounded px-2 py-1 text-xs" />
                                </div>
                            )}
                            <button onClick={() => deleteField(selected.id)}
                                className="w-full py-1.5 rounded bg-red-100 text-red-700 text-[11px] font-bold hover:bg-red-200">
                                🗑 {tx('Delete field', 'Eliminar campo')}
                            </button>
                        </div>
                    )}

                    <div className="pt-3 border-t border-gray-200 text-[11px] text-gray-500">
                        <p><strong>{fields.length}</strong> {tx('field(s) placed', 'campo(s) colocados')}</p>
                        <p>{pageImages.length} {tx('page(s)', 'página(s)')}</p>
                    </div>
                </aside>
            </div>

            {/* Footer */}
            <div className="bg-white border-t border-gray-200 p-3 flex items-center gap-2">
                {error && <span className="text-xs text-red-600 mr-auto">{error}</span>}
                {initialTemplate?.id && (
                    <button onClick={removeTemplate}
                        className="text-[11px] px-3 py-1.5 rounded-lg bg-red-100 text-red-700 font-bold">
                        🗑 {tx('Delete template', 'Eliminar plantilla')}
                    </button>
                )}
                <button onClick={onClose}
                    className="text-sm px-4 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">
                    {tx('Cancel', 'Cancelar')}
                </button>
                <button onClick={save} disabled={saving || !pageImages.length}
                    className="text-sm px-4 py-2 rounded-lg bg-mint-700 text-white font-bold disabled:opacity-50">
                    {saving ? tx('Saving…', 'Guardando…') : tx('Save template', 'Guardar plantilla')}
                </button>
            </div>
        </div>
    );
}

// Field marker — absolutely positioned div on top of the rendered page.
// Click to select, drag center to move, drag bottom-right corner to resize.
//
// DRAG MATH: every drag handler captures the field's x/y/w/h AT DRAG START
// and the cursor's start position. On each pointer move, we compute the
// total delta from the start (not increments) and call onMove/onResize
// with the new ABSOLUTE position. This avoids the React closure pitfall
// where window listeners hold the props from when the drag began (stale
// `field` prop) and only managed a single-tick delta before snapping back.
//
// TOUCH: same path handles touch events for iPad/phone admin use. We
// extract clientX/Y from either MouseEvent or TouchEvent uniformly.
function FieldMarker({ field, selected, onSelect, onMove, onResize, onDelete, isEs }) {
    const getXY = (ev) => {
        if (ev.touches && ev.touches[0]) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
        if (ev.changedTouches && ev.changedTouches[0]) return { x: ev.changedTouches[0].clientX, y: ev.changedTouches[0].clientY };
        return { x: ev.clientX, y: ev.clientY };
    };

    const startDrag = (e, mode) => {
        // Stop the page-container onClick from firing AND prevent text
        // selection / native touch panning during the drag gesture.
        e.stopPropagation();
        e.preventDefault();
        const pageEl = e.currentTarget.closest('.relative');
        if (!pageEl) return;
        const rect = pageEl.getBoundingClientRect();
        const start = getXY(e);
        // Snapshot the field at drag-start so subsequent move events
        // compute against a stable base instead of stale React state.
        const startFx = field.x;
        const startFy = field.y;
        const startFw = field.w;
        const startFh = field.h;

        const onPointerMove = (ev) => {
            const cur = getXY(ev);
            const totalDx = (cur.x - start.x) / rect.width;
            const totalDy = (cur.y - start.y) / rect.height;
            if (mode === 'move') {
                onMove(startFx + totalDx, startFy + totalDy);
            } else {
                onResize(startFw + totalDx, startFh + totalDy);
            }
            // Block native scroll on touch — without preventDefault inside
            // touchmove, iOS swallows the gesture and the page scrolls
            // instead of the marker moving.
            if (ev.cancelable) ev.preventDefault();
        };
        const onPointerUp = () => {
            window.removeEventListener('mousemove', onPointerMove);
            window.removeEventListener('mouseup', onPointerUp);
            window.removeEventListener('touchmove', onPointerMove);
            window.removeEventListener('touchend', onPointerUp);
            window.removeEventListener('touchcancel', onPointerUp);
        };
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
        // passive:false so we can preventDefault inside touchmove.
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp);
        window.addEventListener('touchcancel', onPointerUp);
    };

    return (
        <div
            onClick={(e) => { e.stopPropagation(); onSelect(e); }}
            onMouseDown={(e) => { onSelect(e); startDrag(e, 'move'); }}
            onTouchStart={(e) => { onSelect(e); startDrag(e, 'move'); }}
            className={`absolute cursor-move border-2 group touch-none ${
                selected
                    ? 'border-dd-green bg-dd-green/15 z-10'
                    : field.filledBy === 'static'
                        ? 'border-amber-500 bg-amber-100/50 hover:border-amber-600'
                        : field.filledBy === 'employer'
                            ? 'border-purple-500 bg-purple-100/50 hover:border-purple-600'
                            : field.required === true
                                ? 'border-red-500 bg-red-100/40 hover:border-red-600'
                                : 'border-blue-400 bg-blue-100/40 hover:border-dd-green'
            }`}
            style={{
                left: `${field.x * 100}%`,
                top: `${field.y * 100}%`,
                width: `${field.w * 100}%`,
                height: `${field.h * 100}%`,
            }}>
            {/* Field label pill. Was always-visible at text-[9px] which on
                dense forms (W-4, I-9) covered the underlying PDF labels and
                made it hard to verify alignment. Now: a tiny 7px pill
                visible only when the field is SELECTED or being HOVERED.
                Resting state shows nothing above the field — so admin can
                see the PDF labels they're aligning to. The full info (type
                / autofill / label / required state) is also in the side
                panel when the field is selected, so nothing is lost. */}
            <div className={`absolute top-0 left-0 -translate-y-full text-white text-[8px] font-bold px-1 py-px rounded-t whitespace-nowrap pointer-events-none transition-opacity ${
                selected
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'
            } ${
                field.filledBy === 'static' ? 'bg-amber-600'
                    : field.filledBy === 'employer' ? 'bg-purple-600'
                    : field.required === true ? 'bg-red-600'
                    : 'bg-dd-green'
            }`}>
                {field.filledBy === 'static' ? '🔒 ' : field.filledBy === 'employer' ? '👔 ' : field.required === true ? '✱ ' : ''}{field.type}{field.autofill ? ` · ${field.autofill}` : ''}{field.label ? ` · ${field.label}` : ''}
            </div>
            {selected && (
                <>
                    <button
                        onClick={(e) => { e.stopPropagation(); onDelete(); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onTouchStart={(e) => e.stopPropagation()}
                        className="absolute -top-2.5 -right-2.5 w-6 h-6 rounded-full bg-red-600 text-white text-xs font-bold flex items-center justify-center shadow z-20">
                        ×
                    </button>
                    {/* Resize handle. Bigger hit target than the visible
                        chip so it's easy to grab on touch. Pointer events
                        on this element shouldn't bubble to the marker's
                        move drag — we explicitly call startDrag('resize'). */}
                    <div
                        onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'resize'); }}
                        onTouchStart={(e) => { e.stopPropagation(); startDrag(e, 'resize'); }}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute -bottom-2 -right-2 w-5 h-5 cursor-nwse-resize z-20 flex items-end justify-end touch-none">
                        <span className="w-3 h-3 bg-dd-green rounded-sm shadow" />
                    </div>
                </>
            )}
        </div>
    );
}

// Inline signature pad for the editor sidebar — admin signs ONCE, value
// stored as a PNG data URL on the field. Reused for every hire's PDF.
// Smaller + simpler than the hire-side modal version since this is admin
// UX where they sign once per template.
function InlineSigPad({ value, onChange, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const canvasRef = useRef(null);
    const drawing = useRef(false);
    const lastPoint = useRef(null);
    const [empty, setEmpty] = useState(!value);

    useEffect(() => {
        const c = canvasRef.current;
        if (!c) return;
        const r = c.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        c.width = r.width * dpr;
        c.height = r.height * dpr;
        const ctx = c.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#1f2937';
        if (value) {
            const img = new Image();
            img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height);
            img.src = value;
        }
    }, []);

    const pos = (e) => {
        const c = canvasRef.current;
        const r = c.getBoundingClientRect();
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
    const end = () => {
        if (drawing.current && !empty) {
            onChange(canvasRef.current.toDataURL('image/png'));
        }
        drawing.current = false;
        lastPoint.current = null;
    };
    const clear = () => {
        const c = canvasRef.current;
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
        setEmpty(true);
        onChange('');
    };

    return (
        <div>
            <canvas
                ref={canvasRef}
                className="w-full h-24 bg-white border-2 border-dashed border-amber-400 rounded touch-none"
                onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
                onTouchStart={start} onTouchMove={move} onTouchEnd={end}
            />
            <div className="flex gap-1 mt-1">
                <button type="button" onClick={clear}
                    className="flex-1 py-1 rounded bg-amber-200 text-amber-900 text-[10px] font-bold">
                    {tx('Clear', 'Borrar')}
                </button>
                {value && (
                    <span className="flex-1 py-1 rounded bg-green-100 text-green-800 text-[10px] font-bold text-center">
                        ✓ {tx('Saved', 'Guardado')}
                    </span>
                )}
            </div>
        </div>
    );
}
