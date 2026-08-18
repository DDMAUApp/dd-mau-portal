#!/usr/bin/env node
// Regenerate src/data/masterRecipes.js from the LIVE recipe book
// (Firestore config/recipes.list). Run after material recipe edits so the
// AI assistant index (aiContext.js) and sticker sub-recipe lookup
// (itemBuild.js) don't drift from what the kitchen actually uses.
//
//   node scripts/sync-master-recipes.cjs            # writes the file
//   node scripts/sync-master-recipes.cjs --check    # exit 1 if it would change
//
// Needs firebase-service-account.json in the repo root (never committed).
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'data', 'masterRecipes.js');
const CHECK = process.argv.includes('--check');

const sa = require(path.join(ROOT, 'firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const q = (s) => JSON.stringify(String(s ?? ''));
const arr = (a) => '[\n' + (a || []).map((x) => '            ' + q(x) + ',').join('\n') + '\n        ]';

function render(list, stamp) {
    let out = `// Master recipe book — DD Mau Vietnamese Eatery
// Bilingual EN/ES kitchen reference.
//
// ⚠️ SOURCE OF TRUTH IS FIRESTORE: config/recipes.list (edited in the app
// Recipes tab). This file is a MIRROR of that doc, regenerated on
// ${stamp} by scripts/sync-master-recipes.cjs. It exists for the pieces of
// the app that need recipe data synchronously at import time:
//   • aiContext.js   — AI assistant recipe index (titles/categories)
//   • itemBuild.js   — sticker sub-recipe lookup by title (findSubRecipe)
// It is NOT imported by the Recipes tab and there is no "Import master
// recipes" button any more. If the live book changes materially, regenerate
// with scripts/sync-master-recipes.cjs (dumps config/recipes into this file).
//
// Categories follow the printed Master Recipe Book sections.

export const MASTER_RECIPES = [
`;
    let lastCat = null;
    for (const r of list) {
        const cat = String(r.category || '');
        if (cat !== lastCat) {
            out += `    // ── ${cat.toUpperCase()} ${'─'.repeat(Math.max(4, 60 - cat.length))}\n`;
            lastCat = cat;
        }
        out += `    {
        id: ${Number(r.id)},
        emoji: ${q(r.emoji)},
        category: ${q(r.category)},
        titleEn: ${q(r.titleEn)},
        titleEs: ${q(r.titleEs)},
        prepTimeEn: ${q(r.prepTimeEn)},
        cookTimeEn: ${q(r.cookTimeEn)},
        allergens: ${JSON.stringify(Array.isArray(r.allergens) ? r.allergens : [])},
        yieldsEn: ${q(r.yieldsEn)},
        yieldsEs: ${q(r.yieldsEs)},
        ingredientsEn: ${arr(r.ingredientsEn)},
        ingredientsEs: ${arr(r.ingredientsEs)},
        instructionsEn: ${arr(r.instructionsEn)},
        instructionsEs: ${arr(r.instructionsEs)},
    },
`;
    }
    out += '];\n';
    return out;
}

(async () => {
    const snap = await db.doc('config/recipes').get();
    const list = (snap.data() || {}).list || [];
    if (list.length === 0) throw new Error('config/recipes is empty — refusing to write');
    const stamp = new Date().toISOString().slice(0, 10);
    const next = render(list, stamp);
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    // Compare ignoring the date stamp line.
    const strip = (s) => s.replace(/regenerated on\n\/\/ \d{4}-\d{2}-\d{2}/, '');
    const changed = strip(cur) !== strip(next);
    if (CHECK) {
        console.log(changed ? 'masterRecipes.js is STALE vs live' : 'masterRecipes.js is in sync');
        process.exit(changed ? 1 : 0);
    }
    if (!changed) { console.log('already in sync — nothing written'); process.exit(0); }
    fs.writeFileSync(OUT, next);
    console.log(`wrote ${OUT} (${list.length} recipes)`);
    process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
