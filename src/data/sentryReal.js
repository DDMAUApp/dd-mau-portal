// Slim wrapper exposing ONLY the Sentry methods this app uses.
//
// 2026-06-20 (QA audit P1) — sentryClient.js used to `await import('@sentry/react')`
// (a barrel import), which pulled the entire integration surface into the lazy
// vendor-sentry chunk — including rrweb-based Session Replay, Feedback, and
// Console capture, none of which we use (replay sample rates are hard-coded to 0).
// That bloated the chunk to ~153 KB gzip. Importing only the named methods we
// call lets Rollup tree-shake Replay/Feedback/Console out.
//
// This module is itself DYNAMICALLY imported by sentryClient.js, so Sentry still
// stays off the first-paint critical path (loaded at idle after the lock screen).
import {
    init,
    browserTracingIntegration,
    captureException,
    setUser,
    setTag,
    addBreadcrumb,
} from '@sentry/react';

// 2026-07-09 — this MUST stay a real const object, NOT `export { ... } from
// '@sentry/react'` re-exports. A pure re-export module has zero statements of
// its own, so Rollup dissolves it during chunking; the dynamic import in
// sentryClient then has no chunk to point at, and Rollup inlines the module
// namespace into the ENTRY chunk — built from STATIC imports of vendor-sentry.
// Net effect: the whole ~50 KB gzip SDK loaded eagerly on every cold open and
// the lazy design was silently defeated. The object literal below is a real
// statement Rollup must keep in this module, which keeps this module (and the
// dynamic import edge) alive. manualChunks pins it into vendor-sentry so the
// SDK is one lazy fetch.
const Sentry = {
    init,
    browserTracingIntegration,
    captureException,
    setUser,
    setTag,
    addBreadcrumb,
};

export default Sentry;
