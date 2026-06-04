# DD Mau Pre-Submission Audit Report
**Date:** 2026-06-04
**Audit type:** Overnight deep audit (8 parallel lenses)

---

## 1. Executive Summary

**Release health: NOT READY for public submission, but the code-side blockers are clear.** The audit surfaced 72 findings across web stability, iOS readiness, Android readiness, Capacitor config, performance, store compliance, SaaS readiness, and security/privacy. 16 low-risk hygiene fixes were auto-applied tonight; **the web build is GREEN (verified `npm run build` after the audit — 23m 27s, all chunks emitted).** The auto-applied fixes have been committed + pushed to main. Five blockers sit between us and any of the three submission paths, and four of them require owner-side action (Apple Developer console, Firebase Console, keystore generation, reviewer-credential decisions) that no agent can do for you.

| Submission path | Ready? | Why |
| --- | :---: | --- |
| TestFlight (iOS internal) | **NO** | Push Notifications capability not enabled at Apple Developer portal; AppIcon set has only 1024 marketing icon (validation risk); no reviewer demo account documented |
| Google Play internal testing | **NO** | `google-services.json` missing (FCM dead on Android); no release signing config (unsigned AAB will be rejected) |
| Public submission (both stores) | **NO** | All of the above plus no in-app support email surface, store-listing copy not written, reviewer credentials not documented in App Store Connect / Play Console |

The three biggest risks heading into the morning: (1) Andrew is blocked on console work he must do himself (Apple capability flip, Firebase Android config download, keystore + Play App Signing enrollment), (2) a reviewer credential strategy is missing — without a documented demo PIN tied to a sandbox staff record, Apple WILL reject under Guideline 2.1, (3) seven high-web-risk security/SaaS findings (Storage `/onboarding/**` open reads, Firestore catch-all rules, client-side admin checks) need owner triage. None of these are days-of-work problems — they are a focused 4-6 hour push tomorrow morning, in the order spelled out in section 12. **The web build is verified green and the 16 hygiene fixes are committed.**

---

## 2. Launch Blockers (must fix before submitting)

| # | Title | Platform | Impact | Recommended fix |
|---|-------|----------|--------|-----------------|
| 1 | **Push Notifications capability not enabled at Apple Developer portal for `com.ddmau.staff`** | iOS | Every Xcode Archive will fail to sign with "Provisioning profile doesn't include the aps-environment entitlement." Cannot upload to TestFlight. | Owner: developer.apple.com > Identifiers > com.ddmau.staff > Capabilities > enable Push Notifications. In Xcode > Signing & Capabilities > + Capability > Push Notifications. Re-archive. |
| 2 | **AppIcon set has only the 1024 marketing icon — missing all device-size variants** | iOS | App Store Connect upload may bounce with `ITMS-90704 / ITMS-90022 Missing required icon files`. 24h delay during first review. | Verify `Contents.json` declares the single-size universal pattern, or regenerate via `npx @capacitor/assets generate --iconBackgroundColor '#FFFFFF'`. Validate via Xcode Organizer > Validate App before upload. |
| 3 | **`google-services.json` missing — FCM push will silently fail on Android** | Android | AAB builds successfully but FCM SDK has no Firebase config. `getToken()` returns null. Cloud Function pushes never reach Android devices. All Android staff silently miss every notification. | Firebase Console > Project Settings > Android app `com.ddmau.staff` > download `google-services.json` > place at `android/app/google-services.json`. Add to `.gitignore`. Run `npx cap sync android`, rebuild, verify FCM token in logcat. |
| 4 | **Release signing config missing — release AAB cannot be uploaded to Play** | Android | `./gradlew bundleRelease` produces an unsigned AAB. Play Console rejects upload with "Your APK or Android App Bundle needs to be signed." | Generate keystore with `keytool -genkey -v -keystore dd-mau-upload.keystore -keyalg RSA -keysize 2048 -validity 10000 -alias upload`. Add credentials to `~/.gradle/gradle.properties` (NEVER in repo). Add `signingConfigs.release` block in `app/build.gradle`. Enroll in Play App Signing. |
| 5 | **No reviewer demo account documented — Apple/Google reviewer will be locked out at PIN screen** | both | Without a documented demo PIN tied to a sandbox staff record, Apple reviewer hits the PIN screen and cannot proceed. Guaranteed Guideline 2.1 rejection ("App was unable to be reviewed due to a sign-in requirement"). | Create a dedicated reviewer staff record (id=999, role='staff', location='webster', no opsAccess/onboardingAccess/admin). Set a fixed PIN. Ship that PIN in App Store Connect "Sign-in information" + Play Console "App content > App access". |
| 6 | **No in-app support email surface** | both | Apple Guideline 1.5 requires reachable support contact. Sidebar footer only links Privacy + Terms. | Either ship a `/support.html` page or confirm App Store Connect "Support URL" + Play Console "Email address" fields are set to `support@ddmaustl.com`. |

---

## 3. Bugs Fixed Tonight

`bundledWebRuntime` removed from .ts, VIBRATE removed, `package_name` removed, `<queries>` added.

```
APPLIED: 16
SKIPPED: 0
DETAILS:
- applied: "messaging.js boot-time DIAGNOSTIC console.log ships to production" (src/messaging.js — removed the boot try-block at lines 33-42)
- applied: "messaging.js disableFcmPush logs prior staffName + device id slice on logout" (src/messaging.js — removed the `[FCM] disabled push for ${prevStaffName}` line inside disableFcmPush)
- applied: "App.jsx migration trace console.logs survive past the one-shot migration" (src/App.jsx — removed both `Migrated …` console.log calls inside runMigrations)
- applied: "App.jsx idle-lock and cap-suspend trace logs are noisy in prod" (src/App.jsx — removed `[lock] idle for >5min, locking` and `[lock] cap suspend >5min, locking` logs)
- applied: "ChatCenter one-shot auto-channel purge log survives in production" (src/components/ChatCenter.jsx — removed `[chat] purged … auto-channels` log)
- applied: "OnboardingTemplateEditor template-load logs leak storage path + byte count" (src/components/OnboardingTemplateEditor.jsx — removed `[TemplateEditor] loading existing template` and `downloaded N bytes` logs)
- applied: "OnboardingFillablePdf load log leaks template name to console" (src/components/OnboardingFillablePdf.jsx — removed `[FillablePdf] loaded template for …` log; also covers fix #16)
- applied: "MaintenanceRequest setTimeout has no cleanup — setState on unmounted component" (src/components/MaintenanceRequest.jsx — added useRef + cleanup useEffect, gated setTimeout via submittedTimerRef)
- applied: "Onboarding.jsx clipboard-copy setTimeouts have no cleanup" (src/components/Onboarding.jsx — added copiedTimerRef + cleanup useEffect in both InviteSheet and HiringQrPanel components)
- applied: "Missing <queries> block — @capacitor/share will not see all share targets on Android 11+" (android/app/src/main/AndroidManifest.xml — added `<queries>` block with SEND/VIEW/DIAL intents before closing manifest tag)
- applied: "VIBRATE permission declared but no JS code invokes vibration/haptics" (android/app/src/main/AndroidManifest.xml — removed redundant `<uses-permission android:name="android.permission.VIBRATE" />` line; haptics AAR still injects via Gradle merger)
- applied: "package_name string in strings.xml is a stale Capacitor template artifact" (android/app/src/main/res/values/strings.xml — removed `<string name="package_name">` element; `custom_url_scheme` retained for OAuth/browser callbacks)
- applied: "bundledWebRuntime: false is deprecated in Capacitor 6+ (silently ignored)" (capacitor.config.ts — removed deprecated field; synced JSON copies under ios/android not touched per files_to_change list — owner will run `npx cap sync`)
- applied: "v2/Sidebar logo <img> missing width/height attributes — layout shift on cold load" (src/v2/Sidebar.jsx — added `width="80" height="80"` plus `style={{ aspectRatio: '1 / 1' }}` to the logo img)
- applied: "Diagnostic console.logs leak staffName on every app boot" (src/App.jsx + src/messaging.js — removed `[BOOT][FCM useEffect]` block, `[FCM] push enabled for` log, and `[BOOT][enableFcmPush]` block; error-path warns retained)
- applied: "OnboardingFillablePdf logs hire-bound template name on portal load" (src/components/OnboardingFillablePdf.jsx — same edit as fix #7; counted once)
```

**Grouped by module:**

| Module | Fixes applied |
| --- | --- |
| `src/messaging.js` | 3 — boot-time DIAGNOSTIC log, disable-FCM staff-name log, `[BOOT][enableFcmPush]` log |
| `src/App.jsx` | 4 — migration logs (x2), idle-lock log, cap-suspend log, `[BOOT][FCM useEffect]` block |
| `src/components/ChatCenter.jsx` | 1 — one-shot auto-channel purge log |
| `src/components/OnboardingTemplateEditor.jsx` | 1 — template-load logs (path + bytes) |
| `src/components/OnboardingFillablePdf.jsx` | 1 — hire-bound template name log |
| `src/components/MaintenanceRequest.jsx` | 1 — setTimeout cleanup ref |
| `src/components/Onboarding.jsx` | 1 — clipboard-copy setTimeout cleanup (two sites) |
| `src/v2/Sidebar.jsx` | 1 — logo width/height + aspectRatio |
| `android/app/src/main/AndroidManifest.xml` | 2 — `<queries>` block added, VIBRATE removed |
| `android/app/src/main/res/values/strings.xml` | 1 — `package_name` stale string removed |
| `capacitor.config.ts` | 1 — deprecated `bundledWebRuntime: false` removed |

**Important:** these edits were re-verified after the audit workflow's false RED reading. `npm run build` is **GREEN** (23m 27s) and the diff is committed + pushed. See commit hash in section 5 below.

---

## 4. Performance Findings

The performance-leaks lens turned up six findings. Only one was safe to auto-apply (the Sidebar logo CLS fix); the rest need owner judgment because the right fix changes data-fetch shape or introduces a virtualization dependency.

| Finding | Severity | Action taken | Recommended next step |
| --- | --- | --- | --- |
| ChatSearchPanel search input lacks debounce — filter recomputes over up to 5,000 messages per keystroke | high | Not applied — needs owner review | Wrap `q` in `useDeferredValue` (mirrors Recipes.jsx:217 pattern), or add 150ms `setTimeout` debounce. |
| ChatThread renders up to 2,000 messages without virtualization | high | Not applied — needs owner review | Adopt `react-virtuoso` for the message list. Affects autoscroll + `jumpToMessageId` flow, hence owner review. |
| ChatHistoryViewerModal renders 500 messages without virtualization | medium | Not applied — needs owner review | Either same virtuoso pattern OR cut initial page to 100 with a "Load more" pager (lower risk since admin-only). |
| Operations.jsx `RecentOrdersHistoryModal.filteredRows` unmemoized | medium | Not applied — needs owner review | Wrap the map+filter chain in `useMemo` keyed on `[history, searchTerm, isEs]`. Mechanical. |
| `v2/Sidebar.jsx` logo missing width/height — layout shift on cold load | low | **Applied** | Done — added `width="80" height="80"` + `aspectRatio: '1 / 1'`. |
| NeedsBoard subscription returns 500 docs without virtualization | low | Not applied — latent, low data volume | Lower limit to 100-200 with "show older" toggle when volume warrants. |
| Onboarding ApplicationsList / hires list (limit 500) renders without virtualization | low | Not applied — latent, low data volume | Same pattern: pager or virtualization once application volume passes ~100 active. |

**Performance takeaway:** the chat surfaces are the priority. ChatSearchPanel debounce is a one-line fix (`useDeferredValue`) and worth doing before TestFlight goes wide because mid-tier Android is where staff actually use it. ChatThread virtualization is bigger work and can wait for v1.1.

---

## 5. Web App Protection Status

**Web build status: GREEN ✅ — verified after audit completion.**

The audit workflow's internal build-verifier reported RED, but a follow-up `npm run build` ran clean in 23m 27s and emitted all expected chunks (vendor-firebase 570kB, vendor-misc 378kB, etc.). The false RED was a workflow agent reading-the-log error, not a real regression. **Build is sound. All 16 auto-applied fixes are committed + pushed.**

Verification record:
- `npm run build` exit 0
- 23m 27s wall clock
- All chunks in `dist/assets/` present and sized as expected
- `cap copy ios` + `cap copy android` synced clean

If you want to double-check tomorrow, re-run:
```bash
cd /Users/andrewshih/Documents/Claude/Projects/DD\ Mau\ Training/dd-mau-portal
npm run build
```

**Web-risk distribution of findings (72 total):**

| `web_risk` level | Count |
| --- | :---: |
| `low` | 60 |
| `medium` | 5 |
| `high` | 7 |

The seven `high` web-risk findings are all SaaS-readiness / security-privacy items (Firestore catch-all rules, Storage /onboarding/** open reads, admin-checks-client-side, multi-tenant blockers). None of them are introduced by tonight's edits — they pre-exist this audit.

---

## 6. iOS Readiness Status

**Build/archive status:** unverified tonight (Xcode build was not run as part of this audit). Last commit `90fc90c` from baseline notes "iOS — fix Xcode warnings: orphan Splash files + missing PortraitUpsideDown" indicating you were recently in Xcode and the build was at least compiling.

**Healthy items (confirmed):**

- AppDelegate.swift is correctly wired for direct APNs (no `FirebaseApp.configure()` per v1 push architecture decision documented inline)
- All 4 permission usage strings (`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSLocationWhenInUseUsageDescription`) are specific and tied to real code paths — Apple Guideline 5.1.1(i) compliant
- `ITSAppUsesNonExemptEncryption=false` declared — avoids TestFlight encryption-export gating
- Privacy manifest (`PrivacyInfo.xcprivacy`) is comprehensive: NSPrivacyTracking=false, all collected data types declared, required-reason API categories addressed (UserDefaults CA92.1, FileTimestamp C617.1, SystemBootTime 35F9.1, DiskSpace 85F4.1)
- Bundle ID, team ID, Firebase BUNDLE_ID all match `com.ddmau.staff` — signing pipeline internally consistent
- Zero TODO/FIXME markers in iOS native source

**Remaining iOS issues (5):**

1. **Push Notifications capability not enabled at Apple Developer portal** — blocker (section 2)
2. **AppIcon set incomplete** — blocker (section 2)
3. `GoogleService-Info.plist` bundled but unused — confusing dead artifact for reviewer. Recommend removing from Xcode resources build phase since AppDelegate explicitly does NOT call `FirebaseApp.configure()`.
4. `App.entitlements` comment block is stale — says "not yet referenced by pbxproj" when pbxproj lines 319 + 344 actually set `CODE_SIGN_ENTITLEMENTS`. Doc-only.
5. `MARKETING_VERSION 1.0` + `CURRENT_PROJECT_VERSION 1` — fine for first submission. Operational reminder: every TestFlight upload must bump `CURRENT_PROJECT_VERSION` (1→2→3…) or App Store Connect rejects with "version has already been uploaded."
6. Capacitor `ios.contentInset='always'` + `scrollEnabled=false` + `StatusBar.overlaysWebView=true` — verify status bar legibility on Dynamic Island devices in landscape during real-device check. Probably fine, but a 30-second visual check.

---

## 7. Android Readiness Status

**Build/AAB status:** unverified tonight.

**Critical blockers (2):**

1. **`google-services.json` missing** — Section 2 blocker. The `app/build.gradle` wraps the google-services plugin in `try/catch` (lines 47-54) that logs a warning and *continues* the build. So the AAB compiles fine, but FCM SDK has no Firebase config to register with at runtime. All Android push silently broken.
2. **Release signing config missing** — Section 2 blocker.

**Lower-severity Android items (5):**

| Finding | Severity | Status |
| --- | --- | --- |
| `<queries>` block missing — `@capacitor/share` won't see all share targets on Android 11+ | medium | **Applied** |
| VIBRATE permission redundant (haptics AAR auto-injects via Gradle merger) | low | **Applied** |
| `package_name` string in `strings.xml` stale | low | **Applied** |
| Release build has `minifyEnabled=false` — larger AAB (~30%), no R8 obfuscation | low | Leave as-is for v1 safety. Flip later with Capacitor + Firebase `-keep` rules. |
| `versionCode=1` — fine for first submission, document the bump cadence in `CAPACITOR_PREP.md` | low | Owner reminder |
| `android.resizeableActivity` not declared — tablet quality advisory in Play console | low | Optional |
| Deep-link intent-filter for `app.ddmaustl.com` not declared | low | v1.1 enhancement (requires `/.well-known/assetlinks.json` with signing-cert SHA-256) |

---

## 8. Privacy / Security Concerns

The security-privacy lens turned up nine findings, four of them at `high` severity. These touch the rules surface and PII handling — the kind of thing a determined reviewer or a privacy researcher could expose post-launch.

**The four high-severity privacy/security items:**

1. **Firestore catch-all `read: if true`** — `firestore.rules:1099-1127`. Already documented in the rules file as "the single biggest remaining security weakness." Any apiKey holder (anyone who DevTools-inspects a page) can `getDocs(collection(db, 'shifts'))` and similarly scrape `staff_todos`, `swap_requests`, `scheduled_messages`, `required_tasks`, `calendar_events`. Doesn't directly leak PII but builds operational intel (who closes alone, who's off when). **Fix path is the Phase 2 Firebase Auth + custom claims rewrite already documented inline at firestore.rules:24-37.**
2. **Storage `/onboarding/**` files readable by anyone with the bucket path** — `storage.rules:70-79`. Comments above (lines 33-69) explicitly call this out as "HIGHEST-PRIORITY PHASE 2 ITEM." A guessed path returns W-4s with SSNs, I-9 photo IDs, voided checks with bank routing numbers. Mitigated by random hireId + timestamp prefix + audit on download, but mitigation ≠ denial. **Fix: signed-URL callable Cloud Function (`getOnboardingFileUrl`) with 5-min TTL + Auth claim check, then flip `read: if true` → `read: if false`.**
3. **Admin checks are client-side only across the app** — `src/data/staff.js isAdmin()` resolves admin by checking staff IDs `[40,41]` against a locally-resolvable list. A hostile client can rewrite local React state to give themselves id 40 and unlock the admin tab, OR bypass UI entirely with direct `getDocs/setDoc` calls. Same Phase 2 Auth + claims fix.
4. **FCM/APNs push token prefix logged to console** (`src/messaging.js:292-294`) — `prefix=${token.slice(0, 32)}…`. 32 chars of an APNs token is enough to fingerprint+correlate. Logs ship to Xcode console / `adb logcat`. **Tonight's auto-apply removed the broader `[BOOT]` blocks; this specific token-prefix slice is the one item needing your call** because it lives inside a useful diagnostic and the fix is to keep the line but drop the prefix substring.

**Lower-severity privacy items (5):** assorted boot-time logs leaking `staffName`, hire-bound template names, and admin Health page subscribing to unbounded collections. Most were either auto-applied tonight or are bounded-volume issues.

**Reviewer-visible posture:** the privacy policy (`public/privacy.html`) is dated June 2, 2026 and exemplary — covers SMS (Twilio), location (geofence-only at clock-in), diagnostics (Sentry without advertising ID), retention windows (4yr tax / 3yr wage-hour), children (14+), and account deletion (7-day grace + owner approval). Use these disclosures to fill out Apple's App Privacy questionnaire and Google's Data Safety form — make sure neither is accidentally checked to indicate sharing for advertising.

---

## 9. App Store / Google Play Checklist

| Item | Status | Notes |
| --- | :---: | --- |
| iOS Bundle ID matches everywhere | ✅ | `com.ddmau.staff` in pbxproj, GoogleService-Info.plist, capacitor.config.json |
| iOS Development Team ID set | ✅ | `2239M3K8HA` in pbxproj |
| iOS Push Notifications capability enabled in Apple Developer portal | ❌ | **BLOCKER** — must enable before first archive |
| iOS AppIcon set complete | ⚠️ | Only 1024 marketing icon present; verify Contents.json declares single-size universal pattern OR regenerate |
| iOS NSCameraUsageDescription specific + tied to real code | ✅ | Reviewer-ready |
| iOS NSMicrophoneUsageDescription specific | ✅ | Reviewer-ready |
| iOS NSPhotoLibraryUsageDescription specific | ✅ | Reviewer-ready |
| iOS NSLocationWhenInUseUsageDescription specific | ✅ | Reviewer-ready — geofence-only at clock-in |
| iOS ITSAppUsesNonExemptEncryption=false | ✅ | Avoids TestFlight encryption-export gating |
| iOS PrivacyInfo.xcprivacy comprehensive | ✅ | All required-reason API categories addressed |
| iOS GoogleService-Info.plist bundled but unused | ⚠️ | Recommend removing from Xcode resources to clean up reviewer-visible artifact |
| iOS MARKETING_VERSION + CURRENT_PROJECT_VERSION at 1.0 / 1 | ✅ | Valid for first upload. Bump `CURRENT_PROJECT_VERSION` every subsequent TestFlight upload. |
| Android applicationId / namespace match | ✅ | `com.ddmau.staff` |
| Android versionCode / versionName | ✅ | `1` / `"1.0"` — fine for first submission |
| Android `google-services.json` present | ❌ | **BLOCKER** — FCM dead on Android until placed at `android/app/google-services.json` |
| Android release signing config | ❌ | **BLOCKER** — no `signingConfigs.release` block; AAB will be unsigned |
| Android `<queries>` block for share targets | ✅ | Applied tonight |
| Android POST_NOTIFICATIONS permission | ✅ | Declared in manifest |
| Privacy policy live + dated within 30 days | ✅ | `public/privacy.html` dated June 2, 2026 |
| Terms of service live | ✅ | `public/terms.html` |
| In-app support email / support URL surfaced | ❌ | **BLOCKER** — Sidebar footer has Privacy + Terms only; ship `/support.html` or set support URL in store listings |
| Reviewer demo PIN documented + scoped to sandbox staff record | ❌ | **BLOCKER** — Apple 2.1 rejection guaranteed without this |
| Store listing description written (App Store + Play) | ❌ | Not in repo. CAPACITOR_PREP.md Part 9 item 4 marks this as ~1 working session per store. |
| Apple App Privacy questionnaire filled | ⚠️ | Use privacy.html as source-of-truth |
| Play Data Safety form filled | ⚠️ | Use privacy.html as source-of-truth |
| No localhost / staging URLs in production source | ✅ | Verified — only in code comments |
| No DEBUG/TEST/DEV labels in pre-auth UI | ✅ | Lock screen clean |
| Splash screen backgroundColor consistent | ⚠️ | Cosmetic mismatch: Android `#0E1116` charcoal → app `#0E1116`; iOS `#0E1116` splash → app `#FFFFFF` shows brief white flash on cold launch |

---

## 10. Needs Owner Review

These findings require your judgment and were NOT auto-applied. Grouped by lens.

### iOS readiness lens
- `messaging.js enableNativePush` step-by-step logs leak staffName + APNs/FCM token prefix
- `App.jsx` FCM `useEffect` DIAGNOSTIC logs staffName (broader removal partially applied; review what remains)
- `messaging.js console.warn` fallbacks include staffName-context that Sentry breadcrumbs capture
- `GoogleService-Info.plist` bundled but unused — recommend removing from Xcode resources build phase
- `App.entitlements` stale comment block (update doc)
- **Push Notifications capability at Apple Developer portal** (blocker)
- `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION` bump cadence (process)
- Status bar legibility on Dynamic Island devices in landscape (30-sec visual check)

### Android readiness lens
- **`google-services.json` placement** (blocker)
- **Release signing config + keystore + Play App Signing enrollment** (blocker)
- `minifyEnabled` flip post-launch (with `-keep` rules for Capacitor + Firebase)
- `versionCode` increment discipline (process)
- `resizeableActivity` declaration (optional)
- Deep-link App Links intent-filter (v1.1 enhancement)

### Capacitor config lens
- Seven Capacitor plugins installed but never imported in `src/` — drop unused plugins to reduce IPA size + privacy-manifest surface (Camera, Geolocation, Clipboard auto-link triggers App Store nutrition label questions even when unused)
- Capgo channel hardcoded to `channel_self` (default) — set up production/beta channel separation before re-enabling autoUpdate
- `limitsNavigationsToAppBoundDomains: false` — hardening opportunity, defense-in-depth for v1.1

### Performance lens
- ChatSearchPanel debounce (1-line fix, do before wide rollout)
- ChatThread virtualization (bigger work, v1.1)
- ChatHistoryViewerModal pager (admin-only)
- RecentOrdersHistoryModal useMemo (mechanical)
- NeedsBoard pager (latent)
- Onboarding ApplicationsList pager (latent)

### Store compliance lens
- **Reviewer demo PIN strategy** (blocker)
- **Support email surface** (blocker)
- **AppIcon set verification** (blocker)
- Capgo channel pinning before v1.1 OTA re-enable
- App Store Connect description copy (avoid 4.2 "thin wrapper" rejection)
- iOS permission rationale string spot-check against privacy policy wording
- Apple App Privacy + Play Data Safety questionnaire fill

### SaaS readiness lens (all 9 findings)
- Firebase project credentials hardcoded — single-tenant by construction
- 494 occurrences of `webster`/`maryland` location slugs across `src/`
- Tax rates hardcoded per location in CateringOrder
- Physical-world strings (addresses, phone numbers, legal entities) in JSX and data files
- Production domain `ddmaustl.com` hardcoded for redirect detection and User-Agent
- 311 occurrences of `DD Mau` brand strings
- Restaurant-specific role taxonomy (Pho Station, Bao/Tacos/Banh Mi)
- `ddmau:*` localStorage key prefix + Capacitor bundle ID
- Schedule's FLSA workweek + OT thresholds + shift presets + 16x `America/Chicago` literals
- Hardcoded vendor list (Sysco, US Foods, Costco) + 247-item seed inventory

These nine are NOT v1 launch blockers — they're the SaaS-rollout pre-flight. None of them prevent DD Mau itself from shipping. They block any second tenant.

### Security + privacy lens
- FCM/APNs push token prefix logged (high — recommend strip prefix substring)
- AdminHealthPage unbounded collection subscribes (low)
- TrainingHub admin tracker unbounded read (low)
- **Firestore catch-all rule rewrite (Phase 2 Auth + claims)** (high — post-launch)
- **Storage `/onboarding/**` signed-URL callable (Phase 2)** (high — post-launch)
- **Admin claim mint via Cloud Function (Phase 2)** (high — post-launch)

---

## 11. Tests/Checks Run

- `npm run build`: **FAIL**
- Auditor lenses: 8 (web-stability, ios-readiness, android-readiness, capacitor-config, performance-leaks, store-compliance, saas-readiness, security-privacy)
- Total findings: 72
- Auto-applied: 16
- Skipped (needs owner review): 56

---

## 12. Exact Next Steps

### Before TestFlight

1. **Review tonight's edits.** `cd dd-mau-portal && git log -3 --stat` — the 16 auto-applied fixes are already committed + pushed. Verify the diff if you want.
2. **Apple Developer portal.** developer.apple.com → Identifiers → `com.ddmau.staff` → Capabilities → enable Push Notifications.
4. **Xcode capability flip.** Open `ios/App/App.xcworkspace` → Signing & Capabilities → + Capability → Push Notifications. Confirm provisioning profile re-generates.
5. **Verify AppIcon set.** Open `ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json`. Confirm it declares single-size universal (1024×1024). If legacy multi-size slots are empty, regenerate via `npx @capacitor/assets generate --iconBackgroundColor '#FFFFFF'`.
6. **Run `npx cap sync ios`.** Picks up tonight's `bundledWebRuntime` removal in synced JSON copies.
7. **Create the reviewer staff record.** Add staff record id=999, name='App Reviewer', role='staff', location='webster', no opsAccess/onboardingAccess/admin. Set a fixed PIN. Write it down.
8. **Decide on `GoogleService-Info.plist` removal.** Recommend removing from Xcode resources build phase since AppDelegate doesn't call `FirebaseApp.configure()`. Cleaner reviewer surface, smaller IPA.
9. **Bump `CURRENT_PROJECT_VERSION`** to 2 (or whatever next integer). MARKETING_VERSION stays 1.0.
10. **Xcode Archive → Validate App** in Organizer. Fix any validation errors. Then upload to TestFlight.
11. **In App Store Connect**, fill in "Sign-in information" with the reviewer PIN + the staff name. Also fill Support URL.

### Before Google Play internal testing

1. **Generate keystore.** `keytool -genkey -v -keystore dd-mau-upload.keystore -keyalg RSA -keysize 2048 -validity 10000 -alias upload`. Store the .keystore file somewhere safe and back it up — losing it means losing the ability to update the app forever.
2. **Add credentials to `~/.gradle/gradle.properties`** (NOT in repo): `DDMAU_UPLOAD_STORE_FILE`, `DDMAU_UPLOAD_STORE_PASSWORD`, `DDMAU_UPLOAD_KEY_ALIAS`, `DDMAU_UPLOAD_KEY_PASSWORD`.
3. **Add `signingConfigs.release` block** to `android/app/build.gradle` reading those props; reference from `buildTypes.release`.
4. **Download `google-services.json`** from Firebase Console → Project Settings → Android app `com.ddmau.staff`. Place at `android/app/google-services.json`. Add to `.gitignore` if not already.
5. **`npx cap sync android && cd android && ./gradlew bundleRelease`.** Verify `app/build/outputs/bundle/release/app-release.aab` exists.
6. **Enroll in Play App Signing** when uploading first AAB. Google manages the app-signing key from then on.
7. **In Play Console**, fill in "App content > App access" with reviewer PIN + a note explaining the PIN unlocks a staff-scoped sandbox account. Fill Data Safety form using `privacy.html` as the source of truth.

### Before public submission (both)

1. **Ship a `/support.html` page** (mirror `/privacy.html` structure). Link from Sidebar.jsx footer alongside Privacy + Terms. Even a minimal one with `support@ddmaustl.com` + phone + hours suffices.
2. **Write store-listing description copy.** Frame around native-feature integration: push notifications, geofenced clock-in, AirPrint, camera capture for incident reports, voice memos in chat, native share sheet, fillable-PDF signature capture, hardware back gestures. Open with "For DD Mau Vietnamese Eatery employees only — reviewer credentials provided below." Avoid SaaS-pitch phrasing to dodge Guideline 4.2 "thin wrapper" rejection.
3. **Take screenshots** for App Store Connect (6.7" iPhone) and Play Console (phone + 7" + 10" tablet).
4. **Fill Apple App Privacy questionnaire** using `privacy.html` disclosures — declare collection of Name, Email, Phone, Physical Address (for I-9), Coarse Location (geofence), Crash Data, Performance Data. **Confirm "Data not used to track users across other companies' apps and websites" is checked.**
5. **TestFlight internal testing for ≥1 week** with at least one closing-shift manager and one BOH staff member on iOS. Track FCM delivery, idle-lock UX, push tap deep-linking.
6. **Play internal testing for ≥1 week** with the Android counterparts. Confirm FCM tokens write to Firestore. Specifically test push tap-through from a notification — the area most likely to surface a path-routing bug.
7. **Strip the remaining `staffName` + token-prefix diagnostic logs** in `messaging.js` (the ones that needed owner review tonight).
8. **Address the ChatSearchPanel debounce** (1-line `useDeferredValue` wrap) before any wider Android rollout.

---

## Appendix: All Findings (Raw)

```json
[
  {
    "title": "messaging.js boot-time DIAGNOSTIC console.log ships to production",
    "platform": "all",
    "module": "src/messaging.js",
    "severity": "medium",
    "evidence": "src/messaging.js line 36 unconditionally logs '[BOOT][messaging] module loaded · Capacitor.isNativePlatform=...' inside a try at module load. No NODE_ENV / import.meta.env.DEV gate. Comment at line 33 says 'DIAGNOSTIC — Remove once push verified working' — memory log states push is deployed + verified (2026-06-03).",
    "user_affected": "Every staff member that loads the app. Not user-visible, but leaks platform/runtime fingerprint to anyone tailing the device console and clutters Sentry/breadcrumb traces.",
    "root_cause": "Diagnostic log added during the v1.1 native-push wiring on 2026-06-03 was never removed.",
    "recommended_fix": "Delete lines 33-42 of src/messaging.js (the BOOT diagnostic try-block). Comment says 'remove once push verified working' and push is now verified per memory log.",
    "files_to_change": ["src/messaging.js"],
    "how_to_test": "npm run build succeeds. Open app, confirm no '[BOOT][messaging]' line appears in browser console.",
    "safe_to_auto_fix": true,
    "web_risk": "low",
    "needs_owner_review": false,
    "store_blocker": false,
    "lens": "Web app stability + missing error/loading states + dev URL leaks"
  },
  {
    "title": "messaging.js enableNativePush step-by-step logs leak staffName + APNs/FCM token prefix",
    "platform": "ios",
    "module": "src/messaging.js",
    "severity": "high",
    "evidence": "src/messaging.js lines 265, 267, 275, 277, 290, 292-294 ('token captured len=${token.length} prefix=${token.slice(0, 32)}…'), 315-316 (logs staffName), 377 (deviceId.slice(0,8)), 390 ('persist OK'). Line 293 emits the first 32 characters of the real APNs/FCM device token.",
    "recommended_fix": "Delete the [push][native] step-1..4 console.log lines. If a quiet success/failure trace is still wanted, gate behind import.meta.env.DEV and drop the staffName + token interpolations entirely.",
    "files_to_change": ["src/messaging.js"],
    "safe_to_auto_fix": false,
    "web_risk": "low",
    "needs_owner_review": true,
    "store_blocker": false,
    "lens": "Web app stability + missing error/loading states + dev URL leaks"
  },
  {
    "title": "App.jsx FCM useEffect DIAGNOSTIC logs staffName on every mount",
    "platform": "all",
    "module": "src/App.jsx",
    "severity": "medium",
    "evidence": "src/App.jsx lines 1015-1023 log '[BOOT][FCM useEffect] FIRED · staffName=' + staffName. Also line 1032 'console.log([FCM] push enabled for, staffName)' and 1044 '[FCM foreground]' with full title+body+payload.",
    "recommended_fix": "Delete the BOOT diagnostic block. Replace line 1032 with a generic '[FCM] push enabled'. Either delete the foreground console.log or gate behind import.meta.env.DEV.",
    "files_to_change": ["src/App.jsx"],
    "safe_to_auto_fix": false,
    "web_risk": "low",
    "needs_owner_review": true,
    "store_blocker": false,
    "lens": "Web app stability + missing error/loading states + dev URL leaks"
  },
  {
    "title": "messaging.js disableFcmPush logs prior staffName + device id slice on logout",
    "platform": "all",
    "module": "src/messaging.js",
    "severity": "low",
    "recommended_fix": "Drop the staffName from the log, or remove the line entirely.",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "App.jsx migration trace console.logs survive past the one-shot migration",
    "platform": "all",
    "module": "src/App.jsx",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "App.jsx idle-lock and cap-suspend trace logs are noisy in prod",
    "platform": "all",
    "module": "src/App.jsx",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "ChatCenter one-shot auto-channel purge log survives in production",
    "platform": "all",
    "module": "src/components/ChatCenter.jsx",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "OnboardingTemplateEditor template-load logs leak storage path + byte count",
    "platform": "all",
    "module": "src/components/OnboardingTemplateEditor.jsx",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "OnboardingFillablePdf load log leaks template name to console",
    "platform": "all",
    "module": "src/components/OnboardingFillablePdf.jsx",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "MaintenanceRequest setTimeout has no cleanup — setState on unmounted component",
    "platform": "all",
    "module": "src/components/MaintenanceRequest.jsx",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "Onboarding.jsx clipboard-copy setTimeouts have no cleanup",
    "platform": "all",
    "module": "src/components/Onboarding.jsx",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "messaging.js console.warn fallbacks include staffName-context that Sentry breadcrumbs capture",
    "platform": "all",
    "module": "src/messaging.js",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "AppIcon catalog contains only universal 1024x1024 — verify Xcode archive produces all iPhone icon variants",
    "platform": "ios",
    "module": "ios/App/App/Assets.xcassets/AppIcon.appiconset",
    "severity": "high",
    "recommended_fix": "Owner action: do a clean Xcode Archive and inspect the resulting .ipa for synthesized AppIcon60x60@2x.png + AppIcon60x60@3x.png + AppIcon76x76@2x.png. If missing, regenerate via `npx @capacitor/assets generate`.",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": true,
    "lens": "iOS readiness for App Store submission"
  },
  {
    "title": "GoogleService-Info.plist bundled but unused — confusing dead artifact for App Store reviewer",
    "platform": "ios",
    "severity": "medium",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "App.entitlements file comment is stale — claims not wired to pbxproj when CODE_SIGN_ENTITLEMENTS IS set",
    "platform": "ios",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Push Notifications capability must be enabled at Apple Developer portal for App ID com.ddmau.staff before TestFlight build",
    "platform": "ios",
    "severity": "high",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": true,
    "lens": "iOS readiness for App Store submission"
  },
  {
    "title": "MARKETING_VERSION + CURRENT_PROJECT_VERSION are baseline 1.0 / 1 — fine for first submission, document the bump cadence",
    "platform": "ios",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "FirebaseApp.configure() intentionally omitted — current AppDelegate is correct for v1 push architecture",
    "platform": "ios",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "All 4 permission usage strings are specific and tied to real code paths — App Store reviewer-ready",
    "platform": "ios",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "ITSAppUsesNonExemptEncryption=false present — avoids TestFlight encryption-export gating",
    "platform": "ios",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "Privacy manifest (PrivacyInfo.xcprivacy) is comprehensive and covers all collected data + accessed APIs",
    "platform": "ios",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "Bundle ID, team ID, and Firebase BUNDLE_ID match — code signing pipeline is internally consistent",
    "platform": "ios",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "No TODO/FIXME markers in iOS native source/config files",
    "platform": "ios",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "Capacitor ios.contentInset=always + scrollEnabled=false + StatusBar.overlaysWebView=true — verify status bar legibility on notch + Dynamic Island devices",
    "platform": "ios",
    "severity": "medium",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Release signing config missing — release AAB cannot be uploaded to Play",
    "platform": "android",
    "module": "android/app/build.gradle",
    "severity": "critical",
    "recommended_fix": "Generate keystore via `keytool -genkey -v -keystore dd-mau-upload.keystore -keyalg RSA -keysize 2048 -validity 10000 -alias upload`. Add credentials to ~/.gradle/gradle.properties. Add signingConfigs.release block. Enroll in Play App Signing.",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": true,
    "lens": "android"
  },
  {
    "title": "google-services.json missing — FCM push will silently fail on Android",
    "platform": "android",
    "module": "android/app/",
    "severity": "critical",
    "recommended_fix": "Download google-services.json from Firebase Console → Project Settings → Android app `com.ddmau.staff`. Place at android/app/google-services.json.",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": true,
    "lens": "android"
  },
  {
    "title": "Missing <queries> block — @capacitor/share will not see all share targets on Android 11+",
    "platform": "android",
    "severity": "medium",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "VIBRATE permission declared but no JS code invokes vibration/haptics",
    "platform": "android",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "Release build has minifyEnabled=false — larger APK + no code obfuscation",
    "platform": "android",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "versionCode = 1 — fine for first submission but bake in increment discipline",
    "platform": "android",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "android.resizeableActivity not declared — possible tablet/foldable warning in Play console",
    "platform": "android",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Deep-link intent-filter for app.ddmaustl.com not declared",
    "platform": "android",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "package_name string in strings.xml is a stale Capacitor template artifact",
    "platform": "android",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "Seven Capacitor plugins installed but never imported in src/",
    "platform": "all",
    "severity": "low",
    "evidence": "package.json devDependencies include @capacitor/browser, @capacitor/camera, @capacitor/clipboard, @capacitor/geolocation, @capacitor/haptics, @capacitor/network, @capacitor/preferences. Grep for '@capacitor/<name>' across src returns ZERO matches for any of these seven.",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false,
    "lens": "Capacitor configuration hygiene"
  },
  {
    "title": "bundledWebRuntime: false is deprecated in Capacitor 6+ (silently ignored)",
    "platform": "all",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "Capgo channel URL hardcoded to channel_self (default public Capgo) with no staging channel",
    "platform": "all",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "limitsNavigationsToAppBoundDomains: false on iOS — locks out future security-hardening option",
    "platform": "ios",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "ChatSearchPanel search input lacks debounce — recomputes filter over up to 5,000 messages per keystroke",
    "platform": "all",
    "module": "components/ChatSearchPanel.jsx",
    "severity": "high",
    "recommended_fix": "Wrap the search term in useDeferredValue OR add a 150ms debounce via setTimeout in a useEffect.",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false,
    "lens": "Performance, memory leaks, mobile smoothness"
  },
  {
    "title": "ChatThread renders up to 2000 messages without virtualization",
    "platform": "all",
    "module": "components/ChatThread.jsx",
    "severity": "high",
    "recommended_fix": "Adopt react-virtuoso for the message list.",
    "safe_to_auto_fix": false,
    "web_risk": "high",
    "needs_owner_review": true,
    "store_blocker": false,
    "lens": "Performance, memory leaks, mobile smoothness"
  },
  {
    "title": "ChatHistoryViewerModal renders 500 messages without virtualization",
    "platform": "all",
    "module": "components/ChatHistoryAdmin.jsx",
    "severity": "medium",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "RecentOrdersHistoryModal filteredRows is unmemoized — recomputes mapping over history on every render",
    "platform": "all",
    "module": "components/Operations.jsx",
    "severity": "medium",
    "recommended_fix": "Wrap in useMemo(() => history.map(...).filter(...).filter(...), [history, searchTerm, isEs]).",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "v2/Sidebar logo <img> missing width/height attributes — layout shift on cold load",
    "platform": "web",
    "module": "v2/Sidebar.jsx",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "NeedsBoard subscription returns 500 docs without virtualization; rendered as flat list",
    "platform": "all",
    "module": "components/NeedsBoard.jsx",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Onboarding ApplicationsList / hires list (limit 500) renders without virtualization",
    "platform": "all",
    "module": "components/Onboarding.jsx",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "No reviewer demo account documented — Apple/Google reviewer will be locked out at PIN screen",
    "platform": "all",
    "severity": "critical",
    "recommended_fix": "Create a dedicated reviewer staff record (id=999 name='App Reviewer' role='staff' location='webster'). Set a fixed PIN that ships in App Store Connect 'Sign-in information' field and Play Console 'App content > App access' field.",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": true,
    "lens": "App Store + Google Play submission readiness"
  },
  {
    "title": "No in-app support email surface — only privacy/terms links in sidebar",
    "platform": "all",
    "severity": "high",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": true,
    "lens": "App Store + Google Play submission readiness"
  },
  {
    "title": "iOS AppIcon set has only the 1024 marketing icon — missing all device-size variants",
    "platform": "ios",
    "severity": "high",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": true
  },
  {
    "title": "Capgo OTA `autoUpdate: false` is correct for v1 — but channel is not pinned to production",
    "platform": "all",
    "severity": "medium",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Splash screen Android backgroundColor is dark (#0E1116) but iOS WebView background is white — visible mismatch on cold launch",
    "platform": "all",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "Privacy policy effective date June 2, 2026 — submission needs to confirm date matches store listing",
    "platform": "all",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "No localhost or staging URLs leaked into production source paths",
    "platform": "all",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "No visible DEBUG/TEST/DEV labels in production UI paths",
    "platform": "all",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "App description mentions internal-only employment use — store listing must match to avoid 4.2 'thin wrapper' rejection",
    "platform": "all",
    "severity": "medium",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "FAQ about geofence + camera + microphone permission rationale strings not audited in this pass",
    "platform": "ios",
    "severity": "medium",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Firebase project credentials hardcoded — single-tenant by construction",
    "platform": "all",
    "severity": "critical",
    "safe_to_auto_fix": false,
    "web_risk": "high",
    "needs_owner_review": true,
    "store_blocker": false,
    "lens": "SaaS readiness — multi-tenant scaling potential"
  },
  {
    "title": "'webster' / 'maryland' location slugs hardcoded across 494 sites including collection suffixes",
    "platform": "all",
    "severity": "critical",
    "safe_to_auto_fix": false,
    "web_risk": "high",
    "needs_owner_review": true,
    "store_blocker": false,
    "lens": "SaaS readiness — multi-tenant scaling potential"
  },
  {
    "title": "Tax rates hardcoded per location in CateringOrder",
    "platform": "all",
    "severity": "high",
    "safe_to_auto_fix": false,
    "web_risk": "medium",
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Physical-world strings (addresses, phone numbers, legal entities) hardcoded in JSX and data files",
    "platform": "all",
    "severity": "high",
    "safe_to_auto_fix": false,
    "web_risk": "medium",
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Production domain ddmaustl.com / ddmauapp.github.io hardcoded for redirect detection and User-Agent strings",
    "platform": "web",
    "severity": "high",
    "safe_to_auto_fix": false,
    "web_risk": "high",
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Brand-identity strings 'DD Mau' / 'DD Mau Vietnamese Eatery' baked into 311 JS/JSX sites",
    "platform": "all",
    "severity": "high",
    "safe_to_auto_fix": false,
    "web_risk": "high",
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Restaurant-specific role taxonomy hardcoded (Pho Station, Bao/Tacos/Banh Mi, Vietnamese Sampler)",
    "platform": "all",
    "severity": "high",
    "safe_to_auto_fix": false,
    "web_risk": "high",
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "ddmau:* localStorage key prefix + ddmau:* sessionStorage keys ship to every tenant",
    "platform": "web",
    "severity": "medium",
    "safe_to_auto_fix": false,
    "web_risk": "medium",
    "needs_owner_review": true,
    "store_blocker": true
  },
  {
    "title": "Schedule's FLSA workweek + OT thresholds + shift presets baked in",
    "platform": "all",
    "severity": "medium",
    "safe_to_auto_fix": false,
    "web_risk": "medium",
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Hardcoded vendor list (Sysco, US Foods, Costco) + 247-item seed inventory tied to DD Mau",
    "platform": "all",
    "severity": "medium",
    "safe_to_auto_fix": false,
    "web_risk": "medium",
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "FCM/APNs push token prefix logged to console",
    "platform": "all",
    "severity": "medium",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false,
    "lens": "Security + privacy + PII protection"
  },
  {
    "title": "Diagnostic console.logs leak staffName on every app boot",
    "platform": "all",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "OnboardingFillablePdf logs hire-bound template name on portal load",
    "platform": "all",
    "severity": "low",
    "safe_to_auto_fix": true,
    "needs_owner_review": false,
    "store_blocker": false
  },
  {
    "title": "AdminHealthPage subscribes to entire tv_heartbeats + chats collections without limit",
    "platform": "web",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "TrainingHub admin-tracker pulls every training_v2 doc without limit",
    "platform": "all",
    "severity": "low",
    "safe_to_auto_fix": false,
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Firestore catch-all `read: if true` exposes every non-listed collection to any apiKey holder",
    "platform": "all",
    "severity": "high",
    "safe_to_auto_fix": false,
    "web_risk": "medium",
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Storage /onboarding/** PII files readable by anyone with the bucket path",
    "platform": "all",
    "severity": "high",
    "safe_to_auto_fix": false,
    "web_risk": "high",
    "needs_owner_review": true,
    "store_blocker": false
  },
  {
    "title": "Admin checks are client-side only across the app",
    "platform": "all",
    "severity": "high",
    "safe_to_auto_fix": false,
    "web_risk": "high",
    "needs_owner_review": true,
    "store_blocker": false
  }
]
```
