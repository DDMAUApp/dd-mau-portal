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
// 2026-06-03 — firebase/messaging is LAZY-LOADED via dynamic import
// inside getMessagingSafely() instead of being at the top level.
// Reason: WKWebView (the Capacitor wrapper) hit a Temporal Dead Zone
// initialization error in the bundled firebase/messaging code that
// crashed the entire app on launch with the cryptic message
// "ReferenceError: Cannot access 'Dp' before initialization." at
// vendor-firebase-*.js. The eager top-level import was causing
// firebase/messaging's module evaluation to run before the rest of
// vendor-firebase had finished setting up its const declarations.
// Moving the import to a dynamic `await import(...)` inside the
// only function that uses it (getMessagingSafely on web) defers
// evaluation until after the rest of the vendor-firebase chunk has
// initialized, fixing the TDZ. Web behaviour is identical - the
// dynamic import resolves synchronously after the first call since
// the chunk is already loaded.
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
// 2026-06-03 — v1.1 push wiring Step 1: @capacitor/push-notifications.
//
// The wrapped iOS/Android app uses Capacitor's official push plugin
// (already installed, survived the @capacitor-firebase/messaging
// uninstall). It returns:
//   • iOS: APNs RAW device token (hex, 64 chars), no Firebase needed
//   • Android: FCM registration token (long base64-ish)
//
// Cloud Function will route by platform tag (Step 4):
//   • platform='ios' → send via node-apn directly to APNs HTTP/2
//   • platform='android' or platform=undefined (legacy web) → existing
//     Firebase Admin getMessaging().sendEachForMulticast() path
//
// Step 1 (this commit) just CAPTURES the token and LOGS it. Persistence
// to Firestore is deliberately gated OFF until Step 4 ships - if we
// stored iOS APNs raw tokens before the Cloud Function knows how to
// route them, the existing FCM-only dispatch would try to deliver to
// them via FCM, get "Invalid registration token", and prune every
// iOS token on the next push. So capture-only for now; persistence
// gets enabled in Step 2 (immediately followed by backend Steps 3+4).
async function loadNativePushPlugin() {
    if (!isCapacitorNative()) return null;
    // 2026-06-04 — Android push RE-ENABLED. The 2026-06-03 guard that
    // skipped Android push was a safety net while google-services.json
    // was missing from android/app/. The file is now in place
    // (downloaded via `firebase apps:sdkconfig ANDROID` after registering
    // the Android app in the Firebase project). Verification:
    //   - android/app/google-services.json exists (gitignored, contains
    //     project_id=dd-mau-staff-app, package=com.ddmau.staff, real API key)
    //   - android/build.gradle has the google-services classpath
    //   - android/app/build.gradle conditionally applies the plugin when
    //     the file exists (it now does), so Firebase native SDK initializes
    //     at app start and PushNotifications.register() can safely call
    //     FirebaseMessaging.getInstance() without throwing
    //     IllegalStateException: Default FirebaseApp is not initialized.
    // If Android push starts crashing again, re-add the platform guard
    // and check for the file. Original crash trace was on the
    // CapacitorPlugins background thread — uncatchable from JS.
    try {
        const mod = await import("@capacitor/push-notifications");
        const p = mod.PushNotifications;
        if (!p) return null;
        // 2026-06-03 ROOT-CAUSE FIX: Capacitor's plugin Proxy intercepts
        // ALL property access including `.then`. If we return this Proxy
        // from an async function, JS's Promise.resolve() does a thenable
        // check by accessing `.then` on the Proxy — the Proxy treats it
        // as a method call and forwards to iOS, which throws
        //   "PushNotifications.then() is not implemented on ios"
        // → unhandled rejection → entire push chain dies silently.
        // Fix: bind the 3 methods we actually use into a plain object
        // that has no `.then`. The bound functions properly delegate to
        // the original Proxy for the actual native calls.
        return {
            requestPermissions: p.requestPermissions.bind(p),
            register: p.register.bind(p),
            addListener: p.addListener.bind(p),
            // 2026-06-08 — bind createChannel so we can ENSURE the Android
            // notification channel actually exists. AndroidManifest declares
            // dd_default_channel as the FCM default channel id, but declaring
            // ≠ creating: until the app creates the channel, Android routes
            // pushes to the auto-generated "Miscellaneous" fallback at DEFAULT
            // importance (shows in the shade, no heads-up pop) — and some OEM
            // builds drop a notification whose channelId doesn't exist. The
            // Cloud Function sends android.notification.channelId =
            // "dd_default_channel", so we create that exact channel at HIGH
            // importance below. createChannel is Android-only in the plugin.
            createChannel: p.createChannel ? p.createChannel.bind(p) : null,
        };
    } catch (e) {
        console.warn("[push][native] @capacitor/push-notifications import failed:", e?.message);
        return null;
    }
}

// @capacitor/push-notifications uses an EVENT-BASED registration flow,
// not a Promise. Wrap the register() + addListener('registration') dance
// into a Promise that resolves with the token or rejects on timeout/error.
//
//   APNs registration on iOS can take 1-3 seconds on first launch
//   because the OS has to round-trip to Apple. 15s timeout covers
//   slow networks while still giving up before the user notices.
function registerForNativePush(plugin, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let regSub = null;
        let errSub = null;

        const cleanup = () => {
            try { regSub?.remove?.(); } catch {}
            try { errSub?.remove?.(); } catch {}
        };

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(`registration timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        // Attach the success + error listeners BEFORE calling register().
        // If register() fires synchronously the events might be missed
        // otherwise. The plugin returns a Promise for addListener that
        // resolves with a handle; we store the handle so cleanup can
        // remove it.
        plugin.addListener('registration', (token) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve(token?.value || null);
        }).then(h => { regSub = h; }).catch(() => {});

        plugin.addListener('registrationError', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(new Error(error?.error || 'registration error'));
        }).then(h => { errSub = h; }).catch(() => {});

        // Kick off APNs/FCM registration. plugin.register() returns
        // a Promise that resolves IMMEDIATELY after the call dispatches
        // to native - it does NOT wait for the token. The token arrives
        // via the listeners attached above.
        plugin.register().catch(e => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(e);
        });
    });
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
// v1.1 push wiring Step 1 — CAPTURE-ONLY mode.
//
// This function runs on Capacitor native after sign-in. It:
//   1. Loads @capacitor/push-notifications dynamically
//   2. Requests notification permission (iOS shows the system prompt)
//   3. Calls register() and waits for the platform-native token via
//      the 'registration' event (APNs raw on iOS, FCM on Android)
//   4. Logs the token to console with [push][native] markers so we
//      can see it in Safari Web Inspector and Xcode console
//   5. DOES NOT persist to Firestore yet (see persistence-gate
//      comment below)
//
// Persistence-gate (why we don't write to Firestore here yet):
//   The Cloud Function dispatchNotification currently only knows
//   how to deliver via Firebase Admin getMessaging().sendEachForMulticast().
//   That call REJECTS APNs raw tokens with "Invalid registration token"
//   and the CF then prunes the token from the staff record. If we
//   stored iOS APNs tokens here NOW, every push attempt would prune
//   every iOS token immediately and we'd never get push working.
//
//   Steps 3+4 of the v1.1 plan add node-apn to the Cloud Function
//   and split tokens by platform tag before sending. Once those land,
//   Step 2 of this plan enables the runTransaction below to actually
//   write the token. Until then, capture+log only.
async function enableNativePush(staffName, staffList, setStaffList) {
    console.log('[push][native] step 1: loadNativePushPlugin');
    const plugin = await loadNativePushPlugin();
    console.log('[push][native] step 1 result:', plugin ? 'plugin loaded' : 'NULL');
    if (!plugin) return { ok: false, reason: "native-plugin-missing" };

    // 1) Permission. requestPermissions() shows the system prompt
    //    on first call; later calls return the current state. The
    //    permResult shape is { receive: 'granted' | 'denied' | 'prompt' }.
    let permResult;
    try {
        console.log('[push][native] step 2: requestPermissions');
        permResult = await plugin.requestPermissions();
        console.log('[push][native] step 2 result:', JSON.stringify(permResult));
    } catch (e) {
        console.warn("[push][native] requestPermissions THREW:", e?.message, e?.stack);
        return { ok: false, reason: "permission-error" };
    }
    if (permResult?.receive !== "granted") {
        return { ok: false, reason: "permission-denied" };
    }

    // 1b) Ensure the Android notification channel EXISTS before any push
    //     can arrive. Root cause of "no Android notifications" (2026-06-08):
    //     the Cloud Function targets channelId "dd_default_channel" and the
    //     manifest declares it as the FCM default — but nothing ever created
    //     the channel, so on Android 13 pushes fell back to the unnamed
    //     "Miscellaneous" channel at DEFAULT importance (no heads-up banner),
    //     and could be suppressed outright on some OEM builds. Creating it
    //     here at HIGH importance makes pushes POP as banners under a "DD Mau
    //     Alerts" channel that matches the Cloud Function's channelId.
    //     Android-only; createChannel is null on iOS (guarded). Idempotent —
    //     creating an existing channel is a no-op, so re-running each sign-in
    //     is safe. Rides OTA (no native rebuild needed).
    if (Capacitor.getPlatform() === "android" && plugin.createChannel) {
        try {
            await plugin.createChannel({
                id: "dd_default_channel",
                name: "DD Mau Alerts",
                description: "Chat messages, schedule changes, and urgent alerts",
                importance: 4,   // IMPORTANCE_HIGH → heads-up banner + sound
                visibility: 1,   // VISIBILITY_PUBLIC → full content on lock screen
                sound: "default",
                vibration: true,
                lights: true,
            });
            console.log("[push][native] ensured dd_default_channel (importance=HIGH)");
        } catch (e) {
            console.warn("[push][native] createChannel failed (non-fatal):", e?.message);
        }
    }

    // 2) Register with APNs (iOS) or FCM (Android) and wait for
    //    the token via the event listener wrapped in a Promise.
    let token;
    try {
        console.log('[push][native] step 3: register + wait for token');
        token = await registerForNativePush(plugin);
        console.log('[push][native] step 3 result:', token
            ? `token captured len=${token.length} prefix=${token.slice(0, 32)}…`
            : 'NO TOKEN');
    } catch (e) {
        console.warn("[push][native] register THREW:", e?.message);
        return { ok: false, reason: "register-failed", error: e?.message };
    }
    if (!token) return { ok: false, reason: "no-token" };

    // 3) Persistence — Step 2 LIVE (2026-06-03).
    //    Backend (dispatchNotification + functions/apns.js) is now wired
    //    with the 3 APNs secrets attached. iOS tokens land in Firestore
    //    tagged with platform='ios' + tokenKind='apns_raw' so the
    //    dispatcher routes them to node-apn (HTTP/2) instead of FCM.
    //    Android tokens get platform='android' + tokenKind='fcm' and
    //    still go through Firebase Admin getMessaging().
    //
    //    SAME transactional pattern as the FCM enableFcmPush path
    //    below — read live staff doc, mutate ONLY this user's
    //    fcmTokens, cross-staff sweep on deviceId. Prevents the
    //    2026-05-09 PIN-corruption class of bug.
    const platform = Capacitor.getPlatform(); // 'ios' | 'android' | 'web'
    const tokenKind = platform === 'ios' ? 'apns_raw' : 'fcm';
    console.log('[push][native] step 4: persisting platform=' + platform +
        ' tokenKind=' + tokenKind + ' for staff=' + staffName);

    if (staffName) {
        const deviceId = getOrCreateDeviceId();
        try {
            await runTransaction(db, async (tx) => {
                const ref = doc(db, "config", "staff");
                const snap = await tx.get(ref);
                if (!snap.exists()) {
                    console.warn("[push][native] config/staff doc missing, skipping write");
                    return;
                }
                const liveList = (snap.data() || {}).list || [];
                const meIdx = liveList.findIndex((s) => s.name === staffName);
                if (meIdx === -1) {
                    console.warn(`[push][native] ${staffName} not found in live staff list, skipping write`);
                    return;
                }
                const me = liveList[meIdx];
                const existing = Array.isArray(me.fcmTokens) ? me.fcmTokens : [];
                // Dedup logic mirrors enableFcmPush — same deviceId or
                // same token string collapses to the new entry below.
                const seenTokens = new Set();
                const dedup = [];
                for (const t of existing) {
                    if (!t || !t.token) continue;
                    if (t.token === token) continue;
                    if (t.deviceId && t.deviceId === deviceId) continue;
                    if (seenTokens.has(t.token)) continue;
                    seenTokens.add(t.token);
                    dedup.push(t);
                }
                const nextTokens = [
                    { token, lastSeen: Date.now(), deviceId, platform, tokenKind },
                    ...dedup,
                ].slice(0, MAX_TOKENS_PER_STAFF);

                // Cross-staff sweep on deviceId — same as enableFcmPush.
                let tokenDeviceSweepCount = 0;
                const nextList = liveList.map((s, i) => {
                    if (i === meIdx) return { ...s, fcmTokens: nextTokens };
                    if (!Array.isArray(s.fcmTokens) || s.fcmTokens.length === 0) return s;
                    const cleaned = s.fcmTokens.filter(t => {
                        if (!t || !t.token) return false;
                        if (t.deviceId && t.deviceId === deviceId) return false;
                        if (t.token === token) return false;
                        return true;
                    });
                    if (cleaned.length !== s.fcmTokens.length) {
                        tokenDeviceSweepCount += (s.fcmTokens.length - cleaned.length);
                        return { ...s, fcmTokens: cleaned };
                    }
                    return s;
                });

                const myOwnSame = existing.length === nextTokens.length &&
                    existing.every((t, i) => t.token === nextTokens[i].token);
                if (myOwnSame && tokenDeviceSweepCount === 0) {
                    return;
                }
                if (tokenDeviceSweepCount > 0) {
                    console.log(`[push][native] swept ${tokenDeviceSweepCount} cross-staff token entries for device ${deviceId.slice(0, 8)}…`);
                }
                tx.set(ref, { list: nextList });
            });
            // Mirror live data into React state after txn commits.
            if (setStaffList) {
                try {
                    const fresh = await getDoc(doc(db, "config", "staff"));
                    if (fresh.exists()) {
                        setStaffList(fresh.data().list || []);
                    }
                } catch (_) {}
            }
            console.log('[push][native] persist OK');
            return { ok: true, token, platform, tokenKind, persisted: true };
        } catch (e) {
            console.warn("[push][native] persist (transactional) failed:", e?.message, e?.stack);
            return { ok: true, token, platform, tokenKind, persisted: false, persistError: e?.message };
        }
    }

    return { ok: true, token, platform, tokenKind, persisted: false, reason: 'no-staffName' };
}
// Cached firebase/messaging module ref. Loaded once via dynamic
// import then reused. The first call pays the dynamic-import cost
// (very small — the chunk is already in the vendor-firebase bundle
// fetched at app start), subsequent calls are instant.
let _fbMessagingMod = null;
async function loadFirebaseMessagingMod() {
    if (_fbMessagingMod) return _fbMessagingMod;
    try {
        // Dynamic import — defers firebase/messaging's module-init
        // code until first call. See top-of-file comment for the
        // TDZ bug this works around.
        _fbMessagingMod = await import("firebase/messaging");
        return _fbMessagingMod;
    } catch (e) {
        console.warn("firebase/messaging dynamic import failed:", e?.message);
        return null;
    }
}

async function getMessagingSafely() {
    if (messagingInstance) return messagingInstance;
    try {
        const mod = await loadFirebaseMessagingMod();
        if (!mod) return null;
        if (!(await mod.isSupported())) return null;
        messagingInstance = mod.getMessaging(app);
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
    // 2026-06-03 — v1.1 push wiring Step 1: native registration enabled
    // in CAPTURE-ONLY mode. The plugin (@capacitor/push-notifications)
    // requests permission, registers with APNs/FCM, captures the
    // token, and logs it. It does NOT persist to Firestore yet —
    // the Cloud Function can't route iOS APNs raw tokens until
    // Step 4 lands.
    //
    // Outer try/catch protects React's render cycle from a
    // synchronous throw inside the plugin path. If anything goes
    // wrong, we log + return ok:false; the rest of the app loads
    // normally as if push were disabled.
    if (isCapacitorNative()) {
        console.log('[push][native] === entering enableNativePush (Step 1 capture-only) ===');
        try {
            const r = await enableNativePush(staffName, staffList, setStaffList);
            console.log('[push][native] enableNativePush returned:', JSON.stringify(r));
            return r;
        } catch (e) {
            console.warn('[push][native] enableNativePush THREW (caught at gate):', e?.message, e?.stack);
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
        const mod = await loadFirebaseMessagingMod();
        if (!mod) return { ok: false, reason: "fb-messaging-load-failed" };
        token = await mod.getToken(messaging, {
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
        // v1.1 Step 1: wire foreground listener for native pushes.
        // @capacitor/push-notifications fires 'pushNotificationReceived'
        // when the app is in foreground. (When backgrounded, the OS
        // shows the push and the JS bridge only gets called if the
        // user taps it — that fires 'pushNotificationActionPerformed',
        // which we wire later in Step 2 for deep-link routing.)
        let plugin;
        try {
            plugin = await loadNativePushPlugin();
        } catch {
            return () => {};
        }
        if (!plugin) return () => {};
        try {
            const sub = await plugin.addListener('pushNotificationReceived', (notification) => {
                console.log('[push][native] foreground notif:', notification?.title);
                handler({
                    notification: {
                        title: notification?.title,
                        body: notification?.body,
                    },
                    data: notification?.data || {},
                });
            });
            return () => { try { sub?.remove?.(); } catch {} };
        } catch (e) {
            console.warn('[push][native] addListener pushNotificationReceived THREW:', e?.message);
            return () => {};
        }
    }
    const messaging = await getMessagingSafely();
    if (!messaging) return () => {};
    const mod = await loadFirebaseMessagingMod();
    if (!mod) return () => {};
    return mod.onMessage(messaging, handler);
}

/**
 * Native push TAP routing (#1, 2026-06-16). When a user taps a closed/
 * background push on iOS/Android, the plugin fires
 * 'pushNotificationActionPerformed'. We read the data.deepLink the Cloud
 * Function set and hand the target tab to the caller (App.jsx dispatches the
 * 'ddmau:navigate' window event). No-op on web — web taps are handled by the
 * FCM service worker's notificationclick (postMessage / ?deepLink=). Returns
 * an unsubscribe function.
 */
export async function onPushTapNavigate(handler) {
    if (!isCapacitorNative()) return () => {};
    let plugin;
    try { plugin = await loadNativePushPlugin(); } catch { return () => {}; }
    if (!plugin) return () => {};
    try {
        const sub = await plugin.addListener('pushNotificationActionPerformed', (event) => {
            try {
                const data = event?.notification?.data || {};
                const tab = data.deepLink || data.tab || null;
                if (tab && typeof handler === 'function') handler(String(tab));
            } catch (e) { console.warn('[push][native] tap route failed:', e?.message); }
        });
        return () => { try { sub?.remove?.(); } catch {} };
    } catch (e) {
        console.warn('[push][native] addListener pushNotificationActionPerformed THREW:', e?.message);
        return () => {};
    }
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
        if (messaging) {
            const mod = await loadFirebaseMessagingMod();
            if (mod) await mod.deleteToken(messaging);
        }
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
    } catch (e) {
        console.warn("[FCM] disableFcmPush write failed (non-fatal):", e?.message);
    }
}
