// FCM background message handler.
//
// IMPORTANT: this MUST be a real .js file at the root of the origin (not an
// inline blob), because firebase/messaging looks for it at the path
// `/firebase-messaging-sw.js` and the browser only allows registering SWs
// served from same-origin. The existing inline-blob SW in src/pwa.js is for
// PWA install/cache; this one is dedicated to FCM push delivery.
//
// When the app is open, foreground messages are handled by `onMessage()` in
// the page. When the app is fully closed (or PWA killed), the browser delivers
// the push to this SW, which displays the notification.

importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

firebase.initializeApp({
    apiKey: "AIzaSyDTJccmQHzvbgwW_9_1aDDkAgK0B4PJfkQ",
    authDomain: "dd-mau-staff-app.firebaseapp.com",
    projectId: "dd-mau-staff-app",
    storageBucket: "dd-mau-staff-app.firebasestorage.app",
    messagingSenderId: "294644627803",
    appId: "1:294644627803:web:1b296e9586a7fdbfd7c27e"
});

const messaging = firebase.messaging();

// Background push handler — fires when the page is closed/backgrounded
// and a push arrives.
//
// READ FROM EITHER `data` OR `notification` field. The Cloud Function
// today sends data-only payloads (after f046973), but during a phased
// deploy the SW could be running ahead of or behind the function. We
// also coexist with the older legacy format that put title/body under
// `notification`. Reading both keeps display working regardless of
// which version is live — defense in depth.
//
// `tag` enables OS-level dedup: the OS replaces an existing
// notification with the same tag instead of stacking, so a retry from
// Cloud Functions can never produce two visible toasts.
messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    const notif = payload.notification || {};
    const title = data.title || notif.title || "DD Mau";
    const body  = data.body  || notif.body  || "";
    const tag   = data.tag   || `ddmau-${Date.now()}`;
    self.registration.showNotification(title, {
        body,
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%23255a37'/><text y='70' x='50' text-anchor='middle' font-size='60'>🍜</text></svg>",
        tag,
        renotify: false,
        data: data,
    });
});

// When a notification is clicked, focus the app or open it.
self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
            for (const c of cs) {
                if ("focus" in c) return c.focus();
            }
            if (clients.openWindow) {
                return clients.openWindow("/");
            }
        })
    );
});
