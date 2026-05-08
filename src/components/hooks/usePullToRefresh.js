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
//   • On release past threshold:
//       1. Calls registration.update() on the active service worker so a
//          new SW (if any) starts installing immediately
//       2. Hard reloads the page
//   • A subsequent navigation picks up the new HTML, which references the
//     new hashed JS chunks — stale chunks fall out of cache.

import { useEffect, useState, useRef } from 'react';

const THRESHOLD = 80;     // px pull distance to trigger a refresh
const MAX_PULL = 120;     // px cap on visual progress (rubber-band feel)
const REFRESHING_PAINT_MS = 300; // brief window so user sees the spinner

export default function usePullToRefresh() {
    const [pullDistance, setPullDistance] = useState(0);
    const [refreshing, setRefreshing] = useState(false);
    // Refs so the event listener (mounted once) can read latest values
    // without re-attaching on every state update.
    const startY = useRef(0);
    const tracking = useRef(false);
    const distanceRef = useRef(0);
    const refreshingRef = useRef(false);

    // Keep refs in sync with state for the event handlers below.
    refreshingRef.current = refreshing;

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const setDistance = (v) => {
            distanceRef.current = v;
            setPullDistance(v);
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
            setDistance(0);
        };

        const onTouchMove = (e) => {
            if (!tracking.current || refreshingRef.current) return;
            if (window.scrollY > 0) {
                // User started at top but scrolled away — abandon.
                tracking.current = false;
                setDistance(0);
                return;
            }
            const dy = e.touches[0].clientY - startY.current;
            if (dy <= 0) {
                // Pulled up — not our gesture.
                setDistance(0);
                return;
            }
            // Rubber-band damping past MAX_PULL so the indicator doesn't
            // shoot off-screen on aggressive pulls.
            const eased = dy <= MAX_PULL ? dy : MAX_PULL + (dy - MAX_PULL) * 0.2;
            setDistance(eased);
        };

        const onTouchEnd = async () => {
            if (!tracking.current) return;
            tracking.current = false;
            const finalPull = distanceRef.current;
            setDistance(0);
            if (finalPull < THRESHOLD || refreshingRef.current) return;

            setRefreshing(true);
            try {
                // 1. Tell every registered SW to fetch new files. iOS PWAs
                //    in standalone mode are notorious for serving cached
                //    builds otherwise.
                if ('serviceWorker' in navigator) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    for (const r of regs) { try { await r.update(); } catch {} }
                }
                // 2. Wipe every cache the SW may have populated. Our inline
                //    SW (pwa.js) doesn't .put() anything, but a future SW or
                //    a leftover one from a previous deploy might have. Cheap
                //    to do unconditionally.
                if ('caches' in window) {
                    try {
                        const keys = await caches.keys();
                        await Promise.all(keys.map(k => caches.delete(k)));
                    } catch {}
                }
                // Brief paint window so the user sees "Refreshing…" before
                // the reload kicks in.
                await new Promise(r => setTimeout(r, REFRESHING_PAINT_MS));
            } catch (e) {
                console.warn('Pull-refresh cache clear failed:', e);
            }
            // 3. Cache-busting URL replace. Plain location.reload() on iOS
            //    PWA standalone can still serve the cached HTML; appending
            //    a unique query param forces a fresh GET against the server.
            try {
                const url = new URL(window.location.href);
                url.searchParams.set('_r', Date.now().toString(36));
                window.location.replace(url.toString());
            } catch {
                window.location.reload();
            }
        };

        document.addEventListener('touchstart', onTouchStart, { passive: true });
        document.addEventListener('touchmove',  onTouchMove,  { passive: true });
        document.addEventListener('touchend',   onTouchEnd,   { passive: true });
        document.addEventListener('touchcancel', onTouchEnd,  { passive: true });
        return () => {
            document.removeEventListener('touchstart', onTouchStart);
            document.removeEventListener('touchmove',  onTouchMove);
            document.removeEventListener('touchend',   onTouchEnd);
            document.removeEventListener('touchcancel', onTouchEnd);
        };
    }, []);

    return {
        pullDistance,
        progress: Math.min(1, pullDistance / THRESHOLD),
        refreshing,
        triggered: pullDistance >= THRESHOLD,
    };
}
