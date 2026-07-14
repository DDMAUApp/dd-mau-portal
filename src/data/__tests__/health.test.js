import { describe, it, expect } from 'vitest';
import { complianceStatus, hepA2Due, DEFAULT_HEALTH_DOCS } from '../health';

const DOCS = DEFAULT_HEALTH_DOCS; // 2 required docs

describe('complianceStatus', () => {
    it('brand-new staff (no record) is missing everything', () => {
        const s = complianceStatus(null, DOCS);
        expect(s.complete).toBe(false);
        expect(s.hepA1).toBe(false);
        expect(s.hepA2).toBe(false);
        expect(s.docsSigned).toBe(0);
        expect(s.docsTotal).toBe(2);
        expect(s.missing).toEqual(['hepA1', 'hepA2', 'doc:illness_reporting', 'doc:hygiene_policy']);
    });

    it('fully compliant staff', () => {
        const rec = {
            hepA: { shot1Date: '2025-01-10', shot2Date: '2025-07-15' },
            docs: {
                illness_reporting: { signedAt: '2026-01-01T10:00:00Z' },
                hygiene_policy: { signedAt: '2026-01-01T10:05:00Z' },
            },
        };
        const s = complianceStatus(rec, DOCS);
        expect(s.complete).toBe(true);
        expect(s.missing).toEqual([]);
        expect(s.docsSigned).toBe(2);
    });

    it('shot 1 only + one doc signed', () => {
        const rec = {
            hepA: { shot1Date: '2026-06-01', shot2Date: '' },
            docs: { illness_reporting: { signedAt: '2026-06-01T10:00:00Z' } },
        };
        const s = complianceStatus(rec, DOCS);
        expect(s.hepA1).toBe(true);
        expect(s.hepA2).toBe(false);
        expect(s.docsSigned).toBe(1);
        expect(s.missing).toEqual(['hepA2', 'doc:hygiene_policy']);
    });

    it('medical exemption satisfies both shots', () => {
        const rec = { hepA: { exempt: true }, docs: {} };
        const s = complianceStatus(rec, DOCS);
        expect(s.hepA1).toBe(true);
        expect(s.hepA2).toBe(true);
        expect(s.missing).toEqual(['doc:illness_reporting', 'doc:hygiene_policy']);
    });

    it('non-required docs are ignored', () => {
        const docs = [...DOCS, { key: 'optional_thing', required: false, title: 'X' }];
        const s = complianceStatus({ hepA: { shot1Date: '2025-01-01', shot2Date: '2025-08-01' }, docs: {
            illness_reporting: { signedAt: 'x' }, hygiene_policy: { signedAt: 'x' },
        } }, docs);
        expect(s.complete).toBe(true);
        expect(s.docsTotal).toBe(2);
    });

    it('signed entry without signedAt does not count', () => {
        const s = complianceStatus({ docs: { illness_reporting: { signedAt: '' } } }, DOCS);
        expect(s.docsSigned).toBe(0);
    });
});

describe('hepA2Due', () => {
    it('due when >6 months since shot 1 and no shot 2', () => {
        expect(hepA2Due({ hepA: { shot1Date: '2026-01-01' } }, '2026-07-12')).toBe(true);
    });
    it('not due within 6 months', () => {
        expect(hepA2Due({ hepA: { shot1Date: '2026-03-01' } }, '2026-07-12')).toBe(false);
    });
    it('never due once shot 2 recorded or exempt or no shot 1', () => {
        expect(hepA2Due({ hepA: { shot1Date: '2025-01-01', shot2Date: '2025-08-01' } }, '2026-07-12')).toBe(false);
        expect(hepA2Due({ hepA: { shot1Date: '2025-01-01', exempt: true } }, '2026-07-12')).toBe(false);
        expect(hepA2Due({ hepA: {} }, '2026-07-12')).toBe(false);
        expect(hepA2Due(null, '2026-07-12')).toBe(false);
    });
});

import { hepA2DueDateStr, buildAttentionQueue } from '../health';

describe('hepA2DueDateStr', () => {
    it('is 6 months after shot 1', () => {
        expect(hepA2DueDateStr({ hepA: { shot1Date: '2026-01-15' } })).toBe('2026-07-15');
    });
    it('empty when no shot 1, shot 2 done, or exempt', () => {
        expect(hepA2DueDateStr({ hepA: {} })).toBe('');
        expect(hepA2DueDateStr({ hepA: { shot1Date: '2026-01-15', shot2Date: '2026-07-20' } })).toBe('');
        expect(hepA2DueDateStr({ hepA: { shot1Date: '2026-01-15', exempt: true } })).toBe('');
    });
    // 2026-07-13 audit regression: a stored impossible date parsed as
    // Invalid Date on WebKit and toISOString() THREW inside the roster
    // useMemo — bricking the whole Health tab on iPads. Must return ''
    // (never throw) for garbage stored values.
    it('never throws on an impossible stored date (WebKit crash regression)', () => {
        expect(() => hepA2DueDateStr({ hepA: { shot1Date: '2024-02-31' } })).not.toThrow();
        expect(hepA2DueDateStr({ hepA: { shot1Date: '2024-02-31' } })).toBe('');
        expect(hepA2DueDateStr({ hepA: { shot1Date: 'not-a-date' } })).toBe('');
    });
});

describe('buildAttentionQueue', () => {
    const DOCS = [{ key: 'illness_reporting', required: true, title: 'X' }];
    const row = (id, name, rec) => ({ person: { id, name }, rec, status: complianceStatus(rec, DOCS) });
    it('sorts overdue shot-2 first, docs last; skips complete staff', () => {
        const rows = [
            row(1, 'Amy', { hepA: { shot1Date: '2025-11-01' }, docs: { illness_reporting: { signedAt: 'x' } } }),   // shot2 overdue
            row(2, 'Bob', { hepA: { shot1Date: '2026-01-01', shot2Date: '2026-07-05' }, docs: {} }),                // doc only
            row(3, 'Cal', null),                                                                                    // everything
            row(4, 'Dee', { hepA: { shot1Date: '2026-01-01', shot2Date: '2026-07-05' }, docs: { illness_reporting: { signedAt: 'x' } } }), // complete
        ];
        const q = buildAttentionQueue(rows, '2026-07-12');
        expect(q[0]).toMatchObject({ name: 'Amy', kind: 'hepA2', overdue: true, severity: 0, dueDate: '2026-05-01' });
        expect(q.find(i => i.name === 'Cal' && i.kind === 'hepA1')).toBeTruthy();
        // Cal has no shot 1 → NO hepA2 item (hepA1 covers it)
        expect(q.find(i => i.name === 'Cal' && i.kind === 'hepA2')).toBeFalsy();
        expect(q[q.length - 1].kind).toBe('doc');
        expect(q.find(i => i.name === 'Dee')).toBeFalsy();
    });
    it('upcoming (not overdue) shot 2 gets severity 2 with the due date', () => {
        const rows = [row(1, 'Amy', { hepA: { shot1Date: '2026-05-01' }, docs: { illness_reporting: { signedAt: 'x' } } })];
        const q = buildAttentionQueue(rows, '2026-07-12');
        expect(q[0]).toMatchObject({ kind: 'hepA2', overdue: false, severity: 2, dueDate: '2026-11-01' });
    });
});

import { normalizeDateInput, parsePastedRows } from '../../components/HealthBulkEditor';

describe('normalizeDateInput', () => {
    it('accepts common spreadsheet formats', () => {
        expect(normalizeDateInput('2026-01-15')).toBe('2026-01-15');
        expect(normalizeDateInput('1/15/26')).toBe('2026-01-15');
        expect(normalizeDateInput('01-15-2026')).toBe('2026-01-15');
        expect(normalizeDateInput('3.2.24')).toBe('2024-03-02');
    });
    it('rejects garbage', () => {
        expect(normalizeDateInput('')).toBe('');
        expect(normalizeDateInput('yes')).toBe('');
        expect(normalizeDateInput('13/45/26')).toBe('');
    });
    // 2026-07-13 audit regression: '2/31/24' passed the naive 1-31 day
    // check and stored '2024-02-31' — which crashed WebKit downstream.
    // Only dates that exist on a real calendar may survive.
    it('rejects impossible calendar dates (both input paths)', () => {
        expect(normalizeDateInput('2/31/24')).toBe('');
        expect(normalizeDateInput('9/31/25')).toBe('');
        expect(normalizeDateInput('2024-02-31')).toBe('');
        expect(normalizeDateInput('2023-02-29')).toBe('');   // not a leap year
        expect(normalizeDateInput('2024-02-29')).toBe('2024-02-29'); // leap year OK
    });
});

describe('parsePastedRows', () => {
    const STAFF = [{ id: 6, name: 'Blanca Salgado' }, { id: 21, name: 'Isa Davis' }];
    it('matches names (exact + prefix, case-insensitive) and normalizes dates', () => {
        const text = 'blanca salgado\t3/2/24\t4/1/24\t10/5/24\nIsa,2024-05-01,5/15/24\nGhost Person\t1/1/24\t2/2/24';
        const { matched, unmatched } = parsePastedRows(text, STAFF);
        expect(matched).toHaveLength(2);
        expect(matched[0]).toMatchObject({ staffId: '6', patch: { hiredDate: '2024-03-02', shot1Date: '2024-04-01', shot2Date: '2024-10-05' } });
        expect(matched[1]).toMatchObject({ staffId: '21', patch: { hiredDate: '2024-05-01', shot1Date: '2024-05-15' } });
        expect(unmatched).toHaveLength(1);
    });
    it('skips rows with no readable dates', () => {
        const { matched, unmatched } = parsePastedRows('Isa Davis\tsoon\tmaybe', STAFF);
        expect(matched).toHaveLength(0);
        expect(unmatched).toHaveLength(1);
    });
});
