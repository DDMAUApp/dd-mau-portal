// InventoryLayoutParts.jsx — layout helpers for the Operations inventory page
// (2026-09-23, Andrew: "make the location section easier to find every section
// like we do in sticker categories with the bubbles at the top … lets move the
// search bar at the very bottom of the screen and let it float like the menu
// bar does").
//
// Kept OUT of the 10k-line Operations component on purpose: these own their
// small bits of state (active bubble, menu open) so nothing here can re-render
// the inventory rows or touch how counts are saved.
import { memo, useEffect, useRef, useState } from 'react';
import { INVENTORY_LOCATIONS, locationLabel } from '../data/inventory';

export const UNASSIGNED_LOCATION = '(no location set)';

// Short bubble labels so the bar wraps into as few rows as possible. The full
// names still head each section below.
const LOC_SHORT = {
    'Walk-in Freezer': ['Freezer', 'Congelador'],
    'Walk-in Refrigerator': ['Walk-in', 'Refri'],
    'Pantry': ['Pantry', 'Despensa'],
    'Paper Goods': ['Paper', 'Papel'],
    'Chemicals / Dish Area': ['Chemicals', 'Químicos'],
    'Drinks': ['Drinks', 'Bebidas'],
    'Boba': ['Boba', 'Boba'],
    'Expo': ['Expo', 'Pase'],
};

const titleCase = (s) => String(s || '').replace(/\b([a-z])/g, (m) => m.toUpperCase());

/** Group key for an item's stored location. Case/space-insensitive, so
 *  "hallway" and "Hallway" (or a canonical name typed in another case) never
 *  split into two sections. Display-only: the stored value is never changed. */
export function locationGroupKey(raw, customByLower) {
    const s = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!s) return UNASSIGNED_LOCATION;
    const lower = s.toLowerCase();
    const canon = INVENTORY_LOCATIONS.find((l) => l.toLowerCase() === lower);
    if (canon) return canon;
    if (customByLower) {
        if (!customByLower.has(lower)) customByLower.set(lower, s);
        return customByLower.get(lower);
    }
    return s;
}

/** Full section title: canonical labels translate; custom ones get title case. */
export function locationTitle(loc, isEs) {
    if (INVENTORY_LOCATIONS.includes(loc)) return locationLabel(loc, isEs);
    return titleCase(loc);
}

function bubbleLabel(loc, isEs) {
    if (loc === UNASSIGNED_LOCATION) return isEs ? '⚠ Sin ubicación' : '⚠ No location';
    const s = LOC_SHORT[loc];
    return s ? (isEs ? s[1] : s[0]) : titleCase(loc);
}

/**
 * Pinned bubble bar for the Location view. Tap = JUMP to that location (the
 * whole list stays, so counting can keep walking into the next area). The
 * bubble for the location on screen lights up as you scroll.
 * sections: [{ key, total, counted }]
 */
export const InventoryLocationJumpBar = memo(function InventoryLocationJumpBar({ sections, language, onJump }) {
    const isEs = language === 'es';
    const barRef = useRef(null);
    const [active, setActive] = useState(sections[0] ? sections[0].key : null);
    const keysSig = sections.map((s) => s.key).join('|');

    // Where the list starts once the bar is pinned: bottom of the app header
    // plus this bar's own height.
    const pinnedEdge = () => {
        const header = document.querySelector('.ddmau-app-header');
        const h = header ? header.getBoundingClientRect().height : 56;
        const b = barRef.current ? barRef.current.getBoundingClientRect().height : 0;
        return h + b;
    };

    useEffect(() => {
        let raf = 0;
        const compute = () => {
            raf = 0;
            const els = document.querySelectorAll('[data-inv-loc]');
            if (!els.length) return;
            const edge = pinnedEdge() + 16;
            let cur = els[0].getAttribute('data-inv-loc');
            for (const el of els) {
                if (el.getBoundingClientRect().top <= edge) cur = el.getAttribute('data-inv-loc');
                else break;
            }
            setActive((prev) => (prev === cur ? prev : cur));
        };
        const onScroll = () => { if (!raf) raf = requestAnimationFrame(compute); };
        compute();
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        return () => {
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
            if (raf) cancelAnimationFrame(raf);
        };
    }, [keysSig]);

    const jump = (key) => {
        if (onJump) onJump(key);           // e.g. un-fold a folded section first
        setActive(key);
        const sel = `[data-inv-loc="${(window.CSS && CSS.escape) ? CSS.escape(key) : key}"]`;
        const go = () => {
            const el = document.querySelector(sel);
            if (!el) return;
            const y = el.getBoundingClientRect().top + window.scrollY - pinnedEdge() - 6;
            window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
        };
        // Once right away, then again after the rows between here and there
        // have rendered (they size themselves lazily), so we land exactly.
        // Timers as well as frames: frames can be paused (backgrounded view).
        go();
        requestAnimationFrame(() => requestAnimationFrame(go));
        setTimeout(go, 120);
        setTimeout(go, 400);
    };

    if (sections.length < 2) return null;
    return (
        <div ref={barRef} className="ddmau-inv-jumpbar sticky z-10 -mx-1 px-1 pt-1.5 pb-2 bg-dd-bg/95 backdrop-blur-sm rounded-b-xl">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label={isEs ? 'Ubicaciones' : 'Locations'}>
                {sections.map((s) => {
                    const on = active === s.key;
                    const warn = s.key === UNASSIGNED_LOCATION;
                    return (
                        <button key={s.key} type="button" role="tab" aria-selected={on}
                            onClick={() => jump(s.key)}
                            title={locationTitle(s.key, isEs)}
                            className={`px-2.5 py-[3px] rounded-full text-[11.5px] font-bold border-2 transition whitespace-nowrap active:scale-95 ${on
                                ? 'bg-mint-700 text-white border-mint-800 shadow-sm'
                                : warn
                                    ? 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
                                    : 'bg-white text-mint-800 border-mint-200 hover:bg-mint-50'}`}>
                            {bubbleLabel(s.key, isEs)}
                            <span className={`ml-1 font-semibold tabular-nums ${on ? 'text-white/85' : 'text-dd-text-2'}`}>
                                {s.counted > 0 ? `${s.counted}/${s.total}` : s.total}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
});

/**
 * "⋯" menu for the less-used inventory actions (Import CSV, Print, row
 * density, Edit list) so the view buttons fit on fewer rows.
 * items: [{ key, label, onClick, hidden }]
 */
export function InventoryMoreMenu({ items, language }) {
    const isEs = language === 'es';
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey); };
    }, [open]);
    const shown = items.filter((i) => !i.hidden);
    return (
        <div ref={ref} className="relative">
            <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
                title={isEs ? 'Más opciones' : 'More options'}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${open ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                ⋯ {isEs ? 'Más' : 'More'}
            </button>
            {open && (
                <div role="menu" className="absolute right-0 mt-1 z-30 min-w-[190px] bg-white border border-dd-line rounded-xl shadow-xl py-1">
                    {shown.map((i) => (
                        <button key={i.key} type="button" role="menuitem"
                            onClick={() => { setOpen(false); i.onClick(); }}
                            className="w-full text-left px-3 py-2 text-sm font-semibold text-dd-text hover:bg-dd-bg">
                            {i.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
