// Pins the 2026-07-30 Epson/Brother format split (Andrew: "lets make 2
// different formats one for the epson printer and one for the brother
// printer").
//
// The load-bearing property is the MIGRATION: the Brother has no doc of its
// own on day one, and while that's true it must mirror the Epson doc exactly
// — shipping the split must not restyle a single real label. The first
// Brother save detaches the two forever.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake Firestore: a doc-path → data map plus the live listeners on each path.
const docs = new Map();
const listeners = new Map();          // path → Set<{onNext,onErr}>

const snapFor = (path) => ({
    exists: () => docs.has(path),
    data: () => docs.get(path),
});
const emit = (path) => {
    for (const l of (listeners.get(path) || [])) l.onNext(snapFor(path));
};
/** Write a doc and push it to every live listener. */
const setDocData = (path, data) => { docs.set(path, data); emit(path); };
const clearDocData = (path) => { docs.delete(path); emit(path); };

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('./audit', () => ({ recordAudit: vi.fn() }));

// Mirror real Firestore setDoc(..., { merge: true }) semantics: nested maps
// DEEP-merge (they are not replaced wholesale), and a deleteField() sentinel
// removes its key at whatever depth it appears. The old fake did a top-level
// shallow merge that replaced kindFormats wholesale — which masked the exact
// per-kind-revert-never-persists bug the sentinel tests below pin.
const DELETE = '__delete__';
const isPlainObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const mergeInto = (base, patch) => {
    const out = { ...(base || {}) };
    for (const [k, v] of Object.entries(patch || {})) {
        if (v === DELETE) { delete out[k]; continue; }
        if (isPlainObj(v)) out[k] = mergeInto(isPlainObj(out[k]) ? out[k] : {}, v);
        else out[k] = v;
    }
    return out;
};

vi.mock('firebase/firestore', () => ({
    // doc(db, 'a/b') → the path string itself is our handle.
    doc: (_db, path) => path,
    getDoc: async (path) => snapFor(path),
    setDoc: async (path, data) => {
        const { updatedAt, ...rest } = data;
        setDocData(path, mergeInto(docs.get(path), rest));
    },
    onSnapshot: (path, onNext, onErr) => {
        const entry = { onNext, onErr };
        if (!listeners.has(path)) listeners.set(path, new Set());
        listeners.get(path).add(entry);
        // Firestore delivers an initial snapshot; do it synchronously so the
        // tests stay deterministic.
        onNext(snapFor(path));
        return () => listeners.get(path).delete(entry);
    },
    serverTimestamp: () => 'ts',
    deleteField: () => '__delete__',
}));

const EPSON = 'config/label_format';
const BROTHER = 'config/label_format_brother';

const { subscribeLabelFormat, getLabelFormat, saveLabelFormat, DEFAULT_LABEL_FORMAT } =
    await import('./labelFormat');

beforeEach(() => {
    docs.clear();
    listeners.clear();
});

describe('two independent format docs', () => {
    it('reads the Epson doc for the Epson printer', async () => {
        setDocData(EPSON, { titleScale: 7 });
        const f = await getLabelFormat('epson');
        expect(f.titleScale).toBe(7);
    });

    it('reads the Brother doc for the Brother printer once it exists', async () => {
        setDocData(EPSON, { titleScale: 7 });
        setDocData(BROTHER, { titleScale: 2 });
        expect((await getLabelFormat('brother')).titleScale).toBe(2);
        // ...and the Epson is untouched by that.
        expect((await getLabelFormat('epson')).titleScale).toBe(7);
    });

    it('defaults to the Epson doc when no printer is passed (legacy callers)', async () => {
        setDocData(EPSON, { titleScale: 7 });
        setDocData(BROTHER, { titleScale: 2 });
        expect((await getLabelFormat()).titleScale).toBe(7);
    });
});

describe('Brother follows the Epson until it has its own doc', () => {
    it('one-shot read falls back to the Epson doc', async () => {
        setDocData(EPSON, { titleScale: 7, footerText: 'DD MAU' });
        const f = await getLabelFormat('brother');
        expect(f.titleScale).toBe(7);
        expect(f.footerText).toBe('DD MAU');
    });

    it('subscription reports following:true and mirrors the Epson doc', () => {
        setDocData(EPSON, { titleScale: 7 });
        const cb = vi.fn();
        const unsub = subscribeLabelFormat(cb, 'brother');
        const [fmt, err, meta] = cb.mock.calls.at(-1);
        expect(err).toBeNull();
        expect(meta.following).toBe(true);
        expect(fmt.titleScale).toBe(7);
        unsub();
    });

    it('never emits bare defaults before the Epson doc lands', () => {
        // Nothing written yet: the Brother snapshot says "absent", but the
        // Epson snapshot hasn't been consulted. Emitting here would hand the
        // editor all-on defaults and it would latch them as "the saved
        // layout" — the bug the seededRef fix exists to prevent.
        const cb = vi.fn();
        // Both docs absent → both initial snapshots fire → one emit, and by
        // then the Epson has been seen, so the value is legitimately defaults.
        const unsub = subscribeLabelFormat(cb, 'brother');
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0].titleScale).toBe(DEFAULT_LABEL_FORMAT.titleScale);
        unsub();
    });

    it('live-tracks later Epson edits while still following', () => {
        setDocData(EPSON, { titleScale: 7 });
        const cb = vi.fn();
        const unsub = subscribeLabelFormat(cb, 'brother');
        setDocData(EPSON, { titleScale: 3 });
        const [fmt, , meta] = cb.mock.calls.at(-1);
        expect(fmt.titleScale).toBe(3);
        expect(meta.following).toBe(true);
        unsub();
    });

    it('stops following the moment a Brother format is saved', async () => {
        setDocData(EPSON, { titleScale: 7 });
        const cb = vi.fn();
        const unsub = subscribeLabelFormat(cb, 'brother');
        expect(cb.mock.calls.at(-1)[2].following).toBe(true);

        await saveLabelFormat({ format: { titleScale: 2 }, byName: 'Andrew', printer: 'brother' });

        const [fmt, , meta] = cb.mock.calls.at(-1);
        expect(meta.following).toBe(false);
        expect(fmt.titleScale).toBe(2);

        // The Epson doc must NOT have been touched by a Brother save.
        expect(docs.get(EPSON).titleScale).toBe(7);
        unsub();
    });

    it('a detached Brother ignores later Epson edits', () => {
        setDocData(EPSON, { titleScale: 7 });
        setDocData(BROTHER, { titleScale: 2 });
        const cb = vi.fn();
        const unsub = subscribeLabelFormat(cb, 'brother');
        setDocData(EPSON, { titleScale: 5 });
        expect(cb.mock.calls.at(-1)[0].titleScale).toBe(2);
        unsub();
    });
});

describe('saveLabelFormat targets the right doc', () => {
    it('writes the Epson doc by default', async () => {
        await saveLabelFormat({ format: { titleScale: 4 }, byName: 'Andrew' });
        expect(docs.get(EPSON).titleScale).toBe(4);
        expect(docs.has(BROTHER)).toBe(false);
    });

    it('writes the Brother doc when asked', async () => {
        await saveLabelFormat({ format: { titleScale: 4 }, byName: 'Andrew', printer: 'brother' });
        expect(docs.get(BROTHER).titleScale).toBe(4);
        expect(docs.has(EPSON)).toBe(false);
    });
});

describe('Epson subscription is unaffected by the split', () => {
    it('emits the Epson doc with following:false', () => {
        setDocData(EPSON, { titleScale: 7 });
        const cb = vi.fn();
        const unsub = subscribeLabelFormat(cb, 'epson');
        const [fmt, err, meta] = cb.mock.calls.at(-1);
        expect(fmt.titleScale).toBe(7);
        expect(err).toBeNull();
        expect(meta.following).toBe(false);
        unsub();
    });

    it('ignores the Brother doc entirely', () => {
        setDocData(EPSON, { titleScale: 7 });
        setDocData(BROTHER, { titleScale: 2 });
        const cb = vi.fn();
        const unsub = subscribeLabelFormat(cb, 'epson');
        expect(cb.mock.calls.at(-1)[0].titleScale).toBe(7);
        unsub();
    });
});

// ── Per-kind revert persistence (2026-08 audit P1) ─────────────────────
// setDoc merge:true deep-merges nested maps, so a per-kind field the admin
// REVERTED (removed from the draft) used to survive server-side forever.
// saveLabelFormat now emits deleteField() sentinels for every whitelisted
// per-kind field absent from a present kind — these tests pin that.
describe('per-kind overrides revert cleanly', () => {
    it('removing one field from a still-present kind deletes it server-side', async () => {
        // Admin sets a per-kind override…
        await saveLabelFormat({
            format: { kindFormats: { protein: { titleScale: 7, titleBold: true } } },
            byName: 'Andrew',
        });
        expect((await getLabelFormat()).kindFormats.protein.titleScale).toBe(7);
        // …then reverts titleScale to default (field gone from the draft,
        // kind still present via titleBold).
        await saveLabelFormat({
            format: { kindFormats: { protein: { titleBold: true } } },
            byName: 'Andrew',
        });
        const f = await getLabelFormat();
        expect(f.kindFormats.protein.titleBold).toBe(true);
        expect(f.kindFormats.protein.titleScale).toBeUndefined();
    });

    it('a catering tweak falls back to the SEEDED value once removed', async () => {
        const seeded = DEFAULT_LABEL_FORMAT.kindFormats.catering.titleScale;
        await saveLabelFormat({
            format: { kindFormats: { catering: { titleScale: seeded + 2, showBrandBand: true } } },
            byName: 'Andrew',
        });
        expect((await getLabelFormat()).kindFormats.catering.titleScale).toBe(seeded + 2);
        await saveLabelFormat({
            format: { kindFormats: { catering: { showBrandBand: true } } },
            byName: 'Andrew',
        });
        // Deleted server-side ⇒ mergeWithDefaults falls back to the seed.
        expect(docs.get(EPSON).kindFormats.catering.titleScale).toBeUndefined();
        expect((await getLabelFormat()).kindFormats.catering.titleScale).toBe(seeded);
    });

    it('removing the whole kind override still deletes the map entry', async () => {
        await saveLabelFormat({
            format: { kindFormats: { protein: { titleScale: 7 } } },
            byName: 'Andrew',
        });
        await saveLabelFormat({ format: { kindFormats: {} }, byName: 'Andrew' });
        expect(docs.get(EPSON).kindFormats.protein).toBeUndefined();
        expect((await getLabelFormat()).kindFormats.protein).toBeUndefined();
    });

    it('clears stale overrides for the newer kinds (catering/bottles/garnish/note)', async () => {
        setDocData(EPSON, {
            kindFormats: {
                bottles: { titleScale: 8 },
                garnish: { titleScale: 8 },
                note:    { titleScale: 8 },
            },
        });
        await saveLabelFormat({ format: { kindFormats: {} }, byName: 'Andrew' });
        const saved = docs.get(EPSON);
        expect(saved.kindFormats?.bottles).toBeUndefined();
        expect(saved.kindFormats?.garnish).toBeUndefined();
        expect(saved.kindFormats?.note).toBeUndefined();
    });

    it('clears a stale legacy rotate90 on any save of a present kind', async () => {
        setDocData(EPSON, { kindFormats: { chemical: { rotate90: true, titleScale: 6 } } });
        await saveLabelFormat({
            format: { kindFormats: { chemical: { titleScale: 6 } } },
            byName: 'Andrew',
        });
        expect(docs.get(EPSON).kindFormats.chemical.rotate90).toBeUndefined();
        expect(docs.get(EPSON).kindFormats.chemical.titleScale).toBe(6);
    });
});
