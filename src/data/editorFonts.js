// editorFonts — curated font palette for the TV picture/menu editor's
// text tool.
//
// Andrew 2026-06-08: "in the tv photo or menu ... in the edit sections
// for that lets add a font selection. a good amount of different fonts".
//
// The palette mixes always-available web-safe fonts (Arial, Georgia,
// Courier, Impact) with a hand-picked set of Google display/script
// fonts that suit restaurant signage (Bebas Neue, Oswald, Lobster,
// Pacifico, …). Every entry carries:
//
//   key    — stable id stored on the text recipe (NEVER rename; it's
//            persisted in Firestore on each baked picture's recipe)
//   label  — short name shown in the picker
//   family — the canonical CSS family name, used to drive
//            document.fonts.load() before canvas baking
//   stack  — full CSS font-family value (family + web-safe fallback),
//            used for BOTH the live preview and the canvas ctx.font
//   weight — the weight to render at. Display/script fonts ship a
//            single weight (e.g. Bebas Neue / Anton / Lobster = 400);
//            forcing 900 there just triggers ugly faux-bold, so each
//            font declares the weight that actually looks right.
//   google — Google Fonts css2 `family=` spec (omit for web-safe).
//
// Canvas gotcha: <canvas> fillText silently falls back to a default
// face if the webfont hasn't downloaded yet. bakePictureEdits awaits
// ensureFontLoaded() for every font it's about to paint. If the CDN
// is blocked/offline the stack's web-safe fallback renders instead —
// text never disappears, it just isn't the fancy face.

export const EDITOR_FONTS = [
    { key: 'classic',  label: 'Classic',     family: 'Arial',            stack: 'Arial, "Helvetica Neue", sans-serif',          weight: 900 },
    { key: 'oswald',   label: 'Condensed',   family: 'Oswald',           stack: '"Oswald", "Arial Narrow", sans-serif',         weight: 700, google: 'Oswald:wght@500;700' },
    { key: 'bebas',    label: 'Tall Caps',   family: 'Bebas Neue',       stack: '"Bebas Neue", "Oswald", sans-serif',           weight: 400, google: 'Bebas+Neue' },
    { key: 'anton',    label: 'Heavy',       family: 'Anton',            stack: '"Anton", Impact, sans-serif',                  weight: 400, google: 'Anton' },
    { key: 'impact',   label: 'Impact',      family: 'Impact',           stack: 'Impact, "Arial Black", sans-serif',            weight: 400 },
    { key: 'bangers',  label: 'Comic',       family: 'Bangers',          stack: '"Bangers", Impact, sans-serif',                weight: 400, google: 'Bangers' },
    { key: 'fredoka',  label: 'Rounded',     family: 'Fredoka',          stack: '"Fredoka", "Trebuchet MS", sans-serif',        weight: 600, google: 'Fredoka:wght@500;600' },
    { key: 'playfair', label: 'Elegant',     family: 'Playfair Display', stack: '"Playfair Display", Georgia, serif',           weight: 800, google: 'Playfair+Display:wght@700;800' },
    { key: 'georgia',  label: 'Serif',       family: 'Georgia',          stack: 'Georgia, "Times New Roman", serif',            weight: 700 },
    { key: 'courier',  label: 'Typewriter',  family: 'Courier New',      stack: '"Courier New", Courier, monospace',            weight: 700 },
    { key: 'lobster',  label: 'Script',      family: 'Lobster',          stack: '"Lobster", cursive',                           weight: 400, google: 'Lobster' },
    { key: 'pacifico', label: 'Brush',       family: 'Pacifico',         stack: '"Pacifico", cursive',                          weight: 400, google: 'Pacifico' },
    { key: 'dancing',  label: 'Handwriting', family: 'Dancing Script',   stack: '"Dancing Script", cursive',                    weight: 700, google: 'Dancing+Script:wght@600;700' },
    { key: 'marker',   label: 'Marker',      family: 'Permanent Marker', stack: '"Permanent Marker", cursive',                  weight: 400, google: 'Permanent+Marker' },
];

export const DEFAULT_FONT_KEY = 'classic';

// Look up a font entry by key; always returns a valid entry (falls
// back to the first/default so callers never crash on a stale key).
export function getEditorFont(key) {
    return EDITOR_FONTS.find(f => f.key === key) || EDITOR_FONTS[0];
}

// Inject the single Google Fonts <link> (idempotent). Called when the
// editor opens so the picker previews + live text render in the real
// faces. Web-safe fonts need no link. Safe to call repeatedly.
let _linkInjected = false;
export function ensureEditorFontsLink() {
    if (_linkInjected || typeof document === 'undefined' || !document.head) return;
    _linkInjected = true;
    const families = EDITOR_FONTS.filter(f => f.google).map(f => `family=${f.google}`).join('&');
    if (!families) return;
    try {
        // preconnect to the font hosts for a snappier first paint
        const pre1 = document.createElement('link');
        pre1.rel = 'preconnect'; pre1.href = 'https://fonts.googleapis.com';
        const pre2 = document.createElement('link');
        pre2.rel = 'preconnect'; pre2.href = 'https://fonts.gstatic.com'; pre2.crossOrigin = 'anonymous';
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
        document.head.append(pre1, pre2, link);
    } catch {
        _linkInjected = false;   // let a later call retry
    }
}

// Ensure ONE font's face is actually downloaded before we paint it to a
// <canvas>. document.fonts.load() returns once the matching face is
// ready (or immediately for a locally-available web-safe font). Wrapped
// in a timeout so a slow/blocked CDN can never hang the Save. Returns
// the font entry so callers can read .stack/.weight.
export async function ensureFontLoaded(key, px = 64) {
    const f = getEditorFont(key);
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return f;
    // Web-safe fonts: no network face to wait on.
    if (!f.google) return f;
    ensureEditorFontsLink();
    const spec = `${f.weight || 700} ${Math.round(px) || 64}px "${f.family}"`;
    try {
        await Promise.race([
            document.fonts.load(spec),
            new Promise((res) => setTimeout(res, 2500)),
        ]);
    } catch {
        // best-effort — fall through to the stack's web-safe fallback
    }
    return f;
}

// Pre-load every distinct font used by a set of text elements, in
// parallel. Call once before a canvas bake loop. `texts[]` entries may
// carry a `.font` key; missing/unknown keys resolve to the default.
export async function ensureFontsForTexts(texts, px = 64) {
    const keys = [...new Set((texts || []).map(t => t && t.font).filter(Boolean))];
    if (keys.length === 0) return;
    try {
        await Promise.all(keys.map(k => ensureFontLoaded(k, px)));
    } catch {
        // best-effort
    }
}
