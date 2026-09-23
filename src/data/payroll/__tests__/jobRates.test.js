// Two positions at different pay rates (2026-09-22). End-to-end from a real
// Toast-shaped CSV through the roster adapter, the engine, cross-store OT and
// the workbook rows — plus the proof that single-rate people are untouched.
import { describe, it, expect } from 'vitest';
import { readPayrollExports } from '../toastParse';
import { asRateData, normalizeRoster, upsertPerson, buildRosterView, syncWithToast } from '../roster';
import { runLocation } from '../runLocation';
import { applyCrossOt } from '../crossLocOt';
import { resolveJobPay, jobPayAmounts, jobKey, jobsForPeople } from '../jobRates';
import { keyFromMaster } from '../names';

const HDR = 'Employee,Job Title,Regular Hours,Overtime Hours,Hourly Rate,Location';
const enc = (s) => new TextEncoder().encode(s);
async function parse(lines) {
    const out = await readPayrollExports([{ name: 'wg.csv', bytes: enc([HDR, ...lines].join('\n')) }], {});
    expect(out.errors).toEqual([]);
    return out.employees.WG;
}
const KEY = keyFromMaster('Rosa', 'Diaz');
const roster = (person = {}) => normalizeRoster({
    WG: { people: { [KEY]: { first: 'Rosa', last: 'Diaz', section: 'BOH', direct_deposit: true, ...person } }, salary: [] },
    MH: { people: {}, salary: [] },
});
async function run(lines, person, { cross } = {}) {
    let emps = await parse(lines);
    if (cross) emps = applyCrossOt({ WG: emps }, [cross]).WG;
    const md = asRateData(roster(person), 'WG', emps);
    const res = runLocation('WG', emps, md, 0, 0, 50, []);
    return { res, row: res.sections.BOH.rows[0], md, emps };
}
const LOC = 'Webster Groves';

describe('two jobs at different rates', () => {
    it("Andrew's example: 20h @ $15 + 20h @ $17 pays $640, in either Toast line order", async () => {
        for (const order of [[0, 1], [1, 0]]) {
            const lines = [`"Diaz, Rosa",Cashier,20,0,15,${LOC}`, `"Diaz, Rosa",Line Cook,20,0,17,${LOC}`];
            const { row, res } = await run(order.map((i) => lines[i]));
            expect(row.reg_cents).toBe(64000);
            expect(row.ot_cents).toBe(0);
            expect(row.multi_rate).toBe(true);
            expect(row.rate).toBe(16);                       // weighted average
            const k = res.checks.find((x) => x.id === `jobs:${KEY}`);
            expect(k.level).toBe('warn');
            expect(k.detail).toContain('Cashier: 20h reg + 0h OT @ $15.00');
            expect(k.detail).toContain('Regular pay $640.00');
            expect(res.checks.some((x) => x.id === `rate:${KEY}`)).toBe(false);   // no bogus "differs from Toast"
            expect(res.checks.some((x) => x.id === 'hours' && x.level === 'pass')).toBe(true);
        }
    });
    it('overtime: each OT hour at its job rate + ½ the weighted-average rate', async () => {
        // 30h @ $15 (0 OT) + 15h @ $18 (5 of them OT): straight = 450 + 270 = 720 over 45h → RR 16
        const { row } = await run([`"Diaz, Rosa",Cashier,30,0,15,${LOC}`, `"Diaz, Rosa",Line Cook,10,5,18,${LOC}`]);
        expect(row.reg_cents).toBe(30 * 1500 + 10 * 1800);           // $630
        expect(row.ot_cents).toBe(5 * 1800 + Math.round(0.5 * 16 * 5 * 100)); // $90 + $40
        // one-rate method would have paid 5 × 18 × 1.5 = $135; FLSA regular rate gives $130
    });
    it('a job LOCKED on the People step beats Toast for that job only', async () => {
        const { row, res } = await run([`"Diaz, Rosa",Cashier,20,0,15,${LOC}`, `"Diaz, Rosa",Line Cook,20,0,17,${LOC}`], { job_rates: { line_cook: 18 } });
        expect(row.reg_cents).toBe(20 * 1500 + 20 * 1800);
        expect(res.checks.find((x) => x.id === `jobrate:${KEY}:line_cook`).level).toBe('warn');
    });
    it('your locked master rate still wins over Toast job rates (no silent pay cut) — with a warning', async () => {
        // The real case: Toast listed Lead with NO rate and Cashier at a stale $12; her lock was $17.
        const { row, res } = await run([`"Diaz, Rosa",Lead,21.72,0,,${LOC}`, `"Diaz, Rosa",Cashier,37.11,0,12,${LOC}`], { rate_override: 17 });
        expect(row.multi_rate).toBe(false);
        expect(row.reg_cents).toBe(Math.round(58.83 * 17 * 100));
        const k = res.checks.find((x) => x.id === `joblock:${KEY}`);
        expect(k.level).toBe('warn');
        expect(k.detail).toContain('Lead no rate, Cashier $12.00');
        expect(res.checks.some((x) => x.level === 'fail')).toBe(false);
    });
    it('a per-job lock beats the master lock for that job; other jobs keep the master lock', async () => {
        const { row } = await run([`"Diaz, Rosa",Lead,20,0,,${LOC}`, `"Diaz, Rosa",Cashier,20,0,12,${LOC}`], { rate_override: 17, job_rates: { cashier: 15 } });
        expect(row.multi_rate).toBe(true);
        expect(row.reg_cents).toBe(20 * 1700 + 20 * 1500);
    });
    it('a worked job with NO rate anywhere hard-FAILS (cannot generate)', async () => {
        const { res } = await run([`"Diaz, Rosa",Cashier,20,0,15,${LOC}`, `"Diaz, Rosa",Line Cook,20,0,0,${LOC}`]);
        expect(res.checks.find((x) => x.id === `jobnorate:${KEY}:line_cook`).level).toBe('fail');
    });
    it('a job Toast priced at $0 falls back to the last known rate, with a warning', async () => {
        const { row, res } = await run([`"Diaz, Rosa",Cashier,20,0,15,${LOC}`, `"Diaz, Rosa",Line Cook,20,0,0,${LOC}`], { last_rate: 17 });
        expect(row.reg_cents).toBe(64000);
        expect(res.checks.find((x) => x.id === `jobzero:${KEY}:line_cook`).level).toBe('warn');
        expect(res.checks.some((x) => x.level === 'fail')).toBe(false);
    });
    it('cross-store OT moves hours out of regular at the weighted-average rate', async () => {
        const cross = { key: KEY, location: 'WG', hours: 4, total_cents: Math.round(4 * 16 * 100) + Math.round(4 * 16 * 0.5 * 100) };
        const { row, res } = await run([`"Diaz, Rosa",Cashier,20,0,15,${LOC}`, `"Diaz, Rosa",Line Cook,20,0,17,${LOC}`], {}, { cross });
        expect(row.reg_hours).toBe(36);
        expect(row.reg_cents).toBe(64000 - 4 * 1600);
        expect(row.xot_cents).toBe(9600);
        expect(res.checks.some((x) => x.id === 'hours' && x.level === 'pass')).toBe(true);
    });
});

describe('single-rate people are paid exactly as before', () => {
    it('one job', async () => {
        const { row, res } = await run([`"Diaz, Rosa",Cashier,38,2,15,${LOC}`]);
        expect(row.multi_rate).toBe(false);
        expect(row.reg_cents).toBe(38 * 1500);
        expect(row.ot_cents).toBe(2 * 2250);
        expect(res.checks.some((x) => x.id.startsWith('jobs:'))).toBe(false);
    });
    it('two jobs at the SAME rate: summed hours, old merge warning, person lock still honored, no lock warning', async () => {
        const { row, res } = await run([`"Diaz, Rosa",Cashier,20,0,15,${LOC}`, `"Diaz, Rosa",Prep,20,0,15,${LOC}`], { rate_override: 16 });
        expect(row.multi_rate).toBe(false);
        expect(row.reg_cents).toBe(40 * 1600);
        expect(res.checks.some((x) => x.id === `merge:${KEY}`)).toBe(true);
        expect(res.checks.some((x) => x.id === `joblock:${KEY}`)).toBe(false);
    });
    it('a job with no hours never makes someone multi-rate', async () => {
        const { row } = await run([`"Diaz, Rosa",Cashier,40,0,15,${LOC}`, `"Diaz, Rosa",Line Cook,0,0,17,${LOC}`]);
        expect(row.multi_rate).toBe(false);
        expect(row.reg_cents).toBe(40 * 1500);
    });
});

describe('helpers + People step', () => {
    it('jobKey is stable and Firestore-safe', () => {
        expect(jobKey('Line Cook')).toBe('line_cook');
        expect(jobKey('  Front/Counter. ')).toBe('front_counter');
        expect(jobKey('')).toBe('job');
    });
    it('upsertPerson locks and unlocks one job without touching the others', () => {
        const r = roster();
        upsertPerson(r, 'WG', KEY, { job_rates: { line_cook: 18, cashier: 15.5 } });
        upsertPerson(r, 'WG', KEY, { job_rates: { cashier: '' } });
        expect(r.WG.people[KEY].job_rates).toEqual({ line_cook: 18 });
        upsertPerson(r, 'WG', KEY, { job_rates: { line_cook: 0 } });
        expect(r.WG.people[KEY].job_rates).toBeUndefined();
    });
    it('buildRosterView exposes the jobs and whether they pay differently', async () => {
        const emps = await parse([`"Diaz, Rosa",Cashier,20,0,15,${LOC}`, `"Diaz, Rosa",Line Cook,20,0,17,${LOC}`]);
        const p = buildRosterView(roster(), { WG: emps, MH: {} }).WG.people[0];
        expect(p.jobs.map((j) => [j.key, j.hours, j.toast_rates])).toEqual([['cashier', 20, [15]], ['line_cook', 20, [17]]]);
        expect(p.job_pay).toBeTruthy();
    });
    it('garbage-tolerant', () => {
        expect(resolveJobPay(null, null)).toBeNull();
        expect(resolveJobPay({ lines: [] }, {})).toBeNull();
        expect(jobsForPeople(undefined)).toEqual([]);
        const jp = resolveJobPay({ lines: [{ job: 'A', reg_hours: 10, ot_hours: 0, rate: 10 }, { job: 'B', reg_hours: 10, ot_hours: 0, rate: 20 }] }, {});
        expect(jobPayAmounts(jp, 20, 0)).toEqual({ reg: 300, ot: 0, moved: 0 });
    });
});

describe('the roster remembers jobs between imports (People & DD page)', () => {
    it('an import stores last_jobs for a two-job person and clears it when they go back to one job', async () => {
        const r = roster();
        syncWithToast(r, 'WG', await parse([`"Diaz, Rosa",Lead,20,0,,${LOC}`, `"Diaz, Rosa",Cashier,20,0,12,${LOC}`]), '9.7.26-9.20.26', {});
        expect(r.WG.people[KEY].last_jobs).toEqual([{ key: 'lead', label: 'Lead', toast_rate: null }, { key: 'cashier', label: 'Cashier', toast_rate: 12 }]);
        const view = buildRosterView(r, { WG: {}, MH: {} }).WG.people[0];      // between imports
        expect(view.jobs.map((j) => [j.label, j.hours, j.toast_rates])).toEqual([['Lead', null, []], ['Cashier', null, [12]]]);
        syncWithToast(r, 'WG', await parse([`"Diaz, Rosa",Cashier,40,0,12,${LOC}`]), '9.21.26-10.4.26', {});
        expect(r.WG.people[KEY].last_jobs).toBeUndefined();
    });
});

describe('job detail text never shows float noise', () => {
    it('23.310000000000002h prints as 23.31h', async () => {
        const { res, row } = await run([`"Diaz, Rosa",FOH,23.310000000000002,0,15,${LOC}`, `"Diaz, Rosa",BOH,9.7,0,16,${LOC}`]);
        expect(row.merge_detail).toContain('FOH: 23.31h reg');
        expect(res.checks.find((x) => x.id === `jobs:${KEY}`).detail).not.toMatch(/\d\.\d{5,}/);
    });
});
