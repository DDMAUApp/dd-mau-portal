// functions/apns.js
//
// Apple Push Notification Service (APNs) helper for the v1.1 native
// push wiring (Step 3 of the FCM_RUNBOOK push plan).
//
// Why this exists:
//   The wrapped iOS app uses @capacitor/push-notifications which
//   returns the APNs RAW device token (64-hex-char hex string), not
//   an FCM token. Firebase Admin SDK's getMessaging() can ONLY send
//   to FCM registration tokens - it rejects APNs raw tokens with
//   "Invalid registration token" and the dispatch path then prunes
//   them.
//
//   To deliver to iOS without Firebase iOS SDK in the bundle, we
//   talk APNs HTTP/2 directly from the Cloud Function using the
//   `apn` npm package (battle-tested for ~10 years).
//
// What this exposes:
//   sendApnsPush(token, payload, opts) -> { success, response, error }
//
// Configuration (Firebase Functions secrets):
//   APNS_AUTH_KEY      - the .p8 file CONTENT (PEM string)
//   APNS_KEY_ID        - 10-char key id from Apple Developer Portal
//   APNS_TEAM_ID       - 10-char team id from Apple Developer Portal
//   APNS_BUNDLE_ID     - com.ddmau.staff (defaults to this if unset)
//   APNS_PRODUCTION    - "true" to talk to production APNs, "false"
//                        (or unset) for sandbox (TestFlight + dev builds)
//
// The provider is constructed lazily on first call and cached at
// module scope - APNs uses long-lived HTTP/2 connections so the
// reuse is important. apn library handles connection lifecycle,
// retries, and dead-token detection internally.
//
// Error handling:
//   apn library returns a result object per token with success/failure
//   info. We log every send + every failure to system_logs (existing
//   audit channel) so admin can debug delivery issues without needing
//   to look at Firebase logs directly.

const apn = require("apn");

// One long-lived apn.Provider per APNs ENVIRONMENT. APNs uses persistent
// HTTP/2 connections, so we cache + reuse them across Cloud Function
// invocations. We keep BOTH because a device token is bound to exactly
// one environment and the staff fleet is a mix:
//   • App Store build         → PRODUCTION token (api.push.apple.com)
//   • Xcode / TestFlight build → SANDBOX token   (api.sandbox.push.apple.com)
// Sending a token to the wrong environment returns "BadDeviceToken".
const _providers = { prod: null, sandbox: null };

// Build (and cache) the apn.Provider for one environment. Reads the .p8
// key + ids passed through from index.js (defineSecret values).
function getProvider(env, { authKey, keyId, teamId }) {
    if (_providers[env]) return _providers[env];
    if (!authKey || !keyId || !teamId) {
        throw new Error(`APNs not configured (missing key/id/team)`);
    }
    _providers[env] = new apn.Provider({
        token: {
            // apn library accepts the .p8 contents (PEM) as `key`.
            // No file path / no fs reads - we keep the key in
            // Firebase Functions secret storage.
            key: authKey,
            keyId,
            teamId,
        },
        production: env === "prod",
    });
    return _providers[env];
}

// Send a prepared note to ONE token on ONE environment. Returns
// { ok:true } or { ok:false, reason } where `reason` is the APNs reason
// string ("BadDeviceToken", "Unregistered", "TooManyRequests", …) when
// the failure came back over HTTP/2, else null for a transport error.
async function sendOnEnv(env, token, note, opts) {
    let provider;
    try {
        provider = getProvider(env, opts);
    } catch (e) {
        return { ok: false, reason: null, error: e?.message || "no provider" };
    }
    let result;
    try {
        result = await provider.send(note, token);
    } catch (e) {
        return { ok: false, reason: null, error: e?.message || "send threw" };
    }
    if (result?.sent?.length > 0) return { ok: true };
    const f = result?.failed?.[0];
    const reason = f?.response?.reason || null;
    return { ok: false, reason, error: reason || f?.error?.message || "delivery failed" };
}

// Send a push notification to a single APNs raw device token.
//
// payload should match the iOS aps payload shape:
//   {
//     title: "Julie",
//     body: "covering my shift tonight?",
//     badge: 3,            // app icon badge count (optional)
//     sound: "default",    // 'default' or a registered file
//     tag: "ddmau-chat-7", // collapse / dedupe id
//     data: { link: "/chat", type: "chat_message" }, // arbitrary data
//   }
//
// opts:
//   { authKey, keyId, teamId, production, bundleId }
//
// Returns:
//   { success: true, response: <apn result> } on success
//   { success: false, error: <message>, response: <apn result> } on fail
async function sendApnsPush(token, payload, opts = {}) {
    const note = new apn.Notification();
    note.topic = opts.bundleId || "com.ddmau.staff";
    // apns-push-type header. REQUIRED by production APNs (and the modern
    // HTTP/2 API). Missing it is tolerated by sandbox but rejected by
    // production — a real cause of "worked in TestFlight, dead after the
    // App Store release." These are always user-facing alerts.
    note.pushType = "alert";
    note.alert = {
        title: payload.title || "DD Mau",
        body: payload.body || "",
    };
    // Badge is optional - omit if undefined so iOS doesn't clear it.
    if (typeof payload.badge === "number") note.badge = payload.badge;
    note.sound = payload.sound || "default";
    // collapseId groups duplicate notifications under the same id -
    // a retry from the Cloud Function replaces the first push instead
    // of stacking two banners.
    if (payload.tag) note.collapseId = String(payload.tag).slice(0, 64);
    // payload field is read by the app's onForegroundMessage handler
    // (or pushNotificationActionPerformed for taps).
    note.payload = payload.data || {};
    // 2026-06-14 — DO NOT set content-available on these. Andrew: "the
    // iOS app isn't getting notifications." APNs returned success
    // ("APNs push delivered") but no banner ever appeared. Root cause:
    // content-available:1 flags the push as a SILENT/background update,
    // so iOS hands it to the app's background handler and SUPPRESSES the
    // visible alert — especially when the app is backgrounded/closed and
    // under power-management throttling. Apple's rule is explicit: a
    // user-facing alert push must NOT carry content-available. These
    // pushes always have a title/body alert (set above), so they're
    // alert pushes, not silent ones. Leaving contentAvailable unset makes
    // iOS display the banner normally. priority 10 = immediate alert.
    note.priority = 10; // immediate
    note.expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24; // 24h

    // 2026-06-20 — Andrew: "the iOS app notifications are broken, I'm not
    // getting anything." Root cause: the dispatcher was pinned to SANDBOX
    // APNs, but the App Store build registers PRODUCTION tokens, so every
    // send came back "BadDeviceToken" and the token got pruned as dead.
    //
    // We can't tell which environment a stored token belongs to, so try
    // the preferred env first (production by default — the app is live on
    // the App Store) and, ONLY on "BadDeviceToken" (the wrong-environment
    // signal), retry the OTHER env before giving up. This makes delivery
    // work for App Store, TestFlight, and Xcode dev builds simultaneously.
    // A token is reported dead (deadToken:true, prune it) ONLY when both
    // environments reject it as a bad token, or APNs says "Unregistered"
    // (uninstalled / opted out — environment-independent).
    const preferSandboxFirst = opts.production === false || opts.production === "false";
    const order = preferSandboxFirst ? ["sandbox", "prod"] : ["prod", "sandbox"];

    let last = null;
    for (let i = 0; i < order.length; i++) {
        const r = await sendOnEnv(order[i], token, note, opts);
        if (r.ok) return { success: true, env: order[i] };
        last = r;
        if (r.reason === "Unregistered") {
            return { success: false, error: r.error, deadToken: true };
        }
        if (r.reason !== "BadDeviceToken") {
            // Transient / config error (TooManyRequests, connection drop,
            // bad key, …). Not a dead token, and the other environment uses
            // the same key/topic so it'd fail identically — surface + stop.
            return { success: false, error: r.error, deadToken: false };
        }
        // BadDeviceToken → loop and try the other environment.
    }
    // BadDeviceToken on BOTH environments → the token really is dead.
    return { success: false, error: last?.error || "BadDeviceToken", deadToken: true };
}

// Shut down both providers' HTTP/2 connections cleanly. Called from
// the cleanup hook if we ever wire a finalizer.
function shutdownApns() {
    for (const env of ["prod", "sandbox"]) {
        if (_providers[env]) {
            try { _providers[env].shutdown(); } catch {}
            _providers[env] = null;
        }
    }
}

module.exports = {
    sendApnsPush,
    shutdownApns,
};
