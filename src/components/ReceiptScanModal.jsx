// ReceiptScanModal — the MAIN feature of the new Pricing tab.
//
// Inventory pricing redesign Phase 2c. Flow:
//   capture  → take/choose a receipt photo
//   parsing  → parseReceipt Cloud Function reads it (clarity check + extract)
//   retake   → if the photo isn't legible, show why + let them retake
//   review   → each extracted line ↔ the matcher's best master-item guess;
//              admin confirms / re-picks / skips, can edit the price
//   save     → recordPurchase() writes trusted item_prices (source=invoice)
//              for every confirmed line → cart's 🏆 Best / ↩ Last fill in
//
// Also reusable by the file-import path: pass `initialExtraction`
// ({ vendor, date, lineItems }) to jump straight to the review screen.
import { useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Camera, X, Check, RefreshCw, Search } from 'lucide-react';
import { buildMasterIndex, matchItemByName } from '../data/itemMatch';
import { fileToScaledBase64, parseReceiptImage } from '../data/parseReceipt';
import { recordPurchase, perUnitPrice } from '../data/itemPricing';
import { toast } from '../toast';

export default function ReceiptScanModal({ location, staffName, language, masterCategories, initialExtraction, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const masterIndex = useMemo(() => buildMasterIndex(masterCategories), [masterCategories]);
    const masterById = useMemo(() => {
        const m = new Map();
        for (const cat of (masterCategories || [])) for (const it of (cat?.items || [])) m.set(it.id, it);
        return m;
    }, [masterCategories]);

    // rows: { name, qty, price, pack, masterId, confidence, included, pickerOpen, query }
    const buildRows = (lineItems) => (lineItems || []).map((li) => {
        const guess = matchItemByName(li.name, masterIndex);
        return {
            name: li.name || '',
            qty: li.qty ?? 1,
            price: li.price != null ? String(li.price) : '',
            pack: li.pack || '',
            masterId: guess?.id || null,
            confidence: guess?.confidence || null,
            included: true,
            pickerOpen: false,
            query: '',
        };
    });

    const [stage, setStage] = useState(initialExtraction ? 'review' : 'capture');
    const [vendor, setVendor] = useState(initialExtraction?.vendor || '');
    const [date, setDate] = useState(initialExtraction?.date || new Date().toISOString().slice(0, 10));
    const [rows, setRows] = useState(() => buildRows(initialExtraction?.lineItems));
    const [problems, setProblems] = useState([]);
    const [saving, setSaving] = useState(false);
    const fileRef = useRef(null);

    const handleFile = async (file) => {
        if (!file) return;
        setStage('parsing');
        setProblems([]);
        try {
            const { base64, mediaType } = await fileToScaledBase64(file);
            const result = await parseReceiptImage({ imageBase64: base64, mediaType });
            if (!result || result.readable !== true) {
                setProblems(result?.problems?.length ? result.problems
                    : [tx('Could not read the receipt clearly.', 'No se pudo leer el recibo con claridad.')]);
                setStage('retake');
                return;
            }
            setVendor(result.vendor || '');
            if (result.date) setDate(String(result.date).slice(0, 10));
            setRows(buildRows(result.lineItems));
            setStage('review');
        } catch (e) {
            console.error('[ReceiptScanModal] parse failed', e);
            // Graceful: the AI key may still be getting set up.
            setProblems([tx('Receipt reading is being set up — try again later, or use Import / Set price.', 'La lectura de recibos se está configurando — intenta más tarde, o usa Importar / Fijar precio.')]);
            setStage('retake');
        }
    };

    const setRow = (i, patch) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

    const pickerResults = (query) => {
        const q = query.trim().toLowerCase();
        if (!q) return masterIndex.slice(0, 8);
        return masterIndex.filter((m) => m.nameLower.includes(q)).slice(0, 8);
    };

    const confirmedCount = rows.filter((r) => r.included && r.masterId && r.price !== '' && isFinite(parseFloat(r.price))).length;

    const save = async () => {
        if (saving) return;
        setSaving(true);
        let saved = 0;
        try {
            for (const r of rows) {
                if (!r.included || !r.masterId) continue;
                const price = parseFloat(r.price);
                if (!isFinite(price) || price < 0) continue;
                await recordPurchase(location, r.masterId, {
                    vendor: vendor || 'Other',
                    price,
                    pack: r.pack || null,
                    by: staffName,
                    purchasedDate: date,
                    reason: 'receipt scan',
                });
                saved++;
            }
            toast(tx(`Saved ${saved} price${saved === 1 ? '' : 's'}.`, `${saved} precio${saved === 1 ? '' : 's'} guardado${saved === 1 ? '' : 's'}.`));
            onClose();
        } catch (e) {
            console.error('[ReceiptScanModal] save failed', e);
            toast(tx('Save failed — try again.', 'Error al guardar — intenta de nuevo.'));
            setSaving(false);
        }
    };

    return createPortal(
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
            <div className="bg-white w-full sm:max-w-2xl rounded-t-3xl sm:rounded-2xl shadow-xl max-h-[94vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
                    <div className="text-sm font-bold text-dd-text flex items-center gap-2">
                        <Camera size={16} className="text-dd-green" aria-hidden="true" />
                        {tx('Scan receipt', 'Escanear recibo')}
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1"><X size={20} /></button>
                </div>

                {/* CAPTURE */}
                {stage === 'capture' && (
                    <div className="p-6 text-center space-y-4">
                        <p className="text-sm text-dd-text-2">{tx('Take a clear, straight-on photo of the whole receipt — make sure the item names and prices are readable.', 'Toma una foto clara y de frente de todo el recibo — asegúrate de que los nombres y precios se lean bien.')}</p>
                        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
                            onChange={(e) => handleFile(e.target.files?.[0])} />
                        <button onClick={() => fileRef.current?.click()}
                            className="w-full py-3 rounded-2xl bg-dd-green text-white font-bold flex items-center justify-center gap-2">
                            <Camera size={18} /> {tx('Take / choose photo', 'Tomar / elegir foto')}
                        </button>
                    </div>
                )}

                {/* PARSING */}
                {stage === 'parsing' && (
                    <div className="p-10 text-center space-y-3">
                        <RefreshCw size={28} className="mx-auto text-dd-green animate-spin" aria-hidden="true" />
                        <div className="text-sm font-semibold text-dd-text-2">{tx('Reading the receipt…', 'Leyendo el recibo…')}</div>
                    </div>
                )}

                {/* RETAKE (clarity fail / error) */}
                {stage === 'retake' && (
                    <div className="p-6 space-y-4">
                        <div className="rounded-xl bg-amber-50 border border-amber-200 p-3">
                            <div className="text-sm font-bold text-amber-800">{tx("Couldn't read it clearly", 'No se pudo leer bien')}</div>
                            <ul className="mt-1 text-xs text-amber-800 list-disc pl-4 space-y-0.5">
                                {problems.map((p, i) => <li key={i}>{p}</li>)}
                            </ul>
                        </div>
                        <button onClick={() => setStage('capture')}
                            className="w-full py-3 rounded-2xl bg-dd-green text-white font-bold flex items-center justify-center gap-2">
                            <Camera size={18} /> {tx('Retake photo', 'Tomar otra foto')}
                        </button>
                    </div>
                )}

                {/* REVIEW / MATCH */}
                {stage === 'review' && (
                    <>
                        <div className="px-4 py-2 border-b border-gray-100 flex gap-2 items-center shrink-0">
                            <label className="text-xs font-semibold text-gray-600">{tx('Vendor', 'Proveedor')}</label>
                            <input value={vendor} onChange={(e) => setVendor(e.target.value)}
                                className="flex-1 text-sm rounded-lg border border-gray-300 px-2 py-1" placeholder={tx('e.g. Sysco', 'ej. Sysco')} />
                            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                                className="text-sm rounded-lg border border-gray-300 px-2 py-1" />
                        </div>

                        <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
                            {rows.length === 0 && (
                                <div className="p-6 text-center text-sm text-dd-text-2">{tx('No line items found.', 'No se encontraron artículos.')}</div>
                            )}
                            {rows.map((r, i) => {
                                const matched = r.masterId ? masterById.get(r.masterId) : null;
                                const pu = perUnitPrice(parseFloat(r.price), r.pack);
                                return (
                                    <div key={i} className={`p-3 ${r.included ? '' : 'opacity-40'}`}>
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="text-sm font-semibold text-dd-text truncate">{r.name}</div>
                                                <div className="text-[11px] text-dd-text-2">{tx('qty', 'cant')} {r.qty}{r.pack ? ` · ${r.pack}` : ''}</div>
                                            </div>
                                            <label className="flex items-center gap-1 text-[11px] text-gray-500 shrink-0">
                                                <input type="checkbox" checked={r.included} onChange={(e) => setRow(i, { included: e.target.checked })} />
                                                {tx('include', 'incluir')}
                                            </label>
                                        </div>

                                        {/* match → master */}
                                        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                                            <span className="text-[11px] text-gray-400">→</span>
                                            {matched ? (
                                                <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${r.confidence === 'low' ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'}`}>
                                                    {matched.name}{r.confidence === 'low' ? ' ?' : ''}
                                                </span>
                                            ) : (
                                                <span className="text-xs font-bold px-1.5 py-0.5 rounded border bg-red-50 text-red-700 border-red-200">{tx('unmatched', 'sin emparejar')}</span>
                                            )}
                                            <button onClick={() => setRow(i, { pickerOpen: !r.pickerOpen, query: '' })}
                                                className="text-[11px] text-dd-green-700 underline">
                                                {matched ? tx('change', 'cambiar') : tx('pick', 'elegir')}
                                            </button>
                                            <span className="ml-auto flex items-center gap-1">
                                                <span className="text-[11px] text-gray-400">$</span>
                                                <input value={r.price} onChange={(e) => setRow(i, { price: e.target.value })}
                                                    inputMode="decimal" className="w-16 text-sm rounded border border-gray-300 px-1 py-0.5 text-right" placeholder="0.00" />
                                                {pu && <span className="text-[10px] text-dd-green-700">${pu.perUnit.toFixed(2)}/{pu.unit}</span>}
                                            </span>
                                        </div>

                                        {/* inline picker */}
                                        {r.pickerOpen && (
                                            <div className="mt-2 rounded-lg border border-gray-200 p-2 bg-gray-50">
                                                <div className="flex items-center gap-1 mb-1">
                                                    <Search size={12} className="text-gray-400" />
                                                    <input autoFocus value={r.query} onChange={(e) => setRow(i, { query: e.target.value })}
                                                        className="flex-1 text-sm bg-transparent outline-none" placeholder={tx('search master items…', 'buscar artículos…')} />
                                                </div>
                                                <div className="max-h-40 overflow-y-auto">
                                                    {pickerResults(r.query).map((m) => (
                                                        <button key={m.id} onClick={() => setRow(i, { masterId: m.id, confidence: 'high', pickerOpen: false })}
                                                            className="block w-full text-left text-xs px-2 py-1 hover:bg-white rounded">
                                                            {m.name}
                                                        </button>
                                                    ))}
                                                    <button onClick={() => setRow(i, { masterId: null, confidence: null, pickerOpen: false })}
                                                        className="block w-full text-left text-xs px-2 py-1 text-red-600 hover:bg-white rounded">
                                                        {tx('— leave unmatched —', '— dejar sin emparejar —')}
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {/* Footer */}
                        <div className="px-4 py-3 border-t border-gray-100 flex items-center gap-2 shrink-0">
                            <div className="text-xs text-dd-text-2">{tx(`${confirmedCount} ready to save`, `${confirmedCount} listos`)}</div>
                            <button onClick={save} disabled={saving || confirmedCount === 0}
                                className="ml-auto px-4 py-2 rounded-xl bg-dd-green text-white font-bold text-sm disabled:opacity-50 flex items-center gap-1">
                                <Check size={16} /> {saving ? tx('Saving…', 'Guardando…') : tx('Save prices', 'Guardar precios')}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>,
        document.body
    );
}
