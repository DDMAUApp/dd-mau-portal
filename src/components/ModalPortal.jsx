// ModalPortal — escape-the-tree wrapper for every full-screen modal.
//
// PROBLEM (Andrew, 2026-05-30):
//   "the print pop up window go to the middle of the page. the problem
//    is that i have to scroll alot to get to the window. there is alot
//    of windows that do this."
//
// ROOT CAUSE:
//   CSS `position: fixed` is meant to position relative to the viewport,
//   but the spec carves out an exception: any ancestor with `transform`,
//   `filter`, `backdrop-filter`, `will-change`, `perspective`, `contain`,
//   or `container-type` becomes the containing block instead. The Apple-
//   Liquid-Glass system uses `backdrop-filter: blur(...)` on every
//   `.glass-card`, `.glass-sheet`, `.glass-panel`. Operations.jsx +
//   Schedule.jsx + AdminPanel.jsx all sit deep inside such ancestors.
//   So `<div class="fixed inset-0 z-50">` actually positions itself
//   relative to the nearest glass surface — which, on a long inventory
//   page scrolled to the bottom, can be hundreds of pixels off-screen.
//
// FIX:
//   `createPortal(children, document.body)` lifts the modal out of the
//   component subtree and renders it as a direct child of <body>, which
//   has no transform/filter/backdrop-filter and therefore lets
//   `position: fixed` work as intended. The modal stays in viewport no
//   matter where the user has scrolled.
//
// USAGE:
//   import ModalPortal from './ModalPortal';
//   return (
//       <ModalPortal>
//           <div className="fixed inset-0 z-50 ...">
//               ...your modal markup...
//           </div>
//       </ModalPortal>
//   );
//
// Body-scroll lock is intentional: a modal that lets the background
// scroll feels broken on mobile and lets the user lose the modal by
// accidentally scrolling away.
//
// Re-entrancy safe: a stacked modal restores the PREVIOUS overflow
// value on unmount, not just an empty string, so closing the inner
// modal does not unlock the outer one.
//
// 2026-06-02 — Optional `onBackPress` prop wires the modal into the
// Android hardware-back stack via pushBackHandler. Callers can pass
// their existing close handler:
//   <ModalPortal onBackPress={onClose}>...</ModalPortal>
// and the back gesture will fire the close before the bridge falls
// through to "navigate to home". The wire-up is opt-in so legacy
// modals keep their existing scrim/Escape close behaviour and we
// migrate them one at a time. No-op on web (bridge is a no-op when
// Capacitor.isNativePlatform() is false).

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { pushBackHandler } from '../capacitor-bridge';

export default function ModalPortal({ children, onBackPress }) {
    // Ref to a zero-impact wrapper around the modal so the back handler can
    // find THIS modal's scrim (display:contents generates no box, so layout
    // and position:fixed-to-viewport are unaffected — see the 2026-05-30
    // header note about transformed ancestors).
    const wrapRef = useRef(null);
    useEffect(() => {
        if (typeof document === 'undefined') return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, []);
    // Claim the Android hardware-back gesture for as long as this modal is
    // mounted, so Back NEVER falls through to the bridge's "go to home" / "exit
    // app" while a modal is still on screen (that read as a crash — the app
    // would jump to Home or exit with the modal still rendered). Popped on
    // unmount. No-op on web (the back stack is only consulted on native).
    useEffect(() => {
        // 2026-06-16 (#2): if the caller passed an explicit onBackPress, use it.
        // Otherwise — instead of inertly swallowing the press (the old behavior
        // left Back dead in ~85 of 88 modals) — synthesize a backdrop click on
        // THIS modal's own scrim. Nearly every overlay is click-outside-to-
        // close, so Back now dismisses them. Strictly ≥ the old swallow: it
        // closes click-dismissable modals and no-ops on the rest (it never
        // falls through to go-home with the modal still up). Guarded to only
        // fire on a real full-screen scrim element.
        const onBack = (typeof onBackPress === 'function') ? onBackPress : () => {
            try {
                const root = wrapRef.current && wrapRef.current.firstElementChild;
                const cls = (root && (root.className || '')).toString();
                if (root && /(^|\s)fixed(\s|$)/.test(cls) && /inset-0/.test(cls)) {
                    root.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                }
            } catch { /* best-effort */ }
        };
        const pop = pushBackHandler(() => { onBack(); });
        return pop;
    }, [onBackPress]);
    if (typeof document === 'undefined') return null;   // SSR guard
    return createPortal(
        <div ref={wrapRef} style={{ display: 'contents' }}>{children}</div>,
        document.body,
    );
}
