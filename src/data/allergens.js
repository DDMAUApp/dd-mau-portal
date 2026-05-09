// Canonical allergen taxonomy. ONE source of truth for both the recipe book
// (back-of-house ingredient lists) and the M17 menu-item allergen matrix.
//
// Codes are short, lowercase, machine-friendly. Pretty labels + emoji + colors
// are derived via the helper functions below — never hardcoded at call sites.
//
// "Big 9" = the FDA-recognized major allergens (sesame added 2023). Plus a
// couple DD-Mau-specific tags guests routinely ask about (MSG, vegan,
// gluten-free) that aren't strictly allergens but matter operationally.
//
// Schema on a recipe:
//   allergens: ['fish', 'soy', 'sesame', 'msg']
// Schema on a menu item (M17 matrix):
//   v: { fish: '●', shell: '◐', ... }   ← '●' = contains, '◐' = may contain

export const ALLERGEN_CODES = [
    'milk', 'eggs', 'fish', 'shell', 'treenut', 'peanut',
    'wheat', 'soy', 'sesame', 'msg',
];

// Display order for badges — most-dangerous first (anaphylaxis-prone, hard
// to substitute) so the eye catches the worst-case allergen first.
export const ALLERGEN_ORDER = [
    'peanut', 'treenut', 'shell', 'fish',
    'milk', 'eggs', 'wheat', 'soy', 'sesame', 'msg',
];

const META = {
    peanut:  { en: 'Peanut',     es: 'Cacahuate',     emoji: '🥜', tone: 'bg-red-100 text-red-800 border-red-300' },
    treenut: { en: 'Tree Nut',   es: 'Frutos secos',  emoji: '🌰', tone: 'bg-red-100 text-red-800 border-red-300' },
    shell:   { en: 'Shellfish',  es: 'Mariscos',      emoji: '🦐', tone: 'bg-pink-100 text-pink-800 border-pink-300' },
    fish:    { en: 'Fish',       es: 'Pescado',       emoji: '🐟', tone: 'bg-blue-100 text-blue-800 border-blue-300' },
    milk:    { en: 'Milk',       es: 'Lácteos',       emoji: '🥛', tone: 'bg-amber-100 text-amber-800 border-amber-300' },
    eggs:    { en: 'Eggs',       es: 'Huevos',        emoji: '🥚', tone: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
    wheat:   { en: 'Wheat / Gluten', es: 'Trigo / Gluten', emoji: '🌾', tone: 'bg-orange-100 text-orange-800 border-orange-300' },
    soy:     { en: 'Soy',        es: 'Soya',          emoji: '🫘', tone: 'bg-green-100 text-green-800 border-green-300' },
    sesame:  { en: 'Sesame',     es: 'Ajonjolí',      emoji: '🌱', tone: 'bg-teal-100 text-teal-800 border-teal-300' },
    msg:     { en: 'MSG',        es: 'MSG',           emoji: '⚠️', tone: 'bg-gray-100 text-gray-700 border-gray-300' },
};

export function allergenLabel(code, language = 'en') {
    const m = META[code];
    if (!m) return code;
    return language === 'es' ? m.es : m.en;
}
export function allergenEmoji(code) { return (META[code] || {}).emoji || ''; }
export function allergenTone(code)  { return (META[code] || {}).tone || 'bg-gray-100 text-gray-700 border-gray-300'; }

// Sort a recipe's allergen list into our preferred display order.
export function sortAllergens(list) {
    if (!Array.isArray(list)) return [];
    const order = new Map(ALLERGEN_ORDER.map((code, i) => [code, i]));
    return [...new Set(list)]
        .filter(c => META[c])
        .sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}

// Reverse-lookup: given an allergen the guest is avoiding, return a
// predicate that flags recipes/menu-items that contain it.
export function makeContainsFilter(avoidedCode) {
    if (!avoidedCode) return () => false;
    return (allergens) => Array.isArray(allergens) && allergens.includes(avoidedCode);
}
