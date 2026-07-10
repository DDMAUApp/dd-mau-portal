// DD Mau static service worker — replaces the inline Blob-URL SW that
// previously lived in pwa.js. Static URL is the key change: browsers
// auto-check for updates at a fixed URL on a ~24h schedule (and on
// every navigation), so future deploys propagate without users having
// to do anything.
//
// What it does:
//   • install: skipWaiting() so a new SW activates immediately
//   • activate: claim() all clients + nuke any old caches (one-time
//                cleanup of the Blob-URL SW era AND the previous asset
//                cache, so a new deploy always starts from clean bytes)
//   • fetch: cache-first for CONTENT-HASHED build assets ONLY (see the
//                hard rules on the fetch handler below)
//
// ── 2026-07-10 — cold-open speed-up (Andrew: "the app is taking a long
//    time to load"). Root cause of the felt lag: this SW cached NOTHING,
//    so every cold open re-downloaded the whole hashed bundle over slow
//    restaurant Wi-Fi. Phones evict the browser HTTP cache fast, so it
//    bit often. Fix: a NARROW, cache-first fetch handler for Vite's
//    content-hashed files under /assets/ — those are immutable (a new
//    build = a new hash), so serving them from Cache Storage can never
//    show stale code. Repeat opens now load near-instantly + work
//    offline for the code layer.
//
//    WHY THIS IS SAFE (the caching-bug guardrails — do NOT weaken these):
//      1. We NEVER intercept navigations / index.html / version.json /
//         sw.js itself, or any cross-origin or non-GET request. Those
//         always hit the network exactly as before, so the self-heal
//         version check in pwa.js (fetch version.json, compare to the
//         baked build version, wipe + reload on mismatch) keeps working.
//         Caching index.html is what bricks a PWA on a stale bundle —
//         we deliberately don't.
//      2. We only cache files whose name carries a Vite content hash
//         (…-<hash>.js|css|woff2). Immutable by construction → cache-
//         first is correct forever for them.
//      3. activate still wipes ALL caches. On a deploy the byte content
//         of THIS file must change (bump SW_VERSION), so the browser
//         installs+activates a new SW, which drops the old asset cache;
//         the new hashed assets then repopulate on demand. Between
//         deploys activate does not run, so the cache stays warm across
//         cold opens — that's where the speed win lands.
//
// Cache-bust version stamp. Bump this when a deployment needs to
// force-evict stuck PWA bundles OR when this file's behavior changes
// (changing any byte re-registers the SW → install → activate → the
// activate handler wipes every cache key). This is the lever to pull
// when Andrew reports "I don't see my changes."
//   SW_VERSION = 2026-07-10.1 (cache-first for hashed build assets)

const ASSET_CACHE = 'ddmau-assets-v1';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Wipe every cache on activation. This only runs when a NEW sw.js
        // is installed (i.e. a deploy), so it drops the previous version's
        // asset cache and lets the new hashed files repopulate fresh.
        // Idempotent + cheap.
        try {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        } catch {}
        // Take over any open pages immediately so the fetch handler below
        // starts serving them without a reload.
        await self.clients.claim();
    })());
});

// Cache-first ONLY for immutable, content-hashed build assets. Everything
// else falls through to the network untouched (no respondWith) — see the
// hard rules in the header block. Getting this predicate wrong is the one
// way to brick the app, so it is intentionally conservative.
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    let url;
    try { url = new URL(req.url); } catch { return; }

    // Same-origin only — never touch Firestore/Google/CDN/API traffic.
    if (url.origin !== self.location.origin) return;

    // Only Vite's hashed build files under an /assets/ path. The hash
    // segment (…-<8+ url-safe chars>) guarantees immutability, so a cache
    // hit can never serve stale code. index.html/version.json/sw.js don't
    // match (no /assets/ + no hash) → they stay network-only.
    const isHashedAsset = url.pathname.includes('/assets/')
        && /-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(url.pathname);
    if (!isHashedAsset) return;

    event.respondWith((async () => {
        try {
            const cache = await caches.open(ASSET_CACHE);
            const hit = await cache.match(req);
            if (hit) return hit;
            const resp = await fetch(req);
            // Only store complete, successful responses (status 200, not a
            // 206 partial or an opaque/error response).
            if (resp && resp.status === 200 && resp.type === 'basic') {
                cache.put(req, resp.clone());
            }
            return resp;
        } catch {
            // On any failure fall back to a plain network fetch so a cache
            // hiccup can never block a request.
            return fetch(req);
        }
    })());
});
