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
// The art is spread evenly so it reads on the sides of a portrait picture and
// above/below a wide one. Andrew 2026-11-04 asked for more, and more realistic.
import { memo } from 'react';

const VIEW = '0 0 1600 900';
const LEAF = 'M50 2 L58 20 L68 14 L64 38 L78 28 L82 38 L96 36 L90 52 L98 58 L74 76 L78 88 L54 84 L53 112 L47 112 L46 84 L22 88 L26 76 L2 58 L10 52 L4 36 L18 38 L22 28 L36 38 L32 14 L42 20 Z';
const OVAL = 'M50 0 C72 14 88 38 82 62 C78 80 64 92 50 100 C36 92 22 80 18 62 C12 38 28 14 50 0 Z';
const MAPLE_VEINS = 'M50 112 V8 M50 78 L8 56 M50 78 L92 56 M50 58 L22 24 M50 58 L78 24';
const OVAL_VEINS = 'M50 112 V6 M50 74 L24 56 M50 74 L76 56 M50 54 L24 34 M50 54 L76 34 M50 34 L34 18 M50 34 L66 18';
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

// Depth is what makes these read as real: many small dim ones far away, fewer
// large crisp ones up close. Static, so each is painted once and never again.
const leafLayer = (cols, rows, seed, skip, minS, maxS, minO, maxO) => scatter(cols, rows, seed, skip).map((p, i) => ({
    x: p.x, y: p.y, rot: Math.round(p.r * 360), scale: minS + p.s * (maxS - minS),
    // A leaf lying at an angle looks narrower.
    squash: 0.62 + ((i * 37) % 39) / 100,
    shape: i % 3 === 2 ? 'oval' : 'maple',
    tone: i % LEAF_TONES.length,
    opacity: minO + p.r * (maxO - minO),
}));
const LEAF_TONES = [['#f0a02c', '#c9471b'], ['#d9401f', '#8e1f12'], ['#f2c14a', '#d9781f'], ['#b5521c', '#6e2c10'], ['#e8772a', '#a8321a'], ['#c98a2b', '#7d4a17']];
const LEAVES = [
    ...leafLayer(18, 10, 11, 0.08, 0.2, 0.34, 0.5, 0.68),
    ...leafLayer(12, 7, 17, 0.08, 0.48, 0.78, 0.8, 0.95),
    ...leafLayer(7, 4, 23, 0.12, 1.0, 1.5, 1, 1),
];
const flakeLayer = (cols, rows, seed, minR, maxR, minO, maxO) => scatter(cols, rows, seed, 0.08).map((p) => ({
    x: p.x, y: p.y, r: minR + p.s * (maxR - minR), opacity: minO + p.r * (maxO - minO),
}));
const FLAKES_FAR = flakeLayer(30, 16, 29, 1.2, 2.8, 0.45, 0.8);
const FLAKES_MID = flakeLayer(18, 10, 31, 4, 8, 0.6, 0.95);
const FLAKES_NEAR = flakeLayer(8, 5, 37, 12, 24, 0.45, 0.8);

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
    fall: { background: 'radial-gradient(ellipse 80% 70% at 30% 35%, #6d4522 0%, rgba(109,69,34,0) 100%), radial-gradient(ellipse 70% 70% at 80% 75%, #5c3a1c 0%, rgba(92,58,28,0) 100%), linear-gradient(170deg, #3f2813 0%, #2e1c0d 100%)' },
    snow: { background: 'linear-gradient(180deg, #2c4158 0%, #4d6a86 45%, #8ea7bc 72%, #c9d7e2 100%)' },
    sky:  { backgroundImage: SKY_IMAGE },
};

function FallArt() {
    return (
        <svg viewBox={VIEW} preserveAspectRatio="xMidYMid slice" style={fill} aria-hidden="true">
            <defs>
                {LEAF_TONES.map(([from, to], i) => (
                    <linearGradient key={i} id={`tv-leaf-${i}`} x1="0" y1="0" x2="0.4" y2="1">
                        <stop offset="0" stopColor={from} />
                        <stop offset="1" stopColor={to} />
                    </linearGradient>
                ))}
                <g id="tv-leaf-maple">
                    <path d={LEAF} />
                    <path d={MAPLE_VEINS} fill="none" stroke="#4a1a08" strokeOpacity="0.5" strokeWidth="1.4" />
                </g>
                <g id="tv-leaf-oval">
                    <path d={OVAL} />
                    <path d={OVAL_VEINS} fill="none" stroke="#4a1a08" strokeOpacity="0.5" strokeWidth="1.4" />
                </g>
            </defs>
            {LEAVES.map((l, i) => {
                const place = `translate(${l.x.toFixed(1)} ${l.y.toFixed(1)}) rotate(${l.rot}) scale(${(l.scale * l.squash).toFixed(2)} ${l.scale.toFixed(2)}) translate(-50 -50)`;
                return (
                    <g key={i} opacity={l.opacity.toFixed(2)}>
                        {/* The big ones get a shadow on the ground. A dark copy, not a filter. */}
                        {l.scale >= 1 && <use href={`#tv-leaf-${l.shape}`} fill="#140a04" opacity="0.4"
                            transform={`translate(5 8) ${place}`} />}
                        <use href={`#tv-leaf-${l.shape}`} fill={`url(#tv-leaf-${l.tone})`} transform={place} />
                    </g>
                );
            })}
        </svg>
    );
}

function SnowArt() {
    return (
        <svg viewBox={VIEW} preserveAspectRatio="xMidYMid slice" style={fill} aria-hidden="true">
            <defs>
                <radialGradient id="tv-flake">
                    <stop offset="0" stopColor="#fff" stopOpacity="1" />
                    <stop offset="0.55" stopColor="#fff" stopOpacity="0.75" />
                    <stop offset="1" stopColor="#fff" stopOpacity="0" />
                </radialGradient>
                <linearGradient id="tv-bank" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#ffffff" />
                    <stop offset="1" stopColor="#c6d6e4" />
                </linearGradient>
            </defs>
            {/* Distant pines in the haze, then the drifts. */}
            <path d="M0 800 L40 690 L80 780 L120 660 L170 785 L215 700 L260 790 L320 650 L380 790 L430 710 L480 795 L1120 795 L1170 705 L1220 790 L1280 655 L1340 788 L1390 695 L1440 785 L1500 665 L1555 785 L1600 700 V900 H0 Z" fill="#3c566e" opacity="0.55" />
            <path d="M0 900 V820 Q240 770 560 815 T1120 800 T1600 785 V900 Z" fill="url(#tv-bank)" opacity="0.92" />
            <path d="M0 900 V868 Q380 830 800 866 T1600 846 V900 Z" fill="#f4f8fb" />
            {FLAKES_FAR.map((f, i) => (
                <circle key={i} cx={f.x.toFixed(1)} cy={f.y.toFixed(1)} r={f.r.toFixed(1)} fill="#fff" opacity={f.opacity.toFixed(2)} />
            ))}
            {FLAKES_MID.map((f, i) => (
                <circle key={i} cx={f.x.toFixed(1)} cy={f.y.toFixed(1)} r={f.r.toFixed(1)} fill="url(#tv-flake)" opacity={f.opacity.toFixed(2)} />
            ))}
            {FLAKES_NEAR.map((f, i) => (
                <circle key={i} cx={f.x.toFixed(1)} cy={f.y.toFixed(1)} r={f.r.toFixed(1)} fill="url(#tv-flake)" opacity={f.opacity.toFixed(2)} />
            ))}
        </svg>
    );
}

// Motion: mostly on the sides, because the middle sits behind the picture. The
// keyframes end off-screen so the loop is invisible. A negative delay spreads
// them out from the first frame, with no JS involved.
const MOVER_COLUMNS = [3, 9, 15, 21, 27, 31, 69, 73, 79, 85, 91, 97];
export const MOTION_COUNTS = { fall: 14, snow: 20 };
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
        const size = kind === 'fall' ? 3 + k * 0.7 : 0.8 + k * 0.5;   // vmin
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
                        <path d={MAPLE_VEINS} fill="none" stroke="#4a1a08" strokeOpacity="0.5" strokeWidth="1.6" />
                    </svg>
                ) : (
                    <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: 'radial-gradient(circle, #fff 0%, rgba(255,255,255,.75) 55%, rgba(255,255,255,0) 100%)' }} />
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
