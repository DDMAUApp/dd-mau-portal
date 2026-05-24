// usePullToRefresh — mobile pull-down gesture that force-refreshes the app.
//
// Why custom: with `apple-mobile-web-app-capable=yes` (set so the app can
// install as a PWA), iOS Safari disables its native pull-to-refresh.
// Result: staff installed the PWA, then got stuck on the cached old build
// with no way to pull down and reload. This hook reintroduces the gesture.
//
// What it does:
//   • Listens to touchstart / touchmove / touchend on the document
//   • Only activates when window.scrollY === 0 at touchstart (don't fight
//     vertical scrolling)
//   • Tracks pull distance, returns progress 0..1 for a UI indicator
//   • On release past threshold AND held for DWELL_MS:
//       1. Calls registration.update() on the active service worker so a
//          new SW (if any) starts installing immediately
//       2. Hard reloads the page
//   • A subsequent navigation picks up the new HTML, which references the
//     new hashed JS chunks — stale chunks fall out of cache.
//
// "PULL AND WAIT" GESTURE (Andrew 2026-05-17): the previous threshold of
// 80px with no hold requirement fired refreshes accidentally during normal
// scrolling on every page — made the whole app feel glitchy ("pages
// randomly reload"). New gesture has two locks:
//
//   1. THRESHOLD = 150px (was 80) — needs a deliberate big pull.
//   2. DWELL_MS = 500ms — user must HOLD past the threshold for half
//      a second before release will fire the refresh. A snap-back
//      release (pull then immediately let go) aborts.
//
// Net effect: feels like native iOS pull-to-refresh — the user has to
// commit to the gesture rather than triggering it by overscrolling.

import { useEffect, useState, useRef } from 'react';

const THRESHOLD = 150;    // px pull distance required to ARM the refresh
const MAX_PULL = 200;     // px cap on visual progress (rubber-band feel)
const DWELL_MS = 500;     // ms the pull must be held past threshold
const REFRESHING_PAINT_MS = 300; // brief window so user sees the spinner

// Standalone refresh action — same cache-bust + reload sequence used by the
// pull gesture, exposed so a desktop button (or a future "refresh" menu
// item) can trigger the exact same recovery without touch events.
export async function forceRefresh() {
    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) { try { await r.update(); } catch {} }
        }
        if ('caches' in window) {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            } catch {}
        }
        await new Promise(r => setTimeout(r, REFRESHING_PAINT_MS));
    } catch (e) {
        console.warn('forceRefresh cache clear failed:', e);
    }
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('_r', Date.now().toString(36));
        window.location.replace(url.toString());
    } catch {
        window.location.reload();
    }
}

export default function usePullToRefresh() {
    const [pullDistance, setPullDistance] = useState(0);
    const [armed, setArmed] = useState(false);     // held past threshold long enough
    const [refreshing, setRefreshing] = useState(false);
    // Refs so the event listener (mounted once) can read latest values
    // without re-attaching on every state update.
    const startY = useRef(0);
    const tracking = useRef(false);
    const distanceRef = useRef(0);
    const refreshingRef = useRef(false);
    const armedRef = useRef(false);
    // Timestamp (Date.now()) of when the pull first crossed THRESHOLD on
    // the way down. Reset to 0 when the user releases threshold (pulls
    // back up) or lifts. armed flips to true once (now - thresholdAt)
    // >= DWELL_MS.
    const thresholdAtRef = useRef(0);
    // Timer that watches for the dwell window expiring without further
    // touch movement (the user could pull past threshold and just hold —
    // touchmove won't fire while finger is stationary, so we set an
    // explicit setTimeout to flip the armed flag).
    const dwellTimerRef = useRef(null);

    // Keep refs in sync with state for the event handlers below.
    refreshingRef.current = refreshing;
    armedRef.current = armed;

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const setDistance = (v) => {
            distanceRef.current = v;
            setPullDistance(v);
        };

        const clearDwellTimer = () => {
            if (dwellTimerRef.current) {
                clearTimeout(dwellTimerRef.current);
                dwellTimerRef.current = null;
            }
        };

        const onTouchStart = (e) => {
            if (refreshingRef.current) return;
            // Only enable from the top of the page. Mid-scroll through a
            // long view (Schedule, Operations) — leave it alone.
            if (window.scrollY > 0) { tracking.current = false; return; }
            // Don't intercept gestures inside text inputs — would interfere
            // with keyboard pull-to-dismiss.
            const tag = (document.activeElement?.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                tracking.current = false;
                return;
            }
            startY.current = e.touches[0].clientY;
            tracking.current = true;
            thresholdAtRef.current = 0;
            setArmed(false);
            clearDwellTimer();
            setDistance(0);
        };

        const onTouchMove = (e) => {
            if (!tracking.current || refreshingRef.current) return;
            if (window.scrollY > 0) {
                // User started at top but scrolled away — abandon.
                tracking.current = false;
                setDistance(0);
                thresholdAtRef.current = 0;
                if (armedRef.current) setArmed(false);
                clearDwellTimer();
                return;
            }
            const dy = e.touches[0].clientY - startY.current;
            if (dy <= 0) {
                // Pulled up — not our gesture. Cancel any dwell-in-progress.
                setDistance(0);
                thresholdAtRef.current = 0;
                if (armedRef.current) setArmed(false);
                clearDwellTimer();
                return;
            }
            // Rubber-band damping past MAX_PULL so the indicator doesn't
            // shoot off-screen on aggressive pulls.
            const eased = dy <= MAX_PULL ? dy : MAX_PULL + (dy - MAX_PULL) * 0.2;
            setDistance(eased);

            // Threshold-crossing transitions — track when the user first
            // crosses the line, AND clear the timer if they pull back
            // above it without lifting (so a quick down-then-up doesn't
            // arm). The armed state only fires after DWELL_MS has elapsed
            // while continuously past the threshold.
            const past = eased >= THRESHOLD;
            if (past && thresholdAtRef.current === 0) {
                // Just crossed below → past. Stamp the time and schedule
                // the dwell timer. touchmove won't fire while the finger
                // is held stationary, so an explicit setTimeout is what
                // promotes the gesture to armed without further input.
                thresholdAtRef.current = Date.now();
                clearDwellTimer();
                dwellTimerRef.current = setTimeout(() => {
                    // Re-check: still tracking + still past threshold?
                    // (User could have pulled back up between scheduling
                    // and now; the touchmove handler above clears the
                    // armed state but the timer fires anyway.)
                    if (
                        tracking.current &&
                        !refreshingRef.current &&
                        distanceRef.current >= THRESHOLD
                    ) {
                        setArmed(true);
                    }
                }, DWELL_MS);
            } else if (!past && thresholdAtRef.current !== 0) {
                // Slipped back below — cancel the dwell.
                thresholdAtRef.current = 0;
                if (armedRef.current) setArmed(false);
                clearDwellTimer();
            }
        };

        // 2026-05-24 audit fix: was sharing one handler for touchend +
        // touchcancel. touchcancel fires when the OS interrupts a touch
        // — an incoming call, a system gesture, scroll snap, a long-
        // press triggering the share sheet — and treating those as
        // "release" wrongly triggered the full app refresh whenever an
        // armed pull was interrupted. Two handlers now: cancel resets
        // state silently, end is the only commit path.
        const resetPullState = () => {
            tracking.current = false;
            setDistance(0);
            setArmed(false);
            thresholdAtRef.current = 0;
            clearDwellTimer();
        };

        const onTouchEnd = async () => {
            if (!tracking.current) return;
            const wasArmed = armedRef.current;
            const finalPull = distanceRef.current;
            resetPullState();
            // BOTH conditions must hold to fire:
            //   1. Pull was past threshold at release (finalPull check)
            //   2. User HELD past threshold for >= DWELL_MS (armed flag)
            // A quick pull-and-release that crosses threshold but doesn't
            // dwell long enough aborts silently — feels native.
            if (!wasArmed || finalPull < THRESHOLD || refreshingRef.current) return;

            setRefreshing(true);
            await forceRefresh();
        };

        const onTouchCancel = () => {
            // OS-interrupted touch — never commit. Just clean up state.
            resetPullState();
        };

        document.addEventListener('touchstart', onTouchStart, { passive: true });
        document.addEventListener('touchmove',  onTouchMove,  { passive: true });
        document.addEventListener('touchend',   onTouchEnd,   { passive: true });
        document.addEventListener('touchcancel', onTouchCancel, { passive: true });
        return () => {
            document.removeEventListener('touchstart', onTouchStart);
            document.removeEventListener('touchmove',  onTouchMove);
            document.removeEventListener('touchend',   onTouchEnd);
            document.removeEventListener('touchcancel', onTouchCancel);
            clearDwellTimer();
        };
    }, []);

    return {
        pullDistance,
        progress: Math.min(1, pullDistance / THRESHOLD),
        refreshing,
        armed,
        // `triggered` is what existing consumers read; mirror the armed
        // state (the new "ready to fire on release" condition) so any
        // UI indicator turns green at the right moment — i.e. only after
        // the user has held past threshold for DWELL_MS, not just at
        // first crossing.
        triggered: armed,
    };
}
