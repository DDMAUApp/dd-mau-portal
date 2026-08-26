// Recipe quantity scaling — pure helpers (no React, no Firestore).
//
// Extracted from Recipes.jsx on 2026-08-18 so the multiplier maths can be
// unit-tested; behaviour is the same the kitchen has used since May, plus
// three guard rules found in the 2026-08-18 recipe audit:
//   • durations / temperatures don't scale ("lasts 3–7 days", "350°F",
//     "pickle 2 days first", "3 minutes in the microwave")
//   • "×5" / "x5" batch annotations don't scale ("BASE · ×5 = production")
//   • shrimp count grades don't scale ("21/25 shrimp", "16/20") — those are
//     sizes, not quantities, and used to come out as "1.7 shrimp"
//
// Everything else that looks like a quantity scales, INCLUDING mid-line
// amounts ("1 gallon and 9 cups", "Set aside: 1 cup"), Unicode fractions,
// mixed numbers and ranges ("8–10 onions" → "16–20 onions").

const FRAC_MAP = {
    '½': 0.5, '¼': 0.25, '¾': 0.75,
    '⅓': 1 / 3, '⅔': 2 / 3,
    '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
    '⅙': 1 / 6, '⅚': 5 / 6,
    '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
};
const FRACS = Object.keys(FRAC_MAP).join('');
// Most-specific alternatives first so mixed numbers match as one unit.
const QTY_RE = new RegExp(
    '(\\d+\\s*[' + FRACS + ']|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|[' + FRACS + ']|\\d+\\.?\\d*)',
    'g'
);
// Words that mean the number before them is a TIME / TEMPERATURE /
// PERCENTAGE, not an amount of food. EN + ES kitchen vocabulary.
const NON_SCALING_UNIT_RE = new RegExp(
    '^\\s*(?:°|℉|℃|%|F\\b(?=\\s|$|[.,)])|' +
    '(?:days?|d[ií]as?|hours?|hrs?|hr|horas?|min|mins|minutes?|minutos?|sec|secs|seconds?|segundos?|weeks?|semanas?|months?|meses|mes|' +
    'degrees?|grados?)\\b)',
    'i'
);

// Parse "1/3", "1 1/2", "½", "1½", "0.333", "2" → number. null on garbage.
export function parseQuantity(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    let m = s.match(new RegExp('^(\\d+)\\s*([' + FRACS + '])$'));
    if (m) return parseInt(m[1], 10) + FRAC_MAP[m[2]];
    if (FRAC_MAP[s] !== undefined) return FRAC_MAP[s];
    m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    if (m) { const d = parseInt(m[3], 10); return d > 0 ? parseInt(m[1], 10) + parseInt(m[2], 10) / d : null; }
    m = s.match(/^(\d+)\/(\d+)$/);
    if (m) { const d = parseInt(m[2], 10); return d > 0 ? parseInt(m[1], 10) / d : null; }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

// Format a scaled number the way the recipe book prints quantities:
// clean integers, then whole + Unicode fraction, then one decimal.
export function formatQuantity(scaled) {
    if (!Number.isFinite(scaled)) return '';
    if (Math.abs(scaled - Math.round(scaled)) < 0.01) return String(Math.round(scaled));
    const whole = Math.floor(scaled);
    const dec = scaled - whole;
    for (const [str, val] of Object.entries(FRAC_MAP)) {
        if (Math.abs(dec - val) < 0.02) return whole > 0 ? `${whole}${str}` : str;
    }
    return scaled.toFixed(1);
}

function matchToNumber(match) {
    const noWs = match.replace(/\s+/g, '');
    const mixedUni = noWs.match(new RegExp('^(\\d+)([' + FRACS + '])$'));
    if (mixedUni) return parseInt(mixedUni[1], 10) + FRAC_MAP[mixedUni[2]];
    if (FRAC_MAP[match] !== undefined) return FRAC_MAP[match];
    if (match.includes(' ') && match.includes('/')) {
        const parts = match.trim().split(/\s+/);
        const [n, d] = parts[1].split('/').map(Number);
        return parseFloat(parts[0]) + n / d;
    }
    if (match.includes('/')) {
        const [n, d] = match.split('/').map(Number);
        return n / d;
    }
    return parseFloat(match);
}

// Should this matched number be left alone?
function isProtected(match, offset, full) {
    const before = offset > 0 ? full[offset - 1] : '';
    const after = full.slice(offset + match.length);
    // Glued to a word — the "8" in "V8", the "2" in "1-B"
    if (/[A-Za-z]/.test(before)) return true;
    // Preceded by a standalone × / x (batch annotation "×5", "x 5") — but
    // NOT by a word that merely ends in x ("Mix 2 cups", "approx 3 lb",
    // "box 5 lb")
    if (/(?:^|[^A-Za-z])[×x]\s?$/i.test(full.slice(Math.max(0, offset - 3), offset))) return true;
    // Followed by × / x glued ("5x", "2×")
    if (/^[×x](?![A-Za-z])/i.test(after)) return true;
    // Hyphenated fixed size — "5-gallon", "6-quart", "1 (2-quart)"
    if (/^-[A-Za-z]/.test(after)) return true;
    // Per-unit pack size — "2 cans (5 lb each)" keeps "5 lb each"
    if (/^(\s+[A-Za-z.]+)?\s+each\b/i.test(after)) return true;
    // Parenthesized pack size WITHOUT "each" — "1 (2 lb) bag noodles",
    // "1 can (28 oz) tomatoes": the pack size describes the container and
    // must never scale (only the count outside the parens does). Protect a
    // number inside parens followed by unit+")" ONLY when the "(" directly
    // follows a counted item (a number, optionally + one word) — that's
    // what distinguishes a pack size from an equivalent-amount note like
    // "32 oz sugar (2½ cups)", which SHOULD scale.
    // (2026-08-25 — "1 (2 lb) bag" ×3 was producing "3 (6 lb) bag".)
    {
        const beforeParen = full.slice(Math.max(0, offset - 24), offset);
        if (/\d[\d.,/½¼¾⅓⅔⅛]*\s*(?:[A-Za-z.]+\s+)?\(\s*$/.test(beforeParen)
            && /^\s*[A-Za-z.#]+\s*[)]/.test(after)) return true;
    }
    // Proportion fractions — "fill 3/4 full", "leave ½ empty", "fill ¾ of
    // the way" describe how full a container is, not an amount ("fill 1½
    // full" is impossible). Includes Spanish "lleno/vacío".
    if (/^\s*(?:full|empty|of the way|way\b|lleno|vac[ií]o)/i.test(after)) return true;
    // Time / temperature / percentage — also when this number is the low
    // end of a range ("3–7 days": the "3" is followed by "–7 days")
    if (NON_SCALING_UNIT_RE.test(after)) return true;
    const range = after.match(new RegExp('^\\s*(?:[–—-]|to|a)\\s*(?:\\d+\\s*[' + FRACS + ']|\\d+\\/\\d+|[' + FRACS + ']|\\d+\\.?\\d*)', 'i'));
    if (range && NON_SCALING_UNIT_RE.test(after.slice(range[0].length))) return true;
    // Shrimp count grades — "21/25", "16/20", "26/30" (both parts ≥ 10)
    if (/^\d+\/\d+$/.test(match)) {
        const [n, d] = match.split('/').map(Number);
        if (n >= 10 && d >= 10) return true;
    }
    return false;
}

// Scale every quantity in a recipe line. Preserves the em-dash / hyphen
// sub-bullet prefix used in dry-seasoning blocks ("— ½ cup salt").
export function scaleIngredient(text, multiplier) {
    if (typeof text !== 'string') return text ?? '';
    if (!multiplier || multiplier === 1) return text;
    const prefixMatch = text.match(/^(\s*[—–-]\s+)/);
    const prefix = prefixMatch ? prefixMatch[0] : '';
    const body = text.slice(prefix.length);
    const replaced = body.replace(QTY_RE, (match, _p1, offset, full) => {
        if (isProtected(match, offset, full)) return match;
        const num = matchToNumber(match);
        if (!Number.isFinite(num)) return match;
        return formatQuantity(num * multiplier);
    });
    return prefix + replaced;
}

// Does this line contain anything the multiplier would change? Lets the
// UI mark scaled lines so cooks can tell "16 qt bucket" (a container size
// that scaled) from "lasts 3–7 days" (which correctly did not).
export function lineScales(text) {
    if (typeof text !== 'string' || !text) return false;
    return scaleIngredient(text, 2) !== text;
}
