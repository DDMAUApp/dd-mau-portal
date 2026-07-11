#!/usr/bin/env node
// Admin-side staff RENAME — server mirror of src/data/renameStaff.js.
//
// Use this to (a) recover from a partial/failed in-app rename, or (b) run a
// rename headless. Runs as the Firestore admin (service account), so it
// bypasses security rules and never hits the client chunk-load path.
//
//   node scripts/rename_staff_admin.cjs "Old Name" "New Name" [staffId]
//
// Idempotent: it queries by the OLD name, so re-running after a partial
// finishes the rest and a fully-done rename is a no-op. It also sets the
// config/staff record name for the given id (harmless if already set).
//
// Mirrors renameStaff.js exactly: rewrites the name across shifts,
// recurring_shifts, time_off, notifications(forStaff), offsite_shifts,
// tardies, assigned_tasks(by staffId), and chats (members/admins/createdBy/
// lastReadByName/typingByName/lastMessage.sender). Leaves historical fields
// (chat message bodies, audit trails) as the old name on purpose.

const path = require('path');
const admin = require('firebase-admin');
const sa = require(path.join(__dirname, '..', 'firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const [, , OLD_RAW, NEW_RAW, STAFF_ID_RAW] = process.argv;
const OLD = (OLD_RAW || '').trim();
const NEW = (NEW_RAW || '').trim();
const STAFF_ID = STAFF_ID_RAW != null && STAFF_ID_RAW !== '' ? Number(STAFF_ID_RAW) : null;

if (!OLD || !NEW || OLD === NEW) {
    console.error('Usage: node scripts/rename_staff_admin.cjs "Old Name" "New Name" [staffId]');
    process.exit(1);
}

async function commitInChunks(ops) {
    let committed = 0;
    for (let i = 0; i < ops.length; i += 450) {
        const slice = ops.slice(i, i + 450);
        const batch = db.batch();
        for (const op of slice) op(batch);
        await batch.commit();
        committed += slice.length;
    }
    return committed;
}

async function renameEqualityField(coll, field, extra = []) {
    const snap = await db.collection(coll).where(field, '==', OLD).get();
    const ops = [];
    snap.forEach((d) => {
        const data = d.data() || {};
        const patch = { [field]: NEW };
        for (const ef of extra) if (data[ef] === OLD) patch[ef] = NEW;
        ops.push((b) => b.update(d.ref, patch));
    });
    return commitInChunks(ops);
}

async function renameAssignedTasks() {
    const q = STAFF_ID != null && Number.isFinite(STAFF_ID)
        ? db.collection('assigned_tasks').where('staffId', '==', STAFF_ID)
        : db.collection('assigned_tasks').where('staffName', '==', OLD);
    const snap = await q.get();
    const ops = [];
    snap.forEach((d) => {
        const data = d.data() || {};
        const patch = {};
        if (data.staffName === OLD) patch.staffName = NEW;
        if (data.doneBy === OLD) patch.doneBy = NEW;
        if (data.assignedBy === OLD) patch.assignedBy = NEW;
        if (Object.keys(patch).length) ops.push((b) => b.update(d.ref, patch));
    });
    return commitInChunks(ops);
}

function mapArr(arr) {
    if (!Array.isArray(arr) || !arr.includes(OLD)) return null;
    return arr.map((n) => (n === OLD ? NEW : n));
}

async function renameChats() {
    const snap = await db.collection('chats').where('members', 'array-contains', OLD).get();
    const ops = [];
    snap.forEach((d) => {
        const data = d.data() || {};
        const patch = {};
        const members = mapArr(data.members);
        if (members) patch.members = members;
        const admins = mapArr(data.admins);
        if (admins) patch.admins = admins;
        if (data.createdBy === OLD) patch.createdBy = NEW;
        if (data.lastReadByName && Object.prototype.hasOwnProperty.call(data.lastReadByName, OLD)) {
            const m = { ...data.lastReadByName };
            m[NEW] = m[OLD]; delete m[OLD];
            patch.lastReadByName = m;
        }
        if (data.typingByName && Object.prototype.hasOwnProperty.call(data.typingByName, OLD)) {
            const m = { ...data.typingByName };
            delete m[OLD];
            patch.typingByName = m;
        }
        if (data.lastMessage && data.lastMessage.sender === OLD) {
            patch.lastMessage = { ...data.lastMessage, sender: NEW };
        }
        if (Object.keys(patch).length) ops.push((b) => b.update(d.ref, patch));
    });
    return commitInChunks(ops);
}

async function fixStaffRecord() {
    if (STAFF_ID == null) return 'skipped (no id)';
    const ref = db.doc('config/staff');
    // Transaction + rev bump per the 2026-07-11 roster-write protocol.
    let out = 'already correct';
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) { out = 'no config/staff'; return; }
        const data = snap.data() || {};
        const list = data.list || [];
        let changed = false;
        const next = list.map((s) => {
            if (s.id === STAFF_ID && s.name !== NEW) { changed = true; return { ...s, name: NEW }; }
            return s;
        });
        if (changed) {
            tx.set(ref, { list: next, rev: (Number(data.rev) || 0) + 1 }, { merge: true });
            out = 'updated';
        }
    });
    return out;
}

(async () => {
    console.log(`Renaming "${OLD}" → "${NEW}"${STAFF_ID != null ? ` (id ${STAFF_ID})` : ''}\n`);
    const out = {};
    out['config/staff'] = await fixStaffRecord();
    out.shifts = await renameEqualityField('shifts', 'staffName');
    out.recurring_shifts = await renameEqualityField('recurring_shifts', 'staffName', ['createdBy', 'updatedBy']);
    out.time_off = await renameEqualityField('time_off', 'staffName', ['submittedBy', 'createdBy']);
    out.notifications = await renameEqualityField('notifications', 'forStaff');
    out.offsite_shifts = await renameEqualityField('offsite_shifts', 'staffName', ['forcedOutBy', 'createdBy']);
    out.tardies = await renameEqualityField('tardies', 'staffName');
    out.assigned_tasks = await renameAssignedTasks();
    out.chats = await renameChats();
    console.log('Result:', JSON.stringify(out, null, 2));
    process.exit(0);
})().catch((e) => { console.error('RENAME ERROR:', e && e.message ? e.message : e); process.exit(1); });
