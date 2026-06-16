// PricingWorkspace — the rebuilt inventory "Pricing" tab.
//
// Inventory pricing redesign, Phase 2 (Andrew 2026-06-14: "clear that page
// and build from new"). Two ways to feed trusted prices into the item_prices
// engine (which the cart + item chips now read):
//
//   📸 Scan receipt (MAIN) — photo of a delivery receipt → AI clarity check
//      → AI extracts vendor + line items → match each to the master list →
//      writes trusted prices + "last ordered".  (ReceiptScanModal)
//   📥 Import price file — choose vendor → drop a CSV/PDF from the vendor
//      site → parse → match → writes trusted prices. (VendorCsvImportModal)
//
// Phase 2d (Andrew 2026-06-15: "show where it matched and i can edit it"):
// a "Recent scans" list — every past scan is re-openable into its review
// screen to fix matches and re-save. (receiptScans + ReceiptScanModal)
import { useState, useEffect, useMemo } from 'react';
import { Camera, FileUp, Sparkles, History, Trash2, ChevronRight, Download, Wand2, Search } from 'lucide-react';
import ReceiptScanModal from './ReceiptScanModal';
import { subscribeReceiptScans, deleteReceiptScan, buildUnmatchedQueue } from '../data/receiptScans';
import { subscribeItemAliases, learnAliases } from '../data/itemAliases';
import { recordPurchase } from '../data/itemPricing';
import { buildPricingCsv, pricingCsvFilename } from '../data/pricingExport';
import { downloadFile } from '../capacitor-bridge';
import { toast } from '../toast';

// 'YYYY-MM-DD' → 'Jun 14' (locale-light, no Date parse surprises).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(ymd) {
    if (!ymd || typeof ymd !== 'string') return '';
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return ymd;
    return `${MONTHS[parseInt(m[2], 10) - 1] || ''} ${parseInt(m[3], 10)}`;
}

export default function PricingWorkspace({ language, isAdmin, storeLocation, staffName, masterCategories, itemPrices, onOpenImport }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [scanning, setScanning] = useState(false);
    const [reopen, setReopen] = useState(null);   // a saved scan doc to edit
    const [scans, setScans] = useState([]);
    const [aliasMap, setAliasMap] = useState({});
    const [confirmDel, setConfirmDel] = useState(null);
    const [exporting, setExporting] = useState(false);

    // Export every item we buy + its current pricing to a CSV the manager can
    // open in Excel/Sheets. Uses the cross-platform downloadFile (web anchor /
    // native Filesystem+Share).
    const handleExport = async () => {
        if (exporting) return;
        setExporting(true);
        try {
            const today = new Date().toISOString().slice(0, 10);
            const { csv, itemCount, pricedCount } = buildPricingCsv({ categories: masterCategories, itemPrices, language });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            await downloadFile({ data: blob, fileName: pricingCsvFilename(storeLocation, today), mimeType: 'text/csv' });
            toast(tx(`Exported ${itemCount} items (${pricedCount} priced).`, `${itemCount} artículos exportados (${pricedCount} con precio).`));
        } catch (e) {
            console.error('[PricingWorkspace] export failed', e);
            toast(tx('Export failed — try again.', 'Error al exportar — intenta de nuevo.'));
        } finally {
            setExporting(false);
        }
    };

    useEffect(() => {
        if (!isAdmin || !storeLocation) return;
        return subscribeReceiptScans(storeLocation, setScans);
    }, [isAdmin, storeLocation]);

    useEffect(() => {
        if (!isAdmin || !storeLocation) return;
        return subscribeItemAliases(storeLocation, setAliasMap);
    }, [isAdmin, storeLocation]);

    // Flat master-item list for the unmatched picker.
    const masters = useMemo(() => {
        const out = [];
        for (const cat of (masterCategories || [])) {
            for (const it of (cat?.items || [])) {
                if (it?.id) out.push({ id: it.id, name: it.name || '', nameLower: (it.name || '').toLowerCase() });
            }
        }
        return out;
    }, [masterCategories]);

    // Cross-scan "still unmatched" queue (pure helper, unit-tested).
    const unmatchedQueue = useMemo(() => buildUnmatchedQueue(scans, aliasMap), [scans, aliasMap]);

    // Fix an unmatched name: remember it (so future scans auto-match) and, if
    // the line carried a price, save that purchase so it's not lost. The alias
    // write makes this entry drop out of the queue live.
    const resolveUnmatched = async (entry, masterId, masterName) => {
        try {
            await learnAliases(storeLocation, [{ rawName: entry.name, masterId, masterName, vendor: entry.vendor || null }], staffName);
            if (entry.price != null && isFinite(entry.price)) {
                await recordPurchase(storeLocation, masterId, {
                    vendor: entry.vendor || 'Other', price: entry.price, pack: entry.pack || null,
                    qty: null, by: staffName, purchasedDate: entry.date || undefined, reason: 'unmatched resolve',
                });
            }
            toast(tx(`Matched "${entry.name}" → ${masterName}.`, `Emparejado "${entry.name}" → ${masterName}.`));
        } catch (e) {
            console.error('[PricingWorkspace] resolveUnmatched failed', e);
            toast(tx('Could not save — try again.', 'No se pudo guardar — intenta de nuevo.'));
        }
    };

    if (!isAdmin) {
        return (
            <div className="rounded-2xl border border-dd-line bg-white p-6 text-center text-sm text-dd-text-2">
                {tx('Item pricing is managed by managers.', 'Los precios los administran los gerentes.')}
            </div>
        );
    }

    const modalOpen = scanning || reopen;
    const closeModal = () => { setScanning(false); setReopen(null); };

    return (
        <div className="space-y-4">
            {/* Intro */}
            <div className="rounded-2xl border border-dd-line bg-gradient-to-br from-emerald-50 to-white p-4">
                <div className="flex items-center gap-2 text-emerald-800 font-bold text-sm">
                    <Sparkles size={16} strokeWidth={2.25} aria-hidden="true" />
                    {tx('Pricing & Receipts', 'Precios y Recibos')}
                </div>
                <p className="text-xs text-dd-text-2 mt-1 leading-relaxed">
                    {tx(
                        'Snap a delivery receipt or import a vendor price file. The AI reads the items + prices and matches them to your master list, so the cart always knows the best price and what you last paid.',
                        'Toma una foto de un recibo o importa un archivo de precios del proveedor. La IA lee los artículos y precios y los empareja con tu lista maestra, para que el carrito sepa el mejor precio y lo que pagaste por última vez.'
                    )}
                </p>
            </div>

            {/* Two ways in */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Scan receipt — MAIN */}
                <button
                    type="button"
                    onClick={() => setScanning(true)}
                    className="text-left rounded-2xl border-2 border-dd-green/40 bg-dd-green/5 p-4 hover:bg-dd-green/10 transition active:scale-[0.99]"
                >
                    <div className="w-10 h-10 rounded-xl bg-dd-green text-white flex items-center justify-center mb-2">
                        <Camera size={20} strokeWidth={2.25} aria-hidden="true" />
                    </div>
                    <div className="font-bold text-dd-text text-sm">{tx('📸 Scan receipt', '📸 Escanear recibo')}</div>
                    <div className="text-xs text-dd-text-2 mt-0.5">
                        {tx('Take a photo — AI reads every item + price and helps you match them.', 'Toma una foto — la IA lee cada artículo y precio y te ayuda a emparejarlos.')}
                    </div>
                </button>

                {/* Import file */}
                <button
                    type="button"
                    onClick={onOpenImport}
                    className="text-left rounded-2xl border border-dd-line bg-white p-4 hover:bg-dd-bg transition active:scale-[0.99]"
                >
                    <div className="w-10 h-10 rounded-xl bg-gray-100 text-gray-700 flex items-center justify-center mb-2">
                        <FileUp size={20} strokeWidth={2.25} aria-hidden="true" />
                    </div>
                    <div className="font-bold text-dd-text text-sm">{tx('📥 Import price file', '📥 Importar archivo')}</div>
                    <div className="text-xs text-dd-text-2 mt-0.5">
                        {tx('Choose a vendor and drop a CSV/PDF from their website.', 'Elige un proveedor y sube un CSV/PDF de su sitio web.')}
                    </div>
                </button>
            </div>

            {/* Unmatched items — cross-scan cleanup queue */}
            {unmatchedQueue.length > 0 && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50/40 overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-amber-200 flex items-center gap-2">
                        <Wand2 size={15} className="text-amber-600" aria-hidden="true" />
                        <div className="text-xs font-bold uppercase tracking-wider text-amber-800">
                            {tx('Unmatched items', 'Sin emparejar')}
                        </div>
                        <span className="ml-auto text-[11px] font-bold text-amber-700">{unmatchedQueue.length}</span>
                    </div>
                    <div className="px-4 pt-2 text-[11px] text-amber-800/80">
                        {tx('Names from past scans we couldn’t match. Pick the right item once — we’ll remember it next time and save its price.', 'Nombres de escaneos que no pudimos emparejar. Elige el artículo correcto una vez — lo recordaremos y guardaremos su precio.')}
                    </div>
                    <div className="divide-y divide-amber-200/60 mt-1">
                        {unmatchedQueue.map((entry) => (
                            <UnmatchedRow key={entry.key} entry={entry} masters={masters} language={language} onResolve={resolveUnmatched} />
                        ))}
                    </div>
                </div>
            )}

            {/* Export items & pricing */}
            <div className="rounded-2xl border border-dd-line bg-white p-4">
                <div className="flex items-center gap-2 text-dd-text font-bold text-sm">
                    <Download size={16} className="text-blue-600" strokeWidth={2.25} aria-hidden="true" />
                    {tx('📤 Export items & pricing', '📤 Exportar artículos y precios')}
                </div>
                <p className="text-xs text-dd-text-2 mt-1 leading-relaxed">
                    {tx(
                        'Download a spreadsheet (CSV) of every item you buy with its current best price, who it was last ordered from, and your average order quantity.',
                        'Descarga una hoja de cálculo (CSV) de cada artículo que compras con su mejor precio actual, de quién se pidió por última vez y tu cantidad promedio de pedido.'
                    )}
                </p>
                <button
                    type="button"
                    onClick={handleExport}
                    disabled={exporting || !(masterCategories || []).length}
                    className="mt-3 w-full sm:w-auto px-4 py-2 rounded-xl bg-dd-green text-white font-bold text-sm disabled:opacity-50 flex items-center justify-center gap-1.5 active:scale-[0.99] transition"
                >
                    <Download size={15} /> {exporting ? tx('Exporting…', 'Exportando…') : tx('Export CSV', 'Exportar CSV')}
                </button>
            </div>

            {/* Recent scans — re-openable + editable */}
            <div className="rounded-2xl border border-dd-line bg-white overflow-hidden">
                <div className="px-4 py-2.5 border-b border-dd-line flex items-center gap-2">
                    <History size={15} className="text-dd-text-2" aria-hidden="true" />
                    <div className="text-xs font-bold uppercase tracking-wider text-dd-text-2">
                        {tx('Recent scans', 'Escaneos recientes')}
                    </div>
                    {scans.length > 0 && (
                        <span className="ml-auto text-[11px] text-dd-text-2">{scans.length}</span>
                    )}
                </div>

                {scans.length === 0 ? (
                    <div className="p-6 text-center text-xs text-dd-text-2">
                        {tx('No scans yet. Scan a receipt or import a file — it shows up here so you can see what matched and edit it.', 'Aún no hay escaneos. Escanea un recibo o importa un archivo — aparecerá aquí para ver lo emparejado y editarlo.')}
                    </div>
                ) : (
                    <div className="divide-y divide-dd-line">
                        {scans.map((s) => {
                            const total = (s.lines || []).length;
                            const matched = (s.lines || []).filter((l) => l.masterId).length;
                            return (
                                <div key={s.id} className="flex items-center gap-2 px-4 py-2.5 hover:bg-dd-bg/50">
                                    <button
                                        type="button"
                                        onClick={() => setReopen(s)}
                                        className="flex-1 min-w-0 text-left flex items-center gap-3"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="text-sm font-bold text-dd-text truncate">
                                                {s.vendor || tx('Receipt', 'Recibo')}
                                                {s.source === 'import' && <span className="ml-1 text-[10px] font-semibold text-gray-400">{tx('(import)', '(import)')}</span>}
                                            </div>
                                            <div className="text-[11px] text-dd-text-2 truncate">
                                                {shortDate(s.date)}{s.scannedBy ? ` · ${s.scannedBy}` : ''}
                                            </div>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <div className="text-xs font-bold text-emerald-700">
                                                {tx(`${s.savedCount ?? 0} saved`, `${s.savedCount ?? 0} guardado${(s.savedCount ?? 0) === 1 ? '' : 's'}`)}
                                            </div>
                                            <div className="text-[10px] text-dd-text-2">
                                                {tx(`${matched}/${total} matched`, `${matched}/${total} emparejado`)}
                                            </div>
                                        </div>
                                        <ChevronRight size={16} className="text-gray-300 shrink-0" />
                                    </button>
                                    {confirmDel === s.id ? (
                                        <span className="flex items-center gap-1 shrink-0">
                                            <button
                                                onClick={async () => { await deleteReceiptScan(storeLocation, s.id); setConfirmDel(null); }}
                                                className="text-[11px] font-bold text-red-600 px-1.5 py-0.5 rounded hover:bg-red-50"
                                            >{tx('Delete', 'Borrar')}</button>
                                            <button
                                                onClick={() => setConfirmDel(null)}
                                                className="text-[11px] text-gray-500 px-1.5 py-0.5 rounded hover:bg-gray-100"
                                            >{tx('Cancel', 'Cancelar')}</button>
                                        </span>
                                    ) : (
                                        <button
                                            onClick={() => setConfirmDel(s.id)}
                                            className="text-gray-300 hover:text-red-500 p-1 shrink-0"
                                            aria-label={tx('Delete scan', 'Borrar escaneo')}
                                        ><Trash2 size={15} /></button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Hint */}
            <div className="rounded-2xl border border-dashed border-dd-line bg-dd-bg/40 p-4 text-center">
                <div className="text-xs text-dd-text-2">
                    {tx('Prices you scan, import, or set show on items and in the cart (🏆 Best · ↩ Last ordered).', 'Los precios que escaneas, importas o fijas aparecen en los artículos y en el carrito (🏆 Mejor · ↩ Última compra).')}
                </div>
            </div>

            {modalOpen && (
                <ReceiptScanModal
                    location={storeLocation}
                    staffName={staffName}
                    language={language}
                    masterCategories={masterCategories}
                    aliasMap={aliasMap}
                    initialExtraction={reopen ? {
                        vendor: reopen.vendor,
                        date: reopen.date,
                        lineItems: reopen.lines || [],
                        scanId: reopen.id,
                        source: reopen.source,
                    } : undefined}
                    onClose={closeModal}
                />
            )}
        </div>
    );
}

// One unmatched name + an inline master-item picker. On pick → onResolve
// (learns the alias + saves the price), which removes it from the queue live.
function UnmatchedRow({ entry, masters, language, onResolve }) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [busy, setBusy] = useState(false);
    const results = useMemo(() => {
        const q = query.trim().toLowerCase();
        return (q ? masters.filter((m) => m.nameLower.includes(q)) : masters).slice(0, 8);
    }, [query, masters]);
    const pick = async (m) => {
        if (busy) return;
        setBusy(true);
        try { await onResolve(entry, m.id, m.name); } finally { setBusy(false); }
    };
    return (
        <div className="px-4 py-2.5">
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-dd-text truncate">{entry.name}</div>
                    <div className="text-[11px] text-dd-text-2 truncate">
                        {entry.vendor || tx('Receipt', 'Recibo')}
                        {entry.date ? ` · ${shortDate(entry.date)}` : ''}
                        {entry.price != null ? ` · $${entry.price.toFixed(2)}` : ''}
                        {entry.count > 1 ? ` · ${tx(`seen ${entry.count}×`, `visto ${entry.count}×`)}` : ''}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => setOpen((o) => !o)}
                    className="shrink-0 px-2.5 py-1 rounded-lg bg-dd-green text-white text-xs font-bold active:scale-[0.98]"
                >{open ? tx('Close', 'Cerrar') : tx('Match', 'Emparejar')}</button>
            </div>
            {open && (
                <div className="mt-2 rounded-lg border border-gray-200 bg-white p-2">
                    <div className="flex items-center gap-1 mb-1">
                        <Search size={12} className="text-gray-400" />
                        <input
                            autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
                            placeholder={tx('search master items…', 'buscar artículos…')}
                            className="flex-1 text-sm bg-transparent outline-none"
                        />
                    </div>
                    <div className="max-h-44 overflow-y-auto">
                        {results.map((m) => (
                            <button
                                key={m.id} disabled={busy} onClick={() => pick(m)}
                                className="block w-full text-left text-xs px-2 py-1 hover:bg-dd-bg rounded disabled:opacity-50"
                            >{m.name}</button>
                        ))}
                        {results.length === 0 && (
                            <div className="text-[11px] text-gray-400 px-2 py-1">{tx('No matches.', 'Sin resultados.')}</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
