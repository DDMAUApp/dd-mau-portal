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
import { doc, setDoc, onSnapshot, serverTimestamp, runTransaction, deleteField } from 'firebase/firestore';
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
    {
        // 2026-07-24 (Andrew): chemical labels — spray bottles, sanitizer
        // buckets, etc. Same editable-list machinery as the food sections;
        // starter defaults below, admin curates via Edit Mode.
        key: 'chemicals',
        kind: 'chemical',
        titleEn: '🧪 Chemicals',
        titleEs: '🧪 Químicos',
        defaults: [
            { nameEn: 'Sanitizer', nameEs: 'Desinfectante' },
            { nameEn: 'Bleach Solution', nameEs: 'Solución de Cloro' },
            { nameEn: 'Degreaser', nameEs: 'Desengrasante' },
            { nameEn: 'Glass Cleaner', nameEs: 'Limpiavidrios' },
            { nameEn: 'Dish Soap', nameEs: 'Jabón de Trastes' },
            { nameEn: 'Floor Cleaner', nameEs: 'Limpiador de Pisos' },
        ],
    },
    {
        // 2026-07-24 (Andrew): status labels — "stuff like use first, do
        // not use." Rotation/condition flags, not items.
        key: 'statusLabels',
        kind: 'status',
        titleEn: '⚠️ Use First / Status',
        titleEs: '⚠️ Usar Primero / Estado',
        defaults: [
            { nameEn: 'USE FIRST', nameEs: 'USAR PRIMERO' },
            { nameEn: 'DO NOT USE', nameEs: 'NO USAR' },
            { nameEn: 'THAWING', nameEs: 'DESCONGELANDO' },
            { nameEn: 'COOLING', nameEs: 'ENFRIANDO' },
            { nameEn: 'DISCARD', nameEs: 'DESECHAR' },
            { nameEn: 'NOT FOR SALE', nameEs: 'NO PARA VENTA' },
        ],
    },
    {
        // 2026-08-11 (Andrew): CATERING — customer-facing stickers for
        // catering orders (sauce cups, app trays, protein trays, tray
        // items, bases). Built from the live catering menu
        // (src/data/catering.js). Prints with the customer-facing
        // 'catering' label format (big bold name + date + DD MAU footer —
        // see kindFormats.catering in labelFormat.js). Andrew's edits at
        // review: proteins WITHOUT the "Lemongrass" prefix (matches the
        // catering menu naming), Vietnamese Egg Rolls labeled (Pork).
        // Descriptions deliberately empty — nothing internal should ride
        // onto a customer label.
        key: 'catering',
        kind: 'catering',
        titleEn: '🎉 Catering',
        titleEs: '🎉 Catering',
        defaults: [
            // Sauce cups
            { nameEn: 'Vietnamese Vinaigrette', nameEs: 'Vinagreta Vietnamita' },
            { nameEn: 'Peanut Sauce',           nameEs: 'Salsa de Cacahuate' },
            { nameEn: 'Hoisin',                 nameEs: 'Hoisin' },
            { nameEn: 'Sweet Chili',            nameEs: 'Chile Dulce' },
            { nameEn: 'DD Sauce',               nameEs: 'Salsa DD' },
            { nameEn: 'Spicy DD',               nameEs: 'DD Picante' },
            // Apps & finger food
            { nameEn: 'Crab Rangoons',               nameEs: 'Crab Rangoons' },
            { nameEn: 'Vietnamese Egg Rolls (Pork)', nameEs: 'Rollos Vietnamitas (Cerdo)' },
            { nameEn: 'Vegetarian Egg Rolls',        nameEs: 'Rollos Vegetarianos' },
            { nameEn: 'Spring Rolls',                nameEs: 'Rollos de Primavera' },
            { nameEn: 'Bao Sliders',                 nameEs: 'Mini Baos' },
            { nameEn: 'Bánh Mì',                     nameEs: 'Bánh Mì' },
            // Protein trays
            { nameEn: 'Chicken',    nameEs: 'Pollo' },
            { nameEn: 'Pork',       nameEs: 'Puerco' },
            { nameEn: 'Steak',      nameEs: 'Res' },
            { nameEn: 'Shrimp',     nameEs: 'Camarón' },
            { nameEn: 'Tofu',       nameEs: 'Tofu' },
            { nameEn: 'Veggie',     nameEs: 'Vegetal' },
            { nameEn: 'Vegan Beef', nameEs: 'Res Vegana' },
            // Trays & items
            { nameEn: 'Fried Rice — Plain',   nameEs: 'Arroz Frito — Solo' },
            { nameEn: 'Fried Rice — Chicken', nameEs: 'Arroz Frito — Pollo' },
            { nameEn: 'Fried Rice — Pork',    nameEs: 'Arroz Frito — Puerco' },
            { nameEn: 'Fried Rice — Steak',   nameEs: 'Arroz Frito — Res' },
            { nameEn: 'Fried Rice — Shrimp',  nameEs: 'Arroz Frito — Camarón' },
            { nameEn: 'Fried Rice — Tofu',    nameEs: 'Arroz Frito — Tofu' },
            { nameEn: 'Mini Bowls',           nameEs: 'Mini Tazones' },
            { nameEn: 'DD Mau Sampler',       nameEs: 'Muestra DD Mau' },
            // Bases
            { nameEn: 'Vermicelli Noodles', nameEs: 'Fideos Vermicelli' },
            { nameEn: 'Jasmine Rice',       nameEs: 'Arroz Jazmín' },
            { nameEn: 'Fresh Salad',        nameEs: 'Ensalada Fresca' },
        ],
    },
    {
        // 2026-08-11 (Andrew): BOTTLES — retail 16oz sauce bottles. Fully
        // customer-facing labels (Look 2 "framed premium" — see
        // labelFormat.js kindFormats.bottles). descEn is the 4-5 word
        // customer description PRINTED on the label (grounded in the real
        // recipes) — unlike other sections where desc is internal-only.
        key: 'bottles',
        kind: 'bottles',
        titleEn: '🍾 Bottles',
        titleEs: '🍾 Botellas',
        defaults: [
            { nameEn: 'Vietnamese Vinaigrette',       nameEs: 'Vinagreta Vietnamita',        descEn: 'Sweet, tangy, garlic-chili classic' },
            { nameEn: 'Vegan Vietnamese Vinaigrette', nameEs: 'Vinagreta Vietnamita Vegana', descEn: 'Plant-based sweet and tangy' },
            { nameEn: 'Peanut Dressing',              nameEs: 'Aderezo de Cacahuate',        descEn: 'Creamy hoisin-peanut dipping sauce' },
            { nameEn: 'Spicy Peanut Dressing',        nameEs: 'Aderezo de Cacahuate Picante', descEn: 'Creamy peanut, cayenne kick' },
            { nameEn: 'Hoisin',                       nameEs: 'Hoisin',                      descEn: 'Rich, sweet-savory hoisin blend' },
            { nameEn: 'DD Dressing',                  nameEs: 'Aderezo DD',                  descEn: 'House aioli, pickled tang' },
            { nameEn: 'Spicy DD',                     nameEs: 'DD Picante',                  descEn: 'House aioli, sriracha heat' },
            { nameEn: 'Sweet Chili',                  nameEs: 'Chile Dulce',                 descEn: 'Classic Thai-style sweet heat' },
            { nameEn: 'Creamy Sweet Chili',           nameEs: 'Chile Dulce Cremoso',         descEn: 'Sweet chili, whipped creamy' },
            { nameEn: 'Buffalo Sweet Chili',          nameEs: 'Chile Dulce Buffalo',         descEn: 'Sweet chili meets buffalo' },
            { nameEn: 'Sweet Garlic Sauce',           nameEs: 'Salsa de Ajo Dulce',          descEn: 'Sticky-sweet soy garlic glaze' },
        ],
    },
    {
        // Catch-all category — Andrew 2026-06-25: "always have an add rows".
        // Starts empty; the editor always shows a "+ Add row" at the section
        // bottom (even when empty), so staff/admin can add any one-off sticker
        // item here anytime without touching the other lists.
        key: 'other',
        kind: 'other',
        titleEn: '📦 Other',
        titleEs: '📦 Otros',
        defaults: [],
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

// ── Dynamic sections (Andrew 2026-07-24: "edit the category names and be
// able to add a category") ─────────────────────────────────────────────
// The doc's optional `sectionsOverride` array is the FULL ordered section
// list: built-ins (possibly retitled) + admin-added custom sections
// ({key, kind, titleEn, titleEs}). Absent → the hardcoded STICKER_SECTIONS.
// Built-in sections that a bad save dropped are re-appended, so the
// Proteins list can never disappear; only CUSTOM sections are deletable.
const VALID_SECTION_KINDS = [
    'base', 'topping', 'protein', 'sauce', 'broth', 'side', 'garnish',
    'note', 'drink', 'other', 'chemical', 'status', 'catering', 'bottles',
];
export function resolveSections(data) {
    const ov = Array.isArray(data?.sectionsOverride) ? data.sectionsOverride : null;
    if (!ov || !ov.length) return STICKER_SECTIONS;
    const seen = new Set();
    const out = [];
    for (const s of ov) {
        const key = String(s?.key || '').trim();
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || seen.has(key)) continue;
        seen.add(key);
        const builtin = STICKER_SECTIONS.find(b => b.key === key);
        out.push({
            key,
            kind: VALID_SECTION_KINDS.includes(s.kind) ? s.kind : (builtin?.kind || 'other'),
            titleEn: String(s.titleEn || builtin?.titleEn || key).slice(0, 60),
            titleEs: String(s.titleEs || s.titleEn || builtin?.titleEs || key).slice(0, 60),
            defaults: builtin?.defaults || [],
        });
    }
    for (const b of STICKER_SECTIONS) {
        if (!seen.has(b.key)) out.push(b);
    }
    return out;
}

// Persist the section list (order + titles + custom sections).
// Runs in a TRANSACTION so a deleted custom category's item list can't be
// orphaned: any custom `c_*` key dropped from the list has its doc field
// removed, and if a cook slipped items into it between the admin's
// empty-check and this save, those rows are moved into 'other' instead of
// becoming invisible forever (audit 2026-07-26 finding 5).
export async function saveSections(sections, byName) {
    const seen = new Set();
    const clean = (Array.isArray(sections) ? sections : []).map((s) => {
        const key = String(s?.key || '').trim();
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || seen.has(key)) return null;
        seen.add(key);
        // trim BEFORE the falsy check — a whitespace-only title used to
        // pass `||` and persist as '' (rendered as the raw key).
        const tEn = String(s.titleEn ?? '').trim();
        const tEs = String(s.titleEs ?? '').trim();
        return {
            key,
            kind: VALID_SECTION_KINDS.includes(s.kind) ? s.kind : 'other',
            titleEn: (tEn || key).slice(0, 60),
            titleEs: (tEs || tEn || key).slice(0, 60),
        };
    }).filter(Boolean);
    if (clean.length === 0) throw new Error('sections list cannot be empty');
    let rescued = 0;
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(STICKER_LISTS_DOC_REF());
        const data = snap.exists() ? snap.data() : {};
        const prev = resolveSections(data);
        const keptKeys = new Set(clean.map(s => s.key));
        const update = {
            sectionsOverride: clean,
            updatedAt: serverTimestamp(),
            updatedBy: byName || 'unknown',
        };
        // Custom sections dropped by this save: delete their list field; any
        // rows still in it get rescued into 'other' (deduped by id).
        let other = null; // lazily-built next value of the 'other' field
        for (const p of prev) {
            if (keptKeys.has(p.key) || STICKER_SECTIONS.some(b => b.key === p.key)) continue;
            const orphans = Array.isArray(data[p.key]) ? data[p.key] : [];
            if (orphans.length > 0) {
                if (other === null) {
                    other = Array.isArray(data.other) ? [...data.other] : [...(STAMPED_DEFAULTS.get('other') || [])];
                }
                const haveIds = new Set(other.map(r => r?.id));
                for (const r of orphans) {
                    if (!haveIds.has(r?.id)) { other.push(r); rescued++; }
                }
            }
            update[p.key] = deleteField();
        }
        if (other !== null) update.other = other;
        tx.set(STICKER_LISTS_DOC_REF(), update, { merge: true });
    });
    recordAudit({
        action: 'sticker_lists.sections',
        actorName: byName || 'unknown',
        targetType: 'sticker_list',
        targetId: 'sectionsOverride',
        details: { count: clean.length, keys: clean.map(s => s.key), rescuedToOther: rescued },
    });
}

// Subscribe to the override doc. Callback receives (mergedLists, sections):
// mergedLists = `{ [key]: StickerRow[] }` (override if present — including
// an explicitly-saved EMPTY list, so an admin can clear a section without
// the defaults resurrecting — default otherwise), sections = the resolved
// dynamic section list. Existing single-arg callers just ignore arg 2.
// Identity cache (2026-07-26 perf audit): every snapshot used to mint a
// FRESH array for each overridden section (`override.map(stamp)`), so any
// write to the doc — including Edit Mode's own debounced echoes — changed
// every section's `items` identity and defeated the section memos the UI
// relies on. Reuse the previous array whenever a section's serialized
// content is unchanged. (Also keeps stamp()'s random ids stable across
// echoes for rows that arrived without one.) Module-level: all subscribers
// watch the same single doc.
const _sectionArrCache = new Map();     // key -> { json, arr }
let _sectionsCache = { json: null, arr: STICKER_SECTIONS };

// Resolve one doc-shaped object into { merged, sections } through the
// identity caches. Shared by the live snapshot handler AND the device
// cache below, so a cached paint followed by an identical snapshot
// reuses the exact same array identities (memos never churn).
function _resolveDoc(data) {
    const sectionsJson = JSON.stringify(data.sectionsOverride ?? null);
    if (_sectionsCache.json !== sectionsJson) {
        _sectionsCache = { json: sectionsJson, arr: resolveSections(data) };
    }
    const sections = _sectionsCache.arr;
    const merged = {};
    for (const section of sections) {
        const override = data[section.key];
        if (Array.isArray(override)) {
            const json = JSON.stringify(override);
            const hit = _sectionArrCache.get(section.key);
            if (hit && hit.json === json) {
                merged[section.key] = hit.arr;
            } else {
                const arr = override.map(stamp);
                _sectionArrCache.set(section.key, { json, arr });
                merged[section.key] = arr;
            }
        } else {
            merged[section.key] = STAMPED_DEFAULTS.get(section.key) || [];
        }
    }
    return { merged, sections };
}

// Device cache — last-known lists (Andrew 2026-07-27: "the items I added
// myself don't load right away"). On a cold open the first paint used the
// factory defaults until the Firestore round trip landed; now the previous
// visit's lists render SYNCHRONOUSLY and the live snapshot replaces them.
// Only the array fields are cached (Timestamps don't JSON round-trip).
const STICKER_CACHE_KEY = 'ddmau:stickerLists:v1';

export function subscribeStickerLists(callback) {
    try {
        const raw = localStorage.getItem(STICKER_CACHE_KEY);
        if (raw) {
            const cached = JSON.parse(raw);
            if (cached && typeof cached === 'object') {
                const { merged, sections } = _resolveDoc(cached);
                callback(merged, sections);
            }
        }
    } catch { /* private mode / corrupt cache — defaults paint instead */ }
    return onSnapshot(STICKER_LISTS_DOC_REF(), (snap) => {
        const data = snap.exists() ? snap.data() : {};
        const { merged, sections } = _resolveDoc(data);
        callback(merged, sections);
        try {
            const toCache = {};
            for (const [k, v] of Object.entries(data)) {
                if (Array.isArray(v)) toCache[k] = v;
            }
            localStorage.setItem(STICKER_CACHE_KEY, JSON.stringify(toCache));
        } catch { /* quota / private mode — nonfatal */ }
    }, (err) => {
        console.warn('subscribeStickerLists error:', err);
        // Fall back to defaults so the page still renders.
        const merged = {};
        for (const section of STICKER_SECTIONS) {
            merged[section.key] = STAMPED_DEFAULTS.get(section.key);
        }
        callback(merged, STICKER_SECTIONS);
    });
}

// Save the full list for one section. Replaces whatever was there.
// Sanitizes inputs to a known shape so a buggy form doesn't write
// junk to Firestore.
function assertSectionKey(sectionKey) {
    // Key-shape validation instead of a fixed-list check (2026-07-24) —
    // sections are dynamic now, so any well-formed key is saveable.
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(String(sectionKey || ''))) {
        throw new Error(`bad sticker section key: ${sectionKey}`);
    }
}

function cleanRows(sectionKey, items) {
    return (Array.isArray(items) ? items : []).map((item, i) => {
        const row = {
            id:     String(item.id || makeStickerRowId(`${sectionKey}-${item.nameEn || 'row'}-${i}`)).slice(0, 60),
            nameEn: String(item.nameEn || '').slice(0, 80).trim(),
            nameEs: String(item.nameEs || '').slice(0, 80).trim(),
            descEn: String(item.descEn || '').slice(0, 200).trim(),
            descEs: String(item.descEs || '').slice(0, 200).trim(),
        };
        // Per-item shelf life (days) — feeds the date sticker's use-by date so
        // each item gets the RIGHT default instead of one global number. Only
        // written when set (1–60); omitted rows fall back to the category default.
        const sd = Number(item.shelfLifeDays);
        if (Number.isFinite(sd) && sd > 0) row.shelfLifeDays = Math.min(60, Math.max(1, Math.floor(sd)));
        // Hour-based life (2026-07-26 feature #2): 1–96 hours, overrides the
        // day clock in the print modal (hot-hold / line items / sanitizer).
        const sh = Number(item.shelfLifeHours);
        if (Number.isFinite(sh) && sh > 0) row.shelfLifeHours = Math.min(96, Math.max(1, Math.floor(sh)));
        // Thawed life (feature #6): days on the clock once pulled from the
        // freezer — enables the Fresh/Thawed toggle in the print modal.
        const td = Number(item.thawedDays);
        if (Number.isFinite(td) && td > 0) row.thawedDays = Math.min(30, Math.max(1, Math.floor(td)));
        return row;
    }).filter(r => r.nameEn || r.nameEs); // drop fully-empty rows
}

// Accent/case/space-insensitive name key for duplicate checks — so
// "Jalapeño" and "jalapeno " count as the same item.
export function stickerNameKey(s) {
    return String(s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function saveStickerList(sectionKey, items, byName) {
    assertSectionKey(sectionKey);
    const clean = cleanRows(sectionKey, items);
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

// Append ONE row to a section — transactionally, so two devices adding at
// the same moment can't clobber each other (audit 2026-07-26 finding 3:
// full-array last-write-wins lost one of the adds). Dedupes by normalized
// name against the CURRENT server array. Returns 'added' | 'duplicate'.
export async function addStickerRow(sectionKey, { nameEn, nameEs }, byName) {
    assertSectionKey(sectionKey);
    const en = String(nameEn || '').trim();
    if (!en) throw new Error('item name required');
    let outcome = 'added';
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(STICKER_LISTS_DOC_REF());
        const data = snap.exists() ? snap.data() : {};
        const current = Array.isArray(data[sectionKey])
            ? data[sectionKey]
            : (STAMPED_DEFAULTS.get(sectionKey) || []);
        const key = stickerNameKey(en);
        if (current.some(r => stickerNameKey(r?.nameEn) === key)) {
            outcome = 'duplicate';
            return;
        }
        const clean = cleanRows(sectionKey, [...current, { nameEn: en, nameEs: String(nameEs || '').trim() }]);
        tx.set(STICKER_LISTS_DOC_REF(), {
            [sectionKey]: clean,
            updatedAt: serverTimestamp(),
            updatedBy: byName || 'unknown',
        }, { merge: true });
    });
    if (outcome === 'added') {
        recordAudit({
            action: 'sticker_lists.add_item',
            actorName: byName || 'unknown',
            targetType: 'sticker_list',
            targetId: sectionKey,
            details: { sectionKey, nameEn: en },
        });
    }
    return outcome;
}

// Move ONE row between sections in a single atomic write — both fields live
// on the same doc, so the append-to-target and remove-from-source can never
// land separately (audit 2026-07-26 finding 2: the old two-step move could
// strand the row in both sections, or — raced by a stale debounced save —
// in neither). Dedupes by normalized name in the target.
export async function moveStickerRow(fromKey, toKey, row, byName) {
    assertSectionKey(fromKey);
    assertSectionKey(toKey);
    if (fromKey === toKey || !row?.id) return false;
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(STICKER_LISTS_DOC_REF());
        const data = snap.exists() ? snap.data() : {};
        const from = Array.isArray(data[fromKey]) ? data[fromKey] : (STAMPED_DEFAULTS.get(fromKey) || []);
        const to   = Array.isArray(data[toKey])   ? data[toKey]   : (STAMPED_DEFAULTS.get(toKey)   || []);
        // Prefer the SERVER's copy of the row (it may carry fields — e.g.
        // shelfLifeDays — the caller's edit-draft stripped); fall back to
        // the caller's row when the server hasn't seen it yet.
        const live = from.find(r => r?.id === row.id) || row;
        const nameKey = stickerNameKey(live.nameEn);
        const dupe = to.some(r => stickerNameKey(r?.nameEn) === nameKey);
        const nextFrom = cleanRows(fromKey, from.filter(r => r?.id !== row.id));
        const nextTo = dupe ? cleanRows(toKey, to) : cleanRows(toKey, [...to, live]);
        tx.set(STICKER_LISTS_DOC_REF(), {
            [fromKey]: nextFrom,
            [toKey]: nextTo,
            updatedAt: serverTimestamp(),
            updatedBy: byName || 'unknown',
        }, { merge: true });
    });
    recordAudit({
        action: 'sticker_lists.move_item',
        actorName: byName || 'unknown',
        targetType: 'sticker_list',
        targetId: toKey,
        details: { fromKey, toKey, rowId: row.id, nameEn: row.nameEn || '' },
    });
    return true;
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
