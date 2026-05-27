// logger.js — frontend error + security + breadcrumb logging.
//
// Andrew 2026-05-26 — central spot for "the app blew up, write
// something useful to Firestore so we can fix it later." Three public
// surfaces:
//
//   • logError({ error, severity, feature, meta }) — write a row to
//     /error_logs. Used by the React error boundaries, the global
//     window.onerror / unhandledrejection handlers, and ad-hoc catch
//     blocks throughout the app.
//
//   • logSecurityEvent({ kind, path, op, reason }) — write a row to
//     /security_logs. Used by permission-denied catches, login retry
//     limits, ownerOnly view checks, etc. Kept separate from
//     error_logs because security events have a different retention
//     posture (kept 1 year) and a different audience (owners only).
//
//   • breadcrumb(type, target, extra?) / getBreadcrumbs() — small
//     in-memory ring buffer of the last N user actions (clicks, route
//     changes, important state changes). When something throws, we
//     attach the ring to the error doc so Claude can see "what was
//     the user doing 10 seconds before this crashed?". Buffer is
//     deliberately ephemeral — survives no longer than the page.
//
// Identity model: the app uses anonymous Firestore + name-based
// identity (see CLAUDE.md). Callers populate three window globals
// from App.jsx after PIN unlock:
//
//   window.__ddmau_staffId
//   window.__ddmau_role
//   window.__ddmau_location
//
// Those globals are READ here. Setting them is App.jsx's job (see
// the setIdentityGlobals() call in there). Without those globals
// the log row gets userId: null / userRole: 'anonymous' — still
// useful, just less filterable.
//
// Everything written here passes through redactObject/redactString
// from src/data/redact.js so secrets/PII never reach Firestore.
//
// Best-effort: a failed log write NEVER throws to the caller. The
// underlying error/action takes precedence. We swallow + console.warn.

import { db } from '../firebase';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { redactObject, redactString, redactStack, redactUrl } from './redact';
import { setSentryIdentity, captureException as sentryCapture } from './sentryClient';

// App version is set at build time via __APP_VERSION__ in vite.config.js.
// In dev / Vitest the define is missing — fall back to a sentinel
// so we don't reference an undefined global at module init.
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

// ── breadcrumbs ──────────────────────────────────────────────────────
//
// Ring buffer of the last BC_MAX entries. Stays in memory only — we
// never persist breadcrumbs separately, only as the recentActions
// field on an error or bug report.
//
// Each entry is { t, type, target, extra? } where:
//   t      — Date.now() at capture
//   type   — short string: 'click', 'route', 'submit', 'firestore'…
//   target — what was acted on. Should be a stable name, NOT data.
//            Good: 'InventoryRow.save'. Bad: 'item-abc123-qty-5'.
//   extra  — optional small object, passed through redactObject so
//            secrets can't slip in via breadcrumb metadata.
//
// Why bounded: a long session that never crashes still racks up
// breadcrumbs. Capping at BC_MAX caps memory + caps the eventual
// log row size when a crash does happen.
const BC_MAX = 25;
const breadcrumbs = [];

export function breadcrumb(type, target, extra) {
    try {
        const entry = {
            t: Date.now(),
            type: String(type || 'unknown').slice(0, 40),
            target: String(target || '').slice(0, 120),
        };
        if (extra != null) entry.extra = redactObject(extra);
        breadcrumbs.push(entry);
        if (breadcrumbs.length > BC_MAX) breadcrumbs.shift();
    } catch {
        // breadcrumb failures must never crash the caller.
    }
}

export function getBreadcrumbs() {
    return breadcrumbs.slice();
}

export function clearBreadcrumbs() {
    breadcrumbs.length = 0;
}

// ── identity getters ────────────────────────────────────────────────
//
// Read from window globals populated by App.jsx after PIN unlock.
// SSR-safe — return defaults if `window` isn't defined.
function getIdentity() {
    if (typeof window === 'undefined') {
        return { userId: null, userRole: 'anonymous', userName: null, location: null };
    }
    return {
        userId:   window.__ddmau_staffId ?? null,
        userRole: window.__ddmau_role    ?? 'anonymous',
        userName: window.__ddmau_staffName ?? null,
        location: window.__ddmau_location ?? null,
    };
}

// Stable per-tab session id. Used to correlate a sequence of log rows
// from the same loaded-app session. Initialised lazily on first read.
function getSessionId() {
    if (typeof window === 'undefined') return null;
    if (!window.__ddmau_sessionId) {
        const rand = Math.random().toString(36).slice(2, 8);
        window.__ddmau_sessionId = `sess_${Date.now().toString(36)}_${rand}`;
    }
    return window.__ddmau_sessionId;
}

// Common context attached to every log row. Kept small so the
// Firestore doc stays well under 1MB even with a fat stack trace.
function buildCommonContext() {
    const ident = getIdentity();
    const ctx = {
        ts: serverTimestamp(),
        occurredAt: Date.now(),
        env: typeof import.meta !== 'undefined' && import.meta.env
            ? (import.meta.env.PROD ? 'prod' : 'dev')
            : 'unknown',
        appVersion: APP_VERSION,
        sessionId: getSessionId(),
        userId: ident.userId,
        userName: ident.userName,
        userRole: ident.userRole,
        location: ident.location,
    };
    if (typeof window !== 'undefined') {
        ctx.pageUrl = redactUrl(window.location.pathname + window.location.search);
        ctx.device = {
            ua: (navigator.userAgent || '').slice(0, 200),
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            online: navigator.onLine !== false,
            lang: (navigator.language || '').slice(0, 16),
        };
    }
    return ctx;
}

// ── public: logError ────────────────────────────────────────────────
//
// `error` may be an Error, a string, or any thrown value. `severity`
// defaults to 'error' (use 'critical' for things that page the
// owners, 'warn' for non-blocking issues, 'info' for noteworthy
// non-errors). `feature` is a short tag — 'inventory', 'schedule',
// '86', 'inbox', etc. — used to filter the Health dashboard.
// `meta` is any extra context (will be redacted on write).
//
// Returns the doc id of the written row (or null if the write
// failed). Never throws.
// Chunk-load error pattern — matches the wording every modern browser
// uses when a dynamic import() fails (404 on a chunk hash that no
// longer exists after a deploy). These are ALWAYS stale-cache, never
// actionable bugs, and the global handler in App.jsx auto-reloads
// the app to recover. logError() silently drops these so they never
// pollute /error_logs or Sentry, regardless of who's calling.
const CHUNK_ERR_PATTERN_LOG = /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|dynamically imported module|Failed to load module/i;

export async function logError({ error, severity = 'error', feature, meta } = {}) {
    const errObj = error instanceof Error ? error : new Error(String(error ?? 'unknown error'));

    // Defense in depth: filter chunk errors here too. The route-level
    // PageErrorBoundary already filters them, and the global window
    // error/rejection handlers in installGlobalHandlers() filter them,
    // but a future ad-hoc try/catch calling logError() shouldn't be
    // able to slip one through. 2026-05-27 — Kitchen Manager iPad
    // chunk-load error generated a critical-severity row this way.
    if (CHUNK_ERR_PATTERN_LOG.test(errObj.message || '') || errObj.name === 'ChunkLoadError') {
        if (typeof console !== 'undefined') {
            // eslint-disable-next-line no-console
            console.info('[logger] dropping chunk-load error (stale cache, not a bug):', errObj.message);
        }
        return null;
    }

    // Fire to Sentry FIRST (synchronously, so it queues before any
    // Firestore round-trip). It's a no-op when Sentry isn't wired
    // up. Wrapped in try/catch so a Sentry init issue can never
    // suppress the Firestore write below.
    try {
        sentryCapture(errObj, {
            level: severity === 'critical' ? 'fatal'
                : severity === 'error'    ? 'error'
                : severity === 'warn'     ? 'warning'
                :                            'info',
            tags: {
                feature: feature || 'unknown',
                severity,
            },
            extra: meta != null ? { meta: redactObject(meta) } : undefined,
        });
    } catch {}

    try {
        const ctx = buildCommonContext();
        const row = {
            ...ctx,
            severity,
            source: 'frontend',
            feature: feature ? String(feature).slice(0, 60) : 'unknown',
            errorName: (errObj.name || 'Error').slice(0, 80),
            errorMessage: redactString(String(errObj.message || '')).slice(0, 2000),
            errorCode: errObj.code ? String(errObj.code).slice(0, 80) : null,
            stack: redactStack(errObj.stack || ''),
            meta: meta != null ? redactObject(meta) : null,
            recentActions: getBreadcrumbs(),
            resolved: false,
        };
        const ref = await addDoc(collection(db, 'error_logs'), row);
        return ref.id;
    } catch (e) {
        // Never recurse — just warn. If logging is broken (rules
        // misconfigured, offline, etc.) the original error is still
        // surfaced to the user via the error boundary AND has already
        // gone to Sentry above.
        if (typeof console !== 'undefined') {
            // eslint-disable-next-line no-console
            console.warn('[logger] logError write failed:', e);
        }
        return null;
    }
}

// ── public: logSecurityEvent ────────────────────────────────────────
//
// For permission-denied catches, login retry exhaustion, ownerOnly
// view attempts by non-owners, etc. Separate collection so its
// retention (1 year) and ACL (owners only) can be tightened
// independently.
export async function logSecurityEvent({ kind, path, op, reason, meta } = {}) {
    try {
        const ctx = buildCommonContext();
        const row = {
            ...ctx,
            kind: String(kind || 'unknown').slice(0, 60),
            path: path ? redactString(String(path)).slice(0, 200) : null,
            op: op ? String(op).slice(0, 40) : null,
            reason: reason ? redactString(String(reason)).slice(0, 500) : null,
            meta: meta != null ? redactObject(meta) : null,
        };
        const ref = await addDoc(collection(db, 'security_logs'), row);
        return ref.id;
    } catch (e) {
        if (typeof console !== 'undefined') {
            // eslint-disable-next-line no-console
            console.warn('[logger] logSecurityEvent write failed:', e);
        }
        return null;
    }
}

// ── public: setIdentity ─────────────────────────────────────────────
//
// Called by App.jsx after PIN unlock so subsequent log rows carry
// staff identity. Tear-down (e.g. on logout) should pass empty
// values. Idempotent.
//
// Also mirrors the identity into Sentry (see src/data/sentryClient.js)
// so every Sentry event auto-tags the staff name + role + location.
// Sentry's setUser is the canonical way to filter "show me errors
// only on the Webster manager iPads."
export function setIdentity({ staffId, staffName, role, location } = {}) {
    if (typeof window === 'undefined') return;
    window.__ddmau_staffId   = staffId   ?? null;
    window.__ddmau_staffName = staffName ?? null;
    window.__ddmau_role      = role      ?? 'anonymous';
    window.__ddmau_location  = location  ?? null;
    // Mirror to Sentry. setSentryIdentity is a no-op when Sentry isn't
    // wired up (DSN missing), so this is safe in every environment.
    try { setSentryIdentity({ staffId, staffName, role, location }); } catch {}
}

// ── public: installGlobalHandlers ───────────────────────────────────
//
// Wires window.onerror + unhandledrejection to logError. Should be
// called ONCE from App.jsx (guarded with the __ddmau_loggerInstalled
// flag so HMR / double-mount doesn't double-bind).
//
// Note: the existing chunk-error auto-reload listener already lives
// in App.jsx at module top. We don't replace it — we add to it. Both
// can fire; one logs, the other reloads.
export function installGlobalHandlers() {
    if (typeof window === 'undefined') return;
    if (window.__ddmau_loggerInstalled) return;
    window.__ddmau_loggerInstalled = true;

    // Initialise the session id eagerly so all subsequent log rows
    // share the same correlation key (rather than the first error's
    // log row being the one that mints the id).
    getSessionId();

    window.addEventListener('error', (e) => {
        // Skip chunk errors — App.jsx auto-reloads and we don't want
        // to spam /error_logs with stale-bundle noise. They re-fire
        // as logged errors only on the second attempt (via the
        // sessionStorage RELOAD_FLAG_KEY guard upstream).
        const msg = e?.message || '';
        const name = e?.error?.name || '';
        if (/Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(msg)
            || name === 'ChunkLoadError') return;
        logError({
            error: e.error instanceof Error ? e.error : new Error(msg),
            severity: 'error',
            feature: 'global',
        });
    });

    window.addEventListener('unhandledrejection', (e) => {
        const reason = e?.reason;
        const msg = reason instanceof Error ? reason.message : String(reason || '');
        const name = reason instanceof Error ? reason.name : '';
        if (/Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(msg)
            || name === 'ChunkLoadError') return;
        logError({
            error: reason instanceof Error ? reason : new Error(msg),
            severity: 'error',
            feature: 'unhandled-rejection',
        });
    });

    // Auto-breadcrumb route changes via pushState/popstate so we don't
    // have to wire a manual call at every navigation site.
    try {
        const origPush = history.pushState;
        history.pushState = function (...args) {
            try { breadcrumb('route', redactUrl(args[2] || window.location.pathname)); } catch {}
            return origPush.apply(this, args);
        };
        window.addEventListener('popstate', () => {
            try { breadcrumb('route', redactUrl(window.location.pathname + window.location.search)); } catch {}
        });
    } catch {
        // Some browsers freeze history.pushState — fall back silently.
    }
}
