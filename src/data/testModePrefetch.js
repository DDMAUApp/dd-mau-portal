// testModePrefetch.js — copy a snapshot of the live data into the test-mode
// memory cache, then cut the network for good (see testMode.js).
//
// Runs in main.jsx BEFORE the app renders, so no app code can write while
// the network is still on (test-mode writes also wait on the shim gate).
// Uses the REAL SDK (@firebase/firestore), not the app's shim.
//
// Offline queries run against whatever is in cache, so coverage here is
// what the tester sees: small collections are copied whole, big ones as a
// recent window (sizes measured 2026-11-03). A collection missing from these
// lists still works in test mode — it just starts empty. Add new
// collections here as features land.
import {
    collection, doc, documentId, getDoc, getDocs, query, where, orderBy, limit, disableNetwork, updateDoc,
} from '@firebase/firestore';
import { db } from '../firebase';
import { __openTestModeGate } from '../testmode/firestoreShim';
import { TEST_MODE } from './testMode';

// CREDENTIALS + PRIVATE RECORDS ARE NEVER COPIED (2026-11-03 review): the
// tester is an owner in the UI, so anything in the snapshot is on screen.
// Not copied: onboarding hires/applications/invite tokens/signatures,
// health records, insurance, payroll (runs, notes, roster rates, password
// hash), archived staff records (old PINs), PIN audits, recruiting leads,
// onboarding audits (they carry invite tokens), the owner's email triage,
// SMS logs (phone numbers + message bodies), the print-bridge API key —
// and other people's chats (only chats the tester is a member of are
// copied). Those screens open empty in test mode. Every real PIN except the
// tester's own is replaced (see scrubRoster below).
export const EXCLUDED_FROM_TEST_MODE = Object.freeze([
    'onboarding_hires', 'onboarding_applications', 'onboarding_invites', 'onboarding_signature_events',
    'onboarding_invite_recovery_requests', 'application_audits', 'recruiting_leads', 'health_records',
    'insurance', 'payroll_runs', 'payroll_notes', 'staff_archive', 'pin_audits', 'onboarding_audits',
    'email_intel', 'email_intel_corrections', 'sms_inbound_events', 'sms_delivery_logs', 'sms_opt_in_events',
    'chats (other people\'s)',
    'config/payroll_meta', 'config/payroll_roster', 'config/payroll_queued_adds', 'config/insurance_index',
    'config/print_bridge', 'config/onboarding_company', 'config/secrets',
]);

// Copied whole (all are a few hundred docs or fewer).
export const FULL_COLLECTIONS = [
    'recurring_shifts', 'date_blocks', 'time_off', 'staffing_needs', 'schedule_templates',
    'swap_requests', 'calendar_events', 'scheduled_messages', 'announcements', 'chat_prefs', 'chat_tasks',
    'ops', 'system', 'inventory_lists', 'inventoryHistory_both', 'sauceLogHistory_webster', 'sauceLogHistory_maryland',
    'item_prices_webster', 'item_prices_maryland',
    'item_aliases_webster', 'item_aliases_maryland', 'vendor_prices', 'receipt_scans_webster',
    'receipt_scans_maryland', 'order_sessions', 'order_logs', 'toast_invoices', 'cateringOrders',
    'recipe_audits', 'build_overrides', 'custom_items', 'menu_overrides', 'tv_configs',
    'tv_holidays', 'tv_heartbeats', 'tv_crash_logs', 'training', 'training_v2', 'training_assignments', 'training_progress',
    'training_results', 'app_tour_progress', 'staff_todos', 'assigned_tasks', 'required_tasks',
    'required_task_audits', 'task_plan', 'shift_handoffs', 'tardies', 'offsite_shifts', 'money_counts',
    'cash_tips', 'timecard_disputes', 'onboarding_templates',
    'staff_deletion_requests', 'tester_requests',
    'maintenanceRequests', 'maintenance_tickets', 'needs_webster', 'needs_maryland',
    'rice_log', 'staff_rename_log', 'backup_history', 'deploys', 'health_check_runs',
    'pairing_codes', 'bug_reports',
    'security_logs', 'waste_log',
];

// Big collections: newest N by a time field.
export const WINDOWED = [
    ['toast_orders', 'businessDate', 600],
    ['laborHistory_webster', 'timestamp', 1500],
    ['laborHistory_maryland', 'timestamp', 1500],
    ['timecards', 'date', 800],
    ['attendance', 'date', 800],
    ['sticker_prints', 'createdAt', 500],
    ['inventory_audits_webster', 'at', 500],
    ['inventory_audits_maryland', 'at', 500],
    ['notifications', 'createdAt', 300],
    ['audit', 'createdAt', 300],
    ['error_logs', 'ts', 300],
    ['print_jobs', 'createdAt', 300],
    ['health_checks', 'ranAt', 300],
    ['recipe_views', 'viewedAt', 200],
    ['ai_logs', 'ts', 200],
];

// Snapshot histories whose doc ids start with the date ('2026-10-31_…'):
// the last HISTORY_DAYS by id range (ascending id range = built-in index;
// a descending id sort would need a composite index).
export const ID_WINDOWED = [
    'inventoryHistory', 'inventoryHistory_webster', 'inventoryHistory_maryland',
    'checklistHistory', 'checklistHistory_webster', 'checklistHistory_maryland',
];
export const HISTORY_DAYS = 45;

// Shifts: every future shift + the last SHIFT_HISTORY_DAYS (dates are
// 'YYYY-MM-DD' strings, so a string range works).
export const SHIFT_HISTORY_DAYS = 120;

// /config can't be listed (rules) — fetched doc by doc.
export const CONFIG_DOCS = [
    'app_flags', 'brand', 'build_sheet', 'eighty_six_alerts', 'feature_flags', 'forceRefresh', 'health_docs',
    'inbox_categories', 'inbox_routing_rules', 'label_format', 'label_format_brother', 'laborTarget',
    'menu_v2', 'minVersion', 'onboarding_doc_text', 'policies',
    'printers_maryland_kitchen', 'printers_webster_kitchen', 'printers_maryland_office', 'printers_webster_office',
    'printers_maryland', 'printers_webster', 'recipes', 'schedule_settings', 'skillsMatrix',
    'sms', 'staff', 'stations', 'stations_FOH', 'stations_BOH', 'sticker_lists', 'task_library_BOH',
    'task_library_FOH', 'toast_maryland', 'toast_menu_items', 'toast_webster', 'training_overrides',
    'vendor_categories', 'vendor_matches', 'vendors',
];

// Per-chat subcollections (newest messages, plus the small side tables).
const CHAT_SUBS = [['messages', 'createdAt', 40], ['acks', null, 100], ['pins', null, 30]];

// Everything the test user needs to see the whole app as an owner.
const FULL_ACCESS = {
    opsAccess: true, recipesAccess: true, viewLabor: true, canCountMoney: true, healthAccess: true,
    canViewClockedIn: true, canViewOnboarding: true, canReceive86Alerts: true,
    canEditScheduleFOH: true, canEditScheduleBOH: true, shiftLead: true, hiddenPages: [],
};

// Test-mode roster: the test user gets owner-level flags; every OTHER real
// PIN is replaced (an owner PIN on screen would be a real login to the
// owner account once the tester exits). Fake PINs stay unique 4-digit strings so
// staff edits still pass the roster's PIN validation. Push tokens dropped.
export function scrubRoster(list, testName) {
    // Reserve every real PIN first so a fake one can never equal a real one.
    // The tester keeps their own (they know it; Recipes re-asks for it).
    const used = new Set(list.map((s) => String(s?.pin ?? '').trim()).filter(Boolean));
    let next = 9000;
    const fakePin = () => {
        while (used.has(String(next))) next += 1;
        const p = String(next);
        used.add(p);
        next += 1;
        return p;
    };
    return list.map((s) => {
        if (!s || typeof s !== 'object') return s;
        const { fcmTokens, ...rest } = s;
        if (s.name === testName) return { ...rest, ...FULL_ACCESS, testMode: true };
        return { ...rest, pin: fakePin() };
    });
}

async function pool(tasks, size) {
    let i = 0;
    const run = async () => {
        while (i < tasks.length) {
            const t = tasks[i++];
            try { await t(); } catch { /* one bad query never blocks the rest */ }
        }
    };
    await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, run));
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

// Copies the snapshot, cuts the network, grants the test user full access
// on this device, then opens the shim gate. Resolves with copy stats.
export async function prepareTestMode({ onProgress, budgetMs = 45000 } = {}) {
    const started = Date.now();
    let done = 0;
    const tasks = [];
    const add = (fn) => tasks.push(async () => { await fn(); done += 1; onProgress?.(done, tasks.length); });

    for (const id of CONFIG_DOCS) add(() => getDoc(doc(db, 'config', id)));
    for (const name of FULL_COLLECTIONS) add(() => getDocs(collection(db, name)));
    for (const [name, field, n] of WINDOWED) add(() => getDocs(query(collection(db, name), orderBy(field, 'desc'), limit(n))));
    const dayStr = (daysAgo) => {
        const d = new Date(Date.now() - daysAgo * 86400000);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    for (const name of ID_WINDOWED) add(() => getDocs(query(collection(db, name), where(documentId(), '>=', dayStr(HISTORY_DAYS)))));
    add(() => getDocs(query(collection(db, 'shifts'), where('date', '>=', dayStr(SHIFT_HISTORY_DAYS)))));
    if (TEST_MODE?.name) {
        add(() => getDocs(query(collection(db, 'notifications'), where('forStaff', '==', TEST_MODE.name), orderBy('createdAt', 'desc'), limit(200))));
    }

    // Chats: only the ones the tester is a member of (same query the chat
    // list runs) — Admin → Chat history would otherwise show every DM.
    add(async () => {
        if (!TEST_MODE?.name) return;
        const chats = await getDocs(query(collection(db, 'chats'), where('members', 'array-contains', TEST_MODE.name)));
        const subTasks = [];
        chats.forEach((c) => {
            for (const [sub, field, n] of CHAT_SUBS) {
                subTasks.push(() => getDocs(field
                    ? query(collection(db, 'chats', c.id, sub), orderBy(field, 'desc'), limit(n))
                    : query(collection(db, 'chats', c.id, sub), limit(n))));
            }
        });
        await pool(subTasks, subTasks.length);
    });

    // All at once: the SDK multiplexes every query over one stream, and a
    // small pool measured ~2.5x slower than letting it batch them.
    await withTimeout(pool(tasks, tasks.length), budgetMs);

    // Point of no return: the network is off for the rest of this page.
    await disableNetwork(db);

    // Roster copy, rewritten in the LOCAL cache (network is off): full
    // access for the test user, and no real credentials for anyone.
    try {
        const staffRef = doc(db, 'config', 'staff');
        const snap = await getDoc(staffRef);
        const list = snap.exists() && Array.isArray(snap.data()?.list) ? snap.data().list : null;
        if (list && TEST_MODE?.name) {
            // Real SDK write, never awaited — it can only ever apply locally.
            updateDoc(staffRef, { list: scrubRoster(list, TEST_MODE.name) }).catch(() => {});
        }
    } catch (e) {
        // A failed scrub must never show the app with real PINs in cache —
        // main.jsx leaves test mode when prepare throws.
        throw new Error(`test mode roster scrub failed: ${e?.message || e}`);
    }

    __openTestModeGate();
    return { copied: done, total: tasks.length, ms: Date.now() - started };
}
