import { useRef, useCallback } from 'react';

// Press-and-HOLD trigger for hidden admin affordances (2026-07-12,
// Andrew: "in the home screen there is a secret button that when held
// for 10 secs it activates shared iPad mode"). Spread the returned
// props onto any element; the callback fires only after the pointer
// stays down for the full duration — lifting, drifting off the
// element, or a system cancel (scroll, callout) aborts the countdown.
// No visual feedback by design: it's a secret.
export default function useSecretHold(onTrigger, ms = 10000) {
    const timer = useRef(null);
    const arm = useCallback(() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(onTrigger, ms);
    }, [onTrigger, ms]);
    const disarm = useCallback(() => clearTimeout(timer.current), []);
    return {
        onPointerDown: arm,
        onPointerUp: disarm,
        onPointerLeave: disarm,
        onPointerCancel: disarm,
        // Block the iOS long-press callout / context menu so the hold
        // can survive the full 10s on a text element.
        onContextMenu: (e) => e.preventDefault(),
        style: { WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' },
    };
}
