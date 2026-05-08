// Inline PWA manifest (no separate file needed)
export function setupPWA() {
    const manifestData = {
        name: "DD Mau Staff Portal",
        short_name: "DD Mau",
        description: "Staff portal for DD Mau Vietnamese Eatery",
        start_url: window.location.href.split('?')[0],
        display: "standalone",
        background_color: "#f0f7f1",
        theme_color: "#255a37",
        orientation: "portrait",
        icons: [{
            src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%23255a37'/><text y='70' x='50' text-anchor='middle' font-size='60'>🍜</text></svg>",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any"
        }]
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
