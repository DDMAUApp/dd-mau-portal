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

// Look up the live admin recipients (people with canViewOnboarding OR
// the two hard-coded owner ids 40 / 41). Dedup by name so a duplicate
// staff entry can't fan out twice.
//
// Returns array of staff names. Empty array on any failure — caller
// must tolerate that (the helpers below skip silently).
export async function getAdminRecipients() {
    try {
        const snap = await getDoc(doc(db, 'config', 'staff'));
        if (!snap.exists()) return [];
        const list = (snap.data() || {}).list || [];
        const seen = new Set();
        const names = [];
        for (const s of list) {
            if (!s || !s.name) continue;
            if (!(s.canViewOnboarding === true || s.id === 40 || s.id === 41)) continue;
            if (seen.has(s.name)) continue;
            seen.add(s.name);
            names.push(s.name);
        }
        return names;
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
        ? admins.filter(n => n !== excludeStaff)
        : admins;
    if (recipients.length === 0) {
        console.info('notifyAdmins: no recipients, skipping');
        return [];
    }
    const ids = await Promise.all(recipients.map(async (name) => {
        try {
            const ref = await addDoc(collection(db, 'notifications'), {
                forStaff: name,
                type,
                title,
                body,
                link,
                tag: tag || `${type}:${Date.now()}`,
                createdAt: serverTimestamp(),
                read: false,
                createdBy,
            });
            return ref.id;
        } catch (e) {
            console.warn(`notifyAdmins write failed for ${name}:`, e);
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
export async function notifyStaff({
    forStaff,
    type,
    title,
    body,
    link = '/',
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
