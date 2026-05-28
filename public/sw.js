// DD Mau static service worker — replaces the inline Blob-URL SW that
// previously lived in pwa.js. Static URL is the key change: browsers
// auto-check for updates at a fixed URL on a ~24h schedule (and on
// every navigation), so future deploys propagate without users having
// to do anything.
//
// What it does:
//   • install: skipWaiting() so a new SW activates immediately
//   • activate: claim() all clients + nuke any old caches from the
//                previous Blob-URL SW era (one-time cleanup)
//   • no fetch handler — browser handles requests normally; the SW
//                exists only to satisfy PWA installability
//
// Cache-bust version stamp. Bump this when a deployment needs to
// force-evict stuck PWA bundles. Changing any byte in this file
// triggers the browser to register the SW as "new" → install →
// activate → the activate handler below wipes every cache key. This
// is the lever to pull when Andrew reports "I don't see my changes."
//   SW_VERSION = 2026-05-27.2 (kanban on My Tasks tab)

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // One-time cleanup: wipe any caches the old Blob-URL SW may have
        // populated. Cheap, idempotent, runs every activation.
        try {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        } catch {}
        // Take over any open pages immediately so the next request goes
        // through this SW (or rather, isn't intercepted at all).
        await self.clients.claim();
    })());
});

// No fetch handler. PWA installability rule only requires an SW to be
// registered; it doesn't have to intercept requests. Without a fetch
// handler, the browser handles every fetch normally — no chance of a
// caching bug bricking the app.
