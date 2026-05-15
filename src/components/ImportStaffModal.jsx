// ImportStaffModal — bulk-import new staff from a pasted list or CSV.
//
// 2026-05-15 — Andrew: "in the staff page there is a staff import button
// that looks for names thats not on the list it pulls them in a window
// and we can choose to import or not to all the names... then move onto
// the next window where i can then pick location, permissions, and all
// other things we need like pass code."
//
// Three-stage flow:
//   1. SOURCE   — paste names (one per line) OR upload a CSV exported
//                 from Toast / Sling / wherever. Detected on-the-fly.
//   2. PICK     — diff parsed names against the existing staff list.
//                 Show "new" names with checkboxes (all checked by
//                 default), and a collapsed "already on list" group
//                 so the admin can spot typos before importing.
//   3. CONFIGURE — per-row table: role, location, scheduleSide, PIN,
//                  flags (minor / shift lead / ops / recipes). Bulk
//                  "apply to all" controls on top. Auto-PIN button
//                  generates a 4-digit not already in the existing
//                  list (or already chosen in this batch).
//
// On final import, parent receives a fully-formed staff record array
// ready to merge into /config/staff.list[]. Parent does the actual
// setState + Firestore write (existing saveStaffToFirestore pattern).
//
// Why a separate file:
// AdminPanel.jsx is ~1900 lines already and we don't want to add 500
// more inline. This modal owns its own state machine; it only needs
// existingStaff (for diff + PIN collision) and defaultLocation to do
// its job.

import { useState, useMemo, useRef } from 'react';

// Canonical role list — mirrors AdminPanel.roleOptions so dropdowns
// match the rest of the staff UI. Kept in sync manually; if either
// list grows, update both.
const ROLE_OPTIONS = [
    "FOH", "BOH", "Shift Lead", "Kitchen Manager", "Asst Kitchen Manager",
    "Manager", "Owner", "Prep", "Grill", "Fryer", "Fried Rice", "Dish",
    "Bao/Tacos/Banh Mi", "Spring Rolls/Prep", "Pho Station",
];

// Normalize a name for comparison: lowercase, collapse whitespace,
// strip punctuation. Catches "Bill Smith" vs "bill  smith" vs "Bill
// Smith." — all the same person. Toast CSVs often have stray spaces
// or trailing commas.
function normalizeName(s) {
    if (!s) return '';
    return s.toString().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Parse a raw text/CSV blob into a deduped list of clean names.
// Heuristics:
//   - Detect CSV by presence of commas in the first non-empty line.
//   - If CSV header includes "first name" + "last name", join them.
//   - If CSV header includes "name" or "employee name", use that col.
//   - Otherwise treat each line as a single name (first non-empty
//     comma-separated field).
//   - Skip rows where the parsed name is empty or looks like a header
//     (case-insensitive match against common header keywords).
function parseNames(raw) {
    if (!raw) return [];
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];
    const isCsv = lines[0].includes(',');
    const names = [];
    if (isCsv) {
        const headerCells = lines[0].split(',').map(c => c.trim().toLowerCase().replace(/^"|"$/g, ''));
        const firstIdx = headerCells.findIndex(c => /^first[ _]?name$/.test(c));
        const lastIdx  = headerCells.findIndex(c => /^last[ _]?name$/.test(c));
        const nameIdx  = headerCells.findIndex(c => /^(name|employee[ _]?name|full[ _]?name)$/.test(c));
        // If we recognized a header, skip the first line.
        const hasHeader = firstIdx >= 0 || lastIdx >= 0 || nameIdx >= 0;
        const dataLines = hasHeader ? lines.slice(1) : lines;
        for (const line of dataLines) {
            const cells = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
            let n = '';
            if (firstIdx >= 0 && lastIdx >= 0) {
                n = `${cells[firstIdx] || ''} ${cells[lastIdx] || ''}`.trim();
            } else if (nameIdx >= 0) {
                n = cells[nameIdx] || '';
            } else {
                // Unknown CSV shape: assume first non-empty cell is the name.
                n = cells.find(Boolean) || '';
            }
            if (n) names.push(n);
        }
    } else {
        for (const line of lines) names.push(line);
    }
    // Dedupe by normalized form, preserve first-seen casing.
    const seen = new Set();
    const out = [];
    for (const n of names) {
        const key = normalizeName(n);
        if (!key) continue;
        // Skip lines that look like header words even outside CSV mode.
        if (/^(name|employee|staff|first|last|full)$/.test(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(n.trim());
    }
    return out;
}

// Random 4-digit PIN that's not in any of the supplied taken-sets.
// Tries 50 times; if everything's taken (extremely unlikely with
// 10000 possible values), returns "" so the admin sees a blank to fill.
function generatePin(taken1, taken2) {
    for (let i = 0; i < 50; i++) {
        const pin = String(Math.floor(1000 + Math.random() * 9000));
        if (!taken1.has(pin) && !taken2.has(pin)) return pin;
    }
    return '';
}

export default function ImportStaffModal({ existingStaff, defaultLocation, language, onCancel, onImport }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const [stage, setStage] = useState('source'); // 'source' | 'pick' | 'configure'
    const [pasted, setPasted] = useState('');
    // Toggled "selected for import" set, keyed by normalized name. Default-on.
    const [selected, setSelected] = useState(new Set());
    // Configure-stage rows. One per selected name.
    const [rows, setRows] = useState([]);
    // For collapsing the "already on list" group on stage 2.
    const [showExisting, setShowExisting] = useState(false);
    const fileInputRef = useRef(null);

    // Normalized lookup over existing staff for fast diff.
    const existingByNorm = useMemo(() => {
        const m = new Map();
        for (const s of (existingStaff || [])) {
            if (s?.name) m.set(normalizeName(s.name), s);
        }
        return m;
    }, [existingStaff]);

    // All PINs currently on the staff list — for collision detection
    // when auto-generating a new PIN.
    const existingPins = useMemo(() => {
        const out = new Set();
        for (const s of (existingStaff || [])) {
            const p = String(s?.pin ?? '').trim();
            if (/^\d{4}$/.test(p)) out.add(p);
        }
        return out;
    }, [existingStaff]);

    // Parse the pasted/uploaded text on-the-fly so stage 1 can preview
    // the diff before the admin commits to a "next" click.
    const parsed = useMemo(() => parseNames(pasted), [pasted]);
    const splitParsed = useMemo(() => {
        const newOnes = [];
        const existing = [];
        for (const n of parsed) {
            const key = normalizeName(n);
            if (existingByNorm.has(key)) existing.push({ display: n, match: existingByNorm.get(key) });
            else newOnes.push(n);
        }
        return { newOnes, existing };
    }, [parsed, existingByNorm]);

    // ── File upload — reads as text and folds into the pasted buffer.
    const handleFile = (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
            const text = String(reader.result || '');
            // Concat with existing paste, separated by newline. Lets the
            // admin upload multiple files OR paste + upload.
            setPasted(prev => prev ? prev.trimEnd() + '\n' + text : text);
        };
        reader.readAsText(f);
        // Reset input so the same file can be re-picked if needed.
        e.target.value = '';
    };

    // ── Stage 1 → 2 transition. Default-check every "new" name.
    const goToPick = () => {
        const all = new Set(splitParsed.newOnes.map(n => normalizeName(n)));
        setSelected(all);
        setStage('pick');
    };

    // ── Stage 2 → 3 transition. Build one configure-row per selected name.
    const goToConfigure = () => {
        const pinsInBatch = new Set();
        const selectedNames = splitParsed.newOnes.filter(n => selected.has(normalizeName(n)));
        const built = selectedNames.map((name, idx) => {
            const pin = generatePin(existingPins, pinsInBatch);
            if (pin) pinsInBatch.add(pin);
            return {
                tempId: `imp-${Date.now()}-${idx}`,
                name,
                role: 'FOH',
                location: defaultLocation || 'webster',
                scheduleSide: 'foh',
                pin,
                isMinor: false,
                shiftLead: false,
                opsAccess: false,
                recipesAccess: true, // opt-OUT model — default ON like Add Staff form
            };
        });
        setRows(built);
        setStage('configure');
    };

    const updateRow = (tempId, patch) => {
        setRows(prev => prev.map(r => r.tempId === tempId ? { ...r, ...patch } : r));
    };
    const removeRow = (tempId) => {
        setRows(prev => prev.filter(r => r.tempId !== tempId));
    };
    // "Apply to all" bulk-setters for the most common fields.
    const applyToAll = (field, value) => {
        setRows(prev => prev.map(r => ({ ...r, [field]: value })));
    };
    // Single-row PIN regenerate.
    const regenPin = (tempId) => {
        const others = new Set(rows.filter(r => r.tempId !== tempId).map(r => r.pin).filter(p => /^\d{4}$/.test(p)));
        const pin = generatePin(existingPins, others);
        updateRow(tempId, { pin });
    };

    // ── Final import validation. Returns null if OK, else a reason string.
    const importBlockedReason = (() => {
        if (rows.length === 0) return tx('Nothing to import', 'Nada para importar');
        for (const r of rows) {
            if (!r.name.trim()) return tx('Every row needs a name', 'Cada fila necesita un nombre');
            if (!/^\d{4}$/.test(String(r.pin || ''))) return tx(`PIN for ${r.name} must be 4 digits`, `PIN para ${r.name} debe ser 4 dígitos`);
        }
        // PIN collision inside the batch.
        const seenPin = new Set();
        for (const r of rows) {
            if (seenPin.has(r.pin)) return tx(`Duplicate PIN ${r.pin} in this batch`, `PIN duplicado ${r.pin} en este lote`);
            seenPin.add(r.pin);
            if (existingPins.has(r.pin)) return tx(`PIN ${r.pin} already in use`, `PIN ${r.pin} ya en uso`);
        }
        // Name collision against existing list (in case admin typed over
        // an auto-filled name into something that DOES exist).
        const existingNames = new Set((existingStaff || []).map(s => normalizeName(s.name)));
        const seenName = new Set();
        for (const r of rows) {
            const k = normalizeName(r.name);
            if (existingNames.has(k)) return tx(`${r.name} is already on the staff list`, `${r.name} ya está en la lista`);
            if (seenName.has(k)) return tx(`${r.name} appears twice in this batch`, `${r.name} aparece dos veces en este lote`);
            seenName.add(k);
        }
        return null;
    })();
    const canImport = importBlockedReason === null;

    const handleSubmit = () => {
        if (!canImport) return;
        // Allocate IDs — next id is max existing + 1, then increment per row.
        const maxId = (existingStaff || []).reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
        const finalRecords = rows.map((r, i) => ({
            id: maxId + 1 + i,
            name: r.name.trim(),
            role: r.role,
            pin: r.pin,
            location: r.location,
            scheduleHome: r.location === 'both' ? 'both' : r.location,
            scheduleSide: r.scheduleSide,
            isMinor: r.isMinor,
            shiftLead: r.shiftLead,
            opsAccess: r.opsAccess,
            recipesAccess: r.recipesAccess,
            // Sensible defaults for everything else — admin can refine later
            // via the standard edit form.
            viewLabor: /manager|owner/i.test(r.role),
            targetHours: 0,
            canEditScheduleFOH: false,
            canEditScheduleBOH: false,
            preferredLanguage: 'en',
            homeView: 'auto',
            hiddenPages: [],
        }));
        onImport(finalRecords);
    };

    // ─────────────────────────────────────────────────────────────────
    // Render. Single full-screen-ish modal, stage switches the body.
    return (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full my-8">
                {/* Header — same across stages, shows breadcrumb */}
                <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white rounded-t-2xl">
                    <div>
                        <h2 className="text-lg font-bold text-blue-700">📥 {tx('Import Staff', 'Importar Personal')}</h2>
                        <div className="flex items-center gap-1.5 mt-1 text-[11px]">
                            <span className={`px-2 py-0.5 rounded-full font-bold ${stage === 'source' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>1. {tx('Paste / Upload', 'Pegar / Subir')}</span>
                            <span className="text-gray-400">→</span>
                            <span className={`px-2 py-0.5 rounded-full font-bold ${stage === 'pick' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>2. {tx('Pick names', 'Elegir nombres')}</span>
                            <span className="text-gray-400">→</span>
                            <span className={`px-2 py-0.5 rounded-full font-bold ${stage === 'configure' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>3. {tx('Configure', 'Configurar')}</span>
                        </div>
                    </div>
                    <button onClick={onCancel} className="px-3 py-1 rounded-lg bg-gray-200 text-gray-700 text-sm font-bold hover:bg-gray-300">✕</button>
                </div>

                {/* ── STAGE 1: SOURCE ─────────────────────────────────── */}
                {stage === 'source' && (
                    <div className="p-5 space-y-4">
                        <div>
                            <h3 className="text-sm font-bold text-gray-800 mb-2">{tx('Paste names', 'Pegar nombres')}</h3>
                            <p className="text-xs text-gray-500 mb-2">
                                {tx('One name per line, or paste a CSV (Toast / Sling / spreadsheet). I auto-detect "First Name" + "Last Name" columns, or any "Name" column.',
                                    'Un nombre por línea, o pega un CSV (Toast / Sling / hoja de cálculo). Detecto automáticamente las columnas "First Name" + "Last Name", o cualquier columna "Name".')}
                            </p>
                            <textarea
                                value={pasted}
                                onChange={e => setPasted(e.target.value)}
                                placeholder={tx('Bill Johnson\nEmily Garcia\nMaria López\n…', 'Bill Johnson\nEmily Garcia\nMaria López\n…')}
                                rows={10}
                                className="w-full border-2 border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none" />
                        </div>
                        <div className="border-t border-gray-200 pt-3">
                            <button onClick={() => fileInputRef.current?.click()}
                                className="px-4 py-2 bg-blue-100 text-blue-700 rounded-lg text-sm font-bold hover:bg-blue-200">
                                📂 {tx('Upload CSV / TXT', 'Subir CSV / TXT')}
                            </button>
                            <input ref={fileInputRef} type="file" accept=".csv,.txt" onChange={handleFile} className="hidden" />
                            <span className="ml-3 text-xs text-gray-500">
                                {tx('Adds to the names above', 'Se agrega a los nombres de arriba')}
                            </span>
                        </div>

                        {/* Live preview — surfaces the diff before they click Continue. */}
                        {parsed.length > 0 && (
                            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs">
                                <div className="font-bold text-blue-900 mb-1">
                                    {tx(`Detected ${parsed.length} name${parsed.length === 1 ? '' : 's'}`, `Detectados ${parsed.length} nombre${parsed.length === 1 ? '' : 's'}`)}
                                </div>
                                <div className="text-blue-700">
                                    🆕 {splitParsed.newOnes.length} {tx('new', 'nuevos')}
                                    {' · '}
                                    ✓ {splitParsed.existing.length} {tx('already on list', 'ya en la lista')}
                                </div>
                            </div>
                        )}

                        <div className="flex justify-end gap-2 pt-3 border-t border-gray-200">
                            <button onClick={onCancel}
                                className="px-4 py-2 rounded-lg bg-gray-300 text-gray-700 font-bold hover:bg-gray-400 text-sm">
                                {tx('Cancel', 'Cancelar')}
                            </button>
                            <button onClick={goToPick}
                                disabled={splitParsed.newOnes.length === 0}
                                className={`px-4 py-2 rounded-lg font-bold text-sm ${splitParsed.newOnes.length === 0 ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                                {tx(`Continue (${splitParsed.newOnes.length} new)`, `Continuar (${splitParsed.newOnes.length} nuevos)`)}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── STAGE 2: PICK ──────────────────────────────────── */}
                {stage === 'pick' && (
                    <div className="p-5 space-y-4">
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                            <p className="font-bold text-blue-900">
                                {tx(`${splitParsed.newOnes.length} new name${splitParsed.newOnes.length === 1 ? '' : 's'} detected. Pick which to import.`,
                                    `${splitParsed.newOnes.length} nombre${splitParsed.newOnes.length === 1 ? '' : 's'} nuevo${splitParsed.newOnes.length === 1 ? '' : 's'} detectado${splitParsed.newOnes.length === 1 ? '' : 's'}. Elige cuáles importar.`)}
                            </p>
                        </div>

                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-bold text-gray-800">
                                🆕 {tx('New names', 'Nuevos nombres')} ({selected.size}/{splitParsed.newOnes.length})
                            </h3>
                            <div className="flex gap-1">
                                <button onClick={() => setSelected(new Set(splitParsed.newOnes.map(n => normalizeName(n))))}
                                    className="text-xs px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 font-bold">
                                    {tx('All', 'Todos')}
                                </button>
                                <button onClick={() => setSelected(new Set())}
                                    className="text-xs px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 font-bold">
                                    {tx('None', 'Ninguno')}
                                </button>
                            </div>
                        </div>
                        <div className="max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                            {splitParsed.newOnes.map(n => {
                                const key = normalizeName(n);
                                const on = selected.has(key);
                                return (
                                    <label key={key} className="flex items-center gap-3 px-3 py-2 hover:bg-blue-50 cursor-pointer">
                                        <input type="checkbox" checked={on}
                                            onChange={e => {
                                                setSelected(prev => {
                                                    const next = new Set(prev);
                                                    if (e.target.checked) next.add(key); else next.delete(key);
                                                    return next;
                                                });
                                            }}
                                            className="w-4 h-4 accent-blue-600" />
                                        <span className="text-sm text-gray-800">{n}</span>
                                    </label>
                                );
                            })}
                            {splitParsed.newOnes.length === 0 && (
                                <div className="p-4 text-sm text-gray-500 italic text-center">
                                    {tx('No new names — everyone is already on the staff list.', 'Sin nombres nuevos — todos ya están en la lista.')}
                                </div>
                            )}
                        </div>

                        {/* Collapsed "already on list" group — visible for typo
                            spotting. Pure read-only. */}
                        {splitParsed.existing.length > 0 && (
                            <div>
                                <button onClick={() => setShowExisting(v => !v)}
                                    className="text-xs font-bold text-gray-600 hover:text-gray-800">
                                    {showExisting ? '▼' : '▶'} {tx(`${splitParsed.existing.length} already on list`, `${splitParsed.existing.length} ya en la lista`)}
                                </button>
                                {showExisting && (
                                    <div className="mt-2 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-40 overflow-y-auto">
                                        {splitParsed.existing.map((e, i) => (
                                            <div key={i} className="flex items-center justify-between px-3 py-1.5 text-xs">
                                                <span className="text-gray-600">{e.display}</span>
                                                <span className="text-gray-400">→ {e.match.name}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="flex justify-between gap-2 pt-3 border-t border-gray-200">
                            <button onClick={() => setStage('source')}
                                className="px-4 py-2 rounded-lg bg-gray-300 text-gray-700 font-bold hover:bg-gray-400 text-sm">
                                ← {tx('Back', 'Atrás')}
                            </button>
                            <button onClick={goToConfigure}
                                disabled={selected.size === 0}
                                className={`px-4 py-2 rounded-lg font-bold text-sm ${selected.size === 0 ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                                {tx(`Configure ${selected.size} →`, `Configurar ${selected.size} →`)}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── STAGE 3: CONFIGURE ─────────────────────────────── */}
                {stage === 'configure' && (
                    <div className="p-5 space-y-4">
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                            <p className="font-bold text-amber-900 mb-1">
                                {tx('Set role + location + PIN for each. Use the "apply to all" row to bulk-set if they share defaults.',
                                    'Establece rol + ubicación + PIN para cada uno. Usa la fila "aplicar a todos" para asignar valores por lotes si comparten valores predeterminados.')}
                            </p>
                            <p className="text-amber-700">
                                {tx('PINs were auto-generated. Click 🎲 on any row to regenerate. Everything else can be tweaked later from the staff list.',
                                    'Los PINs se generaron automáticamente. Toca 🎲 en cualquier fila para regenerar. Todo lo demás se puede ajustar luego desde la lista.')}
                            </p>
                        </div>

                        {/* Apply-to-all bar — bulk defaults for the most common fields. */}
                        <div className="bg-gray-100 rounded-lg p-3 space-y-2">
                            <p className="text-[11px] font-bold text-gray-600 uppercase tracking-wider">{tx('Apply to all', 'Aplicar a todos')}</p>
                            <div className="grid grid-cols-3 gap-2">
                                <select onChange={e => { if (e.target.value) { applyToAll('role', e.target.value); e.target.value = ''; } }}
                                    className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white">
                                    <option value="">{tx('Set role…', 'Rol…')}</option>
                                    {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                                <select onChange={e => { if (e.target.value) { applyToAll('location', e.target.value); e.target.value = ''; } }}
                                    className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white">
                                    <option value="">{tx('Set location…', 'Ubicación…')}</option>
                                    <option value="webster">Webster</option>
                                    <option value="maryland">Maryland Heights</option>
                                    <option value="both">{tx('Both', 'Ambas')}</option>
                                </select>
                                <select onChange={e => { if (e.target.value) { applyToAll('scheduleSide', e.target.value); e.target.value = ''; } }}
                                    className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white">
                                    <option value="">{tx('Set side…', 'Lado…')}</option>
                                    <option value="foh">FOH</option>
                                    <option value="boh">BOH</option>
                                </select>
                            </div>
                        </div>

                        {/* Per-row config cards. Cards over a table because mobile-
                            and-up admins need to set flags easily; a table at this
                            density gets cramped on iPad / iPhone landscape. */}
                        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                            {rows.map(r => (
                                <div key={r.tempId} className="border-2 border-gray-200 rounded-lg p-3 bg-white">
                                    <div className="flex items-center gap-2 mb-2">
                                        <input value={r.name}
                                            onChange={e => updateRow(r.tempId, { name: e.target.value })}
                                            className="flex-1 px-2 py-1.5 text-sm font-bold border border-gray-300 rounded focus:border-blue-500 focus:outline-none" />
                                        <button onClick={() => removeRow(r.tempId)}
                                            className="px-2 py-1.5 text-xs rounded bg-red-100 text-red-700 font-bold hover:bg-red-200">
                                            {tx('Drop', 'Quitar')}
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                                        <div>
                                            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">{tx('Role', 'Rol')}</label>
                                            <select value={r.role}
                                                onChange={e => updateRow(r.tempId, { role: e.target.value })}
                                                className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white">
                                                {ROLE_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">{tx('Location', 'Ubicación')}</label>
                                            <select value={r.location}
                                                onChange={e => updateRow(r.tempId, { location: e.target.value })}
                                                className="w-full px-2 py-1 text-xs border border-gray-300 rounded bg-white">
                                                <option value="webster">Webster</option>
                                                <option value="maryland">Maryland Hts</option>
                                                <option value="both">{tx('Both', 'Ambas')}</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">{tx('Side', 'Lado')}</label>
                                            <div className="grid grid-cols-2 gap-1">
                                                <button onClick={() => updateRow(r.tempId, { scheduleSide: 'foh' })}
                                                    className={`py-1 rounded text-[11px] font-bold ${r.scheduleSide === 'foh' ? 'bg-teal-600 text-white' : 'bg-white border border-gray-300 text-gray-600'}`}>FOH</button>
                                                <button onClick={() => updateRow(r.tempId, { scheduleSide: 'boh' })}
                                                    className={`py-1 rounded text-[11px] font-bold ${r.scheduleSide === 'boh' ? 'bg-orange-600 text-white' : 'bg-white border border-gray-300 text-gray-600'}`}>BOH</button>
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">PIN</label>
                                            <div className="flex gap-1">
                                                <input value={r.pin} inputMode="numeric" maxLength={4}
                                                    onChange={e => updateRow(r.tempId, { pin: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                                                    className="flex-1 min-w-0 px-2 py-1 text-xs font-mono border border-gray-300 rounded text-center" />
                                                <button onClick={() => regenPin(r.tempId)}
                                                    title={tx('Regenerate', 'Regenerar')}
                                                    className="px-1.5 rounded bg-blue-100 text-blue-700 text-xs hover:bg-blue-200">🎲</button>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        <button onClick={() => updateRow(r.tempId, { isMinor: !r.isMinor })}
                                            className={`px-2 py-1 rounded text-[11px] font-bold ${r.isMinor ? 'bg-amber-500 text-white' : 'bg-gray-100 text-gray-600'}`}>
                                            🔑 {tx('Minor', 'Menor')}
                                        </button>
                                        <button onClick={() => updateRow(r.tempId, { shiftLead: !r.shiftLead })}
                                            className={`px-2 py-1 rounded text-[11px] font-bold ${r.shiftLead ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                                            🛡️ {tx('Shift Lead', 'Líder')}
                                        </button>
                                        <button onClick={() => updateRow(r.tempId, { opsAccess: !r.opsAccess })}
                                            className={`px-2 py-1 rounded text-[11px] font-bold ${r.opsAccess ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                                            📋 {tx('Ops', 'Ops')}
                                        </button>
                                        <button onClick={() => updateRow(r.tempId, { recipesAccess: !r.recipesAccess })}
                                            className={`px-2 py-1 rounded text-[11px] font-bold ${r.recipesAccess ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                                            🧑‍🍳 {tx('Recipes', 'Recetas')}
                                        </button>
                                    </div>
                                </div>
                            ))}
                            {rows.length === 0 && (
                                <div className="p-4 text-sm text-gray-500 italic text-center">
                                    {tx('All rows removed. Go back to add someone.', 'Todas las filas eliminadas. Regresa para agregar a alguien.')}
                                </div>
                            )}
                        </div>

                        {/* Save-blocked banner — same pattern as Schedule modals. */}
                        {importBlockedReason && (
                            <div className="bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-xs font-bold text-amber-800">
                                ⚠ {importBlockedReason}
                            </div>
                        )}

                        <div className="flex justify-between gap-2 pt-3 border-t border-gray-200">
                            <button onClick={() => setStage('pick')}
                                className="px-4 py-2 rounded-lg bg-gray-300 text-gray-700 font-bold hover:bg-gray-400 text-sm">
                                ← {tx('Back', 'Atrás')}
                            </button>
                            <button onClick={handleSubmit}
                                disabled={!canImport}
                                title={canImport ? '' : importBlockedReason}
                                className={`px-4 py-2 rounded-lg font-bold text-sm ${canImport ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}>
                                ✓ {tx(`Import ${rows.length}`, `Importar ${rows.length}`)}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
