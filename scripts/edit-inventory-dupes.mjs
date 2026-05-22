#!/usr/bin/env node
// scripts/edit-inventory-dupes.mjs
//
// Interactive editor that walks the duplicate candidates from
// find-inventory-dupes.mjs and rewrites src/data/inventory.js in
// place based on your choices.
//
// Usage:
//   node scripts/edit-inventory-dupes.mjs              # interactive
//   node scripts/edit-inventory-dupes.mjs --dry-run    # show planned
//                                                       changes but
//                                                       don't write
//
// Per pair the choices are:
//   a  delete A (keep B)
//   b  delete B (keep A)
//   s  skip — not a duplicate
//   q  save what you've decided so far and quit
//
// After picking a/b you're prompted to rename the kept item — Enter
// keeps its current name, anything else replaces it.
//
// What gets edited:
//   • Deleted item: its whole line is removed from inventory.js
//   • Renamed item: only the `name: "..."` field on its line is
//     swapped; nameEs / vendor / pack / price / etc. are untouched
//
// What doesn't get touched:
//   • Item IDs — these are referenced by Firestore counts + snapshots
//     and the historic data layer assumes ID stability. Deleting an
//     item just removes the master entry; any active count for the
//     deleted ID will silently drop off the inventory page on next
//     load. If you want to MERGE counts (move 0-1's count onto 0-2),
//     that needs a separate Firestore migration — out of scope here.
//
// Safety: the script writes inventory.js only at the very end, after
// you've answered every prompt or hit `q`. On any change at all it
// also writes a backup at src/data/inventory.js.bak (overwrites the
// previous backup) so you can `mv inventory.js.bak inventory.js`
// to undo.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import readline from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const inventoryPath = path.join(repoRoot, 'src', 'data', 'inventory.js');
const backupPath = inventoryPath + '.bak';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || args.has('-n');

// ── load + flatten ────────────────────────────────────────────────
const mod = await import(pathToFileURL(inventoryPath).href);
const CATEGORIES = mod.INVENTORY_CATEGORIES;
if (!Array.isArray(CATEGORIES)) {
    console.error('Could not load INVENTORY_CATEGORIES from', inventoryPath);
    process.exit(1);
}

function normalize(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function stem(w) {
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
}

const items = [];
for (const cat of CATEGORIES) {
    for (const it of (cat.items || [])) {
        const raw = (it.name || '').trim();
        const norm = normalize(raw);
        const stemWords = norm.split(/\s+/).filter(Boolean).map(stem);
        items.push({
            id: it.id,
            name: raw,
            nameEs: it.nameEs || '',
            categoryName: cat.name,
            subcat: it.subcat || '',
            preferredVendor: it.preferredVendor || '',
            pack: it.pack || '',
            price: it.price ?? null,
            norm,
            wordKey: stemWords.slice().sort().join(' '),
            wordSet: new Set(stemWords),
        });
    }
}

// ── detect pairs ──────────────────────────────────────────────────
// Mirror of find-inventory-dupes.mjs's three matchers. Kept inline
// here so this script stays self-contained (the detection logic is
// small and unlikely to drift far from the reporter).
const exactGroups = (() => {
    const m = new Map();
    for (const it of items) {
        if (!it.norm) continue;
        if (!m.has(it.norm)) m.set(it.norm, []);
        m.get(it.norm).push(it);
    }
    return [...m.values()].filter(g => g.length > 1);
})();
const inExact = new Set();
for (const g of exactGroups) for (const it of g) inExact.add(it.id);

const wordOrderGroups = (() => {
    const m = new Map();
    for (const it of items) {
        if (inExact.has(it.id)) continue;
        if (!it.wordKey) continue;
        if (!m.has(it.wordKey)) m.set(it.wordKey, []);
        m.get(it.wordKey).push(it);
    }
    return [...m.values()].filter(g => g.length > 1);
})();
const inWordOrder = new Set();
for (const g of wordOrderGroups) for (const it of g) inWordOrder.add(it.id);

function isStrictSubset(a, b) {
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

// Flatten everything into a single ordered queue of pairs to review.
// Each entry: { tier, a, b }. Groups of >2 become n-1 sequential
// pairs against the first item.
const queue = [];
for (const g of exactGroups) {
    const head = g[0];
    for (let i = 1; i < g.length; i++) queue.push({ tier: 'EXACT', a: head, b: g[i] });
}
for (const g of wordOrderGroups) {
    const head = g[0];
    for (let i = 1; i < g.length; i++) queue.push({ tier: 'WORD ORDER', a: head, b: g[i] });
}
for (const [a, b] of subsetPairs) queue.push({ tier: 'SUBSET', a, b });

// ── colors ────────────────────────────────────────────────────────
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;

function fmtItem(it, label) {
    const extras = [
        it.subcat && `subcat=${it.subcat}`,
        it.preferredVendor && `pref=${it.preferredVendor}`,
        it.pack && `pack=${it.pack}`,
        it.price != null && `$${it.price}`,
        it.nameEs && `es="${it.nameEs}"`,
    ].filter(Boolean).join('  ');
    return `  ${bold(label)}. ${cyan(it.id)}  ${it.name}  ${dim(`[${it.categoryName}]`)}` +
           (extras ? `\n      ${dim(extras)}` : '');
}

// ── interactive loop ──────────────────────────────────────────────
//
// Use the async-iterator over readline instead of rl.question. Two
// reasons:
//   1. rl.question + a separate 'close' listener has a race when
//      stdin closes — close can fire before the buffered 'line' is
//      delivered, so the pending question receives 'q' instead of
//      the buffered empty line. The async iterator delivers buffered
//      lines first, then returns done, so order is well-defined.
//   2. EOF (Ctrl-D, or piped input ending) cleanly returns 'q'
//      without an "unsettled top-level await" warning.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lineIter = rl[Symbol.asyncIterator]();
async function ask(q) {
    process.stdout.write(q);
    const { value, done } = await lineIter.next();
    if (done) return 'q';
    return value;
}

console.log(bold(`\nMaster inventory: ${items.length} items, ${queue.length} duplicate candidates\n`));
if (queue.length === 0) {
    console.log(green('No duplicates detected — nothing to do.\n'));
    rl.close();
    process.exit(0);
}
if (dryRun) console.log(yellow('--dry-run: no changes will be written\n'));

const deletions = new Set();   // ids to delete
const renames = new Map();      // id → new name
let quit = false;

for (let i = 0; i < queue.length && !quit; i++) {
    const { tier, a, b } = queue[i];
    // Skip if either side was already chopped by an earlier decision.
    if (deletions.has(a.id) || deletions.has(b.id)) continue;

    console.log(dim(`\n──────── ${i + 1} / ${queue.length} ────────`));
    console.log(`${red(bold(tier))}`);
    console.log(fmtItem(a, 'A'));
    console.log(fmtItem(b, 'B'));
    console.log('');

    let answered = false;
    while (!answered) {
        const ans = (await ask(`  ${bold('[a]')} delete A  ${bold('[b]')} delete B  ${bold('[s]')} skip  ${bold('[q]')} save+quit  > `)).trim().toLowerCase();
        if (ans === 'q') { quit = true; answered = true; break; }
        if (ans === 's' || ans === '') { answered = true; break; }
        if (ans !== 'a' && ans !== 'b') {
            console.log(dim('  (not a valid choice)'));
            continue;
        }
        const drop = ans === 'a' ? a : b;
        const keep = ans === 'a' ? b : a;
        deletions.add(drop.id);
        console.log(`  ${green(`✓ will delete ${drop.id} (${drop.name})`)}`);
        const rename = (await ask(`  ${dim(`Rename "${keep.name}"? Enter to keep, or type new name: `)}`)).trim();
        if (rename && rename !== keep.name) {
            renames.set(keep.id, rename);
            console.log(`  ${green(`✓ will rename ${keep.id} → "${rename}"`)}`);
        }
        answered = true;
    }
}
rl.close();

// ── summary ───────────────────────────────────────────────────────
console.log(bold(`\n${'─'.repeat(48)}`));
console.log(bold('Decisions:'));
console.log(`  delete: ${deletions.size}`);
console.log(`  rename: ${renames.size}`);
console.log(`  pairs reviewed: ${queue.filter((_, i) => i < queue.length && !quit || true).length}`);

if (deletions.size === 0 && renames.size === 0) {
    console.log(dim('\nNothing to write.\n'));
    process.exit(0);
}

// ── rewrite inventory.js text ─────────────────────────────────────
// Each item entry is on a single line of the form:
//   { id: "0-1", name: "Ball Tips", nameEs: "...", ... },
// so a line-by-line replace is safe. We match `id: "X-Y"` (string
// id) — categories carry numeric ids (`id: 0`), so they're never
// matched.
const raw = await readFile(inventoryPath, 'utf8');
const inputLines = raw.split('\n');
const outputLines = [];
let droppedCount = 0;
let renamedCount = 0;
for (const line of inputLines) {
    const idMatch = line.match(/\bid:\s*"([^"]+)"/);
    if (!idMatch) {
        outputLines.push(line);
        continue;
    }
    const id = idMatch[1];
    if (deletions.has(id)) {
        droppedCount++;
        continue;
    }
    if (renames.has(id)) {
        const newName = renames.get(id);
        // Replace the FIRST `name: "..."` on the line. Each item line
        // has exactly one (nameEs comes right after but has its own
        // distinct key, so the regex won't accidentally grab it).
        const next = line.replace(/name:\s*"([^"\\]|\\.)*"/, `name: ${JSON.stringify(newName)}`);
        outputLines.push(next);
        renamedCount++;
        continue;
    }
    outputLines.push(line);
}

console.log(`  lines dropped: ${droppedCount}`);
console.log(`  lines renamed: ${renamedCount}`);
console.log('');

if (dryRun) {
    console.log(yellow('--dry-run — not writing. Sample of planned changes:'));
    const sampleDeletes = [...deletions].slice(0, 5);
    sampleDeletes.forEach(id => {
        const it = items.find(x => x.id === id);
        console.log(`  - DELETE ${id}: ${it ? it.name : '?'}`);
    });
    if (deletions.size > 5) console.log(`  ... and ${deletions.size - 5} more`);
    [...renames.entries()].slice(0, 5).forEach(([id, name]) => {
        const it = items.find(x => x.id === id);
        console.log(`  ~ RENAME ${id}: "${it ? it.name : '?'}" → "${name}"`);
    });
    if (renames.size > 5) console.log(`  ... and ${renames.size - 5} more`);
    console.log('');
    process.exit(0);
}

await copyFile(inventoryPath, backupPath);
await writeFile(inventoryPath, outputLines.join('\n'), 'utf8');
console.log(green(`✓ wrote ${inventoryPath}`));
console.log(dim(`  backup at ${backupPath} — restore with: mv "${backupPath}" "${inventoryPath}"`));
console.log('');
console.log(dim('Now: review the diff (git diff src/data/inventory.js) and commit when happy.'));
console.log('');
