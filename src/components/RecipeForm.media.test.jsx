// RecipeForm — photos/videos on lines + Prep / Cook-to-order sections
// (2026-09-28). Upload + Firebase are mocked; this drives the real form.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const uploaded = [];
const deleted = [];
vi.mock('../data/recipeMediaUpload', () => ({
    uploadRecipeMedia: vi.fn(async (file) => {
        const id = `m${uploaded.length + 1}`;
        const item = file.type.startsWith('video/')
            ? { id, kind: 'video', url: `https://x/${id}.mov`, path: `recipe_media/${id}.mov` }
            : { id, kind: 'image', url: `https://x/${id}.jpg`, path: `recipe_media/${id}.jpg`, w: 800, h: 600 };
        uploaded.push(item);
        return item;
    }),
    fetchVideoResult: vi.fn(async (id) => ({ playbackUrl: `https://x/${id}_720.mp4`, posterUrl: `https://x/${id}_poster.jpg` })),
    deleteRecipeMediaFiles: vi.fn(async (item) => { deleted.push(item.id); }),
}));
vi.mock('../toast', () => ({ toast: vi.fn() }));
vi.mock('./ModalPortal', () => ({ default: ({ children }) => children }));
vi.mock('../capacitor-bridge', () => ({ openExternalUrl: vi.fn(), pushBackHandler: vi.fn(() => () => {}) }));

import RecipeForm from './RecipeForm';
import { toast } from '../toast';

const RECIPE = {
    id: 7, titleEn: 'Pho Broth', titleEs: 'Caldo de Pho', emoji: '🍜', category: 'Pho & Soups',
    ingredientsEn: ['10 lb beef bones', '2 onions'], ingredientsEs: ['10 lb huesos de res', '2 cebollas'],
    instructionsEn: ['Blanch bones', 'Simmer 8 hours'], instructionsEs: ['Blanquea los huesos', 'Hierve 8 horas'],
    allergens: [],
};

beforeEach(() => {
    uploaded.length = 0; deleted.length = 0;
    localStorage.clear();
    toast.mockClear();
});

const pick = (container, files) => {
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files } });
};

describe('RecipeForm media + sections', () => {
    it('attaches a photo to a step and saves it on that line (both languages untouched)', async () => {
        const onSave = vi.fn(async () => true);
        const { container } = render(<RecipeForm language="en" recipe={RECIPE} onSave={onSave} onCancel={() => {}} draftKey="7" staffName="Andrew Shih" />);
        const cams = screen.getAllByLabelText('Add photo or video');
        // 2 EN ingredient rows + 2 EN step rows (ES rows have no 📷)
        expect(cams.length).toBe(4);
        fireEvent.click(cams[3]);                           // step 2
        await act(async () => { pick(container, [new File(['x'], 'IMG_1.HEIC', { type: 'image/heic' })]); });
        await waitFor(() => expect(uploaded.length).toBe(1));
        await waitFor(() => expect(container.querySelector('img[src="https://x/m1.jpg"]')).toBeTruthy());
        await act(async () => { fireEvent.click(screen.getByText('Save Changes')); });
        const saved = onSave.mock.calls[0][0];
        expect(saved.instructionsEn).toEqual(RECIPE.instructionsEn);
        expect(saved.instructionsEs).toEqual(RECIPE.instructionsEs);
        expect(saved.media.step['1'][0]).toMatchObject({ id: 'm1', kind: 'image' });
        expect(saved.serviceIngredientsEn).toBeUndefined();
        expect(localStorage.getItem('ddmau:recipeEditDraft:7')).toBeNull();
    });

    it('removing a row moves the photos below it up with their line', async () => {
        const recipe = { ...RECIPE, instructionsEn: ['A', 'B', 'C'], instructionsEs: [], media: { step: { 2: [{ id: 'c', kind: 'image', url: 'https://x/c.jpg', path: 'recipe_media/c.jpg' }] } } };
        const onSave = vi.fn(async () => true);
        render(<RecipeForm language="en" recipe={recipe} onSave={onSave} onCancel={() => {}} />);
        const removes = screen.getAllByLabelText('remove');
        // rows: ingEn(2) ingEs(2) stepEn(3) …  → step A is index 4
        await act(async () => { fireEvent.click(removes[4]); });
        await act(async () => { fireEvent.click(screen.getByText('Save Changes')); });
        const saved = onSave.mock.calls[0][0];
        expect(saved.instructionsEn).toEqual(['B', 'C']);
        expect(saved.media.step['1'][0].id).toBe('c');
        expect(saved.media.step['2']).toBeUndefined();
    });

    it('a video picks up the server’s phone-friendly copy on save', async () => {
        const onSave = vi.fn(async () => true);
        const { container } = render(<RecipeForm language="en" recipe={RECIPE} onSave={onSave} onCancel={() => {}} />);
        fireEvent.click(screen.getAllByLabelText('Add photo or video')[0]);
        await act(async () => { pick(container, [new File(['x'], 'clip.mov', { type: 'video/quicktime' })]); });
        await waitFor(() => expect(uploaded.length).toBe(1));
        await waitFor(() => expect(screen.getByText('Save Changes')).toBeTruthy());
        await act(async () => { fireEvent.click(screen.getByText('Save Changes')); });
        const item = onSave.mock.calls[0][0].media.ing['0'][0];
        expect(item).toMatchObject({ kind: 'video', playbackUrl: 'https://x/m1_720.mp4', thumbUrl: 'https://x/m1_poster.jpg' });
    });

    it('Cook-to-order section saves as its own lists + media', async () => {
        const onSave = vi.fn(async () => true);
        const { container } = render(<RecipeForm language="en" recipe={RECIPE} onSave={onSave} onCancel={() => {}} />);
        fireEvent.click(screen.getByText(/Add a Cook-to-order/));
        expect(screen.getByText(/Cook to order \(service\)/)).toBeTruthy();
        const stepBoxes = screen.getAllByPlaceholderText(/English 1/);
        // prep step EN 1 + service step EN 1
        fireEvent.change(stepBoxes[stepBoxes.length - 1], { target: { value: 'Blanch noodles 10 sec' } });
        const cams = screen.getAllByLabelText('Add photo or video');
        fireEvent.click(cams[cams.length - 1]);             // service step 1
        await act(async () => { pick(container, [new File(['x'], 'bowl.jpg', { type: 'image/jpeg' })]); });
        await waitFor(() => expect(uploaded.length).toBe(1));
        await act(async () => { fireEvent.click(screen.getByText('Save Changes')); });
        const saved = onSave.mock.calls[0][0];
        expect(saved.serviceInstructionsEn).toEqual(['Blanch noodles 10 sec']);
        expect(saved.serviceIngredientsEn).toEqual([]);
        expect(saved.media.svcStep['0'][0].id).toBe('m1');
        expect(saved.ingredientsEn).toEqual(RECIPE.ingredientsEn);
    });

    it('a photo on a blank line blocks save instead of vanishing', async () => {
        const recipe = { ...RECIPE, instructionsEn: ['A', ''], media: { step: { 1: [{ id: 'z', kind: 'image', url: 'https://x/z.jpg', path: 'recipe_media/z.jpg' }] } } };
        const onSave = vi.fn(async () => true);
        render(<RecipeForm language="en" recipe={recipe} onSave={onSave} onCancel={() => {}} />);
        await act(async () => { fireEvent.click(screen.getByText('Save Changes')); });
        expect(onSave).not.toHaveBeenCalled();
        expect(String(toast.mock.calls[0][0])).toMatch(/Step 2 has a photo/);
    });

    it('Cancel deletes uploads from this edit; a crash draft is offered back', async () => {
        const onCancel = vi.fn();
        const { container, unmount } = render(<RecipeForm language="en" recipe={RECIPE} onSave={vi.fn()} onCancel={onCancel} draftKey="7" />);
        fireEvent.click(screen.getAllByLabelText('Add photo or video')[0]);
        await act(async () => { pick(container, [new File(['x'], 'a.jpg', { type: 'image/jpeg' })]); });
        await waitFor(() => expect(uploaded.length).toBe(1));
        await act(async () => { await new Promise(r => setTimeout(r, 700)); });   // draft debounce
        expect(localStorage.getItem('ddmau:recipeEditDraft:7')).toBeTruthy();
        unmount();                                                               // "crash"
        const r2 = render(<RecipeForm language="en" recipe={RECIPE} onSave={vi.fn()} onCancel={onCancel} draftKey="7" />);
        expect(r2.getByText(/unsaved changes from/)).toBeTruthy();
        fireEvent.click(r2.getByText('Restore'));
        expect(r2.container.querySelector('img[src="https://x/m1.jpg"]')).toBeTruthy();
        fireEvent.click(r2.getByText('Cancel'));
        expect(onCancel).toHaveBeenCalled();
        expect(localStorage.getItem('ddmau:recipeEditDraft:7')).toBeNull();
    });

    it('Cancel right after an upload deletes that file (it was never saved)', async () => {
        const { container } = render(<RecipeForm language="en" recipe={RECIPE} onSave={vi.fn()} onCancel={() => {}} />);
        fireEvent.click(screen.getAllByLabelText('Add photo or video')[1]);
        await act(async () => { pick(container, [new File(['x'], 'a.jpg', { type: 'image/jpeg' })]); });
        await waitFor(() => expect(uploaded.length).toBe(1));
        fireEvent.click(screen.getByText('Cancel'));
        expect(deleted).toEqual(['m1']);
    });
});
