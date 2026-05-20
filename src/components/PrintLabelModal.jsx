// PrintLabelModal — preview + print a date-code prep label.
//
// Andrew 2026-05-20 — first surface for the Epson TM-L100 label
// printer rollout. Reusable so we can wire the same modal into
// Recipes, Operations inventory, Catering, etc. without rebuilding
// the preview each time.
//
// Props:
//   recipe       — recipe-shaped object (titleEn, titleEs, allergens,
//                  ingredientsEn). Used for the label content.
//   location     — 'webster' | 'maryland'. Picks the printer.
//   staffName    — viewer name, stamped onto "By: ..."
//   language     — 'en' | 'es' for the bilingual label content.
//   onClose      — close callback.
//
// State:
//   shelfLifeDays — adjustable in 1-day increments (1..14). Defaults
//                   from the recipe via resolveShelfLifeDays().
//   notes         — short free-text added below the ingredients
//                   ("batch #3", "double the chili", etc.).
//
// Print flow:
//   1. User taps "Print label" → calls printPrepLabel().
//   2. Toast on success ("Printed!") or failure ("No printer / offline /
//      CORS / etc." — we surface the underlying error so misconfig is
//      diagnosable from the staff side without devtools).

import { useEffect, useMemo, useState } from 'react';
import { toast } from '../toast';
import {
    buildLabelPayload,
    resolveShelfLifeDays,
    subscribePrinterConfig,
    printPrepLabel,
} from '../data/labelPrinting';

export default function PrintLabelModal({
    recipe,
    location,
    staffName,
    language = 'en',
    onClose,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const defaultDays = useMemo(() => resolveShelfLifeDays(recipe), [recipe]);
    const [shelfLifeDays, setShelfLifeDays] = useState(defaultDays);
    const [notes, setNotes] = useState('');
    const [printer, setPrinter] = useState(null);
    const [printing, setPrinting] = useState(false);

    // Live config so a fresh admin edit takes effect without reload.
    useEffect(() => {
        if (!location) return;
        return subscribePrinterConfig(location, setPrinter);
    }, [location]);

    // Build the preview payload — same builder the print path uses,
    // so what the user sees IS what prints.
    const previewPayload = useMemo(() => buildLabelPayload({
        itemName: recipe?.titleEn || recipe?.title || 'Item',
        itemNameEs: recipe?.titleEs,
        prepDate: new Date(),
        shelfLifeDays,
        preppedBy: staffName,
        location: locationLabel(location),
        allergens: recipe?.allergens || [],
        ingredients: pickIngredientsForLabel(recipe, language),
        language,
        notes,
    }), [recipe, shelfLifeDays, staffName, location, language, notes]);

    const printerReady = !!(printer && printer.ip && printer.enabled !== false);

    const handlePrint = async () => {
        if (printing) return;
        if (!printerReady) {
            toast(tx(
                'No printer configured for this location yet. Set one up in Admin.',
                'No hay impresora configurada para esta ubicación. Configúrala en Admin.',
            ), { kind: 'error' });
            return;
        }
        setPrinting(true);
        const res = await printPrepLabel({
            location,
            recipe,
            preppedBy: staffName,
            shelfLifeDays,
            language,
            notes,
            byName: staffName,
        });
        setPrinting(false);
        if (res.ok) {
            toast(tx('✓ Label printed', '✓ Etiqueta impresa'), { kind: 'success' });
            onClose?.();
        } else {
            const errMsg = errorToHuman(res.error, isEs);
            toast(errMsg, { kind: 'error' });
        }
    };

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[95vh] sm:max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between safe-top flex-shrink-0">
                    <h2 className="text-lg font-black text-dd-text">
                        🏷 {tx('Print prep label', 'Imprimir etiqueta')}
                    </h2>
                    <button onClick={onClose}
                        className="w-8 h-8 rounded-full bg-dd-bg text-dd-text-2 text-lg hover:bg-dd-line">
                        ×
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Shelf life — quick chips + step buttons */}
                    <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                            {tx('Shelf life (days)', 'Días de vida útil')}
                        </label>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setShelfLifeDays(d => Math.max(1, d - 1))}
                                className="w-10 h-10 rounded-lg bg-dd-bg text-dd-text font-black text-lg hover:bg-dd-line active:scale-95">
                                −
                            </button>
                            <div className="flex-1 text-center">
                                <div className="text-2xl font-black text-dd-green">{shelfLifeDays}</div>
                                <div className="text-[10px] text-dd-text-2">
                                    {tx('days', 'días')}
                                </div>
                            </div>
                            <button
                                onClick={() => setShelfLifeDays(d => Math.min(14, d + 1))}
                                className="w-10 h-10 rounded-lg bg-dd-bg text-dd-text font-black text-lg hover:bg-dd-line active:scale-95">
                                +
                            </button>
                        </div>
                        <div className="flex gap-1 mt-2 flex-wrap">
                            {[1, 3, 5, 7].map(d => (
                                <button key={d}
                                    onClick={() => setShelfLifeDays(d)}
                                    className={`px-3 py-1 rounded-full text-xs font-bold border transition ${shelfLifeDays === d
                                        ? 'bg-dd-green text-white border-dd-green'
                                        : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                                    {d}d
                                </button>
                            ))}
                            <span className="text-[10px] text-dd-text-2 italic self-center ml-1">
                                {tx(`default ${defaultDays}d`, `pred. ${defaultDays}d`)}
                            </span>
                        </div>
                    </div>

                    {/* Notes (optional) */}
                    <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                            {tx('Notes (optional)', 'Notas (opcional)')}
                        </label>
                        <input
                            type="text"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value.slice(0, 120))}
                            placeholder={tx('e.g. "batch #3", "extra chili"', 'ej. "lote #3"')}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green"
                        />
                    </div>

                    {/* Preview — mimics the linerless thermal label */}
                    <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                            {tx('Preview (what prints)', 'Vista previa')}
                        </div>
                        <div className="bg-white border-2 border-dashed border-dd-line rounded-lg p-3 font-mono text-[11px] leading-tight text-dd-text whitespace-pre-wrap">
                            {renderLabelPreview(previewPayload)}
                        </div>
                    </div>

                    {/* Printer state strip */}
                    <div className={`rounded-lg p-2.5 text-[11px] ${
                        printerReady
                            ? 'bg-dd-sage-50 border border-dd-green/40 text-dd-green-700'
                            : 'bg-amber-50 border border-amber-300 text-amber-800'
                    }`}>
                        {printerReady ? (
                            <>
                                <span className="font-bold">🖨 {printer.name || tx('Printer ready', 'Impresora lista')}</span>
                                <span className="ml-1.5 opacity-70">— {printer.ip}</span>
                            </>
                        ) : (
                            <>
                                ⚠ {tx(
                                    'No printer set up for this location. Ask an admin to configure one in Admin → Printers.',
                                    'No hay impresora para esta ubicación. Pídele a un admin que la configure.',
                                )}
                            </>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="border-t border-dd-line p-3 flex gap-2 flex-shrink-0 safe-bottom">
                    <button onClick={onClose}
                        className="flex-1 py-2.5 rounded-lg bg-white border border-dd-line text-dd-text font-bold hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={handlePrint}
                        disabled={!printerReady || printing}
                        className={`flex-1 py-2.5 rounded-lg font-bold text-white transition ${(!printerReady || printing)
                            ? 'bg-dd-text-2/40 cursor-not-allowed'
                            : 'bg-dd-green hover:bg-dd-green-700 active:scale-95 shadow-sm'}`}>
                        {printing
                            ? tx('Printing…', 'Imprimiendo…')
                            : <>🏷 {tx('Print label', 'Imprimir')}</>}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Render the label preview as plain text. Mirrors the visual that
// the Epson will produce — fixed-width monospace, centered title,
// horizontal rules. Keeps the user oriented when they hit Print.
function renderLabelPreview(payload) {
    const lines = [];
    lines.push('==============================');
    for (const t of payload.titleLines) {
        lines.push(centerLine(t, 30));
    }
    lines.push('==============================');
    for (const m of payload.metaLines) lines.push(m);
    if (payload.allergens.length > 0) {
        lines.push('------------------------------');
        lines.push(`ALLERGENS: ${payload.allergens.join(', ')}`);
    }
    if (payload.ingredients.length > 0) {
        lines.push('------------------------------');
        for (const ing of payload.ingredients) {
            lines.push(`- ${ing.slice(0, 30)}`);
        }
    }
    if (payload.notes) {
        lines.push('------------------------------');
        lines.push(payload.notes);
    }
    lines.push('==============================');
    lines.push(centerLine(payload.footer || 'DD MAU', 30));
    return lines.join('\n');
}

function centerLine(s, w) {
    const t = String(s || '');
    if (t.length >= w) return t;
    const pad = Math.floor((w - t.length) / 2);
    return ' '.repeat(pad) + t;
}

function pickIngredientsForLabel(recipe, language) {
    if (!recipe) return [];
    const list = language === 'es' && Array.isArray(recipe.ingredientsEs) && recipe.ingredientsEs.length
        ? recipe.ingredientsEs
        : (recipe.ingredientsEn || recipe.ingredients || []);
    return list.slice(0, 4).map(line => {
        const m = String(line).match(/^(?:\d+\s*[/\-]?\s*\d*\s*\w{0,12}\s*)?(.*)$/);
        const stripped = (m && m[1]) ? m[1] : line;
        return stripped.trim() || String(line);
    });
}

function locationLabel(loc) {
    if (loc === 'webster') return 'Webster';
    if (loc === 'maryland') return 'MD Heights';
    if (loc === 'both') return 'Both';
    return String(loc || '');
}

function errorToHuman(code, isEs) {
    const map = {
        no_printer_configured: isEs
            ? '⚠ Configura una impresora primero'
            : '⚠ No printer configured yet',
        printer_disabled: isEs
            ? '⚠ La impresora está deshabilitada'
            : '⚠ Printer is disabled',
        'printer timeout': isEs
            ? '⚠ La impresora no respondió. ¿Está encendida y en la misma red Wi-Fi?'
            : '⚠ Printer did not respond. Powered on + same Wi-Fi?',
        printer_rejected: isEs
            ? '⚠ La impresora rechazó el trabajo. Revisa el papel.'
            : '⚠ Printer rejected the job. Check paper / cover / status.',
    };
    if (map[code]) return map[code];
    return isEs
        ? `⚠ Impresión falló: ${code}`
        : `⚠ Print failed: ${code}`;
}
