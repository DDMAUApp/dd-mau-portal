// Staff RENAME propagation.
//
// DD Mau has no per-user auth — identity is the staff NAME string. The
// staff record itself lives in config/staff keyed by a stable numeric id,
// but almost every other collection joins on the name (the schedule, PTO,
// notifications, chat membership, etc. all store `staffName` / `forStaff` /
// a name inside an array). So renaming a staffer in the Admin Panel has to
// rewrite those references or their schedule, time-off, notifications and
// chat access silently de-associate.
//
// This module is the one place that knows the full join-by-name surface.
// AdminPanel updates config/staff (the id-keyed record) on its own; right
// after that succeeds it calls renameStaffEverywhere() to fix everything
// that points AT the staffer by name.
//
// ── Design ──────────────────────────────────────────────────────────────
//   • Best-effort, per-collection. One collection failing is logged + put
//     in the report's `errors`, but does NOT abort the rest — partial
//     propagation beats none, and the caller surfaces the count.
//   • Each collection is found by querying the OLD name (equality or
//     array-contains — both single-field, auto-indexed, so no composite
//     index or rules deploy is needed). Updates go out in chunked
//     writeBatches (Firestore caps a batch at 500 ops; we chunk at 450).
//   • Rename is a rare, explicit admin action, so the extra reads/writes
//     have zero steady-state cost — nothing here runs on a normal render.
//
// ── Intentionally LEFT as the old name (historical / cosmetic) ──────────
// These record "who did X at time T" and rewriting them would mean walking
// every message of every chat or every inventory audit row — expensive and
// pointless. The rename confirm dialog tells the admin these keep the old
// name:
//   • chat MESSAGE fields (senderName, reactions, mentions, coverage
//     requesterId/claimedBy inside a message) — only chat doc-level
//     membership is migrated (see computeChatRenamePatch).
//   • inventory_audits_{loc}.byStaff, receipt_scans_{loc}.scannedBy
//   • pin_audits, date_blocks.createdBy
//   • chat_prefs/{name} (notif prefs reset to sane defaults on next login)
//   • DM doc IDs are derived from names; the existing thread stays reachable
//     from the chat list (members[] is migrated) — only starting a brand-new
//     DM via the picker would fork. Acceptable.

import { db } from '../firebase';
import {
    collection, query, where, getDocs, writeBatch,
} from 'firebase/firestore';

// Replace oldName with newName everywhere it appears in a string array.
// Returns a NEW array (or null if nothing changed) so callers can skip a
// no-op write.
function mapNameInArray(arr, oldName, newName) {
    if (!Array.isArray(arr) || !arr.includes(oldName)) return null;
    return arr.map((n) => (n === oldName ? newName : n));
}

// Move a name-keyed map entry (e.g. lastReadByName: { 'Cash': ts }) from
// oldName to newName, preserving the value. Returns a NEW map or null.
function renameMapKey(map, oldName, newName) {
    if (!map || typeof map !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(map, oldName)) return null;
    const next = { ...map };
    next[newName] = next[oldName];
    delete next[oldName];
    return next;
}

// PURE: given a chat doc's data and a rename, compute the patch needed to
// keep the renamed staffer's MEMBERSHIP + read-state intact. Returns a
// partial-doc object, or null if this chat needs no change. Exported so the
// fiddly array/map logic is unit-tested without Firestore.
//
// Touches only doc-level identity:
//   members[]        — keeps chat access (the access-critical one)
//   admins[]         — keeps co-admin powers
//   createdBy        — owner attribution
//   lastReadByName{} — preserve unread state (rename the key)
//   typingByName{}   — drop the stale ephemeral key (5s heartbeat)
//   lastMessage.sender — cosmetic chat-list preview tidy-up
// Message bodies (senderName/reactions/mentions) are intentionally NOT
// rewritten here.
export function computeChatRenamePatch(data, oldName, newName) {
    if (!data || !oldName || !newName || oldName === newName) return null;
    const patch = {};

    const members = mapNameInArray(data.members, oldName, newName);
    if (members) patch.members = members;

    const admins = mapNameInArray(data.admins, oldName, newName);
    if (admins) patch.admins = admins;

    if (data.createdBy === oldName) patch.createdBy = newName;

    const lastRead = renameMapKey(data.lastReadByName, oldName, newName);
    if (lastRead) patch.lastReadByName = lastRead;

    // Typing is a 5s ephemeral heartbeat — just drop the stale key rather
    // than carry a "newName is typing" ghost forward.
    if (data.typingByName && Object.prototype.hasOwnProperty.call(data.typingByName, oldName)) {
        const next = { ...data.typingByName };
        delete next[oldName];
        patch.typingByName = next;
    }

    if (data.lastMessage && data.lastMessage.sender === oldName) {
        patch.lastMessage = { ...data.lastMessage, sender: newName };
    }

    return Object.keys(patch).length ? patch : null;
}

// Commit an array of single-doc update ops in <=450-op batches.
// Each op is a function (batch) => void that performs one batch.update().
async function commitInChunks(ops) {
    let committed = 0;
    for (let i = 0; i < ops.length; i += 450) {
        const slice = ops.slice(i, i + 450);
        const batch = writeBatch(db);
        for (const op of slice) op(batch);
        await batch.commit();
        committed += slice.length;
    }
    return committed;
}

// Rewrite a single equality-joined field across one collection. `extra` are
// additional fields on the SAME matched docs that should also flip if they
// equal oldName (e.g. time_off.submittedBy, offsite_shifts.forcedOutBy).
async function renameEqualityField(collName, field, oldName, newName, extra = []) {
    const snap = await getDocs(query(collection(db, collName), where(field, '==', oldName)));
    const ops = [];
    snap.forEach((d) => {
        const data = d.data() || {};
        const patch = { [field]: newName };
        for (const ef of extra) {
            if (data[ef] === oldName) patch[ef] = newName;
        }
        ops.push((b) => b.update(d.ref, patch));
    });
    return commitInChunks(ops);
}

// assigned_tasks is keyed by staffId (the live subscription queries by id,
// so it never actually breaks) but carries a denormalized staffName for
// display — keep it honest. Query by id so we catch every row regardless of
// the stored name, and also flip doneBy/assignedBy when they were this
// person.
async function renameAssignedTasks(oldName, newName, staffId) {
    const useId = staffId !== null && staffId !== undefined && Number.isFinite(Number(staffId));
    const q = useId
        ? query(collection(db, 'assigned_tasks'), where('staffId', '==', Number(staffId)))
        : query(collection(db, 'assigned_tasks'), where('staffName', '==', oldName));
    const snap = await getDocs(q);
    const ops = [];
    snap.forEach((d) => {
        const data = d.data() || {};
        const patch = {};
        if (data.staffName === oldName) patch.staffName = newName;
        if (data.doneBy === oldName) patch.doneBy = newName;
        if (data.assignedBy === oldName) patch.assignedBy = newName;
        if (Object.keys(patch).length) ops.push((b) => b.update(d.ref, patch));
    });
    return commitInChunks(ops);
}

async function renameChats(oldName, newName) {
    const snap = await getDocs(
        query(collection(db, 'chats'), where('members', 'array-contains', oldName)),
    );
    const ops = [];
    snap.forEach((d) => {
        const patch = computeChatRenamePatch(d.data() || {}, oldName, newName);
        if (patch) ops.push((b) => b.update(d.ref, patch));
    });
    return commitInChunks(ops);
}

// Strip a REMOVED staffer's name from chat membership/admin arrays. Without
// this, removeStaff leaves the name in members[], so a future hire reusing
// the same name silently inherits that person's chat + DM access (and any
// pending unread state). Message history + lastReadByName are intentionally
// left alone (historical record of who said what). Best-effort, chunked.
// Returns the number of chats updated.
export async function removeStaffFromChats(name) {
    const n = String(name || '').trim();
    if (!n) return 0;
    const snap = await getDocs(
        query(collection(db, 'chats'), where('members', 'array-contains', n)),
    );
    const ops = [];
    snap.forEach((d) => {
        const data = d.data() || {};
        const patch = {};
        if (Array.isArray(data.members) && data.members.includes(n)) {
            patch.members = data.members.filter((m) => m !== n);
        }
        if (Array.isArray(data.admins) && data.admins.includes(n)) {
            patch.admins = data.admins.filter((m) => m !== n);
        }
        if (Object.keys(patch).length) ops.push((b) => b.update(d.ref, patch));
    });
    return commitInChunks(ops);
}

// The function-critical, name-joined collections. Order doesn't matter
// (each is independent); kept roughly by user-visible impact.
//
// Returns { ok, total, byCollection: {name: count}, errors: [{collection, message}] }.
// `ok` is true only if every collection succeeded. A thrown collection is
// recorded and skipped — the others still run.
export async function renameStaffEverywhere({ oldName, newName, staffId } = {}) {
    const o = String(oldName || '').trim();
    const n = String(newName || '').trim();
    if (!o || !n || o === n) {
        return { ok: false, total: 0, byCollection: {}, errors: [{ collection: '_input', message: 'oldName/newName missing or identical' }] };
    }

    const byCollection = {};
    const errors = [];

    // [label, runner] — runner resolves to a write count.
    const tasks = [
        ['shifts',          () => renameEqualityField('shifts', 'staffName', o, n)],
        ['recurring_shifts',() => renameEqualityField('recurring_shifts', 'staffName', o, n, ['createdBy', 'updatedBy'])],
        ['time_off',        () => renameEqualityField('time_off', 'staffName', o, n, ['submittedBy', 'createdBy'])],
        // swap_requests stores staff NAMES (fromStaff/toStaff/createdBy).
        // Without these, Schedule.jsx's swap re-verify (fromData.staffName ===
        // request.fromStaff) fails after a rename and the pending swap can
        // never approve. Two disjoint passes cover initiator + recipient;
        // `extra` fields flip only when they equal oldName (renameEqualityField).
        ['swap_requests',   () => renameEqualityField('swap_requests', 'fromStaff', o, n, ['toStaff', 'createdBy'])],
        ['swap_requests_to',() => renameEqualityField('swap_requests', 'toStaff', o, n, ['fromStaff', 'createdBy'])],
        ['notifications',   () => renameEqualityField('notifications', 'forStaff', o, n)],
        ['offsite_shifts',  () => renameEqualityField('offsite_shifts', 'staffName', o, n, ['forcedOutBy', 'createdBy'])],
        ['tardies',         () => renameEqualityField('tardies', 'staffName', o, n)],
        ['assigned_tasks',  () => renameAssignedTasks(o, n, staffId)],
        ['chats',           () => renameChats(o, n)],
    ];

    for (const [label, run] of tasks) {
        try {
            byCollection[label] = await run();
        } catch (err) {
            byCollection[label] = 0;
            const message = err?.message || String(err);
            errors.push({ collection: label, message });
            console.error(`renameStaffEverywhere: ${label} failed:`, err);
        }
    }

    const total = Object.values(byCollection).reduce((a, b) => a + b, 0);
    return { ok: errors.length === 0, total, byCollection, errors };
}
