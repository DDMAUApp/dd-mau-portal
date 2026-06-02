import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AppToast from './components/AppToast.jsx';
import './index.css';
import './firebase.js';
import { setupPWA } from './pwa.js';
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
try { initSentry(); } catch (e) { console.warn('initSentry failed:', e?.message); }
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
    <React.Fragment>
        <App />
        <AppToast />
    </React.Fragment>
);
