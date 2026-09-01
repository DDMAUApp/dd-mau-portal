// ingredientParts.js — split "1 cup sugar" ⇄ {qty, unit, rest} for the
// recipe editor (Andrew 2026-09-01: "the amount on a box and the
// measurement in one … with the cup it can come from a drop down menu").
//
// STORAGE IS UNCHANGED: recipes keep their ingredient lines as plain
// strings (ingredientsEn/ingredientsEs) — display, ×-scaling
// (recipeScale.js), search, the AI import, and the masterRecipes mirror
// all still see the exact same text. This module only powers the editor's
// three-box row and must ROUND-TRIP faithfully: join(split(line)) equals
// the original line (modulo collapsed whitespace).
//
// Split rules:
//   • qty  = the leading numeric run, verbatim: "1", "2.5", "1 1/2", "½",
//     "1½", "8–10" (ranges), even "21/25" (shrimp grades) — whatever is
//     there is preserved, never re-formatted.
//   • unit = the next word(s) ONLY when they match the known unit list
//     for the line's language (two-word units like "fl oz" first). Food
//     words after a bare count ("3 eggs", "2 limes") are NOT units — they
//     stay in the item box.
//   • rest = everything else, verbatim.
// A line with no leading quantity ("Salt to taste") goes entirely to rest.

const FRACS = '½¼¾⅓⅔⅛⅜⅝⅞⅙⅚⅕⅖⅗⅘';

// Leading numeric RUN — deliberately greedy across spaces/slashes/dashes
// so mixed numbers ("1 1/2") and ranges ("8–10") stay in ONE box, and so
// a half-typed "1 " doesn't get re-split out from under the cursor.
const QTY_RUN_RE = new RegExp('^\\s*([\\d' + FRACS + '][\\d' + FRACS + '\\s./–—-]*)');

// Dropdown unit lists — derived from the live book's actual vocabulary
// (2026-09-01 scan of all 248 ingredient lines) plus standard kitchen
// units. Singular + plural both listed so an existing line's word shows
// selected as-is and nothing silently rewrites on save.
export const UNITS_EN = [
    'cup', 'cups', 'tbsp', 'tsp', 'fl oz', 'oz', 'lb', 'lbs', 'g', 'kg', 'ml', 'L',
    'gallon', 'gallons', 'quart', 'quarts', 'pint', 'pints',
    'can', 'cans', 'bottle', 'bottles', 'bag', 'bags', 'box', 'boxes',
    'case', 'cases', 'bowl', 'bowls', 'tub', 'tubs', 'pack', 'packs',
    'clove', 'cloves', 'piece', 'pieces', 'slice', 'slices',
    'measure', 'measures', 'pinch', 'dash',
];
export const UNITS_ES = [
    'taza', 'tazas', 'cda', 'cdas', 'cdta', 'cdtas',
    'cucharada', 'cucharadas', 'cucharadita', 'cucharaditas',
    'fl oz', 'oz', 'lb', 'lbs', 'g', 'kg', 'ml', 'L',
    'galón', 'galones', 'cuarto', 'cuartos', 'pinta', 'pintas',
    'lata', 'latas', 'botella', 'botellas', 'bolsa', 'bolsas',
    'caja', 'cajas', 'bote', 'botes', 'tazón', 'tazones',
    'paquete', 'paquetes', 'diente', 'dientes', 'pieza', 'piezas',
    'rebanada', 'rebanadas', 'medida', 'medidas', 'pizca',
];

export function unitsFor(lang) {
    return lang === 'es' ? UNITS_ES : UNITS_EN;
}

// Longest-first so 'fl oz' wins over 'oz', 'cucharaditas' over 'cucharadita'.
const byLenDesc = (a, b) => b.length - a.length;
const SORTED = {
    en: [...UNITS_EN].sort(byLenDesc),
    es: [...UNITS_ES].sort(byLenDesc),
};

const matchLeadingUnit = (text, lang) => {
    for (const u of SORTED[lang === 'es' ? 'es' : 'en']) {
        if (text.length >= u.length
            && text.slice(0, u.length).toLowerCase() === u.toLowerCase()
            && (text.length === u.length || /[\s.,)]/.test(text[u.length]))) {
            return text.slice(0, u.length);
        }
    }
    return null;
};

export function splitIngredientLine(line, lang = 'en') {
    const s = String(line ?? '');
    const qm = s.match(QTY_RUN_RE);
    if (!qm) {
        // No amount — but a leading unit alone still belongs in the unit
        // box ("cups chicken" while the amount is not typed yet, or a
        // real "Pinch of salt"). Without this, an editor row with a unit
        // picked before the amount didn't round-trip and the dropdown
        // snapped back to blank.
        const t = s.replace(/^\s+/, '');
        const u = matchLeadingUnit(t, lang);
        if (u) return { qty: '', unit: u, rest: t.slice(u.length).replace(/^\s+/, '') };
        return { qty: '', unit: '', rest: s.trim() };
    }
    // Trim trailing separators off the run (a dash/space belongs to the
    // qty box only while more digits follow).
    let qty = qm[1].replace(/[\s./–—-]+$/, '');
    if (!qty) return { qty: '', unit: '', rest: s.trim() };
    let after = s.slice(s.indexOf(qm[1]) + qm[1].length);
    // If the run over-ate the space before a word ("1 " of "1 cup"), the
    // remainder starts mid-word context; re-anchor from the trimmed qty.
    after = s.slice(s.indexOf(qty) + qty.length).replace(/^\s+/, '');
    // Preserve the line's own casing of the unit.
    const unit = matchLeadingUnit(after, lang);
    if (unit) return { qty, unit, rest: after.slice(unit.length).replace(/^\s+/, '') };
    return { qty, unit: '', rest: after };
}

export function joinIngredientParts({ qty = '', unit = '', rest = '' } = {}) {
    return [qty, unit, rest]
        .map(x => String(x ?? '').trim())
        .filter(Boolean)
        .join(' ');
}
