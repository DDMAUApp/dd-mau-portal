// Show an OS notification from page context, with the service-worker
// fallback Android requires.
//
// ⚠ WHY THIS EXISTS: Android Chrome/WebView throws
//     TypeError: Failed to construct 'Notification': Illegal constructor
// for page-context `new Notification()` — it only permits notifications via
// a ServiceWorkerRegistration. Operations.jsx learned this the hard way in
// the 2026-07-22 audit (the throw took down the whole tab) and grew a
// try/catch + SW fallback.
//
// The 2026-08-01 bug run found three OTHER call sites that had only half the
// lesson: a bare `try { new Notification(...) } catch {}`. Those don't crash —
// they silently swallow the notification, so on Android staff got NOTHING
// from the foreground push handler, the in-app notification popup, and the
// 1-hour-before-shift reminder. A silent catch looks safe and hides a
// feature being dead on a whole platform.
//
// Fire-and-forget by design: callers are UI paths that must never block or
// throw on a notification failing.

/**
 * @param {string} title
 * @param {NotificationOptions} options
 * @returns {Promise<boolean>} true if some surface accepted it
 */
export async function showLocalNotification(title, options = {}) {
    if (typeof window === 'undefined') return false;
    const safeTitle = String(title || 'DD Mau');

    // Permission gate first — constructing without it throws on some engines
    // and prompts on none.
    try {
        if (typeof Notification === 'undefined') return await viaServiceWorker(safeTitle, options);
        if (Notification.permission !== 'granted') return false;
    } catch {
        return await viaServiceWorker(safeTitle, options);
    }

    try {
        // eslint-disable-next-line no-new
        new Notification(safeTitle, options);
        return true;
    } catch {
        // Android's illegal-constructor path — the SW can still show it.
        return await viaServiceWorker(safeTitle, options);
    }
}

async function viaServiceWorker(title, options) {
    try {
        const reg = await navigator.serviceWorker?.ready;
        if (!reg?.showNotification) return false;
        await reg.showNotification(title, options);
        return true;
    } catch {
        return false;
    }
}
