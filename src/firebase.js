import { initializeApp } from 'firebase/app';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';

const firebaseConfig = {
    apiKey: "AIzaSyDTJccmQHzvbgwW_9_1aDDkAgK0B4PJfkQ",
    authDomain: "dd-mau-staff-app.firebaseapp.com",
    projectId: "dd-mau-staff-app",
    storageBucket: "dd-mau-staff-app.firebasestorage.app",
    messagingSenderId: "294644627803",
    appId: "1:294644627803:web:1b296e9586a7fdbfd7c27e"
};

const app = initializeApp(firebaseConfig);

// ── Firebase App Check (DISABLED 2026-05-14) ─────────────────────────
// App Check was previously initialized with ReCaptcha V3 to prep for
// future enforcement of Firestore + Storage. Server-side enforcement
// status (verified via firebaseappcheck.googleapis.com REST API):
//   • firestore.googleapis.com    — UNENFORCED
//   • firebasestorage.googleapis.com — UNENFORCED
//   • identitytoolkit.googleapis.com — UNENFORCED
//
// While enforcement was off, the client-side init was a no-op for
// security — but the ReCaptcha provider was failing on every page
// (the site key 6LcHNuUsAAAAANWkNvePE7_dzmyWQZY5rsobSzG1 was likely
// registered for an old domain, not app.ddmaustl.com). Combined with
// `isTokenAutoRefreshEnabled: true`, the SDK retried token generation
// every ~minute and dumped a stream of console errors:
//   `FirebaseError: AppCheck: ReCAPTCHA error. (appCheck/recaptcha-error)`
// That spam buried real errors and made debugging "Something went
// wrong" reports much harder.
//
// Re-enabling steps (Phase 2):
//   1. In Google reCAPTCHA admin (https://www.google.com/recaptcha/admin),
//      verify the site key has app.ddmaustl.com as an allowed domain.
//      If not, add it.
//   2. Restore the import + init block below.
//   3. Verify clean init in console.
//   4. THEN flip enforcement to ENFORCED in Firebase Console → App Check
//      → Apps for firestore.googleapis.com + firebasestorage.googleapis.com.
//      (Do NOT flip enforcement first — that breaks every client until
//      tokens are flowing correctly.)
//
// Until those steps are done, the import + init stay commented out.
//
// import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
// if (typeof window !== 'undefined' && import.meta.env.PROD) {
//     try {
//         initializeAppCheck(app, {
//             provider: new ReCaptchaV3Provider('6LcHNuUsAAAAANWkNvePE7_dzmyWQZY5rsobSzG1'),
//             isTokenAutoRefreshEnabled: true,
//         });
//     } catch (e) {
//         console.warn('[AppCheck] init failed (will retry on next load):', e);
//     }
// }

// 2026-06-05 — LOGIN FIX (Android Google Play app: "all the codes to log in
// don't work"). The default getFirestore() uses Firestore's WebChannel
// streaming transport. Inside the Android System WebView that stream
// frequently fails to establish, so the /config/staff onSnapshot never
// lands → staffList stays on DEFAULT_STAFF (every pin is "") → EVERY staff
// PIN is rejected and nobody can unlock the app. experimentalAutoDetect-
// LongPolling lets the SDK notice the stalled stream and fall back to
// long-polling. On web + iOS WKWebView (where WebChannel works) it keeps
// using WebChannel, so the web app and iPhone build are UNAFFECTED. This
// must replace getFirestore() and run before any other Firestore call —
// firebase.js is the single Firestore init site (grep-verified).
// 2026-06-16 (#3) — OFFLINE PERSISTENCE. Before this, Firestore used the
// default in-MEMORY cache: a write made while offline (back-of-house dead
// zone) resolves locally but its mutation queue is lost if the app is killed
// before reconnect — so a "sent" chat message or saved inventory count
// silently vanished (the chat retry never fired because offline writes don't
// reject). persistentLocalCache keeps that queue in IndexedDB so it survives a
// restart and syncs on reconnect. persistentMultipleTabManager is required —
// the PWA can have a home-screen instance + a browser tab open at once, and
// the single-tab manager would throw and disable persistence in that case.
//
// SAFETY (this is the login-critical init): we feature-detect IndexedDB and
// the SDK falls back to the memory cache on its own if IndexedDB can't open
// (private mode, locked-down WebView). A persistence failure degrades reads to
// the network — it never blocks login. experimentalAutoDetectLongPolling (the
// 2026-06-05 Android-login fix above) is preserved alongside it.
let _localCache;
try {
    if (typeof indexedDB !== 'undefined' && indexedDB) {
        _localCache = persistentLocalCache({ tabManager: persistentMultipleTabManager() });
    }
} catch (e) {
    console.warn('[firestore] persistent cache unavailable — using memory cache:', e?.message);
    _localCache = undefined;
}
// 2026-06-25 — Android login latency. experimentalAutoDetectLongPolling
// makes the SDK try WebChannel first, DETECT the stall, THEN fall back to
// long-polling — that detect round-trip delays the first /config/staff
// snapshot that gates the keypad (the Android-only "login is slow/glitchy"
// complaint). The Android System WebView never sustains WebChannel anyway
// (see the 2026-06-05 note above), so on Android we FORCE long-polling and
// skip the probe entirely. Web + iOS WKWebView keep auto-detect (WebChannel
// works there and is faster steady-state) — they are UNAFFECTED.
const _isAndroid = typeof window !== 'undefined' && window.Capacitor?.getPlatform?.() === 'android';
export const db = initializeFirestore(app, {
    ...(_isAndroid
        ? { experimentalForceLongPolling: true }
        : { experimentalAutoDetectLongPolling: true }),
    ...(_localCache ? { localCache: _localCache } : {}),
});
export const storage = getStorage(app);
// Cloud Functions client (region must match the deploy region in
// functions/index.js — us-central1). Currently used by chat
// translation (translateMessage callable); other callers may be
// added later.
export const functions = getFunctions(app, 'us-central1');
export default app;
