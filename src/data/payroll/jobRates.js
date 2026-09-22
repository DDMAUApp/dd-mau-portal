// jobRates.js — pay for someone who works TWO (or more) positions at
// different hourly rates (2026-09-22, Andrew: "when i upload a staff that has
// 2 positions does the payroll system know how to handle that. they will have
// different pay rates").
//
// BEFORE: Toast's payroll export lists that person once per job, each line
// with its own hours and rate. The import summed the hours and kept ONLY the
// first line's rate, so every hour was paid at one rate (20h @ $15 + 20h @ $17
// paid $600 or $680 instead of $640, depending on Toast's line order), and a
// person-level locked rate flattened both jobs too.
//
// NOW, only when a person's worked job lines resolve to DIFFERENT rates:
//   • regular pay  = Σ each job's regular hours × that job's rate
//   • overtime pay = Σ each job's OT hours × that job's rate
//                    + ½ × the weighted-average ("regular") rate × all OT hours
//     — the federal regular-rate method for two-rate overtime. Toast reports
//     OT per period, not per week, so the average is taken over the pay period.
//   • cross-store OT (crossLocOt.js) uses the same weighted-average rate.
// Anyone whose lines share one rate (the normal case) returns null here and is
// paid EXACTLY as before — the parity-proven single-rate path is untouched.
//
// Per-line rate precedence: a rate locked for THAT JOB on the People step
// (roster person.job_rates[jobKey]) > the person's locked master rate >
// Toast's rate for the line > last known rate. A rate the owner locked ALWAYS
// wins over Toast — exactly as it does for one-job staff. So a person with a
// master lock and no job locks is paid their lock for every hour, as before
// (the real case that forced this order: Toast listed Yulissa's Lead job with
// NO rate and Cashier at a stale $12 while her locked rate was $17 — letting
// Toast's job rates win would have silently cut her pay). The engine warns in
// that case (lockOverDifferentJobs) so the owner can lock per-job rates.

import { round2 } from './cents.js';

/** Stable roster key for a Toast job title ("Line Cook" → "line_cook"). */
export function jobKey(title) {
    const k = String(title == null ? '' : title).trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return k || 'job';
}

const posNum = (v) => {
    if (v === '' || v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
};
const centsKey = (n) => Math.round(n * 100);

/**
 * @param t  the Toast employee ({ lines:[{job, reg_hours, ot_hours, rate}] })
 * @param p  the roster person ({ job_rates, rate_override, last_rate }) or null
 * @returns null (single rate → legacy path) or
 *   { lines:[{job, key, reg_hours, ot_hours, toast_rate, rate, source}],
 *     regular_rate, hours, straight, override_ignored, missing:[line] }
 */
export function resolveJobPay(t, p) {
    const raw = (t && Array.isArray(t.lines)) ? t.lines : [];
    if (raw.length < 2) return null;
    const pins = (p && p.job_rates && typeof p.job_rates === 'object') ? p.job_rates : {};
    const override = posNum(p && p.rate_override);
    const last = posNum(p && p.last_rate);
    const lines = raw.map((ln) => {
        const key = jobKey(ln.job);
        const reg = Number(ln.reg_hours) || 0;
        const ot = Number(ln.ot_hours) || 0;
        const toastRate = posNum(ln.rate);
        const pin = posNum(pins[key]);
        let rate = 0; let source = 'none';
        if (pin) { rate = pin; source = 'locked'; }
        else if (override) { rate = override; source = 'override'; }
        else if (toastRate) { rate = toastRate; source = 'toast'; }
        else if (last) { rate = last; source = 'last'; }
        return { job: String(ln.job || '').trim() || 'job', key, reg_hours: reg, ot_hours: ot, toast_rate: toastRate || null, rate, source };
    });
    const worked = lines.filter((l) => l.reg_hours + l.ot_hours > 0);
    if (new Set(worked.map((l) => centsKey(l.rate))).size < 2) return null;
    const hours = worked.reduce((a, l) => a + l.reg_hours + l.ot_hours, 0);
    const straight = worked.reduce((a, l) => a + l.rate * (l.reg_hours + l.ot_hours), 0);
    const missing = worked.filter((l) => !(l.rate > 0));
    return {
        lines,
        hours: round2(hours),
        straight,
        regular_rate: hours > 0 ? straight / hours : 0,
        missing,
    };
}

/**
 * A person with a master lock (and no per-job locks) is paid that lock for
 * every hour. When Toast lists their worked jobs at DIFFERENT rates (or one
 * with no rate), return what Toast said so the engine can warn — the owner
 * may want per-job rates instead. null otherwise.
 */
export function lockOverDifferentJobs(t, p) {
    const raw = (t && Array.isArray(t.lines)) ? t.lines : [];
    const override = posNum(p && p.rate_override);
    if (raw.length < 2 || !override) return null;
    const worked = raw.filter((l) => (Number(l.reg_hours) || 0) + (Number(l.ot_hours) || 0) > 0);
    if (new Set(worked.map((l) => centsKey(posNum(l.rate)))).size < 2) return null;
    return { override, jobs: worked.map((l) => ({ job: String(l.job || '').trim() || 'job', toast_rate: posNum(l.rate) || null })) };
}

/**
 * Money for a multi-rate row, in float dollars (caller converts to cents).
 * `regHoursNow` is the row's regular hours AFTER cross-store OT moved some
 * out (applyCrossOt); those moved hours left at the weighted-average rate.
 */
export function jobPayAmounts(jp, regHoursNow, otHours) {
    const lineReg = jp.lines.reduce((a, l) => a + l.reg_hours, 0);
    const moved = Math.max(0, round2(lineReg - (Number(regHoursNow) || 0)));
    const reg = jp.lines.reduce((a, l) => a + l.rate * l.reg_hours, 0) - jp.regular_rate * moved;
    const ot = jp.lines.reduce((a, l) => a + l.rate * l.ot_hours, 0) + 0.5 * jp.regular_rate * (Number(otHours) || 0);
    return { reg, ot, moved };
}

/** Group a Toast employee's lines by job for the People step (UI only). */
export function jobsForPeople(t) {
    const raw = (t && Array.isArray(t.lines)) ? t.lines : [];
    const byKey = new Map();
    for (const ln of raw) {
        const key = jobKey(ln.job);
        const cur = byKey.get(key) || { key, label: String(ln.job || '').trim() || 'Job', hours: 0, toast_rates: [] };
        cur.hours = round2(cur.hours + (Number(ln.reg_hours) || 0) + (Number(ln.ot_hours) || 0));
        const r = posNum(ln.rate);
        if (r && !cur.toast_rates.some((x) => Math.abs(x - r) < 0.005)) cur.toast_rates.push(r);
        byKey.set(key, cur);
    }
    return [...byKey.values()];
}
