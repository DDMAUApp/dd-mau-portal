// Frontend FCM helper.
//
// Two responsibilities:
//   1. Request notification permission AND fetch the FCM token (one device → one token)
//   2. Persist that token on the user's staff record so the Cloud Function can target it
//
// Tokens are stored as `fcmTokens: [{token, lastSeen}]` on each staff doc inside
// the `config/staff.list` array. Up to 5 tokens per staff (covers phone + tablet
// + laptop). Older tokens get rotated out.
//
// VAPID KEY: get the public key from Firebase Console → Project Settings →
// Cloud Messaging → Web Push certificates → Generate key pair, then paste the
// PUBLIC key string here. Without it, getToken() will fail.
import { getMessaging, getToken, onMessage, isSupported } from "firebase/messaging";
import { doc, setDoc } from "firebase/firestore";
import app, { db } from "./firebase";

// ⚠️ REPLACE THIS PLACEHOLDER ⚠️
// Firebase Console → ⚙️ Project Settings → Cloud Messaging tab →
//   "Web configuration" section → Web Push certificates → "Generate key pair"
// Copy the PUBLIC key (starts with B...) and paste it below.
export const VAPID_KEY = "BH2Mtj6Dgfw2X_Mu7e9OzOTVOqx_l6KjgDgc6v98Cq_4ngWZnz3NPYP81mw88_zEY_4tOnKBW2XTScLOrFfNpoQ";

const MAX_TOKENS_PER_STAFF = 5;

let messagingInstance = null;
async function getMessagingSafely() {
    if (messagingInstance) return messagingInstance;
    try {
        if (!(await isSupported())) return null;
        messagingInstance = getMessaging(app);
        return messagingInstance;
    } catch (e) {
        console.warn("FCM not available in this environment:", e);
        return null;
    }
}

/**
 * Request permission AND fetch the FCM token. Persists the token on the user's
 * staff record. Safe to call multiple times — duplicate tokens are de-duped,
 * and the lastSeen timestamp gets refreshed on each call.
 *
 * @param {string} staffName — current staff member's display name
 * @param {Array} staffList — full staff list (current state)
 * @param {Function} setStaffList — React setter for the local staff list
 * @returns {Promise<{ok: boolean, reason?: string, token?: string}>}
 */
export async function enableFcmPush(staffName, staffList, setStaffList) {
    if (typeof Notification === "undefined") {
        return { ok: false, reason: "no-notification-api" };
    }
    if (Notification.permission === "denied") {
        return { ok: false, reason: "permission-denied" };
    }
    if (!VAPID_KEY || VAPID_KEY === "REPLACE_WITH_VAPID_PUBLIC_KEY") {
        console.warn("VAPID key not configured — FCM disabled. See src/messaging.js.");
        return { ok: false, reason: "no-vapid-key" };
    }

    // Permission first
    if (Notification.permission !== "granted") {
        const result = await Notification.requestPermission();
        if (result !== "granted") return { ok: false, reason: "permission-denied" };
    }

    const messaging = await getMessagingSafely();
    if (!messaging) return { ok: false, reason: "messaging-unsupported" };

    // Register the FCM service worker. CRITICAL: must use the deployed base
    // path, not "/". Vite ships this site under base "/dd-mau-portal/" on
    // GitHub Pages — registering "/firebase-messaging-sw.js" 404'd, so the
    // SW never installed, so background pushes were silently dropped (the
    // user only saw foreground in-app notifications when the app was open).
    // import.meta.env.BASE_URL resolves to "/dd-mau-portal/" in production
    // and "/" in dev, so this works in both.
    const swUrl = (import.meta.env.BASE_URL || "/") + "firebase-messaging-sw.js";
    const swScope = import.meta.env.BASE_URL || "/";
    let swRegistration = null;
    if ("serviceWorker" in navigator) {
        try {
            swRegistration = await navigator.serviceWorker.register(swUrl, { scope: swScope });
        } catch (e) {
            console.warn("FCM service worker register failed:", e, "url=", swUrl);
            return { ok: false, reason: "sw-register-failed" };
        }
    }

    let token = null;
    try {
        token = await getToken(messaging, {
            vapidKey: VAPID_KEY,
            serviceWorkerRegistration: swRegistration,
        });
    } catch (e) {
        console.warn("FCM getToken failed:", e);
        return { ok: false, reason: "get-token-failed" };
    }
    if (!token) return { ok: false, reason: "no-token" };

    // Persist token on staff record. Use the FUNCTIONAL form of setStaffList
    // so we read the *latest* staffList from React state instead of the
    // closed-over snapshot — otherwise concurrent admin edits get clobbered.
    if (staffName && setStaffList) {
        let savedSnapshot = null;
        setStaffList((prev) => {
            if (!Array.isArray(prev)) return prev;
            const me = prev.find((s) => s.name === staffName);
            if (!me) return prev;
            const existing = Array.isArray(me.fcmTokens) ? me.fcmTokens : [];
            const dedup = existing.filter((t) => t && t.token && t.token !== token);
            const next = [{ token, lastSeen: Date.now() }, ...dedup].slice(0, MAX_TOKENS_PER_STAFF);
            const updated = prev.map((s) =>
                s.name === staffName ? { ...s, fcmTokens: next } : s
            );
            savedSnapshot = updated;
            return updated;
        });
        if (savedSnapshot) {
            try {
                await setDoc(doc(db, "config", "staff"), { list: savedSnapshot });
            } catch (e) {
                console.warn("Save FCM token to staff doc failed:", e);
            }
        }
    }

    return { ok: true, token };
}

/**
 * Subscribe to foreground messages — when the app is open, FCM delivers via
 * onMessage instead of the SW. Returns an unsubscribe function.
 */
export async function onForegroundMessage(handler) {
    const messaging = await getMessagingSafely();
    if (!messaging) return () => {};
    return onMessage(messaging, handler);
}
