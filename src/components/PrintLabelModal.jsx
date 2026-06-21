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

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';
import { ALLERGEN_ORDER, allergenLabel } from '../data/allergens';
import {
    buildLabelPayload,
    resolveShelfLifeDays,
    subscribePrinterConfig,
    printPrepLabel,
    warmPrintConfigs,
} from '../data/labelPrinting';
import { subscribeLabelFormat, DEFAULT_LABEL_FORMAT } from '../data/labelFormat';

// Props:
//   recipe       — recipe-shaped object (titleEn, titleEs, allergens,
//                  ingredientsEn). Used for the label content when
//                  editable=false.
//   editable     — when true, the title field becomes an editable
//                  input and allergens become checkboxes. Lets the
//                  same modal handle ad-hoc inventory labels ("opened
//                  case of lettuce") without needing a recipe upstream.
//                  Andrew 2026-05-20.
//   location     — 'webster' | 'maryland'. Picks the printer.
//   staffName    — viewer name, stamped onto "By: ..."
//   language     — 'en' | 'es' for the bilingual label content.
//   onClose      — close callback.
export default function PrintLabelModal({
    recipe,
    editable = false,
    location,
    staffName,
    language = 'en',
    source = 'recipe',  // 'recipe' | 'datestickers' | 'operations'
    onClose,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const defaultDays = useMemo(() => resolveShelfLifeDays(recipe), [recipe]);
    const [shelfLifeDays, setShelfLifeDays] = useState(defaultDays);
    const [notes, setNotes] = useState('');
    // Andrew 2026-05-20 — "and then how many copies we want to print".
    // Prep labels can print N at once, stitched into one envelope so
    // the printer batches them as one job (no round-trips per copy).
    const [copies, setCopies] = useState(1);
    // Slot selector — kitchen vs office printer. Andrew 2026-05-20:
    // "add the option to print off the office printer or off the
    // kitchen printer". Persisted per-user in localStorage so the
    // last choice sticks across opens.
    const [slot, setSlot] = useState(() => {
        try { return localStorage.getItem('ddmau:printerSlot') || 'kitchen'; }
        catch { return 'kitchen'; }
    });
    const setSlotPersistent = (s) => {
        setSlot(s);
        try { localStorage.setItem('ddmau:printerSlot', s); } catch {}
    };
    const [printer, setPrinter] = useState(null);
    const [printing, setPrinting] = useState(false);

    // ── Editable-mode state ─────────────────────────────────────
    // Only used when editable=true. We seed from the (possibly
    // empty) recipe object so a caller can pre-fill a name +
    // allergens and still let the user adjust before printing.
    const [editTitle, setEditTitle] = useState(recipe?.titleEn || '');
    const [editTitleEs, setEditTitleEs] = useState(recipe?.titleEs || '');
    const [editAllergens, setEditAllergens] = useState(
        Array.isArray(recipe?.allergens) ? recipe.allergens : []
    );
    // useCallback — handed to the memo'd EditableIdentity section, so
    // a fresh arrow per render would defeat its bail-out.
    const toggleAllergen = useCallback((code) => {
        setEditAllergens(prev => prev.includes(code)
            ? prev.filter(c => c !== code)
            : [...prev, code]);
    }, []);

    // The recipe-shaped object we feed downstream. In editable mode
    // we synthesize it from local state so the preview + the final
    // print payload both reflect the user's edits. useMemo — as an
    // inline literal this got a NEW identity every render, busting the
    // previewPayload memo below, so every unrelated state change
    // (copies +/-, slot toggle) re-rendered the whole label preview.
    // Andrew 2026-06-12: "when you press + quantity it glitches".
    const effectiveRecipe = useMemo(() => (editable
        ? {
            titleEn: editTitle || (isEs ? 'Sin título' : 'Untitled'),
            titleEs: editTitleEs || editTitle || (isEs ? 'Sin título' : 'Untitled'),
            allergens: editAllergens,
            ingredientsEn: [],
            ingredientsEs: [],
            category: recipe?.category || 'Other',
        }
        : recipe
    ), [editable, editTitle, editTitleEs, editAllergens, recipe, isEs]);

    // Live config so a fresh admin edit takes effect without reload.
    // Resubscribes when the slot toggles so the "Printer ready /
    // missing" strip reflects the chosen target.
    useEffect(() => {
        if (!location) return;
        // Pre-warm the print hot path's config cache the moment the
        // modal opens — by the time the user has picked size/copies
        // and taps Print, printPrepLabel resolves both configs in 0ms
        // instead of doing 2 Firestore round-trips ("sticky" print,
        // Andrew 2026-06-11).
        warmPrintConfigs(location, slot);
        return subscribePrinterConfig(location, setPrinter, slot);
    }, [location, slot]);

    // Subscribe to the global label format so the preview reflects
    // admin's saved choices (section toggles, sizes, text overrides).
    // Andrew 2026-05-20 — "make a label edit button so i can go in
    // and edit all the labels format at once".
    const [labelFormat, setLabelFormat] = useState({ ...DEFAULT_LABEL_FORMAT });
    useEffect(() => subscribeLabelFormat(setLabelFormat), []);

    // Printer type drives which preset list staff sees:
    //   • epson_linerless → 80mm-wide ("3-inch") presets
    //   • brother_ql      → 62mm-wide (2.4-inch DK-4205) presets
    // The default matches DEFAULT_PRINTER_TYPE so an unconfigured
    // printer still renders a sensible 3-tab UI.
    const printerType = printer?.type || 'epson_linerless';
    const isBrotherPrinter = printerType === 'brother_ql';

    // Size presets removed (Andrew 2026-06-20: "drop the size tabs").
    // The admin Label Format is now the single source of truth for every
    // sticker, so the print modal renders it directly — what the Label
    // Format editor previews is exactly what prints. Physical roll dims
    // (Brother @page) come from the printer config in printPrepLabel.

    // Build the preview payload — same builder the print path uses, so
    // what the user sees IS what prints. We feed the printer's real roll
    // width so a narrow (e.g. 40mm) Maryland roll previews at the same
    // clamped size it actually prints. In editable mode the content
    // pulls from local edit state via effectiveRecipe.
    const previewPayload = useMemo(() => buildLabelPayload({
        itemName: effectiveRecipe?.titleEn || effectiveRecipe?.title || 'Item',
        itemNameEs: effectiveRecipe?.titleEs,
        prepDate: new Date(),
        shelfLifeDays,
        preppedBy: staffName,
        location: locationLabel(location),
        allergens: effectiveRecipe?.allergens || [],
        ingredients: pickIngredientsForLabel(effectiveRecipe, language),
        language,
        notes,
        format: labelFormat,
        paperWidthMm: printer?.paperWidthMm,
        leftOffsetMm: printer?.leftOffsetMm,
    }), [effectiveRecipe, shelfLifeDays, staffName, location, language, notes, labelFormat, printer?.paperWidthMm, printer?.leftOffsetMm]);
    // Defer the preview one beat behind input. Without this, every
    // keystroke / chip tap re-painted the preview in the SAME frame as
    // the input echo — on older iPads that dropped frames ("glitchy",
    // Andrew 2026-06-12). The urgent render updates just the control
    // the user touched; the preview catches up at idle priority.
    const deferredPayload = useDeferredValue(previewPayload);

    // "Ready" = enabled and (Brother [browser print dialog, no IP needed]
    // OR Epson with an IP filled in). printerType + isBrotherPrinter
    // are derived above (where the preset list is resolved).
    const printerReady = !!(printer
        && (isBrotherPrinter || printer.ip)
        && printer.enabled !== false);

    // Real cancel — Andrew 2026-06-11: "couple of time i canceled the
    // print and then it came out." Cancel/✕ used to just close the
    // modal while the queued job kept going. Now they flip this ref,
    // and printPrepLabel checks it at the last moment before handing
    // the job to the printer. (Once it's on the wire there's no recall
    // — but that window is now ~instant after the v1.0.48 speed-up.)
    const cancelledRef = useRef(false);
    const cancelAndClose = () => {
        cancelledRef.current = true;
        onClose?.();
    };

    const handlePrint = async () => {
        if (printing) return;
        if (!printerReady) {
            toast(tx(
                'No printer configured for this location yet. Set one up in Admin.',
                'No hay impresora configurada para esta ubicación. Configúrala en Admin.',
            ), { kind: 'error' });
            return;
        }
        if (editable && !editTitle.trim()) {
            toast(tx('Enter an item name first.', 'Ingresa un nombre primero.'), { kind: 'error' });
            return;
        }
        cancelledRef.current = false;
        setPrinting(true);
        const res = await printPrepLabel({
            location,
            slot,
            recipe: effectiveRecipe,
            preppedBy: staffName,
            shelfLifeDays,
            language,
            notes,
            byName: staffName,
            copies,
            source,
            shouldAbort: () => cancelledRef.current,
        });
        setPrinting(false);
        if (res.ok) {
            toast(tx('✓ Label printed', '✓ Etiqueta impresa'), { kind: 'success' });
            onClose?.();
        } else if (res.error === 'cancelled') {
            // User hit Cancel mid-flight — job was stopped before it
            // reached the printer; the modal is already closing.
        } else {
            const errMsg = errorToHuman(res.error, isEs);
            toast(errMsg, { kind: 'error' });
        }
    };

    // ModalPortal lifts this modal out of any backdrop-filter ancestor
    // (glass-card etc) so position:fixed lands on the viewport rather
    // than on the nearest containing block. See ModalPortal.jsx for the
    // full rationale.
    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[95vh] sm:max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between safe-top flex-shrink-0">
                    <h2 className="text-lg font-black text-dd-text">
                        🏷 {tx('Print prep label', 'Imprimir etiqueta')}
                    </h2>
                    <button onClick={cancelAndClose}
                        className="w-8 h-8 rounded-full bg-dd-bg text-dd-text-2 text-lg hover:bg-dd-line">
                        ×
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Editable item identity — only in quick-label mode.
                        Lets a receiver / cook print a date label for any
                        item without needing a recipe entry. Title becomes
                        an input; allergens become tappable chips. */}
                    {editable && (
                        <EditableIdentity
                            editTitle={editTitle}
                            editTitleEs={editTitleEs}
                            editAllergens={editAllergens}
                            setEditTitle={setEditTitle}
                            setEditTitleEs={setEditTitleEs}
                            toggleAllergen={toggleAllergen}
                            language={language}
                            isEs={isEs}
                            autoFocusTitle={!recipe?.titleEn}
                        />
                    )}

                    {/* Shelf life — quick chips + step buttons */}
                    <ShelfLifeSection
                        shelfLifeDays={shelfLifeDays}
                        setShelfLifeDays={setShelfLifeDays}
                        defaultDays={defaultDays}
                        isEs={isEs}
                    />

                    {/* Notes (optional) */}
                    <NotesField notes={notes} setNotes={setNotes} isEs={isEs} />

                    {/* Copies — Andrew 2026-05-20. One Print tap can
                        spit out N identical labels (one per container
                        in a batch). Batched into a single envelope so
                        the printer cuts in sequence. */}
                    <CopiesSection copies={copies} setCopies={setCopies} isEs={isEs} />

                    {/* Size tabs removed 2026-06-20 (Andrew "drop the size
                        tabs") — the Label Format editor in Admin is now the
                        single control for how every sticker looks. */}

                    {/* Preview — what the printer will produce */}
                    <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                            {tx('Preview (what prints)', 'Vista previa')}
                        </div>
                        <div className="bg-white border-2 border-dashed border-dd-line rounded-lg p-3 text-dd-text">
                            <LabelPreview payload={deferredPayload} />
                        </div>
                    </div>

                    {/* Slot selector REMOVED 2026-05-20 — Andrew: "the
                        label printers in the admin page i only need the
                        kitchen section for each location". Slot now
                        defaults to 'kitchen' for every print; office is
                        kept in the data layer for future re-enablement
                        but isn't surfaced to staff. setSlotPersistent
                        still exists in case admin re-enables office
                        later without a code change. */}

                    {/* Printer state strip */}
                    <div className={`rounded-lg p-2.5 text-[11px] ${
                        printerReady
                            ? 'bg-dd-sage-50 border border-dd-green/40 text-dd-green-700'
                            : 'bg-amber-50 border border-amber-300 text-amber-800'
                    }`}>
                        {printerReady ? (
                            <>
                                <span className="font-bold">🖨 {printer.name || tx('Printer ready', 'Impresora lista')}</span>
                                {isBrotherPrinter ? (
                                    <span className="ml-1.5 opacity-70">— {tx('Brother (AirPrint dialog)', 'Brother (diálogo AirPrint)')}</span>
                                ) : (
                                    <span className="ml-1.5 opacity-70">— {printer.ip}</span>
                                )}
                            </>
                        ) : (
                            <>
                                ⚠ {tx(
                                    `No ${slot} printer set up for this location. Ask admin to configure it.`,
                                    `Sin impresora de ${slot === 'kitchen' ? 'cocina' : 'oficina'}. Pídele a un admin.`,
                                )}
                            </>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="border-t border-dd-line p-3 flex gap-2 flex-shrink-0 safe-bottom">
                    <button onClick={cancelAndClose}
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
                            : <>🏷 {tx(`Print ${copies > 1 ? copies + '× ' : ''}label${copies > 1 ? 's' : ''}`, `Imprimir ${copies > 1 ? copies + '× ' : ''}etiqueta${copies > 1 ? 's' : ''}`)}</>}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── Memo'd body sections ────────────────────────────────────────────
// Andrew 2026-06-12: "the sticker page is still glitchy." The v1.0.51
// pass memoized the preview, but every keystroke / +tap still re-ran
// the ENTIRE modal body (allergen chips, size tabs, copies row, …).
// Each section is now its own memo component with stable props (the
// useState setters + useCallback handlers above), so a tap re-renders
// only the section it touched. Combined with the deferred preview,
// the urgent frame is just one small subtree.

// Editable item identity — only in quick-label mode. Lets a receiver /
// cook print a date label for any item without a recipe entry. Title
// becomes an input; allergens become tappable chips.
//
// autoFocusTitle: ONLY when the modal opened with an empty name (the
// blank quick-label path). Sticker rows arrive pre-filled — popping
// the iOS keyboard at the same instant the modal animates in was the
// single biggest "glitchy open" on the iPads, and staff rarely edit
// the pre-filled name anyway.
const EditableIdentity = memo(function EditableIdentity({
    editTitle, editTitleEs, editAllergens,
    setEditTitle, setEditTitleEs, toggleAllergen,
    language, isEs, autoFocusTitle,
}) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="space-y-2 pb-3 border-b border-dd-line">
            <label className="block">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                    {tx('Item name', 'Nombre del artículo')}
                </span>
                <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value.slice(0, 60))}
                    placeholder={tx('e.g. "Romaine Lettuce", "Beef Stock"', 'ej. "Lechuga romana"')}
                    autoFocus={autoFocusTitle}
                    className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm font-bold focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green"
                />
            </label>
            {isEs && (
                <label className="block">
                    <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                        {tx('Nombre en inglés (opcional)', 'English name (optional)')}
                    </span>
                    <input
                        type="text"
                        value={editTitleEs}
                        onChange={(e) => setEditTitleEs(e.target.value.slice(0, 60))}
                        className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green"
                    />
                </label>
            )}
            <div>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                    {tx('Allergens (tap to toggle)', 'Alérgenos (tocar para alternar)')}
                </span>
                <div className="flex flex-wrap gap-1">
                    {ALLERGEN_ORDER.map(code => {
                        const on = editAllergens.includes(code);
                        return (
                            <button key={code}
                                onClick={() => toggleAllergen(code)}
                                className={`px-2 py-1 rounded-full text-[11px] font-bold border transition ${on
                                    ? 'bg-amber-100 border-amber-400 text-amber-900'
                                    : 'bg-white border-dd-line text-dd-text-2 hover:bg-dd-bg'}`}>
                                {allergenLabel(code, language)}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
});

const ShelfLifeSection = memo(function ShelfLifeSection({ shelfLifeDays, setShelfLifeDays, defaultDays, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
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
    );
});

const NotesField = memo(function NotesField({ notes, setNotes, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
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
    );
});

const CopiesSection = memo(function CopiesSection({ copies, setCopies, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                {tx('Copies', 'Copias')}
            </label>
            <div className="flex items-center gap-2">
                <button
                    onClick={() => setCopies(c => Math.max(1, c - 1))}
                    className="w-10 h-10 rounded-lg bg-dd-bg text-dd-text font-black text-lg hover:bg-dd-line active:scale-95">
                    −
                </button>
                <div className="w-14 text-center text-2xl font-black text-dd-green">
                    {copies}
                </div>
                <button
                    onClick={() => setCopies(c => Math.min(20, c + 1))}
                    className="w-10 h-10 rounded-lg bg-dd-bg text-dd-text font-black text-lg hover:bg-dd-line active:scale-95">
                    +
                </button>
                <div className="flex gap-1 ml-auto flex-wrap">
                    {[1, 3, 5, 10].map(n => (
                        <button key={n} onClick={() => setCopies(n)}
                            className={`px-2.5 py-1 rounded text-[11px] font-bold border transition ${copies === n
                                ? 'bg-dd-green text-white border-dd-green'
                                : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                            {n}×
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
});

// Label preview — JSX with REAL relative font sizes so admin sees
// how the date dominates the sticker at a glance. Mirrors the
// renderer in src/data/labelPrinting.js:
//   • prepDateLabel ("PREPPED")     — small, bold
//   • prepDateNumber ("05/20/26")   — HUGE, black, the focal point
//   • prepTimeBig ("2:15p")         — medium
//   • title                          — medium-bold
//   • meta / allergens / ingredients — small
//   • footer (DD MAU)                — small bold
// memo: with effectiveRecipe/previewPayload stable above, copies +/-
// and other unrelated taps now skip re-rendering the preview entirely
// — it only repaints when the label content actually changes.
const LabelPreview = memo(function LabelPreview({ payload }) {
    return (
        <div className="text-center font-sans">
            {payload.prepDateLabel && (
                <div className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2">
                    {payload.prepDateLabel}
                </div>
            )}
            {payload.prepDateNumber ? (
                <div className="font-black tabular-nums text-dd-text leading-none mb-0.5"
                    style={{
                        // 8px per Epson scale unit so admin's chosen
                        // size (2..8) maps to a meaningful preview
                        // size (16..64px). Default scale 5 → 40px.
                        fontSize: `${8 * (Number(payload.dateNumberScale) || 5)}px`,
                        letterSpacing: '-1px',
                    }}>
                    {payload.prepDateNumber}
                </div>
            ) : payload.prepDateBig ? (
                <div className="font-black tabular-nums text-dd-text leading-none mb-0.5"
                    style={{ fontSize: '24px' }}>
                    {payload.prepDateBig}
                </div>
            ) : null}
            {payload.prepTimeBig && (
                <div className="text-[14px] font-bold text-dd-text-2 tabular-nums mb-1">
                    {payload.prepTimeBig}
                </div>
            )}
            <hr className="border-t border-dashed border-dd-line my-1.5" />
            {payload.titleLines && payload.titleLines.length > 0 && (
                <div className="text-[14px] font-bold text-dd-text leading-tight">
                    {payload.titleLines.map((t, i) => (
                        <div key={i}>{t}</div>
                    ))}
                </div>
            )}
            <hr className="border-t border-dotted border-dd-line my-1.5" />
            <div className="text-[11px] text-dd-text font-mono text-left leading-snug">
                {payload.metaLines && payload.metaLines.map((m, i) => (
                    <div key={i}>{m}</div>
                ))}
            </div>
            {payload.allergens && payload.allergens.length > 0 && (
                <>
                    <hr className="border-t border-dotted border-dd-line my-1.5" />
                    <div className="text-[11px] font-bold text-dd-text text-left">
                        ALLERGENS: {payload.allergens.join(', ')}
                    </div>
                </>
            )}
            {payload.ingredients && payload.ingredients.length > 0 && (
                <>
                    <hr className="border-t border-dotted border-dd-line my-1.5" />
                    <div className="text-[11px] text-dd-text text-left">
                        {payload.ingredients.map((ing, i) => (
                            <div key={i}>• {String(ing).slice(0, 30)}</div>
                        ))}
                    </div>
                </>
            )}
            {payload.notes && (
                <>
                    <hr className="border-t border-dotted border-dd-line my-1.5" />
                    <div className="text-[11px] italic text-dd-text-2 text-left">
                        {payload.notes}
                    </div>
                </>
            )}
            <hr className="border-t border-dashed border-dd-line my-1.5" />
            <div className="text-[11px] font-black tracking-wider text-dd-text">
                {payload.footer || 'DD MAU'}
            </div>
        </div>
    );
});

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
