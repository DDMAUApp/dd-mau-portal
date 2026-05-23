#!/usr/bin/env node
// scripts/category-mapper-server.mjs
//
// Third local tool in the master-list rebuild flow (after the dupe
// cleaner + mapping export → apply). Lets Andrew:
//   • Assign every item a storage location (walk-in / dry / freezer /
//     bar / etc.) — a NEW field added to inventory.js as `location`.
//   • Reassign items between categories.
//   • Edit subcategories (rename them by editing in place; move items
//     between subcats via a dropdown).
//   • Rename / add / delete top-level categories.
//
// Andrew: "once you make that new list bring it up to another local
// site like the previous mapping but now im going to map the
// categories, locations"
//
// The page persists the in-progress edits in localStorage so refreshes
// don't lose work. Hit "💾 Save to inventory.js" when you're happy —
// the server takes a backup of src/data/inventory.js to .bak (only on
// the first save of the session) and rewrites it. The new `location`
// field is added to every item; old fields are preserved.
//
// Usage:
//   node scripts/category-mapper-server.mjs
//   # open http://localhost:5176 in a browser (5176 = different port
//   # from dupe-cleaner 5174 and mapper 5175 so they coexist)

import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 5176);
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const inventoryPath = path.join(repoRoot, 'src', 'data', 'inventory.js');
const backupPath = inventoryPath + '.bak';

const DEFAULT_LOCATIONS = [
    'Walk-in Cooler', 'Walk-in Freezer', 'Dry Storage',
    'Bar', 'Prep Station', 'Front Counter', 'Hot Line',
];

// ── load ────────────────────────────────────────────────────────
async function loadCategories() {
    const href = pathToFileURL(inventoryPath).href + '?t=' + Date.now();
    const mod = await import(href);
    return mod.INVENTORY_CATEGORIES;
}

// ── write inventory.js from the edited tree ─────────────────────
// Same JS-literal formatter as apply-mappings.mjs so the file stays
// readable. Preserves all existing fields per item and adds `location`.
function jsLit(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(jsLit).join(', ') + ']';
    if (typeof v === 'object') {
        const parts = Object.entries(v).map(([k, val]) => `${k}: ${jsLit(val)}`);
        return '{ ' + parts.join(', ') + ' }';
    }
    return JSON.stringify(v);
}

function regenerateInventory(categories) {
    const out = [];
    out.push('// src/data/inventory.js');
    out.push('//');
    out.push('// Master inventory catalog. Last touched by');
    out.push(`// scripts/category-mapper-server.mjs on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}.`);
    out.push('//');
    out.push('// Each item has id "{catIdx}-{itemIdx}". Counts in Firestore at');
    out.push('// /ops/inventory_{location}.counts are keyed by these ids.');
    out.push('// The `location` field is the kitchen storage location (walk-in,');
    out.push('// dry storage, freezer, bar, etc.) and is used to group items');
    out.push('// for inventory counting rounds.');
    out.push('');
    out.push('export const INVENTORY_CATEGORIES = [');

    let catIdx = 0;
    for (const cat of categories) {
        const items = cat.items || [];
        if (items.length === 0 && !cat.keepEmpty) continue;
        out.push('    {');
        out.push(`        id: ${catIdx},`);
        out.push(`        name: ${JSON.stringify(cat.name)},`);
        out.push(`        nameEs: ${JSON.stringify(cat.nameEs || cat.name)},`);
        out.push('        items: [');
        let itemIdx = 0;
        for (const src of items) {
            const newId = `${catIdx}-${itemIdx}`;
            const item = {
                id: newId,
                name: src.name || '',
                nameEs: src.nameEs || '',
                vendor: src.vendor || '',
                pack: src.pack || '',
                price: src.price ?? null,
                subcat: src.subcat || '',
                location: src.location || '',
                preferredVendor: src.preferredVendor || src.vendor || '',
                vendorOptions: src.vendorOptions || [],
            };
            out.push(`            ${jsLit(item)},`);
            itemIdx++;
        }
        out.push('        ]');
        out.push('    },');
        catIdx++;
    }
    out.push('];');
    out.push('');
    return out.join('\n');
}

let backupTaken = false;
async function applyEdits(categories) {
    if (!backupTaken) {
        try { await access(backupPath); } catch { await copyFile(inventoryPath, backupPath); }
        backupTaken = true;
    }
    const src = regenerateInventory(categories);
    await writeFile(inventoryPath, src, 'utf8');
    return { ok: true };
}

// ── HTML / JS / CSS — single file, no deps ──────────────────────
function renderPage(categories) {
    const dataJson = JSON.stringify({ categories, defaultLocations: DEFAULT_LOCATIONS })
        .replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DD Mau — Category + Location Mapper</title>
<style>
  :root {
    --bg: #f7f5ef; --fg: #1d1d1f; --fg2: #6b6b6f; --line: #e2e0d9;
    --green: #15803d; --green-bg: #dcfce7;
    --amber: #b45309; --amber-bg: #fef3c7;
    --red: #b91c1c; --red-bg: #fee2e2;
    --blue: #1e40af; --blue-bg: #dbeafe;
    --purple: #6b21a8; --purple-bg: #f3e8ff;
    --accent: #2a5d31;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--fg); }
  header { background: white; border-bottom: 1px solid var(--line); padding: 12px 18px; position: sticky; top: 0; z-index: 30; }
  header h1 { margin: 0 0 4px; font-size: 17px; }
  header .stats { color: var(--fg2); font-size: 12px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  header .stats b { color: var(--fg); }
  header button.save { background: var(--accent); color: white; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 700; font-size: 12px; cursor: pointer; margin-left: auto; }
  header button.save:hover { background: #1f4724; }
  header button.save:disabled { opacity: 0.5; }
  .container { max-width: 1300px; margin: 0 auto; padding: 14px 18px 60px; }
  .toolbar { background: white; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; }
  .toolbar h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg2); }
  .pills { display: flex; flex-wrap: wrap; gap: 6px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: white; cursor: pointer; user-select: none; }
  .pill:hover { background: var(--bg); }
  .pill.active { background: var(--fg); color: white; border-color: var(--fg); }
  .pill.loc { background: var(--purple-bg); color: var(--purple); border-color: var(--purple); }
  .pill.loc.active { background: var(--purple); color: white; }
  .pill .x { color: var(--fg2); cursor: pointer; padding: 0 2px; }
  .pill .x:hover { color: var(--red); }
  .pill.add { border-style: dashed; color: var(--fg2); }
  .pill input { background: transparent; border: none; outline: none; font: inherit; color: inherit; width: 80px; }
  .cat-card { background: white; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
  .cat-card.hidden { display: none; }
  .cat-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
  .cat-head input.name { font-size: 16px; font-weight: 800; color: var(--accent); border: none; outline: none; background: transparent; min-width: 200px; padding: 3px 6px; border-radius: 4px; }
  .cat-head input.name:focus { background: var(--bg); }
  .cat-head .count { background: var(--bg); color: var(--fg2); padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .cat-head button.del-cat { font-size: 11px; padding: 3px 8px; border: 1px solid #fecaca; background: white; color: var(--red); border-radius: 4px; cursor: pointer; }
  .cat-head button.del-cat:hover { background: var(--red-bg); }
  .cat-head button.del-cat:disabled { opacity: 0.3; cursor: not-allowed; }
  .subgroup { margin-top: 8px; }
  .subgroup-head { display: flex; align-items: center; gap: 8px; padding: 4px 0 6px; border-bottom: 1px dashed var(--line); }
  .subgroup-head input { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg2); border: none; outline: none; background: transparent; padding: 2px 4px; border-radius: 3px; min-width: 120px; }
  .subgroup-head input:focus { background: var(--bg); }
  .subgroup-head .count { color: var(--fg2); font-size: 11px; }
  .row { display: grid; grid-template-columns: 1fr 160px 160px 160px; gap: 8px; padding: 6px 0; border-bottom: 1px dashed var(--line); align-items: center; }
  .row:last-child { border-bottom: none; }
  .row.hidden { display: none; }
  .row .name { font-weight: 700; font-size: 13px; }
  .row .meta { font-size: 11px; color: var(--fg2); margin-top: 1px; }
  .row select { font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; background: white; }
  .row select.loc { background: var(--purple-bg); color: var(--purple); font-weight: 700; }
  .row select.loc[data-empty="1"] { background: var(--amber-bg); color: var(--amber); }
  .row select.subcat { background: var(--blue-bg); color: var(--blue); font-weight: 700; }
  .row select.cat { background: var(--green-bg); color: var(--green); font-weight: 700; }
  .filter-bar { background: white; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .filter-bar input { flex: 1; min-width: 200px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; font-size: 13px; outline: none; }
  .filter-bar input:focus { border-color: var(--accent); }
  .add-cat-btn { font-size: 12px; padding: 6px 14px; background: white; border: 1px dashed var(--line); color: var(--fg2); border-radius: 6px; cursor: pointer; font-weight: 700; }
  .add-cat-btn:hover { background: var(--bg); color: var(--fg); }
  .toast { position: fixed; bottom: 16px; right: 16px; background: var(--fg); color: white; padding: 8px 14px; border-radius: 6px; font-size: 12px; opacity: 0; transition: opacity .15s; pointer-events: none; z-index: 40; }
  .toast.show { opacity: 1; }
  .toast.err { background: var(--red); }
  .toast.ok { background: var(--green); }
  .dirty-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--amber); margin-right: 6px; vertical-align: middle; }
</style>
</head>
<body>
<header>
  <h1>🗂 DD Mau — Category + Location Mapper</h1>
  <div class="stats">
    <span><b id="stat-cats">0</b> cats</span>
    <span><b id="stat-subs">0</b> subcats</span>
    <span><b id="stat-items">0</b> items</span>
    <span><b id="stat-locs">0</b> locations</span>
    <span id="stat-unset"></span>
    <span id="dirty-mark"></span>
    <button class="save" id="save-btn" onclick="saveAll()" disabled>💾 Save to inventory.js</button>
  </div>
</header>
<div class="container">
  <div class="toolbar">
    <h3>📍 Storage locations <span style="color:var(--fg2);font-weight:400;text-transform:none;letter-spacing:0">— click an item's location pill to assign · click a location pill below to filter</span></h3>
    <div id="loc-pills" class="pills"></div>
  </div>
  <div class="filter-bar">
    <input id="q" type="search" placeholder="🔍 Filter items by name, vendor, category, subcat..." />
    <button class="add-cat-btn" onclick="addCategory()">➕ New category</button>
  </div>
  <div id="root"></div>
</div>
<div id="toast" class="toast"></div>
<script>
const initData = ${dataJson};
const STORAGE_KEY = 'ddmau-catmap-v1';

// State shape: { categories: [{ name, nameEs, items: [{ name, ..., subcat, location }] }], locations: [...] }
function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

let state = loadState();
let activeLocFilter = null; // null = all
let dirty = false;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.categories) return saved;
  } catch(e){}
  return {
    categories: deepClone(initData.categories),
    locations: deepClone(initData.defaultLocations),
  };
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  setDirty(true);
}
function setDirty(v) {
  dirty = v;
  document.getElementById('save-btn').disabled = !v;
  document.getElementById('dirty-mark').innerHTML = v ? '<span class="dirty-dot"></span><span style="color:var(--amber);font-weight:700">unsaved</span>' : '';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}
function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (kind || '');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => { t.className = 'toast'; }, 2000);
}

function gatherLocations() {
  const set = new Set(state.locations);
  for (const c of state.categories) for (const it of c.items) if (it.location) set.add(it.location);
  return [...set].sort();
}

function gatherSubcats(catName) {
  const cat = state.categories.find(c => c.name === catName);
  if (!cat) return [];
  const set = new Set();
  for (const it of cat.items) if (it.subcat) set.add(it.subcat);
  return [...set].sort();
}

function updateStats() {
  const cats = state.categories.length;
  const items = state.categories.reduce((s, c) => s + c.items.length, 0);
  const subs = new Set();
  for (const c of state.categories) for (const it of c.items) if (it.subcat) subs.add(c.name + '|' + it.subcat);
  const locs = gatherLocations().length;
  let unset = 0;
  for (const c of state.categories) for (const it of c.items) if (!it.location) unset++;
  document.getElementById('stat-cats').textContent = cats;
  document.getElementById('stat-subs').textContent = subs.size;
  document.getElementById('stat-items').textContent = items;
  document.getElementById('stat-locs').textContent = locs;
  document.getElementById('stat-unset').innerHTML = unset > 0
    ? '<span style="color:var(--amber);font-weight:700">⚠ ' + unset + ' without location</span>'
    : '<span style="color:var(--green);font-weight:700">✓ all located</span>';
}

function renderLocPills() {
  const all = gatherLocations();
  const counts = {};
  for (const c of state.categories) for (const it of c.items) {
    counts[it.location || ''] = (counts[it.location || ''] || 0) + 1;
  }
  const pills = [];
  // "All" pill
  pills.push(\`<span class="pill\${activeLocFilter===null?' active':''}" onclick="setLocFilter(null)">All <span style="opacity:0.6;font-weight:400">(\${state.categories.reduce((s,c)=>s+c.items.length,0)})</span></span>\`);
  // "Unset" pill
  if (counts['']) pills.push(\`<span class="pill\${activeLocFilter===''?' active':''}" style="background:var(--amber-bg);color:var(--amber);border-color:var(--amber)" onclick="setLocFilter('')">⚠ Unset (\${counts['']})</span>\`);
  for (const loc of all) {
    const n = counts[loc] || 0;
    pills.push(\`<span class="pill loc\${activeLocFilter===loc?' active':''}" onclick="setLocFilter('\${escapeHtml(loc)}')">\${escapeHtml(loc)} <span style="opacity:0.6;font-weight:400">(\${n})</span><span class="x" onclick="event.stopPropagation();removeLocation('\${escapeHtml(loc)}')" title="Remove location">✕</span></span>\`);
  }
  // Add new
  pills.push('<span class="pill add" onclick="addLocation()">➕ new location</span>');
  document.getElementById('loc-pills').innerHTML = pills.join('');
}

function renderRow(catIdx, itemIdx) {
  const cat = state.categories[catIdx];
  const it = cat.items[itemIdx];
  const subcats = gatherSubcats(cat.name);
  const locs = gatherLocations();
  // Build option lists
  const subOpts = ['<option value="">(no subcat)</option>'].concat(
    subcats.map(s => \`<option value="\${escapeHtml(s)}"\${s === it.subcat ? ' selected' : ''}>\${escapeHtml(s)}</option>\`)
  ).join('') + '<option value="__new__">+ new subcat…</option>';
  const locOpts = ['<option value="">(unset)</option>'].concat(
    locs.map(l => \`<option value="\${escapeHtml(l)}"\${l === it.location ? ' selected' : ''}>\${escapeHtml(l)}</option>\`)
  ).join('') + '<option value="__new__">+ new location…</option>';
  const catOpts = state.categories.map((c, i) =>
    \`<option value="\${i}"\${i === catIdx ? ' selected' : ''}>\${escapeHtml(c.name)}</option>\`
  ).join('');
  const meta = [
    it.preferredVendor && 'pref: ' + escapeHtml(it.preferredVendor),
    it.pack && 'pack: ' + escapeHtml(it.pack),
    it.price != null && '$' + escapeHtml(it.price),
    it.nameEs && '<span style="color:#9c9c9c">es: ' + escapeHtml(it.nameEs) + '</span>',
  ].filter(Boolean).join('  ·  ');
  const hay = (it.name + ' ' + (it.nameEs||'') + ' ' + cat.name + ' ' + (it.subcat||'') + ' ' + (it.location||'') + ' ' + (it.preferredVendor||'')).toLowerCase();
  return \`<div class="row" data-cat="\${catIdx}" data-item="\${itemIdx}" data-loc="\${escapeHtml(it.location||'')}" data-hay="\${escapeHtml(hay)}">
    <div>
      <div class="name">\${escapeHtml(it.name)}</div>
      <div class="meta">\${meta}</div>
    </div>
    <select class="cat" onchange="changeCategory(\${catIdx},\${itemIdx},this.value)">
      \${catOpts}
    </select>
    <select class="subcat" onchange="changeSubcat(\${catIdx},\${itemIdx},this.value,this)">
      \${subOpts}
    </select>
    <select class="loc" data-empty="\${it.location ? '0' : '1'}" onchange="changeLocation(\${catIdx},\${itemIdx},this.value,this)">
      \${locOpts}
    </select>
  </div>\`;
}

function renderCategory(catIdx) {
  const cat = state.categories[catIdx];
  if (!cat) return '';
  // Group items by subcat
  const bySub = new Map();
  cat.items.forEach((it, i) => {
    const key = it.subcat || '';
    if (!bySub.has(key)) bySub.set(key, []);
    bySub.get(key).push({ it, i });
  });
  const subKeys = [...bySub.keys()].sort((a, b) => (a || 'zzz').localeCompare(b || 'zzz'));
  const groupsHtml = subKeys.map(subKey => {
    const items = bySub.get(subKey);
    const subHead = subKey
      ? \`<input type="text" value="\${escapeHtml(subKey)}" onchange="renameSubcat(\${catIdx}, '\${escapeHtml(subKey)}', this.value)" />\`
      : '<input type="text" value="(no subcat)" disabled style="font-style:italic;color:#9c9c9c" />';
    return \`<div class="subgroup">
      <div class="subgroup-head">
        \${subHead}
        <span class="count">\${items.length} item\${items.length === 1 ? '' : 's'}</span>
      </div>
      \${items.map(({ i }) => renderRow(catIdx, i)).join('')}
    </div>\`;
  }).join('');
  return \`<div class="cat-card" data-catidx="\${catIdx}">
    <div class="cat-head">
      <input class="name" type="text" value="\${escapeHtml(cat.name)}" onchange="renameCategory(\${catIdx}, this.value)" />
      <span class="count">\${cat.items.length} item\${cat.items.length === 1 ? '' : 's'}</span>
      <button class="del-cat" onclick="deleteCategory(\${catIdx})" \${cat.items.length > 0 ? 'disabled title="Empty the category first"' : ''}>🗑 Delete category</button>
    </div>
    \${groupsHtml || '<div style="color:var(--fg2);font-style:italic;padding:8px 0">empty</div>'}
  </div>\`;
}

function render() {
  const root = document.getElementById('root');
  root.innerHTML = state.categories.map((_, i) => renderCategory(i)).join('');
  renderLocPills();
  updateStats();
  applyFilters();
}

function applyFilters() {
  const q = document.getElementById('q').value.trim().toLowerCase();
  const tokens = q.split(/\\s+/).filter(Boolean);
  document.querySelectorAll('.row').forEach(row => {
    const hay = row.dataset.hay || '';
    const matchesQ = tokens.length === 0 || tokens.every(t => hay.includes(t));
    const matchesLoc = activeLocFilter === null || row.dataset.loc === activeLocFilter;
    row.classList.toggle('hidden', !(matchesQ && matchesLoc));
  });
  document.querySelectorAll('.cat-card').forEach(card => {
    const any = card.querySelector('.row:not(.hidden)');
    card.classList.toggle('hidden', !any);
  });
}

// ── Mutations ───────────────────────────────────────────────────
function renameCategory(catIdx, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) { toast('Category name cannot be empty', 'err'); render(); return; }
  if (state.categories.find((c, i) => i !== catIdx && c.name === trimmed)) {
    toast('A category with that name already exists', 'err'); render(); return;
  }
  state.categories[catIdx].name = trimmed;
  saveState();
  render();
}
function renameSubcat(catIdx, oldName, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) { toast('Subcat name cannot be empty', 'err'); render(); return; }
  if (oldName === trimmed) return;
  for (const it of state.categories[catIdx].items) {
    if ((it.subcat || '') === oldName) it.subcat = trimmed;
  }
  saveState();
  render();
}
function addCategory() {
  const name = prompt('New category name:');
  if (!name || !name.trim()) return;
  if (state.categories.find(c => c.name === name.trim())) { toast('Category already exists', 'err'); return; }
  state.categories.push({ name: name.trim(), nameEs: name.trim(), items: [] });
  saveState();
  render();
}
function deleteCategory(catIdx) {
  if (state.categories[catIdx].items.length > 0) {
    toast('Empty the category first (move items elsewhere)', 'err'); return;
  }
  if (!confirm('Delete empty category "' + state.categories[catIdx].name + '"?')) return;
  state.categories.splice(catIdx, 1);
  saveState();
  render();
}
function changeCategory(catIdx, itemIdx, newCatIdxStr) {
  const newCatIdx = parseInt(newCatIdxStr, 10);
  if (!Number.isFinite(newCatIdx) || newCatIdx === catIdx) return;
  const item = state.categories[catIdx].items.splice(itemIdx, 1)[0];
  state.categories[newCatIdx].items.push(item);
  saveState();
  render();
}
function changeSubcat(catIdx, itemIdx, val, sel) {
  if (val === '__new__') {
    const v = prompt('New subcategory name:');
    if (!v || !v.trim()) { render(); return; }
    state.categories[catIdx].items[itemIdx].subcat = v.trim();
  } else {
    state.categories[catIdx].items[itemIdx].subcat = val;
  }
  saveState();
  render();
}
function changeLocation(catIdx, itemIdx, val, sel) {
  if (val === '__new__') {
    const v = prompt('New storage location name:');
    if (!v || !v.trim()) { render(); return; }
    state.categories[catIdx].items[itemIdx].location = v.trim();
    if (!state.locations.includes(v.trim())) state.locations.push(v.trim());
  } else {
    state.categories[catIdx].items[itemIdx].location = val;
  }
  saveState();
  render();
}
function addLocation() {
  const v = prompt('New storage location name:');
  if (!v || !v.trim()) return;
  if (!state.locations.includes(v.trim())) state.locations.push(v.trim());
  saveState();
  render();
}
function removeLocation(loc) {
  const inUse = state.categories.some(c => c.items.some(it => it.location === loc));
  if (inUse && !confirm('"' + loc + '" is in use. Remove anyway? (items will become unset)')) return;
  state.locations = state.locations.filter(l => l !== loc);
  // Clear from items
  for (const c of state.categories) for (const it of c.items) if (it.location === loc) it.location = '';
  saveState();
  if (activeLocFilter === loc) activeLocFilter = null;
  render();
}
function setLocFilter(loc) {
  activeLocFilter = loc;
  renderLocPills();
  applyFilters();
}

// ── Save back to inventory.js ───────────────────────────────────
async function saveAll() {
  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = '💾 Saving…';
  try {
    const res = await fetch('/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: state.categories }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || 'save failed');
    toast('✓ Saved to inventory.js', 'ok');
    setDirty(false);
    // Clear local cache so reloading shows the actual file content (in case of conflicts later)
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
    setDirty(true);
  } finally {
    btn.textContent = '💾 Save to inventory.js';
  }
}

document.getElementById('q').addEventListener('input', applyFilters);
render();
setDirty(false);
// If localStorage already had edits from a prior session, mark dirty.
if (JSON.stringify(state.categories) !== JSON.stringify(initData.categories)) setDirty(true);
</script>
</body>
</html>`;
}

// ── server ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
            const cats = await loadCategories();
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderPage(cats));
            return;
        }
        if (req.method === 'POST' && req.url === '/save') {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', async () => {
                try {
                    const { categories } = JSON.parse(body);
                    await applyEdits(categories);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
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
        console.error(e);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(e?.message || e));
    }
});

server.listen(PORT, () => {
    console.log('');
    console.log('  🗂  DD Mau — Category + Location Mapper');
    console.log('  ────────────────────────────────────────');
    console.log(`  Open this in your browser: \x1b[36m\x1b[1mhttp://localhost:${PORT}\x1b[0m`);
    console.log('');
    console.log('  Per item, set three things via dropdowns:');
    console.log('    • Category (move between top-level groups)');
    console.log('    • Subcategory (edit in place by clicking the subcat header)');
    console.log('    • Storage location (NEW field — walk-in / dry / freezer / bar / etc.)');
    console.log('');
    console.log('  Edits autosave to localStorage. Click 💾 Save to write inventory.js.');
    console.log('  Ctrl-C to stop the server.');
    console.log('');
});
