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
    collection, doc, getDoc, onSnapshot, query, where, limit,
    writeBatch, updateDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';

// ── SUBSCRIPTIONS ──────────────────────────────────────────────────────

// All assignments for one staffer (by id). Returns unsubscribe.
// Sorted client-side: incomplete first by assignedAt desc, then complete
// by doneAt desc. No orderBy in the query so we don't need a composite
// Firestore index — a single where() on staffId is enough.
export function subscribeAssignmentsForStaff(staffId, callback) {
    if (staffId == null || typeof callback !== 'function') return () => {};
    // PERF, 2026-05-30: capped at 200. Done tasks accumulate forever; a
    // staffer with months of history would otherwise stream every row on
    // every cold mount. 200 covers active + ~recent done.
    const q = query(collection(db, 'assigned_tasks'), where('staffId', '==', staffId), limit(200));
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

// 2026-05-27 — Andrew (kanban tasks redesign): subscribe to ALL open
// assignments for one side. The kanban manager view shows per-staff
// columns of open work; rather than spinning up N
// subscribeAssignmentsForStaff listeners (one per staff member), a
// single side-scoped query is cheaper.
// Returns assignments sorted assignedAt desc; client groups by staffId.
export function subscribeOpenAssignments(side, callback) {
    if (!side || typeof callback !== 'function') return () => {};
    // PERF, 2026-05-30: capped at 500. Even with a full team backlog this
    // is generous (would mean >20 open tasks per staffer for 25 staff).
    const q = query(
        collection(db, 'assigned_tasks'),
        where('side', '==', side),
        where('done', '==', false),
        limit(500),
    );
    return onSnapshot(q, (snap) => {
        const out = [];
        snap.forEach((d) => out.push({ id: d.id, ...(d.data() || {}) }));
        out.sort((a, b) => {
            const at = a.assignedAt?.toMillis?.() || 0;
            const bt = b.assignedAt?.toMillis?.() || 0;
            return bt - at;
        });
        callback(out);
    }, (err) => {
        console.warn('subscribeOpenAssignments failed:', err);
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

// 2026-05-27 — Andrew (kanban tasks redesign): add a task text to the
// side's master library WITHOUT creating an assignment. Used by the
// new "+ Add task" input on the kanban master list — staff don't get
// assigned yet, the row just lives in the library waiting to be
// tapped + assigned. Same upsert semantics as assignTasksToStaff's
// library half (case-insensitive de-dupe; bump useCount if the task
// already exists). Returns { added: true|false } so the caller can
// flash a toast if the row was a duplicate.
export async function addLibraryEntry(side, taskText, category = 'other') {
    const norm = (taskText || '').trim();
    if (!norm || !side) return { added: false };
    const libRef = doc(db, 'config', `task_library_${side}`);
    const libSnap = await getDoc(libRef);
    const libData = libSnap.exists() ? libSnap.data() : null;
    const libItems = Array.isArray(libData?.items) ? [...libData.items] : [];
    const idx = findLibraryItemIdx(libItems, norm);
    const nowMs = Date.now();
    if (idx >= 0) {
        // Already in the library — leave the row alone (don't bump
        // useCount; that counter is for assignment frequency, not
        // "added to library" frequency). Signal duplicate to caller.
        return { added: false };
    }
    libItems.push({
        id: makeLibraryId(norm),
        task: norm,
        category: (category || 'other').trim() || 'other',
        useCount: 0,  // hasn't been assigned yet
        lastUsedAt: nowMs,
    });
    await updateDoc(libRef, {
        items: libItems,
        side,
        updatedAt: serverTimestamp(),
    }).catch(async () => {
        // Doc may not exist yet (first time the side gets any task).
        // Fall back to setDoc-merge via the writeBatch path.
        const batch = writeBatch(db);
        batch.set(libRef, {
            items: libItems, side, updatedAt: serverTimestamp(),
        }, { merge: true });
        await batch.commit();
    });
    return { added: true };
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

// Rename a library entry (admin/manager inline edit on the master list).
// Andrew 2026-05-28: "thats there we ad a edit the tasks." Lets the
// manager fix a typo or sharpen the wording without having to delete
// + re-add (which would lose useCount + lastUsedAt).
//
// Behavior:
//   • Empty/whitespace newText → no-op (caller should delete instead).
//   • If newText collides with a DIFFERENT existing entry (same
//     normalized text), we leave both rows alone and signal duplicate.
//     The picker would otherwise show two identical rows that act
//     differently — confusing.
//   • Existing /assigned_tasks/ rows are NOT touched. They snapshot
//     the task text at assignment time and stay as-is. This matches
//     deleteLibraryEntry's posture: library = template, assignments =
//     ledger of work, edits to the template don't rewrite history.
//
// Returns { renamed: bool, reason?: 'not_found' | 'duplicate' | 'empty' }.
export async function renameLibraryEntry(side, libId, newText) {
    const norm = (newText || '').trim();
    if (!side || !libId) return { renamed: false, reason: 'not_found' };
    if (!norm) return { renamed: false, reason: 'empty' };
    const libRef = doc(db, 'config', `task_library_${side}`);
    const snap = await getDoc(libRef);
    const items = Array.isArray(snap.data()?.items) ? [...snap.data().items] : [];
    const idx = items.findIndex((it) => it.id === libId);
    if (idx < 0) return { renamed: false, reason: 'not_found' };
    // Collision check against OTHER rows.
    const otherDupIdx = items.findIndex(
        (it, i) => i !== idx && (it.task || '').trim().toLowerCase() === norm.toLowerCase(),
    );
    if (otherDupIdx >= 0) return { renamed: false, reason: 'duplicate' };
    const next = items.slice();
    next[idx] = { ...next[idx], task: norm };
    await updateDoc(libRef, { items: next, updatedAt: serverTimestamp() });
    return { renamed: true };
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
