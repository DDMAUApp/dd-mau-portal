#!/usr/bin/env node
// scripts/find-inventory-dupes.mjs
//
// Find likely duplicates in the master inventory catalog
// (src/data/inventory.js → INVENTORY_CATEGORIES).
//
// Why: Andrew flagged the master list has too many doubles, which
// makes counting confusing. This script reads the source, normalizes
// item names, and surfaces three flavors of duplicate so you can
// review + merge them by editing inventory.js.
//
// Usage:
//   node scripts/find-inventory-dupes.mjs
//   node scripts/find-inventory-dupes.mjs --verbose   # also show subcat/vendor/pack
//   node scripts/find-inventory-dupes.mjs --json      # machine-readable
//
// What it surfaces, in order:
//   1. EXACT — same name after normalization (parens stripped, pack
//      info stripped, lowercased). Strongest signal; almost always
//      a real dup.
//   2. WORD ORDER — same set of words in a different order. Catches
//      "Shrimp 21/25" vs "21/25 Shrimp" without false-positiving on
//      genuinely different items.
//   3. CONTAINMENT — one normalized name is a substring of another.
//      Catches "Baking Powder" vs "Clabber Girl Baking Powder, 4 lbs".
//      Most noise lives here — review with the most skepticism.
//
// Each group prints the item id, category, name, and (with --verbose)
// the metadata you need to decide which entry to keep.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const inventoryPath = path.join(repoRoot, 'src', 'data', 'inventory.js');

// Dynamic-import the source module. inventory.js is pure data (no
// side effects, no React imports), so importing it from Node works
// directly without a build step.
const mod = await import(pathToFileURL(inventoryPath).href);
const CATEGORIES = mod.INVENTORY_CATEGORIES;
if (!Array.isArray(CATEGORIES)) {
    console.error('Could not load INVENTORY_CATEGORIES from', inventoryPath);
    process.exit(1);
}

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose') || args.has('-v');
const jsonOut = args.has('--json');

// ── normalize ──────────────────────────────────────────────────────
//
// Conservative: lowercase, strip punctuation → space, collapse
// whitespace. We INTENTIONALLY do NOT strip parens or size prefixes —
// "Cabbage (Green)" vs "Cabbage (Red/Purple)" are different items,
// "Shrimp (16/20)" vs "Shrimp (31/40)" are different items, "12LB
// Brown Bag" vs "25LB Brown Bag" are different items. An earlier
// version of this script stripped all that and produced 15 false-
// positive "exact" duplicates. Better to under-match than over-match.
function normalize(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Crude singular form so "Lid" + "Lids" and "Tip" + "Tips" collide
// in the word-set matchers. Skip very short words and double-s
// endings ("less", "loss", etc).
function stem(w) {
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) {
        return w.slice(0, -1);
    }
    return w;
}

// ── flatten ────────────────────────────────────────────────────────
// One row per item with the category context baked in. We carry the
// raw name + the normalized variants used by the matchers.
const items = [];
for (const cat of CATEGORIES) {
    for (const it of (cat.items || [])) {
        const raw = (it.name || '').trim();
        const norm = normalize(raw);
        const words = norm.split(/\s+/).filter(Boolean);
        const stemWords = words.map(stem);
        items.push({
            id: it.id,
            name: raw,
            nameEs: it.nameEs || '',
            categoryId: cat.id,
            categoryName: cat.name,
            subcat: it.subcat || '',
            vendor: it.vendor || '',
            preferredVendor: it.preferredVendor || '',
            pack: it.pack || '',
            price: it.price ?? null,
            norm,
            words,
            stemWords,
            // Sorted-multiset key for "same words different order"
            wordKey: stemWords.slice().sort().join(' '),
            // Word set (no duplicates) for subset matching
            wordSet: new Set(stemWords),
        });
    }
}

// ── group: exact normalized match ──────────────────────────────────
const byNorm = new Map();
for (const it of items) {
    if (!it.norm) continue;
    if (!byNorm.has(it.norm)) byNorm.set(it.norm, []);
    byNorm.get(it.norm).push(it);
}
const exactGroups = [...byNorm.values()].filter(g => g.length > 1);

// ── group: same words, different order ─────────────────────────────
// Skip groups already caught by exact (their wordKey is the same).
const inExact = new Set();
for (const g of exactGroups) for (const it of g) inExact.add(it.id);
const byWordKey = new Map();
for (const it of items) {
    if (inExact.has(it.id)) continue;
    if (!it.wordKey) continue;
    if (!byWordKey.has(it.wordKey)) byWordKey.set(it.wordKey, []);
    byWordKey.get(it.wordKey).push(it);
}
const wordOrderGroups = [...byWordKey.values()].filter(g => g.length > 1);

// ── pairs: word-set subset ─────────────────────────────────────────
//
// One item's stemmed word set is a STRICT subset of another's. Catches:
//   • "Baking Powder" ⊊ "Clabber Girl Baking Powder, 4 lbs"
//   • "Ball Tips" ⊊ "Beef Ball Tip"            (via stemming)
//   • "Cinnamon Ground" ⊊ "Cinnamon Ground, 5 lbs"
//
// Word-set (not multiset) so "Sugar Sugar" wouldn't fool it. We
// require:
//   • The shorter side has ≥ 2 words (single-word subset is noise —
//     "Egg" is a subset of every dish with egg in it)
//   • Skip items already grouped by an earlier (higher-confidence)
//     matcher
const inWordOrder = new Set();
for (const g of wordOrderGroups) for (const it of g) inWordOrder.add(it.id);

function isStrictSubset(a, b) {
    // a, b are Sets. Returns true iff a ⊊ b.
    if (a.size >= b.size) return false;
    for (const w of a) if (!b.has(w)) return false;
    return true;
}

const subsetPairs = [];
for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (inExact.has(a.id) || inWordOrder.has(a.id)) continue;
    if (a.wordSet.size < 2) continue;
    for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        if (inExact.has(b.id) || inWordOrder.has(b.id)) continue;
        if (b.wordSet.size < 2) continue;
        if (isStrictSubset(a.wordSet, b.wordSet) || isStrictSubset(b.wordSet, a.wordSet)) {
            subsetPairs.push([a, b]);
        }
    }
}

// ── output ─────────────────────────────────────────────────────────
if (jsonOut) {
    console.log(JSON.stringify({
        totalItems: items.length,
        categories: CATEGORIES.length,
        exactGroups,
        wordOrderGroups,
        subsetPairs: subsetPairs.map(([a, b]) => [a, b]),
    }, null, 2));
    process.exit(0);
}

const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;

function fmtItem(it) {
    const main = `  · ${cyan(it.id)}  ${it.name}  ${dim(`[${it.categoryName}]`)}`;
    if (!verbose) return main;
    const extras = [
        it.subcat && `subcat=${it.subcat}`,
        it.preferredVendor && `pref=${it.preferredVendor}`,
        it.pack && `pack=${it.pack}`,
        it.price != null && `$${it.price}`,
        it.nameEs && `es="${it.nameEs}"`,
    ].filter(Boolean).join('  ');
    return `${main}\n    ${dim(extras)}`;
}

console.log(bold(`\nMaster inventory: ${items.length} items across ${CATEGORIES.length} categories\n`));

// 1. Exact
console.log(red(bold(`══ EXACT DUPLICATES — ${exactGroups.length} group${exactGroups.length === 1 ? '' : 's'} ══`)));
console.log(dim('Same normalized name. Highest confidence — almost always a real duplicate.\n'));
if (exactGroups.length === 0) {
    console.log(dim('  (none)\n'));
} else {
    exactGroups.forEach((g, i) => {
        console.log(`${yellow(`#${i + 1}`)}  ${bold(`"${g[0].norm}"`)}  (${g.length} items)`);
        g.forEach(it => console.log(fmtItem(it)));
        console.log('');
    });
}

// 2. Word order
console.log(red(bold(`══ SAME WORDS, DIFFERENT ORDER — ${wordOrderGroups.length} group${wordOrderGroups.length === 1 ? '' : 's'} ══`)));
console.log(dim('"Shrimp 21/25" vs "21/25 Shrimp". Strong signal too.\n'));
if (wordOrderGroups.length === 0) {
    console.log(dim('  (none)\n'));
} else {
    wordOrderGroups.forEach((g, i) => {
        console.log(`${yellow(`#${i + 1}`)}  words: ${bold(g[0].wordKey)}`);
        g.forEach(it => console.log(fmtItem(it)));
        console.log('');
    });
}

// 3. Subset
console.log(red(bold(`══ SUBSET — ${subsetPairs.length} pair${subsetPairs.length === 1 ? '' : 's'} ══`)));
console.log(dim('One item\'s words are all inside the other. Noisier — review carefully.\n'));
if (subsetPairs.length === 0) {
    console.log(dim('  (none)\n'));
} else {
    subsetPairs.forEach(([a, b], i) => {
        console.log(`${yellow(`#${i + 1}`)}`);
        console.log(fmtItem(a));
        console.log(fmtItem(b));
        console.log('');
    });
}

// Summary
const dupItemCount =
    exactGroups.reduce((s, g) => s + g.length, 0)
    + wordOrderGroups.reduce((s, g) => s + g.length, 0)
    + subsetPairs.length * 2;
console.log(bold('Summary:'));
console.log(`  Total items          : ${items.length}`);
console.log(`  Exact dup groups     : ${exactGroups.length}`);
console.log(`  Word-order dup groups: ${wordOrderGroups.length}`);
console.log(`  Subset pairs         : ${subsetPairs.length}`);
console.log(`  Items touched        : ~${dupItemCount}`);
console.log('');
console.log(dim('Edit src/data/inventory.js to merge or remove duplicates, then commit.'));
console.log(dim('Tip: add --verbose to see subcat/vendor/pack on each row.'));
console.log('');
