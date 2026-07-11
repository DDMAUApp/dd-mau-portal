// Deleted-staff archive — Andrew 2026-07-10: "keep a list of deleted
// staff members so we can look back at info if needed."
//
// Before this, handleRemoveStaff dropped the person from the roster
// doc and their record was simply GONE (only side-effects like
// opened shifts hinted they ever existed). Now every removal writes
// a full snapshot to /staff_archive first — removal is ABORTED if
// the archive write fails, so a deletion can never lose the record.
//
// Doc shape (/staff_archive/{autoId}):
//   name        — denormalized for list rendering
//   staffId     — their roster id at deletion (informational only;
//                 restore assigns a fresh id to avoid collisions)
//   record      — the full staff record as it was at deletion
//                 (includes the pin so Restore is one tap — same
//                 exposure class as the roster doc itself)
//   archivedAt / archivedBy
//   restored / restoredAt / restoredBy — set when re-added
//   backfilled  — true on stub entries reconstructed from shift
//                 history for staff deleted BEFORE this existed
//                 (those have name-only records)

import { db } from '../firebase';
import {
    addDoc, collection, doc, onSnapshot, orderBy, query, limit,
    serverTimestamp, updateDoc,
} from 'firebase/firestore';

const COLLECTION = 'staff_archive';

export async function archiveRemovedStaff(person, byName) {
    if (!person || !person.name) throw new Error('nothing to archive');
    // JSON round-trip strips `undefined` values, which Firestore rejects.
    const record = JSON.parse(JSON.stringify(person));
    const ref = await addDoc(collection(db, COLLECTION), {
        name: person.name,
        staffId: person.id ?? null,
        record,
        archivedAt: serverTimestamp(),
        archivedBy: byName || 'admin',
        restored: false,
    });
    return ref.id;
}

// Live list, newest deletion first. cb receives [{id, ...doc}]. Returns
// an unsubscribe.
export function subscribeStaffArchive(cb, max = 100) {
    const qq = query(collection(db, COLLECTION), orderBy('archivedAt', 'desc'), limit(max));
    return onSnapshot(qq, (snap) => {
        cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, (e) => {
        console.warn('staff_archive subscribe failed:', e);
        cb([]);
    });
}

export async function markArchiveRestored(archiveId, byName) {
    await updateDoc(doc(db, COLLECTION, archiveId), {
        restored: true,
        restoredAt: serverTimestamp(),
        restoredBy: byName || 'admin',
    });
}
