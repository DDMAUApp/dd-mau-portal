// test-firestore-rules.mjs — firestore.rules regression suite.
//
// Runs the FULL rule surface against the Firestore emulator using the
// same unauthenticated client SDK the app uses in production (no
// Firebase Auth — everything writes with the public apiKey), so every
// assertion here is exactly what a phone/TV/DevTools console can do.
//
// Written 2026-07-11 alongside the catch-all carve-out (isCarvedOut in
// firestore.rules). Before that carve-out, Firestore's OR-across-
// matches semantics meant the permissive {document=**} block silently
// overrode every restrictive rule — these tests would have failed en
// masse. Run this after ANY rules change:
//
//   PATH="/opt/homebrew/opt/openjdk/bin:$PATH" \
//   npx firebase emulators:exec --only firestore --project dd-mau-staff-app \
//     "node scripts/test-firestore-rules.mjs"
//
// Seeding: docs that must pre-exist (update/delete tests) are written
// through the emulator's REST API with "Authorization: Bearer owner",
// which bypasses rules — the emulator-only equivalent of the admin SDK.

import { initializeApp } from 'firebase/app';
import {
    FieldPath,
    getFirestore, connectFirestoreEmulator, doc, collection,
    setDoc, addDoc, updateDoc, deleteDoc, getDoc, serverTimestamp, Timestamp,
    arrayUnion, increment, getDocs, query, where, deleteField,
} from 'firebase/firestore';

const PROJECT = 'dd-mau-staff-app';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const [host, port] = HOST.split(':');

const app = initializeApp({ projectId: PROJECT, apiKey: 'emulator' });
const db = getFirestore(app);
connectFirestoreEmulator(db, host, Number(port));

// ── Rules-bypassing seed writer (emulator REST + Bearer owner) ────────
async function seed(path, fields) {
    const url = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
        body: JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`seed ${path} failed: ${res.status} ${await res.text()}`);
}
const S = (v) => ({ stringValue: v });
const I = (v) => ({ integerValue: String(v) });
const B = (v) => ({ booleanValue: v });
const TS = (iso) => ({ timestampValue: iso });
const M = (obj) => ({ mapValue: { fields: obj } });
const L = (...vals) => ({ arrayValue: { values: vals } });

// ── Assertion helpers ─────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
async function expect(name, want, fn) {
    try {
        await fn();
        if (want === 'allow') { pass++; }
        else { fail++; failures.push(`${name}: expected DENY but was ALLOWED`); }
    } catch (e) {
        const denied = e?.code === 'permission-denied';
        if (want === 'deny' && denied) { pass++; }
        else { fail++; failures.push(`${name}: expected ${want.toUpperCase()} but got ${e?.code || e?.message || e}`); }
    }
}
const allow = (name, fn) => expect(name, 'allow', fn);
const deny = (name, fn) => expect(name, 'deny', fn);

// ── Seeds (docs that must pre-exist for update/delete tests) ──────────
await seed('config/staff', { list: L(M({ name: S('Alice'), pin: S('1234') })), rev: I(5) });
await seed('config/recipes', { list: L(M({ id: I(1), titleEn: S('Pho') })), updatedAt: S('2026-01-01T00:00:00.000Z') });
await seed('audit/a1', { action: S('seed'), actorName: S('seed'), createdAt: TS('2026-01-01T00:00:00Z') });
await seed('pin_audits/p1', { staffName: S('Alice') });
await seed('notifications/n1', { forStaff: S('Alice'), type: S('chat_message'), read: B(false) });
await seed('email_intel/e1', { category: S('other'), subject: S('seed') });
await seed('onboarding_hires/h1', { id: S('h1'), name: S('Carl'), createdAt: S('2026-01-01T00:00:00.000Z'), personal: M({ dob: S('1990-01-01') }) });
await seed('onboarding_invites/tok123', { hireId: S('h1'), expiresAt: S('2027-01-01T00:00:00.000Z'), used: B(false) });
await seed('onboarding_applications/app1', { name: S('Bob'), createdAt: TS('2026-01-01T00:00:00Z'), status: S('new') });
await seed('onboarding_templates/tpl1', { name: S('W-4'), forDocId: S('w4') });
await seed('insurance/ins1', { staffName: S('Alice'), status: S('submitted') });
await seed('staff_deletion_requests/r1', { requesterName: S('Alice'), status: S('pending') });
await seed('staff_deletion_requests/r2', { requesterName: S('Bob'), status: S('withdrawn') });
await seed('bug_reports/b1', { description: S('seed'), status: S('open') });
await seed('rate_limits/rl1', { count: I(3) });
await seed('system/gmail_sync_state', { ok: B(true) });
await seed('chats/c1', { members: L(S('Alice')) });
await seed('chats/c1/messages/m1', { text: S('hi'), sender: S('Alice') });
await seed('pairing_codes/111111', { code: S('111111'), expiresAt: TS('2027-01-01T00:00:00Z') });
await seed('tardies/t1', { staffName: S('Alice'), date: S('2026-07-01') });
await seed('time_off/to1', { staffName: S('Alice'), startDate: S('2026-07-20'), status: S('pending') });
await seed('config/toast_menu_items', { 'guid-1': S('Pho Dac Biet') });
await seed('error_logs/el1', { severity: S('error'), errorMessage: S('seed') });
await seed('sms_delivery_logs/sd1', { sid: S('seed') });
await seed('attendance/at1', { staffName: S('Alice') });

// ── 1. Catch-all collections (NOT carved out) stay fully usable ──────
await allow('catch-all: create shifts', () => setDoc(doc(db, 'shifts', 'probe1'), { staffName: 'X', day: '2026-07-12' }));
await allow('catch-all: update shifts', () => updateDoc(doc(db, 'shifts', 'probe1'), { day: '2026-07-13' }));
await allow('catch-all: read shifts', () => getDoc(doc(db, 'shifts', 'probe1')));
await allow('catch-all: delete shifts', () => deleteDoc(doc(db, 'shifts', 'probe1')));
await allow('catch-all: config doc not in carve list (payroll_roster)', () => setDoc(doc(db, 'config', 'payroll_roster'), { staff: [] }));
await allow('catch-all: delete non-carved config doc', () => deleteDoc(doc(db, 'config', 'payroll_roster')));
await allow('tv_configs: create', () => setDoc(doc(db, 'tv_configs', 'tvp'), { label: 'probe' }));
await allow('tv_configs: version create', () => setDoc(doc(db, 'tv_configs', 'tvp', 'versions', 'v1'), { snap: 1 }));
await allow('tv_configs: version delete', () => deleteDoc(doc(db, 'tv_configs', 'tvp', 'versions', 'v1')));
await allow('tv_configs: delete', () => deleteDoc(doc(db, 'tv_configs', 'tvp')));

// ── 2. config/staff — rev protocol (carved out since 2026-07-11) ─────
await allow('config/staff: update w/ rev bump', () => setDoc(doc(db, 'config', 'staff'), { list: [{ name: 'Alice', pin: '1234' }], rev: 6 }));
await deny('config/staff: update w/ stale rev', () => setDoc(doc(db, 'config', 'staff'), { list: [{ name: 'Alice', pin: '1234' }], rev: 6 }));
await deny('config/staff: update w/o rev', () => setDoc(doc(db, 'config', 'staff'), { list: [{ name: 'Alice', pin: '1234' }] }));
await deny('config/staff: delete', () => deleteDoc(doc(db, 'config', 'staff')));

// ── 3. config/recipes — 2026-05-09 incident protections ──────────────
await allow('config/recipes: valid save (newer updatedAt)', () => setDoc(doc(db, 'config', 'recipes'), { list: [{ id: 1 }, { id: 2 }], updatedAt: '2026-02-01T00:00:00.000Z' }));
await deny('config/recipes: stale updatedAt replay', () => setDoc(doc(db, 'config', 'recipes'), { list: [{ id: 1 }], updatedAt: '2025-01-01T00:00:00.000Z' }));
await deny('config/recipes: garbage shape', () => setDoc(doc(db, 'config', 'recipes'), { foo: 1 }));
await deny('config/recipes: delete', () => deleteDoc(doc(db, 'config', 'recipes')));

// ── 4. Other carved-out config docs ───────────────────────────────────
await allow('config/forceRefresh: legit broadcast', () => setDoc(doc(db, 'config', 'forceRefresh'), { triggeredBy: 'probe', triggeredAt: serverTimestamp() }));
await deny('config/forceRefresh: garbage write', () => setDoc(doc(db, 'config', 'forceRefresh'), { foo: 1 }));
await allow('config/menu_v2: valid save', () => setDoc(doc(db, 'config', 'menu_v2'), { categories: [], schemaVersion: 1 }));
await deny('config/menu_v2: missing schemaVersion', () => setDoc(doc(db, 'config', 'menu_v2'), { categories: [] }));
await deny('config/menu_v2: delete', () => deleteDoc(doc(db, 'config', 'menu_v2')));
await allow('config/brand: valid save', () => setDoc(doc(db, 'config', 'brand'), { name: 'DD Mau', schemaVersion: 1 }));
await allow('config/build_sheet: valid save', () => setDoc(doc(db, 'config', 'build_sheet'), { sections: {}, schemaVersion: 1 }));
await allow('config/onboarding_doc_text: map write', () => setDoc(doc(db, 'config', 'onboarding_doc_text'), { overrides: {} }));
await deny('config/onboarding_doc_text: delete', () => deleteDoc(doc(db, 'config', 'onboarding_doc_text')));
await allow('config/training_overrides: map write', () => setDoc(doc(db, 'config', 'training_overrides'), { m1__l1: { titleEn: 'x' } }));
await deny('config/training_overrides: delete', () => deleteDoc(doc(db, 'config', 'training_overrides')));
await allow('config/insurance_index: entries write', () => setDoc(doc(db, 'config', 'insurance_index'), { entries: {} }, { merge: true }));
await deny('config/insurance_index: delete', () => deleteDoc(doc(db, 'config', 'insurance_index')));
await deny('config/toast_menu_items: client write', () => setDoc(doc(db, 'config', 'toast_menu_items'), { g: 'x' }));
await allow('config/toast_menu_items: read', () => getDoc(doc(db, 'config', 'toast_menu_items')));
await allow('config/inbox_categories: map write', () => setDoc(doc(db, 'config', 'inbox_categories'), { list: ['catering'] }));
await deny('config/inbox_categories: delete', () => deleteDoc(doc(db, 'config', 'inbox_categories')));

// ── 5. Append-only audit trails ───────────────────────────────────────
await allow('audit: create w/ serverTimestamp (recordAudit shape)', () => addDoc(collection(db, 'audit'), { action: 'rules_probe', actorName: 'test-harness', createdAt: serverTimestamp() }));
await deny('audit: create w/ forged old timestamp', () => addDoc(collection(db, 'audit'), { action: 'x', actorName: 'x', createdAt: Timestamp.fromDate(new Date('2025-01-01')) }));
await deny('audit: update', () => updateDoc(doc(db, 'audit', 'a1'), { action: 'tampered' }));
await deny('audit: delete', () => deleteDoc(doc(db, 'audit', 'a1')));
await allow('pin_audits: create', () => addDoc(collection(db, 'pin_audits'), { staffName: 'probe', ok: false }));
await deny('pin_audits: update', () => updateDoc(doc(db, 'pin_audits', 'p1'), { staffName: 'tampered' }));
await deny('pin_audits: delete', () => deleteDoc(doc(db, 'pin_audits', 'p1')));
await allow('inventory_audits_webster: create', () => addDoc(collection(db, 'inventory_audits_webster'), { item: 'probe', delta: 1 }));
await allow('recipe_audits: create', () => addDoc(collection(db, 'recipe_audits'), { action: 'edit', recipeId: 1, at: serverTimestamp() }));
await allow('backup_history: create', () => addDoc(collection(db, 'backup_history'), { note: 'probe' }));
await allow('staff_rename_log: create', () => addDoc(collection(db, 'staff_rename_log'), { oldName: 'a', newName: 'b' }));
await allow('onboarding_audits: create', () => addDoc(collection(db, 'onboarding_audits'), { action: 'probe' }));

// ── training_assignments (2026-08-19) — create open; bookkeeping maps +
// status editable; module/due/recipients frozen; never deletable ──────
await seed('training_assignments/ta1', { moduleId: S('m18'), status: S('open'), dueAt: TS('2026-09-01T00:00:00Z'), recipients: L(M({ name: S('Alice') })), sent: M({}), opened: M({}) });
await allow('training_assignments: create open', () => addDoc(collection(db, 'training_assignments'), { moduleId: 'm18', recipients: [{ name: 'Alice' }], status: 'open', dueAt: new Date(), sent: {}, opened: {} }));
await deny('training_assignments: create closed', () => addDoc(collection(db, 'training_assignments'), { moduleId: 'm18', recipients: [], status: 'closed' }));
await allow('training_assignments: stamp opened', () => updateDoc(doc(db, 'training_assignments', 'ta1'), new FieldPath('opened', 'alice'), '2026-08-19T00:00:00Z'));
await allow('training_assignments: close', () => updateDoc(doc(db, 'training_assignments', 'ta1'), { status: 'closed', closedAt: serverTimestamp(), closedBy: 'Alice' }));
await deny('training_assignments: move dueAt', () => updateDoc(doc(db, 'training_assignments', 'ta1'), { dueAt: new Date(2030, 0, 1) }));
await deny('training_assignments: shrink recipients', () => updateDoc(doc(db, 'training_assignments', 'ta1'), { recipients: [] }));
// 2026-08-25 — same-size recipients rewrite is ALLOWED (staff-rename fan-out
// rewrites recipients[].name + moves the name-keyed map entries); size
// changes stay blocked (a staffer must not add/drop people).
await allow('training_assignments: rename rewrite (same size + map move)', () => updateDoc(doc(db, 'training_assignments', 'ta1'),
    'recipients', [{ name: 'Alicia' }],
    new FieldPath('sent', 'alicia'), '2026-08-19T00:00:00Z'));
await deny('training_assignments: grow recipients', () => updateDoc(doc(db, 'training_assignments', 'ta1'), { recipients: [{ name: 'Alicia' }, { name: 'Bob' }] }));
await deny('training_assignments: delete', () => deleteDoc(doc(db, 'training_assignments', 'ta1')));
await deny('notifications: client mints training_reminder', () => addDoc(collection(db, 'notifications'), { forStaff: 'Alice', type: 'training_reminder', forceDeliver: true }));

// ── 6. CF-only collections sealed to clients ──────────────────────────
await deny('attendance: client create', () => addDoc(collection(db, 'attendance'), { staffName: 'x' }));
await deny('attendance: client update', () => updateDoc(doc(db, 'attendance', 'at1'), { staffName: 'y' }));
await deny('attendance: client delete', () => deleteDoc(doc(db, 'attendance', 'at1')));
await deny('ai_logs: client create', () => addDoc(collection(db, 'ai_logs'), { x: 1 }));
await deny('api_request_logs: client create', () => addDoc(collection(db, 'api_request_logs'), { x: 1 }));
await deny('sms_delivery_logs: client create', () => addDoc(collection(db, 'sms_delivery_logs'), { x: 1 }));
await deny('sms_delivery_logs: client delete', () => deleteDoc(doc(db, 'sms_delivery_logs', 'sd1')));
await deny('sms_inbound_events: client create', () => addDoc(collection(db, 'sms_inbound_events'), { x: 1 }));
await deny('sms_opt_in_events: client create', () => addDoc(collection(db, 'sms_opt_in_events'), { x: 1 }));
await deny('system: client write', () => setDoc(doc(db, 'system', 'gmail_sync_state'), { ok: false }));
await allow('system: client read (setup banner)', () => getDoc(doc(db, 'system', 'gmail_sync_state')));
await deny('rate_limits: client read', () => getDoc(doc(db, 'rate_limits', 'rl1')));
await deny('rate_limits: client write (counter reset)', () => setDoc(doc(db, 'rate_limits', 'rl1'), { count: 0 }));

// ── 7. Logs — append-only from clients ────────────────────────────────
await allow('error_logs: create (logError shape)', () => addDoc(collection(db, 'error_logs'), { severity: 'error', errorMessage: 'probe' }));
await deny('error_logs: update', () => updateDoc(doc(db, 'error_logs', 'el1'), { severity: 'info' }));
await deny('error_logs: delete', () => deleteDoc(doc(db, 'error_logs', 'el1')));
await allow('security_logs: create (logSecurityEvent shape)', () => addDoc(collection(db, 'security_logs'), { kind: 'probe' }));

// ── 8. Notifications — CF-only type lockdown ──────────────────────────
await allow('notifications: legit client type', () => addDoc(collection(db, 'notifications'), { forStaff: 'Alice', type: 'chat_message', title: 't', body: 'b', createdAt: serverTimestamp() }));
await deny('notifications: forge shift_reminder_1h', () => addDoc(collection(db, 'notifications'), { forStaff: 'Alice', type: 'shift_reminder_1h', title: 't', body: 'b', createdAt: serverTimestamp() }));
await deny('notifications: forge critical_error_alert', () => addDoc(collection(db, 'notifications'), { forStaff: 'Alice', type: 'critical_error_alert', title: 't', body: 'b', createdAt: serverTimestamp() }));
await allow('notifications: mark read', () => updateDoc(doc(db, 'notifications', 'n1'), { read: true }));
await deny('notifications: delete', () => deleteDoc(doc(db, 'notifications', 'n1')));

// ── 9. Email intel ────────────────────────────────────────────────────
await allow('email_intel: triage update', () => updateDoc(doc(db, 'email_intel', 'e1'), { category: 'catering', manuallyCorrected: true }));
await deny('email_intel: client create', () => addDoc(collection(db, 'email_intel'), { subject: 'forged' }));
await deny('email_intel: client delete', () => deleteDoc(doc(db, 'email_intel', 'e1')));
await allow('email_intel_corrections: create w/ CUSTOM category', () => addDoc(collection(db, 'email_intel_corrections'), { gmailId: 'e1', oldCategory: 'other', newCategory: 'my_custom_category' }));
await deny('email_intel_corrections: non-string category', () => addDoc(collection(db, 'email_intel_corrections'), { newCategory: 42 }));

// ── 10. Onboarding (PII) ──────────────────────────────────────────────
await allow('onboarding_hires: admin create shape', () => setDoc(doc(db, 'onboarding_hires', 'h2'), { id: 'h2', name: 'Dana', createdAt: '2026-07-11T00:00:00.000Z' }));
await allow('onboarding_hires: portal update (personal map)', () => updateDoc(doc(db, 'onboarding_hires', 'h1'), { personal: { dob: '1991-02-02' } }));
await deny('onboarding_hires: null over personal PII', () => updateDoc(doc(db, 'onboarding_hires', 'h1'), { personal: null }));
await deny('onboarding_hires: rewrite id anchor', () => updateDoc(doc(db, 'onboarding_hires', 'h1'), { id: 'other' }));
await deny('onboarding_hires: delete', () => deleteDoc(doc(db, 'onboarding_hires', 'h1')));
await allow('onboarding_invites: mint invite', () => setDoc(doc(db, 'onboarding_invites', 'tok999'), { hireId: 'h2', createdAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-25T00:00:00.000Z', used: false }));
await allow('onboarding_invites: markUsed (hireId intact)', () => updateDoc(doc(db, 'onboarding_invites', 'tok123'), { used: true }));
await deny('onboarding_invites: steal token (repoint hireId)', () => updateDoc(doc(db, 'onboarding_invites', 'tok123'), { hireId: 'h2' }));
await deny('onboarding_invites: delete', () => deleteDoc(doc(db, 'onboarding_invites', 'tok123')));
await allow('onboarding_applications: apply-form create', () => setDoc(doc(collection(db, 'onboarding_applications')), { name: 'Zed Probe', createdAt: serverTimestamp() }));
await deny('onboarding_applications: replayed createdAt', () => setDoc(doc(collection(db, 'onboarding_applications')), { name: 'Zed Probe', createdAt: Timestamp.fromDate(new Date('2025-01-01')) }));
await allow('onboarding_applications: triage update', () => updateDoc(doc(db, 'onboarding_applications', 'app1'), { status: 'reviewed' }));
await deny('onboarding_applications: rewrite applicant name', () => updateDoc(doc(db, 'onboarding_applications', 'app1'), { name: 'Eve' }));
await allow('onboarding_applications: admin dismiss (delete)', () => deleteDoc(doc(db, 'onboarding_applications', 'app1')));
await allow('onboarding_templates: save', () => addDoc(collection(db, 'onboarding_templates'), { name: 'MO W-4', forDocId: 'mo_w4', mode: 'fill', createdAt: '2026-07-11T00:00:00.000Z' }));
await deny('onboarding_templates: shapeless write', () => addDoc(collection(db, 'onboarding_templates'), { junk: 1 }));
await allow('onboarding_templates: admin delete (live button)', () => deleteDoc(doc(db, 'onboarding_templates', 'tpl1')));
await allow('recovery request: lock-screen create', () => addDoc(collection(db, 'onboarding_invite_recovery_requests'), { email: 'a@b.com', status: 'pending', requestedAt: serverTimestamp() }));
await deny('recovery request: bad status', () => addDoc(collection(db, 'onboarding_invite_recovery_requests'), { email: 'a@b.com', status: 'sent', requestedAt: serverTimestamp() }));

// ── 11. Insurance (CR-1 PII) ──────────────────────────────────────────
await allow('insurance: enroll create', () => addDoc(collection(db, 'insurance'), { staffName: 'Bob', status: 'submitted' }));
await allow('insurance: admin status update (merge)', () => setDoc(doc(db, 'insurance', 'ins1'), { status: 'approved' }, { merge: true }));
await deny('insurance: rewrite staffName', () => setDoc(doc(db, 'insurance', 'ins1'), { staffName: 'Mallory', status: 'approved' }, { merge: true }));
await deny('insurance: delete', () => deleteDoc(doc(db, 'insurance', 'ins1')));

// ── 12. Deletion requests, bug reports, pairing codes ─────────────────
await allow('deletion request: create pending', () => addDoc(collection(db, 'staff_deletion_requests'), { requesterName: 'Probe', status: 'pending' }));
await allow('deletion request: withdraw own pending', () => updateDoc(doc(db, 'staff_deletion_requests', 'r1'), { status: 'withdrawn' }));
await deny('deletion request: client self-approve', () => updateDoc(doc(db, 'staff_deletion_requests', 'r2'), { status: 'approved' }));
await deny('deletion request: delete', () => deleteDoc(doc(db, 'staff_deletion_requests', 'r2')));
await allow('bug_reports: resolve', () => updateDoc(doc(db, 'bug_reports', 'b1'), { status: 'resolved' }));
await deny('bug_reports: junk status', () => updateDoc(doc(db, 'bug_reports', 'b1'), { status: 'garbage' }));
await deny('bug_reports: delete', () => deleteDoc(doc(db, 'bug_reports', 'b1')));
await allow('pairing_codes: mint', () => setDoc(doc(db, 'pairing_codes', '222222'), { code: '222222', expiresAt: Timestamp.fromDate(new Date(Date.now() + 600000)) }));
await allow('pairing_codes: claim (code intact)', () => updateDoc(doc(db, 'pairing_codes', '111111'), { claimedAt: serverTimestamp(), deviceId: 'pi-1' }));
await deny('pairing_codes: forge onto other code', () => updateDoc(doc(db, 'pairing_codes', '111111'), { code: '333333' }));
await allow('pairing_codes: cleanup delete', () => deleteDoc(doc(db, 'pairing_codes', '222222')));

// ── 13. PTO / tardies / maintenance / needs / offsite / catering ──────
const to2 = await (async () => { const r = doc(collection(db, 'time_off')); await setDoc(r, { staffName: 'Probe', startDate: '2026-08-01', status: 'pending', createdAt: serverTimestamp() }); return r; })().then(r => (pass++, r), e => (fail++, failures.push(`time_off: self-serve create: ${e?.code || e}`), null));
await allow('time_off: approve update', () => updateDoc(doc(db, 'time_off', 'to1'), { status: 'approved' }));
if (to2) await allow('time_off: manager delete (deliberate feature)', () => deleteDoc(to2));
await allow('tardies: punch-in create', () => addDoc(collection(db, 'tardies'), { staffName: 'Probe', date: '2026-07-11', minutesLate: 5, enteredAt: serverTimestamp() }));
await deny('tardies: no staffName', () => addDoc(collection(db, 'tardies'), { date: '2026-07-11' }));
await allow('tardies: admin delete', () => deleteDoc(doc(db, 'tardies', 't1')));
await allow('maintenanceRequests: submit', () => addDoc(collection(db, 'maintenanceRequests'), { description: 'probe', status: 'open' }));
await allow('needs_webster: valid create', () => addDoc(collection(db, 'needs_webster'), { text: 'probe', urgency: 'soon', status: 'open', createdAt: serverTimestamp() }));
await deny('needs_webster: bad urgency', () => addDoc(collection(db, 'needs_webster'), { text: 'probe', urgency: 'ASAP!!', status: 'open' }));
await allow('offsite_shifts: clock-in create', () => addDoc(collection(db, 'offsite_shifts'), { staffName: 'Probe', status: 'pending' }));
await allow('cateringOrders: create', () => addDoc(collection(db, 'cateringOrders'), { name: 'probe' }));
const co = doc(db, 'cateringOrders', 'co-probe');
await seed('cateringOrders/co-probe', { name: S('seeded') });
await deny('cateringOrders: delete (history erasure)', () => deleteDoc(co));
await seed('offsite_shifts/os1', { staffName: S('Alice') });
await deny('offsite_shifts: delete (payroll-adjacent)', () => deleteDoc(doc(db, 'offsite_shifts', 'os1')));

// ── 14. TV heartbeats + print jobs ────────────────────────────────────
await allow('tv_heartbeats: legit heartbeat', () => setDoc(doc(db, 'tv_heartbeats', 'tv1'), { tvId: 'tv1', lastSeenAt: serverTimestamp() }, { merge: true }));
await deny('tv_heartbeats: null-timestamp mask (CR-5)', () => setDoc(doc(db, 'tv_heartbeats', 'tv2'), { tvId: 'tv2', lastSeenAt: null }));
await deny('tv_heartbeats: delete', () => deleteDoc(doc(db, 'tv_heartbeats', 'tv1')));
await allow('print_jobs: log attempt', () => addDoc(collection(db, 'print_jobs'), { kind: 'test', ok: true, createdAt: serverTimestamp() }));

// ── 15. Chats (NOT carved out — block matches catch-all) ─────────────
await allow('chats: create', () => setDoc(doc(db, 'chats', 'c2'), { members: ['Alice', 'Bob'] }));
await allow('chats: message create', () => setDoc(doc(db, 'chats', 'c2', 'messages', 'm1'), { text: 'hi', sender: 'Alice' }));
await allow('chats: acks subcollection (catch-all)', () => setDoc(doc(db, 'chats', 'c2', 'acks', 'a1'), { by: 'Bob' }));
await allow('chats: message delete (photo-issue rollback)', () => deleteDoc(doc(db, 'chats', 'c1', 'messages', 'm1')));
await allow('chats: chat delete (ChatSettingsModal)', () => deleteDoc(doc(db, 'chats', 'c1')));

// ── 16. Rice cooling log (2026-11-02) — health-department record ─────
// Payload shapes match src/data/riceLog.js buildRiceBatchDoc + mark* writes.
const riceBatch = (over = {}) => ({
    location: 'webster', cookDay: '2026-11-02', batchNo: 1,
    cookedAt: '2026-11-02T15:00:00.000Z', fridgeByAt: '2026-11-02T17:00:00.000Z', tossByAt: '2026-11-02T19:00:00.000Z',
    cookedBy: 'Probe Cook', status: 'cooling', stickerCount: 0, prints: [], notes: '', createdAt: serverTimestamp(),
    ...over,
});
await allow('rice_log: new batch', () => setDoc(doc(db, 'rice_log', 'rb1'), riceBatch()));
await allow('rice_log: second batch', () => setDoc(doc(db, 'rice_log', 'rb2'), riceBatch({ batchNo: 2 })));
await allow('rice_log: list a store-day (panel query)', () => getDocs(query(collection(db, 'rice_log'), where('location', '==', 'webster'), where('cookDay', '==', '2026-11-02'))));
await deny('rice_log: create already finished', () => setDoc(doc(db, 'rice_log', 'rbx'), riceBatch({ status: 'used' })));
await deny('rice_log: create bad store', () => setDoc(doc(db, 'rice_log', 'rby'), riceBatch({ location: 'both' })));
await deny('rice_log: create missing cook time', () => setDoc(doc(db, 'rice_log', 'rbz'), riceBatch({ cookedAt: null })));
await allow('rice_log: sticker print entry', () => updateDoc(doc(db, 'rice_log', 'rb1'), { prints: arrayUnion({ at: '2026-11-02T15:01:00.000Z', by: 'Probe Cook', copies: 1, ok: true }), stickerCount: 1 }));
await deny('rice_log: backdate cooked time', () => updateDoc(doc(db, 'rice_log', 'rb1'), { cookedAt: '2026-11-02T16:30:00.000Z' }));
await deny('rice_log: stretch toss deadline', () => updateDoc(doc(db, 'rice_log', 'rb1'), { tossByAt: '2026-11-02T23:00:00.000Z' }));
await deny('rice_log: renumber batch', () => updateDoc(doc(db, 'rice_log', 'rb1'), { batchNo: 9 }));
await allow('rice_log: into fridge with temp', () => updateDoc(doc(db, 'rice_log', 'rb1'), { status: 'fridge', fridgedAt: '2026-11-02T16:30:00.000Z', fridgedBy: 'Probe Cook', fridgeTempF: 68 }));
await deny('rice_log: rewrite a finished outcome', () => updateDoc(doc(db, 'rice_log', 'rb1'), { status: 'used', usedAt: '2026-11-02T16:40:00.000Z', usedBy: 'Probe Cook' }));
await deny('rice_log: edit a finished temp', () => updateDoc(doc(db, 'rice_log', 'rb1'), { fridgeTempF: 40 }));
await allow('rice_log: late print entry on finished batch', () => updateDoc(doc(db, 'rice_log', 'rb1'), { prints: arrayUnion({ at: '2026-11-02T16:31:00.000Z', by: 'Probe Cook', copies: 1, ok: true }), stickerCount: 2 }));
await deny('rice_log: junk status', () => updateDoc(doc(db, 'rice_log', 'rb2'), { status: 'eaten' }));
await allow('rice_log: tossed at 4h', () => updateDoc(doc(db, 'rice_log', 'rb2'), { status: 'tossed', tossedAt: '2026-11-02T19:05:00.000Z', tossedBy: 'Probe Cook', tossReason: 'past_4h' }));
await deny('rice_log: delete a batch', () => deleteDoc(doc(db, 'rice_log', 'rb2')));
// History can only grow (2026-11-03 review).
await deny('rice_log: wipe print history (finished batch)', () => updateDoc(doc(db, 'rice_log', 'rb1'), { prints: [], stickerCount: 0 }));
await allow('rice_log: stale absolute count from an older build still saves its print entry', () => updateDoc(doc(db, 'rice_log', 'rb1'), { prints: arrayUnion({ at: '2026-11-02T16:50:00.000Z', by: 'Old Build', copies: 1, ok: true }), stickerCount: 1 }));
await deny('rice_log: replace a print entry', () => updateDoc(doc(db, 'rice_log', 'rb1'), { prints: [{ at: 'x', by: 'forged', copies: 1, ok: true }, { at: 'y', by: 'forged', copies: 1, ok: true }] }));
await allow('rice_log: increment sticker count + append entry', () => updateDoc(doc(db, 'rice_log', 'rb1'), { prints: arrayUnion({ at: '2026-11-02T16:45:00.000Z', by: 'Probe Cook', copies: 2, ok: true }), stickerCount: increment(2) }));
await setDoc(doc(db, 'rice_log', 'rb3'), riceBatch({ batchNo: 3, prints: [{ at: 'a', by: 'p', copies: 1, ok: false }] }));
await deny('rice_log: wipe print history (open batch)', () => updateDoc(doc(db, 'rice_log', 'rb3'), { prints: [] }));
await allow('rice_log: open batch outcome keeps history', () => updateDoc(doc(db, 'rice_log', 'rb3'), { status: 'used', usedAt: '2026-11-02T17:00:00.000Z', usedBy: 'Probe Cook' }));

// ── 16b. Rice log v2 (2026-11-03): routes, edits[], soft delete ──────
// Payload shapes match src/data/riceLog.js buildRiceBatchDoc + the row writes.
const riceV2 = (over = {}) => riceBatch({
    schemaVersion: 2, route: 'time_control',
    madeAt: '2026-11-02T15:00:00.000Z', wokByAt: '2026-11-02T18:45:00.000Z',
    timeSource: 'now', minutesLate: 0, startTempF: 198, startAttempts: [198], startSetBy: 'rolled',
    pans: 1, createdMs: 1793000000000,
    ...over,
});
const riceFridge = (over = {}) => riceV2({
    route: 'cooling', wokByAt: null,
    seventyByAt: '2026-11-02T17:00:00.000Z', fortyOneByAt: '2026-11-02T21:00:00.000Z', useByDay: '2026-11-03',
    ...over,
});
const riceRef = (id) => doc(db, 'rice_log', id);
const riceEdit = (field, oldValue, newValue, at = '2026-11-02T16:00:00.000Z') => ({ field, old: oldValue, new: newValue, by: 'Probe Lead', at });

// Create
await allow('rice_log v2: For Today batch', () => setDoc(riceRef('v1'), riceV2()));
await allow('rice_log v2: For the Fridge batch', () => setDoc(riceRef('v2'), riceFridge({ batchNo: 2 })));
await allow('rice_log v2: born tossed, reading stayed low', () => setDoc(riceRef('v3'), riceV2({ batchNo: 3, status: 'tossed', tossedAt: '2026-11-02T15:00:00.000Z', tossedBy: 'Probe Cook', tossReason: 'below_135', startAttempts: [128, 130], startTempF: 130 })));
await allow('rice_log v2: born tossed, unmarked over 10 minutes', () => setDoc(riceRef('v4'), riceV2({ batchNo: 4, status: 'tossed', tossedAt: '2026-11-02T15:00:00.000Z', tossedBy: 'Probe Cook', tossReason: 'no_sticker', timeUnknown: true, startAttempts: [], startTempF: null })));
await deny('rice_log v2: born tossed for any other reason', () => setDoc(riceRef('vx1'), riceV2({ status: 'tossed', tossReason: 'leftover' })));
await deny('rice_log v2: born used', () => setDoc(riceRef('vx2'), riceV2({ status: 'used' })));
await deny('rice_log v2: wrong schemaVersion', () => setDoc(riceRef('vx3'), riceV2({ schemaVersion: 3 })));
await deny('rice_log v2: junk route', () => setDoc(riceRef('vx4'), riceV2({ route: 'counter' })));
await deny('rice_log v2: route with no schemaVersion', () => { const { schemaVersion, ...rest } = riceV2(); return setDoc(riceRef('vx5'), rest); });
await deny('rice_log v2: forged createdAt', () => setDoc(riceRef('vx6'), riceV2({ createdAt: Timestamp.fromDate(new Date('2026-11-02T15:00:00Z')) })));
await deny('rice_log v2: made time disagrees with cookedAt', () => setDoc(riceRef('vx7'), riceV2({ madeAt: '2026-11-02T15:30:00.000Z' })));
await deny('rice_log v2: For Today with no wok-by', () => setDoc(riceRef('vx8'), riceV2({ wokByAt: null })));
await deny('rice_log v2: For the Fridge with no 41F deadline', () => setDoc(riceRef('vx9'), riceFridge({ fortyOneByAt: null })));
await deny('rice_log v2: born already deleted', () => setDoc(riceRef('vx10'), riceV2({ deletedAt: 'x', deletedBy: 'x', deleteReason: 'x' })));
await deny('rice_log v2: born with edits', () => setDoc(riceRef('vx11'), riceV2({ edits: [riceEdit('pans', 1, 2)] })));
await allow('rice_log v2: open-batch query', () => getDocs(query(collection(db, 'rice_log'), where('location', '==', 'webster'), where('status', 'in', ['cooling', 'fridge']))));

// Identity stays frozen, even with an edits[] entry riding along.
await deny('rice_log v2: route is immutable', () => updateDoc(riceRef('v1'), { route: 'cooling' }));
await deny('rice_log v2: route is immutable with an edit', () => updateDoc(riceRef('v1'), { route: 'cooling', edits: arrayUnion(riceEdit('route', 'time_control', 'cooling')) }));
await deny('rice_log v2: made time is immutable with an edit', () => updateDoc(riceRef('v1'), { madeAt: '2026-11-02T14:00:00.000Z', cookedAt: '2026-11-02T14:00:00.000Z', edits: arrayUnion(riceEdit('madeAt', 'a', 'b')) }));
await deny('rice_log v2: deadline is immutable with an edit', () => updateDoc(riceRef('v1'), { tossByAt: '2026-11-02T23:00:00.000Z', edits: arrayUnion(riceEdit('tossByAt', 'a', 'b')) }));
await deny('rice_log v2: cook is immutable with an edit', () => updateDoc(riceRef('v1'), { cookedBy: 'Someone Else', edits: arrayUnion(riceEdit('cookedBy', 'a', 'b')) }));
await deny('rice_log v2: start attempts are immutable with an edit', () => updateDoc(riceRef('v1'), { startAttempts: [199], edits: arrayUnion(riceEdit('startAttempts', [198], [199])) }));
await deny('rice_log v2: schemaVersion is immutable', () => updateDoc(riceRef('v1'), { schemaVersion: 1 }));
await deny('rice_log v2: reading can\'t change without an edit entry', () => updateDoc(riceRef('v1'), { startTempF: 150 }));
await deny('rice_log v2: pans can\'t change without an edit entry', () => updateDoc(riceRef('v1'), { pans: 3 }));

// Edits
await allow('rice_log v2: edit reading on an open batch', () => updateDoc(riceRef('v1'), { startTempF: 199, edits: arrayUnion(riceEdit('startTempF', 198, 199)) }));
await allow('rice_log v2: edit pans and note together', () => updateDoc(riceRef('v1'), { pans: 2, notes: 'two pans', edits: arrayUnion(riceEdit('pans', 1, 2, '2026-11-02T16:01:00.000Z'), riceEdit('notes', '', 'two pans', '2026-11-02T16:01:00.000Z')) }));
await deny('rice_log v2: edits can\'t be wiped', () => updateDoc(riceRef('v1'), { edits: [] }));
await deny('rice_log v2: an edit entry can\'t be replaced', () => updateDoc(riceRef('v1'), { edits: [riceEdit('startTempF', 1, 2), riceEdit('pans', 1, 2), riceEdit('notes', '', 'x')] }));
await deny('rice_log v2: a correction that shrinks edits', () => updateDoc(riceRef('v1'), { startTempF: 180, edits: [riceEdit('startTempF', 180, 180)] }));

// For Today never goes in the fridge, whoever asks.
await deny('rice_log v2: For Today can\'t go in the fridge', () => updateDoc(riceRef('v1'), { status: 'fridge', fridgedAt: '2026-11-02T16:30:00.000Z', fridgedBy: 'Probe Cook' }));
await deny('rice_log v2: For Today can\'t be corrected into the fridge', () => updateDoc(riceRef('v1'), { status: 'fridge', edits: arrayUnion(riceEdit('status', 'cooling', 'fridge', '2026-11-02T16:02:00.000Z')) }));

// Closing
await allow('rice_log v2: closed as "don\'t know"', () => updateDoc(riceRef('v1'), { status: 'unknown', unknownAt: '2026-11-02T20:00:00.000Z', unknownBy: 'Probe Cook', closeAnswer: 'unknown' }));
await deny('rice_log v2: a closed batch can\'t change without an edit entry', () => updateDoc(riceRef('v1'), { status: 'tossed', tossedAt: '2026-11-02T20:01:00.000Z', tossedBy: 'Probe Cook', tossReason: 'past_4h' }));
await allow('rice_log v2: a closed batch corrected with an edit entry', () => updateDoc(riceRef('v1'), { status: 'tossed', tossedAt: '2026-11-02T20:02:00.000Z', tossedBy: 'Probe Lead', tossReason: 'past_4h', edits: arrayUnion(riceEdit('status', 'unknown', 'tossed', '2026-11-02T20:02:00.000Z')) }));
await deny('rice_log v2: nothing goes back to open', () => updateDoc(riceRef('v1'), { status: 'cooling', edits: arrayUnion(riceEdit('status', 'tossed', 'cooling', '2026-11-02T20:03:00.000Z')) }));
await allow('rice_log v2: late sticker entry on a closed batch', () => updateDoc(riceRef('v1'), { prints: arrayUnion({ at: '2026-11-02T20:04:00.000Z', by: 'Probe Cook', copies: 1, ok: true }), stickerCount: increment(1) }));

// Fridge batch: into the fridge, readings, used or tossed.
await allow('rice_log v2: reading while it cools', () => updateDoc(riceRef('v2'), { readings: arrayUnion({ tempF: 90, at: '2026-11-02T16:00:00.000Z', enteredAt: '2026-11-02T16:00:05.000Z', by: 'Probe Cook', kind: 'fridge' }) }));
await allow('rice_log v2: Fridge batch into the fridge with a reading', () => updateDoc(riceRef('v2'), { status: 'fridge', fridgedAt: '2026-11-02T16:50:00.000Z', fridgedBy: 'Probe Cook', fridgeTempF: 68, readings: arrayUnion({ tempF: 68, at: '2026-11-02T16:50:00.000Z', enteredAt: '2026-11-02T16:50:05.000Z', by: 'Probe Cook', kind: 'fridge' }) }));
await deny('rice_log v2: readings can\'t be wiped', () => updateDoc(riceRef('v2'), { readings: [] }));
await deny('rice_log v2: into-fridge time can\'t change without an edit', () => updateDoc(riceRef('v2'), { fridgedAt: '2026-11-02T15:30:00.000Z' }));
await allow('rice_log v2: morning reading', () => updateDoc(riceRef('v2'), { readings: arrayUnion({ tempF: 38, at: '2026-11-03T13:00:00.000Z', enteredAt: '2026-11-03T13:00:05.000Z', by: 'Probe Opener', kind: 'morning' }) }));
await allow('rice_log v2: Fridge batch marked used', () => updateDoc(riceRef('v2'), { status: 'used', usedAt: '2026-11-03T15:00:00.000Z', usedBy: 'Probe Cook' }));
await deny('rice_log v2: a used Fridge batch can\'t go back in the fridge', () => updateDoc(riceRef('v2'), { status: 'fridge', edits: arrayUnion(riceEdit('status', 'used', 'fridge')) }));
await allow('rice_log v2: late reading on a closed batch', () => updateDoc(riceRef('v2'), { readings: arrayUnion({ tempF: 39, at: '2026-11-03T13:30:00.000Z', enteredAt: '2026-11-03T16:00:00.000Z', by: 'Probe Opener', kind: 'fridge' }) }));
await setDoc(riceRef('v5'), riceFridge({ batchNo: 5 }));
await updateDoc(riceRef('v5'), { status: 'fridge', fridgedAt: '2026-11-02T16:50:00.000Z', fridgedBy: 'Probe Cook' });
await allow('rice_log v2: morning reading above 41F logs the toss', () => updateDoc(riceRef('v5'), { status: 'tossed', tossedAt: '2026-11-03T13:01:00.000Z', tossedBy: 'Probe Opener', tossReason: 'morning_above_41', readings: arrayUnion({ tempF: 44, at: '2026-11-03T13:00:00.000Z', enteredAt: '2026-11-03T13:01:00.000Z', by: 'Probe Opener', kind: 'morning' }) }));

// Soft delete
await setDoc(riceRef('v6'), riceV2({ batchNo: 6 }));
await deny('rice_log v2: hard delete stays blocked', () => deleteDoc(riceRef('v6')));
await deny('rice_log v2: soft delete needs a who', () => updateDoc(riceRef('v6'), { deletedAt: '2026-11-02T15:05:00.000Z', deleteReason: 'Printed by mistake' }));
await deny('rice_log v2: soft delete can\'t change anything else', () => updateDoc(riceRef('v6'), { deletedAt: '2026-11-02T15:05:00.000Z', deletedBy: 'Probe Cook', deleteReason: 'x', status: 'used' }));
await allow('rice_log v2: soft delete', () => updateDoc(riceRef('v6'), { deletedAt: '2026-11-02T15:05:00.000Z', deletedBy: 'Probe Cook', deleteReason: 'Printed by mistake' }));
await deny('rice_log v2: a soft delete can\'t be rewritten', () => updateDoc(riceRef('v6'), { deletedBy: 'Someone Else' }));
await deny('rice_log v2: a soft delete can\'t be undone', () => updateDoc(riceRef('v6'), { deletedAt: deleteField(), deletedBy: deleteField(), deleteReason: deleteField() }));
await deny('rice_log v2: a soft delete can\'t be undone through an edit', () => updateDoc(riceRef('v6'), { deletedAt: deleteField(), edits: arrayUnion(riceEdit('deletedAt', 'a', null)) }));
await allow('rice_log v2: a queued sticker entry still lands on a deleted ticket', () => updateDoc(riceRef('v6'), { prints: arrayUnion({ at: '2026-11-02T15:06:00.000Z', by: 'Probe Cook', copies: 1, ok: true }) }));
await deny('rice_log v2: hard delete blocked on a soft-deleted ticket', () => deleteDoc(riceRef('v6')));
await allow('rice_log v2: an old row can be soft-deleted', () => updateDoc(riceRef('rb3'), { deletedAt: '2026-11-02T18:00:00.000Z', deletedBy: 'Probe Lead', deleteReason: 'Test ticket' }));

// Builds up to v1.0.500 acting on new rows keep working.
await setDoc(riceRef('v7'), riceV2({ batchNo: 7 }));
await allow('rice_log old build: print entry on a v2 row', () => updateDoc(riceRef('v7'), { prints: arrayUnion({ at: '2026-11-02T15:01:00.000Z', by: 'Old Build', copies: 1, ok: true }), stickerCount: 1 }));
await allow('rice_log old build: closes a v2 row as used', () => updateDoc(riceRef('v7'), { status: 'used', usedAt: '2026-11-02T16:00:00.000Z', usedBy: 'Old Build' }));
await setDoc(riceRef('v8'), riceV2({ batchNo: 8 }));
await allow('rice_log old build: voids a v2 row', () => updateDoc(riceRef('v8'), { status: 'void', voidedAt: '2026-11-02T15:05:00.000Z', voidedBy: 'Old Build' }));
await setDoc(riceRef('v9'), riceV2({ batchNo: 9 }));
await allow('rice_log old build: tosses a v2 row', () => updateDoc(riceRef('v9'), { status: 'tossed', tossedAt: '2026-11-02T19:05:00.000Z', tossedBy: 'Old Build', tossReason: 'chose_to_toss' }));
// An old row's 'fridge' stays final, and new status words reach old rows too.
// A reading below 135F: its own write-once doc, invisible to old builds' lists.
const riceLow = (over = {}) => ({
    recordType: 'low_reading', schemaVersion: 2, location: 'webster', readingDay: '2026-11-02',
    tempF: 128, at: '2026-11-02T15:00:00.000Z', by: 'Probe Cook', setBy: 'rolled', createdAt: serverTimestamp(),
    ...over,
});
await allow('rice_log low reading: logged', () => setDoc(riceRef('l1'), riceLow()));
await allow('rice_log low reading: listed by store and day', () => getDocs(query(collection(db, 'rice_log'), where('location', '==', 'webster'), where('readingDay', '==', '2026-11-02'))));
await deny('rice_log low reading: bad store', () => setDoc(riceRef('lx1'), riceLow({ location: 'both' })));
await deny('rice_log low reading: no temperature', () => setDoc(riceRef('lx2'), riceLow({ tempF: null })));
await deny('rice_log low reading: forged createdAt', () => setDoc(riceRef('lx3'), riceLow({ createdAt: Timestamp.fromDate(new Date('2026-11-02T15:00:00Z')) })));
await deny('rice_log low reading: can\'t pose as a batch', () => setDoc(riceRef('lx4'), riceLow({ status: 'cooling' })));
await deny('rice_log low reading: can\'t land on a day\'s batch list', () => setDoc(riceRef('lx5'), riceLow({ cookDay: '2026-11-02' })));
await deny('rice_log low reading: can\'t take a batch number', () => setDoc(riceRef('lx6'), riceLow({ batchNo: 1 })));
await deny('rice_log low reading: never changes', () => updateDoc(riceRef('l1'), { tempF: 142 }));
await deny('rice_log low reading: can\'t be turned into a batch', () => updateDoc(riceRef('l1'), { status: 'used', edits: arrayUnion(riceEdit('status', 'x', 'used')) }));
await deny('rice_log low reading: can\'t be soft-deleted', () => updateDoc(riceRef('l1'), { deletedAt: 'x', deletedBy: 'x', deleteReason: 'x' }));
await deny('rice_log low reading: can\'t be deleted', () => deleteDoc(riceRef('l1')));

// A batch linking back to its low readings; the link is frozen like the rest.
await allow('rice_log v2: batch with low readings linked', () => setDoc(riceRef('v10'), riceV2({ batchNo: 10, startAttempts: [128, 142], startTempF: 142, lowReadingIds: ['l1'] })));
await deny('rice_log v2: low-reading link is frozen', () => updateDoc(riceRef('v10'), { lowReadingIds: [] }));
await deny('rice_log v2: low-reading link is frozen with an edit', () => updateDoc(riceRef('v10'), { lowReadingIds: [], edits: arrayUnion(riceEdit('lowReadingIds', ['l1'], [])) }));

// "It came out": the cook's word goes in the print history, which only grows.
await allow('rice_log v2: sticker confirmed by the cook', () => updateDoc(riceRef('v10'), { prints: arrayUnion({ at: '2026-11-02T15:02:00.000Z', by: 'Probe Cook', copies: 1, ok: true, seen: true }), stickerCount: increment(1) }));

// edits[] is strictly append-only: order kept, nothing collapsed.
const e1 = riceEdit('pans', 1, 2, '2026-11-02T16:10:00.000Z');
const e2 = riceEdit('notes', '', 'x', '2026-11-02T16:11:00.000Z');
const e3 = riceEdit('notes', 'x', 'y', '2026-11-02T16:12:00.000Z');
await setDoc(riceRef('v11'), riceV2({ batchNo: 11 }));
await allow('rice_log v2: first edit', () => updateDoc(riceRef('v11'), { pans: 2, edits: arrayUnion(e1) }));
await allow('rice_log v2: second edit appends', () => updateDoc(riceRef('v11'), { notes: 'x', edits: arrayUnion(e2) }));
await deny('rice_log v2: edits can\'t be reordered, even while growing', () => updateDoc(riceRef('v11'), { notes: 'y', edits: [e2, e1, e3] }));
await deny('rice_log v2: edits can\'t be reordered', () => updateDoc(riceRef('v11'), { edits: [e2, e1] }));
await deny('rice_log v2: an edit can\'t be dropped while adding two', () => updateDoc(riceRef('v11'), { notes: 'y', edits: [e2, e3, e3] }));
await allow('rice_log v2: third edit appends', () => updateDoc(riceRef('v11'), { notes: 'y', edits: arrayUnion(e3) }));
await setDoc(riceRef('v12'), riceV2({ batchNo: 12 }));
await updateDoc(riceRef('v12'), { pans: 2, edits: [e1, e1] });
await deny('rice_log v2: duplicate entries can\'t be collapsed', () => updateDoc(riceRef('v12'), { notes: 'x', edits: [e1, e2, e3] }));

// Voiding is the old builds' misprint on an open batch, never a correction.
await setDoc(riceRef('v13'), riceV2({ batchNo: 13, status: 'tossed', tossedAt: '2026-11-02T15:00:00.000Z', tossedBy: 'Probe Cook', tossReason: 'below_135', startAttempts: [128, 130], startTempF: 130 }));
await deny('rice_log v2: a tossed batch can\'t be voided through a correction', () => updateDoc(riceRef('v13'), { status: 'void', edits: arrayUnion(riceEdit('status', 'tossed', 'void')) }));
await setDoc(riceRef('v14'), riceV2({ batchNo: 14 }));
await deny('rice_log v2: an open batch can\'t be voided through a correction', () => updateDoc(riceRef('v14'), { status: 'void', edits: arrayUnion(riceEdit('status', 'cooling', 'void')) }));
await allow('rice_log old build: an open batch can still be voided', () => updateDoc(riceRef('v14'), { status: 'void', voidedAt: '2026-11-02T15:05:00.000Z', voidedBy: 'Old Build' }));
await allow('rice_log v2: a voided row\'s note can still be corrected', () => updateDoc(riceRef('v14'), { notes: 'x', edits: arrayUnion(riceEdit('notes', '', 'x')) }));

// Corrections write these fields.
await setDoc(riceRef('v15'), riceV2({ batchNo: 15 }));
await allow('rice_log v2: "saw it gone" through a correction', () => updateDoc(riceRef('v15'), { status: 'used', usedAt: '2026-11-02T20:00:00.000Z', usedBy: 'Probe Lead', closedLate: true, closeAnswer: 'saw_gone', edits: arrayUnion(riceEdit('status', 'cooling', 'saw_gone')) }));
await allow('rice_log v2: tossed past its 70F time', () => setDoc(riceRef('v16'), riceFridge({ batchNo: 16 })).then(() => updateDoc(riceRef('v16'), { status: 'tossed', tossedAt: '2026-11-02T18:00:00.000Z', tossedBy: 'Probe Cook', tossReason: 'past_70f' })));

await setDoc(riceRef('o1'), riceBatch({ batchNo: 20 }));
await allow('rice_log old row: still allowed in the fridge', () => updateDoc(riceRef('o1'), { status: 'fridge', fridgedAt: '2026-11-02T16:30:00.000Z', fridgedBy: 'Old Build', fridgeTempF: 68 }));
await deny('rice_log old row: fridge stays final', () => updateDoc(riceRef('o1'), { status: 'used', usedAt: '2026-11-02T16:40:00.000Z', usedBy: 'Probe Cook' }));
await setDoc(riceRef('o2'), riceBatch({ batchNo: 21 }));
await allow('rice_log old row: closed as "don\'t know"', () => updateDoc(riceRef('o2'), { status: 'unknown', unknownAt: '2026-11-02T20:00:00.000Z', unknownBy: 'Probe Cook', closeAnswer: 'unknown' }));

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
}
console.log('All rules assertions passed.');
process.exit(0);
