import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
    apiKey: "AIzaSyDTJccmQHzvbgwW_9_1aDDkAgK0B4PJfkQ",
    authDomain: "dd-mau-staff-app.firebaseapp.com",
    projectId: "dd-mau-staff-app",
    storageBucket: "dd-mau-staff-app.firebasestorage.app",
    messagingSenderId: "294644627803",
    appId: "1:294644627803:web:1b296e9586a7fdbfd7c27e"
};

const app = initializeApp(firebaseConfig);

// ── Firebase App Check ────────────────────────────────────────────────
// Locks Firestore + Storage so they only respond to traffic that proves
// it's coming from THIS web app (verified via reCAPTCHA v3 token).
// Random scripts hitting the Firebase project from elsewhere — even if
// they have the public API key — get blocked.
//
// Registered in the Firebase Console → App Check → Apps (2026-05-11).
// reCAPTCHA v3 site key below is public-safe; the matching secret key
// lives in Firebase and validates each token server-side.
//
// Currently the Firestore + Storage API enforcement is UNENFORCED in
// the console. Tokens are generated and sent but not yet rejected on
// failure. Once we verify nothing breaks under real usage we flip the
// console to Enforced. After that, requests without a valid token
// (i.e. anyone who isn't actually running the deployed app) fail at
// the API layer.
//
// Skip App Check on localhost dev so vite hot-reload doesn't choke on
// reCAPTCHA failures during development. Vite sets import.meta.env.PROD
// to true on prod builds.
if (typeof window !== 'undefined' && import.meta.env.PROD) {
    try {
        initializeAppCheck(app, {
            provider: new ReCaptchaV3Provider('6LcHNuUsAAAAANWkNvePE7_dzmyWQZY5rsobSzG1'),
            isTokenAutoRefreshEnabled: true,
        });
    } catch (e) {
        // Non-fatal: if App Check init fails (no network, blocked by an
        // extension, etc.) we still want the app to render. Once
        // enforcement is on, the per-request token check will surface
        // any real init issue as a clear error.
        console.warn('[AppCheck] init failed (will retry on next load):', e);
    }
}

export const db = getFirestore(app);
export const storage = getStorage(app);
export default app;
