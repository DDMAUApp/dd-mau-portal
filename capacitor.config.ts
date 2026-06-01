// Capacitor configuration for the DD Mau staff portal native wrap.
//
// 2026-05-31 — Initial wrap. Web app continues to deploy unchanged
// to https://app.ddmaustl.com via GitHub Pages; this config drives
// the native iOS + Android shells that wrap the same `dist/` bundle.
//
// Design decisions baked in below:
//   • appId is permanent once we ship — `com.ddmau.staff` matches
//     the Capgo registration. Apple + Google use this as the
//     unique bundle/package identifier.
//   • Web assets bundle LOCALLY (`webDir: dist`). We do NOT set
//     `server.url` to a remote address; that pattern triggers
//     Apple 4.2 "thin wrapper" rejection AND would break the app
//     if GitHub Pages is ever down.
//   • Cleartext HTTP is OFF. The portal only talks to HTTPS
//     services (Firestore, Storage, app.ddmaustl.com). Flip this
//     to `true` only if a future LAN-printer feature needs raw
//     HTTP — comment it back out as soon as that work is done.
//   • Status bar style starts DARK (dark icons on light background)
//     since the home screen, schedule, and ops pages are light.
//     The chat tab flips it to LIGHT at runtime via a plugin call.
//   • Splash screen shows for 1.5s on cold launch over the
//     dd-charcoal (#0E1116) background — kills the white flash
//     during JS hydration on slower devices.

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    appId: 'com.ddmau.staff',
    appName: 'DD Mau',
    webDir: 'dist',
    bundledWebRuntime: false,

    server: {
        // Use https scheme on Android (matches iOS WKWebView semantics
        // for service workers + secure cookies).
        androidScheme: 'https',
        // Cleartext (raw http://) traffic stays OFF. All Firebase
        // endpoints are https. If LAN printer discovery ever needs
        // http, flip to true here AND add a corresponding networkSecurity
        // config to the Android project (per-domain allow).
        cleartext: false,
        // Allow in-app navigation to our own production domain so
        // privacy-policy + ToS links open inline rather than handing
        // off to the system browser. External links go through
        // @capacitor/browser explicitly.
        allowNavigation: ['*.ddmaustl.com', 'app.ddmaustl.com'],
    },

    ios: {
        // Respect notch + Dynamic Island. With 'always' the WebView
        // viewport sits below the notch and above the home indicator.
        contentInset: 'always',
        // Background behind the WebView during launch + transitions.
        // Set to dd-charcoal so the cold-launch frame matches the
        // splash + status-bar style (no white flash).
        backgroundColor: '#0E1116',
        // Prevent overscroll bounce — it looks great on Mobile Safari
        // but on iOS native apps it's not idiomatic and can cause
        // confusing UX inside scrolling lists.
        scrollEnabled: true,
        limitsNavigationsToAppBoundDomains: false,
    },

    android: {
        backgroundColor: '#0E1116',
        captureInput: true,
        webContentsDebuggingEnabled: false,
    },

    plugins: {
        SplashScreen: {
            // 1.5s feels native — long enough to hide the JS hydration
            // gap, short enough that staff don't perceive a delay.
            launchShowDuration: 1500,
            launchAutoHide: true,
            backgroundColor: '#0E1116',
            androidScaleType: 'CENTER_CROP',
            showSpinner: false,
            splashFullScreen: true,
            splashImmersive: true,
        },
        StatusBar: {
            // Light pages by default (home, schedule, ops). Chat thread
            // flips this to DARK at runtime via StatusBar.setStyle({ style: 'Dark' }).
            style: 'LIGHT',
            backgroundColor: '#FFFFFF',
            overlaysWebView: false,
        },
        PushNotifications: {
            // Show alerts + sounds + badge counts via the OS, not the
            // in-app notification system. The dispatchNotification
            // Cloud Function builds the payload — these are the iOS
            // foreground presentation options.
            presentationOptions: ['badge', 'sound', 'alert'],
        },
        Keyboard: {
            // Don't resize the WebView when the keyboard appears (we
            // handle viewport adjustments in CSS via the iOS Safari
            // pattern already documented in the codebase). Use 'native'
            // for default iOS behavior.
            resize: 'native',
            style: 'DEFAULT',
            resizeOnFullScreen: true,
        },
        CapacitorUpdater: {
            // Capgo OTA updates. The API key is set at runtime in
            // src/main.jsx (read from env at build time), NOT hard-
            // coded here, so the same config works for dev + prod.
            // autoUpdate true means the plugin checks for a new bundle
            // on every app foreground; if newer, downloads + applies
            // on next cold launch.
            autoUpdate: true,
            // Production-safe defaults. Tighten to staging-only via
            // the Capgo dashboard channels if needed.
            statsUrl: 'https://api.capgo.app/stats',
            updateUrl: 'https://api.capgo.app/updates',
            channelUrl: 'https://api.capgo.app/channel_self',
        },
    },
};

export default config;
