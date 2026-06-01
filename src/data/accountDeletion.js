// Account deletion request flow — Apple + Google App Store compliance.
//
// 2026-05-31. Both stores require that any app allowing account
// creation also allow in-app account deletion. The flow:
//   1. Staff taps "Delete my account" in the sidebar footer.
//   2. We write a doc to /staff_deletion_requests/{requestId} with
//      requesterName + requestedAt + status: 'pending'.
//   3. An owner (Andrew or Julie) sees the pending list inside
//      AdminPanel (a future tab) and decides whether to approve.
//   4. On approve, a Cloud Function (or manual admin action) removes
//      the staff entry from /config/staff.list, archives any
//      onboarding_hires record, wipes FCM tokens, and writes a row
//      to /staff_deletion_audits.
//
// The 7-day grace window between request and execution is Apple's
// guideline — gives the user time to undo a mistaken tap. During
// that window the user can withdraw the request from the same UI.
//
// What this module does NOT do:
//   • Actually delete anything. Deletion is admin-driven so we
//     don't accidentally nuke records via a tampered client.
//   • Email the user. We rely on the in-app toast + the manager
//     manually contacting them if needed.

import { collection, addDoc, serverTimestamp, query, where, getDocs, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Submit a deletion request for the named staff member. Idempotent:
 * if a pending request already exists we surface that rather than
 * creating a duplicate.
 *
 * @returns {Promise<{ok: boolean, reason?: string, requestId?: string}>}
 */
export async function requestAccountDeletion(staffName) {
    if (!staffName || typeof staffName !== 'string') {
        return { ok: false, reason: 'no-staff-name' };
    }
    try {
        // Check for an existing pending request first.
        const q = query(
            collection(db, 'staff_deletion_requests'),
            where('requesterName', '==', staffName),
            where('status', '==', 'pending'),
        );
        const existing = await getDocs(q);
        if (!existing.empty) {
            return { ok: true, reason: 'already-pending', requestId: existing.docs[0].id };
        }
        // Create the request.
        const ref = await addDoc(collection(db, 'staff_deletion_requests'), {
            requesterName: staffName,
            status: 'pending',
            requestedAt: serverTimestamp(),
            requestedAtIso: new Date().toISOString(),
            // Source label for triage — phone (native) vs desktop (web).
            source: (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) ? 'native' : 'web',
            note: '',
        });
        return { ok: true, requestId: ref.id };
    } catch (e) {
        console.warn('[accountDeletion] request failed:', e?.message);
        return { ok: false, reason: e?.message || 'write-failed' };
    }
}

/**
 * Withdraw a pending request the same staff member submitted earlier.
 * Used by the "I changed my mind" undo button. Sets status to
 * 'withdrawn' rather than deleting the doc so the audit trail
 * remains intact.
 */
export async function withdrawAccountDeletion(requestId, staffName) {
    if (!requestId || !staffName) return { ok: false, reason: 'bad-args' };
    try {
        await updateDoc(doc(db, 'staff_deletion_requests', requestId), {
            status: 'withdrawn',
            withdrawnAt: serverTimestamp(),
            withdrawnBy: staffName,
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e?.message || 'write-failed' };
    }
}
