// allergenParse.js — free-text allergen notes → canonical allergen codes.
//
// Used where allergens are typed as words (menu.js strings like
// "Soy, Fish (vinaigrette). Optional peanut." and ⭐ Custom sticker items).
// Codes MUST match src/data/allergens.js ALLERGEN_CODES — the print modal's
// chips and the label's printed names key off them.
//
// 2026-09-23 review fixes: whole-word matching (no "shellfish" → fish,
// "eggplant" → egg, "buttermilk" handled explicitly), canonical codes
// (eggs / shell, not egg / shellfish), and the synonyms staff actually type.
// When in doubt this errs toward LISTING an allergen (coconut stays a tree
// nut, as before) — an extra allergen line is safer than a missing one.

const RULES = [
    ['milk',    ['milk', 'dairy', 'butter', 'buttermilk', 'cheese', 'cream', 'yogurt', 'whey', 'casein', 'lactose', 'ghee']],
    ['eggs',    ['egg', 'eggs', 'mayo', 'mayonnaise', 'aioli']],
    ['fish',    ['fish', 'salmon', 'tuna', 'cod', 'tilapia', 'anchovy', 'anchovies', 'fish sauce']],
    ['shell',   ['shellfish', 'shrimp', 'prawn', 'prawns', 'crab', 'lobster', 'crawfish', 'crayfish', 'clam', 'clams',
                 'oyster', 'oysters', 'oyster sauce', 'mussel', 'mussels', 'scallop', 'scallops', 'squid', 'calamari']],
    ['soy',     ['soy', 'soya', 'soybean', 'soybeans', 'tofu', 'edamame', 'miso', 'tamari', 'hoisin']],
    // NOT 'noodle(s)' / 'flour': rice noodles and rice flour are gluten-free —
    // tagging them wheat would mislead a gluten-free guest.
    ['wheat',   ['wheat', 'gluten', 'bread', 'panko', 'breadcrumbs', 'soy sauce']],
    ['peanut',  ['peanut', 'peanuts', 'peanut butter']],
    ['treenut', ['tree nut', 'tree nuts', 'treenut', 'treenuts', 'nut', 'nuts', 'almond', 'almonds', 'cashew', 'cashews',
                 'walnut', 'walnuts', 'pecan', 'pecans', 'pistachio', 'pistachios', 'hazelnut', 'hazelnuts',
                 'macadamia', 'coconut']],
    ['sesame',  ['sesame', 'tahini']],
    ['msg',     ['msg', 'monosodium glutamate']],
];

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMPILED = RULES.map(([code, words]) => [code,
    new RegExp(`(^|[^a-z])(${words.map(escapeRe).join('|')})(?=$|[^a-z])`, 'i')]);

/** "Soy, Fish (vinaigrette). Optional peanut." → ['fish','soy','peanut'] (canonical codes). */
export function parseAllergenText(s) {
    if (!s) return [];
    if (Array.isArray(s)) {
        // Already a code list (recipes store codes) — normalize legacy spellings.
        return [...new Set(s.flatMap((x) => parseAllergenText(String(x))))];
    }
    const text = String(s).toLowerCase();
    const out = [];
    for (const [code, re] of COMPILED) {
        if (re.test(text)) out.push(code);
    }
    // "peanut" also contains the word "nut" only when written "pea nut" — the
    // regex is whole-word so "peanut" never adds treenut; nothing to undo.
    return out;
}

/** Words a person typed that we could NOT map (for a "didn't recognize" hint). */
export function unrecognizedAllergenWords(s) {
    if (!s) return [];
    const known = new Set(RULES.flatMap(([, w]) => w));
    const filler = new Set(['and', 'or', 'with', 'may', 'contain', 'contains', 'optional', 'free', 'trace', 'traces', 'of', 'in', 'the', 'a']);
    return String(s).toLowerCase().split(/[^a-z]+/).filter((w) => w && w.length > 2 && !known.has(w) && !filler.has(w));
}
