// deviceId.js: one stable ID per install of the app.
//
// Same storage key push dedupe has always used, so existing devices keep the
// ID they already have. It mints on first read, which means a shared iPad that
// never registers for push still gets one. No firebase import: main.jsx and
// the logger both read this before the SDK is up.

export const DEVICE_ID_KEY = 'ddmau:fcmDeviceId';

let _fallback = null;

export function getOrCreateDeviceId() {
    try {
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if (id && id.length > 8) return id;
        id = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(DEVICE_ID_KEY, id);
        return id;
    } catch {
        // Storage is broken. Keep one answer for the life of this page so
        // every row from this boot still groups together.
        if (!_fallback) _fallback = 'dev_' + Date.now().toString(36);
        return _fallback;
    }
}

/** The last 6 characters: what goes on the version badge and each iPad's label. */
export function deviceShortId(id = getOrCreateDeviceId()) {
    return String(id || '').slice(-6);
}
