import { describe, it, expect } from 'vitest';
import { taskDueOnDay, recurrenceLabelFor, cleanRecurrenceFields, normalizeRecurDays, normalizeRecurDates } from './checklistRecurrence';

describe('taskDueOnDay', () => {
    it('keeps every legacy preset working', () => {
        expect(taskDueOnDay({}, 3, '2026-08-19')).toBe(true);
        expect(taskDueOnDay({ recurrence: 'daily' }, 0, '2026-08-23')).toBe(true);
        expect(taskDueOnDay({ recurrence: 'weekday' }, 6, '2026-08-22')).toBe(false);
        expect(taskDueOnDay({ recurrence: 'weekend' }, 6, '2026-08-22')).toBe(true);
        expect(taskDueOnDay({ recurrence: 'monday' }, 1, '2026-08-17')).toBe(true);
        expect(taskDueOnDay({ recurrence: 'monday' }, 2, '2026-08-18')).toBe(false);
        expect(taskDueOnDay({ recurrence: 'bogus' }, 2, '2026-08-18')).toBe(true); // unknown → daily
    });
    it('days = several weekdays', () => {
        const t = { recurrence: 'days', recurDays: [1, 3, 5] };
        expect(taskDueOnDay(t, 1, '2026-08-17')).toBe(true);
        expect(taskDueOnDay(t, 2, '2026-08-18')).toBe(false);
        expect(taskDueOnDay(t, 5, '2026-08-21')).toBe(true);
        expect(taskDueOnDay({ recurrence: 'days', recurDays: ['3', 9, -1] }, 3, '2026-08-19')).toBe(true);
        expect(taskDueOnDay({ recurrence: 'days' }, 3, '2026-08-19')).toBe(false);
    });
    it('dates = specific calendar days', () => {
        const t = { recurrence: 'dates', recurDates: ['2026-08-19', '2026-09-01'] };
        expect(taskDueOnDay(t, 3, '2026-08-19')).toBe(true);
        expect(taskDueOnDay(t, 4, '2026-08-20')).toBe(false);
        expect(taskDueOnDay(t, 2, '2026-09-01')).toBe(true);
        expect(taskDueOnDay(t, 2, undefined)).toBe(false);
    });
});

describe('labels + cleanup', () => {
    it('labels presets and custom sets', () => {
        expect(recurrenceLabelFor({ recurrence: 'weekday' }, 'en')).toBe('Weekdays');
        expect(recurrenceLabelFor({ recurrence: 'days', recurDays: [1, 2, 3, 4, 5] }, 'es')).toBe('Lunes-Viernes');
        expect(recurrenceLabelFor({ recurrence: 'days', recurDays: [1, 4] }, 'en')).toBe('Mon · Thu');
        expect(recurrenceLabelFor({ recurrence: 'dates', recurDates: ['2026-08-19', '2026-08-25'] }, 'en')).toBe('8/19, 8/25');
        expect(recurrenceLabelFor({ recurrence: 'dates', recurDates: ['2026-08-19', '2026-08-25', '2026-08-26', '2026-08-27'] }, 'en')).toBe('8/19, 8/25 +2');
    });
    it('cleanRecurrenceFields drops stale companions', () => {
        expect(cleanRecurrenceFields({ id: 'a', recurrence: 'monday', recurDays: [1], recurDates: ['2026-08-19'] })).toEqual({ id: 'a', recurrence: 'monday' });
        expect(cleanRecurrenceFields({ id: 'a', recurrence: 'daily', recurDays: [1] })).toEqual({ id: 'a' });
        expect(cleanRecurrenceFields({ id: 'a', recurrence: 'days', recurDays: [1] })).toEqual({ id: 'a', recurrence: 'days', recurDays: [1] });
        expect(normalizeRecurDays([5, 1, 1, 7])).toEqual([1, 5]);
        expect(normalizeRecurDates(['2026-08-20', '2026-08-19', 'nope', '2026-08-19'])).toEqual(['2026-08-19', '2026-08-20']);
    });
});
