// ─── Self-heal cache-bust ────────────────────────────────────────────
//
// Safari (especially iOS PWAs) is notoriously aggressive about caching
// /index.html and the SW. Even with skipWaiting() + clients.claim() on
// our SW, devices in the wild can sit on a stale bundle for days. The
// classic symptom: Andrew ships a fix, opens his PWA, and still sees
// the previous build. The only manual rescue is "delete the PWA and
// reinstall" — not a thing we want to ask 65 staff to do every week.
//
// Strategy: at boot, fetch /version.json (with cache:'no-store' to
// bypass Safari's HTTP cache) and compare its `v` field to the
// __APP_VERSION__ baked into THIS bundle at build time. If they
// differ, the live deploy is newer than what we're running — wipe
// every cache, unregister every SW, and reload. The fresh reload hits
// the network for a new index.html, which references the new bundle
// hashes, which loads the new code.
//
// Defensive guards:
//   • localStorage `ddmau:lastSelfHealAt` throttles to ≤1 reload per
//     30s, so a busted version.json (or a same-version race) can't
//     bootloop the app
//   • All network failures are swallowed (offline = stay on cached
//     version, don't crash)
//   • Runs once per page load — no polling, no timers
//
// After this lands, future deploys propagate to every device on its
// next app open. No more "did you uninstall and reinstall?" support.
async function selfHealIfStale() {
    try {
        // Loop-breaker: never run more than once per 30s.
        const last = Number(localStorage.getItem('ddmau:lastSelfHealAt') || 0);
        if (last && Date.now() - last < 30_000) return;

        const localVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
        if (!localVersion) return;

        const url = (import.meta.env.BASE_URL || '/') + 'version.json?t=' + Date.now();
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) return;
        const data = await resp.json();
        const serverVersion = data && data.v;
        if (!serverVersion || serverVersion === localVersion) return;

        // Version mismatch — the deployed bundle is newer than the
        // one we're running. Stamp the timestamp BEFORE the reload so
        // we can't loop, then wipe everything and reload.
        console.warn('[self-heal] version mismatch — local:', localVersion, 'server:', serverVersion, '— reloading');
        localStorage.setItem('ddmau:lastSelfHealAt', String(Date.now()));

        // Unregister every SW first so the fresh reload hits the network.
        if ('serviceWorker' in navigator) {
            try {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
            } catch {}
        }

        // Wipe every Cache Storage entry the old SW (or any other code)
        // may have populated.
        if ('caches' in window) {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
            } catch {}
        }

        // Force a network reload. location.reload(true) is deprecated
        // but a query string + replace() guarantees a fresh fetch
        // without polluting back-button history.
        const bustUrl = window.location.pathname + (window.location.search ? window.location.search + '&' : '?') + '_v=' + encodeURIComponent(serverVersion);
        window.location.replace(bustUrl);
    } catch {
        // Network or parse error — stay on whatever we have, don't crash.
    }
}

// Inline PWA manifest (no separate file needed)
export function setupPWA() {
    // Kick off the self-heal check immediately. Don't await — the
    // rest of setupPWA needs to run synchronously so the manifest
    // link tag lands before the user does anything. If the bundle
    // is stale, the page will reload before they get past the lock
    // screen anyway.
    selfHealIfStale();


    // Icon strategy — two purposes to keep both iOS and Android happy.
    // 2026-05-31 — Andrew Android audit. The previous manifest shipped a
    // single icon with `purpose: "any"` and an `rx=20` rounded square.
    // Android Chrome masks home-screen icons into the device-specific
    // shape (round / squircle / teardrop) and was wrapping our rounded
    // green square with a white frame on top, because we hadn't declared
    // a `maskable` variant. The fix is two icons in the array:
    //   • A `maskable` version with NO corner radius and the safe-zone
    //     centered (Android crops the outer 20% so the noodle bowl emoji
    //     stays fully visible inside the 80% safe area).
    //   • An `any` version with the original rounded square, for browsers
    //     that don't use maskable (Firefox, older Chrome).
    // The `id` field stabilizes app identity across upgrades so Chrome
    // doesn't treat each new build as a different installable app.
    const manifestData = {
        id: "/?source=pwa",
        name: "DD Mau Staff Portal",
        short_name: "DD Mau",
        description: "Staff portal for DD Mau Vietnamese Eatery",
        start_url: window.location.href.split('?')[0],
        display: "standalone",
        background_color: "#f0f7f1",
        theme_color: "#255a37",
        orientation: "portrait",
        prefer_related_applications: false,
        icons: [
            {
                // Maskable — Android home-screen safe-zone friendly.
                // Full-bleed green background (no rx), emoji centered in
                // the 80% safe zone so Android can crop to any shape
                // without cutting the design.
                src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23255a37'/><text y='66' x='50' text-anchor='middle' font-size='44'>🍜</text></svg>",
                sizes: "any",
                type: "image/svg+xml",
                purpose: "maskable"
            },
            {
                // "Any" — used by Firefox / older Chrome / contexts that
                // do not honour maskable. Same green background but with
                // rounded corners so the icon reads as a finished design
                // when shown un-masked (e.g. browser tab thumbnails).
                src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%23255a37'/><text y='70' x='50' text-anchor='middle' font-size='60'>🍜</text></svg>",
                sizes: "any",
                type: "image/svg+xml",
                purpose: "any"
            }
        ]
    };
    const manifestBlob = new Blob([JSON.stringify(manifestData)], { type: 'application/json' });
    const manifestURL = URL.createObjectURL(manifestBlob);
    const manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    manifestLink.href = manifestURL;
    document.head.appendChild(manifestLink);

    // Service worker registered from a STATIC URL (/sw.js). The previous
    // implementation used a Blob URL generated fresh on every page load,
    // which the browser treats as a different SW each time — so no auto-
    // update channel existed and stuck devices had to be manually rescued.
    //
    // Static URL → browsers fetch /sw.js periodically (~24h max, plus on
    // navigation/interaction) and update automatically when the byte
    // content changes. After this transition, future SW updates land on
    // every device without any user action.
    if ('serviceWorker' in navigator) {
        // base from vite.config.js — '/dd-mau-portal/' on Pages, '/' in dev.
        // Resolve against the page's BASE_URL so we hit the right path.
        const swURL = (import.meta.env.BASE_URL || '/') + 'sw.js';
        navigator.serviceWorker.register(swURL, { scope: import.meta.env.BASE_URL || '/' })
            .catch((e) => console.warn('SW register failed:', e));
    }
}

// PWA Install Support
export let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    window.dispatchEvent(new Event('pwainstallready'));
});
