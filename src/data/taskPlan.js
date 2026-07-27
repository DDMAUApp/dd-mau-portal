// taskPlan — the admin Task Planner (Andrew 2026-07-27: "plan the tasks
// for the month or week … some tasks repeat everyday and some every other
// day … pull up a calendar and add or move tasks around … the managers
// still check off the tasks everyday like they do now … if it wasn't
// checked off and that task isn't everyday it should carry over").
//
// ── How it works ────────────────────────────────────────────────────────
// Rules live in /task_plan. Each rule describes ONE task + WHO gets it +
// WHEN it repeats. Every day the plan "materializes": for each rule due
// today, a REAL /assigned_tasks doc is created (deterministic id
// `plan_{ruleId}_{date}` → idempotent), so the existing kanban / My Tasks
// pages and the check-off flow need zero changes.
//
// CARRY-OVER falls out of the model: an unchecked assignment simply stays
// open on the board, and the materializer SKIPS a rule while any open
// instance of it exists — so "clean the table bases" from Tuesday keeps
// showing until someone checks it, without duplicates piling up. A daily
// task that WAS checked yesterday gets a fresh instance today.
//
// ── Firestore ───────────────────────────────────────────────────────────
//   /task_plan/{ruleId} = {
//     task:      string,                 // task text (same as library rows)
//     category:  string,                 // Operations TASK_CATEGORIES key
//     side:      'FOH' | 'BOH',
//     assignTo:  { staffId, staffName }, // who the daily instance goes to
//     recurrence: {
//       type: 'once' | 'daily' | 'everyN' | 'weekly',
//       date?:    'YYYY-MM-DD',          // once
//       anchor?:  'YYYY-MM-DD',          // daily/everyN/weekly start date
//       n?:       number,                // everyN: 2 = every other day
//       weekdays?: number[],             // weekly: 0=Sun … 6=Sat
//     },
//     extraDates: ['YYYY-MM-DD'],        // one-off additions (move target)
//     skipDates:  ['YYYY-MM-DD'],        // one-off removals (move source)
//     endDate:   'YYYY-MM-DD' | null,    // stop repeating after this day
//     active:    boolean,                // false = archived
//     createdAt, createdBy, updatedAt,
//   }
//
//   Materialized /assigned_tasks/plan_{ruleId}_{date} — normal assignment
//   fields + { planRuleId, planDate } so the planner can find its own.

import { db } from '../firebase';
import {
    collection, doc, getDoc, getDocs, onSnapshot, query, where, limit,
    addDoc, updateDoc, setDoc, deleteDoc, serverTimestamp, arrayUnion,
} from 'firebase/firestore';

// ── Date helpers (string-based, DST-safe) ──────────────────────────────
// All plan math runs on LOCAL 'YYYY-MM-DD' strings; day arithmetic goes
// through UTC-noon so a DST edge can never shift the calendar day.

export function toDateStr(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function strToUtcNoon(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0);
}

export function addDaysStr(dateStr, n) {
    const t = new Date(strToUtcNoon(dateStr) + n * 86400000);
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

// Whole days from a → b (positive when b is later).
export function dayDiff(aStr, bStr) {
    return Math.round((strToUtcNoon(bStr) - strToUtcNoon(aStr)) / 86400000);
}

export function weekdayOf(dateStr) {
    return new Date(strToUtcNoon(dateStr)).getUTCDay(); // 0=Sun … 6=Sat
}

// ── The resolver (pure, unit-tested) ───────────────────────────────────
export function isRuleDueOn(rule, dateStr) {
    if (!rule || rule.active === false || !dateStr) return false;
    if (Array.isArray(rule.skipDates) && rule.skipDates.includes(dateStr)) return false;
    if (Array.isArray(rule.extraDates) && rule.extraDates.includes(dateStr)) return true;
    if (rule.endDate && dateStr > rule.endDate) return false;
    const r = rule.recurrence || {};
    switch (r.type) {
        case 'once':
            return r.date === dateStr;
        case 'daily':
            return !r.anchor || dateStr >= r.anchor;
        case 'everyN': {
            if (!r.anchor || dateStr < r.anchor) return false;
            const n = Math.max(2, Math.min(60, Math.floor(Number(r.n) || 2)));
            return dayDiff(r.anchor, dateStr) % n === 0;
        }
        case 'weekly': {
            if (r.anchor && dateStr < r.anchor) return false;
            return Array.isArray(r.weekdays) && r.weekdays.includes(weekdayOf(dateStr));
        }
        default:
            return false;
    }
}

// All rules due on a date (planner calendar cells).
export function rulesDueOn(rules, dateStr) {
    return (rules || []).filter(r => isRuleDueOn(r, dateStr));
}

// ── Rule CRUD ──────────────────────────────────────────────────────────

export function subscribeTaskPlan(callback) {
    if (typeof callback !== 'function') return () => {};
    const q = query(collection(db, 'task_plan'), limit(300));
    return onSnapshot(q, (snap) => {
        const out = [];
        snap.forEach(d => out.push({ id: d.id, ...(d.data() || {}) }));
        out.sort((a, b) => (a.task || '').localeCompare(b.task || ''));
        callback(out);
    }, (err) => {
        console.warn('subscribeTaskPlan failed:', err);
        callback([]);
    });
}

export async function createTaskPlanRule({
    task, category = 'other', side, assignTo, recurrence, endDate = null, createdBy,
}) {
    const text = String(task || '').trim();
    if (!text) throw new Error('task text required');
    if (side !== 'FOH' && side !== 'BOH') throw new Error('side required');
    if (!assignTo?.staffName) throw new Error('assignee required');
    const ref = await addDoc(collection(db, 'task_plan'), {
        task: text.slice(0, 200),
        category: String(category || 'other').trim() || 'other',
        side,
        assignTo: { staffId: assignTo.staffId ?? null, staffName: assignTo.staffName },
        recurrence: recurrence || { type: 'once', date: toDateStr() },
        extraDates: [],
        skipDates: [],
        endDate: endDate || null,
        active: true,
        createdAt: serverTimestamp(),
        createdBy: createdBy || 'admin',
        updatedAt: serverTimestamp(),
    });
    return ref.id;
}

export async function updateTaskPlanRule(ruleId, patch) {
    if (!ruleId || !patch) return;
    await updateDoc(doc(db, 'task_plan', ruleId), { ...patch, updatedAt: serverTimestamp() });
}

export async function archiveTaskPlanRule(ruleId) {
    if (!ruleId) return;
    await updateDoc(doc(db, 'task_plan', ruleId), { active: false, updatedAt: serverTimestamp() });
}

export async function deleteTaskPlanRule(ruleId) {
    if (!ruleId) return;
    await deleteDoc(doc(db, 'task_plan', ruleId));
}

// Skip one occurrence of a recurring rule (calendar "skip this day").
export async function skipOccurrence(ruleId, dateStr) {
    if (!ruleId || !dateStr) return;
    await updateDoc(doc(db, 'task_plan', ruleId), {
        skipDates: arrayUnion(dateStr), updatedAt: serverTimestamp(),
    });
}

// Move one occurrence to another day. A 'once' rule just changes its
// date; a recurring rule skips the source day and adds the target as an
// extra date — the series itself is untouched (exactly the "clean the
// table bases on Tuesday, again 2 weeks later on a Wednesday" flow).
export async function moveOccurrence(rule, fromDate, toDate) {
    if (!rule?.id || !fromDate || !toDate || fromDate === toDate) return;
    if (rule.recurrence?.type === 'once' && !(rule.extraDates || []).includes(fromDate)) {
        await updateDoc(doc(db, 'task_plan', rule.id), {
            recurrence: { ...rule.recurrence, date: toDate }, updatedAt: serverTimestamp(),
        });
        return;
    }
    await updateDoc(doc(db, 'task_plan', rule.id), {
        skipDates: arrayUnion(fromDate),
        extraDates: arrayUnion(toDate),
        updatedAt: serverTimestamp(),
    });
}

// ── Materializer ───────────────────────────────────────────────────────
// Turn today's due rules into real /assigned_tasks docs. Idempotent +
// carry-over aware:
//   • deterministic id plan_{ruleId}_{date} → re-runs can't duplicate
//   • a rule with ANY open instance (any date) is skipped → the old
//     open task IS today's task (carry-over), no pile-up
//   • a rule whose today-instance already exists (even if already
//     checked off) is skipped → a later run can't resurrect a done task
// Runs from the kanban + planner mounts; several devices racing is safe
// (same deterministic ids). Throttled to once per (day, side) per session.
const _materializedFor = new Set();
export async function ensureMaterializedForToday(side, byName) {
    const dateStr = toDateStr();
    const throttleKey = `${dateStr}|${side || 'ALL'}`;
    if (_materializedFor.has(throttleKey)) return { created: 0, skipped: true };
    _materializedFor.add(throttleKey);
    try {
        const rulesSnap = await getDocs(query(collection(db, 'task_plan'), limit(300)));
        const rules = [];
        rulesSnap.forEach(d => rules.push({ id: d.id, ...(d.data() || {}) }));
        const due = rules.filter(r =>
            (!side || r.side === side) && isRuleDueOn(r, dateStr));
        if (due.length === 0) return { created: 0 };

        // Open instances (carry-over check) + today's instances (done-today
        // guard). Two bounded one-shot reads.
        const [openSnap, todaySnap] = await Promise.all([
            getDocs(query(collection(db, 'assigned_tasks'), where('done', '==', false), limit(500))),
            getDocs(query(collection(db, 'assigned_tasks'), where('planDate', '==', dateStr), limit(300))),
        ]);
        const openRuleIds = new Set();
        openSnap.forEach(d => { const r = d.data()?.planRuleId; if (r) openRuleIds.add(r); });
        const todayRuleIds = new Set();
        todaySnap.forEach(d => { const r = d.data()?.planRuleId; if (r) todayRuleIds.add(r); });

        let created = 0;
        for (const rule of due) {
            if (openRuleIds.has(rule.id)) continue;   // carry-over: still open
            if (todayRuleIds.has(rule.id)) continue;  // already made (maybe done)
            const ref = doc(db, 'assigned_tasks', `plan_${rule.id}_${dateStr}`);
            await setDoc(ref, {
                staffId: rule.assignTo?.staffId ?? null,
                staffName: rule.assignTo?.staffName || '',
                side: rule.side,
                task: rule.task,
                category: rule.category || 'other',
                assignedBy: '🗓 Planner',
                assignedById: null,
                assignedAt: serverTimestamp(),
                done: false,
                doneAt: null,
                doneBy: null,
                planRuleId: rule.id,
                planDate: dateStr,
                materializedBy: byName || null,
            });
            created++;
        }
        return { created };
    } catch (e) {
        // Allow a retry later in the session if this run failed.
        _materializedFor.delete(throttleKey);
        console.warn('ensureMaterializedForToday failed:', e);
        return { created: 0, error: e?.message };
    }
}

// ── Day sheet: the Daily Ops checklist for a day ───────────────────────
// (Andrew 2026-07-27: "the list i want to see is the one in the daily
// operations, tasks tab" — with a FOH/BOH toggle.) That list lives at
// /ops/checklists2_{location} (customTasks.{side}.all + checks map that
// resets each morning); past days are archived by the rollover to
// /checklistHistory_{location}/{YYYY-MM-DD}. This mirrors the Tasks tab's
// read model: primary list (bare check ids), per-task recurrence
// (daily / weekdays / Mondays…) matched on the business day-of-week,
// subtasks all-checked + required photo = done.

const CHECKLIST_RECUR = {
    daily:     () => true,
    weekday:   w => w >= 1 && w <= 5,
    weekend:   w => w === 0 || w === 6,
    monday:    w => w === 1,
    tuesday:   w => w === 2,
    wednesday: w => w === 3,
    thursday:  w => w === 4,
    friday:    w => w === 5,
    saturday:  w => w === 6,
    sunday:    w => w === 0,
};

// Pure (unit-tested): flatten one side's checklist for a given day with
// done state. Handles the legacy morning/afternoon shape history docs
// may still carry (live docs were migrated to a single `all` period).
export function checklistTasksForDay(customTasks, checks, side, dateStr) {
    const s = customTasks?.[side] || {};
    const all = s.all || [...(s.morning || []), ...(s.afternoon || [])];
    const w = weekdayOf(dateStr);
    const ch = checks || {};
    return all
        .filter(t => (CHECKLIST_RECUR[t?.recurrence || 'daily'] || CHECKLIST_RECUR.daily)(w))
        .map(t => {
            const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
            let done = subs.length > 0 ? subs.every(x => !!ch[x.id]) : !!ch[t.id];
            if (t.requirePhoto && !ch[t.id + '_photo']) done = false;
            const subsDone = subs.filter(x => !!ch[x.id]).length;
            return {
                id: t.id, task: t.task, category: t.category || 'other',
                done, subCount: subs.length, subsDone,
            };
        });
}

// One-shot fetch of the checklist doc + check state for a tapped day.
// Today → live doc (checks only count if the doc has rolled to today);
// future → live doc, unchecked (the list resets each morning);
// past → the archived history row ({missing:true} if none was saved).
export async function fetchOpsChecklistDay(location, dateStr) {
    const todayStr = toDateStr();
    if (dateStr < todayStr) {
        const snap = await getDoc(doc(db, 'checklistHistory_' + location, dateStr));
        if (!snap.exists()) return { missing: true };
        const d = snap.data() || {};
        return { customTasks: d.customTasks || {}, checks: d.checks || {} };
    }
    const snap = await getDoc(doc(db, 'ops', 'checklists2_' + location));
    const d = snap.exists() ? (snap.data() || {}) : {};
    const checks = (dateStr === todayStr && d.date === dateStr) ? (d.checks || {}) : {};
    return { customTasks: d.customTasks || {}, checks };
}
