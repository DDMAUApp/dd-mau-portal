// Does the Label Format editor actually respond to its own controls?
// Andrew 2026-06-20: "the toggles + font size don't do anything."
// This isolates the component (Firestore + payload builder mocked) and
// asserts a toggle flips and the size slider's value updates.

import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the Firestore-touching data module. Keep a faithful DEFAULT +
// clamp so the component sees the same shape it does in production.
// vi.hoisted so these exist when the hoisted vi.mock factory runs.
const { DEFAULT, saveSpy } = vi.hoisted(() => ({
    DEFAULT: {
        showPreppedLabel: true, showTime: true, showTitle: true, showUseBy: true,
        showByName: true, showLocation: true, showAllergens: true,
        showIngredients: true, showNotes: true, showFooter: true,
        dateNumberScale: 5, titleScale: 2,
        preppedLabelTextEn: 'PREPPED', preppedLabelTextEs: 'HECHO', footerText: 'DD MAU',
        dateFormat: 'mm/dd/yy', timeFormat: '12h', showUseByWeekday: true,
        defaultShelfLifeDays: 5,
    },
    saveSpy: vi.fn(() => Promise.resolve()),
}));
vi.mock('../data/labelFormat', () => ({
    DEFAULT_LABEL_FORMAT: DEFAULT,
    clampLabelFormat: (f) => ({ ...f }),
    subscribeLabelFormat: (cb) => { cb({ ...DEFAULT }); return () => {}; },
    saveLabelFormat: (...a) => saveSpy(...a),
}));
// Pure stub — return enough payload shape that PreviewBox renders.
vi.mock('../data/labelPrinting', () => ({
    buildLabelPayload: (args) => ({
        prepDateLabel: args.format?.showPreppedLabel === false ? '' : 'PREPPED',
        prepDateNumber: '06/20/26',
        dateNumberScale: args.format?.dateNumberScale ?? 5,
        titleLines: args.format?.showTitle === false ? [] : ['PORK BOWL'],
        metaLines: [],
        allergens: args.format?.showAllergens === false ? [] : ['Soy'],
        ingredients: [], notes: '', footer: 'DD MAU',
    }),
}));

import LabelFormatEditor from './LabelFormatEditor';

afterEach(cleanup);

describe('LabelFormatEditor controls', () => {
    it('opens, flips a toggle, and moves the size slider', () => {
        render(<LabelFormatEditor language="en" byName="Tester" />);

        // Expand the editor (collapsed by default).
        fireEvent.click(screen.getByText('Label format (every sticker)'));

        // The Allergens toggle (a <button>) starts ON. Tapping flips it OFF.
        const allergens = screen.getByRole('button', { name: /Allergens/ });
        expect(allergens.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(allergens);
        expect(allergens.getAttribute('aria-pressed')).toBe('false');

        // The date-number size stepper starts at 5; tapping + makes it 6.
        const dateRow = screen.getByText('Date number size').parentElement;
        expect(within(dateRow).getByText('5')).toBeTruthy();
        fireEvent.click(within(dateRow).getByLabelText('increase'));
        expect(within(dateRow).getByText('6')).toBeTruthy();
    });
});
