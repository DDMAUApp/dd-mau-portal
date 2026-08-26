// Cross-location overtime reconciliation — synthetic fixtures. The canonical
// scenario is Andrew's own example (2026-08-26): "if yency works 40 hours a
// week at webster and that same week she worked 10 hours at dorsett it still
// gives her overtime."

import { describe, it, expect } from 'vitest';
import {
    computeCrossLocOt, applyOtReclass, parsePeriodRange, mondayKey, isMonday, periodDayCount,
} from '../crossLocOt';

// One-week Monday-start period. 2026-08-10 is a Monday.
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
    it('monday-start weeks', () => {
        expect(isMonday('2026-08-10')).toBe(true);
        expect(mondayKey('2026-08-10')).toBe('2026-08-10');
        expect(mondayKey('2026-08-16')).toBe('2026-08-10'); // Sunday belongs to the prior Monday
        expect(mondayKey('2026-08-17')).toBe('2026-08-17');
        expect(periodDayCount({ start: '2026-08-10', end: '2026-08-23' })).toBe(14);
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
        // Same-rate case shows as NORMAL OVERTIME: hours reclassified reg → OT
        // on the landing row (Andrew 2026-08-26), no EXTRA PAY line.
        expect(out.extras).toHaveLength(0);
        expect(out.reclass).toEqual([{ key: 'gz', location: 'WG', hours: 10 }]);
        const warn = out.checksByLoc.WG.find((k) => k.id === 'xot:topup:gz');
        expect(warn).toBeTruthy();
        expect(warn.level).toBe('warn');
        expect(warn.title).toMatch(/10h moved to the OT column/);
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
        expect(out.reclass).toEqual([{ key: 'gz', location: 'WG', hours: 5 }]); // net +$40
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
        expect(out.reclass).toEqual([{ key: 'gz', location: 'WG', hours: 10 }]); // week 1 only
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

    it('unparseable / non-Monday period → warn, no money', () => {
        const args = { ...base({ wgEmp: emp('Y G', 40, 0), mhEmp: emp('Y G', 10, 0) }), period: '8.11.26-8.24.26' };
        const out = computeCrossLocOt({ ...args, cards: ready({}) });
        expect(out.extras).toHaveLength(0);
        expect(out.checksByLoc.WG[0].id).toBe('xot:period');
    });

    it('different rates → FLSA weighted rate, disclosed', () => {
        const args = base({ wgEmp: emp('Yency Guzman', 40, 0), mhEmp: emp('Yency Guzman', 10, 0), wgRate: 16, mhRate: 20 });
        const cards = cardsFor('yency guzman', {
            '2026-08-10': ['WG', 8], '2026-08-11': ['WG', 8], '2026-08-12': ['WG', 8],
            '2026-08-13': ['WG', 8], '2026-08-14': ['WG', 8], '2026-08-15': ['MH', 10],
        });
        const out = computeCrossLocOt({ ...args, cards: ready({ 'yency guzman': cards }) });
        expect(out.reclass).toHaveLength(0); // differing rates can't reclassify exactly
        expect(out.extras).toHaveLength(1);
        // weighted: (40×16 + 10×20) / 50 = 16.8 → 10h × 16.8 × 0.5 = $84.00
        expect(out.extras[0].amount_cents).toBe(8400);
        expect(out.extras[0].note).toMatch(/different rates/);
        expect(out.extras[0].note).toMatch(/weighted/);
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
        expect(out.extras).toHaveLength(1);
        expect(out.extras[0].amount_cents).toBe(4200);
        expect(out.extras[0].hours).toBe(5);
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
        expect(out.reclass).toEqual([{ key: 'gz', location: 'WG', hours: 10 }]);
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

describe('applyOtReclass', () => {
    it('moves reg → OT on a CLONE, never mutating the original', () => {
        const employees = { WG: { gz: { toast_name: 'G, Y', reg_hours: 40, ot_hours: 0 } }, MH: {} };
        const out = applyOtReclass(employees, [{ key: 'gz', location: 'WG', hours: 10 }]);
        expect(out.WG.gz.reg_hours).toBe(30);
        expect(out.WG.gz.ot_hours).toBe(10);
        expect(out.WG.gz.xot_reclassified).toBe(10);
        expect(employees.WG.gz.reg_hours).toBe(40); // pristine
        expect(employees.WG.gz.ot_hours).toBe(0);
        expect(applyOtReclass(employees, [])).toBe(employees); // no-op identity
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

describe('reclass path through the engine (looks like normal OT)', () => {
    it('OT column carries the hours at rate ×1.5; total pay = reg-only + premium', () => {
        const masterData = {
            employees: [{ key: 'gz', first: 'Yency', last: 'Guzman', section: 'BOH', rate: 16, no_tip: false, direct_deposit: true }],
            salary: [], errors: [],
            by_key: { gz: { key: 'gz', first: 'Yency', last: 'Guzman', section: 'BOH', rate: 16, no_tip: false, direct_deposit: true } },
        };
        const toastEmps = { gz: { toast_name: 'Guzman, Yency', first: 'Yency', last: 'Guzman', reg_hours: 40, ot_hours: 0, toast_rate: 16, lines: [] } };
        const adjusted = applyOtReclass({ WG: toastEmps }, [{ key: 'gz', location: 'WG', hours: 10 }]).WG;
        const res = runLocation('WG', adjusted, masterData, 0, 0, 50, [], null);
        const row = res.sections.BOH.rows.find((r) => r.key === 'gz');
        expect(row.reg_hours).toBe(30);
        expect(row.ot_hours).toBe(10);
        expect(row.ot_cents).toBe(10 * 16 * 1.5 * 100);      // $240 in the OT money
        expect(row.comp_cents).toBe(30 * 16 * 100 + 24000);  // $480 + $240 = $720 = 40×16 + $80 premium
        expect(row.total_hours).toBe(40);                    // hours conserved
    });
});
