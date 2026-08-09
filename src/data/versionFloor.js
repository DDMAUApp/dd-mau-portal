// versionFloor.js — the fleet minimum-version gate (Phase 2 of the
// stabilization plan, SCHEDULING-FORENSICS.md §13 / root cause R2).
//
// WHY: bugs that were fixed weeks ago kept "coming back" because devices
// running old builds keep writing data with old logic — a June-29 build
// was still active on Aug 7 [prod]. The existing OTA self-update is
// aggressive but ADVISORY; nothing STOPS a device that slipped through.
// This gate does: when `config/minVersion.min` is above the running
// build, the app updates itself via the existing machinery, and if it
// cannot (native binary too old, OTA unreachable), it shows a blocking
// "update required" screen instead of silently operating on stale logic.
//
// FAIL-OPEN BY DESIGN: any parse error, missing doc, or garbage value
// must NEVER block the app — a bad minVersion write must not brick the
// fleet. The floor only ever bites when it is deliberately set to a real
// version above the device's build.
//
// Raising the floor (owner procedure): set /config/minVersion
//   { min: '1.0.XXX', setAt: <server timestamp>, note: 'why' }
// Never set it above the version currently serving at
// https://app.ddmaustl.com/version.json — web clients can only reach
// what the site serves.

// '1.0.390' → [1, 0, 390]. Takes the FIRST whitespace-delimited token, so
// the build's display string '1.0.390 · 9c288be' (__APP_VERSION__ includes
// the git hash) parses — a strict parser here would silently kill the gate
// forever. Returns null for anything unparsable.
export function parseVersion(v) {
    if (typeof v !== 'string') return null;
    const parts = v.trim().split(/\s+/)[0].split('.');
    if (parts.length < 2 || parts.length > 4) return null;
    const nums = parts.map(p => (/^\d+$/.test(p) ? parseInt(p, 10) : NaN));
    if (nums.some(Number.isNaN)) return null;
    return nums;
}

// True ONLY when both versions parse and local is strictly below min.
// Unparsable input → false (fail-open).
export function isBelowMinVersion(local, min) {
    const a = parseVersion(local);
    const b = parseVersion(min);
    if (!a || !b) return false;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x < y) return true;
        if (x > y) return false;
    }
    return false;
}

// One floor-triggered reload per window — the same anti-loop posture as
// firestoreRevive's escalateReload. If the reload didn't fix it (service
// worker pinned an old bundle, native binary too old), looping would just
// thrash; the caller shows the blocking screen instead.
export const FLOOR_RELOAD_GUARD_MS = 10 * 60 * 1000;
const GUARD_KEY = 'ddmau:versionFloorReloadAt';

export function shouldAttemptFloorReload(storage) {
    try {
        const s = storage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
        if (!s) return true;
        const last = Number(s.getItem(GUARD_KEY)) || 0;
        if (Date.now() - last < FLOOR_RELOAD_GUARD_MS) return false;
        s.setItem(GUARD_KEY, String(Date.now()));
        return true;
    } catch {
        return true; // storage broken — still try the one reload
    }
}

// ── The live gate ──────────────────────────────────────────────────────────
// Subscribes to /config/minVersion. Below the floor:
//   1. Show a blocking "Updating…" overlay immediately (an outdated build
//      must stop taking input — its writes are the whole problem).
//   2. Drive the EXISTING update machinery (Capgo OTA on native; verified
//      version.json + cache-busting reload on web).
//   3. If the device is still here 90s later (native binary too old, OTA
//      unreachable, service worker pinned), flip the overlay to a manual
//      "Update required" screen with a retry button — never a reload loop.
//
// The overlay is imperative DOM on document.body, deliberately outside the
// React tree: it must cover every screen (lock screen included) and must
// not depend on any component surviving the reload it is about to cause.

import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

export const FLOOR_STUCK_MS = 90 * 1000;
const OVERLAY_ID = 'ddmau-version-floor-overlay';

function renderOverlay(mode, localV, minV, onRetry) {
    if (typeof document === 'undefined') return;
    let el = document.getElementById(OVERLAY_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = OVERLAY_ID;
        el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#0f2417;color:#fff;'
            + 'display:flex;flex-direction:column;align-items:center;justify-content:center;'
            + 'font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:24px;gap:12px;';
        document.body.appendChild(el);
    }
    const spin = mode === 'updating'
        ? '<div style="width:36px;height:36px;border:4px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:ddmauspin 1s linear infinite"></div>'
          + '<style>@keyframes ddmauspin{to{transform:rotate(360deg)}}</style>'
        : '<div style="font-size:40px">⬆️</div>';
    const headline = mode === 'updating'
        ? 'Updating the app… / Actualizando la aplicación…'
        : 'Update required / Actualización requerida';
    const detail = mode === 'updating'
        ? 'This version is out of date. The update applies automatically — one moment.<br/>Esta versión está desactualizada. La actualización se aplica sola — un momento.'
        : 'This device could not update itself. Close the app fully and reopen it. If this keeps showing, update DD Mau from the App Store / Play Store.'
          + '<br/>Este dispositivo no pudo actualizarse. Cierra la aplicación por completo y vuelve a abrirla. Si sigue apareciendo, actualiza DD Mau desde la tienda.';
    el.innerHTML = `${spin}
        <div style="font-size:19px;font-weight:800">${headline}</div>
        <div style="font-size:13px;opacity:.85;max-width:420px;line-height:1.5">${detail}</div>
        <div style="font-size:11px;opacity:.6">v${String(localV || '?')} → v${String(minV || '?')}</div>
        ${mode === 'stuck' ? '<button id="ddmau-floor-retry" style="margin-top:8px;padding:12px 28px;border-radius:12px;border:0;background:#34d399;color:#0f2417;font-weight:800;font-size:15px">Try again / Reintentar</button>' : ''}`;
    if (mode === 'stuck') {
        const btn = document.getElementById('ddmau-floor-retry');
        if (btn && onRetry) btn.onclick = onRetry;
    }
}

function removeOverlay() {
    try { document.getElementById(OVERLAY_ID)?.remove(); } catch { /* noop */ }
}

/** Install once at app startup. Fail-open everywhere. */
export function installVersionFloor() {
    if (typeof window === 'undefined') return;
    const localV = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
    let stuckTimer = null;
    let currentMin = null;

    const attempt = async (minV) => {
        renderOverlay('updating', localV, minV);
        clearTimeout(stuckTimer);
        stuckTimer = setTimeout(() => renderOverlay('stuck', localV, minV, () => attempt(minV)), FLOOR_STUCK_MS);
        try {
            if (window.Capacitor?.isNativePlatform?.() === true) {
                const { applyNativeOtaWhenReady, setOtaApplyAllowed } = await import('../capacitor-bridge');
                // 2026-08-09 audit: OTA apply is normally deferred to the
                // login screen (setOtaApplyAllowed gate) so a broadcast
                // can't reload someone mid-task. Below the floor that gate
                // DEADLOCKS the auto path — our overlay blocks all input,
                // so the user can never reach the login screen. The overlay
                // makes an immediate apply safe (nothing is mid-task), so
                // open the gate before driving the update. App.jsx re-syncs
                // the gate on the next lock/unlock transition.
                try { setOtaApplyAllowed(true); } catch { /* older bridge — fall through */ }
                await applyNativeOtaWhenReady(null);   // applies + reloads the WebView when ready
                return;
            }
            // Web/PWA/TV: only reload if the site actually serves a NEWER
            // build than we run — a blind reload onto the same build loops.
            if (!shouldAttemptFloorReload()) return;    // guard: one reload / 10 min
            const base = (import.meta.env?.BASE_URL || '/');
            const resp = await fetch(base + 'version.json?t=' + Date.now(), { cache: 'no-store' });
            const served = resp.ok ? (await resp.json())?.v : null;
            if (served && served !== localV && !isBelowMinVersion(served, minV)) {
                const { forceRefresh } = await import('../components/hooks/usePullToRefresh');
                forceRefresh();
            }
            // served == local or still below min → the SITE isn't ahead;
            // stay on the overlay, the stuck screen explains next steps.
        } catch (e) {
            console.warn('[versionFloor] update attempt failed:', e?.message || e);
        }
    };

    try {
        onSnapshot(doc(db, 'config', 'minVersion'), (snap) => {
            const min = snap.exists() ? snap.data()?.min : null;
            currentMin = min;
            if (!min || !isBelowMinVersion(localV, min)) {
                clearTimeout(stuckTimer);
                removeOverlay();
                return;
            }
            console.warn(`[versionFloor] build ${localV} is below the fleet floor ${min} — forcing update`);
            attempt(min);
        }, (err) => {
            // Listener failure must never block anyone.
            console.warn('[versionFloor] listener error (gate idle):', err?.message || err);
            clearTimeout(stuckTimer);
            removeOverlay();
        });
    } catch (e) {
        console.warn('[versionFloor] install failed (gate idle):', e?.message || e);
    }
    void currentMin;
}
