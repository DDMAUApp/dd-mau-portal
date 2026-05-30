// Centralized notification helpers.
//
// Two reasons we need this instead of inlining addDoc(...notifications)
// everywhere:
//   1. Dedup by recipient. Several places fanned out manually with
//      list.filter(canViewOnboarding) and could double-write if the
//      staff list had a duplicate entry. A single helper guarantees
//      one doc per unique recipient name.
//   2. Stable tag. Every notification doc carries a `tag` field so the
//      Cloud Function dispatchNotification can pass it through to FCM;
//      same-tag deliveries replace each other at the OS level (no
//      stack-up if retries fire). Without a stable tag the OS shows
//      separate toasts for each retry.
//
// Every helper writes to /notifications/{id} which the dispatchNotification
// Cloud Function picks up + delivers via FCM. Best-effort: failures are
// logged but never thrown — a missing notification should not block the
// underlying action (creating a hire, submitting a doc, etc.).

import { db } from '../firebase';
import { collection, addDoc, doc, getDoc, setDoc, runTransaction, serverTimestamp } from 'firebase/firestore';

// HF-6, 2026-05-30: stable fallback tag bucket. The fallback path for
// callers that didn't pass an explicit `tag` used to be
// `${type}:${Date.now()}` — a per-millisecond tag — which made every
// notif unique and silently defeated the OS-level dedup the `tag` field
// is supposed to provide (see Audit #134, which fixed the explicit-tag
// call sites but missed the fallbacks). A 1-minute bucket strikes the
// balance: rapid retries within the same minute share a tag and dedupe;
// genuinely new notifs across minutes get distinct tags. Per-staff
// flavours of this are formed at the call site by appending `forStaff`.
function fallbackTagBucket() {
    return Math.floor(Date.now() / 60_000);
}

// Resolve a title/body that may be a string OR { en, es } into the
// recipient's preferred language.
//
// 2026-05-16 — the notify() helper inside Schedule.jsx has always done
// this resolution at write time. notifyAdmins didn't, so callers that
// passed { en, es } objects (Schedule's shift-deleted / bulk-delete /
// schedule-published events) wrote raw objects into the notifications
// doc. NotificationsDrawer.jsx renders `{item.title}` directly — for
// object-shaped titles, React throws "Objects are not valid as a React
// child" which crashed the bell drawer on mobile.
function resolveText(val, recipient) {
    if (val == null) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'object') {
        const lang = recipient?.preferredLanguage || 'en';
        return val[lang] || val.en || val.es || '';
    }
    return String(val);
}

// Look up the live MANAGEMENT recipients (owners by id + anyone with
// "manager" or "owner" in their role title). Independent of the
// canViewOnboarding flag, which is scoped to PII access — using it as
// a "who's in charge" filter (as notifyAdmins does) silently misses
// any manager who isn't a PII viewer.
//
// 2026-05-16 — added for schedule events. Andrew (id 40) reported he
// wasn't getting a publish notification because:
//   1. He has no shifts, so the per-staff "your schedule is published"
//      message doesn't fire for him, and
//   2. The admin summary excluded him as the publisher (`excludeStaff`).
// notifyManagement defaults to INCLUDING the actor — managers want a
// bell record of their own actions so they can confirm the publish/
// approve/deny went through. Pass excludeStaff explicitly if a caller
// wants to skip themselves (e.g., a self-action where the toast is
// enough).
export async function getManagementRecipients() {
    try {
        const snap = await getDoc(doc(db, 'config', 'staff'));
        if (!snap.exists()) return [];
        const list = (snap.data() || {}).list || [];
        const seen = new Set();
        const recs = [];
        for (const s of list) {
            if (!s || !s.name) continue;
            const isOwner = s.id === 40 || s.id === 41;
            const roleManager = s.role && /manager|owner/i.test(s.role);
            if (!isOwner && !roleManager) continue;
            // 2026-05-24 audit fix: was deduping by s.name — meaning two
            // managers with the same first/last name silently lost one
            // recipient. We tolerate duplicate names elsewhere (the PIN
            // collision modal on HomePage exists for that exact case),
            // so dedup by the unique staff id, falling back to name only
            // when id is missing (legacy records pre-id-anchoring).
            const dedupKey = s.id != null ? `id:${s.id}` : `name:${s.name}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            recs.push(s);
        }
        return recs;
    } catch (e) {
        console.warn('getManagementRecipients failed:', e);
        return [];
    }
}

// Look up the live admin recipients (people with canViewOnboarding OR
// the two hard-coded owner ids 40 / 41). Dedup by name so a duplicate
// staff entry can't fan out twice.
//
// Returns array of staff records (not just names) so per-recipient
// language preference is available for the title/body resolver below.
// Empty array on any failure — caller must tolerate that.
export async function getAdminRecipients() {
    try {
        const snap = await getDoc(doc(db, 'config', 'staff'));
        if (!snap.exists()) return [];
        const list = (snap.data() || {}).list || [];
        const seen = new Set();
        const recs = [];
        for (const s of list) {
            if (!s || !s.name) continue;
            if (!(s.canViewOnboarding === true || s.id === 40 || s.id === 41)) continue;
            // 2026-05-24 audit fix: dedup by id, see getManagementRecipients.
            const dedupKey = s.id != null ? `id:${s.id}` : `name:${s.name}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            recs.push(s);
        }
        return recs;
    } catch (e) {
        console.warn('getAdminRecipients failed:', e);
        return [];
    }
}

// Write one notification doc per unique admin recipient. The
// dispatchNotification Cloud Function picks each up + sends FCM push.
//
// tag: stable string identifying this LOGICAL event (e.g.
// `app:${appId}`, `hire_doc_submitted:${hireId}:${docId}`). The OS
// replaces same-tag notifications instead of stacking, so retries +
// duplicate sends never produce visible duplicates.
//
// Returns array of created doc ids (or null entries for failures).
export async function notifyAdmins({
    type,
    title,
    body,
    link = '/',
    tag,
    createdBy = 'system',
    excludeStaff = null,
}) {
    const admins = await getAdminRecipients();
    const recipients = excludeStaff
        ? admins.filter(s => s.name !== excludeStaff)
        : admins;
    if (recipients.length === 0) {
        console.info('notifyAdmins: no recipients, skipping');
        return [];
    }
    const ids = await Promise.all(recipients.map(async (recipient) => {
        try {
            const ref = await addDoc(collection(db, 'notifications'), {
                forStaff: recipient.name,
                type,
                // Resolve { en, es } objects to a plain string per the
                // recipient's preferredLanguage. NotificationsDrawer
                // renders these directly — object-shaped titles crash
                // React. See resolveText doc block.
                title: resolveText(title, recipient),
                body: resolveText(body, recipient),
                link,
                tag: tag || `${type}:${fallbackTagBucket()}`,
                createdAt: serverTimestamp(),
                read: false,
                createdBy,
            });
            return ref.id;
        } catch (e) {
            console.warn(`notifyAdmins write failed for ${recipient.name}:`, e);
            return null;
        }
    }));
    return ids;
}

// Fan-out to every owner + manager (regardless of canViewOnboarding).
// Same call signature as notifyAdmins. Defaults to INCLUDING the
// actor so they get a bell-drawer record of their own action — pass
// excludeStaff explicitly to opt out per-call.
//
// Used by Schedule.jsx for: publish, swap approve/deny, PTO request/
// approve/deny/withdraw, shift delete. Anything where the management
// team needs visibility on the action.
export async function notifyManagement({
    type,
    title,
    body,
    link = '/',
    deepLink,
    tag,
    createdBy = 'system',
    excludeStaff = null,
}) {
    const recipients = await getManagementRecipients();
    const filtered = excludeStaff
        ? recipients.filter(s => s.name !== excludeStaff)
        : recipients;
    if (filtered.length === 0) {
        console.info('notifyManagement: no recipients, skipping');
        return [];
    }
    const ids = await Promise.all(filtered.map(async (recipient) => {
        try {
            const ref = await addDoc(collection(db, 'notifications'), {
                forStaff: recipient.name,
                type,
                title: resolveText(title, recipient),
                body: resolveText(body, recipient),
                link,
                ...(deepLink ? { deepLink } : {}),
                tag: tag || `${type}:${fallbackTagBucket()}`,
                createdAt: serverTimestamp(),
                read: false,
                createdBy,
            });
            return ref.id;
        } catch (e) {
            console.warn(`notifyManagement write failed for ${recipient.name}:`, e);
            return null;
        }
    }));
    return ids;
}

// Write one notification doc to a specific staff member. Useful for
// per-recipient events (shift offers, swap approvals, etc.).
//
// noop if forStaff is falsy or matches excludeStaff (so "don't notify
// myself when I do something" is one-call cheap).
//
// deepLink: optional tab name (e.g. 'schedule', 'chat'). The
// NotificationsDrawer reads doc.deepLink and routes the tap to that
// tab via onNavigate. (The older `link` field — typically a URL-like
// '/schedule' string — is kept for legacy compatibility and any Cloud
// Function consumer that reads it, but the in-app drawer ignores it.)
export async function notifyStaff({
    forStaff,
    type,
    title,
    body,
    link = '/',
    deepLink,
    tag,
    priority,        // 'high' | 'normal' (default). 'high' bypasses quiet hours + digests.
    forceDeliver,    // bool — when true, dispatcher bypasses the off-shift gate
    createdBy = 'system',
    excludeStaff = null,
}) {
    if (!forStaff) return null;
    if (excludeStaff && forStaff === excludeStaff) return null;
    try {
        const ref = await addDoc(collection(db, 'notifications'), {
            forStaff,
            type,
            title,
            body,
            link,
            ...(deepLink ? { deepLink } : {}),
            ...(priority ? { priority } : {}),
            ...(forceDeliver === true ? { forceDeliver: true } : {}),
            tag: tag || `${type}:${forStaff}:${fallbackTagBucket()}`,
            createdAt: serverTimestamp(),
            read: false,
            createdBy,
        });
        return ref.id;
    } catch (e) {
        console.warn(`notifyStaff write failed for ${forStaff}:`, e);
        return null;
    }
}

// ── Setup-reminder SMS — TWILIO PATH ───────────────────────────────────
// NOTE (Andrew 2026-05-27): kept in place but currently UNUSED. The
// admin-triggered SMS flow now uses the native sms: URL scheme (admin
// taps a button, native Messages app opens with the text pre-filled,
// admin reviews + hits Send manually). Reason: our Twilio number isn't
// A2P 10DLC-registered yet, so programmatic sends queue but get
// carrier-filtered before delivery. Once registration approves we can
// flip back to this Cloud-Function path with no UI changes — the
// `composeSetupReminderSmsUrl` helper and `stampSetupReminderSent`
// helper below are designed to be drop-in compatible with this path.
//
// Pre-flight checks (all client-side; the Cloud Function does its own
// authoritative gate too):
//   • staff has phoneE164 (can't SMS without one)
//   • staff has smsOptIn === true (CTIA compliance)
//   • staff isn't smsStopped (replied STOP at some point)
//   • last setup_reminder was > REMINDER_COOLDOWN_DAYS ago (don't spam)
//
// Side-effects on success:
//   • One /notifications doc written
//   • staff.setupReminderSentAt stamped (used for the cooldown)
//
// Returns { ok, reason, notificationId } so the caller can show the
// admin what happened (e.g. "Skipped — phone missing for 2 staff").
const REMINDER_COOLDOWN_DAYS = 7;
export async function sendSetupReminderSms(staff, manager, opts = {}) {
    if (!staff?.name || !staff?.phoneE164) {
        return { ok: false, reason: 'no_phone' };
    }
    if (!staff.smsOptIn) {
        return { ok: false, reason: 'not_opted_in' };
    }
    if (staff.smsStopped === true) {
        return { ok: false, reason: 'replied_stop' };
    }
    // Cooldown — keeps an over-eager admin from spamming the same
    // staffer day after day.
    const lastMs = (() => {
        const t = staff.setupReminderSentAt;
        if (!t) return 0;
        if (typeof t === 'number') return t;
        if (typeof t === 'string') return Date.parse(t) || 0;
        if (typeof t?.toMillis === 'function') return t.toMillis();
        return 0;
    })();
    if (!opts.force && lastMs && Date.now() - lastMs < REMINDER_COOLDOWN_DAYS * 86400000) {
        return { ok: false, reason: 'cooldown', lastSentMs: lastMs };
    }

    // First name only — SMS templates render {firstName}.
    const firstName = (staff.name || '').split(/\s+/)[0] || 'there';
    // App URL — staff taps this to open the PWA. Hardcoded prod URL
    // since this SMS goes to phones, not browsers under our control.
    const url = 'https://app.ddmaustl.com/';

    try {
        // Write the /notifications doc. dispatchSms will fan it out
        // via Twilio; dispatchNotification will also try push, which
        // is a no-op for users with no FCM tokens (the typical
        // setup-reminder target).
        const ref = await addDoc(collection(db, 'notifications'), {
            forStaff: staff.name,
            type: 'setup_reminder',
            title: 'Finish setting up DD Mau',
            body: `Hi ${firstName}, open the app and turn on notifications so you don't miss messages.`,
            link: '/',
            // smsVars: the dispatchSms renderer reads notif.smsVars to
            // fill {firstName} / {url} placeholders in the template.
            smsVars: { firstName, url },
            // Bypass off-shift quiet hours — setup reminders are not
            // time-sensitive, but skipping them defeats the purpose.
            forceDeliver: true,
            // HF-6, 2026-05-30: day-bucket so two attempts in the same
            // day share a tag and the OS / dispatch-side dedup catches
            // retries. Daily cadence is appropriate here because the
            // function itself enforces a REMINDER_COOLDOWN_DAYS gate
            // before getting this far — there is never a legitimate
            // case for two real setup reminders to the same staff on
            // the same day.
            tag: `setup_reminder:${staff.name}:${Math.floor(Date.now() / 86400_000)}`,
            createdAt: serverTimestamp(),
            read: false,
            createdBy: manager?.name || 'admin',
            createdById: manager?.id ?? null,
        });

        // Stamp the cooldown marker on the staff doc.
        // HF-1, 2026-05-30: read+modify+set raced with concurrent admin
        // edits of the staff doc — both writes had stale `list` data
        // and one silently won. Wrap in a transaction so the inner
        // read re-runs on conflict.
        try {
            const stRef = doc(db, 'config', 'staff');
            await runTransaction(db, async (tx) => {
                const snap = await tx.get(stRef);
                const list = (snap.exists() ? snap.data().list : []) || [];
                const next = list.map((s) => s && s.name === staff.name
                    ? { ...s, setupReminderSentAt: Date.now() }
                    : s
                );
                tx.set(stRef, { list: next });
            });
        } catch (e) {
            console.warn('setupReminderSentAt stamp failed (non-fatal):', e);
        }
        return { ok: true, notificationId: ref.id };
    } catch (e) {
        console.warn(`sendSetupReminderSms write failed for ${staff.name}:`, e);
        return { ok: false, reason: 'write_failed' };
    }
}

// ── Setup-reminder SMS — MANUAL PATH (sms: URL scheme) ─────────────
// 2026-05-27 — Andrew: "make a text to text like we do in onboarding.
// so i or any admin can go through and send a text through my phone
// and its not automatic." Mirrors the pattern in
// src/components/Onboarding.jsx (line 1701):
//   `sms:${phone}?body=${encodeURIComponent(message)}`
//
// Tapping an <a href={url}> on iPhone / Android opens the native
// Messages app pre-populated with the recipient + body. The admin
// reviews + taps Send. No Twilio, no Cloud Function, no A2P
// registration required — the SMS goes out via the admin's own cell
// carrier, from the admin's own number.
//
// Trade-offs vs. the Twilio path:
//   ✓ Works today (no carrier registration needed)
//   ✓ Staff see a familiar local number (the admin's cell)
//   ✓ No per-message cost (uses admin's existing carrier plan)
//   ✗ Manual — admin has to tap each one
//   ✗ No delivery telemetry (no Twilio status callback)
//   ✗ Limited by the admin's phone's carrier (rate limits apply)
//
// Returns { url, body } so the caller can use the URL in an <a href>
// and optionally show the rendered body for preview.
export function composeSetupReminderSmsUrl(staff, language = 'en') {
    const isEs = language === 'es';
    const firstName = (staff?.name || '').split(/\s+/)[0] || (isEs ? 'hola' : 'there');
    const url = 'https://app.ddmaustl.com/';
    const body = isEs
        ? `Hola ${firstName}, abre la app DD Mau y activa notificaciones para no perder turnos: ${url}`
        : `Hi ${firstName}, please open the DD Mau app and turn on notifications so you don't miss schedule alerts: ${url}`;
    const phone = staff?.phoneE164 || '';
    // RFC 5724 / iOS / Android compatible: `sms:NUMBER?body=...`. The
    // `?body=` form is preferred over `;body=` (some Android skins only
    // honor `?`). encodeURIComponent does the right thing for the body
    // text. Phone goes raw (E.164 + already URL-safe).
    const smsUrl = phone
        ? `sms:${phone}?body=${encodeURIComponent(body)}`
        : null;
    return { url: smsUrl, body, phone };
}

// Stamp the cooldown marker on the staff doc so the same staffer
// isn't pinged twice in REMINDER_COOLDOWN_DAYS. Called by the audit
// panel when the admin taps the SMS link — we assume they hit Send,
// since we can't observe what happens in the native Messages app.
// (Conservative: if the admin opens the SMS app and then cancels, we
// still set the marker. Admin can manually clear by editing staff or
// pass {force: true} to sendSetupReminderSms to override.)
export async function stampSetupReminderSent(staffName) {
    if (!staffName) return { ok: false, reason: 'no_staff' };
    try {
        // HF-1, 2026-05-30: transaction-wrapped to avoid silent clobber
        // when an admin is editing staff at the same time the manual SMS
        // send completes.
        const stRef = doc(db, 'config', 'staff');
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(stRef);
            const list = (snap.exists() ? snap.data().list : []) || [];
            const next = list.map((s) => s && s.name === staffName
                ? { ...s, setupReminderSentAt: Date.now() }
                : s
            );
            tx.set(stRef, { list: next });
        });
        return { ok: true };
    } catch (e) {
        console.warn('stampSetupReminderSent failed:', e);
        return { ok: false, reason: 'write_failed' };
    }
}
