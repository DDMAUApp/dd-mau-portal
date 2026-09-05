// dateFmt.js — cached Intl date/time formatting for hot render paths.
//
// `new Date(x).toLocaleTimeString(locale, opts)` constructs a fresh
// Intl.DateTimeFormat on EVERY call — one of the most expensive
// standard-library calls in a browser (~0.1-1ms each on an older iPad
// WKWebView). The Toast orders/invoices lists were doing hundreds of
// them per render. Reusing one Intl.DateTimeFormat per (locale, opts)
// makes each subsequent format ~100× cheaper.
//
// fmtIso also fixes a latent bug in the callers: formatting an invalid
// date via toLocaleTimeString silently renders the string
// "Invalid Date"; here it renders "" instead.

const _fmtCache = new Map();

export function getDateFormatter(locale, opts) {
    const key = locale + '|' + JSON.stringify(opts);
    let f = _fmtCache.get(key);
    if (!f) {
        f = new Intl.DateTimeFormat(locale, opts);
        _fmtCache.set(key, f);
    }
    return f;
}

/** Format an ISO string (or Date) — returns "" for missing/invalid input. */
export function fmtIso(iso, locale, opts) {
    if (!iso) return "";
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return getDateFormatter(locale, opts).format(d);
}
