// RiceTempWheel — the rolling temperature wheel on the rice screen.
//
// Andrew 2026-11-03: a cook rolls to the probe reading instead of typing it.
// Plain CSS scroll-snap, no library and no native plugin, so it ships over the
// air. It lives inside a scrolling modal, so overscroll is contained: a roll
// that hits the end of the wheel doesn't start moving the page under it.
//
// The start number is NOT a reading. The parent's Print stays locked until
// onChange fires, which only happens when a person does something:
//   • rolling (touch, mouse wheel, arrow keys, tapping another number)
//     reports setBy 'rolled'
//   • tapping the centered number, for when the probe matches it exactly,
//     reports setBy 'tapped'
// Placing the wheel in code (mounting, or a new resetKey) never reports.
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';

const ITEM_H = 52;
// Five rows on a tablet, three on a short phone, so the print buttons stay
// close without scrolling the modal.
const visibleRows = () => (typeof window !== 'undefined' && window.innerHeight < 740 ? 3 : 5);

const WheelItem = memo(function WheelItem({ value, centered, danger, onTap }) {
    return (
        <button
            type="button"
            tabIndex={-1}
            onClick={() => onTap(value)}
            style={{ height: ITEM_H, scrollSnapAlign: 'center' }}
            className={`block w-full select-none tabular-nums leading-none font-black ${
                centered ? 'text-4xl' : 'text-2xl opacity-60'
            } ${danger ? 'text-red-600' : 'text-dd-text'}`}
        >
            {value}
        </button>
    );
});

export default function RiceTempWheel({
    start, min, max, dangerBelow, initial = null, resetKey = 0, onChange, label,
}) {
    const [rows] = useState(visibleRows);
    const listRef = useRef(null);
    const values = useRef(null);
    if (!values.current || values.current[0] !== max || values.current.length !== max - min + 1) {
        values.current = Array.from({ length: max - min + 1 }, (_, i) => max - i);
    }
    const [center, setCenter] = useState(() => initial ?? start);
    // A gesture is in progress or just ended, so scroll movement is the cook's.
    const gesture = useRef(false);
    // Once rolled since the last reset, a tap on the center doesn't change
    // how the number was set: the cook did roll to it.
    const rolled = useRef(false);
    const lastReported = useRef(null);
    const centerRef = useRef(center);
    centerRef.current = center;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    const toScrollTop = useCallback((value) => (max - value) * ITEM_H, [max]);

    const place = useCallback((value, smooth = false) => {
        const el = listRef.current;
        if (!el) return;
        const top = toScrollTop(value);
        if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'smooth' });
        else el.scrollTop = top;
    }, [toScrollTop]);

    // Open (or reopen) at the start number. Not the last reading: a low
    // reading must be measured again, not nudged.
    useLayoutEffect(() => {
        const v = initial ?? start;
        gesture.current = false;
        rolled.current = initial != null;
        lastReported.current = initial;
        setCenter(v);
        place(v);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey, start, place]);

    const report = useCallback((value, setBy) => {
        if (setBy === 'rolled') rolled.current = true;
        lastReported.current = value;
        onChangeRef.current?.(value, rolled.current ? 'rolled' : setBy);
    }, []);

    const markGesture = () => { gesture.current = true; };

    const onScroll = () => {
        const el = listRef.current;
        if (!el) return;
        const idx = Math.round(el.scrollTop / ITEM_H);
        const value = Math.max(min, Math.min(max, max - idx));
        if (value !== centerRef.current) setCenter(value);
        if (gesture.current && value !== lastReported.current && value !== centerRef.current) {
            report(value, 'rolled');
        }
    };

    const onTap = useCallback((value) => {
        gesture.current = false;
        if (value === centerRef.current) {
            report(value, 'tapped');
            return;
        }
        setCenter(value);
        report(value, 'rolled');
        place(value, true);
    }, [place, report]);

    const step = (delta) => {
        const value = Math.max(min, Math.min(max, centerRef.current + delta));
        gesture.current = false;
        centerRef.current = value;  // a held key can repeat before the next render
        setCenter(value);
        report(value, 'rolled');
        place(value);
    };

    const onKeyDown = (e) => {
        const moves = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 };
        if (moves[e.key]) { e.preventDefault(); step(moves[e.key]); return; }
        if (e.key === 'Home') { e.preventDefault(); step(max - centerRef.current); return; }
        if (e.key === 'End') { e.preventDefault(); step(min - centerRef.current); return; }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTap(centerRef.current); }
    };

    const pad = ((rows - 1) / 2) * ITEM_H;
    const danger = center < dangerBelow;

    return (
        <div className="relative" style={{ height: rows * ITEM_H }}>
            <div
                aria-hidden="true"
                className={`absolute left-0 right-0 rounded-xl border-2 pointer-events-none ${
                    danger ? 'border-red-500 bg-red-50' : 'border-sky-500 bg-sky-100'
                }`}
                style={{ top: pad, height: ITEM_H }}
            />
            <div
                ref={listRef}
                role="spinbutton"
                tabIndex={0}
                aria-label={label}
                aria-valuemin={min}
                aria-valuemax={max}
                aria-valuenow={center}
                aria-valuetext={`${center} F`}
                onScroll={onScroll}
                onPointerDown={markGesture}
                onTouchStart={markGesture}
                onWheel={markGesture}
                onKeyDown={onKeyDown}
                className="relative h-full overflow-y-auto rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
                style={{
                    scrollSnapType: 'y mandatory',
                    overscrollBehavior: 'contain',
                    touchAction: 'pan-y',
                    WebkitOverflowScrolling: 'touch',
                    scrollbarWidth: 'none',
                }}
            >
                <div style={{ height: pad }} />
                {values.current.map((v) => (
                    <WheelItem key={v} value={v} centered={v === center} danger={v < dangerBelow} onTap={onTap} />
                ))}
                <div style={{ height: pad }} />
            </div>
            <span className="absolute right-3 pointer-events-none text-lg font-black text-dd-text-2" style={{ top: pad + 12 }} aria-hidden="true">°F</span>
        </div>
    );
}
