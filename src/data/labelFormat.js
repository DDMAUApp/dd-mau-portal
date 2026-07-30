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

const DOC_PATH = 'config/label_format';

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
    kindFormats: {},
});

// Sanitize a kindFormats map — only known kinds/fields, clamped.
export function cleanKindFormats(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object') continue;
        const entry = {};
        if (v.layout === 'nameFirst') entry.layout = 'nameFirst';
        if (Number.isFinite(Number(v.titleScale))) {
            entry.titleScale = Math.max(1, Math.min(8, Number(v.titleScale)));
        }
        if (Number.isFinite(Number(v.dateNumberScale))) {
            entry.dateNumberScale = Math.max(2, Math.min(8, Number(v.dateNumberScale)));
        }
        if (Number.isFinite(Number(v.useByBandScale))) {
            entry.useByBandScale = Math.max(2, Math.min(8, Number(v.useByBandScale)));
        }
        if (Number.isFinite(Number(v.timeScale))) {
            entry.timeScale = Math.max(1, Math.min(4, Number(v.timeScale)));
        }
        if (Number.isFinite(Number(v.metaScale))) {
            entry.metaScale = Math.max(1, Math.min(3, Number(v.metaScale)));
        }
        // Boolean, not only-true (audit 2026-07-27 #5): a per-kind
        // titleBold:false must be able to override a global bold ON.
        if (typeof v.titleBold === 'boolean') entry.titleBold = v.titleBold;
        if (typeof v.showTitleTranslation === 'boolean') entry.showTitleTranslation = v.showTitleTranslation;
        if (Number.isFinite(Number(v.title2Scale))) {
            entry.title2Scale = Math.max(1, Math.min(6, Number(v.title2Scale)));
        }
        // Per-kind giant use-by band control (weekday / discard-time line).
        if (v.showUseByBand === false) entry.showUseByBand = false;
        // 2026-07-27 "every text editable" — per-kind bold + size for the
        // remaining blocks. Booleans (not only-true) so a per-kind OFF can
        // override a global ON, same as titleBold above.
        for (const bk of ['dateBold', 'timeBold', 'metaBold', 'title2Bold',
            'bandBold', 'allergensBold', 'ingredientsBold', 'notesBold',
            'footerBold']) {
            if (typeof v[bk] === 'boolean') entry[bk] = v[bk];
        }
        for (const nk of ['allergensScale', 'ingredientsScale',
            'notesScale', 'footerScale']) {
            if (Number.isFinite(Number(v[nk]))) {
                entry[nk] = Math.max(1, Math.min(3, Number(v[nk])));
            }
        }
        // (rotate90 dropped 2026-07-27 — the TM-L100 ignored ePOS text
        // rotation on hardware; stale saved values are stripped here.)
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
export function subscribeLabelFormat(cb) {
    // 2026-07-30: the error handler used to report NOTHING at all, which is
    // right once a value has landed (a transient blip must not repaint the
    // editor with all-on defaults) but leaves a FIRST-snapshot failure
    // (offline open / rules hiccup) with no value ever delivered — the
    // editor's seededRef never flips and it sits on defaults pretending
    // they're the saved layout. Deliver defaults exactly once in that case,
    // flagged, so the UI can say so instead of lying.
    let delivered = false;
    return onSnapshot(doc(db, DOC_PATH), (snap) => {
        delivered = true;
        if (!snap.exists()) {
            cb({ ...DEFAULT_LABEL_FORMAT }, null);
            return;
        }
        const data = snap.data() || {};
        cb({ ...DEFAULT_LABEL_FORMAT, ...data }, null);
    }, (err) => {
        console.warn('label_format subscription failed:', err);
        if (delivered) return;   // steady state: keep whatever the UI has
        delivered = true;
        cb({ ...DEFAULT_LABEL_FORMAT }, err || new Error('label_format unavailable'));
    });
}

// Hot-path cached read — Andrew 2026-06-11: "the print for the
// stickers is kinda sticky". Every print awaited a fresh Firestore
// round-trip for this rarely-changing doc. First call starts a live
// subscription; every later call resolves instantly from the cached
// (always-current) value. Falls back to the one-shot read while the
// first snapshot is still in flight.
let _fmtCache = { value: undefined, ready: false, started: false };
export function getLabelFormatFast() {
    if (!_fmtCache.started) {
        _fmtCache.started = true;
        try {
            // 2026-07-30: ignore the flagged defaults-fallback delivery —
            // the print hot path must never cache defaults over the real
            // saved format; without a real snapshot it keeps falling back
            // to the one-shot read below, exactly as before.
            subscribeLabelFormat((fmt, err) => {
                if (err) return;
                _fmtCache.value = fmt; _fmtCache.ready = true;
            });
        } catch { /* fall through to one-shot below */ }
    }
    if (_fmtCache.ready) return Promise.resolve(_fmtCache.value);
    return getLabelFormat().then((f) => {
        // Don't clobber a fresher snapshot that landed mid-flight.
        if (!_fmtCache.ready) { _fmtCache.value = f; _fmtCache.ready = true; }
        return _fmtCache.value;
    });
}

// One-shot read. Used by Cloud Function paths or anywhere we
// don't want a live subscription.
export async function getLabelFormat() {
    try {
        const snap = await getDoc(doc(db, DOC_PATH));
        if (!snap.exists()) return { ...DEFAULT_LABEL_FORMAT };
        return { ...DEFAULT_LABEL_FORMAT, ...(snap.data() || {}) };
    } catch (e) {
        console.warn('label_format read failed:', e);
        return { ...DEFAULT_LABEL_FORMAT };
    }
}

export async function saveLabelFormat({ format, byName }) {
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
        // merge:true deep-merges maps, so a kind override the admin
        // REMOVED would silently survive in the doc forever. Solve it
        // with explicit deleteField() sentinels for every known kind
        // that has no override — inside a merged map, the sentinel
        // deletes that key. (2026-07-27: replaced a mergeFields-based
        // whole-field replace that failed on device — this keeps the
        // battle-tested merge:true path every other save uses.)
        const cleaned = cleanKindFormats(format.kindFormats);
        const KNOWN_KINDS = ['chemical', 'status', 'drink', 'protein',
            'topping', 'sauce', 'broth', 'base', 'side', 'other'];
        const out = { ...cleaned };
        for (const k of KNOWN_KINDS) {
            if (!(k in out)) out[k] = deleteField();
        }
        safe.kindFormats = out;
    }
    safe.updatedAt = serverTimestamp();
    safe.updatedBy = byName || null;

    await setDoc(doc(db, DOC_PATH), safe, { merge: true });
    recordAudit({
        action: 'label_format.save',
        actorName: byName || 'admin',
        targetType: 'config',
        targetId: 'label_format',
        details: { changedKeys: Object.keys(safe).filter(k => k !== 'updatedAt' && k !== 'updatedBy') },
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
