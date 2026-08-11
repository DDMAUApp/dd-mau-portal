// Employer auto-fill suggester — patterns pinned against the REAL field
// labels in the prod templates (probed 2026-08-11).
import { describe, it, expect } from 'vitest';
import { suggestEmployerValues, companyForLocation, toUsDate } from './onboardingCompany';

const COMPANY = {
    name: 'Forsis LLC',
    ein: '82-3254025',
    address: '11982 Dorsett Rd, Maryland Heights, MO 63043',
    signerTitle: 'Owner',
};
const HIRE = { hireDate: '2026-08-11', location: 'maryland' };
const ARGS = { company: COMPANY, hire: HIRE, adminName: 'Andrew Shih', todayStr: '08/11/2026' };
const t = (id, label) => ({ id, label, filledBy: 'employer', type: 'text' });

describe('suggestEmployerValues — real prod labels', () => {
    it('fills the I-9 employer block', () => {
        const out = suggestEmployerValues([
            t('a', 'Employers Business or Org Name'),
            t('b', 'Employers Business or Org Address'),
            t('c', 'FirstDayEmployed mmddyyyy'),
            t('d', 'S2 Todays Date mmddyyyy'),
            t('e', 'Last Name First Name and Title of Employer or Authorized Representative'),
        ], ARGS);
        expect(out.a).toBe('Forsis LLC');
        expect(out.b).toBe('11982 Dorsett Rd, Maryland Heights, MO 63043');
        expect(out.c).toBe('08/11/2026');
        expect(out.d).toBe('08/11/2026');
        expect(out.e).toBe('Shih Andrew, Owner');
    });
    it('fills the Spanish W-4 IRS AcroForm fields', () => {
        const out = suggestEmployerValues([
            t('x', 'topmostSubform[0].Page1[0].f1_12[0]'),
            t('y', 'topmostSubform[0].Page1[0].f1_13[0]'),
            t('z', 'topmostSubform[0].Page1[0].f1_14[0]'),
        ], ARGS);
        expect(out.x).toBe('Forsis LLC, 11982 Dorsett Rd, Maryland Heights, MO 63043');
        expect(out.y).toBe('08/11/2026');
        expect(out.z).toBe('82-3254025');
    });
    it('never touches document-list fields, signatures, or checkboxes', () => {
        const out = suggestEmployerValues([
            t('d1', 'Document Title 1'),
            t('d2', 'List B Issuing Authority 1'),
            t('d3', 'Document Number 0 (if any)'),
            { id: 's', label: 'Signature of Employer or AR sig', filledBy: 'employer', type: 'signature' },
            { id: 'cb', label: 'CB_Alt', filledBy: 'employer', type: 'checkbox' },
            { id: 'h', label: 'Employers Business or Org Name', filledBy: 'hire', type: 'text' },
        ], ARGS);
        expect(out).toEqual({});
    });
    it('returns nothing when company info is missing', () => {
        expect(suggestEmployerValues([t('a', 'Employers Business or Org Name')], { ...ARGS, company: null })).toEqual({});
    });
});

describe('companyForLocation', () => {
    const data = { webster: { name: 'W' }, maryland: { name: 'M' } };
    it('picks by hire location, defaults to webster', () => {
        expect(companyForLocation(data, 'maryland').name).toBe('M');
        expect(companyForLocation(data, 'webster').name).toBe('W');
        expect(companyForLocation(data, 'both').name).toBe('W');
        expect(companyForLocation(data, undefined).name).toBe('W');
    });
    it('falls through to whichever block exists', () => {
        expect(companyForLocation({ maryland: { name: 'M' } }, 'webster').name).toBe('M');
        expect(companyForLocation({}, 'webster')).toBe(null);
    });
});

describe('toUsDate', () => {
    it('converts ISO, passes through everything else', () => {
        expect(toUsDate('2026-08-11')).toBe('08/11/2026');
        expect(toUsDate('8/11/26')).toBe('8/11/26');
        expect(toUsDate('')).toBe('');
    });
});
