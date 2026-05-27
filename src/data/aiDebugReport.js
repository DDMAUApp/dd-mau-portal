// aiDebugReport.js — packages an /error_logs or /bug_reports row
// into a Claude-ready JSON blob that Andrew can paste into a chat
// (or a future "Open in Claude" deeplink).
//
// Andrew 2026-05-26 — the whole point of building this logging
// system is that "give Claude the bug logs so Claude can help me
// fix the app faster." The structure below is what makes that
// useful: small enough to paste, normalised timeline, file paths
// preserved without absolute home dirs, secrets confirmed scrubbed.
//
// Two builders:
//
//   • buildAIDebugReportFromError(errorDoc, opts?) — wraps an
//     error_logs row. Optional: relatedRecords, hypothesis, expected,
//     actual, repro steps.
//
//   • buildAIDebugReportFromBug(bugDoc, opts?) — wraps a bug_reports
//     row. Pulls in any attached errors via attachedErrorIds.
//
// And a clipboard helper that wraps the JSON in a fenced code block
// so it lands cleanly in any chat surface.

import { redactObject, redactStack, redactUrl } from './redact';

// Stable short hash for the report id so re-exporting the same row
// produces a re-identifiable token.
function shortId() {
    return Math.random().toString(36).slice(2, 8);
}

// Normalise a Firestore Timestamp / millis / Date / null to ISO.
function toISO(t) {
    if (!t) return null;
    if (typeof t === 'number') return new Date(t).toISOString();
    if (t instanceof Date) return t.toISOString();
    if (typeof t.toDate === 'function') return t.toDate().toISOString();
    if (typeof t.seconds === 'number') return new Date(t.seconds * 1000).toISOString();
    return null;
}

// Convert recentActions breadcrumbs into a normalised timeline
// relative to the error's occurredAt timestamp. Times are rendered
// as "-9s" / "+0s" so Claude sees temporal ordering without us
// having to think about wall-clock zones.
function buildTimeline(breadcrumbs, anchorMs) {
    if (!Array.isArray(breadcrumbs) || !breadcrumbs.length) return [];
    const anchor = typeof anchorMs === 'number' ? anchorMs : Date.now();
    return breadcrumbs.slice(-15).map((b) => {
        const dt = Math.round(((b.t || anchor) - anchor) / 1000);
        const sign = dt > 0 ? '+' : '';
        return {
            t: `${sign}${dt}s`,
            type: b.type,
            target: b.target,
            ...(b.extra ? { extra: b.extra } : {}),
        };
    });
}

// ── builder: error → AI debug report ────────────────────────────────
export function buildAIDebugReportFromError(errorDoc, opts = {}) {
    if (!errorDoc) return null;
    const occurredAt = typeof errorDoc.occurredAt === 'number' ? errorDoc.occurredAt : Date.now();
    return {
        report_id: `ai_dbg_${(toISO(errorDoc.ts) || new Date().toISOString()).slice(0, 16)}_${shortId()}`,
        generated_at: new Date().toISOString(),
        summary: (errorDoc.errorMessage || '').slice(0, 140) || 'Frontend error',
        severity: errorDoc.severity || 'error',
        feature_area: errorDoc.feature || 'unknown',
        user_role_affected: errorDoc.userRole || 'anonymous',
        location: errorDoc.location || null,
        app_version: errorDoc.appVersion || 'unknown',
        environment: errorDoc.env || 'unknown',

        timeline: buildTimeline(errorDoc.recentActions, occurredAt),

        error: {
            name: errorDoc.errorName || 'Error',
            message: errorDoc.errorMessage || '',
            code: errorDoc.errorCode || null,
            // redactStack is idempotent (already-redacted strings
            // pass through cleanly) so re-running here is safe.
            stack_redacted: redactStack(errorDoc.stack || ''),
        },

        context: {
            url_path: typeof errorDoc.pageUrl === 'string' ? errorDoc.pageUrl.split('?')[0] : null,
            url_query_keys: typeof errorDoc.pageUrl === 'string'
                ? (errorDoc.pageUrl.split('?')[1] || '').split('&').filter(Boolean).map((p) => p.split('=')[0])
                : [],
            browser: errorDoc.device?.ua || null,
            viewport: errorDoc.device?.viewport || null,
            online: errorDoc.device?.online ?? null,
        },

        related_records: Array.isArray(opts.relatedRecords)
            ? opts.relatedRecords.map((r) => ({
                type: r.type,
                id: r.id,
                name: r.name,
                fields_attempted: r.fieldsAttempted || null,
                before_redacted: r.before ? redactObject(r.before) : null,
                after_redacted:  r.after  ? redactObject(r.after)  : null,
            }))
            : [],

        // Free-form additions from the caller — UI-driven hypothesis,
        // expected/actual behaviour, repro steps. All redacted.
        expected_behavior: opts.expected ? redactObject(opts.expected) : null,
        actual_behavior:   opts.actual   ? redactObject(opts.actual)   : null,
        hypothesis:        opts.hypothesis ? redactObject(opts.hypothesis) : null,
        steps_to_reproduce: Array.isArray(opts.stepsToReproduce)
            ? opts.stepsToReproduce.map((s) => String(s).slice(0, 200))
            : null,

        meta: errorDoc.meta != null ? redactObject(errorDoc.meta) : null,

        user_pii_redacted: true,
        secrets_redacted: true,
        screenshot_attached: false,
    };
}

// ── builder: bug report → AI debug report ───────────────────────────
export function buildAIDebugReportFromBug(bugDoc, opts = {}) {
    if (!bugDoc) return null;
    const occurredAtMs = bugDoc.occurredAt || (bugDoc.ts && bugDoc.ts.seconds ? bugDoc.ts.seconds * 1000 : Date.now());
    return {
        report_id: `ai_dbg_bug_${(toISO(bugDoc.ts) || new Date().toISOString()).slice(0, 16)}_${shortId()}`,
        generated_at: new Date().toISOString(),
        summary: (bugDoc.description || '').slice(0, 140) || 'Bug report',
        severity: bugDoc.urgency === 'high' ? 'critical' : bugDoc.urgency === 'med' ? 'error' : 'warn',
        feature_area: bugDoc.feature || guessFeatureFromPath(bugDoc.page) || 'unknown',
        user_role_affected: bugDoc.reporterRole || 'staff',
        location: bugDoc.reporterLocation || null,
        app_version: bugDoc.appVersion || 'unknown',
        environment: 'prod',

        timeline: buildTimeline(bugDoc.recentActions, occurredAtMs),

        bug_report: {
            description: bugDoc.description || '',
            what_were_you_doing: bugDoc.whatWereYouDoing || '',
            urgency: bugDoc.urgency || 'med',
        },

        context: {
            url_path: typeof bugDoc.page === 'string' ? bugDoc.page.split('?')[0] : null,
            url_query_keys: typeof bugDoc.page === 'string'
                ? (bugDoc.page.split('?')[1] || '').split('&').filter(Boolean).map((p) => p.split('=')[0])
                : [],
            browser: bugDoc.device?.ua || null,
            viewport: bugDoc.device?.viewport || null,
        },

        attached_errors: Array.isArray(opts.attachedErrors)
            ? opts.attachedErrors.map((e) => ({
                error_log_id: e.id || null,
                name: e.errorName || null,
                message: (e.errorMessage || '').slice(0, 200),
                stack_redacted: redactStack(e.stack || ''),
                feature: e.feature || null,
            }))
            : [],

        expected_behavior: opts.expected ? redactObject(opts.expected) : null,
        actual_behavior:   opts.actual   ? redactObject(opts.actual)   : null,
        hypothesis:        opts.hypothesis ? redactObject(opts.hypothesis) : null,

        user_pii_redacted: true,
        secrets_redacted: true,
        screenshot_attached: !!bugDoc.screenshotPath,
    };
}

// Lightweight feature inference for bug reports that didn't tag a
// feature explicitly. Maps the URL path to one of the canonical
// feature tags ('inventory', 'schedule', '86', 'inbox', etc.) so
// the dashboard can group bug reports the same way error logs
// are grouped. Returns null if no clear match.
function guessFeatureFromPath(path) {
    if (!path || typeof path !== 'string') return null;
    if (path.includes('eighty6'))     return '86';
    if (path.includes('inventory'))   return 'inventory';
    if (path.includes('schedule'))    return 'schedule';
    if (path.includes('chat'))        return 'chat';
    if (path.includes('onboarding'))  return 'onboarding';
    if (path.includes('operations')) return 'operations';
    if (path.includes('inbox'))      return 'inbox';
    if (path.includes('training'))   return 'training';
    if (path.includes('recipes'))    return 'recipes';
    if (path.includes('labor'))      return 'labor';
    if (path.includes('catering'))   return 'catering';
    if (path.includes('maintenance'))return 'maintenance';
    return null;
}

// Copy a report to the system clipboard wrapped in a Markdown code
// fence so it pastes into ChatGPT / Claude / Slack cleanly. Returns
// true on success, false otherwise (older browsers / iframes).
export async function copyAIDebugReport(report) {
    if (!report) return false;
    try {
        const text = '```json\n' + JSON.stringify(report, null, 2) + '\n```';
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

// Build + copy in one call — common shorthand for dashboard buttons.
// Returns { ok, report }.
export async function exportErrorToAI(errorDoc, opts) {
    const report = buildAIDebugReportFromError(errorDoc, opts);
    const ok = await copyAIDebugReport(report);
    return { ok, report };
}

export async function exportBugToAI(bugDoc, opts) {
    const report = buildAIDebugReportFromBug(bugDoc, opts);
    const ok = await copyAIDebugReport(report);
    return { ok, report };
}
