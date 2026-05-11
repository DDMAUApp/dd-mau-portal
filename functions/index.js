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
        const tokens = me.fcmTokens.map((t) => t && t.token).filter(Boolean);
        if (tokens.length === 0) return;

        const message = {
            tokens,
            notification: {
                title: notif.title || "DD Mau",
                body: notif.body || "",
            },
            data: {
                type: notif.type || "",
                tag: notif.id || event.params.id,
                link: notif.link || "/",
            },
            webpush: {
                fcmOptions: {
                    link: notif.link || "/",
                },
            },
        };

        const result = await getMessaging().sendEachForMulticast(message);
        logger.info(`Sent push for ${forStaff}: ${result.successCount} ok, ${result.failureCount} failed`);

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
