// Slim, statically-named re-export of ONLY the Sentry methods this app uses.
//
// 2026-06-20 (QA audit P1) — sentryClient.js used to `await import('@sentry/react')`
// (a barrel import), which pulled the entire integration surface into the lazy
// vendor-sentry chunk — including rrweb-based Session Replay, Feedback, and
// Console capture, none of which we use (replay sample rates are hard-coded to 0).
// That bloated the chunk to ~153 KB gzip. By re-exporting only the named methods
// we call, Rollup can tree-shake Replay/Feedback/Console out.
//
// This module is itself DYNAMICALLY imported by sentryClient.js, so Sentry still
// stays off the first-paint critical path (loaded at idle after the lock screen).
export {
    init,
    browserTracingIntegration,
    captureException,
    setUser,
    setTag,
    addBreadcrumb,
} from '@sentry/react';
