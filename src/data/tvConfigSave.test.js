// TV config saves (2026-09-28 — Andrew: "i resize the images to fit and
// change the scrolling announcements but it keeps reverting"; webster-photos
// flip-flopped v48→v59 between two editors' whole-form saves).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ docs: new Map(), sets: [] }));
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('./audit', () => ({ recordAudit: vi.fn() }));
vi.mock('./firestoreRevive', () => ({ watchdogWrite: (p) => p, watchdogRead: (p) => p, watchdogTransaction: (p) => p }));
vi.mock('firebase/firestore', () => {
    const DELETE = { __delete: true };
    return {
        doc: (_db, ...segs) => ({ path: segs.join('/') }),
        collection: (_db, ...segs) => ({ path: segs.join('/') }),
        query: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), where: vi.fn(),
        onSnapshot: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn(), setDoc: vi.fn(), updateDoc: vi.fn(), deleteDoc: vi.fn(),
        addDoc: vi.fn(), writeBatch: vi.fn(),
        serverTimestamp: () => ({ __ts: true }),
        deleteField: () => DELETE,
        runTransaction: async (_db, fn) => fn({
            get: async (ref) => ({ exists: () => h.docs.has(ref.path), data: () => h.docs.get(ref.path) }),
            set: (ref, data, opts) => {
                // Mirror Firestore: deleteField() is illegal in a non-merge set.
                if (!opts?.merge && Object.values(data).some(v => v && v.__delete)) {
                    throw new Error('deleteField() cannot be used with set() unless you pass {merge:true}');
                }
                h.sets.push({ path: ref.path, data });
                h.docs.set(ref.path, data);
            },
            update: vi.fn(),
        }),
    };
});

import { mergeTvLiveSave, saveTvConfig, publishTvConfigDraft, rollbackTvConfig, copyTvConfigToLocation } from './tvConfigs';

const LIVE = {
    tvId: 'webster-photos', label: 'Webster Photos', location: 'webster', mode: 'image',
    imageFit: 'cover', promoStrip: { enabled: true, textEn: 'Welcome — fresh flavors' },
    imageUrls: ['a.jpg', 'b.jpg'], contrastBoost: 1.08, alertsMuted: true,
    reloadRequestedAt: { seconds: 1 }, publishedVersion: 48,
};
const editorPayload = (over) => ({
    label: 'Webster Photos', location: 'webster', mode: 'image',
    imageFit: 'cover', promoStrip: { enabled: true, textEn: 'Welcome — fresh flavors' },
    imageUrls: ['a.jpg', 'b.jpg'], ...over,
});

beforeEach(() => { h.docs.clear(); h.sets.length = 0; });

describe('mergeTvLiveSave', () => {
    it("a second editor that only changed the fit keeps the other editor's new ticker text", () => {
        const base = LIVE;                                   // both editors opened on v48
        const server = { ...LIVE, promoStrip: { enabled: true, textEn: 'Try our new fall Specials' } };  // editor A saved text
        const { next, kept } = mergeTvLiveSave(editorPayload({ imageFit: 'contain' }), base, server);   // editor B saves fit
        expect(next.imageFit).toBe('contain');
        expect(next.promoStrip.textEn).toBe('Try our new fall Specials');
        expect(kept).toEqual(['promoStrip']);
    });
    it('a field the editor really changed always wins', () => {
        const server = { ...LIVE, imageFit: 'contain' };
        const { next } = mergeTvLiveSave(editorPayload({ imageFit: 'cover', promoStrip: { enabled: false, textEn: 'x' } }), LIVE, server);
        expect(next.promoStrip).toEqual({ enabled: false, textEn: 'x' });
    });
    it('fields the editor does not manage survive every save', () => {
        const { next } = mergeTvLiveSave(editorPayload({}), LIVE, LIVE);
        expect(next.contrastBoost).toBe(1.08);
        expect(next.alertsMuted).toBe(true);
        expect(next.reloadRequestedAt).toEqual({ seconds: 1 });
    });
    it('explicit null still clears (how the editor removes a field)', () => {
        const { next } = mergeTvLiveSave(editorPayload({ promoStrip: null }), LIVE, LIVE);
        expect(next.promoStrip).toBeNull();
    });
    it('object key order does not count as a change', () => {
        const base = { ...LIVE, promoStrip: { textEn: 'A', enabled: true } };
        const server = { ...LIVE, promoStrip: { textEn: 'B', enabled: true } };
        const { next } = mergeTvLiveSave(editorPayload({ promoStrip: { enabled: true, textEn: 'A' } }), base, server);
        expect(next.promoStrip.textEn).toBe('B');
    });
});

describe('saveTvConfig / publish / rollback writes', () => {
    it('save: only the changed field lands, the rest stays newest', async () => {
        h.docs.set('tv_configs/webster-photos', { ...LIVE, promoStrip: { enabled: true, textEn: 'Try our new fall Specials' }, publishedVersion: 49 });
        const res = await saveTvConfig({ tvId: 'webster-photos', payload: editorPayload({ imageFit: 'contain' }), byName: 'Andrew', base: LIVE });
        const root = h.docs.get('tv_configs/webster-photos');
        expect(root.imageFit).toBe('contain');
        expect(root.promoStrip.textEn).toBe('Try our new fall Specials');
        expect(root.contrastBoost).toBe(1.08);
        expect(root.publishedVersion).toBe(50);
        expect(res.keptFromServer).toEqual(['promoStrip']);
    });
    it('publishing a draft works (used to throw on deleteField) and keeps unmanaged fields', async () => {
        h.docs.set('tv_configs/webster', { ...LIVE, tvId: 'webster', draftSnapshot: editorPayload({ imageFit: 'contain' }), draftSavedAt: 1 });
        await publishTvConfigDraft({ tvId: 'webster', byName: 'Andrew' });
        const root = h.docs.get('tv_configs/webster');
        expect(root.imageFit).toBe('contain');
        expect(root.contrastBoost).toBe(1.08);
        expect(root.draftSnapshot).toBeUndefined();
        expect(root.publishedVersion).toBe(49);
    });
    it('rollback works (used to throw on deleteField)', async () => {
        h.docs.set('tv_configs/webster', { ...LIVE, tvId: 'webster' });
        h.docs.set('tv_configs/webster/versions/v40', { ...editorPayload({ imageFit: 'contain' }), version: 40, reason: 'live_save' });
        await rollbackTvConfig({ tvId: 'webster', versionId: 'v40', byName: 'Andrew' });
        const root = h.docs.get('tv_configs/webster');
        expect(root.imageFit).toBe('contain');
        expect(root.contrastBoost).toBe(1.08);
        expect(root.version).toBeUndefined();
    });
});

// webster-photos 2026-11-04: an editor opened on v60 overwrote the picture
// uploaded in v61. Values below are the shape of the real v60/v61/v62.
describe('pictures stay together (imageUrls + imageLayers)', () => {
    const recipe = { originalUrl: 'p2.png', crop: null, adjust: {}, texts: [], bursts: [] };
    const v60 = { ...LIVE, imageUrls: ['fall-edit.jpg'], imageLayers: [recipe] };
    const v61 = { ...LIVE, imageUrls: ['potstickers.png'], imageLayers: [] };
    const form = (over) => editorPayload({ imageUrls: ['fall-edit.jpg'], imageLayers: [recipe], ...over });

    it('a stale editor that re-baked a picture is refused instead of replacing the newer one', () => {
        expect(() => mergeTvLiveSave(form({ imageUrls: ['fall-edit-2.jpg'] }), v60, v61))
            .toThrow(expect.objectContaining({ code: 'tv/stale-editor' }));
    });
    it('the refusal writes nothing to the live doc', async () => {
        h.docs.set('tv_configs/webster-photos', { ...v61, publishedVersion: 61 });
        await expect(saveTvConfig({ tvId: 'webster-photos', payload: form({ imageUrls: ['fall-edit-2.jpg'] }), byName: 'Andrew', base: v60 }))
            .rejects.toMatchObject({ code: 'tv/stale-editor' });
        const root = h.docs.get('tv_configs/webster-photos');
        expect(root.imageUrls).toEqual(['potstickers.png']);
        expect(root.publishedVersion).toBe(61);
    });
    it('an editor opened on the current version edits pictures normally', () => {
        const { next, kept } = mergeTvLiveSave(editorPayload({ imageUrls: ['potstickers-2.jpg'], imageLayers: [recipe] }), v61, v61);
        expect(next.imageUrls).toEqual(['potstickers-2.jpg']);
        expect(next.imageLayers).toEqual([recipe]);
        expect(kept).toEqual([]);
    });
    it('a stale editor that only changed the fit still saves, and keeps the newer pictures', () => {
        const { next, kept } = mergeTvLiveSave(form({ imageFit: 'contain' }), v60, v61);
        expect(next.imageFit).toBe('contain');
        expect(next.imageUrls).toEqual(['potstickers.png']);
        expect(next.imageLayers).toEqual([]);
        expect(kept.sort()).toEqual(['imageLayers', 'imageUrls']);
    });
    it("never leaves a recipe from another picture next to this editor's list", () => {
        const base = { ...LIVE, imageUrls: ['a.jpg'], imageLayers: [{ originalUrl: 'a' }] };
        const server = { ...LIVE, imageUrls: ['c.jpg', 'd.jpg'], imageLayers: [{ originalUrl: 'c' }, null] };
        expect(() => mergeTvLiveSave(editorPayload({ imageUrls: ['a2.jpg'], imageLayers: [{ originalUrl: 'a' }] }), base, server))
            .toThrow(expect.objectContaining({ code: 'tv/stale-editor' }));
    });
    it('a doc that never had imageLayers does not read as a picture change', () => {
        const base = { ...LIVE, imageUrls: ['a.jpg'] };                         // no imageLayers key
        const server = { ...LIVE, imageUrls: ['a.jpg', 'b.jpg'] };
        const { next, kept } = mergeTvLiveSave(editorPayload({ imageUrls: ['a.jpg'], imageLayers: [], imageFit: 'contain' }), base, server);
        expect(next.imageFit).toBe('contain');
        expect(next.imageUrls).toEqual(['a.jpg', 'b.jpg']);
        expect('imageLayers' in next && next.imageLayers === undefined).toBe(false);
        expect(kept).toEqual(['imageUrls']);
    });
    it('the same save landing twice is not a conflict', () => {
        const same = form({ imageUrls: ['x.jpg'], imageLayers: [] });
        const server = { ...LIVE, imageUrls: ['x.jpg'], imageLayers: [] };
        expect(mergeTvLiveSave(same, v60, server).next.imageUrls).toEqual(['x.jpg']);
    });
    it('publish, rollback and copies have no opened base, so they are never refused', () => {
        expect(() => mergeTvLiveSave(form({ imageUrls: ['z.jpg'] }), null, v61)).not.toThrow();
    });
});

describe('imageBackground through every save path', () => {
    const fall = { kind: 'fall', motion: true };
    it('live save writes it', async () => {
        h.docs.set('tv_configs/webster-photos', { ...LIVE });
        await saveTvConfig({ tvId: 'webster-photos', payload: editorPayload({ imageBackground: fall }), byName: 'A', base: LIVE });
        expect(h.docs.get('tv_configs/webster-photos').imageBackground).toEqual(fall);
    });
    it('a save that omits it (untouched picker) keeps the one on the server', async () => {
        h.docs.set('tv_configs/webster-photos', { ...LIVE, imageBackground: fall });
        await saveTvConfig({ tvId: 'webster-photos', payload: editorPayload({ imageFit: 'contain' }), byName: 'A', base: LIVE });
        expect(h.docs.get('tv_configs/webster-photos').imageBackground).toEqual(fall);
    });
    it('explicit null clears it', async () => {
        h.docs.set('tv_configs/webster-photos', { ...LIVE, imageBackground: fall });
        const base = { ...LIVE, imageBackground: fall };
        await saveTvConfig({ tvId: 'webster-photos', payload: editorPayload({ imageBackground: null }), byName: 'A', base });
        expect(h.docs.get('tv_configs/webster-photos').imageBackground).toBeNull();
    });
    it('a draft carries it and publish promotes it', async () => {
        h.docs.set('tv_configs/webster', { ...LIVE, tvId: 'webster', draftSnapshot: editorPayload({ imageBackground: fall }), draftSavedAt: 1 });
        await publishTvConfigDraft({ tvId: 'webster', byName: 'A' });
        expect(h.docs.get('tv_configs/webster').imageBackground).toEqual(fall);
    });
    it('rollback restores it', async () => {
        h.docs.set('tv_configs/webster', { ...LIVE, tvId: 'webster', imageBackground: { kind: 'sky' } });
        h.docs.set('tv_configs/webster/versions/v40', { ...editorPayload({ imageBackground: fall }), version: 40, reason: 'live_save' });
        await rollbackTvConfig({ tvId: 'webster', versionId: 'v40', byName: 'A' });
        expect(h.docs.get('tv_configs/webster').imageBackground).toEqual(fall);
    });
    it('rollback to a version from before a background was picked goes back to black', async () => {
        h.docs.set('tv_configs/webster', { ...LIVE, tvId: 'webster', imageBackground: { kind: 'snow', motion: false } });
        h.docs.set('tv_configs/webster/versions/v40', { ...editorPayload({ imageFit: 'contain' }), version: 40, reason: 'live_save' });
        await rollbackTvConfig({ tvId: 'webster', versionId: 'v40', byName: 'A' });
        const root = h.docs.get('tv_configs/webster');
        expect(root.imageBackground).toBeNull();
        expect(root.imageFit).toBe('contain');
    });
    it('a live save with no key still keeps it (the rollback rule stays in rollback)', () => {
        const server = { ...LIVE, imageBackground: fall };
        expect(mergeTvLiveSave(editorPayload({}), LIVE, server).next.imageBackground).toEqual(fall);
    });
    it('copy to the other location keeps it', async () => {
        const res = await copyTvConfigToLocation({ source: { ...LIVE, imageBackground: fall }, targetLocation: 'maryland', existingIds: [], byName: 'A' });
        expect(h.docs.get(`tv_configs/${res.tvId}`).imageBackground).toEqual(fall);
    });
});
