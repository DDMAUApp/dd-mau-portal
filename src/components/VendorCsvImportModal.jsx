// VendorCsvImportModal — drop in a Sysco / US Foods order-guide CSV
// and turn it into an inventoryHistory snapshot so the "Last ordered"
// badge under every matched item updates in one shot.
//
// Workflow (3 stages):
//   1. Config: pick vendor, pick order date, drop a CSV file in.
//   2. Preview: parser shows mapped columns + the matched / ambiguous /
//      unmatched rows. Admin can override the column auto-detect and
//      pick a master inventory item for each unmatched row.
//   3. Import: writes /inventoryHistory_{loc}/{key} with the matched
//      items + qty. Also persists any newly-resolved vendor-SKU →
//      master-id mappings to /config/vendor_matches so the next
//      import is faster.
//
// Why this exists: vendor scrapers are fragile (MFA, session expiry,
// captcha, UI changes). The user manually exports order-guide CSVs
// from the vendor portal (one click) and uploads here. Same data,
// zero infrastructure to maintain. See docs/VENDOR_PRICING_INTEGRATION_PLAN.md
// §4 — this is the MVP layer.
//
// CSV parser is hand-rolled to avoid adding a dep. Restaurants don't
// produce exotic CSVs; comma + double-quote escaping covers Sysco +
// US Foods exports we've seen.

import { useState, useMemo, useRef, useEffect } from 'react';
import { db } from '../firebase';
import { doc, setDoc, updateDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { recordAudit } from '../data/audit';

// Common column-header aliases for the three fields the parser
// needs. Lowercase + non-alphanumeric stripped before lookup.
// Coverage validated against:
//   • US Foods order-guide export (Product Number / Product
//     Description / Product Price / Product UOM / Product Package Size)
//   • Sysco "Shop Purchase History" export with H/F/P record-type
//     prefix (SUPC / Desc / Case Qty / Split Qty / Pack / Size)
//   • Generic CSVs from Excel/Sheets with common header names.
const COLUMN_ALIASES = {
    sku: [
        'itemnumber', 'itemno', 'itemid', 'item', 'productnumber', 'productid', 'productcode',
        'sku', 'materialnumber', 'material', 'mfgno', 'mfgnumber',
        'supc',                                         // Sysco
        'customerproductnumber',                        // US Foods alt
    ],
    name: [
        'description', 'itemdescription', 'productdescription', 'product', 'productname', 'name',
        'item', 'commodity',
        'desc',                                         // Sysco short header
    ],
    qty: [
        'qty', 'quantity', 'qtyordered', 'orderqty', 'casesordered', 'caseqty', 'cases',
        'qtyshipped', 'shippedqty',
        'caseqty', 'splitqty',                          // Sysco purchase history (often empty)
    ],
    price: [
        'price', 'unitprice', 'caseprice', 'yourprice', 'listprice',
        'productprice', 'case$', 'split$',              // US Foods / Sysco
    ],
    unit: [
        'unit', 'uom', 'pack', 'packsize', 'casepack',
        'productuom', 'productpackagesize',             // US Foods
        'size',                                         // Sysco
    ],
};

const VENDORS = [
    { key: 'sysco',    label: 'Sysco' },
    { key: 'usfoods',  label: 'US Foods' },
    { key: 'costco',   label: 'Costco' },
    { key: 'other',    label: 'Other vendor' },
];

// Costco Business' "Lists" page doesn't export a CSV — only a PDF.
// loadPdfJs is the same pattern OnboardingEmployerFill uses so the
// worker resolves correctly under Vite. Lazy-imported here so the
// Operations chunk doesn't carry pdfjs unless someone imports.
async function loadPdfJs() {
    const pdfjs = await import('pdfjs-dist');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        const workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    }
    return pdfjs;
}

// Costco "Lists" PDF parser. The exported list is a series of item
// blocks; each block has the structure:
//   <product name lines>
//   Item <SKU>
//   $<price>      [per pound]?
//   Add to Cart
//   <saved qty>
//   Remove
//
// We extract text per page (lines = items whose y-coords differ by
// more than 2pt), then walk linearly through every line of every
// page collecting blocks delimited by the "Item <digits>" line.
// One item ends when we see "Remove" (the last line of the block);
// the next line starts a new product.
async function parseCostcoPdf(file) {
    const pdfjs = await loadPdfJs();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const allLines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        let cur = '';
        let lastY = null;
        for (const it of tc.items) {
            if (lastY !== null && Math.abs(it.transform[5] - lastY) > 2) {
                if (cur.trim()) allLines.push(cur.trim());
                cur = '';
            }
            cur += it.str + ' ';
            lastY = it.transform[5];
        }
        if (cur.trim()) allLines.push(cur.trim());
    }

    // Walk lines, accumulating an item when we see "Item <digits>".
    // The product name is whatever appeared on the lines BEFORE the
    // Item line (but after the previous "Remove" or start). Qty is
    // the line BETWEEN "Add to Cart" and "Remove".
    const rows = [];
    let nameBuf = [];
    let pendingItem = null; // { sku, name, price, qty }
    let mode = 'name';      // 'name' -> 'sku-seen' -> 'price-seen' -> 'cart-seen' -> qty -> 'remove'
    const skuRe = /^Item\s+([0-9]{4,12})$/i;
    const priceRe = /^\$([0-9]+(?:\.[0-9]{1,2})?)/;
    for (const line of allLines) {
        const skuMatch = line.match(skuRe);
        if (skuMatch) {
            // Close any half-finished prior block.
            pendingItem = {
                sku: skuMatch[1],
                name: nameBuf.join(' ').replace(/\s+/g, ' ').trim(),
                price: null,
                qty: 0,
            };
            nameBuf = [];
            mode = 'sku-seen';
            continue;
        }
        if (pendingItem && mode === 'sku-seen' && priceRe.test(line)) {
            pendingItem.price = parseFloat(line.match(priceRe)[1]);
            mode = 'price-seen';
            continue;
        }
        if (pendingItem && /^Add to Cart$/i.test(line)) {
            mode = 'cart-seen';
            continue;
        }
        if (pendingItem && mode === 'cart-seen') {
            // The line right after "Add to Cart" is the saved qty.
            const n = parseFloat(line);
            if (!isNaN(n)) pendingItem.qty = n;
            mode = 'qty-seen';
            continue;
        }
        if (pendingItem && /^Remove\b/i.test(line)) {
            // Block ends — emit row, start collecting next name.
            rows.push(pendingItem);
            pendingItem = null;
            nameBuf = [];
            mode = 'name';
            continue;
        }
        if (mode === 'name' || mode === 'qty-seen' /* "per pound" suffix etc */) {
            // Skip the header chrome / navigation lines that appear on
            // every page. Heuristic: drop short lines that look like
            // page chrome.
            if (/^(Current Order|Add \$|Delivery|Maryland Heights|Lists|All|View Savings|Shop|Enter Keyword|Warehouses|Account|Cart|US|page|of)$/i.test(line.trim())) continue;
            if (/^\d+$/.test(line.trim())) continue; // bare page numbers
            if (line.length > 200) continue;
            if (mode === 'name') nameBuf.push(line);
        }
    }
    if (pendingItem) rows.push(pendingItem);
    return rows;
}

export default function VendorCsvImportModal({
    language = 'en',
    storeLocation,
    customInventory,
    vendorMatches,
    staffName,
    viewer,
    onClose,
    onImported,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const [stage, setStage] = useState('config');  // 'config' | 'preview' | 'done'
    const [vendor, setVendor] = useState('sysco');
    const [orderDate, setOrderDate] = useState(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    const [rawText, setRawText] = useState('');
    const [parsed, setParsed] = useState(null);   // { headers, rows, mapping }
    const [overrideMap, setOverrideMap] = useState({});   // rowIdx -> inventory item id (or '__skip__')
    // Per-row qty override. Many vendor CSVs (US Foods order guide,
    // Sysco purchase history) don't carry order quantities — the
    // admin types them in here. Empty string means "use parsed qty
    // from CSV (or 0 if missing)". Numeric string means override.
    const [manualQty, setManualQty] = useState({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const fileRef = useRef(null);

    // ── CSV parser ──────────────────────────────────────────────
    function parseCsv(text) {
        // Strip BOM, normalize CRLF.
        const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
        const rows = [];
        let cur = '';
        let row = [];
        let inQuotes = false;
        for (let i = 0; i < clean.length; i++) {
            const c = clean[i];
            if (inQuotes) {
                if (c === '"') {
                    if (clean[i + 1] === '"') { cur += '"'; i++; }
                    else inQuotes = false;
                } else {
                    cur += c;
                }
            } else {
                if (c === '"') inQuotes = true;
                else if (c === ',') { row.push(cur); cur = ''; }
                else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
                else cur += c;
            }
        }
        if (cur.length || row.length) { row.push(cur); rows.push(row); }
        return rows.filter(r => r.some(cell => String(cell).trim()));
    }

    // ── Column detection ───────────────────────────────────────
    function normalizeHeader(h) {
        return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    // Two-pass detection so EXACT matches always beat fuzzy substring
    // matches. Without this, the sku alias 'item' hijacked the Sysco
    // "Item Status" column (because itemstatus.includes('item') is
    // true), so every row got SKU+name out of the wrong (empty)
    // column and nothing fuzzy-matched downstream.
    function detectColumns(headers) {
        const map = {};
        const norm = headers.map(normalizeHeader);
        for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
            // Pass 1: exact match between any header and any alias.
            let idx = -1;
            for (const alias of aliases) {
                idx = norm.findIndex(h => h === alias);
                if (idx !== -1) break;
            }
            // Pass 2: substring fallback for variants like "Order Qty"
            // (header "orderqty" contains alias "qty"). Only runs when
            // exact-match failed, which protects "Item Status" etc.
            if (idx === -1) {
                for (const alias of aliases) {
                    // Skip very-short aliases on the fallback pass —
                    // they're the ones that caused the earlier hijack.
                    if (alias.length < 4) continue;
                    idx = norm.findIndex(h => h.includes(alias));
                    if (idx !== -1) break;
                }
            }
            if (idx !== -1) map[field] = idx;
        }
        return map;
    }

    // ── Inventory match ────────────────────────────────────────
    // Tier 1: exact SKU match via /config/vendor_matches.{vendor}.{sku}
    // Tier 2: name fuzzy match — token-set similarity against master
    //         inventory item names.
    const flatInventory = useMemo(() => {
        const items = [];
        for (const cat of (customInventory || [])) {
            for (const it of (cat.items || [])) {
                items.push({ id: it.id, name: it.name, nameLower: (it.name || '').toLowerCase(), pack: it.pack || '' });
            }
        }
        return items;
    }, [customInventory]);

    // Token-set similarity. Two scoring lanes so vendor-prefix bloat
    // (e.g. "Kirkland Signature Soybean Oil, 35 lbs" vs master
    // "Soybean Oil") doesn't get penalized by the long-side denominator:
    //
    //   • Standard: overlap / max(querySize, itemSize). Symmetric.
    //   • Subset bonus: if the SMALLER token set is fully contained
    //     in the larger AND has ≥2 tokens, score floors at 0.85.
    //     Catches "<vendor prefix> <core name> <pack>" patterns
    //     that all dump tokens onto one side.
    //
    // The size>=2 guard prevents single-word masters ("Apple") from
    // wildly over-matching ("Pineapple Juice Apple Concentrate").
    // STOPWORDS drops conjunctions that vendors love to put in their
    // marketing-grade descriptions ("And", "With", "For").
    const NAME_STOPWORDS = new Set(['and', 'the', 'for', 'with']);
    function fuzzyMatchByName(query) {
        if (!query) return null;
        const tok = (s) => new Set(
            String(s).toLowerCase().split(/[^a-z0-9]+/)
                .filter(t => t.length > 2 && !NAME_STOPWORDS.has(t))
        );
        const qTokens = tok(query);
        if (qTokens.size === 0) return null;
        let best = null;
        let bestScore = 0;
        for (const it of flatInventory) {
            const itTokens = tok(it.nameLower);
            if (itTokens.size === 0) continue;
            let overlap = 0;
            for (const t of qTokens) if (itTokens.has(t)) overlap++;
            let score = overlap / Math.max(qTokens.size, itTokens.size);
            const smaller = qTokens.size <= itTokens.size ? qTokens : itTokens;
            const larger  = qTokens.size <= itTokens.size ? itTokens : qTokens;
            if (smaller.size >= 2) {
                let isSubset = true;
                for (const t of smaller) { if (!larger.has(t)) { isSubset = false; break; } }
                if (isSubset) score = Math.max(score, 0.85);
            }
            if (score > bestScore && score >= 0.5) {
                bestScore = score;
                best = { id: it.id, name: it.name, score };
            }
        }
        return best;
    }

    function matchRow(skuRaw, nameRaw) {
        const sku = String(skuRaw || '').trim();
        const name = String(nameRaw || '').trim();
        // Tier 1 — exact vendor SKU lookup.
        const skuMap = (vendorMatches && vendorMatches[vendor]) || {};
        if (sku && skuMap[sku]) {
            const masterId = skuMap[sku];
            const it = flatInventory.find(x => x.id === masterId);
            return { matchType: 'sku', itemId: masterId, name: it?.name || '(unknown)', confidence: 1.0 };
        }
        // Tier 2 — name fuzzy match.
        const fuzzy = fuzzyMatchByName(name);
        if (fuzzy) {
            return {
                matchType: fuzzy.score >= 0.75 ? 'fuzzy_high' : 'fuzzy_low',
                itemId: fuzzy.id,
                name: fuzzy.name,
                confidence: fuzzy.score,
            };
        }
        return { matchType: 'none', itemId: null, name: null, confidence: 0 };
    }

    // ── Sysco H/F/P record-type format ─────────────────────────
    // Some Sysco exports (Shop > Purchase History) prefix every row
    // with a record-type marker: H = header, F = field/column names,
    // P = product/data row, T = trailer. We strip that first column
    // and use the F row as headers, P rows as data.
    function detectFpFormat(rows) {
        let hasF = false, hasP = false;
        for (const r of rows.slice(0, 50)) {
            const t = String(r[0] || '').trim().toUpperCase();
            if (t === 'F') hasF = true;
            else if (t === 'P') hasP = true;
            if (hasF && hasP) return true;
        }
        return false;
    }
    function parseFpFormat(rows) {
        let headers = null;
        const body = [];
        for (const r of rows) {
            const t = String(r[0] || '').trim().toUpperCase();
            if (t === 'F') headers = r.slice(1);
            else if (t === 'P') body.push(r.slice(1));
            // ignore H (file header), T (trailer), S (summary), etc.
        }
        return { headers: headers || [], body };
    }

    // ── File picked ────────────────────────────────────────────
    async function handleFile(e) {
        setError(null);
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        const isPdf = /\.pdf$/i.test(f.name);
        const isCsv = /\.csv$/i.test(f.name);
        if (!isCsv && !isPdf) {
            setError(tx('Please upload a .csv or .pdf file.', 'Por favor sube un archivo .csv o .pdf.'));
            return;
        }
        // Costco branch — PDF "Lists" export. We synthesize a
        // pseudo-CSV shape (headers + body) so the same preview UI
        // works without conditionals downstream.
        if (isPdf || vendor === 'costco') {
            if (!isPdf) {
                setError(tx('Costco exports as PDF. Re-upload as .pdf.', 'Costco exporta PDF. Sube .pdf.'));
                return;
            }
            try {
                setBusy(true);
                const items = await parseCostcoPdf(f);
                if (items.length === 0) {
                    setError(tx('No items found in this PDF.', 'No se encontraron artículos en el PDF.'));
                    return;
                }
                const headers = ['Item', 'Description', 'Price', 'Qty'];
                const body = items.map(it => [it.sku, it.name, it.price != null ? `$${it.price.toFixed(2)}` : '', String(it.qty)]);
                const mapping = { sku: 0, name: 1, price: 2, qty: 3 };
                setParsed({
                    headers, body, mapping, fileName: f.name,
                    formatNote: tx(
                        `Detected Costco Lists PDF — ${items.length} items parsed.`,
                        `PDF de Costco — ${items.length} artículos.`
                    ),
                });
                setOverrideMap({});
                // Costco PDF usually carries the saved-list qty per row,
                // but any rows where the parser came back with 0 get
                // defaulted to 1 so the user doesn't have to type.
                const initialQty = {};
                items.forEach((it, idx) => { if (!it.qty || it.qty <= 0) initialQty[idx] = '1'; });
                setManualQty(initialQty);
                setStage('preview');
                // Auto-switch to Costco if user picked a different vendor first.
                if (vendor !== 'costco') setVendor('costco');
            } catch (err) {
                console.error('Costco PDF parse failed:', err);
                setError(tx('Could not read the PDF.', 'No se pudo leer el PDF.'));
            } finally {
                setBusy(false);
            }
            return;
        }
        try {
            const text = await f.text();
            setRawText(text);
            const allRows = parseCsv(text);
            if (allRows.length < 2) {
                setError(tx('CSV looks empty.', 'El CSV está vacío.'));
                return;
            }

            // Branch 1: Sysco H/F/P record-type CSV (detected by an "F"
            // row + at least one "P" row in the first 50 lines).
            let headers, body, formatNote = null;
            if (detectFpFormat(allRows)) {
                const fp = parseFpFormat(allRows);
                headers = fp.headers;
                body = fp.body;
                formatNote = tx(
                    'Detected Sysco purchase-history format (H/F/P records).',
                    'Detectado formato Sysco H/F/P.'
                );
            } else {
                // Branch 2: Standard CSV. Header row = first row where
                // we can detect EITHER name+qty OR name alone (qty
                // missing entirely is OK; admin will fill qty per row).
                let headerIdx = -1;
                for (let i = 0; i < Math.min(allRows.length, 10); i++) {
                    const map = detectColumns(allRows[i]);
                    if (map.name != null && map.qty != null) { headerIdx = i; break; }
                }
                if (headerIdx === -1) {
                    for (let i = 0; i < Math.min(allRows.length, 10); i++) {
                        const map = detectColumns(allRows[i]);
                        if (map.name != null) { headerIdx = i; break; }
                    }
                }
                if (headerIdx === -1) headerIdx = 0;
                headers = allRows[headerIdx];
                body = allRows.slice(headerIdx + 1);
            }

            const mapping = detectColumns(headers);
            // Auto-default qty=1 for every row whose CSV qty is missing
            // or zero. Sysco purchase-history and US Foods order-guide
            // exports don't carry order quantities at all, so the
            // common "I ordered one case of each" case becomes a
            // one-tap import. Admin can still bulk-set or edit per row.
            const initialQty = {};
            const qtyCol = mapping.qty;
            body.forEach((row, idx) => {
                const raw = qtyCol != null ? row[qtyCol] : '';
                const n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
                if (isNaN(n) || n <= 0) initialQty[idx] = '1';
            });
            setParsed({ headers, body, mapping, fileName: f.name, formatNote });
            setOverrideMap({});
            setManualQty(initialQty);
            setStage('preview');
        } catch (err) {
            console.error('CSV parse failed:', err);
            setError(tx('Could not read the file.', 'No se pudo leer el archivo.'));
        }
    }

    // ── Match every body row, memoized so the preview is snappy ─
    const matched = useMemo(() => {
        if (!parsed) return [];
        const { body, mapping } = parsed;
        return body.map((row, idx) => {
            const skuCell = mapping.sku != null ? row[mapping.sku] : '';
            const nameCell = mapping.name != null ? row[mapping.name] : '';
            const qtyCell = mapping.qty != null ? row[mapping.qty] : '';
            const qtyNum = parseFloat(String(qtyCell).replace(/[^0-9.\-]/g, ''));
            const m = matchRow(skuCell, nameCell);
            return {
                rowIdx: idx,
                sku: String(skuCell || '').trim(),
                name: String(nameCell || '').trim(),
                qty: isNaN(qtyNum) ? 0 : qtyNum,
                ...m,
            };
        });
    }, [parsed, vendor, vendorMatches, flatInventory]);

    // ── Final resolved mapping (matched ∪ overrides) ───────────
    // Per-row qty resolution: if admin typed a manualQty override
    // for this row, use that; otherwise the qty parsed out of the
    // CSV (which is 0 for files without a qty column). Rows are
    // INCLUDED for import iff finalItemId exists AND finalQty > 0.
    const resolved = useMemo(() => {
        return matched.map(r => {
            const manual = manualQty[r.rowIdx];
            const finalQty = (manual !== undefined && manual !== '')
                ? Number(manual)
                : r.qty;
            const isSkipped = overrideMap[r.rowIdx] === '__skip__';
            const override = overrideMap[r.rowIdx];
            let finalItemId = null;
            if (isSkipped) {
                finalItemId = null;
            } else if (override && override !== '__skip__') {
                finalItemId = override;
            } else if (r.matchType !== 'none') {
                finalItemId = r.itemId;
            }
            return {
                ...r,
                finalItemId,
                finalQty: isNaN(finalQty) ? 0 : finalQty,
                skipped: isSkipped,
            };
        });
    }, [matched, overrideMap, manualQty, flatInventory]);

    // Counts for the preview header.
    const stats = useMemo(() => {
        let auto = 0, ambig = 0, none = 0, included = 0, noQty = 0;
        for (const r of resolved) {
            if (r.skipped) { /* counted as skipped */ }
            else if (r.matchType === 'sku' || r.matchType === 'fuzzy_high' || overrideMap[r.rowIdx]) auto++;
            else if (r.matchType === 'fuzzy_low') ambig++;
            else if (r.matchType === 'none') none++;
            if (!r.skipped && r.finalItemId && r.finalQty > 0) included++;
            else if (!r.skipped && r.finalItemId && r.finalQty === 0) noQty++;
        }
        return { auto, ambig, none, noQty, included, total: resolved.length };
    }, [resolved, overrideMap]);

    // Bulk qty controls — "set qty to N for every matched row" is a
    // huge time-saver when admin is using an order guide CSV (no qty
    // column) and they actually ordered the same case count for most
    // items. Only applies to matched-non-skipped rows.
    function setQtyForAllMatched(qty) {
        const next = { ...manualQty };
        for (const r of resolved) {
            if (r.skipped || !r.finalItemId) continue;
            next[r.rowIdx] = String(qty);
        }
        setManualQty(next);
    }

    // ── Import: write the inventoryHistory snapshot ────────────
    async function handleImport() {
        if (busy) return;
        if (stats.included === 0) {
            setError(tx('No matched rows with qty > 0 to import.', 'Sin filas con cantidad mayor a 0.'));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            // Build the counts map: master itemId → qty (summed when
            // multiple lines hit the same item — e.g. two pack sizes
            // mapping to the same master).
            const counts = {};
            const meta = {};
            const newSkuMappings = {};
            for (const r of resolved) {
                if (r.skipped || !r.finalItemId || r.finalQty <= 0) continue;
                counts[r.finalItemId] = (counts[r.finalItemId] || 0) + r.finalQty;
                meta[r.finalItemId] = { by: `${vendor}_csv_import`, at: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) };
                // If admin overrode a row (or fuzzy-high matched), persist
                // the SKU → master mapping so the next import auto-resolves.
                const wasAuto = (r.matchType === 'sku');
                if (r.sku && r.finalItemId && !wasAuto) {
                    newSkuMappings[r.sku] = r.finalItemId;
                }
            }

            // Build a filtered customInventory shape that matches what
            // saveInventorySnapshot writes (items array). Operations.jsx
            // expects this shape when re-rendering history entries.
            const filteredItems = (customInventory || []).map(cat => ({
                category: cat.category || cat.name || '',
                items: (cat.items || [])
                    .filter(i => counts[i.id])
                    .map(i => ({
                        id: i.id,
                        name: i.name,
                        nameEs: i.nameEs || '',
                        vendor: i.vendor || i.supplier || '',
                        supplier: i.vendor || i.supplier || '',
                        orderDay: i.orderDay || '',
                        pack: i.pack || '',
                        price: i.price || null,
                    })),
            })).filter(cat => cat.items.length > 0);

            // Doc id = orderDate + a stamp so multiple imports the same
            // day don't collide.
            const stamp = new Date().toTimeString().split(' ')[0].replace(/:/g, '');
            const docKey = `${orderDate}_${stamp}_${vendor}_import`;
            const isoDate = new Date(orderDate + 'T12:00:00').toISOString();

            await setDoc(doc(db, `inventoryHistory_${storeLocation}`, docKey), {
                counts,
                items: filteredItems,
                countMeta: meta,
                date: isoDate,
                listName: `${VENDORS.find(v => v.key === vendor)?.label || vendor} import (${parsed.fileName})`,
                ordered: {},
                importedFrom: vendor,
                importedBy: staffName,
                importedAt: serverTimestamp(),
            });

            // Persist any newly-resolved SKU mappings into vendor_matches
            // so the next import for this vendor auto-matches them.
            if (Object.keys(newSkuMappings).length > 0) {
                const patch = {};
                for (const [sku, id] of Object.entries(newSkuMappings)) {
                    patch[`${vendor}.${sku}`] = id;
                }
                try {
                    await updateDoc(doc(db, 'config', 'vendor_matches'), patch);
                } catch (err) {
                    if (err?.code === 'not-found') {
                        // First-run safety — create the doc.
                        await setDoc(doc(db, 'config', 'vendor_matches'), { [vendor]: newSkuMappings }, { merge: true });
                    } else {
                        console.warn('vendor_matches patch failed:', err);
                    }
                }
            }

            recordAudit({
                action: 'inventory.csv_import',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'inventoryHistory',
                targetId: docKey,
                details: {
                    vendor,
                    location: storeLocation,
                    fileName: parsed.fileName,
                    rowCount: resolved.length,
                    matchedCount: Object.keys(counts).length,
                    newMappings: Object.keys(newSkuMappings).length,
                    orderDate,
                },
            });

            setStage('done');
            onImported?.({ count: Object.keys(counts).length, docKey });
        } catch (err) {
            console.error('CSV import failed:', err);
            setError(tx('Import failed: ', 'Error al importar: ') + (err.message || err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div className="bg-white w-full md:max-w-2xl md:rounded-2xl rounded-t-2xl flex flex-col max-h-[92vh] shadow-xl"
                onClick={(e) => e.stopPropagation()}>
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-gray-300 rounded-full" />
                </div>
                <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-black text-gray-900">📥 {tx('Import vendor CSV', 'Importar CSV de proveedor')}</h2>
                        <p className="text-[11px] text-gray-500">
                            {stage === 'config'
                                ? tx('Pick vendor + drop the order-guide CSV', 'Elige proveedor + sube el CSV')
                                : stage === 'preview'
                                ? `${stats.included} ${tx('rows ready', 'filas listas')} · ${stats.ambig} ${tx('to review', 'a revisar')} · ${stats.none} ${tx('unmatched', 'sin coincidencia')}`
                                : tx('Done', 'Listo')}
                        </p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center">✕</button>
                </div>

                {error && (
                    <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-800">
                        {error}
                    </div>
                )}

                {stage === 'config' && (
                    <div className="p-4 space-y-4 overflow-y-auto">
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-500 mb-1">
                                {tx('Vendor', 'Proveedor')}
                            </label>
                            <div className="grid grid-cols-3 gap-2">
                                {VENDORS.map(v => (
                                    <button
                                        key={v.key}
                                        onClick={() => setVendor(v.key)}
                                        className={`px-3 py-2 rounded-lg border-2 text-sm font-bold transition ${vendor === v.key ? 'border-mint-600 bg-mint-50 text-mint-800' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                                    >
                                        {v.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-gray-500 mb-1">
                                {tx('Order date', 'Fecha del pedido')}
                            </label>
                            <input
                                type="date"
                                value={orderDate}
                                onChange={(e) => setOrderDate(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm"
                            />
                            <p className="text-[10px] text-gray-500 mt-1">
                                {tx('This is the date the "Last ordered" badge will show.', 'Es la fecha que mostrará la insignia "Último pedido".')}
                            </p>
                        </div>
                        <div>
                            <label className="block w-full px-4 py-8 rounded-lg border-2 border-dashed border-gray-300 text-center cursor-pointer hover:border-mint-500 hover:bg-mint-50">
                                <div className="text-4xl mb-1">{vendor === 'costco' ? '📑' : '📄'}</div>
                                <div className="text-sm font-bold text-gray-700">
                                    {vendor === 'costco'
                                        ? tx('Tap to choose PDF', 'Tap para elegir PDF')
                                        : tx('Tap to choose CSV', 'Tap para elegir CSV')}
                                </div>
                                <div className="text-[11px] text-gray-500 mt-1">
                                    {vendor === 'costco'
                                        ? tx('Costco Business "Lists" page > Print > Save as PDF', 'Costco Business "Listas" > Imprimir > Guardar PDF')
                                        : tx('Sysco / US Foods order-guide export, or any CSV with description + qty columns', 'Exportación del proveedor o cualquier CSV con descripción + cantidad')}
                                </div>
                                <input ref={fileRef} type="file"
                                    accept={vendor === 'costco' ? '.pdf,application/pdf' : '.csv,text/csv,.pdf,application/pdf'}
                                    onChange={handleFile} className="hidden" />
                            </label>
                        </div>
                        <div className="px-3 py-2 rounded-lg bg-gray-50 text-[11px] text-gray-600">
                            <b>{tx('How to export:', 'Cómo exportar:')}</b>
                            <ul className="list-disc pl-4 mt-1 space-y-0.5">
                                <li><b>Sysco</b>: {tx('Shop > Order Guide > Actions > Download CSV', 'Shop > Order Guide > Acciones > Descargar CSV')}</li>
                                <li><b>US Foods</b>: {tx('MOXē > Reporting > Detail Data > Export', 'MOXē > Reportes > Detail Data > Exportar')}</li>
                                <li><b>Costco</b>: {tx('Business Center > Lists > Print > Save as PDF (the saved-list qty is what we import as "ordered qty")', 'Business Center > Listas > Imprimir > Guardar PDF (la cantidad guardada se importa como cantidad pedida)')}</li>
                                <li><b>{tx('Other', 'Otro')}</b>: {tx('any CSV with item description + qty columns works', 'cualquier CSV con descripción + cantidad funciona')}</li>
                            </ul>
                        </div>
                    </div>
                )}

                {stage === 'preview' && parsed && (
                    <div className="flex-1 flex flex-col overflow-hidden">
                        {/* Column mapping bar — only shown if auto-detect failed */}
                        {(parsed.mapping.name == null || parsed.mapping.qty == null) && (
                            <div className="px-4 py-2 bg-amber-50 border-b border-amber-200">
                                <div className="text-[11px] font-bold text-amber-900">
                                    ⚠ {tx('Could not auto-detect all columns. Pick them below:', 'No se detectaron todas las columnas. Elige:')}
                                </div>
                                <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                                    {['sku', 'name', 'qty'].map(field => (
                                        <div key={field}>
                                            <div className="font-bold text-amber-800 mb-0.5 uppercase">{field}</div>
                                            <select
                                                value={parsed.mapping[field] ?? ''}
                                                onChange={(e) => setParsed(p => ({ ...p, mapping: { ...p.mapping, [field]: e.target.value === '' ? null : parseInt(e.target.value) } }))}
                                                className="w-full px-2 py-1 rounded border border-amber-300 bg-white"
                                            >
                                                <option value="">— {tx('skip', 'omitir')} —</option>
                                                {parsed.headers.map((h, i) => (
                                                    <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                                                ))}
                                            </select>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Format note (when applicable) */}
                        {parsed.formatNote && (
                            <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-200 text-[11px] text-blue-800">
                                ℹ️ {parsed.formatNote}
                            </div>
                        )}

                        {/* Bulk-qty toolbar — when the CSV has no qty
                            column (order guide, purchase history), the
                            admin types qty inline. These shortcuts skip
                            the per-row typing for the common "I ordered
                            1 case of each" case. */}
                        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex flex-wrap items-center gap-2 text-[11px]">
                            <span className="font-bold text-gray-600">
                                {tx('Qty defaulted to 1 — change all to:', 'Cantidad por defecto = 1 — cambiar todas a:')}
                            </span>
                            {[1, 2, 3, 5].map(n => (
                                <button key={n} onClick={() => setQtyForAllMatched(n)}
                                    className="px-2 py-0.5 rounded-full bg-white border border-gray-300 font-bold hover:bg-mint-50 hover:border-mint-300">
                                    {n}
                                </button>
                            ))}
                            <button onClick={() => setManualQty({})}
                                className="px-2 py-0.5 rounded-full bg-white border border-gray-300 font-bold text-gray-500 hover:bg-gray-100">
                                {tx('use CSV values', 'usar valores CSV')}
                            </button>
                            {stats.noQty > 0 && (
                                <span className="ml-auto text-amber-700 font-bold">
                                    ⚠ {stats.noQty} {tx('matched rows have qty 0', 'filas con cantidad 0')}
                                </span>
                            )}
                        </div>

                        {/* Rows */}
                        <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
                            {resolved.map(r => (
                                <RowPreview
                                    key={r.rowIdx}
                                    row={r}
                                    flatInventory={flatInventory}
                                    isEs={isEs}
                                    qtyOverride={manualQty[r.rowIdx]}
                                    onQtyChange={(v) => setManualQty(m => ({ ...m, [r.rowIdx]: v }))}
                                    onOverride={(itemId) => setOverrideMap(m => ({ ...m, [r.rowIdx]: itemId }))}
                                    onSkip={() => setOverrideMap(m => ({ ...m, [r.rowIdx]: '__skip__' }))}
                                />
                            ))}
                            {resolved.length === 0 && (
                                <div className="px-4 py-8 text-center text-sm text-gray-500">
                                    {tx('No data rows in this CSV.', 'No hay filas de datos en este CSV.')}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {stage === 'done' && (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                        <div className="text-5xl mb-3">✅</div>
                        <div className="text-lg font-black text-gray-900 mb-1">{tx('Import complete', 'Importación completa')}</div>
                        <div className="text-sm text-gray-600 mb-4">
                            {stats.included} {tx('items written to inventory history', 'artículos en el historial')}
                        </div>
                        <button onClick={onClose} className="px-4 py-2 rounded-full bg-mint-600 text-white font-bold text-sm">
                            {tx('Close', 'Cerrar')}
                        </button>
                    </div>
                )}

                {stage === 'preview' && (
                    <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between gap-2 shrink-0">
                        <button
                            onClick={() => { setStage('config'); setParsed(null); }}
                            className="text-xs font-bold text-gray-600 hover:underline px-2 py-2"
                        >
                            ← {tx('Back', 'Volver')}
                        </button>
                        <div className="flex items-center gap-2">
                            <button onClick={onClose} className="px-3 py-2 rounded-full text-sm font-bold text-gray-600 hover:bg-gray-100">
                                {tx('Cancel', 'Cancelar')}
                            </button>
                            <button
                                onClick={handleImport}
                                disabled={busy || stats.included === 0}
                                className="px-4 py-2 rounded-full bg-mint-600 text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-mint-700"
                            >
                                {busy
                                    ? tx('Importing…', 'Importando…')
                                    : tx(`Import ${stats.included} items`, `Importar ${stats.included}`)}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Single row in the preview list ─────────────────────────────
// Color-coded by match confidence + lets admin override the
// auto-match by picking from the master inventory.
function RowPreview({ row, flatInventory, isEs, qtyOverride, onQtyChange, onOverride, onSkip }) {
    const tx = (en, es) => isEs ? es : en;
    const [search, setSearch] = useState('');
    const [showPicker, setShowPicker] = useState(false);

    const tone = row.skipped
        ? 'bg-gray-50 text-gray-400 line-through'
        : row.matchType === 'sku' || row.matchType === 'fuzzy_high'
        ? 'bg-mint-50'
        : row.matchType === 'fuzzy_low'
        ? 'bg-amber-50'
        : 'bg-red-50';

    const badge = row.skipped
        ? { en: 'SKIP', es: 'OMITIR', cls: 'bg-gray-200 text-gray-600' }
        : row.matchType === 'sku'
        ? { en: 'SKU MATCH', es: 'SKU', cls: 'bg-mint-600 text-white' }
        : row.matchType === 'fuzzy_high'
        ? { en: 'NAME MATCH', es: 'NOMBRE', cls: 'bg-mint-500 text-white' }
        : row.matchType === 'fuzzy_low'
        ? { en: 'CHECK', es: 'REVISAR', cls: 'bg-amber-500 text-white' }
        : { en: 'NO MATCH', es: 'SIN MATCH', cls: 'bg-red-500 text-white' };

    const filteredCandidates = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return flatInventory.slice(0, 30);
        return flatInventory
            .filter(it => it.nameLower.includes(q))
            .slice(0, 30);
    }, [flatInventory, search]);

    return (
        <div className={`px-4 py-2 ${tone}`}>
            <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className={`text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded ${badge.cls}`}>
                            {isEs ? badge.es : badge.en}
                        </span>
                        {/* Editable qty input — defaults to whatever the
                            CSV parsed, falls back to '' (empty = use
                            bulk default). Wider when CSV had no qty
                            so the empty field is obvious. */}
                        {!row.skipped && (
                            <div className="flex items-center gap-1">
                                <span className="text-[10px] uppercase font-bold text-gray-500">{tx('qty', 'cant')}:</span>
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    step="any"
                                    value={qtyOverride !== undefined ? qtyOverride : (row.qty || '')}
                                    onChange={(e) => onQtyChange(e.target.value)}
                                    placeholder="0"
                                    className="w-16 px-1.5 py-0.5 rounded border border-gray-300 text-[11px] font-bold tabular-nums text-center focus:outline-none focus:border-mint-500 focus:ring-1 focus:ring-mint-500/30"
                                />
                            </div>
                        )}
                        {row.sku && (
                            <span className="text-[10px] text-gray-500 font-mono">{row.sku}</span>
                        )}
                    </div>
                    <div className="text-[12px] text-gray-800 mt-0.5 truncate">{row.name}</div>
                    {(row.matchType === 'sku' || row.matchType === 'fuzzy_high' || row.matchType === 'fuzzy_low') && row.finalItemId && (
                        <div className="text-[11px] text-gray-600 mt-0.5">
                            → <b>{flatInventory.find(x => x.id === row.finalItemId)?.name || row.name}</b>
                            {row.confidence < 1 && (
                                <span className="ml-1 text-gray-400">({Math.round(row.confidence * 100)}%)</span>
                            )}
                        </div>
                    )}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                    <button
                        onClick={() => setShowPicker(s => !s)}
                        className="text-[10px] font-bold text-blue-700 hover:underline"
                    >
                        {showPicker ? tx('cancel', 'cancelar') : tx('change match', 'cambiar')}
                    </button>
                    {!row.skipped && (
                        <button
                            onClick={onSkip}
                            className="text-[10px] font-bold text-red-600 hover:underline"
                        >
                            {tx('skip', 'omitir')}
                        </button>
                    )}
                </div>
            </div>
            {showPicker && (
                <div className="mt-2 p-2 rounded-lg bg-white border border-gray-200">
                    <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={tx('Search master inventory…', 'Buscar inventario…')}
                        className="w-full px-3 py-1.5 rounded border border-gray-300 text-xs mb-2"
                        autoFocus
                    />
                    <div className="max-h-[180px] overflow-y-auto">
                        {filteredCandidates.length === 0 ? (
                            <div className="text-xs text-gray-400 text-center py-2">{tx('No matches', 'Sin resultados')}</div>
                        ) : filteredCandidates.map(it => (
                            <button
                                key={it.id}
                                onClick={() => { onOverride(it.id); setShowPicker(false); }}
                                className="block w-full text-left px-2 py-1.5 hover:bg-mint-50 rounded text-xs"
                            >
                                <span className="font-bold">{it.name}</span>
                                {it.pack && <span className="text-gray-500 ml-2 text-[10px]">{it.pack}</span>}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
