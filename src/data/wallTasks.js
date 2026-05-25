// wallTasks — short, focused task list that lives on a wall-mounted
// kitchen tablet (TaskDisplay.jsx rendered via ?display=walltasks).
//
// Distinct from:
//   • customTasks.{side}.all in /ops/checklists2_{location}
//       The full opening/closing checklist staff work through on their
//       phones. Long (~30 tasks), categorized, with photos / subtasks.
//   • /assigned_tasks/{id}
//       Per-staff personal assignments from a manager.
//
// THIS list is the "right now, big screen, big text, tap to check"
// cheat sheet visible to everyone on the line. Andrew 2026-05-21:
// "small monitor that i can hang up that we can put today task on …
// we will make a list just for that."
//
// ── Data model ──────────────────────────────────────────────────────
//
//   /ops/wall_tasks_{location}_{side}
//     {
//       items: [
//         { id, task, done, doneAt (ISO string) }
//       ],
//       side:        'FOH' | 'BOH',
//       location:    'webster' | 'maryland',
//       lastResetAt: Timestamp,    // when "Reset all" was last pressed
//       updatedAt:   Timestamp,
//     }
//
// One doc per (location, side). Four total in practice:
//   wall_tasks_webster_FOH, wall_tasks_webster_BOH,
//   wall_tasks_maryland_FOH, wall_tasks_maryland_BOH.
//
// Tasks are the recurring "today on the wall" template — they stay in
// place day to day; only the `done` flags toggle. The Reset button
// clears all flags for the next shift; there's no auto-cron because
// it's cheaper for the manager to tap Reset once each morning than to
// burn a Cloud Function on it.

import { db } from '../firebase';
import {
    doc, onSnapshot, runTransaction, serverTimestamp,
} from 'firebase/firestore';

function refFor(location, side) {
    return doc(db, 'ops', `wall_tasks_${location}_${side}`);
}

// Subscribe to one (location, side) doc. Returns unsubscribe.
// Callback receives { items, lastResetAt, updatedAt }.
export function subscribeWallTasks(location, side, callback) {
    if (!location || !side || typeof callback !== 'function') return () => {};
    return onSnapshot(refFor(location, side), (snap) => {
        const data = snap.exists() ? snap.data() : null;
        callback({
            items: Array.isArray(data?.items) ? data.items : [],
            lastResetAt: data?.lastResetAt || null,
            updatedAt: data?.updatedAt || null,
        });
    }, (err) => {
        console.warn('subscribeWallTasks failed:', err);
        callback({ items: [], lastResetAt: null, updatedAt: null });
    });
}

function newWallTaskId(side) {
    return `wt_${side}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Internal: read-modify-write helper. The list is small (typical 8-20
// items) so client-side mutation is fine and lets us preserve ordering
// without ranks / fractional indices.
//
// 2026-05-24: wrapped in runTransaction so two tablets editing the
// same wall-tasks doc concurrently can't lose each other's edits.
// Previously a plain getDoc → setDoc(merge) had a classic
// read-modify-write race: tablet A and tablet B both read the same
// `items`, both mutate independently, the second write clobbers the
// first. With runTransaction Firestore retries on contention so the
// second mutator runs against the already-applied first write.
async function mutateItems(location, side, mutator, extra = {}) {
    const ref = refFor(location, side);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const existing = Array.isArray(snap.data()?.items) ? snap.data().items : [];
        const next = mutator([...existing]);
        tx.set(ref, {
            items: next,
            side,
            location,
            updatedAt: serverTimestamp(),
            ...extra,
        }, { merge: true });
    });
}

// Add a task to the end of the list.
export async function addWallTask(location, side, taskText) {
    const t = (taskText || '').trim();
    if (!t) return;
    await mutateItems(location, side, (items) => {
        items.push({ id: newWallTaskId(side), task: t, done: false, doneAt: null });
        return items;
    });
}

// Remove one task.
export async function removeWallTask(location, side, itemId) {
    if (!itemId) return;
    await mutateItems(location, side, (items) => items.filter((it) => it.id !== itemId));
}

// Patch one task's fields (task text, etc.).
export async function updateWallTask(location, side, itemId, patch) {
    if (!itemId || !patch) return;
    await mutateItems(location, side, (items) =>
        items.map((it) => (it.id === itemId ? { ...it, ...patch } : it))
    );
}

// Move a task from one index to another. Used by ▲/▼ reorder buttons.
export async function moveWallTask(location, side, fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    await mutateItems(location, side, (items) => {
        if (fromIdx < 0 || fromIdx >= items.length) return items;
        if (toIdx < 0 || toIdx >= items.length) return items;
        const [moved] = items.splice(fromIdx, 1);
        items.splice(toIdx, 0, moved);
        return items;
    });
}

// Toggle done state. Called from the wall display when a cook taps a card.
export async function toggleWallTaskDone(location, side, itemId) {
    if (!itemId) return;
    await mutateItems(location, side, (items) =>
        items.map((it) => {
            if (it.id !== itemId) return it;
            const nowDone = !it.done;
            return {
                ...it,
                done: nowDone,
                doneAt: nowDone ? new Date().toISOString() : null,
            };
        })
    );
}

// Reset all done flags. Tasks survive — the list is the recurring
// "today's wall" template. Manager taps this each morning (or once a
// shift) to start the staff fresh.
export async function resetWallTasks(location, side) {
    await mutateItems(
        location, side,
        (items) => items.map((it) => ({ ...it, done: false, doneAt: null })),
        { lastResetAt: serverTimestamp() }
    );
}
