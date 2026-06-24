// sentryClient.js — Sentry initialization + PII scrubbing for FE.
//
// Andrew 2026-05-26 — Sentry is the "watcher" that auto-captures every
// JS error, unhandled rejection, and slow page in the React app
// without us writing per-error code. It runs alongside our in-house
// /error_logs path (src/data/logger.js):
//
//   • In-house /error_logs — survives forever in Firestore, queryable
//     from the Health dashboard, plus our own redactor.
//   • Sentry — grouping, mobile push, source-map symbolication, the
//     forensic UI nobody has time to build.
//
// Both can fire on the same error; that's by design. Sentry's grouping
// dedupes its side; ours is per-event by Firestore doc id.
//
// ── DSN handling ─────────────────────────────────────────────────────
//
// The DSN lives in import.meta.env.VITE_SENTRY_DSN. Vite picks up every
// env var prefixed `VITE_*` at build time and inlines its value into
// the bundle. DSNs are NOT secrets (Sentry treats them as public
// project identifiers; abuse is controlled by per-project rate limits,
// not key secrecy) so it's fine to commit a `.env` or even hardcode.
//
// If the DSN is missing (dev, fresh clone, before signup), every
// Sentry call below becomes a no-op — `init` returns without binding
// any handlers and `captureException` is a noop the SDK ships with by
// default. So safe to leave installed in dev.
//
// ── PII scrubbing ────────────────────────────────────────────────────
//
// `beforeSend` runs on every event Sentry would send. We pipe each
// event through our existing redact.js so secrets/PII never reach
// Sentry's servers — defense in depth on top of our codebase
// conventions. See `scrubSentryEvent` below for what's scrubbed.

import { redactString, redactStack, redactObject } from './redact';

// @sentry/react is loaded LAZILY (dynamic import in loadSentry below) so the
// ~150KB SDK stays OUT of the eager entry chunk and never blocks first paint /
// the lock screen. initSentry() loads it at idle after first paint; every other
// export below no-ops until then — early errors are still captured by
// logger.js's global window.onerror/unhandledrejection handlers + the error
// boundaries' own Firestore writes.
let Sentry = null;
async function loadSentry() {
    if (Sentry) return Sentry;
    // 2026-06-20 (QA audit P1) — import the slim wrapper (named re-exports only)
    // so Rollup tree-shakes Session Replay / Feedback / Console out of the lazy
    // vendor-sentry chunk. The wrapper exposes exactly the 6 methods used below.
    try { Sentry = await import('./sentryReal'); } catch { Sentry = null; }
    return Sentry;
}

// Build constant — set in vite.config.js. Falls back to 'dev' when not
// available (test runners, the rare SSR path).
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

// DD Mau public Sentry DSN. Sentry treats DSNs as project identifiers,
// not credentials — they're meant to live in client-side JS bundles
// and abuse is controlled by per-project ingest rate limits, not key
// secrecy. Hardcoded as a fallback so the GitHub Actions build (which
// doesn't see local .env.local) still picks it up; local dev can
// override with VITE_SENTRY_DSN in .env.local.
//
// To rotate: replace this string AND the matching env var in
// .env.local + the SENTRY_DSN Firebase secret (functions side).
const FALLBACK_DSN = 'https://d821c1d28812f5b6325d657a6ce5e7bb@o4511459059433472.ingest.us.sentry.io/4511459084861440';

// Read DSN from env, with the hardcoded fallback above. Vite exposes
// import.meta.env at module-init time. In a Node-side script (tests,
// scripts/) import.meta.env may not be present; the typeof guard
// avoids a ReferenceError.
function getDsn() {
    try {
        if (typeof import.meta !== 'undefined' && import.meta.env) {
            return import.meta.env.VITE_SENTRY_DSN || FALLBACK_DSN || null;
        }
    } catch {}
    return FALLBACK_DSN || null;
}

// True iff Sentry is wired up. Lets call sites short-circuit when
// the SDK isn't actually doing anything.
export function isSentryEnabled() {
    return !!getDsn();
}

// ── PII / secret scrubber ────────────────────────────────────────────
//
// Sentry events are nested:
//   event.exception.values[].value       — error message string
//   event.exception.values[].stacktrace.frames[]   — stack frames
//   event.breadcrumbs[].message + .data  — what user did before crash
//   event.contexts.* / .extra / .tags    — arbitrary context
//   event.request.url + .headers          — page URL + headers
//   event.user.email                     — strip entirely
//
// We walk each of those and either redact strings or drop fields
// outright. The redactString path catches most secrets; the drop
// list (in redact.js) catches anything in object shape.
//
// IMPORTANT: this function must NEVER throw. If it throws, Sentry
// will drop the event silently. We wrap each step in try/catch.
export function scrubSentryEvent(event) {
    if (!event) return event;
    try {
        // Exception values + nested stack frames.
        if (Array.isArray(event.exception?.values)) {
            for (const ev of event.exception.values) {
                if (typeof ev.value === 'string') {
                    ev.value = redactString(ev.value).slice(0, 4000);
                }
                if (Array.isArray(ev.stacktrace?.frames)) {
                    for (const f of ev.stacktrace.frames) {
                        // Strip absolute-home dirs from file paths.
                        if (typeof f.filename === 'string') f.filename = redactString(f.filename);
                        if (typeof f.abs_path === 'string') f.abs_path = redactString(f.abs_path);
                        // Drop the pre/post context lines — they sometimes
                        // include inline string literals with PII.
                        f.pre_context = undefined;
                        f.post_context = undefined;
                        f.context_line = undefined;
                    }
                }
            }
        }

        // Breadcrumbs — both Sentry's auto-captured + ours pushed manually.
        if (Array.isArray(event.breadcrumbs)) {
            for (const b of event.breadcrumbs) {
                if (typeof b.message === 'string') b.message = redactString(b.message).slice(0, 500);
                if (b.data && typeof b.data === 'object') b.data = redactObject(b.data);
                // Drop the breadcrumb URL details that may carry tokens.
                if (b.data && typeof b.data.url === 'string') b.data.url = redactString(b.data.url);
            }
        }

        // Request — url + query string + headers.
        if (event.request) {
            if (typeof event.request.url === 'string') event.request.url = redactString(event.request.url);
            // Strip all request headers. Sentry sometimes captures auth tokens
            // here on fetch errors.
            event.request.headers = undefined;
            event.request.cookies = undefined;
        }

        // User — keep id/username/location, never email.
        if (event.user) {
            event.user.email = undefined;
            event.user.ip_address = undefined;  // Sentry will redact this server-side too, belt-and-suspenders
        }

        // Tags + extra + contexts.
        if (event.tags && typeof event.tags === 'object') event.tags = redactObject(event.tags);
        if (event.extra && typeof event.extra === 'object') event.extra = redactObject(event.extra);
        if (event.contexts && typeof event.contexts === 'object') event.contexts = redactObject(event.contexts);
    } catch (e) {
        // If scrubbing itself fails, fall back to a minimal event with
        // a flag so we can debug. Never drop the event silently from a
        // scrub failure — we'd lose the underlying error.
        if (typeof console !== 'undefined') {
            // eslint-disable-next-line no-console
            console.warn('[sentry] scrubSentryEvent failed:', e);
        }
        return {
            ...event,
            tags: { ...(event.tags || {}), scrub_failed: true },
        };
    }
    return event;
}

// ── init ─────────────────────────────────────────────────────────────
//
// Call ONCE from main.jsx before React renders. Idempotent — repeated
// calls are no-ops (Sentry's SDK guards internally).
//
// Settings rationale:
//   • tracesSampleRate: 0.05 — capture 5% of transactions for the
//     performance view. Free tier gives 10k perf events/mo; 5% across
//     ~40 staff × a handful of route changes each = well under.
//   • replaysSessionSampleRate / OnErrorSampleRate: 0 — session replay
//     captures the DOM, which on the email / onboarding tabs could
//     leak PII. We turn it off permanently.
//   • sendDefaultPii: false — Sentry's default is to forward user IPs
//     and some browser data we don't need.
export async function initSentry() {
    const dsn = getDsn();
    if (!dsn) {
        // Quiet no-op in dev or when DSN hasn't been set yet.
        if (typeof console !== 'undefined') {
            // eslint-disable-next-line no-console
            console.info('[sentry] no DSN configured — skipping init');
        }
        return;
    }

    let environment = 'prod';
    try {
        if (import.meta.env?.DEV) environment = 'dev';
        else if (import.meta.env?.MODE) environment = import.meta.env.MODE;
    } catch {}

    // Load the SDK now — its own lazy chunk. We're past first paint by the time
    // initSentry() runs (scheduled at idle from main.jsx).
    await loadSentry();
    if (!Sentry) return;

    Sentry.init({
        dsn,
        release: APP_VERSION,
        environment,
        // Errors get full capture; perf gets 5% sample.
        tracesSampleRate: 0.05,
        // Session replay disabled for privacy on email + onboarding tabs.
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
        // Don't auto-send IPs/cookies.
        sendDefaultPii: false,
        // Cap how many breadcrumbs Sentry's own engine keeps — our
        // logger.js ring is the canonical source, this just supplements.
        maxBreadcrumbs: 50,
        // 2026-05-27 — drop chunk-load errors at the Sentry SDK level.
        // Same patterns logger.js + PageErrorBoundary use to skip
        // /error_logs writes for stale-bundle reloads. Without this,
        // every Kitchen Manager iPad opening Operations / Schedule /
        // ChatThread after a deploy generated a TypeError 'Importing
        // a module script failed.' Sentry event — pure noise, the
        // page auto-reloads itself. ignoreErrors matches against the
        // event's message via substring; case-insensitive when given
        // a RegExp. Cross-origin 'Script error.' is also noise — the
        // browser already censored the details, nothing actionable.
        ignoreErrors: [
            /Loading chunk \d+ failed/i,
            /Failed to fetch dynamically imported module/i,
            /Importing a module script failed/i,
            /dynamically imported module/i,
            /Failed to load module/i,
            /ChunkLoadError/i,
            // Cross-origin script errors with no detail (Sentry FAQ
            // calls these out as the most common noise source on
            // third-party-script-heavy pages).
            'Script error.',
            'Non-Error promise rejection captured',
            // Browser-level IndexedDB failure surfaced through Firestore's
            // offline persistence layer (persistentLocalCache, firebase.js).
            // Safari throws this routinely; also fires on storage eviction,
            // low disk, private mode, or two tabs contending for the DB. It
            // arrives handled, via unhandledrejection — not a crash. Firestore
            // retries and falls back to the memory cache on its own, so no
            // write is lost. Nothing actionable in app code; pure noise.
            /An internal error was encountered in the Indexed Database server/i,
        ],
        // Run every event through our redactor before send.
        beforeSend: scrubSentryEvent,
        beforeBreadcrumb(breadcrumb) {
            // Drop console.debug + console.log breadcrumbs — too noisy
            // and they sometimes embed dev-only data.
            if (breadcrumb.category === 'console'
                && (breadcrumb.level === 'debug' || breadcrumb.level === 'log')) {
                return null;
            }
            return breadcrumb;
        },
        integrations: [
            // browserTracingIntegration auto-instruments fetch + route
            // changes for the performance view. Cheap because tracesSampleRate
            // is 5%, and gives us "this fetch is slow" data we can't easily
            // collect ourselves.
            Sentry.browserTracingIntegration(),
        ],
    });

    if (typeof console !== 'undefined') {
        // eslint-disable-next-line no-console
        console.info(`[sentry] initialized · release=${APP_VERSION} · env=${environment}`);
    }
}

// ── identity tagging ─────────────────────────────────────────────────
//
// Called by App.jsx whenever the signed-in staff identity changes (PIN
// unlock, logout, admin rename). Sentry's `setUser` attaches the value
// to every subsequent event; calling with null clears it on logout.
//
// We pass id + username (staff name) but NEVER email. The redactor
// would scrub email if it appeared, but better to not set it at all.
export function setSentryIdentity({ staffId, staffName, role, location } = {}) {
    if (!isSentryEnabled() || !Sentry) return;
    try {
        if (!staffId && !staffName) {
            Sentry.setUser(null);
            Sentry.setTag('role', undefined);
            Sentry.setTag('location', undefined);
            return;
        }
        Sentry.setUser({
            id: staffId != null ? String(staffId) : undefined,
            username: staffName || undefined,
        });
        Sentry.setTag('role', role || 'anonymous');
        Sentry.setTag('location', location || 'unknown');
    } catch {
        // Identity tagging must never crash callers.
    }
}

// ── manual capture (for code that wants to report explicitly) ────────
//
// Most code shouldn't need to call this — the global handlers + error
// boundaries cover the common cases. Reserved for places that catch
// an error and DON'T want it to propagate (e.g. a background sync
// that handles its own failure but still wants Sentry to know).
export function captureException(err, opts) {
    if (!isSentryEnabled() || !Sentry) return null;
    try {
        return Sentry.captureException(err, opts);
    } catch {
        return null;
    }
}

// Convenience: send a Sentry-side breadcrumb that will appear in the
// "BREADCRUMBS" panel when an error fires. Mirrors our logger's
// breadcrumb() so call sites only have to remember one. Pass-through
// to Sentry; no-op if disabled.
export function sentryBreadcrumb({ type, category, message, data, level } = {}) {
    if (!isSentryEnabled() || !Sentry) return;
    try {
        Sentry.addBreadcrumb({
            type: type || 'default',
            category: category || 'app',
            message: message ? redactString(String(message)).slice(0, 500) : undefined,
            data: data ? redactObject(data) : undefined,
            level: level || 'info',
        });
    } catch {}
}
