// ─────────────────────────────────────────────────────────────────
// ChatHistoryAdmin — admin-only read-only view of every chat in the
// system + every message in those chats. Used by the owner (Andrew)
// to audit staff conversations after-the-fact — useful for HR
// reviews, dispute resolution, and spot-checking that channels are
// being used appropriately.
//
// Lives behind the AdminPanel "💬 Chat History" collapsible. Only
// renders when expanded (lazy import in AdminPanel.jsx) so the
// initial-load query cost is zero for admins who never open it.
//
// Posture vs. ChatCenter.jsx:
//   • ChatCenter filters chats by `where('members', 'array-contains',
//     staffName)` — only chats the viewer participates in.
//   • ChatHistoryAdmin DOES NOT filter — it loads every chat. This
//     is the whole point of the view, and the Firestore catch-all
//     rule allows reads, so no security gate to dodge.
//   • Strictly read-only — no send, edit, delete, react, pin, or
//     poll-vote affordances. Messages are rendered as plain text +
//     a type badge so special types (poll/coverage/86/photo-issue)
//     are still readable but not actionable.
// ─────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
// previewOf turns a chat doc's `lastMessage` OBJECT (senderName/type/
// text/deleted/etc.) into a display string. Important: lastMessage is
// NOT a string — initial version of this file assumed it was and
// crashed with "(t.lastMessage||'').trim is not a function" because
// the OR-fallback returns the object itself.
import { previewOf } from '../data/chat';

export default function ChatHistoryAdmin({ language, staffName }) {
    const isEs = language === 'es';
    const [chats, setChats] = useState(null);  // null = loading
    const [loadError, setLoadError] = useState(null);
    const [typeFilter, setTypeFilter] = useState('all');
    const [searchTerm, setSearchTerm] = useState('');
    const [openChat, setOpenChat] = useState(null);  // chat doc | null

    // Load all chats once on mount. Sort by lastActivityAt desc client-
    // side — most chats have it but some legacy docs may not, so we
    // can't trust a single Firestore orderBy.
    useEffect(() => {
        let cancelled = false;
        setChats(null);
        setLoadError(null);
        const colRef = collection(db, 'chats');
        // 500 cap — DD Mau historically has fewer than 100 active
        // chats. If we ever blow past 500, add pagination.
        getDocs(query(colRef, limit(500)))
            .then(snap => {
                if (cancelled) return;
                const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                // Sort by lastActivityAt (Firestore Timestamp) desc.
                // Fall back to createdAt, then doc id as last resort so
                // missing timestamps don't crash sort.
                list.sort((a, b) => {
                    const am = tsMs(a.lastActivityAt) || tsMs(a.createdAt) || 0;
                    const bm = tsMs(b.lastActivityAt) || tsMs(b.createdAt) || 0;
                    return bm - am;
                });
                setChats(list);
            })
            .catch(err => {
                if (cancelled) return;
                console.warn('ChatHistoryAdmin load failed:', err);
                setLoadError(err?.message || (isEs ? 'Error al cargar' : 'Failed to load'));
                setChats([]);
            });
        return () => { cancelled = true; };
    }, [isEs]);

    const filtered = useMemo(() => {
        const list = chats || [];
        const t = typeFilter;
        const q = searchTerm.trim().toLowerCase();
        return list.filter(c => {
            if (t !== 'all' && (c.type || 'channel') !== t) return false;
            if (!q) return true;
            const hay = [
                c.name || '',
                previewOf(c.lastMessage),
                (c.members || []).join(' '),
                c.createdBy || '',
                c.type || '',
            ].join(' ').toLowerCase();
            return hay.includes(q);
        });
    }, [chats, typeFilter, searchTerm]);

    const totalCount = chats?.length ?? 0;
    const counts = useMemo(() => {
        const out = { all: 0, channel: 0, dm: 0, group: 0, announcement: 0, other: 0 };
        for (const c of (chats || [])) {
            out.all++;
            const t = c.type || 'channel';
            if (out[t] !== undefined) out[t]++;
            else out.other++;
        }
        return out;
    }, [chats]);

    return (
        <div>
            <p className="text-[11px] text-gray-500 mb-3">
                {isEs
                    ? 'Vista de auditoría: lista todos los chats (canales, DMs, grupos, anuncios) y sus mensajes. Solo lectura. Incluye conversaciones privadas — usa con cuidado.'
                    : 'Audit view: lists every chat (channels, DMs, groups, announcements) and their messages. Read-only. Includes private conversations — use with care.'}
            </p>

            {/* Filter chips */}
            <div className="flex flex-wrap gap-1.5 mb-2 text-[11px]">
                {[
                    { k: 'all', en: 'All', es: 'Todos' },
                    { k: 'channel', en: 'Channels', es: 'Canales' },
                    { k: 'dm', en: 'DMs', es: 'Directos' },
                    { k: 'group', en: 'Groups', es: 'Grupos' },
                    { k: 'announcement', en: 'Announcements', es: 'Anuncios' },
                ].map(f => (
                    <button key={f.k} onClick={() => setTypeFilter(f.k)}
                        className={`px-2 py-1 rounded-md font-bold border ${typeFilter === f.k
                            ? 'bg-indigo-700 text-white border-indigo-700'
                            : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}>
                        {isEs ? f.es : f.en}
                        <span className="ml-1 opacity-60">{counts[f.k] ?? 0}</span>
                    </button>
                ))}
            </div>

            {/* Search */}
            <input type="text" value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={isEs ? 'Buscar por nombre, miembro o último mensaje…' : 'Search by name, member, or last message…'}
                className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-[12px] bg-white mb-2" />

            {/* Status line */}
            <div className="flex items-center justify-between text-[10px] text-gray-500 mb-2">
                <span>
                    {chats === null
                        ? (isEs ? 'Cargando…' : 'Loading…')
                        : `${filtered.length} ${isEs ? 'de' : 'of'} ${totalCount}`}
                </span>
                {loadError && (
                    <span className="text-red-700 font-bold">⚠️ {loadError}</span>
                )}
            </div>

            {/* Chat list */}
            {chats === null ? null : filtered.length === 0 ? (
                <div className="text-[12px] text-gray-400 italic px-2 py-4 text-center">
                    {searchTerm || typeFilter !== 'all'
                        ? (isEs ? 'Sin coincidencias.' : 'No matches.')
                        : (isEs ? 'No hay chats todavía.' : 'No chats yet.')}
                </div>
            ) : (
                <div className="space-y-1.5 max-h-[60vh] overflow-y-auto"
                    style={{ overscrollBehavior: 'contain' }}>
                    {filtered.map(c => (
                        <ChatRow key={c.id} chat={c} isEs={isEs}
                            onOpen={() => setOpenChat(c)} />
                    ))}
                </div>
            )}

            {openChat && (
                <ChatHistoryViewerModal
                    chat={openChat}
                    language={language}
                    onClose={() => setOpenChat(null)} />
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────
// ChatRow — one row in the chat list. Click to open the read-only
// thread viewer modal.
// ─────────────────────────────────────────────────────────────────
function ChatRow({ chat, isEs, onOpen }) {
    const typeLabel = chatTypeLabel(chat.type, isEs);
    const typeColor = chatTypeColor(chat.type);
    const memberCount = Array.isArray(chat.members) ? chat.members.length : 0;
    const lastTime = formatRelativeTime(chat.lastActivityAt || chat.createdAt, isEs);
    // lastMessage is an OBJECT — use previewOf to convert to display string.
    const lastPreview = previewOf(chat.lastMessage);
    const displayName = chat.name || (chat.type === 'dm' && memberCount > 0
        ? chat.members.join(' ↔ ')
        : (isEs ? '(sin nombre)' : '(unnamed)'));

    return (
        <button onClick={onOpen}
            className="w-full text-left px-3 py-2 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition">
            <div className="flex items-start gap-2">
                <div className="text-lg flex-shrink-0">
                    {chat.emoji || defaultEmojiForType(chat.type)}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[13px] font-bold text-gray-900 truncate">
                            {displayName}
                        </span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${typeColor}`}>
                            {typeLabel}
                        </span>
                        {chat.deletedAt && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700">
                                {isEs ? 'BORRADO' : 'DELETED'}
                            </span>
                        )}
                    </div>
                    {lastPreview && (
                        <div className="text-[11px] text-gray-600 truncate mt-0.5">
                            {lastPreview}
                        </div>
                    )}
                    <div className="text-[10px] text-gray-400 mt-0.5">
                        {memberCount} {isEs ? 'miembros' : 'members'} · {lastTime}
                    </div>
                </div>
            </div>
        </button>
    );
}

// ─────────────────────────────────────────────────────────────────
// ChatHistoryViewerModal — full message history for one chat. Loads
// up to 500 most-recent messages (oldest-first ordering so admin
// reads top-to-bottom like a normal conversation). Search filters
// in-thread by sender name or message text.
// ─────────────────────────────────────────────────────────────────
function ChatHistoryViewerModal({ chat, language, onClose }) {
    const isEs = language === 'es';
    const [messages, setMessages] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        let cancelled = false;
        setMessages(null);
        setLoadError(null);
        const colRef = collection(db, 'chats', chat.id, 'messages');
        // 500-msg window. Most chats are well under that. If we ever
        // need older history, add a "Load more" pager that walks
        // startAfter the oldest loaded message.
        getDocs(query(colRef, orderBy('createdAt', 'desc'), limit(500)))
            .then(snap => {
                if (cancelled) return;
                // Reverse so oldest is at top (normal reading order).
                const list = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
                setMessages(list);
            })
            .catch(err => {
                if (cancelled) return;
                console.warn('ChatHistoryViewerModal load failed:', err);
                setLoadError(err?.message || (isEs ? 'Error al cargar mensajes' : 'Failed to load messages'));
                setMessages([]);
            });
        return () => { cancelled = true; };
    }, [chat.id, isEs]);

    const filtered = useMemo(() => {
        const list = messages || [];
        const q = searchTerm.trim().toLowerCase();
        if (!q) return list;
        return list.filter(m => {
            const hay = [
                m.senderName || '',
                m.text || '',
                m.type || '',
                (m.eightySixData?.itemName) || '',
                (m.poll?.question) || '',
            ].join(' ').toLowerCase();
            return hay.includes(q);
        });
    }, [messages, searchTerm]);

    const displayName = chat.name || (chat.type === 'dm' && chat.members?.length > 0
        ? chat.members.join(' ↔ ')
        : (isEs ? '(sin nombre)' : '(unnamed)'));

    return (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end md:items-center justify-center"
            onClick={onClose}>
            <div className="bg-white w-full md:max-w-2xl md:rounded-2xl rounded-t-2xl flex flex-col max-h-[92vh] shadow-xl"
                onClick={(e) => e.stopPropagation()}
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-gray-300 rounded-full" />
                </div>
                <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-indigo-50">
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-lg">{chat.emoji || defaultEmojiForType(chat.type)}</span>
                            <h2 className="text-base font-black text-indigo-900 truncate">
                                {displayName}
                            </h2>
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${chatTypeColor(chat.type)}`}>
                                {chatTypeLabel(chat.type, isEs)}
                            </span>
                        </div>
                        <p className="text-[11px] text-indigo-800 truncate">
                            {(chat.members || []).length} {isEs ? 'miembros' : 'members'}
                            {chat.members?.length > 0 && `: ${chat.members.slice(0, 5).join(', ')}${chat.members.length > 5 ? '…' : ''}`}
                        </p>
                    </div>
                    <button onClick={onClose}
                        className="w-8 h-8 rounded-full hover:bg-white/60 flex items-center justify-center text-gray-700 ml-2 flex-shrink-0">
                        ✕
                    </button>
                </div>

                {/* Search */}
                <div className="px-4 pt-2 pb-2 border-b border-gray-200">
                    <input type="text" value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder={isEs ? 'Buscar en este chat…' : 'Search in this chat…'}
                        className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm bg-white" />
                </div>

                {/* Message list */}
                <div className="flex-1 overflow-y-auto p-3 space-y-2"
                    style={{ overscrollBehavior: 'contain' }}>
                    {messages === null && (
                        <div className="text-[12px] text-gray-400 italic px-2 py-3">
                            {isEs ? 'Cargando mensajes…' : 'Loading messages…'}
                        </div>
                    )}
                    {loadError && (
                        <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-[12px] text-red-700">
                            ⚠️ {loadError}
                        </div>
                    )}
                    {messages && filtered.length === 0 && (
                        <div className="text-[12px] text-gray-400 italic px-2 py-3 text-center">
                            {searchTerm
                                ? (isEs ? 'Sin coincidencias.' : 'No matches.')
                                : (isEs ? 'No hay mensajes.' : 'No messages.')}
                        </div>
                    )}
                    {filtered.map(m => (
                        <MessageRow key={m.id} message={m} isEs={isEs} />
                    ))}
                </div>

                <div className="px-4 py-2 border-t border-gray-200 text-[10px] text-gray-500 text-center">
                    {isEs
                        ? 'Mostrando hasta 500 mensajes más recientes. Solo lectura.'
                        : 'Showing up to 500 most-recent messages. Read-only.'}
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────
// MessageRow — read-only render of a single message. Handles every
// type that ChatThread sends: text, media (image/video/audio),
// poll, announcement, eighty_six_alert, coverage_request, etc.
// Special types just show "[Poll] question text" — for forensic
// audit we just need to know it happened + who/when/what.
// ─────────────────────────────────────────────────────────────────
function MessageRow({ message, isEs }) {
    const time = formatFullTimestamp(message.createdAt, isEs);
    const sender = message.senderName || (isEs ? '(desconocido)' : '(unknown)');
    const body = renderMessageBody(message, isEs);
    const reactions = Object.entries(message.reactions || {})
        .filter(([, names]) => Array.isArray(names) && names.length > 0);

    return (
        <div className="px-3 py-2 rounded-lg bg-gray-50 border border-gray-200">
            <div className="flex items-baseline justify-between gap-2 mb-0.5">
                <span className="text-[12px] font-bold text-gray-900 truncate">
                    {sender}
                </span>
                <span className="text-[10px] text-gray-500 flex-shrink-0">
                    {time}
                </span>
            </div>
            {body}
            <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500">
                {message.edited && (
                    <span className="italic">{isEs ? 'editado' : 'edited'}</span>
                )}
                {message.pinned && (
                    <span className="text-amber-700 font-bold">📌 {isEs ? 'fijado' : 'pinned'}</span>
                )}
                {reactions.length > 0 && (
                    <span className="flex items-center gap-1">
                        {reactions.map(([emoji, names]) => (
                            <span key={emoji} className="px-1 rounded bg-white border border-gray-200">
                                {emoji} {names.length}
                            </span>
                        ))}
                    </span>
                )}
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────
// Renderers per message type. Returns a React node — keep all of
// these read-only-display only (no buttons, no interactions).
// ─────────────────────────────────────────────────────────────────
function renderMessageBody(m, isEs) {
    if (m.deleted) {
        return (
            <div className="text-[12px] text-gray-400 italic">
                {isEs ? '(mensaje eliminado por ' : '(message deleted by '}
                {m.deletedBy || '?'})
            </div>
        );
    }
    const t = m.type || 'text';
    if (t === 'image' || t === 'video') {
        return (
            <div>
                {m.mediaUrl ? (
                    t === 'image' ? (
                        <img src={m.mediaUrl} alt=""
                            className="max-h-40 rounded border border-gray-200" />
                    ) : (
                        <video src={m.mediaUrl} controls
                            className="max-h-40 rounded border border-gray-200" />
                    )
                ) : (
                    <span className="text-[12px] text-gray-500">
                        [{t}] {isEs ? '(sin url)' : '(no url)'}
                    </span>
                )}
                {m.text && (
                    <div className="text-[12px] text-gray-700 mt-1">{m.text}</div>
                )}
            </div>
        );
    }
    if (t === 'audio') {
        return (
            <div>
                {m.mediaUrl ? (
                    <audio src={m.mediaUrl} controls className="w-full" />
                ) : (
                    <span className="text-[12px] text-gray-500">
                        [audio] {isEs ? '(sin url)' : '(no url)'}
                    </span>
                )}
                {m.duration && (
                    <span className="text-[10px] text-gray-500 ml-2">
                        {Math.round(m.duration)}s
                    </span>
                )}
            </div>
        );
    }
    if (t === 'poll') {
        const opts = m.poll?.options || [];
        const votes = m.poll?.votes || {};
        return (
            <div>
                <div className="text-[10px] font-bold text-purple-700 uppercase tracking-wide">
                    [{isEs ? 'Encuesta' : 'Poll'}]
                </div>
                <div className="text-[12px] font-bold text-gray-900">{m.poll?.question}</div>
                <div className="mt-1 space-y-0.5">
                    {opts.map(o => (
                        <div key={o.id} className="text-[11px] text-gray-700">
                            • {o.label}
                            <span className="text-gray-500 ml-1">
                                ({(votes[o.id] || []).length})
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    if (t === 'announcement') {
        return (
            <div>
                <div className="text-[10px] font-bold text-amber-700 uppercase tracking-wide">
                    [{isEs ? 'Anuncio' : 'Announcement'}]
                </div>
                <div className="text-[12px] text-gray-900 whitespace-pre-wrap">
                    {m.text || ''}
                </div>
            </div>
        );
    }
    if (t === 'eighty_six_alert') {
        const d = m.eightySixData || {};
        return (
            <div>
                <div className="text-[10px] font-bold text-red-700 uppercase tracking-wide">
                    [86 {d.transition || ''}]
                </div>
                <div className="text-[12px] text-gray-900">
                    {d.itemName || '?'} {d.location ? `· ${d.location}` : ''}
                </div>
                {d.note && <div className="text-[11px] text-gray-600">"{d.note}"</div>}
            </div>
        );
    }
    if (t === 'coverage_request') {
        const d = m.coverageData || {};
        return (
            <div>
                <div className="text-[10px] font-bold text-blue-700 uppercase tracking-wide">
                    [{isEs ? 'Cobertura' : 'Coverage'}]
                </div>
                <div className="text-[12px] text-gray-900">
                    {d.date || ''} {d.startTime || ''}–{d.endTime || ''}
                </div>
                {d.note && <div className="text-[11px] text-gray-600">{d.note}</div>}
                {d.claimedBy && (
                    <div className="text-[11px] text-green-700 font-bold">
                        ✓ {isEs ? 'Tomado por' : 'Claimed by'} {d.claimedBy}
                    </div>
                )}
            </div>
        );
    }
    if (t === 'photo_issue') {
        return (
            <div>
                <div className="text-[10px] font-bold text-orange-700 uppercase tracking-wide">
                    [{isEs ? 'Foto/Issue' : 'Photo issue'}]
                </div>
                {m.mediaUrl && (
                    <img src={m.mediaUrl} alt=""
                        className="max-h-40 rounded border border-gray-200" />
                )}
                {m.text && <div className="text-[12px] text-gray-700 mt-1">{m.text}</div>}
            </div>
        );
    }
    // Default: plain text (or fallback for unknown type)
    return (
        <div className="text-[13px] text-gray-900 whitespace-pre-wrap break-words">
            {m.text || (
                <span className="italic text-gray-400">
                    [{t}] {isEs ? '(sin texto)' : '(no text)'}
                </span>
            )}
        </div>
    );
}

// ── helpers ────────────────────────────────────────────────────────
function tsMs(ts) {
    if (!ts) return 0;
    if (ts.toMillis) return ts.toMillis();
    if (ts.seconds) return ts.seconds * 1000;
    if (typeof ts === 'string') {
        const d = new Date(ts);
        return isNaN(d.getTime()) ? 0 : d.getTime();
    }
    if (typeof ts === 'number') return ts;
    return 0;
}

function formatRelativeTime(ts, isEs) {
    const ms = tsMs(ts);
    if (!ms) return isEs ? 'nunca' : 'never';
    const diffSec = (Date.now() - ms) / 1000;
    if (diffSec < 60) return isEs ? 'ahora' : 'now';
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h`;
    const d = new Date(ms);
    if (diffSec < 86400 * 7) {
        return d.toLocaleDateString(isEs ? 'es' : 'en',
            { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString(isEs ? 'es' : 'en',
        { month: 'short', day: 'numeric', year: '2-digit' });
}

function formatFullTimestamp(ts, isEs) {
    const ms = tsMs(ts);
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleString(isEs ? 'es' : 'en', {
        month: 'short', day: 'numeric', year: '2-digit',
        hour: 'numeric', minute: '2-digit',
    });
}

function chatTypeLabel(type, isEs) {
    switch (type) {
        case 'dm': return isEs ? 'DIRECTO' : 'DM';
        case 'group': return isEs ? 'GRUPO' : 'GROUP';
        case 'announcement': return isEs ? 'ANUNCIO' : 'ANNOUNCE';
        case 'eighty_six_alert': return '86';
        case 'coverage_request': return isEs ? 'COBERTURA' : 'COVERAGE';
        case 'channel':
        default: return isEs ? 'CANAL' : 'CHANNEL';
    }
}

function chatTypeColor(type) {
    switch (type) {
        case 'dm': return 'bg-purple-100 text-purple-700';
        case 'group': return 'bg-green-100 text-green-700';
        case 'announcement': return 'bg-amber-100 text-amber-700';
        case 'eighty_six_alert': return 'bg-red-100 text-red-700';
        case 'coverage_request': return 'bg-blue-100 text-blue-700';
        case 'channel':
        default: return 'bg-indigo-100 text-indigo-700';
    }
}

function defaultEmojiForType(type) {
    switch (type) {
        case 'dm': return '💬';
        case 'group': return '👥';
        case 'announcement': return '📣';
        case 'eighty_six_alert': return '🚫';
        case 'coverage_request': return '🆘';
        case 'channel':
        default: return '#️⃣';
    }
}
