/**
 * DD Mau Cloud Functions — push notification dispatcher.
 *
 * Two functions in this file:
 *
 *   1. dispatchNotification — Firestore trigger on `notifications/{id}` creates.
 *      Looks up the recipient's FCM tokens from `config/staff.list[].fcmTokens`
 *      and sends a push to each one. Cleans up tokens that come back invalid.
 *
 *   2. sendShiftReminders — Pub/Sub scheduled function (runs every 5 minutes).
 *      Finds shifts starting 60-65 minutes from now and writes a notification
 *      doc for each owner. The dispatcher above then sends the push. This
 *      replaces the client setTimeout reminder for the closed-app case.
 *
 * Deploy: `firebase deploy --only functions`
 *
 * Free tier: 2M invocations/month, 400K GB-sec, 200K CPU-sec. DD Mau's
 * notification volume is tiny — well under free tier. Cloud Functions
 * REQUIRES the Blaze (pay-as-you-go) plan even though usage stays free.
 */
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { GoogleAuth } = require("google-auth-library");

initializeApp();
const db = getFirestore();

// Twilio SMS — secrets are injected per-function so they never appear
// in the deployed bundle as plaintext. Set them with:
//   firebase functions:secrets:set TWILIO_ACCOUNT_SID
//   firebase functions:secrets:set TWILIO_AUTH_TOKEN
//   firebase functions:secrets:set TWILIO_FROM_NUMBER
// See FCM_SETUP.md companion: SMS_SETUP.md for the runbook.
const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");
const TWILIO_FROM_NUMBER = defineSecret("TWILIO_FROM_NUMBER");

// Anthropic API key — powers aiSearch (semantic search) below.
// Set with: firebase functions:secrets:set ANTHROPIC_API_KEY
// Aim a Claude Haiku-class model — fast + cheap; queries are
// roughly $0.0015 each at restaurant-scale inventory size.
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// Gmail OAuth — powers pollGmail (owner inbox triage). Three secrets:
//   - GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET: from the
//     OAuth 2.0 client created in Google Cloud Console (Desktop app type).
//   - GMAIL_OAUTH_REFRESH_TOKEN: minted once via the local helper at
//     scripts/gmail-oauth-setup.mjs after Andrew/Julie complete the
//     consent flow.
// Set with: firebase functions:secrets:set GMAIL_OAUTH_CLIENT_ID (etc.)
const GMAIL_OAUTH_CLIENT_ID = defineSecret("GMAIL_OAUTH_CLIENT_ID");
const GMAIL_OAUTH_CLIENT_SECRET = defineSecret("GMAIL_OAUTH_CLIENT_SECRET");
const GMAIL_OAUTH_REFRESH_TOKEN = defineSecret("GMAIL_OAUTH_REFRESH_TOKEN");

// 2026-05-23 — Toast Connect API secrets removed. Powered syncToastMenuStatus,
// which was a redundant duplicate of the Railway scraper that already writes
// /ops/86_<location>. The Cloud Function 401'd in production because nothing
// in this app was actually using the partner API — the working path is the
// Railway scraper. Secrets in Firebase can be deleted with
//   firebase functions:secrets:destroy TOAST_WEBSTER_CLIENT_ID
// (and the other 3) if you want to remove them entirely; otherwise harmless.

const smsHelpers = require("./sms");
const {
    renderSmsTemplate,
    INBOUND_REPLIES,
    CONSENT_TEXT_VERSION,
    ALWAYS_SMS_TYPES,
} = require("./smsTemplates");

// Helper: is `staffName` currently within a published shift, or
// within 30 min of one starting? Returns true/false. Used by the
// off-shift gate in dispatchNotification.
//
// Date math mirrors sendShiftReminders — we compute the actual
// America/Chicago UTC offset for the shift's date via Intl so the
// gate respects DST. Reading ONLY today+yesterday because:
//   • yesterday: catches overnight shifts whose end-time has rolled
//     past midnight UTC but the shift's `date` field is still
//     yesterday's date in CT.
//   • today: the obvious case.
async function isOnShiftNow(staffName) {
    if (!staffName) return false;
    const now = Date.now();
    const today = new Date();
    const yest = new Date(today.getTime() - 86400_000);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dateRange = [fmt(yest), fmt(today)];

    const snap = await db
        .collection("shifts")
        .where("staffName", "==", staffName)
        .where("date", "in", dateRange)
        .where("published", "==", true)
        .get();

    for (const sDoc of snap.docs) {
        const sh = sDoc.data();
        if (!sh.date || !sh.startTime || !sh.endTime) continue;
        const [y, mo, d] = sh.date.split("-").map(Number);
        const [hh, mm] = sh.startTime.split(":").map(Number);
        const [eh, em] = sh.endTime.split(":").map(Number);
        // Resolve CT offset for that date (handles DST).
        const probe = new Date(Date.UTC(y, mo - 1, d, 12, 0));
        const offsetParts = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            timeZoneName: "shortOffset",
        }).formatToParts(probe);
        const offsetLabel = offsetParts.find((p) => p.type === "timeZoneName")?.value || "GMT-5";
        const offsetMatch = /GMT([+-]?\d+)/.exec(offsetLabel);
        const ctOffsetHours = offsetMatch ? -parseInt(offsetMatch[1], 10) : 5;
        const startMs = Date.UTC(y, mo - 1, d, hh + ctOffsetHours, mm);
        let endMs = Date.UTC(y, mo - 1, d, eh + ctOffsetHours, em);
        // Overnight shift (end < start): bump end into the next day.
        if (endMs <= startMs) endMs += 86400_000;
        // On-shift window: 30 min before start through end.
        if (now >= startMs - 30 * 60_000 && now <= endMs) return true;
    }
    return false;
}

// ── 1. Push every notification doc to its recipient's FCM tokens ──────────
exports.dispatchNotification = onDocumentCreated(
    { document: "notifications/{id}", region: "us-central1" },
    async (event) => {
        const snap = event.data;
        if (!snap) return;
        const notif = snap.data();
        const forStaff = notif.forStaff;
        if (!forStaff) {
            logger.warn("notification missing forStaff field, id=", event.params.id);
            return;
        }

        // Look up recipient's FCM tokens from the staff config doc
        const staffDoc = await db.doc("config/staff").get();
        const list = (staffDoc.data() || {}).list || [];
        const me = list.find((s) => s.name === forStaff);
        if (!me || !Array.isArray(me.fcmTokens) || me.fcmTokens.length === 0) {
            logger.info(`no FCM tokens for ${forStaff}, skipping push`);
            return;
        }

        // ── OWNER-ONLY type gate (2026-05-26) ──────────────────────
        // Andrew: "i want to make sure that all of the inbox functions
        // do not let anyone else see it except julie and andrew." The
        // sender (pollGmail) already addresses only ids 40/41, but
        // this is defense in depth: if ANYTHING ever writes an
        // owner-only-typed notification to a non-owner forStaff, we
        // refuse to push it and stamp the doc as suppressed. The
        // in-bell doc is still preserved for forensics but no FCM
        // fan-out, no SMS routing, no surprise pages.
        //
        // Source of truth: src/data/notificationTypes.js → ownerOnly
        // flag. Keep this list in sync.
        const OWNER_ONLY_TYPE_IDS = new Set([
            "email_inquiry_catering",
            "email_inquiry_complaint",
        ]);
        const OWNER_STAFF_IDS = new Set([40, 41]);
        if (OWNER_ONLY_TYPE_IDS.has(notif.type) && !OWNER_STAFF_IDS.has(me.id)) {
            logger.warn(
                `owner-only gate: refused to push type=${notif.type} to non-owner forStaff=${forStaff} (id=${me.id})`
            );
            try {
                await snap.ref.update({
                    pushSuppressed: true,
                    pushSuppressedReason: "owner_only_type",
                });
            } catch (e) {
                logger.warn(`could not stamp pushSuppressed for ${event.params.id}:`, e);
            }
            return;
        }

        // ── Per-staff opt-out gate (2026-05-24) ────────────────────
        // Admin can mute optional notification types per-staff via the
        // /admin → Notifications page. pushOptOut: string[] on the
        // staff record holds the type ids that should NEVER push to
        // this person. LOCKED_ON types (chat, personal schedule
        // changes, your own tasks) IGNORE this — they always push,
        // because muting "you got a shift" or "@-mention" silently
        // breaks the app's promise to staff. The /notifications doc
        // is still kept (bell drawer still shows it), only the FCM
        // push is suppressed. Source-of-truth for which types are
        // locked: src/data/notificationTypes.js (mirrored below).
        const LOCKED_ON_TYPE_IDS = new Set([
            // chat
            "chat_message", "chat_mention", "chat_nudge",
            // personal schedule changes / outcomes
            "shift_reminder_1h",
            "shift_added", "shift_deleted", "shift_reassigned",
            "shift_date_changed", "shift_time_changed",
            "pto_approved", "pto_denied",
            "swap_approved", "swap_denied",
            "coverage_approved", "coverage_denied",
            "week_published",
            // your own tasks / acks
            "task_handoff", "task_reminder", "task_comment",
            "task_message", "task_completed",
            "required_ack", "announcement",
        ]);
        const personalOptOuts = Array.isArray(me.pushOptOut) ? me.pushOptOut : [];
        if (notif.type && personalOptOuts.includes(notif.type) && !LOCKED_ON_TYPE_IDS.has(notif.type)) {
            logger.info(`opt-out gate: suppressing push for ${forStaff} type=${notif.type} (admin muted)`);
            try {
                await snap.ref.update({
                    pushSuppressed: true,
                    pushSuppressedReason: "staff_opt_out",
                });
            } catch (e) {
                logger.warn(`could not stamp pushSuppressed for ${event.params.id}:`, e);
            }
            return;
        }
        // DEDUP by exact token string. Without this, multiple stale
        // entries that all happen to share the same active token (which
        // happens after the message rotation logic in messaging.js
        // re-saves the same token N times across sessions) cause Nx
        // duplicate notifications on a single device. The Set-based
        // dedup is the actual fix for the "4 of each notification"
        // bug reported on 2026-05-13. The persist-side dedup in
        // messaging.js prevents new accumulation; this dispatch-side
        // dedup neutralizes legacy data already in Firestore.
        const tokens = [...new Set(
            me.fcmTokens.map((t) => t && t.token).filter(Boolean)
        )];
        if (tokens.length === 0) return;
        if (tokens.length !== me.fcmTokens.length) {
            logger.info(`deduped ${me.fcmTokens.length - tokens.length} duplicate token(s) for ${forStaff}`);
        }

        // ── Off-shift quiet hours gate ──────────────────────────────
        // Andrew (2026-05-17): "lets do number one but lets have
        // somthing that lets us know they are silenced. and if its
        // important we can notify anyways".
        //
        // We suppress the FCM push (but keep the /notifications doc —
        // user sees it in the bell next time they open the app) when:
        //   1. The notification type respects off-shift gating
        //   2. The recipient is NOT currently on shift (within 30 min
        //      of start, through end-time)
        //   3. The recipient is NOT a manager/owner (always reachable)
        //   4. The sender did NOT mark the notif `forceDeliver: true`
        //
        // ALWAYS-DELIVER types (mentions, 86 alerts, shift reminders,
        // coverage approvals, etc.) ignore this gate entirely — they
        // are operationally urgent or directly addressed.
        const ALWAYS_DELIVER_TYPES = new Set([
            // 2026-05-20 — Andrew: "lets keep all chat group chat
            // groups on, not silenced give the staff the option to
            // salience it." Routine chat now pierces the off-shift
            // gate; the per-channel mute (checked just below) is the
            // opt-out path for staff who don't want pushes from a
            // specific channel.
            "chat_message",            // group / DM message
            "chat_mention",            // @-tagged, directly addressed
            "chat_nudge",              // manager explicitly reminding YOU to read
            "eighty_six_alert",        // operational emergency
            "photo_issue",             // operational
            "shift_reminder_1h",       // your own shift
            "coverage_approved",       // outcome you need now
            "coverage_denied",         // outcome you need now
            "required_ack",            // explicit ack flow
            "task_handoff",            // assigned to YOU
            "invite_sent",             // onboarding
            "tv_offline",              // menu TV went dark — needs reboot
            "tv_back_online",          // menu TV recovered
        ]);

        // ── Per-channel mute gate ───────────────────────────────────
        // Runs BEFORE the off-shift gate so even always-deliver chat
        // types respect a user's explicit mute. Reads
        // /chat_prefs/{forStaff}.channelPrefs[chatId]:
        //   'all'      → push (default when no entry exists)
        //   'mentions' → push only when notif.type === 'chat_mention'
        //   'none'     → suppress all pushes for this channel
        // chatId is parsed from notif.tag (`chat:{id}:{to}`) which
        // both the client (ChatThread) and the scheduled-chat pump
        // set. Non-chat notifs are never muted this way.
        if ((notif.type === "chat_message" || notif.type === "chat_mention")
            && typeof notif.tag === "string" && notif.tag.startsWith("chat:")) {
            const chatId = notif.tag.split(":")[1];
            if (chatId) {
                try {
                    const prefsSnap = await db.doc(`chat_prefs/${forStaff}`).get();
                    const channelPref = prefsSnap.exists
                        ? (prefsSnap.data()?.channelPrefs || {})[chatId]
                        : null;
                    if (channelPref === "none"
                        || (channelPref === "mentions" && notif.type !== "chat_mention")) {
                        logger.info(`channel-mute gate: suppressing ${notif.type} for ${forStaff} in ${chatId} (pref=${channelPref})`);
                        try {
                            await snap.ref.update({
                                pushSuppressed: true,
                                pushSuppressedReason: channelPref === "none" ? "channel_muted" : "channel_mentions_only",
                            });
                        } catch (e) {
                            logger.warn(`could not stamp pushSuppressed for ${event.params.id}:`, e);
                        }
                        return;
                    }
                } catch (e) {
                    // Fail open — push goes through. Better to over-notify
                    // than to drop a chat because of a prefs read failure.
                    logger.warn(`channel-mute check failed for ${forStaff}:`, e);
                }
            }
        }

        const isManagerOrOwner = (() => {
            if (me.id === 40 || me.id === 41) return true; // owners
            return !!me.role && /manager|owner/i.test(me.role);
        })();
        const respectsGate = !ALWAYS_DELIVER_TYPES.has(notif.type)
            && notif.forceDeliver !== true
            && !isManagerOrOwner;
        if (respectsGate) {
            try {
                const onShift = await isOnShiftNow(forStaff);
                if (!onShift) {
                    // User has off-shift quiet enabled (default true).
                    // Honor it unless they've opted out via notifPolicy.
                    const policy = me.notifPolicy || {};
                    const offShiftQuiet = policy.offShiftQuiet !== false; // default ON
                    if (offShiftQuiet) {
                        logger.info(`off-shift gate: suppressing push for ${forStaff} (type=${notif.type}); doc retained for in-app view`);
                        // Stamp the doc so the client can render a
                        // "silenced — they'll see it when they open
                        // the app" indicator next to delivery state.
                        try {
                            await snap.ref.update({ pushSuppressed: true, pushSuppressedReason: "off_shift" });
                        } catch (e) {
                            logger.warn(`could not stamp pushSuppressed for ${event.params.id}:`, e);
                        }
                        return;
                    }
                }
            } catch (e) {
                // If shift lookup fails, default to delivering — better
                // to over-notify than to drop an important message
                // because of a query error.
                logger.warn(`off-shift check failed for ${forStaff}, delivering anyway:`, e);
            }
        }

        // DATA-ONLY payload. Critical: with a top-level `notification`
        // field, Chrome / Edge auto-display the message at the OS level
        // via the SW push event BEFORE firebase-messaging's wrapper
        // gets a chance to suppress it. Then our SW's onBackgroundMessage
        // ALSO fires showNotification, so the user sees TWO toasts for
        // one event. Data-only payloads bypass auto-display entirely;
        // our SW (firebase-messaging-sw.js) reads title/body out of the
        // data field and calls showNotification exactly once.
        //
        // The `tag` field lets the OS coalesce duplicate notifications
        // — if the same tag arrives twice (e.g. retry), the OS replaces
        // the first with the second instead of stacking.
        const tag = notif.tag || notif.id || event.params.id;
        const message = {
            tokens,
            data: {
                title: notif.title || "DD Mau",
                body: notif.body || "",
                type: notif.type || "",
                tag,
                link: notif.link || "/",
            },
            webpush: {
                headers: { Urgency: "high" },
                fcmOptions: { link: notif.link || "/" },
            },
        };

        const result = await getMessaging().sendEachForMulticast(message);
        logger.info(`Sent push for ${forStaff}: ${result.successCount} ok, ${result.failureCount} failed (${tokens.length} token${tokens.length === 1 ? "" : "s"})`);

        // Clean up dead tokens (registration-token-not-registered, invalid-argument).
        // Identify which tokens to PRUNE this round; we'll then atomically
        // remove them inside a transaction so a concurrent admin PIN edit
        // (or another notification trigger pruning a different staff's
        // tokens) doesn't get clobbered.
        //
        // 2026-05-24 audit fix: was reading `list` from the trigger-time
        // snapshot then writing the whole doc with `set({list: newList})`.
        // This is the exact whole-doc clobber pattern that caused the
        // 2026-05-09 PIN-wipe incident. Wrapping in runTransaction reads
        // the LIVE doc inside the txn and only mutates this staff's
        // fcmTokens — any concurrent admin write to a different staff
        // (PIN edit, opsAccess toggle, etc.) survives.
        const deadCodes = new Set([
            "messaging/registration-token-not-registered",
            "messaging/invalid-registration-token",
            "messaging/invalid-argument",
        ]);
        const deadTokens = [];
        for (let i = 0; i < tokens.length; i++) {
            const r = result.responses[i];
            if (!r.success && deadCodes.has(r.error?.code)) {
                deadTokens.push(tokens[i]);
                logger.info(`pruning dead token for ${forStaff}: ${r.error?.code}`);
            }
        }
        if (deadTokens.length > 0) {
            try {
                await db.runTransaction(async (txn) => {
                    const liveSnap = await txn.get(db.doc("config/staff"));
                    if (!liveSnap.exists) return;
                    const liveList = (liveSnap.data() || {}).list || [];
                    const meIdx = liveList.findIndex((s) => s.name === forStaff);
                    if (meIdx === -1) return;
                    const meLive = liveList[meIdx];
                    const existingTokens = Array.isArray(meLive.fcmTokens) ? meLive.fcmTokens : [];
                    const pruned = existingTokens.filter((t) => !deadTokens.includes(t?.token));
                    if (pruned.length === existingTokens.length) return; // no-op
                    const nextList = liveList.map((s, i) =>
                        i === meIdx ? { ...s, fcmTokens: pruned } : s
                    );
                    txn.update(liveSnap.ref, { list: nextList });
                });
            } catch (e) {
                logger.warn(`dispatchNotification: token-prune txn failed for ${forStaff}:`, e?.message);
            }
        }
    }
);

// ──────────────────────────────────────────────────────────────────────
// SMS dispatch — parallel to dispatchNotification
// ──────────────────────────────────────────────────────────────────────
//
// Same trigger (onDocumentCreated on notifications/{id}) so SMS runs
// alongside push. Independent: if Twilio is down or the staff isn't
// SMS-opted-in, push still happens; if push has no FCM tokens (PWA
// never installed), SMS catches the staff anyway.
//
// What triggers an SMS:
//   1. notif.type is in ALWAYS_SMS_TYPES (system urgencies only; chat
//      stays in-app per Andrew 2026-05-19)
//   2. staff has phoneE164 + smsOptIn=true + smsStopped!=true
//   3. global /config/sms enabled (or doc missing — default on)
//   4. no prior sms_delivery_logs row exists for this notificationId
//      (dedup against trigger retries)
//
// What we do NOT do:
//   • Send SMS for routine chat (chat_message, chat_mention) — those
//     stay push-only
//   • Relay inbound SMS into the chat UI — inbound is STOP/START/HELP
//     compliance only
//   • Put PII (SSN, payroll, medical) into the body — SMS isn't private
exports.dispatchSms = onDocumentCreated(
    {
        document: "notifications/{id}",
        region: "us-central1",
        secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER],
    },
    async (event) => {
        const snap = event.data;
        if (!snap) return;
        const notif = snap.data();
        const notificationId = event.params.id;

        // Cheapest checks first — bail before any Firestore reads.
        // The type-policy arm of isSmsEligible doesn't need the staff,
        // so test it directly: anything not on the urgent list is
        // push-only, period. Same with the explicit per-event skip.
        if (!ALWAYS_SMS_TYPES.has(notif.type)) return;
        if (notif.skipSms === true) return;

        const forStaff = notif.forStaff;
        if (!forStaff) return;

        // ── OWNER-ONLY type gate (2026-05-26) ──────────────────────
        // Mirror of the dispatchNotification owner-only gate. If a
        // notification with an inbox-triage type ever ends up with a
        // non-owner forStaff (it shouldn't — pollGmail only writes
        // for ids 40/41), we refuse to text them. Defense in depth
        // against any future writer that might forget the owner-only
        // contract.
        const OWNER_ONLY_SMS_TYPES = new Set([
            "email_inquiry_catering",
            "email_inquiry_complaint",
        ]);
        const OWNER_STAFF_IDS_SMS = new Set([40, 41]);
        if (OWNER_ONLY_SMS_TYPES.has(notif.type)) {
            const staffDocPre = await db.doc("config/staff").get();
            const listPre = (staffDocPre.data() || {}).list || [];
            const recipient = listPre.find((s) => s && s.name === forStaff);
            if (!recipient || !OWNER_STAFF_IDS_SMS.has(recipient.id)) {
                logger.warn(
                    `dispatchSms owner-only gate: refused type=${notif.type} for non-owner forStaff=${forStaff} (id=${recipient?.id ?? "n/a"})`
                );
                return;
            }
        }

        // Dedup — trigger may fire twice under retry pressure. Exactly-
        // once SMS semantics per notification doc.
        const alreadySent = await smsHelpers.hasExistingDeliveryLog(db, notificationId);
        if (alreadySent) {
            logger.info(`dispatchSms: ${notificationId} already has a log row, skipping (dedup)`);
            return;
        }

        // 2026-05-24 audit fix — per-recipient cooldown.
        //
        // The notificationId dedup above only catches the SAME doc retried
        // by Firestore. It does NOT catch a buggy/hostile client writing
        // N separate notifications/{} docs with the same type+forStaff in
        // rapid succession — each one a brand new SMS. Combined with the
        // public-API-key-write rule on /notifications (now locked down
        // for server-only types but still open for coverage_request,
        // urgent_announcement, etc.), this was a real cost-bomb vector.
        //
        // Cooldown: 60s per (recipient, type). Blocks rapid-fire spam but
        // allows a legitimate retry 1+ minute later. sms_delivery_logs is
        // the source of truth — checking it requires a single indexed
        // query. forceDeliver: true bypasses the cooldown (for genuine
        // urgent_announcements that need to override the throttle).
        if (notif.forceDeliver !== true) {
            try {
                const cooldownMs = 60_000;
                const since = new Date(Date.now() - cooldownMs);
                const recentSnap = await db.collection("sms_delivery_logs")
                    .where("forStaff", "==", forStaff)
                    .where("type", "==", notif.type)
                    .where("createdAt", ">", since)
                    .limit(1)
                    .get();
                if (!recentSnap.empty) {
                    logger.info(`dispatchSms: cooldown hit for ${forStaff}/${notif.type} — skipping (last sent <60s ago)`);
                    return;
                }
            } catch (e) {
                // Missing index — log and proceed. Better to send a few
                // extras than to silently drop everything if the cooldown
                // index hasn't built yet.
                logger.warn(`dispatchSms cooldown query failed (proceeding):`, e?.message);
            }
        }

        // Load staff + global settings.
        const [staffDoc, settingsDoc] = await Promise.all([
            db.doc("config/staff").get(),
            db.doc("config/sms").get(),
        ]);
        const list = (staffDoc.data() || {}).list || [];
        const staff = list.find((s) => s && s.name === forStaff);
        const settings = settingsDoc.exists ? settingsDoc.data() : {};

        // 2026-05-24 — Per-staff opt-out (same array dispatchNotification
        // checks). NONE of the ALWAYS_SMS_TYPES are in LOCKED_ON_TYPE_IDS,
        // so admin can mute any SMS-eligible type per staff. The
        // /notifications doc + the push channel still fire (subject to
        // their own gates); only the SMS is suppressed. Saves $0.0079
        // per Twilio segment per muted recipient.
        const personalOptOuts = Array.isArray(staff?.pushOptOut) ? staff.pushOptOut : [];
        if (notif.type && personalOptOuts.includes(notif.type)) {
            logger.info(`dispatchSms opt-out: ${forStaff} muted type=${notif.type}`);
            return;
        }

        const [eligible, reason] = smsHelpers.isSmsEligible(notif, staff, settings);
        if (!eligible) {
            logger.info(`dispatchSms skip: ${forStaff} type=${notif.type} reason=${reason}`);
            // We don't write a log row for ineligible — only ATTEMPTED
            // sends get logged, otherwise the table fills with noise.
            return;
        }

        // Render template.
        const language = staff.preferredLanguage === "es" ? "es" : "en";
        const vars = smsHelpers.buildSmsVars(notif);
        const body = renderSmsTemplate(notif.type, language, vars);
        if (!body) {
            logger.warn(`dispatchSms: no template for type=${notif.type}, skipping`);
            return;
        }

        // Status callback URL — Twilio POSTs delivery updates here.
        // Constructed from the function's deployed region/project. We
        // don't hardcode the URL — let env override for staging if/when
        // we have one.
        const projectId = process.env.GCLOUD_PROJECT;
        const statusCallback = projectId
            ? `https://us-central1-${projectId}.cloudfunctions.net/twilioStatusCallback`
            : undefined;

        let sid = null;
        let twilioStatus = null;
        let errorCode = null;
        let errorMessage = null;
        try {
            const res = await smsHelpers.sendTwilioSms({
                to: staff.phoneE164,
                from: TWILIO_FROM_NUMBER.value(),
                body,
                accountSid: TWILIO_ACCOUNT_SID.value(),
                authToken: TWILIO_AUTH_TOKEN.value(),
                statusCallback,
            });
            sid = res.sid;
            twilioStatus = res.status;
            logger.info(`SMS sent to ${forStaff} type=${notif.type} sid=${sid} status=${twilioStatus}`);
        } catch (e) {
            errorCode = e?.code != null ? String(e.code) : "unknown";
            errorMessage = e?.message || "twilio_error";
            logger.error(`dispatchSms FAILED for ${forStaff} type=${notif.type}:`, errorMessage);
        }

        // Always write a delivery log row — success and failure both.
        await smsHelpers.writeDeliveryLog(db, {
            notificationId,
            forStaff,
            staffId: staff.id ?? null,
            phoneE164: staff.phoneE164,
            type: notif.type,
            body,
            language,
            twilioSid: sid,
            status: sid ? (twilioStatus || "queued") : "failed",
            errorCode,
            errorMessage,
            retryCount: 0,
        });

        // Update staff record with last-send timestamp + status.
        // NOTE: staff list lives inside /config/staff.list[] (array).
        // Firestore rejects FieldValue.serverTimestamp() sentinels
        // INSIDE arrays — they're only valid on top-level fields.
        // Use a plain ISO string instead; the audit collections
        // (sms_delivery_logs) still carry the precise server time.
        try {
            await smsHelpers.updateStaffSmsState(db, forStaff, {
                smsLastSentAt: new Date().toISOString(),
                smsLastDeliveryStatus: sid ? (twilioStatus || "queued") : "failed",
                ...(errorMessage ? { smsLastFailureReason: errorMessage.slice(0, 200) } : {}),
            });
        } catch (e) {
            logger.warn(`dispatchSms staff-update failed for ${forStaff}:`, e?.message || e);
        }
    }
);

// ──────────────────────────────────────────────────────────────────────
// Twilio inbound webhook — STOP / START / HELP only
// ──────────────────────────────────────────────────────────────────────
//
// CTIA + Twilio require us to honor STOP immediately and respond to
// HELP. START re-subscribes. Anything else is logged for reference but
// does NOT get relayed into the chat — chat-to-staff communication
// stays inside the app (Andrew 2026-05-19).
//
// Configure in Twilio Console:
//   Phone Number → Messaging → A message comes in → Webhook
//     URL: https://us-central1-<project>.cloudfunctions.net/twilioInbound
//     Method: POST
//
// Twilio signs every webhook call; we verify the signature before
// trusting any payload — otherwise an attacker who guessed the URL
// could STOP/START arbitrary phone numbers.
exports.twilioInbound = onRequest(
    {
        region: "us-central1",
        secrets: [TWILIO_AUTH_TOKEN],
        cors: false,
        invoker: "public",
    },
    async (req, res) => {
        // Signature verification — protects against spoofed inbound.
        try {
            const twilio = require("twilio");
            const sig = req.header("X-Twilio-Signature") || "";
            const url = `https://${req.hostname}${req.originalUrl}`;
            const valid = twilio.validateRequest(
                TWILIO_AUTH_TOKEN.value(),
                sig,
                url,
                req.body || {},
            );
            if (!valid) {
                logger.warn("twilioInbound: invalid signature, rejecting");
                res.status(403).send("forbidden");
                return;
            }
        } catch (e) {
            logger.error("twilioInbound signature check failed:", e?.message || e);
            res.status(500).send("error");
            return;
        }

        const from = req.body?.From || "";
        const body = req.body?.Body || "";
        const sid = req.body?.MessageSid || null;
        const kind = smsHelpers.classifyInboundBody(body);

        const staff = await smsHelpers.findStaffByPhone(db, from);
        const staffName = staff?.name || null;

        // Log every inbound, regardless of kind. This is the audit
        // record — proves we received a STOP at time T.
        try {
            await db.collection("sms_inbound_events").add({
                fromE164: from,
                matchedStaff: staffName,
                staffId: staff?.id ?? null,
                body,
                kind,                       // 'stop' | 'start' | 'help' | 'other'
                isOptOut: kind === "stop",
                isOptIn: kind === "start",
                twilioSid: sid,
                receivedAt: FieldValue.serverTimestamp(),
            });
        } catch (e) {
            logger.error("sms_inbound_events write failed:", e?.message || e);
        }

        // Pick the auto-reply language. Default to English when we
        // don't know the staff.
        const lang = staff?.preferredLanguage === "es" ? "es" : "en";

        if (kind === "stop") {
            // Update the staff record to reflect the opt-out + write
            // the compliance event row. Twilio also auto-blocks future
            // sends from the same From/To pair at the carrier level,
            // but we mirror it on the staff record so our own
            // eligibility check matches what Twilio will accept.
            if (staffName) {
                // Note on the timestamp: same array-sentinel issue as
                // dispatchSms's staff update — use ISO string inside
                // /config/staff.list[]. The compliance evidence row
                // in sms_opt_in_events still gets serverTimestamp().
                await smsHelpers.updateStaffSmsState(db, staffName, {
                    smsOptIn: false,
                    smsStopped: true,
                    smsStoppedAt: new Date().toISOString(),
                });
                try {
                    await smsHelpers.writeOptInEvent(db, {
                        staffId: staff.id,
                        staffName,
                        phoneE164: from,
                        action: "opt_out",
                        source: "sms_stop_reply",
                        byName: staffName,
                        byId: staff.id ?? null,
                        twilioMessageSid: sid,
                    });
                } catch (_) { /* writeOptInEvent already logs */ }
            }
            sendTwiml(res, INBOUND_REPLIES.stop_confirm[lang]);
            return;
        }

        if (kind === "start") {
            if (staffName) {
                // Same array-sentinel rule as STOP path above.
                await smsHelpers.updateStaffSmsState(db, staffName, {
                    smsOptIn: true,
                    smsStopped: false,
                    smsOptInAt: new Date().toISOString(),
                    smsOptInBy: staffName,
                    smsOptInSource: "sms_start_reply",
                });
                try {
                    await smsHelpers.writeOptInEvent(db, {
                        staffId: staff.id,
                        staffName,
                        phoneE164: from,
                        action: "opt_in",
                        source: "sms_start_reply",
                        byName: staffName,
                        byId: staff.id ?? null,
                        twilioMessageSid: sid,
                    });
                } catch (_) {}
            }
            sendTwiml(res, INBOUND_REPLIES.start_confirm[lang]);
            return;
        }

        if (kind === "help") {
            sendTwiml(res, INBOUND_REPLIES.help[lang]);
            return;
        }

        // Anything else — acknowledge with HELP copy so the staffer
        // sees something instead of dead silence. We do NOT route
        // freeform inbound into the chat (Andrew: "on the app's chat
        // page is where they will text message each other").
        sendTwiml(res, INBOUND_REPLIES.help[lang]);
    }
);

function sendTwiml(res, message) {
    const safe = String(message || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    res.set("Content-Type", "application/xml");
    res.status(200).send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`
    );
}

// ──────────────────────────────────────────────────────────────────────
// Twilio delivery status callback
// ──────────────────────────────────────────────────────────────────────
//
// Twilio POSTs to this URL each time a message changes state
// (queued → sent → delivered, or → failed/undelivered). We use the
// MessageSid to find the matching /sms_delivery_logs row and stamp
// the latest status + timestamps.
//
// Configure in Twilio:
//   Phone Number → Messaging → Status Callback URL:
//     https://us-central1-<project>.cloudfunctions.net/twilioStatusCallback
//
// OR pass per-message via statusCallback (which dispatchSms already
// does — that way every send carries the URL even if the console
// config drifts).
exports.twilioStatusCallback = onRequest(
    {
        region: "us-central1",
        secrets: [TWILIO_AUTH_TOKEN],
        cors: false,
        invoker: "public",
    },
    async (req, res) => {
        // Signature verification — same protection as inbound.
        try {
            const twilio = require("twilio");
            const sig = req.header("X-Twilio-Signature") || "";
            const url = `https://${req.hostname}${req.originalUrl}`;
            const valid = twilio.validateRequest(
                TWILIO_AUTH_TOKEN.value(),
                sig,
                url,
                req.body || {},
            );
            if (!valid) {
                logger.warn("twilioStatusCallback: invalid signature");
                res.status(403).send("forbidden");
                return;
            }
        } catch (e) {
            logger.error("twilioStatusCallback signature check failed:", e?.message || e);
            res.status(500).send("error");
            return;
        }

        const sid = req.body?.MessageSid || null;
        const status = req.body?.MessageStatus || null;
        const errorCode = req.body?.ErrorCode || null;
        if (!sid) {
            res.status(400).send("missing MessageSid");
            return;
        }

        try {
            const snap = await db
                .collection("sms_delivery_logs")
                .where("twilioSid", "==", sid)
                .limit(1)
                .get();
            if (snap.empty) {
                // Not necessarily an error — the callback might race
                // ahead of our log write, or Twilio re-deliver an old
                // callback after we've moved on. Log + 200 so Twilio
                // doesn't retry endlessly.
                logger.info(`twilioStatusCallback: no log row for sid=${sid}, status=${status}`);
                res.status(200).send("ok");
                return;
            }
            const docRef = snap.docs[0].ref;
            const updates = {
                status,
                lastStatusAt: FieldValue.serverTimestamp(),
            };
            if (errorCode) updates.errorCode = errorCode;
            if (status === "delivered") updates.deliveredAt = FieldValue.serverTimestamp();
            await docRef.update(updates);
        } catch (e) {
            logger.error("twilioStatusCallback update failed:", e?.message || e);
            // Still 200 — we don't want Twilio retrying because we
            // had a transient Firestore hiccup. The log entry stays
            // with its prior status.
        }
        res.status(200).send("ok");
    }
);

// ── 2. Scheduled 1-hour-before-shift reminders ─────────────────────────────
// Runs every 5 minutes. Finds PUBLISHED shifts whose start is 60-65 min from
// now and writes a notification doc for each owner. Idempotency: each shift
// gets at most one reminder via the `reminderSent` flag on the shift doc.
exports.sendShiftReminders = onSchedule(
    {
        schedule: "every 5 minutes",
        timeZone: "America/Chicago", // DD Mau's business timezone
        region: "us-central1",
    },
    async (event) => {
        const now = Date.now();
        const windowStart = now + 60 * 60 * 1000; // 60 min from now
        const windowEnd = now + 65 * 60 * 1000;   // 65 min from now

        // Date range covering today and tomorrow (broad query, then filter in JS).
        const today = new Date();
        const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const dateRange = [fmt(today), fmt(tomorrow)];

        const snap = await db
            .collection("shifts")
            .where("date", "in", dateRange)
            .where("published", "==", true)
            .get();

        let reminded = 0;
        for (const sDoc of snap.docs) {
            const sh = sDoc.data();
            if (sh.reminderSent) continue;
            if (!sh.staffName || !sh.date || !sh.startTime) continue;

            const [y, mo, d] = sh.date.split("-").map(Number);
            const [hh, mm] = sh.startTime.split(":").map(Number);
            // FIX (2026-05-14): compute the actual America/Chicago UTC
            // offset for the SHIFT DATE via Intl, so reminders work
            // correctly across DST boundaries. Previously hardcoded
            // -5 (CDT), which would have made every winter (CST)
            // reminder fire 1 hour late starting in November, and
            // double-fire / skip around the spring + fall DST flips.
            //
            // Intl returns a shortOffset like "GMT-5" (CDT) or "GMT-6"
            // (CST). We parse the integer offset, plus the sign, and
            // ADD that to the wall-clock hours to get UTC.
            const probe = new Date(Date.UTC(y, mo - 1, d, 12, 0));
            const offsetParts = new Intl.DateTimeFormat("en-US", {
                timeZone: "America/Chicago",
                timeZoneName: "shortOffset",
            }).formatToParts(probe);
            const offsetLabel = offsetParts.find(p => p.type === "timeZoneName")?.value || "GMT-5";
            // "GMT-5" → -5, "GMT-6" → -6 (Chicago never +)
            const offsetMatch = /GMT([+-]?\d+)/.exec(offsetLabel);
            const ctOffsetHours = offsetMatch ? -parseInt(offsetMatch[1], 10) : 5;
            const shiftStartMs = Date.UTC(y, mo - 1, d, hh + ctOffsetHours, mm);

            if (shiftStartMs < windowStart) continue;
            if (shiftStartMs > windowEnd) continue;

            // Write the notification doc — dispatchNotification will pick it up
            // and fan out to FCM tokens.
            await db.collection("notifications").add({
                forStaff: sh.staffName,
                type: "shift_reminder_1h",
                title: "DD Mau — Shift in 1 hour",
                body: `Your shift starts at ${formatTime12h(sh.startTime)} · ${sh.location || ""}`.trim(),
                createdAt: FieldValue.serverTimestamp(),
                read: false,
                createdBy: "system",
            });
            await sDoc.ref.update({ reminderSent: true, reminderSentAt: FieldValue.serverTimestamp() });
            reminded++;
        }

        logger.info(`shift reminders: ${reminded} sent (out of ${snap.size} candidates)`);
    }
);

// ── Scheduled chat-message delivery ──────────────────────────────
// Runs every minute. Scans /scheduled_messages for docs with
// sendAt <= now AND status='pending', delivers them to the target
// chat's messages subcollection (same write shape ChatThread's
// sendMessage uses), and marks the source doc status='sent'.
//
// We don't delete the doc — keeping it around lets the user inspect
// what was sent and lets us audit if a delivery fails midway. A
// separate sweeper (purgeOldScheduledMessages, in the same file
// region — TODO when count grows) can prune docs > 30 days old.
//
// Why every minute (vs every 5 like shift reminders): scheduled
// messages are user-set deadlines — "send this at 8am" should not
// drift 5 minutes late. Cloud Scheduler minimum granularity is 1
// minute and the cost difference is negligible.
exports.sendScheduledChatMessages = onSchedule(
    {
        schedule: "every 1 minutes",
        timeZone: "America/Chicago",
        region: "us-central1",
    },
    async () => {
        const now = new Date();
        // Pull every pending doc whose sendAt has passed. We bound the
        // page size at 100 so a backlog doesn't blow up a single tick.
        const snap = await db
            .collection("scheduled_messages")
            .where("status", "==", "pending")
            .where("sendAt", "<=", now)
            .orderBy("sendAt", "asc")
            .limit(100)
            .get();

        let delivered = 0;
        for (const sDoc of snap.docs) {
            const data = sDoc.data();
            const { chatId, createdBy, createdById, payload } = data;
            if (!chatId || !createdBy || !payload || !payload.type) {
                // Malformed doc — mark error so it doesn't retry forever.
                await sDoc.ref.update({ status: "error", error: "missing fields", deliveredAt: FieldValue.serverTimestamp() }).catch(() => {});
                continue;
            }

            // 2026-05-24 audit fix — at-least-once duplicate-delivery guard.
            //
            // Without this: the function flipped status to 'sent' only AFTER
            // appending the message, denormalizing the chat preview, AND
            // fanning out N notifications. If the function instance crashed
            // / timed out / got cut at a deploy boundary anywhere in the
            // middle, the doc kept status='pending' and the next tick re-
            // ran it from the start — duplicate bubble in the thread,
            // duplicate FCM push to every recipient.
            //
            // CAS-style claim: transactionally flip status 'pending' →
            // 'delivering' BEFORE doing any side-effects. If another
            // instance got here first, the CAS fails (status is no
            // longer 'pending') and we skip the doc.
            try {
                const claimed = await db.runTransaction(async (txn) => {
                    const fresh = await txn.get(sDoc.ref);
                    if (!fresh.exists) return false;
                    if ((fresh.data() || {}).status !== "pending") return false;
                    txn.update(sDoc.ref, {
                        status: "delivering",
                        claimedAt: FieldValue.serverTimestamp(),
                    });
                    return true;
                });
                if (!claimed) {
                    logger.info(`scheduled ${sDoc.id} already claimed/sent — skipping`);
                    continue;
                }
            } catch (e) {
                logger.warn(`scheduled ${sDoc.id} claim failed:`, e?.message);
                continue;
            }

            try {
                // 1) Re-parse mentions against the CURRENT staff list so a
                //    rename / new hire between scheduling and delivery
                //    isn't missed.
                const text = String(payload.text || "");
                let mentions = [];
                try {
                    const staffSnap = await db.doc("config/staff").get();
                    const list = (staffSnap.exists && Array.isArray(staffSnap.data().list)) ? staffSnap.data().list : [];
                    mentions = parseMentionsServer(text, list);
                } catch (e) {
                    logger.warn(`mention parse failed for scheduled ${sDoc.id}:`, e);
                }

                // 2) Append the message to the chat's messages subcollection
                //    using the same shape ChatThread's sendMessage uses.
                const msgDoc = {
                    senderName: createdBy,
                    senderId: createdById || null,
                    type: payload.type,
                    text,
                    reactions: {},
                    mentions,
                    createdAt: FieldValue.serverTimestamp(),
                    scheduledSourceId: sDoc.id,
                };
                if (payload.replyTo && payload.replyTo.id) {
                    msgDoc.replyTo = {
                        id: String(payload.replyTo.id),
                        senderName: payload.replyTo.senderName || "",
                        snippet: String(payload.replyTo.snippet || "").slice(0, 120),
                        type: payload.replyTo.type || "text",
                    };
                }
                if (payload.poll && Array.isArray(payload.poll.options) && payload.poll.options.length >= 2) {
                    msgDoc.poll = payload.poll;
                }
                const ref = await db.collection("chats").doc(chatId).collection("messages").add(msgDoc);

                // 3) Denormalize chat preview + bump lastActivityAt so the
                //    chat list reorders and unread dots light up.
                const preview = payload.type === "image" ? "📷 Photo"
                    : payload.type === "video" ? "🎬 Video"
                    : payload.type === "audio" ? "🎤 Voice"
                    : payload.type === "poll" ? `📊 ${(payload.poll && payload.poll.question) || "Poll"}`
                    : text;
                await db.doc(`chats/${chatId}`).set({
                    lastMessage: {
                        text: String(preview).slice(0, 200),
                        sender: createdBy,
                        ts: FieldValue.serverTimestamp(),
                        type: payload.type,
                    },
                    lastActivityAt: FieldValue.serverTimestamp(),
                    [`lastReadByName.${createdBy}`]: FieldValue.serverTimestamp(),
                }, { merge: true });

                // 4) Fan out per-recipient notification docs (chat
                //    members minus the sender). dispatchNotification
                //    handles the actual FCM send.
                let members = [];
                try {
                    const chatSnap = await db.doc(`chats/${chatId}`).get();
                    if (chatSnap.exists && Array.isArray(chatSnap.data().members)) {
                        members = chatSnap.data().members;
                    }
                } catch (e) {
                    logger.warn(`chat members lookup failed for ${chatId}:`, e);
                }
                const chatName = (await db.doc(`chats/${chatId}`).get()).data()?.name || "Chat";
                // Carry the sender's "Notify anyway" intent FROM
                // scheduling TIME into delivery time. The client
                // stamps payload.forceDeliver=true when the sender
                // flipped the off-shift override before scheduling;
                // without honoring it here, the dispatcher would
                // re-apply the off-shift gate at delivery and could
                // silently suppress a message the sender explicitly
                // chose to send through.
                const scheduledForceDeliver = payload.forceDeliver === true;
                const recipients = members.filter(n => n && n !== createdBy);
                await Promise.all(recipients.map(async (to) => {
                    const mentioned = mentions.includes(to);
                    await db.collection("notifications").add({
                        forStaff: to,
                        type: mentioned ? "chat_mention" : "chat_message",
                        title: mentioned ? `@${createdBy} → ${chatName}` : chatName,
                        body: String(`${createdBy}: ${preview}`).slice(0, 140),
                        deepLink: "chat",
                        link: "/chat",
                        tag: `chat:${chatId}:${to}`,
                        priority: "high",
                        ...(scheduledForceDeliver ? { forceDeliver: true } : {}),
                        createdAt: FieldValue.serverTimestamp(),
                        read: false,
                        createdBy: "system",
                    }).catch(e => logger.warn(`scheduled notify failed for ${to}:`, e));
                }));

                // 5) Stamp success on the source doc.
                await sDoc.ref.update({
                    status: "sent",
                    deliveredAt: FieldValue.serverTimestamp(),
                    deliveredMessageId: ref.id,
                });
                delivered++;
            } catch (err) {
                logger.error(`scheduled delivery failed for ${sDoc.id}:`, err);
                await sDoc.ref.update({
                    status: "error",
                    error: String(err && err.message || err).slice(0, 500),
                    deliveredAt: FieldValue.serverTimestamp(),
                }).catch(() => {});
            }
        }

        logger.info(`scheduled chat messages: ${delivered} delivered (out of ${snap.size} due)`);
    }
);

// Server-side mention parser. Mirrors src/data/chat.js's parseMentions
// but stays here (Cloud Functions can't import the client module
// because the SDKs differ). Returns a string[] of resolved staff names.
function parseMentionsServer(text, staffList) {
    if (!text || typeof text !== "string") return [];
    const names = (Array.isArray(staffList) ? staffList : []).map(s => s && s.name).filter(Boolean);
    const found = new Set();
    const quoted = text.matchAll(/@"([^"]+)"/g);
    for (const m of quoted) {
        const target = names.find(n => n.toLowerCase() === m[1].toLowerCase());
        if (target) found.add(target);
    }
    const bare = text.matchAll(/@(\p{L}[\p{L}'\-]*)/gu);
    for (const m of bare) {
        const lower = m[1].toLowerCase();
        const firstNameMatch = names.find(n => n.split(" ")[0].toLowerCase() === lower);
        const fullMatch = names.find(n => n.toLowerCase() === lower);
        const target = fullMatch || firstNameMatch;
        if (target) found.add(target);
    }
    return Array.from(found);
}

// Local helper — duplicated from src/components/Schedule.jsx
function formatTime12h(time24) {
    if (!time24) return "";
    const [h, m] = time24.split(":").map(Number);
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/* ──────────────────────────────────────────────────────────────────────
 * Onboarding reminders — REMOVED (2026-05-18).
 *
 * Previously a daily scheduled function (`onboardingReminderScan`) walked
 * active hires every morning at 8am Central, computed each required doc's
 * deadline (hireDate + daysFromHire), and pushed admin notifications for
 * anything overdue or due in ≤ 3 days. Idempotency was via per-doc
 * `reminderSentDay` stamps on the hire's checklist.
 *
 * Andrew's call: drop the timer. Admins use the manual 📧 Remind button
 * (Onboarding.jsx → ReminderEmailButton) or ↻ Resend invite when they
 * decide a hire needs a nudge. Less auto-noise, fewer false alarms when
 * a federal deadline doesn't match how Andrew actually onboards.
 *
 * Existing hire records may still carry stale checklist.{docId}.reminderSentDay
 * / reminderSentAt fields from prior runs — Firestore is fine with extras;
 * no migration needed.
 */

/* ──────────────────────────────────────────────────────────────────────
 * sendDueReminders — daily check for catering orders + Toast invoices
 * with an upcoming due/promised date. Fires reminders 2 days OUT and
 * 1 day OUT to managers + owners.
 *
 * Andrew (2026-05-17): "lets also add a invoice notification where it
 * reminds us 2 days before the due time and 1 day before due time.
 * also if there is a new catering that was taken send a notification.
 * these are all for manager and admin".
 *
 * Two sources scanned:
 *   1. /cateringOrders — customer.date + customer.time is the due
 *      moment (when food needs to be ready for pickup / delivery).
 *      Status filter: ignore 'cancelled' / 'declined'. Everything else
 *      ('new', 'confirmed', 'in-progress') is in flight and
 *      worth reminding about.
 *   2. /toast_invoices — promisedDate is the equivalent "due" field
 *      (when the customer expects to pick up / receive).
 *
 * Idempotency: each (docId, kind, day) gets at most one push per day.
 * We stamp a small map onto the doc:
 *   remindersSent: { d2: 'YYYY-MM-DD', d1: 'YYYY-MM-DD' }
 * Re-running the function on the same day is a no-op for already-
 * stamped entries. A doc whose due date shifts gets re-evaluated
 * naturally on the next pass.
 *
 * Runs at 8am Central — early enough that managers see the reminders
 * before service starts but late enough not to ping mid-night.
 */
exports.sendDueReminders = onSchedule(
    {
        schedule: "0 8 * * *",
        timeZone: "America/Chicago",
        retryCount: 1,
        memory: "256MiB",
    },
    async () => {
        // Compute target dates (2 days out, 1 day out) in YYYY-MM-DD
        // anchored to Central — restaurant operates on CT.
        const tzFmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Chicago",
            year: "numeric", month: "2-digit", day: "2-digit",
        });
        const today = new Date();
        const day = (offsetDays) => {
            const d = new Date(today.getTime() + offsetDays * 86400_000);
            return tzFmt.format(d); // en-CA → YYYY-MM-DD
        };
        const todayKey = day(0);
        const in1 = day(1);
        const in2 = day(2);
        const targets = new Map([[in2, 'd2'], [in1, 'd1']]);

        // Resolve recipient list ONCE (owners + anyone with "manager"
        // or "owner" in their role). Mirror of getManagementRecipients
        // from src/data/notify.js — duplicated here so the function
        // doesn't need to pull the client module.
        const staffDoc = await db.doc('config/staff').get();
        const staffList = (staffDoc.exists ? staffDoc.data().list : []) || [];
        const managementNames = [];
        const seen = new Set();
        for (const s of staffList) {
            if (!s || !s.name || seen.has(s.name)) continue;
            const isOwner = s.id === 40 || s.id === 41;
            const roleManager = s.role && /manager|owner/i.test(s.role);
            if (isOwner || roleManager) {
                seen.add(s.name);
                managementNames.push(s.name);
            }
        }
        if (managementNames.length === 0) {
            logger.info("sendDueReminders: no management recipients, skipping");
            return;
        }

        let pinged = 0;
        let skipped = 0;

        // Helper — write notification docs for ALL management recipients
        // for a single source doc. Tag includes day key so retries
        // collapse but successive days don't.
        const fanOut = async ({ sourceColl, sourceId, type, title, body, deepLink, dayKey }) => {
            const tag = `${type}:${sourceId}:${dayKey}`;
            await Promise.all(managementNames.map(name =>
                db.collection('notifications').add({
                    forStaff: name,
                    type,
                    title,
                    body,
                    link: `/${deepLink || ''}`,
                    deepLink: deepLink || null,
                    tag,
                    createdAt: FieldValue.serverTimestamp(),
                    read: false,
                    createdBy: 'system:dueReminders',
                }).catch(e => logger.warn(`fanOut(${tag}) write failed for ${name}:`, e))
            ));
        };

        // ── Source #1: catering orders ────────────────────────────
        // Pull only orders whose customer.date is today + {0..3} days
        // — narrows the scan dramatically. customer.date is the
        // YYYY-MM-DD string used by the in-app form.
        try {
            const cateringSnap = await db.collection('cateringOrders')
                .where('customer.date', 'in', [todayKey, in1, in2, day(3)])
                .get();
            for (const oDoc of cateringSnap.docs) {
                const data = oDoc.data() || {};
                const status = (data.status || '').toLowerCase();
                if (status === 'cancelled' || status === 'declined') {
                    skipped++; continue;
                }
                const dueDate = data?.customer?.date;
                const kind = targets.get(dueDate);
                if (!kind) { skipped++; continue; }
                // Idempotency: skip if we already reminded for this
                // (kind, day) pair.
                const sent = (data.remindersSent || {})[kind];
                if (sent === todayKey) { skipped++; continue; }

                const cust = data.customer || {};
                const whenLabel = `${cust.date || ''} @ ${cust.time || ''}`.trim();
                const locLabel = cust.pickupLocation === 'maryland' ? 'Maryland' : 'Webster';
                const guests = cust.guests || '?';
                const kindLabel = kind === 'd2' ? '2 days' : 'tomorrow';
                await fanOut({
                    sourceColl: 'cateringOrders',
                    sourceId: oDoc.id,
                    type: kind === 'd2' ? 'catering_due_2d' : 'catering_due_1d',
                    title: `🥡 Catering ${kindLabel}: ${cust.name || ''}`.trim(),
                    body: `${guests} guests · ${whenLabel} · ${locLabel}`,
                    deepLink: 'catering',
                    dayKey: todayKey,
                });
                // Stamp the doc so we don't re-ping on the next run.
                await oDoc.ref.update({
                    [`remindersSent.${kind}`]: todayKey,
                });
                pinged++;
            }
        } catch (e) {
            logger.warn('sendDueReminders catering scan failed:', e);
        }

        // ── Source #2: Toast invoices ──────────────────────────────
        // promisedDate is the equivalent of "due" — when the customer
        // expects pickup/delivery. Toast writes ISO strings; we slice
        // to YYYY-MM-DD for the comparison.
        try {
            const invSnap = await db.collection('toast_invoices')
                .limit(500)
                .get();
            for (const iDoc of invSnap.docs) {
                const data = iDoc.data() || {};
                if (!data.promisedDate) { skipped++; continue; }
                const promisedKey = String(data.promisedDate).slice(0, 10);
                const kind = targets.get(promisedKey);
                if (!kind) { skipped++; continue; }
                const sent = (data.remindersSent || {})[kind];
                if (sent === todayKey) { skipped++; continue; }
                const kindLabel = kind === 'd2' ? '2 days' : 'tomorrow';
                const customerName = data.customer?.firstName
                    ? `${data.customer.firstName} ${data.customer.lastName || ''}`.trim()
                    : (data.customerName || `#${data.invoiceNumber || ''}`);
                const total = data.total != null ? `$${Number(data.total).toFixed(2)}` : '';
                const loc = data.location === 'maryland' ? 'Maryland' : 'Webster';
                await fanOut({
                    sourceColl: 'toast_invoices',
                    sourceId: iDoc.id,
                    type: kind === 'd2' ? 'invoice_due_2d' : 'invoice_due_1d',
                    title: `🧾 Invoice ${kindLabel}: ${customerName}`,
                    body: `${total ? total + ' · ' : ''}${promisedKey} · ${loc}`,
                    deepLink: 'catering',  // ToastInvoices lives inside the Catering tab
                    dayKey: todayKey,
                });
                await iDoc.ref.update({
                    [`remindersSent.${kind}`]: todayKey,
                });
                pinged++;
            }
        } catch (e) {
            logger.warn('sendDueReminders toast invoice scan failed:', e);
        }

        logger.info(`sendDueReminders: ${pinged} reminder(s) sent, ${skipped} skipped`);
    }
);

/* ──────────────────────────────────────────────────────────────────────
 * scheduledFirestoreBackup — daily managed export to Cloud Storage.
 *
 * Uses Firestore's official MANAGED EXPORT API (REST). Output lands in
 * the GCS bucket `dd-mau-staff-app-backups` under a date-stamped folder
 * (YYYY-MM-DD). Each export is queryable by gsutil and importable back
 * into Firestore via the same managed API if needed.
 *
 * Why this approach:
 *   - Built-in Firebase tooling — no third-party deps, no maintenance
 *   - Atomic, consistent — exports a snapshot of the entire DB, not a
 *     stream of best-effort gets like the npm-script backup-firestore.mjs
 *   - Importable straight back — recovery is a console click + import call
 *
 * Setup (one-time, by user):
 *   1. Create a GCS bucket named `dd-mau-staff-app-backups` in the
 *      same region as Firestore (us-central1):
 *        gcloud storage buckets create gs://dd-mau-staff-app-backups \
 *          --location=us-central1
 *   2. Grant the App Engine default service account the
 *      "Cloud Datastore Import Export Admin" role:
 *        gcloud projects add-iam-policy-binding dd-mau-staff-app \
 *          --member="serviceAccount:dd-mau-staff-app@appspot.gserviceaccount.com" \
 *          --role="roles/datastore.importExportAdmin"
 *   3. Same service account also needs Storage Admin on the bucket:
 *        gcloud storage buckets add-iam-policy-binding \
 *          gs://dd-mau-staff-app-backups \
 *          --member="serviceAccount:dd-mau-staff-app@appspot.gserviceaccount.com" \
 *          --role="roles/storage.admin"
 *   4. Deploy: firebase deploy --only functions
 *
 * Schedule: every day at 03:00 America/Chicago (off-hours, no traffic).
 * Output path: gs://dd-mau-staff-app-backups/YYYY-MM-DD/
 *
 * Recovery: from the GCP console, Firestore -> Import/Export -> pick
 * the export folder. Or via gcloud:
 *   gcloud firestore import gs://dd-mau-staff-app-backups/2026-05-10
 *
 * Cost: each export reads every doc once (~$0.06 per million reads).
 * DD Mau has ~40K docs. Cost per backup: ~$0.0024. Per month: ~$0.07.
 */
// GoogleAuth is required at the top of the file (line 28).
const PROJECT_ID = "dd-mau-staff-app";
const BACKUP_BUCKET = "dd-mau-staff-app-backups";

exports.scheduledFirestoreBackup = onSchedule(
    {
        schedule: "0 3 * * *",            // 3:00am every day
        timeZone: "America/Chicago",      // restaurant operates on Central
        retryCount: 1,
        memory: "256MiB",
    },
    async (event) => {
        const auth = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/datastore"],
        });
        const client = await auth.getClient();
        const accessToken = (await client.getAccessToken()).token;

        const today = new Date();
        const dateStr = today.getFullYear() + "-" +
                        String(today.getMonth() + 1).padStart(2, "0") + "-" +
                        String(today.getDate()).padStart(2, "0");
        const outputUriPrefix = `gs://${BACKUP_BUCKET}/${dateStr}`;

        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default):exportDocuments`;
        const body = {
            outputUriPrefix,
            // Empty array = export ALL collections.
            collectionIds: [],
        };

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            });
            const text = await res.text();
            if (!res.ok) {
                logger.error(`backup failed (${res.status}): ${text}`);
                throw new Error(`Firestore export failed: ${res.status} ${text}`);
            }
            const data = JSON.parse(text);
            logger.info(`✓ Firestore backup started: ${dateStr}`, {
                outputUriPrefix,
                operationName: data.name,
            });

            // Audit trail: write a backup_history doc so admins can see
            // when the last backup ran without checking GCP console.
            await db.collection("backup_history").add({
                date: dateStr,
                outputUriPrefix,
                operationName: data.name,
                triggeredAt: FieldValue.serverTimestamp(),
                status: "started",
                kind: "scheduled_daily",
            });
        } catch (err) {
            logger.error("scheduledFirestoreBackup failed:", err);
            // Audit the failure too so we notice silent breakage.
            try {
                await db.collection("backup_history").add({
                    date: dateStr,
                    error: String(err.message || err),
                    triggeredAt: FieldValue.serverTimestamp(),
                    status: "failed",
                    kind: "scheduled_daily",
                });
            } catch {}
            throw err;
        }
    }
);

// ── 5. Application lifecycle — expire stale + purge ───────────────────────
//
// Two-stage cleanup on the public applications collection.
//
//   STAGE 1 (90 days untouched) → flip status to 'expired'. App still
//   readable in admin's archive but stops showing in Open filter.
//
//   STAGE 2 (180 days from creation) → delete the doc entirely. PII
//   minimization: we don't keep job-application data around forever for
//   people who never got hired. Hired applicants flip into
//   /onboarding_hires before STAGE 1 fires, so their data is preserved
//   under employment-record retention rules instead.
//
// Federal note (EEOC): non-hired applicant records must be retained at
// least 1 YEAR. We're more aggressive at 180 days because:
//   (a) DD Mau has <15 employees so it's exempt from many federal
//       record-keeping rules (the bigger ones kick in at 15+)
//   (b) Admin can archive any application they want to keep BEFORE
//       180 days by converting it to a hire or marking it 'hired'
//   IF DD Mau grows past 15 employees, bump STAGE 2 to 365 days.
//
// Runs daily at 3:30am Central (after the backup at 3am).
exports.expireAndPurgeApplications = onSchedule(
    {
        schedule: "30 9 * * *", // 9:30 UTC = 3:30 Central daylight
        timeZone: "America/Chicago",
        region: "us-central1",
        // 2026-05-24 audit: was reading the entire onboarding_applications
        // collection and using Promise.all on arbitrarily-many writes —
        // would silently time out (default 60s) if a spam-flood of public
        // Apply submissions ever piled up. Bumped to the v2 max so a
        // backlog can drain over multiple days without dying mid-run.
        timeoutSeconds: 540,
        memory: "512MiB",
    },
    async () => {
        const now = Date.now();
        const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
        const ONE_EIGHTY_DAYS = 180 * 24 * 60 * 60 * 1000;
        // Cap the scan per run. With status NOT in 'hired' and ordered by
        // createdAt asc, we drain the oldest 500 first each day. If a
        // public-form attack creates >500 spam apps in one day, this
        // still slow-drains them rather than choking the function. The
        // ASC order matters — without it Firestore returns docs in
        // arbitrary order and the same junk gets scanned every day.
        const SCAN_LIMIT = 500;
        let expiredCount = 0;
        let deletedCount = 0;
        try {
            const snap = await db.collection("onboarding_applications")
                .orderBy("createdAt", "asc")
                .limit(SCAN_LIMIT)
                .get();
            // BulkWriter chunks + rate-limits internally. Way safer than
            // Promise.all for unbounded write counts — Firestore caps at
            // ~500 writes/sec and Promise.all will exceed and throw.
            const bulkWriter = db.bulkWriter();
            bulkWriter.onWriteError((err) => {
                // Retry transient errors up to 3 times. Non-transient
                // (e.g. permission denied) — give up so a poisoned doc
                // doesn't stall the whole run.
                if (err.failedAttempts < 3) return true;
                logger.warn("bulkWriter giving up on doc:", err.documentRef.path, err.message);
                return false;
            });
            snap.forEach((d) => {
                const data = d.data() || {};
                const status = data.status || "applied";
                const created = data.createdAt && data.createdAt.toMillis
                    ? data.createdAt.toMillis()
                    : (typeof data.createdAt === "string" ? Date.parse(data.createdAt) : 0);
                if (!created) return;
                const age = now - created;
                // Skip hired apps — they've graduated into /onboarding_hires.
                if (status === "hired") return;
                // STAGE 2: nuke at 180 days regardless of status.
                if (age >= ONE_EIGHTY_DAYS) {
                    bulkWriter.delete(d.ref);
                    deletedCount++;
                    return;
                }
                // STAGE 1: flip applied/screening/etc → expired at 90 days.
                const lastTouch = (data.statusUpdatedAt && Date.parse(data.statusUpdatedAt)) || created;
                const sinceTouch = now - lastTouch;
                const stuck = ["applied", "screening", "phone_screen"].includes(status);
                if (stuck && sinceTouch >= NINETY_DAYS) {
                    bulkWriter.update(d.ref, {
                        status: "expired",
                        expiredAt: new Date().toISOString(),
                        expiredReason: "untouched_90_days",
                    });
                    expiredCount++;
                }
            });
            await bulkWriter.close();
            const scanned = snap.size;
            logger.info(`application lifecycle: scanned=${scanned} expired=${expiredCount} deleted=${deletedCount} (limit=${SCAN_LIMIT})`);
            try {
                await db.collection("application_audits").add({
                    action: "lifecycle_run",
                    byAdmin: "cloud_function",
                    scanned,
                    expiredCount,
                    deletedCount,
                    at: FieldValue.serverTimestamp(),
                });
            } catch {}
        } catch (err) {
            logger.error("expireAndPurgeApplications failed", err);
            throw err;
        }
    }
);

// ── pruneAuditLogs — 2026-05-24 ──────────────────────────────────────────
// Audit log collections are append-only-by-design (Firestore rules forbid
// client delete) so they grow forever. After 2 years a single inventory
// audit collection can have ~50k docs, making the AdminPanel audit view
// slow and pushing up the daily-export backup size. This function deletes
// docs older than the per-collection retention (default 2 years) once a
// week. It uses BulkWriter for safety and caps per-collection deletes at
// 1000 per run so a long-deferred prune drains over several weeks rather
// than spiking firestore writes in one shot.
//
// IMPORTANT — TIMESTAMP FIELD NAMES VARY across audit collections:
//   - inventory_audits_*, recipe_audits, onboarding_audits, application_audits
//     and pin_audits collision rows use `at`
//   - pin_audits PIN-change rows use `changedAt`
//   - sms_delivery_logs uses `createdAt`
//   - backup_history uses a date string `date` (no proper timestamp) — skipped
// PRUNE_RULES below has one row per (collection, fieldName) pair. Add a row
// here when adding a new audit collection — otherwise it grows unchecked.
exports.pruneAuditLogs = onSchedule(
    {
        schedule: "0 4 * * 0", // Sundays 4am Central
        timeZone: "America/Chicago",
        region: "us-central1",
        timeoutSeconds: 540,
        memory: "512MiB",
    },
    async () => {
        const RETENTION_DAYS = 730; // 2 years
        const SCAN_LIMIT = 1000;    // per-collection per-run cap

        const PRUNE_RULES = [
            { coll: "pin_audits",                field: "changedAt" },
            { coll: "pin_audits",                field: "at"        },
            { coll: "inventory_audits_webster",  field: "at"        },
            { coll: "inventory_audits_maryland", field: "at"        },
            { coll: "recipe_audits",             field: "at"        },
            { coll: "onboarding_audits",         field: "at"        },
            { coll: "application_audits",        field: "at"        },
            { coll: "sms_delivery_logs",         field: "createdAt" },
            { coll: "sms_inbound_events",        field: "receivedAt" },
            { coll: "sms_opt_in_events",         field: "at"        },
            // 2026-05-24 audit fix: notifications collection grew
            // unbounded. After a year of daily chat pings × 30 staff
            // each it's tens of thousands of docs and inflates the
            // daily Firestore export. Audit rule retention is 2 years
            // (default below); notifications get a shorter 180-day
            // window since their "did this push fire?" history loses
            // forensic value much faster than PIN / recipe / inventory
            // changes do. Rendered notifications are already cached
            // in-browser; bell-history beyond 6 months has near-zero
            // operational value.
            { coll: "notifications",             field: "createdAt", retentionDays: 180 },
            // tv_crash_logs are produced by TvErrorBoundary. We want
            // RECENT crashes visible in admin (last 24h badge) but
            // don't need to keep them forever. 90 days is plenty.
            { coll: "tv_crash_logs",             field: "crashedAt", retentionDays: 90 },
        ];

        const report = [];
        let totalDeleted = 0;
        let totalErrors = 0;

        for (const rule of PRUNE_RULES) {
            // 2026-05-24: each rule can override the default 2-year
            // retention. Used for notifications (180d) and
            // tv_crash_logs (90d) — their forensic value decays much
            // faster than audit collections.
            const ruleDays = rule.retentionDays ?? RETENTION_DAYS;
            const cutoff = new Date(Date.now() - ruleDays * 24 * 60 * 60_000);
            let deleted = 0;
            let errors = 0;
            try {
                const snap = await db.collection(rule.coll)
                    .where(rule.field, "<", cutoff)
                    .orderBy(rule.field, "asc")
                    .limit(SCAN_LIMIT)
                    .get();
                if (snap.empty) {
                    report.push(`${rule.coll}[${rule.field}]: 0`);
                    continue;
                }
                const bw = db.bulkWriter();
                bw.onWriteError((err) => {
                    if (err.failedAttempts < 3) return true;
                    errors++;
                    logger.warn(`pruneAuditLogs ${rule.coll}: giving up on ${err.documentRef.path}`, err.message);
                    return false;
                });
                snap.forEach((d) => {
                    bw.delete(d.ref);
                    deleted++;
                });
                await bw.close();
                report.push(`${rule.coll}[${rule.field}]: ${deleted}${errors ? ` (${errors} err)` : ""}`);
                totalDeleted += deleted;
                totalErrors += errors;
            } catch (err) {
                // Most likely "field doesn't exist on this collection" — the
                // collection schema doesn't match this rule. Log and move on.
                logger.warn(`pruneAuditLogs ${rule.coll}[${rule.field}] failed:`, err.message);
                report.push(`${rule.coll}[${rule.field}]: ERR`);
                totalErrors++;
            }
        }

        logger.info(`pruneAuditLogs: deleted=${totalDeleted} errors=${totalErrors} | ${report.join(", ")}`);

        // Write a single audit row recording this run.
        // 2026-05-24: `cutoff` is scoped to the per-rule for-loop above
        // (each rule has its own `cutoff` derived from its retentionDays),
        // so referencing it here used to throw ReferenceError and the
        // bare-catch swallowed it — the audit row silently never wrote.
        // Compute the default-retention cutoff explicitly to match the
        // `retentionDays: RETENTION_DAYS` field stamped on the same row.
        try {
            const defaultCutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000);
            await db.collection("audit").add({
                action: "prune_audit_logs",
                byAdmin: "cloud_function",
                retentionDays: RETENTION_DAYS,
                cutoff: defaultCutoff.toISOString(),
                totalDeleted,
                totalErrors,
                breakdown: report,
                at: FieldValue.serverTimestamp(),
            });
        } catch {}
    }
);

// ── 6. I-9 reverification reminder ────────────────────────────────────────
//
// Federal I-9 requires the employer to RE-VERIFY work authorization
// before it expires (F-1 OPT, TPS, EAD-based statuses, etc.). The hire
// doc supports an optional `workAuthExpiry: 'YYYY-MM-DD'` field that
// admin sets when filling I-9 Section 2 for a hire with a time-limited
// authorization. This function pings admin 30 days before expiry so
// there's time to collect updated docs.
//
// Skips:
//   - hires with no workAuthExpiry set (US citizens, LPRs — no expiry)
//   - hires marked archived
//   - already-pinged-this-window hires (idempotent via i9ReverifyPingedFor)
//
// Runs daily at 9am Central.
exports.i9ReverificationReminder = onSchedule(
    {
        schedule: "0 14 * * *", // 14:00 UTC = 9:00 Central daylight
        timeZone: "America/Chicago",
        region: "us-central1",
    },
    async () => {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayStr = today.toISOString().slice(0, 10);

            // Pull all hires (small set) and filter in-memory.
            const snap = await db.collection("onboarding_hires").get();
            // Owners + canViewOnboarding admins receive the ping.
            // Dedupe by name — duplicate staff entries would otherwise
            // produce duplicate notification docs and the same admin
            // gets multiple pushes per event.
            const staffDoc = await db.doc("config/staff").get();
            const list = (staffDoc.data() || {}).list || [];
            const seenAdminNames = new Set();
            const admins = list.filter((s) => {
                if (!s || !s.name) return false;
                if (!(s.canViewOnboarding === true || s.id === 40 || s.id === 41)) return false;
                if (seenAdminNames.has(s.name)) return false;
                seenAdminNames.add(s.name);
                return true;
            });

            let pingedCount = 0;
            const ops = [];
            snap.forEach((d) => {
                const h = { id: d.id, ...d.data() };
                if (h.status === "archived") return;
                const exp = h.workAuthExpiry;
                if (!exp) return;
                const expDate = new Date(exp + "T00:00:00");
                const days = Math.round((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                // Ping window: 30 days out, 14 days out, 7 days out, day 0,
                // day -7 (already overdue).
                const pingDays = [30, 14, 7, 0, -7];
                if (!pingDays.includes(days)) return;
                const pingKey = `${todayStr}_d${days}`;
                if ((h.i9ReverifyPingedFor || []).includes(pingKey)) return;

                const overdue = days < 0;
                const title = overdue
                    ? `⚠ I-9 reverification ${Math.abs(days)}d OVERDUE`
                    : days === 0
                        ? `⚠ I-9 reverification due TODAY`
                        : `I-9 reverification in ${days} days`;
                const body = `${h.name || "(hire)"} — work auth ${overdue ? "expired" : "expires"} ${exp}`;

                for (const a of admins) {
                    ops.push(db.collection("notifications").add({
                        forStaff: a.name,
                        type: "i9_reverify_due",
                        title,
                        body,
                        link: "/onboarding",
                        createdAt: FieldValue.serverTimestamp(),
                        read: false,
                        createdBy: "i9ReverificationReminder",
                        hireId: h.id,
                        daysToExpiry: days,
                    }));
                }
                // Mark this ping so we don't re-fire if the function runs
                // again the same day (Cloud Scheduler typically delivers
                // once but we belt-and-suspender).
                ops.push(d.ref.update({
                    i9ReverifyPingedFor: FieldValue.arrayUnion(pingKey),
                }));
                pingedCount++;
            });
            await Promise.all(ops);
            logger.info(`i9 reverify: pinged ${pingedCount} hire(s)`);
        } catch (err) {
            logger.error("i9ReverificationReminder failed", err);
            throw err;
        }
    }
);

// ── 7. Voided check purge (90 days after hire goes Complete) ──────────────
//
// The voided check is a one-time verification artifact for direct
// deposit setup. We don't need it forever — keeping bank info around
// past payroll setup is unnecessary PII surface. Once admin marks the
// hire 'complete' (locked) and 90 days pass, drop all files under
// onboarding/{hireId}/voided_check/ from Storage. Firestore checklist
// entry stays so the audit trail is intact ("voided check submitted +
// approved on YYYY-MM-DD, files purged on YYYY-MM-DD").
//
// Conservative: only purges hires explicitly marked status='complete'.
// If admin moves them back to active or archives, we leave the files
// alone.
//
// Runs weekly Sunday 4am Central.
exports.purgeVoidedChecks = onSchedule(
    {
        schedule: "0 9 * * 0", // 9 UTC Sunday = 4 Central daylight
        timeZone: "America/Chicago",
        region: "us-central1",
    },
    async () => {
        const { getStorage } = require("firebase-admin/storage");
        const bucket = getStorage().bucket();
        const now = Date.now();
        const NINETY = 90 * 24 * 60 * 60 * 1000;
        let purgedHires = 0;
        let purgedFiles = 0;
        try {
            const snap = await db.collection("onboarding_hires")
                .where("status", "==", "complete").get();
            for (const d of snap.docs) {
                const h = d.data();
                const completedAt = h.completedAt && Date.parse(h.completedAt);
                if (!completedAt) continue;
                if (now - completedAt < NINETY) continue;
                if (h.voidedCheckPurgedAt) continue;
                const prefix = `onboarding/${d.id}/voided_check/`;
                const [files] = await bucket.getFiles({ prefix });
                if (files.length === 0) {
                    // Mark anyway so we don't re-check next week.
                    await d.ref.update({ voidedCheckPurgedAt: new Date().toISOString() });
                    continue;
                }
                await Promise.all(files.map((f) => f.delete().catch(() => null)));
                purgedFiles += files.length;
                await d.ref.update({
                    voidedCheckPurgedAt: new Date().toISOString(),
                    voidedCheckPurgedCount: files.length,
                });
                try {
                    await db.collection("onboarding_audits").add({
                        action: "voided_check_purged",
                        byAdmin: "cloud_function",
                        hireId: d.id,
                        hireName: h.name,
                        fileCount: files.length,
                        at: FieldValue.serverTimestamp(),
                    });
                } catch {}
                purgedHires++;
            }
            logger.info(`voided check purge: ${purgedFiles} file(s) across ${purgedHires} hire(s)`);
        } catch (err) {
            logger.error("purgeVoidedChecks failed", err);
            throw err;
        }
    }
);

// ── 8. 86 / out-of-stock daily push reminders ─────────────────────────────
//
// Runs three times a day (10am, 2pm, 8pm Central) to remind opted-in
// staff what's STILL out of stock on either restaurant location's 86
// board. The "still" matters — once an item is 86'd, it tends to stay
// off the menu longer than necessary because nobody remembers to flip
// it back when the new shipment lands. These pings keep the list
// top-of-mind without spamming the whole staff.
//
// Recipients: any staff with canReceive86Alerts === true on their
// /config/staff record. Admin opts staff in via the per-staff toggle
// on the Admin Panel ("🚫 86 alerts").
//
// Data shape: /ops/86_{location} = { items: [{name, status}], count,
// updatedAt }. Only items with status === 'OUT_OF_STOCK' are
// considered for the notification — low-stock items are surfaced on
// the dashboard but don't trigger the daily ping (they're an early
// warning, not a "still off the menu" reminder).
//
// Idempotency / dedup: each ping carries a stable tag of the form
// `eighty_six_alert:{slot}:{YYYY-MM-DD}` where slot ∈ {morning,
// afternoon, evening}. The OS replaces same-tag notifications so a
// retry from Cloud Scheduler can't double-ping. The dispatch path
// (dispatchNotification → FCM with data-only payload + tag) handles
// the rest.
//
// Skip rule: if BOTH locations have zero OUT_OF_STOCK items at the
// scheduled time, NO notification is sent. Pure positive-noise
// reduction — staff don't want "everything's fine" pings 3x a day.
const eightySixSchedule = async (slot, slotLabelEn, slotLabelEs) => {
    try {
        const [websterSnap, marylandSnap] = await Promise.all([
            db.doc("ops/86_webster").get(),
            db.doc("ops/86_maryland").get(),
        ]);
        const outOf = (snap) => {
            if (!snap.exists) return [];
            const items = (snap.data() || {}).items || [];
            return items
                .filter((i) => i && i.status === "OUT_OF_STOCK" && i.name)
                .map((i) => i.name);
        };
        const websterOut = outOf(websterSnap);
        const marylandOut = outOf(marylandSnap);
        const totalOut = websterOut.length + marylandOut.length;
        if (totalOut === 0) {
            logger.info(`86 alert (${slot}): nothing out at either location, skipping`);
            return;
        }
        // 2026-05-16 — Andrew: "lets make the 86 notifications have the
        // same geofence so if the staff is off they dont get a bunch of
        // 86 notifications on days off."
        //
        // Geofence-by-schedule: a staff member only receives a 86 push
        // if EITHER (a) they're an owner/admin (always get pings — they're
        // oversight, not on-the-line workers), OR (b) they have at least
        // one published shift today at any location. "Today" = America/
        // Chicago calendar date. Draft shifts don't count — they haven't
        // been released to the staffer yet.
        const todayCentral = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
        const todayShiftsSnap = await db.collection("shifts").where("date", "==", todayCentral).get();
        const onShiftToday = new Set();
        todayShiftsSnap.forEach(d => {
            const data = d.data() || {};
            if (data.staffName && data.published !== false) onShiftToday.add(data.staffName);
        });
        // Pull recipients.
        const staffDoc = await db.doc("config/staff").get();
        const list = (staffDoc.data() || {}).list || [];
        const seenNames = new Set();
        let skippedOffDuty = 0;
        const recipients = list.filter((s) => {
            if (!s || !s.name) return false;
            if (s.canReceive86Alerts !== true) return false;
            if (seenNames.has(s.name)) return false;
            seenNames.add(s.name);
            // Owners always get pings (oversight). All others: must be
            // on shift today.
            const isOwner = s.id === 40 || s.id === 41;
            if (!isOwner && !onShiftToday.has(s.name)) {
                skippedOffDuty += 1;
                return false;
            }
            return true;
        });
        if (recipients.length === 0) {
            logger.info(`86 alert (${slot}): ${totalOut} item(s) out but no on-duty recipients (${skippedOffDuty} skipped off-duty)`);
            return;
        }
        // Compose body. Format per-location with item lists so the push
        // is actionable on its own — recipient doesn't have to open the
        // app to see what's still off.
        const lines = [];
        if (websterOut.length > 0) {
            lines.push(`Webster: ${websterOut.join(", ")}`);
        }
        if (marylandOut.length > 0) {
            lines.push(`Maryland: ${marylandOut.join(", ")}`);
        }
        const title = `🚫 ${totalOut} item${totalOut === 1 ? "" : "s"} still 86'd (${slotLabelEn})`;
        const body = lines.join(" · ");
        const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD in Central
        const tag = `eighty_six_alert:${slot}:${todayStr}`;
        const ops = recipients.map((s) =>
            db.collection("notifications").add({
                forStaff: s.name,
                type: "eighty_six_alert",
                title,
                body,
                link: "/eighty6",
                tag,
                createdAt: FieldValue.serverTimestamp(),
                read: false,
                createdBy: "eightySixAlerts",
            })
        );
        await Promise.all(ops);
        logger.info(`86 alert (${slot}): pinged ${recipients.length} recipient(s), ${totalOut} item(s) out`);
    } catch (err) {
        logger.error(`eightySixAlerts(${slot}) failed`, err);
        throw err;
    }
};

// 2026-05-16 — replaced the three fixed crons with a SINGLE hourly
// trigger that reads /config/eighty_six_alerts to decide whether to fire
// at this hour. Andrew configures times via the in-app gear modal
// (Eighty6Dashboard → ⚙️). Default times when the config doc doesn't
// exist: 10am / 2pm / 8pm Central — same as the previous hardcoded set,
// so behavior is identical out-of-the-box.
//
// Why hourly instead of every-15-min: alerts only make sense on the
// hour. 24 invocations/day per function is well under Firebase's free
// tier (2M/month). Cron string "0 * * * *" runs at minute :00 of every
// hour. The function then resolves the current America/Chicago hour
// and checks the enabledHours array.
//
// Per-slot label uses a simple hour-of-day formatter rather than the
// old morning/afternoon/evening tags — the tag now includes the hour
// (e.g. "eighty_six_alert:10:2026-05-16") so different hour pings on
// the same day don't collapse on each other.
exports.eightySixAlertsHourly = onSchedule(
    { schedule: "0 * * * *", timeZone: "America/Chicago", region: "us-central1" },
    async () => {
        try {
            const cfgSnap = await db.doc("config/eighty_six_alerts").get();
            const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
            if (cfg.enabled === false) {
                logger.info("86 hourly: alerts disabled by config, skipping");
                return;
            }
            const enabledHours = Array.isArray(cfg.enabledHours) ? cfg.enabledHours : [10, 14, 20];
            // Resolve current Chicago hour. Use Intl rather than offset
            // math so DST is handled correctly.
            const fmt = new Intl.DateTimeFormat("en-US", {
                timeZone: "America/Chicago",
                hour: "numeric",
                hour12: false,
            });
            const parts = fmt.formatToParts(new Date());
            const hourPart = parts.find(p => p.type === "hour");
            const hour = hourPart ? Number(hourPart.value) : null;
            if (hour == null || !enabledHours.includes(hour)) {
                // Not a scheduled hour — silent skip.
                return;
            }
            const period = hour >= 12 ? "PM" : "AM";
            const h12 = ((hour + 11) % 12) + 1;
            const label = `${h12}${period}`;
            await eightySixSchedule(`hour_${hour}`, label, label);
        } catch (err) {
            logger.error("eightySixAlertsHourly failed", err);
            throw err;
        }
    },
);

// ── 8b. Real-time 86 alert ─────────────────────────────────────────────────
// Diffs every write to /ops/86_{location} and pushes the MOMENT a new
// item enters OUT_OF_STOCK. Complements the 3-times-daily schedule:
// scheduled pings remind staff what's STILL out, this one pings the
// instant something GOES out — so the kitchen / FOH knows in seconds,
// not hours.
//
// Dedup: tag = `eighty_six_new:{location}:{itemName}`. Same item going
// out a second time the same day → same tag → OS replaces the previous
// notification. If 3 items go out at once (a delivery shortage), the
// recipient sees them grouped because each new item gets its own tag
// but they all arrive within seconds.
//
// Idempotency: we compare BEFORE → AFTER set membership, so a write
// that doesn't actually add anything (e.g. low-stock list grew but
// 86 list unchanged) produces zero notifications.
const realtime86Handler = (location) => async (event) => {
    try {
        const before = event.data?.before;
        const after = event.data?.after;
        if (!after?.exists) return;  // doc deleted — no alert
        const beforeNames = new Set(
            ((before?.exists ? (before.data() || {}).items : []) || [])
                .filter((i) => i && i.status === "OUT_OF_STOCK" && i.name)
                .map((i) => i.name)
        );
        const afterItems = ((after.data() || {}).items || [])
            .filter((i) => i && i.status === "OUT_OF_STOCK" && i.name);
        const afterNames = new Set(afterItems.map((i) => i.name));
        const newlyOut = afterItems.filter((i) => !beforeNames.has(i.name));
        // Back-in-stock: was OUT_OF_STOCK before, isn't anymore (either
        // removed from items[] OR status flipped to something else).
        // Stored as plain names since we don't need the full item record.
        const backInStock = [...beforeNames].filter((n) => !afterNames.has(n));
        if (newlyOut.length === 0 && backInStock.length === 0) {
            return;  // no transitions either way — silently skip
        }
        // Recipients = opted-in staff. Same gate as the scheduled
        // pings so admin only manages one toggle ("🚫 86 alerts") on
        // the staff card.
        // 2026-05-16 — same on-duty filter as the scheduled hourly alert.
        // Off-duty staff don't need a real-time 86 ping. Owners (id
        // 40/41) bypass — they get pings regardless of schedule.
        const todayCentral = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
        const todayShiftsSnap = await db.collection("shifts").where("date", "==", todayCentral).get();
        const onShiftToday = new Set();
        todayShiftsSnap.forEach(d => {
            const data = d.data() || {};
            if (data.staffName && data.published !== false) onShiftToday.add(data.staffName);
        });
        const staffDoc = await db.doc("config/staff").get();
        const list = (staffDoc.data() || {}).list || [];
        const seenNames = new Set();
        let skippedOffDuty = 0;
        const recipients = list.filter((s) => {
            if (!s || !s.name) return false;
            if (s.canReceive86Alerts !== true) return false;
            if (seenNames.has(s.name)) return false;
            seenNames.add(s.name);
            const isOwner = s.id === 40 || s.id === 41;
            if (!isOwner && !onShiftToday.has(s.name)) {
                skippedOffDuty += 1;
                return false;
            }
            return true;
        });
        if (recipients.length === 0) {
            logger.info(`real-time 86 (${location}): ${newlyOut.length} new + ${backInStock.length} back, no on-duty recipients (${skippedOffDuty} skipped off-duty)`);
            return;
        }
        const locLabel = location === "webster" ? "Webster" : "Maryland Heights";
        // One push per recipient per item — keeps the per-item tag
        // useful (item resurrected + re-86'd swaps the same tag, no
        // stacking). For mass shortages (3+ items at once), we fan
        // them out so the user sees each one rather than a single
        // collapsed "3 items" toast that hides what they are.
        //
        // SHARED tag between "going out" and "back in stock" for the
        // same item — `eighty_six:{location}:{itemName}` — so the OS
        // replaces a stale "🚫 86" toast with the fresh "✅ back" toast
        // when the same item comes back. Staff phone never shows
        // contradictory toasts side-by-side.
        const ops = [];
        for (const item of newlyOut) {
            for (const r of recipients) {
                ops.push(db.collection("notifications").add({
                    forStaff: r.name,
                    type: "eighty_six_new",
                    title: `🚫 86: ${item.name}`,
                    body: `Just went out at ${locLabel}.`,
                    link: "/eighty6",
                    tag: `eighty_six:${location}:${item.name}`,
                    createdAt: FieldValue.serverTimestamp(),
                    read: false,
                    createdBy: "realtime86Alert",
                }));
            }
        }
        for (const name of backInStock) {
            for (const r of recipients) {
                ops.push(db.collection("notifications").add({
                    forStaff: r.name,
                    type: "eighty_six_back",
                    title: `✅ Back in stock: ${name}`,
                    body: `${locLabel} can sell ${name} again.`,
                    link: "/eighty6",
                    tag: `eighty_six:${location}:${name}`,
                    createdAt: FieldValue.serverTimestamp(),
                    read: false,
                    createdBy: "realtime86Alert",
                }));
            }
        }
        await Promise.all(ops);
        logger.info(`real-time 86 (${location}): pinged ${recipients.length} recipient(s) — ${newlyOut.length} newly out, ${backInStock.length} back in stock`);
    } catch (err) {
        logger.error(`realtime86Handler(${location}) failed`, err);
    }
};

exports.realtime86Webster = onDocumentWritten(
    { document: "ops/86_webster", region: "us-central1" },
    realtime86Handler("webster"),
);

exports.realtime86Maryland = onDocumentWritten(
    { document: "ops/86_maryland", region: "us-central1" },
    realtime86Handler("maryland"),
);

// ── Toast Orders sync trigger ──────────────────────────────────────────────
// The Toast orders scraper on Railway watches `ops/orders_trigger` for
// timestamp changes and fetches fresh orders whenever the field updates.
//
// Previously the trigger was only written by ToastOrders.jsx every 60s
// while that tab was open. The moment no client had the tab open
// (closing time, all staff signed out, phones locked), the trigger
// stopped firing and orders stopped syncing — which is exactly what
// Andrew hit at 5pm on 2026-05-16: last order showed at 5, scraper
// went idle the moment the orders tab closed.
//
// This cron writes the trigger every minute regardless of clients so
// the scraper keeps a steady drumbeat all day. If the scraper itself
// is also down (Railway service stopped / OAuth expired) this
// function still runs but no orders show up — symptom that says
// "go restart the Railway service / refresh the Toast token."
//
// Cost: ~43,200 invocations/month. Firebase Cloud Functions free tier
// is 2M invocations/month so this stays free.
//
// Scheduler region must be us-central1 (App Engine default) — the
// scheduler v2 only runs in regions with App Engine app configured.
exports.triggerOrdersSync = onSchedule(
    {
        schedule: "every 1 minutes",
        timeZone: "America/Chicago",
        region: "us-central1",
    },
    async () => {
        try {
            await db.doc("ops/orders_trigger").set({
                triggeredAt: FieldValue.serverTimestamp(),
                triggeredBy: "cloud_function_cron",
            }, { merge: true });
        } catch (err) {
            logger.error("triggerOrdersSync failed", err);
        }
    },
);

// ── 5. translateMessage — on-demand chat message translation ─────────────
// HTTPS callable. The chat thread shows a small "🌐 Translate" link under
// each non-own message; tapping it calls this function which:
//
//   1. Picks the text to translate. Caller passes `{chatId, messageId,
//      targetLang}` for cached path (we read the message from Firestore
//      and persist the translation back), or `{text, targetLang}` for a
//      one-shot ad-hoc translation without persistence.
//   2. Hits Google Cloud Translation v2 REST endpoint with an
//      Application-Default-Credentials access token (google-auth-library
//      handles the metadata server lookup on Cloud Functions — no API key
//      to manage, no service account JSON to commit).
//   3. If chatId/messageId provided, writes
//        translations.{targetLang} = translatedText
//        sourceLang = detectedSource
//      onto the message doc so the next viewer sees the cached translation
//      instantly without re-billing the API.
//   4. Returns {translatedText, sourceLang, cached}.
//
// Why server-side (vs calling Translate from the browser):
//   • Browser would need an API key shipped in client code → quota theft.
//   • Cloud Functions run on a service account → ADC token, no secret.
//   • Persisting the translation requires admin SDK access anyway.
//
// Why v2 REST (not @google-cloud/translate npm pkg):
//   • One less heavy dep. The REST surface is two endpoints.
//   • Auth via google-auth-library which we already have for ops scripts.
//
// One-time GCP setup BEFORE this works:
//   1. Enable the "Cloud Translation API" on the dd-mau-staff-app GCP project
//      (Console → APIs & Services → Library → Cloud Translation API).
//   2. Grant the default compute service account
//      (PROJECT_NUMBER-compute@developer.gserviceaccount.com) the
//      "Cloud Translation API User" role on the project. Cloud Functions
//      v2 uses the compute SA by default, so this is the right principal.
//   3. Verify Blaze plan is active (translation API requires billing
//      account; first 500K chars/month are free, then ~$20 per million).
//
// Throughput / cost (DD Mau scale):
//   ~20-50 messages/day need translation × ~120 chars avg = under 200K
//   chars/month. Stays inside the free tier with margin. Cached on the
//   message doc so re-views of the same message cost nothing.
// Per-IP rate limit shared across HTTPS callable functions. Without
// Firebase Auth wired (Phase 2), we can't tie a call to a specific
// staff member — but we can cap how many calls a single IP can make
// in a rolling window so a scripted attacker can't drain quota or
// brute-force a sensitive endpoint.
//
// Counter doc lives at /rate_limits/{namespace}_{ipHash}_{bucket}. We
// hash the IP (so it's not stored raw) and bucket by the window so
// the doc resets itself naturally — no GC needed. Best-effort: if the
// rate-limit read or write fails (Firestore unavailable, etc.) we let
// the call through. Defense-in-depth, not a guarantee.
//
// Usage:
//   await enforceRateLimit({ ip, namespace: 'translate', limit: 60, windowMs: 5*60_000 });
async function enforceRateLimit({ ip, namespace, limit: maxCount, windowMs }) {
    if (!ip) return; // unknown IP — let through; nothing to throttle against
    try {
        const crypto = require("crypto");
        const ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
        const bucket = Math.floor(Date.now() / windowMs);
        const docId = `${namespace}_${ipHash}_${bucket}`;
        const ref = db.doc(`rate_limits/${docId}`);
        const snap = await ref.get();
        const cur = snap.exists ? (snap.data().count || 0) : 0;
        if (cur >= maxCount) {
            throw new HttpsError(
                "resource-exhausted",
                `Rate limit reached — try again in a few minutes.`,
            );
        }
        // Increment via merge so two simultaneous calls don't lose the bump.
        // FieldValue.increment is atomic at the Firestore layer.
        await ref.set({
            count: FieldValue.increment(1),
            expiresAt: FieldValue.serverTimestamp(),
        }, { merge: true });
    } catch (e) {
        if (e instanceof HttpsError) throw e;
        logger.warn(`rate-limit check (${namespace}) failed (allowing through):`, e);
    }
}

// Convenience wrapper preserving the old name + the translateMessage
// signature. Limit: 60 requests per 5-minute window.
async function checkTranslateRateLimit(ip) {
    return enforceRateLimit({
        ip,
        namespace: "translate",
        limit: 60,
        windowMs: 5 * 60_000,
    });
}

// ── validateOnboardingInvite ─────────────────────────────────────
// Server-side token validation for the new-hire onboarding portal.
// Replaces the client-side `getDoc('/onboarding_invites/{token}')`
// pattern (AUDIT SEC-004) so an attacker who has a leaked invite URL
// cannot enumerate other tokens via DevTools.
//
// What this gives us today:
//   • Per-IP rate limit (10 attempts / 10 min) → token brute-force
//     becomes impractical
//   • Server-side validation of expiresAt → no client-tampering
//   • Centralized audit log row for every portal access
//   • Same admin-SDK path the function uses already — when the
//     Firestore rules tighten to `allow get: if false` on
//     /onboarding_invites + /onboarding_hires (Phase B, requires
//     migrating admin reads too), the portal flow keeps working
//     unchanged.
//
// What's still open after this fix:
//   • Direct Firestore reads of /onboarding_invites + /onboarding_hires
//     remain permitted by the catch-all rule (admin UI uses them).
//     Closing that requires moving admin reads through Cloud Functions
//     as well — see AUDIT SEC-004 for the roadmap.
//   • Storage paths under /onboarding/{hireId}/... still resolvable
//     by anyone who knows a hireId.
//
// Input:  { token: string }
// Output: { hireId, hire: <sanitized hire fields> }
exports.validateOnboardingInvite = onCall(
    { region: "us-central1", cors: true, maxInstances: 10 },
    async (request) => {
        const ip = request.rawRequest?.ip
            || request.rawRequest?.headers?.["x-forwarded-for"]?.split(",")[0]
            || null;
        await enforceRateLimit({
            ip,
            namespace: "onboard_invite",
            limit: 10,
            windowMs: 10 * 60_000,
        });

        const token = String(request.data?.token || "").trim();
        if (!token || token.length < 8) {
            throw new HttpsError("invalid-argument", "Token required.");
        }

        const invRef = db.doc(`onboarding_invites/${token}`);
        const invSnap = await invRef.get();
        if (!invSnap.exists) {
            // Don't reveal whether the token never existed vs expired —
            // same error message for both reduces information leakage
            // about valid token shapes.
            throw new HttpsError("not-found", "This invite link is invalid or has expired.");
        }
        const inv = invSnap.data() || {};
        if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) {
            throw new HttpsError("not-found", "This invite has expired. Ask your manager for a new link.");
        }

        const hireId = inv.hireId;
        if (!hireId) {
            throw new HttpsError("internal", "Invite is missing hire reference.");
        }
        const hireRef = db.doc(`onboarding_hires/${hireId}`);
        const hireSnap = await hireRef.get();
        if (!hireSnap.exists) {
            throw new HttpsError("not-found", "Hire record missing. Ask your manager.");
        }
        const hire = { id: hireSnap.id, ...hireSnap.data() };

        // Mark invite as opened on first access. Non-blocking;
        // function still returns hire data even if this write fails.
        if (!inv.used) {
            invRef.update({
                used: true,
                openedAt: new Date().toISOString(),
            }).catch((e) => logger.warn("invite open-mark failed:", e));
        }

        // Audit every portal access — useful for later "who accessed
        // this hire's data and when" investigations. Stored on the
        // hire's own audit collection (already exists for admin views).
        try {
            await db.collection("onboarding_audits").add({
                action: "portal.access",
                hireId,
                token,
                ip: ip ? require("crypto").createHash("sha256").update(ip).digest("hex").slice(0, 16) : null,
                userAgent: request.rawRequest?.headers?.["user-agent"] || null,
                createdAt: FieldValue.serverTimestamp(),
            });
        } catch (e) {
            // Non-fatal — audit miss shouldn't block legit hire access.
            logger.warn("onboarding portal audit write failed:", e);
        }

        return { hireId, hire };
    },
);

// ── aiSearch ───────────────────────────────────────────────────────
// Semantic search via Anthropic Claude. The client posts a free-text
// query plus a list of items (id + name + category + subcategory)
// and gets back the IDs that semantically match — useful for things
// the substring matcher misses, e.g. "dry" → spices/rice/noodles,
// "things for pho" → beef bones, rice noodles, star anise, mint, lime.
//
// Why a server function (and not direct from the client): the API
// key has to live somewhere not-the-client-bundle. We also benefit
// from shared rate-limiting + a single audit-able call surface.
//
// Cost: input ~5-8K tokens for DD Mau's full inventory, output ~50
// tokens. Claude Haiku-class pricing puts each call around $0.001-
// $0.002. Even with heavy use the spend is dollars per month.
exports.aiSearch = onCall(
    {
        region: "us-central1",
        cors: true,
        maxInstances: 5,
        secrets: [ANTHROPIC_API_KEY],
    },
    async (request) => {
        // Same IP rate-limit shape as translateMessage.
        const ip = request.rawRequest?.ip
            || request.rawRequest?.headers?.["x-forwarded-for"]?.split(",")[0]
            || null;
        await enforceRateLimit({
            ip,
            namespace: "aiSearch",
            limit: 60,
            windowMs: 5 * 60_000,
        });

        const data = request.data || {};
        const query = String(data.query || "").trim();
        const items = Array.isArray(data.items) ? data.items : [];
        if (!query) throw new HttpsError("invalid-argument", "query required");
        if (items.length === 0) {
            return { matchingIds: [], note: "no items" };
        }
        if (query.length > 200) {
            throw new HttpsError("invalid-argument", "query too long");
        }
        if (items.length > 2000) {
            // Cost guard. DD Mau's inventory is < 500 items; anything
            // bigger is misuse.
            throw new HttpsError("invalid-argument", "too many items in one call");
        }

        // Build a compact "items dossier" for the LLM. Format:
        //   id=<id> name=<name> cat=<category> sub=<subcat>
        // Truncated fields keep the prompt under the model's
        // efficient input window. We DON'T include vendor / price /
        // pack — they confuse semantic matching without adding signal.
        const dossier = items.map(it => {
            const id = String(it.id || "").slice(0, 32);
            const name = String(it.name || "").slice(0, 80);
            const cat = String(it.category || "").slice(0, 40);
            const sub = String(it.subcat || "").slice(0, 40);
            return `id=${id} name=${name} cat=${cat} sub=${sub}`;
        }).join("\n");

        // System prompt — directly tells Claude what to do, with
        // examples to anchor the matching style.
        const system = [
            "You are a search assistant for a restaurant inventory list.",
            "Given a free-text query and a list of items (id, name, category, subcategory), return the IDs of items that semantically match.",
            "",
            "Match generously — include items related, similar, or commonly grouped with the query term, even if the literal word does NOT appear.",
            "",
            "Examples:",
            '- "dry" → spices, dried herbs, rice, noodles, beans, vinegar, soy sauce, fish sauce',
            '- "green" → green vegetables (green onion, green beans, broccoli, cilantro, mint, basil, lettuce, cabbage)',
            '- "things for pho" → beef bones, beef brisket, rice noodles, star anise, white onion, ginger, lime, mint, basil, hoisin, sriracha',
            '- "spicy" → jalapeño, sriracha, chili oil, gochujang, hot sauce, sambal',
            '- "vegan" → tofu, vegan chicken, vegan beef, vegan shrimp, plant-based items',
            "",
            "Respond with ONLY a JSON array of matching item IDs. No prose, no explanation, no markdown code fences.",
            'Format: ["1-0", "2-3", "5-7"]',
            "",
            "If nothing matches, respond with: []",
        ].join("\n");

        const userMessage = `Query: ${JSON.stringify(query)}\n\nItems:\n${dossier}`;

        // Call Anthropic Messages API.
        let body;
        try {
            const resp = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": ANTHROPIC_API_KEY.value(),
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    // Claude Haiku-class — fast + cheap. If this model
                    // name 404s, set the secret to point at whichever
                    // current Haiku-class model is live (e.g. haiku-4-5,
                    // haiku-3-5, etc.). The model is encoded here, not
                    // in a secret, so a rename means a one-line code
                    // change + redeploy.
                    model: "claude-haiku-4-5",
                    max_tokens: 1024,
                    system,
                    messages: [{ role: "user", content: userMessage }],
                }),
            });
            if (!resp.ok) {
                const errText = await resp.text();
                logger.error("anthropic API error", resp.status, errText.slice(0, 500));
                throw new HttpsError("internal", `anthropic failed: ${resp.status}`);
            }
            body = await resp.json();
        } catch (e) {
            if (e instanceof HttpsError) throw e;
            logger.error("aiSearch fetch failed:", e?.message || e);
            throw new HttpsError("unavailable", "ai search unavailable");
        }

        // Parse Claude's response. Expected shape:
        //   { content: [{ type: 'text', text: '["1-0", "2-3"]' }], ... }
        const textBlock = (body?.content || []).find(c => c?.type === "text");
        const raw = textBlock?.text || "";
        let matchingIds = [];
        try {
            // Be permissive with the parse — Claude usually returns
            // a clean JSON array, but if it sneaks in a code fence or
            // a "Here's the result:" preamble, fall back to extracting
            // the first array-shaped substring.
            const trimmed = raw.trim().replace(/^```(?:json)?\n?/i, "").replace(/```$/i, "").trim();
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                matchingIds = parsed.map(String).slice(0, 500);
            }
        } catch {
            const bracketed = raw.match(/\[[^\]]*\]/);
            if (bracketed) {
                try {
                    const parsed = JSON.parse(bracketed[0]);
                    if (Array.isArray(parsed)) {
                        matchingIds = parsed.map(String).slice(0, 500);
                    }
                } catch {
                    logger.warn("aiSearch: could not parse model output:", raw.slice(0, 200));
                }
            }
        }

        // Filter to ids that were actually in the request — guards
        // against the model hallucinating extra ids.
        const validIds = new Set(items.map(it => String(it.id)));
        matchingIds = matchingIds.filter(id => validIds.has(id));

        return {
            matchingIds,
            queryLen: query.length,
            itemsCount: items.length,
        };
    }
);

// ── 2026-05-20 — aiFixText: spelling + grammar helper for chat ────
// Andrew: "make the staff chat page text bar have ai to help with
// spelling and grammer too". Takes a draft message + optional
// language hint, returns the same text with spelling / grammar /
// basic clarity issues fixed. Tone-preserving — does NOT rewrite
// for style, doesn't formalize casual messages, doesn't add words
// that change the meaning. Caps text length at 1000 chars (chat
// messages aren't novels) and rate-limits per IP same as aiSearch.
// Cost: ~$0.0005-$0.001 per fix at Haiku rates.
exports.aiFixText = onCall(
    {
        region: "us-central1",
        cors: true,
        maxInstances: 5,
        secrets: [ANTHROPIC_API_KEY],
    },
    async (request) => {
        const ip = request.rawRequest?.ip
            || request.rawRequest?.headers?.["x-forwarded-for"]?.split(",")[0]
            || null;
        await enforceRateLimit({
            ip,
            namespace: "aiFixText",
            limit: 120,
            windowMs: 5 * 60_000,
        });

        const data = request.data || {};
        const text = String(data.text || "").trim();
        const language = String(data.language || "").trim().toLowerCase();
        if (!text) throw new HttpsError("invalid-argument", "text required");
        if (text.length > 1000) {
            throw new HttpsError("invalid-argument", "text too long (max 1000 chars)");
        }

        // System prompt — kept terse and example-anchored. The key
        // constraint is "preserve voice" so a casual "lol im on my way"
        // doesn't come back as "I am en route." The model is told to
        // return ONLY the fixed text — no commentary, no quote marks,
        // no "Here's the fix:" preamble.
        const langLine = language === "es"
            ? "The text is in Spanish. Keep it in Spanish."
            : language === "en"
                ? "The text is in English. Keep it in English."
                : "Detect the language and keep the output in the SAME language as the input. Do not translate.";
        const system = [
            "You are a chat-message spelling and grammar helper for restaurant staff.",
            "Fix spelling, capitalization, punctuation, and clear grammar mistakes.",
            "PRESERVE the writer's voice and tone — casual stays casual, terse stays terse, slang stays slang.",
            "Do NOT add new information, do NOT rewrite for style, do NOT formalize informal messages.",
            "Keep emojis and @-mentions exactly as written.",
            "Keep line breaks where the writer placed them.",
            langLine,
            "",
            "If the input is already correct, return it UNCHANGED.",
            "Respond with ONLY the fixed text. No prose, no commentary, no quotation marks around the result, no markdown.",
        ].join("\n");

        let body;
        try {
            const resp = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": ANTHROPIC_API_KEY.value(),
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: "claude-haiku-4-5",
                    max_tokens: 1500,
                    system,
                    messages: [{ role: "user", content: text }],
                }),
            });
            if (!resp.ok) {
                const errText = await resp.text();
                logger.error("aiFixText anthropic error", resp.status, errText.slice(0, 500));
                throw new HttpsError("internal", `anthropic failed: ${resp.status}`);
            }
            body = await resp.json();
        } catch (e) {
            if (e instanceof HttpsError) throw e;
            logger.error("aiFixText fetch failed:", e?.message || e);
            throw new HttpsError("unavailable", "ai fix unavailable");
        }

        const textBlock = (body?.content || []).find(c => c?.type === "text");
        let fixed = String(textBlock?.text || "").trim();
        // Strip code fences or accidental wrapping quotes — defense
        // against the model adding "Here is the fix:" or backticks.
        fixed = fixed.replace(/^```[\w]*\n?/i, "").replace(/```$/i, "").trim();
        // Strip a single wrapping pair of double quotes if the model
        // wrapped the result. Don't strip quotes inside the text.
        if (fixed.length >= 2 && fixed.startsWith('"') && fixed.endsWith('"')) {
            const inner = fixed.slice(1, -1);
            if (!inner.includes('"')) fixed = inner;
        }
        if (!fixed) fixed = text; // fail-safe: never return empty

        const changed = fixed !== text;
        return { fixed, changed, originalLength: text.length, fixedLength: fixed.length };
    }
);

// ── 2026-05-20 — checkTvHeartbeats: alert when a menu TV goes dark ─
// Andrew Wave 7 of "match the SaaS leaders". Every kiosk browser
// (MenuDisplay) writes a heartbeat to /tv_heartbeats/{tvId} every
// minute via setDoc + serverTimestamp. This function runs every
// 5 minutes, finds heartbeats that haven't ticked in >10 min, and
// fires a notification (FCM + SMS if configured) once per outage.
//
// We also stamp `alertedAt` on the heartbeat doc so the same outage
// doesn't re-fire every 5 minutes — only one ping per stretch of
// offline time. When a TV comes back online (heartbeat resumes),
// `alertedAt` is cleared so the NEXT outage will alert again.
//
// Recipients: staff with canReceiveTvOfflineAlerts === true on
// their /config/staff.list[] record. Falls back to admin (40, 41)
// if no opt-in flags are set, so the alert never silently no-ops.
exports.checkTvHeartbeats = onSchedule(
    {
        schedule: "every 5 minutes",
        timeZone: "America/Chicago",
        region: "us-central1",
    },
    async (event) => {
        // ── 2026-05-24 — Feature flag gate ────────────────────────────
        // Andrew turned TV offline alerts OFF while still rolling the
        // kiosk fleet out across the two restaurants. Every time he
        // unplugs a Pi to carry it from his house to a TV, the
        // heartbeat goes stale and this used to fire a 📴 push to his
        // phone — pure noise during deployment.
        //
        // To re-enable: set /config/feature_flags.tvOfflineAlertsEnabled
        // = true (Firebase Console → Firestore → config/feature_flags).
        // No redeploy needed. Default behavior with the flag missing or
        // false is SILENT — the function runs to completion (so the
        // Cloud Scheduler doesn't error) but writes no notifications.
        //
        // Fail-closed: if the flag read itself fails (network, perms),
        // we also skip — better to miss an alert than to spam when we
        // can't tell whether the user wants alerts on.
        try {
            const flagSnap = await db.doc("config/feature_flags").get();
            const enabled = flagSnap.exists &&
                flagSnap.data()?.tvOfflineAlertsEnabled === true;
            if (!enabled) {
                logger.info("checkTvHeartbeats: tvOfflineAlertsEnabled is false — skipping");
                return;
            }
        } catch (e) {
            logger.warn("checkTvHeartbeats: feature flag read failed:", e?.message);
            return;
        }

        const STALE_MS = 10 * 60_000;   // 10 min = "TV is dark"
        const now = Date.now();

        // 2026-05-24 audit fix: was reading EVERY heartbeat doc every 5 min.
        // Retired TVs stay in the collection forever (rules forbid client
        // delete). Scoped to the last 1 hour — anything older than that has
        // already been alerted on (alertedAt is set) so we have nothing new
        // to do for it. Cuts read cost from O(all-TVs-ever) to O(active+
        // recently-stale) per 5-min run. We do a second query for any TVs
        // with alertedAt set so we can fire `tv_back_online` if they
        // recovered — that's bounded by however many TVs are actively
        // alerted (almost always 0–3 in a healthy fleet).
        const lookbackMs = now - 60 * 60_000;   // 1 hour
        const recentSnap = await db.collection("tv_heartbeats")
            .where("lastSeenAt", ">", new Date(lookbackMs))
            .get();
        const alertedSnap = await db.collection("tv_heartbeats")
            .where("alertedAt", "!=", null)
            .get();
        // Dedup — a doc can match both queries.
        const seenIds = new Set();
        const docs = [];
        for (const d of recentSnap.docs) {
            if (!seenIds.has(d.id)) { seenIds.add(d.id); docs.push(d); }
        }
        for (const d of alertedSnap.docs) {
            if (!seenIds.has(d.id)) { seenIds.add(d.id); docs.push(d); }
        }
        const snap = { empty: docs.length === 0, size: docs.length, docs };
        if (snap.empty) {
            logger.info("checkTvHeartbeats: no heartbeats in last hour + no active alerts");
            return;
        }

        // Load staff once to resolve recipients.
        let recipients = [];
        try {
            const staffSnap = await db.doc("config/staff").get();
            const staffList = Array.isArray(staffSnap.data()?.list)
                ? staffSnap.data().list : [];
            recipients = staffList.filter(s => s?.canReceiveTvOfflineAlerts === true && s?.name);
            // Fallback: admin IDs 40 + 41 (Andrew + Julie) so the
            // alert never silently no-ops before anyone opts in.
            if (recipients.length === 0) {
                recipients = staffList.filter(s => s?.id === 40 || s?.id === 41);
            }
        } catch (e) {
            logger.warn("checkTvHeartbeats: could not load staff:", e?.message);
        }

        let alerted = 0;
        let recovered = 0;
        for (const hbDoc of snap.docs) {
            const hb = hbDoc.data() || {};
            const tvId = hbDoc.id;
            const lastSeenMs = hb.lastSeenAt?.toMillis
                ? hb.lastSeenAt.toMillis()
                : (hb.lastSeenAt?.seconds ? hb.lastSeenAt.seconds * 1000 : 0);
            const ageMs = lastSeenMs ? (now - lastSeenMs) : Infinity;
            const isStale = ageMs > STALE_MS;
            const alertedAt = hb.alertedAt?.toMillis ? hb.alertedAt.toMillis() : 0;

            if (isStale && !alertedAt) {
                // Going offline — fire one notification per recipient.
                const ageMin = Math.round(ageMs / 60_000);
                for (const r of recipients) {
                    try {
                        await db.collection("notifications").add({
                            type: "tv_offline",
                            forStaff: r.name,
                            title: `📴 TV offline: ${tvId}`,
                            body: `${tvId} hasn't reported in ${ageMin} min. Reboot the Fire TV or check the kiosk browser.`,
                            createdAt: FieldValue.serverTimestamp(),
                            read: false,
                            details: { tvId, ageMin },
                        });
                    } catch (e) {
                        logger.warn("tv_offline notification write failed:", r.name, e?.message);
                    }
                }
                await hbDoc.ref.set({
                    alertedAt: FieldValue.serverTimestamp(),
                    lastOutageAgeMin: ageMin,
                }, { merge: true });
                alerted += 1;
                logger.info(`checkTvHeartbeats: alerted on ${tvId} (${ageMin} min stale)`);
            } else if (!isStale && alertedAt) {
                // Recovery — TV is reporting again. Clear the alert
                // stamp so the NEXT outage will alert.
                for (const r of recipients) {
                    try {
                        await db.collection("notifications").add({
                            type: "tv_back_online",
                            forStaff: r.name,
                            title: `🟢 TV back online: ${tvId}`,
                            body: `${tvId} is reporting again.`,
                            createdAt: FieldValue.serverTimestamp(),
                            read: false,
                            details: { tvId },
                        });
                    } catch (e) {
                        logger.warn("tv_back_online notification write failed:", r.name, e?.message);
                    }
                }
                await hbDoc.ref.set({
                    alertedAt: FieldValue.delete(),
                    lastOutageAgeMin: FieldValue.delete(),
                }, { merge: true });
                recovered += 1;
                logger.info(`checkTvHeartbeats: ${tvId} recovered`);
            }
        }
        logger.info(`checkTvHeartbeats: alerted=${alerted} recovered=${recovered} totalHeartbeats=${snap.size}`);
    }
);

// ── 2026-05-23 — syncToastMenuStatus REMOVED ─────────────────────
// What was here: a 5-min scheduled Cloud Function that called the
// Toast Connect partner API (POST /authentication/v1/authentication/login,
// GET /stock/v1/inventory, GET /menus/v2/menus) to pull OOS items and
// merge them into /ops/86_<location>.
//
// Why deleted: it was a duplicate. The Railway scraper pipeline already
// writes /ops/86_<location> by scraping toasttab.com directly with the
// staff Toast login (TOAST_EMAIL + TOAST_PASSWORD on Railway). The
// Cloud Function 401'd in production for an hour while we debugged —
// turned out it never needed to run. The Railway pipeline was always
// doing the actual work.
//
// Architectural note for next time: BEFORE adding a "pull from
// Toast" path here, check whether the Railway scraper already
// owns it. /ops/86_*, /ops/labor_*, /ops/orders_*, staff lists,
// menu attribution — all of those are Railway's job. Cloud Functions
// is for: Firestore triggers (push notifications, fan-out, audit),
// scheduled cleanups, callable AI endpoints. Not for scraping/polling
// external POS systems.
//
// If you ever want to re-add a Cloud Function path here: git log
// will show the deleted code, but it's redundant — extend the Railway
// scraper instead.

// ── 2026-05-20 — aiExtractMenu: PDF/image → structured menu data ──
// Andrew: "if the menu comes in as pdf or jpeg how can you make
// edits". The client uploads a PDF/JPEG to Storage (handled by
// menuImageUpload.js — PDFs are split into one PNG per page) and
// then calls this function with the list of image URLs. We fetch
// each image, base64-encode it, send the lot to Claude with vision,
// and parse a structured menu JSON back. The client shows the
// result in a review UI and writes the accepted items to the
// /menu_items overrides collection.
//
// Cost: Claude Haiku-class with vision is ~$0.003-0.008 per image
// at typical menu sizes — usually pennies for a full menu import.
// Cap at 8 images per call (designer menus rarely exceed 4 pages).
exports.aiExtractMenu = onCall(
    {
        region: "us-central1",
        cors: true,
        maxInstances: 5,
        timeoutSeconds: 120,   // vision calls can take 20-60s for multi-page menus
        memory: "512MiB",      // base64 + JSON parsing of multi-image responses
        secrets: [ANTHROPIC_API_KEY],
    },
    async (request) => {
        const ip = request.rawRequest?.ip
            || request.rawRequest?.headers?.["x-forwarded-for"]?.split(",")[0]
            || null;
        await enforceRateLimit({
            ip,
            namespace: "aiExtractMenu",
            limit: 20,           // 20 menu imports per 5 min — generous; menu imports are rare events
            windowMs: 5 * 60_000,
        });

        const data = request.data || {};
        const imageUrls = Array.isArray(data.imageUrls) ? data.imageUrls : [];
        if (imageUrls.length === 0) {
            throw new HttpsError("invalid-argument", "imageUrls required");
        }
        if (imageUrls.length > 8) {
            throw new HttpsError("invalid-argument", "too many pages (max 8)");
        }

        // 2026-05-24 audit fix — SSRF hostname allowlist.
        //
        // Before: this function accepted any `https://...` URL and fetched
        // it server-side. Combined with the public Cloud Function endpoint,
        // this was effectively a free outbound HTTPS proxy from Google's
        // network — any attacker could trick it into fetching internal
        // metadata URLs (169.254.169.254 was already filtered by Google
        // Cloud, but third-party services often whitelist GCP IPs), or
        // use it as a free proxy to exfiltrate data via the response
        // bytes being sent to Anthropic. SSRF is the standard term.
        //
        // Allowlist: ONLY this project's Storage bucket. Menu PDFs the
        // admin uploads land there via the existing aiExtractMenu UI;
        // no legitimate caller needs to point this function elsewhere.
        const STORAGE_HOST_ALLOWLIST = new Set([
            "firebasestorage.googleapis.com",
            "storage.googleapis.com",
            "dd-mau-staff-app.firebasestorage.app",
            "dd-mau-staff-app.appspot.com",
        ]);

        // Fetch each image and base64-encode. We fetch from Storage
        // server-side rather than expecting the client to send raw
        // bytes — keeps the request payload small and lets us run on
        // pre-uploaded URLs cleanly.
        const imageBlocks = [];
        for (const url of imageUrls) {
            if (typeof url !== "string" || !/^https:\/\//.test(url)) {
                throw new HttpsError("invalid-argument", "imageUrls must be https URLs");
            }
            // SSRF check — host must be on the allowlist.
            try {
                const host = new URL(url).hostname.toLowerCase();
                if (!STORAGE_HOST_ALLOWLIST.has(host)) {
                    throw new HttpsError("permission-denied",
                        `imageUrls host not allowed: ${host}. Only the project's Firebase Storage is permitted.`);
                }
            } catch (e) {
                if (e instanceof HttpsError) throw e;
                throw new HttpsError("invalid-argument", "imageUrls must be valid URLs");
            }
            try {
                const resp = await fetch(url);
                if (!resp.ok) {
                    throw new HttpsError("invalid-argument", `failed to fetch ${url.slice(0, 80)}: ${resp.status}`);
                }
                const buf = await resp.arrayBuffer();
                const sizeKB = Math.round(buf.byteLength / 1024);
                if (buf.byteLength > 5 * 1024 * 1024) {
                    throw new HttpsError("invalid-argument", `image too large (${sizeKB} KB; cap 5 MB)`);
                }
                const b64 = Buffer.from(buf).toString("base64");
                // Honor the content-type header; fall back to PNG which
                // is what our pdfjs renderer produces.
                let mediaType = (resp.headers.get("content-type") || "image/png").split(";")[0].trim().toLowerCase();
                if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mediaType)) {
                    mediaType = "image/png";
                }
                imageBlocks.push({
                    type: "image",
                    source: { type: "base64", media_type: mediaType, data: b64 },
                });
            } catch (e) {
                if (e instanceof HttpsError) throw e;
                logger.error("aiExtractMenu fetch image failed:", url, e?.message);
                throw new HttpsError("internal", "could not fetch one of the menu images");
            }
        }

        const system = [
            "You are a menu OCR + structuring assistant for a restaurant management app.",
            "Given one or more images of a restaurant menu, extract the menu items into a clean JSON structure.",
            "",
            "Rules:",
            "- Treat multi-page menus as one consolidated menu (don't duplicate items shown on a cover page + later).",
            "- Group items under their visible category headers (e.g. 'Bowls', 'Bánh Mì', 'Drinks').",
            "- For each item, capture: nameEn (English name as printed), price (as printed, e.g. '$18'), and descEn (one-line description IF printed; omit if absent).",
            "- If the menu shows price suffixes like '/ S /M /L' or multiple sizes, capture the FIRST listed price.",
            "- For dietary tags visible on the menu (V, GF, VG, vegan, vegetarian, gluten-free, spicy), set the matching boolean flags: vegan, glutenFree, spicy.",
            "- Don't invent items. If you can't read something clearly, skip it.",
            "- Preserve any accents/diacritics in names (e.g. 'Bánh Mì', 'Phở').",
            "",
            "Respond with ONLY a JSON object of this exact shape. No prose, no explanation, no markdown code fences:",
            '{ "categories": [ { "category": "Bowls", "items": [ { "nameEn": "Pork Bowl", "price": "$15", "descEn": "Roast pork with rice", "spicy": false, "vegan": false, "glutenFree": false, "popular": false } ] } ] }',
            "",
            "If you cannot extract a menu at all, respond with: { \"categories\": [] }",
        ].join("\n");

        const userContent = [
            ...imageBlocks,
            { type: "text", text: "Extract the menu items from these image(s) into the JSON shape described in the system prompt." },
        ];

        let body;
        try {
            const resp = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": ANTHROPIC_API_KEY.value(),
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    // Haiku-class — vision-capable. If model 404s, swap to
                    // the current Haiku model name and redeploy.
                    model: "claude-haiku-4-5",
                    max_tokens: 8192,    // big menus can have 50-100 items; pad generously
                    system,
                    messages: [{ role: "user", content: userContent }],
                }),
            });
            if (!resp.ok) {
                const errText = await resp.text();
                logger.error("aiExtractMenu anthropic error", resp.status, errText.slice(0, 500));
                throw new HttpsError("internal", `anthropic failed: ${resp.status}`);
            }
            body = await resp.json();
        } catch (e) {
            if (e instanceof HttpsError) throw e;
            logger.error("aiExtractMenu fetch failed:", e?.message || e);
            throw new HttpsError("unavailable", "menu extraction unavailable");
        }

        // Parse model output. Expected shape: { content: [{ type: 'text', text: '{...JSON...}' }] }
        const textBlock = (body?.content || []).find(c => c?.type === "text");
        const raw = textBlock?.text || "";
        let parsed = null;
        try {
            const trimmed = raw.trim().replace(/^```(?:json)?\n?/i, "").replace(/```$/i, "").trim();
            parsed = JSON.parse(trimmed);
        } catch {
            // Fallback: extract first {...} block if Claude prefixed prose
            const m = raw.match(/\{[\s\S]*\}/);
            if (m) {
                try { parsed = JSON.parse(m[0]); } catch {}
            }
        }
        if (!parsed || !Array.isArray(parsed.categories)) {
            logger.warn("aiExtractMenu: could not parse model output:", raw.slice(0, 300));
            return { categories: [], rawSnippet: raw.slice(0, 500) };
        }

        // Sanity-check + sanitize each item so we don't pass garbage
        // through to the client's review UI. Keep field whitelist tight.
        const safeCategories = [];
        for (const cat of parsed.categories) {
            if (!cat || typeof cat.category !== "string") continue;
            const items = Array.isArray(cat.items) ? cat.items : [];
            const safeItems = [];
            for (const it of items) {
                if (!it || typeof it.nameEn !== "string" || !it.nameEn.trim()) continue;
                safeItems.push({
                    nameEn: String(it.nameEn).trim().slice(0, 120),
                    price: typeof it.price === "string" ? it.price.slice(0, 16) : "",
                    descEn: typeof it.descEn === "string" ? it.descEn.slice(0, 280) : "",
                    spicy: it.spicy === true,
                    vegan: it.vegan === true,
                    glutenFree: it.glutenFree === true,
                    popular: it.popular === true,
                });
            }
            if (safeItems.length === 0) continue;
            safeCategories.push({
                category: cat.category.trim().slice(0, 60),
                items: safeItems,
            });
        }

        return {
            categories: safeCategories,
            pageCount: imageUrls.length,
        };
    }
);

// ── 2026-05-20 — aiGeneratePromo: AI banner copy for menu TVs ─────
// Andrew Wave 5 of "match the SaaS leaders, beat them where we can".
// None of Raydiant / ScreenCloud / Samsung VXT offer AI-generated
// promo banner copy. Ours does, in EN + ES, picking restaurant-
// appropriate emojis and short attention-grabbing phrasing. Admin
// types a hint ("happy hour", "promote catering", "we're slow
// tuesdays") and Claude returns 3 banner variants to pick from.
//
// Cost: Claude Haiku, ~$0.0005 per call. Used a handful of times
// per week at most.
exports.aiGeneratePromo = onCall(
    {
        region: "us-central1",
        cors: true,
        maxInstances: 5,
        secrets: [ANTHROPIC_API_KEY],
    },
    async (request) => {
        const ip = request.rawRequest?.ip
            || request.rawRequest?.headers?.["x-forwarded-for"]?.split(",")[0]
            || null;
        await enforceRateLimit({
            ip,
            namespace: "aiGeneratePromo",
            limit: 40,
            windowMs: 5 * 60_000,
        });

        const data = request.data || {};
        const hint = String(data.hint || "").trim().slice(0, 300);
        const variant = String(data.variant || "promo").toLowerCase();
        if (!hint) {
            throw new HttpsError("invalid-argument", "hint required");
        }

        const system = [
            "You are a copywriter for DD Mau, a Vietnamese fast-casual restaurant with locations in Webster Groves and Maryland Heights, MO.",
            "Generate short, punchy banner copy for the restaurant's menu TVs.",
            "",
            "Style rules:",
            "- Keep each banner to ONE line, under 80 characters.",
            "- Lead with one tasteful emoji (food, time, sale, sparkle — pick one that fits).",
            "- Friendly, warm tone — never corporate. Active voice.",
            "- Use real, scannable details if the user provided them (times, percentages, dates, menu items).",
            "- No exclamation marks at the end of EVERY variant — vary punctuation.",
            "- Avoid clichés (\"limited time only\", \"act now\", \"don't miss out\").",
            "",
            "Output 3 variants of the SAME promo, each in English AND Spanish (Mexican Spanish; restaurants in Missouri).",
            "Translation should match the energy of the English version — not word-for-word.",
            "",
            "Respond with ONLY this JSON shape, no prose, no markdown fences:",
            '{ "variants": [ { "en": "🎉 Happy hour 3-5pm — half off all boba teas", "es": "🎉 Happy hour 3-5pm: boba a mitad de precio" }, ... ] }',
        ].join("\n");

        const userMessage = [
            `Restaurant: DD Mau (Vietnamese fast-casual)`,
            `Banner type: ${variant}`,
            ``,
            `Admin's hint: ${hint}`,
            ``,
            `Generate 3 banner variants.`,
        ].join("\n");

        let body;
        try {
            const resp = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "x-api-key": ANTHROPIC_API_KEY.value(),
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: "claude-haiku-4-5",
                    max_tokens: 1024,
                    system,
                    messages: [{ role: "user", content: userMessage }],
                }),
            });
            if (!resp.ok) {
                const errText = await resp.text();
                logger.error("aiGeneratePromo anthropic error", resp.status, errText.slice(0, 500));
                throw new HttpsError("internal", `anthropic failed: ${resp.status}`);
            }
            body = await resp.json();
        } catch (e) {
            if (e instanceof HttpsError) throw e;
            logger.error("aiGeneratePromo fetch failed:", e?.message || e);
            throw new HttpsError("unavailable", "promo generation unavailable");
        }

        const textBlock = (body?.content || []).find(c => c?.type === "text");
        const raw = textBlock?.text || "";
        let parsed = null;
        try {
            const trimmed = raw.trim().replace(/^```(?:json)?\n?/i, "").replace(/```$/i, "").trim();
            parsed = JSON.parse(trimmed);
        } catch {
            const m = raw.match(/\{[\s\S]*\}/);
            if (m) {
                try { parsed = JSON.parse(m[0]); } catch {}
            }
        }
        if (!parsed || !Array.isArray(parsed.variants)) {
            logger.warn("aiGeneratePromo: could not parse model output:", raw.slice(0, 300));
            return { variants: [] };
        }

        // Sanitize each variant — short string lengths, drop blanks.
        const safe = parsed.variants
            .filter(v => v && typeof v.en === "string" && v.en.trim())
            .map(v => ({
                en: String(v.en).trim().slice(0, 200),
                es: typeof v.es === "string" ? v.es.trim().slice(0, 200) : "",
            }))
            .slice(0, 5);

        return { variants: safe };
    }
);

exports.translateMessage = onCall(
    { region: "us-central1", cors: true, maxInstances: 10 },
    async (request) => {
        // Rate limit by source IP before doing any work. This is the
        // only auth-shaped check we can do without Firebase Auth wired
        // — see SEC-002 in AUDIT.md for the full picture.
        const ip = request.rawRequest?.ip
            || request.rawRequest?.headers?.["x-forwarded-for"]?.split(",")[0]
            || null;
        await checkTranslateRateLimit(ip);

        const data = request.data || {};
        const targetLang = String(data.targetLang || "").toLowerCase();
        if (!targetLang || !/^[a-z]{2}(-[a-z]{2,4})?$/i.test(targetLang)) {
            throw new HttpsError("invalid-argument", "targetLang required (e.g. 'en' or 'es')");
        }

        // Resolve the text. Two modes:
        //   A. {chatId, messageId} → read from Firestore + cache result back.
        //   B. {text} → one-shot ad-hoc translation, no persistence.
        let text = "";
        let chatId = data.chatId ? String(data.chatId) : null;
        let messageId = data.messageId ? String(data.messageId) : null;
        let msgRef = null;
        let msgData = null;
        if (chatId && messageId) {
            msgRef = db.doc(`chats/${chatId}/messages/${messageId}`);
            const snap = await msgRef.get();
            if (!snap.exists) {
                throw new HttpsError("not-found", "message not found");
            }
            msgData = snap.data() || {};
            text = String(msgData.text || "").trim();
            // Cache hit — return without billing the API again.
            const cached = (msgData.translations || {})[targetLang];
            if (cached && typeof cached === "string") {
                return {
                    translatedText: cached,
                    sourceLang: msgData.sourceLang || null,
                    cached: true,
                };
            }
        } else {
            text = String(data.text || "").trim();
        }

        if (!text) {
            throw new HttpsError("invalid-argument", "no text to translate");
        }
        // Sanity cap — chat messages above 5k chars are essays, not chat.
        // Stops accidental abuse of the API quota.
        if (text.length > 5000) {
            throw new HttpsError("invalid-argument", "text too long (max 5000 chars)");
        }

        // Call Google Cloud Translation v2 REST. ADC handles the access
        // token; we never see a raw key.
        let translatedText = "";
        let detectedSourceLang = null;
        try {
            const auth = new GoogleAuth({
                scopes: ["https://www.googleapis.com/auth/cloud-translation"],
            });
            const client = await auth.getClient();
            // Match the pattern scheduledFirestoreBackup uses — extract
            // .token directly off the GetAccessTokenResponse. The earlier
            // `token.token || token` fallback would smuggle an object
            // into the Authorization header on failure, masking the real
            // "couldn't get token" error.
            const accessToken = (await client.getAccessToken()).token;
            if (!accessToken) {
                throw new HttpsError("internal", "could not obtain access token");
            }
            const projectId = await auth.getProjectId();
            const url = "https://translation.googleapis.com/language/translate/v2";
            const resp = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                    "x-goog-user-project": projectId,
                },
                body: JSON.stringify({
                    q: text,
                    target: targetLang,
                    format: "text",
                }),
            });
            if (!resp.ok) {
                const body = await resp.text();
                logger.error("translate API error", resp.status, body);
                throw new HttpsError("internal", `translate failed: ${resp.status}`);
            }
            const json = await resp.json();
            const tr = json?.data?.translations?.[0] || {};
            translatedText = String(tr.translatedText || "");
            detectedSourceLang = tr.detectedSourceLanguage || null;
        } catch (e) {
            if (e instanceof HttpsError) throw e;
            logger.error("translateMessage call failed:", e);
            throw new HttpsError("internal", "translation service unavailable");
        }

        // Persist the auto-detected source lang on the message doc so
        // future viewers know what we're dealing with. Two distinct
        // cases handled by separate branches:
        //
        //   A. source != target (real translation happened) — write
        //      the translation under translations.{targetLang} AND
        //      record sourceLang if we don't have it yet.
        //
        //   B. source == target (API returned input verbatim) —
        //      DON'T write a junk translation entry, but DO write
        //      sourceLang. Without this, shouldOfferTranslation has
        //      no way to know the message is already in the viewer's
        //      language; the chip re-appears on every reload and the
        //      next tap re-bills the API for nothing. (2026-05-17 fix
        //      — Andrew reported tapping Translate on English messages
        //      with target=en and seeing the chip come back after each
        //      reload.)
        if (msgRef && translatedText) {
            const norm = (s) => String(s || "").toLowerCase().split("-")[0];
            const sourceMatchesTarget = detectedSourceLang
                && norm(detectedSourceLang) === norm(targetLang);
            const patch = {};
            if (!sourceMatchesTarget) {
                patch[`translations.${targetLang}`] = translatedText;
            }
            if (!msgData?.sourceLang && detectedSourceLang) {
                patch.sourceLang = detectedSourceLang;
            }
            if (Object.keys(patch).length > 0) {
                try {
                    await msgRef.update(patch);
                } catch (e) {
                    // Non-fatal: caller still gets the translation. Cache miss next time.
                    logger.warn("translation cache write failed (non-fatal):", e);
                }
            }
        }

        return {
            translatedText,
            sourceLang: detectedSourceLang,
            cached: false,
        };
    },
);

// ── pollGmail — owner inbox triage (Andrew 2026-05-26) ────────────────────
//
// Scheduled hourly. Pulls new messages from Andrew's Gmail via OAuth,
// classifies each one with Claude Haiku into:
//   catering | complaint | vendor | bill | other
// and writes a row per email to /email_intel for the in-app admin
// "Inbox" tab. For 'catering' and 'complaint' (time-sensitive types),
// also writes notification docs that the existing dispatchSms picks
// up and texts Andrew + Julie.
//
// State: /system/gmail_sync_state.lastInternalDate — Gmail's internal
// message timestamp (epoch ms). We query "after:<seconds>" so we only
// fetch genuinely new mail each hour. First run defaults to "last 24h"
// to seed without scanning the whole mailbox.
//
// Scope: gmail.readonly only. The CF never writes to or moves the
// inbox; triage state lives entirely in Firestore.
//
// Why owner-only audience: Andrew: "i want to make sure the
// notifications only got to julie and andrew the owners". Recipients
// are hardcoded to staff records with id 40 or 41 here; the future
// manager-rollup (Andrew: "i want to be able to sent to managers one
// day") will read an admin toggle from /config/inboxTriage instead.
exports.pollGmail = onSchedule(
    {
        schedule: "every 60 minutes",
        timeZone: "America/Chicago",
        region: "us-central1",
        timeoutSeconds: 300,
        memory: "512MiB",
        secrets: [
            GMAIL_OAUTH_CLIENT_ID,
            GMAIL_OAUTH_CLIENT_SECRET,
            GMAIL_OAUTH_REFRESH_TOKEN,
            ANTHROPIC_API_KEY,
        ],
    },
    async () => {
        const { google } = require("googleapis");

        // Build OAuth client. Refresh token is long-lived so this
        // works without any human re-consent until Andrew revokes
        // the app via myaccount.google.com/permissions.
        const oauth2 = new google.auth.OAuth2(
            GMAIL_OAUTH_CLIENT_ID.value(),
            GMAIL_OAUTH_CLIENT_SECRET.value(),
        );
        oauth2.setCredentials({ refresh_token: GMAIL_OAUTH_REFRESH_TOKEN.value() });
        const gmail = google.gmail({ version: "v1", auth: oauth2 });

        // ── Concurrency lock (Andrew 2026-05-26) ─────────────────────
        // The first-day bring-up had three runs race (one cron tick +
        // two manual force-runs from the Scheduler UI). Each saw "77
        // new messages" and slammed the Anthropic API in parallel,
        // tripping a 429 rate limit and saddling ~half the messages
        // with a fallback category of "other". Acquire a transactional
        // lock so only one run can be classifying at a time; expire
        // after 9 minutes so a crashed run doesn't wedge the next
        // hour's tick.
        const lockRef = db.doc("system/gmail_sync_lock");
        const lockAcquired = await db.runTransaction(async (txn) => {
            const snap = await txn.get(lockRef);
            const heldUntil = snap.exists ? Number(snap.data().heldUntil || 0) : 0;
            if (heldUntil > Date.now()) return false; // someone else holds it
            txn.set(lockRef, {
                heldUntil: Date.now() + 9 * 60 * 1000,
                heldBy: "pollGmail",
                acquiredAt: FieldValue.serverTimestamp(),
            });
            return true;
        });
        if (!lockAcquired) {
            logger.info("pollGmail: another instance is already running — skipping.");
            return;
        }

        // ── Load few-shot examples from manager corrections ─────────
        // Andrew 2026-05-26: "the classification ai should learn as
        // changes are made." Every time Andrew or Julie clicks the
        // category dropdown on a row in the InboxTriage UI, a
        // correction row is appended to /email_intel_corrections. We
        // load the most recent 30 corrections and stuff them into
        // every classification prompt as examples. The model picks
        // up the pattern (e.g. "emails from <vendor X> are 'vendor'
        // even though they look like 'bill'") without any retraining.
        let correctionExamples = "";
        try {
            const correctionsSnap = await db.collection("email_intel_corrections")
                .orderBy("correctedAt", "desc")
                .limit(30)
                .get();
            if (!correctionsSnap.empty) {
                const lines = [];
                correctionsSnap.forEach(d => {
                    const c = d.data();
                    if (!c || !c.newCategory) return;
                    lines.push(
                        `- From: ${(c.fromName || c.from || '').slice(0, 80)} | Subject: ${(c.subject || '').slice(0, 100)} | Snippet: ${(c.snippet || '').slice(0, 160)} → ${c.newCategory}`
                    );
                });
                if (lines.length > 0) {
                    correctionExamples =
                        "\n\nPRIOR MANAGER CORRECTIONS (use these as guidance — when an email looks similar, match the manager's choice):\n"
                        + lines.join("\n");
                }
            }
        } catch (e) {
            // Non-fatal — fall back to zero-shot prompt.
            logger.warn(`pollGmail: corrections load failed: ${e.message}`);
        }

        // ── Load routing rules + killswitch ─────────────────────────
        // Auto-forwarding to staff requires BOTH masterEnabled to be
        // true AND the category's per-rule enabled flag. Until Andrew
        // flips the master, this is a no-op (no notifications fan out
        // to staff). Stored at /config/inbox_routing_rules.
        let routingRules = { masterEnabled: false, rules: {} };
        try {
            const rulesSnap = await db.doc("config/inbox_routing_rules").get();
            if (rulesSnap.exists) routingRules = { ...routingRules, ...(rulesSnap.data() || {}) };
        } catch (e) {
            logger.warn(`pollGmail: routing rules load failed: ${e.message}`);
        }

        // ── Resume from last poll ────────────────────────────────────
        const stateRef = db.doc("system/gmail_sync_state");
        const stateSnap = await stateRef.get();
        const lastInternalMs = stateSnap.exists ? Number(stateSnap.data().lastInternalDate || 0) : 0;
        // First run: look back 24h so we don't scan the whole mailbox.
        const seedMs = Date.now() - 24 * 60 * 60 * 1000;
        const afterMs = Math.max(lastInternalMs, seedMs);
        const afterSec = Math.floor(afterMs / 1000);
        const query = `after:${afterSec}`;

        logger.info(`pollGmail: query="${query}" (afterMs=${afterMs})`);

        // ── List message ids since last poll ────────────────────────
        // Page through at most 100 (one hour shouldn't have more than
        // that in a real inbox; if it does, we'll catch up next tick).
        let messageIds = [];
        let nextPageToken;
        let pages = 0;
        do {
            const list = await gmail.users.messages.list({
                userId: "me",
                q: query,
                maxResults: 50,
                pageToken: nextPageToken,
            });
            for (const m of (list.data.messages || [])) messageIds.push(m.id);
            nextPageToken = list.data.nextPageToken;
            pages++;
        } while (nextPageToken && messageIds.length < 100 && pages < 5);

        // ── Cleanup pass: pick up previously-failed classifications ─
        // Andrew 2026-05-26: the first-day 429 storm left ~36 docs with
        // category='other' + reasoning='' (the LLM fallback). Gmail's
        // after: cursor advanced past them, so the main loop would never
        // see them again. Each run also retries up to 50 of these
        // orphans so the misclassified 'other' bucket drains naturally.
        const retryIds = [];
        try {
            const failedSnap = await db.collection("email_intel")
                .where("reasoning", "==", "")
                .limit(50)
                .get();
            failedSnap.forEach((d) => {
                if (!messageIds.includes(d.id)) retryIds.push(d.id);
            });
        } catch (e) {
            // Non-fatal — main loop still processes new mail.
            logger.warn(`pollGmail: failed-classification scan errored: ${e.message}`);
        }
        if (retryIds.length > 0) {
            logger.info(`pollGmail: cleanup pass — retrying ${retryIds.length} failed classification(s).`);
            messageIds.push(...retryIds);
        }

        if (messageIds.length === 0) {
            logger.info("pollGmail: no new messages.");
            // Release the lock even when there's nothing to do.
            await lockRef.set({ heldUntil: 0, releasedAt: FieldValue.serverTimestamp() }, { merge: true });
            return;
        }
        logger.info(`pollGmail: ${messageIds.length - retryIds.length} new + ${retryIds.length} retry message(s).`);

        // ── Classify + write each ──────────────────────────────────────
        // Anthropic call helper with retry-on-429. Haiku has burst
        // limits; concurrent classifications can trip them even at
        // low total volume. 3 attempts, exponential backoff
        // (1s / 3s / 7s) so a transient rate-limit clears within
        // one minute total wait.
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        async function classifyWithRetry(prompt) {
            const backoffsMs = [1000, 3000, 7000];
            for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
                const resp = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-api-key": ANTHROPIC_API_KEY.value(),
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model: "claude-haiku-4-5",
                        max_tokens: 80,
                        messages: [{ role: "user", content: prompt }],
                    }),
                });
                if (resp.ok) return resp;
                // 429 (rate limit) and 5xx — retryable. 4xx other than
                // 429 means we built a bad request; don't retry.
                const retryable = resp.status === 429 || (resp.status >= 500 && resp.status < 600);
                if (!retryable || attempt >= backoffsMs.length) return resp;
                await sleep(backoffsMs[attempt]);
            }
        }

        let maxInternalMs = lastInternalMs;
        let classified = 0;
        let reclassified = 0;
        for (const id of messageIds) {
            // 2026-05-26: skip only if a PRIOR classification succeeded
            // (reasoning is set, i.e. the LLM actually responded). Skip
            // doc without reasoning means an earlier 429/network error
            // — re-try it this run so the 429 fallback "other" gets
            // replaced with the real category.
            const intelRef = db.doc("email_intel/" + id);
            const existing = await intelRef.get();
            const prev = existing.exists ? existing.data() : null;
            if (prev && prev.reasoning) continue;
            const isRetry = !!prev;

            // Pull headers + snippet (small, no body — saves the cost of
            // shipping the full body through the LLM and Firestore).
            const msg = await gmail.users.messages.get({
                userId: "me",
                id,
                format: "metadata",
                metadataHeaders: ["From", "Subject", "Date"],
            });

            const headers = (msg.data.payload?.headers || []).reduce((acc, h) => {
                acc[h.name.toLowerCase()] = h.value || "";
                return acc;
            }, {});
            const from = headers["from"] || "(unknown sender)";
            const subject = headers["subject"] || "(no subject)";
            const snippet = (msg.data.snippet || "").slice(0, 800);
            const internalMs = Number(msg.data.internalDate) || Date.now();
            if (internalMs > maxInternalMs) maxInternalMs = internalMs;

            // Pretty-extract just the name part of From: "Jane Doe <a@b.com>"
            const fromName = (() => {
                const m = from.match(/^(.+?)\s*<.*>$/);
                return m ? m[1].replace(/^"|"$/g, "") : from;
            })();

            // ── Classify with Claude Haiku ──────────────────────────
            let category = "other";
            let reasoning = "";
            try {
                const prompt = `You triage emails for a restaurant. Classify ONE email into exactly one of:
- catering — someone asking about catering, large orders, events, group meals, off-site service. INCLUDES Toast online-order receipts where the order is a catering / large-party / event submission (look for catering language, large guest counts, off-site delivery).
- complaint — a customer is unhappy: bad food, slow service, rude staff, refund request, sick after eating.
- vendor — a vendor (Sysco, US Foods, suppliers, distributors) asking a question, sending order confirmations, or making a request.
- bill — an invoice, statement, payment due, utility bill, subscription receipt.
- toast — automated emails from Toast POS (toasttab.com, toastpos.com, Toast Now, etc.): daily sales summaries, transaction notices, online-order receipts, loyalty reports, payroll-from-Toast. IMPORTANT: if the Toast email is a CATERING order, classify as 'catering' instead — catering wins over toast.
- other — anything else (marketing, spam, personal, employee, banking notices, social media).

Reply with ONLY a JSON object: {"category":"<one of the 6>","reason":"<6-12 word reason>"}
${correctionExamples}

Email:
From: ${from}
Subject: ${subject}
Body snippet: ${snippet}`;
                const classifyResp = await classifyWithRetry(prompt);
                if (classifyResp.ok) {
                    const j = await classifyResp.json();
                    const text = j.content?.[0]?.text || "";
                    const match = text.match(/\{[\s\S]*?\}/);
                    if (match) {
                        const parsed = JSON.parse(match[0]);
                        const valid = ["catering", "complaint", "vendor", "bill", "toast", "other"];
                        if (valid.includes(parsed.category)) {
                            category = parsed.category;
                            reasoning = (parsed.reason || "").slice(0, 120);
                        }
                    }
                } else {
                    logger.warn(`pollGmail: Anthropic ${classifyResp.status} on id=${id} (final after retries)`);
                }
            } catch (e) {
                logger.warn(`pollGmail: classify failed for id=${id}: ${e.message}`);
            }

            // ── Write to /email_intel ────────────────────────────────
            // Preserve smsSent across re-classification so we don't
            // double-text on a retry.
            const gmailUrl = `https://mail.google.com/mail/u/0/#all/${id}`;
            const wasSmsSent = !!prev?.smsSent;
            await intelRef.set({
                gmailId: id,
                gmailUrl,
                from,
                fromName,
                subject,
                snippet,
                category,
                reasoning,
                receivedAt: FieldValue.serverTimestamp(),
                internalDate: internalMs,
                triaged: !!prev?.triaged,
                smsSent: wasSmsSent,
                classifiedAt: FieldValue.serverTimestamp(),
            });
            if (isRetry) reclassified++;
            else classified++;

            // ── Real-time SMS for time-sensitive categories ──────────
            // Only catering + complaint trigger SMS today; vendor/bill
            // are visible in the in-app inbox tab. dispatchSms picks
            // up the notification docs we write here and routes via
            // Twilio to each owner's phoneE164.
            //
            // 2026-05-26: skip if smsSent is already true. A re-classify
            // run (replacing a 429-fallback 'other' with a real category)
            // mustn't double-page the owners.
            if (!wasSmsSent && (category === "catering" || category === "complaint")) {
                const notifType = category === "catering"
                    ? "email_inquiry_catering"
                    : "email_inquiry_complaint";
                const title = category === "catering"
                    ? `🍱 Catering inquiry: ${fromName}`
                    : `⚠️ Complaint: ${fromName}`;
                const body = subject;

                // Look up owners by id (40 = Andrew, 41 = Julie). Future
                // managers-rollup will read /config/inboxTriage.recipients
                // to extend this list.
                const staffDoc = await db.doc("config/staff").get();
                const list = (staffDoc.data() || {}).list || [];
                const ownerNames = list
                    .filter(s => s && s.name && (s.id === 40 || s.id === 41))
                    .map(s => s.name);

                for (const name of ownerNames) {
                    await db.collection("notifications").add({
                        forStaff: name,
                        type: notifType,
                        title,
                        body,
                        deepLink: "inbox",
                        link: "/?tab=inbox",
                        // Tag with the gmail id so a duplicate Gmail
                        // event can't double-page either owner.
                        tag: `${notifType}:${id}`,
                        // dispatchSms reads these to render the SMS
                        // template — same shape the smsTemplates use.
                        smsVars: {
                            from: fromName.slice(0, 60),
                            subject: subject.slice(0, 80),
                        },
                        priority: "high",
                        forceDeliver: true,
                        createdAt: FieldValue.serverTimestamp(),
                        read: false,
                        createdBy: "pollGmail",
                    });
                }
                await intelRef.update({ smsSent: true });
            }

            // ── Auto-forward to staff (Andrew 2026-05-26) ────────────
            // "set that one come in it auto sends to a staff. once i
            // turn that on." Master killswitch + per-category enable
            // both must be true. Only fires for genuinely NEW emails
            // (not retries) — preventing the cleanup pass from
            // forwarding the same email twice if a manager changes
            // routing rules after the original send.
            const rule = routingRules.rules?.[category];
            if (
                !isRetry
                && routingRules.masterEnabled === true
                && rule?.enabled === true
                && Array.isArray(rule.recipients)
                && rule.recipients.length > 0
            ) {
                const fwdSnippet = (snippet || "").slice(0, 200);
                const fwdTitle = `📤 New ${category}: ${subject || "(no subject)"}`.slice(0, 120);
                const fwdBody = `From ${fromName} · ${fwdSnippet}`.slice(0, 600);
                const writes = rule.recipients.map((name) =>
                    db.collection("notifications").add({
                        forStaff: name,
                        type: "email_forwarded",
                        title: fwdTitle,
                        body: fwdBody,
                        deepLink: "/",
                        tag: `email_forwarded:${id}:${name}`,
                        priority: "high",
                        forceDeliver: true,
                        createdAt: FieldValue.serverTimestamp(),
                        read: false,
                        createdBy: "pollGmail.autoForward",
                        sourceGmailId: id,
                    })
                );
                try {
                    await Promise.all(writes);
                    await intelRef.update({
                        forwardedToStaff: rule.recipients,
                        lastForwardedAt: FieldValue.serverTimestamp(),
                        lastForwardedBy: "auto",
                    });
                    logger.info(`pollGmail: auto-forwarded ${id} (${category}) to ${rule.recipients.length} recipient(s).`);
                } catch (e) {
                    logger.warn(`pollGmail: auto-forward failed for ${id}: ${e.message}`);
                }
            }
        }

        // ── Persist sync state ─────────────────────────────────────
        await stateRef.set({
            lastInternalDate: maxInternalMs,
            lastRunAt: FieldValue.serverTimestamp(),
            lastClassifiedCount: classified,
            lastReclassifiedCount: reclassified,
        }, { merge: true });
        // Release the concurrency lock — set heldUntil to 0 so the
        // next run can acquire immediately (don't `delete` the doc
        // so failed-run forensics survive: acquiredAt timestamps).
        await lockRef.set({ heldUntil: 0, releasedAt: FieldValue.serverTimestamp() }, { merge: true });
        logger.info(`pollGmail: classified ${classified} new + reclassified ${reclassified}.`);
    },
);
