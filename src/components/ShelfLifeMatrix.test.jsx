// "Set all (days)" in the shelf-life table (2026-09-23 review). It used to
// write the number into every row but keep each row's unit, so an
// hour-clocked item (Sanitizer 4h, COOLING 6h) became N HOURS. Hour rows
// are now skipped — a bulk DAYS value must never land on them.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn(), getDoc: vi.fn(), setDoc: vi.fn(), onSnapshot: vi.fn(() => () => {}),
    runTransaction: vi.fn(), serverTimestamp: vi.fn(), deleteField: vi.fn(),
}));
vi.mock('../data/audit', () => ({ recordAudit: vi.fn() }));

import { applySetAllDays } from './ShelfLifeMatrix';

const ROWS = [
    { id: 'r1', nameEn: 'Chicken', shelfLifeDays: 3 },
    { id: 'r2', nameEn: 'Rice' },
    { id: 's1', nameEn: 'Sanitizer', shelfLifeHours: 4 },
];

describe('applySetAllDays', () => {
    it('fills every DAY-clock row and skips hour-clock rows', () => {
        const next = applySetAllDays({}, 'sec', ROWS, 5);
        expect(next).toEqual({ 'sec:r1': '5', 'sec:r2': '5' });
        expect('sec:s1' in next).toBe(false);
    });

    it('follows pending unit edits (switched-to-hours skipped, switched-to-days included)', () => {
        const edits = { 'sec:r2:u': 'h', 'sec:s1:u': 'd' };
        const next = applySetAllDays(edits, 'sec', ROWS, 7);
        expect(next['sec:r1']).toBe('7');
        expect(next['sec:r2']).toBeUndefined();
        expect(next['sec:s1']).toBe('7');
        // never touches the unit keys themselves
        expect(next['sec:r2:u']).toBe('h');
        expect(next['sec:s1:u']).toBe('d');
    });

    it('keeps other edits and does not mutate its input', () => {
        const edits = Object.freeze({ 'other:x': '2', 'sec:s1': '6' });
        const next = applySetAllDays(edits, 'sec', ROWS, 4);
        expect(next['other:x']).toBe('2');
        expect(next['sec:s1']).toBe('6');   // hour row's own edit untouched
        expect(edits).toEqual({ 'other:x': '2', 'sec:s1': '6' });
    });

    it('tolerates an empty section', () => {
        expect(applySetAllDays({ a: '1' }, 'sec', undefined, 3)).toEqual({ a: '1' });
    });
});
