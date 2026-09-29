// tvStaleConfig.js — is the menu TV showing an OLD config?
//
// 2026-09-28 (Andrew: "i just updated the image tv at webster and its not
// showing up"): the Webster photo TV (ddmau-pi5, browser up 83 days) kept
// writing its heartbeat every minute but its tv_configs onSnapshot had
// silently stopped delivering — it showed the old 17-photo slideshow while
// version 48 (2 photos) was published. Writes alive + listener dead = the
// heartbeat can't see it. MenuDisplay now asks the SERVER directly every few
// minutes and compares with what's on screen.

const ms = (ts) => {
    if (!ts) return 0;
    if (typeof ts === 'string') { const t = Date.parse(ts); return Number.isFinite(t) ? t : 0; }
    if (typeof ts.toMillis === 'function') return Math.floor(ts.toMillis());
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    return 0;
};

// True when the server has a strictly NEWER published config than the one
// on screen. publishedVersion (integer, bumped on every Publish) is the
// primary signal; publishedAt / updatedAt (ISO strings) cover docs that
// predate versioning. Never true for an equal or older server copy.
export function tvConfigIsStale(current, server) {
    if (!server) return false;
    if (!current) return true;
    const sv = Number(server.publishedVersion), cv = Number(current.publishedVersion);
    if (Number.isFinite(sv) && Number.isFinite(cv)) return sv > cv;
    const s = Math.max(ms(server.publishedAt), ms(server.updatedAt));
    const c = Math.max(ms(current.publishedAt), ms(current.updatedAt));
    return s > 0 && s > c;
}

// One stale-listener reload per 20 min per tab, so a TV whose fresh page
// still can't listen keeps showing (polled) content instead of looping.
export const STALE_RELOAD_GAP_MS = 20 * 60 * 1000;
export function mayReloadForStale(lastReloadAt, now = Date.now()) {
    const last = Number(lastReloadAt) || 0;
    return !last || (now - last) >= STALE_RELOAD_GAP_MS;
}
