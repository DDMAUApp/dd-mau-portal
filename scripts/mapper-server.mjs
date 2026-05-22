#!/usr/bin/env node
// scripts/mapper-server.mjs
//
// Visual tool for mapping the CURRENT master inventory list
// (src/data/inventory.js) onto the NEW one Andrew uploaded
// (scripts/data/new-master.json — built from his original "started
// it all" xlsx via scripts/parse-new-master.py).
//
// Andrew's pitch: "make this at the master list and ill match each
// item to this list i uploaded and the rest that doesnt fit i can
// see where it needs to go."
//
// The workflow has two halves:
//   1. THIS TOOL — interactively map each current item to a new
//      master item (or mark Drop / Keep-as-is). Mappings persist
//      in localStorage so you can step away and come back. Hit
//      "Export mappings" when done — it downloads mappings.json.
//   2. APPLY (separate step, run later) — once the mappings.json is
//      ready I'll generate the new inventory.js + a Firestore count-
//      remap migration plan. The two-step split keeps the destructive
//      part (rewriting inventory.js + remapping live counts) behind
//      a human review gate.
//
// Why same-pattern local server vs adding to the app: same reasons
// as dupe-cleaner-server. Filesystem access for the source file,
// no build pipeline involvement, easy to throw away when the
// migration is done.
//
// Usage:
//   node scripts/mapper-server.mjs
//   # open http://localhost:5175 (different port from dupe cleaner
//   # so they can run side by side if needed)

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 5175);
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const inventoryPath = path.join(repoRoot, 'src', 'data', 'inventory.js');
const newMasterPath = path.join(repoRoot, 'scripts', 'data', 'new-master.json');

// ── normalize + word set helpers (shared with dupe cleaner) ──────
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
const STOP = new Set([
    'and', 'or', 'the', 'with', 'for', 'of', 'in', 'on',
    'fresh', 'frozen', 'whole', 'case', 'pack',
]);
function contentWords(s) {
    return normalize(s).split(/\s+/)
        .filter(Boolean)
        .map(stem)
        .filter(w => w.length >= 2 && !STOP.has(w));
}
function jaccard(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let common = 0;
    for (const w of a) if (b.has(w)) common++;
    return common / (a.size + b.size - common);
}

// ── load data ────────────────────────────────────────────────────
async function loadCurrent() {
    const href = pathToFileURL(inventoryPath).href + '?t=' + Date.now();
    const mod = await import(href);
    const cats = mod.INVENTORY_CATEGORIES;
    const items = [];
    for (const cat of cats) {
        for (const it of (cat.items || [])) {
            items.push({
                id: it.id,
                name: it.name,
                nameEs: it.nameEs || '',
                category: cat.name,
                subcat: it.subcat || '',
                vendor: it.vendor || '',
                preferredVendor: it.preferredVendor || '',
                pack: it.pack || '',
                price: it.price ?? null,
            });
        }
    }
    return { categories: cats, items };
}

async function loadNewMaster() {
    const raw = await readFile(newMasterPath, 'utf8');
    const data = JSON.parse(raw);
    const items = [];
    for (const cat of data.categories) {
        for (const it of cat.items) {
            items.push({
                // Synthetic key for now — final inventory.js IDs will
                // be assigned at apply time once the structure is
                // confirmed. Format: "<cat-slug>:<en>".
                key: `${slug(cat.name)}:${slug(it.en)}`,
                en: it.en,
                es: it.es,
                category: cat.name,
                vendor1: it.vendor1,
                vendor2: it.vendor2,
                tues: it.tues,
                fri: it.fri,
            });
        }
    }
    return { categories: data.categories, items, meta: { sourceFile: data.sourceFile, parsedAt: data.parsedAt, totalItems: data.totalItems } };
}
function slug(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, ''); }

// ── auto-match: for each current item, score every new item ─────
//
// Scoring:
//   100  exact normalized English name match
//    90  exact normalized Spanish name match
//   60-90 word-set Jaccard ≥ 0.5 (scaled)
//   40-70 subset (smaller word set fully contained, ≥ 2 shared words)
// Below 30 → no suggestion (current item is "unmatched" by default).
function bestMatch(current, newItems) {
    const curEnNorm = normalize(current.name);
    const curEsNorm = normalize(current.nameEs);
    const curWords = new Set(contentWords(current.name));
    const curWordsEs = new Set(contentWords(current.nameEs));
    let best = null;
    let bestScore = 0;
    for (const ni of newItems) {
        let score = 0;
        const niEnNorm = normalize(ni.en);
        const niEsNorm = normalize(ni.es);
        if (curEnNorm && curEnNorm === niEnNorm) score = Math.max(score, 100);
        if (curEsNorm && curEsNorm === niEsNorm) score = Math.max(score, 90);
        if (score < 100) {
            const niWords = new Set(contentWords(ni.en));
            const niWordsEs = new Set(contentWords(ni.es));
            const jEn = jaccard(curWords, niWords);
            const jEs = curWordsEs.size > 0 && niWordsEs.size > 0 ? jaccard(curWordsEs, niWordsEs) : 0;
            const j = Math.max(jEn, jEs);
            if (j >= 0.5) score = Math.max(score, 60 + j * 30);
            // Subset (en only — Spanish text is messier)
            if (niWords.size > 0 && curWords.size > 0) {
                let common = 0;
                for (const w of curWords) if (niWords.has(w)) common++;
                if (common >= 2) {
                    const shorter = Math.min(curWords.size, niWords.size);
                    if (common === shorter) {
                        score = Math.max(score, 40 + (common / Math.max(curWords.size, niWords.size)) * 30);
                    }
                }
            }
        }
        if (score > bestScore) { bestScore = score; best = ni; }
    }
    return bestScore >= 30 ? { key: best.key, score: Math.round(bestScore) } : null;
}

// ── build the page data the browser uses ─────────────────────────
async function buildPageData() {
    const current = await loadCurrent();
    const newMaster = await loadNewMaster();
    // Index new items by category for quick render
    const newByCategory = {};
    for (const ni of newMaster.items) {
        if (!newByCategory[ni.category]) newByCategory[ni.category] = [];
        newByCategory[ni.category].push(ni);
    }
    // For each current item, compute a default suggestion
    const suggestions = {};
    for (const cur of current.items) {
        const b = bestMatch(cur, newMaster.items);
        suggestions[cur.id] = b;
    }
    return {
        current: current.items,
        newMaster: newMaster.items,
        newByCategory,
        newCategories: newMaster.categories.map(c => c.name),
        suggestions,
        meta: {
            currentCount: current.items.length,
            newCount: newMaster.items.length,
            sourceFile: newMaster.meta.sourceFile,
            parsedAt: newMaster.meta.parsedAt,
        },
    };
}

// ── HTML / JS / CSS for the page (single-file, no deps) ──────────
function renderPage(pageData) {
    const dataJson = JSON.stringify(pageData).replace(/</g, '\\u003c');
    const { meta } = pageData;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DD Mau — Master List Mapper</title>
<style>
  :root {
    --bg: #f7f5ef; --fg: #1d1d1f; --fg2: #6b6b6f; --line: #e2e0d9;
    --green: #15803d; --green-bg: #dcfce7;
    --amber: #b45309; --amber-bg: #fef3c7;
    --red: #b91c1c; --red-bg: #fee2e2;
    --accent: #2a5d31; --blue: #1e40af; --blue-bg: #dbeafe;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--fg); }
  header { background: white; border-bottom: 1px solid var(--line); padding: 12px 18px; position: sticky; top: 0; z-index: 20; }
  header h1 { margin: 0 0 4px; font-size: 17px; }
  header .stats { color: var(--fg2); font-size: 12px; display: flex; gap: 14px; flex-wrap: wrap; }
  header .stats b { color: var(--fg); font-weight: 800; }
  header .stats .stat-matched b { color: var(--green); }
  header .stats .stat-drop b { color: var(--red); }
  header .stats .stat-keep b { color: var(--blue); }
  header .stats .stat-pending b { color: var(--amber); }
  header button.export { background: var(--accent); color: white; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 700; font-size: 12px; cursor: pointer; margin-left: auto; }
  header button.export:hover { background: #1f4724; }
  .layout { display: grid; grid-template-columns: 320px 1fr; gap: 14px; max-width: 1400px; margin: 0 auto; padding: 12px 18px 60px; }
  /* LEFT pane — new master tree */
  aside { background: white; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; position: sticky; top: 78px; height: calc(100vh - 100px); overflow-y: auto; }
  aside h3 { margin: 0 0 8px; font-size: 13px; color: var(--accent); }
  aside .src { font-size: 10px; color: var(--fg2); margin-bottom: 10px; }
  aside .nm-cat { margin-bottom: 12px; }
  aside .nm-cat > div.head { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg2); padding: 4px 0; cursor: pointer; user-select: none; display: flex; justify-content: space-between; align-items: center; }
  aside .nm-cat > div.head:hover { color: var(--fg); }
  aside .nm-item { font-size: 12px; padding: 3px 6px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  aside .nm-item:hover { background: var(--bg); cursor: pointer; }
  aside .nm-item .badge { font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 999px; background: var(--bg); color: var(--fg2); flex-shrink: 0; }
  aside .nm-item .badge.linked { background: var(--green-bg); color: var(--green); }
  /* RIGHT pane — current items */
  main { background: transparent; }
  .search { background: white; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 14px; display: flex; gap: 10px; align-items: center; }
  .search input { flex: 1; padding: 8px 12px; font-size: 13px; border: 1px solid var(--line); border-radius: 6px; outline: none; }
  .search input:focus { border-color: var(--accent); }
  .search .filter-pills { display: flex; gap: 6px; }
  .search button.pill { font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: white; color: var(--fg2); cursor: pointer; }
  .search button.pill.active { background: var(--fg); color: white; border-color: var(--fg); }
  .cat-group { margin-bottom: 18px; }
  .cat-group h2 { font-size: 14px; font-weight: 800; color: var(--accent); margin: 0 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
  .row { background: white; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; display: flex; gap: 10px; align-items: flex-start; }
  .row.matched { border-left: 3px solid var(--green); }
  .row.dropped { border-left: 3px solid var(--red); opacity: 0.5; }
  .row.kept { border-left: 3px solid var(--blue); }
  .row.pending { border-left: 3px solid var(--amber); }
  .row.hidden { display: none; }
  .row .left { flex: 1 1 50%; min-width: 0; }
  .row .id { font-family: ui-monospace, monospace; font-size: 10px; color: var(--fg2); }
  .row .name { font-weight: 700; font-size: 13px; }
  .row.dropped .name { text-decoration: line-through; }
  .row .meta { font-size: 11px; color: var(--fg2); margin-top: 2px; }
  .row .meta span { margin-right: 8px; }
  .row .right { flex: 1 1 50%; min-width: 0; }
  .arrow { color: var(--fg2); font-weight: 700; margin: 0 6px; }
  .maps-to { font-size: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .maps-to .target { font-weight: 700; padding: 2px 8px; border-radius: 4px; }
  .maps-to .target.score-high { background: var(--green-bg); color: var(--green); }
  .maps-to .target.score-med { background: var(--amber-bg); color: var(--amber); }
  .maps-to .target.score-low { background: var(--bg); color: var(--fg2); }
  .maps-to .target.dropped { background: var(--red-bg); color: var(--red); }
  .maps-to .target.kept { background: var(--blue-bg); color: var(--blue); }
  .actions { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
  .actions button { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--line); background: white; cursor: pointer; color: var(--fg2); }
  .actions button:hover { background: var(--bg); color: var(--fg); }
  .actions button.danger:hover { background: var(--red-bg); color: var(--red); border-color: #fecaca; }
  .actions button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  .actions button.primary:hover { background: #1f4724; }
  .picker { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 30; }
  .picker .panel { background: white; border-radius: 10px; padding: 14px; max-width: 600px; width: 90%; max-height: 80vh; display: flex; flex-direction: column; }
  .picker .panel h3 { margin: 0 0 8px; font-size: 14px; }
  .picker input { width: 100%; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 13px; margin-bottom: 8px; }
  .picker .results { flex: 1; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; padding: 4px; }
  .picker .result { padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .picker .result:hover { background: var(--bg); }
  .picker .result .cat { font-size: 10px; color: var(--fg2); }
  .picker .close { background: var(--line); color: var(--fg2); border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; align-self: flex-end; margin-top: 8px; font-weight: 700; }
  .toast { position: fixed; bottom: 16px; right: 16px; background: var(--fg); color: white; padding: 8px 14px; border-radius: 6px; font-size: 12px; opacity: 0; transition: opacity .15s; pointer-events: none; z-index: 40; }
  .toast.show { opacity: 1; }
  /* Helpful pings for low-confidence rows */
  .conf-note { font-size: 10px; color: var(--amber); font-weight: 700; }
</style>
</head>
<body>
<header>
  <h1>🔗 DD Mau — Master List Mapper</h1>
  <div class="stats">
    <span>📋 Current: <b id="stat-cur">${meta.currentCount}</b></span>
    <span>🎯 New master: <b id="stat-new">${meta.newCount}</b> <span style="color:#9c9c9c">(from ${meta.sourceFile})</span></span>
    <span class="stat-matched">✓ Matched: <b id="stat-matched">0</b></span>
    <span class="stat-pending">⌛ Pending: <b id="stat-pending">${meta.currentCount}</b></span>
    <span class="stat-keep">💭 Keep separate: <b id="stat-keep">0</b></span>
    <span class="stat-drop">🗑 Drop: <b id="stat-drop">0</b></span>
    <button class="export" onclick="exportMappings()">📥 Export mappings.json</button>
  </div>
</header>
<div class="layout">
  <aside>
    <h3>🎯 New master items</h3>
    <div class="src">${meta.newCount} items from ${meta.sourceFile}<br>Linked-count badges update as you map.</div>
    <div id="aside-tree"></div>
  </aside>
  <main>
    <div class="search">
      <input id="q" type="search" placeholder="🔍 Filter current items by name, vendor, category..." />
      <div class="filter-pills">
        <button class="pill active" data-pf="all" onclick="setPillFilter(this)">all</button>
        <button class="pill" data-pf="pending" onclick="setPillFilter(this)">⌛ pending</button>
        <button class="pill" data-pf="matched" onclick="setPillFilter(this)">✓ matched</button>
        <button class="pill" data-pf="kept" onclick="setPillFilter(this)">💭 kept</button>
        <button class="pill" data-pf="dropped" onclick="setPillFilter(this)">🗑 dropped</button>
      </div>
    </div>
    <div id="root"></div>
  </main>
</div>
<div id="toast" class="toast"></div>
<script>
const data = ${dataJson};
const STORAGE_KEY = 'ddmau-mapper-v1';

// Mappings state: { currentId: { action: 'match'|'drop'|'keep'|'pending', newKey?: string, score?: number } }
let mappings = loadMappings();
let pillFilter = 'all';

// Initialize with auto-suggestions for any pending rows
for (const cur of data.current) {
  if (!mappings[cur.id] || mappings[cur.id].action === 'pending') {
    const sug = data.suggestions[cur.id];
    if (sug) {
      mappings[cur.id] = { action: 'pending', newKey: sug.key, score: sug.score };
    } else {
      mappings[cur.id] = { action: 'pending', newKey: null, score: 0 };
    }
  }
}

function saveMappings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(mappings)); } catch(e) {}
}
function loadMappings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch(e) { return {}; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function newItemByKey(key) {
  return data.newMaster.find(n => n.key === key);
}

function renderAsideTree() {
  // Count links per new key
  const linked = {};
  for (const cur of data.current) {
    const m = mappings[cur.id];
    if (m && (m.action === 'match' || (m.action === 'pending' && m.newKey)) && m.newKey) {
      linked[m.newKey] = (linked[m.newKey] || 0) + 1;
    }
  }
  const out = [];
  for (const catName of data.newCategories) {
    const items = data.newByCategory[catName] || [];
    const totalLinked = items.reduce((s, ni) => s + (linked[ni.key] || 0), 0);
    out.push('<div class="nm-cat">');
    out.push(\`<div class="head"><span>\${escapeHtml(catName)}</span><span class="badge\${totalLinked ? ' linked' : ''}">\${totalLinked}/\${items.length}</span></div>\`);
    for (const ni of items) {
      const n = linked[ni.key] || 0;
      out.push(\`<div class="nm-item" onclick="filterByNewKey('\${escapeHtml(ni.key)}')"><span>\${escapeHtml(ni.en)}\${ni.es ? ' <span style="color:#9c9c9c">· '+escapeHtml(ni.es)+'</span>' : ''}</span><span class="badge\${n>0?' linked':''}">\${n}</span></div>\`);
    }
    out.push('</div>');
  }
  document.getElementById('aside-tree').innerHTML = out.join('');
}

function rowStateClass(m) {
  if (!m) return 'pending';
  if (m.action === 'drop') return 'dropped';
  if (m.action === 'keep') return 'kept';
  if (m.action === 'match') return 'matched';
  return 'pending';
}

function targetClass(m) {
  if (!m) return 'score-low';
  if (m.action === 'drop') return 'dropped';
  if (m.action === 'keep') return 'kept';
  if (!m.newKey) return 'score-low';
  if (m.score >= 90) return 'score-high';
  if (m.score >= 60) return 'score-med';
  if (m.action === 'match') return 'score-high';
  return 'score-low';
}

function renderRow(cur) {
  const m = mappings[cur.id];
  const target = m && m.newKey ? newItemByKey(m.newKey) : null;
  const targetText =
    m && m.action === 'drop' ? '🗑 will be dropped' :
    m && m.action === 'keep' ? '💭 keep separate (not in new master)' :
    target ? \`\${target.en} <span style="color:#9c9c9c;font-size:11px">· \${escapeHtml(target.category)}</span>\` :
    'no match found';
  const confNote = m && m.action === 'pending' && m.score && m.score < 60
    ? '<span class="conf-note"> ⚠ low confidence</span>' : '';
  const haystack = [cur.name, cur.nameEs, cur.category, cur.subcat, cur.vendor, cur.preferredVendor, cur.id].join(' ').toLowerCase();
  return \`<div class="row \${rowStateClass(m)}" data-id="\${escapeHtml(cur.id)}" data-state="\${rowStateClass(m)}" data-newkey="\${m && m.newKey ? escapeHtml(m.newKey) : ''}" data-hay="\${escapeHtml(haystack)}">
    <div class="left">
      <div><span class="id">\${escapeHtml(cur.id)}</span> <span class="name">\${escapeHtml(cur.name)}</span></div>
      <div class="meta">
        \${cur.subcat ? '<span>'+escapeHtml(cur.subcat)+'</span>' : ''}
        \${cur.preferredVendor ? '<span>pref: '+escapeHtml(cur.preferredVendor)+'</span>' : ''}
        \${cur.pack ? '<span>pack: '+escapeHtml(cur.pack)+'</span>' : ''}
        \${cur.price != null ? '<span>$'+escapeHtml(cur.price)+'</span>' : ''}
        \${cur.nameEs ? '<span style="color:#9c9c9c">es: '+escapeHtml(cur.nameEs)+'</span>' : ''}
      </div>
    </div>
    <div class="right">
      <div class="maps-to">
        <span class="arrow">→</span>
        <span class="target \${targetClass(m)}">\${targetText}</span>
        \${confNote}
        \${m && m.action === 'pending' && m.score ? '<span style="font-size:10px;color:#9c9c9c">'+m.score+'%</span>' : ''}
      </div>
      <div class="actions">
        \${m && m.action === 'match'
          ? '<button class="primary" disabled>✓ matched</button>'
          : (m && m.newKey
              ? '<button class="primary" onclick="confirmMatch(\\''+cur.id+'\\')">✓ Confirm match</button>'
              : '')}
        <button onclick="openPicker('\${cur.id}')">🔄 Different…</button>
        <button onclick="setAction('\${cur.id}', 'keep')">💭 Keep separate</button>
        <button class="danger" onclick="setAction('\${cur.id}', 'drop')">🗑 Drop</button>
        \${m && (m.action === 'drop' || m.action === 'keep' || m.action === 'match')
          ? '<button onclick="reset(\\''+cur.id+'\\')">↺ Undo</button>' : ''}
      </div>
    </div>
  </div>\`;
}

function render() {
  // Group current items by current category preserving the order they appear in
  const byCat = new Map();
  for (const cur of data.current) {
    if (!byCat.has(cur.category)) byCat.set(cur.category, []);
    byCat.get(cur.category).push(cur);
  }
  const out = [];
  for (const [cat, items] of byCat) {
    out.push(\`<div class="cat-group" data-cat="\${escapeHtml(cat)}"><h2>\${escapeHtml(cat)} <span style="color:#9c9c9c;font-weight:500;font-size:11px">(\${items.length})</span></h2>\`);
    for (const cur of items) out.push(renderRow(cur));
    out.push('</div>');
  }
  document.getElementById('root').innerHTML = out.join('');
  renderAsideTree();
  updateStats();
  applyFilters();
}

function updateStats() {
  let matched=0, drop=0, keep=0, pending=0;
  for (const cur of data.current) {
    const m = mappings[cur.id];
    if (!m) { pending++; continue; }
    if (m.action === 'match') matched++;
    else if (m.action === 'drop') drop++;
    else if (m.action === 'keep') keep++;
    else pending++;
  }
  document.getElementById('stat-matched').textContent = matched;
  document.getElementById('stat-drop').textContent = drop;
  document.getElementById('stat-keep').textContent = keep;
  document.getElementById('stat-pending').textContent = pending;
}

function applyFilters() {
  const q = document.getElementById('q').value.trim().toLowerCase();
  const tokens = q.split(/\\s+/).filter(Boolean);
  document.querySelectorAll('.row').forEach(row => {
    const hay = row.dataset.hay || '';
    const matchesQuery = tokens.length === 0 || tokens.every(t => hay.includes(t));
    const matchesPill = pillFilter === 'all' || row.dataset.state === pillFilter;
    row.classList.toggle('hidden', !(matchesQuery && matchesPill));
  });
  document.querySelectorAll('.cat-group').forEach(g => {
    const any = g.querySelector('.row:not(.hidden)');
    g.style.display = any ? '' : 'none';
  });
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show';
  clearTimeout(toast._h);
  toast._h = setTimeout(() => { t.className = 'toast'; }, 1500);
}

function confirmMatch(id) {
  const m = mappings[id];
  if (!m || !m.newKey) return;
  mappings[id] = { action: 'match', newKey: m.newKey, score: m.score };
  saveMappings();
  render();
}
function setAction(id, action) {
  if (action === 'drop' || action === 'keep') {
    mappings[id] = { action, newKey: null };
  }
  saveMappings();
  render();
}
function reset(id) {
  // Reset to auto-suggestion as pending
  const sug = data.suggestions[id];
  mappings[id] = sug
    ? { action: 'pending', newKey: sug.key, score: sug.score }
    : { action: 'pending', newKey: null, score: 0 };
  saveMappings();
  render();
}

// Picker — search the new master to pick a different match
let pickerForId = null;
function openPicker(id) {
  pickerForId = id;
  const cur = data.current.find(c => c.id === id);
  const div = document.createElement('div');
  div.className = 'picker';
  div.id = 'picker';
  div.innerHTML = \`
    <div class="panel">
      <h3>Map "\${escapeHtml(cur.name)}" to…</h3>
      <input id="picker-q" type="search" placeholder="🔍 Search new master items…" autofocus />
      <div class="results" id="picker-results"></div>
      <button class="close" onclick="closePicker()">Cancel</button>
    </div>\`;
  document.body.appendChild(div);
  renderPickerResults('');
  setTimeout(() => document.getElementById('picker-q').focus(), 30);
  document.getElementById('picker-q').addEventListener('input', e => renderPickerResults(e.target.value));
}
function closePicker() {
  const el = document.getElementById('picker');
  if (el) el.remove();
  pickerForId = null;
}
function renderPickerResults(q) {
  const tokens = q.trim().toLowerCase().split(/\\s+/).filter(Boolean);
  const results = data.newMaster.filter(ni => {
    if (tokens.length === 0) return true;
    const hay = (ni.en + ' ' + ni.es + ' ' + ni.category).toLowerCase();
    return tokens.every(t => hay.includes(t));
  });
  const html = results.slice(0, 50).map(ni =>
    \`<div class="result" onclick="pickNewKey('\${escapeHtml(ni.key)}')">
      <span><b>\${escapeHtml(ni.en)}</b>\${ni.es ? ' <span style="color:#9c9c9c">· '+escapeHtml(ni.es)+'</span>' : ''}</span>
      <span class="cat">\${escapeHtml(ni.category)}</span>
    </div>\`
  ).join('');
  document.getElementById('picker-results').innerHTML = html || '<div style="padding:14px;text-align:center;color:#9c9c9c">no results</div>';
}
function pickNewKey(key) {
  if (!pickerForId) return;
  mappings[pickerForId] = { action: 'match', newKey: key, score: 100 };
  saveMappings();
  closePicker();
  render();
}

function filterByNewKey(key) {
  document.getElementById('q').value = '';
  pillFilter = 'all';
  document.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p.dataset.pf === 'all'));
  document.querySelectorAll('.row').forEach(row => {
    row.classList.toggle('hidden', row.dataset.newkey !== key);
  });
  document.querySelectorAll('.cat-group').forEach(g => {
    const any = g.querySelector('.row:not(.hidden)');
    g.style.display = any ? '' : 'none';
  });
  toast('Filtered to items mapped to this new item');
}

function setPillFilter(btn) {
  pillFilter = btn.dataset.pf;
  document.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p === btn));
  applyFilters();
}

function exportMappings() {
  const out = {
    exportedAt: new Date().toISOString(),
    summary: {
      currentItems: data.current.length,
      newMasterItems: data.newMaster.length,
      matched: 0, drop: 0, keep: 0, pending: 0,
    },
    mappings: {},
  };
  for (const cur of data.current) {
    const m = mappings[cur.id] || { action: 'pending', newKey: null };
    out.mappings[cur.id] = {
      action: m.action,
      newKey: m.newKey || null,
      currentName: cur.name,
      currentCategory: cur.category,
      newName: m.newKey ? (newItemByKey(m.newKey) || {}).en || null : null,
      newCategory: m.newKey ? (newItemByKey(m.newKey) || {}).category || null : null,
    };
    out.summary[m.action] = (out.summary[m.action] || 0) + 1;
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'inventory-mappings-' + new Date().toISOString().replace(/[:.]/g,'-').slice(0,19) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Downloaded mappings.json');
}

document.getElementById('q').addEventListener('input', applyFilters);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePicker(); });

render();
saveMappings();
</script>
</body>
</html>`;
}

// ── server ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
            const pageData = await buildPageData();
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderPage(pageData));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    } catch (e) {
        console.error(e);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(e?.stack || e?.message || e));
    }
});

server.listen(PORT, () => {
    console.log('');
    console.log('  🔗  DD Mau — Master List Mapper');
    console.log('  ───────────────────────────────');
    console.log(`  Open this in your browser: \x1b[36m\x1b[1mhttp://localhost:${PORT}\x1b[0m`);
    console.log('');
    console.log('  Each row defaults to its best auto-match suggestion.');
    console.log('  Use the action buttons to confirm, change, drop, or keep separate.');
    console.log('  Decisions persist in localStorage; export when done.');
    console.log('  Ctrl-C to stop the server.');
    console.log('');
});
