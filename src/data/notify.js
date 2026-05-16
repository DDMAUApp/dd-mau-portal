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
import { collection, addDoc, doc, getDoc, serverTimestamp } from 'firebase/firestore';

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
            if (seen.has(s.name)) continue;
            seen.add(s.name);
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
                tag: tag || `${type}:${Date.now()}`,
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
            tag: tag || `${type}:${forStaff}:${Date.now()}`,
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
