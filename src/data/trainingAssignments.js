// Training assignments (2026-08-18) — Andrew: "send to all staff via the chat
// to read it and take a test … tracked and done by a certain time … in the
// admin page I can see all opens, all progress and completions."
//
// One doc per assignment in /training_assignments:
//   { moduleId, moduleCode, titleEn, titleEs, dueAt: Timestamp, note,
//     createdAt, createdBy, status: 'open'|'closed', closedAt,
//     recipients: [{ name, id }],                 // who it went to
//     sent:   { [docId]: { name, at: ISO, chatId, error } },   // DM delivery
//     opened: { [docId]: ISO },                   // first time they opened the module
//     reminders: { [docId]: { lastAt: ISO, count } } }
// Progress itself (lessons read, quiz passed) is NOT copied here — it is
// read from /training_v2/{docId} (the same doc the Training Hub writes) so
// the admin roster can never disagree with what the staffer sees.
//
// docId = trainingDocId(name) (lower-case, spaces → _), the same key
// TrainingHub uses for /training_v2.

import { db } from '../firebase';
import {
    collection, doc, serverTimestamp, Timestamp, FieldPath,
    addDoc as _fsAddDoc, updateDoc as _fsUpdateDoc,
} from 'firebase/firestore';
import { watchdogWrite } from './firestoreRevive';
import { sendDirectMessage, liveDmMapFor } from './chatDm';
import { trainingDocId } from './renameStaff';

const addDoc = (...a) => watchdogWrite(_fsAddDoc(...a));
const updateDoc = (...a) => watchdogWrite(_fsUpdateDoc(...a));

export const ASSIGNMENTS = 'training_assignments';
export { trainingDocId };

export function fmtDue(dueMs, language = 'en') {
    if (!dueMs) return '';
    try {
        return new Date(dueMs).toLocaleString(language === 'es' ? 'es' : 'en', {
            weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });
    } catch { return ''; }
}

export function toMs(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts === 'string') { const n = Date.parse(ts); return Number.isFinite(n) ? n : 0; }
    if (ts.toMillis) return ts.toMillis();
    if (ts.seconds) return ts.seconds * 1000;
    return 0;
}

// The DM / push body. Both languages in one message — a DM has one text and
// the recipient's language is unknown here; the in-app card is localized.
export function assignmentMessageText({ moduleCode, titleEn, titleEs, dueMs, note }) {
    const due = fmtDue(dueMs, 'en');
    const dueEs = fmtDue(dueMs, 'es');
    const lines = [
        `📚 Required training: ${moduleCode} · ${titleEn}`,
        `Please read the lessons and pass the quiz by ${due}.`,
        `Open the Training tab → ${moduleCode}.`,
    ];
    if (note) lines.push(`“${note}”`);
    lines.push('', `📚 Capacitación requerida: ${moduleCode} · ${titleEs || titleEn}`,
        `Lee las lecciones y aprueba el examen antes del ${dueEs}.`,
        `Abre la pestaña Capacitación → ${moduleCode}.`);
    return lines.join('\n');
}

export function reminderMessageText({ moduleCode, titleEn, titleEs, dueMs, overdue }) {
    const due = fmtDue(dueMs, 'en');
    const dueEs = fmtDue(dueMs, 'es');
    return [
        overdue
            ? `⏰ Overdue training: ${moduleCode} · ${titleEn} was due ${due}. Please finish it today — read the lessons and pass the quiz.`
            : `⏰ Reminder: ${moduleCode} · ${titleEn} is due ${due}. Read the lessons and pass the quiz in the Training tab.`,
        '',
        overdue
            ? `⏰ Capacitación vencida: ${moduleCode} · ${titleEs || titleEn} vencía el ${dueEs}. Por favor termínala hoy — lee las lecciones y aprueba el examen.`
            : `⏰ Recordatorio: ${moduleCode} · ${titleEs || titleEn} vence el ${dueEs}. Lee las lecciones y aprueba el examen en la pestaña Capacitación.`,
    ].join('\n');
}

// Create the assignment doc. Returns its id.
export async function createAssignment({ moduleId, moduleCode, titleEn, titleEs, dueAt, note = '', recipients, createdBy }) {
    if (!moduleId || !(dueAt instanceof Date) || !Array.isArray(recipients) || recipients.length === 0) {
        throw new Error('moduleId, dueAt (Date) and at least one recipient are required');
    }
    const ref = await addDoc(collection(db, ASSIGNMENTS), {
        moduleId, moduleCode, titleEn, titleEs: titleEs || titleEn,
        dueAt: Timestamp.fromDate(dueAt),
        note: String(note || '').trim().slice(0, 300),
        createdAt: serverTimestamp(),
        createdBy: createdBy || 'unknown',
        status: 'open',
        recipients: recipients.map(r => ({ name: r.name, id: r.id ?? null })),
        sent: {}, opened: {}, reminders: {},
    });
    return ref.id;
}

// DM every recipient (sequential — ~66 people, a few hundred ms each) and
// stamp `sent.{docId}`. The sender's live-DM map is resolved ONCE up front;
// `sent` is flushed in chunks (not 66 single-field writes on one hot doc)
// and flush failures are surfaced, not swallowed. `only` = names to send to
// (the panel's "Resend to unsent"); default = every recipient.
// onProgress(done, total, name, ok).
export async function sendAssignmentDMs({ assignmentId, assignment, fromName, fromId = null, onProgress, only = null }) {
    const dueMs = toMs(assignment.dueAt);
    const text = assignmentMessageText({ ...assignment, dueMs });
    const training = {
        assignmentId, moduleId: assignment.moduleId, moduleCode: assignment.moduleCode,
        titleEn: assignment.titleEn, titleEs: assignment.titleEs || assignment.titleEn,
        dueAtMs: dueMs, note: assignment.note || '',
    };
    const ref = doc(db, ASSIGNMENTS, assignmentId);
    const onlySet = Array.isArray(only) ? new Set(only) : null;
    const recipients = (assignment.recipients || []).filter(r => !onlySet || onlySet.has(r.name));
    const dmMap = await liveDmMapFor(fromName);
    let ok = 0, failed = 0;
    let pending = [];   // [FieldPath, value] pairs waiting to be flushed
    let flushErrors = 0;
    const flush = async () => {
        if (!pending.length) return;
        const args = pending.flat();
        pending = [];
        try { await updateDoc(ref, args[0], args[1], ...args.slice(2)); }
        catch (e) { flushErrors += 1; console.warn('assignment sent-stamp flush failed:', e); }
    };
    for (let i = 0; i < recipients.length; i++) {
        const r = recipients[i];
        const key = trainingDocId(r.name);
        let res;
        if (r.name === fromName) {
            res = { ok: true, chatId: null, self: true };   // can't DM yourself; count as delivered
        } else {
            // eslint-disable-next-line no-await-in-loop
            res = await sendDirectMessage({ fromName, fromId, toName: r.name, text, extra: { type: 'training_assignment', training }, knownChatId: dmMap ? (dmMap.get(r.name) ?? false) : null });
        }
        if (res.ok) ok += 1; else failed += 1;
        pending.push([new FieldPath('sent', key), { name: r.name, at: new Date().toISOString(), chatId: res.chatId || null, error: res.ok ? null : (res.error || 'send_failed') }]);
        // eslint-disable-next-line no-await-in-loop
        if (pending.length >= 8) await flush();
        onProgress?.(i + 1, recipients.length, r.name, res.ok);
    }
    await flush();
    return { ok, failed, flushErrors };
}

// Staff side: first time they open the module after being assigned.
export async function stampAssignmentOpened(assignmentId, staffName) {
    const key = trainingDocId(staffName);
    try {
        // FieldPath (not a dot-string) so a key like "dr._bob" stays one segment.
        await updateDoc(doc(db, ASSIGNMENTS, assignmentId), new FieldPath('opened', key), new Date().toISOString());
    } catch (e) { console.warn('stampAssignmentOpened failed:', e); }
}

export async function closeAssignment(assignmentId, byName) {
    await updateDoc(doc(db, ASSIGNMENTS, assignmentId), { status: 'closed', closedAt: serverTimestamp(), closedBy: byName || 'unknown' });
}
export async function reopenAssignment(assignmentId) {
    await updateDoc(doc(db, ASSIGNMENTS, assignmentId), { status: 'open', closedAt: null, closedBy: null });
}

// Remind everyone who isn't done (rows from deriveAssignmentRows with
// status !== 'done'). DM only — the DM fan-out pushes on its own.
export async function sendAssignmentReminders({ assignmentId, assignment, rows, fromName, fromId = null, onProgress }) {
    const dueMs = toMs(assignment.dueAt);
    const overdue = dueMs > 0 && Date.now() > dueMs;
    const text = reminderMessageText({ ...assignment, dueMs, overdue });
    const training = {
        assignmentId, moduleId: assignment.moduleId, moduleCode: assignment.moduleCode,
        titleEn: assignment.titleEn, titleEs: assignment.titleEs || assignment.titleEn,
        dueAtMs: dueMs, note: '', reminder: true,
    };
    const ref = doc(db, ASSIGNMENTS, assignmentId);
    const todo = rows.filter(r => r.status !== 'done' && r.name !== fromName);
    const dmMap = await liveDmMapFor(fromName);
    let ok = 0, failed = 0;
    for (let i = 0; i < todo.length; i++) {
        const r = todo[i];
        // eslint-disable-next-line no-await-in-loop
        const res = await sendDirectMessage({ fromName, fromId, toName: r.name, text, extra: { type: 'training_assignment', training }, knownChatId: dmMap ? (dmMap.get(r.name) ?? false) : null });
        if (res.ok) ok += 1; else failed += 1;
        // eslint-disable-next-line no-await-in-loop
        await updateDoc(ref, new FieldPath('reminders', r.docId),
            { lastAt: new Date().toISOString(), count: ((assignment.reminders?.[r.docId]?.count) || 0) + 1 },
        ).catch(() => {});
        onProgress?.(i + 1, todo.length, r.name, res.ok);
    }
    return { ok, failed, total: todo.length };
}

// ── Pure: derive the roster for one assignment ───────────────────────
// trainingDocs: { [docId]: training_v2 doc data }  ·  module: the MODULES
// entry (for lesson count). nowMs for testability.
export function deriveAssignmentRows(assignment, trainingDocs, module, nowMs = Date.now()) {
    const dueMs = toMs(assignment?.dueAt);
    const lessonsTotal = module?.lessons?.length || 0;
    const lessonIds = new Set((module?.lessons || []).map(l => l.id));
    const mId = assignment?.moduleId;
    const rows = (assignment?.recipients || []).map(r => {
        const docId = trainingDocId(r.name);
        const sent = assignment.sent?.[docId] || null;
        const openedAt = assignment.opened?.[docId] || null;
        const rem = assignment.reminders?.[docId] || null;          // manual (admin button → DM)
        const auto = assignment.autoReminders?.[docId] || null;     // scheduled push (Cloud Function)
        const st = trainingDocs?.[docId]?.modules?.[mId] || {};
        const done = Array.isArray(st.lessonsCompleted) ? st.lessonsCompleted.filter(id => lessonIds.has(id)).length : 0;
        const attempts = Array.isArray(st.attempts) ? st.attempts : [];
        const passed = !!st.passed;
        const passedAt = st.passedAt || (passed ? (attempts.filter(a => a.passed).map(a => a.at).sort().pop() || null) : null);
        const locked = !!st.locked && !passed;
        const failedAttempts = attempts.filter(a => !a.passed).length;
        let status = 'not_started';
        if (passed) status = 'done';
        // 2026-08-26 — distinct "read everything, quiz not passed" state.
        // Six of the first 22 M18 readers stopped exactly there and looked
        // like generic "in progress"; admins couldn't tell "just needs the
        // quiz" from "halfway through the lessons".
        else if (lessonsTotal > 0 && done >= lessonsTotal) status = 'quiz_pending';
        else if (done > 0 || attempts.length > 0) status = 'in_progress';
        else if (openedAt) status = 'opened';
        const overdue = !passed && dueMs > 0 && nowMs > dueMs;
        return {
            name: r.name, id: r.id ?? null, docId,
            sentAt: sent?.at || null, sendError: sent?.error || null, chatId: sent?.chatId || null,
            openedAt, lessonsDone: done, lessonsTotal,
            attempts: attempts.length, failedAttempts, locked,
            passed, passedAt, status, overdue,
            reminderCount: (rem?.count || 0) + (auto?.count || 0),
            lastReminderAt: [rem?.lastAt, auto?.lastAt].filter(Boolean).sort().pop() || null,
        };
    });
    const summary = {
        total: rows.length,
        done: rows.filter(r => r.status === 'done').length,
        inProgress: rows.filter(r => r.status === 'in_progress').length,
        quizPending: rows.filter(r => r.status === 'quiz_pending').length,
        opened: rows.filter(r => r.status === 'opened').length,
        notStarted: rows.filter(r => r.status === 'not_started').length,
        overdue: rows.filter(r => r.overdue).length,
        sendFailed: rows.filter(r => r.sendError).length,
        dueMs, isPastDue: dueMs > 0 && nowMs > dueMs,
    };
    return { rows, summary };
}

// Staff side: which open assignments is this person on (and not done)?
export function myOpenAssignments(assignments, staffName, progressModules = {}) {
    const key = trainingDocId(staffName);
    return (assignments || [])
        .filter(a => a && a.status !== 'closed' && (a.recipients || []).some(r => trainingDocId(r.name) === key))
        .map(a => ({ ...a, dueMs: toMs(a.dueAt), done: !!progressModules?.[a.moduleId]?.passed }))
        .sort((a, b) => a.dueMs - b.dueMs);
}
