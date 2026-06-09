import React, { Component } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AppToast from './components/AppToast.jsx';
import './index.css';
import './firebase.js';
import { setupPWA } from './pwa.js';

// ─── Top-level ErrorBoundary — never let the screen go white ─────────
// 2026-06-02 — Andrew "im stuck on the white screen again". App.jsx
// already has an inner ErrorBoundary keyed on activeTab, but that
// boundary is INSIDE App. If App.jsx itself throws during its own
// render (or a top-level hook/effect throws), the inner boundary is
// never reached and React unmounts the whole tree → white screen.
//
// This RootErrorBoundary wraps <App /> at the React root so absolutely
// any uncaught render error in the entire tree lands here and shows a
// usable fallback UI with the actual error message instead of white.
// The user can tap Reload to retry. In native iOS/Android wraps this
// makes white-screen-from-a-render-error impossible.
//
// We deliberately do NOT swallow the error — it's surfaced in the UI
// and console.error'd so Safari Web Inspector picks it up. No
// dependency on the app's logger module so this boundary can't itself
// depend on a chunk that failed to load.
class RootErrorBoundary extends Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error, info) {
        try { console.error('[RootErrorBoundary]', error, info?.componentStack); } catch {}
    }
    render() {
        if (!this.state.error) return this.props.children;
        const msg = (this.state.error && (this.state.error.message || String(this.state.error))) || 'Unknown error';
        return (
            <div style={{
                padding: '32px 20px',
                minHeight: '100vh',
                boxSizing: 'border-box',
                background: '#f0f7f1',
                color: '#0f172a',
                fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            }}>
                <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>DD Mau hit a snag</h1>
                <p style={{ fontSize: 15, marginBottom: 16 }}>
                    Something failed while loading the app. Tap Reload to try again. If it keeps happening, take a screenshot and send it to Andrew.
                </p>
                <pre style={{
                    background: '#fff',
                    padding: 12,
                    borderRadius: 8,
                    border: '1px solid #d1d5db',
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    marginBottom: 20,
                    maxHeight: 200,
                    overflow: 'auto',
                }}>{msg}</pre>
                <button
                    onClick={() => { try { window.location.reload(); } catch {} }}
                    style={{
                        background: '#255a37',
                        color: 'white',
                        border: 'none',
                        padding: '14px 24px',
                        borderRadius: 12,
                        fontSize: 16,
                        fontWeight: 700,
                        width: '100%',
                    }}>
                    Reload
                </button>
            </div>
        );
    }
}
// Capacitor native runtime bridge — 2026-05-31. Initialises the
// status bar style, splash hide, keyboard listeners, Android back
// button, and Capgo OTA on native builds. No-op on the web build
// (Capacitor.isNativePlatform() returns false in browsers).
import { initCapacitor } from './capacitor-bridge.js';
// Sentry — Andrew 2026-05-26. Initialised BEFORE React renders so
// the very first render is instrumented. No-op when VITE_SENTRY_DSN
// is missing (dev or fresh-clone state) — see src/data/sentryClient.js.
import { initSentry } from './data/sentryClient.js';

// 2026-06-01 — wrap each init in try/catch so a throw from any of
// them cannot prevent React from mounting. The first iOS build came
// up to a white screen because a single PWA setup exception broke
// the entire boot chain. Defensive try/catch keeps the React tree
// rendering even if one helper bombs.
// 2026-06-01 round 2 — Set body.capacitor-native SYNCHRONOUSLY here
// before React renders. capacitor-bridge.js still sets it from its
// async initCapacitor() below, but that runs AFTER the first paint —
// so for the first ~50ms of frames the bottom nav rendered without
// the CSS rules that disable WKWebView rubber-band. Setting the class
// here makes the lockdown rules apply from frame 1 of the React tree.
try {
    if (typeof window !== 'undefined' && window?.Capacitor?.isNativePlatform?.()) {
        document.body.classList.add('capacitor-native');
        // 2026-06-01 round 4 — also stamp on <html> so the body+root
        // scroll-restructure CSS can target html as a containing block
        // for the locked viewport.
        document.documentElement.classList.add('capacitor-native');
        // 2026-06-03 — Andrew reported Android app is slow + laggy.
        // Tag platform so CSS can disable backdrop-filter blur on
        // Android (kills GPU compositing in Android WebView, causes
        // major jank on scroll/animations). iOS WKWebView handles
        // backdrop-filter natively, no override needed there.
        const platform = window?.Capacitor?.getPlatform?.();
        if (platform === 'android') {
            document.body.classList.add('capacitor-android');
            document.documentElement.classList.add('capacitor-android');
        } else if (platform === 'ios') {
            document.body.classList.add('capacitor-ios');
            document.documentElement.classList.add('capacitor-ios');
        }
    }
    // 2026-06-03 — Tag ANY Android device (Chrome browser visiting
    // app.ddmaustl.com OR Capacitor wrapped app) via UA sniff. The
    // capacitor-android class above only fires inside the wrapped
    // app; Chrome browser on Android also needs the perf overrides.
    // body.is-android-device catches both cases. UA sniff for
    // "Android" excludes iOS devices reliably.
    if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '')) {
        document.body.classList.add('is-android-device');
        document.documentElement.classList.add('is-android-device');
    }
} catch (_) { /* no-op — non-fatal if Capacitor global isn't there */ }

// Sentry init is deferred to idle (after first paint) and the SDK lazy-loads,
// so the ~150KB @sentry chunk never blocks the lock screen / first paint. Early
// errors are still caught by logger.js's global window.onerror +
// unhandledrejection handlers.
{
    const startSentry = () => { initSentry().catch((e) => console.warn('initSentry failed:', e?.message)); };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(startSentry, { timeout: 4000 });
    else setTimeout(startSentry, 1500);
}
try { setupPWA(); } catch (e) { console.warn('setupPWA failed:', e?.message); }
// Fire-and-forget: the Capacitor init reads platform state then
// wires listeners. Web builds skip the body of every function via
// Capacitor.isNativePlatform() === false at the top, so this adds
// nothing measurable to the web critical path.
initCapacitor().catch((e) => console.warn('initCapacitor failed:', e?.message));

// AppToast subscribes to the module-level toast queue. Rendering it
// here (sibling of <App />) guarantees it shows on every code path —
// the lock screen, onboarding portal, public apply page, install
// splash, and the main app shell — without needing prop-drilling.
//
// HISTORICAL BUG (Andrew 2026-05-17 polish pass): AppToast was imported
// inside src/App.jsx but never actually rendered. Every existing toast()
// call (in AdminPanel, Operations, Onboarding, Eighty6Dashboard, etc.)
// silently produced no UI — users saw nothing when an error toast or
// success toast was fired. Mounting it at the root fixes the entire
// toast pipeline in one shot.
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
    <RootErrorBoundary>
        <App />
        <AppToast />
    </RootErrorBoundary>
);
