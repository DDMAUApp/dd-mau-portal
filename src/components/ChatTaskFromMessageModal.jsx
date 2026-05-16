// ChatTaskFromMessageModal — promote a chat message into a tracked task.
//
// Workflow:
//   1. Long-press a message → "Make this a task" → modal opens with
//      title prefilled (first line) + body (full message + media link)
//   2. Pick assignee, due date, priority
//   3. Save → /chat_tasks/{taskId} created, message gets linkedTaskId
//      pill, assignee gets push notification
//
// Why a new /chat_tasks collection instead of using existing checklists
// or maintenance_tickets: chat-tasks are message-anchored, ad-hoc, and
// short-lived. Operations checklists are recurring; maintenance is
// vendor-tracked. Conflating would muddy the data model.
//
// Schema:
//   /chat_tasks/{id} = {
//     title, body, assigneeId (staffName), priority, dueAt,
//     status: 'open' | 'done' | 'cancelled',
//     sourceMessageId, sourceChannelId, createdBy, createdAt,
//     completedAt?, completedBy?
//   }

import { useState, useMemo } from 'react';
import { db } from '../firebase';
import {
    collection, doc, addDoc, updateDoc, serverTimestamp,
} from 'firebase/firestore';
import { recordAudit } from '../data/audit';
import { notifyStaff } from '../data/notify';

const PRIORITIES = [
    { key: 'low',    en: 'Low',    es: 'Baja',    color: 'bg-dd-bg text-dd-text-2 border-dd-line' },
    { key: 'medium', en: 'Medium', es: 'Media',   color: 'bg-amber-50 text-amber-800 border-amber-200' },
    { key: 'high',   en: 'High',   es: 'Alta',    color: 'bg-orange-50 text-orange-800 border-orange-200' },
];

export default function ChatTaskFromMessageModal({
    chat, message, language = 'en', staffName, staffList, viewer,
    onClose, onCreated,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const initialTitle = (message?.text || '').split('\n')[0].slice(0, 100) || 'Follow up';
    const [title, setTitle] = useState(initialTitle);
    const [body, setBody] = useState(message?.text || '');
    const [assignee, setAssignee] = useState('');
    const [priority, setPriority] = useState('medium');
    const [dueDate, setDueDate] = useState(() => {
        // default to end-of-day tomorrow
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    const [busy, setBusy] = useState(false);

    // Candidates: chat members (most likely the right person is in the chat).
    // Falls back to full staff list if the chat doesn't have a members
    // array (e.g., DMs are 2 people).
    const candidates = useMemo(() => {
        const members = Array.isArray(chat?.members) ? chat.members : [];
        const inChat = (staffList || []).filter(s => members.includes(s.name));
        // For groups: show in-chat first; for DMs: show the OTHER person.
        if (chat?.type === 'dm') {
            return inChat.filter(s => s.name !== staffName);
        }
        return inChat
            .filter(s => s.hideFromSchedule !== true)
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [chat, staffList, staffName]);

    async function handleCreate() {
        if (!title.trim() || !assignee || busy) return;
        setBusy(true);
        try {
            const dueAt = dueDate ? new Date(dueDate + 'T23:59:00').toISOString() : null;
            const taskRef = await addDoc(collection(db, 'chat_tasks'), {
                title: title.trim(),
                body: body.trim(),
                assigneeId: assignee,
                priority,
                dueAt,
                status: 'open',
                sourceMessageId: message?.id || null,
                sourceChannelId: chat?.id || null,
                sourceMediaUrl: message?.mediaUrl || null,
                createdBy: staffName,
                createdById: viewer?.id || null,
                createdAt: serverTimestamp(),
            });

            // Patch the source message with the linkedTaskId so the
            // ChatThread renderer can show a "📋 Task" chip.
            if (message?.id && chat?.id) {
                try {
                    await updateDoc(doc(db, 'chats', chat.id, 'messages', message.id), {
                        linkedTaskId: taskRef.id,
                    });
                } catch (e) {
                    console.warn('linkedTaskId patch failed:', e);
                }
            }

            // Notify the assignee.
            notifyStaff({
                forStaff: assignee,
                type: 'task_handoff',
                title: '📋 ' + tx('New task', 'Nueva tarea'),
                body: title.trim(),
                deepLink: 'chat',
                link: '/chat',
                tag: `task:${taskRef.id}:${assignee}`,
                createdBy: staffName,
            }).catch(() => {});

            recordAudit({
                action: 'chat.task.convert',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'task',
                targetId: taskRef.id,
                details: {
                    sourceMessageId: message?.id,
                    sourceChannelId: chat?.id,
                    assignee,
                    priority,
                    dueAt,
                },
            });

            onCreated?.({ taskId: taskRef.id });
        } catch (e) {
            console.error('task convert failed:', e);
            alert(tx('Could not create task', 'No se pudo crear la tarea'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl flex flex-col max-h-[90vh] shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-black text-dd-text">📋 {tx('Make this a task', 'Convertir en tarea')}</h2>
                        <p className="text-[11px] text-dd-text-2">{tx('Assign + track to completion', 'Asignar y dar seguimiento')}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Title', 'Título')}
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            maxLength={100}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm font-bold focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                        />
                    </div>

                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Details', 'Detalles')}
                        </label>
                        <textarea
                            rows={3}
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                        />
                        {message?.mediaUrl && (
                            <div className="mt-1 text-[11px] text-dd-text-2">
                                📎 {tx('Original photo/video will be linked', 'Foto/video original se enlazará')}
                            </div>
                        )}
                    </div>

                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Assignee', 'Asignado a')}
                        </label>
                        <select
                            value={assignee}
                            onChange={(e) => setAssignee(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line bg-white text-sm font-bold focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                        >
                            <option value="">{tx('— Pick a person —', '— Elige a alguien —')}</option>
                            {candidates.map(s => (
                                <option key={s.name} value={s.name}>{s.name}{s.role ? ` — ${s.role}` : ''}</option>
                            ))}
                        </select>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                {tx('Priority', 'Prioridad')}
                            </label>
                            <div className="flex gap-1">
                                {PRIORITIES.map(p => (
                                    <button
                                        key={p.key}
                                        onClick={() => setPriority(p.key)}
                                        className={`flex-1 px-1 py-2 rounded text-[11px] font-bold border-2 transition ${priority === p.key ? p.color : 'border-dd-line text-dd-text-2'}`}
                                    >
                                        {isEs ? p.es : p.en}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                {tx('Due', 'Vence')}
                            </label>
                            <input
                                type="date"
                                value={dueDate}
                                onChange={(e) => setDueDate(e.target.value)}
                                className="w-full px-2 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                            />
                        </div>
                    </div>
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex items-center justify-between gap-3 shrink-0">
                    <button onClick={onClose} className="px-3 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={handleCreate}
                        disabled={busy || !title.trim() || !assignee}
                        className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-dd-green-700"
                    >
                        {busy ? tx('Creating…', 'Creando…') : tx('📋 Create Task', '📋 Crear Tarea')}
                    </button>
                </div>
            </div>
        </div>
    );
}
