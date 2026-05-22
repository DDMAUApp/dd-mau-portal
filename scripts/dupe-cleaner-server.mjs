#!/usr/bin/env node
// scripts/dupe-cleaner-server.mjs
//
// Local visual cleanup tool for the master inventory list. Andrew:
// "make somthing that i can go through and delete extras. start by
// grouping all the items with the same words in the name together
// so we can start deleting doubles".
//
// What it does:
//   1. Spins up a tiny HTTP server at http://localhost:5174
//   2. Serves a single-page UI that loads INVENTORY_CATEGORIES from
//      src/data/inventory.js and groups items by similar names
//      (Jaccard overlap on stemmed word sets, within the same
//      category — so "12oz PET Cup 360CC" + "12oz PET Cups" cluster
//      together but "Cinnamon Ground" + "Cinnamon Sticks" do too).
//   3. Each group card lists every item with a Delete button. Click
//      Delete → POST /delete → the server removes that line from
//      inventory.js and the browser drops the row.
//
// Safety: the first delete creates src/data/inventory.js.bak (a copy
// of the file before any changes this session). Subsequent deletes
// do NOT re-overwrite the backup, so the backup is always "what the
// file looked like when you started this session." Restore with:
//   mv src/data/inventory.js.bak src/data/inventory.js
//
// Item IDs are NEVER renumbered — same caveat as edit-inventory-
// dupes.mjs: any active Firestore count for a deleted ID silently
// drops off on next page load. Don't delete items staff currently
// have non-zero counts for.
//
// Usage:
//   node scripts/dupe-cleaner-server.mjs
//   # → "Open http://localhost:5174"
//   # → Ctrl-C to stop the server when done.

import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 5174);
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const inventoryPath = path.join(repoRoot, 'src', 'data', 'inventory.js');
const backupPath = inventoryPath + '.bak';

// ── helpers ──────────────────────────────────────────────────────
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
// Tiny stopword list — words too common to anchor a cluster.
const STOP = new Set([
    'and', 'or', 'the', 'with', 'for', 'of', 'in', 'on',
    'fresh', 'frozen', 'whole', 'case', 'pack', 'small', 'med',
    'medium', 'large', 'big', 'mini',
]);
function contentWords(s) {
    return normalize(s).split(/\s+/)
        .filter(Boolean)
        .map(stem)
        .filter(w => w.length >= 2 && !STOP.has(w));
}

// ── union-find ───────────────────────────────────────────────────
function makeUF(n) {
    const p = Array.from({ length: n }, (_, i) => i);
    function find(x) { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) p[ra] = rb; }
    return { find, union };
}

// Two items are in the same cluster if their content-word sets have
// Jaccard overlap ≥ 0.5 OR one is a subset of the other (with ≥ 2
// words on the shorter side, otherwise things like "Egg" pull in
// half the dairy section).
function shouldCluster(a, b) {
    if (a.size === 0 || b.size === 0) return false;
    let common = 0;
    for (const w of a) if (b.has(w)) common++;
    const union = a.size + b.size - common;
    const jaccard = common / union;
    if (jaccard >= 0.5) return true;
    if (common >= 2) {
        const shorter = Math.min(a.size, b.size);
        if (common === shorter) return true; // subset
    }
    return false;
}

// ── load + cluster ───────────────────────────────────────────────
async function loadCategories() {
    // Bust the import cache so re-fetches after a delete see the
    // updated file (same module path = ESM caches it forever).
    const href = pathToFileURL(inventoryPath).href + '?t=' + Date.now();
    const mod = await import(href);
    return mod.INVENTORY_CATEGORIES;
}

function buildPageData(categories) {
    // For each category: flatten items, cluster, return cluster
    // arrays with metadata for rendering.
    const out = [];
    for (const cat of categories) {
        const items = (cat.items || []).map(it => ({
            id: it.id,
            name: it.name,
            nameEs: it.nameEs || '',
            subcat: it.subcat || '',
            vendor: it.vendor || '',
            preferredVendor: it.preferredVendor || '',
            pack: it.pack || '',
            price: it.price ?? null,
            wordSet: new Set(contentWords(it.name)),
        }));
        const uf = makeUF(items.length);
        for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
                if (shouldCluster(items[i].wordSet, items[j].wordSet)) {
                    uf.union(i, j);
                }
            }
        }
        // Bucket by root
        const buckets = new Map();
        for (let i = 0; i < items.length; i++) {
            const r = uf.find(i);
            if (!buckets.has(r)) buckets.set(r, []);
            buckets.get(r).push(items[i]);
        }
        const clusters = [...buckets.values()]
            .filter(c => c.length > 1)
            // Pick the most "shared" word as the cluster headline
            .map(c => {
                const wordCounts = new Map();
                for (const it of c) for (const w of it.wordSet) {
                    wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
                }
                const headline = [...wordCounts.entries()]
                    .filter(([, n]) => n === c.length)  // shared by all
                    .sort((a, b) => b[0].length - a[0].length)
                    .map(([w]) => w)
                    .slice(0, 3)
                    .join(' + ') || '(varies)';
                return {
                    headline,
                    items: c.map(it => ({
                        id: it.id,
                        name: it.name,
                        nameEs: it.nameEs,
                        subcat: it.subcat,
                        vendor: it.vendor,
                        preferredVendor: it.preferredVendor,
                        pack: it.pack,
                        price: it.price,
                    })).sort((a, b) => a.name.localeCompare(b.name)),
                };
            })
            .sort((a, b) => b.items.length - a.items.length);
        if (clusters.length > 0) {
            out.push({
                categoryId: cat.id,
                categoryName: cat.name,
                clusters,
                totalItemsInCategory: items.length,
                itemsInClusters: clusters.reduce((s, c) => s + c.items.length, 0),
            });
        }
    }
    return out;
}

// ── delete from inventory.js ────────────────────────────────────
let backupTaken = false;
async function deleteIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: [] };
    // Take a one-time backup on the first delete of this session.
    if (!backupTaken) {
        try {
            await access(backupPath);
            // Existing .bak — leave it alone (could be from a prior
            // session). New deletes still go through; restore via mv.
        } catch {
            await copyFile(inventoryPath, backupPath);
        }
        backupTaken = true;
    }
    const raw = await readFile(inventoryPath, 'utf8');
    const lines = raw.split('\n');
    const idSet = new Set(ids);
    const out = [];
    const deleted = [];
    for (const line of lines) {
        const m = line.match(/\bid:\s*"([^"]+)"/);
        if (m && idSet.has(m[1])) {
            deleted.push(m[1]);
            continue;
        }
        out.push(line);
    }
    await writeFile(inventoryPath, out.join('\n'), 'utf8');
    return { deleted };
}

// ── HTML page ────────────────────────────────────────────────────
// Single-file HTML+JS+CSS. No external deps so the tool works
// offline. The data is injected as a JSON blob in a <script> tag.
function renderPage(pageData, totalItems) {
    const totalClusters = pageData.reduce((s, c) => s + c.clusters.length, 0);
    const totalInClusters = pageData.reduce((s, c) => s + c.itemsInClusters, 0);
    const dataJson = JSON.stringify(pageData).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DD Mau — Dupe Cleaner</title>
<style>
  :root {
    --bg: #f7f5ef; --fg: #1d1d1f; --fg2: #6b6b6f;
    --line: #e2e0d9; --green: #15803d; --red: #b91c1c;
    --amber: #b45309; --accent: #2a5d31;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--fg); }
  header { background: white; border-bottom: 1px solid var(--line); padding: 14px 20px; position: sticky; top: 0; z-index: 10; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header .stats { color: var(--fg2); font-size: 12px; }
  main { max-width: 1100px; margin: 0 auto; padding: 16px 20px 60px; }
  .cat { margin-top: 28px; }
  .cat h2 { font-size: 15px; font-weight: 800; color: var(--accent); margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .cluster { background: white; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
  .cluster-head { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--fg2); letter-spacing: 0.05em; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  .cluster-head .keyword { background: #fff3d4; color: var(--amber); padding: 2px 8px; border-radius: 999px; font-weight: 800; }
  .cluster-head .count { color: var(--fg2); font-weight: 600; }
  .row { display: grid; grid-template-columns: 70px 1fr auto; gap: 10px; padding: 7px 0; border-top: 1px dashed var(--line); align-items: flex-start; }
  .row:first-child { border-top: none; }
  .row.deleted { opacity: 0.35; }
  .row.deleted .name { text-decoration: line-through; }
  .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--fg2); padding-top: 2px; }
  .name { font-weight: 700; }
  .meta { font-size: 11px; color: var(--fg2); margin-top: 2px; }
  .meta span { margin-right: 10px; }
  button.del { background: white; border: 1px solid #fecaca; color: var(--red); font-weight: 700; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer; }
  button.del:hover { background: #fee2e2; }
  button.del:disabled { opacity: 0.4; cursor: not-allowed; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--fg); color: white; padding: 10px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .15s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .toast.err { background: var(--red); }
  .empty { text-align: center; color: var(--fg2); padding: 40px 0; }
  .hint { background: white; border-left: 3px solid var(--accent); padding: 8px 14px; margin-bottom: 18px; font-size: 12px; color: var(--fg2); border-radius: 0 6px 6px 0; }
  .hint b { color: var(--fg); }
</style>
</head>
<body>
<header>
  <h1>🧹 DD Mau — Master List Dupe Cleaner</h1>
  <div class="stats">
    <span id="stat-total">${totalItems} items</span> &middot;
    <span id="stat-clusters">${totalClusters} clusters with possible duplicates</span> &middot;
    <span id="stat-affected">~${totalInClusters} items to review</span> &middot;
    <span id="stat-deleted">0 deleted this session</span>
  </div>
</header>
<main>
  <div class="hint">
    <b>How to use:</b> each card below is a cluster of items whose names share enough words that one might be a duplicate of another. Click <b>Delete</b> on the rows you want to remove. Items not in any cluster aren't shown (no candidates to compare to). When you're done, run <code>git diff src/data/inventory.js</code> in your terminal to review, and commit when happy.
    <br><br>
    <b>Backup:</b> the first delete this session creates <code>src/data/inventory.js.bak</code>. To undo everything, stop the server and run <code>mv src/data/inventory.js.bak src/data/inventory.js</code>.
  </div>
  <div id="root"></div>
</main>
<div id="toast" class="toast"></div>
<script>
const data = ${dataJson};
let deletedCount = 0;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderItem(it) {
  const extras = [
    it.subcat && '<span>' + escapeHtml(it.subcat) + '</span>',
    it.preferredVendor && '<span>pref: ' + escapeHtml(it.preferredVendor) + '</span>',
    it.pack && '<span>pack: ' + escapeHtml(it.pack) + '</span>',
    it.price != null && '<span>$' + escapeHtml(it.price) + '</span>',
    it.nameEs && '<span style="color:#9c9c9c">es: ' + escapeHtml(it.nameEs) + '</span>',
  ].filter(Boolean).join('');
  return \`<div class="row" data-id="\${escapeHtml(it.id)}">
    <div class="id">\${escapeHtml(it.id)}</div>
    <div>
      <div class="name">\${escapeHtml(it.name)}</div>
      \${extras ? '<div class="meta">' + extras + '</div>' : ''}
    </div>
    <button class="del" onclick="onDelete(this, '\${escapeHtml(it.id)}')">🗑 Delete</button>
  </div>\`;
}

function renderCluster(cl) {
  return \`<div class="cluster">
    <div class="cluster-head">
      <span class="keyword">\${escapeHtml(cl.headline)}</span>
      <span class="count">\${cl.items.length} items</span>
    </div>
    \${cl.items.map(renderItem).join('')}
  </div>\`;
}

function render() {
  const root = document.getElementById('root');
  if (!data || data.length === 0) {
    root.innerHTML = '<div class="empty">🎉 No clusters detected — your master list looks clean.</div>';
    return;
  }
  root.innerHTML = data.map(cat => \`
    <div class="cat" data-cat="\${escapeHtml(cat.categoryId)}">
      <h2>\${escapeHtml(cat.categoryName)} <span style="color:#9c9c9c;font-weight:500;font-size:12px">— \${cat.clusters.length} cluster\${cat.clusters.length === 1 ? '' : 's'}</span></h2>
      \${cat.clusters.map(renderCluster).join('')}
    </div>
  \`).join('');
}

function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => { t.className = 'toast'; }, 2000);
}

async function onDelete(btn, id) {
  if (!confirm('Delete item ' + id + ' from inventory.js?\\n\\n(Backup is automatic on first delete; restore with mv src/data/inventory.js.bak src/data/inventory.js)')) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || 'delete failed');
    const row = btn.closest('.row');
    row.classList.add('deleted');
    btn.textContent = '✓ deleted';
    deletedCount++;
    document.getElementById('stat-deleted').textContent = deletedCount + ' deleted this session';
    toast('Deleted ' + id);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '🗑 Delete';
    toast('Delete failed: ' + e.message, true);
  }
}

render();
</script>
</body>
</html>`;
}

// ── server ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
            const cats = await loadCategories();
            const pageData = buildPageData(cats);
            const totalItems = cats.reduce((s, c) => s + (c.items?.length || 0), 0);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderPage(pageData, totalItems));
            return;
        }
        if (req.method === 'POST' && req.url === '/delete') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', async () => {
                try {
                    const { ids } = JSON.parse(body);
                    const result = await deleteIds(ids);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, deleted: result.deleted }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
                }
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(e?.message || e));
    }
});

server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log('');
    console.log('  🧹  DD Mau — Master List Dupe Cleaner');
    console.log('  ────────────────────────────────────');
    console.log(`  Open this in your browser: \x1b[36m\x1b[1m${url}\x1b[0m`);
    console.log('');
    console.log('  Each Delete click edits src/data/inventory.js right away.');
    console.log('  First delete auto-backs up to src/data/inventory.js.bak.');
    console.log('  When you\'re done, Ctrl-C to stop the server.');
    console.log('');
});
