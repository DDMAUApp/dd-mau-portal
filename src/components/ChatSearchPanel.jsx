// ChatSearchPanel — global search across all chats the viewer is in.
//
// v1 is client-side: we read up to N most-recent messages from every
// chat the viewer is a member of, then substring-match. Good enough
// for a few hundred messages per chat (kitchen ops chats are short-
// lived). For 10k+ messages we'd swap to Algolia / Typesense via the
// Firestore extension — schema already supports it via searchTokens.
//
// Filters:
//   • text query — substring (case-insensitive)
//   • from-user
//   • date range (last 7 days / last 30 / all)
//   • has-media (image/video/audio)
//   • is-announcement / is-coverage / is-issue

import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { chatDisplayName, ChatAvatar } from './ChatShared';
import { expandQueryTerms, buildHaystack, haystackMatches } from '../data/chatSearch';

export default function ChatSearchPanel({
    chats, language = 'en', staffName, viewer, onClose, onJump,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    // Note: we intentionally don't render a Translate chip in search
    // results. The result snippet uses <mark> highlighting on the
    // query term, which would conflict with TranslatableText's body
    // swap. The user taps a result to jump into the chat thread,
    // where the chip works normally with no UX clash. (Considered + ruled
    // out 2026-05-17.)

    const [q, setQ] = useState('');
    const [fromUser, setFromUser] = useState('');
    const [dateRange, setDateRange] = useState('30d');   // 7d | 30d | all
    const [hasMedia, setHasMedia] = useState(false);
    const [typeFilter, setTypeFilter] = useState('any'); // any|announcement|coverage_request|photo_issue

    // Load recent messages from every chat the viewer can see.
    //
    // 2026-05-24 audit fix: was mounting 25 SIMULTANEOUS onSnapshot
    // listeners (one per chat) × limit(200) each = up to 5,000 live
    // message docs streamed while the search panel is open. Every
    // new message in ANY of those 25 chats kicked a snapshot tick +
    // a setState — across 30 staff using search, that's hundreds of
    // listeners against Firestore. Search is not real-time anyway —
    // user opens it, types, taps a result, closes it. One-shot
    // getDocs per chat is the right tool. Parallelized via
    // Promise.all so the panel still feels instant on open.
    const [messagesByChat, setMessagesByChat] = useState({});  // chatId -> [msg]
    const [loading, setLoading] = useState(false);
    useEffect(() => {
        if (!Array.isArray(chats) || chats.length === 0) return;
        let cancelled = false;
        const cutoff = dateRange === '7d' ? Date.now() - 7 * 86400_000
                     : dateRange === '30d' ? Date.now() - 30 * 86400_000
                     : 0;
        setLoading(true);
        const targets = chats.slice(0, 25);
        Promise.all(targets.map(async chat => {
            try {
                const ref = query(
                    collection(db, 'chats', chat.id, 'messages'),
                    orderBy('createdAt', 'desc'),
                    limit(200),
                );
                const snap = await getDocs(ref);
                const list = [];
                snap.forEach(d => {
                    const data = { id: d.id, chatId: chat.id, ...d.data() };
                    const ms = data.createdAt?.toMillis ? data.createdAt.toMillis()
                        : (data.createdAt?.seconds ? data.createdAt.seconds * 1000 : 0);
                    if (!cutoff || ms >= cutoff) list.push(data);
                });
                return [chat.id, list];
            } catch (e) {
                console.warn('search read failed for chat', chat.id, e);
                return [chat.id, []];
            }
        })).then(pairs => {
            if (cancelled) return;
            const map = {};
            for (const [id, list] of pairs) map[id] = list;
            setMessagesByChat(map);
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, [chats, dateRange]);

    // Pre-expand the query into [{term, expansions:Set}] once per
    // query-input change. Each token must match SOME synonym in the
    // message's haystack for the message to appear (AND across tokens,
    // OR across synonyms — see chatSearch.haystackMatches).
    const expandedTokens = useMemo(() => expandQueryTerms(q), [q]);

    const allResults = useMemo(() => {
        const out = [];
        for (const [chatId, list] of Object.entries(messagesByChat)) {
            const chat = chats.find(c => c.id === chatId);
            if (!chat) continue;
            for (const m of list) {
                // Type filter
                if (typeFilter !== 'any') {
                    if (typeFilter === 'announcement' && m.type !== 'announcement') continue;
                    if (typeFilter === 'coverage_request' && m.type !== 'coverage_request') continue;
                    if (typeFilter === 'photo_issue' && m.type !== 'photo_issue') continue;
                }
                // Media filter
                if (hasMedia && !m.mediaUrl) continue;
                // From user
                if (fromUser && m.senderName !== fromUser) continue;
                // Smart text match — builds a normalized haystack from
                // the message's text + sender + poll Q+options + reply
                // snippet + type label, then checks every query token
                // against the union of its bilingual synonyms. So
                // searching "chicken" finds Spanish "pollo" messages,
                // and searching "photo" finds image messages even when
                // the caption is blank.
                if (expandedTokens.length > 0) {
                    const hay = buildHaystack(m);
                    if (!haystackMatches(hay, expandedTokens)) continue;
                }
                out.push({ message: m, chat });
            }
        }
        out.sort((a, b) => {
            const ams = a.message.createdAt?.toMillis ? a.message.createdAt.toMillis() : 0;
            const bms = b.message.createdAt?.toMillis ? b.message.createdAt.toMillis() : 0;
            return bms - ams;
        });
        return out.slice(0, 200);
    }, [messagesByChat, chats, expandedTokens, fromUser, hasMedia, typeFilter]);

    // Build the from-user dropdown from messages we've seen
    const senderOptions = useMemo(() => {
        const set = new Set();
        for (const list of Object.values(messagesByChat)) {
            for (const m of list) if (m.senderName) set.add(m.senderName);
        }
        return Array.from(set).sort();
    }, [messagesByChat]);

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-stretch md:items-center justify-center" onClick={onClose}>
            {/* Container — full-screen on mobile (h-full bounded between
                top: 0 and bottom: 0), modal-sized on md+.  Padding-bottom
                accounts for the iPhone home indicator so the result list
                doesn't slide under it on devices with a long swipe-bar.
                Andrew (2026-05-17): "the search bar is too high and the
                back arrow is un reachable" — was caused by the header
                having no env(safe-area-inset-top) padding, so on iPhone
                X+ the ← button and the input were both sitting under
                the notch / status bar. Added the safe-area inline style
                on the header below to push it clear. */}
            <div
                className="bg-white w-full md:max-w-lg md:rounded-2xl md:max-h-[88vh] h-full md:h-auto flex flex-col shadow-xl overflow-hidden"
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-4 py-3 border-b border-dd-line flex items-center gap-3 shrink-0"
                     style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}>
                    <button onClick={onClose}
                        className="w-9 h-9 rounded-full hover:bg-dd-bg flex items-center justify-center text-lg shrink-0"
                        aria-label={tx('Back', 'Atrás')}>
                        ←
                    </button>
                    <input
                        type="search"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        autoFocus
                        placeholder={tx('Search messages…', 'Buscar mensajes…')}
                        className="flex-1 px-3 py-2 rounded-lg bg-dd-bg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                    />
                </div>

                {/* Filter strip */}
                <div className="px-3 py-2 border-b border-dd-line flex gap-2 overflow-x-auto scrollbar-thin shrink-0">
                    <select
                        value={dateRange}
                        onChange={(e) => setDateRange(e.target.value)}
                        className="px-2 py-1 rounded-full bg-dd-bg border border-dd-line text-xs font-bold shrink-0"
                    >
                        <option value="7d">{tx('Last 7d', 'Últimos 7d')}</option>
                        <option value="30d">{tx('Last 30d', 'Últimos 30d')}</option>
                        <option value="all">{tx('All time', 'Todo')}</option>
                    </select>
                    <select
                        value={fromUser}
                        onChange={(e) => setFromUser(e.target.value)}
                        className="px-2 py-1 rounded-full bg-dd-bg border border-dd-line text-xs font-bold shrink-0"
                    >
                        <option value="">{tx('Anyone', 'Cualquiera')}</option>
                        {senderOptions.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <select
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value)}
                        className="px-2 py-1 rounded-full bg-dd-bg border border-dd-line text-xs font-bold shrink-0"
                    >
                        <option value="any">{tx('Any type', 'Cualquier tipo')}</option>
                        <option value="announcement">📣 {tx('Announcements', 'Anuncios')}</option>
                        <option value="coverage_request">🙋 {tx('Coverage', 'Cobertura')}</option>
                        <option value="photo_issue">📸 {tx('Issues', 'Problemas')}</option>
                    </select>
                    <button
                        onClick={() => setHasMedia(m => !m)}
                        className={`px-3 py-1 rounded-full text-xs font-bold shrink-0 border ${hasMedia ? 'bg-dd-green text-white border-dd-green' : 'bg-dd-bg text-dd-text-2 border-dd-line'}`}
                    >
                        📎 {tx('Has media', 'Con media')}
                    </button>
                </div>

                {/* Result list — same overscroll-contain + touch-action
                    pattern as NotificationsDrawer so pull-down past
                    the top of the list doesn't bleed into the page
                    underneath and trigger iOS pull-to-refresh / the
                    chunk-reload safety net. */}
                <div
                    className="flex-1 min-h-0 overflow-y-auto"
                    style={{
                        overscrollBehavior: 'contain',
                        WebkitOverflowScrolling: 'touch',
                        touchAction: 'pan-y',
                    }}
                >
                    {allResults.length === 0 ? (
                        <div className="p-8 text-center text-sm text-dd-text-2">
                            {q.trim()
                                ? tx('No matches.', 'Sin resultados.')
                                : tx('Type to search across your chats.', 'Escribe para buscar en tus chats.')}
                        </div>
                    ) : (
                        allResults.map(({ message, chat }) => (
                            <button
                                key={`${chat.id}_${message.id}`}
                                onClick={() => onJump?.({ chatId: chat.id, messageId: message.id })}
                                className="w-full flex items-start gap-3 px-3 py-3 border-b border-dd-line/60 hover:bg-dd-bg text-left"
                            >
                                <ChatAvatar chat={chat} viewerName={staffName} size={32} />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="text-[12.5px] font-black text-dd-text truncate">
                                            {chatDisplayName(chat, staffName)}
                                        </span>
                                        <span className="text-[10px] text-dd-text-2 shrink-0">
                                            {formatSearchTime(message.createdAt)}
                                        </span>
                                    </div>
                                    <div className="text-[11px] font-bold text-dd-text-2">{message.senderName}</div>
                                    <div className="text-[13px] text-dd-text line-clamp-2 mt-0.5">
                                        {highlight(message.text || (message.type === 'image' ? '📷 Photo' : message.type === 'audio' ? '🎤 Voice' : message.type), q)}
                                    </div>
                                </div>
                            </button>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}

function highlight(text, q) {
    const term = q.trim();
    if (!term || !text) return text;
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    const parts = String(text).split(re);
    return parts.map((p, i) => i % 2 === 1
        ? <mark key={i} className="bg-amber-100 text-dd-text">{p}</mark>
        : <span key={i}>{p}</span>);
}

function formatSearchTime(ts) {
    if (!ts) return '';
    const ms = ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : 0);
    if (!ms) return '';
    const d = new Date(ms);
    const diff = Date.now() - ms;
    if (diff < 86400_000) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
