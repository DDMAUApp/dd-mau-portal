// ChatPinsDrawer — list of pinned messages in the active chat.
//
// Pins live as a field on the message doc (`pinned: true` + `pinnedBy`
// + `pinnedAt`). We render a small banner in ChatThread when ≥1 pin
// exists; tapping opens this drawer.
//
// Cap of 5 active pins per channel (configurable per-org later). Adding
// a 6th prompts the manager to unpin one first — keeps the banner from
// becoming a wall of text.

import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, orderBy, limit } from 'firebase/firestore';

export default function ChatPinsDrawer({
    chat, language = 'en', onClose, onJumpToMessage,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const [pins, setPins] = useState([]);

    useEffect(() => {
        if (!chat?.id) return;
        const q = query(
            collection(db, 'chats', chat.id, 'messages'),
            where('pinned', '==', true),
            orderBy('pinnedAt', 'desc'),
            limit(20),
        );
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setPins(list);
        }, (err) => console.warn('pins snapshot failed:', err));
        return () => unsub();
    }, [chat?.id]);

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl flex flex-col max-h-[80vh] shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between">
                    <h2 className="text-lg font-black text-dd-text">📌 {tx('Pinned messages', 'Mensajes fijados')}</h2>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {pins.length === 0 ? (
                        <div className="p-8 text-center text-sm text-dd-text-2">
                            {tx('No pins yet. Long-press a message to pin.', 'Sin mensajes fijados. Mantén presionado para fijar.')}
                        </div>
                    ) : (
                        pins.map(m => (
                            <button
                                key={m.id}
                                onClick={() => { onJumpToMessage?.(m.id); onClose(); }}
                                className="w-full text-left px-4 py-3 border-b border-dd-line/60 hover:bg-dd-bg"
                            >
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-dd-text-2">
                                        📌 {m.senderName}
                                    </span>
                                    <span className="text-[10px] text-dd-text-2">
                                        · {formatPinTime(m.pinnedAt)}
                                    </span>
                                </div>
                                <div className="text-sm text-dd-text line-clamp-3">
                                    {m.text || (m.type === 'image' ? '📷 Photo' : m.type === 'video' ? '🎬 Video' : m.type === 'audio' ? '🎤 Voice' : '—')}
                                </div>
                            </button>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

function formatPinTime(ts) {
    if (!ts) return '';
    const ms = ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : 0);
    if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
