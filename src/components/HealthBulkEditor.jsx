// Health records — bulk import & edit (Admin page, Andrew 2026-07-12).
//
// Spreadsheet-style grid of EVERY active staff member with inline
// hired / shot 1 / shot 2 / exempt editing, dirty-tracking, and one
// "Save all" that upserts each changed /health_records/{staffId} doc
// (stamped verified-by the admin). Plus a paste-import box: copy rows
// straight out of Excel/Sheets/Numbers ("Name, hired, shot1, shot2"),
// names fuzzy-match the roster, parsed dates land in the grid as
// pending edits for review before saving.
import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { upsertHealthRecord, extractHealthDoc, loadHealthDocsConfig } from '../data/health';
import { storage } from '../firebase';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { toast } from '../toast';

// Accepts 2026-01-15, 1/15/26, 01-15-2026, 1.15.26 → 'YYYY-MM-DD' | ''.
export function normalizeDateInput(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
    if (!m) return '';
    let [, mo, d, y] = m;
    if (y.length === 2) y = '20' + y;
    mo = mo.padStart(2, '0'); d = d.padStart(2, '0');
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return '';
    return `${y}-${mo}-${d}`;
}

// Parse pasted spreadsheet rows: Name <tab|,> hired <tab|,> shot1 <tab|,> shot2
// Returns { matched: [{staffId, name, patch}], unmatched: [line] }.
export function parsePastedRows(text, staffList) {
    const matched = [], unmatched = [];
    const roster = (staffList || []).filter(s => s && s.name);
    const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const cells = line.split(/\t|,/).map(c => c.trim());
        const name = cells[0];
        if (!name) continue;
        const person = roster.find(s => norm(s.name) === norm(name))
            || roster.find(s => norm(s.name).startsWith(norm(name)) || norm(name).startsWith(norm(s.name)));
        if (!person) { unmatched.push(line); continue; }
        const patch = {};
        const hired = normalizeDateInput(cells[1]);
        const s1 = normalizeDateInput(cells[2]);
        const s2 = normalizeDateInput(cells[3]);
        if (hired) patch.hiredDate = hired;
        if (s1) patch.shot1Date = s1;
        if (s2) patch.shot2Date = s2;
        if (Object.keys(patch).length === 0) { unmatched.push(line + '   ← no readable dates'); continue; }
        matched.push({ staffId: String(person.id), name: person.name, patch });
    }
    return { matched, unmatched };
}

export default function HealthBulkEditor({ staffList = [], language = 'en', byName = '' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [open, setOpen] = useState(false);
    const [records, setRecords] = useState({});
    const [edits, setEdits] = useState({});      // staffId → {hiredDate?, shot1Date?, shot2Date?, exempt?}
    const [pasteText, setPasteText] = useState('');
    const [pasteResult, setPasteResult] = useState(null);
    const [saving, setSaving] = useState(false);

    // ── Mass document import (Andrew 2026-07-12) ──────────────────────
    // Select MANY files at once; each is uploaded, AI-read (name + shot
    // dates come off the card), auto-matched to a staff member, and
    // classified. Admin reviews the table, fixes any assignment, and
    // one Apply files everything — including marking paper-signed
    // required docs as signed so existing staff never re-sign.
    const [massRows, setMassRows] = useState([]);   // {id,fileName,url,path,extracted,staffId,kind,status}
    const [massBusy, setMassBusy] = useState('');   // '' | 'reading 3/12' | 'applying 3/12'
    const [docsConfig, setDocsConfig] = useState([]);
    useEffect(() => {
        if (!open) return;
        loadHealthDocsConfig().then(setDocsConfig).catch(() => setDocsConfig([]));
    }, [open]);

    const guessStaffId = (personName) => {
        const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!personName) return '';
        const n = norm(personName);
        // Substring matches require a REAL full name (two words) on the
        // roster side — a one-word roster entry ("Test", a first name)
        // inside the document's name is coincidence, not identity, and a
        // silent wrong auto-assign files the doc to the wrong person.
        const full = (p) => norm(p.name).includes(' ');
        const hit = rows.find(p => norm(p.name) === n)
            || rows.find(p => full(p) && (norm(p.name).includes(n) || n.includes(norm(p.name))))
            || rows.find(p => {
                const toks = n.split(' ').filter(Boolean);
                const hay = norm(p.name);
                return toks.length >= 2 && toks.every(t => hay.includes(t));
            });
        return hit ? String(hit.id) : '';
    };

    // Andrew 2026-07-13: "i have 38 files in one doc … assign the doc that
    // has 38 pages to 38 different [staff]". A multi-page PDF is really N
    // separate records scanned into one file, so each page becomes its OWN
    // import row: rendered to a JPEG (pdfjs, same lazy pattern as
    // OnboardingFillablePdf), AI-read individually, and assignable to a
    // different staff member. Single-page PDFs go through the same path —
    // a bonus, since the AI reader only accepts images, so pages of PDFs
    // become readable where the raw PDF wasn't. The original PDF is also
    // parked in _import for archive (not a row).
    const pdfToPageBlobs = async (file, onProgress) => {
        const pdfjs = await import('pdfjs-dist');
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
            const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
            pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        }
        const data = await file.arrayBuffer();
        const doc = await pdfjs.getDocument({ data }).promise;
        const base = file.name.replace(/\.pdf$/i, '');
        const out = [];
        for (let p = 1; p <= doc.numPages; p++) {
            onProgress?.(p, doc.numPages);
            const page = await doc.getPage(p);
            // ~2000px on the long edge — plenty for the AI to read
            // handwriting on a vaccine card without huge uploads.
            const v1 = page.getViewport({ scale: 1 });
            const scale = Math.min(3, 2000 / Math.max(v1.width, v1.height));
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            // intent:'print' — the default 'display' intent schedules canvas
            // work on requestAnimationFrame, which browsers FREEZE in
            // background/occluded tabs, so a 38-page import would stall the
            // moment the admin switches tabs. Print intent renders straight
            // through (verified: hung forever on 'display', 14ms on 'print'
            // in an occluded tab).
            await page.render({ canvasContext: canvas.getContext('2d'), viewport, intent: 'print' }).promise;
            const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
            if (blob) out.push({ blob, name: `${base}-page${String(p).padStart(2, '0')}.jpg`, type: 'image/jpeg' });
        }
        doc.destroy?.();
        return out;
    };

    const onMassFiles = async (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        if (files.length === 0) return;
        // Expand: images pass through; PDFs explode into one item per page.
        const items = [];
        for (const file of files) {
            const isPdf = (file.type || '').includes('pdf') || /\.pdf$/i.test(file.name);
            if (!isPdf) { items.push({ blob: file, name: file.name, type: file.type || 'image/jpeg' }); continue; }
            try {
                const pages = await pdfToPageBlobs(file, (p, n) =>
                    setMassBusy(`${tx('Splitting PDF page', 'Separando página')} ${p}/${n}…`));
                items.push(...pages);
                // Archive the original multi-page PDF alongside (best-effort).
                try {
                    const apath = `health/_import/${Date.now()}-original-${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
                    await uploadBytes(storageRef(storage, apath), file, { contentType: 'application/pdf' });
                } catch { /* archive is best-effort */ }
            } catch (err) {
                console.error('pdf split failed:', file.name, err?.message);
                // Fall back to the old behavior: store the PDF whole (no AI).
                items.push({ blob: file, name: file.name, type: 'application/pdf' });
            }
        }
        const staged = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            setMassBusy(`${tx('Uploading', 'Subiendo')} ${i + 1}/${items.length}…`);
            try {
                const path = `health/_import/${Date.now()}-${i}-${item.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
                const sref = storageRef(storage, path);
                await uploadBytes(sref, item.blob, { contentType: item.type });
                const url = await getDownloadURL(sref);
                staged.push({ id: `${Date.now()}-${i}`, fileName: item.name, url, path, isImage: (item.type || '').startsWith('image/'), extracted: null, staffId: '', kind: 'record', status: 'pending', shot1: '', shot2: '' });
            } catch (err) {
                console.error('mass upload failed:', item.name, err?.message);
            }
        }
        setMassRows(prev => [...prev, ...staged]);
        // AI-read sequentially (rate limit is 60/5min server-side).
        for (let i = 0; i < staged.length; i++) {
            const row = staged[i];
            if (!row.isImage) continue;
            setMassBusy(`🤖 ${tx('Reading', 'Leyendo')} ${i + 1}/${staged.length}…`);
            try {
                const ex = await extractHealthDoc([row.url]);
                const staffId = guessStaffId(ex.personName);
                const kind = ex.docType === 'hepA_card' ? 'vaccine' : 'record';
                // Seed the editable per-row shot dates from the AI read —
                // Andrew reviews/corrects them in the table and Apply writes
                // exactly these into the staff record (no post-import fixup).
                setMassRows(prev => prev.map(r => r.id === row.id ? {
                    ...r, extracted: ex, staffId: r.staffId || staffId, kind,
                    shot1: normalizeDateInput(ex.hepAShot1Date || '') || '',
                    shot2: normalizeDateInput(ex.hepAShot2Date || '') || '',
                } : r));
            } catch (err) {
                console.warn('mass extract failed:', err?.message);
                setMassRows(prev => prev.map(r => r.id === row.id ? { ...r, extracted: { docType: 'other', notes: 'AI read failed — assign manually' } } : r));
            }
        }
        setMassBusy('');
    };

    const setMassRow = (id, patch) => setMassRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));

    const applyMass = async () => {
        const assigned = massRows.filter(r => r.staffId && r.status === 'pending');
        if (assigned.length === 0 || massBusy) return;
        let done = 0;
        for (const row of assigned) {
            setMassBusy(`${tx('Filing', 'Archivando')} ${++done}/${assigned.length}…`);
            const person = rows.find(p => String(p.id) === row.staffId);
            if (!person) continue;
            try {
                // Copy the file into the staff's own folder (tidy paths;
                // originals in _import stay too — versioned, never lost).
                let finalUrl = row.url, finalPath = row.path;
                try {
                    const blob = await (await fetch(row.url)).blob();
                    finalPath = `health/${row.staffId}/${Date.now()}-${row.fileName.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
                    const dref = storageRef(storage, finalPath);
                    await uploadBytes(dref, blob, { contentType: blob.type || 'image/jpeg' });
                    finalUrl = await getDownloadURL(dref);
                } catch { /* copy failed — reference the _import path instead */ }
                await upsertHealthRecord(row.staffId, person.name, (rec) => {
                    rec.files = [...(rec.files || []), {
                        url: finalUrl, path: finalPath, label: row.fileName,
                        kind: row.kind === 'vaccine' ? 'hepA_card' : row.kind.startsWith('doc:') ? 'signed_paper_doc' : (row.extracted?.docType || 'other'),
                        uploadedAt: new Date().toISOString(), uploadedBy: byName,
                        extracted: row.extracted || null, importedBatch: true,
                    }];
                    if (row.kind === 'vaccine') {
                        rec.hepA = { ...(rec.hepA || {}) };
                        // The per-row date boxes (seeded from the AI read,
                        // corrected by the admin) are authoritative — Apply
                        // writes them straight into the record so nobody has
                        // to re-enter dates after the import. A blank box
                        // leaves whatever the record already has.
                        const s1 = normalizeDateInput(row.shot1 || '') || row.extracted?.hepAShot1Date;
                        const s2 = normalizeDateInput(row.shot2 || '') || row.extracted?.hepAShot2Date;
                        if (s1) rec.hepA.shot1Date = s1;
                        if (s2) rec.hepA.shot2Date = s2;
                        rec.hepA.verifiedBy = byName;
                        rec.hepA.verifiedAt = new Date().toISOString();
                    } else if (row.kind.startsWith('doc:')) {
                        const key = row.kind.slice(4);
                        const def = (docsConfig || []).find(d => d.key === key);
                        rec.docs = { ...(rec.docs || {}), [key]: {
                            signedAt: new Date().toISOString(),
                            signedName: person.name,
                            docTitle: def?.title || key,
                            version: def?.version || 1,
                            method: 'paper',
                            note: `Paper copy on file — imported by ${byName}`,
                        } };
                    }
                    return rec;
                }, byName);
                setMassRow(row.id, { status: 'done' });
            } catch (err) {
                console.error('mass apply failed:', person?.name, err?.message);
                setMassRow(row.id, { status: 'error' });
            }
        }
        setMassBusy('');
        const failed = massRows.filter(r => r.status === 'error').length;
        toast(failed
            ? tx(`Filed ${done - failed}, ${failed} failed`, `${done - failed} archivados, ${failed} fallaron`)
            : tx(`✅ ${done} document${done === 1 ? '' : 's'} filed`, `✅ ${done} documento${done === 1 ? '' : 's'} archivados`));
    };

    useEffect(() => {
        if (!open) return;
        const unsub = onSnapshot(collection(db, 'health_records'), (snap) => {
            const map = {};
            snap.forEach((d) => { map[d.id] = d.data(); });
            setRecords(map);
        }, (err) => console.warn('health bulk editor listener:', err?.code));
        return () => unsub();
    }, [open]);

    const rows = useMemo(
        () => (staffList || []).filter(s => s && s.name && s.active !== false)
            .slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')),
        [staffList]
    );

    const cellValue = (person, field) => {
        const id = String(person.id);
        const e = edits[id];
        if (e && field in e) return e[field];
        const rec = records[id];
        if (field === 'hiredDate') return rec?.hiredDate || '';
        if (field === 'exempt') return rec?.hepA?.exempt === true;
        return rec?.hepA?.[field] || '';
    };
    const setCell = (person, field, value) => {
        const id = String(person.id);
        setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }));
    };
    const dirtyIds = Object.keys(edits);

    const applyPaste = () => {
        const res = parsePastedRows(pasteText, rows);
        setPasteResult(res);
        if (res.matched.length) {
            setEdits((prev) => {
                const next = { ...prev };
                for (const m of res.matched) {
                    next[m.staffId] = { ...(next[m.staffId] || {}), ...m.patch };
                }
                return next;
            });
        }
    };

    const saveAll = async () => {
        if (saving || dirtyIds.length === 0) return;
        setSaving(true);
        let ok = 0, failed = 0;
        for (const id of dirtyIds) {
            const person = rows.find(p => String(p.id) === id);
            if (!person) continue;
            const e = edits[id];
            try {
                await upsertHealthRecord(id, person.name, (rec) => {
                    if ('hiredDate' in e) rec.hiredDate = e.hiredDate || '';
                    rec.hepA = { ...(rec.hepA || {}) };
                    if ('shot1Date' in e) rec.hepA.shot1Date = e.shot1Date || '';
                    if ('shot2Date' in e) rec.hepA.shot2Date = e.shot2Date || '';
                    if ('exempt' in e) rec.hepA.exempt = e.exempt === true;
                    rec.hepA.verifiedBy = byName;
                    rec.hepA.verifiedAt = new Date().toISOString();
                    return rec;
                }, byName);
                ok++;
            } catch (err) {
                console.error('bulk save failed for', person.name, err?.message);
                failed++;
            }
        }
        setSaving(false);
        setEdits({});
        setPasteResult(null); setPasteText('');
        toast(failed
            ? tx(`Saved ${ok}, ${failed} failed — try again`, `${ok} guardados, ${failed} fallaron`)
            : tx(`✅ ${ok} record${ok === 1 ? '' : 's'} saved & verified`, `✅ ${ok} registro${ok === 1 ? '' : 's'} guardados`));
    };

    return (
        <div className="mb-3">
            <button onClick={() => setOpen(o => !o)} aria-expanded={open}
                className="glass-section-head tint-red">
                <div className="flex items-center gap-3 min-w-0">
                    <span className="glass-icon-tile" aria-hidden="true">🏥</span>
                    <div className="text-left min-w-0">
                        <h3 className="font-bold text-[15px] text-dd-text">
                            {tx('Health records — bulk import & edit', 'Registros de salud — importar y editar')}
                        </h3>
                        <p className="text-[11px] text-dd-text-2 truncate">
                            {tx('Type or paste hire + Hep A dates for everyone at once', 'Escribe o pega fechas de contratación y Hep A para todos a la vez')}
                        </p>
                    </div>
                </div>
                <span className="section-chevron" aria-hidden="true">›</span>
            </button>

            {open && (
                <div className="glass-card p-3 mt-2">
                    {/* Mass document import */}
                    <details className="mb-3" open={massRows.length > 0}>
                        <summary className="text-sm font-semibold text-dd-text cursor-pointer">
                            📂 {tx('Mass import documents (vaccine cards + signed paper docs)', 'Importación masiva de documentos')}
                        </summary>
                        <p className="text-[11px] text-dd-text-2 mt-1 mb-1.5">
                            {tx('Select many files at once. Each is read automatically and matched to a staff member by the name on the document — review, fix any, pick what each file is, then Apply. Marking a file as a signed paper agreement counts that document as signed (no re-signing).',
                                'Selecciona muchos archivos a la vez. Cada uno se lee automáticamente y se asigna por el nombre en el documento — revisa, corrige, elige qué es cada archivo y Aplica.')}
                        </p>
                        <label className="glass-button-primary inline-flex items-center px-4 py-2 rounded-full text-sm font-bold cursor-pointer">
                            {tx('Choose files…', 'Elegir archivos…')}
                            <input type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={onMassFiles} disabled={!!massBusy} />
                        </label>
                        {massBusy && <span className="ml-3 text-sm text-dd-text-2">{massBusy}</span>}
                        {massRows.length > 0 && (
                            <div className="overflow-x-auto mt-2">
                                <table className="w-full text-sm min-w-[680px]">
                                    <thead>
                                        <tr className="text-left text-[11px] uppercase text-dd-text-2 border-b border-dd-line">
                                            <th className="py-1.5 px-1.5">{tx('File', 'Archivo')}</th>
                                            <th className="py-1.5 px-1.5">{tx('AI read', 'Lectura IA')}</th>
                                            <th className="py-1.5 px-1.5">{tx('Assign to', 'Asignar a')}</th>
                                            <th className="py-1.5 px-1.5">{tx('This file is', 'Este archivo es')}</th>
                                            <th className="py-1.5 px-1.5">{tx('Shot 1 / Shot 2', 'Dosis 1 / Dosis 2')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {massRows.map((r) => (
                                            <tr key={r.id} className={`border-b border-dd-line/60 ${r.status === 'done' ? 'opacity-50' : r.status === 'error' ? 'bg-red-50' : ''}`}>
                                                <td className="py-1.5 px-1.5 max-w-[160px]">
                                                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-dd-green-700 underline underline-offset-2 truncate block">{r.fileName}</a>
                                                    {r.status === 'done' && <span className="text-[10px] text-dd-green-700 font-bold">✓ {tx('filed', 'archivado')}</span>}
                                                    {r.status === 'error' && <span className="text-[10px] text-red-600 font-bold">{tx('failed — retry Apply', 'falló')}</span>}
                                                </td>
                                                <td className="py-1.5 px-1.5 text-xs text-dd-text-2 max-w-[200px]">
                                                    {r.extracted
                                                        ? <>{r.extracted.personName && <b className="text-dd-text">{r.extracted.personName}</b>}
                                                            {r.extracted.hepAShot1Date && <> · 💉1 {r.extracted.hepAShot1Date}</>}
                                                            {r.extracted.hepAShot2Date && <> · 💉2 {r.extracted.hepAShot2Date}</>}
                                                            {!r.extracted.personName && !r.extracted.hepAShot1Date && (r.extracted.notes || r.extracted.docType)}</>
                                                        : tx('reading…', 'leyendo…')}
                                                </td>
                                                <td className="py-1.5 px-1.5">
                                                    <select value={r.staffId} onChange={(e) => setMassRow(r.id, { staffId: e.target.value })}
                                                        disabled={r.status === 'done'}
                                                        className={`glass-select text-sm py-1 ${!r.staffId ? 'border-amber-400' : ''}`}>
                                                        <option value="">{tx('— pick staff —', '— elegir —')}</option>
                                                        {rows.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
                                                    </select>
                                                </td>
                                                <td className="py-1.5 px-1.5">
                                                    <select value={r.kind} onChange={(e) => setMassRow(r.id, { kind: e.target.value })}
                                                        disabled={r.status === 'done'}
                                                        className="glass-select text-sm py-1">
                                                        <option value="vaccine">{tx('Vaccine card (fills shot dates)', 'Tarjeta de vacunas')}</option>
                                                        {(docsConfig || []).map(d => (
                                                            <option key={d.key} value={`doc:${d.key}`}>{tx('Signed paper:', 'Papel firmado:')} {d.title}</option>
                                                        ))}
                                                        <option value="record">{tx('Other record (file only)', 'Otro registro')}</option>
                                                    </select>
                                                </td>
                                                <td className="py-1.5 px-1.5">
                                                    {r.kind === 'vaccine' ? (
                                                        <div className="flex flex-col gap-1">
                                                            <input type="date" value={r.shot1 || ''} disabled={r.status === 'done'}
                                                                onChange={(e) => setMassRow(r.id, { shot1: e.target.value })}
                                                                className={`glass-input text-xs py-0.5 px-1 w-[130px] ${!r.shot1 ? 'border-amber-400' : ''}`}
                                                                aria-label={tx('Shot 1 date', 'Fecha dosis 1')} />
                                                            <input type="date" value={r.shot2 || ''} disabled={r.status === 'done'}
                                                                onChange={(e) => setMassRow(r.id, { shot2: e.target.value })}
                                                                className="glass-input text-xs py-0.5 px-1 w-[130px]"
                                                                aria-label={tx('Shot 2 date', 'Fecha dosis 2')} />
                                                        </div>
                                                    ) : <span className="text-[11px] text-dd-text-2">—</span>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <div className="flex items-center justify-between mt-2">
                                    <p className="text-xs text-dd-text-2">
                                        {massRows.filter(r => r.status === 'pending' && r.staffId).length} {tx('ready', 'listos')} · {massRows.filter(r => r.status === 'pending' && !r.staffId).length} {tx('need a staff pick', 'sin asignar')}
                                    </p>
                                    <div className="flex gap-2">
                                        <button onClick={() => setMassRows(prev => prev.filter(r => r.status !== 'done'))}
                                            className="glass-button-apple px-3 py-2 rounded-full text-sm">{tx('Clear done', 'Quitar listos')}</button>
                                        <button onClick={applyMass} disabled={!!massBusy || massRows.every(r => !(r.status === 'pending' && r.staffId))}
                                            className="glass-button-primary px-5 py-2 rounded-full text-sm font-bold disabled:opacity-50">
                                            {tx('Apply assigned', 'Aplicar asignados')}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </details>

                    {/* Paste import */}
                    <details className="mb-3">
                        <summary className="text-sm font-semibold text-dd-text cursor-pointer">
                            📋 {tx('Paste from a spreadsheet', 'Pegar desde una hoja de cálculo')}
                        </summary>
                        <p className="text-[11px] text-dd-text-2 mt-1 mb-1.5">
                            {tx('One row per person: Name, hired date, shot 1 date, shot 2 date (tabs or commas — copying cells from Excel/Sheets works as-is). Parsed dates load into the grid below for review, then Save all.',
                                'Una fila por persona: Nombre, fecha de contratación, dosis 1, dosis 2 (tabulaciones o comas). Las fechas se cargan en la tabla para revisar, luego Guardar todo.')}
                        </p>
                        <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                            rows={4} placeholder={'Blanca Salgado\t3/2/24\t4/1/24\t10/5/24'}
                            className="glass-input w-full font-mono text-xs" />
                        <button onClick={applyPaste} disabled={!pasteText.trim()}
                            className="glass-button-apple px-4 py-2 rounded-full text-sm mt-1.5 disabled:opacity-50">
                            {tx('Parse & load into grid', 'Analizar y cargar')}
                        </button>
                        {pasteResult && (
                            <p className="text-xs mt-1.5">
                                <span className="text-dd-green-700 font-bold">{pasteResult.matched.length} {tx('matched', 'coincidieron')}</span>
                                {pasteResult.unmatched.length > 0 && (
                                    <span className="text-amber-700"> · {pasteResult.unmatched.length} {tx('not matched:', 'sin coincidir:')} {pasteResult.unmatched.slice(0, 3).join(' | ')}{pasteResult.unmatched.length > 3 ? '…' : ''}</span>
                                )}
                            </p>
                        )}
                    </details>

                    {/* Inline grid */}
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[620px]">
                            <thead>
                                <tr className="text-left text-[11px] uppercase text-dd-text-2 border-b border-dd-line">
                                    <th className="py-1.5 px-1.5">{tx('Staff', 'Personal')}</th>
                                    <th className="py-1.5 px-1.5">{tx('Hired', 'Contratado')}</th>
                                    <th className="py-1.5 px-1.5">{tx('Hep A shot 1', 'Hep A dosis 1')}</th>
                                    <th className="py-1.5 px-1.5">{tx('Hep A shot 2', 'Hep A dosis 2')}</th>
                                    <th className="py-1.5 px-1.5">{tx('Exempt', 'Exento')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((person) => {
                                    const dirty = edits[String(person.id)];
                                    return (
                                        <tr key={person.id} className={`border-b border-dd-line/60 ${dirty ? 'bg-amber-50/60' : ''}`}>
                                            <td className="py-1 px-1.5 font-semibold text-dd-text whitespace-nowrap">
                                                {person.name}{dirty && <span className="text-amber-600 ml-1">•</span>}
                                            </td>
                                            <td className="py-1 px-1.5"><input type="date" value={cellValue(person, 'hiredDate')}
                                                onChange={(e) => setCell(person, 'hiredDate', e.target.value)} className="glass-input text-sm py-1" /></td>
                                            <td className="py-1 px-1.5"><input type="date" value={cellValue(person, 'shot1Date')}
                                                onChange={(e) => setCell(person, 'shot1Date', e.target.value)} className="glass-input text-sm py-1" /></td>
                                            <td className="py-1 px-1.5"><input type="date" value={cellValue(person, 'shot2Date')}
                                                onChange={(e) => setCell(person, 'shot2Date', e.target.value)} className="glass-input text-sm py-1" /></td>
                                            <td className="py-1 px-1.5 text-center"><input type="checkbox" checked={cellValue(person, 'exempt')}
                                                onChange={(e) => setCell(person, 'exempt', e.target.checked)} className="w-4 h-4" /></td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    <div className="flex items-center justify-between mt-3">
                        <p className="text-xs text-dd-text-2">
                            {dirtyIds.length > 0
                                ? tx(`${dirtyIds.length} unsaved change${dirtyIds.length === 1 ? '' : 's'}`, `${dirtyIds.length} cambio${dirtyIds.length === 1 ? '' : 's'} sin guardar`)
                                : tx('No unsaved changes', 'Sin cambios')}
                        </p>
                        <div className="flex gap-2">
                            {dirtyIds.length > 0 && (
                                <button onClick={() => { setEdits({}); setPasteResult(null); }}
                                    className="glass-button-apple px-4 py-2 rounded-full text-sm">{tx('Discard', 'Descartar')}</button>
                            )}
                            <button onClick={saveAll} disabled={saving || dirtyIds.length === 0}
                                className="glass-button-primary px-5 py-2 rounded-full text-sm font-bold disabled:opacity-50">
                                {saving ? tx('Saving…', 'Guardando…') : tx('Save all', 'Guardar todo')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
