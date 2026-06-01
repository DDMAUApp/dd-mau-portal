// Capacitor native runtime bridge.
//
// 2026-05-31 — Created during the iOS / Android wrap. Every Capacitor
// plugin call lives behind a runtime detection guard so the same code
// runs unchanged on the web build (browsers ignore the plugin calls,
// since Capacitor.isNativePlatform() returns false). Web users see
// zero behavior change.
//
// Public API:
//   • initCapacitor()  — call once after the React tree mounts.
//                        Wires status bar, splash hide, back button,
//                        keyboard, and starts the Capgo OTA check.
//   • setStatusBarStyle(style)  — 'light' (light icons on dark bg)
//                                 or 'dark' (dark icons on light bg).
//                                 Wired from ChatThread on open/close.
//   • downloadFile({ data, fileName, mimeType })
//                        — works on web AND native. Web uses anchor
//                          download; native writes to Documents via
//                          @capacitor/filesystem then opens a share
//                          sheet so the user picks where it goes.
//   • shareText(text)    — native share sheet on iOS / Android, falls
//                          back to navigator.share on web.
//
// Web-only behavior is preserved by import-time short-circuits — if
// Capacitor isn't loaded (web build), the helpers no-op gracefully.

import { Capacitor } from '@capacitor/core';

function isNative() {
    try { return Capacitor.isNativePlatform(); }
    catch { return false; }
}

// One-shot init. Safe to call multiple times — guarded by a module-
// level flag so duplicate App.jsx mounts (StrictMode dev double-render)
// don't double-register listeners.
let _initialized = false;

export async function initCapacitor() {
    if (!isNative()) return;
    if (_initialized) return;
    _initialized = true;

    // ── Splash screen ────────────────────────────────────────────
    // Hide the native splash once React has mounted and the first
    // paint is done. The 1500ms launchShowDuration in capacitor.config
    // is the FLOOR — splash hides ASAP after that whether or not we
    // call hide() ourselves. We call it explicitly so the splash
    // doesn't linger if hydration was faster than expected.
    try {
        const { SplashScreen } = await import('@capacitor/splash-screen');
        await SplashScreen.hide();
    } catch (e) {
        console.warn('[cap] splash hide failed:', e?.message);
    }

    // ── Status bar ───────────────────────────────────────────────
    // Default state: dark icons on light background (matches the
    // home/schedule/ops pages). The chat tab flips this to LIGHT
    // (light icons on dark bg) via setStatusBarStyle() when it
    // mounts, then flips back on unmount.
    try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        await StatusBar.setStyle({ style: Style.Dark }); // 'Dark' = dark text
        await StatusBar.setBackgroundColor({ color: '#FFFFFF' });
        await StatusBar.setOverlaysWebView({ overlay: false });
    } catch (e) {
        console.warn('[cap] status bar init failed:', e?.message);
    }

    // ── Keyboard ─────────────────────────────────────────────────
    // Add CSS classes to <body> when the keyboard shows / hides so
    // composer + input layouts can react. The existing iOS Safari
    // viewport hacks already handle most of this in CSS; the body
    // class is an escape hatch for native-only adjustments.
    try {
        const { Keyboard } = await import('@capacitor/keyboard');
        Keyboard.addListener('keyboardWillShow', () => {
            document.body.classList.add('keyboard-open');
        });
        Keyboard.addListener('keyboardWillHide', () => {
            document.body.classList.remove('keyboard-open');
        });
    } catch (e) {
        console.warn('[cap] keyboard init failed:', e?.message);
    }

    // ── Hardware back button (Android) ───────────────────────────
    // Android users expect the back gesture to navigate within the
    // app, not exit it immediately. Strategy:
    //   1. If a modal is open (body has data-modal-open), close the
    //      modal instead of navigating.
    //   2. If a chat thread is open, leave the thread back to the
    //      chat list (Capacitor wraps the existing chat-thread-open
    //      body data flag).
    //   3. If activeTab is not 'home', navigate to home.
    //   4. If we're already on home, prompt to exit. A double-tap-
    //      back-to-exit pattern is the standard Android UX so we
    //      don't accidentally exit on a single tap.
    try {
        const { App: CapApp } = await import('@capacitor/app');
        let lastBackPressMs = 0;
        CapApp.addListener('backButton', () => {
            // Priority 1: close any open modal. We detect the open
            // state via body data attributes that the chat surface
            // and modals already set. Future modals just need to
            // set body.dataset.modalOpen = 'true' to participate.
            if (document.body.dataset.modalOpen === 'true') {
                document.dispatchEvent(new CustomEvent('cap:back:modal'));
                return;
            }
            // Priority 2: chat thread open → leave thread.
            if (document.body.dataset.chatThreadOpen === 'true') {
                document.dispatchEvent(new CustomEvent('cap:back:chat-thread'));
                return;
            }
            // Priority 3: not on home → navigate to home.
            // Implementation reads the saved tab from localStorage
            // and dispatches a custom event the App.jsx tab router
            // can listen for. We do NOT call history.back() because
            // this is a single-page app with no real route history.
            const currentTab = (() => {
                try { return localStorage.getItem('ddmau:activeTab') || 'home'; }
                catch { return 'home'; }
            })();
            if (currentTab !== 'home') {
                document.dispatchEvent(new CustomEvent('cap:back:to-home'));
                return;
            }
            // Priority 4: home + back pressed twice within 2s → exit.
            const now = Date.now();
            if (now - lastBackPressMs < 2000) {
                CapApp.exitApp();
                return;
            }
            lastBackPressMs = now;
            document.dispatchEvent(new CustomEvent('cap:back:exit-hint'));
        });
    } catch (e) {
        console.warn('[cap] back button init failed:', e?.message);
    }

    // ── Capgo OTA check ──────────────────────────────────────────
    // Live updates from Capgo. The plugin auto-checks on every
    // foreground per autoUpdate:true in capacitor.config.ts; calling
    // notifyAppReady on first launch tells Capgo the bundle survived
    // hydration and can be promoted to "ready for users". Without
    // this call, Capgo treats every bundle as still-on-trial.
    try {
        const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
        await CapacitorUpdater.notifyAppReady();
    } catch (e) {
        console.warn('[cap] Capgo notifyAppReady failed:', e?.message);
    }
}

// Status-bar style toggle. Called by ChatThread on mount/unmount so
// the chat dark surface gets light status bar icons and other pages
// get dark icons on the light surface.
export async function setStatusBarStyle(style) {
    if (!isNative()) return;
    try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        const map = { light: Style.Light, dark: Style.Dark };
        await StatusBar.setStyle({ style: map[style] || Style.Dark });
        // Match background color too. Light style is used over dark
        // page background (chat), so the bar background goes dark.
        const bg = style === 'light' ? '#0a0a0a' : '#FFFFFF';
        await StatusBar.setBackgroundColor({ color: bg });
    } catch (e) {
        console.warn('[cap] setStatusBarStyle failed:', e?.message);
    }
}

// Cross-platform file download. Replaces the `<a download>` +
// URL.createObjectURL pattern which doesn't work in WebView. On native
// we save to Documents, then open a share sheet so the user picks
// where the file lands.
export async function downloadFile({ data, fileName, mimeType = 'application/octet-stream' }) {
    if (!isNative()) {
        // Web path — anchor download, same as existing code.
        const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { ok: true, path: null };
    }
    // Native path — write to Documents, then share so the user can
    // save it to Files / Drive / iCloud / Photos etc.
    try {
        const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
        // Convert Blob/ArrayBuffer to base64 for the plugin.
        const base64 = await blobToBase64(data, mimeType);
        const res = await Filesystem.writeFile({
            path: fileName,
            data: base64,
            directory: Directory.Documents,
            recursive: true,
        });
        try {
            const { Share } = await import('@capacitor/share');
            await Share.share({
                title: fileName,
                url: res.uri,
                dialogTitle: 'Save or share',
            });
        } catch {
            // Share refused or unavailable — file is still saved.
        }
        return { ok: true, path: res.uri };
    } catch (e) {
        console.warn('[cap] downloadFile failed:', e?.message);
        return { ok: false, error: e?.message };
    }
}

async function blobToBase64(data, mimeType) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => {
            // r.result is "data:<mime>;base64,<payload>" — strip the prefix
            const s = String(r.result || '');
            const idx = s.indexOf(',');
            resolve(idx >= 0 ? s.slice(idx + 1) : s);
        };
        r.onerror = () => reject(r.error || new Error('blob read failed'));
        r.readAsDataURL(blob);
    });
}

// Native share sheet on iOS / Android; falls back to Web Share API
// on supporting browsers, then to clipboard as last resort.
export async function shareText(text, title = '') {
    if (isNative()) {
        try {
            const { Share } = await import('@capacitor/share');
            await Share.share({ text, title });
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e?.message };
        }
    }
    if (navigator.share) {
        try { await navigator.share({ text, title }); return { ok: true }; }
        catch { /* user cancelled */ }
    }
    try {
        await navigator.clipboard.writeText(text);
        return { ok: true, copied: true };
    } catch (e) {
        return { ok: false, error: e?.message };
    }
}
