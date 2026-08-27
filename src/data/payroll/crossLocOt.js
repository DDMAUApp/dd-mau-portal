// Cross-location overtime reconciliation (2026-08-26, Andrew: "if yency
// works 40 hours a week at webster and that same week she worked 10 hours
// at dorsett it still gives her overtime").
//
// WHY THIS EXISTS: each store is its own Toast restaurant, and the payroll
// engine deliberately "takes OT as Toast reports it, never recomputes" —
// so someone splitting a week across stores (40h WG + 10h MH) showed ZERO
// overtime on both exports even though 10 of those hours are legally OT
// (the stores are joint employers; weekly hours aggregate under the FLSA).
//
// WHAT IT DOES: for every person on BOTH stores' exports in one run, it
// rebuilds their combined per-week hours from the /timecards feed (daily,
// per-store, Toast's own break-adjusted numbers via the scraper), computes
// the OT the combined weeks actually owe, subtracts the OT the exports
// already paid, and injects the shortfall as a pay-add. The netting is in
// PREMIUM DOLLARS: each workweek's overage is priced at that week's FLSA
// weighted regular rate, and the premium Toast already paid is valued at
// each store's own rate (see the block comment at the netting code). With
// one shared rate — the normal case — that reduces to:
//
//     top-up = missing OT hours × regular rate × 0.5
//
// ×0.5, NOT ×1.5 — the straight-time for those hours was already paid at
// 1.0× inside one store's regular hours; only the overtime PREMIUM is
// missing. The pay-add lands on the store where they worked more hours
// this period, with the full math in its note, and a warn-level check
// makes the owner acknowledge it before generating.
//
// ENGINE PHILOSOPHY (never guess — surface it): anything this module can't
// verify makes it REFUSE to add money and emit a check instead:
//   • clock data still loading → FAIL check (generation hard-blocks)
//   • clock data unavailable / fetch error → WARN, no auto-add
//   • clock total disagrees with the Toast export beyond tolerance → WARN
//   • period label unparseable → WARN, no auto-add. Weeks run SUN–SAT
//     (owner-confirmed 2026-08-26); each week's OT settles in the period
//     containing its Saturday, so misaligned Monday-start periods work.
//   • the two stores pay different rates → FLSA weighted regular rate,
//     spelled out in the note (that's the legal rule, not a guess)
//
// Pure module — no Firestore imports. The panel fetches the timecards and
// passes them in, so everything here is unit-testable.

import { c as cents, fmtG, money2, round2 } from './cents.js';

// Toast location codes used by payroll ↔ /timecards `location` values.
export const LOC_OF_CARD = { webster: 'WG', maryland: 'MH' };

/** normName — MUST match src/data/timecards.js normName (staffKey join). */
export function normCardKey(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** '8.10.26-8.23.26' → { start: '2026-08-10', end: '2026-08-23' } | null */
export function parsePeriodRange(period) {
    const m = String(period || '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})-(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
    if (!m) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const start = `20${m[3]}-${pad(m[1])}-${pad(m[2])}`;
    const end = `20${m[6]}-${pad(m[4])}-${pad(m[5])}`;
    if (Number.isNaN(Date.parse(start + 'T12:00:00Z')) || Number.isNaN(Date.parse(end + 'T12:00:00Z'))) return null;
    if (end < start) return null;
    return { start, end };
}

const DAY_MS = 86400000;
function utcNoon(dateStr) { return new Date(dateStr + 'T12:00:00Z'); }
export function periodDayCount(range) {
    return Math.round((utcNoon(range.end) - utcNoon(range.start)) / DAY_MS) + 1;
}
/** SUNDAY-start week key for a YYYY-MM-DD date. Andrew 2026-08-26: "our
 *  weeks are sunday through saturday" — the workweek for the 40h overtime
 *  threshold runs Sun–Sat. (An earlier build inferred Monday-start from
 *  clock data; the stores are closed most Sundays, which makes the two
 *  indistinguishable in the data — the owner's statement is the truth.) */
export function sundayKey(dateStr) {
    const d = utcNoon(dateStr);
    return new Date(d.getTime() - d.getUTCDay() * DAY_MS).toISOString().slice(0, 10);
}
/** The Saturday that ends the week containing dateStr. */
export function saturdayOf(dateStr) {
    return new Date(utcNoon(sundayKey(dateStr)).getTime() + 6 * DAY_MS).toISOString().slice(0, 10);
}
/** The clock-data range the panel must fetch for a pay period: extended back
 *  to the Sunday that starts the period's first week, because a Monday-start
 *  pay period's first Sun–Sat week can include the prior Sunday's hours. */
export function clockFetchRange(range) {
    return { start: sundayKey(range.start), end: range.end };
}

const OT_WEEK_HOURS = 40;
// Clock-vs-export tolerance per location, in hours. The scraper stores
// Toast's own break-adjusted hoursToday, so real deviation means missed
// days (scraper gap) or edited timecards — either way, don't auto-pay.
const RECON_TOL_HOURS = 0.25;
// Ignore sub-minute OT dust.
const MIN_TOPUP_HOURS = 0.02;

const check = (id, level, title, detail = '') => ({ id, level, title, detail });

/**
 * Apply CROSS OT ops to a parsed exports.employees map WITHOUT mutating the
 * original (the panel recomputes from pristine parsed state on every render —
 * in-place mutation would compound the move each render). The moved hours
 * leave reg_hours and land in xot_hours/xot_cents, which runLocation carries
 * into the row's dedicated CROSS OT column (Toast's own OT column is never
 * touched, so it always matches the raw export). Returns a new employees
 * object; untouched people share references.
 */
export function applyCrossOt(employees, ops) {
    if (!ops || ops.length === 0) return employees;
    const out = { ...employees };
    for (const op of ops) {
        const locMap = { ...(out[op.location] || {}) };
        const emp = locMap[op.key];
        if (!emp) continue; // defensive — op derived from this same map
        locMap[op.key] = {
            ...emp,
            reg_hours: round2((Number(emp.reg_hours) || 0) - op.hours),
            xot_hours: round2((Number(emp.xot_hours) || 0) + op.hours),
            xot_cents: (Number(emp.xot_cents) || 0) + op.total_cents,
        };
        out[op.location] = locMap;
    }
    return out;
}

/**
 * @param {object} args
 * @param {string} args.period            panel period label ('8.10.26-8.23.26')
 * @param {object} args.employees         parsed.exports.employees {WG:{key:emp}, MH:{...}}
 * @param {object} args.masters           inputs.masters {WG:{by_key}, MH:{by_key}}
 * @param {object|null} args.cards        { ready, error?, byKey: {staffKey: [{date, location, hours}]} }
 * @returns {{ extras: object[], checksByLoc: {WG: object[], MH: object[]}, sig: string }}
 *   extras are FINAL validated-shape pay-adds ({type:'other', key, location,
 *   name, note, amount_cents}) ready for runLocation's periodExtras.
 */
export function computeCrossLocOt({ period, employees, masters, cards }) {
    const checksByLoc = { WG: [], MH: [] };
    const extras = [];   // EXTRA-PAY fallback (differing rates / thin row)
    const crossOps = []; // preferred: hours moved REG → the CROSS OT column
    const both = Object.keys((employees && employees.WG) || {})
        .filter((k) => k in ((employees && employees.MH) || {}));
    const done = (sig) => ({ extras, crossOps, checksByLoc, sig });
    if (both.length === 0) return done('none');

    const pushBoth = (k) => { checksByLoc.WG.push(k); checksByLoc.MH.push(k); };

    const range = period ? parsePeriodRange(period) : null;
    if (!range || periodDayCount(range) < 6 || periodDayCount(range) > 35) {
        pushBoth(check('xot:period', 'warn', 'Cross-store overtime NOT auto-checked',
            `${both.length} name(s) worked both stores, but the period "${period || '(blank)'}" ` +
            `couldn't be resolved into real dates — combined weekly overtime was not verified. ` +
            `Check their combined hours by hand.`));
        return done('period-unparseable');
    }
    // Weeks run SUNDAY–SATURDAY (owner-confirmed). Pay periods start on
    // Mondays, so they don't align to week boundaries: a week's overtime
    // SETTLES in the pay period that contains that week's SATURDAY. The
    // leading partial week pulls in the prior Sunday's hours (the panel
    // fetches from clockFetchRange(range).start); the trailing partial
    // week (its Saturday lands after the period) settles NEXT period —
    // each week counts exactly once, no gaps, no double-pay.
    const fetchStart = sundayKey(range.start);

    if (!cards || !cards.ready) {
        // Hard-block: money could still change once the clock data lands.
        pushBoth(check('xot:pending', 'fail', 'Verifying cross-store overtime…',
            `${both.length} name(s) worked at both stores this period. Their combined weekly ` +
            `hours are being checked against the clock data — wait a moment, this clears itself.`));
        return done('pending');
    }
    if (cards.error) {
        pushBoth(check('xot:nocards', 'warn', 'Cross-store overtime could not be verified',
            `Clock data failed to load (${cards.error}). ${both.length} name(s) worked both ` +
            `stores — check their combined weekly hours by hand before paying.`));
        return done('cards-error');
    }

    for (const key of both) {
        const wg = employees.WG[key];
        const mh = employees.MH[key];
        const name = (masters.WG.by_key[key] && `${masters.WG.by_key[key].first} ${masters.WG.by_key[key].last}`)
            || wg.toast_name || key;

        // SALARY guard (2026-08-26 adversarial review #7): asRateData puts
        // salaried people in by_key with rate = their per-period salary
        // DOLLARS — treating that as an hourly rate would emit a monstrous
        // top-up and then crash runLocation (sections.SALARY doesn't exist).
        // Hourly OT doesn't apply to them here; surface it, never compute.
        const secWG = (masters.WG.by_key[key] || {}).section;
        const secMH = (masters.MH.by_key[key] || {}).section;
        const hourly = (s) => s === 'FOH' || s === 'BOH';
        if (!hourly(secWG) || !hourly(secMH)) {
            pushBoth(check(`xot:salary:${key}`, 'warn',
                `${name}: worked both stores but isn't hourly at both`,
                `Cross-store overtime is only auto-computed for hourly (FOH/BOH) people. ` +
                `Their sections read WG=${secWG || '?'} / MH=${secMH || '?'} — if overtime applies, handle it by hand.`));
            continue;
        }
        const exportHours = {
            WG: round2((Number(wg.reg_hours) || 0) + (Number(wg.ot_hours) || 0)),
            MH: round2((Number(mh.reg_hours) || 0) + (Number(mh.ot_hours) || 0)),
        };
        const paidOt = round2((Number(wg.ot_hours) || 0) + (Number(mh.ot_hours) || 0));

        // Collect this person's period card-rows. The /timecards staffKey is
        // normName("First Last") from the scraper, but the payroll export's
        // raw toast_name is "Last, First" — keying off the raw name found
        // ZERO cards and silently warn-skipped every person (caught by the
        // 2026-08-26 synthetic end-to-end). Primary key = parsed first+last;
        // raw names kept as fallback (extra keys are harmless: rows dedupe
        // by doc id and the reconciliation guard still protects the money).
        const staffKeys = [...new Set([
            `${wg.first || ''} ${wg.last || ''}`, `${mh.first || ''} ${mh.last || ''}`,
            wg.toast_name, mh.toast_name,
        ].map(normCardKey).filter(Boolean))];
        const seen = new Set();
        const rows = [];
        for (const sk of staffKeys) {
            for (const r of (cards.byKey[sk] || [])) {
                // Extended window: leading days back to the week's Sunday
                // feed the weekly math; the RECONCILIATION below only counts
                // days inside the pay period (what the export pays).
                if (!r || !r.date || r.date < fetchStart || r.date > range.end) continue;
                const id = r.id || `${r.location}|${r.date}`;
                if (seen.has(id)) continue;
                seen.add(id);
                rows.push(r);
            }
        }

        // Per-location clock totals (period days only) + per-week
        // per-location hours (Sun–Sat weeks, extended window).
        const clockByLoc = { WG: 0, MH: 0 };
        const weekLocHours = new Map(); // sundayKey -> { WG, MH }
        let unknownLoc = false;
        for (const r of rows) {
            const loc = LOC_OF_CARD[r.location];
            if (!loc) { unknownLoc = true; continue; }
            const h = Number(r.hours) || 0;
            if (r.date >= range.start) clockByLoc[loc] += h;
            const wk = sundayKey(r.date);
            // Only weeks that SETTLE in this period (Saturday ≤ period end)
            // count toward this run — a trailing partial week is the next
            // period's business.
            if (saturdayOf(r.date) > range.end) continue;
            const w = weekLocHours.get(wk) || { WG: 0, MH: 0 };
            w[loc] += h;
            weekLocHours.set(wk, w);
        }
        clockByLoc.WG = round2(clockByLoc.WG);
        clockByLoc.MH = round2(clockByLoc.MH);

        // Reconcile clock vs export per store — disagreement means the clock
        // picture is incomplete (scraper gap / edited cards): never auto-pay
        // off numbers that don't match what's actually being paid.
        const drift = (loc) => Math.abs(clockByLoc[loc] - exportHours[loc]);
        if (unknownLoc || drift('WG') > RECON_TOL_HOURS || drift('MH') > RECON_TOL_HOURS) {
            pushBoth(check(`xot:mismatch:${key}`, 'warn',
                `${name}: cross-store overtime could not be verified`,
                `Worked both stores, but the clock data (WG ${fmtG(clockByLoc.WG)}h / MH ${fmtG(clockByLoc.MH)}h) ` +
                `doesn't match the Toast exports (WG ${fmtG(exportHours.WG)}h / MH ${fmtG(exportHours.MH)}h)` +
                (unknownLoc ? ' and some clock rows had an unknown store' : '') +
                `. No overtime was added automatically — check their combined weekly hours by hand.`));
            continue;
        }

        // Rates — must be valid before any money math.
        const rateWG = Number((masters.WG.by_key[key] || {}).rate);
        const rateMH = Number((masters.MH.by_key[key] || {}).rate);
        const ratesOk = Number.isFinite(rateWG) && rateWG > 0 && Number.isFinite(rateMH) && rateMH > 0;
        const ratesEqual = ratesOk && Math.abs(rateWG - rateMH) <= 0.005;

        // OT the combined weeks owe vs OT the exports already paid — netted
        // in PREMIUM DOLLARS, not hours (2026-08-26 adversarial review #2:
        // hour-netting at a blended rate mis-priced already-paid OT by
        // Δrate × paidOT × 0.5 when the stores pay different rates). Each
        // workweek prices its overtime at THAT week's FLSA weighted regular
        // rate; the premium Toast already paid is valued at each store's own
        // rate. Same-rate people (the norm) reduce to the simple formula.
        let owedOt = 0;            // hours (display + dust gate)
        let owedPremiumCents = 0;  // authoritative money
        const weekBits = [];
        for (const [wk, w] of [...weekLocHours.entries()].sort()) {
            const combined = round2(w.WG + w.MH);
            const over = Math.max(0, round2(combined - OT_WEEK_HOURS));
            if (over <= 0) continue;
            owedOt = round2(owedOt + over);
            if (!ratesOk) { weekBits.push(`week of ${wk}: ${fmtG(combined)}h combined → ${fmtG(over)}h OT`); continue; }
            const wkRate = ratesEqual ? rateWG
                : round2((w.WG * rateWG + w.MH * rateMH) / combined);
            owedPremiumCents += cents(over * wkRate * 0.5);
            weekBits.push(`week of ${wk}: ${fmtG(combined)}h combined → ${fmtG(over)}h OT` +
                (ratesEqual ? '' : ` @ $${fmtG(wkRate)} weighted (WG ${fmtG(round2(w.WG))}h × $${fmtG(rateWG)} + MH ${fmtG(round2(w.MH))}h × $${fmtG(rateMH)})`));
        }
        const missingHours = round2(owedOt - paidOt);
        if (owedOt > 0 && !ratesOk) {
            pushBoth(check(`xot:norate:${key}`, 'warn', `${name}: cross-store overtime needs a rate`,
                `Their combined weeks owe ${fmtG(owedOt)}h of overtime (exports pay ${fmtG(paidOt)}h), but a valid pay rate ` +
                `couldn't be resolved (WG $${fmtG(Number.isFinite(rateWG) ? rateWG : 0)} / MH $${fmtG(Number.isFinite(rateMH) ? rateMH : 0)}). ` +
                `Fix their rate on the People step and re-run.`));
            continue;
        }
        const paidPremiumCents = ratesOk
            ? cents((Number(wg.ot_hours) || 0) * rateWG * 0.5) + cents((Number(mh.ot_hours) || 0) * rateMH * 0.5)
            : 0;
        const amountCents = owedPremiumCents - paidPremiumCents;
        if (missingHours <= MIN_TOPUP_HOURS || amountCents <= 0) {
            if (owedOt > 0) {
                pushBoth(check(`xot:ok:${key}`, 'info', `${name}: cross-store overtime already covered`,
                    `Combined weeks owe ${fmtG(owedOt)}h OT ($${money2(owedPremiumCents / 100)} premium); ` +
                    `the exports already pay ${fmtG(paidOt)}h ($${money2(paidPremiumCents / 100)}).`));
            }
            continue;
        }

        // CROSS OT column (Andrew 2026-08-26: "we can add a new column …
        // called cross OT"): the missing hours leave the landing row's
        // REGULAR column and land in a dedicated CROSS OT column, paid
        // straight time (exactly what left REG, at that row's own rate)
        // PLUS the FLSA-exact premium — net ≈1.5×, exact legal dollars in
        // EVERY case including differing store rates. Toast's own OT
        // column is never touched, so it always matches the raw export.
        const landPref = exportHours.WG >= exportHours.MH ? 'WG' : 'MH';
        const otherLoc = landPref === 'WG' ? 'MH' : 'WG';
        const empOf = { WG: wg, MH: mh };
        const rateOf = { WG: rateWG, MH: rateMH };
        const landLoc = (Number(empOf[landPref].reg_hours) || 0) >= missingHours ? landPref
            : (Number(empOf[otherLoc].reg_hours) || 0) >= missingHours ? otherLoc
            : null;
        const weekMath = `${weekBits.join('; ')}` +
            ` (WG ${fmtG(exportHours.WG)}h + MH ${fmtG(exportHours.MH)}h this period; exports already pay ${fmtG(paidOt)}h OT` +
            (paidPremiumCents > 0 ? ` = $${money2(paidPremiumCents / 100)} premium, subtracted` : '') + ')';
        if (landLoc) {
            const straightCents = cents(missingHours * rateOf[landLoc]);
            const totalCents = straightCents + amountCents;
            crossOps.push({ key, location: landLoc, hours: missingHours, straight_cents: straightCents, premium_cents: amountCents, total_cents: totalCents });
            checksByLoc[landLoc].push(check(`xot:topup:${key}`, 'warn',
                `${name}: ${fmtG(missingHours)}h CROSS OT (+$${money2(amountCents / 100)} over regular)`,
                `Combined weeks put them over 40h: ${weekMath}. ${fmtG(missingHours)}h moved from REGULAR to the CROSS OT column on the ${landLoc} check — ` +
                `$${money2(totalCents / 100)} there (straight time $${money2(straightCents / 100)} + overtime premium $${money2(amountCents / 100)}` +
                (ratesEqual ? `, ≈ $${fmtG(rateOf[landLoc])} × 1.5` : ` — stores pay different rates, so the premium uses the FLSA weighted rate`) + `).`));
        } else {
            // Neither store's check has enough regular hours to move
            // (pathological) — exact dollars as EXTRA PAY so the money
            // still lands.
            const dispRate = ratesEqual ? rateWG : round2((amountCents / 100) / (missingHours * 0.5));
            const note = `Cross-store OT premium: ${fmtG(missingHours)}h ≈ $${money2(amountCents / 100)}. ${weekMath}.` +
                ` Shown as EXTRA PAY because neither store's check has ${fmtG(missingHours)} regular hours to move to CROSS OT.` +
                ` Straight time for these hours is already in regular pay — this is the missing ×0.5 premium only.`;
            extras.push({ type: 'xot_premium', key, location: landPref, name, note, hours: missingHours, rate: dispRate, amount_cents: amountCents });
            checksByLoc[landPref].push(check(`xot:topup:${key}`, 'warn',
                `${name}: cross-store overtime added — $${money2(amountCents / 100)}`, note));
        }
    }

    const sig = [
        ...extras.map((x) => `${x.key}:${x.amount_cents}`),
        ...crossOps.map((r) => `${r.key}:x${r.total_cents}`),
    ].sort().join(',') || 'clean';
    return done(sig);
}
