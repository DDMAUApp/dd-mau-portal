// inventoryTapCoalescer.js — turn a burst of +/- taps on one item into ONE
// Firestore write.
//
// WHY (2026-09-09): every tap used to fire two watchdogged writes (an audit
// row + a patch on the ~93 KB ops/inventory doc). Firestore serializes those
// through a 10-deep in-order pipeline, so a 30-tap burst queued ~60 batches
// and the tail waited long enough to trip the 8 s "stuck write" watchdog on a
// perfectly healthy connection → "Reconnecting…" → reload. Coalescing taps per
// item into a short window (re-armed on every tap, hard-capped) cuts that to a
// handful of writes and keeps the optimistic display exactly as it is.
//
// Semantics per item window:
//   • startPrev  = the count BEFORE the first tap of the window
//   • latestNext = the count AFTER the most recent tap
//   • mode       = 'inc' while every tap was '+' (write increment(latestNext -
//                  startPrev): two devices counting at once both land);
//                  'abs' once any '−' or typed value occurred (write the
//                  clamped absolute — increment() has no floor)
//   • priorMeta  = the item's countMeta as of the window start (what the
//                  contribution accounting must diff against)
//   • ctx        = opaque caller context captured at the window start (the
//                  store + staff the taps belong to) — a flush that fires
//                  after a store switch must still write to the ORIGINAL doc
//   • tapDelta   = the SUM of this device's own signed taps in the window.
//                  The 'inc' write is increment(tapDelta), never
//                  latestNext − startPrev: a snapshot from another device can
//                  move the on-screen base mid-window, and deriving the delta
//                  from display values would re-apply their count as ours
//                  (review 2026-09-09)
// A typed value ('abs' kind) flushes immediately. flushNow() drains
// synchronously (pagehide / reload stash / location switch).
//
// Pure + injectable timers so the exact window/cap behavior is unit-tested.

export const DEFAULT_WINDOW_MS = 350;
export const DEFAULT_MAX_WAIT_MS = 1200;

export function createTapCoalescer({
    windowMs = DEFAULT_WINDOW_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    flush,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
} = {}) {
    if (typeof flush !== 'function') throw new Error('createTapCoalescer: flush is required');
    const windows = new Map(); // itemId -> { startPrev, latestNext, hasNonInc, priorMeta, firstAt, timer }

    function fire(itemId) {
        const w = windows.get(itemId);
        if (!w) return;
        windows.delete(itemId);
        if (w.timer != null) clearTimer(w.timer);
        try {
            flush(itemId, {
                prevCount: w.startPrev,
                nextCount: w.latestNext,
                tapDelta: w.tapDelta,
                mode: w.hasNonInc ? 'abs' : 'inc',
                priorMeta: w.priorMeta,
                ctx: w.ctx,
            });
        } catch { /* the flush owns its own error handling */ }
    }

    function arm(itemId, w) {
        if (w.timer != null) clearTimer(w.timer);
        const t = now();
        const untilCap = Math.max(0, (w.firstAt + maxWaitMs) - t);
        const delay = Math.min(windowMs, untilCap);
        w.timer = setTimer(() => fire(itemId), delay);
    }

    return {
        /** Record one tap. kind: 'inc' | 'dec' | 'abs'. */
        tap(itemId, { prevCount, nextCount, kind, priorMeta, ctx }) {
            let w = windows.get(itemId);
            if (!w) {
                w = { startPrev: prevCount, latestNext: nextCount, hasNonInc: false, priorMeta, ctx, firstAt: now(), timer: null, tapDelta: 0 };
                windows.set(itemId, w);
            }
            w.latestNext = nextCount;
            w.tapDelta += (Number(nextCount) || 0) - (Number(prevCount) || 0);
            if (kind !== 'inc') w.hasNonInc = true;
            if (kind === 'abs') { fire(itemId); return; }
            arm(itemId, w);
        },
        /** Flush one item (or every item) synchronously. */
        flushNow(itemId) {
            if (itemId != null) { fire(itemId); return; }
            for (const id of [...windows.keys()]) fire(id);
        },
        pendingIds() { return [...windows.keys()]; },
        /** Drop everything without flushing (unmount / store switch after a flush). */
        clear() {
            for (const w of windows.values()) if (w.timer != null) clearTimer(w.timer);
            windows.clear();
        },
    };
}
