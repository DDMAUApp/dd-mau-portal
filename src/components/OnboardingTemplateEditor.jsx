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
import { ref as sref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
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
        if (!initialTemplate?.storagePath) return;
        let alive = true;
        (async () => {
            setLoadingPdf(true);
            try {
                const url = await getDownloadURL(sref(storage, initialTemplate.storagePath));
                const res = await fetch(url);
                const buf = await res.arrayBuffer();
                if (!alive) return;
                setPdfBytes(buf);
                await renderPdf(buf);
            } catch (e) { console.warn('Load existing template failed', e); setError('Failed to load PDF.'); }
            finally { setLoadingPdf(false); }
        })();
        return () => { alive = false; };
    }, [initialTemplate?.storagePath]);

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
            if (!name) setName(file.name.replace(/\.pdf$/i, ''));
            await renderPdf(buf);
        } finally {
            setLoadingPdf(false);
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
            if (pdfBytes && (!initialTemplate || initialTemplate.pendingNewPdf)) {
                // Allocate a fresh storage path; templates are append-only —
                // never overwrite the original so we can roll back.
                const ts = Date.now();
                const safeId = (forDocId || 'template') + '_' + ts;
                storagePath = `onboarding_templates/${safeId}.pdf`;
                await uploadBytes(sref(storage, storagePath), new Blob([pdfBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
            }
            // 2. Save metadata + fields.
            const meta = {
                name: name.trim(),
                forDocId,
                storagePath,
                fields,
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
                            {ONBOARDING_DOCS.filter(d => d.kind === 'template').map(d => (
                                <option key={d.id} value={d.id}>{isEs ? d.es : d.en}</option>
                            ))}
                        </select>
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
                                    onMove={(dx, dy) => updateField(f.id, {
                                        x: Math.max(0, Math.min(1 - f.w, f.x + dx)),
                                        y: Math.max(0, Math.min(1 - f.h, f.y + dy)),
                                    })}
                                    onResize={(dw, dh) => updateField(f.id, {
                                        w: Math.max(0.02, Math.min(1 - f.x, f.w + dw)),
                                        h: Math.max(0.015, Math.min(1 - f.y, f.h + dh)),
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
                                            ? 'bg-mint-700 text-white border-mint-700'
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
                            <div>
                                <label className="text-[10px] font-bold text-gray-500">
                                    {tx('Label (optional)', 'Etiqueta (opcional)')}
                                </label>
                                <input value={selected.label}
                                    onChange={e => updateField(selected.id, { label: e.target.value })}
                                    placeholder={tx('e.g. "Box 1c"', 'ej: "Casilla 1c"')}
                                    className="w-full border border-gray-300 rounded px-2 py-1 text-xs" />
                            </div>
                            {(selected.type === 'text' || selected.type === 'date') && (
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
function FieldMarker({ field, selected, onSelect, onMove, onResize, onDelete, isEs }) {
    const dragState = useRef(null);
    const startDrag = (e, mode) => {
        e.stopPropagation();
        e.preventDefault();
        const rect = e.currentTarget.closest('.relative').getBoundingClientRect();
        dragState.current = {
            mode,
            startX: e.clientX,
            startY: e.clientY,
            rect,
        };
        const onMouseMove = (ev) => {
            if (!dragState.current) return;
            const dx = (ev.clientX - dragState.current.startX) / dragState.current.rect.width;
            const dy = (ev.clientY - dragState.current.startY) / dragState.current.rect.height;
            if (dragState.current.mode === 'move') {
                onMove(dx, dy);
            } else {
                onResize(dx, dy);
            }
            dragState.current.startX = ev.clientX;
            dragState.current.startY = ev.clientY;
        };
        const onMouseUp = () => {
            dragState.current = null;
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    };
    return (
        <div
            onClick={onSelect}
            onMouseDown={(e) => { onSelect(e); startDrag(e, 'move'); }}
            className={`absolute cursor-move border-2 group ${
                selected
                    ? 'border-mint-700 bg-mint-200/40 z-10'
                    : 'border-blue-400 bg-blue-100/40 hover:border-mint-500'
            }`}
            style={{
                left: `${field.x * 100}%`,
                top: `${field.y * 100}%`,
                width: `${field.w * 100}%`,
                height: `${field.h * 100}%`,
            }}>
            <div className="absolute top-0 left-0 -translate-y-full bg-mint-700 text-white text-[9px] font-bold px-1 py-0.5 rounded-t whitespace-nowrap">
                {field.type}{field.autofill ? ` · ${field.autofill}` : ''}{field.label ? ` · ${field.label}` : ''}
            </div>
            {selected && (
                <>
                    <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
                        className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center shadow z-10">
                        ×
                    </button>
                    <div onMouseDown={(e) => startDrag(e, 'resize')}
                        className="absolute -bottom-1 -right-1 w-3 h-3 bg-mint-700 cursor-nwse-resize rounded-sm z-10" />
                </>
            )}
        </div>
    );
}
