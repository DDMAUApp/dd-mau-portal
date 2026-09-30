// tvTransitions.js — image-TV slideshow transitions (MenuDisplay
// ImageModeLayout + the TV editor's picker share this list).
//
// Andrew 2026-09-29: "on the image tv i want to have more option for
// animations". The six originals (fade/cut/slide-left/slide-up/zoom/
// ken-burns) render EXACTLY as before; new ones need to know which slide is
// LEAVING (push/wipe/circle/flip), so each slide gets a role:
//   'current' — on screen now
//   'prev'    — the slide that was just on screen (animating out)
//   'idle'    — everything else (parked, hidden)
// Styles are plain inline-style objects (no CSS file to keep in sync).

export const TV_TRANSITIONS = [
    { id: 'fade',        icon: '🌊', en: 'Fade',          es: 'Atenuar' },
    { id: 'cut',         icon: '✂️', en: 'Cut',           es: 'Corte' },
    { id: 'slide-left',  icon: '⏩', en: 'Slide L→R',     es: 'Desliz I→D' },
    { id: 'slide-right', icon: '⏪', en: 'Slide R→L',     es: 'Desliz D→I' },
    { id: 'slide-up',    icon: '⬆️', en: 'Slide up',      es: 'Desliz arriba' },
    { id: 'slide-down',  icon: '⬇️', en: 'Slide down',    es: 'Desliz abajo' },
    { id: 'push-left',   icon: '👉', en: 'Push',          es: 'Empujar' },
    { id: 'push-up',     icon: '👆', en: 'Push up',       es: 'Empujar arriba' },
    { id: 'zoom',        icon: '🔍', en: 'Zoom in',       es: 'Acercar' },
    { id: 'zoom-out',    icon: '🔭', en: 'Zoom out',      es: 'Alejar' },
    { id: 'blur',        icon: '💨', en: 'Blur',          es: 'Desenfoque' },
    { id: 'wipe',        icon: '🧽', en: 'Wipe',          es: 'Barrido' },
    { id: 'circle',      icon: '⭕', en: 'Circle reveal', es: 'Círculo' },
    { id: 'flip',        icon: '🃏', en: 'Flip',          es: 'Voltear' },
    { id: 'ken-burns',   icon: '🎬', en: 'Ken Burns',     es: 'Ken Burns' },
    { id: 'random',      icon: '🎲', en: 'Random mix',    es: 'Mezcla' },
];
const KNOWN = new Set(TV_TRANSITIONS.map(t => t.id));

// 'random' picks a different look on every slide change (deterministic per
// change number so every render of the same change agrees). Ken Burns and
// cut are left out — one needs the whole dwell, the other isn't a look.
export const RANDOM_POOL = ['fade', 'slide-left', 'slide-up', 'push-left', 'push-up', 'zoom', 'zoom-out', 'blur', 'wipe', 'circle', 'flip'];
export function resolveTransition(mode, changeN = 0) {
    const m = KNOWN.has(mode) ? mode : 'fade';
    if (m !== 'random') return m;
    const n = Math.abs(Math.floor(Number(changeN) || 0));
    // Knuth multiplicative hash so consecutive changes don't walk the pool in order.
    return RANDOM_POOL[((n * 2654435761) >>> 0) % RANDOM_POOL.length];
}

const EASE = 'cubic-bezier(0.4,0,0.2,1)';

// Inline style for one slide. `ms` = transition duration.
export function tvSlideStyle(mode, role, ms) {
    const cur = role === 'current';
    const prev = role === 'prev';
    const t = Math.max(100, Math.min(3000, Number(ms) || 700));
    const z = cur ? 2 : prev ? 1 : 0;
    const base = { zIndex: z };
    switch (mode) {
        // ── originals (unchanged look: prev + idle behave the same) ──
        case 'cut':
            return { ...base, opacity: cur ? 1 : 0, transition: 'none' };
        case 'slide-left':
            return { ...base, opacity: cur ? 1 : 0, transform: cur ? 'translateX(0)' : 'translateX(100%)', transition: `opacity ${t}ms ease, transform ${t}ms ${EASE}` };
        case 'slide-up':
            return { ...base, opacity: cur ? 1 : 0, transform: cur ? 'translateY(0)' : 'translateY(100%)', transition: `opacity ${t}ms ease, transform ${t}ms ${EASE}` };
        case 'zoom':
            return { ...base, opacity: cur ? 1 : 0, transform: cur ? 'scale(1)' : 'scale(0.92)', transition: `opacity ${t}ms ease, transform ${t}ms ${EASE}` };
        case 'ken-burns':
        case 'fade':
            return { ...base, opacity: cur ? 1 : 0, transition: `opacity ${t}ms ease` };
        // ── new ──
        case 'slide-right':
            return { ...base, opacity: cur ? 1 : 0, transform: cur ? 'translateX(0)' : 'translateX(-100%)', transition: `opacity ${t}ms ease, transform ${t}ms ${EASE}` };
        case 'slide-down':
            return { ...base, opacity: cur ? 1 : 0, transform: cur ? 'translateY(0)' : 'translateY(-100%)', transition: `opacity ${t}ms ease, transform ${t}ms ${EASE}` };
        case 'push-left':
            // New slide pushes the old one off to the left; waiting slides
            // park off the right edge without animating.
            if (cur) return { ...base, opacity: 1, transform: 'translateX(0)', transition: `transform ${t}ms ${EASE}` };
            if (prev) return { ...base, opacity: 1, transform: 'translateX(-100%)', transition: `transform ${t}ms ${EASE}` };
            return { ...base, opacity: 0, transform: 'translateX(100%)', transition: 'none' };
        case 'push-up':
            if (cur) return { ...base, opacity: 1, transform: 'translateY(0)', transition: `transform ${t}ms ${EASE}` };
            if (prev) return { ...base, opacity: 1, transform: 'translateY(-100%)', transition: `transform ${t}ms ${EASE}` };
            return { ...base, opacity: 0, transform: 'translateY(100%)', transition: 'none' };
        case 'zoom-out':
            return { ...base, opacity: cur ? 1 : 0, transform: cur ? 'scale(1)' : 'scale(1.15)', transition: `opacity ${t}ms ease, transform ${t}ms ${EASE}` };
        case 'blur':
            return { ...base, opacity: cur ? 1 : 0, filter: cur ? 'blur(0px)' : 'blur(24px)', transition: `opacity ${t}ms ease, filter ${t}ms ease` };
        case 'wipe':
            // New slide is revealed right→left OVER the old one, which stays
            // put underneath until it's covered.
            if (cur) return { ...base, opacity: 1, clipPath: 'inset(0 0 0 0)', transition: `clip-path ${t}ms ${EASE}` };
            if (prev) return { ...base, opacity: 1, clipPath: 'inset(0 0 0 0)', transition: 'none' };
            return { ...base, opacity: 0, clipPath: 'inset(0 0 0 100%)', transition: 'none' };
        case 'circle':
            if (cur) return { ...base, opacity: 1, clipPath: 'circle(75% at 50% 50%)', transition: `clip-path ${t}ms ${EASE}` };
            if (prev) return { ...base, opacity: 1, clipPath: 'circle(75% at 50% 50%)', transition: 'none' };
            return { ...base, opacity: 0, clipPath: 'circle(0% at 50% 50%)', transition: 'none' };
        case 'flip': {
            // Card flip: the old slide turns away to edge-on in the first
            // half, the new one turns in from edge-on in the second half.
            // Rotation alone hides each slide at 90° (no opacity tricks —
            // a delayed opacity transition hid the old slide instantly).
            const half = Math.round(t / 2);
            if (cur) return { ...base, opacity: 1, transform: 'perspective(1600px) rotateY(0deg)', transition: `transform ${half}ms ease-out ${half}ms` };
            if (prev) return { ...base, opacity: 1, transform: 'perspective(1600px) rotateY(90deg)', transition: `transform ${half}ms ease-in` };
            return { ...base, opacity: 0, transform: 'perspective(1600px) rotateY(-90deg)', transition: 'none' };
        }
        default:
            return { ...base, opacity: cur ? 1 : 0, transition: `opacity ${t}ms ease` };
    }
}
