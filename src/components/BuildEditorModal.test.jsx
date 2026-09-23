// BuildEditorModal custom-item path (2026-09-23 review M2). Once ✏️ Edit on
// ⭐ Custom items started opening this path, its whole-doc save
// (saveCustomItem, merge:false) had to stop stripping what it doesn't edit,
// and an allergen-only fix had to be saveable (Save used to watch only the
// component rows).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../toast', () => ({ toast: vi.fn() }));
vi.mock('./ModalPortal', () => ({ default: ({ children }) => children }));
vi.mock('../data/itemBuild', () => ({
    COMPONENT_KIND_TONE: { side: { labelEn: 'Side', labelEs: 'Acomp.' }, protein: { labelEn: 'Protein', labelEs: 'Proteína' } },
}));
const h = vi.hoisted(() => ({ saveCustomItem: null, saveBuildOverride: null }));
vi.mock('../data/customItems', () => ({
    saveCustomItem: (...a) => h.saveCustomItem(...a),
    deleteCustomItem: vi.fn(),
    makeCustomItemSlug: (n) => String(n).toLowerCase().replace(/\s+/g, '-'),
}));
vi.mock('../data/buildOverrides', () => ({
    getBuildOverride: vi.fn(async () => null),
    saveBuildOverride: (...a) => h.saveBuildOverride(...a),
    deleteBuildOverride: vi.fn(),
}));

import BuildEditorModal from './BuildEditorModal';

const MENU_ITEM = {
    id: 'banh-mi-special', nameEn: 'Banh Mi Special', nameEs: 'Banh Mi Especial',
    category: 'Sandwiches', categoryEs: 'Sándwiches', allergens: 'Soy', isCustom: true,
};
const COMPONENTS = [
    // Extra fields an admin script (or a future feature) put on a component —
    // the sticker search reads these; the editor must not strip them.
    { id: 'c1', kind: 'protein', nameEn: 'Pork', nameEs: 'Cerdo', allergens: 'Soy', shelfLifeHours: 4, thawedDays: 2 },
    { id: 'c2', kind: 'side', nameEn: 'Pickles', nameEs: 'Encurtidos', descEn: 'house pickled' },
];

function renderEditor() {
    return render(
        <BuildEditorModal menuItem={MENU_ITEM} initialComponents={COMPONENTS} initialNotes={[]}
            initialShelfLifeDays={2} isCustom staffName="Andrew" language="en"
            onClose={vi.fn()} onSaved={vi.fn()} />,
    );
}
const saveButton = () => screen.getByRole('button', { name: /^Save$/ });

beforeEach(() => {
    h.saveCustomItem = vi.fn(async () => {});
    h.saveBuildOverride = vi.fn(async () => {});
});

describe('BuildEditorModal — custom item edit', () => {
    it('an allergen-only fix enables Save and saves to /custom_items (never build_overrides)', async () => {
        renderEditor();
        expect(saveButton()).toBeDisabled();
        fireEvent.change(screen.getByDisplayValue('Soy'), { target: { value: 'Soy, Wheat, Sesame' } });
        expect(saveButton()).toBeEnabled();
        await act(async () => { fireEvent.click(saveButton()); });
        expect(h.saveBuildOverride).not.toHaveBeenCalled();
        expect(h.saveCustomItem).toHaveBeenCalledTimes(1);
        const arg = h.saveCustomItem.mock.calls[0][0];
        expect(arg.slug).toBe('banh-mi-special');
        expect(arg.allergens).toBe('Soy, Wheat, Sesame');
        expect(arg.shelfLifeDays).toBe(2);
    });

    it('carries per-component fields it does not edit, and keeps the Spanish category', async () => {
        renderEditor();
        fireEvent.change(screen.getByDisplayValue('Pork'), { target: { value: 'Grilled Pork' } });
        await act(async () => { fireEvent.click(saveButton()); });
        const arg = h.saveCustomItem.mock.calls[0][0];
        expect(arg.components[0]).toEqual({
            id: 'c1', kind: 'protein', nameEn: 'Grilled Pork', nameEs: 'Cerdo',
            allergens: 'Soy', shelfLifeHours: 4, thawedDays: 2,
        });
        expect(arg.components[1]).toEqual({ id: 'c2', kind: 'side', nameEn: 'Pickles', nameEs: 'Encurtidos', descEn: 'house pickled' });
        expect(arg.category).toBe('Sandwiches');
        expect(arg.categoryEs).toBe('Sándwiches');
    });

    it('a cleared description really clears (edited fields always win)', async () => {
        renderEditor();
        fireEvent.change(screen.getByDisplayValue('house pickled'), { target: { value: '' } });
        await act(async () => { fireEvent.click(saveButton()); });
        expect(h.saveCustomItem.mock.calls[0][0].components[1].descEn).toBeUndefined();
    });

    it('renaming the category writes the new name to both languages (old behavior)', async () => {
        renderEditor();
        fireEvent.change(screen.getByDisplayValue('Sandwiches'), { target: { value: 'Specials' } });
        await act(async () => { fireEvent.click(saveButton()); });
        const arg = h.saveCustomItem.mock.calls[0][0];
        expect(arg.category).toBe('Specials');
        expect(arg.categoryEs).toBe('Specials');
    });
});
