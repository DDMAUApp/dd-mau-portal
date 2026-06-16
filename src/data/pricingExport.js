// pricingExport.js — build a spreadsheet (CSV) of every item we buy with its
// current pricing, for the Pricing tab's "Export items & pricing".
//
// Inventory pricing redesign, Phase 2h (Andrew 2026-06-15). One row per
// master inventory item, with its trusted price + best vendor + last ordered
// + average order qty pulled from the item_prices engine. Items with no
// pricing yet still export (blank price columns), so the file doubles as a
// full list of what we buy.
//
// Pure string builder — no DOM. The component does the Blob download.

import {
    resolveTrustedPrice, cheapestVendor, lastOrdered, orderQtyStats,
    PRICE_SOURCE_LABEL,
} from './itemPricing';

// Coerce a date-ish value (ISO string / Firestore Timestamp / {seconds}) to
// 'YYYY-MM-DD' for the spreadsheet.
function fmtDate(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v.slice(0, 10);
    if (typeof v?.toDate === 'function') { try { return v.toDate().toISOString().slice(0, 10); } catch { return ''; } }
    if (typeof v?.seconds === 'number') return new Date(v.seconds * 1000).toISOString().slice(0, 10);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
}

function money(n, dp = 2) {
    return (n == null || !isFinite(Number(n))) ? '' : Number(n).toFixed(dp);
}
function qtyNum(n) {
    if (n == null || !isFinite(Number(n))) return '';
    return Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(1);
}

// RFC-4180 cell escaping.
function esc(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Build the CSV string. `categories` = the master inventory shape
// ([{category|name, items:[{id,name,nameEs,pack,vendor,supplier}]}]).
// `itemPrices` = { [itemId]: priceDoc } from subscribeItemPrices.
export function buildPricingCsv({ categories, itemPrices, language } = {}) {
    const isEs = language === 'es';
    const srcLabel = (s) => (PRICE_SOURCE_LABEL[s] ? (isEs ? PRICE_SOURCE_LABEL[s].es : PRICE_SOURCE_LABEL[s].en) : (s || ''));

    const headers = isEs
        ? ['Categoría', 'Artículo', 'Nombre (ES)', 'Empaque', 'Proveedor asignado',
           'Precio', 'Precio/unidad', 'Unidad', 'Fuente', 'Proveedor del precio', 'Actualizado', 'Vencido',
           'Mejor proveedor', 'Mejor precio/unidad',
           'Última compra $', 'Último proveedor', 'Última fecha',
           'Cant. promedio', 'Última cant.']
        : ['Category', 'Item', 'Name (ES)', 'Pack', 'Assigned vendor',
           'Price', 'Price/unit', 'Unit', 'Source', 'Price vendor', 'Updated', 'Stale',
           'Best vendor', 'Best price/unit',
           'Last ordered $', 'Last vendor', 'Last date',
           'Avg qty', 'Last qty'];

    const rows = [headers];
    let itemCount = 0, pricedCount = 0;

    for (const cat of (categories || [])) {
        const catName = cat?.category || cat?.name || '';
        for (const it of (cat?.items || [])) {
            if (!it || !it.id) continue;
            itemCount++;
            const pd = itemPrices ? itemPrices[it.id] : null;
            const trusted = pd ? resolveTrustedPrice(pd) : null;
            const best = pd ? cheapestVendor(pd) : null;
            const last = pd ? lastOrdered(pd) : null;
            const q = pd ? orderQtyStats(pd) : null;
            if (trusted) pricedCount++;

            rows.push([
                catName,
                it.name || '',
                it.nameEs || '',
                it.pack || '',
                it.vendor || it.supplier || '',
                trusted ? money(trusted.price) : '',
                trusted && trusted.perUnit != null ? money(trusted.perUnit, trusted.perUnit < 1 ? 4 : 2) : '',
                trusted?.unit || '',
                trusted ? srcLabel(trusted.source) : '',
                trusted?.vendor || '',
                trusted ? fmtDate(trusted.at) : '',
                trusted?.stale ? (isEs ? 'sí' : 'yes') : '',
                best?.vendor || '',
                best && best.perUnit != null ? money(best.perUnit, best.perUnit < 1 ? 4 : 2) : '',
                last ? money(last.price) : '',
                last?.vendor || '',
                last ? fmtDate(last.at) : '',
                q ? qtyNum(q.avgQty) : '',
                q ? qtyNum(q.lastQty) : '',
            ]);
        }
    }

    const body = rows.map((r) => r.map(esc).join(',')).join('\r\n');
    // UTF-8 BOM so Excel reads accents (ñ, á) correctly.
    return { csv: '﻿' + body, itemCount, pricedCount };
}

// Suggested filename: dd-mau-pricing-<location>-<YYYY-MM-DD>.csv
export function pricingCsvFilename(location, dateStr) {
    const loc = String(location || 'inventory').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return `dd-mau-pricing-${loc}-${dateStr}.csv`;
}
