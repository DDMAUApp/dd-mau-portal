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
    collection, query, where, getDocs, writeBatch, addDoc, serverTimestamp,
    doc, getDoc, orderBy, limit, deleteField, FieldPath, updateDoc,
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

// staffing_needs stores names in ARRAYS (filledStaff[] parallel to
// filledShiftIds[], and interestedClaims[{name, claimedAt}]), so the
// equality-field pass can't reach them. A rename used to silently drop the
// staffer from filled slots — the slot re-opened and got double-filled
// (2026-07-26 audit M4). filledStaff is queryable via array-contains;
// interestedClaims holds objects, so rewrite it on the same matched docs
// plus a second targeted sweep over recent docs.
async function renameStaffingNeeds(oldName, newName) {
    const ops = [];
    const patchDoc = (d) => {
        const data = d.data() || {};
        const patch = {};
        if (Array.isArray(data.filledStaff) && data.filledStaff.includes(oldName)) {
            patch.filledStaff = data.filledStaff.map((m) => (m === oldName ? newName : m));
        }
        if (Array.isArray(data.interestedClaims) && data.interestedClaims.some(c => c?.name === oldName)) {
            patch.interestedClaims = data.interestedClaims.map(c => (c?.name === oldName ? { ...c, name: newName } : c));
        }
        if (Object.keys(patch).length) ops.push((b) => b.update(d.ref, patch));
    };
    const seen = new Set();
    const filled = await getDocs(query(collection(db, 'staffing_needs'), where('filledStaff', 'array-contains', oldName)));
    filled.forEach((d) => { seen.add(d.id); patchDoc(d); });
    // interestedClaims can't be array-contains-queried (objects) — sweep
    // docs from the last 60 days for claim-only membership.
    const cutoff = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const recent = await getDocs(query(collection(db, 'staffing_needs'), where('date', '>=', cutoff)));
    recent.forEach((d) => { if (!seen.has(d.id)) patchDoc(d); });
    return commitInChunks(ops);
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

// Announcements (2026-07-26 audit). Three name joins the equality pass
// can't reach:
//   • /announcements.acks — a MAP keyed by staff name (drives the "Got
//     it" pop-up suppression + the manager ack dashboard).
//   • the chat copy's audienceNames[] — the REAL audience list the ack
//     dashboard counts against (reachable via the chatId/chatMessageId
//     back-links stored on the announcement doc).
//   • the mirrored ack doc /chats/{chatId}/acks/{chatMessageId}_{name}
//     — the NAME is baked into the doc ID, so a move = copy + delete.
// Without this pass a renamed staffer's pop-up re-fires (their ack is
// under the dead old name) and they show as "pending" forever on the
// dashboard. Bounded to the 50 most recent announcements — the pop-up
// feed itself only reads 20, so older docs are cosmetic history.
//
// All map-key writes use the updateDoc/batch VARARGS FieldPath form:
// staff names are free text (a dot would corrupt a template-string
// dot-path), and a FieldPath used as a computed OBJECT KEY stringifies
// to "[object Object]" and throws.
async function renameAnnouncements(oldName, newName) {
    const snap = await getDocs(query(
        collection(db, 'announcements'), orderBy('createdAt', 'desc'), limit(50),
    ));
    const ops = [];
    for (const d of snap.docs) {
        const data = d.data() || {};
        const hasAck = !!data.acks && Object.prototype.hasOwnProperty.call(data.acks, oldName);

        // Announcement doc: move acks[oldName] → acks[newName] (keep the
        // original ack timestamp) + flip createdBy attribution.
        const args = [];
        if (hasAck) {
            args.push(new FieldPath('acks', newName), data.acks[oldName]);
            args.push(new FieldPath('acks', oldName), deleteField());
        }
        if (data.createdBy === oldName) args.push('createdBy', newName);
        // 2026-07-27 audit C3 — audienceCustom (hand-picked audience names,
        // Andrew 2026-07-26) joins by name too; without this a renamed
        // staffer silently dropped out of custom-audience announcements
        // (audienceMatches does an exact-name includes()).
        const custom = mapNameInArray(data.audienceCustom, oldName, newName);
        if (custom) args.push('audienceCustom', custom);
        if (args.length) ops.push((b) => b.update(d.ref, ...args));

        // Chat-copy fixups — only where the back-links exist (older docs
        // from before the back-link write may lack them; skip those).
        if (!data.chatId || !data.chatMessageId) continue;
        const msgRef = doc(db, 'chats', data.chatId, 'messages', data.chatMessageId);
        try {
            const msgSnap = await getDoc(msgRef);
            if (msgSnap.exists()) {
                const names = mapNameInArray(msgSnap.data()?.audienceNames, oldName, newName);
                if (names) ops.push((b) => b.update(msgRef, { audienceNames: names }));
            }
        } catch (err) {
            console.warn('renameAnnouncements: chat-copy read failed:', err);
        }
        if (hasAck) {
            const oldAckRef = doc(db, 'chats', data.chatId, 'acks', `${data.chatMessageId}_${oldName}`);
            try {
                const oldAck = await getDoc(oldAckRef);
                if (oldAck.exists()) {
                    const newAckRef = doc(db, 'chats', data.chatId, 'acks', `${data.chatMessageId}_${newName}`);
                    const ackData = { ...(oldAck.data() || {}), userName: newName };
                    ops.push((b) => b.set(newAckRef, ackData, { merge: true }));
                    ops.push((b) => b.delete(oldAckRef));
                }
            } catch (err) {
                console.warn('renameAnnouncements: mirrored ack read failed:', err);
            }
        }
    }
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
//
// `by` (optional) — the admin performing the rename, recorded in the
// /staff_rename_log audit row written after the fan-out.
// /config/insurance_index maps staffName → random insurance doc id
// (2026-06-02 doc-ID hardening). Without this move, a renamed staffer's
// insurance record silently de-associates: the load path finds no entry
// under the NEW name, falls back to the (empty) legacy id, shows a blank
// form, and a re-submit forks a second record — orphaning the original.
// (2026-08-11 full-app audit.) The insurance DOC's embedded staffName is
// deliberately left as-is: Firestore rules pin it immutable (anti-hijack),
// and identity flows through this index — InsuranceEnrollment preserves
// the stored name on update for the same reason.
async function renameInsuranceIndex(oldName, newName) {
    const ref = doc(db, 'config', 'insurance_index');
    const snap = await getDoc(ref);
    if (!snap.exists()) return 0;
    const entries = snap.data()?.entries || {};
    const docId = entries[oldName];
    if (!docId) return 0;
    // FieldPath (not dotted strings) — names are user data and must never
    // be parsed as path separators (same rule as the 2026-07-22 split-
    // FieldPath fixes).
    await updateDoc(ref,
        new FieldPath('entries', oldName), deleteField(),
        new FieldPath('entries', newName), docId,
        new FieldPath('updatedAt'), new Date().toISOString(),
    );
    return 1;
}

// /training_v2/{staffDocId} — Training Hub progress (lessons read, quiz
// attempts, locks). Doc id = lowercase name with spaces → "_" (see
// TrainingHub.jsx staffDocId) and the doc carries `staffName` for the
// tracker. Before 2026-08-17 a rename left the old doc orphaned: the
// renamed person subscribed to a fresh empty doc (every module "not
// started", locks gone) and the admin Tracker listed both names. Copy
// old → new (merge, so a doc the new name already has keeps its own
// fields) and delete the old one in a single batch.
// NOTE: '/' must be replaced too — a name like "Ana/Luis" would otherwise
// produce an invalid doc path and crash the Training tab for that person.
// Keep in sync with TrainingHub.staffDocId and functions/index.js docIdFor.
export const trainingDocId = (name) => (name || 'unknown').toLowerCase().replace(/\s+/g, '_').replace(/\//g, '_');
async function renameTrainingProgress(oldName, newName) {
    const oldId = trainingDocId(oldName);
    const newId = trainingDocId(newName);
    if (oldId === newId) return 0; // case/whitespace-only rename → same doc
    const oldRef = doc(db, 'training_v2', oldId);
    const snap = await getDoc(oldRef);
    if (!snap.exists()) return 0;
    const data = snap.data() || {};
    const batch = writeBatch(db);
    batch.set(doc(db, 'training_v2', newId), {
        ...data,
        staffName: newName,
        renamedFrom: oldName,
        updatedAt: new Date().toISOString(),
    }, { merge: true });
    batch.delete(oldRef);
    await batch.commit();
    return 1;
}

// /training_assignments — assignment docs freeze recipients[].name and key
// the sent/opened/reminders/autoReminders maps by trainingDocId(name).
// Before 2026-08-25 a rename silently broke every assignment touching the
// person: the admin roster showed them "not started" forever (deriveAssignment
// Rows joins live /training_v2 by the NEW doc id, which renameTrainingProgress
// moved), their Required-training banner vanished (myOpenAssignments matches
// by name), and the daily reminder CF pushed to the dead old name until the
// 14-day cutoff. Covers ALL statuses (closed rosters join live training_v2
// too). Case-only renames still rewrite recipients[].name (the CF's forStaff
// and manual-DM toName use the exact string) but skip the map-key moves
// (same trainingDocId). Rules note: the training_assignments update whitelist
// explicitly allows 'recipients' for SAME-SIZE rewrites (see firestore.rules).
async function renameTrainingAssignments(oldName, newName) {
    const oldId = trainingDocId(oldName);
    const newId = trainingDocId(newName);
    const snap = await getDocs(collection(db, 'training_assignments'));
    let writes = 0;
    for (const d of snap.docs) {
        const data = d.data() || {};
        const recipients = Array.isArray(data.recipients) ? data.recipients : [];
        const touchesOld = recipients.some((r) => r && r.name === oldName);
        if (!touchesOld) continue;
        const nextRecipients = recipients.map((r) =>
            (r && r.name === oldName) ? { ...r, name: newName } : r);
        // updateDoc varargs: alternating field/value pairs. recipients via
        // string path (top-level), map moves via FieldPath segments — names
        // can contain dots, so dotted strings are forbidden here.
        const args = ['recipients', nextRecipients];
        if (oldId !== newId) {
            for (const mapField of ['sent', 'opened', 'reminders', 'autoReminders']) {
                const m = data[mapField];
                if (m && typeof m === 'object' && Object.prototype.hasOwnProperty.call(m, oldId)) {
                    args.push(new FieldPath(mapField, newId), m[oldId]);
                    args.push(new FieldPath(mapField, oldId), deleteField());
                }
            }
        }
        await updateDoc(doc(db, 'training_assignments', d.id), ...args);
        writes += 1;
    }
    return writes;
}

export async function renameStaffEverywhere({ oldName, newName, staffId, by } = {}) {
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
        // Offer/claim identity fields live on OTHER people's shifts, so the
        // staffName pass never touches them. Without these, a rename during
        // a pending claim made the approval write the DEAD old name into
        // staffName — the shift then orphan-filtered off every grid
        // (2026-07-26 audit M4).
        ['shifts_claims',   () => renameEqualityField('shifts', 'pendingClaimBy', o, n, ['offeredBy'])],
        ['shifts_offered',  () => renameEqualityField('shifts', 'offeredBy', o, n)],
        ['staffing_needs',  () => renameStaffingNeeds(o, n)],
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
        ['announcements',   () => renameAnnouncements(o, n)],
        ['chats',           () => renameChats(o, n)],
        ['insurance_index', () => renameInsuranceIndex(o, n)],
        ['training_v2',     () => renameTrainingProgress(o, n)],
        ['training_assignments', () => renameTrainingAssignments(o, n)],
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
    const report = { ok: errors.length === 0, total, byCollection, errors };

    // Audit row — /staff_rename_log, one per fan-out. Best-effort (a
    // logging failure never fails the rename). The 2026-07-11 revert
    // repair had to RECONSTRUCT the rename mapping by fuzzy-matching
    // shift history because this trail didn't exist — and the fuzzy
    // match misfired on Emma Castro. Never again: who/old/new/when +
    // per-collection counts, permanently.
    try {
        await addDoc(collection(db, 'staff_rename_log'), {
            oldName: o,
            newName: n,
            staffId: staffId ?? null,
            by: by || null,
            at: serverTimestamp(),
            total,
            byCollection,
            ok: report.ok,
            errors: errors.map(e => `${e.collection}: ${e.message}`),
        });
    } catch (e) {
        console.warn('staff_rename_log write failed (rename itself succeeded):', e);
    }
    return report;
}
