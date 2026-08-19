// TrainingAssignmentsPanel — Admin → Training assignments (2026-08-18).
//
// Andrew: "i want to finish it and then send to all staff … to read it and
// take a test. i want this function to be tracked and done by a certain
// time. in the admin page i can see all opens all progress and completions."
//
// Top: assign a module (pick module, due date/time, who, optional note) →
// one DM per person with a 📚 card that deep-links into the module (the
// DM fan-out Cloud Function pushes it). Below: every assignment with a live
// roster — sent ✓, opened, lessons x/y, quiz attempts, passed ✅, overdue —
// joined live from /training_v2 (the exact doc the Training Hub writes).
// Reminders DM only the people who aren't done.

import { useEffect, useState } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { MODULES } from '../data/training';
import {
    ASSIGNMENTS, sendAssignmentReminders, sendAssignmentDMs,
    closeAssignment, reopenAssignment, deriveAssignmentRows, fmtDue, toMs,
} from '../data/trainingAssignments';
import TrainingAssignForm from './TrainingAssignForm';
import { toast } from '../toast';

const STATUS_META = {
    done:        { en: 'Done',        es: 'Listo',       cls: 'bg-green-100 text-green-800' },
    in_progress: { en: 'In progress', es: 'En progreso', cls: 'bg-amber-100 text-amber-800' },
    opened:      { en: 'Opened',      es: 'Abrió',       cls: 'bg-sky-100 text-sky-800' },
    not_started: { en: 'Not started', es: 'Sin empezar', cls: 'bg-gray-100 text-gray-600' },
};

export default function TrainingAssignmentsPanel({ staffList = [], language = 'en', staffName = '', staffId = null, isAdminUser = false }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // ── live data ────────────────────────────────────────────────────
    const [assignments, setAssignments] = useState([]);
    const [trainingDocs, setTrainingDocs] = useState({});
    useEffect(() => {
        const unsubA = onSnapshot(query(collection(db, ASSIGNMENTS), orderBy('createdAt', 'desc'), limit(100)), (snap) => {
            const list = []; snap.forEach(d => list.push({ id: d.id, ...d.data() })); setAssignments(list);
        }, (e) => console.warn('assignments snapshot error:', e));
        const unsubT = onSnapshot(collection(db, 'training_v2'), (snap) => {
            const m = {}; snap.forEach(d => { m[d.id] = d.data(); }); setTrainingDocs(m);
        }, (e) => console.warn('training_v2 snapshot error:', e));
        return () => { unsubA(); unsubT(); };
    }, []);

    const [expanded, setExpanded] = useState({});   // assignmentId → bool
    const [reminding, setReminding] = useState(null);

    const [resending, setResending] = useState(null);
    const resendUnsent = async (a, rows) => {
        const todo = rows.filter(r => (!r.sentAt || r.sendError) && r.name !== staffName).map(r => r.name);
        if (!todo.length) { toast(tx('Everyone has the message', 'Todos tienen el mensaje')); return; }
        if (!confirm(tx(`Send the original message to ${todo.length} people who never got it?`, `¿Enviar el mensaje original a ${todo.length} personas que no lo recibieron?`))) return;
        setResending(a.id);
        try {
            const res = await sendAssignmentDMs({ assignmentId: a.id, assignment: a, fromName: staffName, fromId: staffId, only: todo });
            toast(tx(`📨 Sent ${res.ok}${res.failed ? `, ${res.failed} failed` : ''}`, `📨 Enviado ${res.ok}${res.failed ? `, ${res.failed} fallaron` : ''}`));
        } catch (err) {
            toast(tx('Resend failed: ', 'Error: ') + (err?.message || err), { kind: 'error' });
        } finally { setResending(null); }
    };

    const remind = async (a, rows) => {
        const todo = rows.filter(r => r.status !== 'done' && r.name !== staffName);
        if (!todo.length) { toast(tx('Everyone is done 🎉', 'Todos terminaron 🎉')); return; }
        if (!confirm(tx(`Send a reminder DM to ${todo.length} people who haven't finished?`, `¿Enviar recordatorio por DM a ${todo.length} personas que no han terminado?`))) return;
        setReminding(a.id);
        try {
            const res = await sendAssignmentReminders({ assignmentId: a.id, assignment: a, rows, fromName: staffName, fromId: staffId });
            toast(tx(`⏰ Reminded ${res.ok}${res.failed ? `, ${res.failed} failed` : ''}`, `⏰ Recordatorio a ${res.ok}${res.failed ? `, ${res.failed} fallaron` : ''}`));
        } catch (err) {
            toast(tx('Reminder failed: ', 'Error: ') + (err?.message || err), { kind: 'error' });
        } finally { setReminding(null); }
    };

    const fmtTs = (v) => {
        const ms = toMs(v); if (!ms) return '—';
        try { return new Date(ms).toLocaleString(isEs ? 'es' : 'en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return '—'; }
    };

    const openList = assignments.filter(a => a.status !== 'closed');
    const closedList = assignments.filter(a => a.status === 'closed');

    const renderAssignment = (a) => {
        const m = MODULES.find(x => x.id === a.moduleId);
        const { rows, summary } = deriveAssignmentRows(a, trainingDocs, m);
        const isOpen = !!expanded[a.id];
        const pct = summary.total ? Math.round(summary.done / summary.total * 100) : 0;
        const closed = a.status === 'closed';
        return (
            <div key={a.id} className={`glass-card p-3 mb-3 ${closed ? 'opacity-70' : ''}`}>
                <button type="button" onClick={() => setExpanded(e => ({ ...e, [a.id]: !isOpen }))} className="w-full text-left">
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className="text-sm font-black text-dd-text truncate">{m?.icon || '📚'} {a.moduleCode} · {isEs ? (a.titleEs || a.titleEn) : a.titleEn}</div>
                            <div className={`text-[11px] mt-0.5 ${summary.isPastDue && !closed ? 'text-red-700 font-bold' : 'text-dd-text-2'}`}>
                                {closed ? tx('Closed', 'Cerrada') + ' · ' : ''}{tx('Due', 'Límite')} {fmtDue(summary.dueMs, isEs ? 'es' : 'en')}{summary.isPastDue && !closed ? ` · ${tx('PAST DUE', 'VENCIDA')}` : ''}
                                {' · '}{tx('sent by', 'enviado por')} {a.createdBy} {fmtTs(a.createdAt)}
                            </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                            <div className="text-lg font-black text-dd-text">{summary.done}/{summary.total}</div>
                            <div className="text-[10px] text-dd-text-2">{tx('done', 'listos')} · {pct}%</div>
                        </div>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-gray-200 overflow-hidden">
                        <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2 text-[10px] font-bold">
                        <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-800">✅ {summary.done} {tx('done', 'listos')}</span>
                        <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">📖 {summary.inProgress} {tx('in progress', 'en progreso')}</span>
                        <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-800">👀 {summary.opened} {tx('opened', 'abrieron')}</span>
                        <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">⬜ {summary.notStarted} {tx('not started', 'sin empezar')}</span>
                        {summary.overdue > 0 && !closed && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-800">⏰ {summary.overdue} {tx('overdue', 'vencidos')}</span>}
                        {summary.sendFailed > 0 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-800">✉️ {summary.sendFailed} {tx('not delivered', 'no entregados')}</span>}
                    </div>
                </button>
                {isOpen && (
                    <div className="mt-3">
                        <div className="flex flex-wrap gap-2 mb-2">
                            {!closed && (
                                <button type="button" disabled={reminding === a.id} onClick={() => remind(a, rows)}
                                    className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-black disabled:opacity-60">
                                    {reminding === a.id ? tx('Sending…', 'Enviando…') : tx(`⏰ Remind ${rows.filter(r => r.status !== 'done').length} not done`, `⏰ Recordar a ${rows.filter(r => r.status !== 'done').length} pendientes`)}
                                </button>
                            )}
                            {!closed && rows.some(r => (!r.sentAt || r.sendError) && r.name !== staffName) && (
                                <button type="button" disabled={resending === a.id} onClick={() => resendUnsent(a, rows)}
                                    className="px-3 py-1.5 rounded-lg bg-red-100 text-red-800 text-xs font-black disabled:opacity-60">
                                    {resending === a.id ? tx('Sending…', 'Enviando…') : tx(`✉️ Resend to ${rows.filter(r => (!r.sentAt || r.sendError) && r.name !== staffName).length} unsent`, `✉️ Reenviar a ${rows.filter(r => (!r.sentAt || r.sendError) && r.name !== staffName).length} sin mensaje`)}
                                </button>
                            )}
                            {!closed
                                ? <button type="button" onClick={() => { if (confirm(tx('Close this assignment? Staff stop seeing the banner; progress stays.', '¿Cerrar esta asignación? El personal deja de ver el aviso; el progreso se conserva.'))) closeAssignment(a.id, staffName).catch(e => toast(String(e?.message || e), { kind: 'error' })); }}
                                    className="px-3 py-1.5 rounded-lg bg-gray-200 text-gray-800 text-xs font-black">{tx('Close', 'Cerrar')}</button>
                                : <button type="button" onClick={() => reopenAssignment(a.id).catch(e => toast(String(e?.message || e), { kind: 'error' }))}
                                    className="px-3 py-1.5 rounded-lg bg-gray-200 text-gray-800 text-xs font-black">{tx('Reopen', 'Reabrir')}</button>}
                            <button type="button" onClick={() => {
                                const lines = [['Name', 'Status', 'Sent', 'Opened', 'Lessons', 'Attempts', 'Passed at', 'Overdue'].join('\t'),
                                    ...rows.map(r => [r.name, r.status, r.sentAt || '', r.openedAt || '', `${r.lessonsDone}/${r.lessonsTotal}`, r.attempts, r.passedAt || '', r.overdue ? 'yes' : ''].join('\t'))];
                                navigator.clipboard?.writeText(lines.join('\n')).then(() => toast(tx('Copied roster (paste into a spreadsheet)', 'Lista copiada (pégala en una hoja de cálculo)')));
                            }} className="px-3 py-1.5 rounded-lg bg-gray-200 text-gray-800 text-xs font-black">{tx('Copy roster', 'Copiar lista')}</button>
                        </div>
                        {a.note && <div className="text-[11px] italic text-dd-text-2 mb-2">“{a.note}”</div>}
                        <div className="overflow-x-auto -mx-1">
                            <table className="w-full text-[11px]">
                                <thead>
                                    <tr className="text-left text-dd-text-2 border-b border-gray-200">
                                        <th className="py-1 pr-2">{tx('Name', 'Nombre')}</th>
                                        <th className="py-1 pr-2">{tx('Status', 'Estado')}</th>
                                        <th className="py-1 pr-2">{tx('Sent', 'Enviado')}</th>
                                        <th className="py-1 pr-2">{tx('Opened', 'Abrió')}</th>
                                        <th className="py-1 pr-2">{tx('Lessons', 'Lecciones')}</th>
                                        <th className="py-1 pr-2">{tx('Quiz', 'Examen')}</th>
                                        <th className="py-1 pr-2">{tx('Completed', 'Completado')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...rows].sort((x, y) => {
                                        const order = { not_started: 0, opened: 1, in_progress: 2, done: 3 };
                                        return (order[x.status] - order[y.status]) || x.name.localeCompare(y.name);
                                    }).map(r => {
                                        const meta = STATUS_META[r.status];
                                        return (
                                            <tr key={r.docId} className={`border-b border-gray-100 ${r.overdue ? 'bg-red-50/60' : ''}`}>
                                                <td className="py-1.5 pr-2 font-bold text-dd-text whitespace-nowrap">{r.name}{r.locked ? ' 🔒' : ''}</td>
                                                <td className="py-1.5 pr-2 whitespace-nowrap">
                                                    <span className={`px-1.5 py-0.5 rounded-full font-bold ${meta.cls}`}>{isEs ? meta.es : meta.en}</span>
                                                    {r.overdue && <span className="ml-1 px-1.5 py-0.5 rounded-full font-bold bg-red-100 text-red-800">{tx('overdue', 'vencido')}</span>}
                                                </td>
                                                <td className="py-1.5 pr-2 whitespace-nowrap">{r.sendError ? <span className="text-red-700 font-bold" title={r.sendError}>✗ {tx('failed', 'falló')}</span> : r.sentAt ? `✓ ${fmtTs(r.sentAt)}` : '—'}{r.reminderCount ? <span className="text-amber-700"> · ⏰×{r.reminderCount}</span> : null}</td>
                                                <td className="py-1.5 pr-2 whitespace-nowrap">{r.openedAt ? fmtTs(r.openedAt) : '—'}</td>
                                                <td className="py-1.5 pr-2 whitespace-nowrap">{r.lessonsDone}/{r.lessonsTotal}</td>
                                                <td className="py-1.5 pr-2 whitespace-nowrap">{r.passed ? '✅' : r.attempts ? `${r.failedAttempts} ${tx('failed', 'fallidos')}${r.locked ? ' 🔒' : ''}` : '—'}</td>
                                                <td className="py-1.5 pr-2 whitespace-nowrap">{r.passedAt ? fmtTs(r.passedAt) : '—'}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="mb-3">
            <TrainingAssignForm staffList={staffList} language={language} staffName={staffName} staffId={staffId} isAdminUser={isAdminUser}
                onSent={(id) => setExpanded(e => ({ ...e, [id]: true }))} />

            {/* ── Assignments ───────────────────────────────────────── */}
            <h3 className="font-bold text-[13px] text-dd-text-2 uppercase tracking-wide mb-2">{tx('Open assignments', 'Asignaciones abiertas')} ({openList.length})</h3>
            {openList.length === 0 && <p className="text-xs text-dd-text-2 italic mb-3">{tx('None yet.', 'Ninguna todavía.')}</p>}
            {openList.map(renderAssignment)}
            {closedList.length > 0 && (
                <>
                    <h3 className="font-bold text-[13px] text-dd-text-2 uppercase tracking-wide mb-2 mt-4">{tx('Closed', 'Cerradas')} ({closedList.length})</h3>
                    {closedList.map(renderAssignment)}
                </>
            )}
        </div>
    );
}
