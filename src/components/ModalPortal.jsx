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

import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export default function ModalPortal({ children }) {
    useEffect(() => {
        if (typeof document === 'undefined') return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, []);
    if (typeof document === 'undefined') return null;   // SSR guard
    return createPortal(children, document.body);
}
