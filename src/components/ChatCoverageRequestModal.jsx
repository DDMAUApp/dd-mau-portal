// ChatCoverageRequestModal — staff requests coverage for their shift.
//
// Posted by a staff member who needs someone to take their shift. The
// modal lets them:
//   1. Pick the shift they need covered (auto-loads next 14 days of
//      their published shifts)
//   2. Add an optional note ("kid sick")
//   3. Pick which channel to post into (defaults to their location's
//      role channel — #foh-webster, etc.)
//
// On submit, writes a coverage_request message into the channel. The
// CoverageRequestCard renderer in ChatThread handles claim + approval
// state from there.
//
// State machine (mirrored on the message doc):
//   open → claimed → approved (closed)
//                  ↘ denied (re-open)
//        → expired (auto, 2h before shift)
//        → withdrawn (requester cancels)

import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import {
    collection, query, where, onSnapshot, addDoc, doc,
    serverTimestamp, updateDoc,
} from 'firebase/firestore';
import { recordAudit } from '../data/audit';
import { notifyStaff } from '../data/notify';
import { channelDocId } from '../data/chat';

export default function ChatCoverageRequestModal({
    language = 'en', staffName, staffList, viewer, onClose, onPosted,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const [myShifts, setMyShifts] = useState([]);
    const [pickedShiftId, setPickedShiftId] = useState('');
    const [note, setNote] = useState('');
    const [channelKey, setChannelKey] = useState('');
    const [busy, setBusy] = useState(false);

    // Load my next 14 days of published shifts.
    useEffect(() => {
        if (!staffName) return;
        const today = new Date();
        const cutoff = new Date(today);
        cutoff.setDate(cutoff.getDate() + 14);
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const q = query(
            collection(db, 'shifts'),
            where('staffName', '==', staffName),
            where('date', '>=', fmt(today)),
            where('date', '<', fmt(cutoff))
        );
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            list.sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
            // Only published, non-deleted shifts.
            setMyShifts(list.filter(s => s.published !== false && !s.deleted));
        }, (err) => console.warn('coverage: my-shifts snapshot failed:', err));
        return () => unsub();
    }, [staffName]);

    const pickedShift = useMemo(
        () => myShifts.find(s => s.id === pickedShiftId) || null,
        [myShifts, pickedShiftId]
    );

    // Auto-pick the target channel based on the shift's side + location.
    useEffect(() => {
        if (!pickedShift) return;
        const side = pickedShift.side === 'boh' ? 'boh' : 'foh';
        setChannelKey(side);
    }, [pickedShift]);

    if (myShifts.length === 0) {
        return (
            <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onClose}>
                <div className="bg-white rounded-xl p-6 max-w-sm" onClick={(e) => e.stopPropagation()}>
                    <h2 className="text-lg font-black mb-2">🙋 {tx('No upcoming shifts', 'Sin turnos próximos')}</h2>
                    <p className="text-sm text-dd-text-2 mb-4">
                        {tx("You don't have any published shifts in the next 14 days to request coverage for.",
                            'No tienes turnos publicados en los próximos 14 días.')}
                    </p>
                    <button onClick={onClose} className="px-4 py-2 bg-dd-bg rounded font-bold text-sm">{tx('Close', 'Cerrar')}</button>
                </div>
            </div>
        );
    }

    async function handlePost() {
        if (!pickedShift || busy) return;
        setBusy(true);
        try {
            const chatId = channelDocId(channelKey);

            const msgRef = await addDoc(collection(db, 'chats', chatId, 'messages'), {
                senderName: staffName,
                senderId: viewer?.id || null,
                type: 'coverage_request',
                text: note.trim() || '',
                linkedShiftId: pickedShift.id,
                shiftSnapshot: {
                    date: pickedShift.date,
                    startTime: pickedShift.startTime,
                    endTime: pickedShift.endTime,
                    side: pickedShift.side,
                    location: pickedShift.location,
                    role: pickedShift.role || null,
                },
                coverageStatus: 'open',         // state machine field
                requesterId: staffName,
                claimedBy: null,
                claimedAt: null,
                approvedBy: null,
                approvedAt: null,
                reactions: {},
                mentions: [],
                createdAt: serverTimestamp(),
            });

            await updateDoc(doc(db, 'chats', chatId), {
                lastMessage: {
                    text: `🙋 ${staffName} ${tx('needs coverage', 'necesita cobertura')} — ${pickedShift.date}`,
                    sender: staffName,
                    ts: serverTimestamp(),
                    type: 'coverage_request',
                },
                lastActivityAt: serverTimestamp(),
                [`lastReadByName.${staffName}`]: serverTimestamp(),
            });

            recordAudit({
                action: 'chat.coverage.request',
                actorName: staffName,
                actorId: viewer?.id,
                actorRole: viewer?.role,
                targetType: 'shift',
                targetId: pickedShift.id,
                details: {
                    messageId: msgRef.id,
                    chatId,
                    date: pickedShift.date,
                    side: pickedShift.side,
                    location: pickedShift.location,
                    note: note.trim(),
                },
            });

            // Notify eligible channel members.
            // TODO multi-tenant: pull from channel members; for v1 we
            // notify role-matched peers at the same location.
            const eligible = (staffList || [])
                .filter(s => s.name !== staffName)
                .filter(s => s.hideFromSchedule !== true)
                .filter(s => {
                    const side = (s.scheduleSide || s.side || '').toLowerCase();
                    if (pickedShift.side === 'foh' && side === 'boh') return false;
                    if (pickedShift.side === 'boh' && side === 'foh') return false;
                    if (s.location !== 'both' && pickedShift.location !== s.location && pickedShift.location !== 'both') return false;
                    return true;
                })
                .map(s => s.name);

            await Promise.all(eligible.map(name =>
                notifyStaff({
                    forStaff: name,
                    type: 'coverage_request',
                    title: '🙋 ' + tx('Coverage needed', 'Cobertura necesaria'),
                    body: `${staffName} · ${pickedShift.date} ${pickedShift.startTime}-${pickedShift.endTime}`,
                    deepLink: 'chat',
                    link: '/chat',
                    tag: `coverage:${msgRef.id}:${name}`,
                    createdBy: staffName,
                }).catch(() => {})
            ));

            onPosted?.({ messageId: msgRef.id, chatId });
        } catch (e) {
            console.error('coverage request failed:', e);
            alert(tx('Send failed', 'Error al enviar'));
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
                        <h2 className="text-lg font-black text-dd-text">🙋 {tx('Request Coverage', 'Pedir Cobertura')}</h2>
                        <p className="text-[11px] text-dd-text-2">{tx('Ask a teammate to take your shift', 'Pide a un compañero que tome tu turno')}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Shift picker */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Which shift?', '¿Qué turno?')}
                        </label>
                        <div className="space-y-2">
                            {myShifts.map(s => (
                                <button
                                    key={s.id}
                                    onClick={() => setPickedShiftId(s.id)}
                                    className={`w-full text-left px-3 py-2.5 rounded-lg border-2 transition ${pickedShiftId === s.id
                                        ? 'border-dd-green bg-dd-sage-50'
                                        : 'border-dd-line hover:bg-dd-bg'}`}
                                >
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="text-sm font-black text-dd-text">
                                                {new Date(s.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                                            </div>
                                            <div className="text-xs text-dd-text-2">
                                                {s.startTime}–{s.endTime} · {(s.side || 'foh').toUpperCase()} · {s.location === 'maryland' ? 'Maryland' : 'Webster'}
                                            </div>
                                        </div>
                                        {pickedShiftId === s.id && <span className="text-dd-green text-lg">✓</span>}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Note */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Optional note', 'Nota opcional')}
                        </label>
                        <input
                            type="text"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder={tx('e.g. kid is sick', 'p.ej. niño enfermo')}
                            maxLength={140}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                        />
                    </div>

                    {/* Channel info */}
                    {pickedShift && (
                        <div className="px-3 py-2 rounded-lg bg-dd-bg border border-dd-line text-xs text-dd-text-2">
                            {tx('Will post in', 'Se publicará en')}: <b>{channelKey === 'foh' ? '🪑 Front of House' : '👩‍🍳 Back of House'}</b> · {tx('eligible teammates will be notified.', 'compañeros elegibles serán notificados.')}
                        </div>
                    )}
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex items-center justify-between gap-3 shrink-0">
                    <button onClick={onClose} className="px-3 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={handlePost}
                        disabled={busy || !pickedShift}
                        className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-dd-green-700"
                    >
                        {busy ? tx('Posting…', 'Publicando…') : tx('🙋 Post Request', '🙋 Publicar Petición')}
                    </button>
                </div>
            </div>
        </div>
    );
}
