// PictureEditor — in-app editor for a single image-mode TV picture.
// Crop (16:9), drop TEXT, and STARBURST callouts ("$5.99", "NEW", "SPICY").
//
// Andrew 2026-06-07: "the webster tv 3 is just pictures — make each picture
// editable, crop, add words, starbursts."
//
// Design (mirrors HitZoneEditor):
//   • Edits are stored as a non-destructive RECIPE { crop, texts[], bursts[] }
//     in ORIGINAL-image fractions, plus the originalUrl. On Save we bake the
//     recipe into a flat PNG (bakePictureEdits) and hand back the new URL +
//     recipe. Reopening loads the original + recipe so nothing is ever lost.
//   • The stage shows the ORIGINAL image at all times; the crop is drawn as a
//     bright frame with the outside dimmed (that's what the TV will show).
//     Text/burst elements sit at their original-fraction anchors directly on
//     the image, so there's no coordinate drift when the crop changes.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { bakePictureEdits } from '../data/menuImageUpload';
import {
    BURST_PRESETS, BURST_PRESET_KEYS, BURST_DEFAULT_FILL, BURST_DEFAULT_TEXT,
    BURST_FILL_SWATCHES, burstSvgPoints,
} from '../data/burstShapes';
import { EDITOR_FONTS, DEFAULT_FONT_KEY, getEditorFont, ensureEditorFontsLink } from '../data/editorFonts';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

const TV_ASPECT = 16 / 9;
let _uid = 0;
const nextId = () => `el_${Date.now()}_${_uid++}`;
const TEXT_SWATCHES = ['#ffffff', '#111827', '#fde047', '#ef4444', '#16a34a', '#2563eb'];

export default function PictureEditor({
    imageUrl,
    originalUrl,
    initialRecipe = null,
    slugPrefix = 'pic',
    onSave,
    onClose,
    language = 'en',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // The true source we bake from (the unedited picture).
    const src = originalUrl || imageUrl;

    const [crop, setCrop] = useState(initialRecipe?.crop || null);
    const [texts, setTexts] = useState(() => (initialRecipe?.texts || []).map(t => ({ id: nextId(), ...t })));
    const [bursts, setBursts] = useState(() => (initialRecipe?.bursts || []).map(b => ({ id: nextId(), ...b })));
    const [tool, setTool] = useState('select');         // 'select' | 'crop'
    const [selId, setSelId] = useState(null);
    const [saving, setSaving] = useState(false);
    const [cropDraft, setCropDraft] = useState(null);   // { x, y, w, h } during a crop drag
    const [disp, setDisp] = useState({ w: 0, h: 0 });   // displayed image px size
    const [natAspect, setNatAspect] = useState(TV_ASPECT);

    const imgRef = useRef(null);
    const stageRef = useRef(null);
    const dragRef = useRef(null);                        // active drag descriptor

    // Andrew 2026-06-10: on touchscreens, tapping a text to MOVE it used to
    // autofocus the inspector textarea → on-screen keyboard popped up and
    // shrank the photo. Now the keyboard only opens for a JUST-ADDED element
    // (you do want to type its words right away); selecting an existing one
    // to drag never steals focus, and grabbing any element dismisses an open
    // keyboard so the full photo is visible while you position it.
    const [freshId, setFreshId] = useState(null);
    const freshInputRef = useRef(null);
    // useLayoutEffect, NOT useEffect — layout effects run synchronously in
    // the same discrete-event commit as the Add-button tap, keeping focus()
    // inside the user-gesture stack so iOS actually opens the keyboard
    // (a passive effect runs after paint, where WebKit may focus silently).
    useLayoutEffect(() => {
        if (freshId && selId === freshId && freshInputRef.current) {
            freshInputRef.current.focus();
            freshInputRef.current.select?.();
        }
    }, [freshId, selId]);
    // Only TEXT-ENTRY fields summon the on-screen keyboard. The inspector is
    // full of inputs that don't (range sliders, checkboxes, color pickers) —
    // blurring those is fine, but they must not trigger the "tap only
    // dismisses the keyboard" touch path.
    const dismissKeyboard = () => {
        const a = document.activeElement;
        if (!a) return false;
        const isTextEntry = a.tagName === 'TEXTAREA'
            || (a.tagName === 'INPUT' && /^(text|search|tel|url|email|password|number)$/i.test(a.type || 'text'));
        if (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') a.blur();
        return isTextEntry;
    };

    // Pull in the Google display/script fonts once the editor opens so the
    // picker chips + live text render in their real faces (web-safe fonts
    // need nothing). Idempotent across re-opens.
    useEffect(() => { ensureEditorFontsLink(); }, []);

    // ── displayed-size tracking (for on-screen font/badge sizing) ──
    useEffect(() => {
        const el = imgRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => {
            const r = el.getBoundingClientRect();
            setDisp({ w: r.width, h: r.height });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const onImgLoad = () => {
        const el = imgRef.current;
        if (!el) return;
        if (el.naturalHeight > 0) setNatAspect(el.naturalWidth / el.naturalHeight);
        const r = el.getBoundingClientRect();
        setDisp({ w: r.width, h: r.height });
    };

    // pointer → fraction (0..1) of the displayed image
    const frac = (e) => {
        const r = imgRef.current?.getBoundingClientRect();
        if (!r || !r.width || !r.height) return null;
        return {
            x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
            y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
        };
    };

    const center = () => crop
        ? { x: crop.x + crop.w / 2, y: crop.y + crop.h / 2 }
        : { x: 0.5, y: 0.5 };

    // ── element helpers ────────────────────────────────────────
    const selectedText = texts.find(t => t.id === selId) || null;
    const selectedBurst = bursts.find(b => b.id === selId) || null;

    const updateText = (id, patch) => setTexts(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
    const updateBurst = (id, patch) => setBursts(prev => prev.map(b => b.id === id ? { ...b, ...patch } : b));
    const deleteSelected = () => {
        if (selectedText) setTexts(prev => prev.filter(t => t.id !== selId));
        if (selectedBurst) setBursts(prev => prev.filter(b => b.id !== selId));
        setSelId(null);
    };

    const addText = () => {
        const c = center();
        const t = { id: nextId(), x: c.x, y: c.y, text: tx('NEW', 'NUEVO'), size: 0.08, color: '#ffffff', align: 'center', outline: true, font: DEFAULT_FONT_KEY };
        setTexts(prev => [...prev, t]);
        setSelId(t.id); setFreshId(t.id); setTool('select');
    };
    const addBurst = (shape = 'star') => {
        const c = center();
        const b = { id: nextId(), x: c.x, y: c.y, size: 0.24, shape, fill: BURST_DEFAULT_FILL, textColor: BURST_DEFAULT_TEXT, text: '$5' };
        setBursts(prev => [...prev, b]);
        setSelId(b.id); setFreshId(b.id); setTool('select');
    };

    // ── pointer handlers on the stage ──────────────────────────
    const onPointerDown = (e) => {
        const elId = e.target?.dataset?.elid;
        if (tool === 'crop') {
            const f = frac(e); if (!f) return;
            dragRef.current = { kind: 'crop', start: f };
            setCropDraft({ x: f.x, y: f.y, w: 0, h: 0 });
            try { stageRef.current?.setPointerCapture?.(e.pointerId); } catch {}
            return;
        }
        if (elId) {
            setFreshId(null);
            // pointerType of THIS gesture, not matchMedia('pointer: coarse')
            // (which reflects the primary pointer — wrong on a touchscreen
            // laptop where a mouse is attached but the finger is dragging).
            const isTouch = e.pointerType === 'touch';
            // If the on-screen keyboard is open, a TOUCH tap just dismisses it —
            // closing the keyboard resizes the WebView mid-gesture, which would
            // shift the image rect under the finger and corrupt the drag. Select
            // the element and let the NEXT tap do the moving. (Mouse/pen have no
            // keyboard resize, so there we blur and drag in the same gesture.)
            if (dismissKeyboard() && isTouch) {
                setSelId(elId);
                e.stopPropagation();
                return;
            }
            const f = frac(e); if (!f) return;
            const t = texts.find(x => x.id === elId);
            const b = bursts.find(x => x.id === elId);
            const anchor = t || b;
            if (!anchor) return;
            // TOUCH: selId is set on RELEASE — on mobile the inspector panel
            // mounts when selId is set, which reflows the stage mid-drag and
            // makes the dragged element jump (frac() reads the moved rect).
            // MOUSE/PEN: select immediately (the desktop sidebar is always
            // rendered, so no reflow — and the ring should track the click).
            if (!isTouch) setSelId(elId);
            dragRef.current = { kind: 'move', id: elId, dx: f.x - anchor.x, dy: f.y - anchor.y, deferSelect: isTouch };
            try { stageRef.current?.setPointerCapture?.(e.pointerId); } catch {}
            e.stopPropagation();
            return;
        }
        // clicked empty image → deselect
        dismissKeyboard();
        dragRef.current = null;
        setSelId(null);
        setFreshId(null);
    };

    const onPointerMove = (e) => {
        const d = dragRef.current;
        if (!d) return;
        const f = frac(e); if (!f) return;
        if (d.kind === 'crop') {
            // freeform width from the drag; height locked to 16:9 of OUTPUT.
            let x = Math.min(d.start.x, f.x);
            let w = Math.abs(f.x - d.start.x);
            // output 16:9 → crop.h = crop.w * natAspect / TV_ASPECT (in frac units)
            let h = w * natAspect / TV_ASPECT;
            // anchor vertically from the drag start, following drag direction
            let y = f.y >= d.start.y ? d.start.y : d.start.y - h;
            // clamp into the image
            if (y < 0) y = 0;
            if (y + h > 1) { h = 1 - y; w = h * TV_ASPECT / natAspect; }
            if (x + w > 1) { w = 1 - x; h = w * natAspect / TV_ASPECT; }
            setCropDraft({ x, y, w, h });
        } else if (d.kind === 'move') {
            const nx = Math.max(0, Math.min(1, f.x - d.dx));
            const ny = Math.max(0, Math.min(1, f.y - d.dy));
            if (texts.some(t => t.id === d.id)) updateText(d.id, { x: nx, y: ny });
            else updateBurst(d.id, { x: nx, y: ny });
        }
    };

    // Shared by pointerup AND pointercancel (system edge gesture, palm
    // rejection) so a cancelled tap still lands the selection. The existence
    // check guards a multi-touch edge: finger 2 can hit the inspector's
    // Delete mid-drag — re-selecting a deleted id would strand the mobile
    // inspector on an empty panel.
    const commitDeferredSelect = (d) => {
        if (d?.kind !== 'move' || !d.deferSelect) return;
        if (texts.some(t => t.id === d.id) || bursts.some(b => b.id === d.id)) setSelId(d.id);
    };

    const onPointerCancel = () => {
        const d = dragRef.current;
        dragRef.current = null;
        commitDeferredSelect(d);
        if (d?.kind === 'crop') setCropDraft(null);
    };

    const onPointerUp = () => {
        const d = dragRef.current;
        dragRef.current = null;
        commitDeferredSelect(d);
        if (d?.kind === 'crop' && cropDraft) {
            if (cropDraft.w > 0.04 && cropDraft.h > 0.04) {
                setCrop({
                    x: +cropDraft.x.toFixed(4), y: +cropDraft.y.toFixed(4),
                    w: +cropDraft.w.toFixed(4), h: +cropDraft.h.toFixed(4),
                });
            }
            setCropDraft(null);
            setTool('select');
        }
    };

    // ── save / bake ────────────────────────────────────────────
    const save = async () => {
        setSaving(true);
        try {
            const recipeTexts = texts.map(({ id, ...rest }) => rest).filter(t => String(t.text || '').trim());
            const recipeBursts = bursts.map(({ id, ...rest }) => rest);
            const newUrl = await bakePictureEdits({
                originalUrl: src, crop, texts: recipeTexts, bursts: recipeBursts, slugPrefix,
            });
            onSave(newUrl, { originalUrl: src, crop: crop || null, texts: recipeTexts, bursts: recipeBursts });
            toast(tx('✓ Picture saved', '✓ Imagen guardada'), { kind: 'success' });
            onClose();
        } catch (err) {
            console.warn('bakePictureEdits failed:', err);
            toast(tx(`Save failed: ${err?.message || 'unknown'}`, `Error: ${err?.message || ''}`), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    // on-screen px size of a height-fraction
    const pxH = (f) => Math.max(2, (f || 0) * (disp.h || 0));
    const liveCrop = cropDraft || crop;

    return (
        <ModalPortal onBackPress={onClose}>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-3 bg-black/70"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            {/* Full-screen on phones/tablets so the photo gets every pixel;
                floating card with rounded corners on desktop. */}
            <div className="bg-white rounded-none sm:rounded-2xl w-full max-w-6xl h-[100dvh] sm:h-auto sm:max-h-[96vh] flex flex-col overflow-hidden shadow-2xl">
                {/* Header */}
                <header className="bg-violet-600 text-white px-4 py-3 safe-top flex items-center justify-between flex-shrink-0">
                    <div>
                        <div className="text-base font-black">🖼 {tx('Edit picture', 'Editar imagen')}</div>
                        <div className="text-[11px] opacity-90">
                            {tx('Crop to 16:9, add words & starbursts. Drag to move; click to select.',
                                'Recorta 16:9, agrega texto y estrellas. Arrastra para mover; clic para seleccionar.')}
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 text-lg font-black">✕</button>
                </header>

                {/* Toolbar */}
                <div className="flex items-center gap-1.5 px-3 py-2 bg-dd-bg border-b border-dd-line flex-shrink-0 flex-wrap">
                    <button onClick={() => { setTool('select'); }}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border ${tool === 'select' ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-dd-text border-dd-line hover:bg-dd-bg'}`}>
                        ↖ {tx('Select', 'Seleccionar')}
                    </button>
                    <button onClick={() => { setTool('crop'); setSelId(null); }}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border ${tool === 'crop' ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-dd-text border-dd-line hover:bg-dd-bg'}`}>
                        ⛶ {tx('Crop 16:9', 'Recortar')}
                    </button>
                    {crop && (
                        <button onClick={() => setCrop(null)}
                            className="px-2 py-1.5 rounded-lg text-xs font-bold bg-white text-red-600 border border-red-200 hover:bg-red-50">
                            ⟲ {tx('Reset crop', 'Quitar recorte')}
                        </button>
                    )}
                    <span className="w-px h-6 bg-dd-line mx-1" />
                    <button onClick={addText}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-white text-dd-text border border-dd-line hover:bg-dd-bg">
                        ＋ {tx('Text', 'Texto')}
                    </button>
                    {BURST_PRESET_KEYS.map(k => (
                        <button key={k} onClick={() => addBurst(k)}
                            title={`${tx('Add', 'Agregar')} ${BURST_PRESETS[k].label}`}
                            className="px-2 py-1.5 rounded-lg text-xs font-bold bg-white text-dd-text border border-dd-line hover:bg-dd-bg flex items-center gap-1">
                            <svg viewBox="-1.15 -1.15 2.3 2.3" className="w-4 h-4"><polygon points={burstSvgPoints(k)} fill="#e11d48" /></svg>
                            {BURST_PRESETS[k].label}
                        </button>
                    ))}
                </div>

                <div className="flex-1 flex flex-col sm:flex-row min-h-0">
                    {/* Stage */}
                    <div className="flex-1 overflow-auto p-4 bg-stone-800 flex items-center justify-center min-h-0">
                        {src ? (
                            <div ref={stageRef}
                                className="relative inline-block select-none touch-none"
                                style={{ cursor: tool === 'crop' ? 'crosshair' : 'default' }}
                                onPointerDown={onPointerDown}
                                onPointerMove={onPointerMove}
                                onPointerUp={onPointerUp}
                                onPointerCancel={onPointerCancel}>
                                <img ref={imgRef} src={src} alt="picture" draggable={false} onLoad={onImgLoad}
                                    className="block max-w-full max-h-[50vh] sm:max-h-[74vh]" />

                                {/* Crop dim overlays (outside = darkened) */}
                                {liveCrop && (
                                    <>
                                        <div className="absolute bg-black/55 pointer-events-none" style={{ left: 0, top: 0, width: '100%', height: `${liveCrop.y * 100}%` }} />
                                        <div className="absolute bg-black/55 pointer-events-none" style={{ left: 0, top: `${(liveCrop.y + liveCrop.h) * 100}%`, width: '100%', bottom: 0 }} />
                                        <div className="absolute bg-black/55 pointer-events-none" style={{ left: 0, top: `${liveCrop.y * 100}%`, width: `${liveCrop.x * 100}%`, height: `${liveCrop.h * 100}%` }} />
                                        <div className="absolute bg-black/55 pointer-events-none" style={{ left: `${(liveCrop.x + liveCrop.w) * 100}%`, top: `${liveCrop.y * 100}%`, right: 0, height: `${liveCrop.h * 100}%` }} />
                                        <div className="absolute border-2 border-white/90 pointer-events-none" style={{ left: `${liveCrop.x * 100}%`, top: `${liveCrop.y * 100}%`, width: `${liveCrop.w * 100}%`, height: `${liveCrop.h * 100}%` }} />
                                    </>
                                )}

                                {/* Text elements */}
                                {texts.map(t => {
                                    const f = getEditorFont(t.font);
                                    return (
                                    <div key={t.id} data-elid={t.id}
                                        className={`absolute whitespace-pre text-center leading-tight ${selId === t.id ? 'ring-2 ring-violet-400' : ''}`}
                                        style={{
                                            left: `${t.x * 100}%`, top: `${t.y * 100}%`,
                                            transform: 'translate(-50%,-50%)',
                                            fontFamily: f.stack,
                                            fontWeight: t.weight || f.weight || 900,
                                            fontSize: `${pxH(t.size)}px`,
                                            color: t.color || '#fff',
                                            textShadow: t.outline === false ? 'none' : '0 0 2px rgba(0,0,0,.9), 0 1px 3px rgba(0,0,0,.7)',
                                            WebkitTextStroke: t.outline === false ? undefined : `${Math.max(1, pxH(t.size) * 0.05)}px rgba(0,0,0,.55)`,
                                            cursor: tool === 'crop' ? 'crosshair' : 'move',
                                            padding: '2px',
                                        }}>
                                        {t.text || ' '}
                                    </div>
                                    );
                                })}

                                {/* Burst elements */}
                                {bursts.map(b => {
                                    const d = pxH(b.size);
                                    return (
                                        <div key={b.id} data-elid={b.id}
                                            className={`absolute ${selId === b.id ? 'ring-2 ring-violet-400 rounded-full' : ''}`}
                                            style={{
                                                left: `${b.x * 100}%`, top: `${b.y * 100}%`,
                                                width: `${d}px`, height: `${d}px`,
                                                transform: 'translate(-50%,-50%)',
                                                cursor: tool === 'crop' ? 'crosshair' : 'move',
                                            }}>
                                            <svg viewBox="-1.15 -1.15 2.3 2.3" className="w-full h-full pointer-events-none overflow-visible">
                                                <polygon points={burstSvgPoints(b.shape || 'star')} fill={b.fill || BURST_DEFAULT_FILL} stroke="rgba(0,0,0,.18)" strokeWidth="0.04" strokeLinejoin="round" />
                                                {String(b.text || '').trim() && (
                                                    <text x="0" y="0" textAnchor="middle" dominantBaseline="central"
                                                        fontWeight="900" fontFamily="Arial, sans-serif"
                                                        fontSize={Math.min(0.5, 0.95 / Math.max(1, String(b.text).length * 0.62))}
                                                        fill={b.textColor || BURST_DEFAULT_TEXT}>
                                                        {b.text}
                                                    </text>
                                                )}
                                            </svg>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-stone-300 text-sm">{tx('No image.', 'Sin imagen.')}</div>
                        )}
                    </div>

                    {/* Inspector — desktop: right sidebar (always shown). Mobile: a
                        bottom panel that appears whenever an element is selected.
                        Adding Text/Starburst auto-selects, so it pops up ready to
                        edit — this is where you type the words / price. */}
                    <div className={`w-full sm:w-64 flex-shrink-0 border-t sm:border-t-0 sm:border-l border-dd-line bg-white overflow-y-auto p-3 max-h-[44vh] sm:max-h-none ${selId ? 'block' : 'hidden'} sm:block`}>
                        {!selId && (
                            <div className="text-[12px] text-dd-text-2 leading-relaxed">
                                <p className="font-bold text-dd-text mb-1">{tx('No element selected', 'Nada seleccionado')}</p>
                                <p>{tx('Use the toolbar to crop, add text, or add a starburst — then click it here to edit.',
                                    'Usa la barra para recortar, agregar texto o una estrella — luego haz clic para editar.')}</p>
                            </div>
                        )}

                        {/* Text inspector */}
                        {selectedText && (
                            <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-black uppercase tracking-wider text-violet-700">{tx('Text', 'Texto')}</span>
                                    <button onClick={deleteSelected} className="text-[11px] font-bold text-red-600 hover:underline">🗑 {tx('Delete', 'Borrar')}</button>
                                </div>
                                <textarea value={selectedText.text}
                                    onChange={(e) => updateText(selId, { text: e.target.value })}
                                    rows={2} ref={freshInputRef}
                                    placeholder={tx('Type your words…', 'Escribe tus palabras…')}
                                    className="w-full px-2 py-1.5 rounded border border-dd-line text-base resize-none focus:outline-none focus:ring-2 focus:ring-violet-300" />
                                <div>
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{tx('Font', 'Fuente')}</span>
                                    <div className="grid grid-cols-2 gap-1.5 mt-1">
                                        {EDITOR_FONTS.map(f => {
                                            const sel = (selectedText.font || DEFAULT_FONT_KEY) === f.key;
                                            return (
                                                <button key={f.key} onClick={() => updateText(selId, { font: f.key })}
                                                    title={f.label}
                                                    className={`px-2 py-2 rounded-lg border truncate transition ${sel ? 'border-violet-600 bg-violet-50 ring-1 ring-violet-300' : 'border-dd-line bg-white hover:bg-dd-bg'}`}
                                                    style={{ fontFamily: f.stack, fontWeight: f.weight, fontSize: '15px', lineHeight: 1 }}>
                                                    {f.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                <label className="block">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{tx('Size', 'Tamaño')}</span>
                                    <input type="range" min="0.02" max="0.30" step="0.005"
                                        value={selectedText.size}
                                        onChange={(e) => updateText(selId, { size: parseFloat(e.target.value) })}
                                        className="w-full accent-violet-600" />
                                </label>
                                <div>
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{tx('Color', 'Color')}</span>
                                    <div className="flex flex-wrap gap-1.5 mt-1">
                                        {TEXT_SWATCHES.map(c => (
                                            <button key={c} onClick={() => updateText(selId, { color: c })}
                                                className={`w-6 h-6 rounded-full border-2 ${selectedText.color === c ? 'border-violet-600' : 'border-white'} shadow`}
                                                style={{ background: c }} />
                                        ))}
                                        <input type="color" value={selectedText.color || '#ffffff'}
                                            onChange={(e) => updateText(selId, { color: e.target.value })}
                                            className="w-6 h-6 rounded-full overflow-hidden border-0 p-0 bg-transparent cursor-pointer" />
                                    </div>
                                </div>
                                <label className="flex items-center gap-2 text-[12px] font-bold text-dd-text">
                                    <input type="checkbox" checked={selectedText.outline !== false}
                                        onChange={(e) => updateText(selId, { outline: e.target.checked })}
                                        className="accent-violet-600" />
                                    {tx('Dark outline (readable on photos)', 'Contorno oscuro (legible)')}
                                </label>
                            </div>
                        )}

                        {/* Burst inspector */}
                        {selectedBurst && (
                            <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-black uppercase tracking-wider text-violet-700">{tx('Starburst', 'Estrella')}</span>
                                    <button onClick={deleteSelected} className="text-[11px] font-bold text-red-600 hover:underline">🗑 {tx('Delete', 'Borrar')}</button>
                                </div>
                                <input type="text" value={selectedBurst.text} ref={freshInputRef}
                                    onChange={(e) => updateBurst(selId, { text: e.target.value })}
                                    placeholder={tx('e.g. $5.99', 'ej. $5.99')}
                                    className="w-full px-2 py-1.5 rounded border border-dd-line text-base font-bold text-center focus:outline-none focus:ring-2 focus:ring-violet-300" />
                                <div>
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{tx('Shape', 'Forma')}</span>
                                    <div className="flex gap-1.5 mt-1">
                                        {BURST_PRESET_KEYS.map(k => (
                                            <button key={k} onClick={() => updateBurst(selId, { shape: k })}
                                                className={`flex-1 py-1 rounded border ${selectedBurst.shape === k ? 'border-violet-600 bg-violet-50' : 'border-dd-line bg-white'}`}>
                                                <svg viewBox="-1.15 -1.15 2.3 2.3" className="w-6 h-6 mx-auto"><polygon points={burstSvgPoints(k)} fill={selectedBurst.fill || '#e11d48'} /></svg>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{tx('Fill', 'Relleno')}</span>
                                    <div className="flex flex-wrap gap-1.5 mt-1">
                                        {BURST_FILL_SWATCHES.map(c => (
                                            <button key={c} onClick={() => updateBurst(selId, { fill: c })}
                                                className={`w-6 h-6 rounded-full border-2 ${selectedBurst.fill === c ? 'border-violet-600' : 'border-white'} shadow`}
                                                style={{ background: c }} />
                                        ))}
                                        <input type="color" value={selectedBurst.fill || BURST_DEFAULT_FILL}
                                            onChange={(e) => updateBurst(selId, { fill: e.target.value })}
                                            className="w-6 h-6 rounded-full overflow-hidden border-0 p-0 bg-transparent cursor-pointer" />
                                    </div>
                                </div>
                                <div>
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{tx('Text color', 'Color de texto')}</span>
                                    <div className="flex gap-1.5 mt-1">
                                        {['#ffffff', '#111827', '#fde047'].map(c => (
                                            <button key={c} onClick={() => updateBurst(selId, { textColor: c })}
                                                className={`w-6 h-6 rounded-full border-2 ${selectedBurst.textColor === c ? 'border-violet-600' : 'border-white'} shadow`}
                                                style={{ background: c }} />
                                        ))}
                                    </div>
                                </div>
                                <label className="block">
                                    <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{tx('Size', 'Tamaño')}</span>
                                    <input type="range" min="0.08" max="0.6" step="0.01"
                                        value={selectedBurst.size}
                                        onChange={(e) => updateBurst(selId, { size: parseFloat(e.target.value) })}
                                        className="w-full accent-violet-600" />
                                </label>
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <footer className="border-t border-dd-line p-3 flex items-center gap-2 flex-shrink-0">
                    <span className="text-[11px] text-dd-text-2">
                        {texts.length} {tx('text', 'texto')} · {bursts.length} {tx('starburst', 'estrella')}{crop ? ` · ${tx('cropped', 'recortado')}` : ''}
                    </span>
                    <button onClick={onClose} disabled={saving}
                        className="ml-auto px-4 py-2 rounded-lg bg-white border border-dd-line text-dd-text font-bold hover:bg-dd-bg disabled:opacity-40">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={save} disabled={saving || !src}
                        className="px-5 py-2 rounded-lg bg-violet-600 text-white font-bold hover:bg-violet-700 disabled:opacity-60">
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save picture', 'Guardar')}
                    </button>
                </footer>
            </div>
        </div>
        </ModalPortal>
    );
}
