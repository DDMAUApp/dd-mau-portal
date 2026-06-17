// Excel output — JS/exceljs port of app/engine/excel_out.py. Produces the
// accountant workbook (PayrollExport / <LOC> TIP / EXTRAS / CHECKS) and the
// period-over-period comparison workbook, reproducing the exact column layout,
// fills, fonts, number formats, cell notes, borders and frozen panes the
// accountant already knows. Every cell is a computed VALUE (not a cross-sheet
// formula), same as the standalone app.
//
// exceljs is dynamic-imported so it only loads when payroll runs.

import { d, fmtG, money2 } from './cents.js';
import { describe as describeExtra } from './extras.js';

const LOCATION_NAMES = { WG: 'WEBSTER GROVES', MH: 'MARYLAND HEIGHTS' };

// openpyxl RGB → exceljs ARGB (implicit FF alpha).
const argb = (rgb) => `FF${rgb}`;
const FILL = (rgb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(rgb) } });

const F_TITLE = { bold: true, size: 14 };
const F_HDR = { bold: true, color: { argb: argb('FFFFFF') }, size: 10 };
const F_BOLD = { bold: true };
const F_RED = { bold: true, color: { argb: argb('9C0006') } };
const FILL_HDR = FILL('4472C4');
const FILL_SEC = FILL('D9E1F2');
const FILL_TOT = FILL('FCE4D6');
const FILL_RED = FILL('FFC7CE');
const FILL_YEL = FILL('FFF2CC');
const FILL_GRN = FILL('C6EFCE');
const THIN = { style: 'thin', color: { argb: argb('B0B0B0') } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const RED_SIDE = { style: 'medium', color: { argb: argb('C00000') } };
const RED_BORDER = { top: RED_SIDE, left: RED_SIDE, bottom: RED_SIDE, right: RED_SIDE };

const MONEY = '#,##0.00';
const HOURS = '0.00';
const PCT = '0.0%';

const TIP_HEADERS = ['RATE', 'FIRST', 'LAST', 'REG HRS', 'OT HRS', 'TOTAL HRS', '% POOL',
    'TIP $', 'REG PAY', 'OT PAY', 'EXTRA PAY', 'HOL HRS', 'HOL PAY',
    'VAC HRS', 'VAC PAY', 'TOTAL COMP', 'EFF RATE', 'DD'];

function cell(ws, r, col) { return ws.getRow(r).getCell(col); }
function setWidths(ws, widthsByCol) {
    for (const [col, w] of Object.entries(widthsByCol)) ws.getColumn(Number(col)).width = w;
}

async function newWorkbook() {
    const mod = await import('exceljs');
    const ExcelJS = mod.default || mod;
    return new ExcelJS.Workbook();
}

// ─────────────────────────────────── PayrollExport ───────────────────────────────────
function writeExportSheet(ws, res) {
    const locName = LOCATION_NAMES[res.location];
    ws.getCell('A1').value = `${locName} – PAYROLL EXPORT (hours exactly as on the Toast export)`;
    ws.getCell('A1').font = F_TITLE;
    const hdrs = ['LOCATION', 'EMPLOYEE NAME', 'REGULAR HRS', 'OT HRS', 'JOBS (if merged)'];
    hdrs.forEach((h, i) => {
        const c = cell(ws, 2, i + 1);
        c.value = h; c.font = F_HDR; c.fill = FILL_HDR; c.border = BORDER;
    });
    let r = 3;
    let rows = ['FOH', 'BOH'].flatMap((sec) => res.sections[sec].rows).filter((row) => row.toast_name);
    rows = rows.concat(res.review);
    rows.sort((a, b) => {
        const an = (a.toast_name || '').toLowerCase();
        const bn = (b.toast_name || '').toLowerCase();
        return an < bn ? -1 : (an > bn ? 1 : 0);
    });
    for (const row of rows) {
        cell(ws, r, 1).value = locName;
        cell(ws, r, 2).value = row.toast_name == null ? null : row.toast_name;
        const rc = cell(ws, r, 3); rc.value = row.reg_hours; rc.numFmt = HOURS;
        const oc = cell(ws, r, 4); oc.value = row.ot_hours; oc.numFmt = HOURS;
        if (row.merge_detail) cell(ws, r, 5).value = row.merge_detail;
        r += 1;
    }
    setWidths(ws, { 1: 20, 2: 28, 3: 13, 4: 10, 5: 50 });
    ws.views = [{ state: 'frozen', ySplit: 2 }]; // freeze_panes 'A3'
}

// ─────────────────────────────────── TIP sheet ───────────────────────────────────
function tipRow(ws, r, row) {
    const vals = [
        [row.rate, MONEY], [row.display_first, null], [row.display_last, null],
        [row.reg_hours, HOURS], [row.ot_hours, HOURS], [row.total_hours, HOURS],
        [row.pool_pct / 100.0, PCT], [d(row.tip_cents), MONEY],
        [d(row.reg_cents), MONEY], [d(row.ot_cents), MONEY],
        [row.extra_cents ? d(row.extra_cents) : null, MONEY],
        [row.hol_hours || null, HOURS], [row.hol_cents ? d(row.hol_cents) : null, MONEY],
        [row.vac_hours || null, HOURS], [row.vac_cents ? d(row.vac_cents) : null, MONEY],
        [d(row.comp_cents), MONEY], [row.eff_rate, MONEY],
        [row.direct_deposit ? 'DD' : null, null],
    ];
    vals.forEach(([val, fmt], i) => {
        const c = cell(ws, r, i + 1);
        c.value = val === undefined ? null : val;
        if (fmt && val !== null && val !== undefined) c.numFmt = fmt;
        c.border = BORDER;
    });
    // Pay rate was changed from what Toast reported (an override) → fill the row
    // red so the People-step flag carries all the way through to the doc.
    if (row.toast_rate != null && Math.abs(row.rate - row.toast_rate) > 0.005) {
        for (let ci = 1; ci <= 18; ci++) cell(ws, r, ci).fill = FILL_RED;
    }
    if (row.no_tip) {
        cell(ws, r, 7).value = 0;
        cell(ws, r, 8).note = 'Not in tip pool (roster flag)';
    }
    if (row.multi_line && row.merge_detail) {
        for (let ci = 1; ci <= 18; ci++) cell(ws, r, ci).border = RED_BORDER;
        cell(ws, r, 6).note = `Merged from multiple Toast lines:\n${row.merge_detail}`;
    }
    if (row.extras && row.extras.length) {
        cell(ws, r, 16).note = row.extras.join('\n');
        if (row.extra_cents < 0) cell(ws, r, 11).font = F_RED;
    }
}

function extraDetailRows(ws, r, row) {
    for (const desc of (row.extras || [])) {
        const negative = desc.includes('deducted') || desc.includes('-$');
        const c = cell(ws, r, 2);
        c.value = `      ↳ ${desc}`;
        c.font = { italic: true, size: 9, color: { argb: argb(negative ? '9C0006' : '808080') } };
        r += 1;
    }
    return r;
}

function totalsRow(ws, r, label, tot) {
    const lab = cell(ws, r, 1); lab.value = label; lab.font = F_BOLD;
    const cols = [
        [4, tot.reg_hours, HOURS], [5, tot.ot_hours, HOURS], [6, tot.total_hours, HOURS],
        [8, d(tot.tip_cents), MONEY], [9, d(tot.reg_cents), MONEY], [10, d(tot.ot_cents), MONEY],
        [11, d(tot.extra_cents), MONEY], [12, tot.hol_hours, HOURS], [13, d(tot.hol_cents), MONEY],
        [14, tot.vac_hours, HOURS], [15, d(tot.vac_cents), MONEY], [16, d(tot.comp_cents), MONEY],
    ];
    for (const [ci, val, fmt] of cols) {
        const c = cell(ws, r, ci);
        c.value = val; c.numFmt = fmt; c.font = F_BOLD; c.fill = FILL_TOT;
    }
}

function writeTipSheet(ws, res) {
    const loc = res.location;
    const tips = res.tips;
    ws.getCell('A1').value = `DD MAU ${LOCATION_NAMES[loc]} – TIP DISTRIBUTION`;
    ws.getCell('A1').font = F_TITLE;

    const box = [
        ['PAY PERIOD', res.period || '', null],
        ['CARD TIPS', d(tips.card_cents), MONEY],
        ['CASH TIPS', d(tips.cash_cents), MONEY],
        ['TOTAL TIPS', d(tips.total_cents), MONEY],
        ['FOH SPLIT %', tips.foh_pct / 100.0, PCT],
        ['BOH SPLIT %', tips.boh_pct / 100.0, PCT],
        ['FOH POOL $', d(tips.foh_pool_cents), MONEY],
        ['BOH POOL $', d(tips.boh_pool_cents), MONEY],
    ];
    box.forEach(([label, val, fmt], i) => {
        const lab = cell(ws, i + 1, 20); lab.value = label; lab.font = F_BOLD; // col T
        const v = cell(ws, i + 1, 21); v.value = val; if (fmt) v.numFmt = fmt; v.fill = FILL_YEL; // col U
    });

    let r = 4;
    for (const sec of ['FOH', 'BOH']) {
        const data = res.sections[sec];
        const label = sec === 'FOH' ? 'FRONT OF HOUSE (FOH)' : 'BACK OF HOUSE (BOH)';
        const hdr = cell(ws, r, 1);
        hdr.value = `▸  ${label} — TIP POOL $${money2(d(data.pool_cents))}  (${money2(data.tips_per_hour)}/hr over ${fmtG(data.eligible_hours)} hrs)`;
        hdr.font = F_BOLD; hdr.fill = FILL_SEC;
        r += 1;
        TIP_HEADERS.forEach((h, i) => {
            const c = cell(ws, r, i + 1); c.value = h; c.font = F_HDR; c.fill = FILL_HDR; c.border = BORDER;
        });
        r += 1;
        for (const row of data.rows) {
            tipRow(ws, r, row);
            r += 1;
            r = extraDetailRows(ws, r, row);
        }
        totalsRow(ws, r, `TOTAL ${sec}`, data.totals);
        r += 2;
    }

    totalsRow(ws, r, 'GRAND TOTAL', res.totals);
    r += 2;

    if (res.salary && res.salary.length) {
        const hdr = cell(ws, r, 1);
        hdr.value = '▸  SALARY (fixed per pay period — NOT in tip pool)';
        hdr.font = F_BOLD; hdr.fill = FILL_SEC;
        r += 1;
        for (const [ci, h] of [[1, 'AMOUNT'], [2, 'FIRST'], [3, 'LAST'], [16, 'TOTAL COMP'], [18, 'DD']]) {
            const c = cell(ws, r, ci); c.value = h; c.font = F_HDR; c.fill = FILL_HDR; c.border = BORDER;
        }
        r += 1;
        for (const s of res.salary) {
            cell(ws, r, 1).value = d(s.amount_cents); cell(ws, r, 1).numFmt = MONEY;
            cell(ws, r, 2).value = s.legal_first || s.first;
            cell(ws, r, 3).value = s.legal_last || s.last;
            cell(ws, r, 16).value = d(s.amount_cents); cell(ws, r, 16).numFmt = MONEY;
            cell(ws, r, 18).value = 'DD';
            r += 1;
        }
        const totCell = cell(ws, r, 1); totCell.value = 'TOTAL SALARY'; totCell.font = F_BOLD;
        const tc = cell(ws, r, 16);
        tc.value = d(res.salary.reduce((a, s) => a + s.amount_cents, 0));
        tc.numFmt = MONEY; tc.font = F_BOLD; tc.fill = FILL_TOT;
        r += 2;
    }

    if (res.review && res.review.length) {
        const hdr = cell(ws, r, 1);
        hdr.value = '⚠ NEW — ON TOAST EXPORT, NOT YET SET UP (in NO tip pool — set their FOH/BOH + Direct Deposit on the People step and re-run)';
        hdr.font = F_RED; hdr.fill = FILL_RED;
        r += 1;
        for (const [ci, h] of [[2, 'TOAST NAME'], [4, 'REG HRS'], [5, 'OT HRS'], [6, 'TOTAL HRS'], [7, 'TOAST RATE'], [8, 'CLOSEST KNOWN NAME']]) {
            const c = cell(ws, r, ci); c.value = h; c.font = F_HDR; c.fill = FILL_HDR; c.border = BORDER;
        }
        r += 1;
        for (const rv of res.review) {
            const cellsRv = [
                [2, rv.toast_name, null], [4, rv.reg_hours, HOURS], [5, rv.ot_hours, HOURS],
                [6, rv.total_hours, HOURS], [7, rv.toast_rate, MONEY], [8, rv.suggestion, null],
            ];
            for (const [ci, val, fmt] of cellsRv) {
                const c = cell(ws, r, ci);
                c.value = val === undefined ? null : val;
                if (fmt) c.numFmt = fmt;
                c.fill = FILL_RED;
            }
            r += 1;
        }
    }

    setWidths(ws, {
        1: 9, 2: 14, 3: 16, 4: 9, 5: 8, 6: 10, 7: 8, 8: 10, 9: 10, 10: 9, 11: 10,
        12: 8, 13: 9, 14: 8, 15: 9, 16: 12, 17: 9, 18: 5, 19: 2, 20: 12, 21: 14,
    });
    ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 5 }]; // freeze_panes 'D6'
}

// ─────────────────────────────────── EXTRAS ───────────────────────────────────
function writeExtrasSheet(ws, res) {
    ws.getCell('A1').value = 'EXTRAS APPLIED THIS PERIOD (advances / back pay / vacation / holiday / bonus)';
    ws.getCell('A1').font = F_TITLE;
    ['PERSON', 'TYPE', 'DETAIL', 'AMOUNT $', 'NOTE'].forEach((h, i) => {
        const c = cell(ws, 2, i + 1); c.value = h; c.font = F_HDR; c.fill = FILL_HDR; c.border = BORDER;
    });
    let r = 3;
    for (const x of res.extras_applied) {
        cell(ws, r, 1).value = x.name;
        cell(ws, r, 2).value = String(x.type).toUpperCase();
        cell(ws, r, 3).value = x.description || describeExtra(x);
        const amt = cell(ws, r, 4); amt.value = d(x.amount_cents); amt.numFmt = MONEY;
        if (x.amount_cents < 0) amt.font = F_RED;
        cell(ws, r, 5).value = x.note || '';
        r += 1;
    }
    if (r === 3) cell(ws, 3, 1).value = '(none this period)';
    setWidths(ws, { 1: 24, 2: 10, 3: 44, 4: 12, 5: 50 });
}

// ─────────────────────────────────── CHECKS ───────────────────────────────────
function writeChecksSheet(ws, res) {
    ws.getCell('A1').value = 'RECONCILIATION & CHECKS — read this before sending to the accountant';
    ws.getCell('A1').font = F_TITLE;
    ['STATUS', 'CHECK', 'DETAIL'].forEach((h, i) => {
        const c = cell(ws, 2, i + 1); c.value = h; c.font = F_HDR; c.fill = FILL_HDR; c.border = BORDER;
    });
    const order = { fail: 0, warn: 1, pass: 2, info: 3 };
    const fills = { fail: FILL_RED, warn: FILL_YEL, pass: FILL_GRN, info: null };
    const labels = { fail: 'PROBLEM', warn: 'REVIEW', pass: 'OK', info: 'FYI' };
    let r = 3;
    const sorted = [...res.checks].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
    for (const chk of sorted) {
        const s = cell(ws, r, 1);
        s.value = labels[chk.level] || chk.level;
        if (fills[chk.level]) s.fill = fills[chk.level];
        s.font = F_BOLD;
        cell(ws, r, 2).value = chk.title;
        const c = cell(ws, r, 3);
        c.value = chk.detail;
        c.alignment = { wrapText: true, vertical: 'top' };
        r += 1;
    }
    setWidths(ws, { 1: 10, 2: 44, 3: 90 });
}

/** Build the accountant workbook for one location. res = run result (with res.period). */
export async function buildPayrollWorkbook(res) {
    const wb = await newWorkbook();
    writeExportSheet(wb.addWorksheet('PayrollExport'), res);
    writeTipSheet(wb.addWorksheet(`${res.location} TIP`), res);
    writeExtrasSheet(wb.addWorksheet('EXTRAS'), res);
    writeChecksSheet(wb.addWorksheet('CHECKS'), res);
    return wb;
}

// ─────────────────────────────────── COMPARISON ───────────────────────────────────
/** prevSnap = run_summary dict ({period, locations:{loc:{people:{key:{...}}}}}) or null. */
export async function buildComparisonWorkbook(period, results, prevSnap) {
    const wb = await newWorkbook();
    for (const loc of Object.keys(results)) {
        const res = results[loc];
        const ws = wb.addWorksheet(`${loc} Comparison`);
        const prevLoc = ((prevSnap || {}).locations || {})[loc] || {};
        const prevPeople = prevLoc.people || {};
        const prevPeriod = (prevSnap || {}).period || 'no previous run saved';
        ws.getCell('A1').value = `${LOCATION_NAMES[loc]} — ${period} vs ${prevPeriod}`;
        ws.getCell('A1').font = F_TITLE;
        const hdrs = ['PERSON', 'FLAG', 'RATE', 'PREV RATE', 'HOURS', 'PREV HOURS', 'Δ HOURS', 'TOTAL COMP', 'PREV COMP', 'Δ COMP'];
        hdrs.forEach((h, i) => {
            const c = cell(ws, 2, i + 1); c.value = h; c.font = F_HDR; c.fill = FILL_HDR; c.border = BORDER;
        });
        let r = 3;
        const curKeys = new Set();
        const rows = ['FOH', 'BOH'].flatMap((sec) => res.sections[sec].rows)
            .sort((a, b) => {
                const al = a.last.toLowerCase(); const bl = b.last.toLowerCase();
                if (al !== bl) return al < bl ? -1 : 1;
                const af = a.first.toLowerCase(); const bf = b.first.toLowerCase();
                return af < bf ? -1 : (af > bf ? 1 : 0);
            });
        const hasPrev = Object.keys(prevPeople).length > 0;
        for (const row of rows) {
            curKeys.add(row.key);
            const p = prevPeople[row.key];
            const flags = [];
            if (p == null) {
                flags.push(hasPrev ? 'NEW' : '');
            } else {
                if (Math.abs(p.rate - row.rate) > 0.005) flags.push('RATE CHANGE');
                if (Math.abs(p.total_hours - row.total_hours) >= 15) flags.push('BIG HOURS SWING');
            }
            const vals = [
                `${row.first} ${row.last}`, flags.filter(Boolean).join(', '),
                row.rate, p ? p.rate : null,
                row.total_hours, p ? p.total_hours : null,
                p ? Math.round((row.total_hours - p.total_hours) * 100) / 100 : null,
                d(row.comp_cents), p ? d(p.comp_cents) : null,
                p ? d(row.comp_cents - p.comp_cents) : null,
            ];
            vals.forEach((val, i) => {
                const ci = i + 1;
                const c = cell(ws, r, ci);
                c.value = val === undefined ? null : val;
                if ([3, 4, 8, 9, 10].includes(ci) && val !== null && val !== undefined) c.numFmt = MONEY;
                if ([5, 6, 7].includes(ci) && val !== null && val !== undefined) c.numFmt = HOURS;
            });
            if (flags.filter(Boolean).length) cell(ws, r, 2).fill = FILL_YEL;
            r += 1;
        }
        const gone = Object.keys(prevPeople).filter((k) => !curKeys.has(k)).map((k) => prevPeople[k]);
        gone.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
        for (const p of gone) {
            cell(ws, r, 1).value = p.name;
            const c = cell(ws, r, 2); c.value = 'GONE (no hours this period)'; c.fill = FILL_RED;
            cell(ws, r, 4).value = p.rate; cell(ws, r, 4).numFmt = MONEY;
            cell(ws, r, 6).value = p.total_hours; cell(ws, r, 6).numFmt = HOURS;
            cell(ws, r, 9).value = d(p.comp_cents); cell(ws, r, 9).numFmt = MONEY;
            r += 1;
        }
        setWidths(ws, { 1: 26, 2: 22, 3: 9, 4: 10, 5: 9, 6: 11, 7: 9, 8: 12, 9: 11, 10: 10 });
        ws.views = [{ state: 'frozen', ySplit: 2 }];
    }
    return wb;
}

/** Convenience: serialize a workbook to a Blob for download in the browser. */
export async function workbookBlob(wb) {
    const buffer = await wb.xlsx.writeBuffer();
    return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
