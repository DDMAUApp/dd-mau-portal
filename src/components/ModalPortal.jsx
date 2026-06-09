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

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { pushBackHandler } from '../capacitor-bridge';

export default function ModalPortal({ children, onBackPress }) {
    useEffect(() => {
        if (typeof document === 'undefined') return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, []);
    // Claim the Android hardware-back gesture for as long as this modal is
    // mounted, so Back NEVER falls through to the bridge's "go to home" / "exit
    // app" while a modal is still on screen (that read as a crash — the app
    // would jump to Home or exit with the modal still rendered). If the caller
    // passed an onBackPress, run it to close the modal; otherwise just swallow
    // the press (the user closes via the modal's own ✕ / scrim). Popped on
    // unmount. No-op on web (the back stack is only consulted on native).
    useEffect(() => {
        const onBack = (typeof onBackPress === 'function') ? onBackPress : () => {};
        const pop = pushBackHandler(() => { onBack(); });
        return pop;
    }, [onBackPress]);
    if (typeof document === 'undefined') return null;   // SSR guard
    return createPortal(children, document.body);
}
