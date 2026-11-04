// TvBackgroundLayer — the art behind the picture on an image-mode TV, and the
// editor's swatch previews. Field + labels: data/tvBackgrounds.js.
//
// Drawn with CSS gradients and inline SVG, no image files. These run on
// Raspberry Pis that have run out of memory after months of uptime, so:
//   • static by default: painted once, then nothing happens
//   • motion is a per-TV opt-in with a fixed handful of elements, CSS
//     transform animation only: no JS timers, filters, blur or layout work
//   • the scatter is computed once and is the same every render
//   • 'black' renders nothing at all, leaving the TV as it always was
//
// Colors stay muted, and the art is spread evenly so it reads on the sides of
// a portrait picture and above/below a wide one, without pulling the eye off it.
import { memo } from 'react';

const VIEW = '0 0 1600 900';
const LEAF = 'M50 2 L58 20 L68 14 L64 38 L78 28 L82 38 L96 36 L90 52 L98 58 L74 76 L78 88 L54 84 L53 112 L47 112 L46 84 L22 88 L26 76 L2 58 L10 52 L4 36 L18 38 L22 28 L36 38 L32 14 L42 20 Z';
const FLAKE = 'M50 4 V96 M10 27 L90 73 M90 27 L10 73 M50 22 L40 12 M50 22 L60 12 M50 78 L40 88 M50 78 L60 88 M18 41 L14 27 M18 41 L5 45 M82 59 L86 73 M82 59 L95 55 M82 41 L86 27 M82 41 L95 45 M18 59 L14 73 M18 59 L5 55';
const LEAF_COLORS = ['#d9702a', '#c2501f', '#e0a030', '#a63c1a', '#e88a2c', '#8f4a1c'];

// Small seeded generator: same picture on every TV and every render.
function seeded(seed) {
    let s = seed;
    return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}
function scatter(cols, rows, seed, skip) {
    const r = seeded(seed), out = [];
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const a = r(), b = r(), c = r(), d = r(), e = r();
            if (e < skip) continue;
            out.push({ x: ((col + 0.15 + a * 0.7) / cols) * 1600, y: ((row + 0.15 + b * 0.7) / rows) * 900, r: c, s: d });
        }
    }
    return out;
}

const LEAVES = scatter(9, 5, 11, 0.25).map((p, i) => ({
    x: p.x, y: p.y, rot: Math.round(p.r * 360), scale: 0.45 + p.s * 0.75,
    color: LEAF_COLORS[i % LEAF_COLORS.length], opacity: 0.6 + p.s * 0.3,
}));
const FLAKES = scatter(10, 6, 29, 0.1).map((p, i) => ({
    x: p.x, y: p.y, rot: Math.round(p.r * 60), s: p.s, big: i % 3 === 0,
}));

// Sky clouds: three overlapping soft ellipses each. A gradient that fades out
// looks soft without using blur. Percentages, so the swatch matches the TV.
const CLOUD_SPOTS = [[13, 20, 1], [84, 15, 1.1], [24, 60, 0.85], [90, 52, 1], [52, 9, 0.8], [5, 82, 0.8], [71, 84, 0.9]];
const puff = (w, h, x, y, a) =>
    `radial-gradient(ellipse ${w}% ${h}% at ${x}% ${y}%, rgba(255,255,255,${a}) 0%, rgba(255,255,255,${a * 0.75}) 45%, rgba(255,255,255,0) 100%)`;
const SKY_IMAGE = [
    ...CLOUD_SPOTS.flatMap(([x, y, k]) => [
        puff(9 * k, 7 * k, x, y, 0.85),
        puff(6 * k, 6 * k, x - 6 * k, y + 1.5 * k, 0.7),
        puff(6.5 * k, 5 * k, x + 6 * k, y + 1.5 * k, 0.7),
    ]),
    'linear-gradient(180deg, #2b78cc 0%, #5ba6e6 55%, #bfe0f8 100%)',
].join(',');

const fill = { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' };
const BACKDROP = {
    fall: { background: 'linear-gradient(165deg, #7c4319 0%, #a95d1f 48%, #6e3814 100%)' },
    snow: { background: 'linear-gradient(180deg, #1c3a5e 0%, #39678f 60%, #8fb3d1 100%)' },
    sky:  { backgroundImage: SKY_IMAGE },
};

function FallArt() {
    return (
        <svg viewBox={VIEW} preserveAspectRatio="xMidYMid slice" style={fill} aria-hidden="true">
            {LEAVES.map((l, i) => (
                <path key={i} d={LEAF} fill={l.color} opacity={l.opacity}
                    transform={`translate(${l.x.toFixed(1)} ${l.y.toFixed(1)}) rotate(${l.rot}) scale(${l.scale.toFixed(2)}) translate(-50 -50)`} />
            ))}
        </svg>
    );
}

function SnowArt() {
    return (
        <svg viewBox={VIEW} preserveAspectRatio="xMidYMid slice" style={fill} aria-hidden="true">
            <path d="M0 900 V826 Q260 782 560 822 T1120 812 T1600 800 V900 Z" fill="#e8f1f8" opacity="0.8" />
            {FLAKES.map((f, i) => f.big ? (
                <path key={i} d={FLAKE} fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity={0.45 + f.s * 0.4}
                    transform={`translate(${f.x.toFixed(1)} ${f.y.toFixed(1)}) rotate(${f.rot}) scale(${(0.3 + f.s * 0.3).toFixed(2)}) translate(-50 -50)`} />
            ) : (
                <circle key={i} cx={f.x.toFixed(1)} cy={f.y.toFixed(1)} r={(2.5 + f.s * 4).toFixed(1)} fill="#fff" opacity={0.4 + f.s * 0.45} />
            ))}
        </svg>
    );
}

// Motion: mostly on the sides, because the middle sits behind the picture. The
// keyframes end off-screen so the loop is invisible. A negative delay spreads
// them out from the first frame, with no JS involved.
const MOVER_COLUMNS = [3, 9, 15, 21, 27, 31, 69, 73, 79, 85, 91, 97];
export const MOTION_COUNTS = { fall: 10, snow: 16 };
const MOTION_CSS = `
@keyframes tv-bg-fall { from { transform: translate3d(0,-14vh,0) rotate(0deg); } to { transform: translate3d(3vw,114vh,0) rotate(300deg); } }
@keyframes tv-bg-snow { from { transform: translate3d(0,-8vh,0); } to { transform: translate3d(-2vw,108vh,0); } }
.tv-bg-mover { position: absolute; top: 0; will-change: transform; animation-timing-function: linear; animation-iteration-count: infinite; }
@media (prefers-reduced-motion: reduce) { .tv-bg-mover { display: none; } }
`;

function Movers({ kind }) {
    const n = MOTION_COUNTS[kind] || 0;
    const items = [];
    for (let i = 0; i < n; i++) {
        const k = (i * 7) % 5;                      // 0..4, repeatable variety
        const dur = 55 + k * 9;                     // 55–91 s top to bottom
        const size = kind === 'fall' ? 3 + k * 0.7 : 1 + k * 0.35;   // vmin
        items.push(
            <div key={i} className="tv-bg-mover" data-tv-bg-mover="" style={{
                left: `${MOVER_COLUMNS[(i * 5) % MOVER_COLUMNS.length]}%`,
                width: `${size}vmin`,
                height: `${size}vmin`,
                opacity: kind === 'fall' ? 0.85 : 0.75,
                animationName: kind === 'fall' ? 'tv-bg-fall' : 'tv-bg-snow',
                animationDuration: `${dur}s`,
                animationDelay: `${-((i + 0.5) / n) * dur}s`,
            }}>
                {kind === 'fall' ? (
                    <svg viewBox="0 0 100 114" style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden="true">
                        <path d={LEAF} fill={LEAF_COLORS[i % LEAF_COLORS.length]} />
                    </svg>
                ) : (
                    <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden="true">
                        {k % 2 === 0
                            ? <path d={FLAKE} fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" />
                            : <circle cx="50" cy="50" r="30" fill="#fff" />}
                    </svg>
                )}
            </div>,
        );
    }
    return (
        <>
            <style>{MOTION_CSS}</style>
            {items}
        </>
    );
}

// Takes primitives (not the config object) so memo holds across the 30-second
// clock re-renders of the page around it.
function TvBackgroundLayer({ kind, color, motion = false }) {
    if (kind !== 'color' && !BACKDROP[kind]) return null;   // black / unknown: nothing
    const style = kind === 'color' ? { backgroundColor: color } : BACKDROP[kind];
    return (
        <div data-tv-background={kind} aria-hidden="true"
            style={{ position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden', pointerEvents: 'none', contain: 'strict', ...style }}>
            {kind === 'fall' && <FallArt />}
            {kind === 'snow' && <SnowArt />}
            {motion && (kind === 'fall' || kind === 'snow') && <Movers kind={kind} />}
        </div>
    );
}

export default memo(TvBackgroundLayer);
