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
//                 ALSO: "Fetch from Toast" button — reads the latest
//                 employee dump the Railway scraper wrote to Firestore
//                 (see TOAST_EMPLOYEES_DOC contract below).
//   2. PICK     — diff parsed names against the existing staff list.
//                 Show "new" names with checkboxes (all checked by
//                 default), and a collapsed "already on list" group
//                 so the admin can spot typos before importing.
//                 ALSO: "Quick import N" — skips stage 3 and uses
//                 defaults + auto-PINs for everyone. Fast path for
//                 a brand-new restaurant onboarding 30+ staff at once.
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
// ── Toast scraper contract (ops/toast_employees) ──────────────────────
// The Railway scraper writes the current Toast employee list to:
//   /ops/toast_employees
// Shape:
//   {
//     employees: [
//       { name: "Bill Johnson", role?: "Server",   location?: "webster"  },
//       { name: "Emily Garcia", role?: "Cook",     location?: "maryland" },
//       ...
//     ],
//     updatedAt: <serverTimestamp>,
//     source: "toast"
//   }
// Optional per-employee fields (role, location) feed Stage 3's per-row
// defaults so the admin doesn't have to set them by hand. If the doc
// doesn't exist or has zero employees, the Fetch button surfaces a
// helpful "scraper not synced yet" message instead of silently failing.
//
// Why a separate file:
// AdminPanel.jsx is ~1900 lines already and we don't want to add 500
// more inline. This modal owns its own state machine; it only needs
// existingStaff (for diff + PIN collision) and defaultLocation to do
// its job.

import { useState, useMemo, useRef } from 'react';
import { db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';

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

// Normalize a free-text location value (from CSV / scraper) to one of
// 'webster' | 'maryland' | 'both'. Returns undefined if we can't tell
// — caller falls back to defaultLocation.
function normalizeLocation(raw) {
    if (!raw) return undefined;
    const k = String(raw).toLowerCase().trim();
    if (/^web/.test(k) || k === 'webster groves' || k === 'wg') return 'webster';
    if (/^mary/.test(k) || k === 'maryland heights' || k === 'md' || k === 'mh') return 'maryland';
    if (k === 'both' || k === 'all' || k === 'multi') return 'both';
    return undefined;
}

// Normalize a free-text role to one of ROLE_OPTIONS. Falls back to
// returning the raw role string (Stage 3 dropdown will show it if it's
// a valid option; otherwise admin can re-pick).
//
// Light mapping for the most common Toast labels seen in the wild:
//   "Server"           → "FOH"
//   "Bartender"        → "FOH"
//   "Cashier"          → "FOH"
//   "Line Cook"        → "BOH"
//   "Cook"             → "BOH"
//   "Dishwasher"       → "Dish"
//   "Prep Cook"        → "Prep"
//   "Manager"          → "Manager"
function normalizeRole(raw) {
    if (!raw) return undefined;
    const k = String(raw).toLowerCase().trim();
    if (/server|bartender|cashier|host|host\/ess|hostess|busser/.test(k)) return 'FOH';
    if (/line[ _]?cook|prep[ _]?cook|grill[ _]?cook/.test(k)) {
        if (/prep/.test(k))  return 'Prep';
        if (/grill/.test(k)) return 'Grill';
        return 'BOH';
    }
    if (/^cook$|kitchen[ _]?staff/.test(k)) return 'BOH';
    if (/dish/.test(k))               return 'Dish';
    if (/fryer/.test(k))              return 'Fryer';
    if (/pho/.test(k))                return 'Pho Station';
    if (/kitchen[ _]?manager/.test(k))return 'Kitchen Manager';
    if (/asst[\.]?[ _]?kitchen/.test(k)) return 'Asst Kitchen Manager';
    if (/owner/.test(k))              return 'Owner';
    if (/manager|gm/.test(k))         return 'Manager';
    if (/shift[ _]?lead/.test(k))     return 'Shift Lead';
    // Pass through if it's already a canonical option.
    const exact = ROLE_OPTIONS.find(o => o.toLowerCase() === k);
    return exact || undefined;
}

// Infer scheduleSide from a (possibly normalized) role. Mirrors the
// FOH/BOH heuristic in AdminPanel + Schedule.
function inferSide(role) {
    if (!role) return 'foh';
    if (/foh|server|host|bartender|cashier|busser/i.test(role)) return 'foh';
    if (/boh|cook|prep|grill|fryer|dish|kitchen|pho/i.test(role)) return 'boh';
    return 'foh';
}

// Parse a raw text/CSV blob into a deduped list of row objects.
// Each row: { name, role?, location? } — role + location only set if
// the CSV provided them and we could normalize the value.
//
// Heuristics:
//   - Detect CSV by presence of commas in the first non-empty line.
//   - Header detection: any column matching "first name", "last name",
//     "name", "employee name", "role" / "position" / "job title",
//     "location" / "store" / "primary location".
//   - If CSV header is recognized, the first row is skipped as header.
//   - Plain-text mode (no commas): one name per line, no extra fields.
//   - Dedupe by normalized name, preserving first-seen casing.
function parseRows(raw) {
    if (!raw) return [];
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];
    const isCsv = lines[0].includes(',');
    const collected = [];
    if (isCsv) {
        const headerCells = lines[0].split(',').map(c => c.trim().toLowerCase().replace(/^"|"$/g, ''));
        const firstIdx = headerCells.findIndex(c => /^first[ _]?name$/.test(c));
        const lastIdx  = headerCells.findIndex(c => /^last[ _]?name$/.test(c));
        const nameIdx  = headerCells.findIndex(c => /^(name|employee[ _]?name|full[ _]?name)$/.test(c));
        const roleIdx  = headerCells.findIndex(c => /^(role|position|job[ _]?title|title)$/.test(c));
        const locIdx   = headerCells.findIndex(c => /^(location|store|primary[ _]?location|site)$/.test(c));
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
            if (!n) continue;
            collected.push({
                name: n,
                role: roleIdx >= 0 ? normalizeRole(cells[roleIdx]) : undefined,
                location: locIdx >= 0 ? normalizeLocation(cells[locIdx]) : undefined,
            });
        }
    } else {
        for (const line of lines) collected.push({ name: line });
    }
    // Dedupe by normalized form, preserve first-seen row (which keeps
    // whatever role/location was attached to that row).
    const seen = new Set();
    const out = [];
    for (const r of collected) {
        const key = normalizeName(r.name);
        if (!key) continue;
        if (/^(name|employee|staff|first|last|full)$/.test(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...r, name: r.name.trim() });
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
    // Toast fetch state — 'idle' | 'loading' | 'success' | 'empty' | 'error'.
    // 'empty' = doc exists but employees array is empty/missing (scraper
    // hasn't synced yet). 'error' = network/permission denied.
    const [toastFetch, setToastFetch] = useState({ status: 'idle', message: '' });

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
    // Returns row objects { name, role?, location? } so we can carry
    // CSV-extracted defaults through to Stage 3.
    const parsed = useMemo(() => parseRows(pasted), [pasted]);
    const splitParsed = useMemo(() => {
        const newOnes = [];
        const existing = [];
        for (const r of parsed) {
            const key = normalizeName(r.name);
            if (existingByNorm.has(key)) existing.push({ display: r.name, match: existingByNorm.get(key) });
            else newOnes.push(r);
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
        const all = new Set(splitParsed.newOnes.map(r => normalizeName(r.name)));
        setSelected(all);
        setStage('pick');
    };

    // Build configure-rows from selected parsed rows, applying CSV /
    // scraper hints (role + location) when they came through, and a
    // batch-unique auto-PIN. Used by both:
    //   • the "Configure →" path (admin gets to tweak each row), and
    //   • the "Quick import" fast path (rows are built and immediately
    //     handed to onImport with defaults preserved).
    const buildRowsFromSelection = () => {
        const pinsInBatch = new Set();
        const selectedRows = splitParsed.newOnes.filter(r => selected.has(normalizeName(r.name)));
        return selectedRows.map((src, idx) => {
            const pin = generatePin(existingPins, pinsInBatch);
            if (pin) pinsInBatch.add(pin);
            const role = src.role || 'FOH';
            return {
                tempId: `imp-${Date.now()}-${idx}`,
                name: src.name,
                role,
                location: src.location || defaultLocation || 'webster',
                scheduleSide: inferSide(role),
                pin,
                isMinor: false,
                shiftLead: false,
                opsAccess: false,
                recipesAccess: true, // opt-OUT model — default ON like Add Staff form
            };
        });
    };

    // ── Stage 2 → 3 transition. Build one configure-row per selected name.
    const goToConfigure = () => {
        setRows(buildRowsFromSelection());
        setStage('configure');
    };

    // ── Stage 2 → IMPORT (skip configure). Builds rows with defaults
    // (CSV-extracted role/location if present, otherwise defaults +
    // auto-PINs) and submits directly. For new-restaurant bulk onboard
    // where 30+ staff need to land NOW and the admin will refine flags
    // later from the standard edit form.
    const quickImport = () => {
        const built = buildRowsFromSelection();
        if (built.length === 0) return;
        // Same final-record shape as handleSubmit — kept inline rather
        // than refactored out because handleSubmit reads `rows` state
        // and we're acting on the just-built array directly here.
        const maxId = (existingStaff || []).reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
        const finalRecords = built.map((r, i) => ({
            id: maxId + 1 + i,
            name: r.name.trim(),
            role: r.role,
            pin: r.pin,
            location: r.location,
            scheduleHome: r.location === 'both' ? 'both' : r.location,
            scheduleSide: r.scheduleSide,
            isMinor: false,
            shiftLead: false,
            opsAccess: false,
            recipesAccess: true,
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

    // ── "Fetch from Toast" — reads /ops/toast_employees written by
    // the Railway scraper. See top-of-file contract block for the
    // expected doc shape. If the doc is missing or empty (scraper
    // hasn't run yet), surface a specific message rather than failing
    // silently. On success we serialize the rows to CSV and append to
    // the textarea so they flow through the same parser as paste/file
    // input — single source of truth for downstream stages.
    const fetchFromToast = async () => {
        setToastFetch({ status: 'loading', message: '' });
        try {
            const snap = await getDoc(doc(db, 'ops', 'toast_employees'));
            if (!snap.exists()) {
                setToastFetch({
                    status: 'empty',
                    message: tx(
                        'Toast scraper hasn\'t synced yet. The /ops/toast_employees doc doesn\'t exist. Ask your admin to set up the employees scraper on Railway.',
                        'El scraper de Toast aún no ha sincronizado. El documento /ops/toast_employees no existe. Pide a tu administrador que configure el scraper de empleados en Railway.'
                    ),
                });
                return;
            }
            const data = snap.data() || {};
            const employees = Array.isArray(data.employees) ? data.employees : [];
            if (employees.length === 0) {
                setToastFetch({
                    status: 'empty',
                    message: tx(
                        'Toast scraper synced but returned 0 employees. Check the scraper log on Railway.',
                        'El scraper de Toast sincronizó pero devolvió 0 empleados. Revisa el log del scraper en Railway.'
                    ),
                });
                return;
            }
            // Serialize to a CSV the parser already understands. Header
            // line includes whatever fields we actually have data for,
            // so the parser triggers its CSV path with proper column
            // detection.
            const hasRole = employees.some(e => e.role);
            const hasLoc  = employees.some(e => e.location);
            const headers = ['Name'];
            if (hasRole) headers.push('Role');
            if (hasLoc)  headers.push('Location');
            const lines = [headers.join(',')];
            for (const e of employees) {
                const cells = [String(e.name || '').replace(/,/g, ' ')];
                if (hasRole) cells.push(String(e.role || '').replace(/,/g, ' '));
                if (hasLoc)  cells.push(String(e.location || '').replace(/,/g, ' '));
                lines.push(cells.join(','));
            }
            const csv = lines.join('\n');
            setPasted(prev => prev ? prev.trimEnd() + '\n' + csv : csv);
            const fetchedTs = data.updatedAt?.toDate ? data.updatedAt.toDate() : null;
            const ago = fetchedTs ? Math.round((Date.now() - fetchedTs.getTime()) / 60000) : null;
            setToastFetch({
                status: 'success',
                message: tx(
                    `Fetched ${employees.length} employee${employees.length === 1 ? '' : 's'} from Toast${ago != null ? ` (last sync ${ago} min ago)` : ''}.`,
                    `Se obtuvieron ${employees.length} empleado${employees.length === 1 ? '' : 's'} de Toast${ago != null ? ` (última sincronización hace ${ago} min)` : ''}.`
                ),
            });
        } catch (err) {
            console.error('Toast fetch failed:', err);
            setToastFetch({
                status: 'error',
                message: tx(
                    'Couldn\'t reach the Toast employees doc. Check your network or Firestore rules for /ops/toast_employees.',
                    'No se pudo acceder al documento de empleados de Toast. Verifica tu red o las reglas de Firestore para /ops/toast_employees.'
                ),
            });
        }
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
                        <div className="border-t border-gray-200 pt-3 flex flex-wrap items-center gap-2">
                            <button onClick={() => fileInputRef.current?.click()}
                                className="px-4 py-2 bg-blue-100 text-blue-700 rounded-lg text-sm font-bold hover:bg-blue-200">
                                📂 {tx('Upload CSV / TXT', 'Subir CSV / TXT')}
                            </button>
                            <input ref={fileInputRef} type="file" accept=".csv,.txt" onChange={handleFile} className="hidden" />
                            {/* Fetch from Toast — reads the scraper-written
                                /ops/toast_employees doc. See top-of-file
                                contract for the expected shape. */}
                            <button onClick={fetchFromToast}
                                disabled={toastFetch.status === 'loading'}
                                className={`px-4 py-2 rounded-lg text-sm font-bold ${toastFetch.status === 'loading' ? 'bg-gray-300 text-gray-500 cursor-wait' : 'bg-amber-100 text-amber-800 hover:bg-amber-200'}`}>
                                {toastFetch.status === 'loading'
                                    ? '⏳ ' + tx('Fetching…', 'Obteniendo…')
                                    : '🔄 ' + tx('Fetch from Toast', 'Obtener de Toast')}
                            </button>
                            <span className="text-xs text-gray-500">
                                {tx('Adds to the names above', 'Se agrega a los nombres de arriba')}
                            </span>
                        </div>

                        {/* Toast fetch result banner — colored by outcome. */}
                        {toastFetch.status === 'success' && (
                            <div className="bg-green-50 border border-green-200 rounded-lg p-2 text-xs text-green-800 font-bold">
                                ✓ {toastFetch.message}
                            </div>
                        )}
                        {toastFetch.status === 'empty' && (
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-800">
                                ⚠ {toastFetch.message}
                            </div>
                        )}
                        {toastFetch.status === 'error' && (
                            <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-800">
                                ✕ {toastFetch.message}
                            </div>
                        )}

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
                                <button onClick={() => setSelected(new Set(splitParsed.newOnes.map(r => normalizeName(r.name))))}
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
                            {splitParsed.newOnes.map(r => {
                                const key = normalizeName(r.name);
                                const on = selected.has(key);
                                // Surface CSV-extracted hints next to the name
                                // so admin sees what's being carried into Stage 3.
                                const hints = [r.role, r.location].filter(Boolean);
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
                                        <span className="text-sm text-gray-800 flex-1">{r.name}</span>
                                        {hints.length > 0 && (
                                            <span className="text-[10px] text-gray-500 font-mono">{hints.join(' · ')}</span>
                                        )}
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

                        <div className="flex flex-wrap justify-between gap-2 pt-3 border-t border-gray-200">
                            <button onClick={() => setStage('source')}
                                className="px-4 py-2 rounded-lg bg-gray-300 text-gray-700 font-bold hover:bg-gray-400 text-sm">
                                ← {tx('Back', 'Atrás')}
                            </button>
                            <div className="flex flex-wrap gap-2">
                                {/* Quick Import — skips Stage 3 entirely. Uses
                                    CSV/scraper-extracted role + location when
                                    available, defaults otherwise (FOH +
                                    defaultLocation), auto-PINs for everyone.
                                    Right path for the "I have 40 names and
                                    don't want to click through 40 cards" case. */}
                                <button onClick={quickImport}
                                    disabled={selected.size === 0}
                                    title={tx('Skip configure — use CSV defaults / FOH / current store, auto-PIN everyone, import now', 'Saltar configurar — usa valores predeterminados, PIN automático, importar ahora')}
                                    className={`px-4 py-2 rounded-lg font-bold text-sm ${selected.size === 0 ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}>
                                    ⚡ {tx(`Quick import ${selected.size}`, `Importar rápido ${selected.size}`)}
                                </button>
                                <button onClick={goToConfigure}
                                    disabled={selected.size === 0}
                                    className={`px-4 py-2 rounded-lg font-bold text-sm ${selected.size === 0 ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                                    {tx(`Configure ${selected.size} →`, `Configurar ${selected.size} →`)}
                                </button>
                            </div>
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
