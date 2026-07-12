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
import { upsertHealthRecord } from '../data/health';
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
