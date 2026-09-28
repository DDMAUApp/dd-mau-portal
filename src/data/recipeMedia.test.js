import { describe, it, expect } from 'vitest';
import {
    hasServiceSection, mediaAt, mediaCount, shiftMediaOnRemove, shiftMediaOnSplice,
    addMediaItem, removeMediaItem, compactListWithMedia, applyVideoResults, mediaPathFor, allMediaItems,
} from './recipeMedia';

const img = (id) => ({ id, kind: 'image', url: `https://x/${id}.jpg`, path: `recipe_media/${id}.jpg` });

describe('recipeMedia', () => {
    it('service section is detected only when it has words', () => {
        expect(hasServiceSection({ ingredientsEn: ['1 cup rice'] })).toBe(false);
        expect(hasServiceSection({ serviceIngredientsEn: [''], serviceInstructionsEn: ['  '] })).toBe(false);
        expect(hasServiceSection({ serviceInstructionsEs: ['Sirve'] })).toBe(true);
    });

    it('add / read / remove items on a line', () => {
        let m = addMediaItem({}, 'step', 2, img('a'));
        m = addMediaItem(m, 'step', 2, img('b'));
        expect(mediaAt(m, 'step', 2).map(x => x.id)).toEqual(['a', 'b']);
        expect(mediaAt(m, 'step', 0)).toEqual([]);
        m = removeMediaItem(m, 'step', 2, 'a');
        expect(mediaAt(m, 'step', 2).map(x => x.id)).toEqual(['b']);
        m = removeMediaItem(m, 'step', 2, 'b');
        expect(m.step).toBeUndefined();
        expect(mediaCount(m)).toBe(0);
    });

    it('removing a row drops its media and shifts later rows up', () => {
        let m = addMediaItem({}, 'ing', 0, img('zero'));
        m = addMediaItem(m, 'ing', 1, img('one'));
        m = addMediaItem(m, 'ing', 3, img('three'));
        m = addMediaItem(m, 'step', 1, img('otherBucket'));
        const r = shiftMediaOnRemove(m, 'ing', 1);
        expect(mediaAt(r, 'ing', 0)[0].id).toBe('zero');
        expect(mediaAt(r, 'ing', 1)).toEqual([]);
        expect(mediaAt(r, 'ing', 2)[0].id).toBe('three');
        expect(mediaAt(r, 'step', 1)[0].id).toBe('otherBucket');   // other lists untouched
    });

    it('multi-line paste keeps media on the pasted row and shifts rows below', () => {
        let m = addMediaItem({}, 'step', 1, img('pasteRow'));
        m = addMediaItem(m, 'step', 2, img('below'));
        const r = shiftMediaOnSplice(m, 'step', 1, 3);
        expect(mediaAt(r, 'step', 1)[0].id).toBe('pasteRow');
        expect(mediaAt(r, 'step', 4)[0].id).toBe('below');
        expect(mediaAt(r, 'step', 2)).toEqual([]);
    });

    it('save compaction follows lines when blanks are dropped', () => {
        const bucket = { 0: [img('a')], 2: [img('c')], 3: [img('d')] };
        const r = compactListWithMedia(['Boil water', '', 'Add noodles', 'Drain'], bucket);
        expect(r.list).toEqual(['Boil water', 'Add noodles', 'Drain']);
        expect(r.bucket['0'][0].id).toBe('a');
        expect(r.bucket['1'][0].id).toBe('c');
        expect(r.bucket['2'][0].id).toBe('d');
        expect(r.blankWithMedia).toEqual([]);
    });

    it('a blank line carrying a photo is reported (not silently lost)', () => {
        const r = compactListWithMedia(['Step one', '   '], { 1: [img('orphan')] });
        expect(r.blankWithMedia).toEqual([2]);
        expect(r.list).toEqual(['Step one']);
    });

    it('server video results are copied onto matching items only', () => {
        const media = {
            step: { 0: [{ id: 'v1', kind: 'video', url: 'o.mov' }, { id: 'v2', kind: 'video', url: 'p.mov', playbackUrl: 'keep.mp4' }] },
        };
        const out = applyVideoResults(media, {
            v1: { playbackUrl: 'v1_720.mp4', posterUrl: 'v1_poster.jpg', playbackWidth: 720, playbackHeight: 1280 },
            v2: { playbackUrl: 'SHOULD_NOT_REPLACE' },
        });
        const [a, b] = out.step['0'];
        expect(a).toMatchObject({ playbackUrl: 'v1_720.mp4', posterUrl: 'v1_poster.jpg', thumbUrl: 'v1_poster.jpg', w: 720, h: 1280 });
        expect(b.playbackUrl).toBe('keep.mp4');
        expect(applyVideoResults(media, {})).toBe(media);
        expect(allMediaItems(out).length).toBe(2);
    });

    it('storage paths', () => {
        expect(mediaPathFor('1_ab', 'image', 'IMG_1.HEIC')).toBe('recipe_media/1_ab.jpg');
        expect(mediaPathFor('1_ab', 'video', 'IMG_1.MOV')).toBe('recipe_media/1_ab.mov');
        expect(mediaPathFor('1_ab', 'video', 'clip')).toBe('recipe_media/1_ab.mp4');
        expect(mediaPathFor('1_ab', 'video', '')).toBe('recipe_media/1_ab.mp4');
    });
});
