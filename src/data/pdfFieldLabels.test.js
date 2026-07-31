// Pins the 2026-07-30 fillable-field labelling fix (Andrew: "in all of the
// fillable fields it says top something").
//
// Real AcroForm names below are the actual shapes government fillable PDFs
// use — IRS forms are XFA-derived and name every widget
// `topmostSubform[0].Page1[0].f1_01[0]`.

import { describe, it, expect } from 'vitest';
import { humanizeFieldLabel, guessAutofill, displayFieldLabel } from './pdfFieldLabels';

describe('humanizeFieldLabel — the "top something" bug', () => {
    it('never returns the XFA machine name', () => {
        const label = humanizeFieldLabel('topmostSubform[0].Page1[0].f1_01[0]', '');
        expect(label).not.toMatch(/topmost/i);
        expect(label).not.toMatch(/\[0\]/);
    });

    it('prefers the tooltip, which is the agency\'s own wording', () => {
        expect(humanizeFieldLabel(
            'topmostSubform[0].Page1[0].f1_01[0]',
            'Step 1(a) First name and middle initial',
        )).toBe('Step 1(a) First name and middle initial');
    });

    it('returns empty for a purely machine-named field with no tooltip', () => {
        // Nothing meaningful exists — the caller supplies its own fallback.
        expect(humanizeFieldLabel('topmostSubform[0].Page1[0].f1_01[0]', '')).toBe('');
    });

    it('ignores a tooltip that just repeats the machine name', () => {
        expect(humanizeFieldLabel(
            'topmostSubform[0].Page1[0].f1_01[0]',
            'topmostSubform[0].Page1[0].f1_01[0]',
        )).toBe('');
    });

    it('mines a meaningful leaf out of the dotted path', () => {
        // PascalCase segments keep their internal capitals — "Employee Last
        // Name" reads like a form label, which is the point.
        expect(humanizeFieldLabel('form1[0].Page1[0].EmployeeLastName[0]', ''))
            .toBe('Employee Last Name');
    });

    it('splits snake_case and kebab-case', () => {
        expect(humanizeFieldLabel('home_address_line', '')).toBe('Home address line');
        expect(humanizeFieldLabel('zip-code', '')).toBe('Zip code');
    });

    it('skips junk leaves and uses an earlier meaningful segment', () => {
        expect(humanizeFieldLabel('form1[0].SocialSecurityNumber[0].f1_05[0]', ''))
            .toBe('Social Security Number');
    });

    it('trims trailing colons and caps very long tooltips', () => {
        expect(humanizeFieldLabel('x', 'Last name:')).toBe('Last name');
        const long = humanizeFieldLabel('x', 'A'.repeat(200));
        expect(long.length).toBeLessThanOrEqual(80);
        expect(long.endsWith('…')).toBe(true);
    });

    it('handles null/undefined without throwing', () => {
        expect(humanizeFieldLabel(null, undefined)).toBe('');
        expect(humanizeFieldLabel(undefined, null)).toBe('');
    });
});

describe('guessAutofill — combined boxes must beat their parts', () => {
    it('binds the federal W-4 combined box to cityStateZip, not city', () => {
        // Regression: the old squash-everything matcher hit /^city/ first and
        // silently dropped the state + ZIP from a single-box form.
        expect(guessAutofill('f1_04[0]', 'City or town, state, and ZIP code'))
            .toBe('cityStateZip');
    });

    it('still binds a standalone city box to city', () => {
        expect(guessAutofill('', 'City or Town')).toBe('city');
    });

    it('binds standalone state and ZIP boxes (MO W-4 splits them)', () => {
        expect(guessAutofill('', 'State')).toBe('state');
        expect(guessAutofill('', 'ZIP Code')).toBe('zip');
    });
});

describe('guessAutofill — real form fields', () => {
    const cases = [
        ['Step 1(a) First name and middle initial', 'firstName'],
        ['Last name', 'lastName'],
        ['Full Name', 'legalName'],
        ['Social Security Number', 'ssn'],
        ['Home Address (Number and Street or Rural Route)', 'addressLine'],
        ['Date (MM/DD/YYYY)', 'today'],
        ['Employee Signature Date', 'today'],
        ['Date of Birth', 'dob'],
        ['Email Address', 'email'],
        ['Telephone Number', 'phone'],
        ['Date Services for Pay First Performed by Employee', 'hireDate'],
    ];
    for (const [tooltip, expected] of cases) {
        it(`"${tooltip}" → ${expected}`, () => {
            expect(guessAutofill('', tooltip)).toBe(expected);
        });
    }
});

describe('guessAutofill — must NOT bind the wrong thing', () => {
    it('leaves "State Tax" and "State Wages" unbound', () => {
        // Binding these to the hire's home state would write "MO" into a
        // dollar box on a tax form.
        expect(guessAutofill('', 'State Tax Withheld')).toBe('');
        expect(guessAutofill('', 'State Wages')).toBe('');
    });

    it('returns empty for an unrecognized field', () => {
        expect(guessAutofill('f1_99[0]', '')).toBe('');
        expect(guessAutofill('', '')).toBe('');
    });

    it('handles null/undefined without throwing', () => {
        expect(guessAutofill(null, undefined)).toBe('');
    });
});

describe('displayFieldLabel — Spanish', () => {
    it('translates via the autofill binding, not the English wording', () => {
        // Same box, three different agency phrasings across form revisions —
        // all land on the same Spanish because the BINDING is what's keyed.
        for (const label of ['Step 1(a) First name and middle initial', 'First name', 'Given name']) {
            expect(displayFieldLabel({ label, autofill: 'firstName' }, 'es'))
                .toBe('Nombre (y segundo nombre)');
        }
    });

    it('translates the combined city/state/zip box', () => {
        expect(displayFieldLabel(
            { label: 'City or town, state, and ZIP code', autofill: 'cityStateZip' }, 'es',
        )).toBe('Ciudad, estado y código postal');
    });

    it('falls back to a known phrase when there is no binding', () => {
        expect(displayFieldLabel({ label: 'Employee Signature', autofill: '' }, 'es'))
            .toBe('Firma del empleado');
        expect(displayFieldLabel({ label: 'Head of Household', autofill: '' }, 'es'))
            .toBe('Jefe de familia');
    });

    it('labels a signature widget even with no text at all', () => {
        expect(displayFieldLabel({ label: '', autofill: '', type: 'signature' }, 'es'))
            .toBe('Firma');
    });

    it('falls back to the agency English rather than showing nothing', () => {
        // Untranslated is better than blank — it also matches the words
        // printed on the PDF page behind the box.
        expect(displayFieldLabel({ label: 'Line 4c extra withholding', autofill: '' }, 'es'))
            .toBe('Line 4c extra withholding');
    });

    it('English mode returns the humanized agency wording', () => {
        expect(displayFieldLabel({ label: 'Last name', autofill: 'lastName' }, 'en'))
            .toBe('Last name');
    });

    it('never leaks the machine name in either language', () => {
        const f = { label: 'topmostSubform[0].Page1[0].f1_01[0]', autofill: 'firstName' };
        expect(displayFieldLabel(f, 'es')).toBe('Nombre (y segundo nombre)');
        expect(displayFieldLabel(f, 'en')).not.toMatch(/topmost/i);
    });
});
