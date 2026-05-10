// useIsMobile — single source of truth for "are we on a phone right now?"
//
// Uses matchMedia (max-width: 767px) — same breakpoint as Tailwind's `md`,
// so JS-side branching stays consistent with CSS-side `md:` modifiers.
//
// Why a hook + JS detection instead of CSS-only render-both:
//   Some components mount expensive Firestore subscriptions (HomeV2 has
//   labor / 86 / shifts / time_off listeners). Rendering both the desktop
//   and mobile versions of those would double the listener count just to
//   hide one with `hidden md:block`. JS branching mounts only the variant
//   that the viewport actually needs.
//
// SSR-safe (returns false on the server). Listens to media-query change
// events so a user dragging from portrait to landscape, or rotating their
// phone, gets a clean re-render.

import { useEffect, useState } from 'react';

const MOBILE_QUERY = '(max-width: 767px)';

export default function useIsMobile() {
    const [isMobile, setIsMobile] = useState(() => {
        if (typeof window === 'undefined') return false;
        return window.matchMedia(MOBILE_QUERY).matches;
    });

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const mq = window.matchMedia(MOBILE_QUERY);
        const handler = (e) => setIsMobile(e.matches);
        // Modern listener API — fall back to legacy addListener for old Safari.
        if (mq.addEventListener) mq.addEventListener('change', handler);
        else mq.addListener(handler);
        return () => {
            if (mq.removeEventListener) mq.removeEventListener('change', handler);
            else mq.removeListener(handler);
        };
    }, []);

    return isMobile;
}
