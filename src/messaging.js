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
import { doc, setDoc, runTransaction, getDoc } from "firebase/firestore";
import app, { db } from "./firebase";

// ⚠️ REPLACE THIS PLACEHOLDER ⚠️
// Firebase Console → ⚙️ Project Settings → Cloud Messaging tab →
//   "Web configuration" section → Web Push certificates → "Generate key pair"
// Copy the PUBLIC key (starts with B...) and paste it below.
export const VAPID_KEY = "BH2Mtj6Dgfw2X_Mu7e9OzOTVOqx_l6KjgDgc6v98Cq_4ngWZnz3NPYP81mw88_zEY_4tOnKBW2XTScLOrFfNpoQ";

const MAX_TOKENS_PER_STAFF = 5;
const DEVICE_ID_KEY = "ddmau:fcmDeviceId";

// Stable per-browser identifier. Generated once on first FCM registration
// and persisted to localStorage; used to deduplicate fcmTokens entries by
// PHYSICAL DEVICE (not just by token string). Without this, FCM token
// rotation + the same device appearing in multiple browser contexts (PWA
// install + tab + private window) would each get their own token and
// every push would fire N times on the device. With deviceId dedup, the
// staff record holds at most one token per browser.
function getOrCreateDeviceId() {
    try {
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if (id && id.length > 8) return id;
        // crypto.randomUUID() is available everywhere we deploy to;
        // Math.random fallback only kicks in on truly ancient browsers.
        id = (typeof crypto !== "undefined" && crypto.randomUUID)
            ? crypto.randomUUID()
            : "dev_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(DEVICE_ID_KEY, id);
        return id;
    } catch { return "dev_" + Date.now().toString(36); }
}

let messagingInstance = null;
// Module-level flag for one-shot legacy SW cleanup (see enableFcmPush).
let _swCleanedUp = false;
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

    // Register the FCM service worker on its DEDICATED scope. CRITICAL:
    // the PWA SW (src/pwa.js → /sw.js) registers at scope "/" for offline
    // caching. A browser allows only ONE active SW per scope — registering
    // FCM at scope "/" too means the two SWs stomp on each other on every
    // page load, and whichever registers SECOND invalidates the first's
    // push subscription. That kills the FCM token within seconds of being
    // issued (observed 2026-05-14 in Cloud Function logs: token works for
    // ~50s of pushes, then `registration-token-not-registered`).
    //
    // Firebase's canonical scope for messaging is
    // `/firebase-cloud-messaging-push-scope` — a dedicated namespace that
    // doesn't conflict with the PWA SW's scope "/". Push events arrive at
    // the SW regardless of scope (they come over the push subscription,
    // not fetch interception), so narrowing scope here has no functional
    // downside.
    //
    // BASE_URL is "/" in production (custom domain at apex) and "/" in dev,
    // so the resulting scope is "/firebase-cloud-messaging-push-scope".
    const swUrl = (import.meta.env.BASE_URL || "/") + "firebase-messaging-sw.js";
    const swScope = (import.meta.env.BASE_URL || "/") + "firebase-cloud-messaging-push-scope";
    let swRegistration = null;
    if ("serviceWorker" in navigator) {
        try {
            // Legacy cleanup: devices that registered before the
            // dedicated-scope fix have a firebase-messaging-sw.js
            // registration at scope "/" colliding with the PWA SW.
            // Find and unregister it before installing the new one at
            // the dedicated scope — otherwise the orphaned registration
            // sits there indefinitely.
            //
            // FIX (review 2026-05-14, perf): idempotent — only walk
            // registrations the FIRST time we successfully complete this
            // step in a session. enableFcmPush gets re-fired on every
            // staffList length change (App.jsx FCM init effect), and
            // re-walking every SW registration each time was real cost
            // on devices that haven't had a legacy registration since
            // their last cold-launch wipe.
            if (!_swCleanedUp) {
                try {
                    const all = await navigator.serviceWorker.getRegistrations();
                    for (const r of all) {
                        const sw = r.active || r.installing || r.waiting;
                        if (!sw || !sw.scriptURL) continue;
                        if (!sw.scriptURL.includes("firebase-messaging-sw.js")) continue;
                        if (r.scope === swScope) continue;  // keep the correct one
                        await r.unregister();
                        console.log("[FCM] unregistered legacy SW at scope", r.scope);
                    }
                    _swCleanedUp = true;
                } catch (e) {
                    console.warn("FCM legacy SW cleanup failed (non-fatal):", e);
                    // Don't set _swCleanedUp — we'll retry on the next call.
                }
            }
            swRegistration = await navigator.serviceWorker.register(swUrl, { scope: swScope });
        } catch (e) {
            console.warn("FCM service worker register failed:", e, "url=", swUrl, "scope=", swScope);
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

    // Persist token on staff record. CRITICAL: read the LIVE Firestore staff
    // doc inside a transaction and modify only ONE field (this user's
    // fcmTokens). Do NOT use React state as the base — on app startup
    // staffList is still DEFAULT_STAFF (the seed) before the Firestore
    // snapshot arrives, and writing that back wiped real PINs to seed
    // values. This was the 2026-05-09 PIN-corruption root cause.
    if (staffName) {
        const deviceId = getOrCreateDeviceId();
        try {
            await runTransaction(db, async (tx) => {
                const ref = doc(db, "config", "staff");
                const snap = await tx.get(ref);
                if (!snap.exists()) {
                    console.warn("FCM token: config/staff doc missing, skipping write");
                    return;
                }
                const liveList = (snap.data() || {}).list || [];
                const meIdx = liveList.findIndex((s) => s.name === staffName);
                if (meIdx === -1) {
                    console.warn(`FCM token: ${staffName} not found in live staff list, skipping write`);
                    return;
                }
                const me = liveList[meIdx];
                const existing = Array.isArray(me.fcmTokens) ? me.fcmTokens : [];
                // Dedup with TWO axes:
                //   1. By deviceId — only one entry per physical browser.
                //      If an entry has the same deviceId as ours, we
                //      replace it (this is the new token after FCM
                //      rotation on the same device). This collapses
                //      the "PWA + tab + private window all on the same
                //      Mac" case to one entry.
                //   2. By token string — legacy entries (no deviceId)
                //      stay dedupable so we don't accumulate stale
                //      duplicates of the same token.
                // Legacy entries WITHOUT a deviceId AND without matching
                // our current token are left alone (might belong to a
                // different device whose deviceId we don't know yet).
                // They'll get pruned by dispatchNotification when their
                // tokens go stale, or replaced when that device next
                // registers (it'll gain a deviceId then).
                const seenTokens = new Set();
                const dedup = [];
                for (const t of existing) {
                    if (!t || !t.token) continue;
                    if (t.token === token) continue;        // current token re-added below
                    if (t.deviceId && t.deviceId === deviceId) continue; // same device, replace
                    if (seenTokens.has(t.token)) continue;  // duplicate token string
                    seenTokens.add(t.token);
                    dedup.push(t);
                }
                const nextTokens = [
                    { token, lastSeen: Date.now(), deviceId },
                    ...dedup,
                ].slice(0, MAX_TOKENS_PER_STAFF);
                // No-op if nothing meaningful changed.
                if (existing.length === nextTokens.length &&
                    existing.every((t, i) => t.token === nextTokens[i].token)) {
                    return;
                }
                const nextList = liveList.slice();
                nextList[meIdx] = { ...me, fcmTokens: nextTokens };
                tx.set(ref, { list: nextList });
            });
            // Mirror the live data into local React state so the app sees
            // the same as Firestore. Do this AFTER the transaction commits.
            if (setStaffList) {
                try {
                    const fresh = await getDoc(doc(db, "config", "staff"));
                    if (fresh.exists()) {
                        setStaffList(fresh.data().list || []);
                    }
                } catch (_) {}
            }
        } catch (e) {
            console.warn("FCM token persist (transactional) failed:", e);
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
