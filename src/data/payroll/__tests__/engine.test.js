// Payroll engine regression tests — synthetic fixtures (fake names), hand-
// verified golden cents. Mirrors the standalone app's app/tests/test_engine.py
// and test_added_hours.py so the JS port is locked to the same behaviour. The
// real-data byte-for-byte parity check against the Python engine lives in the
// local-only parity harness (not committed — it touches real names + pay).

import { describe, it, expect } from 'vitest';
import { cRound, c, round2 } from '../cents';
import { keyFromToast, keyFromMaster } from '../names';
import { validate, describe as describeExtra } from '../extras';
import { splitPools, allocatePool, runLocation } from '../runLocation';
import { asRateData, normalizeRoster } from '../roster';

// ───────────────────────────── cents / rounding ─────────────────────────────
describe('cents rounding (CPython-faithful)', () => {
    it('rounds half to EVEN like Python round()', () => {
        expect(cRound(0.5)).toBe(0);
        expect(cRound(1.5)).toBe(2);
        expect(cRound(2.5)).toBe(2);
        expect(cRound(3.5)).toBe(4);
        expect(cRound(-0.5)).toBe(0);
        expect(cRound(-1.5)).toBe(-2);
        expect(cRound(-2.5)).toBe(-2);
    });
    it('c() converts dollars to integer cents', () => {
        expect(c(15)).toBe(1500);
        expect(c(17 * 1.5 * 0.5)).toBe(1275);
        expect(c(0)).toBe(0);
        expect(c(-400)).toBe(-40000);
    });
    it('round2 cleans float noise', () => {
        expect(round2(33.33 + 2.0)).toBe(35.33);
        expect(round2(0.1 + 0.2)).toBe(0.3);
    });
});

// ───────────────────────────── names ─────────────────────────────
describe('toast name matching', () => {
    it('matches "Last, First" to first/last regardless of spacing/case', () => {
        expect(keyFromToast('Chandler , Marley')).toBe(keyFromMaster('MARLEY', 'CHANDLER'));
        expect(keyFromToast('cruz, Marcos', { 'Cruz, Marcos': 'Cruz, Marco' }))
            .toBe(keyFromMaster('Marco', 'Cruz'));
        expect(keyFromToast('Cruz-Hernandez, Edgar', { 'Cruz-Hernandez, Edgar': 'Cruz, Edgar' }))
            .toBe(keyFromMaster('EDGAR', 'CRUZ'));
    });
});

// ───────────────────────────── tips math ─────────────────────────────
describe('tip pool math', () => {
    it('pool split always sums to the total', () => {
        for (const total of [0, 1, 999999, 1151925]) {
            for (const pct of [50, 33.3, 70]) {
                const [foh, boh] = splitPools(total, pct);
                expect(foh + boh).toBe(total);
            }
        }
    });
    it('largest-remainder allocation is penny-exact', () => {
        const shares = allocatePool(500000, [33.33, 33.33, 33.34]);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(500000);
        expect(shares).toEqual([166650, 166650, 166700]);
        const awkward = allocatePool(100003, [1, 1, 1]);
        expect(awkward.reduce((a, b) => a + b, 0)).toBe(100003);
        expect(Math.max(...awkward) - Math.min(...awkward)).toBeLessThanOrEqual(1);
    });
    it('handles zero hours', () => {
        expect(allocatePool(10000, [])).toEqual([]);
        expect(allocatePool(10000, [0, 0])).toEqual([0, 0]);
    });
    it('Andrew example: $5000 over 100 FOH hours → $50/hr', () => {
        expect(allocatePool(500000, [60, 40])).toEqual([300000, 200000]);
    });
});

// ───────────────────────────── extras ─────────────────────────────
const MKEY = keyFromMaster('ANA', 'TEST');
const MASTER_BY_KEY = {
    [MKEY]: {
        first: 'ANA', last: 'TEST', rate: 15.0, section: 'FOH',
        no_tip: false, direct_deposit: true, legal_first: '', legal_last: '',
        legal_name: '', note: '', key: MKEY,
    },
};

describe('extras validation', () => {
    it('back pay for a missed raise', () => {
        const [x, err] = validate({ type: 'backpay', key: MKEY, location: 'WG', hours: 34, per_hour: 1 }, MASTER_BY_KEY);
        expect(err).toBeNull();
        expect(x.amount_cents).toBe(3400);
    });
    it('advance is negative and requires a note', () => {
        let [x, err] = validate({ type: 'advance', key: MKEY, location: 'WG', amount: 400 }, MASTER_BY_KEY);
        expect(x).toBeNull();
        expect(err).toContain('note');
        [x, err] = validate({ type: 'advance', key: MKEY, location: 'WG', amount: 400, note: 'check #1042' }, MASTER_BY_KEY);
        expect(err).toBeNull();
        expect(x.amount_cents).toBe(-40000);
    });
    it('vacation uses base rate', () => {
        const [x, err] = validate({ type: 'vacation', key: MKEY, location: 'WG', hours: 8 }, MASTER_BY_KEY);
        expect(err).toBeNull();
        expect(x.amount_cents).toBe(8 * 15 * 100);
    });
    it('reg_hours @ base rate, ot_hours @ 1.5x', () => {
        const [reg, e1] = validate({ type: 'reg_hours', key: MKEY, location: 'WG', hours: 3 }, MASTER_BY_KEY);
        expect(e1).toBeNull();
        expect(reg.amount_cents).toBe(4500); // 3 * $15.00
        expect(describeExtra(reg)).toContain('reg hrs');
        const [ot, e2] = validate({ type: 'ot_hours', key: MKEY, location: 'WG', hours: 2 }, MASTER_BY_KEY);
        expect(e2).toBeNull();
        expect(ot.amount_cents).toBe(4500); // 2 * $15.00 * 1.5
        expect(describeExtra(ot)).toContain('x1.5');
    });
    it('rejects an extra for an unknown person', () => {
        const [x, err] = validate({ type: 'bonus', key: 'nobody', location: 'WG', amount: 50 }, MASTER_BY_KEY);
        expect(x).toBeNull();
        expect(err).toContain('unknown person');
    });
});

// ───────────────────────────── run_location ─────────────────────────────
function emp(first, last, rate, section, noTip = false) {
    return {
        first, last, rate, section, no_tip: noTip, direct_deposit: false,
        legal_first: '', legal_last: '', legal_name: '', note: '',
        key: keyFromMaster(first, last), row: 0,
    };
}
function masterData() {
    const employees = [
        emp('AMY', 'FOH1', 15, 'FOH'), emp('BEN', 'FOH2', 16, 'FOH'),
        emp('CAL', 'BOH1', 17, 'BOH'), emp('DEE', 'NOTIP', 20, 'BOH', true),
    ];
    const salary = [emp('SAL', 'OWNER', 3000, 'SALARY')];
    const byKey = {};
    for (const e of [...employees, ...salary]) byKey[e.key] = e;
    return { employees, salary, by_key: byKey, errors: [] };
}
function toastEmps(pairs) {
    const out = {};
    for (const [first, last, reg, ot] of pairs) {
        const k = keyFromMaster(first, last);
        out[k] = {
            toast_name: `${last}, ${first}`, first, last, reg_hours: reg, ot_hours: ot,
            toast_rate: 15.0, lines: [{ job: 'x', reg_hours: reg, ot_hours: ot, rate: 15.0 }], multi_line: false,
        };
    }
    return out;
}

describe('runLocation invariants', () => {
    it('full run: tips penny-exact, OT at 1.5x, unknown→review, hours reconcile, salary out of pool', () => {
        const t = toastEmps([
            ['AMY', 'FOH1', 60, 0], ['BEN', 'FOH2', 40, 2],
            ['CAL', 'BOH1', 50, 0], ['DEE', 'NOTIP', 30, 0],
            ['ZED', 'UNKNOWN', 12.5, 0],
        ]);
        const res = runLocation('WG', t, masterData(), 400000, 100000, 50, []);
        const foh = res.sections.FOH;
        expect(foh.pool_cents).toBe(250000);
        const amy = foh.rows.find((r) => r.first === 'AMY');
        const ben = foh.rows.find((r) => r.first === 'BEN');
        expect(amy.tip_cents + ben.tip_cents).toBe(250000);
        const boh = res.sections.BOH;
        const cal = boh.rows.find((r) => r.first === 'CAL');
        const dee = boh.rows.find((r) => r.first === 'DEE');
        expect(cal.tip_cents).toBe(250000);
        expect(dee.tip_cents).toBe(0);
        expect(ben.ot_cents).toBe(cRound(16 * 1.5 * 2 * 100));
        expect(res.review.length).toBe(1);
        expect(res.review[0].total_hours).toBe(12.5);
        expect(res.checks.some((k) => k.id.startsWith('unknown:') && k.level === 'warn')).toBe(true);
        expect(res.checks.find((k) => k.id === 'hours').level).toBe('pass');
        expect(res.salary[0].amount_cents).toBe(300000);
    });

    it('advance bigger than pay → negative-paycheck fail', () => {
        const t = toastEmps([['AMY', 'FOH1', 10, 0]]);
        const extra = { type: 'advance', key: keyFromMaster('AMY', 'FOH1'), location: 'WG', name: 'AMY FOH1', amount_cents: -100000, note: 'big check' };
        const res = runLocation('WG', t, masterData(), 0, 0, 50, [extra]);
        expect(res.checks.some((k) => k.id.startsWith('negcomp:') && k.level === 'fail')).toBe(true);
    });

    it('extra for a person with no hours creates a zero-hour row, hours still reconcile', () => {
        const t = toastEmps([['AMY', 'FOH1', 10, 0]]);
        const extra = { type: 'vacation', key: keyFromMaster('BEN', 'FOH2'), location: 'WG', name: 'BEN FOH2', hours: 8, rate: 16.0, amount_cents: 12800, note: '' };
        const res = runLocation('WG', t, masterData(), 0, 0, 50, [extra]);
        const ben = res.sections.FOH.rows.find((r) => r.first === 'BEN');
        expect(ben.vac_cents).toBe(12800);
        expect(ben.comp_cents).toBe(12800);
        expect(res.checks.find((k) => k.id === 'hours').level).toBe('pass');
    });

    it('rate drift vs Toast is flagged', () => {
        const t = toastEmps([['AMY', 'FOH1', 10, 0]]);
        t[keyFromMaster('AMY', 'FOH1')].toast_rate = 14.0; // master says 15
        const res = runLocation('WG', t, masterData(), 0, 0, 50, []);
        expect(res.checks.some((k) => k.id.startsWith('rate:'))).toBe(true);
    });

    it('added reg/OT hours go to EXTRA PAY, not the tip pool', () => {
        const e = emp('A', 'One', 20.0, 'BOH');
        const md = { employees: [e], salary: [], by_key: { [e.key]: e }, errors: [] };
        const t = {
            [e.key]: { toast_name: 'One, A', first: 'A', last: 'One', toast_rate: 20.0, reg_hours: 40.0, ot_hours: 0.0, multi_line: false, lines: [] },
        };
        const reg = validate({ type: 'reg_hours', key: e.key, hours: 3 }, md.by_key)[0];
        const ot = validate({ type: 'ot_hours', key: e.key, hours: 2 }, md.by_key)[0];
        const res = runLocation('WG', t, md, c(1000.0), 0, 0.0, [{ ...reg, location: 'WG' }, { ...ot, location: 'WG' }]);
        const row = ['FOH', 'BOH'].flatMap((s) => res.sections[s].rows).find((r) => r.key === e.key);
        expect(row.reg_hours).toBe(40.0);
        expect(row.ot_hours).toBe(0.0);
        expect(row.extra_cents).toBe(12000); // 3*20 + 2*20*1.5
        const alloc = ['FOH', 'BOH'].flatMap((s) => res.sections[s].rows).reduce((a, r) => a + r.tip_cents, 0);
        expect(alloc).toBe(res.tips.total_cents);
        expect(res.checks.filter((k) => k.level === 'fail').length).toBe(0);
    });
});

// ───────────────────── audit hardening (2026-06-30) ─────────────────────
// Locks in the fixes from the payroll correctness audit so they can't regress.
describe('allocatePool conserves for ANY pool sign', () => {
    it('positive pools are unchanged (floor === trunc when exact ≥ 0)', () => {
        expect(allocatePool(500000, [33.33, 33.33, 33.34])).toEqual([166650, 166650, 166700]);
        expect(allocatePool(100003, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100003);
        expect(allocatePool(1, [1, 0, 0])).toEqual([1, 0, 0]);
    });
    it('negative pools (refunded tips) still sum EXACTLY to the pool', () => {
        for (const pool of [-1, -7, -52749, -100000]) {
            for (const w of [[1, 1, 1], [0, 0, 5.49, 67.12], [3, 1, 1]]) {
                expect(allocatePool(pool, w).reduce((a, b) => a + b, 0)).toBe(pool);
            }
        }
    });
});

describe('splitPools clamps FOH% to [0,100]', () => {
    it('always returns two pools summing to the total, even out of range', () => {
        for (const pct of [-20, 0, 50, 100, 150, NaN]) {
            const [foh, boh] = splitPools(100000, pct);
            expect(foh + boh).toBe(100000);
            expect(foh).toBeGreaterThanOrEqual(0);
            expect(boh).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('asRateData always yields a finite rate (no NaN paychecks)', () => {
    const mkRoster = (person) => normalizeRoster({ WG: { people: { k1: { key: 'k1', first: 'A', last: 'B', section: 'FOH', ...person } }, salary: [] }, MH: { people: {}, salary: [] } });
    it('a non-numeric last_rate coerces to 0 (then runLocation will FAIL it), never NaN', () => {
        const rd = asRateData(mkRoster({ last_rate: 'oops' }), 'WG', {});
        expect(rd.employees[0].rate).toBe(0);
        expect(Number.isFinite(rd.employees[0].rate)).toBe(true);
    });
    it('a rate_override of 0 is ignored — pays the Toast rate (display-vs-pay parity)', () => {
        const rd = asRateData(mkRoster({ rate_override: 0, last_rate: 12 }), 'WG', { k1: { toast_rate: 15 } });
        expect(rd.employees[0].rate).toBe(15);
    });
    it('a NaN rate_override does not produce a NaN paycheck', () => {
        const rd = asRateData(mkRoster({ rate_override: NaN, last_rate: 14 }), 'WG', {});
        expect(rd.employees[0].rate).toBe(14);
    });
    it('a real positive override wins over Toast', () => {
        const rd = asRateData(mkRoster({ rate_override: 20, last_rate: 12 }), 'WG', { k1: { toast_rate: 15 } });
        expect(rd.employees[0].rate).toBe(20);
    });
});

describe('runLocation hard-FAILS a worked person with a $0 / missing rate', () => {
    it('zero rate + hours worked → fail check, not a silent $0 paycheck', () => {
        const e = { first: 'Z', last: 'ERO', rate: 0, section: 'FOH', no_tip: false, direct_deposit: false, legal_first: '', legal_last: '', legal_name: '', note: '', key: keyFromMaster('Z', 'ERO'), row: 0 };
        const md = { employees: [e], salary: [], by_key: { [e.key]: e }, errors: [] };
        const t = { [e.key]: { toast_name: 'ERO, Z', first: 'Z', last: 'ERO', toast_rate: 0, reg_hours: 30, ot_hours: 0, multi_line: false, lines: [] } };
        const res = runLocation('WG', t, md, 0, 0, 50, []);
        expect(res.checks.some((k) => k.id.startsWith('zerorate:') && k.level === 'fail')).toBe(true);
    });
});

describe('runLocation FAILS when two different names merge into one key', () => {
    it('name_conflict from a bad alias is a hard fail', () => {
        const e = emp('AMY', 'FOH1', 15, 'FOH');
        const md = { employees: [e], salary: [], by_key: { [e.key]: e }, errors: [] };
        const t = { [e.key]: { toast_name: 'FOH1, AMY', first: 'AMY', last: 'FOH1', toast_rate: 15, reg_hours: 20, ot_hours: 0, multi_line: true, lines: [], name_conflict: true, merged_names: ['FOH1, AMY', 'OTHER, PERSON'] } };
        const res = runLocation('WG', t, md, 0, 0, 50, []);
        expect(res.checks.some((k) => k.id.startsWith('namemerge:') && k.level === 'fail')).toBe(true);
    });
});
