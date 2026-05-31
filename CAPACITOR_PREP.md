# Capacitor wrap — App Store + Play Store runbook

Written 2026-05-31 during the autonomous Cap-readiness audit. Read top to
bottom when Andrew pings "accounts ready" and we start Task #200.

---

## TL;DR resume signal

When Andrew has BOTH:
- Apple Developer Program enrolled (already done — App Store Connect access
  confirmed 2026-05-31)
- Google Play Console enrolled (waiting on Android-device verification)

…ping me with `accounts ready` and we start the install + plugin wiring
flow below. Estimated time to first TestFlight build: 1 working session.

---

## Part 1 — what was fixed in this audit (already shipped, commit `fea00f1`)

These all landed before the wrap so iOS / Android users do not hit them
on Day 1:

| File | Fix |
|---|---|
| `TardinessTracker.jsx` | input `text-sm` → `text-base` (iOS zoom-on-focus) |
| `LaborDashboard.jsx` | target % input `text-sm` → `text-base` |
| `OrderMode.jsx` | row qty input `text-sm` → `text-base` |
| `OnboardingApply.jsx` | `TextInput` component default (cascades to name / phone / email / city), money input, state select, availability textarea — all → `text-base` |
| `AdminPanel.jsx` | stopped logging staff PIN in `console.error` (Sentry / aiDebugReport hygiene) |
| `InsuranceEnrollment.jsx` | defensive `staffName` guard + `alive` guard + `finally` |
| `OnboardingFillablePdf.jsx` | 30s `Promise.race` timeout on the pdf.js render so a slow / failed chunk does not strand the hire on a spinner |
| `Onboarding.jsx` ReminderEmailButton | copy the full reminder to clipboard before `mailto:`, so a WebView with no mail handler still leaves the user with something pasteable |

Build verified clean. Push deployed to GH Pages.

---

## Part 2 — what the audit looked at and is clean

To save you re-auditing: these dimensions came back fine.

- **Firestore queries** — all production paths bounded (`limit`, `where`, date range). No N+1 subscriptions.
- **`onSnapshot` cleanup** — every subscription returns its unsubscribe.
- **`setInterval` / `setTimeout` cleanup** — every interval clears.
- **Async useEffects** — proper `let alive = true` guards in chat thread, onboarding portal, fillable PDF.
- **`window.open(...)` calls** — all 13 use `target="_blank"` correctly.
- **`document.cookie`** — zero usage. Good.
- **Hardcoded API keys** — only the Firebase apiKey (public by design).
- **Sentry redact + breadcrumbs** — `redact.js` + `sentryClient.js` cover SSN, email, phone, FCM tokens, secrets.
- **Storage CORS** — `cors.json` set; reads go through `getBytes()` (SDK XHR, CORS-safe).
- **Privacy policy** — `public/privacy.html` exists and is current (2026-05-29). Need to add an in-app footer link.
- **Image lazy-loading** — already on chat image bubbles.

---

## Part 3 — install Capacitor (when accounts are ready)

From repo root:

```bash
npm install --save \
  @capacitor/core @capacitor/cli \
  @capacitor/ios @capacitor/android \
  @capacitor/app @capacitor/preferences \
  @capacitor/status-bar @capacitor/splash-screen \
  @capacitor/keyboard @capacitor/haptics \
  @capacitor/push-notifications \
  @capacitor/camera @capacitor/geolocation \
  @capacitor/share @capacitor/filesystem \
  @capacitor/network @capacitor/browser

npx cap init "DD Mau" com.ddmau.staff --web-dir=dist
npm run build
npx cap add ios
npx cap add android
npx cap sync
```

Reasoning per plugin:

| Plugin | Why we need it |
|---|---|
| `@capacitor/app` | Handle Android hardware back + app state events |
| `@capacitor/preferences` | Replace localStorage for the PIN / device id (encrypted on iOS Keychain / Android EncryptedSharedPrefs) |
| `@capacitor/status-bar` | Match dd-charcoal / dd-green status bar instead of default white |
| `@capacitor/splash-screen` | Replace browser-tab loading with a real splash |
| `@capacitor/keyboard` | Fix WebView keyboard-show layout shift (the same iOS Safari pain we already softened) |
| `@capacitor/haptics` | Tap haptics on PIN entry, send button, check-offs |
| `@capacitor/push-notifications` | **Critical.** Replaces FCM service-worker push (the SW does not fire in WebView). Bridges APNs (iOS) + native FCM (Android) tokens back to your existing `dispatchNotification` Cloud Function. |
| `@capacitor/camera` | Replace `<input type="file" capture="environment">` in ChatPhotoIssueModal + MaintenanceRequest for a native picker. Keeps the existing input as a desktop fallback. |
| `@capacitor/geolocation` | `src/components/hooks/useGeofence.js` currently calls `navigator.geolocation`. Wrap with the plugin for iOS / Android permission UX. |
| `@capacitor/share` | Native share sheet for the Schedule export ICS file + onboarding URL handoff. |
| `@capacitor/filesystem` | Reliable file save for PDF downloads (signed I-9 / W-4 / catering orders). |
| `@capacitor/network` | Real online / offline detection (more reliable than `navigator.onLine` in WebView). |
| `@capacitor/browser` | Open external URLs (USCIS, IRS forms in Onboarding) in the system browser overlay instead of leaving the app. |

---

## Part 4 — `capacitor.config.ts` recommendations

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ddmau.staff',
  appName: 'DD Mau',
  webDir: 'dist',
  // Bundle the web assets locally. App-store-friendly + works offline.
  // Do NOT set `server.url` to a remote URL — that triggers Apple 4.2
  // "thin wrapper" rejection AND breaks if GH Pages is down.
  server: {
    androidScheme: 'https',
    // Local printer / scraper hostnames need explicit cleartext allow on
    // Android — these are inside the restaurant LAN only.
    cleartext: false, // flip to true ONLY if printer discovery breaks
    allowNavigation: ['*.ddmaustl.com'],
  },
  ios: {
    contentInset: 'always', // respects iPhone notch / Dynamic Island
    backgroundColor: '#0E1116', // dd-charcoal — prevents white flash on launch
  },
  android: {
    backgroundColor: '#0E1116',
    captureInput: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#0E1116',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK', // dark icons on light bg by default; flip with plugin call when chat opens
      backgroundColor: '#FFFFFF',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
```

---

## Part 5 — iOS `Info.plist` additions

After `npx cap add ios`, open `ios/App/App/Info.plist` and add:

```xml
<key>NSCameraUsageDescription</key>
<string>DD Mau uses the camera so you can attach photos of supply issues to chat and maintenance tickets, and capture your ID during onboarding.</string>

<key>NSMicrophoneUsageDescription</key>
<string>DD Mau uses the microphone to record voice notes in chat.</string>

<key>NSPhotoLibraryUsageDescription</key>
<string>DD Mau lets you attach photos from your library to chat and maintenance tickets.</string>

<key>NSLocationWhenInUseUsageDescription</key>
<string>DD Mau uses your location only when you are at work to confirm you are inside the restaurant for clock-in.</string>

<key>NSContactsUsageDescription</key>
<!-- Only if we wire contact import; safe to omit until then -->
```

Apple requires honest, specific copy for each. Vague language ("for app features") gets rejected.

---

## Part 6 — Android `AndroidManifest.xml` additions

Inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.VIBRATE" />
```

The `POST_NOTIFICATIONS` permission is mandatory on Android 13+ — without
it, FCM pushes are silently dropped.

---

## Part 7 — iOS Privacy Manifest (`PrivacyInfo.xcprivacy`)

Required by Apple since May 2024 for App Store approval. Create at
`ios/App/App/PrivacyInfo.xcprivacy`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key>
  <false/>
  <key>NSPrivacyTrackingDomains</key>
  <array/>
  <key>NSPrivacyCollectedDataTypes</key>
  <array>
    <dict>
      <key>NSPrivacyCollectedDataType</key>
      <string>NSPrivacyCollectedDataTypeName</string>
      <key>NSPrivacyCollectedDataTypeLinked</key>
      <true/>
      <key>NSPrivacyCollectedDataTypeTracking</key>
      <false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key>
      <string>NSPrivacyCollectedDataTypePhoneNumber</string>
      <key>NSPrivacyCollectedDataTypeLinked</key>
      <true/>
      <key>NSPrivacyCollectedDataTypeTracking</key>
      <false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key>
      <string>NSPrivacyCollectedDataTypeEmailAddress</string>
      <key>NSPrivacyCollectedDataTypeLinked</key>
      <true/>
      <key>NSPrivacyCollectedDataTypeTracking</key>
      <false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
    <dict>
      <key>NSPrivacyCollectedDataType</key>
      <string>NSPrivacyCollectedDataTypeCrashData</string>
      <key>NSPrivacyCollectedDataTypeLinked</key>
      <false/>
      <key>NSPrivacyCollectedDataTypeTracking</key>
      <false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array>
    </dict>
  </array>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array><string>CA92.1</string></array>
    </dict>
    <dict>
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array><string>C617.1</string></array>
    </dict>
  </array>
</dict>
</plist>
```

These declarations match what the app actually does. Do NOT add tracking
domains — we do not track across apps.

---

## Part 8 — FCM → Capacitor Push Notifications migration

Current setup uses the Firebase Cloud Messaging web SDK + a service
worker (`public/firebase-messaging-sw.js`). The SW does NOT fire in a
Capacitor WebView, so without changes push goes dark on Day 1.

Migration plan (3 small steps when we wire it):

1. **Client side** — in `src/messaging.js`, detect Capacitor at runtime
   (`window.Capacitor?.isNativePlatform()`) and:
   - On native: use `@capacitor/push-notifications` (`register()` returns
     an APNs / FCM device token).
   - On web: keep the existing FCM web SDK path.
2. **Token storage** — add a `platform: 'ios'|'android'|'web'` field to
   each entry in the staff record's `fcmTokens` array. A user with both a
   phone and a browser registered will then get both notified.
3. **Cloud Function** — `functions/index.js` `dispatchNotification` already
   fans out per-token; no change needed. Firebase Admin handles the APNs
   bridging server-side automatically once the token type is registered
   via Firebase Console (Apple Developer → Keys → APNs Auth Key → upload
   to Firebase project settings → Cloud Messaging).

---

## Part 9 — App Store BLOCKERS still to land

These are not "fixes" — they are features we need to build before App
Store submission. None of them block the Capacitor *wrap* itself.

1. **Account deletion path** (Apple AND Google requirement)
   - "Apps that support account creation must also support account
     deletion within the app."
   - Build: a button in My Profile / settings → confirm modal →
     `requestStaffDeletion` Cloud Function → row in
     `/staff_deletion_requests/{staffId}` → admin approves in AdminPanel
     within 7 days → archive hire + remove from `/config/staff.list[]` +
     wipe FCM tokens.
   - Effort: ~1 working session.

2. **In-app privacy policy link**
   - Footer link or "About" screen pointing to
     `https://app.ddmaustl.com/privacy.html`.
   - Effort: 5 min.

3. **Account-deletion mention in privacy policy**
   - Add a paragraph to `public/privacy.html` describing the deletion
     flow + 7-day window.
   - Effort: 5 min.

4. **Listing copy + screenshots**
   - App Store: 6.5" + 5.5" + iPad screenshots, description (4000 char),
     keywords, category (Business), age rating questionnaire.
   - Google Play: feature graphic 1024×500, phone screenshots, short +
     long description, content rating.
   - All bilingual (EN + ES).
   - Effort: ~1 working session per store.

5. **App icons**
   - Use `@capacitor/assets` from `public/dd-mau-logo.png` to generate
     iOS + Android + splash variants.
   - Effort: 10 min.

---

## Part 10 — Known issues we did NOT fix in the audit

Documented for awareness — none block launch.

| File / area | Issue | Why we left it |
|---|---|---|
| `ChatThread.jsx:2782` | Edit-message textarea uses `text-[14.5px]` (zooms on iOS) | Bubble proportions are tightly tuned; bumping risks breaking the bubble layout. Low-traffic path (edit your own sent message). |
| 118 `confirm()` / `alert()` / `prompt()` call sites | iOS / Android native dialogs look small + block UI | Migrating to custom modals is dozens of sessions. Works fine, just ugly. Migrate incrementally per page as we touch them. |
| `Schedule.jsx` cache-vs-live loading split | If Firestore is slow >5 min, cached stale data appears without a refresh spinner | Bigger problem if Firestore is down 5 min. Defer. |
| Operations.jsx midnight interval | No `mounted` check on async setState | Operations is the heaviest file; risk of regression. Defer to a dedicated session. |
| `aiSearch` / `aiFixText` Cloud Functions | No auth check or rate limit | Low cost (Haiku); spam ceiling ~$5/hr; not a PII leak. Phase 2. |
| Account-name-based `/insurance` doc ids | Predictable id → enumerable | Phase 2 Firebase Auth + custom claims is the right fix. |

---

## Part 11 — Pre-submission device test plan

Before TestFlight / internal track upload, test on real hardware:

iOS (iPhone 12 or newer running iOS 17+):
- [ ] PIN unlock + idle relock
- [ ] Chat thread scroll + composer + photo attach + voice record
- [ ] Push notification arrives when app is BACKGROUND + when CLOSED
- [ ] Camera attach on ChatPhotoIssueModal + MaintenanceRequest
- [ ] AirPrint from Schedule print, InventoryHistory print, PrepList print
- [ ] mailto: from ReminderEmailButton (and clipboard fallback toast)
- [ ] Onboarding fillable PDF render + signature capture + submit
- [ ] No viewport zoom on TardinessTracker / OrderMode qty / Apply form
- [ ] Hardware back gesture (swipe from left edge) does NOT exit the app mid-form
- [ ] Status bar style matches each page (light on chat, dark elsewhere)
- [ ] Splash screen → first paint with no white flash

Android (mid-tier device, Android 13+):
- [ ] Same flows
- [ ] Hardware back button: prompts confirm before exiting chat / form
- [ ] Notification permission prompt on first push attempt
- [ ] Native share sheet from Schedule export

---

## Part 12 — Open questions for Andrew when we resume

1. **Bundle ID** — `com.ddmau.staff` or different? (Once submitted, this is
   permanent.)
2. **Display name** — "DD Mau" or "DD Mau Staff"?
3. **Categories** — Apple primary: Business or Food & Drink? Google Play:
   Business or Productivity?
4. **Support URL** — gets shown on the App Store listing. Use the privacy
   policy URL or stand up a dedicated `/support` page?
5. **Marketing URL** — optional but recommended. `https://ddmaustl.com`?
6. **Age rating** — 4+ on Apple, Everyone on Google (no UGC review,
   chat is internal staff-only)?

---

## Resume signal

When ready, ping with `accounts ready` and we install Capacitor +
generate iOS / Android projects. First TestFlight build in same
session.
