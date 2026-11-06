// RiceTimeWheel — when the rice came out, rolled sideways under the temp wheel.
//
// Andrew 2026-11-05: it opens on the current time, and pulling it from left to
// right brings the time back, so a pan stickered late during a rush gets the time
// it really came out. Up to an hour back (owner's call, over the old 10-minute
// limit); the far-left stop is "Over 1 hr", which means toss.
//
// The value is minutes ago (0 = now), so the deadlines are worked out from the
// clock at the moment of the tap. Only a person's gesture reports a change.
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';

export const RICE_TOO_LATE = 'over';
const ITEM_W = 92;

const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const Item = memo(function Item({ value, label, sub, centered, late, onTap }) {
    return (
        <button
            type="button"
            tabIndex={-1}
            onClick={() => onTap(value)}
            style={{ width: ITEM_W, scrollSnapAlign: 'center' }}
            className={`shrink-0 h-full flex flex-col items-center justify-center select-none tabular-nums leading-tight ${
                centered ? '' : 'opacity-50'
            } ${late ? 'text-red-600' : 'text-dd-text'}`}
        >
            <span className={centered ? 'text-xl font-black' : 'text-base font-black'}>{label}</span>
            <span className="text-[11px] font-bold">{sub}</span>
        </button>
    );
});

export default function RiceTimeWheel({ value, onChange, now, maxMinutes = 60, resetKey = 0, tx }) {
    // Left to right: "Over 1 hr", then the oldest time, ..., Now at the far right.
    const values = useRef(null);
    if (!values.current || values.current.length !== maxMinutes + 2) {
        values.current = [RICE_TOO_LATE, ...Array.from({ length: maxMinutes + 1 }, (_, i) => maxMinutes - i)];
    }
    const listRef = useRef(null);
    const gesture = useRef(false);
    const [center, setCenter] = useState(value);
    const centerRef = useRef(center);
    centerRef.current = center;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    const indexOf = (v) => values.current.indexOf(v);
    const place = useCallback((v, smooth = false) => {
        const el = listRef.current;
        if (!el) return;
        const left = Math.max(0, indexOf(v)) * ITEM_W;
        if (smooth && typeof el.scrollTo === 'function') el.scrollTo({ left, behavior: 'smooth' });
        else el.scrollLeft = left;
    }, []);

    // Open (and reopen after each batch) on the value the panel holds: Now.
    useLayoutEffect(() => {
        gesture.current = false;
        setCenter(value);
        place(value);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey, place]);

    const choose = useCallback((v) => {
        centerRef.current = v;
        setCenter(v);
        onChangeRef.current?.(v);
    }, []);

    const onScroll = () => {
        const el = listRef.current;
        if (!el) return;
        const idx = Math.max(0, Math.min(values.current.length - 1, Math.round(el.scrollLeft / ITEM_W)));
        const v = values.current[idx];
        if (v !== centerRef.current) {
            if (gesture.current) choose(v);
            else setCenter(v);
        }
    };

    const onTap = useCallback((v) => {
        gesture.current = false;
        choose(v);
        place(v, true);
    }, [choose, place]);

    const step = (delta) => {
        const idx = Math.max(0, Math.min(values.current.length - 1, indexOf(centerRef.current) + delta));
        gesture.current = false;
        choose(values.current[idx]);
        place(values.current[idx]);
    };
    const onKeyDown = (e) => {
        const moves = { ArrowLeft: -1, ArrowRight: 1, PageUp: -10, PageDown: 10 };
        if (moves[e.key]) { e.preventDefault(); step(moves[e.key]); return; }
        if (e.key === 'End') { e.preventDefault(); step(values.current.length); }
        if (e.key === 'Home') { e.preventDefault(); step(-values.current.length); }
    };
    const markGesture = () => { gesture.current = true; };

    // Touch screens scroll the wheel themselves. A mouse doesn't drag-scroll, so a
    // drag with one moves it by hand, then lets it snap to the nearest time.
    const drag = useRef(null);
    const onPointerDown = (e) => {
        markGesture();
        if (e.pointerType !== 'mouse' || !listRef.current) return;
        drag.current = { x: e.clientX, left: listRef.current.scrollLeft, moved: false };
        listRef.current.style.scrollSnapType = 'none';
        try { listRef.current.setPointerCapture?.(e.pointerId); } catch { /* not every browser */ }
    };
    const onPointerMove = (e) => {
        const d = drag.current;
        if (!d || !listRef.current) return;
        if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
        listRef.current.scrollLeft = d.left - (e.clientX - d.x);
    };
    const endDrag = () => {
        const d = drag.current;
        drag.current = null;
        const el = listRef.current;
        if (!d || !el) return;
        el.style.scrollSnapType = 'x mandatory';
        const idx = Math.max(0, Math.min(values.current.length - 1, Math.round(el.scrollLeft / ITEM_W)));
        choose(values.current[idx]);
        place(values.current[idx], true);
        // A drag that moved isn't also a tap on whatever time it ended over.
        dragMoved.current = d.moved;
    };
    const dragMoved = useRef(false);

    const labelFor = (v) => {
        if (v === RICE_TOO_LATE) return [tx('Over 1 hr', 'Más de 1 h'), tx('toss', 'tirar')];
        const at = new Date(now.getTime() - v * 60000);
        return [clock(at), v === 0 ? tx('Now', 'Ahora') : tx(`${v} min ago`, `hace ${v} min`)];
    };
    const [bigLabel, bigSub] = labelFor(center);

    return (
        <div>
            <div className="text-[13px] font-bold text-sky-950 mb-1">
                {tx('When did it come out? Pull right to go back.', '¿Cuándo salió? Jala a la derecha para regresar.')}
            </div>
            <div className="relative h-[64px]">
                <div
                    aria-hidden="true"
                    className={`absolute top-0 bottom-0 left-1/2 -translate-x-1/2 rounded-xl border-2 pointer-events-none ${
                        center === RICE_TOO_LATE ? 'border-red-500 bg-red-50' : center > 0 ? 'border-amber-500 bg-amber-50' : 'border-sky-500 bg-sky-100'
                    }`}
                    style={{ width: ITEM_W }}
                />
                <div
                    ref={listRef}
                    role="slider"
                    tabIndex={0}
                    aria-label={tx('When the rice came out', 'Cuándo salió el arroz')}
                    aria-valuemin={0}
                    aria-valuemax={maxMinutes + 1}
                    aria-valuenow={center === RICE_TOO_LATE ? maxMinutes + 1 : center}
                    aria-valuetext={`${bigLabel}, ${bigSub}`}
                    onScroll={onScroll}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onClickCapture={(e) => { if (dragMoved.current) { e.stopPropagation(); dragMoved.current = false; } }}
                    onTouchStart={markGesture}
                    onWheel={markGesture}
                    onKeyDown={onKeyDown}
                    className="relative h-full flex overflow-x-auto rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
                    style={{
                        scrollSnapType: 'x mandatory',
                        overscrollBehavior: 'contain',
                        touchAction: 'pan-x',
                        WebkitOverflowScrolling: 'touch',
                        scrollbarWidth: 'none',
                    }}
                >
                    <div className="shrink-0" style={{ width: `calc(50% - ${ITEM_W / 2}px)` }} />
                    {values.current.map((v) => {
                        const [label, sub] = labelFor(v);
                        return <Item key={v} value={v} label={label} sub={sub} centered={v === center} late={v === RICE_TOO_LATE} onTap={onTap} />;
                    })}
                    <div className="shrink-0" style={{ width: `calc(50% - ${ITEM_W / 2}px)` }} />
                </div>
            </div>
        </div>
    );
}
