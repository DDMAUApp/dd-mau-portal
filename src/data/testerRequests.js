// ── Android tester emails (Andrew 2026-11-14) ─────────────────────────
// "is there a place i can see the emails?" — the lock-screen Install app
// sheet writes each Android staffer's Google email to /tester_requests
// (InstallAppButton.jsx) and pings managers, but nothing in the app listed
// them; once the push was cleared the only place to find one was the
// Firebase console. Admin → Staff → Android testers now reads them here.
//
// Doc shape (written by InstallAppButton): { email, platform:'android',
// status:'pending', createdAt, userAgent }. Admin marks a row 'added' (pasted
// into Play Console → Closed testing → Testers) or 'dismissed' (junk/typo).
// Never deleted — the record stays as history.
import { db } from '../firebase';
import { collection, doc, onSnapshot, orderBy, query, limit, updateDoc, serverTimestamp } from 'firebase/firestore';

export function subscribeTesterRequests(cb, max = 300) {
    const q = query(collection(db, 'tester_requests'), orderBy('createdAt', 'desc'), limit(max));
    return onSnapshot(q,
        (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => { console.warn('subscribeTesterRequests failed:', err); cb([]); });
}

export async function setTesterRequestStatus(id, status, byName) {
    await updateDoc(doc(db, 'tester_requests', id), {
        status,                        // 'added' | 'dismissed' | 'pending' (undo)
        handledBy: byName || null,
        handledAt: serverTimestamp(),
    });
}

// Same address submitted twice (staffer tapped Send again) → show once, keep
// the newest row. Rows arrive newest-first.
export function dedupeByEmail(rows) {
    const seen = new Set();
    const out = [];
    for (const r of rows || []) {
        const key = String(r?.email || '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    return out;
}
