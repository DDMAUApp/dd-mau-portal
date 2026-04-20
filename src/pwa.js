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

    // Inline service worker
    const swCode = `
        self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
        self.addEventListener('fetch', (e) => {
            e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
        });
    `;
    if ('serviceWorker' in navigator) {
        const swBlob = new Blob([swCode], { type: 'application/javascript' });
        const swURL = URL.createObjectURL(swBlob);
        navigator.serviceWorker.register(swURL, { scope: '/' }).catch(() => {});
    }
}

// PWA Install Support
export let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    window.dispatchEvent(new Event('pwainstallready'));
});
