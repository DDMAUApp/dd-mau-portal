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

describe('the date is always shown', () => {
    it('renders who, the date, and the time for a count made today', () => {
        const meta = { by: 'Andrew', at: '9:15 AM', atISO: '2026-07-31T14:15:00.000Z' };
        expect(formatCountStamp(meta, NOW)).toBe('Andrew — Jul 31, 9:15 AM');
    });

    it('dates a count from earlier the same Chicago day', () => {
        const meta = { by: 'Blanca', at: '6:05 AM', atISO: '2026-07-31T11:05:00.000Z' };
        expect(formatCountTime(meta, NOW)).toBe('Jul 31, 6:05 AM');
    });
});

describe('older counts carry their own date — the misleading case', () => {
    it('dates a count made two days ago', () => {
        const meta = { by: 'Andrew', at: '3:45 PM', atISO: '2026-07-29T20:45:00.000Z' };
        expect(formatCountStamp(meta, NOW)).toBe('Andrew — Jul 29, 3:45 PM');
    });

    it('uses the CHICAGO day, not the UTC one, for a late-night count', () => {
        // 2026-07-30 23:30 Chicago = 2026-07-31 04:30Z. Naive UTC-date math
        // would stamp this "Jul 31" — the wrong business day.
        const meta = { by: 'Isa', at: '11:30 PM', atISO: '2026-07-31T04:30:00.000Z' };
        expect(formatCountTime(meta, NOW)).toBe('Jul 30, 11:30 PM');
    });

    it('keeps a very-early-morning Chicago count on the correct day', () => {
        // 2026-07-31 00:30 Chicago = 05:30Z same date.
        const meta = { by: 'Isa', at: '12:30 AM', atISO: '2026-07-31T05:30:00.000Z' };
        expect(formatCountTime(meta, NOW)).toBe('Jul 31, 12:30 AM');
    });
});

describe('legacy rows written before atISO existed', () => {
    it('shows the bare time — there is no stored date to show', () => {
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

// ── Multiple counters on one item (2026-07-31) ─────────────────────────
import { formatCountStampLines, listContributors, staffKey } from './inventoryStamp';

const who = (rows) => ({ who: Object.fromEntries(rows.map(r => [staffKey(r.n), r])) });

describe('multiple people counting the same item', () => {
    it('lists every contributor with their own qty and time, oldest first', () => {
        const meta = who([
            { n: 'Blanca', q: 1, t: '2026-07-31T21:10:00.000Z' },
            { n: 'Andrew', q: 2, t: '2026-07-31T20:45:00.000Z' },
        ]);
        expect(formatCountStampLines(meta, NOW)).toBe(
            'Andrew 2 — Jul 31, 3:45 PM\nBlanca 1 — Jul 31, 4:10 PM',
        );
    });

    it('keeps a single counter on one line', () => {
        const meta = who([{ n: 'Andrew', q: 3, t: '2026-07-31T20:45:00.000Z' }]);
        expect(formatCountStampLines(meta, NOW)).toBe('Andrew 3 — Jul 31, 3:45 PM');
    });

    it('shows a NEGATIVE tally — the evidence for "who removed this?"', () => {
        const meta = who([
            { n: 'Andrew', q: 2, t: '2026-07-31T20:45:00.000Z' },
            { n: 'Blanca', q: -2, t: '2026-07-31T21:10:00.000Z' },
        ]);
        expect(formatCountStampLines(meta, NOW)).toBe(
            'Andrew 2 — Jul 31, 3:45 PM\nBlanca \u{2212}2 — Jul 31, 4:10 PM',
        );
    });

    it('drops a net-zero contributor (added then removed the same amount)', () => {
        const meta = who([
            { n: 'Andrew', q: 2, t: '2026-07-31T20:45:00.000Z' },
            { n: 'Blanca', q: 0, t: '2026-07-31T21:10:00.000Z' },
        ]);
        expect(formatCountStampLines(meta, NOW)).toBe('Andrew 2 — Jul 31, 3:45 PM');
    });
});

describe('legacy items still render', () => {
    it('falls back to the single by/at stamp with no qty', () => {
        const meta = { by: 'Andrew', at: '3:45 PM', atISO: '2026-07-31T20:45:00.000Z' };
        expect(formatCountStampLines(meta, NOW)).toBe('Andrew — Jul 31, 3:45 PM');
    });

    it('falls back when `who` exists but every entry is unusable', () => {
        const meta = {
            by: 'Andrew', at: '3:45 PM', atISO: '2026-07-31T20:45:00.000Z',
            who: { andrew: { n: 'Andrew', q: 0, t: '2026-07-31T20:45:00.000Z' } },
        };
        expect(formatCountStampLines(meta, NOW)).toBe('Andrew — Jul 31, 3:45 PM');
    });

    it('returns empty when there is nothing at all', () => {
        expect(formatCountStampLines(null, NOW)).toBe('');
        expect(formatCountStampLines({}, NOW)).toBe('');
        expect(listContributors(null, NOW)).toEqual([]);
    });
});

describe('staffKey — names are not safe as raw Firestore map keys', () => {
    it('strips dots, which would otherwise nest the path', () => {
        expect(staffKey('Andres Portillo Mo.')).toBe('andres_portillo_mo');
    });

    it('is stable across casing and spacing', () => {
        expect(staffKey('  Andrew  Shih ')).toBe(staffKey('andrew shih'));
    });

    it('never returns an empty key', () => {
        expect(staffKey('')).toBe('unknown');
        expect(staffKey('...')).toBe('unknown');
        expect(staffKey(null)).toBe('unknown');
    });
});
