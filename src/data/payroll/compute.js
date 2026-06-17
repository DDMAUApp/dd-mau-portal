// Period orchestrator — JS port of app/engine/run.py (the pure parts:
// load_inputs's rate-data construction + compute()). File scanning/parsing lives
// in toastParse.js; this module turns parsed inputs + the roster into results.

import { asRateData } from './roster.js';
import { runLocation } from './runLocation.js';
import { c } from './cents.js';

export const LOCATIONS = ['WG', 'MH'];

/** Build the per-location rate data the engine consumes from the roster. */
export function buildMasters(roster, exportsEmployees) {
    const masters = {};
    for (const loc of LOCATIONS) {
        masters[loc] = asRateData(roster, loc, exportsEmployees[loc] || {});
    }
    return masters;
}

/**
 * Assemble the `inputs` object compute() consumes. Mirrors run.load_inputs minus
 * the folder scan (toastParse already produced `exports` + `salesByLoc`).
 *   exports       = { employees:{loc:{key:emp}}, files, conflicts, errors }
 *   salesByLoc    = { loc: {card_tips, warning, ...} }
 *   salesConflicts= [str]
 */
export function loadInputs(exports, salesByLoc, salesConflicts, roster) {
    const masters = buildMasters(roster, exports.employees || {});
    const problems = [...(exports.errors || []), ...(exports.conflicts || []), ...(salesConflicts || [])];
    for (const loc of LOCATIONS) {
        const emps = (exports.employees || {})[loc];
        if (emps && Object.keys(emps).length && !salesByLoc[loc]) {
            problems.push(`${loc}: payroll export found but no sales summary (card tips unknown)`);
        }
    }
    return { exports, sales: salesByLoc, masters, problems };
}

/**
 * Run the calculation for every location present in the export files. Mirrors
 * run.compute. cashTips: {loc: dollars}; fohPct: {loc: percent} or a number.
 */
export function compute(inputs, period, cashTips, fohPct, periodExtras) {
    const results = {};
    for (const loc of LOCATIONS) {
        const toastEmps = (inputs.exports.employees || {})[loc];
        if (!toastEmps || Object.keys(toastEmps).length === 0) continue;
        const sales = inputs.sales[loc];
        const cardCents = sales ? c(sales.card_tips) : 0;
        const cashCents = c((cashTips && cashTips[loc]) || 0);
        const pct = (fohPct && typeof fohPct === 'object') ? (fohPct[loc] == null ? 50 : fohPct[loc]) : fohPct;
        const res = runLocation(
            loc, toastEmps, inputs.masters[loc],
            cardCents, cashCents, Number(pct), periodExtras || [],
            (sales || {}).warning,
        );
        res.period = period;
        for (const prob of inputs.problems) {
            if (String(prob).startsWith(loc)) {
                res.checks.unshift({ id: 'files', level: 'fail', title: 'Input file problem', detail: prob });
            }
        }
        results[loc] = res;
    }
    return results;
}
