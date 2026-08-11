// Employer auto-fill suggester — patterns pinned against the REAL field
// labels in the prod templates (probed 2026-08-11).
import { describe, it, expect } from 'vitest';
import { suggestEmployerValues, companyForLocation, toUsDate, splitAddress } from './onboardingCompany';

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

describe('suggestEmployerValues — MO W-4 labels (2026-08-11 round 2)', () => {
    const MO_ARGS = { ...ARGS, company: { ...COMPANY, moTaxId: '12345678' } };
    const fields = [
        t('n', "Employer's Name"),
        t('a', "Employer's Address (street)"),
        t('c', 'Employer City'),
        t('s', 'Employer State'),
        t('z', 'Employer ZIP Code'),
        t('d', 'Date Services for Pay First Performed (MM/DD/YYYY)'),
        t('f', 'Federal Employer I.D. Number'),
        t('m', 'Missouri Tax Identification Number'),
    ];
    it('fills the whole MO employer block', () => {
        const out = suggestEmployerValues(fields, MO_ARGS);
        expect(out.n).toBe('Forsis LLC');
        expect(out.a).toBe('11982 Dorsett Rd');
        expect(out.c).toBe('Maryland Heights');
        expect(out.s).toBe('MO');
        expect(out.z).toBe('63043');
        expect(out.d).toBe('08/11/2026');
        expect(out.f).toBe('82-3254025');
        expect(out.m).toBe('12345678');
    });
    it('leaves the MO tax box empty until the id is on file', () => {
        const out = suggestEmployerValues(fields, ARGS); // no moTaxId
        expect(out.m).toBeUndefined();
        expect(out.f).toBe('82-3254025'); // FEIN unaffected
    });
    it('MO patterns do not disturb the I-9 single-line address', () => {
        const out = suggestEmployerValues([t('x', 'Employers Business or Org Address')], MO_ARGS);
        expect(out.x).toBe('11982 Dorsett Rd, Maryland Heights, MO 63043');
    });
});

describe('splitAddress', () => {
    it('splits both real store addresses', () => {
        expect(splitAddress('8169 Big Bend Blvd, Webster Groves, MO 63119'))
            .toEqual({ street: '8169 Big Bend Blvd', city: 'Webster Groves', state: 'MO', zip: '63119' });
        expect(splitAddress('11982 Dorsett Rd, Maryland Heights, MO 63043'))
            .toEqual({ street: '11982 Dorsett Rd', city: 'Maryland Heights', state: 'MO', zip: '63043' });
    });
    it('tolerates junk', () => {
        expect(splitAddress('')).toEqual({ street: '', city: '', state: '', zip: '' });
        expect(splitAddress('just a street')).toEqual({ street: 'just a street', city: '', state: '', zip: '' });
    });
});

describe('toUsDate', () => {
    it('converts ISO, passes through everything else', () => {
        expect(toUsDate('2026-08-11')).toBe('08/11/2026');
        expect(toUsDate('8/11/26')).toBe('8/11/26');
        expect(toUsDate('')).toBe('');
    });
});
