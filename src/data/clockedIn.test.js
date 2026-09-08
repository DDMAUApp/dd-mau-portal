import { describe, it, expect } from 'vitest';
import { earlierSessionsFor, isSaneSessionForDate, MAX_SESSION_HOURS } from './clockedIn';

const todayCT = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

// Build an ISO stamp on today's Central date at the given CT hour.
function todayAt(hourCT, minute = 0) {
    const [y, m, d] = todayCT.split('-').map(Number);
    // Probe noon UTC to learn the Central offset for this date.
    const probe = new Date(Date.UTC(y, m - 1, d, 12, 0));
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' }).formatToParts(probe);
    const off = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
    const mm = off.match(/GMT([+-]\d+)/);
    const offsetH = mm ? Number(mm[1]) : -5;
    return new Date(Date.UTC(y, m - 1, d, hourCT - offsetH, minute)).toISOString().replace('Z', '+0000');
}

describe('isSaneSessionForDate', () => {
    it('accepts a normal same-day session', () => {
        expect(isSaneSessionForDate({ clockIn: todayAt(10), clockOut: todayAt(14, 30) }, todayCT)).toBe(true);
    });
    it('rejects a session that started on another day (weekend outage fabrication)', () => {
        const sat = '2026-09-05T15:37:04.381+0000';
        const tue = '2026-09-08T14:49:17.725+0000';
        expect(isSaneSessionForDate({ clockIn: sat, clockOut: tue }, '2026-09-08')).toBe(false);
    });
    it('rejects negative / zero spans (clocked-out-entry inference bug)', () => {
        expect(isSaneSessionForDate({ clockIn: todayAt(14, 45), clockOut: todayAt(10, 5) }, todayCT)).toBe(false);
        expect(isSaneSessionForDate({ clockIn: todayAt(10), clockOut: todayAt(10) }, todayCT)).toBe(false);
    });
    it('rejects spans over MAX_SESSION_HOURS and missing clockOut', () => {
        expect(MAX_SESSION_HOURS).toBe(16);
        expect(isSaneSessionForDate({ clockIn: '2026-09-05T15:37:04.381+0000', clockOut: '2026-09-06T15:37:04.381+0000' }, '2026-09-05')).toBe(false);
        expect(isSaneSessionForDate({ clockIn: todayAt(10), clockOut: null }, todayCT)).toBe(false);
    });
    it('parses the Toast "+0000" offset form', () => {
        expect(isSaneSessionForDate({ clockIn: todayAt(9), clockOut: todayAt(11) }, todayCT)).toBe(true);
    });
});

describe('earlierSessionsFor', () => {
    const id = 'emp-1';
    it('returns [] for another day\'s doc', () => {
        expect(earlierSessionsFor({ date: '2000-01-01', employees: { [id]: { sessions: [{ clockIn: todayAt(9), clockOut: todayAt(10) }] } } }, id)).toEqual([]);
    });
    it('filters out cross-day and negative sessions but keeps sane ones', () => {
        const good = { clockIn: todayAt(9), clockOut: todayAt(12) };
        const doc = {
            date: todayCT,
            employees: { [id]: { sessions: [
                { clockIn: '2026-09-05T15:37:04.381+0000', clockOut: todayAt(9, 49) }, // Saturday → today
                { clockIn: todayAt(14, 45), clockOut: todayAt(10, 5) },              // negative
                good,
            ] } },
        };
        expect(earlierSessionsFor(doc, id)).toEqual([good]);
    });
    it('handles missing employee / malformed docs', () => {
        expect(earlierSessionsFor(null, id)).toEqual([]);
        expect(earlierSessionsFor({ date: todayCT }, id)).toEqual([]);
        expect(earlierSessionsFor({ date: todayCT, employees: { [id]: { sessions: 'nope' } } }, id)).toEqual([]);
    });
});
