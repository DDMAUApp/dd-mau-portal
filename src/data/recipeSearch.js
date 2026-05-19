// Recipe search — bilingual + accent-insensitive + synonym-expanded matching.
//
// Pure helpers (no React, no Firestore). Reuses normalize / expandQueryTerms /
// haystackMatches from chatSearch so the restaurant vocabulary defined there
// (chicken↔pollo, lime↔limón, broth↔caldo, peanut↔cacahuate, etc.) widens
// recipe matches the same way it widens chat searches. One synonym list,
// two surfaces.
//
// ── What gets indexed ────────────────────────────────────────────────
//   • titleEn, titleEs
//   • category
//   • emoji  (cheap to include — lets the rare emoji-pasted query hit)
//   • ingredientsEn, ingredientsEs  (joined into one blob)
//   • allergen labels in BOTH languages — typing "peanut" surfaces every
//     recipe tagged with the peanut allergen, even if the word itself
//     never appears in the ingredient list (common when an ingredient
//     is a brand name or a sauce that hides the allergen).
//
// ── What is intentionally NOT indexed ────────────────────────────────
//   • instructionsEn / instructionsEs — long and noisy. Verbs and
//     transitions ("add", "stir", "fold", "until smooth") add a lot of
//     false positives. The pieces cooks/cashiers actually search for
//     live in title + ingredients + category.
//
// ── Performance ──────────────────────────────────────────────────────
// Recipes is a small collection (dozens, not thousands). We rebuild the
// haystack per recipe on every keystroke. Sub-millisecond at current
// size — no memoization needed. If the recipe book ever grows past a
// few hundred we can move to a useMemo over a fingerprint of the list.

import { normalize, expandQueryTerms, haystackMatches } from './chatSearch';
import { allergenLabel } from './allergens';

// Build a single normalized haystack string for a recipe.
export function buildRecipeHaystack(recipe) {
    if (!recipe) return '';
    const parts = [];
    if (recipe.titleEn)  parts.push(recipe.titleEn);
    if (recipe.titleEs)  parts.push(recipe.titleEs);
    if (recipe.category) parts.push(recipe.category);
    if (recipe.emoji)    parts.push(recipe.emoji);
    if (Array.isArray(recipe.ingredientsEn)) parts.push(recipe.ingredientsEn.join(' '));
    if (Array.isArray(recipe.ingredientsEs)) parts.push(recipe.ingredientsEs.join(' '));
    if (Array.isArray(recipe.allergens)) {
        for (const code of recipe.allergens) {
            parts.push(allergenLabel(code, 'en'));
            parts.push(allergenLabel(code, 'es'));
        }
    }
    return normalize(parts.join(' '));
}

// Convenience wrapper: does this recipe match the (possibly multi-word) query?
// Empty/whitespace query → returns true (no filter applied).
export function matchesRecipeQuery(recipe, query) {
    const expanded = expandQueryTerms(query);
    if (expanded.length === 0) return true;
    const haystack = buildRecipeHaystack(recipe);
    return haystackMatches(haystack, expanded);
}
