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
    getFirestore, connectFirestoreEmulator, doc, collection,
    setDoc, addDoc, updateDoc, deleteDoc, getDoc, serverTimestamp, Timestamp,
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

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
}
console.log('All rules assertions passed.');
process.exit(0);
