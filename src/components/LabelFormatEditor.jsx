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

import { useEffect, useMemo, useState } from 'react';
import {
    subscribeLabelFormat, saveLabelFormat,
    DEFAULT_LABEL_FORMAT, clampLabelFormat,
} from '../data/labelFormat';
import { buildLabelPayload } from '../data/labelPrinting';
import { toast } from '../toast';

export default function LabelFormatEditor({ language = 'en', byName }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [format, setFormat] = useState({ ...DEFAULT_LABEL_FORMAT });
    const [draft, setDraft] = useState({ ...DEFAULT_LABEL_FORMAT });
    const [saving, setSaving] = useState(false);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        const unsub = subscribeLabelFormat((f) => {
            setFormat(f);
            // Only refresh draft from server if admin hasn't made
            // local edits since last save (heuristic: dirty === false).
            setDraft(prev => isDirty(prev, format) ? prev : f);
        });
        return unsub;
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
    }), [draft, isEs, byName]);

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
                                ].map(t => (
                                    <ToggleRow key={t.k}
                                        checked={draft[t.k] !== false}
                                        onChange={(v) => update({ [t.k]: v })}
                                        label={isEs ? t.es : t.en} />
                                ))}
                            </div>
                        </FieldsetCard>

                        {/* Size */}
                        <FieldsetCard title={tx('Sizes', 'Tamaños')} tx={tx}>
                            <SliderRow
                                label={tx('Date number size', 'Tamaño de fecha')}
                                value={draft.dateNumberScale}
                                onChange={(v) => update({ dateNumberScale: v })}
                                min={2} max={8} step={1}
                                hint={`Epson scale = ${draft.dateNumberScale} · Brother HTML proportional`} />
                            <SliderRow
                                label={tx('Item title size', 'Tamaño del título')}
                                value={draft.titleScale}
                                onChange={(v) => update({ titleScale: v })}
                                min={1} max={4} step={1}
                                hint={`Epson scale = ${draft.titleScale}`} />
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
                        <div className="bg-white border-2 border-dashed border-dd-line rounded-lg p-3 text-dd-text">
                            <PreviewBox payload={previewPayload} />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Mirror of LabelPreview from PrintLabelModal so the editor doesn't
// import it (avoids circular component dependencies). Kept in sync
// with the printer renderer.
function PreviewBox({ payload }) {
    const dateScale = Number(payload.dateNumberScale) || 5;
    // Map Epson scale to a CSS px size for the preview. The actual
    // printer's width=5 height=5 is HUGE — we use 8px per scale unit
    // to give admin a visceral sense without overflowing the card.
    const dateFontPx = 8 * dateScale;
    return (
        <div className="text-center font-sans">
            {payload.prepDateLabel && (
                <div className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2">
                    {payload.prepDateLabel}
                </div>
            )}
            {payload.prepDateNumber && (
                <div className="font-black tabular-nums text-dd-text leading-none mb-0.5"
                    style={{ fontSize: `${dateFontPx}px`, letterSpacing: '-1px' }}>
                    {payload.prepDateNumber}
                </div>
            )}
            {payload.prepTimeBig && (
                <div className="text-[14px] font-bold text-dd-text-2 tabular-nums mb-1">
                    {payload.prepTimeBig}
                </div>
            )}
            {payload.titleLines && payload.titleLines.length > 0 && (
                <>
                    <hr className="border-t border-dashed border-dd-line my-1.5" />
                    <div className="text-[14px] font-bold text-dd-text leading-tight">
                        {payload.titleLines.map((t, i) => <div key={i}>{t}</div>)}
                    </div>
                </>
            )}
            {payload.metaLines && payload.metaLines.length > 0 && (
                <>
                    <hr className="border-t border-dotted border-dd-line my-1.5" />
                    <div className="text-[11px] text-dd-text font-mono text-left leading-snug">
                        {payload.metaLines.map((m, i) => <div key={i}>{m}</div>)}
                    </div>
                </>
            )}
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
            {payload.footer && (
                <>
                    <hr className="border-t border-dashed border-dd-line my-1.5" />
                    <div className="text-[11px] font-black tracking-wider text-dd-text">
                        {payload.footer}
                    </div>
                </>
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
function SliderRow({ label, value, onChange, min, max, step = 1, hint }) {
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

function isDirty(draft, server) {
    if (!draft || !server) return false;
    for (const k of Object.keys(draft)) {
        if (k === 'updatedAt' || k === 'updatedBy') continue;
        if (draft[k] !== server[k]) return true;
    }
    return false;
}
