// Tests for the inventory count stamp (Andrew 2026-07-31: "i want my name and
// timestamp to show up under the - count window and +").
//
// The load-bearing case is the stale-day one: a cart builds across days, and a
// bare "3:45 PM" on a count made two days ago reads as today on a sheet
// someone is ordering from.
//
// Every assertion pins America/Chicago explicitly, so these pass regardless of
// the machine's timezone.

import { describe, it, expect } from 'vitest';
import { formatCountStamp, formatCountTime } from './inventoryStamp';

// 2026-07-31 14:45 Chicago (CDT = UTC-5) → 19:45Z
const NOW = new Date('2026-07-31T19:45:00.000Z');

describe('same-day counts show just the time', () => {
    it('renders who and the time', () => {
        const meta = { by: 'Andrew', at: '9:15 AM', atISO: '2026-07-31T14:15:00.000Z' };
        expect(formatCountStamp(meta, NOW)).toBe('Andrew — 9:15 AM');
    });

    it('does not date-qualify a count from earlier the same Chicago day', () => {
        const meta = { by: 'Blanca', at: '6:05 AM', atISO: '2026-07-31T11:05:00.000Z' };
        expect(formatCountTime(meta, NOW)).toBe('6:05 AM');
    });
});

describe('older counts are date-qualified — the misleading case', () => {
    it('adds the date for a count made two days ago', () => {
        const meta = { by: 'Andrew', at: '3:45 PM', atISO: '2026-07-29T20:45:00.000Z' };
        expect(formatCountStamp(meta, NOW)).toBe('Andrew — Jul 29, 3:45 PM');
    });

    it('treats late-night Chicago yesterday as a different day', () => {
        // 2026-07-30 23:30 Chicago = 2026-07-31 04:30Z. Naive UTC-date math
        // would call this "today" and drop the date.
        const meta = { by: 'Isa', at: '11:30 PM', atISO: '2026-07-31T04:30:00.000Z' };
        expect(formatCountTime(meta, NOW)).toBe('Jul 30, 11:30 PM');
    });

    it('treats very early Chicago today as today', () => {
        // 2026-07-31 00:30 Chicago = 05:30Z same date — genuinely today.
        const meta = { by: 'Isa', at: '12:30 AM', atISO: '2026-07-31T05:30:00.000Z' };
        expect(formatCountTime(meta, NOW)).toBe('12:30 AM');
    });
});

describe('legacy rows written before atISO existed', () => {
    it('falls back to the stored time string unchanged', () => {
        expect(formatCountStamp({ by: 'Andrew', at: '3:45 PM' }, NOW)).toBe('Andrew — 3:45 PM');
    });

    it('falls back when atISO is unparseable', () => {
        const meta = { by: 'Andrew', at: '3:45 PM', atISO: 'not-a-date' };
        expect(formatCountStamp(meta, NOW)).toBe('Andrew — 3:45 PM');
    });
});

describe('degenerate input never renders a broken line', () => {
    it('returns empty for no meta at all', () => {
        expect(formatCountStamp(null, NOW)).toBe('');
        expect(formatCountStamp(undefined, NOW)).toBe('');
        expect(formatCountStamp({}, NOW)).toBe('');
    });

    it('shows just the name when there is no time', () => {
        expect(formatCountStamp({ by: 'Andrew' }, NOW)).toBe('Andrew');
    });

    it('shows just the time when there is no name', () => {
        expect(formatCountStamp({ at: '3:45 PM' }, NOW)).toBe('3:45 PM');
    });

    it('ignores whitespace-only names', () => {
        expect(formatCountStamp({ by: '   ', at: '3:45 PM' }, NOW)).toBe('3:45 PM');
    });
});
