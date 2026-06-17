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
import { toast } from './toast';

function isNative() {
    try { return Capacitor.isNativePlatform(); }
    catch { return false; }
}

// Hide the native splash screen. Idempotent + safe to call from any
// path (first-paint, bridge init, error boundary, failsafe timeout) —
// a second call after the splash is already gone is a harmless no-op.
// No-op on web (no native splash exists). Exported so main.jsx can
// fire it the instant React paints, instead of waiting on the full
// initCapacitor() async chain. Andrew 2026-06-13 ("loads so slow").
let _splashHidden = false;
export async function hideSplash() {
    if (!isNative() || _splashHidden) return;
    _splashHidden = true;
    try {
        const { SplashScreen } = await import('@capacitor/splash-screen');
        await SplashScreen.hide();
    } catch (e) {
        console.warn('[cap] splash hide failed:', e?.message);
    }
}

// One-shot init. Safe to call multiple times — guarded by a module-
// level flag so duplicate App.jsx mounts (StrictMode dev double-render)
// don't double-register listeners.
let _initialized = false;

// Subscription handles captured by initCapacitor(). Each Capacitor
// plugin listener returns a Promise<PluginListenerHandle> with a
// `.remove()` method. We retain them so cleanupCapacitor() can tear
// every one down on HMR / future teardown paths.
//
// 2026-06-02 — Practical leak is small because initCapacitor() is
// guarded by _initialized, but HMR can still reload this module
// without unmounting the WebView in dev. Wiring the cleanup hook
// now is cheap and future-proof.
const _subscriptions = [];

// ── Back-stack registry ──────────────────────────────────────────
// 2026-06-02 — Previously the back-button listener dispatched
// cap:back:modal / cap:back:chat-thread DOM events but nothing in
// the app listened for them, so the back gesture inside a modal or
// chat thread silently fell through to the tab-router. Replace the
// event-dispatch with an actual handler stack: modal + chat-thread
// components register a handler on mount and pop it on unmount.
// The hardware back-button listener checks the stack first and
// calls the top handler (LIFO) — matching how the native back
// stack on Android works.
const _backHandlers = [];

// Set true once Capgo has DOWNLOADED a newer OTA bundle that's waiting to be
// applied (see the updateAvailable listener in initCapacitor).
let _otaPending = false;

export function pushBackHandler(fn) {
    if (typeof fn !== 'function') return () => {};
    _backHandlers.push(fn);
    // Return a one-shot popper for the caller — easier than asking
    // them to call popBackHandler() AND pass the same fn reference.
    let popped = false;
    return () => {
        if (popped) return;
        popped = true;
        const idx = _backHandlers.lastIndexOf(fn);
        if (idx >= 0) _backHandlers.splice(idx, 1);
    };
}

export function popBackHandler() {
    return _backHandlers.pop();
}

export async function initCapacitor() {
    if (!isNative()) return;
    if (_initialized) return;
    _initialized = true;

    // 2026-06-01 — Andrew: "the bottom bar with home schedule and ops
    // are moving. keep it locked." The web build of MobileBottomNav
    // already has a GPU layer pin (transform: translateZ(0) + isolation
    // + contain) which fixes the jitter in mobile Safari. Inside the
    // Capacitor WKWebView the jitter source is different: WKWebView's
    // rubber-band overscroll drags fixed-positioned elements with the
    // scroll velocity for ~150ms after a fling. The fix is per-platform:
    // disable overscroll-y on body in the Capacitor build only (we keep
    // it on the web build because pull-to-refresh on the home + chat
    // pages depends on it). Adding `capacitor-native` to body makes
    // every CSS scoped rule we need a one-class hop away.
    try {
        document.body.classList.add('capacitor-native');
    } catch (e) {
        console.warn('[cap] body class add failed:', e?.message);
    }

    // ── Splash screen ────────────────────────────────────────────
    // 2026-06-13 — Andrew: "the ios app on the ipad loads so slow."
    // Root cause: the splash used a FIXED 1500ms floor (launchAutoHide
    // + launchShowDuration:1500), so even when React painted its first
    // screen at ~300ms the user kept staring at the splash for another
    // ~1.2s on every cold launch. Fixed delays read as "slow."
    //
    // New model: launchAutoHide is now FALSE (capacitor.config.ts) — the
    // splash never hides on a timer. hideSplash() is called from
    // main.jsx the moment React commits + paints its first frame (double
    // rAF), so the app appears exactly as soon as it's ready and not a
    // millisecond later. main.jsx also arms a 2.5s failsafe + the
    // RootErrorBoundary hides it, so a render failure can never strand
    // the user on the splash forever. We still call it here as a
    // belt-and-suspenders backup once the native bridge is up.
    hideSplash();

    // ── Capgo: notifyAppReady FIRST ──────────────────────────────
    // 2026-06-14 — call this as early as possible (right after the splash
    // hides), NOT buried at the end of the init chain behind the status-bar,
    // keyboard, and back-button awaits. Capgo treats a bundle that doesn't
    // signal ready within its window as FAILED and rolls back to the previous
    // bundle (a visible reload that reads as "slow," and on a bad cycle can
    // loop). Firing it up front removes that risk and shaves the resume path.
    // Fire-and-forget — the OTA *listeners* are still registered later; this
    // only moves the readiness signal earlier. Idempotent if the later block
    // ever also calls it.
    import('@capgo/capacitor-updater')
        .then(m => m.CapacitorUpdater.notifyAppReady())
        .catch(e => console.warn('[cap] early notifyAppReady failed:', e?.message));

    // ── Status bar ───────────────────────────────────────────────
    // Default state: dark icons on light background (matches the
    // home/schedule/ops pages). The chat tab flips this to LIGHT
    // (light icons on dark bg) via setStatusBarStyle() when it
    // mounts, then flips back on unmount.
    //
    // 2026-06-02 — Do NOT call setOverlaysWebView() here. The
    // overlaysWebView:true value in capacitor.config.ts (StatusBar
    // plugin block) is the source of truth — flipping it at runtime
    // would contradict the static config and confuse anyone reading
    // either file. Overlay mode lets the WebView paint under the
    // status bar so the safe-area-inset-top CSS handles the notch
    // padding (see comment in capacitor.config.ts). We still set
    // style + background color at runtime because those flip per-
    // page (chat dark surface vs. light home).
    try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        // 2026-06-14 — don't AWAIT these two cosmetic setters. They're not
        // needed for first paint (the splash already hid + content is up),
        // and awaiting them serially delayed the keyboard/back-button/OTA
        // blocks that follow. Fire-and-forget removes that latency.
        StatusBar.setStyle({ style: Style.Dark }).catch(() => {}); // 'Dark' = dark text
        StatusBar.setBackgroundColor({ color: '#FFFFFF' }).catch(() => {});
    } catch (e) {
        console.warn('[cap] status bar init failed:', e?.message);
    }

    // ── Keyboard ─────────────────────────────────────────────────
    // Add CSS classes to <body> when the keyboard shows / hides so
    // composer + input layouts can react. The existing iOS Safari
    // viewport hacks already handle most of this in CSS; the body
    // class is an escape hatch for native-only adjustments.
    //
    // 2026-06-02 — Capture the PluginListenerHandle promises so
    // cleanupCapacitor() can remove them on HMR / future teardown.
    // The initCapacitor() guard prevents duplicate listeners during
    // a normal session, but Vite HMR can reload this module without
    // unmounting the WebView — without cleanup that path leaks.
    try {
        const { Keyboard } = await import('@capacitor/keyboard');
        const showHandle = Keyboard.addListener('keyboardWillShow', () => {
            document.body.classList.add('keyboard-open');
        });
        const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
            document.body.classList.remove('keyboard-open');
        });
        _subscriptions.push(showHandle, hideHandle);
    } catch (e) {
        console.warn('[cap] keyboard init failed:', e?.message);
    }

    // ── Hardware back button (Android) ───────────────────────────
    // Android users expect the back gesture to navigate within the
    // app, not exit it immediately. Strategy:
    //   1. If the back-handler stack has any handlers registered
    //      (modals, chat thread, image viewer, etc.), call the top
    //      one. This is the proper LIFO back-stack — components
    //      register on mount via pushBackHandler() and pop on
    //      unmount.
    //   2. If activeTab is not 'home', navigate to home.
    //   3. If we're already on home, prompt to exit. A double-tap-
    //      back-to-exit pattern is the standard Android UX so we
    //      don't accidentally exit on a single tap.
    //
    // 2026-06-02 — Previously priorities 1+2 dispatched DOM events
    // (cap:back:modal, cap:back:chat-thread) that nothing listened
    // for, so the gesture silently fell through. Replaced with a
    // module-level back-handler stack (pushBackHandler / popBack
    // Handler) that modals + ChatCenter populate on mount.
    try {
        const { App: CapApp } = await import('@capacitor/app');
        let lastBackPressMs = 0;
        const backHandle = CapApp.addListener('backButton', () => {
            // Priority 1: invoke the top of the back-handler stack
            // if anything is registered. Handlers are responsible
            // for popping themselves (or the caller's cleanup
            // function does it on unmount).
            if (_backHandlers.length > 0) {
                const top = _backHandlers[_backHandlers.length - 1];
                try { top(); } catch (err) { console.warn('[cap] back handler threw:', err?.message); }
                return;
            }
            // Priority 2: not on home → navigate to home.
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
            // Priority 3: home + back pressed twice within 2s → exit.
            const now = Date.now();
            if (now - lastBackPressMs < 2000) {
                CapApp.exitApp();
                return;
            }
            lastBackPressMs = now;
            document.dispatchEvent(new CustomEvent('cap:back:exit-hint'));
        });
        _subscriptions.push(backHandle);
    } catch (e) {
        console.warn('[cap] back button init failed:', e?.message);
    }

    // ── External links (a[target="_blank"]) ──────────────────────
    // In WKWebView a plain `target="_blank"` anchor opens NOTHING; on Android
    // the OS can hand the URL to a random app. Delegate every such click to the
    // in-app browser (openExternalUrl). Native only — the web build keeps its
    // normal new-tab behavior. Capture phase so we run before React onClicks;
    // we only preventDefault (no stopPropagation) so any sibling handlers still
    // fire. Only intercepts real http(s) URLs, so internal routing is untouched.
    try {
        const extLinkHandler = (ev) => {
            const a = ev.target?.closest?.('a[target="_blank"]');
            if (!a) return;
            const href = a.getAttribute('href') || '';
            if (!/^https?:\/\//i.test(href)) return;
            ev.preventDefault();
            openExternalUrl(href);
        };
        document.addEventListener('click', extLinkHandler, true);
        // Tearable down by cleanupCapacitor() like the plugin listeners.
        _subscriptions.push({ remove: () => document.removeEventListener('click', extLinkHandler, true) });
    } catch (e) {
        console.warn('[cap] external-link delegate failed:', e?.message);
    }

    // ── Capgo OTA listeners ──────────────────────────────────────
    // notifyAppReady() now fires EARLY (right after the splash hide, above) —
    // see the 2026-06-14 note there for why. This block only registers the
    // OTA update listeners + the auto-apply-on-reopen behavior.
    try {
        const { CapacitorUpdater } = await import('@capgo/capacitor-updater');

        // ── OTA refresh trigger — no more "close + reopen twice" ──────
        // With autoUpdate, Capgo downloads a newer bundle in the background but
        // only APPLIES it on the next COLD launch — so a fresh deploy needed two
        // relaunches (one to download, one to apply). Instead we:
        //   (a) show a one-tap "Refresh" toast the moment a bundle is ready, and
        //   (b) auto-apply when the app next returns to the foreground after
        //       being away a few seconds (a genuine reopen — not a quick
        //       tab-away, which would interrupt mid-task).
        // reload() swaps the WebView onto the downloaded bundle in-session.
        const applyOta = async () => {
            try { await CapacitorUpdater.reload(); }
            catch (e) { console.warn('[cap] OTA reload failed:', e?.message); }
        };
        const updHandle = await CapacitorUpdater.addListener('updateAvailable', () => {
            _otaPending = true;
            try {
                toast('✨ New version ready · Nueva versión lista', {
                    kind: 'info',
                    duration: 0,                 // sticky until tapped / dismissed
                    actionLabel: 'Refresh',
                    onAction: applyOta,
                });
            } catch { /* toast is best-effort */ }
        });
        _subscriptions.push(updHandle);

        // Auto-apply on a real reopen (foreground after >8s away). Separate from
        // App.jsx's relock appStateChange listener — both coexist fine.
        let otaBgAt = 0;
        const { App: CapOtaApp } = await import('@capacitor/app');
        const otaStateHandle = await CapOtaApp.addListener('appStateChange', ({ isActive }) => {
            if (!isActive) { otaBgAt = Date.now(); return; }
            // 2026-06-16 (#17): only auto-apply on a GENUINE reopen, and never
            // out from under active input. Raised the away-threshold 8s→30s (a
            // quick mid-task app-switch is usually shorter), and skip the reload
            // while a field is focused/being edited. A skipped bundle stays
            // pending → applies on the next reopen, via the Refresh toast, or on
            // the next cold launch (Capgo applies it regardless).
            const editing = (() => {
                try {
                    const el = document.activeElement;
                    if (!el) return false;
                    if (/^(input|textarea|select)$/i.test(el.tagName)) return true;
                    if (el.isContentEditable) return true;
                } catch {}
                return false;
            })();
            if (_otaPending && otaBgAt > 0 && Date.now() - otaBgAt > 30000 && !editing) applyOta();
            otaBgAt = 0;
        });
        _subscriptions.push(otaStateHandle);
    } catch (e) {
        console.warn('[cap] Capgo notifyAppReady failed:', e?.message);
    }
}

// 2026-06-02 — Tear down every Capacitor plugin listener registered
// by initCapacitor(). Nothing in the app calls this today (the
// _initialized guard makes the practical leak small), but Vite HMR
// can reload this module without unmounting the WebView in dev —
// at which point the next initCapacitor() would register a SECOND
// set of listeners on top of the orphaned first set. Wiring the
// cleanup hook now is cheap and lets a future HMR-aware caller
// (or unit test) flip the bridge off without restarting the app.
export async function cleanupCapacitor() {
    while (_subscriptions.length > 0) {
        const handle = _subscriptions.pop();
        try {
            // Capacitor plugin .addListener() returns either a sync
            // handle or a Promise<handle> depending on version; await
            // both shapes so .remove() always has the resolved object.
            const resolved = handle && typeof handle.then === 'function' ? await handle : handle;
            if (resolved && typeof resolved.remove === 'function') {
                await resolved.remove();
            }
        } catch (e) {
            console.warn('[cap] subscription remove failed:', e?.message);
        }
    }
    _backHandlers.length = 0;
    _initialized = false;
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
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
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

// Cross-platform "print this HTML document" — NATIVE path only.
// The WebView can't print itself: window.open returns null on iOS
// WKWebView, opens an EXTERNAL browser on Android, and window.print()
// (even from a hidden iframe) is a NO-OP in the Android System WebView.
// On native we hand the full HTML to @capgo/capacitor-printer, which
// drives the real OS print sheet (UIPrintInteractionController on iOS /
// PrintManager on Android) → Save-as-PDF / printer / Cancel. The HTML's
// own `@media print` rules (e.g. hiding toolbars) still apply.
//
// USAGE — keeps every existing web path byte-for-byte unchanged:
//   if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Prep'); return; }
//   // ...existing window.open(...) + window.print() code, untouched...
// Fire-and-forget (don't await) so callers stay synchronous.
export async function printViaNative(html, name = 'DD Mau') {
    try {
        const { Printer } = await import('@capgo/capacitor-printer');
        await Printer.printHtml({ name: String(name || 'DD Mau').trim(), html });
    } catch (e) {
        console.warn('[cap] printViaNative failed:', e?.message);
    }
}

// Open a URL the right way per platform. Native: in-app browser
// (@capacitor/browser) so the user stays inside the app and can swipe
// back — window.open returns null on iOS and yanks the user into an
// external browser on Android (losing the authenticated session).
// Web: a normal new tab. Use for viewing photos / external links.
export async function openExternalUrl(url) {
    if (!url) return;
    if (isNative()) {
        try {
            const { Browser } = await import('@capacitor/browser');
            await Browser.open({ url: String(url) });
        } catch (e) {
            console.warn('[cap] openExternalUrl failed:', e?.message);
        }
        return;
    }
    try { window.open(url, '_blank', 'noopener'); } catch { /* ignore */ }
}

// The PUBLIC, off-device base URL for shareable / kiosk / QR / invite links.
// In the native app `window.location.origin` is `capacitor://localhost` (iOS) /
// `https://localhost` (Android) — useless off-device, and the OS may hand such
// a URL to a random installed app. Dev runs on a localhost origin too. So in
// the app (or on any localhost origin) fall back to the canonical public site;
// real web origins (app.ddmaustl.com, github.io) pass through unchanged.
export function publicAppBase() {
    const CANON = 'https://app.ddmaustl.com';
    try {
        const origin = (typeof window !== 'undefined' && window.location.origin) || '';
        const isRealWeb = /^https?:\/\//i.test(origin) && !/\/\/localhost(?::\d+)?(?:$|\/)/i.test(origin);
        if (isNative() || !isRealWeb) return CANON;
        return `${origin}${window.location.pathname.replace(/[^/]*$/, '')}`.replace(/\/$/, '');
    } catch { return CANON; }
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
