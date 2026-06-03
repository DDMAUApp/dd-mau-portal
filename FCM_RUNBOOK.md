# FCM Push Notifications — Diagnosis, Fix, and Options

**Written 2026-06-03 overnight while Andrew slept.** No code changes that would break the wrapped iOS build. All changes are dormant artifacts + this runbook.

---

## TL;DR

The wrapped iOS app was white-screening because **`ios/App/App/App.entitlements` doesn't exist** and the Xcode project has no `CODE_SIGN_ENTITLEMENTS` reference. Without `aps-environment` entitlement, iOS throws `NSInternalInconsistencyException` the first time the FCM plugin calls `registerForRemoteNotifications()` — and that exception crashes the entire WKWebView in native code, before any JavaScript runs. That's why Safari Web Inspector never saw our `[FCM][native]` logs.

The fix is **3 minutes of clicking in Xcode** (Phase 1 below) plus a verification in Firebase Console (Phase 2). Once those are done, we re-enable FCM in `messaging.js` and it should work end-to-end on iOS, Android, and Web.

---

## Current State (safe baseline you can ship right now)

- ✅ Web app at app.ddmaustl.com: FCM works (service worker + VAPID)
- ✅ Wrapped iOS app: LAUNCHES cleanly past PIN, all features work, in-app notifications work via Firestore subscription, chat tile red badge updates in real time. **No native push (no icon badge, no closed-app pings).**
- ✅ Wrapped Android app: same as iOS — works, no native push.
- ✅ SMS via Twilio: working for urgent alerts (Cloud Function `dispatchSms`).

You can submit v1 to the App Store and Google Play **right now** and staff will have a functional app. The only thing missing is closed-app pushes on the wrapped builds.

---

## What I prepared overnight (dormant, no risk)

1. **`ios/App/App/App.entitlements`** — created with `aps-environment = development`. Currently NOT referenced from `project.pbxproj`, so it's just a file sitting on disk. Xcode will pick it up automatically when you click "+ Capability → Push Notifications" in Phase 1, or recreate it identically.

2. **This runbook** — every option, every step, every fallback, with click-by-click instructions.

I did NOT modify `project.pbxproj`, NOT push code that re-enables FCM, NOT change any Cloud Function logic, NOT touch the Capacitor config. The currently-deployed iOS bundle is the safe `e802195` build that loads cleanly past PIN.

---

## Phase 1: Add Push Notifications capability in Xcode (3 min)

1. Open Xcode. Make sure the project is loaded.
2. In the left sidebar, click the **blue "App"** icon at the very top (the project root, not the inner App folder).
3. In the main editor area, look for a column showing **PROJECT / TARGETS**. Click the **App target** (under TARGETS).
4. Click the **"Signing & Capabilities"** tab at the top of the editor.
5. Look for an existing "Push Notifications" section. If it's already there: skip to step 8.
6. If not present: click the **"+ Capability"** button (top-left of that tab).
7. In the search box that opens, type **"Push"** → double-click **"Push Notifications"** in the results.
   - Xcode adds the capability AND auto-links the `App.entitlements` file I prepared (or creates an identical one).
   - Build settings now show `CODE_SIGN_ENTITLEMENTS = App/App.entitlements`.
8. While you're in there, verify **"Background Modes"** capability is also present. If not, click "+ Capability" → "Background Modes" → check ☑ **"Remote notifications"**. (The Info.plist already declares this, but having the capability in Xcode makes it visible in Signing & Capabilities for future reference.)
9. **Important — provisioning profile refresh.** The capability changes require Xcode to refetch a provisioning profile that includes push entitlement. If you see a yellow ⚠ banner saying "Provisioning profile doesn't include the aps-environment entitlement", click **"Try Again"** or toggle automatic signing off then back on. This forces Xcode to request a fresh profile from Apple Developer Portal that includes push.

---

## Phase 2: Verify APNs Auth Key is in Firebase Console (2 min)

1. Open https://console.firebase.google.com/project/dd-mau-staff-app/settings/cloudmessaging
2. Scroll to **"Apple app configuration"** section.
3. Look for the iOS app `com.ddmau.staff`. There should be a sub-section labeled **"APNs Authentication Key"** showing your registered key (Key ID + Team ID).
4. If it's there with a Key ID and Team ID: ✅ you're done with this phase.
5. If it's missing or shows "No key uploaded":
   - You should have a `.p8` file from earlier today's work ("ok got the key" was a message you sent).
   - Click **"Upload"** in that section.
   - Drop the `.p8` file.
   - Enter the **Key ID** (10-character string Apple gave you when you created the key).
   - Enter the **Team ID** (10-character string from Apple Developer Portal → Membership).
   - Click **"Upload"**.

Without this key, FCM can't bridge APNs → FCM tokens for iOS devices. Even with the entitlement fix, `getToken()` will return null until Firebase has the APNs key.

---

## Phase 3: Tell Claude to re-enable FCM and test

After Phases 1 and 2 are done, send me: **"FCM ready, capability + key are in, re-enable it"**

I will:
1. Restore `messaging.js` to the active FCM path with verbose `[FCM][native]` step logging.
2. Build + sync + push.
3. You do Clean Build Folder + delete app from iPhone + ▶️ Play.
4. With Safari Web Inspector connected (Develop menu → your iPhone → DD Mau), watch the console as you enter PIN.

Expected sequence in the console:
```
[FCM][native] === DEBUG BUILD === entering enableNativePush
[FCM][native] step 1: loadNativePushPlugin
[FCM][native] step 1 result: plugin loaded
[FCM][native] step 2: requestPermissions
[FCM][native] step 2 result: {"receive":"granted"}
[FCM][native] step 3: getToken
[FCM][native] step 3 result: token len=152
[FCM][native] enableNativePush returned: {"ok":true,...}
```

When all 4 lines print AND we see "ok:true", we verify the token landed in your staff record (`scripts/check_chat_notifs.mjs`-style probe), then send a test push from Julie's web session. iPhone should buzz with the chat content + show a red badge on the app icon.

---

## Phase 4: Verification checklist after FCM works

Once we see a successful end-to-end push, verify these in order:

1. **FCM token saved to Firestore staff record**
   - Run `node scripts/check_andrew_fcm_token.mjs` (I'll create this when we re-enable)
   - Should show one entry in `fcmTokens` array with `platform: 'ios'`, `nativeWrap: true`

2. **Closed-app push delivers**
   - Force-quit DD Mau on iPhone (swipe up from bottom, swipe app away)
   - From Mac browser as Julie, send Andrew a chat
   - iPhone should show banner + sound within 5 seconds
   - Tap banner → opens DD Mau directly to the chat

3. **Icon badge updates**
   - With DD Mau closed, send 3 messages from Julie
   - iPhone home-screen icon should show red "3"
   - Open the app + tap Chat → badge clears

4. **Off-shift quiet hours still work**
   - Pick a time outside your shift hours
   - Have Julie send a non-urgent notification type (e.g., `info_announcement`)
   - Should NOT push (quiet hours), but should appear in the bell drawer in-app
   - Chat messages bypass this gate (they're in `ALWAYS_DELIVER_TYPES`)

5. **Cross-platform parity**
   - Send chat from iOS → arrives on web (Mac browser)
   - Send chat from web → arrives on iOS
   - Send chat from Android (after Andrew sets up wrapped Android) → arrives on iOS + web

---

## Option B fallback: switch to `@capacitor/push-notifications` + direct APNs

If Phase 1 + Phase 2 don't fix the white-screen (low probability but possible), the next move is to ditch `@capacitor-firebase/messaging` entirely:

1. `npm uninstall @capacitor-firebase/messaging`
2. The existing `@capacitor/push-notifications` plugin is still installed; it returns APNs raw tokens (no Firebase iOS SDK dependency).
3. Update `messaging.js` to use that plugin's API.
4. Update Cloud Function `dispatchNotification` to handle BOTH:
   - FCM tokens (Android + Web) → continue using `getMessaging().sendEachForMulticast()`
   - APNs raw tokens (iOS) → use `node-apn` library to send via APNs HTTP/2 directly with the same Auth Key

**Effort**: ~2-3 hours of focused work to swap plugins + add `node-apn` to the Cloud Function + test.

**Pro**: avoids the Firebase iOS SDK entirely. If `@capacitor-firebase/messaging` is what's crashing the WebView (even after fixing entitlements), this sidesteps the problem.

**Con**: more code paths in `dispatchNotification`. Manageable but not trivial.

---

## Option C fallback: OneSignal

If Options A and B both fail, OneSignal is the heavy-but-reliable fallback:

1. Sign up at onesignal.com (free tier: 10K subscribers, covers DD Mau forever).
2. `npm install onesignal-cordova-plugin` (Capacitor-compatible via @awesome-cordova-plugins/onesignal).
3. Configure their iOS + Android setup via their dashboard (they walk you through APNs key upload, etc.).
4. Replace `messaging.js` enableFcmPush call with OneSignal's SDK call.
5. Replace Cloud Function dispatchNotification's `getMessaging()` call with a fetch to OneSignal's REST API.

**Effort**: ~1 day of work.

**Pro**: their SDK handles APNs/FCM init in their own native code. We don't debug. Battle-tested by thousands of apps.

**Con**: vendor dependency. Pricing tier changes happen (free tier could shrink). They have access to your push payloads (privacy consideration — chat content briefly passes through their pipes).

---

## Option D fallback: Skip wrapped app, encourage PWA install

If push absolutely cannot work natively, the lowest-friction path is to ship a much-improved "Add to Home Screen" PWA experience:

1. Ship v1 wrapped apps to App Store + Google Play as-is (no push).
2. Tell staff who care about push to use the web version with "Add to Home Screen" on iOS / "Install app" on Android Chrome.
3. PWA installs get full web FCM push including app-icon badge (on Android), sound, and banners.
4. The wrapped App Store version becomes a "guaranteed-works" alternative for staff who can't figure out PWA install.

**Pro**: zero engineering. Already works on web.

**Con**: confusing UX explanation to staff. Two install paths.

---

## Reasonable failure modes and what they mean

| Symptom in Safari Web Inspector | Likely cause | Fix |
|---|---|---|
| No `[FCM][native]` lines, WebView white-screens | Still missing entitlement (Phase 1 wasn't fully applied) | Re-do Phase 1, verify `CODE_SIGN_ENTITLEMENTS` is set in Build Settings → Code Signing |
| `step 1 result: NULL` | Plugin didn't load (dynamic import threw) | Run `./node_modules/.bin/cap sync ios` — Xcode project may be missing the Pod |
| `step 2 result: {"receive":"denied"}` | User said no, OR iOS killed the prompt | Settings → Notifications → DD Mau → toggle Allow ON manually |
| `step 3 result: NO TOKEN` | Permission granted but Firebase couldn't mint token | APNs Auth Key not uploaded to Firebase (Phase 2) OR provisioning profile doesn't include push |
| All 4 lines print but no push arrives | Token saved but Cloud Function not delivering | Check Cloud Function logs in Firebase Console for `dispatchNotification` errors |

---

## What ships in v1 WITHOUT push if we never crack this

These all work today on the iPhone wrapped app:
- ✅ All in-app features (chat, schedule, ops, 86, training, inventory, recipes, etc.)
- ✅ Chat tile red badge (Firestore subscription, real-time)
- ✅ Bell drawer for all notification types
- ✅ SMS for urgent alerts via Twilio
- ✅ Web push (for staff who use the app via browser)

What's missing in v1 without native push:
- ❌ App-icon badge with unread number
- ❌ Lock-screen banner + sound when app is closed
- ❌ Banner while phone is in pocket

The current Cloud Function `dispatchNotification` writes the in-app notification doc + sends FCM (which is a no-op for iOS without tokens). The bell drawer still shows everything. Staff just need to open the app to see new chats.

This is shippable. App Store reviewers won't ding you for missing push — many apps don't have it.

---

## Long-term recommendation

Once v1 is in the App Store and Google Play and you're past the initial launch, do this for v1.1:

1. **Definitively fix native push via Option A (most likely works after entitlement fix).**
2. If A doesn't work, **migrate to OneSignal** (Option C). One vendor relationship for push across all platforms, their native init is rock solid, free tier covers your scale.
3. Avoid Option B unless you really want to stay vendor-free.

By v1.2 you'll have push working reliably and the focus can shift to other features.

---

## File audit done overnight

| File | What I checked | Status |
|---|---|---|
| `src/messaging.js` | Token storage logic, dedup, cross-staff sweep, web/native gates | ✅ Robust |
| `functions/index.js` dispatchNotification | Owner-only gate, opt-out, locked-on types, off-shift quiet, coalesce, token dedup | ✅ Robust |
| `public/firebase-messaging-sw.js` | Background message handler, data/notification fallback, tag dedup | ✅ Working |
| `ios/App/App/Info.plist` | UIBackgroundModes remote-notification, permission strings | ✅ Correct |
| `ios/App/App/App.entitlements` | aps-environment | ⚠️ Created tonight, not yet linked from pbxproj (Phase 1 will link it) |
| `ios/App/App.xcodeproj/project.pbxproj` | CODE_SIGN_ENTITLEMENTS | ❌ Currently 0 references — Phase 1 will add it via Xcode UI |
| Apple Developer Portal App ID push capability | ☑ Push Notifications | ✅ You confirmed "its checked" earlier today |
| Firebase Console APNs Auth Key | uploaded for `com.ddmau.staff` | ⚠️ Need to verify in Phase 2 |

---

## Sleep tight

Nothing in the deployed wrapped iOS bundle changed overnight. Whatever was on your iPhone before you went to bed will be the same when you wake up. The only artifact on disk that's new is `App.entitlements` (dormant) and this runbook.

When you wake up: run through Phase 1 + Phase 2, then tell me FCM ready and we wire it up.
