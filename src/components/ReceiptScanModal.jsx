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
import { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Camera, X, Check, RefreshCw, Search, ArrowLeft } from 'lucide-react';
import { buildMasterIndex, matchItemByName } from '../data/itemMatch';
import { fileToScaledBase64, parseReceiptImage } from '../data/parseReceipt';
import { recordPurchase, perUnitPrice } from '../data/itemPricing';
import { saveReceiptScan, updateReceiptScan } from '../data/receiptScans';
import { lookupAlias, learnAliases } from '../data/itemAliases';
import { toast } from '../toast';

export default function ReceiptScanModal({ location, staffName, language, masterCategories, aliasMap, initialExtraction, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const masterIndex = useMemo(() => buildMasterIndex(masterCategories), [masterCategories]);
    const masterById = useMemo(() => {
        const m = new Map();
        for (const cat of (masterCategories || [])) for (const it of (cat?.items || [])) m.set(it.id, it);
        return m;
    }, [masterCategories]);

    // Latest learned-alias map in a ref so buildRows (called async after the
    // AI parse) always sees the current memory without re-creating the fn.
    const aliasRef = useRef(aliasMap || {});
    aliasRef.current = aliasMap || {};

    // rows: { name, qty, price, pack, masterId, confidence, learned, included, pickerOpen, query }
    // Match priority for a fresh AI extraction:
    //   1) a SAVED match on the line (re-opening a past scan) — trust verbatim,
    //      the manager may have hand-corrected it;
    //   2) a LEARNED alias — a name we matched on a previous scan; remembered;
    //   3) the fuzzy matcher's best guess.
    const buildRows = (lineItems) => (Array.isArray(lineItems) ? lineItems : []).map((li) => {
        const hasSavedMatch = Object.prototype.hasOwnProperty.call(li || {}, 'masterId');
        let masterId = null, confidence = null, learned = false;
        if (hasSavedMatch) {
            masterId = li.masterId || null;
            confidence = li.confidence || null;
        } else {
            const alias = lookupAlias(aliasRef.current, li.name);
            if (alias && alias.masterId && masterById.has(alias.masterId)) {
                masterId = alias.masterId;
                confidence = 'high';
                learned = true;          // remembered from a past scan
            } else {
                const guess = matchItemByName(li.name, masterIndex);
                masterId = guess?.id || null;
                confidence = guess?.confidence || null;
            }
        }
        return {
            name: li.name || '',
            qty: li.qty ?? 1,
            price: li.price != null ? String(li.price) : '',
            pack: li.pack || '',
            code: li.code || '',     // vendor SKU / item # (from the invoice)
            brand: li.brand || '',   // brand / manufacturer (from the invoice)
            masterId,
            confidence,
            learned,
            included: li.included != null ? li.included : true,
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
    // Re-opening a past scan from history carries its id so re-saving updates
    // the SAME record instead of creating a duplicate.
    const [scanId, setScanId] = useState(initialExtraction?.scanId || null);
    const scanSource = initialExtraction?.source || 'receipt';
    // After a successful save we show a summary of exactly what landed.
    const [savedSummary, setSavedSummary] = useState(null);
    const fileRef = useRef(null);

    // 2026-06-20 (QA audit L1) — keep an object-URL preview of the captured
    // receipt. The file was base64'd, sent to the AI, then discarded with no
    // preview anywhere — so on "retake" the manager couldn't see what was
    // captured, and on "review" couldn't cross-check a misread price against
    // the source image. Revoke the prior URL on replace + on unmount.
    const [previewUrl, setPreviewUrl] = useState(null);
    const previewUrlRef = useRef(null);
    const setPreview = (file) => {
        try { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); } catch {}
        const url = file ? URL.createObjectURL(file) : null;
        previewUrlRef.current = url;
        setPreviewUrl(url);
    };
    useEffect(() => () => { try { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); } catch {} }, []);

    const handleFile = async (file) => {
        if (!file) return;
        setPreview(file);
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

    // Parse a price string tolerant of "$", thousands commas and stray
    // spaces. A manager pasting "$1,234.56" must NOT persist as $1.00 (bare
    // parseFloat stops at the comma) nor get silently dropped
    // (parseFloat("$12") === NaN). US format; ambiguous EU "1.234,56" falls
    // through to parseFloat — still no worse than before.
    const parsePrice = (v) => parseFloat(String(v ?? '').replace(/[$\s]/g, '').replace(/,(?=\d{3}\b)/g, ''));

    // Mirror the save() guard exactly (incl. price >= 0) so the footer count
    // never promises a row that save() will silently skip.
    const confirmedCount = rows.filter((r) => r.included && r.masterId && r.price !== '' && isFinite(parsePrice(r.price)) && parsePrice(r.price) >= 0).length;

    // Snapshot EVERY row (matched or not, included or not) so a re-opened
    // scan shows the whole receipt — including lines still to be matched.
    // masterName is snapshotted so history reads even if the master list
    // later changes.
    const snapshotLines = () => rows.map((r) => {
        const price = parsePrice(r.price);
        const qn = Number(r.qty);
        const master = r.masterId ? masterById.get(r.masterId) : null;
        return {
            name: r.name || '',
            qty: (isFinite(qn) && qn >= 0 && qn < 100000) ? qn : null,
            price: isFinite(price) ? price : null,
            pack: r.pack || null,
            code: r.code || null,
            brand: r.brand || null,
            masterId: r.masterId || null,
            masterName: master?.name || null,
            confidence: r.confidence || null,
            included: !!r.included,
        };
    });

    const save = async () => {
        if (saving) return;
        setSaving(true);
        const landed = [];
        try {
            for (const r of rows) {
                if (!r.included || !r.masterId) continue;
                const price = parsePrice(r.price);
                if (!isFinite(price) || price < 0) continue;
                await recordPurchase(location, r.masterId, {
                    vendor: vendor || 'Other',
                    price,
                    pack: r.pack || null,
                    code: r.code || null,
                    brand: r.brand || null,
                    qty: isFinite(Number(r.qty)) ? Number(r.qty) : null,
                    by: staffName,
                    purchasedDate: date,
                    reason: scanSource === 'import' ? 'price import' : 'receipt scan',
                });
                const pu = perUnitPrice(price, r.pack);
                landed.push({
                    name: masterById.get(r.masterId)?.name || r.name,
                    price, perUnit: pu?.perUnit ?? null, unit: pu?.unit || null,
                });
            }
            // Persist the scan record (create new, or update the re-opened one).
            const lines = snapshotLines();
            const payload = { vendor: vendor || '', date, savedCount: landed.length, lines };
            try {
                if (scanId) {
                    await updateReceiptScan(location, scanId, payload);
                } else {
                    const id = await saveReceiptScan(
                        location,
                        { ...payload, scannedBy: staffName, source: scanSource },
                        Date.now(),
                    );
                    setScanId(id);
                }
            } catch (histErr) {
                // History is a convenience; the prices already saved. Don't
                // fail the whole save just because the record didn't persist.
                console.error('[ReceiptScanModal] scan-record save failed', histErr);
            }
            // Remember every confirmed match (even ones with a blank price) so
            // the next scan auto-applies them — this is the "it didn't remember
            // CHI MEI GWA BUN is bao" fix. Best-effort; never blocks the save.
            try {
                const learnedEntries = rows
                    // 2026-06-16 (#4): only learn matches the manager actually
                    // confirmed. A low-confidence FUZZY guess is included by
                    // default but unverified — learning it poisons future scans.
                    // Picking/changing a row sets confidence 'high', and a
                    // remembered alias reads back as 'high', so only untouched
                    // low-confidence guesses are excluded here.
                    .filter((r) => r.included && r.masterId && r.name && r.confidence !== 'low')
                    .map((r) => ({
                        rawName: r.name,
                        masterId: r.masterId,
                        masterName: masterById.get(r.masterId)?.name || null,
                        vendor: vendor || null,
                    }));
                await learnAliases(location, learnedEntries, staffName);
            } catch (aliasErr) {
                console.error('[ReceiptScanModal] learnAliases failed', aliasErr);
            }
            toast(tx(`Saved ${landed.length} price${landed.length === 1 ? '' : 's'}.`, `${landed.length} precio${landed.length === 1 ? '' : 's'} guardado${landed.length === 1 ? '' : 's'}.`));
            setSavedSummary({ count: landed.length, landed, unmatched: rows.filter((r) => r.included && !r.masterId).length });
            setStage('saved');
            setSaving(false);
        } catch (e) {
            console.error('[ReceiptScanModal] save failed', e);
            toast(tx('Save failed — try again.', 'Error al guardar — intenta de nuevo.'));
            setSaving(false);
        }
    };

    return createPortal(
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => { if (!saving) onClose(); }}>
            <div className="bg-white w-full sm:max-w-2xl rounded-t-3xl sm:rounded-2xl shadow-xl max-h-[94vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
                    <div className="text-sm font-bold text-dd-text flex items-center gap-2">
                        <Camera size={16} className="text-dd-green" aria-hidden="true" />
                        {tx('Scan receipt', 'Escanear recibo')}
                    </div>
                    <button onClick={() => { if (!saving) onClose(); }} className="text-gray-400 hover:text-gray-700 p-1"><X size={20} /></button>
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
                        {previewUrl && (
                            <img src={previewUrl} alt={tx('Captured receipt', 'Recibo capturado')}
                                className="w-full max-h-56 object-contain rounded-xl border border-gray-200 bg-gray-50" />
                        )}
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
                            {previewUrl && (
                                <div className="p-3">
                                    <img src={previewUrl} alt={tx('Captured receipt', 'Recibo capturado')}
                                        className="w-full max-h-48 object-contain rounded-xl border border-gray-200 bg-gray-50" />
                                </div>
                            )}
                            {rows.length === 0 && (
                                <div className="p-6 text-center text-sm text-dd-text-2">{tx('No line items found.', 'No se encontraron artículos.')}</div>
                            )}
                            {rows.map((r, i) => {
                                const matched = r.masterId ? masterById.get(r.masterId) : null;
                                const pu = perUnitPrice(parsePrice(r.price), r.pack);
                                return (
                                    <div key={i} className={`p-3 ${r.included ? '' : 'opacity-40'}`}>
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="text-sm font-semibold text-dd-text truncate">{r.name}</div>
                                                <div className="text-[11px] text-dd-text-2 flex items-center gap-1 mt-0.5">
                                                    <span>{tx('qty', 'cant')}</span>
                                                    <input value={r.qty} onChange={(e) => setRow(i, { qty: e.target.value })}
                                                        inputMode="decimal" className="w-12 text-center rounded border border-gray-300 px-1 py-0.5"
                                                        aria-label={tx('quantity ordered', 'cantidad pedida')} />
                                                    {r.pack ? <span>· {r.pack}</span> : null}
                                                </div>
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
                                            {matched && r.learned && (
                                                <span className="text-[10px] font-semibold text-emerald-600" title={tx('Remembered from a past scan', 'Recordado de un escaneo anterior')}>
                                                    ✓ {tx('remembered', 'recordado')}
                                                </span>
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
                                                        <button key={m.id} onClick={() => setRow(i, { masterId: m.id, confidence: 'high', learned: false, pickerOpen: false })}
                                                            className="block w-full text-left text-xs px-2 py-1 hover:bg-white rounded">
                                                            {m.name}
                                                        </button>
                                                    ))}
                                                    <button onClick={() => setRow(i, { masterId: null, confidence: null, learned: false, pickerOpen: false })}
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

                {/* SAVED — summary of exactly what landed */}
                {stage === 'saved' && savedSummary && (
                    <>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3">
                            <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 text-center">
                                <div className="w-10 h-10 rounded-full bg-emerald-500 text-white flex items-center justify-center mx-auto mb-2">
                                    <Check size={22} strokeWidth={2.5} />
                                </div>
                                <div className="text-sm font-bold text-emerald-900">
                                    {tx(`Saved ${savedSummary.count} price${savedSummary.count === 1 ? '' : 's'}`, `${savedSummary.count} precio${savedSummary.count === 1 ? '' : 's'} guardado${savedSummary.count === 1 ? '' : 's'}`)}
                                </div>
                                <div className="text-[11px] text-emerald-800 mt-0.5">
                                    {tx(`from ${vendor || 'this receipt'}${date ? ` · ${date}` : ''}`, `de ${vendor || 'este recibo'}${date ? ` · ${date}` : ''}`)}
                                </div>
                            </div>

                            <div className="rounded-xl border border-gray-100 divide-y divide-gray-100">
                                {savedSummary.landed.map((l, i) => (
                                    <div key={i} className="flex items-center gap-2 px-3 py-2">
                                        <Check size={13} className="text-emerald-600 shrink-0" />
                                        <div className="text-sm font-semibold text-dd-text truncate flex-1">{l.name}</div>
                                        <div className="text-xs text-dd-text-2 text-right shrink-0">
                                            ${l.price.toFixed(2)}
                                            {l.perUnit != null && <span className="text-emerald-700"> · ${l.perUnit.toFixed(2)}/{l.unit}</span>}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {savedSummary.unmatched > 0 && (
                                <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
                                    {tx(`${savedSummary.unmatched} item${savedSummary.unmatched === 1 ? '' : 's'} weren't matched, so they weren't saved. Tap "Edit matches" to match them.`, `${savedSummary.unmatched} artículo${savedSummary.unmatched === 1 ? '' : 's'} sin emparejar — no se guardaron. Toca "Editar" para emparejarlos.`)}
                                </div>
                            )}

                            <div className="text-[11px] text-dd-text-2 text-center px-2">
                                {tx('These now show on the items and in the cart (🏆 Best · ↩ Last ordered). You can re-open this scan anytime from "Recent scans".', 'Ahora aparecen en los artículos y en el carrito (🏆 Mejor · ↩ Última compra). Puedes reabrir este escaneo desde "Escaneos recientes".')}
                            </div>
                        </div>

                        <div className="px-4 py-3 border-t border-gray-100 flex items-center gap-2 shrink-0">
                            <button onClick={() => setStage('review')}
                                className="px-3 py-2 rounded-xl border border-gray-300 text-dd-text font-semibold text-sm flex items-center gap-1">
                                <ArrowLeft size={15} /> {tx('Edit matches', 'Editar')}
                            </button>
                            <button onClick={onClose}
                                className="ml-auto px-5 py-2 rounded-xl bg-dd-green text-white font-bold text-sm">
                                {tx('Done', 'Listo')}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>,
        document.body
    );
}
