// ChatAckDashboard — manager view of who's read an announcement.
//
// Opened from a special "🔍 Read-rate" button rendered on the
// announcement card for the original author (or any manager). Shows:
//   • Progress bar (X / N acknowledged)
//   • List of pending (still need to ack)
//   • List of completed (with timestamps)
//   • Nudge button — sends a reminder to all pending
//
// Data sources:
//   • The announcement message doc (for ackDeadline, audience)
//   • The chat doc (for full members list — the audience)
//   • /chats/{chatId}/acks subcollection (one doc per ack)

import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, doc } from 'firebase/firestore';
import { notifyStaff } from '../data/notify';
import { recordAudit } from '../data/audit';

export default function ChatAckDashboard({
    chat, message, language = 'en', staffName, viewer, onClose,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const [acks, setAcks] = useState([]); // [{ userName, ackedAt }]
    const [nudging, setNudging] = useState(false);

    useEffect(() => {
        if (!chat?.id || !message?.id) return;
        const unsub = onSnapshot(
            collection(db, 'chats', chat.id, 'acks'),
            (snap) => {
                const list = [];
                snap.forEach(d => {
                    const data = d.data();
                    if (data.messageId === message.id) list.push({ id: d.id, ...data });
                });
                setAcks(list);
            },
            (err) => console.warn('ack snapshot failed:', err)
        );
        return () => unsub();
    }, [chat?.id, message?.id]);

    const audience = useMemo(() => {
        // Audience = chat members minus the sender (author implicitly read).
        const members = Array.isArray(chat?.members) ? chat.members : [];
        return members.filter(m => m !== message?.senderName);
    }, [chat?.members, message?.senderName]);

    const ackedNames = useMemo(() => new Set(acks.map(a => a.userName)), [acks]);
    const pending = useMemo(() => audience.filter(n => !ackedNames.has(n)), [audience, ackedNames]);

    const total = audience.length;
    const done = acks.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const deadlineMs = message?.ackDeadline ? Date.parse(message.ackDeadline) : null;
    const deadlineLabel = deadlineMs
        ? new Date(deadlineMs).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : null;
    const overdue = deadlineMs && Date.now() > deadlineMs;

    async function handleNudge() {
        if (pending.length === 0 || nudging) return;
        if (!window.confirm(tx(
            `Send a reminder to ${pending.length} ${pending.length === 1 ? 'person' : 'people'}?`,
            `¿Enviar un recordatorio a ${pending.length} ${pending.length === 1 ? 'persona' : 'personas'}?`
        ))) return;
        setNudging(true);
        try {
            await Promise.all(pending.map(name =>
                notifyStaff({
                    forStaff: name,
                    type: 'announcement',
                    title: '⏰ ' + tx('Reminder: announcement awaiting ack', 'Recordatorio: anuncio sin acuse'),
                    body: (message?.text || '').slice(0, 140),
                    deepLink: 'chat',
                    link: '/chat',
                    tag: `nudge:${message.id}:${name}:${Date.now()}`,
                    createdBy: staffName,
                }).catch(() => {})
            ));
            recordAudit({
                action: 'chat.announcement.nudge',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'message',
                targetId: message?.id,
                details: { count: pending.length, chatId: chat?.id },
            });
            alert(tx('Reminders sent ✓', 'Recordatorios enviados ✓'));
        } catch (e) {
            console.warn('nudge failed:', e);
        } finally {
            setNudging(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div
                className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl flex flex-col max-h-[90vh] shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>

                <div className="px-4 py-3 border-b border-dd-line">
                    <div className="flex items-center justify-between">
                        <h2 className="text-lg font-black text-dd-text">📊 {tx('Read receipts', 'Acuses de recibo')}</h2>
                        <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                    </div>
                    {message?.text && (
                        <p className="mt-2 text-xs text-dd-text-2 line-clamp-2 italic">
                            "{message.text}"
                        </p>
                    )}
                </div>

                <div className="p-4 border-b border-dd-line">
                    <div className="flex items-baseline justify-between mb-2">
                        <div className="text-3xl font-black text-dd-text tabular-nums">
                            {done}<span className="text-lg text-dd-text-2">/{total}</span>
                        </div>
                        <div className="text-sm font-bold text-dd-text-2">{pct}% {tx('read', 'leído')}</div>
                    </div>
                    <div className="h-2 bg-dd-bg rounded-full overflow-hidden">
                        <div
                            className={`h-full transition-all ${pct === 100 ? 'bg-dd-green' : pct >= 75 ? 'bg-dd-green' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500'}`}
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                    {deadlineLabel && (
                        <p className={`mt-2 text-xs font-bold ${overdue ? 'text-red-700' : 'text-dd-text-2'}`}>
                            {overdue ? '🚨 ' : '⏰ '}
                            {tx('Deadline:', 'Plazo:')} {deadlineLabel}
                        </p>
                    )}
                </div>

                <div className="flex-1 overflow-y-auto">
                    {pending.length > 0 && (
                        <div>
                            <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-between">
                                <span className="text-[11px] font-black uppercase tracking-widest text-amber-800">
                                    {tx('Pending', 'Pendientes')} · {pending.length}
                                </span>
                                <button
                                    onClick={handleNudge}
                                    disabled={nudging}
                                    className="text-xs font-bold text-amber-800 hover:underline disabled:opacity-50"
                                >
                                    {nudging ? tx('Sending…', 'Enviando…') : tx('Send reminder →', 'Enviar recordatorio →')}
                                </button>
                            </div>
                            {pending.map(name => (
                                <div key={name} className="flex items-center gap-3 px-4 py-2 border-b border-dd-line/60">
                                    <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-amber-100 text-amber-700 text-[11px] font-black">
                                        {(name.split(' ').map(p => p[0]).slice(0, 2).join('') || '?').toUpperCase()}
                                    </span>
                                    <span className="flex-1 text-sm font-bold text-dd-text truncate">{name}</span>
                                    <span className="text-[11px] text-amber-700">{tx('Not yet', 'Aún no')}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {acks.length > 0 && (
                        <div>
                            <div className="px-4 py-2 bg-dd-sage-50 border-b border-dd-line">
                                <span className="text-[11px] font-black uppercase tracking-widest text-dd-green-700">
                                    {tx('Acknowledged', 'Confirmados')} · {acks.length}
                                </span>
                            </div>
                            {acks
                                .sort((a, b) => {
                                    const am = a.ackedAt?.toMillis?.() || 0;
                                    const bm = b.ackedAt?.toMillis?.() || 0;
                                    return bm - am;
                                })
                                .map(a => (
                                    <div key={a.id} className="flex items-center gap-3 px-4 py-2 border-b border-dd-line/60">
                                        <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-dd-green/15 text-dd-green-700 text-[11px] font-black">
                                            ✓
                                        </span>
                                        <span className="flex-1 text-sm font-bold text-dd-text truncate">{a.userName}</span>
                                        <span className="text-[11px] text-dd-text-2 tabular-nums">
                                            {formatAckTime(a.ackedAt)}
                                        </span>
                                    </div>
                                ))}
                        </div>
                    )}
                    {audience.length === 0 && (
                        <div className="p-6 text-center text-sm text-dd-text-2">
                            {tx('No audience.', 'Sin audiencia.')}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function formatAckTime(ts) {
    if (!ts) return '';
    const ms = ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : 0);
    if (!ms) return '';
    const d = new Date(ms);
    const sameDay = (new Date()).toDateString() === d.toDateString();
    return sameDay
        ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
