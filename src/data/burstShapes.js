// Starburst badge geometry — shared by PictureEditor (live SVG preview)
// and bakePictureEdits() (final canvas render) so the on-screen editor and
// the baked TV image look identical.
//
// Andrew 2026-06-07 — picture editor for image-mode TV screens: crop,
// text, and starburst callouts ("$5.99", "NEW", "SPICY").
//
// Each preset is an alternating outer/inner-radius star polygon. `points`
// is the number of spikes; `innerRatio` is how deep the valleys cut (1.0
// = a flat circle, 0.5 = sharp spikes).

export const BURST_PRESETS = {
    star: { label: 'Star',  points: 12, innerRatio: 0.50 },   // classic price burst
    seal: { label: 'Seal',  points: 24, innerRatio: 0.86 },   // scalloped wax-seal badge
    pop:  { label: 'Pop',   points: 10, innerRatio: 0.60 },   // bold comic burst
};

export const BURST_PRESET_KEYS = Object.keys(BURST_PRESETS);

// Defaults for a freshly-added burst — the classic red price star.
export const BURST_DEFAULT_FILL = '#e11d48';   // rose-600
export const BURST_DEFAULT_TEXT = '#ffffff';

// A few one-tap fill swatches offered in the editor.
export const BURST_FILL_SWATCHES = [
    '#e11d48', // red
    '#f59e0b', // amber
    '#16a34a', // green
    '#2563eb', // blue
    '#7c3aed', // violet
    '#111827', // near-black
];

// Unit polygon for a preset: points on a circle of outer radius 1, centered
// at (0,0), first spike pointing straight up. Alternates radius 1 / innerRatio.
// Returns [{x, y}, ...]. Consumed by both the SVG preview (viewBox -1..1) and
// the canvas baker (scaled by the badge radius in px).
export function burstUnitPoints(presetKey) {
    const p = BURST_PRESETS[presetKey] || BURST_PRESETS.star;
    const n = Math.max(3, p.points);
    const inner = Math.max(0.05, Math.min(1, p.innerRatio));
    const pts = [];
    const total = n * 2;
    for (let i = 0; i < total; i++) {
        const r = (i % 2 === 0) ? 1 : inner;
        const ang = (-Math.PI / 2) + (i * Math.PI / n);   // start at top, go clockwise
        pts.push({ x: Math.cos(ang) * r, y: Math.sin(ang) * r });
    }
    return pts;
}

// SVG points="" string for a preset, scaled to a unit viewBox of -1..1.
export function burstSvgPoints(presetKey) {
    return burstUnitPoints(presetKey)
        .map(pt => `${pt.x.toFixed(4)},${pt.y.toFixed(4)}`)
        .join(' ');
}
