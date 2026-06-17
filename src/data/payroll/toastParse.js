// Toast export readers — JS port of app/engine/toast.py.
//
// Reliability rules carried over verbatim:
//  - Files are grouped by the Location column INSIDE the file, never the name.
//  - Identical duplicate downloads are deduped by content hash (SHA-256).
//  - Two DIFFERENT files claiming the same location is a hard conflict.
//  - One employee on multiple export lines (one per job) has hours SUMMED,
//    with per-line detail kept for the audit trail.
//
// exceljs (xlsx read) is dynamically imported so it only loads when payroll runs.
// Files are passed in as { name, bytes } (Uint8Array/ArrayBuffer) so the same
// code runs in the browser (File.arrayBuffer) and in the Node parity harness
// (fs.readFileSync).

import { keyFromToast, splitToastName } from './names.js';
import { round2, money2 } from './cents.js';

const WG = 'WG';
const MH = 'MH';

const LOCATION_MARKERS = {
    WG: ['WEBSTER', 'BIG BEND'],
    MH: ['MARYLAND', 'DORSETT'],
};

const REQUIRED_EXPORT_COLS = ['Employee', 'Regular Hours', 'Overtime Hours', 'Hourly Rate', 'Location'];

export function locationCode(text) {
    const up = String(text == null ? '' : text).toUpperCase();
    for (const code of [WG, MH]) {
        if (LOCATION_MARKERS[code].some((m) => up.includes(m))) return code;
    }
    return null;
}

// ── byte / encoding helpers ───────────────────────────────────────────────
function toUint8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return new Uint8Array(bytes);
}
function toArrayBuffer(bytes) {
    const u = toUint8(bytes);
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
}
/** utf-8 decode; TextDecoder strips a leading BOM (utf-8-sig behaviour). */
function bytesToText(bytes) {
    return new TextDecoder('utf-8').decode(toUint8(bytes));
}
async function hashBytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
async function loadExcel() {
    const mod = await import('exceljs');
    return mod.default || mod;
}
function cellVal(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') {
        if (v.result !== undefined) return v.result;
        if (v.text !== undefined) return v.text;
        if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
        return v.toString();
    }
    return v;
}

/** Mirrors toast._to_float: strip $ and , then parse, recovering a leading number. */
function toFloat(v) {
    const s = String(v == null ? '' : v).replace(/\$/g, '').replace(/,/g, '').trim();
    if (!s) return 0.0;
    const f = Number(s);
    if (!Number.isNaN(f) && isFinite(f)) return f;
    // Anchored at the START to mirror Python's re.match (toast.py): recover a
    // leading number ("40h" -> 40) but reject a number buried mid-string
    // ("approx 40" -> 0), exactly as the Python engine does.
    const m = s.match(/^-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0.0;
}

// ── RFC-4180 CSV ──────────────────────────────────────────────────────────
// Required because the Employee column is quoted "Last, First" — a naive split
// on commas would shred every name. Mirrors Python's csv module.
function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let sawAny = false;
    const n = text.length;
    let i = 0;
    while (i < n) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i += 1; continue;
            }
            field += ch; i += 1; continue;
        }
        if (ch === '"') { inQuotes = true; sawAny = true; i += 1; continue; }
        if (ch === ',') { row.push(field); field = ''; sawAny = true; i += 1; continue; }
        if (ch === '\r') { i += 1; continue; }
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; sawAny = false; i += 1; continue; }
        field += ch; sawAny = true; i += 1;
    }
    if (sawAny || field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
}

/** DictReader-equivalent. Skips fully-blank lines (mirrors csv.reader → [] → DictReader skip). */
function parseCsvDicts(text) {
    const raw = parseCsvRows(text);
    if (!raw.length) return { header: [], rows: [] };
    const header = raw[0];
    const out = [];
    for (let i = 1; i < raw.length; i++) {
        const r = raw[i];
        if (r.length === 0 || (r.length === 1 && r[0] === '')) continue;
        const obj = {};
        for (let j = 0; j < header.length; j++) obj[header[j]] = j < r.length ? r[j] : null;
        out.push(obj);
    }
    return { header, rows: out };
}

// ── payroll export ────────────────────────────────────────────────────────
/**
 * Read one or more Toast payroll export CSVs. files = [{name, bytes}].
 * Returns { employees:{loc:{key:emp}}, files, conflicts, errors }.
 * Mirrors toast.read_payroll_exports.
 */
export async function readPayrollExports(files, aliases) {
    const out = { employees: {}, files: [], conflicts: [], errors: [] };
    const seenHashes = {};
    const rowsByLoc = {};
    const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));

    for (const f of sorted) {
        let h;
        try { h = await hashBytes(f.bytes); }
        catch (e) { out.errors.push(`Can't read ${f.name}: ${e.message || e}`); continue; }
        if (Object.prototype.hasOwnProperty.call(seenHashes, h)) {
            out.files.push({ name: f.name, hash: h, duplicate_of: seenHashes[h], locations: [], rows: 0 });
            continue;
        }
        seenHashes[h] = f.name;
        const { header, rows } = parseCsvDicts(bytesToText(f.bytes));
        if (rows.length) {
            const missing = REQUIRED_EXPORT_COLS.filter((c) => !header.includes(c));
            if (missing.length) {
                out.errors.push(`${f.name}: missing column(s) ${JSON.stringify(missing)}. Columns found: ${JSON.stringify(header)}`);
                continue;
            }
        }
        const locs = new Set();
        for (const r of rows) {
            const loc = locationCode(r.Location);
            if (!loc) { out.errors.push(`${f.name}: unknown Location '${r.Location}'`); continue; }
            locs.add(loc);
            if (!rowsByLoc[loc]) rowsByLoc[loc] = [];
            rowsByLoc[loc].push([f.name, r]);
        }
        out.files.push({ name: f.name, hash: h, locations: [...locs].sort(), rows: rows.length });
    }

    for (const loc of Object.keys(rowsByLoc)) {
        const srcs = [...new Set(rowsByLoc[loc].map(([fn]) => fn))].sort();
        if (srcs.length > 1) {
            out.conflicts.push(`${loc}: rows came from more than one distinct file (${srcs.join(', ')}). Remove the stale one and rescan.`);
        }
    }

    for (const loc of Object.keys(rowsByLoc)) {
        const byKey = {};
        for (const [, r] of rowsByLoc[loc]) {
            const rawName = String(r.Employee == null ? '' : r.Employee).split(/\s+/).filter(Boolean).join(' ');
            if (!rawName) continue;
            const key = keyFromToast(rawName, aliases);
            const [first, last] = splitToastName(rawName);
            const reg = toFloat(r['Regular Hours']);
            const ot = toFloat(r['Overtime Hours']);
            const line = { job: String(r['Job Title'] == null ? '' : r['Job Title']).trim(), reg_hours: reg, ot_hours: ot, rate: toFloat(r['Hourly Rate']) };
            const emp = byKey[key];
            if (!emp) {
                byKey[key] = { toast_name: rawName, first, last, reg_hours: reg, ot_hours: ot, toast_rate: line.rate, lines: [line] };
            } else {
                emp.reg_hours += reg;
                emp.ot_hours += ot;
                emp.lines.push(line);
            }
        }
        for (const k of Object.keys(byKey)) {
            const emp = byKey[k];
            emp.multi_line = emp.lines.length > 1;
            emp.reg_hours = round2(emp.reg_hours);
            emp.ot_hours = round2(emp.ot_hours);
        }
        out.employees[loc] = byKey;
    }
    return out;
}

// ── sales summary ─────────────────────────────────────────────────────────
/**
 * Card tips + location from a Toast SalesSummary (.xlsx or .csv). The 'Tips'
 * line in the Revenue block is the card-tip total; 'Total tips' is a cross-check.
 * file = {name, bytes}. Mirrors toast.read_sales_summary.
 */
export async function readSalesSummary(file) {
    const name = file.name;
    const lower = name.toLowerCase();
    let cells = [];
    if (lower.endsWith('.csv')) {
        const raw = parseCsvRows(bytesToText(file.bytes));
        cells = raw.map((r) => [r.length ? r[0] : null, r.length > 1 ? r[1] : null]);
    } else {
        const ExcelJS = await loadExcel();
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(toArrayBuffer(file.bytes));
        const ws = wb.worksheets[0];
        const maxRow = Math.min(80, ws.rowCount || 80);
        for (let r = 1; r <= maxRow; r++) {
            const row = ws.getRow(r);
            cells.push([cellVal(row.getCell(1).value), cellVal(row.getCell(2).value)]);
        }
    }

    let loc = null;
    let tips = null;
    let totalTips = null;
    for (const row of cells) {
        const label = String(row[0] == null ? '' : row[0]).trim();
        const val = row.length > 1 ? row[1] : null;
        if (loc === null) { const found = locationCode(label); if (found) loc = found; }
        if (tips === null && label === 'Tips') tips = toFloat(val);
        if (totalTips === null && label === 'Total tips') totalTips = toFloat(val);
    }

    let warning = null;
    if (tips === null) { warning = `${name}: no 'Tips' line found`; tips = 0.0; }
    else if (totalTips !== null && Math.abs(tips - totalTips) > 0.01) {
        warning = `${name}: 'Tips' ($${money2(tips)}) and 'Total tips' ($${money2(totalTips)}) disagree -- check for refunded tips`;
    }
    return { location: loc, card_tips: round2(tips), cross_check_tips: totalTips, warning, name, path: name };
}

/** Group sales summaries by location; flag conflicting tip totals. Mirrors toast.dedupe_sales. */
export function dedupeSales(salesResults) {
    const byLoc = {};
    const conflicts = [];
    for (const s of salesResults) {
        const loc = s.location;
        if (loc === null || loc === undefined) {
            conflicts.push(`${s.name}: couldn't tell which location this is`);
            continue;
        }
        const prev = byLoc[loc];
        if (!prev) byLoc[loc] = s;
        else if (Math.abs(prev.card_tips - s.card_tips) > 0.01) {
            conflicts.push(`${loc}: two sales summaries disagree on tips (${prev.name} $${money2(prev.card_tips)} vs ${s.name} $${money2(s.card_tips)}). Remove the stale one.`);
        }
    }
    return { byLoc, conflicts };
}

// ── classification ────────────────────────────────────────────────────────
async function classifyByContent(f) {
    try {
        const n = f.name.toLowerCase();
        if (n.endsWith('.csv')) {
            const head = bytesToText(f.bytes).slice(0, 2000);
            const first = head.split(/\r?\n/)[0] || '';
            if (first.includes('Regular Hours') && first.includes('Employee')) return 'payroll_exports';
            if (first.includes('Time In') && first.includes('Time Out')) return 'time_entries';
        } else {
            const ExcelJS = await loadExcel();
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(toArrayBuffer(f.bytes));
            const a1 = String(cellVal(wb.worksheets[0] && wb.worksheets[0].getCell(1, 1).value) || '');
            if (a1.toLowerCase().replace(/ /g, '').includes('salessummary')) return 'sales_summaries';
        }
    } catch { /* ignore */ }
    return 'other';
}

/** Classify in-memory files by name + content peek. Mirrors toast.scan_folder. */
export async function classifyFiles(files) {
    const out = { payroll_exports: [], sales_summaries: [], time_entries: [], other: [] };
    for (const f of files) {
        const n = f.name.toLowerCase();
        if (n.startsWith('.') || n.startsWith('~')) continue;
        if (n.endsWith('.csv') && n.includes('payroll_export')) out.payroll_exports.push(f);
        else if (n.includes('salessummary') && (n.endsWith('.xlsx') || n.endsWith('.csv'))) out.sales_summaries.push(f);
        else if (n.endsWith('.csv') && (n.includes('timeentries') || n.includes('time_entries'))) out.time_entries.push(f);
        else if (!n.endsWith('.xlsx') && !n.endsWith('.csv')) continue;
        else {
            const kind = await classifyByContent(f);
            if (kind === 'other') out.other.push(f);
            else out[kind].push(f);
        }
    }
    return out;
}

// ── browser helpers + high-level entry ────────────────────────────────────
/** Read a browser File into { name, bytes }. */
export async function fileToBytes(file) {
    const buf = await file.arrayBuffer();
    return { name: file.name, bytes: new Uint8Array(buf) };
}

/**
 * Full parse of a period's picked files. Returns the pieces compute.loadInputs
 * needs plus a classification summary for the Import step UI.
 */
export async function parseToastFiles(files, aliases) {
    const classified = await classifyFiles(files);
    const exports = await readPayrollExports(classified.payroll_exports, aliases);
    const salesResults = [];
    for (const f of classified.sales_summaries) salesResults.push(await readSalesSummary(f));
    const { byLoc, conflicts } = dedupeSales(salesResults);
    return {
        exports,
        salesByLoc: byLoc,
        salesConflicts: conflicts,
        sales: salesResults,
        classified: {
            payroll_exports: classified.payroll_exports.map((f) => f.name),
            sales_summaries: classified.sales_summaries.map((f) => f.name),
            time_entries: classified.time_entries.map((f) => f.name),
            unrecognized: classified.other.map((f) => f.name),
        },
    };
}
