// HitZoneEditor — admin maps menu-image rectangles to MENU_DATA items
// so MenuDisplay can overlay SOLD OUT stickers when those items are 86'd.
//
// Andrew 2026-05-20: "Image + overlay 'SOLD OUT' stickers on items".
// The menu image stays untouched; the overlays go on TOP. Coordinates
// are stored as fractions of the natural image dimensions so they
// work at any TV resolution.
//
// ─── UX ──────────────────────────────────────────────────────
//   1. Modal shows the menu image (large, fit to modal).
//   2. Admin click-drags a rectangle on the image, or single-clicks
//      to drop a default-size box at that location.
//   3. Item-picker popover opens — admin selects which MENU_DATA item
//      that rectangle represents. (Searchable; grouped by category.)
//   4. Save adds it to the zones list. Existing zones show as dashed
//      outlines on the image — click one to edit / delete.
//   5. Multi-page menus: page tabs at top to switch between PDF pages.

import { useEffect, useMemo, useRef, useState } from 'react';
import { MENU_DATA } from '../data/menu';
import { bakePriceOverlaysIntoImage } from '../data/menuImageUpload';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

// Default hit zone size when admin single-clicks (fraction of image):
// 14% wide × 4% tall — close to a typical menu item row.
const DEFAULT_ZONE_W = 0.14;
const DEFAULT_ZONE_H = 0.04;

// Minimum drag distance (in pixels) to count as a drag vs a click.
const DRAG_THRESHOLD_PX = 6;

export default function HitZoneEditor({
    imageUrls = [],
    initialZones = [],
    onSave,
    onClose,
    language = 'en',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [page, setPage] = useState(0);
    const [zones, setZones] = useState(initialZones);
    const [pickerForZoneIdx, setPickerForZoneIdx] = useState(null);
    const [pickerFilter, setPickerFilter] = useState('');
    const [baking, setBaking] = useState(false);
    const [bakeProgress, setBakeProgress] = useState('');

    // Live drag state — only set during a mouse-down → up sequence.
    const [dragStart, setDragStart] = useState(null);   // { x, y } in fractions
    const [dragEnd, setDragEnd] = useState(null);
    const imageRef = useRef(null);
    const containerRef = useRef(null);

    // Flat list of MENU_DATA items for the picker, grouped by category.
    const menuItemOptions = useMemo(() => {
        const out = [];
        for (const cat of MENU_DATA) {
            for (const item of (cat.items || [])) {
                out.push({
                    category: cat.category,
                    nameEn: item.nameEn,
                    label: `${cat.category} — ${item.nameEn}`,
                });
            }
        }
        return out;
    }, []);

    const filteredOptions = useMemo(() => {
        const q = pickerFilter.trim().toLowerCase();
        if (!q) return menuItemOptions;
        return menuItemOptions.filter(o =>
            o.label.toLowerCase().includes(q));
    }, [pickerFilter, menuItemOptions]);

    const pageZones = zones.filter(z => (z.page ?? 0) === page);

    // ── Mouse handlers ─────────────────────────────────────────
    const fracFromEvent = (e) => {
        const rect = imageRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return null;
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        return {
            x: Math.max(0, Math.min(1, cx / rect.width)),
            y: Math.max(0, Math.min(1, cy / rect.height)),
        };
    };

    const onMouseDown = (e) => {
        // Ignore clicks that started on an existing-zone overlay (let
        // their own onClick handler delete / edit them).
        if (e.target.dataset?.zone === 'true') return;
        const f = fracFromEvent(e);
        if (!f) return;
        setDragStart(f);
        setDragEnd(f);
    };

    const onMouseMove = (e) => {
        if (!dragStart) return;
        const f = fracFromEvent(e);
        if (f) setDragEnd(f);
    };

    const onMouseUp = (e) => {
        if (!dragStart || !dragEnd) {
            setDragStart(null);
            setDragEnd(null);
            return;
        }
        // Compute the rectangle. If drag distance < threshold, treat
        // as a click and drop a default-sized box centered on the
        // click point.
        const rect = imageRef.current?.getBoundingClientRect();
        const pxDist = rect
            ? Math.hypot((dragEnd.x - dragStart.x) * rect.width, (dragEnd.y - dragStart.y) * rect.height)
            : 0;
        let x, y, width, height;
        if (pxDist < DRAG_THRESHOLD_PX) {
            // Single-click → default-sized centered box.
            width = DEFAULT_ZONE_W;
            height = DEFAULT_ZONE_H;
            x = Math.max(0, Math.min(1 - width, dragStart.x - width / 2));
            y = Math.max(0, Math.min(1 - height, dragStart.y - height / 2));
        } else {
            x = Math.min(dragStart.x, dragEnd.x);
            y = Math.min(dragStart.y, dragEnd.y);
            width = Math.abs(dragEnd.x - dragStart.x);
            height = Math.abs(dragEnd.y - dragStart.y);
            // Floor a min size to avoid invisible zones from a tiny drag
            width = Math.max(0.04, width);
            height = Math.max(0.025, height);
        }
        const newZone = {
            page,
            x: Number(x.toFixed(4)),
            y: Number(y.toFixed(4)),
            width: Number(width.toFixed(4)),
            height: Number(height.toFixed(4)),
            itemName: '',
            category: '',
        };
        setZones(prev => {
            const next = [...prev, newZone];
            // Open the picker for the new zone immediately.
            setPickerForZoneIdx(next.length - 1);
            setPickerFilter('');
            return next;
        });
        setDragStart(null);
        setDragEnd(null);
    };

    // Cancel a half-started drag if the mouse leaves the image area.
    const onMouseLeave = () => {
        if (dragStart) {
            setDragStart(null);
            setDragEnd(null);
        }
    };

    // ── Zone CRUD ──────────────────────────────────────────────
    const setZoneItem = (idx, item) => {
        setZones(prev => prev.map((z, i) =>
            i === idx ? { ...z, itemName: item.nameEn, category: item.category } : z));
        setPickerForZoneIdx(null);
        setPickerFilter('');
    };

    const setZonePrice = (idx, priceOverride) => {
        setZones(prev => prev.map((z, i) =>
            i === idx ? { ...z, priceOverride: priceOverride || '' } : z));
    };

    const setZoneQrUrl = (idx, qrUrl) => {
        setZones(prev => prev.map((z, i) =>
            i === idx ? { ...z, qrUrl: (qrUrl || '').trim() } : z));
    };

    const deleteZone = (idx) => {
        setZones(prev => prev.filter((_, i) => i !== idx));
        if (pickerForZoneIdx === idx) setPickerForZoneIdx(null);
    };

    // ── Save ───────────────────────────────────────────────────
    // If any zones have priceOverride, we BAKE those overlays into
    // the menu image before saving — so the new prices become part
    // of the image data and can't accidentally revert. Andrew's
    // concern: "with the pricing i need that to change the pdf at
    // its core so it can[t] accidentally revert back to the old
    // pricing".
    //
    // For each page that has price overrides:
    //   1. Render the current image + overlays to a new PNG.
    //   2. Upload the PNG to Storage.
    //   3. Replace imageUrls[page] with the new URL.
    //   4. Clear priceOverride on those zones (the image now IS
    //      the new price; no overlay needed at runtime).
    // Zones themselves stay — needed for SOLD OUT support.
    const save = async () => {
        // Drop any orphan zones with no itemName.
        const cleaned = zones.filter(z => z.itemName);
        const orphans = zones.length - cleaned.length;
        if (orphans > 0) {
            const ok = window.confirm(tx(
                `${orphans} zone(s) have no item picked yet — drop them?`,
                `${orphans} zona(s) sin item — ¿descartar?`,
            ));
            if (!ok) return;
        }

        // Plan: which pages need re-baking? Group zones by page.
        const pagesWithPrices = new Set();
        for (const z of cleaned) {
            if (z.priceOverride && String(z.priceOverride).trim()) {
                pagesWithPrices.add(z.page ?? 0);
            }
        }

        if (pagesWithPrices.size > 0) {
            const ok = window.confirm(tx(
                `You changed ${[...cleaned].filter(z => z.priceOverride).length} price(s). The new prices will be permanently rendered into the menu image — even if a hit zone gets deleted later, the new price stays. Continue?`,
                `Cambiaste precios. Los nuevos precios se renderizarán permanentemente en la imagen del menú. ¿Continuar?`,
            ));
            if (!ok) return;
            setBaking(true);
        }

        let updatedUrls = [...imageUrls];
        let updatedZones = cleaned;
        try {
            for (const pageIdx of pagesWithPrices) {
                const url = updatedUrls[pageIdx];
                if (!url) continue;
                const zonesForPage = updatedZones.filter(z =>
                    (z.page ?? 0) === pageIdx && z.priceOverride);
                if (zonesForPage.length === 0) continue;
                setBakeProgress(tx(
                    `Baking page ${pageIdx + 1}…`,
                    `Generando página ${pageIdx + 1}…`,
                ));
                const newUrl = await bakePriceOverlaysIntoImage({
                    imageUrl: url,
                    priceZones: zonesForPage,
                    slugPrefix: `page${pageIdx + 1}`,
                });
                updatedUrls[pageIdx] = newUrl;
                // Clear priceOverride on zones we just baked.
                updatedZones = updatedZones.map(z => {
                    if ((z.page ?? 0) === pageIdx && z.priceOverride) {
                        const { priceOverride, ...rest } = z;
                        return rest;
                    }
                    return z;
                });
            }
            onSave({ zones: updatedZones, imageUrls: updatedUrls });
            toast(tx(
                pagesWithPrices.size > 0
                    ? `✓ Saved · ${pagesWithPrices.size} page(s) re-rendered with new prices`
                    : `✓ Saved ${updatedZones.length} hit zones`,
                pagesWithPrices.size > 0
                    ? `✓ Guardado · ${pagesWithPrices.size} página(s) regeneradas`
                    : `✓ Guardadas ${updatedZones.length} zonas`,
            ), { kind: 'success' });
            onClose();
        } catch (err) {
            console.warn('save / bake failed:', err);
            toast(tx(`Save failed: ${err?.message || 'unknown'}`, `Error al guardar: ${err?.message || ''}`), { kind: 'error' });
        } finally {
            setBaking(false);
            setBakeProgress('');
        }
    };

    // ── Render ─────────────────────────────────────────────────
    const currentUrl = imageUrls[page];

    // Live preview rectangle while dragging.
    const previewRect = (dragStart && dragEnd) ? {
        x: Math.min(dragStart.x, dragEnd.x),
        y: Math.min(dragStart.y, dragEnd.y),
        width: Math.abs(dragEnd.x - dragStart.x),
        height: Math.abs(dragEnd.y - dragStart.y),
    } : null;

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/60"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[95vh] flex flex-col overflow-hidden shadow-2xl">
                <header className="bg-sky-600 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                    <div>
                        <div className="text-base font-black">
                            🎯 {tx('Map menu items for SOLD OUT overlays', 'Mapear items para tachados SOLD OUT')}
                        </div>
                        <div className="text-[11px] opacity-90">
                            {tx('Click each item on the menu → pick which item it is. Drag for a custom-size box.',
                                'Haz clic en cada item del menú → elige cuál es. Arrastra para una caja personalizada.')}
                        </div>
                    </div>
                    <button onClick={onClose}
                        className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 transition text-lg font-black">
                        ✕
                    </button>
                </header>

                {/* Page tabs (multi-page menus) */}
                {imageUrls.length > 1 && (
                    <div className="flex items-center gap-1.5 px-4 py-2 bg-dd-bg border-b border-dd-line flex-shrink-0">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mr-2">
                            {tx('Page', 'Página')}:
                        </span>
                        {imageUrls.map((_, i) => {
                            const count = zones.filter(z => (z.page ?? 0) === i).length;
                            return (
                                <button key={i}
                                    onClick={() => setPage(i)}
                                    className={`px-2.5 py-1 rounded-md text-xs font-bold transition ${
                                        page === i
                                            ? 'bg-sky-600 text-white'
                                            : 'bg-white text-sky-800 hover:bg-sky-50 border border-sky-200'
                                    }`}>
                                    {i + 1}
                                    {count > 0 && (
                                        <span className={`ml-1 px-1.5 py-0 rounded-full text-[9px] ${page === i ? 'bg-sky-800' : 'bg-sky-100 text-sky-700'}`}>
                                            {count}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Image canvas */}
                <div ref={containerRef}
                    className="flex-1 overflow-auto p-4 bg-stone-200 flex items-start justify-center">
                    {currentUrl ? (
                        <div className="relative inline-block bg-white shadow-lg select-none"
                            onMouseDown={onMouseDown}
                            onMouseMove={onMouseMove}
                            onMouseUp={onMouseUp}
                            onMouseLeave={onMouseLeave}
                            style={{ cursor: 'crosshair' }}>
                            <img ref={imageRef}
                                src={currentUrl}
                                alt={`menu page ${page + 1}`}
                                draggable={false}
                                className="block max-w-full"
                                style={{ maxHeight: '70vh' }} />

                            {/* Existing zones on this page */}
                            {pageZones.map(zone => {
                                const zoneIdx = zones.indexOf(zone);
                                const isPicking = pickerForZoneIdx === zoneIdx;
                                const labeled = !!zone.itemName;
                                return (
                                    <div key={zoneIdx}
                                        data-zone="true"
                                        className={`absolute border-2 rounded transition ${
                                            isPicking
                                                ? 'border-amber-500 bg-amber-500/20'
                                                : labeled
                                                    ? 'border-emerald-500 bg-emerald-500/15 hover:bg-emerald-500/25'
                                                    : 'border-red-500 bg-red-500/20 animate-pulse'
                                        }`}
                                        style={{
                                            left: `${zone.x * 100}%`,
                                            top: `${zone.y * 100}%`,
                                            width: `${zone.width * 100}%`,
                                            height: `${zone.height * 100}%`,
                                        }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setPickerForZoneIdx(isPicking ? null : zoneIdx);
                                            setPickerFilter('');
                                        }}>
                                        {/* Label tag */}
                                        {labeled && (
                                            <div className="absolute -top-5 left-0 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-600 text-white whitespace-nowrap flex items-center gap-1">
                                                <span>{zone.itemName}</span>
                                                {zone.priceOverride && (
                                                    <span className="px-1 rounded bg-white text-emerald-700 tabular-nums">
                                                        {zone.priceOverride}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                        {/* Delete button */}
                                        <button data-zone="true"
                                            onClick={(e) => { e.stopPropagation(); deleteZone(zoneIdx); }}
                                            className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-600 text-white text-[10px] font-black hover:bg-red-700">
                                            ✕
                                        </button>
                                    </div>
                                );
                            })}

                            {/* Live drag preview */}
                            {previewRect && (
                                <div className="absolute border-2 border-dashed border-sky-600 bg-sky-600/10 pointer-events-none"
                                    style={{
                                        left: `${previewRect.x * 100}%`,
                                        top: `${previewRect.y * 100}%`,
                                        width: `${previewRect.width * 100}%`,
                                        height: `${previewRect.height * 100}%`,
                                    }} />
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center p-12 text-stone-600">
                            <div className="text-4xl mb-2">📄</div>
                            <div className="text-sm">{tx('No image uploaded for this page.', 'Sin imagen para esta página.')}</div>
                        </div>
                    )}
                </div>

                {/* Mapped items list — page-scoped, with editable price overrides */}
                {pageZones.filter(z => z.itemName).length > 0 && (
                    <div className="border-t border-dd-line bg-emerald-50/30 p-3 flex-shrink-0 max-h-44 overflow-y-auto">
                        <div className="text-[10px] font-black uppercase tracking-widest text-emerald-900 mb-1.5">
                            {tx(`Mapped items on this page (${pageZones.filter(z => z.itemName).length})`, `Items mapeados (${pageZones.filter(z => z.itemName).length})`)}
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                            {pageZones.filter(z => z.itemName).map((zone) => {
                                const zoneIdx = zones.indexOf(zone);
                                return (
                                    <div key={zoneIdx}
                                        className="flex flex-col gap-1 bg-white border border-emerald-200 rounded px-2 py-1.5">
                                        <div className="flex items-center gap-1.5">
                                            <span className="flex-1 text-[11px] font-bold text-emerald-900 truncate" title={`${zone.category} — ${zone.itemName}`}>
                                                {zone.itemName}
                                            </span>
                                            <input type="text"
                                                value={zone.priceOverride || ''}
                                                onChange={(e) => setZonePrice(zoneIdx, e.target.value)}
                                                placeholder={tx('$ new price', '$ precio')}
                                                className={`w-20 px-1.5 py-0.5 rounded border text-[11px] font-bold tabular-nums text-right ${
                                                    zone.priceOverride
                                                        ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                                                        : 'border-stone-200 bg-white text-stone-500'
                                                }`} />
                                            <button onClick={() => deleteZone(zoneIdx)}
                                                className="w-5 h-5 rounded-full bg-red-100 hover:bg-red-200 text-red-700 text-[10px] font-black"
                                                title={tx('Delete zone', 'Borrar zona')}>
                                                ✕
                                            </button>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <span className="text-[9px] font-bold text-stone-500 w-8">QR:</span>
                                            <input type="url"
                                                value={zone.qrUrl || ''}
                                                onChange={(e) => setZoneQrUrl(zoneIdx, e.target.value)}
                                                placeholder={tx('https://… (optional QR overlay)', 'https://… (QR opcional)')}
                                                className={`flex-1 px-1.5 py-0.5 rounded border text-[10px] font-mono ${
                                                    zone.qrUrl
                                                        ? 'border-purple-500 bg-purple-50 text-purple-700'
                                                        : 'border-stone-200 bg-white text-stone-500'
                                                }`} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <p className="text-[10px] text-emerald-700/70 italic mt-1.5 leading-snug">
                            {tx(
                                'Set a price to overlay it on the menu image (covers the printed price). Leave blank to keep the printed price.',
                                'Escribe un precio para sobreponer al impreso. Déjalo vacío para mantener el precio original.',
                            )}
                        </p>
                    </div>
                )}

                {/* Picker popover */}
                {pickerForZoneIdx !== null && zones[pickerForZoneIdx] && (
                    <div className="border-t border-dd-line bg-amber-50/50 p-3 flex-shrink-0">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-black text-amber-900">
                                {tx('Pick the item this box represents:', 'Elige el item de esta caja:')}
                            </span>
                            <input type="text" value={pickerFilter}
                                onChange={(e) => setPickerFilter(e.target.value)}
                                placeholder={tx('Search…', 'Buscar…')}
                                autoFocus
                                className="flex-1 px-2 py-1 rounded border border-amber-300 text-sm bg-white" />
                            <button onClick={() => { setPickerForZoneIdx(null); setPickerFilter(''); }}
                                className="px-2 py-1 text-xs font-bold text-stone-600 hover:bg-stone-100 rounded">
                                {tx('Cancel', 'Cancelar')}
                            </button>
                        </div>
                        <div className="max-h-32 overflow-y-auto grid grid-cols-3 gap-1">
                            {filteredOptions.slice(0, 60).map((opt, i) => (
                                <button key={`${opt.category}-${opt.nameEn}-${i}`}
                                    onClick={() => setZoneItem(pickerForZoneIdx, opt)}
                                    className="text-left px-2 py-1 rounded text-[11px] font-bold text-amber-900 hover:bg-amber-200 border border-amber-200 bg-white truncate">
                                    <span className="text-amber-600 text-[9px] uppercase tracking-wider mr-1">{opt.category}</span>
                                    {opt.nameEn}
                                </button>
                            ))}
                            {filteredOptions.length === 0 && (
                                <p className="col-span-3 text-[11px] text-stone-500 italic px-2 py-1.5">
                                    {tx('No items match. Try a different search term.', 'Sin coincidencias.')}
                                </p>
                            )}
                        </div>
                    </div>
                )}

                {/* Footer */}
                <footer className="border-t border-dd-line p-3 flex gap-2 flex-shrink-0 items-center">
                    <span className="text-[11px] text-dd-text-2">
                        <strong className="text-dd-text">{zones.filter(z => z.itemName).length}</strong> {tx('mapped', 'mapeados')}
                        {zones.length > zones.filter(z => z.itemName).length && (
                            <> · <span className="text-red-600 font-bold">{zones.length - zones.filter(z => z.itemName).length} {tx('unpicked', 'sin item')}</span></>
                        )}
                    </span>
                    {baking && bakeProgress && (
                        <span className="text-[11px] text-amber-700 font-bold italic">
                            🔥 {bakeProgress}
                        </span>
                    )}
                    <button onClick={onClose} disabled={baking}
                        className="ml-auto px-4 py-2 rounded-lg bg-white border border-dd-line text-dd-text font-bold hover:bg-dd-bg disabled:opacity-40">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={save} disabled={baking}
                        className="px-4 py-2 rounded-lg bg-sky-600 text-white font-bold hover:bg-sky-700 disabled:opacity-60">
                        {baking ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                </footer>
            </div>
        </div>
        </ModalPortal>
    );
}
