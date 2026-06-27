import { describe, it, expect } from 'vitest';
import { totalCents, fmtMoney, ALL_DENOMS } from './moneyCount';

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
});
