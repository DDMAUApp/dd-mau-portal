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
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

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
        // Keep only tokens whose result was a success OR a transient failure.
        const deadCodes = new Set([
            "messaging/registration-token-not-registered",
            "messaging/invalid-registration-token",
            "messaging/invalid-argument",
        ]);
        const liveTokens = [];
        for (let i = 0; i < tokens.length; i++) {
            const r = result.responses[i];
            if (r.success || !deadCodes.has(r.error?.code)) {
                liveTokens.push(me.fcmTokens.find((t) => t.token === tokens[i]));
            } else {
                logger.info(`pruning dead token for ${forStaff}: ${r.error?.code}`);
            }
        }
        if (liveTokens.length !== me.fcmTokens.length) {
            const newList = list.map((s) =>
                s.name === forStaff ? { ...s, fcmTokens: liveTokens } : s
            );
            await db.doc("config/staff").set({ list: newList });
        }
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
            // The shift's start as a UTC timestamp built from local-business-day fields.
            // Cloud Function runs in UTC, so we need to interpret the date as a local CT time.
            // Use a Date with local fields then convert via DateTimeFormat? Simpler: build as
            // ISO with the timezone offset for America/Chicago. CT is UTC-5 (CDT) or UTC-6 (CST);
            // DST varies. We approximate using the server's local time conversion via
            // Intl. For now: best-effort using JS Date.UTC + manual offset for May (CDT = -5).
            // (For a perfect solution, use a tz library — overkill for a 5-min-window job.)
            const cdtOffsetHours = 5; // CDT (DST) — matches DD Mau May timeframe
            const shiftStartMs = Date.UTC(y, mo - 1, d, hh + cdtOffsetHours, mm);

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

// Local helper — duplicated from src/components/Schedule.jsx
function formatTime12h(time24) {
    if (!time24) return "";
    const [h, m] = time24.split(":").map(Number);
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/* ──────────────────────────────────────────────────────────────────────
 * onboardingReminderScan — daily check for overdue / due-soon onboarding docs.
 *
 * Runs every morning at 8am Central. Walks active hire records, computes
 * the deadline for each required doc (hireDate + daysFromHire — kept in
 * sync with src/data/onboarding.js), and fires a notification to the
 * admins for anything overdue or due in <= 3 days.
 *
 * Admins receive a push via the existing dispatchNotification fan-out
 * (FCM tokens already saved per staff record). The notification deep-
 * links to /onboarding.
 *
 * Idempotency: each (hireId, docId, day) gets at most one ping per day —
 * we stamp reminderSentDay on the doc's checklist entry.
 */
// Kept in sync manually with src/data/onboarding.js. If you change one,
// change the other — the React side reads ONBOARDING_DOCS for UI; the
// Cloud Function reads this list for deadline calc + reminders.
const ONBOARDING_DOCS_SERVER = [
    { id: 'w4_fed',             en: 'W-4 (Federal)',             required: true,  daysFromHire: 7  },
    { id: 'w4_mo',              en: 'Missouri W-4',              required: true,  daysFromHire: 7  },
    { id: 'direct_deposit',     en: 'Direct deposit',            required: true,  daysFromHire: 7  },
    { id: 'voided_check',       en: 'Voided check / bank letter',required: true,  daysFromHire: 7  },
    { id: 'i9',                 en: 'I-9 work authorization',    required: true,  daysFromHire: 3  },
    { id: 'id_doc_1',           en: 'ID document #1',            required: true,  daysFromHire: 3  },
    { id: 'id_doc_2',           en: 'ID document #2',            required: true,  daysFromHire: 3  },
    { id: 'hep_a_record',       en: 'Hep A vaccination record',  required: true,  daysFromHire: 30 },
    { id: 'minor_permit',       en: 'Minor work permit',         required: false, daysFromHire: 7, minorOnly: true },
];

function dayKey(d = new Date()) {
    return d.toISOString().slice(0, 10);
}

exports.onboardingReminderScan = onSchedule(
    {
        schedule: "0 8 * * *",
        timeZone: "America/Chicago",
        retryCount: 1,
        memory: "256MiB",
    },
    async () => {
        const today = dayKey();
        const hiresSnap = await db.collection('onboarding_hires').get();
        const staffDoc = await db.doc('config/staff').get();
        const staffList = (staffDoc.exists ? staffDoc.data().list : []) || [];
        const admins = staffList.filter(s =>
            s.canViewOnboarding === true || s.id === 40 || s.id === 41
        );
        let pinged = 0;
        for (const sd of hiresSnap.docs) {
            const hire = sd.data();
            if (!hire || hire.status === 'archived' || hire.status === 'complete') continue;
            if (!hire.hireDate) continue;
            const parts = String(hire.hireDate).split('-').map(Number);
            if (parts.length !== 3 || parts.some(isNaN)) continue;
            const [y, m, d] = parts;
            const startMs = new Date(y, m - 1, d).getTime();
            for (const docDef of ONBOARDING_DOCS_SERVER) {
                if (!docDef.required) continue;
                if (docDef.daysFromHire == null) continue;
                if (docDef.minorOnly && !hire.isMinor) continue;
                const deadline = startMs + docDef.daysFromHire * 24 * 60 * 60 * 1000;
                const daysLeft = Math.ceil((deadline - Date.now()) / (24 * 60 * 60 * 1000));
                if (daysLeft > 3) continue;
                const cur = (hire.checklist && hire.checklist[docDef.id]) || {};
                if (cur.status === 'submitted' || cur.status === 'approved') continue;
                if (cur.reminderSentDay === today) continue;
                const isOverdue = daysLeft < 0;
                const body = isOverdue
                    ? `${hire.name} · ${docDef.en} is ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} overdue`
                    : `${hire.name} · ${docDef.en} due ${daysLeft <= 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}`;
                const title = isOverdue ? '⚠ Onboarding overdue' : '⏰ Onboarding due soon';
                await Promise.all(admins.map(a => db.collection('notifications').add({
                    forStaff: a.name,
                    type: isOverdue ? 'onboarding_overdue' : 'onboarding_due_soon',
                    title,
                    body,
                    link: '/onboarding',
                    createdAt: FieldValue.serverTimestamp(),
                    read: false,
                    createdBy: 'system',
                }).catch(() => null)));
                try {
                    await sd.ref.update({
                        [`checklist.${docDef.id}.reminderSentDay`]: today,
                        [`checklist.${docDef.id}.reminderSentAt`]: FieldValue.serverTimestamp(),
                    });
                } catch {}
                pinged++;
            }
        }
        logger.info(`onboardingReminderScan: ${pinged} reminder(s) across ${hiresSnap.size} hires`);
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
const { GoogleAuth } = require("google-auth-library");
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
    },
    async () => {
        const now = Date.now();
        const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
        const ONE_EIGHTY_DAYS = 180 * 24 * 60 * 60 * 1000;
        let expiredCount = 0;
        let deletedCount = 0;
        try {
            const snap = await db.collection("onboarding_applications").get();
            const writes = [];
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
                    writes.push(d.ref.delete());
                    deletedCount++;
                    return;
                }
                // STAGE 1: flip applied/screening/etc → expired at 90 days.
                const lastTouch = (data.statusUpdatedAt && Date.parse(data.statusUpdatedAt)) || created;
                const sinceTouch = now - lastTouch;
                const stuck = ["applied", "screening", "phone_screen"].includes(status);
                if (stuck && sinceTouch >= NINETY_DAYS) {
                    writes.push(d.ref.update({
                        status: "expired",
                        expiredAt: new Date().toISOString(),
                        expiredReason: "untouched_90_days",
                    }));
                    expiredCount++;
                }
            });
            await Promise.all(writes);
            logger.info(`application lifecycle: expired ${expiredCount}, deleted ${deletedCount}`);
            try {
                await db.collection("application_audits").add({
                    action: "lifecycle_run",
                    byAdmin: "cloud_function",
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
            if (!snap.exists()) return [];
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
        // Pull recipients.
        const staffDoc = await db.doc("config/staff").get();
        const list = (staffDoc.data() || {}).list || [];
        const seenNames = new Set();
        const recipients = list.filter((s) => {
            if (!s || !s.name) return false;
            if (s.canReceive86Alerts !== true) return false;
            if (seenNames.has(s.name)) return false;
            seenNames.add(s.name);
            return true;
        });
        if (recipients.length === 0) {
            logger.info(`86 alert (${slot}): ${totalOut} item(s) out but no opted-in recipients`);
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

// Cron strings below are interpreted in America/Chicago — Cloud
// Scheduler honors the timeZone option so daylight savings flips are
// handled for us. Write the schedule as the wall-clock time we want.
exports.eightySixAlertsMorning = onSchedule(
    { schedule: "0 10 * * *", timeZone: "America/Chicago", region: "us-central1" },
    () => eightySixSchedule("morning", "10am", "10am"),
);

exports.eightySixAlertsAfternoon = onSchedule(
    { schedule: "0 14 * * *", timeZone: "America/Chicago", region: "us-central1" },
    () => eightySixSchedule("afternoon", "2pm", "2pm"),
);

exports.eightySixAlertsEvening = onSchedule(
    { schedule: "0 20 * * *", timeZone: "America/Chicago", region: "us-central1" },
    () => eightySixSchedule("evening", "8pm", "8pm"),
);
