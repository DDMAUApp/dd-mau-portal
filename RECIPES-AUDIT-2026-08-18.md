# RECIPES TAB DEEP DIVE — 2026-08-18

**Trigger (Andrew):** "go through the whole page … audit … make sure the recipes are all sound and correct … the way the recipes are displayed … then add a recipe import — file, picture, any other way … use AI or picture/file reading."

**Method:** full read of `Recipes.jsx` + every helper it touches (recipeSearch, aiSearch, labelPrinting.printRecipeIngredients, PrintLabelModal, AdminPanel recipe audit, rules), live Firestore dump of `config/recipes` + `recipe_audits` + 30-day `recipe_views`, 3-way content diff (live doc ↔ `masterRecipes.js` ↔ Master Recipe Book docx/original kitchen PDF), one independent per-recipe allergen/content reviewer, adversarial code review of the batch, live checks in the browser pane (desktop / iPad 820 / phone 375, EN + ES) against prod data.

---

## 0. TL;DR

**Content — the big one.** 38 of 40 live recipes had **no allergen tags at all** (`masterRecipes.js` had tags, but they were never pushed to Firestore, and several of those tags were wrong anyway). The Recipes tab was showing **"✅ No major allergens recorded"** on Peanut Butter Sauce, Crab Rangoons, Ranch, Vietnamese Egg Rolls, etc., and the "Avoid allergen" reverse-lookup was useless. Fixed live (38 recipes, one `recipe_audits` row each, backup at `~/Documents/Claude/dd-mau-backups/recipes-before-audit-*.json`).

**Code — perf was fine, correctness wasn't.** The page paints from the localStorage cache instantly and the chunk was already prewarmed; the "slow" feel was the flat 40-card list. Real bugs: the multiplier double-scaled the "(×5 = 60 yolks)" annotations, scaled shelf-life days / cook minutes / shrimp grades ("21/25 shrimp" → "1.7 shrimp"), a print exception left the button stuck on "Printing…", and view logging re-fired on every live snapshot.

**Display.** Grouped by book section with a chip filter, 2-column card grid on iPad-landscape/desktop, expanded recipe splits ingredients | instructions side-by-side, readable allergen chips on closed cards, scaled amounts highlighted purple.

**Import — new.** 📥 Import (admin): photo/camera (several at once), PDF (whole book OK, split into pages, 6 per AI call in parallel), Word .docx / .txt, or pasted text → Claude reads it into the app's bilingual schema (EN + ES, allergen codes, category, emoji) → review screen (edit in the full editor, replace-existing / add-as-new / skip for duplicates) → saved through the same race-safe transaction with audit rows. Plus **✨ Auto-fill Spanish + allergens** in the recipe editor. Measured: pasted text 20 s, one photo 18 s, auto-fill 8 s.

---

## 1. Content findings applied live (all reversible from `recipe_audits`, via `content_audit_2026_08_18`)

Allergen tags now on every recipe (decisions in `scratchpad/recipes/content_audit.md`; the ones that differ from `masterRecipes.js`'s old tags):
- **Lo Mein Sauce, Lemongrass Marinade for Meats** — + shellfish (oyster sauce). Old tags missed it.
- **Lemongrass Shrimp small/big batch** — shellfish + sesame only (old tags said fish/soy/msg they don't contain).
- **Chicken & Beef Marinade for Fried Rice** — eggs + msg (old: fish/soy).
- **Fried Fish** — fish + msg (old: wheat/eggs — the coating is cornstarch only). **Chicken Wings** — wheat + msg (old soy had no ingredient). **Fried Shrimp Rolls** — shellfish, eggs, wheat, soy, msg (old fish had no ingredient).
- **Peanut Butter / Spicy Peanut / Hoisin / Vegan Beef Marinade / How to Make Vegan Beef** — + **sesame** (Lee Kum Kee hoisin contains sesame paste). ⚠️ **M17 (Allergen Matrix) does not mark sesame on Peanut Dressing / Hoisin / Vegan Beef — Andrew: check the hoisin can label; if it lists sesame, M17 needs updating.**
- **Vegan Vinaigrette** — soy (Matrix marks it; vegetarian fish sauce). **Coconut Condensed Milk** — treenut (FDA lists coconut as tree nut; Matrix says "caution"). **Thai Tea** — none (concentrate only; yields text now says it's served with half & half).
- MSG added where the ingredient list has MSG/chicken powder/bouillon: Egg Rolls, Veggie Egg Rolls, Crab Rangoons, Fried Fish, Wings, Shrimp Rolls, Vegan Popcorn Shrimp, Vegan Cream Cheese, Vegan Beef, Vinaigrette.

Text fixes: `(×5 = …)`/`(×2 = …)` annotations stripped from DD / Spicy DD / Mayo (they double-scaled under the multiplier; yields now says "Base batch (12 yolks). Standard production run = 5x — tap 5x above."); Mayo "1 TSP salt" → 1 TBSP (the ×2 = 2 TBSP on the same line proved it); **Tofu Marinade soy sauce line restored** (Jun 26 edit deleted it, leaving "Put , garlic powder…" and ES still saying salsa de soya — see Q3); Thai Chili Pepper Seasoning typos ("6 cupswhole", "5lb", "3 cup"); Hoisin "1 /2 gallon" → "½ gallon" (see Q1); Soy Sauce for Fried Rice ES still said 2 tazas (EN 5); Lychee Limeade ES said 1 can/1 cup (EN 2/2) + two ES lines in English; Chicken Wings "1 case Ck Wings (40lb)" ES → Spanish + moved to line 1; String bean sauce → category "Sauces & Dressings", ES title + ingredients, + wheat; wrapper lines added to Egg Rolls / Veggie Egg Rolls / Crab Rangoons (they carry the wheat/egg); "1 case vegan shrimp" line added to Vegan Popcorn Shrimp; Cajun "1/4 cups" → "¼ cup"; Fried Fish ES "1  TBSP" → "1 cucharada".

`masterRecipes.js` regenerated from the fixed live doc (`scripts/sync-master-recipes.cjs`, `--check` mode available) so the AI assistant index and the sticker sub-recipe lookup stop using May quantities.

## 2. Questions for Andrew (typo vs. kitchen change — I did NOT decide these)
1. **Hoisin Sauce water:** live had "1 /2 gallon" (all sources say **1 gallon**). I read the typed "/2" as intent and set **½ gallon** — confirm.
2. **Lemongrass Shrimp small batch:** live "4 cups vegetable oil" (PDF ¼ cup), "1 cup sesame oil" (PDF ¼), "¼ cup garlic powder" (PDF ⅛), "32 oz lemongrass (1 cup)". Left as-is.
3. **Tofu Marinade:** I restored "2 quarts Kikkoman soy sauce" — was the Jun 26 deletion on purpose?
4. **Vietnamese Coffee:** ingredient says 4 cans condensed milk, step 4 says 2½ (all sources 2½). Left as-is.
5. **Egg rolls:** 20 white onions (live) vs 8–10 / 6 (all sources). **Chicken Wings** ¼ cup baking powder vs 1 cup. **Vegan Popcorn Shrimp** 6 cups cornstarch vs 4. Left as-is (live is the kitchen).
6. **Vegan Beef Marinade "Hoisin Sauce"** — canned LKK (no peanut, what I assumed from "use the empty hoisin can") or the house Hoisin (peanut butter → peanut allergen)?
7. **String bean sauce** — no method/yield, "4 cups wine" (which?), can size. Hidden? It's live.
8. **Pickled Medley** — Matrix's MSG skip-list names it, recipe has no MSG. Which is right?
9. Label checks (◐): LKK hoisin sesame (M17), vegetarian fish sauce wheat, egg-roll wrapper egg (tagged eggs per Matrix), imitation crab crab-extract (Crab Rangoons ingredient line now says to check), vegan shrimp soy, white chocolate soy lecithin (Churro Ganache).

## 3. Code changes (Recipes tab)
- `src/data/recipeScale.js` (+11 tests): `scaleIngredient` / `parseQuantity` extracted; new guards — durations/temps/percent don't scale ("lasts 3–7 days", "350°F", "3 minutes"), "×5"/"2x" annotations don't, shrimp grades ("21/25") don't; ranges still do ("8–10 onions" → "16–20"). Instructions are never scaled (only ingredients + yields).
- `Recipes.jsx`: grouped sections + chip filter; `lg:` 2-col grid, expanded card `lg:col-span-2` with ingredients | instructions split; closed card shows yields line + labeled allergen chips; scroll-into-view on expand; view-log effect keys on the opened recipe only (metadata via ref — no duplicate rows on live snapshots); print `try/finally`; "No allergens tagged — ask the Shift Lead" instead of the green "No major allergens" reassurance; avoid-allergen count also reports untagged recipes; double bottom padding removed; `upsertRecipe` shared by editor + import (one transaction per recipe, `via:'ai_import'` on audit rows); Import button.
- `RecipeForm.jsx` (extracted): category chips from the live book, ✨ Auto-fill Spanish + allergens (fills only empty ES fields, unions allergen tags), EN/ES line-count hint, paste a whole list into one row → splits into rows, save requires ≥1 ingredient.
- `RecipeImportModal.jsx` + `src/data/recipeImport.js`: photo/camera (`capture="environment"`, multiple), files (PDF via pdfjs → PNG pages, images downscaled to 2200 px long edge without cropping, .docx via jszip text, .txt/.md/.csv), pasted text; staged under Storage `menu_imports/recipe_*` (existing rule allows it) and deleted right after; job-doc transport (`recipe_import_jobs`, same reliable-on-iPad pattern as health imports); ≤6 pages per job, jobs run in parallel; review list with confidence, warnings, EN/ES counts, duplicate detection (replace / add as new / skip), full editor per draft, save N.
- `functions/index.js`: `processRecipeImportJob` (onDocumentCreated, Sonnet 4.6 with Haiku fallback, 150 s/attempt × 3, sanitized output, 60 jobs / 5 min global bucket) + `recipe_import_jobs` added to the daily prune. **Deployed.**

## 4. Measurements
| | before | after |
|---|---|---|
| First paint | instant (LS cache) | same |
| Multiplier on "16 qt bucket · lasts 3–7 days" ×2 | "32 qt … lasts 6–14 days" | "32 qt … lasts 3–7 days" |
| Multiplier on "12 egg yolks (×5 = 60 yolks)" ×5 | "60 egg yolks (×25 = 300 yolks)" | "60 egg yolks" |
| "Per 6 blocks of 21/25 shrimp" ×2 | "12 blocks of 1.7 shrimp" | "12 blocks of 21/25 shrimp" |
| Import: pasted 5-ingredient recipe | — | 20 s (Sonnet), correct EN/ES/allergens |
| Import: 1 photo (1200×1600 rendered card) | — | 18 s, eggs+milk correct, ES faithful |
| Editor ✨ Auto-fill | — | 8 s |
| Tests | 896 | 907 |

## 5. Not done / follow-ups
- Recipe Audit panel in Admin still lists `recipe_views` only; import/edit rows are in `recipe_audits` (readable in Firestore; a small "Recipe changes" panel would be ~1 h).
- HEIC photos from iPhone: the browser decodes them on iOS (Safari/WKWebView) so the downscale works there; on desktop Chrome an HEIC file is uploaded as-is and the server rejects the media type → user sees "could not fetch an image". Convert to JPEG on the phone or use the app.
- Recipe photos are NOT stored — only text lands in the book. Storing an original photo per recipe (behind the same confidentiality gate) is a natural next step.
- Multi-recipe PDFs: tested text + single image live; the batching path (>6 pages) is exercised by code review, not a live 38-page run.
