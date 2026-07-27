// LabelPrintPreviewModal — fake-print pop-up (Andrew 2026-07-27: "print a
// fake preview that pops up a window so we can see what the print will
// look like"). Draws a to-scale mock label from the SAME segment model the
// Epson renderer uses (buildLabelPreviewModel mirrors renderPrepLabelBody
// block-for-block): monospace columns, real width/height magnification,
// roll-width proportions. Used by the Label Format editor so admins can
// iterate on a category's format — including UNSAVED draft changes —
// without burning labels.
import { useMemo, useState } from 'react';
import { buildLabelPayload, buildLabelPreviewModel, resolveLabelFormatForKind } from '../data/labelPrinting';
import ModalPortal from './ModalPortal';

// Sample items per kind so the preview shows a realistic sticker for the
// category being edited. Anything not listed falls back to the bowl.
const SAMPLES = {
    chemical: { en: 'Sanitizer',  es: 'Desinfectante', hours: 4 },
    status:   { en: 'RECEIVED',   es: 'RECIBIDO',      days: 1 },
    drink:    { en: 'Thai Tea',   es: 'Té Tailandés',  days: 3 },
    protein:  { en: 'Chicken',    es: 'Pollo',         days: 3 },
    topping:  { en: 'Pickled Carrots', es: 'Zanahorias Encurtidas', days: 5 },
    sauce:    { en: 'Peanut Sauce', es: 'Salsa de Maní', days: 7 },
    broth:    { en: 'Pho Broth',  es: 'Caldo de Pho',  days: 3 },
    base:     { en: 'Vermicelli', es: 'Fideos de Arroz', days: 2 },
    side:     { en: 'Egg Rolls',  es: 'Rollitos',      days: 4 },
};
const DEFAULT_SAMPLE = { en: 'Pork Bowl', es: 'Bowl de Cerdo', days: 5, allergens: ['Soy', 'Wheat'] };

// Pixels per Font-A column at magnification 1 — sets the on-screen label
// width (58 mm / 34 cols ≈ 340 px). Monospace glyph advance ≈ 0.6 em, so
// fontSize is derived from the target char box rather than the reverse.
const PX_PER_COL = 10;

export default function LabelPrintPreviewModal({ format, kind = null, byName, isEs, onClose }) {
    const tx = (en, es) => (isEs ? es : en);
    const [widthMm, setWidthMm] = useState(58);

    const model = useMemo(() => {
        const sample = SAMPLES[kind] || DEFAULT_SAMPLE;
        const payload = buildLabelPayload({
            itemName: sample.en,
            itemNameEs: sample.es,
            prepDate: new Date(),
            shelfLifeDays: sample.days || 5,
            shelfLifeHours: sample.hours || null,
            preppedBy: byName || 'Andrew',
            location: 'Webster',
            allergens: sample.allergens || [],
            ingredients: [],
            language: isEs ? 'es' : 'en',
            notes: '',
            format: resolveLabelFormatForKind(format, kind),
            paperWidthMm: widthMm,
        });
        return buildLabelPreviewModel(payload);
    }, [format, kind, byName, isEs, widthMm]);

    const labelW = model.cols * PX_PER_COL;
    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-stone-100 rounded-2xl shadow-2xl max-h-[90vh] flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}>
                <div className="px-4 py-2.5 flex items-center justify-between gap-3 border-b border-stone-300 bg-white">
                    <div className="text-sm font-black text-dd-text">
                        🖨 {tx('Print preview', 'Vista previa de impresión')}
                        <span className="ml-2 text-[10px] font-bold text-dd-text-2 normal-case">
                            {tx('mock — nothing prints', 'simulada — no imprime nada')}
                        </span>
                    </div>
                    <div className="flex items-center gap-1">
                        {[40, 58, 80].map((mm) => (
                            <button key={mm} type="button" onClick={() => setWidthMm(mm)}
                                className={`px-2 py-1 rounded-full text-[11px] font-bold border ${widthMm === mm
                                    ? 'bg-violet-600 text-white border-violet-700'
                                    : 'bg-white text-dd-text-2 border-stone-300'}`}>
                                {mm}mm
                            </button>
                        ))}
                        <button onClick={onClose}
                            className="ml-1 w-7 h-7 rounded-full hover:bg-stone-200 flex items-center justify-center text-sm">✕</button>
                    </div>
                </div>
                <div className="flex-1 overflow-auto p-5 flex justify-center bg-stone-200/70">
                    {/* The mock label — white sticker, roll-width proportions. */}
                    <div className="bg-white rounded-sm shadow-md py-3 px-2 self-start"
                        style={{ width: `${labelW + 16}px`, minWidth: `${labelW + 16}px` }}>
                        {model.segs.map((s, i) => (
                            <div key={i}
                                className={s.center ? 'text-center' : 'text-left'}
                                style={{ overflow: 'hidden' }}>
                                <span
                                    style={{
                                        display: 'inline-block',
                                        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                                        whiteSpace: 'pre',
                                        // Char box: height tracks h, width tracks w — the
                                        // scaleX squeeze reproduces Epson's independent
                                        // width/height magnification (tall text).
                                        fontSize: `${(PX_PER_COL / 0.6) * s.h}px`,
                                        lineHeight: 1.05,
                                        fontWeight: s.em ? 800 : 400,
                                        ...(s.w !== s.h ? {
                                            transform: `scaleX(${(s.w / s.h).toFixed(3)})`,
                                            transformOrigin: s.center ? 'center' : 'left',
                                        } : {}),
                                    }}>
                                    {s.text}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
