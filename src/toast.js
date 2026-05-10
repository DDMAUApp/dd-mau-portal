// Lightweight in-app toast notification system.
//
// Replaces window.alert() across the app. Native alert() shows
// "ddmauapp.github.io says:" as a prefix on Chrome/Android — this module
// renders our own clean popup instead. Drop-in compatible with alert():
// callsites that did `alert("Saved!")` can switch to `toast("Saved!")`.
//
// Module-level pub/sub so any code can call `toast()` without prop-drilling
// or context wrappers. <AppToast /> mounts once in App.jsx and subscribes.

let nextId = 1;
const subscribers = new Set();
let activeToasts = []; // [{ id, message, kind, duration }]

function emit() {
    for (const fn of subscribers) {
        try { fn(activeToasts); } catch (e) { console.warn('toast subscriber failed:', e); }
    }
}

/**
 * Show a toast.
 * @param {string} message
 * @param {object} [opts]
 * @param {'info'|'success'|'error'|'warn'} [opts.kind='info']
 * @param {number} [opts.duration=4000] - ms before auto-dismiss; 0 = sticky
 * @param {string} [opts.actionLabel] - if set, shows an action button
 * @param {function} [opts.onAction] - called when action is tapped
 */
export function toast(message, opts = {}) {
    if (message == null) return;
    const id = nextId++;
    const kind = opts.kind || (
        // Heuristic kind detection from common message prefixes used in this
        // codebase (✓ / ✅ → success; ⚠️ / Error → warn/error). Lets us drop
        // alert() → toast() with no callsite changes and still get colors.
        /^[\s]*[✓✅]/.test(String(message)) ? 'success'
        : /^[\s]*⚠/.test(String(message)) ? 'warn'
        : /error|failed|fail|invalid/i.test(String(message)) ? 'error'
        : 'info'
    );
    const duration = opts.duration != null ? opts.duration : 4000;
    const t = {
        id, message: String(message), kind, duration,
        actionLabel: opts.actionLabel || null,
        onAction: opts.onAction || null,
    };
    activeToasts = [...activeToasts, t];
    emit();
    if (duration > 0) {
        setTimeout(() => dismissToast(id), duration);
    }
    return id;
}

/**
 * Undo-toast pattern. Buffers a destructive action behind a 5-second
 * "Undo" toast — the staffer can hit Undo to cancel before it commits.
 *
 * Usage:
 *   undoToast(
 *     'Shift deleted',
 *     async () => { await actuallyDeleteShift(id); },
 *     { delayMs: 5000 }
 *   );
 *
 * The commit function only runs after the delay if Undo wasn't tapped.
 * Returns a cancel handle in case the caller wants programmatic cancel.
 */
export function undoToast(message, commitFn, opts = {}) {
    const delay = opts.delayMs != null ? opts.delayMs : 5000;
    let cancelled = false;
    const id = toast(message, {
        kind: opts.kind || 'info',
        duration: delay,
        actionLabel: opts.undoLabel || 'Undo',
        onAction: () => { cancelled = true; dismissToast(id); },
    });
    setTimeout(() => {
        if (!cancelled) {
            try { commitFn(); } catch (e) { console.warn('undoToast commit failed:', e); }
        }
    }, delay);
    return { cancel: () => { cancelled = true; dismissToast(id); } };
}

export function dismissToast(id) {
    const before = activeToasts.length;
    activeToasts = activeToasts.filter(t => t.id !== id);
    if (activeToasts.length !== before) emit();
}

/**
 * Subscribe to toast changes. Returns an unsubscribe function.
 * Used by <AppToast /> in App.jsx — most app code should call `toast()` instead.
 */
export function subscribeToasts(fn) {
    subscribers.add(fn);
    fn(activeToasts);
    return () => subscribers.delete(fn);
}
