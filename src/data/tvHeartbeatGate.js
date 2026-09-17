// tvHeartbeatGate.js — who is allowed to speak AS a menu TV.
//
// MenuDisplay writes /tv_heartbeats/{tvId} every 60 s. Two things now trust
// that heartbeat to mean "the physical screen is alive": the Pi-side watchdog
// (restarts the kiosk browser when it goes stale) and the checkTvHeartbeats
// Cloud Function (posts to the 📺 Menu Screens chat thread). Review 2026-09-17:
// ANY top-level page at ?tv=<id> heartbeated as that TV — so opening the link
// on a laptop to check on a dark screen produced a false "Back online", and a
// forgotten tab hid a dead TV from both the watchdog and the alert.
//
// Rule: previews and personal devices render the menu but never impersonate
// the TV. It FAILS OPEN — an unknown signage device (the Pis report
// "X11; CrOS", a Fire TV is Android without "Mobile") keeps heartbeating; only
// things that are clearly a person's computer or phone are excluded. A
// blacklist on purpose: a whitelist would silently unmonitor a new TV model.
export const PERSONAL_DEVICE_UA = /(Macintosh|iPhone|iPad|iPod|Windows NT)|Android.*Mobile/;

export function isTvImpersonationBlocked({ embedded = false, search = '', userAgent = '' } = {}) {
    if (embedded) return true;                                   // admin dashboard iframe previews (2026-08-25)
    try {
        if (new URLSearchParams(String(search || '')).get('preview') === '1') return true;   // "Open" / "Preview" buttons
    } catch { /* malformed query → not a preview */ }
    return PERSONAL_DEVICE_UA.test(String(userAgent || ''));     // iPadOS reports "Macintosh", so iPads are covered
}

/** Append the preview marker to a kiosk URL for look-at-it buttons (never for Copy URL). */
export function asPreviewUrl(url) {
    const u = String(url || '');
    if (!u) return u;
    if (/[?&]preview=1(&|$)/.test(u)) return u;
    return u + (u.includes('?') ? '&' : '?') + 'preview=1';
}
