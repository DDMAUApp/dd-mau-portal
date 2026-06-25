import { useState, useMemo } from 'react';
import ModalPortal from './ModalPortal';

// Item price history — Andrew 2026-06-25: "a tab under the scan receipt button
// where we have every item pulled from invoices and I can look at that item's
// price history… look at greens, press green onions, and see all the price
// history and where each time it was bought from."
//
// Reads the per-item /item_prices_{loc}/{itemId}.history[] that recordPurchase
// writes on every receipt scan / price import. Each history row now carries the
// INVOICE date (purchasedDate) + per-unit + vendor, so a price lands at the date
// it was actually bought. Browse by category → item → full purchase history.

function rowsFromDoc(priceDoc) {
    const hist = Array.isArray(priceDoc?.history) ? priceDoc.history : [];
    return hist
        .filter(h => h && h.newPrice != null)
        .map(h => ({
            // Prefer the real invoice date; older rows (pre-2026-06-25) fall back
            // to the save timestamp's date.
            date: h.purchasedDate || (typeof h.at === 'string' ? h.at.slice(0, 10) : null),
            price: Number(h.newPrice),
            perUnit: h.perUnit != null ? Number(h.perUnit) : null,
            unit: h.unit || null,
            pack: h.pack || null,
            vendor: h.vendor || 'Other',
            qty: h.qty != null ? Number(h.qty) : null,
            code: h.code || null,
            brand: h.brand || null,
            source: h.source || 'invoice',
        }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

const money = (n) => (n == null || !isFinite(n) ? '—' : `$${Number(n).toFixed(2)}`);
function fmtDate(d, isEn) {
    if (!d) return '—';
    const parts = String(d).split('-');
    if (parts.length !== 3) return d;
    const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12);
    return dt.toLocaleDateString(isEn ? 'en-US' : 'es-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Per-item detail modal ───────────────────────────────────────────────────
function HistoryModal({ item, rows, language, onClose }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);
    const prices = rows.map(r => (r.perUnit != null ? r.perUnit : r.price)).filter(p => p != null && isFinite(p));
    const lo = prices.length ? Math.min(...prices) : null;
    const hi = prices.length ? Math.max(...prices) : null;
    const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    const usesPerUnit = rows.some(r => r.perUnit != null);

    return (
        <ModalPortal onBackPress={onClose}>
            <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/40" onClick={onClose} role="dialog" aria-modal="true">
                <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-dd-line overflow-hidden flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
                    <div className="px-4 py-3 bg-dd-green-50 border-b border-dd-line flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className="text-base font-black text-dd-text truncate">{item.name}</div>
                            <div className="text-[11px] text-dd-text-2">{tx('Price history', 'Historial de precios')} · {rows.length} {tx('buys', 'compras')}</div>
                        </div>
                        <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/70 text-dd-text-2 hover:bg-white text-lg leading-none shrink-0">✕</button>
                    </div>
                    {/* Lo / avg / hi summary */}
                    <div className="px-4 py-2 flex items-center justify-center gap-2 flex-wrap border-b border-dd-line bg-dd-bg/40 text-[11px] font-bold">
                        <span className="px-2 py-0.5 rounded-full bg-dd-green text-white">{tx('Low', 'Bajo')} {money(lo)}{usesPerUnit ? `/${rows.find(r => r.unit)?.unit || 'unit'}` : ''}</span>
                        <span className="px-2 py-0.5 rounded-full bg-dd-bg text-dd-text-2 border border-dd-line">{tx('Avg', 'Prom')} {money(avg)}</span>
                        <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-300">{tx('High', 'Alto')} {money(hi)}</span>
                    </div>
                    {/* History rows */}
                    <div className="p-3 overflow-y-auto">
                        {rows.length === 0 ? (
                            <p className="text-[12px] text-dd-text-2 italic text-center py-6">{tx('No purchases recorded yet.', 'Aún no hay compras.')}</p>
                        ) : (
                            <div className="space-y-1">
                                {rows.map((r, i) => {
                                    const isLow = (r.perUnit != null ? r.perUnit : r.price) === lo;
                                    return (
                                        <div key={i} className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border ${isLow ? 'border-dd-green/50 bg-dd-green-50/60' : 'border-dd-line bg-white'}`}>
                                            <div className="min-w-0">
                                                <div className="text-sm font-bold text-dd-text tabular-nums">
                                                    {money(r.price)}{r.pack ? <span className="text-[11px] font-normal text-dd-text-2"> / {r.pack}</span> : null}
                                                    {r.perUnit != null && <span className="ml-1 text-[11px] font-bold text-dd-green-700">({money(r.perUnit)}/{r.unit || 'unit'})</span>}
                                                </div>
                                                <div className="text-[11px] text-dd-text-2">
                                                    {r.vendor}{r.brand ? ` · ${r.brand}` : ''}{r.code ? ` · #${r.code}` : ''}{r.qty != null ? ` · ${tx('qty', 'cant')} ${r.qty}` : ''}{r.source && r.source !== 'invoice' ? ` · ${r.source}` : ''}
                                                </div>
                                            </div>
                                            <div className="text-[11px] font-bold text-dd-text-2 shrink-0 text-right">{fmtDate(r.date, isEn)}</div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}

// ── Collapsible browser ─────────────────────────────────────────────────────
export default function ItemPriceHistory({ language, masterCategories, itemPrices }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);
    const [expanded, setExpanded] = useState(false);
    const [search, setSearch] = useState('');
    const [openCat, setOpenCat] = useState(null);
    const [selected, setSelected] = useState(null); // { item, rows }

    // Categories → items that HAVE purchase history, with a quick summary.
    const cats = useMemo(() => {
        const out = [];
        for (const cat of (masterCategories || [])) {
            const items = [];
            for (const it of (cat?.items || [])) {
                if (!it?.id) continue;
                const rows = rowsFromDoc(itemPrices?.[it.id]);
                if (!rows.length) continue;
                items.push({
                    id: it.id, name: it.name || it.id,
                    rows, count: rows.length,
                    latest: rows[0],
                });
            }
            if (items.length) {
                items.sort((a, b) => a.name.localeCompare(b.name));
                out.push({ id: cat.id, name: (isEn ? cat.name : (cat.nameEs || cat.name)) || tx('Other', 'Otros'), items });
            }
        }
        return out;
    }, [masterCategories, itemPrices, isEn]);

    const totalItems = useMemo(() => cats.reduce((n, c) => n + c.items.length, 0), [cats]);

    // Search across all items (flat) when there's a query.
    const searchResults = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return null;
        const out = [];
        for (const c of cats) for (const it of c.items) {
            if (it.name.toLowerCase().includes(q)) out.push({ ...it, cat: c.name });
        }
        return out.slice(0, 60);
    }, [search, cats]);

    return (
        <div className="mt-3 pt-3 border-t border-dd-line">
            <button onClick={() => setExpanded(v => !v)}
                className="w-full flex items-center justify-between text-dd-text text-xs font-bold hover:bg-dd-bg rounded-md px-2 py-1.5 transition">
                <span>📜 {tx('Item price history', 'Historial de precios')}</span>
                <span className="text-dd-text-2">{expanded ? '▼' : '▶'}</span>
            </button>
            {expanded && (
                <div className="mt-2">
                    <p className="text-[11px] text-dd-text-2 mb-2 px-1">
                        {tx('Every item we\'ve bought on a scanned invoice. Tap one to see every price it was bought at, the date, and where.',
                            'Cada artículo comprado en una factura escaneada. Toca uno para ver cada precio, la fecha y de dónde.')}
                    </p>
                    <input value={search} onChange={(e) => setSearch(e.target.value)}
                        placeholder={tx('Search an item (e.g. green onion)…', 'Buscar artículo…')}
                        className="w-full mb-2 px-2.5 py-1.5 text-base border border-dd-line rounded-lg focus:border-dd-green focus:ring-1 focus:ring-dd-green-50 outline-none" />

                    {totalItems === 0 ? (
                        <p className="text-[12px] text-dd-text-2 italic px-2 py-3">
                            {tx('No invoice prices recorded yet. Scan a receipt or import a price file and items will show up here.',
                                'Aún no hay precios de facturas. Escanea un recibo o importa un archivo y los artículos aparecerán aquí.')}
                        </p>
                    ) : searchResults ? (
                        <div className="space-y-1 max-h-[26rem] overflow-y-auto overscroll-contain pr-1">
                            {searchResults.length === 0
                                ? <p className="text-[12px] text-dd-text-2 italic px-2 py-3">{tx('No items match.', 'Sin coincidencias.')}</p>
                                : searchResults.map(it => (
                                    <button key={it.id} onClick={() => setSelected({ item: it, rows: it.rows })}
                                        className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-white border border-dd-line hover:bg-dd-bg active:scale-[0.99] transition text-left">
                                        <span className="min-w-0">
                                            <span className="block text-sm font-bold text-dd-text truncate">{it.name}</span>
                                            <span className="block text-[10px] text-dd-text-2">{it.cat} · {it.count} {tx('buys', 'compras')}</span>
                                        </span>
                                        <span className="text-sm font-bold text-dd-text tabular-nums shrink-0">{money(it.latest.price)}<span className="text-[10px] font-normal text-dd-text-2"> {fmtDate(it.latest.date, isEn)}</span></span>
                                    </button>
                                ))}
                        </div>
                    ) : (
                        <div className="space-y-1 max-h-[26rem] overflow-y-auto overscroll-contain pr-1">
                            {cats.map(c => (
                                <div key={c.id} className="rounded-lg border border-dd-line overflow-hidden">
                                    <button onClick={() => setOpenCat(openCat === c.id ? null : c.id)}
                                        className="w-full flex items-center justify-between px-3 py-2 bg-dd-bg/50 hover:bg-dd-bg text-sm font-bold text-dd-text">
                                        <span>{c.name} <span className="text-[10px] font-normal text-dd-text-2">({c.items.length})</span></span>
                                        <span className="text-dd-text-2 text-xs">{openCat === c.id ? '▼' : '▶'}</span>
                                    </button>
                                    {openCat === c.id && (
                                        <div className="divide-y divide-dd-line/60">
                                            {c.items.map(it => (
                                                <button key={it.id} onClick={() => setSelected({ item: it, rows: it.rows })}
                                                    className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-white hover:bg-dd-bg active:scale-[0.99] transition text-left">
                                                    <span className="min-w-0">
                                                        <span className="block text-sm font-semibold text-dd-text truncate">{it.name}</span>
                                                        <span className="block text-[10px] text-dd-text-2">{it.count} {tx('buys', 'compras')} · {tx('latest', 'último')} {fmtDate(it.latest.date, isEn)}</span>
                                                    </span>
                                                    <span className="text-sm font-bold text-dd-text tabular-nums shrink-0">{money(it.latest.price)}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {selected && (
                <HistoryModal item={selected.item} rows={selected.rows} language={language} onClose={() => setSelected(null)} />
            )}
        </div>
    );
}
