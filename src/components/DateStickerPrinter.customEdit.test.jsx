// ✏️ Edit on a ⭐ Custom item must open the CUSTOM-item editor (2026-09-23
// review M2). Both call sites used to pass only { id, nameEn, nameEs }, so
// BuildEditorModal took the menu-item path — loaded getMenuItemBuild and
// saved to /build_overrides — and the edit never reached the sticker.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn(() => ({ path: 'mock' })),
    collection: vi.fn(() => ({ path: 'mock' })),
    onSnapshot: vi.fn(() => () => {}),
    setDoc: vi.fn(async () => {}),
    getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
    addDoc: vi.fn(async () => ({ id: 'x' })),
    updateDoc: vi.fn(async () => {}),
    runTransaction: vi.fn(async () => {}),
    deleteField: vi.fn(() => ({})),
    serverTimestamp: vi.fn(() => ({})),
    query: vi.fn((...a) => a),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    FieldPath: class FieldPath {},
}));
vi.mock('../data/aiSearch', () => ({
    useAiSearch: () => ({ loading: false, matchingIds: null, error: null }),
}));
vi.mock('../data/labelPrinting', () => ({ warmPrintConfigs: vi.fn() }));
vi.mock('../data/buildOverrides', () => ({
    subscribeAllBuildOverrides: (cb) => { cb(new Map()); return () => {}; },
    applyBuildOverride: (b) => b,
}));
const CUSTOM = {
    slug: 'banh-mi-special',
    nameEn: 'Banh Mi Special',
    nameEs: 'Banh Mi Especial',
    category: 'Sandwiches',
    categoryEs: 'Sándwiches',
    allergens: 'Soy, Wheat',
    shelfLifeDays: 2,
    components: [{ id: 'c1', kind: 'protein', nameEn: 'Pork', nameEs: 'Cerdo' }],
    notes: [],
};
vi.mock('../data/customItems', () => ({
    subscribeAllCustomItems: (cb) => { cb([CUSTOM]); return () => {}; },
}));
const { editorProps } = vi.hoisted(() => ({ editorProps: [] }));
vi.mock('./BuildEditorModal', () => ({
    default: (props) => { editorProps.push(props); return <div>editor-open</div>; },
}));
vi.mock('./PrintLabelModal', () => ({ default: () => null }));
vi.mock('./ShelfLifeMatrix', () => ({ default: () => null }));
vi.mock('./ExpiringPanel', () => ({ default: () => null }));

import DateStickerPrinter from './DateStickerPrinter';

describe('DateStickerPrinter — ✏️ Edit on a custom item (M2)', () => {
    it('opens the custom-item path with the fields it seeds from', async () => {
        render(
            <DateStickerPrinter
                language="en"
                staffName="Andrew Shih"
                storeLocation="webster"
                staffList={[{ id: 40, name: 'Andrew Shih', role: 'Owner' }]}
            />,
        );
        const edit = screen.getByTitle('Edit build (admin)');
        await act(async () => { fireEvent.click(edit); });
        expect(await screen.findByText('editor-open')).toBeInTheDocument();
        const props = editorProps[editorProps.length - 1];
        expect(props.isCustom).toBe(true);
        expect(props.menuItem).toMatchObject({
            id: 'banh-mi-special',
            nameEn: 'Banh Mi Special',
            category: 'Sandwiches',
            categoryEs: 'Sándwiches',
            allergens: 'Soy, Wheat',
            isCustom: true,
        });
        // Seeded from the custom item doc — not getMenuItemBuild's empty build.
        expect(props.initialComponents).toEqual(CUSTOM.components);
        expect(props.initialShelfLifeDays).toBe(2);
    });
});
