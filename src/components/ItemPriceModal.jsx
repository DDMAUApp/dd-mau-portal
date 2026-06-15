// ItemPriceModal — admin-only "set the trusted price" editor for an
// inventory item. Inventory pricing redesign, Phase 1 / slice 2.
//
// Writes a MANUAL price (the top of the trust order) to the new
// item_prices_{location} collection via setManualPrice(). Shows a live
// per-unit preview, the item's current resolved trusted price + source,
// and recent price history. Admin gating is enforced by the caller (the
// app has no Firebase Auth, so admin-only is client-side, same as every
// other admin feature here).
import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { INVENTORY_VENDORS } from '../data/inventory';
import {
    setManualPrice, perUnitPrice, resolveTrustedPrice, PRICE_SOURCE_LABEL,
} from '../data/itemPricing';

export default function ItemPriceModal({ item, location, staffName, language, priceDoc, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [price, setPrice] = useState(() => {
        const p = priceDoc?.manual?.price;
        return p != null ? String(p) : '';
    });
    const [pack, setPack] = useState(priceDoc?.manual?.pack || item?.pack || '');
    const [vendor, setVendor] = useState(priceDoc?.manual?.vendor || item?.preferredVendor || item?.vendor || '');
    const [note, setNote] = useState(priceDoc?.manual?.note || '');
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState('');

    // Live per-unit preview as the admin types.
    const preview = useMemo(() => {
        const n = parseFloat(price);
        if (!isFinite(n)) return null;
        return perUnitPrice(n, pack);
    }, [price, pack]);

    const trusted = useMemo(() => resolveTrustedPrice(priceDoc), [priceDoc]);
    const history = (priceDoc?.history || []).slice(-6).reverse();

    const save = async () => {
        const n = parseFloat(price);
        if (!isFinite(n) || n < 0) { setErr(tx('Enter a valid price.', 'Ingresa un precio válido.')); return; }
        setSaving(true);
        setErr('');
        try {
            await setManualPrice(location, item.id, {
                price: n,
                pack: pack.trim() || null,
                vendor: vendor.trim() || null,
                note: note.trim() || null,
            }, staffName);
            onClose();
        } catch (e) {
            console.error('[ItemPriceModal] save failed', e);
            setErr(tx('Save failed — try again.', 'Error al guardar — intenta de nuevo.'));
            setSaving(false);
        }
    };

    const name = isEs && item?.nameEs ? item.nameEs : item?.name;

    return createPortal(
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
            onClick={onClose}>
            <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-xl max-h-[92vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between">
                    <div className="min-w-0">
                        <div className="text-[11px] font-bold uppercase tracking-wide text-dd-green-700">{tx('Set price', 'Fijar precio')}</div>
                        <div className="text-sm font-bold text-gray-900 truncate">{name}</div>
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none px-2">&times;</button>
                </div>

                <div className="p-4 space-y-4">
                    {/* Current trusted price */}
                    {trusted && (
                        <div className="rounded-xl bg-gray-50 border border-gray-200 p-2.5 text-xs text-gray-700">
                            {tx('Current', 'Actual')}: <b>${Number(trusted.price).toFixed(2)}</b>
                            {trusted.perUnit != null && <> (${trusted.perUnit.toFixed(2)}/{trusted.unit})</>}
                            {' · '}{(PRICE_SOURCE_LABEL[trusted.source] || {})[isEs ? 'es' : 'en'] || trusted.source}
                            {trusted.stale && <span className="ml-1 text-amber-700 font-bold">· {tx('stale', 'viejo')} ⚠</span>}
                        </div>
                    )}

                    {/* Price + pack */}
                    <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                            <span className="text-xs font-semibold text-gray-600">{tx('Price ($)', 'Precio ($)')}</span>
                            <input type="number" inputMode="decimal" step="0.01" min="0" value={price}
                                onChange={(e) => setPrice(e.target.value)} autoFocus
                                className="mt-1 w-full text-base rounded-xl border border-gray-300 px-3 py-2 focus:border-dd-green focus:ring-1 focus:ring-dd-green outline-none"
                                placeholder="0.00" />
                        </label>
                        <label className="block">
                            <span className="text-xs font-semibold text-gray-600">{tx('Pack / size', 'Paquete / tamaño')}</span>
                            <input type="text" value={pack} onChange={(e) => setPack(e.target.value)}
                                className="mt-1 w-full text-base rounded-xl border border-gray-300 px-3 py-2 focus:border-dd-green focus:ring-1 focus:ring-dd-green outline-none"
                                placeholder="4/2.5LB" />
                        </label>
                    </div>

                    {/* Per-unit preview / missing-pack warning */}
                    {price !== '' && (
                        preview
                            ? <div className="text-xs text-dd-green-700 font-semibold">= ${preview.perUnit.toFixed(2)}/{preview.unit} ({tx('per-unit', 'por unidad')})</div>
                            : <div className="text-xs text-amber-700">⚠ {tx("Can't compute per-unit — add a pack like \"4/2.5LB\" or \"5gal\" so prices compare fairly.", 'No se puede calcular por unidad — agrega un paquete como "4/2.5LB" o "5gal" para comparar precios.')}</div>
                    )}

                    {/* Vendor */}
                    <label className="block">
                        <span className="text-xs font-semibold text-gray-600">{tx('Vendor', 'Proveedor')}</span>
                        <input type="text" list="ddmau-vendor-list" value={vendor} onChange={(e) => setVendor(e.target.value)}
                            className="mt-1 w-full text-base rounded-xl border border-gray-300 px-3 py-2 focus:border-dd-green focus:ring-1 focus:ring-dd-green outline-none"
                            placeholder={tx('e.g. Restaurant Depot', 'ej. Restaurant Depot')} />
                        <datalist id="ddmau-vendor-list">
                            {(INVENTORY_VENDORS || []).map((v) => <option key={v} value={v} />)}
                        </datalist>
                    </label>

                    {/* Note */}
                    <label className="block">
                        <span className="text-xs font-semibold text-gray-600">{tx('Note (optional)', 'Nota (opcional)')}</span>
                        <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
                            className="mt-1 w-full text-base rounded-xl border border-gray-300 px-3 py-2 focus:border-dd-green focus:ring-1 focus:ring-dd-green outline-none"
                            placeholder={tx('e.g. case price, confirmed 6/12', 'ej. precio por caja, confirmado 6/12')} />
                    </label>

                    {err && <div className="text-xs text-red-600 font-semibold">{err}</div>}

                    {/* Recent history */}
                    {history.length > 0 && (
                        <div className="rounded-xl border border-gray-200 p-2.5">
                            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{tx('Recent changes', 'Cambios recientes')}</div>
                            <ul className="space-y-0.5 text-[11px] text-gray-600">
                                {history.map((h, i) => (
                                    <li key={i} className="flex justify-between gap-2">
                                        <span>{h.oldPrice != null ? `$${Number(h.oldPrice).toFixed(2)} → ` : ''}<b>${Number(h.newPrice).toFixed(2)}</b> · {(PRICE_SOURCE_LABEL[h.source] || {})[isEs ? 'es' : 'en'] || h.source}</span>
                                        <span className="text-gray-400 shrink-0">{h.by || ''} {h.at ? String(h.at).slice(0, 10) : ''}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="sticky bottom-0 bg-white border-t border-gray-100 px-4 py-3 flex gap-2">
                    <button onClick={onClose} disabled={saving}
                        className="flex-1 py-2.5 rounded-xl border border-gray-300 text-gray-700 font-semibold text-sm">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={save} disabled={saving}
                        className="flex-1 py-2.5 rounded-xl bg-dd-green text-white font-bold text-sm disabled:opacity-60">
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save price', 'Guardar')}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
