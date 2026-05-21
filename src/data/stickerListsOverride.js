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
    BUILD_SHEET_BOWL_PROTEINS,
    BUILD_SHEET_FRIED_RICE_PROTEINS,
    BUILD_SHEET_PHO_PROTEINS,
    BUILD_SHEET_SAUCES,
    BUILD_SHEET_SNACKS,
} from './buildSheet';

// The five editable sections. Keys match the Firestore doc fields
// AND the kind passed to the BuildSheetFlatSection renderer. Add a
// new section by adding an entry here + a default list + a
// matching section in DateStickerPrinter's BuildSheetBrowse.
export const STICKER_SECTIONS = Object.freeze([
    {
        key: 'bowlProteins',
        kind: 'protein',
        titleEn: '🍤 Bowl Proteins',
        titleEs: '🍤 Proteínas de Bowls',
        defaults: BUILD_SHEET_BOWL_PROTEINS,
    },
    {
        key: 'friedRiceProteins',
        kind: 'protein',
        titleEn: '🍤 Fried Rice Proteins',
        titleEs: '🍤 Proteínas de Fried Rice',
        defaults: BUILD_SHEET_FRIED_RICE_PROTEINS,
    },
    {
        key: 'phoProteins',
        kind: 'protein',
        titleEn: '🍤 Pho Proteins',
        titleEs: '🍤 Proteínas de Pho',
        defaults: BUILD_SHEET_PHO_PROTEINS,
    },
    {
        key: 'sauces',
        kind: 'sauce',
        titleEn: '🥢 Sauces',
        titleEs: '🥢 Salsas',
        defaults: BUILD_SHEET_SAUCES,
    },
    {
        key: 'snacks',
        kind: 'side',
        titleEn: '🥟 Snacks',
        titleEs: '🥟 Snacks',
        defaults: BUILD_SHEET_SNACKS,
    },
]);

const STICKER_LISTS_DOC_REF = () => doc(db, 'config', 'sticker_lists');

// Subscribe to the override doc. Callback receives a `{ [key]:
// StickerRow[] }` object with merged lists (override if present,
// default otherwise). Defaults are also given stable ids so the
// UI can key off them before the admin saves anything.
export function subscribeStickerLists(callback) {
    return onSnapshot(STICKER_LISTS_DOC_REF(), (snap) => {
        const data = snap.exists() ? snap.data() : {};
        const merged = {};
        for (const section of STICKER_SECTIONS) {
            const override = data[section.key];
            if (Array.isArray(override) && override.length > 0) {
                merged[section.key] = override.map(stamp);
            } else {
                merged[section.key] = section.defaults.map((row, i) => stamp({
                    ...row,
                    id: row.id || makeStickerRowId(`${section.key}-${row.nameEn}-${i}`),
                }));
            }
        }
        callback(merged);
    }, (err) => {
        console.warn('subscribeStickerLists error:', err);
        // Fall back to defaults so the page still renders.
        const merged = {};
        for (const section of STICKER_SECTIONS) {
            merged[section.key] = section.defaults.map((row, i) => stamp({
                ...row,
                id: row.id || makeStickerRowId(`${section.key}-${row.nameEn}-${i}`),
            }));
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
