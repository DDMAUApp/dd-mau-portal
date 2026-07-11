// applyRosterMutation — the pure core every roster write goes through
// (2026-07-11 roster-write protocol). These tests pin the central
// invariants that prevent the rename-revert / Emma Castro incident
// class: no write can produce duplicate names/ids/PINs, an invalid
// PIN, an empty name, or an empty list; diffs are exact; no-ops skip.
import { describe, it, expect } from 'vitest';
import { applyRosterMutation, nextStaffRev, noteStaffSnapshot, STAFF_DOC } from '../staffDoc';

const person = (id, name, pin, extra = {}) => ({ id, name, pin, ...extra });
const DATA = {
    rev: 7,
    list: [
        person(1, 'Andrew Shih', '1111', { role: 'Owner' }),
        person(2, 'Emma Castro', '2222', { role: 'FOH', shiftLead: true }),
        person(3, 'Julio Turcios', '3333', { role: 'BOH' }),
    ],
};

describe('applyRosterMutation', () => {
    it('applies a single-record patch and diffs exactly one change', () => {
        const out = applyRosterMutation(DATA, list =>
            list.map(s => s.id === 2 ? { ...s, role: 'Shift Lead' } : s));
        expect(out.noop).toBe(false);
        expect(out.list).toHaveLength(3);
        expect(out.changed).toHaveLength(1);
        expect(out.changed[0].before.role).toBe('FOH');
        expect(out.changed[0].after.role).toBe('Shift Lead');
        // untouched records keep identity
        expect(out.list[0]).toBe(DATA.list[0]);
    });

    it('returns noop when the mutator returns null', () => {
        const out = applyRosterMutation(DATA, () => null);
        expect(out.noop).toBe(true);
        expect(out.list).toBe(DATA.list);
    });

    it('returns noop when the mutator changes nothing (same references)', () => {
        const out = applyRosterMutation(DATA, list => list.map(s => s));
        expect(out.noop).toBe(true);
    });

    it('diffs an added record with before:null', () => {
        const out = applyRosterMutation(DATA, list => [...list, person(4, 'New Hire', '4444')]);
        expect(out.changed).toEqual([{ before: null, after: expect.objectContaining({ name: 'New Hire' }) }]);
    });

    it('diffs a removed record with after:null', () => {
        const out = applyRosterMutation(DATA, list => list.filter(s => s.id !== 3));
        expect(out.changed).toEqual([{ before: expect.objectContaining({ name: 'Julio Turcios' }), after: null }]);
    });

    it('passes result through from {list, result} form', () => {
        const out = applyRosterMutation(DATA, list => ({
            list: list.filter(s => s.id !== 3),
            result: { removedName: 'Julio Turcios' },
        }));
        expect(out.result).toEqual({ removedName: 'Julio Turcios' });
    });

    it('rejects an EMPTY list — the roster can never be wiped', () => {
        expect(() => applyRosterMutation(DATA, () => [])).toThrowError(/empty_list/);
    });

    it('rejects duplicate names case-insensitively (identity-collapse guard)', () => {
        expect(() => applyRosterMutation(DATA, list => [...list, person(4, 'emma castro', '4444')]))
            .toThrowError(/name_exists/);
    });

    it('rejects duplicate ids', () => {
        expect(() => applyRosterMutation(DATA, list => [...list, person(2, 'Someone Else', '4444')]))
            .toThrowError(/dup_id/);
    });

    it('rejects duplicate PINs (PIN is the whole auth mechanism)', () => {
        expect(() => applyRosterMutation(DATA, list => [...list, person(4, 'Someone Else', '2222')]))
            .toThrowError(/dup_pin/);
    });

    it('rejects invalid PINs on changed records, naming the offender', () => {
        let detail = null;
        try {
            applyRosterMutation(DATA, list => list.map(s => s.id === 2 ? { ...s, pin: '' } : s));
        } catch (e) { detail = e.detail; expect(e.code).toBe('invalid_pin'); }
        expect(detail).toBe('Emma Castro');
    });

    it('rejects empty names', () => {
        expect(() => applyRosterMutation(DATA, list => list.map(s => s.id === 2 ? { ...s, name: '  ' } : s)))
            .toThrowError(/empty_name/);
    });

    it('rejects a record with a missing id', () => {
        expect(() => applyRosterMutation(DATA, list => [...list, { name: 'No Id', pin: '9876' }]))
            .toThrowError(/dup_id/);
    });

    it('handles a missing/empty doc as an empty list', () => {
        const out = applyRosterMutation({}, list => {
            expect(list).toEqual([]);
            return null;
        });
        expect(out.noop).toBe(true);
    });
});

describe('rev counter', () => {
    it('nextStaffRev increments from the read doc, starting at 0', () => {
        expect(nextStaffRev({ rev: 7 })).toBe(8);
        expect(nextStaffRev({})).toBe(1);
        expect(nextStaffRev(null)).toBe(1);
        expect(nextStaffRev({ rev: 'junk' })).toBe(1);
    });

    it('noteStaffSnapshot tracks the snapshot rev (null when absent)', () => {
        noteStaffSnapshot({ rev: 12 });
        expect(STAFF_DOC.rev).toBe(12);
        noteStaffSnapshot({ list: [] });
        expect(STAFF_DOC.rev).toBe(null);
    });
});
