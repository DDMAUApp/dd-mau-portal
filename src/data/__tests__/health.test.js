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
