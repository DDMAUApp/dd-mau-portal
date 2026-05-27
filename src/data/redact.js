// redact.js — secret + PII scrubbing for log payloads.
//
// Andrew 2026-05-26 — every log row we write to Firestore (error_logs,
// security_logs, bug_reports, the AI Debug export) passes through here
// first. The rules atop firestore.rules + the CLAUDE.md privacy block
// both say "never log full email bodies, payroll, tokens, etc.". This
// file is the chokepoint that enforces those rules at write time so a
// future careless caller can't slip a secret into a log row.
//
// Three layers:
//
//   1. SECRET_PATTERNS — known-shape secrets get replaced with
//      <redacted-secret>. Adding a new vendor key shape? Add it here.
//      Patterns are anchored to recognisable prefixes (sk-ant-, AKIA,
//      eyJ for JWTs, etc.) to keep false positives low.
//
//   2. PII redactors — emails, phones, IPv4, FCM tokens, absolute file
//      paths. We don't DROP these; we MASK them so a stack trace still
//      reads ("at handleSave (src/components/X.jsx:142)") and a
//      breadcrumb still tells us which form the user was on.
//
//   3. DROP_KEYS — any object key in this set gets its value replaced
//      with <redacted> regardless of content. This is the "if it lives
//      under this key, we definitely never want it logged" backstop:
//      passwords, tokens, raw email bodies, etc.
//
// Performance: redactString runs every regex in series on each string,
// so don't add expensive backtracking patterns. All patterns here are
// linear-time.
//
// Pure ESM, no Firebase import — usable from any callsite (frontend
// logger, Cloud Functions mirror, scripts/).

// ── Layer 1: known secret shapes ─────────────────────────────────────
//
// Each pattern is intentionally narrow so we don't false-positive on
// hashes or doc IDs that happen to be 32+ chars. If you add a vendor
// here, anchor on its known prefix.
const SECRET_PATTERNS = [
    // Anthropic API keys (sk-ant-…). Used by aiSearch + pollGmail.
    /sk-ant-[A-Za-z0-9_-]{20,}/g,
    // Stripe-shaped (sk_live_ / sk_test_ / pk_live_ / pk_test_).
    /(?:sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|rk_test_)[A-Za-z0-9]{16,}/g,
    // OpenAI-shaped (sk-…).
    /\bsk-[A-Za-z0-9]{32,}/g,
    // Google API keys (AIza…).
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    // AWS access keys.
    /\bAKIA[0-9A-Z]{16}\b/g,
    // GitHub PATs.
    /\bghp_[0-9A-Za-z]{36}\b/g,
    // Twilio account SID (AC + 32 hex). Auth tokens are pure 32 hex
    // strings which are hard to distinguish from doc IDs, so we don't
    // try to pattern-match those — they live behind DROP_KEYS instead.
    /\bAC[0-9a-f]{32}\b/g,
    // JWT shape (header.payload.sig of base64-ish chars).
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    // Generic "key:value" / "key=value" looking secrets. Greedy on the
    // KEY half (matches authorization|token|secret|password|api[_-]?key|bearer)
    // and lazy on the VALUE half so we don't over-match into surrounding
    // JSON. Case-insensitive.
    /(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|bearer)\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}["']?/gi,
];

// ── Layer 2: PII masking ─────────────────────────────────────────────
//
// We MASK, not drop. A logger that drops every email makes "Maria
// couldn't log in" debuggable but "she's at j***@gmail.com" tells us
// the domain (which routes through Gmail vs SES) without exposing the
// person.
const EMAIL_RE = /([A-Za-z0-9._-])[A-Za-z0-9._-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PHONE_RE = /(?:\+?1[\s\-.]?)?\(?(\d{3})\)?[\s\-.]?(\d{3})[\s\-.]?(\d{4})/g;
// IPv4 → keep /16 prefix only. /32 would let an attacker correlate
// user sessions; /16 gives us "is this a corporate network" without
// the unique fingerprint.
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g;
// FCM tokens are huge opaque strings — we keep first 6 + last 4 so we
// can correlate to /config/staff.list[].fcmTokens entries without
// storing the whole thing.
const FCM_RE = /[A-Za-z0-9_-]{50,200}:APA91b[A-Za-z0-9_-]{30,180}/g;
// Strip operator's home dirs from stack traces so log rows don't
// embed the developer's username.
const ABS_PATH_RE = /\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|C:\\Users\\[^\\\s]+\\/g;
// SSNs — must never appear in a log. We never write them to Firestore
// anyway (only to the W-4 PDF in Storage), but the redactor is the
// belt-and-suspenders backstop for crashes that touched a hire form
// in memory.
const SSN_RE = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g;

export function redactString(s) {
    if (typeof s !== 'string') return s;
    let out = s;
    // Secrets first — the SECRET_PATTERNS replace whole tokens with a
    // placeholder, so subsequent regexes don't see them.
    for (const re of SECRET_PATTERNS) out = out.replace(re, '<redacted-secret>');
    out = out.replace(SSN_RE,     '<redacted-ssn>');
    out = out.replace(FCM_RE,     (m) => `${m.slice(0, 6)}...${m.slice(-4)}`);
    out = out.replace(EMAIL_RE,   (_, a, b) => `${a}***${b}`);
    out = out.replace(PHONE_RE,   (_, _a, _b, last4) => `(***) ***-${last4}`);
    out = out.replace(IPV4_RE,    (_, a, b) => `${a}.${b}.0.0/16`);
    out = out.replace(ABS_PATH_RE, '/<home>/');
    return out;
}

// ── Layer 3: drop-list keys ──────────────────────────────────────────
//
// Any object key in this set has its value replaced with <redacted>,
// regardless of whether redactString would have caught its contents.
// This is the safety net for shapes the patterns above might miss
// (e.g. an obscure custom auth header, a raw Gmail message body).
//
// CASE-INSENSITIVE match — see the lowercased-key lookup in
// redactObject below.
const DROP_KEYS = new Set([
    // Auth-y
    'password', 'passwd', 'pwd', 'pin',
    'token', 'accesstoken', 'access_token',
    'refreshtoken', 'refresh_token',
    'idtoken', 'id_token',
    'apikey', 'api_key', 'authorization', 'auth',
    'secret', 'clientsecret', 'client_secret',
    'sessionid', 'cookie', 'session',
    // Restaurant ops PII
    'ssn', 'socialsecurity', 'social_security',
    'dob', 'dateofbirth', 'date_of_birth',
    'bankaccount', 'bank_account', 'routing', 'routingnumber', 'accountnumber',
    'wages', 'payrate', 'pay_rate', 'tips', 'payroll',
    // Email/document bodies — never log full content
    'body', 'messagebody', 'message_body', 'rawbody', 'raw_body',
    'attachment', 'attachments', 'attachmentdata',
    'rawresponse', 'raw_response',
    // Full LLM prompt/response when the prompt may contain a body
    'prompt', 'fullprompt', 'full_prompt',
]);

// Configurable max sizes — log rows live in Firestore docs (1MB cap)
// so each field has to stay small. These limits also bound runaway
// logs (a 50KB stack trace blowing up a notifications doc, etc.).
export const REDACT_STRING_MAX = 8000;
export const REDACT_ARRAY_MAX = 50;
export const REDACT_DEPTH_MAX = 6;

// Recursively redacts a JSON-safe value. Returns a NEW value; never
// mutates the input. Out-of-budget paths get a sentinel so the
// consumer knows the data was truncated rather than empty.
export function redactObject(value, depth = 0) {
    if (value == null) return value;
    if (depth > REDACT_DEPTH_MAX) return '<too-deep>';
    if (typeof value === 'string') {
        return redactString(value).slice(0, REDACT_STRING_MAX);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (Array.isArray(value)) {
        const out = value.slice(0, REDACT_ARRAY_MAX).map((v) => redactObject(v, depth + 1));
        if (value.length > REDACT_ARRAY_MAX) out.push(`<+${value.length - REDACT_ARRAY_MAX} more>`);
        return out;
    }
    if (typeof value === 'object') {
        const out = {};
        let count = 0;
        for (const [k, v] of Object.entries(value)) {
            // Object key budget — same idea as REDACT_ARRAY_MAX, prevents
            // a Firestore doc snapshot's whole .data() from blowing up
            // a log entry if someone passes one in by mistake.
            if (count++ >= 50) {
                out['<truncated>'] = '<+more keys>';
                break;
            }
            if (DROP_KEYS.has(k.toLowerCase())) {
                out[k] = '<redacted>';
                continue;
            }
            out[k] = redactObject(v, depth + 1);
        }
        return out;
    }
    // Functions / symbols / Map / Set — not JSON-safe. Stamp the type
    // so we can see "we tried to log a Map and stripped it" rather
    // than silently writing undefined.
    return `<${typeof value}>`;
}

// Stack trace cleanup — strip absolute paths above the project root,
// cap lines, redact embedded strings (since stack frames sometimes
// embed prop values via error-cause messages).
export function redactStack(stack) {
    if (typeof stack !== 'string') return stack;
    const cleaned = redactString(stack);
    return cleaned.split('\n').slice(0, 60).join('\n');
}

// Convenience: strip query-string VALUES out of a URL, leaving only
// the keys so we can see "user opened /staff?id=…&token=…" without
// the actual values. Pathname is preserved as-is (no redaction).
//
// Important for: bug reports + breadcrumbs. The url path itself often
// names the feature ("/onboarding?hire=ABC"); we keep that route info,
// drop the unique IDs.
export function redactUrl(url) {
    if (typeof url !== 'string') return url;
    try {
        const u = new URL(url, 'https://app.ddmaustl.com');
        const keys = [...u.searchParams.keys()];
        return `${u.pathname}${keys.length ? `?${keys.join('&')}` : ''}`;
    } catch {
        // Not a parseable URL — fall back to string redaction.
        return redactString(url).slice(0, 500);
    }
}
