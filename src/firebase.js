import { initializeApp } from 'firebase/app';
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

export const db = getFirestore(app);
export const storage = getStorage(app);
export default app;
