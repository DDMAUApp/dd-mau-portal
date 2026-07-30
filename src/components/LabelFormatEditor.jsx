// LabelFormatEditor — admin section for customizing the date sticker
// label format globally.
//
// Andrew 2026-05-20: "make a label edit button so i can go in and
// edit all the labels format at once".
//
// Edits /config/label_format. Every print path reads from this so
// changes apply to:
//   • Epson XML labels (printPrepLabel + testPrint)
//   • Brother HTML labels (via the same buildLabelPayload)
//   • PrintLabelModal preview
//   • Free-text labels via PrintCenter
// Live preview on the right updates as admin toggles fields.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
    subscribeLabelFormat, saveLabelFormat,
    DEFAULT_LABEL_FORMAT, clampLabelFormat,
} from '../data/labelFormat';
import { buildLabelPayload, buildLabelPreviewModel } from '../data/labelPrinting';
import { toast } from '../toast';
import LabelPrintPreviewModal, { LabelMock } from './LabelPrintPreviewModal';

// Categories that can carry a per-kind override — [kind, EN label, ES
// label]. `kind` matches the sticker rows' kind field (the color family
// on the sticker page), which rides on the recipe into every print.
const KIND_FORMAT_TARGETS = [
    ['chemical', '🧪 Chemicals / Sanitizer', '🧪 Químicos / Desinfectante'],
    ['status',   '⚠️ Status labels (RECEIVED…)', '⚠️ Etiquetas de estado'],
    ['drink',    '🧋 Drinks', '🧋 Bebidas'],
    ['protein',  '🥩 Proteins', '🥩 Proteínas'],
    ['topping',  '🥬 Veggies & Toppings', '🥬 Verduras'],
    ['sauce',    '🥢 Sauces & Dressings', '🥢 Salsas'],
    ['broth',    '🍲 Broths & Stocks', '🍲 Caldos'],
    ['base',     '🍜 Noodles & Rice', '🍜 Fideos y Arroz'],
    ['side',     '🥟 Made Ahead / Sides', '🥟 Pre-Hechos'],
    ['other',    '📦 Other', '📦 Otros'],
];

export default function LabelFormatEditor({ language = 'en', byName, startExpanded = false }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [format, setFormat] = useState({ ...DEFAULT_LABEL_FORMAT });
    const [draft, setDraft] = useState({ ...DEFAULT_LABEL_FORMAT });
    const [saving, setSaving] = useState(false);
    // 2026-07-29 — admin hub reorg: AdminPanel now opens each tool full-screen
    // from a tile grid; startExpanded lets the tool view mount pre-expanded
    // (default false keeps the old collapsed-header behavior everywhere else).
    const [expanded, setExpanded] = useState(startExpanded);
    // Per-category overrides (Andrew 2026-07-26): which kind is being
    // edited in the "Per-category" card below.
    const [kindSel, setKindSel] = useState('chemical');
    // Fake-print preview pop-up (2026-07-27) — null closed, or the kind
    // being previewed ('__all__' = no per-kind override; audit R6: the old
    // 'base' sentinel COLLIDED with the real 'base' kind, Noodles & Rice,
    // so its override card previewed the default format). Previews the
    // DRAFT (unsaved edits included) so the admin iterates without printing.
    const [printPreview, setPrintPreview] = useState(null);

    // Latest SERVER format, readable inside the once-mounted subscription
    // below. 2026-07-27 audit finding #2: the old callback compared the
    // draft against `format` captured on MOUNT (always the defaults), so
    // once the saved config differed from defaults the draft NEVER
    // re-synced — another admin's save spontaneously lit "Unsaved" here,
    // and tapping Save then clobbered their change with this stale draft.
    const serverFmtRef = useRef(format);
    useEffect(() => {
        const unsub = subscribeLabelFormat((f) => {
            setFormat(f);
            // Only refresh draft from server if admin hasn't made
            // local edits since the LAST server value (dirty === false).
            setDraft(prev => isDirty(prev, serverFmtRef.current) ? prev : f);
            serverFmtRef.current = f;
        });
        return unsub;
    }, []);

    const dirty = isDirty(draft, format);

    const update = (patch) => setDraft(d => ({ ...d, ...patch }));

    const save = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await saveLabelFormat({ format: clampLabelFormat(draft), byName });
            toast(tx('✓ Saved · every label uses the new format', '✓ Guardado'), { kind: 'success' });
        } catch (e) {
            console.warn('saveLabelFormat failed:', e);
            toast(tx('Save failed: ', 'Error: ') + (e?.message || ''), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const resetToDefaults = () => {
        if (!window.confirm(tx('Reset all label format fields to defaults?', '¿Restaurar valores por defecto?'))) return;
        setDraft({ ...DEFAULT_LABEL_FORMAT });
    };

    // Build a live preview payload using the current draft. Mirrors
    // a typical "Pork Bowl" print so admin sees the layout.
    const previewPayload = useMemo(() => buildLabelPayload({
        itemName: 'Pork Bowl',
        itemNameEs: 'Bowl de Cerdo',
        prepDate: new Date(),
        shelfLifeDays: draft.defaultShelfLifeDays || 5,
        preppedBy: byName || 'Andrew',
        location: 'Webster',
        allergens: ['Soy', 'Wheat'],
        ingredients: ['Lemongrass marinade', 'Rice or vermicelli'],
        language: isEs ? 'es' : 'en',
        notes: '',
        format: clampLabelFormat(draft),
        paperWidthMm: 58,
    }), [draft, isEs, byName]);
    // Render via the SAME segment model the printer uses (2026-07-27
    // audit #3: the old hand-rolled PreviewBox ignored most knobs — the
    // new sliders visibly did nothing in the live preview).
    const previewModel = useMemo(() => buildLabelPreviewModel(previewPayload), [previewPayload]);

    return (
        <div className="mt-6 mb-4 bg-white border-2 border-violet-200 rounded-xl p-4">
            <button onClick={() => setExpanded(v => !v)}
                className="w-full flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-2xl">🏷</span>
                    <h3 className="text-base font-bold text-violet-900">
                        {tx('Label format (every sticker)', 'Formato de etiqueta')}
                    </h3>
                    {dirty && (
                        <span className="text-[10px] font-bold text-amber-800 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded-full">
                            • {tx('Unsaved', 'Sin guardar')}
                        </span>
                    )}
                </div>
                <span className="text-violet-700 text-sm font-bold">{expanded ? '▼' : '▶'}</span>
            </button>
            <p className="text-[11px] text-violet-700 mb-3 leading-snug">
                {tx(
                    'One place to control how every date sticker looks. Toggle sections on/off, resize the date number + title, change the "PREPPED" label text, switch date / time formats. Changes apply to every print (Epson + Brother + Print Center preview).',
                    'Un solo lugar para controlar cada etiqueta. Apaga secciones, cambia tamaños, edita el texto "HECHO", formatos de fecha/hora.',
                )}
            </p>

            {!expanded ? (
                <p className="text-[10px] text-violet-700/70 italic px-2">
                    {tx('Click the chevron to open the editor.', 'Toca el chevron para abrir.')}
                </p>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Form */}
                    <div className="space-y-3">
                        {/* Sections */}
                        <FieldsetCard title={tx('Sections (show / hide)', 'Secciones')} tx={tx}>
                            <div className="grid grid-cols-2 gap-1.5">
                                {[
                                    { k: 'showPreppedLabel', en: 'PREPPED label',  es: 'Etiqueta HECHO' },
                                    { k: 'showTime',         en: 'Time',            es: 'Hora' },
                                    { k: 'showTitle',        en: 'Item title',      es: 'Título' },
                                    { k: 'showUseBy',        en: 'Use by',          es: 'Caduca' },
                                    { k: 'showByName',       en: 'Prepped by',      es: 'Hecho por' },
                                    { k: 'showLocation',     en: 'Location',        es: 'Ubicación' },
                                    { k: 'showAllergens',    en: 'Allergens',       es: 'Alérgenos' },
                                    { k: 'showIngredients',  en: 'Ingredients',     es: 'Ingredientes' },
                                    { k: 'showNotes',        en: 'Notes',           es: 'Notas' },
                                    { k: 'showFooter',       en: 'Footer (DD MAU)', es: 'Pie' },
                                    { k: 'showUseByBand',    en: 'Use-by band (SAT)', es: 'Banda de caducidad' },
                                    { k: 'showDividers',     en: 'Divider lines',   es: 'Líneas divisoras' },
                                ].map(t => (
                                    <ToggleRow key={t.k}
                                        checked={draft[t.k] !== false}
                                        onChange={(v) => update({ [t.k]: v })}
                                        label={isEs ? t.es : t.en} />
                                ))}
                            </div>
                        </FieldsetCard>

                        {/* Sizes — 2026-07-27 "every text editable" (Andrew:
                            "make every text from the top to bottom editable
                            for size to bold to italic, font and so on"): one
                            row per printed block, each with a size stepper +
                            a compact B (bold) chip. No italic / font pickers
                            — the TM-L100's ePOS-Print XML has neither. */}
                        <FieldsetCard title={tx('Sizes & bold (every line)', 'Tamaños y negrita (cada línea)')} tx={tx}>
                            <p className="text-[10px] text-dd-text-2 leading-snug mb-1">
                                {tx(
                                    'Every printed line, top to bottom. B = bold. (No italic — the Epson label printer can\'t print it.)',
                                    'Cada línea impresa. B = negrita. (Sin cursiva — la impresora Epson no la imprime.)',
                                )}
                            </p>
                            <SliderRow
                                label={tx('Item title size', 'Tamaño del título')}
                                value={draft.titleScale}
                                onChange={(v) => update({ titleScale: v })}
                                min={1} max={8} step={1}
                                boldChecked={draft.titleBold === true}
                                onBoldChange={(v) => update({ titleBold: v })}
                                hint={tx(
                                    `Epson scale = ${draft.titleScale} · long names auto-shrink to fit the roll`,
                                    `Escala Epson = ${draft.titleScale} · nombres largos se reducen para caber`,
                                )} />
                            {/* Only meaningful when the both-languages toggle is on
                                (Format card) — shown always so the control is
                                discoverable; Andrew 2026-07-27: "the sticker item
                                name in spanish needs a size format too". */}
                            <SliderRow
                                label={tx('Translated name size (2nd language)', 'Tamaño del nombre traducido (2º idioma)')}
                                value={draft.title2Scale ?? 2}
                                onChange={(v) => update({ title2Scale: v })}
                                min={1} max={6} step={1}
                                boldChecked={draft.title2Bold === true}
                                onBoldChange={(v) => update({ title2Bold: v })}
                                hint={tx('The smaller second-language line under the item name', 'La línea del nombre en el otro idioma')} />
                            <SliderRow
                                label={tx('Date number size', 'Tamaño de fecha')}
                                value={draft.dateNumberScale}
                                onChange={(v) => update({ dateNumberScale: v })}
                                min={2} max={8} step={1}
                                boldChecked={draft.dateBold !== false}
                                onBoldChange={(v) => update({ dateBold: v })}
                                hint={`Epson scale = ${draft.dateNumberScale} · Brother HTML proportional`} />
                            <SliderRow
                                label={tx('Time size (under the date)', 'Tamaño de la hora')}
                                value={draft.timeScale ?? 2}
                                onChange={(v) => update({ timeScale: v })}
                                min={1} max={4} step={1}
                                boldChecked={draft.timeBold === true}
                                onBoldChange={(v) => update({ timeBold: v })} />
                            <SliderRow
                                label={tx('Info lines size (Use by / By / Loc)', 'Tamaño de líneas de info')}
                                value={draft.metaScale ?? 1}
                                onChange={(v) => update({ metaScale: v })}
                                min={1} max={3} step={1}
                                boldChecked={draft.metaBold === true}
                                onBoldChange={(v) => update({ metaBold: v })} />
                            <SliderRow
                                label={tx('Use-by band size (SAT / discard time)', 'Tamaño de banda de caducidad')}
                                value={draft.useByBandScale ?? 4}
                                onChange={(v) => update({ useByBandScale: v })}
                                min={2} max={8} step={1}
                                boldChecked={draft.bandBold !== false}
                                onBoldChange={(v) => update({ bandBold: v })}
                                hint={tx('The big weekday / discard-time line near the bottom', 'La línea grande de día / hora de descarte')} />
                            <SliderRow
                                label={tx('Allergens size', 'Tamaño de alérgenos')}
                                value={draft.allergensScale ?? 1}
                                onChange={(v) => update({ allergensScale: v })}
                                min={1} max={3} step={1}
                                boldChecked={draft.allergensBold !== false}
                                onBoldChange={(v) => update({ allergensBold: v })} />
                            <SliderRow
                                label={tx('Ingredients size', 'Tamaño de ingredientes')}
                                value={draft.ingredientsScale ?? 1}
                                onChange={(v) => update({ ingredientsScale: v })}
                                min={1} max={3} step={1}
                                boldChecked={draft.ingredientsBold === true}
                                onBoldChange={(v) => update({ ingredientsBold: v })} />
                            <SliderRow
                                label={tx('Notes size', 'Tamaño de notas')}
                                value={draft.notesScale ?? 1}
                                onChange={(v) => update({ notesScale: v })}
                                min={1} max={3} step={1}
                                boldChecked={draft.notesBold === true}
                                onBoldChange={(v) => update({ notesBold: v })} />
                            <SliderRow
                                label={tx('Footer size (DD MAU)', 'Tamaño del pie (DD MAU)')}
                                value={draft.footerScale ?? 1}
                                onChange={(v) => update({ footerScale: v })}
                                min={1} max={3} step={1}
                                boldChecked={draft.footerBold !== false}
                                onBoldChange={(v) => update({ footerBold: v })} />
                        </FieldsetCard>

                        {/* Per-category overrides — Andrew 2026-07-26: "change
                            certain stickers to be formatted differently —
                            sanitizers with the item name larger, maybe turn
                            the whole sticker 90 degrees". Each override only
                            touches labels of that category (kind). */}
                        <FieldsetCard title={tx('Per-category format', 'Formato por categoría')} tx={tx}>
                            <p className="text-[10px] text-dd-text-2 leading-snug mb-2">
                                {tx(
                                    'Give one category its own look — e.g. Sanitizer labels with the item name huge at the top. Categories without an override use the settings above.',
                                    'Dale a una categoría su propio estilo — p. ej. etiquetas de Desinfectante con el nombre enorme arriba. Sin ajuste, usan la configuración general.',
                                )}
                            </p>
                            <SelectRow
                                label={tx('Category', 'Categoría')}
                                value={kindSel}
                                onChange={setKindSel}
                                options={KIND_FORMAT_TARGETS.map(([k, en, es]) => ({ v: k, label: isEs ? es : en }))} />
                            {(() => {
                                const ov = draft.kindFormats?.[kindSel];
                                const setKind = (patch) => {
                                    const next = { ...(draft.kindFormats || {}) };
                                    next[kindSel] = { ...(next[kindSel] || {}), ...patch };
                                    // Strip fields explicitly set undefined.
                                    for (const [k, v] of Object.entries(next[kindSel])) {
                                        if (v === undefined) delete next[kindSel][k];
                                    }
                                    update({ kindFormats: next });
                                };
                                const removeKind = () => {
                                    const next = { ...(draft.kindFormats || {}) };
                                    delete next[kindSel];
                                    update({ kindFormats: next });
                                };
                                if (!ov) {
                                    return (
                                        <button type="button" onClick={() => setKind({ layout: 'nameFirst', titleScale: 6 })}
                                            className="mt-2 w-full py-2 rounded-lg border-2 border-dashed border-violet-300 text-violet-700 text-xs font-bold hover:bg-violet-50">
                                            + {tx('Customize this category', 'Personalizar esta categoría')}
                                        </button>
                                    );
                                }
                                return (
                                    <div className="mt-2 space-y-2 rounded-lg border border-violet-200 bg-violet-50/40 p-2">
                                        <SelectRow
                                            label={tx('Layout', 'Diseño')}
                                            value={ov.layout === 'nameFirst' ? 'nameFirst' : 'standard'}
                                            onChange={(v) => setKind({ layout: v === 'nameFirst' ? 'nameFirst' : undefined })}
                                            options={[
                                                { v: 'standard', label: tx('Standard (big date first)', 'Estándar (fecha grande arriba)') },
                                                { v: 'nameFirst', label: tx('Big item NAME first', 'NOMBRE grande arriba') },
                                            ]} />
                                        <SliderRow
                                            label={tx('Item title size (this category)', 'Tamaño del título (esta categoría)')}
                                            value={ov.titleScale ?? draft.titleScale}
                                            onChange={(v) => setKind({ titleScale: v })}
                                            min={1} max={8} step={1}
                                            hint={tx('Long names print TALL to reach this size (width auto-fits the roll)', 'Nombres largos se imprimen ALTOS (el ancho se ajusta al rollo)')} />
                                        <SliderRow
                                            label={tx('Date size (this category)', 'Tamaño de fecha (esta categoría)')}
                                            value={ov.dateNumberScale ?? draft.dateNumberScale}
                                            onChange={(v) => setKind({ dateNumberScale: v })}
                                            min={2} max={8} step={1} />
                                        <ToggleRow
                                            checked={ov.showUseByBand !== false}
                                            onChange={(v) => setKind({ showUseByBand: v ? undefined : false })}
                                            label={tx('Giant use-by band (THU / discard time)', 'Banda grande de caducidad (JUE / hora)')} />
                                        {ov.showUseByBand !== false && (
                                            <SliderRow
                                                label={tx('Use-by band size (this category)', 'Tamaño de banda (esta categoría)')}
                                                value={ov.useByBandScale ?? draft.useByBandScale ?? 4}
                                                onChange={(v) => setKind({ useByBandScale: v })}
                                                min={2} max={8} step={1} />
                                        )}
                                        <button type="button" onClick={() => setPrintPreview(kindSel)}
                                            className="w-full py-2 rounded-lg bg-white border-2 border-violet-300 text-violet-700 text-xs font-bold hover:bg-violet-50 active:scale-95">
                                            🖨 {tx('Preview a print (uses your unsaved edits)', 'Vista previa (incluye cambios sin guardar)')}
                                        </button>
                                        <button type="button" onClick={save} disabled={saving}
                                            className="w-full py-2 rounded-lg bg-violet-600 text-white text-xs font-bold disabled:opacity-40 active:scale-95">
                                            {saving ? tx('Saving…', 'Guardando…') : tx('💾 Save category format', '💾 Guardar formato de categoría')}
                                        </button>
                                        <button type="button" onClick={removeKind}
                                            className="w-full py-1.5 rounded-lg bg-white border border-red-300 text-red-700 text-[11px] font-bold hover:bg-red-50">
                                            {tx('Remove override (use default format)', 'Quitar ajuste (usar formato general)')}
                                        </button>
                                    </div>
                                );
                            })()}
                        </FieldsetCard>

                        {/* Text content */}
                        <FieldsetCard title={tx('Text overrides', 'Texto')} tx={tx}>
                            <div className="grid grid-cols-2 gap-2">
                                <TextRow
                                    label={tx('"PREPPED" (EN)', '"HECHO" (EN)')}
                                    value={draft.preppedLabelTextEn || ''}
                                    onChange={(v) => update({ preppedLabelTextEn: v })}
                                    placeholder="PREPPED" />
                                <TextRow
                                    label={tx('"PREPPED" (ES)', '"HECHO" (ES)')}
                                    value={draft.preppedLabelTextEs || ''}
                                    onChange={(v) => update({ preppedLabelTextEs: v })}
                                    placeholder="HECHO" />
                            </div>
                            <div className="grid grid-cols-2 gap-2 mt-2">
                                <TextRow
                                    label={tx('"Use by" (EN)', '"Use by" (EN)')}
                                    value={draft.useByLabelTextEn || ''}
                                    onChange={(v) => update({ useByLabelTextEn: v })}
                                    placeholder="Use by" />
                                <TextRow
                                    label={tx('"Use by" (ES)', '"Caduca" (ES)')}
                                    value={draft.useByLabelTextEs || ''}
                                    onChange={(v) => update({ useByLabelTextEs: v })}
                                    placeholder="Caduca" />
                            </div>
                            <TextRow
                                label={tx('Footer text', 'Texto del pie')}
                                value={draft.footerText || ''}
                                onChange={(v) => update({ footerText: v })}
                                placeholder="DD MAU" />
                        </FieldsetCard>

                        {/* Format */}
                        <FieldsetCard title={tx('Format', 'Formato')} tx={tx}>
                            <SelectRow
                                label={tx('Date format', 'Formato de fecha')}
                                value={draft.dateFormat || 'mm/dd/yy'}
                                onChange={(v) => update({ dateFormat: v })}
                                options={[
                                    { v: 'mm/dd/yy', label: 'MM/DD/YY (US)' },
                                    { v: 'dd/mm/yy', label: 'DD/MM/YY (International)' },
                                ]} />
                            <SelectRow
                                label={tx('Time format', 'Formato de hora')}
                                value={draft.timeFormat || '12h'}
                                onChange={(v) => update({ timeFormat: v })}
                                options={[
                                    { v: '12h', label: '12-hour (2:15p)' },
                                    { v: '24h', label: '24-hour (14:15)' },
                                ]} />
                            <ToggleRow
                                checked={draft.showUseByWeekday !== false}
                                onChange={(v) => update({ showUseByWeekday: v })}
                                label={tx('Show weekday on use-by line (Wed)', 'Mostrar día de la semana')} />
                            <ToggleRow
                                checked={draft.showTitleTranslation === true}
                                onChange={(v) => update({ showTitleTranslation: v })}
                                label={tx('Item name in BOTH languages (EN + ES)', 'Nombre en AMBOS idiomas (EN + ES)')} />
                            <div className="grid grid-cols-2 gap-2 mt-1">
                                <NumberRow
                                    label={tx('Default shelf life (days)', 'Caducidad por defecto')}
                                    value={draft.defaultShelfLifeDays}
                                    onChange={(v) => update({ defaultShelfLifeDays: v })}
                                    min={1} max={30} />
                            </div>
                        </FieldsetCard>

                        {/* Actions — NOT sticky: a sticky bg-white bar
                            pinned to the scroll-container bottom sat on top
                            of the toggles/steppers and swallowed taps in the
                            WebView (Andrew 2026-06-20 "controls don't respond"). */}
                        <div className="flex gap-2 pt-2">
                            <button onClick={resetToDefaults}
                                className="px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-700 text-xs font-bold hover:bg-stone-50">
                                {tx('Reset to defaults', 'Restaurar')}
                            </button>
                            <button onClick={() => setPrintPreview('__all__')}
                                className="px-3 py-2 rounded-lg bg-white border-2 border-violet-300 text-violet-700 text-xs font-bold hover:bg-violet-50">
                                🖨 {tx('Preview', 'Vista previa')}
                            </button>
                            <button onClick={save} disabled={saving || !dirty}
                                className="flex-1 py-2 rounded-lg bg-violet-600 text-white text-sm font-bold hover:bg-violet-700 disabled:opacity-40">
                                {saving ? tx('Saving…', 'Guardando…') : tx('Save & apply to all labels', 'Guardar')}
                            </button>
                        </div>
                    </div>

                    {/* Live preview */}
                    <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-violet-800 mb-1.5">
                            {tx('Live preview', 'Vista previa')}
                        </div>
                        <div className="bg-stone-200/70 border-2 border-dashed border-dd-line rounded-lg p-3 flex justify-center">
                            <LabelMock model={previewModel} pxPerCol={8} />
                        </div>
                    </div>
                </div>
            )}
            {printPreview && (
                <LabelPrintPreviewModal
                    format={clampLabelFormat(draft)}
                    kind={printPreview === '__all__' ? null : printPreview}
                    byName={byName}
                    isEs={isEs}
                    onClose={() => setPrintPreview(null)}
                />
            )}
        </div>
    );
}


function FieldsetCard({ title, children }) {
    return (
        <div className="border border-violet-200 rounded-lg p-2.5 bg-violet-50/40">
            <div className="text-[10px] font-black uppercase tracking-widest text-violet-800 mb-1.5">
                {title}
            </div>
            <div className="space-y-1.5">{children}</div>
        </div>
    );
}

// Button-based toggle (not a native <input type="checkbox">). Andrew
// 2026-06-20: the native checkboxes + range sliders "don't respond at
// all" in the iOS/Android WebView. Tappable <button>s with a big hit
// target are the app's proven pattern (allergen chips, size tabs) and
// work reliably on every device. aria-pressed keeps it accessible.
function ToggleRow({ checked, onChange, label }) {
    return (
        <button
            type="button"
            onClick={() => onChange(!checked)}
            aria-pressed={checked}
            className={`flex items-center justify-between gap-2 w-full px-2.5 py-2 rounded-lg border text-[11px] font-bold transition active:scale-95 ${checked
                ? 'bg-violet-600 border-violet-700 text-white'
                : 'bg-white border-dd-line text-dd-text-2 hover:bg-dd-bg'}`}
        >
            <span className="text-left leading-tight">{label}</span>
            <span className={`flex-shrink-0 w-9 h-5 rounded-full relative transition ${checked ? 'bg-white/30' : 'bg-dd-line'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
            </span>
        </button>
    );
}

// −/+ stepper (not a native <input type="range">). Same reasoning as
// ToggleRow — range sliders are the single most unreliable control in
// a mobile WebView; the −/value/+ stepper mirrors the shelf-life /
// copies steppers staff already use without trouble. min/max/step are
// honored; onChange still receives a Number so callers are unchanged.
// 2026-07-27 "every text editable": optional compact bold chip ("B")
// rendered right after the +/− stepper — pass boldChecked + onBoldChange
// to show it. Button-based like ToggleRow (native checkboxes are
// unreliable in the WebView). There is deliberately NO italic chip: the
// Epson TM-L100's ePOS-Print XML has no italic attribute, so italic
// can't print.
function SliderRow({ label, value, onChange, min, max, step = 1, hint, boldChecked, onBoldChange }) {
    const v = Number(value);
    const dec = () => onChange(Math.max(min, v - step));
    const inc = () => onChange(Math.min(max, v + step));
    return (
        <div className="block">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold text-dd-text-2 leading-tight">{label}</span>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button type="button" onClick={dec} disabled={v <= min}
                        aria-label="decrease"
                        className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text font-black text-lg leading-none disabled:opacity-30 hover:bg-dd-line active:scale-95">
                        −
                    </button>
                    <span className="w-6 text-center text-sm font-black text-violet-700 tabular-nums">{v}</span>
                    <button type="button" onClick={inc} disabled={v >= max}
                        aria-label="increase"
                        className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text font-black text-lg leading-none disabled:opacity-30 hover:bg-dd-line active:scale-95">
                        +
                    </button>
                    {onBoldChange && (
                        <button type="button"
                            onClick={() => onBoldChange(!boldChecked)}
                            aria-pressed={!!boldChecked}
                            aria-label="bold"
                            className={`w-8 h-8 rounded-lg border font-black text-sm leading-none transition active:scale-95 ${boldChecked
                                ? 'bg-violet-600 border-violet-700 text-white'
                                : 'bg-white border-dd-line text-dd-text-2 hover:bg-dd-bg'}`}>
                            B
                        </button>
                    )}
                </div>
            </div>
            {hint && <div className="text-[9px] text-dd-text-2/70 italic mt-0.5">{hint}</div>}
        </div>
    );
}

function TextRow({ label, value, onChange, placeholder }) {
    return (
        <label className="block">
            <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                {label}
            </span>
            <input type="text" value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                maxLength={50}
                className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white" />
        </label>
    );
}

function NumberRow({ label, value, onChange, min, max }) {
    return (
        <label className="block">
            <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                {label}
            </span>
            <input type="number" value={value} min={min} max={max} step={1}
                onChange={(e) => onChange(Number(e.target.value))}
                className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white font-mono" />
        </label>
    );
}

function SelectRow({ label, value, onChange, options }) {
    return (
        <label className="block">
            <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                {label}
            </span>
            <select value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white">
                {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
        </label>
    );
}

// 2026-07-27 audit R7: plain JSON.stringify is key-order sensitive and
// Firestore echoes maps back with SORTED keys — after a save the draft's
// insertion order differed from the server round-trip, so "Unsaved" stuck
// forever. Sort keys recursively so equal values always compare equal.
function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort()
        .map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function isDirty(draft, server) {
    if (!draft || !server) return false;
    for (const k of Object.keys(draft)) {
        if (k === 'updatedAt' || k === 'updatedBy') continue;
        const a = draft[k], b = server[k];
        // Object fields (kindFormats) compare by VALUE — identity compare
        // would flag "Unsaved" forever after the first per-category edit.
        if (typeof a === 'object' || typeof b === 'object') {
            if (stableStringify(a ?? null) !== stableStringify(b ?? null)) return true;
        } else if (a !== b) {
            return true;
        }
    }
    return false;
}
