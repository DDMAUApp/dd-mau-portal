// MenuDisplay — read-only TV/kiosk menu board for the restaurant.
//
// Andrew 2026-05-20: "i have menu tvs at the restaurant and i want
// to have a usb drive that i can connect to the wifi and have
// automatic menu updates". Hardware = Fire TV Stick 4K + Fully
// Kiosk Browser pointed at ?tv=<tvId>. This component IS what
// that browser renders.
//
// ─── Routing ───────────────────────────────────────────────────
// Mounted by App.jsx when ?tv=<tvId> is in the URL. Bypasses the
// PIN entirely (public-facing display, not staff data). Same trick
// the onboarding portal uses.
//
// ─── Data sources ─────────────────────────────────────────────
//   • Static base:  MENU_DATA from src/data/menu.js (canonical menu).
//   • Live overlay: /menu_items/{slug} — admin price/desc/photo edits
//                   AND custom items not in MENU_DATA.
//   • Live 86:      /ops/86_{location} — sold-out items.
//   • Live config:  /tv_configs/{tvId} — layout, categories, photos.
//
// All three Firestore sources are onSnapshot — changes in admin
// reflect on the TV within seconds, no refresh.
//
// ─── Layout modes ─────────────────────────────────────────────
//   • dense     — 3-column single-page (default; everything visible)
//   • rotate    — auto-cycles through categories every N seconds
//                 (good for narrow/portrait TVs)
//   • spotlight — one big featured category + others compact
//                 (good for "today's specials" feel)

import { Component, useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, onSnapshot, query, where, limit, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { MENU_DATA } from '../data/menu';
import { useMenuConfigLegacy } from '../data/menuConfig';
import { subscribeMenuOverrides, applyMenuOverrides } from '../data/menuOverrides';
import { urlIsVideo } from '../data/menuImageUpload';
import {
    subscribeTvConfig, MODES, resolveActiveOrLastDaypart,
    DEFAULT_ROTATE_SECONDS, DEFAULT_IMAGE_ROTATE_SECONDS,
} from '../data/tvConfigs';
import {
    resolveActiveHoliday, applyHolidayOverlay, daysUntilHoliday,
} from '../data/tvHolidays';

// ─── Offline failsafe ──────────────────────────────────────────────
// Restaurants have flaky Wi-Fi. A blank TV during dinner rush is
// worse than a stale one. Everything below this comment block keeps
// the menu visible when the Pi loses its Firestore connection.
//
// What we cache, when, and where:
//   • tvConfig (layout, dayparts, image URLs) — on every successful
//     onSnapshot. Keyed by tvId so multiple TVs on one Pi can't step
//     on each other.
//   • menu overrides (admin price/desc/photo edits + custom items)
//     — on every successful snapshot. Stored as serialized Map.
//   • 86 list — on every successful snapshot. Stored as serialized Set.
//
// What we DON'T cache:
//   • Firebase Storage image URLs themselves — the browser HTTP cache
//     handles that. Images that loaded successfully once stay in the
//     Pi's Chromium disk cache. New images uploaded during a Wi-Fi
//     outage won't appear (we don't have them yet), but the LAST
//     working menu image keeps rendering.
//
// How render-from-cache works:
//   • useState initializers read localStorage synchronously on first
//     render. If we have a cached config, the TV paints the last
//     working menu IMMEDIATELY — before Firestore even tries to
//     connect. Bootstrapping a rebooted-but-offline Pi works.
//
// Boundaries / failure modes still on the table:
//   • Cold boot with NO previous successful connection + Wi-Fi down
//     → there's nothing to render. We show a friendly "Reconnecting"
//     splash with the DD Mau logo, not white. SW caching the app
//     shell would help here, future work.
//   • Browser localStorage disabled (quota, private mode) → cache
//     reads/writes silently fail; behavior degrades to pre-fix.

const CACHE_PREFIX = 'ddmau:tv_cache:';
// 7 days — old enough to cover a long weekend reboot, young enough
// that a forgotten Pi pulled out of storage doesn't paint a customer-
// facing screen with last spring's menu.
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function loadJSON(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { /* quota or disabled — ignore */ }
}

// 2026-05-23 hardening: cached payloads now wrap as
//   { cachedAt: ms, payload: <original> }
// so we can reject anything older than CACHE_MAX_AGE_MS at read time.
// Back-compat: if a load returns an unwrapped value (older Pi that
// already had cache from before this change), we return it as-is and
// the next save rewraps it. After one good Firestore round-trip every
// cache is in the new shape.
function unwrapCache(raw) {
    if (!raw) return null;
    // Already-wrapped: has cachedAt + payload keys.
    if (typeof raw === 'object' && raw !== null
        && 'cachedAt' in raw && 'payload' in raw) {
        const age = Date.now() - Number(raw.cachedAt || 0);
        if (age > CACHE_MAX_AGE_MS) {
            // Better to render the splash + a fresh Firestore round-trip
            // than show stale prices in front of a customer.
            return null;
        }
        return raw.payload;
    }
    // Pre-wrap legacy shape — accept once, gets rewrapped on next save.
    return raw;
}

function wrapCache(payload) {
    return { cachedAt: Date.now(), payload };
}

function loadCachedTvConfig(tvId) {
    return unwrapCache(loadJSON(CACHE_PREFIX + 'config:' + tvId));
}
function saveCachedTvConfig(tvId, cfg) {
    if (!cfg) return;
    // Firestore Timestamps survive JSON as {seconds, nanoseconds};
    // we never call toMillis() on them in this file's render path,
    // so a round-trip through JSON is safe.
    saveJSON(CACHE_PREFIX + 'config:' + tvId, wrapCache(cfg));
}

function loadCachedOverrides(tvId) {
    const arr = unwrapCache(loadJSON(CACHE_PREFIX + 'overrides:' + tvId));
    return new Map(Array.isArray(arr) ? arr : []);
}
function saveCachedOverrides(tvId, map) {
    if (!(map instanceof Map)) return;
    saveJSON(CACHE_PREFIX + 'overrides:' + tvId, wrapCache(Array.from(map.entries())));
}

function loadCachedSixed(tvId) {
    const arr = unwrapCache(loadJSON(CACHE_PREFIX + '86:' + tvId));
    return new Set(Array.isArray(arr) ? arr : []);
}
function saveCachedSixed(tvId, set) {
    if (!(set instanceof Set)) return;
    saveJSON(CACHE_PREFIX + '86:' + tvId, wrapCache(Array.from(set)));
}

// ─── Error boundary ──────────────────────────────────────────────
// Catches any render error in the menu tree and falls back to the
// "we'll be right back" splash instead of letting Chromium show the
// raw error overlay (or worse, a blank white viewport).
//
// 2026-05-23 hardening: the original version logged to console only
// and stayed on the splash FOREVER until a manager rebooted the Pi.
// Andrew got bitten when a screen sat on "Display reloading" through
// a lunch rush and no one noticed. Three additions:
//
//   1. Write the crash to /tv_crash_logs/{tvId}_{ts} so the admin
//      dashboard can surface a red badge on that TV's card.
//   2. After 30s on the splash, force a full page reload — usually
//      a transient bad snapshot (e.g., a half-written tv_config) and
//      the second render succeeds. Bounded by maxAutoReloads so we
//      don't crash-reload-crash-reload forever during a real bug.
//   3. componentWillUnmount clears the recover timer so we don't
//      leak it during normal unmount paths (parent route change etc).
//
// componentDidCatch only fires for synchronous render errors; async
// errors (failed image loads, etc.) don't trigger it, which is fine
// — those don't blank the screen anyway.
class TvErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
        this.recoverTimer = null;
        // Stored on window so it survives reloads — otherwise a real
        // bug would crash-loop forever (each reload resets state).
        // After 3 reloads in 10 min we stop reloading and just sit on
        // the splash; manager intervention required at that point.
        this.maxAutoReloads = 3;
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, info) {
        console.error('MenuDisplay render crashed:', error, info);
        // Best-effort Firestore log — wrapped in try so a Firestore
        // failure doesn't itself crash the boundary.
        try {
            const tvId = this.props.tvId || 'unknown';
            const docId = `${tvId}_${Date.now()}`;
            setDoc(doc(db, 'tv_crash_logs', docId), {
                tvId,
                message: String(error?.message || error).slice(0, 500),
                stack: String(error?.stack || '').slice(0, 2000),
                componentStack: String(info?.componentStack || '').slice(0, 2000),
                userAgent: typeof navigator !== 'undefined'
                    ? navigator.userAgent.slice(0, 200) : null,
                url: typeof location !== 'undefined' ? location.href.slice(0, 300) : null,
                crashedAt: serverTimestamp(),
            }).catch(err => console.warn('crash log write failed:', err));
        } catch (e) {
            console.warn('crash log try-block failed:', e);
        }
        // Auto-recover: schedule a reload in 30s. Track reload count in
        // sessionStorage with a 10-min rolling window so a real bug
        // doesn't pin us in a reload loop.
        try {
            const RELOAD_KEY = 'ddmau:tv_crash_reloads';
            const now = Date.now();
            const raw = sessionStorage.getItem(RELOAD_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            const recent = arr.filter(t => now - t < 10 * 60 * 1000);
            if (recent.length < this.maxAutoReloads) {
                recent.push(now);
                sessionStorage.setItem(RELOAD_KEY, JSON.stringify(recent));
                this.recoverTimer = setTimeout(() => {
                    if (typeof location !== 'undefined') location.reload();
                }, 30_000);
            } else {
                console.warn(`TvErrorBoundary: max auto-reloads (${this.maxAutoReloads}) hit in 10 min, sitting on splash`);
            }
        } catch (e) {
            console.warn('auto-recover scheduling failed:', e);
        }
    }
    componentWillUnmount() {
        if (this.recoverTimer) {
            clearTimeout(this.recoverTimer);
            this.recoverTimer = null;
        }
    }
    render() {
        if (this.state.hasError) return <ReconnectingSplash subtitle="Display reloading" />;
        return this.props.children;
    }
}

// ─── Reconnecting splash ─────────────────────────────────────────
// Full-screen brand-colored placeholder for the first-paint-no-cache
// case (and the error boundary fallback). Never shows a plain white
// viewport to a customer standing at the counter.
function ReconnectingSplash({ subtitle = 'Connecting…' }) {
    return (
        <div className="fixed inset-0 bg-dd-green text-white flex flex-col items-center justify-center">
            <div className="text-7xl font-black tracking-tight leading-none">DD MAU</div>
            <div className="text-2xl font-bold opacity-80 mt-3">{subtitle}</div>
            <div className="text-base opacity-60 mt-8 animate-pulse">●  ●  ●</div>
        </div>
    );
}

// ─── Offline indicator ───────────────────────────────────────────
// Small corner badge shown when we haven't received a Firestore
// snapshot in a while. Auto-hides when the next tick arrives. Sits
// in the corner so it's visible to staff (who know what it means)
// but doesn't dominate the customer's view of the menu.
function OfflineBadge({ minutesAgo }) {
    return (
        <div
            className="fixed bottom-3 right-3 z-40 bg-red-600 text-white px-3 py-1.5 rounded-full text-xs font-bold shadow-lg flex items-center gap-1.5 pointer-events-none"
            style={{ opacity: 0.92 }}
        >
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            Offline · {minutesAgo < 1 ? 'just now' : `${minutesAgo} min`}
            <span className="opacity-70">· cached</span>
        </div>
    );
}

const LOC_LABEL = {
    webster: 'Webster',
    maryland: 'MD Heights',
};

// Normalize for 86 fuzzy matching (strip diacritics + punctuation).
function normalizeName(s) {
    return String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function MenuDisplayInner({ tvId = 'webster' }) {
    // Initial state reads from localStorage SYNCHRONOUSLY on first
    // render. If the Pi previously cached a working config, the TV
    // paints the last good menu before Firestore even attempts a
    // connection — so a Wi-Fi-down reboot doesn't blank the screen.
    const [tvConfig, setTvConfig] = useState(() => loadCachedTvConfig(tvId));
    const [overrides, setOverrides] = useState(() => loadCachedOverrides(tvId));
    const [sixed, setSixed] = useState(() => loadCachedSixed(tvId));
    const [sixedUpdatedAt, setSixedUpdatedAt] = useState(null);
    const [now, setNow] = useState(() => new Date());

    // Last time ANY Firestore snapshot fired successfully. Used to
    // decide whether we're offline (no ticks in >60s) and how stale
    // the cached data is. Updated in every snapshot callback below.
    const [lastSnapshotAt, setLastSnapshotAt] = useState(() => Date.now());

    // Subscribe to the TV's config doc. Falls back to defaults for
    // the reserved 'webster'/'maryland' ids when no doc exists.
    // Every successful snapshot writes through to localStorage so a
    // subsequent reboot can render the last known config without
    // the network.
    useEffect(() => {
        const unsub = subscribeTvConfig(tvId, (cfg) => {
            setTvConfig(cfg);
            saveCachedTvConfig(tvId, cfg);
            setLastSnapshotAt(Date.now());
        });
        return unsub;
    }, [tvId]);

    // 2026-05-23 Holiday Scheduler: subscribe to /tv_holidays and pick
    // the active one (if any) for THIS tvId + location. Cached to
    // localStorage so a Pi reboot during Tết keeps showing festive
    // content even before Firestore reconnects.
    const [holidaysList, setHolidaysList] = useState(() => {
        const arr = unwrapCache(loadJSON(CACHE_PREFIX + 'holidays'));
        return Array.isArray(arr) ? arr : [];
    });
    useEffect(() => {
        // 2026-05-24 audit fix: was subscribing to the ENTIRE
        // /tv_holidays collection — every Pi pulled past holidays from
        // 2026, 2027, etc. forever. Holidays have a dateEnd field
        // (YYYY-MM-DD); only ones still upcoming or active need to
        // ride on TVs. Filter to anything ending today-or-later. The
        // cap of 50 is a sanity guard against future runaway writes
        // — DD Mau realistically has <20 holiday entries pending at
        // any moment.
        const todayCentral = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Chicago',
            year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        const q = query(
            collection(db, 'tv_holidays'),
            where('dateEnd', '>=', todayCentral),
            limit(50),
        );
        const unsub = onSnapshot(q, (snap) => {
            const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            setHolidaysList(list);
            saveJSON(CACHE_PREFIX + 'holidays', wrapCache(list));
            setLastSnapshotAt(Date.now());
        }, (err) => console.warn('tv_holidays subscribe failed:', err));
        return unsub;
    }, []);

    const location = tvConfig?.location || (tvId === 'maryland' ? 'maryland' : 'webster');

    // Active holiday + merged config with overlay applied. `tvConfig`
    // is what we read directly; `effectiveConfig` is what the rest of
    // the render path uses. When no holiday matches, they're identical.
    const { effectiveConfig, activeHoliday } = useMemo(() => {
        const h = resolveActiveHoliday(holidaysList, { tvId, location, now });
        if (!h) return { effectiveConfig: tvConfig, activeHoliday: null };
        const merged = applyHolidayOverlay(tvConfig, h);
        return { effectiveConfig: merged.config, activeHoliday: merged.holiday };
    }, [holidaysList, tvConfig, tvId, location, now]);

    const mode = effectiveConfig?.mode || MODES.MENU;
    const layout = effectiveConfig?.layout || 'dense';
    const showPhotos = effectiveConfig?.showPhotos === true;
    const rotateSeconds = Math.max(3, Math.min(60, Number(effectiveConfig?.rotateSeconds) || DEFAULT_ROTATE_SECONDS));

    // Daypart resolution — if the TV config has a `dayparts` schedule,
    // pick the one that covers the current hour and use ITS imageUrls /
    // hitZones / imageRotateSeconds instead of the top-level fields.
    // The `now` clock state already ticks every 30s so we'll switch
    // dayparts within at most 30s of the boundary.
    //
    // 2026-05-23: switched from resolveActiveDaypart to the "OrLast"
    // variant. The strict version returned null in any gap between
    // dayparts (e.g. Breakfast 7-11 + Lunch 12-15 → 11:00-12:00
    // returned null → blank screen if no top-level imageUrls fallback
    // was set). The new helper falls back to the most-recent past
    // daypart's content. Marked with _isFallback for future UI hints.
    const activeDaypart = useMemo(
        () => resolveActiveOrLastDaypart(effectiveConfig?.dayparts, now),
        [effectiveConfig?.dayparts, now]);
    const imageUrls = Array.isArray(activeDaypart?.imageUrls)
        ? activeDaypart.imageUrls
        : (Array.isArray(effectiveConfig?.imageUrls) ? effectiveConfig.imageUrls : []);
    const imageHitZones = Array.isArray(activeDaypart?.imageHitZones)
        ? activeDaypart.imageHitZones
        : (Array.isArray(effectiveConfig?.imageHitZones) ? effectiveConfig.imageHitZones : []);
    const imageRotateSeconds = Math.max(3, Math.min(60,
        Number(activeDaypart?.imageRotateSeconds)
        || Number(effectiveConfig?.imageRotateSeconds)
        || DEFAULT_IMAGE_ROTATE_SECONDS));
    // Slideshow transition style + speed. Daypart wins over top-level
    // so a "Dinner" daypart with ken-burns can sit on top of a default
    // fade for the rest of the day. Falls back to 'fade' + 700ms which
    // is what every TV showed before this feature shipped.
    const imageTransition = activeDaypart?.imageTransition || effectiveConfig?.imageTransition || 'fade';
    const imageTransitionMs = Math.max(100, Math.min(3000,
        Number(activeDaypart?.imageTransitionMs)
        || Number(effectiveConfig?.imageTransitionMs)
        || 700));
    // Shuffle + fit knobs from the editor. Same daypart-wins fallback
    // chain. Shuffle defaults false (deterministic order matters for
    // menu PDFs); fit defaults 'contain' (letterbox + show full image,
    // matches the historical behavior before this knob existed).
    const imageShuffle = (activeDaypart?.imageShuffle ?? effectiveConfig?.imageShuffle) === true;
    const imageFit = (activeDaypart?.imageFit || effectiveConfig?.imageFit) === 'cover' ? 'cover' : 'contain';
    const includeCategories = Array.isArray(effectiveConfig?.includeCategories) && effectiveConfig.includeCategories.length > 0
        ? new Set(effectiveConfig.includeCategories) : null;
    const spotlightCategory = effectiveConfig?.spotlightCategory || null;

    // Subscribe to admin menu overrides (price/desc/photo edits +
    // custom items). Pure overlay, no Firestore reads in render.
    // Cached locally so the menu still reflects the last known
    // price/86/custom-item state during a Wi-Fi outage.
    useEffect(() => {
        const unsub = subscribeMenuOverrides((next) => {
            setOverrides(next);
            saveCachedOverrides(tvId, next);
            setLastSnapshotAt(Date.now());
        });
        return unsub;
    }, [tvId]);

    // Subscribe to the location's 86 list. Cached per-tvId so the
    // SOLD-OUT overlays survive a reboot — customers shouldn't see
    // a "this item is available" message for something the kitchen
    // already 86'd, just because the Pi rebooted offline.
    useEffect(() => {
        const ref = doc(db, 'ops', `86_${location}`);
        const unsub = onSnapshot(ref, (snap) => {
            const data = snap.exists() ? snap.data() : null;
            const items = Array.isArray(data?.items) ? data.items : [];
            const outOfStock = items.filter(i => i?.status === 'OUT_OF_STOCK' && i?.name);
            const nextSet = new Set(outOfStock.map(i => normalizeName(i.name)));
            setSixed(nextSet);
            saveCachedSixed(tvId, nextSet);
            setSixedUpdatedAt(new Date());
            setLastSnapshotAt(Date.now());
        }, (err) => console.warn('86 listener failed:', err));
        return unsub;
    }, [location, tvId]);

    // Online/offline detection. Combines navigator.onLine (cheap,
    // reactive to OS-level changes) with a "haven't seen Firestore
    // in >60s" check (catches the case where Wi-Fi reports online
    // but the connection can't actually reach the Firestore
    // servers). Either signal flips the offline badge on.
    const [navOnline, setNavOnline] = useState(() => typeof navigator !== 'undefined' ? navigator.onLine !== false : true);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        function on()  { setNavOnline(true); }
        function off() { setNavOnline(false); }
        window.addEventListener('online', on);
        window.addEventListener('offline', off);
        return () => {
            window.removeEventListener('online', on);
            window.removeEventListener('offline', off);
        };
    }, []);
    const minutesSinceSnap = Math.max(0, Math.round((now.getTime() - lastSnapshotAt) / 60000));
    const showOfflineBadge = !navOnline || minutesSinceSnap >= 2;

    // Live clock — also a "feed alive" cue. Frozen clock = reboot.
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 30_000);
        return () => clearInterval(t);
    }, []);

    // Heartbeat — write to /tv_heartbeats/{tvId} every minute. The
    // checkTvHeartbeats Cloud Function looks at lastSeenAt and pings
    // admins when a TV goes quiet (>10 min). Wave 7 of "match the
    // SaaS leaders" — Raydiant / ScreenCloud both surface "device
    // offline" alerts. Ours is integrated into the existing FCM/SMS
    // notification dispatcher.
    useEffect(() => {
        if (!tvId) return;
        const write = () => {
            setDoc(doc(db, 'tv_heartbeats', tvId), {
                tvId,
                lastSeenAt: serverTimestamp(),
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : null,
            }, { merge: true }).catch(err => console.warn('tv heartbeat failed:', err));
        };
        write();   // initial heartbeat on mount
        const id = setInterval(write, 60_000);
        return () => clearInterval(id);
    }, [tvId]);

    // Andrew 2026-05-30 Phase 1.E — base menu now comes from the
    // Firestore-backed useMenuConfigLegacy hook, with MENU_DATA as
    // cold-boot fallback (the hook handles that internally). The
    // existing /menu_items override layer still applies on top of
    // whatever base the hook returns, so per-item price/desc tweaks
    // continue to work. Edits in MenuConfigEditor (Admin) flow to
    // every TV within seconds via the onSnapshot inside the hook.
    const { menu: liveMenuBase } = useMenuConfigLegacy();
    const menu = useMemo(() => {
        const base = (liveMenuBase && liveMenuBase.length > 0) ? liveMenuBase : MENU_DATA;
        const merged = applyMenuOverrides(base, overrides);
        if (!includeCategories) return merged;
        return merged.filter(c => includeCategories.has(c.category));
    }, [liveMenuBase, overrides, includeCategories]);

    // Check 86 status. Try several name variants since the 86 doc
    // might list under different conventions.
    const is86d = useMemo(() => {
        return (item, cat) => {
            if (!item?.nameEn) return false;
            const candidates = [
                item.nameEn,
                `${item.nameEn} ${cat.category}`,
                `${cat.category} ${item.nameEn}`,
            ].map(normalizeName);
            return candidates.some(n => n && sixed.has(n));
        };
    }, [sixed]);

    // Holiday banner — slim strip ABOVE the main header. Only rendered
    // when an active holiday has banner text set. Bilingual + Vietnamese
    // fields rotate on a 6s interval so the same strip serves customers
    // in EN/ES/VI without taking extra screen real estate.
    // 2026-05-23 Holiday Scheduler.
    const [bannerLangIdx, setBannerLangIdx] = useState(0);
    useEffect(() => {
        if (!activeHoliday?._bannerText) return;
        const langs = ['en', 'es', 'vi'].filter(k => !!activeHoliday._bannerText[k]);
        if (langs.length <= 1) return;
        const id = setInterval(() => {
            setBannerLangIdx(i => (i + 1) % langs.length);
        }, 6000);
        return () => clearInterval(id);
    }, [activeHoliday?._bannerText]);
    const accentBg = activeHoliday?._accentColor || null;
    const bannerNode = activeHoliday?._bannerText ? (() => {
        const langs = ['en', 'es', 'vi'].filter(k => !!activeHoliday._bannerText[k]);
        const text = activeHoliday._bannerText[langs[bannerLangIdx % langs.length] || 'en'] || '';
        const countdown = activeHoliday._showCountdown
            ? daysUntilHoliday(activeHoliday, now) : null;
        const countdownLabel = countdown !== null && countdown > 0
            ? ` · ${countdown} day${countdown === 1 ? '' : 's'} away` : '';
        return (
            <div className="flex items-center justify-center px-6 py-1.5 text-white font-bold text-base tracking-wide flex-shrink-0 shadow-inner"
                style={{ backgroundColor: accentBg || '#15803d' }}>
                <span>{text}{countdownLabel}</span>
            </div>
        );
    })() : null;

    const headerNode = (
        <>
            {bannerNode}
            <header
                className={`text-white px-8 py-4 flex items-baseline justify-between flex-shrink-0 shadow-md ${accentBg ? '' : 'bg-dd-green'}`}
                style={accentBg ? { backgroundColor: accentBg } : undefined}>
                <div className="flex items-baseline gap-5">
                    <div className="text-5xl font-black tracking-tight leading-none">
                        DD MAU
                    </div>
                    <div className="text-xl font-bold opacity-90 tracking-wide">
                        {effectiveConfig?.label || LOC_LABEL[location] || location}
                    </div>
                </div>
                <div className="text-lg font-bold opacity-90 tabular-nums">
                    {now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
                    <span className="mx-2 opacity-50">•</span>
                    {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </div>
            </header>
        </>
    );

    const footerNode = (
        <footer className="bg-dd-bg border-t border-dd-line px-8 py-2 flex items-center justify-between flex-shrink-0 text-dd-text-2">
            <div className="text-[13px] font-bold tracking-wide">
                Vietnamese Fast Casual
            </div>
            <div className="flex items-center gap-2 text-[12px]">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="font-bold">Live menu</span>
                {sixedUpdatedAt && sixed.size > 0 && (
                    <span className="opacity-60 ml-1">
                        · {sixed.size} sold out today
                    </span>
                )}
            </div>
            <div className="text-[12px] opacity-60">
                ddmau.com
            </div>
        </footer>
    );

    // Image mode renders the uploaded PDF/JPEG full-bleed (no header
    // / footer chrome) so the designer's menu fills the entire TV.
    // A tiny live indicator + clock stays in the top-right corner so
    // staff can confirm the feed is alive at a glance.
    if (mode === MODES.IMAGE) {
        return (
            <>
                <ImageModeLayout
                    imageUrls={imageUrls}
                    imageRotateSeconds={imageRotateSeconds}
                    imageTransition={imageTransition}
                    imageTransitionMs={imageTransitionMs}
                    imageShuffle={imageShuffle}
                    imageFit={imageFit}
                    imageHitZones={imageHitZones}
                    sixed={sixed}
                    now={now}
                    label={tvConfig?.label || LOC_LABEL[location] || location}
                    daypartLabel={activeDaypart?.label || null}
                />
                <PromoStrip promoStrip={tvConfig?.promoStrip} />
                {showOfflineBadge && <OfflineBadge minutesAgo={minutesSinceSnap} />}
            </>
        );
    }

    if (mode === MODES.SPLIT) {
        const split = tvConfig?.split || {};
        return (
            <>
                <SplitModeLayout
                    leftImageUrls={Array.isArray(split.leftImageUrls) ? split.leftImageUrls : []}
                    leftRotateSeconds={Math.max(3, Math.min(60, Number(split.leftRotateSeconds) || DEFAULT_IMAGE_ROTATE_SECONDS))}
                    rightImageUrls={Array.isArray(split.rightImageUrls) ? split.rightImageUrls : []}
                    rightRotateSeconds={Math.max(3, Math.min(60, Number(split.rightRotateSeconds) || DEFAULT_IMAGE_ROTATE_SECONDS))}
                    leftWidthPct={Math.max(50, Math.min(85, Number(split.leftWidthPct) || 70))}
                    imageHitZones={imageHitZones}
                    sixed={sixed}
                    now={now}
                    label={tvConfig?.label || LOC_LABEL[location] || location}
                />
                <PromoStrip promoStrip={tvConfig?.promoStrip} />
                {showOfflineBadge && <OfflineBadge minutesAgo={minutesSinceSnap} />}
            </>
        );
    }

    return (
        <>
            <div className="fixed inset-0 bg-white text-dd-text flex flex-col overflow-hidden font-sans">
                {headerNode}
                {layout === 'rotate' ? (
                    <RotateLayout menu={menu} is86d={is86d} showPhotos={showPhotos} rotateSeconds={rotateSeconds} />
                ) : layout === 'spotlight' ? (
                    <SpotlightLayout menu={menu} is86d={is86d} showPhotos={showPhotos} spotlightCategory={spotlightCategory} />
                ) : (
                    <DenseLayout menu={menu} is86d={is86d} showPhotos={showPhotos} />
                )}
                {footerNode}
            </div>
            <PromoStrip promoStrip={tvConfig?.promoStrip} />
            {showOfflineBadge && <OfflineBadge minutesAgo={minutesSinceSnap} />}
        </>
    );
}

// Default export wraps the menu in an error boundary so any render
// crash falls back to the brand-colored "we'll be right back" splash
// instead of a blank white viewport. Customers should never see a
// raw error in a restaurant.
export default function MenuDisplay(props) {
    return (
        // tvId passed so the boundary can tag the Firestore crash log
        // with which TV blew up — admin dashboard needs this to badge
        // the right device card.
        <TvErrorBoundary tvId={props.tvId}>
            <MenuDisplayInner {...props} />
        </TvErrorBoundary>
    );
}

// ── Image / PDF mode ─────────────────────────────────────────
// Full-bleed image fill. If multiple pages, fades between them
// every `rotateSeconds`. Minimal corner indicator (live dot +
// clock) for staff confidence that the feed is running.
//
// SOLD OUT overlays:
//   When `imageHitZones` is configured, each zone is a rectangle
//   (fractions of the natural image dims) tied to a MENU_DATA
//   item name. When that item is in the 86 list, we render a
//   semi-transparent red sticker at the zone's coordinates so
//   customers see SOLD OUT directly on the menu image. The image
//   itself is untouched — the overlay sits on top in a layer
//   that's positioned identically to the image area.
//
//   Trick for getting overlay alignment right with object-contain
//   letterboxing: we render the image inside a container whose
//   aspect-ratio is locked to the image's natural aspect ratio.
//   The container fits the screen via max-w / max-h, and the
//   image fills the container exactly (no letterbox inside the
//   container). Overlays are positioned absolute inside the
//   container at fractional coordinates — they always land on
//   the right pixels regardless of TV size.
function ImageModeLayout({
    imageUrls, imageRotateSeconds, imageHitZones = [],
    sixed, now, label, daypartLabel,
    embedded = false,           // when used inside SplitModeLayout, drop fixed positioning
    suppressIndicator = false,  // hide the corner pill (the embedding parent already shows it)
    // Audit follow-up 2026-05-23. Six transition styles selectable
    // from the editor. Default 'fade' preserves the previous behavior
    // (700ms opacity cross-fade) so existing TVs see no change until
    // admin picks a new style.
    imageTransition = 'fade',
    imageTransitionMs = 700,
    imageShuffle = false,
    imageFit = 'contain',
}) {
    const [idx, setIdx] = useState(0);
    // Track natural dims per page so we can size each container to
    // its image's aspect ratio. Updated on each img's onLoad.
    const [naturalDims, setNaturalDims] = useState({});
    // Parent rect — used to compute EXACT image-fit dimensions so
    // overlay coords (stored as fractions of the natural image)
    // land on the right pixels regardless of letterboxing. Fixes
    // Andrew 2026-05-20: "the menu over lay doesnt really work" —
    // root cause was a CSS aspect-ratio + width:100%/height:100%
    // conflict in the container, which sized the wrapper to the
    // VIEWPORT and let the image letterbox inside; overlays were
    // positioned against the wrapper not the image.
    const wrapperRef = useRef(null);
    const [parentBox, setParentBox] = useState({ w: 0, h: 0 });
    useEffect(() => {
        if (!wrapperRef.current) return;
        const update = () => {
            const r = wrapperRef.current.getBoundingClientRect();
            setParentBox({ w: r.width, h: r.height });
        };
        update();
        let ro = null;
        if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(update);
            ro.observe(wrapperRef.current);
        }
        window.addEventListener('resize', update);
        window.addEventListener('orientationchange', update);
        return () => {
            if (ro) ro.disconnect();
            window.removeEventListener('resize', update);
            window.removeEventListener('orientationchange', update);
        };
    }, []);
    const safeUrls = Array.isArray(imageUrls) ? imageUrls : [];

    // Shuffle support — when imageShuffle is on, we walk a randomized
    // order index rather than the natural array order. New shuffle is
    // generated on mount + every time we complete a full cycle so the
    // same random sequence doesn't repeat across the day. When
    // shuffle is off, order is the identity permutation (0,1,2,...)
    // which matches the previous behavior exactly.
    const [order, setOrder] = useState(() => {
        const base = safeUrls.map((_, i) => i);
        if (!imageShuffle) return base;
        // Fisher-Yates shuffle.
        for (let i = base.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [base[i], base[j]] = [base[j], base[i]];
        }
        return base;
    });
    useEffect(() => {
        // Re-derive the order when the URL list changes OR the
        // shuffle toggle flips. Without this, removing/adding a
        // photo while shuffle is on would leave a stale `order`
        // pointing at indices that no longer exist.
        const base = safeUrls.map((_, i) => i);
        if (!imageShuffle) { setOrder(base); return; }
        for (let i = base.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [base[i], base[j]] = [base[j], base[i]];
        }
        setOrder(base);
        setIdx(0);
    }, [safeUrls.length, imageShuffle]);

    useEffect(() => {
        if (safeUrls.length <= 1) return;
        const t = setInterval(() => {
            setIdx(prev => {
                const next = (prev + 1) % safeUrls.length;
                // When we complete a full cycle in shuffle mode,
                // re-shuffle so the next pass doesn't repeat the
                // same random sequence. Idempotent — only fires
                // on the wrap.
                if (imageShuffle && next === 0) {
                    setOrder(curr => {
                        const base = [...curr];
                        for (let i = base.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [base[i], base[j]] = [base[j], base[i]];
                        }
                        return base;
                    });
                }
                return next;
            });
        }, imageRotateSeconds * 1000);
        return () => clearInterval(t);
    }, [safeUrls.length, imageRotateSeconds, imageShuffle]);

    // Map the active position (idx) through the shuffle order to get
    // the actual URL index to display. When shuffle is off, order is
    // [0,1,2,...] so this is a no-op passthrough.
    const realIdx = (i) => (order[i] ?? i);

    // Preload the NEXT image in the rotation so the swap is
    // instant when the timer fires. Without this, slow restaurant
    // Wi-Fi can leave a blank slate for 1-2 seconds between
    // slides — customers see a flash of black before the next
    // image paints. We add an off-screen <img> with the next URL;
    // the browser cache populates while the current slide is up
    // and the next setIdx hits a hot cache. Videos are skipped
    // (urlIsVideo) — the browser doesn't prefetch <video> sources
    // via preload images and the data cost would be huge anyway.
    // Active URL index (after shuffle mapping). When shuffle is off,
    // order is the identity permutation so currentUrlIdx === idx and
    // everything below behaves exactly like the pre-shuffle render.
    const currentUrlIdx = realIdx(idx);
    const nextPos = (idx + 1) % Math.max(1, safeUrls.length);
    const nextUrl = safeUrls.length > 1 ? safeUrls[realIdx(nextPos)] : null;
    useEffect(() => {
        if (!nextUrl || urlIsVideo(nextUrl)) return;
        const img = new Image();
        img.decoding = 'async';
        img.src = nextUrl;
        // Browser holds the bytes in its HTTP cache even if we
        // discard this Image object — no cleanup needed.
    }, [nextUrl]);

    const containerCls = embedded
        ? 'absolute inset-0 bg-stone-900 overflow-hidden font-sans flex items-center justify-center'
        : 'fixed inset-0 bg-stone-900 overflow-hidden font-sans flex items-center justify-center';

    if (safeUrls.length === 0) {
        const emptyCls = embedded
            ? 'absolute inset-0 bg-stone-900 text-white flex flex-col items-center justify-center font-sans'
            : 'fixed inset-0 bg-stone-900 text-white flex flex-col items-center justify-center font-sans';
        return (
            <div className={emptyCls}>
                <div className="text-6xl mb-4">🖼</div>
                <div className="text-2xl font-black tracking-tight mb-2">{label}</div>
                <div className="text-base opacity-80 mb-1">No menu image uploaded yet.</div>
                <div className="text-sm opacity-60">Admin → 📺 Menu TV displays → Edit → upload PDF/JPEG.</div>
            </div>
        );
    }

    // Resolve which hit zones, on the current page, need a SOLD OUT
    // overlay AND which need a price-override overlay. A single zone
    // can have both (sold out today + new price set).
    // Hit zones are keyed by the IMAGE INDEX (z.page), not the
    // playback position. Use currentUrlIdx so shuffle keeps zones
    // aligned with their underlying image. Hit zones + shuffle is a
    // weird combination (zones are typically for menu PDFs, shuffle
    // for photo galleries) but this keeps it correct if anyone does
    // combine them.
    const zonesOnCurrentPage = imageHitZones.filter(z =>
        (z.page ?? 0) === currentUrlIdx && z.itemName);
    const activeZonesOnPage = zonesOnCurrentPage.filter(z => {
        // Fuzzy name match against the 86 set (same normalize() used
        // for data-mode matching above).
        const candidates = [
            z.itemName,
            `${z.itemName} ${z.category || ''}`,
            `${z.category || ''} ${z.itemName}`,
        ].map(normalizeName);
        return candidates.some(n => n && sixed.has(n));
    });
    const priceZonesOnPage = zonesOnCurrentPage.filter(z =>
        z.priceOverride && String(z.priceOverride).trim().length > 0);
    const qrZonesOnPage = zonesOnCurrentPage.filter(z =>
        z.qrUrl && /^https?:\/\//i.test(String(z.qrUrl).trim()));

    return (
        <div ref={wrapperRef} className={containerCls}>
            {/* Keyframes for the during-dwell animations. Defined
                inline so we don't have to edit a global stylesheet
                or invent a Tailwind plugin for two animations.
                animation-duration is set per-element via the inline
                style above so each transition uses imageRotateSeconds
                as the duration (animation completes just as the
                slide changes).
                  • tv-zoom-in: gentle 1.0 → 1.06 zoom while active.
                  • tv-ken-burns: combined zoom + diagonal pan, the
                    classic "documentary photo" effect. Alternating
                    start corners would feel more cinematic; for v1
                    we keep it consistent so the look is predictable. */}
            <style>{`
                @keyframes tv-zoom-in {
                    0%   { transform: scale(1); }
                    100% { transform: scale(1.06); }
                }
                /* Four Ken-Burns variants — each animates scale +
                   a slight diagonal pan from a different start
                   corner. Cycling through them slide-by-slide gives
                   the "documentary editor" feel where each photo
                   moves a different direction. Without alternation,
                   every shot panned the same way, which felt
                   mechanical. Andrew 2026-05-23. */
                @keyframes tv-kb-tl { 0% { transform: scale(1)    translate3d(0,    0,    0); } 100% { transform: scale(1.14) translate3d(-3%, -2%, 0); } }
                @keyframes tv-kb-tr { 0% { transform: scale(1)    translate3d(0,    0,    0); } 100% { transform: scale(1.14) translate3d( 3%, -2%, 0); } }
                @keyframes tv-kb-bl { 0% { transform: scale(1)    translate3d(0,    0,    0); } 100% { transform: scale(1.14) translate3d(-3%,  2%, 0); } }
                @keyframes tv-kb-br { 0% { transform: scale(1)    translate3d(0,    0,    0); } 100% { transform: scale(1.14) translate3d( 3%,  2%, 0); } }
                .tv-zoom-in   { animation-name: tv-zoom-in; animation-timing-function: ease-out;    animation-fill-mode: forwards; }
                .tv-kb-tl     { animation-name: tv-kb-tl;   animation-timing-function: ease-in-out; animation-fill-mode: forwards; }
                .tv-kb-tr     { animation-name: tv-kb-tr;   animation-timing-function: ease-in-out; animation-fill-mode: forwards; }
                .tv-kb-bl     { animation-name: tv-kb-bl;   animation-timing-function: ease-in-out; animation-fill-mode: forwards; }
                .tv-kb-br     { animation-name: tv-kb-br;   animation-timing-function: ease-in-out; animation-fill-mode: forwards; }
            `}</style>
            {/* Each page renders inside a container sized to the EXACT
                displayed image dimensions (via JS measurement of the
                wrapper + the image's natural aspect ratio). This is
                the fix for "overlays in wrong position": the container
                IS the image's displayed box, so overlay coordinates
                stored as fractions of the natural image land on the
                right pixels. No letterbox between container and image. */}
            {safeUrls.map((url, i) => {
                const dims = naturalDims[i];
                const aspect = dims ? (dims.w / dims.h) : null;
                // Compute the largest letterbox-fit box inside parentBox
                // that preserves the image's natural aspect ratio.
                let fitW, fitH;
                if (!aspect || !parentBox.w || !parentBox.h) {
                    // Fallback before image loads or before we've
                    // measured the parent — fill the parent. Overlays
                    // will look off for ~100ms; once dims arrive they
                    // snap to correct positions.
                    fitW = parentBox.w || '100%';
                    fitH = parentBox.h || '100%';
                } else {
                    const widthIfHeightConstrained = parentBox.h * aspect;
                    if (widthIfHeightConstrained <= parentBox.w) {
                        // Height-constrained (sides letterboxed).
                        fitW = widthIfHeightConstrained;
                        fitH = parentBox.h;
                    } else {
                        // Width-constrained (top/bottom letterboxed).
                        fitW = parentBox.w;
                        fitH = parentBox.w / aspect;
                    }
                }
                // Per-slide transition style. Computed inline so
                // each transition mode is a pure data transform —
                // no extra CSS file, no animation classes to keep
                // in sync. The active slide (i === currentUrlIdx,
                // i.e. the URL index that order[idx] maps to) is
                // fully visible at the "rest" transform; the others
                // are offset / faded / scaled depending on the mode.
                //
                // For ken-burns + zoom, we ALSO apply a CSS
                // keyframe animation to the active image element
                // itself (inside the inner div below) so the
                // image keeps moving while it's on screen.
                const isCurrent = i === currentUrlIdx;
                const ms = Math.max(100, Math.min(3000, Number(imageTransitionMs) || 700));
                const slideStyle = (() => {
                    const base = {
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: isCurrent ? 'auto' : 'none',
                    };
                    switch (imageTransition) {
                        case 'cut':
                            return {
                                ...base,
                                opacity: isCurrent ? 1 : 0,
                                transition: 'none',
                            };
                        case 'slide-left':
                            return {
                                ...base,
                                opacity: isCurrent ? 1 : 0,
                                transform: isCurrent ? 'translateX(0)' : 'translateX(100%)',
                                transition: `opacity ${ms}ms ease, transform ${ms}ms cubic-bezier(0.4,0,0.2,1)`,
                            };
                        case 'slide-up':
                            return {
                                ...base,
                                opacity: isCurrent ? 1 : 0,
                                transform: isCurrent ? 'translateY(0)' : 'translateY(100%)',
                                transition: `opacity ${ms}ms ease, transform ${ms}ms cubic-bezier(0.4,0,0.2,1)`,
                            };
                        case 'zoom':
                            return {
                                ...base,
                                opacity: isCurrent ? 1 : 0,
                                transform: isCurrent ? 'scale(1)' : 'scale(0.92)',
                                transition: `opacity ${ms}ms ease, transform ${ms}ms cubic-bezier(0.4,0,0.2,1)`,
                            };
                        case 'ken-burns':
                            // Outer layer fades; inner image runs a
                            // slow zoom-pan animation while active
                            // (set on the inner div via className
                            // below).
                            return {
                                ...base,
                                opacity: isCurrent ? 1 : 0,
                                transition: `opacity ${ms}ms ease`,
                            };
                        case 'fade':
                        default:
                            return {
                                ...base,
                                opacity: isCurrent ? 1 : 0,
                                transition: `opacity ${ms}ms ease`,
                            };
                    }
                })();
                // Per-image animation class for ken-burns / zoom-during-dwell.
                // Driven by a keyframe animation defined inline below the
                // map. Only applied when this slide IS the current one.
                // Ken Burns rotates through 4 variants (TL/TR/BL/BR) keyed
                // on idx so consecutive slides pan in different directions
                // — cinematic feel instead of every photo drifting the
                // same way.
                const KB_VARIANTS = ['tv-kb-tl', 'tv-kb-tr', 'tv-kb-bl', 'tv-kb-br'];
                const innerAnimClass = isCurrent && imageTransition === 'ken-burns'
                    ? KB_VARIANTS[idx % 4]
                    : isCurrent && imageTransition === 'zoom'
                    ? 'tv-zoom-in'
                    : '';
                return (
                    <div key={url + i}
                        className="absolute overflow-hidden"
                        style={slideStyle}>
                        <div className={`relative ${innerAnimClass}`}
                            style={{
                                width: fitW,
                                height: fitH,
                                // animationDuration matches the
                                // dwell time so the zoom completes
                                // just as we swap to the next slide.
                                animationDuration: isCurrent && (imageTransition === 'ken-burns' || imageTransition === 'zoom')
                                    ? `${imageRotateSeconds}s`
                                    : undefined,
                            }}>
                            {urlIsVideo(url) ? (
                                // Video pages — autoplay muted loops. The
                                // `muted` attribute is required for autoplay
                                // on iOS Safari + Chrome on TV browsers.
                                // playsInline keeps it from going full-screen
                                // on mobile in landscape. preload=auto so
                                // the next frame is ready when the rotation
                                // gets there.
                                <video src={url}
                                    autoPlay loop muted playsInline
                                    preload="auto"
                                    onLoadedMetadata={(e) => {
                                        const v = e.currentTarget;
                                        setNaturalDims(prev => prev[i]
                                            ? prev
                                            : { ...prev, [i]: { w: v.videoWidth || 1920, h: v.videoHeight || 1080 } });
                                    }}
                                    className={`block w-full h-full ${imageFit === 'cover' ? 'object-cover' : 'object-contain'}`}
                                    style={{ background: '#000' }} />
                            ) : (
                                <img src={url} alt=""
                                    onLoad={(e) => {
                                        const img = e.currentTarget;
                                        setNaturalDims(prev => prev[i]
                                            ? prev
                                            : { ...prev, [i]: { w: img.naturalWidth, h: img.naturalHeight } });
                                    }}
                                    className={`block w-full h-full ${imageFit === 'cover' ? 'object-cover' : 'object-contain'}`}
                                    draggable={false} />
                            )}

                            {/* Layer order from bottom up:
                                  1. QR codes (don't compete with SOLD OUT)
                                  2. Price overrides
                                  3. SOLD OUT stamps (cover everything when an
                                     item is out — sold out trumps price + QR)
                                When an item is 86'd, the SOLD OUT stamp covers
                                the QR too, which is correct: don't tempt a
                                customer to scan a QR for an out-of-stock item. */}
                            {isCurrent && qrZonesOnPage.map((zone, zi) => (
                                <QrOverlay key={`qr-${zi}`} zone={zone} />
                            ))}
                            {isCurrent && priceZonesOnPage.map((zone, zi) => (
                                <PriceOverlay key={`price-${zi}`} zone={zone} />
                            ))}
                            {isCurrent && activeZonesOnPage.map((zone, zi) => (
                                <SoldOutSticker key={`sold-${zi}`} zone={zone} />
                            ))}
                        </div>
                    </div>
                );
            })}

            {/* Corner live indicator — hidden inside split mode's
                right pane (the left pane already shows it). */}
            {!suppressIndicator && (
            <div className="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/40 backdrop-blur-sm text-white text-[10px] font-bold z-10">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="tabular-nums">{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                {daypartLabel && (
                    <span className="opacity-80 ml-1">· {daypartLabel}</span>
                )}
                {safeUrls.length > 1 && (
                    <span className="opacity-60">· {idx + 1}/{safeUrls.length}</span>
                )}
                {activeZonesOnPage.length > 0 && (
                    <span className="opacity-70 ml-1">· {activeZonesOnPage.length} sold out</span>
                )}
                {priceZonesOnPage.length > 0 && (
                    <span className="opacity-70 ml-1">· {priceZonesOnPage.length} priced</span>
                )}
            </div>
            )}
        </div>
    );
}

// ── Split mode — two image sources side-by-side ──────────────
// Andrew 2026-05-20 Wave 6 of "match the SaaS leaders". The
// "menu + photo carousel" layout that Raydiant / ScreenCloud /
// Samsung VXT use heavily on portrait drive-thru / lobby TVs.
// Left side carries the hit zones (so 86 / price / QR overlays
// still work on the menu side); right side is just a rotation.
function SplitModeLayout({
    leftImageUrls, leftRotateSeconds,
    rightImageUrls, rightRotateSeconds,
    leftWidthPct,
    imageHitZones, sixed, now, label,
}) {
    return (
        <div className="fixed inset-0 bg-stone-900 overflow-hidden flex font-sans">
            {/* LEFT — menu side with hit-zone overlays */}
            <div className="relative flex items-center justify-center"
                style={{ width: `${leftWidthPct}%`, height: '100%' }}>
                <ImageModeLayout
                    imageUrls={leftImageUrls}
                    imageRotateSeconds={leftRotateSeconds}
                    imageHitZones={imageHitZones}
                    sixed={sixed}
                    now={now}
                    label={label}
                    daypartLabel={null}
                    embedded={true} />
            </div>
            {/* RIGHT — secondary carousel (no overlays) */}
            <div className="relative flex items-center justify-center bg-black border-l border-stone-800"
                style={{ width: `${100 - leftWidthPct}%`, height: '100%' }}>
                <ImageModeLayout
                    imageUrls={rightImageUrls}
                    imageRotateSeconds={rightRotateSeconds}
                    imageHitZones={[]}
                    sixed={new Set()}
                    now={now}
                    label={label}
                    daypartLabel={null}
                    embedded={true}
                    suppressIndicator={true} />
            </div>
        </div>
    );
}

// ── Promo / announcement strip ───────────────────────────────
// Andrew 2026-05-20 Wave 3 of "match the SaaS leaders". A
// persistent text bar overlaid at the top or bottom of the TV.
// When the text is wider than the screen, scrolls horizontally
// like a marquee so long promos stay legible without truncating.
function PromoStrip({ promoStrip }) {
    if (!promoStrip || promoStrip.enabled === false) return null;
    const textEn = String(promoStrip.textEn || '').trim();
    const textEs = String(promoStrip.textEs || '').trim();
    // We don't have a language signal at this layer (the TV display
    // is anonymous public). Show both languages separated by a wide
    // bullet when both are set; otherwise just the one that exists.
    const text = textEn && textEs
        ? `${textEn}   •   ${textEs}`
        : (textEn || textEs);
    if (!text) return null;

    const position = promoStrip.position === 'top' ? 'top' : 'bottom';
    const styleKey = ['sage', 'red', 'amber', 'sky', 'dark'].includes(promoStrip.style)
        ? promoStrip.style : 'sage';
    const STYLE_CLASS = {
        // Andrew 2026-06-08: announcement green → the HOME SCREEN's background
        // sage (dd-sage #C9DBC9, the .ddmau-app-backdrop glow). It's a light
        // tint, so the text flips to dark green for contrast. (Arc: mint #2BB673
        // → sage #647D5B → match the app backdrop.) Key stays 'sage' so existing
        // TV configs keep working.
        sage:  'bg-dd-sage text-dd-green-700',
        red:   'bg-red-700 text-white',
        amber: 'bg-amber-500 text-amber-950',
        sky:   'bg-sky-700 text-white',
        dark:  'bg-stone-900 text-white',
    }[styleKey];

    const speed = Number(promoStrip.speed) || 0;
    const isScrolling = speed > 0;

    return (
        <div className={`fixed left-0 right-0 z-30 overflow-hidden px-6 py-2 font-sans font-black tracking-wide text-[clamp(14px,2vw,28px)] shadow-md ${STYLE_CLASS}`}
            style={{ [position]: 0 }}>
            {isScrolling ? (
                <div className="whitespace-nowrap"
                    style={{
                        animation: `dd-mau-promo-scroll ${Math.max(8, 100 - speed)}s linear infinite`,
                    }}>
                    {/* Duplicate the text so the scroll loops seamlessly */}
                    {text}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{text}
                </div>
            ) : (
                <div className="text-center truncate">{text}</div>
            )}
            {/* Keyframes inlined — they don't exist in the global CSS yet */}
            <style>{`
                @keyframes dd-mau-promo-scroll {
                    from { transform: translateX(0); }
                    to   { transform: translateX(-50%); }
                }
            `}</style>
        </div>
    );
}

// ── QR overlay — renders a QR code at the hit zone ───────────
// Andrew 2026-05-20 Wave 2 of "match the SaaS leaders". Common
// use cases: "Scan to order online", "Scan for catering menu",
// "Scan for nutrition info". Generated client-side via the
// qrcode npm package (already in the bundle as a lazy chunk).
//
// The QR is centered + sized to FIT inside the zone (square,
// since QR codes need a 1:1 aspect to scan). A white background
// + small label below for readability across the dining room.
function QrOverlay({ zone }) {
    const [dataUrl, setDataUrl] = useState('');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const qrcode = await import('qrcode');
                // Generate a high error-correction QR (level H) so the
                // code stays scannable even if a corner is occluded.
                const url = await qrcode.toDataURL(zone.qrUrl, {
                    errorCorrectionLevel: 'H',
                    margin: 1,
                    width: 512,   // canvas size; CSS scales to the zone
                    color: { dark: '#000000', light: '#ffffff' },
                });
                if (!cancelled) setDataUrl(url);
            } catch (e) {
                console.warn('qr generation failed:', zone.qrUrl, e);
            }
        })();
        return () => { cancelled = true; };
    }, [zone.qrUrl]);

    if (!dataUrl) return null;

    return (
        <div className="absolute pointer-events-none flex items-center justify-center"
            style={{
                left: `${zone.x * 100}%`,
                top: `${zone.y * 100}%`,
                width: `${zone.width * 100}%`,
                height: `${zone.height * 100}%`,
            }}>
            {/* White card holding the QR */}
            <div className="bg-white rounded-md shadow-lg p-1 flex items-center justify-center"
                style={{
                    // Make the QR square within the zone — use the smaller
                    // dimension so the QR doesn't overflow.
                    aspectRatio: '1 / 1',
                    maxWidth: '100%',
                    maxHeight: '100%',
                }}>
                <img src={dataUrl} alt="QR code"
                    className="w-full h-full" />
            </div>
        </div>
    );
}

// ── Price overlay — covers the printed price on the menu image ──
// Andrew 2026-05-20: "i also want to be able to change pricing".
// Renders an opaque white sticker covering the FULL hit zone, with
// bold green text showing the new price.
//
// 2026-05-20 (later) — Andrew reported "when i overlay a box over
// a price and change it it doesnt overlay it". Root cause: the
// previous version covered only the right 30% of the zone, which
// worked for full-item-row zones but failed when admin drew a
// small zone precisely over a price (30% of a tiny box = nothing
// covered). Updated to 100% coverage so the zone IS the overlay
// area — admin draws zones where they want the sticker to go.
//
// For full-row SOLD OUT support: admin can still draw a big zone
// over the whole item; the SOLD OUT stamp covers it fully. To
// also change the price, admin can draw a SECOND small zone over
// just the printed price (with the new price) — that small zone
// gets its own targeted sticker.
function PriceOverlay({ zone }) {
    return (
        <div className="absolute pointer-events-none flex items-center justify-center"
            style={{
                left: `${zone.x * 100}%`,
                top: `${zone.y * 100}%`,
                width: `${zone.width * 100}%`,
                height: `${zone.height * 100}%`,
                background: 'rgba(255, 255, 255, 0.98)',
                border: '1px solid rgba(0, 0, 0, 0.08)',
                borderRadius: '2px',
                boxShadow: '0 1px 2px rgba(0, 0, 0, 0.1)',
                // Enable container query units (cqh) on the inner
                // text so font auto-scales to the zone's height.
                // Small zones get small text, large zones get large
                // text — overlay font ~ printed price font.
                containerType: 'size',
            }}>
            <span className="font-black tabular-nums whitespace-nowrap text-dd-green-700"
                style={{
                    // 70% of zone height; falls back gracefully for
                    // browsers that don't support cqh (very rare now).
                    fontSize: 'min(70cqh, 70cqw)',
                    lineHeight: 1,
                }}>
                {zone.priceOverride}
            </span>
        </div>
    );
}

// ── SOLD OUT sticker — rendered on top of a hit zone ─────────
// Semi-transparent red overlay sized to fully cover the zone, with
// a centered "SOLD OUT" label. Drop-shadow + rotation make it feel
// like a physical stamp rather than a polite UI badge.
function SoldOutSticker({ zone }) {
    return (
        <div className="absolute pointer-events-none"
            style={{
                left: `${zone.x * 100}%`,
                top: `${zone.y * 100}%`,
                width: `${zone.width * 100}%`,
                height: `${zone.height * 100}%`,
            }}>
            {/* Background block — partial-transparency red so the
                item name underneath still reads ghosted */}
            <div className="absolute inset-0 bg-red-600/55 border-2 border-red-700 rounded shadow-lg" />
            {/* Diagonal strike band */}
            <div className="absolute inset-0 flex items-center justify-center">
                <div className="bg-red-700 text-white px-2 py-0.5 text-[clamp(10px,2vw,18px)] font-black uppercase tracking-widest shadow-2xl"
                    style={{ transform: 'rotate(-8deg)' }}>
                    Sold&nbsp;Out
                </div>
            </div>
        </div>
    );
}

// ── Item row — shared across layouts ─────────────────────────
// `size` controls type scale: 'normal', 'large' (spotlight hero),
// 'xl' (rotate-fullscreen hero).
function ItemRow({ item, sixed, showPhotos, size = 'normal' }) {
    const nameSize = size === 'xl' ? 'text-3xl' : size === 'large' ? 'text-2xl' : 'text-[19px]';
    const priceSize = size === 'xl' ? 'text-3xl' : size === 'large' ? 'text-2xl' : 'text-[19px]';
    return (
        <li className={`flex items-center gap-3 py-1 ${sixed ? 'opacity-60' : ''}`}>
            {showPhotos && item.photoUrl && (
                <img src={item.photoUrl} alt=""
                    className="flex-shrink-0 rounded-md object-cover bg-dd-bg"
                    style={{ width: size === 'normal' ? 36 : size === 'large' ? 56 : 80,
                             height: size === 'normal' ? 36 : size === 'large' ? 56 : 80 }} />
            )}
            <span className={`flex-1 font-bold leading-tight ${nameSize} ${sixed ? 'line-through decoration-[1.5px]' : ''}`}>
                {item.nameEn}
            </span>
            {sixed ? (
                <span className="px-2 py-0.5 rounded-md bg-red-600 text-white text-[10px] font-black uppercase tracking-wider whitespace-nowrap leading-tight">
                    Sold&nbsp;Out
                </span>
            ) : (
                <span className={`font-black text-dd-green-700 tabular-nums whitespace-nowrap ${priceSize}`}>
                    {item.price}
                </span>
            )}
        </li>
    );
}

// ── Layout A: dense 3-column ─────────────────────────────────
// Everything on one page. CSS-columns flow lets each category
// stay together (break-inside-avoid) while distributing the
// total content evenly across columns.
function DenseLayout({ menu, is86d, showPhotos }) {
    return (
        <main className="flex-1 px-8 py-6 overflow-hidden">
            <div className="columns-3 gap-8 h-full">
                {menu.map(cat => (
                    <section key={cat.category} className="break-inside-avoid mb-7">
                        <h2 className="text-2xl font-black text-dd-green-700 border-b-2 border-dd-green/40 pb-1 mb-2.5 uppercase tracking-wider">
                            {cat.category}
                        </h2>
                        <ul className="space-y-0.5">
                            {cat.items.map(item => (
                                <ItemRow key={item._slug || item.nameEn}
                                    item={item}
                                    sixed={is86d(item, cat)}
                                    showPhotos={showPhotos}
                                    size="normal" />
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
        </main>
    );
}

// ── Layout B: auto-rotate full-screen categories ────────────
// Cycles through one category per page. Items get xl typography
// so people across the room can read them. Page indicator dots
// at the bottom + smooth fade transition.
function RotateLayout({ menu, is86d, showPhotos, rotateSeconds }) {
    const [idx, setIdx] = useState(0);
    useEffect(() => {
        if (!menu.length) return;
        const t = setInterval(() => {
            setIdx(prev => (prev + 1) % menu.length);
        }, rotateSeconds * 1000);
        return () => clearInterval(t);
    }, [menu.length, rotateSeconds]);

    const cat = menu[idx] || menu[0];
    if (!cat) return <main className="flex-1" />;

    return (
        <main className="flex-1 px-12 py-8 overflow-hidden flex flex-col">
            <div className="flex items-baseline justify-between mb-6">
                <h2 className="text-5xl font-black text-dd-green-700 uppercase tracking-wider">
                    {cat.category}
                </h2>
                <div className="flex items-center gap-2">
                    {menu.map((_, i) => (
                        <span key={i}
                            className={`block rounded-full transition-all ${
                                i === idx ? 'bg-dd-green-700 w-6 h-2' : 'bg-dd-line w-2 h-2'
                            }`} />
                    ))}
                </div>
            </div>
            <ul className="flex-1 grid grid-cols-2 gap-x-12 gap-y-2 content-start overflow-hidden">
                {cat.items.map(item => (
                    <ItemRow key={item._slug || item.nameEn}
                        item={item}
                        sixed={is86d(item, cat)}
                        showPhotos={showPhotos}
                        size="xl" />
                ))}
            </ul>
        </main>
    );
}

// ── Layout C: spotlight (one big + others compact) ──────────
// Hero category on the left at large scale; remaining categories
// stacked in a narrow column on the right. Good for "feature a
// section" feel (e.g. spotlight today's Bowls).
function SpotlightLayout({ menu, is86d, showPhotos, spotlightCategory }) {
    if (!menu.length) return <main className="flex-1" />;
    const hero = menu.find(c => c.category === spotlightCategory) || menu[0];
    const rest = menu.filter(c => c.category !== hero.category);
    return (
        <main className="flex-1 px-8 py-6 overflow-hidden grid grid-cols-3 gap-8">
            {/* Hero (2 cols) */}
            <section className="col-span-2 flex flex-col overflow-hidden">
                <h2 className="text-4xl font-black text-dd-green-700 border-b-4 border-dd-green/40 pb-2 mb-4 uppercase tracking-wider">
                    {hero.category}
                </h2>
                <ul className="flex-1 grid grid-cols-2 gap-x-8 gap-y-1 content-start overflow-hidden">
                    {hero.items.map(item => (
                        <ItemRow key={item._slug || item.nameEn}
                            item={item}
                            sixed={is86d(item, hero)}
                            showPhotos={showPhotos}
                            size="large" />
                    ))}
                </ul>
            </section>
            {/* Rest (1 col, flowing) */}
            <aside className="overflow-hidden">
                <div className="columns-1 gap-4 h-full">
                    {rest.map(cat => (
                        <section key={cat.category} className="break-inside-avoid mb-4">
                            <h3 className="text-base font-black text-dd-green-700 border-b border-dd-green/30 pb-0.5 mb-1 uppercase tracking-wider">
                                {cat.category}
                            </h3>
                            <ul className="space-y-0">
                                {cat.items.map(item => (
                                    <li key={item._slug || item.nameEn}
                                        className={`flex items-baseline gap-2 py-0.5 text-[13px] ${is86d(item, cat) ? 'opacity-60' : ''}`}>
                                        <span className={`flex-1 font-bold leading-tight ${is86d(item, cat) ? 'line-through' : ''}`}>
                                            {item.nameEn}
                                        </span>
                                        {is86d(item, cat) ? (
                                            <span className="px-1 py-0 rounded bg-red-600 text-white text-[8px] font-black uppercase tracking-wide">
                                                Out
                                            </span>
                                        ) : (
                                            <span className="font-black text-dd-green-700 tabular-nums whitespace-nowrap">
                                                {item.price}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            </aside>
        </main>
    );
}
