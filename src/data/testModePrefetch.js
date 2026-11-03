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

// Copied whole (all are a few hundred docs or fewer).
export const FULL_COLLECTIONS = [
    'recurring_shifts', 'date_blocks', 'time_off', 'staffing_needs', 'schedule_templates',
    'swap_requests', 'calendar_events', 'scheduled_messages', 'announcements', 'chats', 'chat_prefs',
    'ops', 'system', 'inventory_lists', 'inventoryHistory_both', 'sauceLogHistory_webster', 'item_prices_webster', 'item_prices_maryland',
    'item_aliases_webster', 'item_aliases_maryland', 'vendor_prices', 'receipt_scans_webster',
    'receipt_scans_maryland', 'order_sessions', 'order_logs', 'toast_invoices', 'cateringOrders',
    'recipe_audits', 'build_overrides', 'custom_items', 'menu_overrides', 'tv_configs',
    'tv_holidays', 'tv_heartbeats', 'training', 'training_v2', 'training_assignments', 'training_progress',
    'training_results', 'app_tour_progress', 'staff_todos', 'assigned_tasks', 'required_tasks',
    'required_task_audits', 'task_plan', 'shift_handoffs', 'tardies', 'offsite_shifts', 'money_counts',
    'cash_tips', 'payroll_runs', 'payroll_notes', 'timecard_disputes', 'staff_archive', 'health_records',
    'insurance', 'onboarding_hires', 'onboarding_applications', 'onboarding_invites', 'onboarding_templates',
    'onboarding_signature_events', 'application_audits', 'recruiting_leads',
    'onboarding_invite_recovery_requests', 'staff_deletion_requests', 'tester_requests', 'email_intel',
    'email_intel_corrections', 'maintenanceRequests', 'maintenance_tickets', 'needs_webster', 'needs_maryland',
    'rice_log', 'pin_audits', 'staff_rename_log', 'backup_history', 'deploys', 'health_check_runs',
    'sms_delivery_logs', 'sms_inbound_events', 'sms_opt_in_events', 'pairing_codes', 'bug_reports',
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
    ['onboarding_audits', 'at', 200],
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
    'inbox_categories', 'inbox_routing_rules', 'insurance_index', 'label_format', 'label_format_brother',
    'menu_v2', 'minVersion', 'onboarding_company', 'onboarding_doc_text', 'payroll_meta', 'payroll_queued_adds',
    'payroll_roster', 'policies', 'print_bridge', 'printers_maryland_kitchen', 'printers_webster_kitchen',
    'printers_maryland_office', 'printers_webster_office', 'recipes', 'schedule_settings', 'skillsMatrix',
    'sms', 'staff', 'stations', 'sticker_lists', 'task_library_BOH', 'task_library_FOH', 'toast_maryland',
    'toast_menu_items', 'toast_webster', 'training_overrides', 'vendor_categories', 'vendor_matches',
];

// Per-chat subcollections (newest messages, plus the small side tables).
const CHAT_SUBS = [['messages', 'createdAt', 40], ['acks', null, 100], ['pins', null, 30]];

// Everything the test user needs to see the whole app as an owner.
const FULL_ACCESS = {
    opsAccess: true, recipesAccess: true, viewLabor: true, canCountMoney: true, healthAccess: true,
    canViewClockedIn: true, canViewOnboarding: true, canReceive86Alerts: true,
    canEditScheduleFOH: true, canEditScheduleBOH: true, shiftLead: true, hiddenPages: [],
};

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

    // Chat subcollections need the chat ids first.
    add(async () => {
        const chats = await getDocs(collection(db, 'chats'));
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

    // Owner view on this device only: full access flags on the test user's
    // own roster entry, written to the LOCAL cache (network is off).
    try {
        const staffRef = doc(db, 'config', 'staff');
        const snap = await getDoc(staffRef);
        const list = snap.exists() && Array.isArray(snap.data()?.list) ? snap.data().list : null;
        if (list && TEST_MODE?.name) {
            const next = list.map((s) => (s?.name === TEST_MODE.name ? { ...s, ...FULL_ACCESS, testMode: true } : s));
            // Real SDK write, never awaited — it can only ever apply locally.
            updateDoc(staffRef, { list: next }).catch(() => {});
        }
    } catch { /* access flags are a convenience; owner id already grants admin */ }

    __openTestModeGate();
    return { copied: done, total: tasks.length, ms: Date.now() - started };
}
