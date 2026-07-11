// Revision tracking for the single /config/staff roster doc.
//
// 2026-07-11 — Andrew's staff renames REVERTED overnight. Root cause:
// the lastSignInAt / pwaInstalled stamps (v1.0.227) did a plain
// getDoc → modify one record → setDoc of the WHOLE list from every
// staff phone at sign-in. On install day, any phone that read the
// list moments before an admin rename and wrote back moments after
// silently restored the pre-rename roster. Classic read-modify-write
// race, no cache needed.
//
// The fix has two parts:
//   1. Every roster writer runs inside a TRANSACTION that re-reads the
//      server list and patches only what it means to change (stamps +
//      fcmTokens patch one record; admin saves write the list they
//      edited). Transactions always read from the server — an offline
//      device errors out instead of queueing a stale overwrite.
//   2. Every transactional write bumps a monotonic `rev` on the doc.
//      The admin whole-list save aborts when the server rev no longer
//      matches the rev its on-screen list was built from — catching
//      the same-size concurrent edits the old length-only guard
//      (HF-7) could not see.
//
// STAFF_DOC.rev is a module singleton fed by App.jsx's /config/staff
// onSnapshot — it always holds the rev of the roster the UI currently
// shows. `undefined` = no snapshot yet this session (guard skipped).

export const STAFF_DOC = { rev: undefined };

export function noteStaffSnapshot(data) {
    STAFF_DOC.rev = (data && typeof data.rev === 'number') ? data.rev : null;
}

// Next revision value for a transactional write, given the doc data
// the transaction just read.
export function nextStaffRev(data) {
    const cur = (data && typeof data.rev === 'number') ? data.rev : 0;
    return cur + 1;
}
