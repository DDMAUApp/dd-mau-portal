// Core payroll calculation — faithful JS port of app/engine/payroll.py.
//
// All money is integer cents. Two invariants this module guarantees:
//   1. HOURS — every hour on the Toast export shows up exactly once in the
//      result (active rows + review section). Checked, not assumed.
//   2. TIPS  — FOH pool + BOH pool == card + cash tips to the penny, and each
//      pool is distributed to the penny (largest-remainder).
// Anything the program would have to guess (unknown person's section/rate,
// whether merged multi-job hours re-trigger OT) is never guessed — it is
// surfaced as a check the owner must resolve or acknowledge.

import { c, cRound, fmtG, money2, round2, roundN } from './cents.js';
import { suggestMatch } from './names.js';
import { describe } from './extras.js';

const OT_MULT = 1.5;

/** FOH/BOH pool split that always sums to the total. Mirrors split_pools.
 *  fohPct is clamped to [0,100] so a stray out-of-range % (e.g. a pasted 150)
 *  can never make one pool exceed the tips or the other pool go negative — both
 *  pools stay in [0,total] and always sum to total. */
export function splitPools(totalCents, fohPct) {
    const pct = Math.min(100, Math.max(0, Number.isFinite(fohPct) ? fohPct : 50));
    const foh = cRound((totalCents * pct) / 100.0);
    return [foh, totalCents - foh];
}

/**
 * Largest-remainder allocation of poolCents over weights (hours). Returns an
 * array of cents, same order as weights, summing EXACTLY to poolCents (all
 * zeros if total weight is 0). Mirrors allocate_pool, including its tie-break
 * key `(remainder, weight, -index)` sorted descending.
 */
export function allocatePool(poolCents, weights) {
    const n = weights.length;
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0 || poolCents === 0) return new Array(n).fill(0);
    const exact = weights.map((w) => (poolCents * w) / total);
    // Math.floor (toward −∞), NOT trunc (toward 0): for a non-negative pool the
    // two are identical (exact ≥ 0), so this is behavior-for-behavior the same on
    // every real tip pool. For a NEGATIVE pool (possible if a refund makes Toast
    // card tips negative), trunc rounded the "floor" the wrong way and left a cent
    // unallocated; floor + a sign-aware remainder conserves to the penny either way.
    const floors = exact.map((e) => Math.floor(e));
    const short = poolCents - floors.reduce((a, b) => a + b, 0); // sign = pool sign, |short| = cents to spread
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
        const ra = exact[a] - floors[a];
        const rb = exact[b] - floors[b];
        if (rb !== ra) return rb - ra;                       // remainder desc
        if (weights[b] !== weights[a]) return weights[b] - weights[a]; // weight desc
        return a - b;                                        // -index desc == index asc
    });
    const step = short >= 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(short); i++) floors[order[i]] += step;
    return floors;
}

function check(id, level, title, detail = '') {
    return { id, level, title, detail };
}

function newRow(m, t) {
    return {
        key: m.key, first: m.first, last: m.last,
        legal_first: m.legal_first, legal_last: m.legal_last,
        display_first: (m.legal_first || m.first),
        display_last: (m.legal_last || m.last),
        section: m.section, rate: m.rate,
        no_tip: m.no_tip, direct_deposit: m.direct_deposit,
        toast_name: t ? t.toast_name : null,
        toast_rate: t ? t.toast_rate : null, // what Toast reported (for the "pay rate changed" flag)
        reg_hours: t ? t.reg_hours : 0.0,
        ot_hours: t ? t.ot_hours : 0.0,
        total_hours: t ? round2(t.reg_hours + t.ot_hours) : 0.0,
        multi_line: !!(t && t.multi_line),
        lines: t ? t.lines : [],
        merge_detail: null,
        tip_cents: 0, reg_cents: 0, ot_cents: 0,
        extra_cents: 0, hol_hours: 0.0, hol_cents: 0,
        vac_hours: 0.0, vac_cents: 0, comp_cents: 0,
        extras: [],
    };
}

function totals(rows) {
    const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
    return {
        reg_hours: round2(sum((r) => r.reg_hours)),
        ot_hours: round2(sum((r) => r.ot_hours)),
        total_hours: round2(sum((r) => r.total_hours)),
        tip_cents: sum((r) => r.tip_cents),
        reg_cents: sum((r) => r.reg_cents),
        ot_cents: sum((r) => r.ot_cents),
        extra_cents: sum((r) => r.extra_cents),
        hol_hours: round2(sum((r) => r.hol_hours)),
        hol_cents: sum((r) => r.hol_cents),
        vac_hours: round2(sum((r) => r.vac_hours)),
        vac_cents: sum((r) => r.vac_cents),
        comp_cents: sum((r) => r.comp_cents),
    };
}

export function worstLevel(checks) {
    const levels = new Set(checks.map((k) => k.level));
    for (const lvl of ['fail', 'warn']) if (levels.has(lvl)) return lvl;
    return 'pass';
}

/**
 * Compute one location's payroll. Returns a JSON-able object identical in shape
 * + values to payroll.run_location. `toastEmps` is {key: emp}; `masterData` has
 * {employees[], salary[], by_key{}, errors[]}.
 */
export function runLocation(loc, toastEmps, masterData, cardTipsCents, cashTipsCents, fohPct, periodExtras, salesWarning = null) {
    const checks = [];
    const byKey = masterData.by_key;

    for (const err of masterData.errors) checks.push(check('master', 'fail', 'Roster problem', err));
    if (salesWarning) checks.push(check('sales', 'warn', 'Sales summary tips', salesWarning));

    // ---- match Toast -> master --------------------------------------------
    const rowsByKey = {};
    const review = [];
    const knownKeys = masterData.employees.map((e) => e.key);
    const sortedToast = Object.entries(toastEmps).sort(([, a], [, b]) => {
        const al = String(a.last).toLowerCase();
        const bl = String(b.last).toLowerCase();
        if (al < bl) return -1;
        if (al > bl) return 1;
        const af = String(a.first).toLowerCase();
        const bf = String(b.first).toLowerCase();
        if (af < bf) return -1;
        if (af > bf) return 1;
        return 0;
    });
    for (const [key, t] of sortedToast) {
        const m = byKey[key];
        if (m === undefined || m === null || m.section === 'SALARY') {
            const suggKey = suggestMatch(key, knownKeys);
            const sugg = suggKey ? byKey[suggKey] : null;
            review.push({
                key, toast_name: t.toast_name, first: t.first, last: t.last,
                reg_hours: t.reg_hours, ot_hours: t.ot_hours,
                total_hours: round2(t.reg_hours + t.ot_hours),
                toast_rate: t.toast_rate,
                suggestion: sugg ? `${sugg.first} ${sugg.last}` : null,
                lines: t.lines,
            });
            continue;
        }
        rowsByKey[key] = newRow(m, t);
        if (t.name_conflict) {
            checks.push(check(`namemerge:${key}`, 'fail', `Two different names merged into one paycheck`,
                `Toast rows for ${(t.merged_names || []).join(' AND ')} collapsed to a single person (${m.first} ${m.last}) — usually a wrong alias or a name-spelling collision. Their hours/tips were SUMMED onto one check. If these are different people, fix the alias/spelling and re-run; if it's really one person, confirm before generating.`));
        }
        if (t.multi_line) {
            const detail = t.lines
                .map((ln) => `${ln.job || 'job'}: ${fmtG(ln.reg_hours)}h reg + ${fmtG(ln.ot_hours)}h OT @ $${fmtG(ln.rate)}`)
                .join('; ');
            rowsByKey[key].merge_detail = detail;
            checks.push(check(`merge:${key}`, 'warn', `${m.first} ${m.last}: multiple jobs merged`,
                `Toast listed them once per job; hours were summed. ${detail}. OT is taken as Toast reports it per line, not recomputed.`));
        }
        const drift = Math.abs(t.toast_rate - m.rate);
        if (t.toast_rate && drift > 0.005) {
            checks.push(check(`rate:${key}`, 'warn', `${m.first} ${m.last}: rate differs from Toast`,
                `Master list $${fmtG(m.rate)}/hr (used for pay) vs Toast $${fmtG(t.toast_rate)}/hr. Fix whichever is wrong.`));
        }
        // PM6 — Toast reported a $0/blank rate but we have a real roster rate to
        // fall back on. We DID pay them (from last-known / override), but the
        // rate-drift check above skips a falsy Toast rate — so surface it out loud
        // rather than let a stale $0-from-Toast hide silently. Additive warn only;
        // no money math changes. (A $0 Toast rate with NO roster fallback still
        // hits the zerorate hard-FAIL below.)
        if (!t.toast_rate && Number.isFinite(m.rate) && m.rate > 0 && ((t.reg_hours || 0) > 0 || (t.ot_hours || 0) > 0)) {
            checks.push(check(`toastzero:${key}`, 'warn', `${m.first} ${m.last}: Toast reported $0/hr`,
                `Toast's pay rate for them was $0 or blank, so pay used $${fmtG(m.rate)}/hr from the roster (last known or your override). Confirm that's the right rate.`));
        }
    }

    // Roster people with no hours this period — shown, never dropped silently.
    const idle = masterData.employees
        .filter((e) => !(e.key in rowsByKey))
        .map((e) => `${e.first} ${e.last}`);
    if (idle.length) {
        const shown = idle.slice(0, 20).join(', ') + (idle.length > 20 ? ` … (+${idle.length - 20} more)` : '');
        checks.push(check('idle', 'info', `${idle.length} roster names had no hours this period`, shown));
    }

    for (const r of review) {
        checks.push(check(`unknown:${r.key}`, 'warn',
            `NEW — needs section + Direct Deposit setup: ${r.toast_name} (${fmtG(r.total_hours)}h)`,
            "New on the Toast export. All their hours are in the doc's red NEW section, but "
            + 'they are in no tip pool yet -- the program won\'t guess their FOH/BOH section. '
            + (r.suggestion ? `Looks like it might be ${r.suggestion} (fix the spelling in Toast if so). ` : '')
            + 'Set their section + DD on the People step, then re-run.'));
    }

    // ---- section grouping --------------------------------------------------
    const sections = { FOH: [], BOH: [] };
    for (const e of masterData.employees) {
        const row = rowsByKey[e.key];
        if (row) sections[e.section].push(row);
    }

    // ---- tips --------------------------------------------------------------
    const totalTips = cardTipsCents + cashTipsCents;
    const [fohPool, bohPool] = splitPools(totalTips, fohPct);
    for (const [sec, pool] of [['FOH', fohPool], ['BOH', bohPool]]) {
        const rows = sections[sec];
        const eligible = rows.filter((r) => !r.no_tip);
        const weights = eligible.map((r) => r.total_hours);
        const shares = allocatePool(pool, weights);
        eligible.forEach((r, i) => { r.tip_cents = shares[i]; });
        const sumW = weights.reduce((a, b) => a + b, 0);
        if (pool > 0 && sumW <= 0) {
            checks.push(check(`pool:${sec}`, 'fail', `${sec} tip pool has no one to receive it`,
                `$${money2(pool / 100)} is assigned to ${sec} but no eligible hours were worked.`));
        }
        const allocated = eligible.reduce((a, r) => a + r.tip_cents, 0);
        if (allocated !== pool && sumW > 0) {
            checks.push(check(`tipsum:${sec}`, 'fail', `${sec} tips don't add up`,
                `pool $${money2(pool / 100)} vs allocated $${money2(allocated / 100)}`));
        }
    }

    // ---- extras ------------------------------------------------------------
    const appliedExtras = [];
    for (const x of periodExtras) {
        if (x.location !== loc) continue;
        let row = rowsByKey[x.key];
        if (row === undefined || row === null) {
            const m = byKey[x.key];
            if (m === undefined || m === null) {
                checks.push(check(`extra:${x.key}`, 'fail', `Extra for unknown person: ${x.name}`,
                    x.type ? describe(x) : String(x)));
                continue;
            }
            // Person had no Toast hours this period (vacation-only or advance
            // square-up) — give them a zero-hour row so the money lands.
            row = newRow(m, null);
            rowsByKey[m.key] = row;
            sections[m.section].push(row);
        }
        const desc = describe(x);
        row.extras.push(desc);
        appliedExtras.push({ ...x, description: desc });
        if (x.type === 'vacation') {
            row.vac_hours += x.hours;
            row.vac_cents += x.amount_cents;
        } else if (x.type === 'holiday') {
            row.hol_hours += x.hours;
            row.hol_cents += x.amount_cents;
        } else { // backpay / bonus / advance / reg_hours / ot_hours / other
            row.extra_cents += x.amount_cents;
        }
    }

    // ---- per-row money -----------------------------------------------------
    for (const sec of ['FOH', 'BOH']) {
        for (const r of sections[sec]) {
            // A worked person must have a real, positive pay rate. A rate that is
            // 0 or non-finite (missing Toast/last rate, a pinned $0 the engine
            // dropped, a non-numeric value) would silently pay $0 of base wages on
            // an otherwise-green run — so hard-FAIL it. This is the guard that makes
            // "paid the wrong amount" impossible to ship rather than just unlikely.
            if (r.total_hours > 0 && (!Number.isFinite(r.rate) || r.rate <= 0)) {
                checks.push(check(`zerorate:${r.key}`, 'fail', `${r.first} ${r.last}: pay rate is $0 / missing`,
                    `They worked ${fmtG(r.total_hours)} hours but their pay rate read as $${fmtG(Number.isFinite(r.rate) ? r.rate : 0)}/hr. Set their rate on the People step (digits only, no $ or commas) and re-run.`));
            }
            r.reg_cents = c(r.rate * r.reg_hours);
            r.ot_cents = c(r.rate * OT_MULT * r.ot_hours);
            r.comp_cents = r.tip_cents + r.reg_cents + r.ot_cents + r.extra_cents + r.hol_cents + r.vac_cents;
            r.eff_rate = r.total_hours ? round2(r.comp_cents / 100.0 / r.total_hours) : null;
            // comp_cents must be a real number. NaN < 0 is false, so a NaN paycheck
            // would slip past the negative-pay check below — guard it explicitly.
            if (!Number.isFinite(r.comp_cents)) {
                checks.push(check(`nancomp:${r.key}`, 'fail', `${r.first} ${r.last}: paycheck didn't compute`,
                    'Their total pay came out as not-a-number — a rate or hours value is bad. Fix it on the People step and re-run.'));
            } else if (r.comp_cents < 0) {
                checks.push(check(`negcomp:${r.key}`, 'fail', `${r.first} ${r.last}: negative paycheck`,
                    `Total comp is $${money2(r.comp_cents / 100)}. An advance deduction is bigger than what they earned this period -- split it across periods.`));
            }
            if (r.total_hours > 100) {
                checks.push(check(`bighours:${r.key}`, 'warn', `${r.first} ${r.last}: ${fmtG(r.total_hours)} hours`,
                    'Over 100 hours in one period -- double-check the time cards.'));
            }
        }
    }

    // ---- salary ------------------------------------------------------------
    const salaryRows = [];
    for (const s of masterData.salary) {
        const amountCents = c(s.rate);
        salaryRows.push({
            first: s.first, last: s.last,
            legal_first: s.legal_first, legal_last: s.legal_last,
            amount_cents: amountCents, direct_deposit: true,
        });
        // Salary people are NOT part of the hours/tips reconciliation, so a
        // bad salary $ would otherwise ship a wrong line with no check catching
        // it. Hard-block: NaN (e.g. someone typed "1,200" -> NaN), AND a blank/
        // zero amount. 2026-06-20 (QA audit AD2): a blank field becomes
        // Number(''||0)=0 -> c(0)=0, which IS finite, so the old NaN-only guard
        // silently shipped a $0.00 paycheck. Flag <=0 too.
        if (!Number.isFinite(amountCents) || amountCents <= 0) {
            checks.push(check(`salary:${s.key || (s.first + s.last)}`, 'fail',
                `${s.first} ${s.last}: salary amount is missing, zero, or not a number`,
                "Their salary $/period is blank, zero, or didn't read as a number — fix it on the People step (digits only, no commas)."));
        }
    }

    // ---- invariant: every Toast hour is represented ------------------------
    let toastTotal = 0;
    for (const t of Object.values(toastEmps)) toastTotal += t.reg_hours + t.ot_hours;
    toastTotal = round2(toastTotal);
    let outTotal = 0;
    for (const sec of ['FOH', 'BOH']) for (const r of sections[sec]) outTotal += r.reg_hours + r.ot_hours;
    for (const r of review) outTotal += r.reg_hours + r.ot_hours;
    outTotal = round2(outTotal);
    if (!Number.isFinite(toastTotal) || !Number.isFinite(outTotal) || Math.abs(toastTotal - outTotal) > 0.005) {
        // `NaN > 0.005` is false, which would otherwise let a NaN-hours run take the
        // green "all accounted for" branch — force the finite check first.
        checks.push(check('hours', 'fail', 'Hours reconciliation FAILED',
            `Toast export has ${fmtG(toastTotal)} hours; output accounts for ${fmtG(outTotal)}.`));
    } else {
        const peopleCount = sections.FOH.length + sections.BOH.length;
        checks.push(check('hours', 'pass', 'Every Toast hour accounted for',
            `${fmtG(toastTotal)} hours in = ${fmtG(outTotal)} hours out (${peopleCount} people + ${review.length} in review).`));
    }

    const grandTips = sections.FOH.reduce((a, r) => a + r.tip_cents, 0) + sections.BOH.reduce((a, r) => a + r.tip_cents, 0);
    if (grandTips === totalTips || totalTips === 0) {
        checks.push(check('tips', 'pass', 'Tips distributed to the penny',
            `$${money2(cardTipsCents / 100)} card + $${money2(cashTipsCents / 100)} cash = $${money2(totalTips / 100)} = FOH $${money2(fohPool / 100)} + BOH $${money2(bohPool / 100)}.`));
    }

    // ---- section outputs ---------------------------------------------------
    const secOut = {};
    for (const sec of ['FOH', 'BOH']) {
        const rows = sections[sec];
        const pool = sec === 'FOH' ? fohPool : bohPool;
        const eligibleHours = rows.filter((r) => !r.no_tip).reduce((a, r) => a + r.total_hours, 0);
        for (const r of rows) {
            r.pool_pct = (eligibleHours && !r.no_tip) ? round2((100.0 * r.total_hours) / eligibleHours) : 0.0;
        }
        secOut[sec] = {
            rows,
            pool_cents: pool,
            eligible_hours: round2(eligibleHours),
            tips_per_hour: eligibleHours ? round2(pool / 100.0 / eligibleHours) : 0.0,
            totals: totals(rows),
        };
    }

    const grand = totals([...sections.FOH, ...sections.BOH]);
    grand.salary_cents = salaryRows.reduce((a, s) => a + s.amount_cents, 0);

    return {
        location: loc,
        tips: {
            card_cents: cardTipsCents, cash_cents: cashTipsCents,
            total_cents: totalTips, foh_pct: fohPct, boh_pct: roundN(100 - fohPct, 4),
            foh_pool_cents: fohPool, boh_pool_cents: bohPool,
        },
        sections: secOut,
        review,
        salary: salaryRows,
        extras_applied: appliedExtras,
        checks,
        totals: grand,
    };
}
