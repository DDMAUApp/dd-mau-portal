import { describe, it, expect } from 'vitest';
import { scaleIngredient, parseQuantity, formatQuantity, lineScales } from './recipeScale';

describe('parseQuantity', () => {
    it('parses the multiplier input formats', () => {
        expect(parseQuantity('2')).toBe(2);
        expect(parseQuantity('1/3')).toBeCloseTo(1 / 3);
        expect(parseQuantity('1 1/2')).toBe(1.5);
        expect(parseQuantity('½')).toBe(0.5);
        expect(parseQuantity('1½')).toBe(1.5);
        expect(parseQuantity('0.333')).toBeCloseTo(0.333);
        expect(parseQuantity('')).toBeNull();
        expect(parseQuantity('abc')).toBeNull();
        expect(parseQuantity('1/0')).toBeNull();
    });
});

describe('formatQuantity', () => {
    it('prefers integers, then unicode fractions, then one decimal', () => {
        expect(formatQuantity(4)).toBe('4');
        expect(formatQuantity(2.5)).toBe('2½');
        expect(formatQuantity(0.25)).toBe('¼');
        expect(formatQuantity(1 / 3)).toBe('⅓');
        expect(formatQuantity(1.7)).toBe('1.7');
    });
});

describe('scaleIngredient — quantities that MUST scale', () => {
    it('scales plain, decimal, fraction and mixed numbers', () => {
        expect(scaleIngredient('12 egg yolks', 5)).toBe('60 egg yolks');
        expect(scaleIngredient('¼ cup sugar', 5)).toBe('1¼ cup sugar');
        expect(scaleIngredient('1/4 cup baking powder', 2)).toBe('½ cup baking powder');
        expect(scaleIngredient('1 ½ cup whole green Szechuan peppercorn', 2)).toBe('3 cup whole green Szechuan peppercorn');
        expect(scaleIngredient('2½ cups pickled medley juice', 2)).toBe('5 cups pickled medley juice');
        expect(scaleIngredient('1.5 cups sesame oil', 2)).toBe('3 cups sesame oil');
        expect(scaleIngredient('5lb dried Thai chili', 0.5)).toBe('2½lb dried Thai chili');
    });
    it('scales every amount in the line, ranges included', () => {
        expect(scaleIngredient('1 gallon and 9 cups water', 2)).toBe('2 gallon and 18 cups water');
        expect(scaleIngredient('8–10 white onions (depending on size)', 2)).toBe('16–20 white onions (depending on size)');
        expect(scaleIngredient('16 oz white sugar (2½ cups)', 2)).toBe('32 oz white sugar (5 cups)');
        expect(scaleIngredient('2 cans (5 lb each) Lee Kum Kee Hoisin Sauce = 10 lb', 2))
            .toBe('4 cans (5 lb each) Lee Kum Kee Hoisin Sauce = 20 lb');
    });
    it('keeps the sub-bullet prefix', () => {
        expect(scaleIngredient('— ½ cup black pepper', 2)).toBe('— 1 cup black pepper');
        expect(scaleIngredient('— 1 TBSP black pepper', 3)).toBe('— 3 TBSP black pepper');
    });
    it('is a no-op at 1x and on non-strings', () => {
        expect(scaleIngredient('12 egg yolks', 1)).toBe('12 egg yolks');
        expect(scaleIngredient(undefined, 2)).toBe('');
        expect(scaleIngredient(null, 2)).toBe('');
    });
});

describe('scaleIngredient — numbers that must NOT scale', () => {
    it('leaves fixed container sizes and pack sizes alone', () => {
        expect(scaleIngredient('1 × 6-quart container', 2)).toBe('2 × 6-quart container');
        expect(scaleIngredient('Put sugar in 5-gallon buckets', 2)).toBe('Put sugar in 5-gallon buckets');
        expect(scaleIngredient('1 (2-quart) measuring cup', 3)).toBe('3 (2-quart) measuring cup');
        expect(scaleIngredient('2 cans (5 lb each)', 2)).toBe('4 cans (5 lb each)');
        expect(scaleIngredient('V8 juice', 2)).toBe('V8 juice');
    });
    it('leaves shelf life, timings and temperatures alone', () => {
        expect(scaleIngredient('16 qt bucket · lasts 3–7 days', 2)).toBe('32 qt bucket · lasts 3–7 days');
        expect(scaleIngredient('1 big bus tub · lasts 3–5 days · pickle 2 days first', 2))
            .toBe('2 big bus tub · lasts 3–5 days · pickle 2 days first');
        expect(scaleIngredient('Heat peanut butter in microwave for 3 minutes', 2))
            .toBe('Heat peanut butter in microwave for 3 minutes');
        expect(scaleIngredient('Fry at 350°F for 4 min', 2)).toBe('Fry at 350°F for 4 min');
        expect(scaleIngredient('Fry at 350 F', 2)).toBe('Fry at 350 F');
        expect(scaleIngredient('2 bags · lasts 1 day or less', 2)).toBe('4 bags · lasts 1 day or less');
        expect(scaleIngredient('dura 3–5 días', 2)).toBe('dura 3–5 días');
        expect(scaleIngredient('reposar 2 horas', 2)).toBe('reposar 2 horas');
        expect(scaleIngredient('Brewed concentrate (2½ gallons) · tea longer than 3 days = throw out', 2))
            .toBe('Brewed concentrate (5 gallons) · tea longer than 3 days = throw out');
    });
    it('leaves ×N batch annotations alone', () => {
        expect(scaleIngredient('BASE — 12 yolks · ×5 = production batch', 5)).toBe('BASE — 60 yolks · ×5 = production batch');
        expect(scaleIngredient('base 1 TBSP / 2x = 2 TBSP', 2)).toBe('base 2 TBSP / 2x = 4 TBSP');
        expect(scaleIngredient('2 × 2.5 lb bags 31/40 shrimp', 2)).toBe('4 × 2.5 lb bags 31/40 shrimp');
    });
    it('still scales after words that merely end in x', () => {
        expect(scaleIngredient('Mix 2 cups sugar with 1 cup water', 2)).toBe('Mix 4 cups sugar with 2 cup water');
        expect(scaleIngredient('Onions, approx 3 lb', 2)).toBe('Onions, approx 6 lb');
        expect(scaleIngredient('1 box 5 lb rice noodles', 2)).toBe('2 box 10 lb rice noodles');
    });
    it('protects "N to M minutes" ranges too', () => {
        expect(scaleIngredient('Boil 3 to 5 minutes', 2)).toBe('Boil 3 to 5 minutes');
        expect(scaleIngredient('2 to 3 lb ginger', 2)).toBe('4 to 6 lb ginger');
    });
    it('leaves shrimp count grades alone', () => {
        expect(scaleIngredient('Per 6 blocks of 21/25 shrimp', 2)).toBe('Per 12 blocks of 21/25 shrimp');
        expect(scaleIngredient('16/20 shrimp, 2 lb', 2)).toBe('16/20 shrimp, 4 lb');
    });
});

describe('lineScales', () => {
    it('tells lines with scalable amounts from lines without', () => {
        expect(lineScales('12 egg yolks')).toBe(true);
        expect(lineScales('lasts 3–7 days')).toBe(false);
        expect(lineScales('Cold water to top off')).toBe(false);
        expect(lineScales('')).toBe(false);
    });
});

// 2026-08-25 audit — parenthesized pack sizes and proportion fractions
// must not scale (verified live-bug shapes).
import { scaleIngredient as _si25 } from './recipeScale';
describe('pack-size and proportion guards (2026-08-25)', () => {
    it('does not scale a parenthesized pack size without "each"', () => {
        expect(_si25('1 (2 lb) bag noodles', 3)).toBe('3 (2 lb) bag noodles');
        expect(_si25('add 1 can (28 oz) tomatoes', 2)).toBe('add 2 can (28 oz) tomatoes');
    });
    it('still scales per-each pack counts correctly', () => {
        expect(_si25('2 cans (5 lb each)', 2)).toBe('4 cans (5 lb each)');
    });
    it('does not scale proportion fractions', () => {
        // "5-gallon" is a fixed container size (existing hyphen guard).
        expect(_si25('5-gallon bucket, fill 3/4 full', 2)).toBe('5-gallon bucket, fill 3/4 full');
        expect(_si25('fill ¾ of the way with water', 2)).toBe('fill ¾ of the way with water');
        expect(_si25('leave 1/2 empty', 3)).toBe('leave 1/2 empty');
    });
    it('still scales normal parenthesized yields', () => {
        // A number in parens NOT followed by unit+")" keeps scaling.
        expect(_si25('12 egg yolks', 5)).toBe('60 egg yolks');
    });
});
