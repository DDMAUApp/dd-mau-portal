import { describe, it, expect } from 'vitest';
import { totalCents, fmtMoney, ALL_DENOMS, dollarsToCents, missingTipDays } from './moneyCount';

describe('moneyCount cents math', () => {
    it("Andrew's example: 34×1¢ + 14×$10 = $140.34", () => {
        expect(totalCents({ 1: 34, 1000: 14 })).toBe(14034);
        expect(fmtMoney(14034)).toBe('$140.34');
    });

    it('sums every denomination penny-exact', () => {
        const one = Object.fromEntries(ALL_DENOMS.map((d) => [d.cents, 1]));
        // 1+5+10+25+50 + 100+500+1000+2000+5000+10000 = 18691¢ = $186.91
        expect(totalCents(one)).toBe(18691);
        expect(fmtMoney(18691)).toBe('$186.91');
    });

    it('no float drift on many pennies', () => {
        expect(totalCents({ 1: 100 })).toBe(100);   // exactly $1.00, not 0.999…
        expect(fmtMoney(totalCents({ 1: 100 }))).toBe('$1.00');
    });

    it('floors / ignores bad counts (negative, NaN, fractional)', () => {
        expect(totalCents({ 100: -5 })).toBe(0);
        expect(totalCents({ 100: 'x' })).toBe(0);
        expect(totalCents({ 100: 2.9 })).toBe(200);   // 2 bills, fraction dropped
        expect(totalCents(null)).toBe(0);
        expect(totalCents({})).toBe(0);
    });

    it('formats thousands + zero pad', () => {
        expect(fmtMoney(0)).toBe('$0.00');
        expect(fmtMoney(5)).toBe('$0.05');
        expect(fmtMoney(123456)).toBe('$1,234.56');
        expect(fmtMoney(10000)).toBe('$100.00');
    });

    it('dollarsToCents parses tip input penny-exact', () => {
        expect(dollarsToCents('123.45')).toBe(12345);
        expect(dollarsToCents('$1,234')).toBe(123400);
        expect(dollarsToCents('5')).toBe(500);
        expect(dollarsToCents('5.')).toBe(500);
        expect(dollarsToCents('.5')).toBe(50);
        expect(dollarsToCents('0.09')).toBe(9);
        expect(dollarsToCents('12.999')).toBe(1299);   // caps at 2 decimals
        expect(dollarsToCents('')).toBe(0);
        expect(dollarsToCents(null)).toBe(0);
    });

    it('missingTipDays flags gaps but skips Sundays (closed)', () => {
        // Mon 2026-05-04 → Sun 2026-05-10. Present: 5/4, 5/6.
        // 5/10 is a Sunday → never flagged. Missing non-Sundays: 5/5,5/7,5/8,5/9.
        const present = new Set(['2026-05-04', '2026-05-06']);
        expect(missingTipDays('2026-05-04', '2026-05-10', present))
            .toEqual(['2026-05-05', '2026-05-07', '2026-05-08', '2026-05-09']);
    });
    it('missingTipDays: full coverage (minus Sunday) → none missing', () => {
        const present = new Set(['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-09']);
        expect(missingTipDays('2026-05-04', '2026-05-10', present)).toEqual([]);
    });
    it('missingTipDays: a lone Sunday range is empty', () => {
        expect(missingTipDays('2026-05-10', '2026-05-10', new Set())).toEqual([]);
    });
});
