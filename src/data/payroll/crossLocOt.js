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
// the OT the combined weeks actually owe, and moves the shortfall into a
// dedicated CROSS OT column. Attribution is CHRONOLOGICAL per Sun–Sat week
// (owner's rule, 2026-08-26): the first 40 hours are regular; every hour
// after belongs to the store where it was worked and pays THAT store's
// rate × 1.5 (the FLSA "rate in effect" method for two-rate overtime) —
// e.g. 40h Webster Mon–Fri + 10h Dorsett Saturday = 10h OT at Dorsett's
// rate on the Dorsett check. OT a store's export already pays is netted
// per store, never cross-netted. Warn-level checks carry the full math
// and force acknowledgment before generating.
//
// ENGINE PHILOSOPHY (never guess — surface it): anything this module can't
// verify makes it REFUSE to add money and emit a check instead:
//   • clock data still loading → FAIL check (generation hard-blocks)
//   • clock data unavailable / fetch error → WARN, no auto-add
//   • clock total disagrees with the Toast export beyond tolerance → WARN
//   • period label unparseable → WARN, no auto-add. Weeks run SUN–SAT
//     (owner-confirmed 2026-08-26); each week's OT settles in the period
//     containing its Saturday, so misaligned Monday-start periods work.
//   • a store owed OT hours has no valid rate → WARN, no auto-add
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

        // Per-location clock totals (period days only) + per-week DAY LISTS
        // (Sun–Sat weeks, extended window). Day-level detail is needed
        // because OT attribution is CHRONOLOGICAL (see below).
        const clockByLoc = { WG: 0, MH: 0 };
        const weekDays = new Map(); // sundayKey -> [{date, loc, hours, firstIn}]
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
            const list = weekDays.get(wk) || [];
            list.push({ date: r.date, loc, hours: h, firstIn: r.firstIn || '' });
            weekDays.set(wk, list);
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

        // Rates per store.
        const rateOf = { WG: Number((masters.WG.by_key[key] || {}).rate), MH: Number((masters.MH.by_key[key] || {}).rate) };
        const rateOk = (l) => Number.isFinite(rateOf[l]) && rateOf[l] > 0;

        // CHRONOLOGICAL OT attribution (Andrew 2026-08-26: "where the staff
        // has the overtime at — which is usually later in the week — that's
        // the pay we follow"; his example: 40h Webster Mon–Fri + 10h Dorsett
        // Saturday → 10h of overtime at Dorsett's rate). Within each Sun–Sat
        // week the days run in worked order (date, then first clock-in for
        // two-store days); the first 40 hours are regular, every hour after
        // belongs to the store where it was worked and pays THAT store's
        // rate — the FLSA "rate in effect" method for two-rate overtime. A
        // day straddling the 40-hour mark splits.
        let owedOt = 0;
        const owedByLoc = { WG: 0, MH: 0 };
        const weekBits = [];
        for (const [wk, days] of [...weekDays.entries()].sort()) {
            days.sort((a, b) => (a.date === b.date
                ? String(a.firstIn).localeCompare(String(b.firstIn))
                : (a.date < b.date ? -1 : 1)));
            const combined = round2(days.reduce((s, d) => s + d.hours, 0));
            const over = Math.max(0, round2(combined - OT_WEEK_HOURS));
            if (over <= 0) continue;
            owedOt = round2(owedOt + over);
            let cum = 0;
            const wkByLoc = { WG: 0, MH: 0 };
            for (const d of days) {
                const before = cum;
                cum = round2(cum + d.hours);
                // This day's share of the over-40 span.
                const otPart = Math.max(0, round2(Math.min(cum, combined) - Math.max(before, OT_WEEK_HOURS)));
                if (otPart > 0) wkByLoc[d.loc] = round2(wkByLoc[d.loc] + otPart);
            }
            owedByLoc.WG = round2(owedByLoc.WG + wkByLoc.WG);
            owedByLoc.MH = round2(owedByLoc.MH + wkByLoc.MH);
            const bits = ['WG', 'MH'].filter((l) => wkByLoc[l] > 0)
                .map((l) => `${fmtG(wkByLoc[l])}h at ${l}`).join(' + ');
            weekBits.push(`week of ${wk}: ${fmtG(combined)}h combined → ${fmtG(over)}h OT (${bits})`);
        }

        // Net per store against the OT that store's export already pays —
        // never cross-netted (one store's overpaid OT is never clawed back
        // or used to cancel the other store's shortfall).
        const paidOtOf = { WG: round2(Number(wg.ot_hours) || 0), MH: round2(Number(mh.ot_hours) || 0) };
        const missingOf = {
            WG: Math.max(0, round2(owedByLoc.WG - paidOtOf.WG)),
            MH: Math.max(0, round2(owedByLoc.MH - paidOtOf.MH)),
        };
        const missingHours = round2(missingOf.WG + missingOf.MH);
        if (missingHours <= MIN_TOPUP_HOURS) {
            if (owedOt > 0) {
                pushBoth(check(`xot:ok:${key}`, 'info', `${name}: cross-store overtime already covered`,
                    `Combined weeks owe ${fmtG(owedOt)}h OT (WG ${fmtG(owedByLoc.WG)}h / MH ${fmtG(owedByLoc.MH)}h); ` +
                    `the exports already pay ${fmtG(paidOt)}h.`));
            }
            continue;
        }
        const needLocs = ['WG', 'MH'].filter((l) => missingOf[l] > MIN_TOPUP_HOURS);
        if (needLocs.some((l) => !rateOk(l))) {
            pushBoth(check(`xot:norate:${key}`, 'warn', `${name}: cross-store overtime needs a rate`,
                `Their combined weeks owe ${fmtG(missingHours)}h of overtime, but a valid pay rate ` +
                `couldn't be resolved (WG $${fmtG(rateOk('WG') ? rateOf.WG : 0)} / MH $${fmtG(rateOk('MH') ? rateOf.MH : 0)}). ` +
                `Fix their rate on the People step and re-run.`));
            continue;
        }

        // CROSS OT column, one op per store that holds over-40 hours: the
        // hours leave that store's REGULAR column and land in its CROSS OT
        // column at that store's own rate × 1.5 (straight time + premium).
        // Toast's own OT column is never touched.
        const empOf = { WG: wg, MH: mh };
        const weekMath = `${weekBits.join('; ')} (WG ${fmtG(exportHours.WG)}h + MH ${fmtG(exportHours.MH)}h this period` +
            (paidOt > 0 ? `; exports already pay ${fmtG(paidOt)}h OT, subtracted per store` : '') + ')';
        for (const loc of needLocs) {
            const hrs = missingOf[loc];
            const straightCents = cents(hrs * rateOf[loc]);
            const premiumCents = cents(hrs * rateOf[loc] * 0.5);
            const totalCents = straightCents + premiumCents;
            if ((Number(empOf[loc].reg_hours) || 0) >= hrs) {
                crossOps.push({ key, location: loc, hours: hrs, straight_cents: straightCents, premium_cents: premiumCents, total_cents: totalCents });
                checksByLoc[loc].push(check(`xot:topup:${key}:${loc}`, 'warn',
                    `${name}: ${fmtG(hrs)}h CROSS OT at ${loc} (+$${money2(premiumCents / 100)} over regular)`,
                    `Combined weeks put them over 40h: ${weekMath}. The over-40 hours worked at ${loc} pay ${loc}'s own rate — ` +
                    `${fmtG(hrs)}h moved from REGULAR to the CROSS OT column: $${money2(totalCents / 100)} ($${fmtG(rateOf[loc])} × 1.5).`));
            } else {
                // That store's check doesn't have the regular hours to move
                // (pathological) — exact premium as EXTRA PAY so the money
                // still lands.
                const note = `Cross-store OT premium: ${fmtG(hrs)}h at ${loc} ≈ $${money2(premiumCents / 100)}. ${weekMath}. ` +
                    `Shown as EXTRA PAY because the ${loc} check doesn't have ${fmtG(hrs)} regular hours to move to CROSS OT. ` +
                    `Straight time for these hours is already in regular pay — this is the missing ×0.5 premium only.`;
                extras.push({ type: 'xot_premium', key, location: loc, name, note, hours: hrs, rate: rateOf[loc], amount_cents: premiumCents });
                checksByLoc[loc].push(check(`xot:topup:${key}:${loc}`, 'warn',
                    `${name}: cross-store overtime added — $${money2(premiumCents / 100)}`, note));
            }
        }
    }

    const sig = [
        ...extras.map((x) => `${x.key}:${x.amount_cents}`),
        ...crossOps.map((r) => `${r.key}:x${r.total_cents}`),
    ].sort().join(',') || 'clean';
    return done(sig);
}
