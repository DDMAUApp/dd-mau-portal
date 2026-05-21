// assignedTasks — per-staff task assignments + library of past tasks.
//
// Backs the new "Assign Tasks" sub-tab inside Operations (manager view)
// and the new top-level "My Tasks" tab (staff view).
//
// ── Data model ──────────────────────────────────────────────────────────
//
//   /assigned_tasks/{autoId}
//     {
//       staffId:       number,         // recipient id from /config/staff
//       staffName:     string,         // recipient name (denormalized for display)
//       side:          'FOH' | 'BOH',  // canonical, uppercase
//       task:          string,
//       category:      string,         // matches Operations TASK_CATEGORIES
//       assignedBy:    string,         // manager name (display)
//       assignedById:  number|null,    // manager id
//       assignedAt:    Timestamp,      // serverTimestamp
//       done:          boolean,
//       doneAt:        Timestamp|null,
//       doneBy:        string|null,    // staff name on done-toggle
//     }
//
//   /config/task_library_FOH
//   /config/task_library_BOH
//     {
//       items: [
//         { id, task, category, useCount, lastUsedAt (ms) }
//       ],
//       side: 'FOH' | 'BOH',
//       updatedAt: Timestamp,
//     }
//
// One library doc per side (not per location). Andrew has 2 stores but
// the same set of FOH/BOH tasks applies at both — keeping the library
// global avoids forking it. If a location-specific library is needed
// later, suffix the doc key.
//
// ── Why one batched write on assign ────────────────────────────────────
// Library bumps + assignment creates must be atomic — if only half
// commits we either lose the library entry (next manager has to retype)
// or lose the assignment (staff doesn't see it). One writeBatch =
// all-or-nothing.

import { db } from '../firebase';
import {
    collection, doc, getDoc, onSnapshot, query, where,
    writeBatch, updateDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';

// ── SUBSCRIPTIONS ──────────────────────────────────────────────────────

// All assignments for one staffer (by id). Returns unsubscribe.
// Sorted client-side: incomplete first by assignedAt desc, then complete
// by doneAt desc. No orderBy in the query so we don't need a composite
// Firestore index — a single where() on staffId is enough.
export function subscribeAssignmentsForStaff(staffId, callback) {
    if (staffId == null || typeof callback !== 'function') return () => {};
    const q = query(collection(db, 'assigned_tasks'), where('staffId', '==', staffId));
    return onSnapshot(q, (snap) => {
        const out = [];
        snap.forEach((d) => out.push({ id: d.id, ...(d.data() || {}) }));
        out.sort((a, b) => {
            if (!!a.done !== !!b.done) return a.done ? 1 : -1;
            const at = (a.done ? a.doneAt : a.assignedAt)?.toMillis?.() || 0;
            const bt = (b.done ? b.doneAt : b.assignedAt)?.toMillis?.() || 0;
            return bt - at;
        });
        callback(out);
    }, (err) => {
        console.warn('subscribeAssignmentsForStaff failed:', err);
        callback([]);
    });
}

// Subscribe to the task library for one side. Returns unsubscribe.
export function subscribeTaskLibrary(side, callback) {
    if (!side || typeof callback !== 'function') return () => {};
    const ref = doc(db, 'config', `task_library_${side}`);
    return onSnapshot(ref, (snap) => {
        const data = snap.exists() ? snap.data() : null;
        const items = Array.isArray(data?.items) ? data.items : [];
        callback(items);
    }, (err) => {
        console.warn('subscribeTaskLibrary failed:', err);
        callback([]);
    });
}

// ── HELPERS ────────────────────────────────────────────────────────────

// Case-insensitive find by task text (trims + lowercases both sides so
// "Clean grill" and "clean grill " are the same library row).
function findLibraryItemIdx(items, taskText) {
    const norm = (taskText || '').trim().toLowerCase();
    if (!norm) return -1;
    return items.findIndex((it) => (it.task || '').trim().toLowerCase() === norm);
}

// Library row id — short slug + random tail. Stable for React keys.
function makeLibraryId(taskText) {
    const slug = (taskText || '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 28);
    return `lib_${slug || 'task'}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── WRITES ─────────────────────────────────────────────────────────────

// Assign N tasks to a staff member. Atomically:
//   1. Upserts each task into the side's library (new row OR bump useCount)
//   2. Creates one /assigned_tasks/ doc per task
//
// Within-batch de-dupe: if the manager added the same task text twice in
// one draft (case-insensitive), we keep the first occurrence only.
//
// Inputs:
//   tasks   = [{ task: string, category?: string }]
//   staff   = { id: number, name: string }   — recipient
//   manager = { id: number|null, name: string }  — assigner
//   side    = 'FOH' | 'BOH'
export async function assignTasksToStaff({ tasks, staff, manager, side }) {
    const cleanTasks = (Array.isArray(tasks) ? tasks : [])
        .map((t) => ({
            task: (t?.task || '').trim(),
            category: (t?.category || 'other').trim() || 'other',
        }))
        .filter((t) => t.task);
    if (cleanTasks.length === 0) return { writes: 0 };
    if (!staff?.id || !staff?.name || !side) {
        throw new Error('assignTasksToStaff: missing staff/side');
    }

    // De-dupe within this batch (case-insensitive).
    const seen = new Set();
    const deduped = [];
    for (const t of cleanTasks) {
        const k = t.task.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        deduped.push(t);
    }

    // Read current library doc so we can compute the new items array
    // client-side. getDoc is one read; the writeBatch below makes it
    // atomic with the assignment creates.
    const libRef = doc(db, 'config', `task_library_${side}`);
    const libSnap = await getDoc(libRef);
    const libData = libSnap.exists() ? libSnap.data() : null;
    const libItems = Array.isArray(libData?.items) ? [...libData.items] : [];

    const nowMs = Date.now();
    for (const t of deduped) {
        const idx = findLibraryItemIdx(libItems, t.task);
        if (idx >= 0) {
            libItems[idx] = {
                ...libItems[idx],
                // Preserve task text as originally written (so casing the
                // library was created with sticks); just bump counters.
                useCount: (libItems[idx].useCount || 0) + 1,
                lastUsedAt: nowMs,
                // Patch category if the previous entry didn't have one.
                category: libItems[idx].category || t.category,
            };
        } else {
            libItems.push({
                id: makeLibraryId(t.task),
                task: t.task,
                category: t.category,
                useCount: 1,
                lastUsedAt: nowMs,
            });
        }
    }

    const batch = writeBatch(db);
    batch.set(libRef, {
        items: libItems,
        side,
        updatedAt: serverTimestamp(),
    }, { merge: true });

    const assignmentsCol = collection(db, 'assigned_tasks');
    for (const t of deduped) {
        const ref = doc(assignmentsCol); // auto-id
        batch.set(ref, {
            staffId: staff.id,
            staffName: staff.name,
            side,
            task: t.task,
            category: t.category,
            assignedBy: manager?.name || 'system',
            assignedById: manager?.id ?? null,
            assignedAt: serverTimestamp(),
            done: false,
            doneAt: null,
            doneBy: null,
        });
    }

    await batch.commit();
    return { writes: deduped.length };
}

// Toggle done on an assignment (staff action). Writes done + doneAt + doneBy.
// Passing done:false re-opens (clears doneAt + doneBy).
export async function setAssignmentDone(assignmentId, { done, staffName }) {
    if (!assignmentId) return;
    await updateDoc(doc(db, 'assigned_tasks', assignmentId), {
        done: !!done,
        doneAt: done ? serverTimestamp() : null,
        doneBy: done ? (staffName || null) : null,
    });
}

// Hard-delete an assignment (manager backs out of a mistake). Library
// entry survives so the task text is still available next time.
export async function deleteAssignment(assignmentId) {
    if (!assignmentId) return;
    await deleteDoc(doc(db, 'assigned_tasks', assignmentId));
}

// Remove a single library entry (admin clean-up: typos, duplicates).
// Does NOT touch any existing /assigned_tasks/ rows for that text.
export async function deleteLibraryEntry(side, libId) {
    if (!side || !libId) return;
    const libRef = doc(db, 'config', `task_library_${side}`);
    const snap = await getDoc(libRef);
    const items = Array.isArray(snap.data()?.items) ? [...snap.data().items] : [];
    const next = items.filter((it) => it.id !== libId);
    await updateDoc(libRef, { items: next, updatedAt: serverTimestamp() });
}

// ── SEARCH ─────────────────────────────────────────────────────────────

// Fuzzy library search + sort. With a query: rank by token-match score
// regardless of sort mode (you typed something, show what matches best).
// Without a query: sort by `mode` — 'alpha' (default) or 'most_used'.
//
// Score weights (tuned for short restaurant tasks):
//   substring of full query           +100
//   token that starts a word          + 30
//   token contained anywhere          + 10
//   useCount tiebreaker               + useCount/10
export function searchLibrary(items, queryText, mode = 'alpha') {
    const q = (queryText || '').trim().toLowerCase();
    const base = Array.isArray(items) ? items : [];

    if (q) {
        const tokens = q.split(/\s+/).filter(Boolean);
        const scored = base.map((it) => {
            const t = (it.task || '').toLowerCase();
            let score = 0;
            if (t.includes(q)) score += 100;
            const words = t.split(/[^a-z0-9]+/).filter(Boolean);
            for (const tok of tokens) {
                if (!tok) continue;
                if (words.some((w) => w.startsWith(tok))) score += 30;
                else if (t.includes(tok)) score += 10;
            }
            score += (it.useCount || 0) / 10;
            return { it, score };
        }).filter((x) => x.score > 0);
        scored.sort((a, b) => b.score - a.score);
        return scored.map((x) => x.it);
    }

    const arr = [...base];
    if (mode === 'most_used') {
        arr.sort((a, b) => {
            const d = (b.useCount || 0) - (a.useCount || 0);
            if (d !== 0) return d;
            return (a.task || '').localeCompare(b.task || '');
        });
    } else {
        arr.sort((a, b) => (a.task || '').localeCompare(b.task || ''));
    }
    return arr;
}

// ── SIDE INFERENCE ─────────────────────────────────────────────────────

// Resolve a staff member's side. Mirrors the Schedule/Operations
// convention: explicit `scheduleSide` (lower- or upper-case) wins;
// otherwise fall back to role keyword. Returns 'FOH' | 'BOH' | null.
export function inferStaffSide(staffMember) {
    if (!staffMember) return null;
    const explicit = staffMember.scheduleSide;
    if (explicit === 'FOH' || explicit === 'foh') return 'FOH';
    if (explicit === 'BOH' || explicit === 'boh') return 'BOH';
    const role = staffMember.role || '';
    // Operations.jsx convention: FOH default for the role-set below.
    if (['FOH', 'Manager', 'Owner', 'Shift Lead'].includes(role)) return 'FOH';
    if (/cashier|server|host|bartender/i.test(role)) return 'FOH';
    if (/boh|kitchen|cook|prep|dish|line/i.test(role)) return 'BOH';
    return null;
}
