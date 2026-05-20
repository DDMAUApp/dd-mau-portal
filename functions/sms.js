/**
 * Twilio send helper, eligibility checker, opt-in event logger.
 *
 * Pure-ish helpers — they read/write Firestore but don't define Cloud
 * Functions themselves. The actual triggers (dispatchSms, twilioInbound,
 * twilioStatusCallback) live in index.js and call these.
 *
 * Secrets are loaded via defineSecret + injected on each call. Twilio
 * SDK is lazy-loaded inside sendTwilioSms so the module-level require
 * doesn't slow cold starts of unrelated functions in this codebase.
 */

const { FieldValue } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions/v2");
const {
    ALWAYS_SMS_TYPES,
    renderSmsTemplate,
    CONSENT_TEXT_VERSION,
    CONSENT_TEXT,
} = require("./smsTemplates");

// E.164 sanity check. We do tighter validation on the client (libphonenumber
// would be ideal but adds 100kb to the client bundle; for a US-only team
// the regex below is sufficient + fast). The Cloud Function side just
// rejects anything that clearly isn't E.164.
function isE164(s) {
    if (!s || typeof s !== "string") return false;
    return /^\+[1-9]\d{7,14}$/.test(s);
}

// SMS eligibility — returns [boolean, reasonString].
//
// Order matters: cheapest checks first so a non-eligible event bails
// before we touch Firestore for settings or look up the staff.
//
// `notif` — the freshly-created /notifications/{id} doc data
// `staff` — the staff record from /config/staff.list[]
// `settings` — the /config/sms global settings doc (may be null on first run)
function isSmsEligible(notif, staff, settings) {
    if (!notif) return [false, "no_notif"];
    if (!staff) return [false, "no_staff_record"];

    // 1. Type must be SMS-eligible. Anything not in the set is push-only.
    if (!ALWAYS_SMS_TYPES.has(notif.type)) return [false, "type_not_sms_eligible"];

    // 2. Per-event opt-out. Lets a caller mark a specific notification
    //    push-only without changing the type policy.
    if (notif.skipSms === true) return [false, "skip_sms_flag"];

    // 3. Phone number required + E.164 valid.
    if (!staff.phoneE164) return [false, "no_phone"];
    if (!isE164(staff.phoneE164)) return [false, "invalid_phone"];

    // 4. Staff opted in.
    if (staff.smsOptIn !== true) return [false, "not_opted_in"];

    // 5. Staff hasn't replied STOP. This flag is server-only — the
    //    client can never clear it; only an inbound START reply or an
    //    admin override (which writes an audit row) can.
    if (staff.smsStopped === true) return [false, "stopped"];

    // 6. Global settings (lenient defaults — if /config/sms doesn't
    //    exist yet, we treat SMS as enabled).
    const cfg = settings || {};
    if (cfg.enabled === false) return [false, "sms_globally_disabled"];

    // 7. Test mode — only owners get real SMS. Useful when wiring Twilio
    //    for the first time so a misconfig doesn't blast 30 people.
    if (cfg.testMode === true) {
        const isOwner = staff.id === 40 || staff.id === 41;
        if (!isOwner) return [false, "test_mode_skipped"];
    }

    return [true, "eligible"];
}

// Build the variable bag passed to renderSmsTemplate. Pulls from
// notif.smsVars first (callers can supply explicit values), then falls
// back to scraping common fields off the notif doc itself.
//
// We do NOT scrape title/body into SMS — those are push-formatted and
// often contain markup or are longer than SMS tolerates. SMS uses its
// own templates with explicit, controlled placeholders.
function buildSmsVars(notif) {
    const vars = {};
    if (notif.smsVars && typeof notif.smsVars === "object") {
        Object.assign(vars, notif.smsVars);
    }
    // Lightweight fallbacks for the most common fields callers forget
    // to populate explicitly.
    if (!vars.location && notif.location) vars.location = notif.location;
    if (!vars.date && notif.date) vars.date = notif.date;
    if (!vars.time && notif.time) vars.time = notif.time;
    if (!vars.summary && notif.body && typeof notif.body === "string") {
        // Truncate so SMS stays single-segment even when body is long
        vars.summary = notif.body.length > 80 ? notif.body.slice(0, 77) + "..." : notif.body;
    }
    return vars;
}

// Lazy-load the Twilio SDK so unrelated cold starts in this codebase
// don't pay the require cost.
let _twilioClient = null;
function getTwilioClient(accountSid, authToken) {
    if (_twilioClient) return _twilioClient;
    const twilio = require("twilio");
    _twilioClient = twilio(accountSid, authToken);
    return _twilioClient;
}

// Send one SMS. Returns { sid, status } on success or throws on Twilio
// API failure. Caller writes the delivery log row in either case.
async function sendTwilioSms({ to, body, accountSid, authToken, from, statusCallback }) {
    const client = getTwilioClient(accountSid, authToken);
    const msg = await client.messages.create({
        to,
        from,
        body,
        ...(statusCallback ? { statusCallback } : {}),
    });
    return { sid: msg.sid, status: msg.status };
}

// Write one row to /sms_delivery_logs. Best-effort — failures here
// are logged but never throw, because they're observability not core
// path. The presence/absence of a log row is also used for dedup:
// dispatchSms checks if a row already exists for the same notificationId
// before sending, so a retry of the same trigger doesn't double-send.
async function writeDeliveryLog(db, payload) {
    try {
        await db.collection("sms_delivery_logs").add({
            ...payload,
            createdAt: FieldValue.serverTimestamp(),
        });
    } catch (e) {
        logger.warn("sms_delivery_logs write failed (non-fatal):", e?.message || e);
    }
}

// Has THIS notification already been processed by dispatchSms (success
// or attempted)? Used for dedup — Firestore triggers can fire twice for
// the same doc under retry pressure; we want exactly-once SMS semantics
// per notification regardless. Cheap collection-group query by indexed
// `notificationId` field.
async function hasExistingDeliveryLog(db, notificationId) {
    try {
        const snap = await db
            .collection("sms_delivery_logs")
            .where("notificationId", "==", notificationId)
            .limit(1)
            .get();
        return !snap.empty;
    } catch (e) {
        // On query failure default to "no" — better to risk a duplicate
        // SMS than to silently drop a real one. We log loudly so the
        // missing index gets surfaced.
        logger.warn("hasExistingDeliveryLog query failed:", e?.message || e);
        return false;
    }
}

// Write one row to /sms_opt_in_events. EVERY opt-in / opt-out gets a
// row — by self, by admin, by STOP reply, by START reply, by onboarding
// form. The row is the legal/compliance evidence. Snapshots the consent
// text VERBATIM so a future audit can prove exactly what the user agreed
// to at the moment they agreed.
async function writeOptInEvent(db, {
    staffId,
    staffName,
    phoneE164,
    action,              // 'opt_in' | 'opt_out'
    source,              // 'self_app' | 'admin_panel' | 'sms_stop_reply' | 'sms_start_reply' | 'onboarding_form' | 'system'
    byName = "system",
    byId = null,
    ipAddress = null,
    userAgent = null,
    twilioMessageSid = null,
    note = null,
}) {
    try {
        await db.collection("sms_opt_in_events").add({
            staffId: staffId ?? null,
            staffName: staffName || null,
            phoneE164: phoneE164 || null,
            action,
            source,
            byName,
            byId,
            consentTextVersion: CONSENT_TEXT_VERSION,
            consentTextEn: CONSENT_TEXT.en,
            consentTextEs: CONSENT_TEXT.es,
            ipAddress,
            userAgent,
            twilioMessageSid,
            note,
            at: FieldValue.serverTimestamp(),
        });
    } catch (e) {
        logger.error("sms_opt_in_events write failed:", e?.message || e);
        // Rethrow — losing an opt-in event is a compliance failure,
        // not best-effort. Caller decides whether to fail loudly.
        throw e;
    }
}

// Lookup a staff record by phone number for inbound webhook handling.
// Returns null if no match. Phone normalization is done before lookup
// so "+13145551234", "3145551234", "(314) 555-1234" all hit the same
// E.164 stored on the record.
async function findStaffByPhone(db, fromPhone) {
    if (!fromPhone) return null;
    const normalized = normalizePhoneToE164(fromPhone);
    if (!normalized) return null;
    const doc = await db.doc("config/staff").get();
    const list = (doc.exists ? doc.data().list : []) || [];
    return list.find((s) => s && s.phoneE164 === normalized) || null;
}

// Server-side E.164 normalization. The client uses a more thorough
// version in src/data/sms.js; this is a fallback for inbound where
// Twilio always sends From in E.164 anyway.
function normalizePhoneToE164(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (s.startsWith("+")) {
        return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
    }
    const digits = s.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;          // US
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
}

// Detect STOP/START/HELP in an inbound body. Twilio normalizes the
// carrier auto-detected ones too, but we mirror their logic for any
// custom-routed inbound. Returns one of: 'stop' | 'start' | 'help' | 'other'.
function classifyInboundBody(body) {
    if (!body) return "other";
    const t = String(body).trim().toUpperCase();
    if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|PARAR|ALTO)\b/.test(t)) return "stop";
    if (/^(START|YES|UNSTOP|ACTIVAR)\b/.test(t)) return "start";
    if (/^(HELP|INFO|AYUDA)\b/.test(t)) return "help";
    return "other";
}

// Update a staff record's SMS fields atomically. Reads config/staff,
// maps the list, writes back. Returns the updated staff record (or
// null if no match).
async function updateStaffSmsState(db, staffName, updates) {
    if (!staffName) return null;
    const ref = db.doc("config/staff");
    const snap = await ref.get();
    const list = (snap.exists ? snap.data().list : []) || [];
    let found = null;
    const newList = list.map((s) => {
        if (!s || s.name !== staffName) return s;
        const merged = { ...s, ...updates };
        found = merged;
        return merged;
    });
    if (!found) return null;
    await ref.set({ list: newList });
    return found;
}

module.exports = {
    isE164,
    isSmsEligible,
    buildSmsVars,
    sendTwilioSms,
    writeDeliveryLog,
    hasExistingDeliveryLog,
    writeOptInEvent,
    findStaffByPhone,
    normalizePhoneToE164,
    classifyInboundBody,
    updateStaffSmsState,
};
