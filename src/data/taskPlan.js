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

import { taskDueOnDay, normalizeRecurDays, normalizeRecurDates, cleanRecurrenceFields, normalizeAssignDays } from './checklistRecurrence';
import { db } from '../firebase';
import {
    collection, doc, onSnapshot, query, where, limit, serverTimestamp, arrayUnion, getDoc as _fsGetDoc, getDocs as _fsGetDocs, addDoc as _fsAddDoc, updateDoc as _fsUpdateDoc, setDoc as _fsSetDoc, deleteDoc as _fsDeleteDoc, runTransaction as _fsRunTransaction,
} from 'firebase/firestore';
// 2026-09-02 whole-app audit -- watchdog shadows (house pattern A):
// user-pressed saves in this file ran raw and hung forever on a wedged
// transport (no pill, no revive, no escalation). Zero call-site changes.
import { watchdogWrite, watchdogRead } from './firestoreRevive';
const getDoc = (...a) => watchdogRead(_fsGetDoc(...a));
const getDocs = (...a) => watchdogRead(_fsGetDocs(...a));
const addDoc = (...a) => watchdogWrite(_fsAddDoc(...a));
const updateDoc = (...a) => watchdogWrite(_fsUpdateDoc(...a));
const setDoc = (...a) => watchdogWrite(_fsSetDoc(...a));
const deleteDoc = (...a) => watchdogWrite(_fsDeleteDoc(...a));
const runTransaction = (...a) => watchdogWrite(_fsRunTransaction(...a));

// ── Date helpers (string-based, DST-safe) ──────────────────────────────
// All plan math runs on LOCAL 'YYYY-MM-DD' strings; day arithmetic goes
// through UTC-noon so a DST edge can never shift the calendar day.

// "Today" is the BUSINESS day (America/Chicago), not the device's day —
// the whole checklist system is Chicago-anchored (see Operations.jsx
// getTodayKey/getBusinessDow, added because Andrew's phone runs in HKT).
// Device-local dates here made a phone abroad materialize tomorrow's
// rules a business-day early and mis-classify the DaySheet's "today".
const _chiDateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function toDateStr(d = new Date()) {
    return _chiDateFmt.format(d); // en-CA emits YYYY-MM-DD
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
    // Assignee is OPTIONAL (Andrew 2026-07-27: "add a task and not assign
    // to a staff like the main list") — null assignTo materializes as an
    // unassigned board task anyone can pick up. Normalize BOTH caller
    // shapes ({staffId,staffName} and the UI's {id,name}) — the DaySheet
    // was passing {id,name}, which this validation used to reject, so
    // every planner add silently failed with "assignee required".
    const who = assignTo
        ? { staffId: assignTo.staffId ?? assignTo.id ?? null, staffName: assignTo.staffName || assignTo.name || '' }
        : null;
    if (who && !who.staffName) throw new Error('assignee name missing');
    const ref = await addDoc(collection(db, 'task_plan'), {
        task: text.slice(0, 200),
        category: String(category || 'other').trim() || 'other',
        side,
        assignTo: who,
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
    // 2026-07-27 audit R1: plain arrayUnions only ever GREW the arrays, and
    // skipDates wins over extraDates in isRuleDueOn — so moving Tue→Wed→Tue
    // left BOTH days in skipDates and the occurrence vanished entirely.
    // Read the live doc and write COMPUTED arrays instead: the day we land
    // on leaves skipDates, the day we leave stops being an extra.
    const ref = doc(db, 'task_plan', rule.id);
    const snap = await getDoc(ref);
    const cur = (snap?.exists?.() ? snap.data() : null) || rule;
    const skips = new Set(Array.isArray(cur.skipDates) ? cur.skipDates : []);
    const extras = new Set(Array.isArray(cur.extraDates) ? cur.extraDates : []);
    skips.add(fromDate);
    skips.delete(toDate);
    extras.add(toDate);
    extras.delete(fromDate);
    await updateDoc(ref, {
        skipDates: [...skips].sort(),
        extraDates: [...extras].sort(),
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
// `force: true` bypasses that throttle (2026-07-30): the planner's "⚡
// Generate today now" button EXISTS to run the materializer on demand, but
// AssignTasksPanel's Tasks-page mount had already claimed today's keys, so
// the button short-circuited to { created: 0, skipped: true } and the UI
// cheerfully reported "Today is already up to date" while the task the
// admin had just planned never materialized. A forced run still records the
// key, so passive mount calls stay throttled.
const _materializedFor = new Set();
export async function ensureMaterializedForToday(side, byName, { force = false } = {}) {
    const dateStr = toDateStr();
    const throttleKey = `${dateStr}|${side || 'ALL'}`;
    if (!force && _materializedFor.has(throttleKey)) return { created: 0, skipped: true };
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

// (Matcher lives in src/data/checklistRecurrence.js — shared with the
// Tasks page so both agree on 'days' / 'dates' custom sets.)

// Pure (unit-tested): flatten one side's checklist for a given day with
// done state. Handles the legacy morning/afternoon shape history docs
// may still carry (live docs were migrated to a single `all` period).
export function checklistTasksForDay(customTasks, checks, side, dateStr) {
    const s = customTasks?.[side] || {};
    const all = s.all || [...(s.morning || []), ...(s.afternoon || [])];
    const w = weekdayOf(dateStr);
    const ch = checks || {};
    return all
        .filter(t => taskDueOnDay(t, w, dateStr))
        .map(t => {
            const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
            let done = subs.length > 0 ? subs.every(x => !!ch[x.id]) : !!ch[t.id];
            if (t.requirePhoto && !ch[t.id + '_photo']) done = false;
            const subsDone = subs.filter(x => !!ch[x.id]).length;
            return {
                id: t.id, task: t.task, category: t.category || 'other',
                recurrence: t.recurrence || 'daily',
                recurDays: normalizeRecurDays(t.recurDays),
                recurDates: normalizeRecurDates(t.recurDates),
                // 2026-07-29: pass through so the DaySheet's inline row
                // editors can show/edit who + by-when (Operations already
                // renders + alarms on both fields).
                assignTo: Array.isArray(t.assignTo) ? t.assignTo : (t.assignTo ? [t.assignTo] : []),
                assignDays: (t.assignDays && typeof t.assignDays === 'object') ? t.assignDays : {},
                completeBy: typeof t.completeBy === 'string' ? t.completeBy : '',
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

// ── Edit the Daily Ops checklist from the planner ──────────────────────
// (Andrew 2026-07-27: "click on the daily op list from the task planner
// and that also pops up a menu that can edit the tasks.") Writes go
// through a TRANSACTION that rewrites ONLY the one period array that
// contains the task (dot-path field update) — never the whole doc, per
// the 2026-07-14 checklists2 clobber lesson. Searches both the migrated
// `all` array and the legacy morning/afternoon arrays.
async function _editOpsChecklistTask(location, taskId, mutate) {
    if (!location || !taskId) throw new Error('missing location/taskId');
    const ref = doc(db, 'ops', 'checklists2_' + location);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('checklist not found');
        const customTasks = snap.data()?.customTasks || {};
        for (const side of ['FOH', 'BOH']) {
            for (const period of ['all', 'morning', 'afternoon']) {
                const arr = customTasks?.[side]?.[period];
                if (!Array.isArray(arr)) continue;
                const idx = arr.findIndex(t => t?.id === taskId);
                if (idx === -1) continue;
                const next = mutate === null
                    ? arr.filter(t => t?.id !== taskId)
                    : arr.map(t => (t?.id === taskId ? mutate(t) : t));
                const patch = {
                    [`customTasks.${side}.${period}`]: next,
                    updatedAt: new Date().toISOString(),
                };
                if (mutate === null) {
                    // Deleting: also purge the task's check keys across EVERY
                    // list prefix ({side}_L{n}_{id}, bare {id}, and the _by/_at/
                    // _photo/_followUp suffixes + subtask ids) so the doc doesn't
                    // accumulate orphans. Safe as a whole-map rewrite ONLY
                    // because we're inside the transaction (retries on conflict).
                    const old = arr[idx] || {};
                    const ids = [taskId, ...(Array.isArray(old.subtasks) ? old.subtasks.map(s => s?.id).filter(Boolean) : [])];
                    const checks = snap.data()?.checks || {};
                    const cleaned = {};
                    for (const [k, v] of Object.entries(checks)) {
                        if (!ids.some(id => k === id || k.endsWith('_' + id) || k.includes(id + '_'))) cleaned[k] = v;
                    }
                    if (Object.keys(cleaned).length !== Object.keys(checks).length) patch.checks = cleaned;
                }
                tx.update(ref, patch);
                return;
            }
        }
        throw new Error('task not found');
    });
}

export async function updateOpsChecklistTask(location, taskId, patch) {
    const clean = {};
    if (typeof patch?.task === 'string' && patch.task.trim()) clean.task = patch.task.trim().slice(0, 300);
    if (typeof patch?.recurrence === 'string') clean.recurrence = patch.recurrence;
    // 2026-08-19: custom sets travel with their id (cleanRecurrenceFields
    // below drops whichever companion doesn't match the saved recurrence).
    if (patch && 'recurDays' in patch) clean.recurDays = normalizeRecurDays(patch.recurDays);
    if (patch && 'recurDates' in patch) clean.recurDates = normalizeRecurDates(patch.recurDates).slice(0, 120);
    // 2026-07-29: inline row editors also write who + by-when. Empty/null
    // means REMOVE the field — the mutate spread can't delete keys, so
    // removals are tracked separately and dropped from the next object.
    let dropAssign = false, dropTime = false;
    if (patch && 'assignTo' in patch) {
        const names = Array.isArray(patch.assignTo)
            ? patch.assignTo.map(x => String(x || '').trim()).filter(Boolean).slice(0, 6).map(s => s.slice(0, 40))
            : [];
        if (names.length) clean.assignTo = names; else dropAssign = true;
    }
    let assignDaysPatch = null;   // sanitized against the FINAL assignTo inside mutate
    if (patch && 'assignDays' in patch) assignDaysPatch = patch.assignDays || {};
    if (patch && 'completeBy' in patch) {
        const v = typeof patch.completeBy === 'string' ? patch.completeBy.trim() : '';
        if (/^\d{2}:\d{2}$/.test(v)) clean.completeBy = v; else dropTime = true;
    }
    if (Object.keys(clean).length === 0 && !dropAssign && !dropTime && assignDaysPatch === null) return;
    await _editOpsChecklistTask(location, taskId, t => {
        let next = { ...t, ...clean };
        if (dropAssign) delete next.assignTo;
        if (dropTime) delete next.completeBy;
        if ('recurrence' in clean || 'recurDays' in clean || 'recurDates' in clean) next = cleanRecurrenceFields(next);
        // Per-person day schedules: sanitize against the FINAL assignee list
        // (an explicit patch replaces the map; an assignTo change alone
        // prunes the existing one).
        const finalAssign = Array.isArray(next.assignTo) ? next.assignTo : [];
        const source = assignDaysPatch !== null ? assignDaysPatch : next.assignDays;
        const cleanedDays = normalizeAssignDays(source, finalAssign);
        if (Object.keys(cleanedDays).length > 0) next.assignDays = cleanedDays; else delete next.assignDays;
        return next;
    });
}

// Pure (unit-tested) array math for drag-reorder: pull `id` out and put it
// back in front of `beforeId` (null / absent anchor = push to the END).
// Returns a NEW array, or null when `id` isn't in the array.
export function moveInArray(arr, id, beforeId) {
    const list = Array.isArray(arr) ? arr : [];
    const from = list.findIndex(t => t?.id === id);
    if (from === -1) return null;
    const moved = list[from];
    const rest = list.filter((_, i) => i !== from);
    const at = beforeId == null ? -1 : rest.findIndex(t => t?.id === beforeId);
    if (at === -1) rest.push(moved); else rest.splice(at, 0, moved);
    return rest;
}

// 2026-07-29: drag-to-reorder from the planner DaySheet. Same transaction
// discipline as _editOpsChecklistTask — find the ONE period array holding
// taskId and rewrite only that dot-path. Array order is meaningful (the
// Operations edit mode has ▲▼ reorder), and the before-anchor semantics
// stay correct even when the caller's visible list is day-filtered.
export async function moveOpsChecklistTask(location, taskId, beforeTaskId = null) {
    if (!location || !taskId) throw new Error('missing location/taskId');
    const ref = doc(db, 'ops', 'checklists2_' + location);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('checklist not found');
        const customTasks = snap.data()?.customTasks || {};
        for (const side of ['FOH', 'BOH']) {
            for (const period of ['all', 'morning', 'afternoon']) {
                const next = moveInArray(customTasks?.[side]?.[period], taskId, beforeTaskId);
                if (!next) continue;
                tx.update(ref, {
                    [`customTasks.${side}.${period}`]: next,
                    updatedAt: new Date().toISOString(),
                });
                return;
            }
        }
        throw new Error('task not found');
    });
}

export async function deleteOpsChecklistTask(location, taskId) {
    await _editOpsChecklistTask(location, taskId, null);
}

// ── Per-task transactional writers for the Operations Tasks tab ─────────
// (2026-08-25 audit.) Operations' nine checklist writers used to rewrite
// the WHOLE customTasks.<side>.all array from a local ref snapshot
// (writeChecklistPatch), so two devices editing different tasks in the
// same window were last-writer-wins — one edit silently vanished. These
// three helpers replace that path with transactions on the LIVE
// ops/checklists2_{loc} doc that touch exactly one (or two, for the
// swap) tasks, located BY ID — array indexes go stale under concurrent
// reorders.
//
// History mirror: writeChecklistPatch dual-wrote the side array to
// checklistHistory_<loc>/<todayKey>, and fetchOpsChecklistDay +
// ChecklistHistory read those rows — so every helper mirrors the final
// side array there too. The mirror is a nested tx.set(..., {merge:true})
// (merge only touches customTasks.<side>.<period>), which works whether
// or not today's history doc exists yet. The old path's date/version
// stamps are intentionally dropped — rollover owns `date`.

// Shared: apply mutateFn to the task with `taskId` inside `arr`.
// Returns the new array, or null when the task isn't there.
// mutateFn(liveTask) → replacement task; returning null deletes it.
function _applyTaskMutation(arr, taskId, mutateFn) {
    if (!Array.isArray(arr)) return null;
    if (!arr.some(t => t?.id === taskId)) return null;
    const out = [];
    for (const t of arr) {
        if (t?.id !== taskId) { out.push(t); continue; }
        const next = mutateFn(t);
        if (next != null) out.push(next);
    }
    return out;
}

// Generic single-task mutation. `side` scopes the search (the caller
// always knows it); within the side the task is looked up across the
// migrated `all` array and the legacy morning/afternoon arrays, same as
// _editOpsChecklistTask. `fallbackSideArr` (optional): when the live doc
// doesn't exist yet (fresh location), seed it from the caller's local
// side array with the mutation applied — the create-branch equivalent of
// writeChecklistPatch's setDoc-merge fallback.
export async function mutateOpsChecklistTask(location, side, taskId, mutateFn, { fallbackSideArr } = {}) {
    if (!location || !side || !taskId || typeof mutateFn !== 'function') {
        throw new Error('missing location/side/taskId/mutateFn');
    }
    const liveRef = doc(db, 'ops', 'checklists2_' + location);
    const histRef = doc(db, 'checklistHistory_' + location, toDateStr());
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(liveRef);
        const nowIso = new Date().toISOString();
        if (!snap.exists()) {
            const next = _applyTaskMutation(Array.isArray(fallbackSideArr) ? fallbackSideArr : [], taskId, mutateFn);
            if (!next) throw new Error('task not found');
            tx.set(liveRef, {
                customTasks: { [side]: { all: next } },
                date: toDateStr(), updatedAt: nowIso,
            }, { merge: true });
            tx.set(histRef, { customTasks: { [side]: { all: next } }, updatedAt: nowIso }, { merge: true });
            return;
        }
        const customTasks = snap.data()?.customTasks || {};
        for (const period of ['all', 'morning', 'afternoon']) {
            const next = _applyTaskMutation(customTasks?.[side]?.[period], taskId, mutateFn);
            if (!next) continue;
            tx.update(liveRef, {
                [`customTasks.${side}.${period}`]: next,
                updatedAt: nowIso,
            });
            tx.set(histRef, { customTasks: { [side]: { [period]: next } }, updatedAt: nowIso }, { merge: true });
            return;
        }
        throw new Error('task not found');
    });
}

// Transactional append for the two "add task" writers (quick-add + full
// form) — read the live side array, append the new task, write. No id
// lookup needed; the task's own id makes a transaction retry idempotent.
export async function appendOpsChecklistTask(location, side, task) {
    if (!location || !side || !task?.id) throw new Error('missing location/side/task');
    const liveRef = doc(db, 'ops', 'checklists2_' + location);
    const histRef = doc(db, 'checklistHistory_' + location, toDateStr());
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(liveRef);
        const s = (snap.exists() ? snap.data()?.customTasks?.[side] : null) || {};
        // Live docs were migrated to a single `all` period; a doc still on
        // the legacy morning/afternoon shape gets the same merge the
        // Operations listener applies (and the old whole-array write wrote).
        const base = Array.isArray(s.all) ? s.all : [...(s.morning || []), ...(s.afternoon || [])];
        const next = base.some(t => t?.id === task.id) ? base : [...base, task];
        const nowIso = new Date().toISOString();
        if (snap.exists()) {
            tx.update(liveRef, { [`customTasks.${side}.all`]: next, updatedAt: nowIso });
        } else {
            tx.set(liveRef, { customTasks: { [side]: { all: next } }, date: toDateStr(), updatedAt: nowIso }, { merge: true });
        }
        tx.set(histRef, { customTasks: { [side]: { all: next } }, updatedAt: nowIso }, { merge: true });
    });
}

// Transactional two-ID swap for the Tasks tab's ▲▼ reorder arrows.
// Operations' moveChecklistTask is a SWAP of two possibly NON-adjacent
// positions (the visible list is filtered, so the tapped rows' _origIdx
// values need not be neighbors) — deliberately NOT built on
// moveOpsChecklistTask, whose move-before semantics would be a visible
// reorder regression. Both ids are captured by the caller at tap time;
// the transaction re-locates them by id so a concurrent reorder can't
// redirect the swap onto the wrong rows.
export async function swapOpsChecklistTasks(location, taskIdA, taskIdB) {
    if (!location || !taskIdA || !taskIdB || taskIdA === taskIdB) throw new Error('missing/equal task ids');
    const liveRef = doc(db, 'ops', 'checklists2_' + location);
    const histRef = doc(db, 'checklistHistory_' + location, toDateStr());
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(liveRef);
        if (!snap.exists()) throw new Error('checklist not found');
        const customTasks = snap.data()?.customTasks || {};
        for (const side of ['FOH', 'BOH']) {
            for (const period of ['all', 'morning', 'afternoon']) {
                const arr = customTasks?.[side]?.[period];
                if (!Array.isArray(arr)) continue;
                const ia = arr.findIndex(t => t?.id === taskIdA);
                if (ia === -1) continue;
                const ib = arr.findIndex(t => t?.id === taskIdB);
                // Both tasks must live in the same array — if the partner
                // vanished (concurrent delete), abort rather than guess.
                if (ib === -1) throw new Error('swap partner not found');
                const next = arr.slice();
                [next[ia], next[ib]] = [next[ib], next[ia]];
                const nowIso = new Date().toISOString();
                tx.update(liveRef, { [`customTasks.${side}.${period}`]: next, updatedAt: nowIso });
                tx.set(histRef, { customTasks: { [side]: { [period]: next } }, updatedAt: nowIso }, { merge: true });
                return;
            }
        }
        throw new Error('task not found');
    });
}
