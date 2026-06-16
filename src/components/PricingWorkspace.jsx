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
import { useState, useEffect } from 'react';
import { Camera, FileUp, Sparkles, History, Trash2, ChevronRight } from 'lucide-react';
import ReceiptScanModal from './ReceiptScanModal';
import { subscribeReceiptScans, deleteReceiptScan } from '../data/receiptScans';

// 'YYYY-MM-DD' → 'Jun 14' (locale-light, no Date parse surprises).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(ymd) {
    if (!ymd || typeof ymd !== 'string') return '';
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return ymd;
    return `${MONTHS[parseInt(m[2], 10) - 1] || ''} ${parseInt(m[3], 10)}`;
}

export default function PricingWorkspace({ language, isAdmin, storeLocation, staffName, masterCategories, onOpenImport }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [scanning, setScanning] = useState(false);
    const [reopen, setReopen] = useState(null);   // a saved scan doc to edit
    const [scans, setScans] = useState([]);
    const [confirmDel, setConfirmDel] = useState(null);

    useEffect(() => {
        if (!isAdmin || !storeLocation) return;
        return subscribeReceiptScans(storeLocation, setScans);
    }, [isAdmin, storeLocation]);

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
