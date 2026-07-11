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

// Append ONE new staff record to the roster, race-safely (Andrew
// 2026-07-11: "in the onboarding make a button that moves the new hire
// to the staff page"). Runs in a transaction per the roster-write rule:
// read the server list, append, bump rev — never writes a list built
// from client state. Assigns the next id (max+1, same as add-staff)
// and a random UNUSED 4-digit PIN (saveStaffToFirestore's PIN gate
// requires one; the admin changes it on the Staff page).
//
// Returns { ok:true, id, pin } or { ok:false, error } where error is
// 'no_name' | 'name_exists' | 'no_doc' | <firestore message>.
export async function appendStaffRecord({ name, record = {} }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { ok: false, error: 'no_name' };
    try {
        const { doc, runTransaction } = await import('firebase/firestore');
        const { db } = await import('../firebase');
        let assignedPin = null;
        let assignedId = null;
        await runTransaction(db, async (tx) => {
            const ref = doc(db, 'config', 'staff');
            const snap = await tx.get(ref);
            if (!snap.exists()) {
                const e = new Error('no_doc'); e.code = 'no_doc'; throw e;
            }
            const data = snap.data() || {};
            const list = data.list || [];
            if (list.some(s => String(s?.name || '').trim().toLowerCase() === trimmed.toLowerCase())) {
                const e = new Error('name_exists'); e.code = 'name_exists'; throw e;
            }
            const maxId = list.reduce((m, s) => Math.max(m, Number(s?.id) || 0), 0);
            const used = new Set(list.map(s => String(s?.pin ?? '').trim()));
            let pin;
            do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (used.has(pin));
            assignedPin = pin;
            assignedId = maxId + 1;
            tx.set(ref, {
                list: [...list, { ...record, name: trimmed, id: assignedId, pin }],
                rev: nextStaffRev(data),
            });
        });
        return { ok: true, id: assignedId, pin: assignedPin };
    } catch (e) {
        return { ok: false, error: e?.code || e?.message || 'failed' };
    }
}
