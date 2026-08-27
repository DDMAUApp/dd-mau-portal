// Cross-location overtime reconciliation — synthetic fixtures. The canonical
// scenario is Andrew's own example (2026-08-26): "if yency works 40 hours a
// week at webster and that same week she worked 10 hours at dorsett it still
// gives her overtime."

import { describe, it, expect } from 'vitest';
import {
    computeCrossLocOt, applyCrossOt, parsePeriodRange, sundayKey, saturdayOf, clockFetchRange, periodDayCount,
} from '../crossLocOt';

// One-week-ish period. 2026-08-10 is a Monday; weeks run SUN–SAT, so this
// period's days all fall in the week of Sun 2026-08-09 (Sat 8/15 settles it)
// except Sun 8/16, whose week settles next period.
const PERIOD = '8.10.26-8.16.26';

function emp(name, reg, ot, rate = 16) {
    return { toast_name: name, reg_hours: reg, ot_hours: ot, toast_rate: rate };
}
function master(first, last, rate = 16) {
    return { first, last, section: 'BOH', rate };
}
// Spread `spec` = { 'YYYY-MM-DD': [locCode, hours] } into card rows.
function cardsFor(name, spec) {
    return Object.entries(spec).map(([date, [loc, hours]], i) => ({
        id: `${loc}|${date}|${i}`, date, hours,
        location: loc === 'WG' ? 'webster' : 'maryland',
        staffKey: name.toLowerCase(),
    }));
}
const ready = (byKey) => ({ ready: true, byKey });

function base({ wgEmp, mhEmp, wgRate = 16, mhRate = 16 }) {
    return {
        period: PERIOD,
        employees: { WG: { 'gz': wgEmp }, MH: { 'gz': mhEmp } },
        masters: {
            WG: { by_key: { 'gz': master('Yency', 'Guzman', wgRate) } },
            MH: { by_key: { 'gz': master('Yency', 'Guzman', mhRate) } },
        },
    };
}

describe('period parsing / week math', () => {
    it('parses the panel period label', () => {
        expect(parsePeriodRange('8.10.26-8.23.26')).toEqual({ start: '2026-08-10', end: '2026-08-23' });
        expect(parsePeriodRange('12.29.25-1.11.26')).toEqual({ start: '2025-12-29', end: '2026-01-11' });
        expect(parsePeriodRange('8.10-8.23')).toBeNull();
        expect(parsePeriodRange('')).toBeNull();
    });
    it('sunday–saturday weeks (owner-confirmed)', () => {
        expect(sundayKey('2026-08-09')).toBe('2026-08-09');  // Sunday starts its own week
        expect(sundayKey('2026-08-10')).toBe('2026-08-09');  // Monday belongs to the prior Sunday
        expect(sundayKey('2026-08-15')).toBe('2026-08-09');  // Saturday ends that week
        expect(sundayKey('2026-08-16')).toBe('2026-08-16');  // next Sunday = new week
        expect(saturdayOf('2026-08-10')).toBe('2026-08-15');
        expect(periodDayCount({ start: '2026-08-10', end: '2026-08-23' })).toBe(14);
        // Monday-start pay period → fetch window extends back to Sunday.
        expect(clockFetchRange({ start: '2026-08-10', end: '2026-08-23' }))
            .toEqual({ start: '2026-08-09', end: '2026-08-23' });
    });
});

describe('computeCrossLocOt', () => {
    it("Andrew's canonical case: 40h WG + 10h MH in one week → 10h × rate × 0.5 premium", () => {
        const args = base({ wgEmp: emp('Yency Guzman', 40, 0), mhEmp: emp('Yency Guzman', 10, 0) });
        const cards = cardsFor('yency guzman', {
            '2026-08-10': ['WG', 8], '2026-08-11': ['WG', 8], '2026-08-12': ['WG', 8],
            '2026-08-13': ['WG', 8], '2026-08-14': ['WG', 8],
            '2026-08-15': ['MH', 10],
        });
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        // Chronological attribution (Andrew's example verbatim): the over-40
        // hours are Saturday's 10h at MH → CROSS OT on the MH check at MH's
        // rate. No EXTRA PAY line, Toast OT untouched.
        expect(out.extras).toHaveLength(0);
        expect(out.crossOps).toEqual([{ key: 'gz', location: 'MH', hours: 10, straight_cents: 16000, premium_cents: 8000, total_cents: 24000 }]);
        const warn = out.checksByLoc.MH.find((k) => k.id === 'xot:topup:gz:MH');
        expect(warn).toBeTruthy();
        expect(warn.level).toBe('warn');
        expect(warn.title).toMatch(/10h CROSS OT at MH/);
        expect(warn.detail).toMatch(/50h combined → 10h OT/);
    });

    it('no combined OT → no extras, no checks', () => {
        const args = base({ wgEmp: emp('Yency Guzman', 20, 0), mhEmp: emp('Yency Guzman', 10, 0) });
        const cards = cardsFor('yency guzman', {
            '2026-08-10': ['WG', 10], '2026-08-11': ['WG', 10], '2026-08-12': ['MH', 10],
        });
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        expect(out.extras).toHaveLength(0);
        expect(out.checksByLoc.WG).toHaveLength(0);
        expect(out.checksByLoc.MH).toHaveLength(0);
    });

    it('OT Toast already paid is subtracted (single-store 45h + other-store 5h)', () => {
        // WG export: 40 reg + 5 OT (Toast saw the 45h itself). MH adds 5h.
        // Combined week = 50h → owes 10h; already paid 5h → top-up 5h only.
        const args = base({ wgEmp: emp('Yency Guzman', 40, 5), mhEmp: emp('Yency Guzman', 5, 0) });
        const cards = cardsFor('yency guzman', {
            '2026-08-10': ['WG', 9], '2026-08-11': ['WG', 9], '2026-08-12': ['WG', 9],
            '2026-08-13': ['WG', 9], '2026-08-14': ['WG', 9],
            '2026-08-15': ['MH', 5],
        });
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        expect(out.extras).toHaveLength(0);
        // Chronological: Friday's last 5h (WG) + Saturday's 5h (MH) are the
        // over-40 span; WG's export already pays its 5h → only MH's 5h remain.
        expect(out.crossOps).toEqual([{ key: 'gz', location: 'MH', hours: 5, straight_cents: 8000, premium_cents: 4000, total_cents: 12000 }]);
    });

    it('two-week period: each Toast week stands alone', () => {
        // Week 1: 40 WG + 10 MH → 10h OT. Week 2: 20 WG only → none.
        const args = {
            period: '8.10.26-8.23.26',
            employees: { WG: { gz: emp('Yency Guzman', 60, 0) }, MH: { gz: emp('Yency Guzman', 10, 0) } },
            masters: base({ wgEmp: null, mhEmp: null }).masters,
        };
        const cards = cardsFor('yency guzman', {
            '2026-08-10': ['WG', 8], '2026-08-11': ['WG', 8], '2026-08-12': ['WG', 8],
            '2026-08-13': ['WG', 8], '2026-08-14': ['WG', 8], '2026-08-15': ['MH', 10],
            '2026-08-17': ['WG', 10], '2026-08-18': ['WG', 10],
        });
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        expect(out.extras).toHaveLength(0);
        expect(out.crossOps).toEqual([{ key: 'gz', location: 'MH', hours: 10, straight_cents: 16000, premium_cents: 8000, total_cents: 24000 }]); // week 1 only, Saturday at MH
    });

    it('clock/export mismatch → warn, NO money added', () => {
        const args = base({ wgEmp: emp('Yency Guzman', 40, 0), mhEmp: emp('Yency Guzman', 10, 0) });
        const cards = cardsFor('yency guzman', { '2026-08-10': ['WG', 8] }); // scraper missed days
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        expect(out.extras).toHaveLength(0);
        const warn = out.checksByLoc.WG.find((k) => k.id === 'xot:mismatch:gz');
        expect(warn).toBeTruthy();
        expect(warn.level).toBe('warn');
    });

    it('cards still loading → FAIL check (blocks generation), no money', () => {
        const args = base({ wgEmp: emp('Yency Guzman', 40, 0), mhEmp: emp('Yency Guzman', 10, 0) });
        const out = computeCrossLocOt({ ...args, cards: null });
        expect(out.extras).toHaveLength(0);
        expect(out.checksByLoc.WG[0].level).toBe('fail');
        expect(out.checksByLoc.MH[0].level).toBe('fail');
    });

    it('unparseable period → warn, no money', () => {
        const args = { ...base({ wgEmp: emp('Y G', 40, 0), mhEmp: emp('Y G', 10, 0) }), period: '8.10-8.23' };
        const out = computeCrossLocOt({ ...args, cards: ready({}) });
        expect(out.extras).toHaveLength(0);
        expect(out.crossOps).toHaveLength(0);
        expect(out.checksByLoc.WG[0].id).toBe('xot:period');
    });

    it('a leading SUNDAY (prior to the Monday period start) counts into week 1', () => {
        // Sun 8/9: 4h MH + Mon–Fri 8h×5 WG = 44h in the week of 8/9 → 4h OT,
        // even though the Sunday itself belongs to the previous pay period.
        const args = base({ wgEmp: emp('Yency Guzman', 40, 0), mhEmp: emp('Yency Guzman', 0, 0) });
        args.employees.MH.gz = emp('Yency Guzman', 0, 0); // no in-period MH hours
        const cards = cardsFor('yency guzman', {
            '2026-08-09': ['MH', 4],
            '2026-08-10': ['WG', 8], '2026-08-11': ['WG', 8], '2026-08-12': ['WG', 8],
            '2026-08-13': ['WG', 8], '2026-08-14': ['WG', 8],
        });
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        expect(out.crossOps).toHaveLength(1);
        // Chronological: the Sunday came FIRST, so the over-40 span is the
        // END of Friday's WG shift → 4h at WG's rate on the WG check.
        expect(out.crossOps[0].location).toBe('WG');
        expect(out.crossOps[0].hours).toBe(4);
        expect(out.crossOps[0].total_cents).toBe(4 * 16 * 1.5 * 100); // $96
    });

    it('a trailing partial week (Saturday after period end) settles NEXT period', () => {
        // Period ends Sun 8/16; hours on 8/16 belong to the week of Sun 8/16
        // (Saturday 8/22 > period end) → excluded from THIS run's weekly
        // math, but still counted in the clock/export reconciliation.
        const args = base({ wgEmp: emp('Yency Guzman', 40, 0), mhEmp: emp('Yency Guzman', 10, 0) });
        args.employees.MH.gz = emp('Yency Guzman', 20, 0); // 10 Sat + 10 Sun 8/16
        const cards = cardsFor('yency guzman', {
            '2026-08-10': ['WG', 8], '2026-08-11': ['WG', 8], '2026-08-12': ['WG', 8],
            '2026-08-13': ['WG', 8], '2026-08-14': ['WG', 8],
            '2026-08-15': ['MH', 10], '2026-08-16': ['MH', 10],
        });
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        // Only week of 8/9 settles: 40 WG + 10 MH (Sat) = 50h → 10h OT,
        // chronologically the Saturday MH hours.
        expect(out.crossOps).toHaveLength(1);
        expect(out.crossOps[0].location).toBe('MH');
        expect(out.crossOps[0].hours).toBe(10);
    });

    it('different rates → FLSA weighted rate, disclosed', () => {
        const args = base({ wgEmp: emp('Yency Guzman', 40, 0), mhEmp: emp('Yency Guzman', 10, 0), wgRate: 16, mhRate: 20 });
        const cards = cardsFor('yency guzman', {
            '2026-08-10': ['WG', 8], '2026-08-11': ['WG', 8], '2026-08-12': ['WG', 8],
            '2026-08-13': ['WG', 8], '2026-08-14': ['WG', 8], '2026-08-15': ['MH', 10],
        });
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        // Owner's rule: the over-40 hours are Saturday's at MH → they pay
        // MH's $20 rate on the MH check. 10h × $20 × 1.5 = $300.
        expect(out.extras).toHaveLength(0);
        expect(out.crossOps).toEqual([{ key: 'gz', location: 'MH', hours: 10, straight_cents: 20000, premium_cents: 10000, total_cents: 30000 }]);
        const warn = out.checksByLoc.MH.find((k) => k.id === 'xot:topup:gz:MH');
        expect(warn.detail).toMatch(/pay MH's own rate/);
    });

    it("verifier's example: differing rates WITH already-paid OT nets in dollars", () => {
        // WG export 40reg+5ot @$16; MH 5reg @$20. Week: 45h WG + 5h MH = 50h.
        // Owed: 10h @ weighted (45×16+5×20)/50 = $16.40 → $82.00 premium.
        // Paid: 5h × $16 × 0.5 = $40.00. Missing = $42.00 (hour-netting at a
        // blended rate said $41 — the review's $1-short case).
        const args = base({ wgEmp: emp('Yency Guzman', 40, 5), mhEmp: emp('Yency Guzman', 5, 0), wgRate: 16, mhRate: 20 });
        const cards = cardsFor('yency guzman', {
            '2026-08-10': ['WG', 9], '2026-08-11': ['WG', 9], '2026-08-12': ['WG', 9],
            '2026-08-13': ['WG', 9], '2026-08-14': ['WG', 9], '2026-08-15': ['MH', 5],
        });
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        expect(out.extras).toHaveLength(0);
        // Chronological: WG's Friday excess (5h) is covered by WG's paid OT;
        // Saturday's 5h at MH pays MH's $20: 5h × $20 × 1.5 = $150.
        expect(out.crossOps).toEqual([{ key: 'gz', location: 'MH', hours: 5, straight_cents: 10000, premium_cents: 5000, total_cents: 15000 }]);
    });

    it('real Toast "Last, First" export names still find the clock data', () => {
        // /timecards keys are normName("First Last"); the raw export name is
        // "Last, First" — the module must key off parsed first/last (a raw-
        // name key found zero cards and silently warn-skipped everyone;
        // caught by the 2026-08-26 synthetic end-to-end).
        const mk = (reg, ot) => ({ toast_name: 'Guzman, Yency', first: 'Yency', last: 'Guzman', reg_hours: reg, ot_hours: ot, toast_rate: 16 });
        const args = base({ wgEmp: mk(40, 0), mhEmp: mk(10, 0) });
        const cards = cardsFor('yency guzman', {
            '2026-08-10': ['WG', 8], '2026-08-11': ['WG', 8], '2026-08-12': ['WG', 8],
            '2026-08-13': ['WG', 8], '2026-08-14': ['WG', 8], '2026-08-15': ['MH', 10],
        });
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        expect(out.crossOps).toEqual([{ key: 'gz', location: 'MH', hours: 10, straight_cents: 16000, premium_cents: 8000, total_cents: 24000 }]);
    });

    it('a day straddling the 40h mark splits, and same-day two-store cards order by first clock-in', () => {
        // Sun–Thu WG 7h×5 = 35h; Friday: MH 3h (morning) then WG 4h (evening).
        // Cumulative: 35 → MH takes 38 → WG takes 42. Over-40 span = last 2h
        // of the WG evening shift → 2h CROSS OT at WG only.
        // Exports cover PERIOD days only (Mon 8/10+): WG 28h Mon–Thu + 4h
        // Fri evening = 32h; MH 3h Fri morning. The leading Sunday (8/9,
        // prior period) still counts toward the WEEK's 40h threshold.
        const args = base({ wgEmp: emp('Yency Guzman', 32, 0), mhEmp: emp('Yency Guzman', 3, 0) });
        const cards = [
            ...cardsFor('yency guzman', {
                '2026-08-09': ['WG', 7], '2026-08-10': ['WG', 7], '2026-08-11': ['WG', 7],
                '2026-08-12': ['WG', 7], '2026-08-13': ['WG', 7],
            }),
            { id: 'fri-mh', date: '2026-08-14', location: 'maryland', hours: 3, staffKey: 'yency guzman', firstIn: '2026-08-14T14:00:00.000Z' },
            { id: 'fri-wg', date: '2026-08-14', location: 'webster', hours: 4, staffKey: 'yency guzman', firstIn: '2026-08-14T22:00:00.000Z' },
        ];
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        expect(out.crossOps).toEqual([{ key: 'gz', location: 'WG', hours: 2, straight_cents: 3200, premium_cents: 1600, total_cents: 4800 }]);
    });

    it('salaried at either store → warn, never computes (crash guard)', () => {
        const args = base({ wgEmp: emp('Sal A', 40, 0), mhEmp: emp('Sal A', 10, 0) });
        args.masters.MH.by_key.gz.section = 'SALARY';
        args.masters.MH.by_key.gz.rate = 1500; // per-period salary dollars
        const out = computeCrossLocOt({ ...args, cards: ready({}) });
        expect(out.extras).toHaveLength(0);
        const warn = out.checksByLoc.WG.find((k) => k.id === 'xot:salary:gz');
        expect(warn).toBeTruthy();
    });

    it('nobody on both exports → completely inert', () => {
        const out = computeCrossLocOt({
            period: PERIOD,
            employees: { WG: { a: emp('A', 40, 0) }, MH: { b: emp('B', 10, 0) } },
            masters: { WG: { by_key: {} }, MH: { by_key: {} } },
            cards: null,
        });
        expect(out.extras).toHaveLength(0);
        expect(out.checksByLoc.WG).toHaveLength(0);
        expect(out.sig).toBe('none');
    });
});

describe('applyCrossOt', () => {
    it('moves reg → CROSS OT on a CLONE, never mutating the original', () => {
        const employees = { WG: { gz: { toast_name: 'G, Y', reg_hours: 40, ot_hours: 0 } }, MH: {} };
        const out = applyCrossOt(employees, [{ key: 'gz', location: 'WG', hours: 10, total_cents: 24000 }]);
        expect(out.WG.gz.reg_hours).toBe(30);
        expect(out.WG.gz.ot_hours).toBe(0);       // Toast's OT column untouched
        expect(out.WG.gz.xot_hours).toBe(10);
        expect(out.WG.gz.xot_cents).toBe(24000);
        expect(employees.WG.gz.reg_hours).toBe(40); // pristine
        expect(applyCrossOt(employees, [])).toBe(employees); // no-op identity
    });
});

// End-to-end: an xot_premium extra flows through runLocation onto the row.
import { runLocation } from '../runLocation';
describe('xot_premium through the engine', () => {
    it('lands in extra_cents with a readable description', () => {
        const masterData = {
            employees: [{ key: 'gz', first: 'Yency', last: 'Guzman', section: 'BOH', rate: 16, no_tip: false, direct_deposit: true }],
            salary: [], errors: [],
            by_key: { gz: { key: 'gz', first: 'Yency', last: 'Guzman', section: 'BOH', rate: 16, no_tip: false, direct_deposit: true } },
        };
        const toastEmps = { gz: { toast_name: 'Yency Guzman', first: 'Yency', last: 'Guzman', reg_hours: 40, ot_hours: 0, toast_rate: 16, lines: [] } };
        const extra = { type: 'xot_premium', key: 'gz', location: 'WG', name: 'Yency Guzman', note: 'test', hours: 10, rate: 16, amount_cents: 8000 };
        const res = runLocation('WG', toastEmps, masterData, 0, 0, 50, [extra], null);
        const row = res.sections.BOH.rows.find((r) => r.key === 'gz');
        expect(row.extra_cents).toBe(8000);
        expect(row.comp_cents).toBe(16 * 40 * 100 + 8000); // reg + premium
        expect(row.extras[0]).toMatch(/cross-store OT premium 10h @ \$16x0\.5 = \+\$80\.00/);
    });
});

// validate() must reject a user-entered xot_premium (auto-generated only —
// a fall-through returned no amount_cents → NaN pay; review 2026-08-26 #6).
import { validate as validateExtra } from '../extras';
describe('xot_premium is not user-enterable', () => {
    it('validate() rejects it', () => {
        const byKey = { gz: { first: 'Y', last: 'G', rate: 16, section: 'BOH' } };
        const [x, err] = validateExtra({ type: 'xot_premium', key: 'gz', location: 'WG', name: 'Y G' }, byKey);
        expect(x).toBeNull();
        expect(err).toMatch(/auto-generated/);
    });
});

describe('CROSS OT through the engine', () => {
    it('dedicated column carries hours + pay; total = reg-only + premium; Toast OT untouched', () => {
        const masterData = {
            employees: [{ key: 'gz', first: 'Yency', last: 'Guzman', section: 'BOH', rate: 16, no_tip: false, direct_deposit: true }],
            salary: [], errors: [],
            by_key: { gz: { key: 'gz', first: 'Yency', last: 'Guzman', section: 'BOH', rate: 16, no_tip: false, direct_deposit: true } },
        };
        const toastEmps = { gz: { toast_name: 'Guzman, Yency', first: 'Yency', last: 'Guzman', reg_hours: 40, ot_hours: 0, toast_rate: 16, lines: [] } };
        const adjusted = applyCrossOt({ WG: toastEmps }, [{ key: 'gz', location: 'WG', hours: 10, total_cents: 24000 }]).WG;
        const res = runLocation('WG', adjusted, masterData, 0, 0, 50, [], null);
        const row = res.sections.BOH.rows.find((r) => r.key === 'gz');
        expect(row.reg_hours).toBe(30);
        expect(row.ot_hours).toBe(0);                        // Toast's OT column untouched
        expect(row.xot_hours).toBe(10);
        expect(row.xot_cents).toBe(24000);                   // straight $160 + premium $80
        expect(row.comp_cents).toBe(30 * 16 * 100 + 24000);  // $720 = 40×16 + $80 premium
        expect(row.total_hours).toBe(40);                    // hours conserved
        expect(res.sections.BOH.totals.xot_cents).toBe(24000);
        const passCheck = res.checks.find((k) => k.id === 'hours');
        expect(passCheck.level).toBe('pass');                // reconciliation counts CROSS OT hours
    });
});
