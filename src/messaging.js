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
import { getMessaging, getToken, deleteToken, onMessage, isSupported } from "firebase/messaging";
import { doc, setDoc, runTransaction, getDoc } from "firebase/firestore";
import app, { db } from "./firebase";
import { Capacitor } from "@capacitor/core";

// 2026-05-31 — Capacitor wrap. The Firebase web SDK uses a service
// worker for push delivery (firebase-messaging-sw.js). Service
// workers do NOT fire inside the iOS WKWebView or Android WebView
// that Capacitor uses, so on native we MUST switch to the native
// push plugin which talks to APNs (iOS) / native FCM (Android) and
// surfaces tokens that Firebase Admin (used by the dispatchNotification
// Cloud Function) can target without any backend changes.
//
// Web path stays IDENTICAL to before. Native path is added as a
// short-circuit at the top of each public function. Detection is
// safe to call on web — Capacitor.isNativePlatform() returns false
// when the @capacitor/core runtime is not running inside a native
// shell.
function isCapacitorNative() {
    try { return Capacitor.isNativePlatform(); }
    catch { return false; }
}

// Lazy-load the native push plugin so the web build doesn't pull
// in code it never executes. Dynamic import keeps the plugin off
// the web critical path.
//
// 2026-06-02 — Switched from `@capacitor/push-notifications` to
// `@capacitor-firebase/messaging`. Reason: the raw push-notifications
// plugin returns an APNs *device token* (hex) on iOS unless Firebase
// iOS SDK is also linked into the native shell. The dispatchNotification
// Cloud Function uses `getMessaging().sendEachForMulticast(tokens)`
// which requires FCM registration tokens — APNs raw tokens are rejected
// at the Admin SDK layer with "Invalid registration token". So the old
// path silently produced unusable tokens.
//
// `@capacitor-firebase/messaging` wraps Firebase iOS SDK natively, so
// `getToken()` returns a real FCM registration token routable through
// the existing dispatch flow with NO Cloud Function changes. Requires
// GoogleService-Info.plist to be present in the Xcode project (owner
// step). On web build this dynamic import is a no-op via the
// isCapacitorNative() short-circuit.
async function loadNativePushPlugin() {
    if (!isCapacitorNative()) return null;
    try {
        const mod = await import("@capacitor-firebase/messaging");
        return mod.FirebaseMessaging || null;
    } catch (e) {
        console.warn("[FCM] @capacitor-firebase/messaging import failed:", e?.message);
        return null;
    }
}

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

// Native push registration. Mirrors the web enableFcmPush — request
// permission, fetch the device token, write it onto the staff record
// in the same `fcmTokens` array that web tokens go into. Firebase
// Admin in the dispatchNotification Cloud Function routes pushes to
// EITHER kind of token transparently (the SDK figures out APNs vs
// FCM per token), so no backend changes are needed.
//
// We tag each entry with `platform: 'ios' | 'android'` so admins
// can see at a glance which device is on which OS. Also stamps a
// `nativeWrap: true` so a future Capacitor migration can identify
// installs that came in via the native shell vs the browser.
async function enableNativePush(staffName, staffList, setStaffList) {
    console.log('[FCM][native] step 1: loadNativePushPlugin');
    const plugin = await loadNativePushPlugin();
    console.log('[FCM][native] step 1 result:', plugin ? 'plugin loaded' : 'NULL');
    if (!plugin) return { ok: false, reason: "native-plugin-missing" };

    // 1) Permission. requestPermissions() shows the system prompt
    //    on first call; later calls return the current state.
    let permResult;
    try {
        console.log('[FCM][native] step 2: requestPermissions');
        permResult = await plugin.requestPermissions();
        console.log('[FCM][native] step 2 result:', JSON.stringify(permResult));
    } catch (e) {
        console.warn("[FCM][native] requestPermissions THREW:", e?.message, e?.stack);
        return { ok: false, reason: "permission-error" };
    }
    if (permResult?.receive !== "granted") {
        return { ok: false, reason: "permission-denied" };
    }

    // 2) Mint the FCM registration token.
    let token;
    try {
        console.log('[FCM][native] step 3: getToken');
        const res = await plugin.getToken();
        console.log('[FCM][native] step 3 result:', res?.token ? `token len=${res.token.length}` : 'NO TOKEN');
        token = res?.token || null;
    } catch (e) {
        console.warn("[FCM][native] getToken THREW:", e?.message, e?.stack);
        return { ok: false, reason: "register-failed", error: e?.message };
    }
    if (!token) return { ok: false, reason: "no-token" };

    // 3) Persist on the staff record. Identical pattern to the web
    //    path's transactional write — dedupe by deviceId, cap at
    //    MAX_TOKENS_PER_STAFF, refresh lastSeen on existing matches.
    const deviceId = getOrCreateDeviceId();
    const platform = Capacitor.getPlatform(); // 'ios' | 'android' | 'web'
    try {
        await runTransaction(db, async (tx) => {
            const ref = doc(db, "config", "staff");
            const snap = await tx.get(ref);
            if (!snap.exists()) throw new Error("staff doc missing");
            const list = (snap.data() || {}).list || [];
            const idx = list.findIndex((s) => s.name === staffName);
            if (idx === -1) throw new Error(`staff "${staffName}" not in list`);
            const meRec = list[idx];
            const existing = Array.isArray(meRec.fcmTokens) ? meRec.fcmTokens : [];
            const now = new Date().toISOString();
            const filtered = existing.filter((t) => {
                if (!t || !t.token) return false;
                if (t.deviceId && t.deviceId === deviceId) return false;
                if (t.token === token) return false;
                return true;
            });
            const updated = [...filtered, { token, deviceId, platform, nativeWrap: true, lastSeen: now }];
            const capped = updated.slice(-MAX_TOKENS_PER_STAFF);
            const nextList = list.map((s, i) =>
                i === idx ? { ...s, fcmTokens: capped } : s
            );
            tx.set(ref, { list: nextList });
        });
        if (typeof setStaffList === "function") {
            // Optimistic local update so the UI shows enabled state
            // before the next /config/staff snapshot fires. Same
            // pattern the web path uses below.
            try {
                const fresh = await getDoc(doc(db, "config", "staff"));
                if (fresh.exists()) setStaffList((fresh.data() || {}).list || []);
            } catch {}
        }
        return { ok: true, token, platform };
    } catch (e) {
        console.warn("[FCM][native] write failed:", e?.message);
        return { ok: false, reason: "write-failed", error: e?.message };
    }
}
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
    // Native short-circuit. On iOS / Android via Capacitor we use the
    // native push plugin instead of the web FCM SDK + service worker.
    // The plugin emits an FCM token (Android) or APNs token (iOS) that
    // Firebase Admin can target server-side without any backend code
    // changes — dispatchNotification's existing fan-out works as-is.
    // We tag the stored token with `platform` so admins can tell a
    // phone install apart from a browser install when triaging
    // delivery issues.
    // 2026-06-02 — Re-enabling FCM with Safari Web Inspector connected
    // (Andrew chose long-term FCM over SMS-only fallback). Every step
    // in enableNativePush logs to console with [FCM][native] markers
    // so the LAST line printed before any WebView crash tells us
    // exactly which call killed it. Outer wrapper catches synchronous
    // throws so they can't bubble into React's render cycle.
    //
    // If this round results in white-screen-after-PIN again:
    //   • RootErrorBoundary in main.jsx catches render errors and shows
    //     fallback UI instead of white (added today in stability pass).
    //   • Safari Web Inspector will show the [FCM][native] crash line.
    //   • To revert: change this gate back to the disabled short-circuit
    //     (commit bc89364 has the exact form).
    if (isCapacitorNative()) {
        console.log('[FCM][native] === DEBUG BUILD === entering enableNativePush');
        try {
            const r = await enableNativePush(staffName, staffList, setStaffList);
            console.log('[FCM][native] enableNativePush returned:', JSON.stringify(r));
            return r;
        } catch (e) {
            console.warn('[FCM][native] enableNativePush THREW (caught at gate):', e?.message, e?.stack);
            return { ok: false, reason: 'native-threw', error: e?.message };
        }
    }
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

                // Sweep cross-staff contamination — remove the same
                // deviceId (and the same token string) from every
                // OTHER staff's fcmTokens. (2026-05-17 — Andrew
                // reported Julie's phone getting pushes for messages
                // she just sent, which only happens when her device's
                // token is also registered to Andrew's record. Symptom
                // class: someone signed in on the wrong phone briefly,
                // both records hold the same device entry, dispatch
                // pushes to both staff for every chat.)
                //
                // After this sweep + this commit, the next time each
                // staff opens their own PWA, their record sweeps the
                // foreign entries out of all other staff. Self-healing.
                //
                // tokenDeviceSweepCount is tracked so we know whether
                // we actually mutated the list (avoids a no-op write
                // that triggers a pointless snapshot fan-out to every
                // other listener).
                let tokenDeviceSweepCount = 0;
                const nextList = liveList.map((s, i) => {
                    if (i === meIdx) return { ...s, fcmTokens: nextTokens };
                    if (!Array.isArray(s.fcmTokens) || s.fcmTokens.length === 0) return s;
                    const cleaned = s.fcmTokens.filter(t => {
                        if (!t || !t.token) return false;
                        // Drop any entry whose device matches the device
                        // we're now claiming for the current staff.
                        if (t.deviceId && t.deviceId === deviceId) return false;
                        // Drop entries whose token string equals our
                        // new token (defensive — same physical browser
                        // can register the same token under different
                        // staff if the deviceId was generated post-
                        // facto, e.g. after the localStorage clear).
                        if (t.token === token) return false;
                        return true;
                    });
                    if (cleaned.length !== s.fcmTokens.length) {
                        tokenDeviceSweepCount += (s.fcmTokens.length - cleaned.length);
                        return { ...s, fcmTokens: cleaned };
                    }
                    return s;
                });

                // No-op if nothing meaningful changed (avoids a
                // pointless snapshot fan-out). The new check also
                // accounts for the cross-staff sweep — even if my own
                // tokens are unchanged, if we swept somebody else's
                // contamination we still need to write.
                const myOwnSame = existing.length === nextTokens.length &&
                    existing.every((t, i) => t.token === nextTokens[i].token);
                if (myOwnSame && tokenDeviceSweepCount === 0) {
                    return;
                }
                if (tokenDeviceSweepCount > 0) {
                    console.log(`[FCM] swept ${tokenDeviceSweepCount} cross-staff token entries for device ${deviceId.slice(0, 8)}…`);
                }
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
    // Native short-circuit. On iOS / Android the native push plugin
    // emits a `pushNotificationReceived` event when the app is in the
    // foreground (background pushes are surfaced by the OS itself and
    // don't enter the JS bridge unless tapped). We adapt the event
    // shape to match the FCM web SDK so the in-app handler doesn't
    // need to branch.
    if (isCapacitorNative()) {
        // 2026-06-02 — Re-enabled with FCM debug build. Wrapped in
        // try/catch + verbose logging so a listener-setup crash can't
        // bring down React. See enableFcmPush gate above.
        console.log('[FCM][native] onForegroundMessage: loading plugin');
        let plugin;
        try {
            plugin = await loadNativePushPlugin();
        } catch (e) {
            console.warn('[FCM][native] onForegroundMessage plugin load THREW:', e?.message);
            return () => {};
        }
        if (!plugin) {
            console.log('[FCM][native] onForegroundMessage plugin null, returning noop');
            return () => {};
        }
        // @capacitor-firebase/messaging fires `notificationReceived`
        // (singular event for foreground delivery). Same payload shape
        // as the old plugin — { title, body, data }.
        try {
            console.log('[FCM][native] onForegroundMessage: addListener notificationReceived');
            const sub = await plugin.addListener("notificationReceived", (notification) => {
                console.log('[FCM][native] foreground notif:', notification?.title);
                handler({
                    notification: { title: notification?.title, body: notification?.body },
                    data: notification?.data || {},
                });
            });
            console.log('[FCM][native] onForegroundMessage: listener attached');
            return () => { try { sub?.remove?.(); } catch {} };
        } catch (e) {
            console.warn('[FCM][native] onForegroundMessage addListener THREW:', e?.message);
            return () => {};
        }
    }
    const messaging = await getMessagingSafely();
    if (!messaging) return () => {};
    return onMessage(messaging, handler);
}

/**
 * 2026-05-24 audit fix — disableFcmPush.
 *
 * Reverses what enableFcmPush did for this device. Used by:
 *   - Manual logout (App.jsx onLogout)
 *   - Idle re-lock (App.jsx idle timer)
 *   - Cold-launch wipe (App.jsx module-load handler)
 *
 * Why this exists: WITHOUT it, the device's FCM token stays bound to the
 * previously-signed-in staff member in /config/staff. Pushes addressed to
 * that staff (chat messages, shift offers, urgent alerts) keep ringing on
 * THIS device's lockscreen even though the device is now PIN-locked and
 * available to a different physical user. That's an information leak on
 * shared iPads (Webster front-of-house tablet, Maryland prep iPad), and
 * potentially a privacy issue on personal phones that get handed off.
 *
 * What it does:
 *   1. deleteToken() — tells FCM to invalidate this device's token so the
 *      server stops trying to push to it (also rotates the SW push
 *      subscription so a new sign-in gets a fresh binding).
 *   2. Removes the matching entry (by deviceId OR by token string) from
 *      the prior staff's fcmTokens array. Transactional so it doesn't
 *      clobber concurrent edits to the same /config/staff doc.
 *
 * Safe to call multiple times and safe to call when not signed in
 * (no-ops cleanly).
 */
export async function disableFcmPush(prevStaffName) {
    const deviceId = (() => {
        try { return localStorage.getItem(DEVICE_ID_KEY); }
        catch { return null; }
    })();
    // Tell FCM to drop this token on the SW side. Best-effort — we still
    // try to clean the Firestore entry even if this fails.
    try {
        const messaging = await getMessagingSafely();
        if (messaging) await deleteToken(messaging);
    } catch (e) {
        console.warn("[FCM] deleteToken failed (non-fatal):", e?.message);
    }
    // 2026-05-24 audit fix: clear the cached messaging singleton + SW
    // cleanup flag so a subsequent enableFcmPush (e.g. the NEXT staff
    // signing in on this shared iPad) gets a fresh Messaging instance
    // and re-runs the legacy SW unregister walk. Without this, the
    // module-level cache retained a reference to the now-deleted
    // token's instance, and getToken would briefly serve a cached
    // stale token under the new staff's record before re-minting.
    messagingInstance = null;
    _swCleanedUp = false;
    if (!prevStaffName) return;
    if (!deviceId) return; // nothing to clean up — we never registered
    try {
        await runTransaction(db, async (tx) => {
            const ref = doc(db, "config", "staff");
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            const list = (snap.data() || {}).list || [];
            const idx = list.findIndex((s) => s.name === prevStaffName);
            if (idx === -1) return;
            const meRec = list[idx];
            const existing = Array.isArray(meRec.fcmTokens) ? meRec.fcmTokens : [];
            const filtered = existing.filter((t) => {
                if (!t || !t.token) return false;
                if (t.deviceId && t.deviceId === deviceId) return false;
                return true;
            });
            if (filtered.length === existing.length) return; // no-op
            const nextList = list.map((s, i) =>
                i === idx ? { ...s, fcmTokens: filtered } : s
            );
            tx.set(ref, { list: nextList });
        });
        console.log(`[FCM] disabled push for ${prevStaffName} on device ${(deviceId || '').slice(0, 8)}…`);
    } catch (e) {
        console.warn("[FCM] disableFcmPush write failed (non-fatal):", e?.message);
    }
}
