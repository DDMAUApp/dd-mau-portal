// staffTodos — the "what do I still need to do?" list rendered on the
// staff Home page (MobileHome + HomeV2).
//
// Two flavors of todo, unified into one renderable list:
//
//   1. AUTO TODOS — computed client-side from the current staff record.
//      Disappear automatically when the underlying field is filled.
//      Examples: missing birthday, missing weekly availability.
//      No Firestore persistence; just functions over the staff doc.
//
//   2. CUSTOM TODOS — admin-defined, stored in /staff_todos/{id}.
//      Targeted at 'all' or a specific list of staff names. Each
//      staff acks them via the "Done" button which writes their
//      name + timestamp into the doc's completedBy map.
//      Manage via AdminPanel → Staff Todos.
//
// Firestore shape:
//   /staff_todos/{id} = {
//     titleEn:   string,
//     titleEs:   string,            // optional, falls back to en
//     bodyEn:    string,            // optional
//     bodyEs:    string,            // optional
//     emoji:     string,            // optional icon, defaults to '📌'
//     audience:  'all' | string[],  // staff names, or 'all'
//     deepLink:  string?,           // optional tab id ('schedule', 'recipes', ...)
//     completedBy: { [staffName: string]: Timestamp },  // per-staff dismissal
//     active:    boolean,           // false = soft-archived (hidden from staff)
//     createdAt: Timestamp,
//     createdBy: string,            // admin name
//   }

import { db } from '../firebase';
import {
    collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc,
    serverTimestamp,
} from 'firebase/firestore';

// SessionStorage key that Schedule.jsx reads on mount to auto-open one
// of its self-serve modals (availability / birthday). Set when the staff
// taps an auto-todo, navigate to Schedule, the modal opens, then the
// key clears.
export const OPEN_MODAL_KEY = 'ddmau:scheduleOpenModal';

// Auto-todos — compute from the current staff record. Each one carries:
//   id      — stable for keying React lists
//   emoji   — visual marker
//   titleEn, titleEs
//   bodyEn, bodyEs (optional)
//   deepLink — tab id; we navigate the user there on tap
//   openModalKey — sessionStorage marker so the target tab auto-opens
//                  the right modal/section
//
// Filtering: only include todos for fields that are MISSING — the
// presence of the todo IS the prompt to fill it in. Once the field is
// set, the todo naturally disappears on the next render.
//
// Pass `viewer = currentStaffRecord` from App.jsx.
export function getAutoTodos(viewer) {
    if (!viewer) return [];
    const out = [];

    // Birthday — staff.birthday is an MM-DD string. Empty / missing →
    // surface a todo. Used by Schedule's events strip to display "🎂
    // Maria's birthday" chips.
    const hasBirthday = typeof viewer.birthday === 'string' && /^\d{2}-\d{2}$/.test(viewer.birthday.trim());
    if (!hasBirthday) {
        out.push({
            id: 'auto:birthday',
            emoji: '🎂',
            titleEn: 'Add your birthday',
            titleEs: 'Agrega tu cumpleaños',
            bodyEn: 'So we can wish you happy birthday 🎉',
            bodyEs: 'Para poder desearte feliz cumpleaños 🎉',
            deepLink: 'schedule',
            openModal: 'birthday',
            // Not persisted; auto-todos don't get "Done" buttons. The
            // todo vanishes when the field is filled.
            kind: 'auto',
        });
    }

    // Availability — staff.availability is a per-day map. Missing /
    // empty → surface a todo. Auto-fill uses availability to suggest
    // shifts; staff with no availability set never get auto-suggested.
    const av = viewer.availability;
    const hasAvail = av && typeof av === 'object' && Object.keys(av).length > 0;
    if (!hasAvail) {
        out.push({
            id: 'auto:availability',
            emoji: '🗓',
            titleEn: 'Set your weekly availability',
            titleEs: 'Establece tu disponibilidad',
            bodyEn: 'Tell us which days + hours you can work each week.',
            bodyEs: 'Dinos qué días y horas puedes trabajar cada semana.',
            deepLink: 'schedule',
            openModal: 'availability',
            kind: 'auto',
        });
    }

    return out;
}

// Subscribe to active custom todos for this staff member. Returns the
// unsubscribe function. Filters CLIENT-SIDE because Firestore can't
// query "audience == 'all' OR audience array-contains me" in one shot
// without composite indexes — and the staff_todos collection is small
// (admin-managed, expected size <50 active).
//
// Callback receives [{ id, ...doc }] sorted by createdAt desc.
export function subscribeCustomTodos(staffName, callback) {
    if (!staffName || typeof callback !== 'function') return () => {};
    const ref = collection(db, 'staff_todos');
    return onSnapshot(ref, (snap) => {
        const out = [];
        snap.forEach(d => {
            const data = d.data() || {};
            if (data.active === false) return;
            // Audience filter — 'all' OR an array containing this staff.
            const aud = data.audience;
            const targeted = aud === 'all' ||
                (Array.isArray(aud) && aud.includes(staffName));
            if (!targeted) return;
            // Skip ones this staff has already marked done.
            if (data.completedBy && data.completedBy[staffName]) return;
            out.push({ id: d.id, ...data, kind: 'custom' });
        });
        // Sort newest first so freshly-added todos surface at the top.
        out.sort((a, b) => {
            const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
            const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
            return bt - at;
        });
        callback(out);
    }, (err) => {
        console.warn('staff_todos subscribe failed:', err);
        callback([]);
    });
}

// Subscribe to ALL custom todos for admin management UI — no audience
// filter, includes archived (`active: false`) so admin can restore them.
export function subscribeAllCustomTodos(callback) {
    if (typeof callback !== 'function') return () => {};
    const ref = collection(db, 'staff_todos');
    return onSnapshot(ref, (snap) => {
        const out = [];
        snap.forEach(d => out.push({ id: d.id, ...(d.data() || {}) }));
        out.sort((a, b) => {
            const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
            const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
            return bt - at;
        });
        callback(out);
    }, (err) => {
        console.warn('staff_todos admin subscribe failed:', err);
        callback([]);
    });
}

// Mark a custom todo as done by this staff. Writes completedBy.{name} =
// serverTimestamp. Dot-path so we don't clobber other staff's
// completion timestamps.
export async function markTodoDone(todoId, staffName) {
    if (!todoId || !staffName) return;
    try {
        await updateDoc(doc(db, 'staff_todos', todoId), {
            [`completedBy.${staffName}`]: serverTimestamp(),
        });
    } catch (e) {
        console.warn('markTodoDone failed:', e);
        throw e;
    }
}

// Reset a custom todo's completion for one staff (admin action — useful
// when re-issuing the same todo without creating a new one).
export async function clearCompletionFor(todoId, staffName) {
    if (!todoId || !staffName) return;
    try {
        // Firestore lets us write `null` to remove a key from a map via
        // dot-path; we use FieldValue.delete() for the truer "remove
        // the key" semantics, imported lazily so this module stays
        // skinny for the staff-side consumers that don't need it.
        const { deleteField } = await import('firebase/firestore');
        await updateDoc(doc(db, 'staff_todos', todoId), {
            [`completedBy.${staffName}`]: deleteField(),
        });
    } catch (e) {
        console.warn('clearCompletionFor failed:', e);
        throw e;
    }
}

// Admin: create a new custom todo. Returns the new doc id.
export async function createCustomTodo({
    titleEn, titleEs, bodyEn, bodyEs, emoji, audience, deepLink, createdBy,
}) {
    const payload = {
        titleEn: (titleEn || '').trim(),
        titleEs: (titleEs || titleEn || '').trim(),
        bodyEn: (bodyEn || '').trim(),
        bodyEs: (bodyEs || bodyEn || '').trim(),
        emoji: emoji || '📌',
        audience: audience || 'all',
        deepLink: deepLink || null,
        completedBy: {},
        active: true,
        createdAt: serverTimestamp(),
        createdBy: createdBy || 'system',
    };
    const ref = await addDoc(collection(db, 'staff_todos'), payload);
    return ref.id;
}

// Admin: update a custom todo (partial). Pass only the fields you want
// changed.
export async function updateCustomTodo(todoId, patch) {
    if (!todoId || !patch) return;
    await updateDoc(doc(db, 'staff_todos', todoId), patch);
}

// Admin: soft-archive a todo (sets active:false). Use this in preference
// to delete so the completedBy audit trail survives.
export async function archiveCustomTodo(todoId) {
    if (!todoId) return;
    await updateDoc(doc(db, 'staff_todos', todoId), { active: false });
}

// Admin: restore an archived todo.
export async function unarchiveCustomTodo(todoId) {
    if (!todoId) return;
    await updateDoc(doc(db, 'staff_todos', todoId), { active: true });
}

// Admin: hard-delete. Loses the completedBy audit trail — prefer
// archive in normal use.
export async function deleteCustomTodo(todoId) {
    if (!todoId) return;
    await deleteDoc(doc(db, 'staff_todos', todoId));
}
