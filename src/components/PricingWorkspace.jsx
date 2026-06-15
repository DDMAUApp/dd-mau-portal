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
import { useState } from 'react';
import { Camera, FileUp, Sparkles } from 'lucide-react';
import ReceiptScanModal from './ReceiptScanModal';

export default function PricingWorkspace({ language, isAdmin, storeLocation, staffName, masterCategories, onOpenImport }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [scanning, setScanning] = useState(false);

    if (!isAdmin) {
        return (
            <div className="rounded-2xl border border-dd-line bg-white p-6 text-center text-sm text-dd-text-2">
                {tx('Item pricing is managed by managers.', 'Los precios los administran los gerentes.')}
            </div>
        );
    }

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

            {/* Hint */}
            <div className="rounded-2xl border border-dashed border-dd-line bg-dd-bg/40 p-4 text-center">
                <div className="text-xs text-dd-text-2">
                    {tx('Prices you scan, import, or set show on items and in the cart (🏆 Best · ↩ Last ordered).', 'Los precios que escaneas, importas o fijas aparecen en los artículos y en el carrito (🏆 Mejor · ↩ Última compra).')}
                </div>
            </div>

            {scanning && (
                <ReceiptScanModal
                    location={storeLocation}
                    staffName={staffName}
                    language={language}
                    masterCategories={masterCategories}
                    onClose={() => setScanning(false)}
                />
            )}
        </div>
    );
}
