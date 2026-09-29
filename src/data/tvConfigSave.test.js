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

import { mergeTvLiveSave, saveTvConfig, publishTvConfigDraft, rollbackTvConfig } from './tvConfigs';

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
