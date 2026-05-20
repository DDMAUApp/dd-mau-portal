// Required-task framework.
//
// Each staff has a queue of "required tasks" living in
// /required_tasks/{id}. On login the app-shell checks the queue;
// if non-empty AND any task has blockApp=true, the normal home page
// is replaced by a full-screen flow that walks the staffer through
// each blocking task in turn. Soft tasks (blockApp=false) show as
// dismissible banners on the home tab.
//
// First two task types: sms_optin (Phase 4 anchor) + availability.
// Adding more task types later = drop a new entry into TASK_TYPES +
// a new React component. No core changes needed.
//
// Andrew 2026-05-19 — "as soon as they log in they have to fill out
// their availability... or I want to pick one, three, or all staff
// to opt in to our notifications."
//
// ── Data model ───────────────────────────────────────────────────
// /required_tasks/{id}
//   forStaff: 'Andrea Frias'
//   staffId: 50
//   taskType: 'sms_optin' | 'availability' | ...
//   status: 'pending' | 'completed' | 'skipped' | 'declined'
//   createdAt, createdBy
//   completedAt, completedSnapshot (JSON: what they chose)
//   dueBy: null | Timestamp
//   blockApp: true (hard gate) | false (soft banner)
//   allowSkip: false (default)
//   priority: 1 (lower = earlier in queue)
//   language: 'en' | 'es' | null (uses staff.preferredLanguage)
//   payload: { ... }                  task-specific data
//   campaignId: 'sms-optin-2026-05'   groups admin pushes
//
// /required_task_audits/{id}
//   taskId, action: 'created' | 'completed' | 'skipped' | 'declined' | 'cancelled'
//   byName, at, snapshot

import { db } from '../firebase';
import {
    collection, doc, addDoc, getDoc, getDocs, updateDoc,
    query, where, orderBy, limit, serverTimestamp, writeBatch,
} from 'firebase/firestore';

// ── Task type registry ─────────────────────────────────────────────
// Each task type knows its own labels, default options, and the
// `autoComplete(staff, task)` predicate the app-shell can call to
// auto-resolve the task when the prerequisite data shows up
// elsewhere in the app (e.g. availability gets filled via the
// Schedule tab → the task should close itself).
//
// The actual React component for each type is lazy-loaded in
// RequiredTaskFlow.jsx — keeping the runtime decoupled means new
// task types can be added without bloating the framework bundle.
export const TASK_TYPES = {
    sms_optin: {
        labelEn: 'Get urgent text alerts',
        labelEs: 'Recibir alertas urgentes',
        icon: '📱',
        defaultBlockApp: true,
        defaultAllowSkip: false,
        // Auto-resolves when staff has answered either way — both
        // smsOptIn=true AND smsOptIn=false (with an opt-in event)
        // count as "they made a choice".
        autoComplete: (staff) => {
            if (!staff) return false;
            return staff.smsOptIn === true || staff.smsOptIn === false;
        },
        // Display when staff sees the task in the queue.
        descriptionEn: 'Decide if DD Mau can text you for shift reminders, coverage requests, weather closures, and other urgent things.',
        descriptionEs: 'Decide si DD Mau puede enviarte SMS para recordatorios de turno, coberturas, cierres por clima y otras cosas urgentes.',
    },
    availability: {
        labelEn: 'Set your weekly availability',
        labelEs: 'Define tu disponibilidad semanal',
        icon: '📅',
        defaultBlockApp: true,
        defaultAllowSkip: false,
        // Auto-resolves once staff.availability has at least one
        // day with at least one usable window. Empty objects /
        // empty arrays count as "still pending".
        autoComplete: (staff) => {
            if (!staff || !staff.availability) return false;
            const av = staff.availability;
            if (typeof av !== 'object') return false;
            for (const day of Object.keys(av)) {
                const slots = av[day];
                if (Array.isArray(slots) && slots.length > 0) return true;
                if (slots && typeof slots === 'object' && (slots.start || slots.end || slots.allDay)) return true;
            }
            return false;
        },
        descriptionEn: 'Tell us which days and hours you can work. Managers use this to build the schedule.',
        descriptionEs: 'Dinos qué días y horas puedes trabajar. Los gerentes usan esto para hacer el horario.',
    },
    install_pwa: {
        labelEn: 'Add DD Mau to your home screen',
        labelEs: 'Agrega DD Mau a tu pantalla de inicio',
        icon: '📲',
        defaultBlockApp: true,
        defaultAllowSkip: false,
        // Auto-resolves once staff.pwaInstalled is true. App.jsx
        // writes that flag on every cold-start when running in
        // standalone display mode — so any staffer who has the app
        // on their home screen on ANY of their devices has the flag
        // set, and the gate closes.
        //
        // Why this task exists: on iPhone, web push notifications
        // ONLY work when the app is installed to the home screen.
        // Plain-Safari iPhone users get zero notifications. Forcing
        // installation closes that gap. (Andrew 2026-05-19 — "the
        // whole point was to enable notifications to staff without
        // the app installed".)
        autoComplete: (staff) => {
            if (!staff) return false;
            return staff.pwaInstalled === true;
        },
        descriptionEn: 'On iPhone, notifications only work when the app is added to your home screen. Takes 30 seconds.',
        descriptionEs: 'En iPhone, las notificaciones solo funcionan al agregar la app a tu pantalla. Toma 30 segundos.',
    },
};

// All known task types — useful for the admin picker.
export const TASK_TYPE_IDS = Object.keys(TASK_TYPES);

// Status enum — strings, kept stable; never change values without
// migrating existing /required_tasks rows.
export const TASK_STATUS = {
    PENDING: 'pending',
    COMPLETED: 'completed',
    SKIPPED: 'skipped',
    DECLINED: 'declined',
    CANCELLED: 'cancelled',
};

// ── Query helpers ──────────────────────────────────────────────────

// Pending tasks for a specific staff, sorted by priority. Used by
// the app-shell interceptor to decide whether to show the flow.
export async function fetchPendingTasksFor(staffName) {
    if (!staffName) return [];
    try {
        const snap = await getDocs(query(
            collection(db, 'required_tasks'),
            where('forStaff', '==', staffName),
            where('status', '==', TASK_STATUS.PENDING),
        ));
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Sort client-side: lower priority first, then oldest first.
        list.sort((a, b) => {
            const ap = a.priority ?? 100;
            const bp = b.priority ?? 100;
            if (ap !== bp) return ap - bp;
            const at = a.createdAt?.toMillis?.() ?? 0;
            const bt = b.createdAt?.toMillis?.() ?? 0;
            return at - bt;
        });
        return list;
    } catch (e) {
        console.warn('fetchPendingTasksFor failed:', e);
        return [];
    }
}

// All tasks (any status) for a campaign — used by the admin tracker.
export async function fetchTasksForCampaign(campaignId) {
    if (!campaignId) return [];
    try {
        const snap = await getDocs(query(
            collection(db, 'required_tasks'),
            where('campaignId', '==', campaignId),
            orderBy('createdAt', 'desc'),
        ));
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.warn('fetchTasksForCampaign failed:', e);
        return [];
    }
}

// ── Create / update operations ─────────────────────────────────────

// Push one task type to many recipients. Each recipient gets their
// own task doc; all docs share a campaignId so the admin can track
// completion. Skip recipients that already have a PENDING task of
// the same type (avoid double-push noise).
export async function createTaskCampaign({
    taskType,
    recipients,            // [{ name, id }]
    createdBy,
    payload = {},
    dueBy = null,
    blockApp = null,        // null → use TASK_TYPES default
    allowSkip = null,
    language = null,
    note = null,
}) {
    if (!TASK_TYPES[taskType]) throw new Error(`Unknown task type: ${taskType}`);
    if (!Array.isArray(recipients) || recipients.length === 0) return { campaignId: null, created: 0, skipped: 0 };

    const type = TASK_TYPES[taskType];
    const effectiveBlockApp = blockApp == null ? type.defaultBlockApp : blockApp;
    const effectiveAllowSkip = allowSkip == null ? type.defaultAllowSkip : allowSkip;
    const campaignId = `${taskType}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 7)}`;

    // Filter out recipients who already have a pending task of this
    // type — we don't double-push. (If admin wants to re-push, they
    // should cancel the pending one first.)
    const existing = await getDocs(query(
        collection(db, 'required_tasks'),
        where('taskType', '==', taskType),
        where('status', '==', TASK_STATUS.PENDING),
    ));
    const alreadyPending = new Set(existing.docs.map(d => d.data().forStaff));

    const toCreate = recipients.filter(r => r && r.name && !alreadyPending.has(r.name));
    const skippedCount = recipients.length - toCreate.length;

    // Batched write — much cheaper than N round-trips.
    const batch = writeBatch(db);
    const colRef = collection(db, 'required_tasks');
    for (const r of toCreate) {
        const ref = doc(colRef);
        batch.set(ref, {
            forStaff: r.name,
            staffId: r.id ?? null,
            taskType,
            status: TASK_STATUS.PENDING,
            createdAt: serverTimestamp(),
            createdBy: createdBy || 'admin',
            completedAt: null,
            completedSnapshot: null,
            dueBy: dueBy || null,
            blockApp: !!effectiveBlockApp,
            allowSkip: !!effectiveAllowSkip,
            priority: 10,
            language: language || null,
            payload: payload || {},
            campaignId,
        });
    }
    await batch.commit();

    // Audit one row per created task. Fire-and-forget so a logging
    // hiccup never blocks the campaign push.
    Promise.all(toCreate.map(r => addDoc(collection(db, 'required_task_audits'), {
        taskType,
        forStaff: r.name,
        staffId: r.id ?? null,
        action: 'created',
        byName: createdBy || 'admin',
        campaignId,
        at: serverTimestamp(),
        note,
    }).catch(e => console.warn('required_task_audits write failed:', e))));

    return { campaignId, created: toCreate.length, skipped: skippedCount };
}

// Mark a task complete with a snapshot of what the user chose.
// Called by each task-type component after the user completes
// their action (e.g. TaskSmsOptIn writes opt-in/out + closes).
export async function completeTask(taskId, { snapshot = null, byName = null } = {}) {
    if (!taskId) return false;
    try {
        const ref = doc(db, 'required_tasks', taskId);
        await updateDoc(ref, {
            status: TASK_STATUS.COMPLETED,
            completedAt: serverTimestamp(),
            completedSnapshot: snapshot || null,
        });
        addDoc(collection(db, 'required_task_audits'), {
            taskId,
            action: 'completed',
            byName: byName || 'self',
            snapshot: snapshot || null,
            at: serverTimestamp(),
        }).catch(e => console.warn('required_task_audits completed write failed:', e));
        return true;
    } catch (e) {
        console.error('completeTask failed:', e);
        return false;
    }
}

// Skip a task (only allowed if task.allowSkip === true). The skip
// is recorded but the task is considered done.
export async function skipTask(taskId, { byName = null } = {}) {
    if (!taskId) return false;
    try {
        const ref = doc(db, 'required_tasks', taskId);
        await updateDoc(ref, {
            status: TASK_STATUS.SKIPPED,
            completedAt: serverTimestamp(),
        });
        addDoc(collection(db, 'required_task_audits'), {
            taskId,
            action: 'skipped',
            byName: byName || 'self',
            at: serverTimestamp(),
        }).catch(() => {});
        return true;
    } catch (e) {
        console.error('skipTask failed:', e);
        return false;
    }
}

// Admin can cancel a pending task (e.g. they pushed it by mistake,
// or the recipient already completed the underlying action via a
// different path). Cancellation is permanent — admin pushes a new
// task if they want the gate back.
export async function cancelTask(taskId, { byName = null } = {}) {
    if (!taskId) return false;
    try {
        const ref = doc(db, 'required_tasks', taskId);
        await updateDoc(ref, {
            status: TASK_STATUS.CANCELLED,
            completedAt: serverTimestamp(),
        });
        addDoc(collection(db, 'required_task_audits'), {
            taskId,
            action: 'cancelled',
            byName: byName || 'admin',
            at: serverTimestamp(),
        }).catch(() => {});
        return true;
    } catch (e) {
        console.error('cancelTask failed:', e);
        return false;
    }
}

// Resolve any pending tasks whose autoComplete predicate now passes
// for the given staff. Called by the app-shell interceptor before
// it decides whether to show the flow — saves the staffer from
// staring at a "set your availability" gate after they just set it
// somewhere else.
export async function autoResolveTasksFor(staff) {
    if (!staff || !staff.name) return 0;
    const pending = await fetchPendingTasksFor(staff.name);
    let resolved = 0;
    for (const task of pending) {
        const type = TASK_TYPES[task.taskType];
        if (!type || typeof type.autoComplete !== 'function') continue;
        try {
            if (type.autoComplete(staff, task)) {
                await completeTask(task.id, {
                    byName: 'auto',
                    snapshot: { reason: 'autoComplete predicate matched' },
                });
                resolved++;
            }
        } catch (e) {
            console.warn(`autoResolveTasksFor: ${task.taskType} for ${staff.name} threw`, e);
        }
    }
    return resolved;
}
