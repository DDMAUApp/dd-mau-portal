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
const COLUMN_ALIASES = {
    sku: [
        'itemnumber', 'itemno', 'itemid', 'item', 'productnumber', 'productid', 'productcode',
        'sku', 'materialnumber', 'material', 'mfgno', 'mfgnumber',
    ],
    name: [
        'description', 'itemdescription', 'productdescription', 'product', 'productname', 'name',
        'item', 'commodity',
    ],
    qty: [
        'qty', 'quantity', 'qtyordered', 'orderqty', 'casesordered', 'caseqty',
        'qtyshipped', 'shippedqty', 'cases',
    ],
    price: [
        'price', 'unitprice', 'caseprice', 'yourprice', 'listprice',
    ],
    unit: [
        'unit', 'uom', 'pack', 'packsize', 'casepack',
    ],
};

const VENDORS = [
    { key: 'sysco',    label: 'Sysco' },
    { key: 'usfoods',  label: 'US Foods' },
    { key: 'other',    label: 'Other vendor' },
];

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
    function detectColumns(headers) {
        const map = {};
        const norm = headers.map(normalizeHeader);
        for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
            for (const alias of aliases) {
                const idx = norm.findIndex(h => h === alias || h.includes(alias));
                if (idx !== -1) { map[field] = idx; break; }
            }
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

    function fuzzyMatchByName(query) {
        if (!query) return null;
        const q = String(query).toLowerCase();
        const qTokens = new Set(q.split(/[^a-z0-9]+/).filter(t => t.length > 2));
        if (qTokens.size === 0) return null;
        let best = null;
        let bestScore = 0;
        for (const it of flatInventory) {
            const itTokens = new Set(it.nameLower.split(/[^a-z0-9]+/).filter(t => t.length > 2));
            if (itTokens.size === 0) continue;
            let overlap = 0;
            for (const t of qTokens) if (itTokens.has(t)) overlap++;
            const score = overlap / Math.max(qTokens.size, itTokens.size);
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

    // ── File picked ────────────────────────────────────────────
    async function handleFile(e) {
        setError(null);
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        if (!/\.csv$/i.test(f.name)) {
            setError(tx('Please upload a .csv file.', 'Por favor sube un archivo .csv.'));
            return;
        }
        try {
            const text = await f.text();
            setRawText(text);
            const rows = parseCsv(text);
            if (rows.length < 2) {
                setError(tx('CSV looks empty or has no header row.', 'El CSV está vacío o sin encabezado.'));
                return;
            }
            // Find the header row — Sysco CSVs sometimes have a few title rows
            // before the actual column header. We pick the first row that has
            // both a "description"-like AND a "qty"-like column detected.
            let headerIdx = 0;
            for (let i = 0; i < Math.min(rows.length, 10); i++) {
                const map = detectColumns(rows[i]);
                if (map.name != null && map.qty != null) { headerIdx = i; break; }
            }
            const headers = rows[headerIdx];
            const body = rows.slice(headerIdx + 1);
            const mapping = detectColumns(headers);
            setParsed({ headers, body, mapping, fileName: f.name });
            setOverrideMap({});
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
    const resolved = useMemo(() => {
        return matched.map(r => {
            if (overrideMap[r.rowIdx] === '__skip__') return { ...r, finalItemId: null, skipped: true };
            const override = overrideMap[r.rowIdx];
            if (override) {
                const it = flatInventory.find(x => x.id === override);
                return { ...r, finalItemId: override, finalName: it?.name || r.name, skipped: false };
            }
            return {
                ...r,
                finalItemId: r.itemId,
                finalName: r.name || r.matchType === 'none' ? r.name : (r.name || ''),
                skipped: r.matchType === 'none',
            };
        });
    }, [matched, overrideMap, flatInventory]);

    // Counts for the preview header.
    const stats = useMemo(() => {
        let auto = 0, ambig = 0, none = 0, included = 0;
        for (const r of resolved) {
            if (r.skipped) none++;
            else if (r.matchType === 'sku' || r.matchType === 'fuzzy_high' || overrideMap[r.rowIdx]) {
                auto++;
                if (r.qty > 0) included++;
            } else if (r.matchType === 'fuzzy_low') ambig++;
            else none++;
        }
        return { auto, ambig, none, included, total: resolved.length };
    }, [resolved, overrideMap]);

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
                if (r.skipped || !r.finalItemId || r.qty <= 0) continue;
                counts[r.finalItemId] = (counts[r.finalItemId] || 0) + r.qty;
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
                                <div className="text-4xl mb-1">📄</div>
                                <div className="text-sm font-bold text-gray-700">{tx('Tap to choose CSV', 'Tap para elegir CSV')}</div>
                                <div className="text-[11px] text-gray-500 mt-1">
                                    {tx('Sysco / US Foods order-guide export, or any CSV with description + qty columns', 'Exportación del proveedor o cualquier CSV con descripción + cantidad')}
                                </div>
                                <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
                            </label>
                        </div>
                        <div className="px-3 py-2 rounded-lg bg-gray-50 text-[11px] text-gray-600">
                            <b>{tx('How to export:', 'Cómo exportar:')}</b>
                            <ul className="list-disc pl-4 mt-1 space-y-0.5">
                                <li><b>Sysco</b>: {tx('Shop > Order Guide > Actions > Download CSV', 'Shop > Order Guide > Acciones > Descargar CSV')}</li>
                                <li><b>US Foods</b>: {tx('MOXē > Reporting > Detail Data > Export', 'MOXē > Reportes > Detail Data > Exportar')}</li>
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

                        {/* Rows */}
                        <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
                            {resolved.map(r => (
                                <RowPreview
                                    key={r.rowIdx}
                                    row={r}
                                    flatInventory={flatInventory}
                                    isEs={isEs}
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
function RowPreview({ row, flatInventory, isEs, onOverride, onSkip }) {
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
                        {row.qty > 0 && (
                            <span className="text-[11px] font-black text-gray-800 tabular-nums">
                                {tx('Qty', 'Cant.')}: {row.qty}
                            </span>
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
