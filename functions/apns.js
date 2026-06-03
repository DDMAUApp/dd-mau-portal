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

let _provider = null;

// Build the apn.Provider lazily on first send. Reads secrets from
// Firebase Functions config (defineSecret pattern - the secrets are
// declared in index.js and passed in).
function getProvider({ authKey, keyId, teamId, production }) {
    if (_provider) return _provider;
    if (!authKey || !keyId || !teamId) {
        throw new Error(`APNs not configured (missing key/id/team)`);
    }
    _provider = new apn.Provider({
        token: {
            // apn library accepts the .p8 contents (PEM) as `key`.
            // No file path / no fs reads - we keep the key in
            // Firebase Functions secret storage.
            key: authKey,
            keyId,
            teamId,
        },
        production: production === true || production === "true",
    });
    return _provider;
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
    const provider = getProvider(opts);

    const note = new apn.Notification();
    note.topic = opts.bundleId || "com.ddmau.staff";
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
    // 'content-available' lets a silent push wake a backgrounded app
    // briefly to pre-fetch new data. Already set in the existing
    // dispatchNotification path - keep parity here.
    note.contentAvailable = 1;
    note.priority = 10; // immediate
    note.expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24; // 24h

    let result;
    try {
        result = await provider.send(note, token);
    } catch (e) {
        return { success: false, error: e?.message || "send threw", response: null };
    }

    // result.sent and result.failed are arrays. Single-token send means
    // exactly one of them has the device.
    const sent = result?.sent?.length > 0;
    const failed = result?.failed?.length > 0;

    if (sent) {
        return { success: true, response: result };
    }
    if (failed) {
        const f = result.failed[0];
        return {
            success: false,
            error: f?.response?.reason || f?.error?.message || "delivery failed",
            response: result,
            // APNs HTTP/2 returns specific reason strings for dead tokens:
            //   "BadDeviceToken" - token doesn't match our bundle/env
            //   "Unregistered"   - user uninstalled or denied notifs
            // The caller uses these to decide whether to prune the
            // token from /config/staff.list[].fcmTokens.
            deadToken:
                f?.response?.reason === "BadDeviceToken" ||
                f?.response?.reason === "Unregistered",
        };
    }
    return { success: false, error: "no sent or failed entries returned", response: result };
}

// Shut down the provider's HTTP/2 connections cleanly. Called from
// the cleanup hook if we ever wire a finalizer.
function shutdownApns() {
    if (_provider) {
        try { _provider.shutdown(); } catch {}
        _provider = null;
    }
}

module.exports = {
    sendApnsPush,
    shutdownApns,
};
