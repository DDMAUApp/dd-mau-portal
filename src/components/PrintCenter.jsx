// PrintCenter — Word-style mini print app for ad-hoc labels.
//
// Andrew 2026-05-20 — "lets also build a print center that we can
// type messages or item names to print. kinda like word or print."
//
// Free-form composer for anything the kitchen needs that isn't a
// recipe-bound prep label: equipment status ("BROKEN DO NOT USE"),
// allergen warnings, custom date tags, single-batch markers, prep
// reminders, special-of-the-day mini-signs, etc.
//
// Features:
//   • Multi-line textarea — line breaks preserved
//   • Global font size (small / normal / large / huge)
//   • Bold toggle
//   • Alignment (left / center / right)
//   • Optional auto-stamps: date+time and "— <staffName>" signature
//   • Copies 1-20 (stitched into a single print envelope so the
//     printer handles them as one batch, no round-trips)
//   • Location selector — when storeLocation='both', admin picks
//     which restaurant prints
//   • Recent prints — local-storage history of the last 6 messages
//     this staffer typed; tap to recall
//   • Templates — one-tap quick fills for common kitchen messages
//   • Live preview that mimics the actual sticker

import { useEffect, useMemo, useState } from 'react';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';
import { subscribePrinterConfig, printFreeText, getLabelSizePresets, DEFAULT_LABEL_SIZE_PRESET } from '../data/labelPrinting';

const RECENTS_KEY = 'ddmau:printCenter:recents';
const MAX_RECENTS = 6;

export default function PrintCenter({
    location,            // 'webster' | 'maryland' | 'both'
    staffName,
    language = 'en',
    isAdmin = false,
    onClose,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    // Active location to print TO. When the user is in 'both' mode
    // (admin), we default to webster and let them flip via a chip.
    // When they're pinned to a single location, that's the only
    // option — the chip stays inert.
    const [printLocation, setPrintLocation] = useState(
        location === 'both' ? 'webster' : (location || 'webster')
    );
    useEffect(() => {
        if (location && location !== 'both' && location !== printLocation) {
            setPrintLocation(location);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location]);

    // Slot selector — kitchen vs office. Persisted per-user.
    const [printSlot, setPrintSlot] = useState(() => {
        try { return localStorage.getItem('ddmau:printerSlot') || 'kitchen'; }
        catch { return 'kitchen'; }
    });
    const setSlotPersistent = (s) => {
        setPrintSlot(s);
        try { localStorage.setItem('ddmau:printerSlot', s); } catch {}
    };

    const [printer, setPrinter] = useState(null);
    useEffect(() => {
        return subscribePrinterConfig(printLocation, setPrinter, printSlot);
    }, [printLocation, printSlot]);

    const [text, setText] = useState('');
    const [size, setSize] = useState('large');
    const [bold, setBold] = useState(true);
    const [align, setAlign] = useState('center');
    const [copies, setCopies] = useState(1);
    const [stampDate, setStampDate] = useState(false);
    const [stampSignature, setStampSignature] = useState(false);
    const [printing, setPrinting] = useState(false);
    const [recents, setRecents] = useState([]);
    // Label-size preset — Andrew 2026-05-20 "3 tabs for the labels".
    // Shared localStorage key with PrintLabelModal so the choice
    // sticks across both prep-label and free-text prints.
    const [presetId, setPresetId] = useState(() => {
        try { return localStorage.getItem('ddmau:labelPreset') || DEFAULT_LABEL_SIZE_PRESET; }
        catch { return DEFAULT_LABEL_SIZE_PRESET; }
    });
    const setPresetPersistent = (id) => {
        setPresetId(id);
        try { localStorage.setItem('ddmau:labelPreset', id); } catch {}
    };

    useEffect(() => {
        try {
            const raw = localStorage.getItem(RECENTS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) setRecents(parsed.slice(0, MAX_RECENTS));
            }
        } catch { /* localStorage disabled — fine, no recents */ }
    }, []);

    const pushRecent = (newText) => {
        const trimmed = String(newText || '').trim();
        if (!trimmed) return;
        setRecents(prev => {
            // Dedup case-insensitive, push most-recent to front.
            const lower = trimmed.toLowerCase();
            const next = [trimmed, ...prev.filter(r => r.toLowerCase() !== lower)]
                .slice(0, MAX_RECENTS);
            try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch {}
            return next;
        });
    };

    // "Ready" = enabled and (Brother [browser print dialog, no IP needed]
    // OR Epson with an IP filled in). Default type unset = epson_linerless
    // for backward compat with pre-Brother printer config docs.
    const printerType = printer?.type || 'epson_linerless';
    const isBrotherPrinter = printerType === 'brother_ql';
    const printerReady = !!(printer
        && (isBrotherPrinter || printer.ip)
        && printer.enabled !== false);

    // Per-printer-type preset list (Epson 80mm vs Brother 62mm).
    // The 3 size tabs below render from this — names + dims update
    // automatically when the staff toggles between locations whose
    // kitchen printer happens to be a different model.
    const sizePresets = useMemo(
        () => getLabelSizePresets(printerType),
        [printerType]);

    const handlePrint = async () => {
        if (printing) return;
        if (!text.trim()) {
            toast(tx('Type something to print first.', 'Escribe algo para imprimir.'), { kind: 'error' });
            return;
        }
        if (!printerReady) {
            toast(tx(
                'No printer configured for this location yet. Set one up in Admin.',
                'No hay impresora configurada. Configúrala en Admin.',
            ), { kind: 'error' });
            return;
        }
        setPrinting(true);
        const res = await printFreeText({
            location: printLocation,
            slot: printSlot,
            text,
            size, bold, align, copies,
            stampDate, stampSignature, signature: staffName,
            byName: staffName,
            presetId,
        });
        setPrinting(false);
        if (res.ok) {
            pushRecent(text);
            const word = copies > 1 ? tx('labels', 'etiquetas') : tx('label', 'etiqueta');
            toast(tx(`✓ Printed ${copies} ${word}`, `✓ ${copies} ${word} impresas`), { kind: 'success' });
            // Don't auto-close — staff often want to print multiple
            // different things in one session. They close manually.
        } else {
            toast(tx('Print failed: ', 'Impresión falló: ') + errorToHuman(res.error, isEs), { kind: 'error' });
        }
    };

    const sizeChips = [
        { key: 'small',  en: 'Small',  es: 'Pequeño',   sample: 'aA' },
        { key: 'normal', en: 'Normal', es: 'Normal',    sample: 'aA' },
        { key: 'large',  en: 'Large',  es: 'Grande',    sample: 'aA' },
        { key: 'huge',   en: 'Huge',   es: 'Muy Grande', sample: 'aA' },
    ];
    const sizePixels = useMemo(() => ({
        small: 11, normal: 14, large: 18, huge: 24,
    }), []);

    const previewBodyStyle = {
        fontSize: `${sizePixels[size] || 14}px`,
        fontWeight: bold ? 800 : 400,
        textAlign: align,
        whiteSpace: 'pre-wrap',
        lineHeight: 1.35,
    };

    const TEMPLATES = useMemo(() => [
        {
            id: 'broken',
            label: tx('🚫 Broken / Do not use', '🚫 Roto / No usar'),
            text: tx('BROKEN\nDO NOT USE', 'ROTO\nNO USAR'),
            size: 'huge', bold: true, align: 'center', stampDate: true, stampSignature: true,
        },
        {
            id: 'quarantine',
            label: tx('⚠ Quarantine', '⚠ Cuarentena'),
            text: tx('QUARANTINE\nDO NOT SERVE', 'CUARENTENA\nNO SERVIR'),
            size: 'huge', bold: true, align: 'center', stampDate: true, stampSignature: true,
        },
        {
            id: 'allergen',
            label: tx('🚨 Allergen warning', '🚨 Alérgeno'),
            text: tx('CONTAINS:\n', 'CONTIENE:\n'),
            size: 'large', bold: true, align: 'center', stampDate: false, stampSignature: false,
        },
        {
            id: 'reserved',
            label: tx('🔖 Reserved / Hold', '🔖 Reservado'),
            text: tx('RESERVED FOR:\n', 'RESERVADO PARA:\n'),
            size: 'large', bold: true, align: 'center', stampDate: false, stampSignature: false,
        },
        {
            id: 'date',
            label: tx('🗓 Custom date label', '🗓 Etiqueta con fecha'),
            text: tx('OPENED', 'ABIERTO'),
            size: 'large', bold: true, align: 'center', stampDate: true, stampSignature: true,
        },
    ], [isEs]);

    const applyTemplate = (tpl) => {
        setText(tpl.text);
        setSize(tpl.size);
        setBold(tpl.bold);
        setAlign(tpl.align);
        setStampDate(tpl.stampDate);
        setStampSignature(tpl.stampSignature);
    };

    // ModalPortal: lifts modal out of any backdrop-filter ancestor so
    // position:fixed lands on the viewport (see ModalPortal.jsx).
    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl h-[100dvh] sm:h-auto sm:max-h-[92vh] flex flex-col">
                {/* Header */}
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between safe-top flex-shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <h2 className="text-lg font-black text-dd-text">
                            🖨 {tx('Print Center', 'Centro de impresión')}
                        </h2>
                    </div>
                    <button onClick={onClose}
                        className="px-3 py-1.5 rounded-full bg-dd-bg text-dd-text font-bold text-sm hover:bg-dd-line">
                        {tx('Done', 'Listo')}
                    </button>
                </div>

                {/* Body — split panel on desktop, stacked on mobile */}
                <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* ── LEFT: Composer + controls ────────────────── */}
                    <div className="space-y-3 min-w-0">
                        {/* Quick templates */}
                        <div>
                            <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                {tx('Quick templates', 'Plantillas rápidas')}
                            </span>
                            <div className="flex flex-wrap gap-1">
                                {TEMPLATES.map(t => (
                                    <button key={t.id}
                                        onClick={() => applyTemplate(t)}
                                        className="px-2 py-1 rounded-full bg-purple-50 border border-purple-200 text-purple-800 text-[11px] font-bold hover:bg-purple-100">
                                        {t.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Composer */}
                        <div>
                            <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                {tx('Message', 'Mensaje')}
                            </span>
                            <textarea
                                value={text}
                                onChange={(e) => setText(e.target.value.slice(0, 2000))}
                                rows={6}
                                placeholder={tx(
                                    'Type anything — multiple lines OK. Try a template above to start.',
                                    'Escribe lo que quieras — varias líneas. Prueba una plantilla arriba.',
                                )}
                                autoFocus
                                className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm font-mono leading-tight focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green"
                            />
                            <div className="text-[10px] text-dd-text-2/70 mt-0.5 text-right">
                                {text.length} / 2000
                            </div>
                        </div>

                        {/* Size + bold + align */}
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                    {tx('Size', 'Tamaño')}
                                </span>
                                <div className="flex flex-wrap gap-1">
                                    {sizeChips.map(s => (
                                        <button key={s.key}
                                            onClick={() => setSize(s.key)}
                                            className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${size === s.key
                                                ? 'bg-dd-green text-white border-dd-green'
                                                : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                                            {isEs ? s.es : s.en}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                    {tx('Style', 'Estilo')}
                                </span>
                                <div className="flex gap-1">
                                    <button onClick={() => setBold(v => !v)}
                                        className={`flex-1 px-2 py-1 rounded-md text-[11px] font-black border transition ${bold
                                            ? 'bg-dd-green text-white border-dd-green'
                                            : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                                        B
                                    </button>
                                    {['left', 'center', 'right'].map(a => (
                                        <button key={a}
                                            onClick={() => setAlign(a)}
                                            className={`flex-1 px-2 py-1 rounded-md text-[11px] font-bold border transition ${align === a
                                                ? 'bg-dd-green text-white border-dd-green'
                                                : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                                            {a === 'left' ? '⬅' : a === 'center' ? '⬌' : '➡'}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Auto-stamps */}
                        <div className="flex flex-wrap gap-2 items-center">
                            <label className="flex items-center gap-1.5 text-[11px] text-dd-text cursor-pointer">
                                <input type="checkbox" checked={stampDate}
                                    onChange={(e) => setStampDate(e.target.checked)}
                                    className="w-4 h-4 accent-dd-green" />
                                🗓 {tx('Stamp date + time', 'Sellar fecha + hora')}
                            </label>
                            <label className="flex items-center gap-1.5 text-[11px] text-dd-text cursor-pointer">
                                <input type="checkbox" checked={stampSignature}
                                    onChange={(e) => setStampSignature(e.target.checked)}
                                    className="w-4 h-4 accent-dd-green" />
                                ✍ {tx('Sign with my name', 'Firmar con mi nombre')}
                            </label>
                        </div>

                        {/* Copies */}
                        <div>
                            <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                {tx('Copies', 'Copias')}
                            </span>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setCopies(c => Math.max(1, c - 1))}
                                    className="w-9 h-9 rounded-lg bg-dd-bg text-dd-text font-black text-lg hover:bg-dd-line active:scale-95">
                                    −
                                </button>
                                <div className="w-12 text-center text-xl font-black text-dd-green">
                                    {copies}
                                </div>
                                <button
                                    onClick={() => setCopies(c => Math.min(20, c + 1))}
                                    className="w-9 h-9 rounded-lg bg-dd-bg text-dd-text font-black text-lg hover:bg-dd-line active:scale-95">
                                    +
                                </button>
                                <div className="flex gap-1 ml-auto">
                                    {[1, 5, 10].map(n => (
                                        <button key={n} onClick={() => setCopies(n)}
                                            className={`px-2 py-1 rounded text-[10px] font-bold border ${copies === n ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                                            {n}×
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Print location — only when admin can pick */}
                        {(location === 'both' || isAdmin) && (
                            <div>
                                <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                    {tx('Print to', 'Imprimir en')}
                                </span>
                                <div className="flex gap-1">
                                    {[
                                        { k: 'webster', en: 'Webster', es: 'Webster' },
                                        { k: 'maryland', en: 'MD Heights', es: 'MD Heights' },
                                    ].map(l => (
                                        <button key={l.k}
                                            onClick={() => setPrintLocation(l.k)}
                                            className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-bold border transition ${printLocation === l.k
                                                ? 'bg-dd-text text-white border-dd-text'
                                                : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                                            {isEs ? l.es : l.en}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Slot selector REMOVED 2026-05-20 — Andrew:
                            "i only need the kitchen section for each
                            location". Slot defaults to 'kitchen' from
                            state init; toggle hidden from staff UI. */}

                        {/* Label size tabs — Andrew 2026-05-20 "3 tabs
                            in the print screen for the labels". Same
                            preset picker as PrintLabelModal; shared
                            localStorage so choice carries across.
                            Per-printer-type list (Epson 80mm vs
                            Brother 62mm) comes from `sizePresets`. */}
                        <div>
                            <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                {tx('Label size', 'Tamaño')}
                            </span>
                            {/* Tabs — Small / Medium / Large. Dimensions
                                stripped 2026-05-20 ("staff will know the
                                size") — preset still carries widthMm /
                                heightMm under the hood for the Brother
                                @page sizing, just not shown in the UI. */}
                            <div className="flex gap-1">
                                {sizePresets.map(p => {
                                    const active = p.id === presetId;
                                    return (
                                        <button key={p.id}
                                            onClick={() => setPresetPersistent(p.id)}
                                            className={`flex-1 px-2 py-2 rounded-lg text-xs font-bold border-2 transition ${
                                                active
                                                    ? 'bg-dd-text text-white border-dd-text'
                                                    : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'
                                            }`}>
                                            {isEs ? p.nameEs : p.nameEn}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Recent prints */}
                        {recents.length > 0 && (
                            <div>
                                <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                    {tx('Your recent prints', 'Tus impresiones recientes')}
                                </span>
                                <div className="space-y-1">
                                    {recents.map((r, i) => (
                                        <button key={i}
                                            onClick={() => setText(r)}
                                            className="w-full text-left px-2 py-1.5 rounded-md bg-dd-bg hover:bg-dd-sage-50 border border-dd-line text-[11px] text-dd-text font-mono truncate">
                                            {r.split('\n').join(' · ').slice(0, 80)}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ── RIGHT: Preview + printer state ───────────── */}
                    <div className="space-y-3 min-w-0">
                        <div>
                            <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                {tx('Preview', 'Vista previa')}
                            </span>
                            <div className="bg-white border-2 border-dashed border-dd-line rounded-lg p-3 min-h-[120px]"
                                style={previewBodyStyle}>
                                {text || (
                                    <span className="text-dd-text-2/50 italic font-normal text-sm">
                                        {tx('Type a message to see it here…', 'Escribe un mensaje para verlo aquí…')}
                                    </span>
                                )}
                                {(stampDate || stampSignature) && text && (
                                    <div className="mt-2 pt-2 border-t border-dd-line/40 text-[10px] text-dd-text-2 font-mono font-normal text-center"
                                        style={{ textAlign: 'center' }}>
                                        {stampDate && (
                                            <div>{previewDateStamp()}</div>
                                        )}
                                        {stampSignature && (
                                            <div>— {staffName || tx('me', 'yo')}</div>
                                        )}
                                        <div className="opacity-70 mt-0.5">DD MAU</div>
                                    </div>
                                )}
                            </div>
                            <p className="text-[10px] text-dd-text-2 italic mt-1">
                                {tx(
                                    '80mm linerless thermal — preview is approximate. Actual print uses fixed-width characters.',
                                    'Térmica sin liner 80mm — la vista previa es aproximada.',
                                )}
                            </p>
                        </div>

                        {/* Printer state strip */}
                        <div className={`rounded-lg p-2.5 text-[11px] ${
                            printerReady
                                ? 'bg-dd-sage-50 border border-dd-green/40 text-dd-green-700'
                                : 'bg-amber-50 border border-amber-300 text-amber-800'
                        }`}>
                            {printerReady ? (
                                <>
                                    <span className="font-bold">🖨 {printer.name || tx('Printer ready', 'Lista')}</span>
                                    {isBrotherPrinter ? (
                                        <span className="ml-1.5 opacity-70">— {tx('Brother (AirPrint dialog)', 'Brother (diálogo AirPrint)')}</span>
                                    ) : (
                                        <span className="ml-1.5 opacity-70">— {printer.ip}</span>
                                    )}
                                </>
                            ) : (
                                <>
                                    ⚠ {tx(
                                        'No printer at this location. Admin → 🏷 Label printers.',
                                        'Sin impresora aquí. Admin → 🏷 Impresoras.',
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {/* Footer — sticky Print button */}
                <div className="border-t border-dd-line p-3 flex gap-2 flex-shrink-0 safe-bottom">
                    <button onClick={() => setText('')}
                        disabled={!text}
                        className="px-3 py-2.5 rounded-lg bg-white border border-dd-line text-dd-text-2 text-sm font-bold hover:bg-dd-bg disabled:opacity-40">
                        {tx('Clear', 'Limpiar')}
                    </button>
                    <button
                        onClick={handlePrint}
                        disabled={!printerReady || printing || !text.trim()}
                        className={`flex-1 py-2.5 rounded-lg font-bold text-white transition ${(!printerReady || printing || !text.trim())
                            ? 'bg-dd-text-2/40 cursor-not-allowed'
                            : 'bg-dd-green hover:bg-dd-green-700 active:scale-95 shadow-sm'}`}>
                        {printing
                            ? tx('Printing…', 'Imprimiendo…')
                            : <>🖨 {tx(`Print ${copies > 1 ? copies + '× ' : ''}label`, `Imprimir ${copies > 1 ? copies + '× ' : ''}etiqueta`)}</>}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

function previewDateStamp() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    let h = d.getHours(); const ampm = h >= 12 ? 'p' : 'a';
    h = h % 12 || 12;
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd}/${yy} ${h}:${mi}${ampm}`;
}

function errorToHuman(code, isEs) {
    const map = {
        no_printer_configured: isEs ? 'sin impresora' : 'no printer',
        empty_text: isEs ? 'mensaje vacío' : 'empty message',
        text_too_long: isEs ? 'mensaje muy largo' : 'message too long',
        'printer timeout': isEs ? 'sin respuesta de la impresora' : 'printer timeout',
        printer_rejected: isEs ? 'la impresora rechazó' : 'printer rejected',
    };
    return map[code] || code || (isEs ? 'falló' : 'failed');
}
