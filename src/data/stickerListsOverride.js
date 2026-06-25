// Sticker-lists overrides — admin-editable layer on top of the
// static buildSheet.js protein / sauce / snack lists.
//
// Andrew 2026-05-20: "make the items all editable". The five flat
// lists (Bowl Proteins, Fried Rice Proteins, Pho Proteins, Sauces,
// Snacks) drive prep-time decisions and rotate over time — sauces
// come and go, vegan substitutes get added, seasonal proteins
// appear. Hardcoded JS isn't enough; admin needs to edit live.
//
// Design:
//   • buildSheet.js stays the canonical default (so a fresh install
//     and the Menu tab's Build Sheet view still show useful data).
//   • Admin edits → /config/sticker_lists. Each section is stored
//     as a full array — if the doc has `bowlProteins`, that REPLACES
//     the default; otherwise the default is used. Simple to reason
//     about, no merge semantics.
//   • Live subscription so every sticker page on every device sees
//     the same list within a second of an admin edit.
//   • All saves write an audit row to /audit so we can trace who
//     changed what.
//
// Schema: /config/sticker_lists =
//   {
//     bowlProteins?:        StickerRow[],
//     friedRiceProteins?:   StickerRow[],
//     phoProteins?:         StickerRow[],
//     sauces?:              StickerRow[],
//     snacks?:              StickerRow[],
//     updatedAt:  serverTimestamp,
//     updatedBy:  string,
//   }
//
// StickerRow = {
//   id:      string,    // stable per row (slug or random)
//   nameEn:  string,
//   nameEs:  string,
//   descEn?: string,
//   descEs?: string,
// }

import { db } from '../firebase';
import { doc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { recordAudit } from './audit';
import {
    BUILD_SHEET_PROTEINS,
    BUILD_SHEET_SAUCES,
    BUILD_SHEET_SWEETS_SNACKS,
    BUILD_SHEET_VEGETABLES,
    BUILD_SHEET_RICE_NOODLES,
    BUILD_SHEET_STOCKS,
    BUILD_SHEET_MADE_AHEAD,
    BUILD_SHEET_DRINKS,
} from './buildSheet';

// The editable sections — Andrew 2026-06-11: "too many items. alot
// of doubles. make sure there is only one of each item. categorize
// it by veggie, protein, noodles, rice and so on." The three
// overlapping per-category protein lists (bowlProteins /
// friedRiceProteins / phoProteins) collapsed into ONE deduped
// 'proteins' section; snacks deduped against Made Ahead. Keys match
// the Firestore doc fields AND the kind passed to the
// BuildSheetFlatSection renderer. (No /config/sticker_lists override
// doc existed at switchover — verified — so retiring the old keys
// needed no migration; subscribeStickerLists ignores unknown keys.)
export const STICKER_SECTIONS = Object.freeze([
    {
        key: 'proteins',
        kind: 'protein',
        titleEn: '🥩 Proteins',
        titleEs: '🥩 Proteínas',
        defaults: BUILD_SHEET_PROTEINS,
    },
    {
        key: 'vegetables',
        kind: 'topping',
        titleEn: '🥬 Veggies & Toppings',
        titleEs: '🥬 Vegetales y Toppings',
        defaults: BUILD_SHEET_VEGETABLES,
    },
    {
        key: 'riceNoodles',
        kind: 'base',
        titleEn: '🍜 Noodles & Rice',
        titleEs: '🍜 Fideos y Arroz',
        defaults: BUILD_SHEET_RICE_NOODLES,
    },
    {
        key: 'sauces',
        kind: 'sauce',
        titleEn: '🥢 Sauces & Dressings',
        titleEs: '🥢 Salsas y Aderezos',
        defaults: BUILD_SHEET_SAUCES,
    },
    {
        key: 'stocks',
        kind: 'broth',
        titleEn: '🍲 Broths & Stocks',
        titleEs: '🍲 Caldos',
        defaults: BUILD_SHEET_STOCKS,
    },
    {
        key: 'madeAhead',
        kind: 'side',
        titleEn: '🥟 Made Ahead',
        titleEs: '🥟 Pre-Hechos',
        defaults: BUILD_SHEET_MADE_AHEAD,
    },
    {
        key: 'snacks',
        kind: 'side',
        titleEn: '🍪 Sweets & Snacks',
        titleEs: '🍪 Dulces y Snacks',
        defaults: BUILD_SHEET_SWEETS_SNACKS,
    },
    {
        key: 'drinks',
        kind: 'drink',
        titleEn: '🧋 Drinks',
        titleEs: '🧋 Bebidas',
        defaults: BUILD_SHEET_DRINKS,
    },
]);

const STICKER_LISTS_DOC_REF = () => doc(db, 'config', 'sticker_lists');

// Default rows stamped ONCE, with DETERMINISTIC ids, at module load.
// The old behavior stamped them with makeStickerRowId (random tail)
// inside the snapshot callback — every snapshot regenerated fresh ids
// for every non-overridden section. Edit Mode's draft merge then saw
// zero id overlap, kept the old rows AND appended the "new" ones, so
// every untouched section DOUBLED on each save echo (and the dupes
// could get persisted). Stable identity also means the same array
// reference is reused across snapshots, so memo'd sections skip
// re-rendering on unrelated echoes. Found in review 2026-06-12.
const STAMPED_DEFAULTS = new Map(STICKER_SECTIONS.map(section => [
    section.key,
    section.defaults.map((row, i) => ({ ...row, id: row.id || `default-${section.key}-${i}` })),
]));
export function getStampedDefaults(sectionKey) {
    return STAMPED_DEFAULTS.get(sectionKey) || [];
}

// Subscribe to the override doc. Callback receives a `{ [key]:
// StickerRow[] }` object with merged lists (override if present —
// including an explicitly-saved EMPTY list, so an admin can clear a
// section without the defaults resurrecting — default otherwise).
export function subscribeStickerLists(callback) {
    return onSnapshot(STICKER_LISTS_DOC_REF(), (snap) => {
        const data = snap.exists() ? snap.data() : {};
        const merged = {};
        for (const section of STICKER_SECTIONS) {
            const override = data[section.key];
            merged[section.key] = Array.isArray(override)
                ? override.map(stamp)
                : STAMPED_DEFAULTS.get(section.key);
        }
        callback(merged);
    }, (err) => {
        console.warn('subscribeStickerLists error:', err);
        // Fall back to defaults so the page still renders.
        const merged = {};
        for (const section of STICKER_SECTIONS) {
            merged[section.key] = STAMPED_DEFAULTS.get(section.key);
        }
        callback(merged);
    });
}

// Save the full list for one section. Replaces whatever was there.
// Sanitizes inputs to a known shape so a buggy form doesn't write
// junk to Firestore.
export async function saveStickerList(sectionKey, items, byName) {
    if (!STICKER_SECTIONS.find(s => s.key === sectionKey)) {
        throw new Error(`unknown sticker section: ${sectionKey}`);
    }
    const clean = (Array.isArray(items) ? items : []).map((item, i) => ({
        id:     String(item.id || makeStickerRowId(`${sectionKey}-${item.nameEn || 'row'}-${i}`)).slice(0, 60),
        nameEn: String(item.nameEn || '').slice(0, 80).trim(),
        nameEs: String(item.nameEs || '').slice(0, 80).trim(),
        descEn: String(item.descEn || '').slice(0, 200).trim(),
        descEs: String(item.descEs || '').slice(0, 200).trim(),
    })).filter(r => r.nameEn || r.nameEs); // drop fully-empty rows
    await setDoc(STICKER_LISTS_DOC_REF(), {
        [sectionKey]: clean,
        updatedAt: serverTimestamp(),
        updatedBy: byName || 'unknown',
    }, { merge: true });
    recordAudit({
        action: 'sticker_lists.save',
        actorName: byName || 'unknown',
        targetType: 'sticker_list',
        targetId: sectionKey,
        details: { sectionKey, rowCount: clean.length },
    });
}

// Generate a stable, readable ID from a name (slug-like). Includes
// a short random tail so two rows with the same name don't collide.
export function makeStickerRowId(name) {
    const slug = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30);
    const tail = Math.random().toString(36).slice(2, 6);
    return slug ? `${slug}-${tail}` : `row-${tail}`;
}

// Stamp a missing id onto a row so React keys are stable.
function stamp(row) {
    if (row.id) return row;
    return { ...row, id: makeStickerRowId(row.nameEn || row.nameEs || 'row') };
}
