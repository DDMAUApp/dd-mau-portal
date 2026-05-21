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
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
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

    // Size scaling
    dateNumberScale: 5,    // Epson: width=height=5. Brother CSS: ~28% of label width
    titleScale:      2,    // Epson: width=height=2. Brother CSS: medium-large

    // Text content
    preppedLabelTextEn: 'PREPPED',
    preppedLabelTextEs: 'HECHO',
    footerText:         'DD MAU',

    // Format
    dateFormat:         'mm/dd/yy',   // or 'dd/mm/yy'
    timeFormat:         '12h',         // or '24h'
    showUseByWeekday:   true,

    // Defaults
    defaultShelfLifeDays: 5,
});

// Live subscription. Callback gets the merged format (defaults +
// any saved overrides). Renderers + preview use this to update
// in real time when admin saves.
export function subscribeLabelFormat(cb) {
    return onSnapshot(doc(db, DOC_PATH), (snap) => {
        if (!snap.exists()) {
            cb({ ...DEFAULT_LABEL_FORMAT });
            return;
        }
        const data = snap.data() || {};
        cb({ ...DEFAULT_LABEL_FORMAT, ...data });
    }, (err) => {
        console.warn('label_format subscription failed:', err);
        cb({ ...DEFAULT_LABEL_FORMAT });
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
        'showNotes', 'showFooter', 'showUseByWeekday'];
    const STRING_FIELDS = ['preppedLabelTextEn', 'preppedLabelTextEs',
        'footerText', 'dateFormat', 'timeFormat'];
    const NUMBER_FIELDS = ['dateNumberScale', 'titleScale', 'defaultShelfLifeDays'];

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
    f.titleScale = Math.max(1, Math.min(4, Number(f.titleScale) || 2));
    f.defaultShelfLifeDays = Math.max(1, Math.min(60, Number(f.defaultShelfLifeDays) || 5));
    return f;
}
