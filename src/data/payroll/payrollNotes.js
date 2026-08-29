// Payroll notes & reminders (2026-08-29, Andrew: "i want to remind myself
// that edith needs to be paid vacation pay … my name and time stamp … a done
// box to check or uncheck that puts a line through the reminder").
//
// One tiny top-level collection, /payroll_notes — same posture as the other
// payroll docs (payrollStore.js header: new payroll collections ride the
// catch-all rule, no rules deploy needed; the real gate is the owner-only +
// password-locked panel that is the only reader/writer).
//
// Doc shape: { text, byName, createdAt(serverTimestamp), done:boolean,
//              doneBy:string|null, doneAt:serverTimestamp|null }
// Done is a TOGGLE (uncheck clears doneBy/doneAt) — the note itself is never
// altered, so the author + original timestamp always stand.

import {
    collection, query, orderBy, limit, onSnapshot,
    addDoc, updateDoc, deleteDoc, doc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../firebase.js';

const COL = 'payroll_notes';
const MAX_TEXT = 2000;

/** Live-subscribe, newest first. cb(list) — or cb(null) on a listener error
 *  so the UI can show a retry instead of silently freezing. */
export function subscribePayrollNotes(cb) {
    const q = query(collection(db, COL), orderBy('createdAt', 'desc'), limit(200));
    return onSnapshot(q,
        (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => { console.warn('payroll notes snapshot failed:', err); cb(null); });
}

export async function addPayrollNote({ text, byName }) {
    const body = String(text || '').trim().slice(0, MAX_TEXT);
    if (!body) return { ok: false, error: 'empty' };
    try {
        const ref = await addDoc(collection(db, COL), {
            text: body,
            byName: String(byName || 'unknown'),
            createdAt: serverTimestamp(),
            done: false,
            doneBy: null,
            doneAt: null,
        });
        return { ok: true, id: ref.id };
    } catch (e) {
        console.warn('addPayrollNote failed:', e);
        return { ok: false, error: e?.message || 'write failed' };
    }
}

export async function setPayrollNoteDone(id, done, byName) {
    try {
        await updateDoc(doc(db, COL, id), {
            done: !!done,
            doneBy: done ? String(byName || 'unknown') : null,
            doneAt: done ? serverTimestamp() : null,
        });
        return { ok: true };
    } catch (e) {
        console.warn('setPayrollNoteDone failed:', e);
        return { ok: false, error: e?.message || 'write failed' };
    }
}

export async function deletePayrollNote(id) {
    try {
        await deleteDoc(doc(db, COL, id));
        return { ok: true };
    } catch (e) {
        console.warn('deletePayrollNote failed:', e);
        return { ok: false, error: e?.message || 'delete failed' };
    }
}
