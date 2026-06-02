// functions/sentry.js — Sentry initialization for the Cloud Functions runtime.
//
// Andrew 2026-05-26. Two-layer setup:
//
//   1. initSentry() — called ONCE at the top of functions/index.js
//      before any function handler is registered. Reads DSN from the
//      SENTRY_DSN secret (via defineSecret). No-op if unset.
//
//   2. captureWithContext(err, opts) — wrapper around Sentry.captureException
//      that auto-includes the function name + tags. Per-function catch
//      blocks call this; the call is no-op if Sentry isn't init'd.
//
// Why not a full per-function wrap: Firebase Functions v2 handlers
// don't have a single chokepoint we can monkey-patch (each trigger
// type uses a different runtime). Hand-instrumenting the critical
// paths (pollGmail, dispatch*, etc.) is the realistic minimum.
//
// The catch-all is the `unhandledRejection` listener inside initSentry —
// any unawaited promise rejection that escapes a handler gets reported
// to Sentry automatically.

const Sentry = require("@sentry/node");

let initialized = false;

// 2026-06-02 audit fix: beforeSend scrubber for backend events.
//
// The backend functions read PII through several paths (gmail subjects,
// Twilio phone numbers, FCM tokens on staff records, occasional W-4
// SSNs in error messages from PDF parsing) and any of those values
// could ride along with a Sentry capture in event.contexts, event.extra,
// or the error message itself. Strip them at the wire before the event
// leaves the Cloud Function.
//
// Rules:
//   1. Strip phone / phoneE164 / token / fcmToken fields under
//      event.contexts.app.context.
//   2. Redact gmail subject lines — event.extra.subject (and the
//      common "subject" key under event.contexts.app.context) → '<redacted>'.
//   3. Redact SSN-shaped strings (\d{3}-?\d{2}-?\d{4}) anywhere in
//      event.message, event.exception messages, and any value under
//      event.extra. The fix is intentionally regex-only so a stray
//      "111-22-3333" embedded in a free-text error survives the scrub.
const SSN_RE = /\d{3}-?\d{2}-?\d{4}/g;
const SSN_REDACTED = "XXX-XX-XXXX";
const PII_KEYS_REMOVE = new Set(["phone", "phoneE164", "token", "fcmToken"]);

function redactSsnString(s) {
    if (typeof s !== "string") return s;
    return s.replace(SSN_RE, SSN_REDACTED);
}

function scrubObjectForPii(obj) {
    if (!obj || typeof obj !== "object") return obj;
    for (const k of Object.keys(obj)) {
        if (PII_KEYS_REMOVE.has(k)) {
            delete obj[k];
            continue;
        }
        const v = obj[k];
        if (typeof v === "string") {
            obj[k] = redactSsnString(v);
        } else if (v && typeof v === "object") {
            scrubObjectForPii(v);
        }
    }
    return obj;
}

function sentryBeforeSend(event) {
    try {
        // 1. Strip PII fields from contexts.app.context. Sentry's Node
        //    SDK funnels arbitrary tags here when callers pass extra
        //    metadata — phone numbers and FCM tokens are exactly the
        //    kind of value that lands here uninspected.
        const ctxApp = event.contexts && event.contexts.app;
        if (ctxApp && ctxApp.context && typeof ctxApp.context === "object") {
            for (const k of Object.keys(ctxApp.context)) {
                if (PII_KEYS_REMOVE.has(k)) {
                    delete ctxApp.context[k];
                }
            }
            // 2. Redact subject line if present here.
            if (typeof ctxApp.context.subject === "string") {
                ctxApp.context.subject = "<redacted>";
            }
        }

        // 2. Redact gmail subject in event.extra. pollGmail's captures
        //    sometimes attach the email subject directly.
        if (event.extra && typeof event.extra === "object") {
            if (typeof event.extra.subject === "string") {
                event.extra.subject = "<redacted>";
            }
            // 3. SSN redaction across every string in extra.
            scrubObjectForPii(event.extra);
        }

        // 3. SSN redaction in the top-level error message + any
        //    exception messages.
        if (typeof event.message === "string") {
            event.message = redactSsnString(event.message);
        }
        if (event.exception && Array.isArray(event.exception.values)) {
            for (const exc of event.exception.values) {
                if (exc && typeof exc.value === "string") {
                    exc.value = redactSsnString(exc.value);
                }
            }
        }
    } catch {
        // Belt-and-suspenders: if scrubbing somehow throws, prefer
        // shipping a slightly-PII-leaky event over dropping it
        // entirely. Sentry's PII rules + DSN-level filters give us
        // a second layer of defense.
    }
    return event;
}

// Set up Sentry. Returns true if init succeeded, false if no DSN
// configured (which is the no-op state — every captureException
// below becomes a noop).
function initSentry({ dsn, release, environment } = {}) {
    if (initialized) return true;
    if (!dsn) {
        // Quiet no-op so dev / fresh deploys without the secret don't
        // throw at module load.
        if (typeof console !== "undefined") {
            console.info("[sentry] no DSN — backend Sentry disabled.");
        }
        return false;
    }
    try {
        Sentry.init({
            dsn,
            release: release || "unknown",
            environment: environment || "prod",
            // Backend runs are short-lived (Cloud Functions terminate
            // after each invocation), so we don't bother with
            // performance/tracing. Errors only.
            tracesSampleRate: 0,
            // Cap how many breadcrumbs Sentry's own auto-instrumentation
            // keeps — Node's console + http patches can be chatty.
            maxBreadcrumbs: 50,
            // Don't try to bind to the process's exit signal — Cloud
            // Functions handles termination its own way and the
            // bound handlers cause warnings.
            shutdownTimeout: 2_000,
            // 2026-06-02 audit fix: PII scrubber. Strips phone /
            // phoneE164 / token / fcmToken fields, redacts gmail
            // subject lines, and replaces SSN-shaped strings with
            // XXX-XX-XXXX. Defined above the init call.
            beforeSend: sentryBeforeSend,
        });
        // Belt-and-suspenders unhandled-rejection catcher. The Cloud
        // Functions runtime catches uncaught throws/rejections at the
        // handler boundary, but anything that fires AFTER the handler
        // returns (e.g. a forgotten `.then(...)` without await) becomes
        // an unhandled rejection that the runtime logs as a warning.
        // This routes those to Sentry too.
        process.on("unhandledRejection", (reason) => {
            try {
                const err = reason instanceof Error ? reason : new Error(String(reason));
                Sentry.captureException(err, {
                    tags: { source: "unhandledRejection" },
                });
            } catch {}
        });
        initialized = true;
        if (typeof console !== "undefined") {
            console.info(`[sentry] initialized · release=${release || "unknown"} · env=${environment || "prod"}`);
        }
        return true;
    } catch (e) {
        if (typeof console !== "undefined") {
            console.warn("[sentry] init failed:", e?.message || e);
        }
        return false;
    }
}

// Capture an exception with function-name + extra tags merged in.
// Always safe to call — no-op when Sentry isn't init'd.
//
// Usage:
//   try {
//     await doThing();
//   } catch (e) {
//     captureWithContext(e, { fn: "pollGmail", extra: { gmailId: id } });
//     throw e; // (or swallow, depending on caller)
//   }
function captureWithContext(err, opts = {}) {
    if (!initialized) return null;
    try {
        return Sentry.captureException(err, {
            level: opts.level || "error",
            tags: {
                fn: opts.fn || "unknown",
                ...(opts.tags || {}),
            },
            extra: opts.extra || undefined,
        });
    } catch {
        return null;
    }
}

// Manual breadcrumb — same idea as the frontend's sentryBreadcrumb.
function sentryBreadcrumb({ message, category, data, level } = {}) {
    if (!initialized) return;
    try {
        Sentry.addBreadcrumb({
            message: message ? String(message).slice(0, 500) : undefined,
            category: category || "app",
            data: data || undefined,
            level: level || "info",
        });
    } catch {}
}

// Convenience: wrap an async function so any throw inside becomes a
// Sentry capture + re-throw. Useful for migrating handlers one-by-one
// to Sentry without rewriting their try/catch logic.
//
// Usage:
//   exports.myFn = onSchedule(..., withSentry("myFn", async (event) => {
//     // ... body ...
//   }));
function withSentry(fnName, handler) {
    return async (...args) => {
        try {
            return await handler(...args);
        } catch (err) {
            captureWithContext(err, { fn: fnName });
            throw err;
        }
    };
}

module.exports = {
    initSentry,
    captureWithContext,
    sentryBreadcrumb,
    withSentry,
};
