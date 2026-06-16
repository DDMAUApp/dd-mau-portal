# Native build punch list — perf/size (NOT OTA-able)

From the 2026-06-15 iOS/Android audit. These all live in native project config or
asset catalogs, so they need a full **Xcode (iOS)** / **Android Studio (Android)**
rebuild + a new store submission. Capgo OTA can't touch them. The JS-side native
fix (skip the version.json poll on native) already shipped via OTA in v1.0.80.

Everything else the audit checked is already correct: iOS Release is optimized
(`-O`, whole-module, assertions off, no bitcode), cleartext is scoped on iOS via
`NSAllowsLocalNetworking`, `hardwareAccelerated=true`, `allowBackup=false`,
SDK levels healthy (minSdk 24 / target 36 / iOS 15), permissions tight, no
`server.url` (avoids Apple 4.2), `CAPACITOR_DEBUG` does NOT reach the iOS Release
build, push background mode justified.

## 1. Android — enable R8 minify + resource shrink (BIGGEST WIN)
`android/app/build.gradle`, `buildTypes.release`: currently `minifyEnabled false`,
no `shrinkResources`. A `proguard-rules.pro` is already wired but inert.
```gradle
release {
    minifyEnabled true
    shrinkResources true
    proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
    // ...existing signing config...
}
```
After enabling, build a release AAB and **test on a real device**: push notifications,
camera/photo pick, share-sheet export, and a Capgo OTA apply — Capacitor plugins
sometimes need keep-rules. Smaller download + faster cold start.

## 2. Android — scope cleartext to the printer only (hardening)
`android/app/src/main/AndroidManifest.xml` has `android:usesCleartextTraffic="true"`
app-wide (needed for the Epson LAN printer over http). Printing works today; this
is just narrowing the surface (and Play flags blanket cleartext). Replace with a
per-domain rule:
- add `res/xml/network_security_config.xml` allowing cleartext ONLY for the printer
  IP/subnet, and reference it via `android:networkSecurityConfig` on `<application>`;
- remove `android:usesCleartextTraffic="true"`.
(Also realigns the now-misleading `cleartext: false` comment in capacitor.config.ts.)

## 3. iOS — slim the splash imageset (~2 MB dead weight)
`ios/App/App/Assets.xcassets/Splash.imageset/` is 3.5 MB: six identical 2732×2732
PNGs (592 KB each, 3 light + 3 dark) filling @1x/@2x/@3x with the same oversized
image. Ship one correctly-scaled universal image (or let Capacitor's splash config
generate proper scales). Trims the IPA.

## 4. Android — splash PNG → WebP (~1.7 MB → ~half)
`android/app/src/main/res/**/splash.png` (26 files) are PNG. Android Studio →
right-click → "Convert to WebP". The modern splash is the `Theme.SplashScreen`
windowBackground (already used), so the full-bleed per-density set is largely legacy
— could also drop unused densities.

## 5. iOS — bump `MARKETING_VERSION` off `1.0` (cosmetic)
`ios/App/App.xcodeproj/project.pbxproj` still shows `MARKETING_VERSION = 1.0`. Bump
the human-facing version string on the next submission.

---
Priority: **#1 (R8)** is the only one with a real perf payoff; #3/#4 are size; #2 is
hardening; #5 is cosmetic. None are urgent — batch them into your next native build.
