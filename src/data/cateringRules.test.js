import { describe, it, expect } from 'vitest';
import { mergeSettings, parseTime, formatTime, dayKey, timeOptions, deliveryFeeFor, checkOrder, blackoutFor, DEFAULT_CATERING_SETTINGS } from './cateringRules';

const s = (over = {}) => mergeSettings(over);

describe('times', () => {
    it('reads both formats the app has saved', () => {
        expect(parseTime('11:30 AM')).toBe(690);
        expect(parseTime('12:15 PM')).toBe(735);
        expect(parseTime('12:00 AM')).toBe(0);
        expect(parseTime('13:30')).toBe(810);
        expect(parseTime('nope')).toBe(null);
        expect(formatTime(675)).toBe('11:15 AM');
    });
    it('knows the weekday of a date', () => {
        expect(dayKey('2026-11-07')).toBe('sat');
        expect(dayKey('2026-11-09')).toBe('mon');
    });
});

describe('settings', () => {
    it("defaults match the owner's example: weekday delivery from 11:15, Saturday 11:45", () => {
        const d = s();
        expect(d.windows.delivery.mon.earliest).toBe('11:15');
        expect(d.windows.delivery.sat.earliest).toBe('11:45');
    });
    it('a partly filled doc keeps the rest', () => {
        const d = s({ delivery: { minimumOrder: 150 }, windows: { delivery: { mon: { earliest: '12:00' } } } });
        expect(d.delivery.baseFee).toBe(15);
        expect(d.windows.delivery.mon).toEqual({ open: true, earliest: '12:00', latest: '19:00' });
        expect(d.windows.delivery.tue.earliest).toBe('11:15');
    });
});

describe('delivery windows on the picker', () => {
    it('shows a weekday window as 11:15–11:45 and marks it inside', () => {
        const o = timeOptions(s(), '2026-11-09', 'delivery').find(x => x.value === '11:15 AM');
        expect(o).toEqual({ value: '11:15 AM', label: '11:15 AM – 11:45 AM', inside: true });
    });
    it('Saturday 11:15 is outside, 11:45 inside', () => {
        const o = timeOptions(s(), '2026-11-07', 'delivery');
        expect(o.find(x => x.value === '11:15 AM').inside).toBe(false);
        expect(o.find(x => x.value === '11:45 AM').inside).toBe(true);
    });
    it('pickup times are single times', () => {
        expect(timeOptions(s(), '2026-11-09', 'pickup')[0].label).toBe('8:00 AM');
    });
});

describe('fees', () => {
    it('base fee plus each started mile past the included ones', () => {
        const d = s({ delivery: { baseFee: 15, includedMiles: 5, perMileOver: 2 } });
        expect(deliveryFeeFor(d, 4)).toBe(15);
        expect(deliveryFeeFor(d, 7.2)).toBe(21);
        expect(deliveryFeeFor(d, undefined)).toBe(15);
    });
});

describe('warnings', () => {
    const base = { date: '2026-11-09', time: '11:30 AM', orderType: 'delivery', location: 'webster', subtotal: 200, miles: 3 };
    it('a normal order has none', () => { expect(checkOrder(s(), base)).toEqual([]); });
    it('blackout days, for that store or both', () => {
        const d = s({ blackouts: [{ date: '2026-11-09', note: 'Thanksgiving prep', location: 'webster' }] });
        expect(checkOrder(d, base).map(x => x.kind)).toEqual(['blackout']);
        expect(checkOrder(d, base)[0].en).toMatch(/Thanksgiving prep/);
        expect(checkOrder(d, { ...base, location: 'maryland' })).toEqual([]);
        expect(blackoutFor(s({ blackouts: [{ date: '2026-11-09' }] }), '2026-11-09', 'maryland')).toBeTruthy();
    });
    it('too early, too late, closed days', () => {
        expect(checkOrder(s(), { ...base, time: '11:00 AM' }).map(x => x.kind)).toEqual(['tooEarly']);
        expect(checkOrder(s(), { ...base, time: '8:00 PM' }).map(x => x.kind)).toEqual(['tooLate']);
        const closed = s({ windows: { delivery: { mon: { open: false } } } });
        expect(checkOrder(closed, base).map(x => x.kind)).toEqual(['closedDay']);
    });
    it('under the minimum and too far, only once the owner sets them', () => {
        expect(checkOrder(s(), { ...base, subtotal: 10, miles: 99 })).toEqual([]);
        const d = s({ delivery: { minimumOrder: 150, maxMiles: 15 } });
        expect(checkOrder(d, { ...base, subtotal: 100, miles: 20 }).map(x => x.kind)).toEqual(['belowMinimum', 'tooFar']);
    });
    it('pickup ignores delivery rules', () => {
        const d = s({ delivery: { minimumOrder: 150, maxMiles: 15 } });
        expect(checkOrder(d, { ...base, orderType: 'pickup', subtotal: 10, miles: 99 })).toEqual([]);
    });
    it('defaults are unchanged by use', () => { expect(DEFAULT_CATERING_SETTINGS.blackouts).toEqual([]); });
});
