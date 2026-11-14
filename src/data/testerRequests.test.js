import { describe, it, expect, vi } from 'vitest';
vi.mock('../firebase', () => ({ db: {} }));
import { dedupeByEmail } from './testerRequests';

describe('dedupeByEmail', () => {
    it('keeps the first (newest) row per email, case-insensitive, skips blanks', () => {
        const rows = [
            { id: 'b', email: 'Ann@Gmail.com' },
            { id: 'a', email: 'ann@gmail.com ' },
            { id: 'c', email: '' },
            { id: 'd', email: 'bo@gmail.com' },
        ];
        expect(dedupeByEmail(rows).map((r) => r.id)).toEqual(['b', 'd']);
    });
    it('handles null', () => expect(dedupeByEmail(null)).toEqual([]));
});
