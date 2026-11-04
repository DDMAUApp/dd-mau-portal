// tvBackgrounds.js — what shows around the picture on an image-mode TV.
//
// Andrew 2026-11-04: "right now the picture just shows in the middle and the
// sides are black. make something so we can change the color of the
// background, or add fall leaves, snow, blue skies."
//
// tv_configs/{tvId}.imageBackground = { kind, color?, motion? }. Absent or
// invalid means black, which is the TV exactly as it rendered before this
// field existed. Dayparts inherit it: there's no per-daypart background.
// The art itself lives in components/TvBackgroundLayer.jsx.

export const DEFAULT_BG_COLOR = '#14532d';

export const TV_BACKGROUNDS = [
    { id: 'black', en: 'Black',       es: 'Negro',       motion: false },
    { id: 'color', en: 'Color',       es: 'Color',       motion: false },
    { id: 'fall',  en: 'Fall leaves', es: 'Hojas',       motion: true },
    { id: 'snow',  en: 'Snow',        es: 'Nieve',       motion: true },
    { id: 'sky',   en: 'Blue sky',    es: 'Cielo azul',  motion: false },
];
const BY_ID = new Map(TV_BACKGROUNDS.map(b => [b.id, b]));
const HEX = /^#[0-9a-f]{6}$/i;

export function bgSupportsMotion(kind) {
    return BY_ID.get(kind)?.motion === true;
}

// Always returns a clean { kind, color?, motion? }. A bad kind or a bad color
// falls back to black rather than guessing, and motion only sticks to the
// kinds that have moving art, so a stray flag can't start anything on a Pi.
export function normalizeImageBackground(raw) {
    const black = { kind: 'black' };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return black;
    const def = typeof raw.kind === 'string' ? BY_ID.get(raw.kind) : null;
    if (!def || def.id === 'black') return black;
    if (def.id === 'color') {
        return typeof raw.color === 'string' && HEX.test(raw.color)
            ? { kind: 'color', color: raw.color.toLowerCase() }
            : black;
    }
    return def.motion ? { kind: def.id, motion: raw.motion === true } : { kind: def.id };
}

const same = (a, b) => a.kind === b.kind && a.color === b.color && !!a.motion === !!b.motion;

// What the editor's save payload should carry. `picked` is the editor's choice
// (null when the TV isn't in image mode), `original` is the raw field as the
// editor opened it. Returns undefined when the payload should OMIT the key.
//
// An untouched picker has to look untouched to mergeTvLiveSave, which treats
// anything different from the opened doc as this editor's change. So a TV with
// no field stays without one (writing null here would let a stale editor erase
// the background someone just picked), and an unchanged one sends its raw value.
export function imageBackgroundForSave(picked, original) {
    const next = normalizeImageBackground(picked);
    if (same(next, normalizeImageBackground(original))) {
        return original === undefined ? undefined : original;
    }
    return next.kind === 'black' ? null : next;
}
