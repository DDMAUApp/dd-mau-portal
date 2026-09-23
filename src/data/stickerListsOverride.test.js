// Tests for the pure parts of stickerListsOverride — the name-dedupe key
// and section resolution rules that the 2026-07-26 audit fixes lean on.
import { describe, it, expect } from 'vitest';
import { stickerNameKey, resolveSections, STICKER_SECTIONS } from './stickerListsOverride';

describe('stickerNameKey', () => {
    it('is case- and whitespace-insensitive', () => {
        expect(stickerNameKey('  Fish  Sauce ')).toBe(stickerNameKey('fish sauce'));
    });
    it('is accent-insensitive (Jalapeño == Jalapeno)', () => {
        expect(stickerNameKey('Jalapeño')).toBe(stickerNameKey('Jalapeno'));
        expect(stickerNameKey('Salsa Picánte')).toBe(stickerNameKey('salsa picante'));
    });
    it('handles empty/nullish', () => {
        expect(stickerNameKey('')).toBe('');
        expect(stickerNameKey(null)).toBe('');
        expect(stickerNameKey(undefined)).toBe('');
    });
});

describe('resolveSections', () => {
    it('returns built-ins when no override', () => {
        expect(resolveSections({})).toBe(STICKER_SECTIONS);
        expect(resolveSections(null)).toBe(STICKER_SECTIONS);
    });
    it('re-appends dropped built-ins so Proteins can never disappear', () => {
        const out = resolveSections({ sectionsOverride: [{ key: 'c_special', kind: 'other', titleEn: 'Specials', titleEs: 'Especiales' }] });
        expect(out.some(s => s.key === 'proteins')).toBe(true);
        expect(out.some(s => s.key === 'c_special')).toBe(true);
    });
    it('drops malformed keys and duplicates', () => {
        const out = resolveSections({ sectionsOverride: [
            { key: '9bad', kind: 'other', titleEn: 'x' },
            { key: 'c_ok', kind: 'other', titleEn: 'ok' },
            { key: 'c_ok', kind: 'other', titleEn: 'dupe' },
        ] });
        expect(out.filter(s => s.key === 'c_ok')).toHaveLength(1);
        expect(out.some(s => s.key === '9bad')).toBe(false);
    });
    it('falls back to key when a custom title is blank', () => {
        const out = resolveSections({ sectionsOverride: [{ key: 'c_x', kind: 'other', titleEn: '', titleEs: '' }] });
        const cx = out.find(s => s.key === 'c_x');
        expect(cx.titleEn).toBe('c_x');
    });
});

// ── Edit Mode draft ⇄ live list merge (2026-09-23 review M8) ──────────
// The old inline mergeDrafts kept every draft row verbatim, so a device
// in Edit Mode reverted other devices' renames / shelf lives and
// resurrected their deletions on its next whole-section save.
import { mergeEditDraft, settledEditIds } from './stickerListsOverride';

const row = (id, nameEn, extra = {}) => ({ id, nameEn, nameEs: nameEn, descEn: '', descEs: '', ...extra });

describe('mergeEditDraft', () => {
    it('untouched rows take the SERVER version (remote rename + shelf life stick)', () => {
        const draft = [row('a', 'Chicken'), row('b', 'Beef')];
        const server = [row('a', 'Grilled Chicken', { shelfLifeDays: 3 }), row('b', 'Beef')];
        const out = mergeEditDraft(draft, server, { touchedIds: new Set() });
        expect(out[0]).toEqual(server[0]);
        expect(out.map(r => r.nameEn)).toEqual(['Grilled Chicken', 'Beef']);
    });

    it('touched rows keep the typed text but follow the server for fields Edit Mode does not own', () => {
        const draft = [row('a', 'Chick'), row('b', 'Beef')];
        const server = [row('a', 'Chicken', { shelfLifeDays: 3, thawedDays: 2 }), row('b', 'Beef')];
        const [a] = mergeEditDraft(draft, server, { touchedIds: new Set(['a']) });
        expect(a.nameEn).toBe('Chick');
        expect(a.shelfLifeDays).toBe(3);
        expect(a.thawedDays).toBe(2);
    });

    it('drops rows another device deleted — untouched OR merely edited here', () => {
        const draft = [row('a', 'A'), row('b', 'B'), row('c', 'C')];
        const server = [row('a', 'A')];
        const out = mergeEditDraft(draft, server, { touchedIds: new Set(['c']) });
        expect(out.map(r => r.id)).toEqual(['a']);
    });

    it('keeps rows ADDED here that the server has not seen yet', () => {
        const draft = [row('a', 'A'), row('new1', '')];
        const out = mergeEditDraft(draft, [row('a', 'A')], { addedIds: new Set(['new1']), touchedIds: new Set(['new1']) });
        expect(out.map(r => r.id)).toEqual(['a', 'new1']);
    });

    it('appends rows another device added, after the draft order', () => {
        const draft = [row('b', 'B'), row('a', 'A')];
        const server = [row('a', 'A'), row('z', 'Z'), row('b', 'B')];
        expect(mergeEditDraft(draft, server).map(r => r.id)).toEqual(['b', 'a', 'z']);
    });

    it('a row deleted here is not resurrected by a stale echo (2026-05-24 rule kept)', () => {
        const draft = [row('a', 'A')];
        const staleServer = [row('a', 'A'), row('gone', 'Gone')];
        expect(mergeEditDraft(draft, staleServer, { deletedIds: new Set(['gone']) }).map(r => r.id)).toEqual(['a']);
    });

    it('tolerates missing inputs', () => {
        expect(mergeEditDraft(undefined, undefined)).toEqual([]);
        expect(mergeEditDraft([row('a', 'A')], null)).toEqual([]);
        expect(mergeEditDraft(null, [row('a', 'A')]).map(r => r.id)).toEqual(['a']);
    });

    it('the reported scenario: idle Edit Mode on device A no longer reverts device B', () => {
        // A opened Edit Mode, then B renamed a row, set a shelf life, and
        // deleted another. A types in a third row → A's next save writes the
        // MERGED draft, which must carry B's changes.
        const aDraft = [row('p1', 'Chicken'), row('p2', 'Shrimp'), row('p3', 'Tofu')];
        const afterB = [row('p1', 'Lemongrass Chicken', { shelfLifeDays: 3 }), row('p3', 'Tofu')];
        const merged = mergeEditDraft(aDraft, afterB, { touchedIds: new Set(['p3']) });
        merged[1] = { ...merged[1], nameEn: 'Fried Tofu' };   // A's edit
        expect(merged).toEqual([
            row('p1', 'Lemongrass Chicken', { shelfLifeDays: 3 }),
            { ...row('p3', 'Tofu'), nameEn: 'Fried Tofu' },
        ]);
    });
});

describe('settledEditIds', () => {
    it('a row whose text now equals the server is settled; a differing or missing one is not', () => {
        const draft = [row('a', 'Chicken'), row('b', 'Bee'), row('c', 'C')];
        const server = [row('a', 'Chicken', { shelfLifeDays: 3 }), row('b', 'Beef')];
        expect([...settledEditIds(draft, server)]).toEqual(['a']);
    });
    it('treats missing and empty text as equal', () => {
        expect([...settledEditIds([{ id: 'a', nameEn: 'X' }], [{ id: 'a', nameEn: 'X', nameEs: '', descEn: '' }])]).toEqual(['a']);
    });
});
