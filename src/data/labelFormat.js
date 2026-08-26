// Label format — global admin-editable settings for the date-sticker
// label layout. One Firestore doc at /config/label_format; every
// print path (Epson XML, Brother HTML, PrintLabelModal preview) reads
// from this so admin can change "what every sticker looks like" in
// one place.
//
// Andrew 2026-05-20: "make a label edit button so i can go in and
// edit all the labels format at once".
//
// What's configurable:
//   - Section visibility toggles (PREPPED label, time, title, use-by,
//     by-name, location, allergens, ingredients, notes, footer)
//   - Date number scale (3 / 4 / 5 — Epson size multipliers; the
//     Brother HTML CSS scales proportionally)
//   - Title scale (1 / 2 — Epson size multipliers)
//   - Text content overrides: PREPPED → "MADE"/"PREP", footer
//     "DD MAU" → custom text
//   - Date format: mm/dd/yy or dd/mm/yy
//   - Time format: 12h or 24h
//   - Show use-by weekday (e.g. "Wed")
//   - Default shelf life days

import { db } from '../firebase';
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp, deleteField } from 'firebase/firestore';
import { recordAudit } from './audit';

// 2026-07-30 (Andrew: "lets make 2 different formats one for the epson
// printer and one for the brother printer"). The two printers produce very
// different labels — the Epson TM-L100 is a continuous linerless receipt
// roll, the Brother QL-820NWB is a fixed 62×40mm die-cut sticker — so one
// shared layout always compromised both. Each now has its OWN doc.
//
// MIGRATION / FALLBACK: the Epson keeps the original `config/label_format`
// doc untouched, so nothing about the Epson changes. The Brother doc starts
// ABSENT, and while absent the Brother FOLLOWS the Epson doc — so shipping
// the split is a no-op on real labels. The first Brother save creates the
// doc and the two become independent forever after. Callers that need to
// know which state they're in get it from the subscribe callback's third
// `meta.following` argument.
const DOC_PATH = 'config/label_format';
const DOC_PATH_BROTHER = 'config/label_format_brother';

// Anything not 'brother' means the Epson doc — every legacy call site omits
// the argument and keeps working.
const isBrother = (printer) => printer === 'brother';
const pathFor = (printer) => (isBrother(printer) ? DOC_PATH_BROTHER : DOC_PATH);

// All default values. Used as the baseline that admin overrides.
// Any field NOT in the saved Firestore doc falls back here.
export const DEFAULT_LABEL_FORMAT = Object.freeze({
    // Section visibility
    showPreppedLabel: true,
    showTime:         true,
    showTitle:        true,
    showUseBy:        true,
    showByName:       true,
    showLocation:    true,
    showAllergens:    true,
    showIngredients:  true,
    showNotes:        true,
    showFooter:       true,
    showUseByBand:    true,   // giant "SAT" / discard-time band

    // Size scaling
    dateNumberScale: 5,    // Epson: width=height=5. Brother CSS: ~28% of label width
    titleScale:      2,    // Epson: width=height=2. Brother CSS: medium-large
    // Giant use-by band ("SAT" weekday / discard time). Ceiling — the
    // renderer still auto-shrinks so the text fits the roll. 4 was the
    // old hardcoded cap (Andrew 2026-07-27: "control more, like the SAT
    // or Time to discard").
    useByBandScale:  4,
    // 2026-07-27 "more control" batch — previously hardcoded:
    timeScale:       2,       // prep time under the date (1..4)
    metaScale:       1,       // Use by / By / Loc info lines (1..3)
    titleBold:       false,   // bold item name (name-first layout is always bold)
    showDividers:    true,    // the ==== / ---- rule lines
    // Print the item name in BOTH languages (smaller second line) so one
    // sticker reads for EN + ES staff (Andrew 2026-07-27).
    showTitleTranslation: false,
    // Size of that translated-name line (Andrew 2026-07-27: "the sticker
    // item name in spanish needs a size format too"). Max size — the
    // printer still width-fits long words down, same as the main title.
    title2Scale: 2,

    // 2026-07-27 "every text editable" batch (Andrew: "make every text
    // from the top to bottom editable for size to bold to italic, font
    // and so on") — per-block bold + size for every remaining line.
    // Defaults reproduce the old hardcoded output EXACTLY: blocks that
    // always printed em=true default bold ON, everything else OFF, all
    // new scales default 1. NO italic and NO font choice anywhere: the
    // TM-L100's ePOS-Print XML has no italic attribute (only em / ul /
    // width / height) and one built-in font — italic can't print.
    dateBold:        true,    // PREPPED label + date number (was hardcoded em)
    timeBold:        false,   // prep time line (was plain)
    metaBold:        false,   // Use by / By / Loc info lines (were plain)
    title2Bold:      false,   // translated-name line (was plain)
    bandBold:        true,    // giant use-by band (was hardcoded em)
    allergensBold:   true,    // ALLERGENS line (was hardcoded em)
    ingredientsBold: false,   // ingredient lines (were plain)
    notesBold:       false,   // notes line (was plain)
    footerBold:      true,    // footer (was hardcoded em)
    // 1..3 — like metaScale, each line still width-auto-fits the roll.
    allergensScale:   1,
    ingredientsScale: 1,
    notesScale:       1,
    footerScale:      1,

    // Text content
    preppedLabelTextEn: 'PREPPED',
    preppedLabelTextEs: 'HECHO',
    useByLabelTextEn:   'Use by',
    useByLabelTextEs:   'Caduca',
    footerText:         'DD MAU',

    // Format
    dateFormat:         'mm/dd/yy',   // or 'dd/mm/yy'
    timeFormat:         '12h',         // or '24h'
    showUseByWeekday:   true,

    // Defaults
    defaultShelfLifeDays: 5,

    // Per-KIND overrides (Andrew 2026-07-26: "change certain stickers to
    // be formatted differently — sanitizers with the item name larger").
    // Keyed by the sticker's kind ('chemical', 'status', 'protein', …) —
    // the kind rides on the recipe object into every print path. Each
    // entry shallow-merges over the base format for that kind only:
    //   { layout?: 'nameFirst', titleScale?: 1..8, dateNumberScale?: 2..8,
    //     rotate90?: true }
    kindFormats: {
        // 2026-08-11 (Andrew): CATERING — the first CUSTOMER-FACING label
        // kind. Big bold item name on top (nameFirst), Spanish name under
        // it, bold date, DD MAU branding footer — and none of the
        // internal-ops lines (no PREPPED, no prep time, no staff name, no
        // location, no use-by band). Andrew explicitly dropped the "Made
        // fresh for your event" footer line — branding only.
        // Seeded here (not in Firestore) so a fresh install prints right;
        // admin can still tune it per-kind in the Label Format editor —
        // mergeWithDefaults() below deep-merges saved kind entries OVER
        // this seed, so edits win field-by-field.
        catering: {
            layout: 'nameFirst',
            titleScale: 4,
            titleBold: true,
            // Andrew 2026-08-11 round 2: English-only on catering labels —
            // no Spanish second line.
            showTitleTranslation: false,
            // Black band with white brand text at the very top of the label
            // (Andrew: "the black window on the top with the white ddmau").
            showBrandBand: true,
            brandBandText: 'DD MAU',
            dateBold: true,
            // Round 3 (Andrew): no date on catering labels at all.
            showDate: false,
            showUseByBand: false,
            showPreppedLabel: false,
            showTime: false,
            showByName: false,
            showLocation: false,
            showIngredients: false,
            showNotes: false,
            showUseBy: false,
            showAllergens: true,
            footerText: 'DD MAU · DDMAUSTL.COM',
        },
        // 2026-08-11 (Andrew, "look 2 build it"): BOTTLES — retail 16oz
        // sauce bottle labels, the framed-premium look he picked from the
        // three mockups: double border frame, letterspaced DD MAU + ◆ ◆ ◆
        // ornament at the top, huge sauce name, the item's own 4-5 word
        // description, the PRINTING store's address (auto — the device
        // knows its location), DDMAUSTL.COM footer. No date, no internal
        // ops lines, English only — it's customer packaging.
        bottles: {
            layout: 'nameFirst',
            titleScale: 3,
            titleBold: true,
            showTitleTranslation: false,
            showFrame: true,
            headerText: 'DD MAU',
            showOrnament: true,
            showItemDesc: true,
            showAddress: true,
            showDate: false,
            showUseByBand: false,
            showPreppedLabel: false,
            showTime: false,
            showByName: false,
            showLocation: false,
            showIngredients: false,
            showNotes: false,
            showUseBy: false,
            showAllergens: false,
            footerText: 'DDMAUSTL.COM',
        },
    },
});

// Merge a saved label-format doc over the defaults. kindFormats needs a
// per-kind DEEP merge: a plain `{...DEFAULT, ...saved}` replaced the whole
// kindFormats object the moment an admin saved ANY per-kind tweak, silently
// wiping seeded kind defaults (like `catering` above) for every other kind.
// Per-kind, saved fields win over seeded fields.
export function mergeWithDefaults(saved) {
    const data = saved && typeof saved === 'object' ? saved : {};
    const merged = { ...DEFAULT_LABEL_FORMAT, ...data };
    const savedKinds = data.kindFormats && typeof data.kindFormats === 'object' ? data.kindFormats : {};
    const kinds = { ...DEFAULT_LABEL_FORMAT.kindFormats };
    for (const [k, v] of Object.entries(savedKinds)) {
        if (!v || typeof v !== 'object') continue;
        kinds[k] = { ...(kinds[k] || {}), ...v };
    }
    merged.kindFormats = kinds;
    return merged;
}

// ── Per-kind field whitelist (single source of truth) ────────────────
// Every field a kindFormats entry may carry, each with its sanitizer.
// ONE table drives BOTH the read-side cleaner (cleanKindFormats) and the
// save-side deleteField() sentinels in saveLabelFormat — by construction,
// any field that can be saved can also be REVERTED (2026-08 audit P1: the
// sentinel list used to be absent entirely, so a per-kind field removed
// from the editor's draft survived Firestore's merge:true deep-merge
// forever).
// A sanitizer returns the cleaned value, or undefined to drop the field.
const numClamp = (lo, hi) => (v) =>
    (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : undefined);
// Boolean both ways, not only-true (audit 2026-07-27 #5): a per-kind
// bold:false / show:false must be able to override a global ON.
const boolAny = (v) => (typeof v === 'boolean' ? v : undefined);
const strMax = (n) => (v) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const KIND_FIELD_SPECS = {
    layout:          (v) => (v === 'nameFirst' ? 'nameFirst' : undefined),
    titleScale:      numClamp(1, 8),
    dateNumberScale: numClamp(2, 8),
    useByBandScale:  numClamp(2, 8),
    timeScale:       numClamp(1, 4),
    metaScale:       numClamp(1, 3),
    titleBold:       boolAny,
    showTitleTranslation: boolAny,
    title2Scale:     numClamp(1, 6),
    // Per-kind giant use-by band control (weekday / discard-time line) —
    // only-false, as always (a per-kind entry can hide it, never force it).
    showUseByBand:   (v) => (v === false ? false : undefined),
    // 2026-08-11 (catering, customer-facing kind) — per-kind visibility
    // toggles + footer text. resolveLabelFormatForKind shallow-merges the
    // kind entry over the WHOLE format, so these override the globals for
    // that kind only.
    showDate:         boolAny,
    showPreppedLabel: boolAny,
    showTime:         boolAny,
    showByName:       boolAny,
    showLocation:     boolAny,
    showAllergens:    boolAny,
    showIngredients:  boolAny,
    showNotes:        boolAny,
    showFooter:       boolAny,
    showUseBy:        boolAny,
    showTitle:        boolAny,
    footerText:       strMax(60),
    // Brand band (black bar, white text, top of label) — catering et al.
    showBrandBand:    boolAny,
    brandBandText:    strMax(24),
    // Framed-premium elements (2026-08-11, bottles Look 2).
    showFrame:        boolAny,
    showOrnament:     boolAny,
    showItemDesc:     boolAny,
    showAddress:      boolAny,
    headerText:       strMax(24),
    // 2026-07-27 "every text editable" — per-kind bold + size for the
    // remaining blocks.
    dateBold:         boolAny,
    timeBold:         boolAny,
    metaBold:         boolAny,
    title2Bold:       boolAny,
    bandBold:         boolAny,
    allergensBold:    boolAny,
    ingredientsBold:  boolAny,
    notesBold:        boolAny,
    footerBold:       boolAny,
    allergensScale:   numClamp(1, 3),
    ingredientsScale: numClamp(1, 3),
    notesScale:       numClamp(1, 3),
    footerScale:      numClamp(1, 3),
};
export const KIND_FORMAT_FIELDS = Object.freeze(Object.keys(KIND_FIELD_SPECS));

// Sanitize a kindFormats map — only known fields, clamped.
export function cleanKindFormats(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object') continue;
        const entry = {};
        for (const field of KIND_FORMAT_FIELDS) {
            const clean = KIND_FIELD_SPECS[field](v[field]);
            if (clean !== undefined) entry[field] = clean;
        }
        // (rotate90 dropped 2026-07-27 — the TM-L100 ignored ePOS text
        // rotation on hardware; stale saved values are stripped here and
        // cleared server-side by saveLabelFormat's sentinels.)
        if (Object.keys(entry).length) out[String(k).slice(0, 24)] = entry;
    }
    return out;
}

// Live subscription. Callback gets the merged format (defaults +
// any saved overrides). Renderers + preview use this to update
// in real time when admin saves.
//
// The callback is invoked as cb(format, error): `error` is null on every
// normal delivery and carries the Firestore error ONLY on the one
// defaults-fallback delivery described below. Consumers that must not
// render defaults (getLabelFormatFast) just ignore any delivery with an
// error; the editor uses it to show a "showing defaults" warning.
// The third callback argument is `meta`: { following } is true only for the
// Brother while it has no doc of its own and is mirroring the Epson format.
export function subscribeLabelFormat(cb, printer = 'epson') {
    // 2026-07-30: the error handler used to report NOTHING at all, which is
    // right once a value has landed (a transient blip must not repaint the
    // editor with all-on defaults) but leaves a FIRST-snapshot failure
    // (offline open / rules hiccup) with no value ever delivered — the
    // editor's seededRef never flips and it sits on defaults pretending
    // they're the saved layout. Deliver defaults exactly once in that case,
    // flagged, so the UI can say so instead of lying.
    let delivered = false;
    const failOnce = (err) => {
        if (delivered) return;   // steady state: keep whatever the UI has
        delivered = true;
        cb({ ...DEFAULT_LABEL_FORMAT }, err || new Error('label_format unavailable'), { following: false });
    };

    if (!isBrother(printer)) {
        return onSnapshot(doc(db, DOC_PATH), (snap) => {
            delivered = true;
            const data = snap.exists() ? (snap.data() || {}) : {};
            cb(mergeWithDefaults(data), null, { following: false });
        }, (err) => {
            console.warn('label_format subscription failed:', err);
            failOnce(err);
        });
    }

    // Brother: watch BOTH docs. Its own doc wins whenever it exists; until
    // then it mirrors the Epson doc live.
    let bro;                 // undefined = no snapshot yet, null = doc absent
    let eps = null;
    let epsSeen = false;
    const emit = () => {
        if (bro === undefined) return;
        // While following we must NOT emit before the Epson doc has landed,
        // or the first delivery would be all-defaults and any consumer that
        // seeds once (the editor) would latch onto them as "the saved
        // layout" — the exact bug the seededRef fix was written to kill.
        if (!bro && !epsSeen) return;
        delivered = true;
        cb(mergeWithDefaults(bro || eps || {}), null, { following: !bro });
    };
    const unsubBrother = onSnapshot(doc(db, DOC_PATH_BROTHER), (snap) => {
        bro = snap.exists() ? (snap.data() || {}) : null;
        emit();
    }, (err) => {
        console.warn('label_format_brother subscription failed:', err);
        failOnce(err);
    });
    const unsubEpson = onSnapshot(doc(db, DOC_PATH), (snap) => {
        eps = snap.exists() ? (snap.data() || {}) : null;
        epsSeen = true;
        emit();
    }, (err) => {
        console.warn('label_format (brother fallback) subscription failed:', err);
        // Only fatal while we're actually depending on it.
        if (bro === null || bro === undefined) failOnce(err);
    });
    return () => { unsubBrother(); unsubEpson(); };
}

// Hot-path cached read — Andrew 2026-06-11: "the print for the
// stickers is kinda sticky". Every print awaited a fresh Firestore
// round-trip for this rarely-changing doc. First call starts a live
// subscription; every later call resolves instantly from the cached
// (always-current) value. Falls back to the one-shot read while the
// first snapshot is still in flight.
// One cache PER PRINTER — they're independent docs now, and sharing a single
// cache would serve whichever printed first to both.
const _fmtCaches = {
    epson:   { value: undefined, ready: false, started: false },
    brother: { value: undefined, ready: false, started: false },
};
export function getLabelFormatFast(printer = 'epson') {
    const key = isBrother(printer) ? 'brother' : 'epson';
    const cache = _fmtCaches[key];
    if (!cache.started) {
        cache.started = true;
        try {
            // 2026-07-30: ignore the flagged defaults-fallback delivery —
            // the print hot path must never cache defaults over the real
            // saved format; without a real snapshot it keeps falling back
            // to the one-shot read below, exactly as before.
            subscribeLabelFormat((fmt, err) => {
                if (err) return;
                cache.value = fmt; cache.ready = true;
            }, key);
        } catch { /* fall through to one-shot below */ }
    }
    if (cache.ready) return Promise.resolve(cache.value);
    return getLabelFormat(key).then((f) => {
        // Don't clobber a fresher snapshot that landed mid-flight.
        if (!cache.ready) { cache.value = f; cache.ready = true; }
        return cache.value;
    });
}

// One-shot read. Used by Cloud Function paths or anywhere we
// don't want a live subscription.
export async function getLabelFormat(printer = 'epson') {
    try {
        if (isBrother(printer)) {
            const bro = await getDoc(doc(db, DOC_PATH_BROTHER));
            if (bro.exists()) return mergeWithDefaults(bro.data() || {});
            // No Brother doc yet ⇒ follow the Epson one (see the header note).
        }
        const snap = await getDoc(doc(db, DOC_PATH));
        if (!snap.exists()) return { ...DEFAULT_LABEL_FORMAT };
        return mergeWithDefaults(snap.data() || {});
    } catch (e) {
        console.warn('label_format read failed:', e);
        return { ...DEFAULT_LABEL_FORMAT };
    }
}

export async function saveLabelFormat({ format, byName, printer = 'epson' }) {
    if (!format || typeof format !== 'object') throw new Error('format required');
    // Whitelist + sanitize each field so a malformed payload can't
    // corrupt the doc.
    const safe = {};
    const BOOL_FIELDS = ['showPreppedLabel', 'showTime', 'showTitle', 'showUseBy',
        'showByName', 'showLocation', 'showAllergens', 'showIngredients',
        'showNotes', 'showFooter', 'showUseByWeekday', 'showUseByBand',
        'titleBold', 'showDividers', 'showTitleTranslation',
        // 2026-07-27 "every text editable" per-block bold toggles.
        'dateBold', 'timeBold', 'metaBold', 'title2Bold', 'bandBold',
        'allergensBold', 'ingredientsBold', 'notesBold', 'footerBold'];
    const STRING_FIELDS = ['preppedLabelTextEn', 'preppedLabelTextEs',
        'useByLabelTextEn', 'useByLabelTextEs',
        'footerText', 'dateFormat', 'timeFormat'];
    const NUMBER_FIELDS = ['dateNumberScale', 'titleScale', 'useByBandScale',
        'timeScale', 'metaScale', 'title2Scale', 'defaultShelfLifeDays',
        // 2026-07-27 "every text editable" per-block size scales.
        'allergensScale', 'ingredientsScale', 'notesScale', 'footerScale'];

    for (const k of BOOL_FIELDS) {
        if (k in format) safe[k] = format[k] === true;
    }
    for (const k of STRING_FIELDS) {
        if (k in format && typeof format[k] === 'string') {
            safe[k] = String(format[k]).slice(0, 50);
        }
    }
    for (const k of NUMBER_FIELDS) {
        if (k in format && Number.isFinite(Number(format[k]))) {
            safe[k] = Math.max(1, Math.min(99, Number(format[k])));
        }
    }
    if ('kindFormats' in format) {
        // merge:true deep-merges maps, so anything the admin REMOVED
        // would silently survive in the doc forever — both a whole kind
        // override AND a single field reverted to default inside a kind
        // (2026-08 audit P1: the per-FIELD case had no sentinels at all,
        // so "revert to default" never persisted). Solve both with
        // explicit deleteField() sentinels — inside a merged map, the
        // sentinel deletes that key at its depth. (2026-07-27: replaced
        // a mergeFields-based whole-field replace that failed on device —
        // this keeps the battle-tested merge:true path every other save
        // uses.)
        const cleaned = cleanKindFormats(format.kindFormats);
        // Every kind a sticker section can carry — must stay a superset of
        // VALID_SECTION_KINDS in stickerListsOverride.js (not importable
        // without exporting it there; keep the two lists in sync).
        const KNOWN_KINDS = ['chemical', 'status', 'drink', 'protein',
            'topping', 'sauce', 'broth', 'base', 'side', 'other',
            'catering', 'bottles', 'garnish', 'note'];
        const out = {};
        for (const k of new Set([...KNOWN_KINDS, ...Object.keys(cleaned)])) {
            if (k in cleaned) {
                // Kind PRESENT in the draft: write its fields, and emit a
                // per-field delete sentinel for every whitelisted field the
                // draft no longer carries. NEVER mixed with the whole-kind
                // sentinel below — present/absent stay disjoint.
                const entry = { ...cleaned[k] };
                for (const f of KIND_FORMAT_FIELDS) {
                    if (!(f in entry)) entry[f] = deleteField();
                }
                // Legacy field, stripped on read since 2026-07-27 — clear
                // any stale saved value server-side too.
                entry.rotate90 = deleteField();
                out[k] = entry;
            } else {
                // Kind ABSENT from the draft: delete the whole map entry.
                out[k] = deleteField();
            }
        }
        safe.kindFormats = out;
    }
    safe.updatedAt = serverTimestamp();
    safe.updatedBy = byName || null;

    const targetId = isBrother(printer) ? 'label_format_brother' : 'label_format';
    await setDoc(doc(db, pathFor(printer)), safe, { merge: true });
    recordAudit({
        action: 'label_format.save',
        actorName: byName || 'admin',
        targetType: 'config',
        targetId,
        details: {
            printer: isBrother(printer) ? 'brother' : 'epson',
            changedKeys: Object.keys(safe).filter(k => k !== 'updatedAt' && k !== 'updatedBy'),
        },
    });
}

// Validate ranges + clamp on read. Some fields have specific
// constraints (Epson size 1..8). Apply them here so callers don't
// have to.
export function clampLabelFormat(format) {
    const f = { ...format };
    f.dateNumberScale = Math.max(2, Math.min(8, Number(f.dateNumberScale) || 5));
    // 8 = Epson max (2026-07-26 "make the item font larger" — was 4, which
    // silently undid the editor's bigger slider on save).
    f.titleScale = Math.max(1, Math.min(8, Number(f.titleScale) || 2));
    f.useByBandScale = Math.max(2, Math.min(8, Number(f.useByBandScale) || 4));
    f.timeScale = Math.max(1, Math.min(4, Number(f.timeScale) || 2));
    f.metaScale = Math.max(1, Math.min(3, Number(f.metaScale) || 1));
    f.title2Scale = Math.max(1, Math.min(6, Number(f.title2Scale) || 2));
    // 2026-07-27 "every text editable" scales (1..3, default 1).
    f.allergensScale = Math.max(1, Math.min(3, Number(f.allergensScale) || 1));
    f.ingredientsScale = Math.max(1, Math.min(3, Number(f.ingredientsScale) || 1));
    f.notesScale = Math.max(1, Math.min(3, Number(f.notesScale) || 1));
    f.footerScale = Math.max(1, Math.min(3, Number(f.footerScale) || 1));
    f.defaultShelfLifeDays = Math.max(1, Math.min(60, Number(f.defaultShelfLifeDays) || 5));
    if (f.kindFormats) f.kindFormats = cleanKindFormats(f.kindFormats);
    return f;
}
