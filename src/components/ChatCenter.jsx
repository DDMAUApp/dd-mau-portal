// ChatCenter — top-level chat tab.
//
// Two-pane layout:
//   ┌──────────────┬──────────────────────────┐
//   │ Chat list    │ Active chat thread       │
//   │ (~320px)     │ (flex-1)                 │
//   │  - search    │  - header (name, gear)   │
//   │  - + new     │  - messages              │
//   │  - channels  │  - input bar             │
//   │  - DMs/grps  │                          │
//   └──────────────┴──────────────────────────┘
//
// Mobile collapses to a single-pane SPA: list view ↔ thread view, with
// a back arrow to return.
//
// Subscribes to /chats where members contains-any [viewerName]. That
// includes channels (where members is recomputed each time staffList
// changes), DMs, and groups.
//
// Auto-channel sync runs on mount + on staffList change: it upserts
// the three /chats/channel_{key} docs so they always exist with
// up-to-date membership. Cheap (3 writes + only when membership drifts).

import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { db } from '../firebase';
import {
    collection, doc, query, where, onSnapshot,
    addDoc, setDoc, updateDoc, getDoc, getDocs,
    serverTimestamp, orderBy, limit, writeBatch,
} from 'firebase/firestore';
import {
    AUTO_CHANNELS, channelDocId, channelMembersFor, dmDocId,
    tierOf, canEditChat, previewOf, isChatUnread, formatChatTime,
} from '../data/chat';
import { canPostAnnouncements, canPostCoverageRequest, canDeleteChat } from '../data/chatPermissions';
import { recordAudit } from '../data/audit';

const ChatThread = lazy(() => import('./ChatThread'));
const ChatSettingsModal = lazy(() => import('./ChatSettingsModal'));
const ChatAnnouncementComposer = lazy(() => import('./ChatAnnouncementComposer'));
const ChatCoverageRequestModal = lazy(() => import('./ChatCoverageRequestModal'));
const ChatPhotoIssueModal = lazy(() => import('./ChatPhotoIssueModal'));
const ChatSearchPanel = lazy(() => import('./ChatSearchPanel'));
const ChatNotifSettings = lazy(() => import('./ChatNotifSettings'));

export default function ChatCenter({
    language = 'en',
    staffName = '',
    staffList = [],
    isAdmin = false,
    isManager = false,
    storeLocation = 'webster',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const viewer = useMemo(
        () => (staffList || []).find(s => s.name === staffName) || null,
        [staffList, staffName]
    );
    const viewerTier = useMemo(
        () => tierOf(viewer, isAdmin),
        [viewer, isAdmin]
    );

    // ── Chat list ─────────────────────────────────────────────────
    // Two queries: members array-contains me (groups + DMs the user is
    // in) UNION channels which the auto-sync below keeps me in. Single
    // listener per query; result lists are merged + deduped by id.
    const [chats, setChats] = useState([]);
    useEffect(() => {
        if (!staffName) return;
        // Firestore can't do "array-contains-any with OR another filter"
        // in one query, but we don't need it — channels are kept in the
        // members array by the sync logic below. So one query covers it.
        const q = query(
            collection(db, 'chats'),
            where('members', 'array-contains', staffName)
        );
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            // Sort: unread first (within unread, newest first),
            // then read by lastActivityAt desc.
            const ms = (ts) => ts?.toMillis ? ts.toMillis()
                : (ts?.seconds ? ts.seconds * 1000 : 0);
            list.sort((a, b) => {
                const ua = isChatUnread(a, staffName) ? 1 : 0;
                const ub = isChatUnread(b, staffName) ? 1 : 0;
                if (ua !== ub) return ub - ua;
                return ms(b.lastActivityAt) - ms(a.lastActivityAt);
            });
            setChats(list);
        }, (err) => console.warn('chats snapshot failed:', err));
        return () => unsub();
    }, [staffName]);

    // ── Auto-channel sync ─────────────────────────────────────────
    // On first mount + whenever staffList changes, make sure the three
    // channels exist and that their members[] reflects current roster.
    //
    // Idempotent: setDoc({ merge: true }) updates the membership array
    // without clobbering messages or other fields. Skipped if the
    // membership array hasn't changed (avoids needless writes).
    useEffect(() => {
        if (!Array.isArray(staffList) || staffList.length === 0) return;
        let cancelled = false;
        (async () => {
            for (const ch of AUTO_CHANNELS) {
                const id = channelDocId(ch.key);
                const ref = doc(db, 'chats', id);
                try {
                    const snap = await getDoc(ref);
                    const wantMembers = channelMembersFor(ch.key, staffList);
                    if (cancelled) return;
                    if (!snap.exists()) {
                        await setDoc(ref, {
                            type: 'channel',
                            channelKey: ch.key,
                            name: ch.name,
                            emoji: ch.emoji,
                            members: wantMembers,
                            admins: [],
                            createdBy: 'system',
                            createdByTier: 'admin',
                            editTier: 'admin',
                            createdAt: serverTimestamp(),
                            lastActivityAt: serverTimestamp(),
                        });
                    } else {
                        const cur = snap.data().members || [];
                        const same = cur.length === wantMembers.length
                            && cur.every(m => wantMembers.includes(m));
                        if (!same) {
                            await updateDoc(ref, { members: wantMembers });
                        }
                    }
                } catch (e) {
                    console.warn(`channel sync failed (${ch.key}):`, e);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [staffList]);

    // ── Mark chat notifications read on entering this tab ───────
    // The /notifications docs of type chat_message + chat_mention
    // drive the unread badge on the Chat tile + sidebar entry. We
    // mark them all read when the user enters ChatCenter — the
    // per-chat unread indicators below (lastReadByName) still drive
    // the WITHIN-list unread dots, so the user can still see which
    // CONVERSATIONS are unread even after entering the tab.
    useEffect(() => {
        if (!staffName) return;
        let cancelled = false;
        (async () => {
            try {
                const q = query(
                    collection(db, 'notifications'),
                    where('forStaff', '==', staffName),
                    where('read', '==', false),
                );
                const snap = await getDocs(q);
                if (cancelled) return;
                const chatDocs = [];
                snap.forEach(d => {
                    const t = d.data().type;
                    if (t === 'chat_message' || t === 'chat_mention') chatDocs.push(d.id);
                });
                if (chatDocs.length === 0) return;
                const batch = writeBatch(db);
                chatDocs.forEach(id => batch.update(doc(db, 'notifications', id), { read: true }));
                await batch.commit();
            } catch (e) {
                console.warn('mark-chat-read failed:', e);
            }
        })();
        return () => { cancelled = true; };
    }, [staffName]);

    // ── UI state ─────────────────────────────────────────────────
    const [activeChatId, setActiveChatId] = useState(null);
    const [search, setSearch] = useState('');
    const [showNewChat, setShowNewChat] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showAnnouncement, setShowAnnouncement] = useState(false);
    const [showCoverage, setShowCoverage] = useState(false);
    const [showIssue, setShowIssue] = useState(false);
    const [showSearchPanel, setShowSearchPanel] = useState(false);
    const [showNotifSettings, setShowNotifSettings] = useState(false);
    const [showActionMenu, setShowActionMenu] = useState(false);  // FAB expand
    const [longPressedChat, setLongPressedChat] = useState(null); // chat-list long-press action sheet

    const canAnnounce = canPostAnnouncements(viewer, isAdmin, isManager);
    const canCover = canPostCoverageRequest(viewer);

    const activeChat = useMemo(
        () => chats.find(c => c.id === activeChatId) || null,
        [chats, activeChatId]
    );

    // Mobile list-vs-thread switcher: if mobile + a chat is active, hide
    // the list. Desktop shows both panes always.
    const [mobileShowList, setMobileShowList] = useState(true);
    useEffect(() => {
        if (activeChatId) setMobileShowList(false);
    }, [activeChatId]);

    // ── Filtered list ─────────────────────────────────────────────
    const filteredChats = useMemo(() => {
        const term = search.trim().toLowerCase();
        if (!term) return chats;
        return chats.filter(c => {
            if (chatDisplayName(c, staffName).toLowerCase().includes(term)) return true;
            const preview = previewOf(c.lastMessage).toLowerCase();
            return preview.includes(term);
        });
    }, [chats, search, staffName]);

    return (
        <div className="flex h-[calc(100vh-160px)] md:h-[calc(100vh-130px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-3 md:-my-6 bg-white md:rounded-xl overflow-hidden">
            {/* ── LEFT PANE: chat list ──────────────────────────── */}
            <aside className={`${mobileShowList ? 'flex' : 'hidden'} md:flex flex-col w-full md:w-[340px] md:border-r border-dd-line bg-white shrink-0`}>
                {/* Header */}
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between bg-white shrink-0 gap-2">
                    <h1 className="text-[18px] font-black text-dd-text tracking-tight">
                        💬 {tx('Chat', 'Chat')}
                    </h1>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setShowSearchPanel(true)}
                            className="w-9 h-9 rounded-full hover:bg-dd-bg flex items-center justify-center text-lg"
                            aria-label={tx('Search', 'Buscar')}
                            title={tx('Search', 'Buscar')}
                        >
                            🔍
                        </button>
                        <button
                            onClick={() => setShowNotifSettings(true)}
                            className="w-9 h-9 rounded-full hover:bg-dd-bg flex items-center justify-center text-lg"
                            aria-label={tx('Notifications', 'Notificaciones')}
                            title={tx('Notifications', 'Notificaciones')}
                        >
                            🔔
                        </button>
                        <button
                            onClick={() => setShowActionMenu(true)}
                            className="w-9 h-9 rounded-full bg-dd-green text-white text-lg font-black flex items-center justify-center shadow-sm hover:bg-dd-green-700 active:scale-95 transition"
                            aria-label={tx('New', 'Nuevo')}
                        >
                            +
                        </button>
                    </div>
                </div>

                {/* Search */}
                <div className="px-3 py-2 border-b border-dd-line shrink-0">
                    <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={tx('Search chats…', 'Buscar chats…')}
                        className="w-full px-3 py-2 rounded-lg bg-dd-bg border border-dd-line text-sm text-dd-text placeholder:text-dd-text-2 focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green"
                    />
                </div>

                {/* Chat list */}
                <div className="flex-1 overflow-y-auto">
                    {filteredChats.length === 0 ? (
                        <div className="p-8 text-center text-sm text-dd-text-2">
                            {search
                                ? tx('No matches', 'Sin resultados')
                                : tx('No chats yet. Start one →', 'Aún no hay chats. Inicia uno →')}
                        </div>
                    ) : (
                        filteredChats.map(c => (
                            <ChatListItem
                                key={c.id}
                                chat={c}
                                viewerName={staffName}
                                active={c.id === activeChatId}
                                onClick={() => {
                                    setActiveChatId(c.id);
                                    setMobileShowList(false);
                                }}
                                onLongPress={() => setLongPressedChat(c)}
                                isEs={isEs}
                            />
                        ))
                    )}
                </div>
            </aside>

            {/* ── RIGHT PANE: active thread ─────────────────────── */}
            <section className={`${mobileShowList ? 'hidden' : 'flex'} md:flex flex-col flex-1 bg-dd-bg min-w-0`}>
                {activeChat ? (
                    <Suspense fallback={<div className="p-8 text-center text-sm text-dd-text-2">{tx('Loading…', 'Cargando…')}</div>}>
                        <ChatThread
                            key={activeChat.id}
                            chat={activeChat}
                            language={language}
                            staffName={staffName}
                            staffList={staffList}
                            isAdmin={isAdmin}
                            isManager={isManager}
                            viewer={viewer}
                            viewerTier={viewerTier}
                            onBack={() => { setActiveChatId(null); setMobileShowList(true); }}
                            onOpenSettings={() => setShowSettings(true)}
                        />
                    </Suspense>
                ) : (
                    <EmptyState isEs={isEs} onStart={() => setShowNewChat(true)} />
                )}
            </section>

            {/* ── New chat modal ─────────────────────────────── */}
            {showNewChat && (
                <NewChatModal
                    isEs={isEs}
                    staffName={staffName}
                    staffList={staffList}
                    viewer={viewer}
                    viewerTier={viewerTier}
                    isAdmin={isAdmin}
                    existingChats={chats}
                    onClose={() => setShowNewChat(false)}
                    onCreated={(chatId) => {
                        setShowNewChat(false);
                        setActiveChatId(chatId);
                        setMobileShowList(false);
                    }}
                />
            )}

            {/* ── Action menu (expanded "+" FAB) ───────────── */}
            {showActionMenu && (
                <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={() => setShowActionMenu(false)}>
                    <div className="bg-white w-full md:max-w-sm md:rounded-2xl rounded-t-2xl p-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
                        <div className="md:hidden flex justify-center pt-1 pb-2">
                            <div className="w-10 h-1 bg-dd-line rounded-full" />
                        </div>
                        <button
                            onClick={() => { setShowActionMenu(false); setShowNewChat(true); }}
                            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-dd-bg text-left"
                        >
                            <span className="text-2xl">💬</span>
                            <div className="flex-1">
                                <div className="font-black text-dd-text">{tx('New chat', 'Nuevo chat')}</div>
                                <div className="text-xs text-dd-text-2">{tx('Message a teammate or group', 'Mensaje a compañero o grupo')}</div>
                            </div>
                        </button>
                        {canAnnounce && (
                            <button
                                onClick={() => { setShowActionMenu(false); setShowAnnouncement(true); }}
                                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-dd-bg text-left"
                            >
                                <span className="text-2xl">📣</span>
                                <div className="flex-1">
                                    <div className="font-black text-dd-text">{tx('Announcement', 'Anuncio')}</div>
                                    <div className="text-xs text-dd-text-2">{tx('Broadcast, optional ack', 'Difundir, acuse opcional')}</div>
                                </div>
                            </button>
                        )}
                        {canCover && (
                            <button
                                onClick={() => { setShowActionMenu(false); setShowCoverage(true); }}
                                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-dd-bg text-left"
                            >
                                <span className="text-2xl">🙋</span>
                                <div className="flex-1">
                                    <div className="font-black text-dd-text">{tx('Request coverage', 'Pedir cobertura')}</div>
                                    <div className="text-xs text-dd-text-2">{tx('Need someone to take a shift', 'Necesitas que cubran un turno')}</div>
                                </div>
                            </button>
                        )}
                        <button
                            onClick={() => { setShowActionMenu(false); setShowIssue(true); }}
                            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-dd-bg text-left"
                        >
                            <span className="text-2xl">📸</span>
                            <div className="flex-1">
                                <div className="font-black text-dd-text">{tx('Report issue', 'Reportar problema')}</div>
                                <div className="text-xs text-dd-text-2">{tx('Broken equipment, supplies, safety', 'Equipo, suministros, seguridad')}</div>
                            </div>
                        </button>
                    </div>
                </div>
            )}

            {/* ── Feature modals (all lazy) ──────────────────── */}
            {showAnnouncement && (
                <Suspense fallback={null}>
                    <ChatAnnouncementComposer
                        language={language}
                        staffName={staffName}
                        staffList={staffList}
                        viewer={viewer}
                        isAdmin={isAdmin}
                        isManager={isManager}
                        onClose={() => setShowAnnouncement(false)}
                        onPosted={() => setShowAnnouncement(false)}
                    />
                </Suspense>
            )}
            {showCoverage && (
                <Suspense fallback={null}>
                    <ChatCoverageRequestModal
                        language={language}
                        staffName={staffName}
                        staffList={staffList}
                        viewer={viewer}
                        onClose={() => setShowCoverage(false)}
                        onPosted={({ chatId }) => {
                            setShowCoverage(false);
                            if (chatId) {
                                setActiveChatId(chatId);
                                setMobileShowList(false);
                            }
                        }}
                    />
                </Suspense>
            )}
            {showIssue && (
                <Suspense fallback={null}>
                    <ChatPhotoIssueModal
                        language={language}
                        staffName={staffName}
                        staffList={staffList}
                        viewer={viewer}
                        storeLocation={storeLocation}
                        onClose={() => setShowIssue(false)}
                        onPosted={() => setShowIssue(false)}
                    />
                </Suspense>
            )}
            {showSearchPanel && (
                <Suspense fallback={null}>
                    <ChatSearchPanel
                        chats={chats}
                        language={language}
                        staffName={staffName}
                        onClose={() => setShowSearchPanel(false)}
                        onJump={({ chatId }) => {
                            setShowSearchPanel(false);
                            setActiveChatId(chatId);
                            setMobileShowList(false);
                        }}
                    />
                </Suspense>
            )}
            {showNotifSettings && (
                <Suspense fallback={null}>
                    <ChatNotifSettings
                        chats={chats}
                        language={language}
                        staffName={staffName}
                        viewer={viewer}
                        onClose={() => setShowNotifSettings(false)}
                    />
                </Suspense>
            )}

            {/* ── Chat-list long-press action sheet ───────────── */}
            {longPressedChat && (
                <ChatListActionSheet
                    chat={longPressedChat}
                    viewer={viewer}
                    isAdmin={isAdmin}
                    staffName={staffName}
                    isEs={isEs}
                    onClose={() => setLongPressedChat(null)}
                    onDeleted={() => {
                        if (activeChatId === longPressedChat.id) setActiveChatId(null);
                        setLongPressedChat(null);
                    }}
                    onOpenSettings={() => {
                        setActiveChatId(longPressedChat.id);
                        setShowSettings(true);
                        setLongPressedChat(null);
                    }}
                />
            )}

            {/* ── Group settings modal ─────────────────────────── */}
            {showSettings && activeChat && (
                <Suspense fallback={null}>
                    <ChatSettingsModal
                        chat={activeChat}
                        language={language}
                        staffName={staffName}
                        staffList={staffList}
                        isAdmin={isAdmin}
                        viewer={viewer}
                        onClose={() => setShowSettings(false)}
                        onDeleted={() => {
                            setShowSettings(false);
                            setActiveChatId(null);
                            setMobileShowList(true);
                        }}
                    />
                </Suspense>
            )}
        </div>
    );
}

// ── Components below this line — keep ChatCenter tight, push detail
// renderers down. ──────────────────────────────────────────────────

// One row in the chat list. Avatar disc on the left (initials for DMs,
// emoji for channels/groups), name + preview in the middle, time +
// unread dot on the right.
function ChatListItem({ chat, viewerName, active, onClick, onLongPress, isEs }) {
    const name = chatDisplayName(chat, viewerName);
    const subtitle = previewOf(chat.lastMessage) || subtitleFor(chat, isEs);
    const unread = isChatUnread(chat, viewerName);
    const time = formatChatTime(chat.lastActivityAt);

    // Long-press timer for the row's action sheet. 500ms feels right —
    // shorter fires on sloppy taps, longer leaves the user wondering.
    //
    // Pattern: let onClick handle the tap (browser synthesizes it after
    // touchend). When long-press fires we set longPressFired.current so
    // the upcoming synthetic click is suppressed. Scroll cancels via
    // touchmove. Desktop right-click → onContextMenu also fires long-press.
    const pressTimer = useRef(null);
    const longPressFired = useRef(false);
    function pressStart() {
        longPressFired.current = false;
        pressTimer.current = setTimeout(() => {
            pressTimer.current = null;
            longPressFired.current = true;
            onLongPress?.();
        }, 500);
    }
    function pressCancel() {
        if (pressTimer.current) clearTimeout(pressTimer.current);
        pressTimer.current = null;
    }

    return (
        <button
            onClick={(e) => {
                if (longPressFired.current) {
                    // Synthetic click after a long-press — swallow it
                    // so we don't open the chat AND show the sheet.
                    longPressFired.current = false;
                    e.preventDefault();
                    return;
                }
                onClick?.();
            }}
            onTouchStart={pressStart}
            onTouchEnd={pressCancel}
            onTouchMove={pressCancel}
            onTouchCancel={pressCancel}
            onContextMenu={(e) => { e.preventDefault(); onLongPress?.(); }}
            className={`w-full flex items-start gap-3 px-3 py-3 border-b border-dd-line/60 text-left transition ${active ? 'bg-dd-sage-50' : 'hover:bg-dd-bg active:bg-dd-bg'}`}
        >
            <ChatAvatar chat={chat} viewerName={viewerName} size={44} />
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                    <span className={`truncate text-[14px] ${unread ? 'font-black text-dd-text' : 'font-bold text-dd-text'}`}>
                        {name}
                    </span>
                    <span className={`text-[11px] shrink-0 ${unread ? 'text-dd-green font-bold' : 'text-dd-text-2'}`}>
                        {time}
                    </span>
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className={`truncate text-[12.5px] ${unread ? 'text-dd-text font-semibold' : 'text-dd-text-2'}`}>
                        {subtitle}
                    </span>
                    {unread && (
                        <span className="shrink-0 w-2.5 h-2.5 rounded-full bg-dd-green" />
                    )}
                </div>
            </div>
        </button>
    );
}

// Avatar — channel emoji, group emoji, or DM initials. Stays a circle
// at every size; falls back to a sage-tinted background when no emoji.
export function ChatAvatar({ chat, viewerName, size = 40 }) {
    if (!chat) return null;
    const px = `${size}px`;
    const fontSize = `${Math.round(size * 0.46)}px`;
    if (chat.type === 'channel' || (chat.type === 'group' && chat.emoji)) {
        return (
            <span
                className="inline-flex items-center justify-center rounded-full bg-dd-sage-50 border border-dd-line shrink-0"
                style={{ width: px, height: px, fontSize }}
            >
                {chat.emoji || '👥'}
            </span>
        );
    }
    if (chat.type === 'group') {
        return (
            <span
                className="inline-flex items-center justify-center rounded-full bg-dd-charcoal text-white font-black shrink-0"
                style={{ width: px, height: px, fontSize: `${Math.round(size * 0.38)}px` }}
            >
                {((chat.name || '').slice(0, 2) || '?').toUpperCase()}
            </span>
        );
    }
    // DM — initials of the OTHER person.
    const other = (chat.members || []).find(m => m !== viewerName) || '?';
    const initials = other.split(' ').filter(Boolean).map(p => p[0]).slice(0, 2).join('').toUpperCase();
    return (
        <span
            className="inline-flex items-center justify-center rounded-full bg-dd-green text-white font-black shrink-0"
            style={{ width: px, height: px, fontSize: `${Math.round(size * 0.38)}px` }}
        >
            {initials || '?'}
        </span>
    );
}

// Display name for a chat from the viewer's perspective.
// DM → the OTHER person. Channel/group → their stored name.
export function chatDisplayName(chat, viewerName) {
    if (!chat) return '';
    if (chat.type === 'dm') {
        const other = (chat.members || []).find(m => m !== viewerName);
        return other || '(empty)';
    }
    return chat.name || '(unnamed)';
}

function subtitleFor(chat, isEs) {
    if (!chat) return '';
    if (chat.type === 'channel') return isEs ? 'Canal del equipo' : 'Team channel';
    if (chat.type === 'group') {
        const n = (chat.members || []).length;
        return isEs ? `${n} miembros` : `${n} members`;
    }
    return '';
}

function EmptyState({ isEs, onStart }) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <div className="text-6xl mb-4">💬</div>
            <div className="text-lg font-black text-dd-text mb-1">
                {isEs ? 'Elige un chat' : 'Pick a chat'}
            </div>
            <div className="text-sm text-dd-text-2 max-w-[280px] mb-4">
                {isEs
                    ? 'Mensajea a un compañero, un canal del equipo o crea un grupo.'
                    : 'Message a teammate, a team channel, or start a group.'}
            </div>
            <button
                onClick={onStart}
                className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm hover:bg-dd-green-700 active:scale-95 transition"
            >
                {isEs ? '+ Nuevo chat' : '+ New chat'}
            </button>
        </div>
    );
}

// Audience-filter predicate — pure helper used by NewChatModal's
// chip strip. Kept inline (not exported from chat.js) so the picker
// can mix role + location combinations without round-tripping through
// channelMembersFor's rule strings. Mirrors the same regex matches.
function matchesAudienceFilter(s, key) {
    if (!s || !key || key === 'all') return true;
    const role = s.role || '';
    const isFoh = s.scheduleSide === 'foh' || s.side === 'foh' || /foh|front|server|cashier|host|bartender/i.test(role);
    const isBoh = s.scheduleSide === 'boh' || s.side === 'boh' || /boh|kitchen|cook|prep|dish/i.test(role);
    const isMgr = s.id === 40 || s.id === 41 || /manager|owner/i.test(role);
    const atLoc = (loc) => s.location === loc || s.location === 'both';
    switch (key) {
        case 'foh':           return isFoh;
        case 'boh':           return isBoh;
        case 'managers':      return isMgr;
        case 'webster':       return atLoc('webster');
        case 'maryland':      return atLoc('maryland');
        case 'foh-webster':   return isFoh && atLoc('webster');
        case 'foh-maryland':  return isFoh && atLoc('maryland');
        case 'boh-webster':   return isBoh && atLoc('webster');
        case 'boh-maryland':  return isBoh && atLoc('maryland');
        default:              return true;
    }
}

// ── New chat modal ──────────────────────────────────────────────
// Three modes: DM (pick 1) / Group (pick 2+) / Cancel.
// Group mode reveals a name + emoji input AFTER picking members.
function NewChatModal({
    isEs, staffName, staffList, viewer, viewerTier, isAdmin,
    existingChats, onClose, onCreated,
}) {
    const tx = (en, es) => isEs ? es : en;
    const [picked, setPicked] = useState([]); // staff names
    const [groupName, setGroupName] = useState('');
    const [groupEmoji, setGroupEmoji] = useState('💬');
    const [filter, setFilter] = useState('');
    // Role / location quick-filter pills shown above the candidate
    // list. Default 'all' = no narrowing. Andrew asked for these so
    // building a group chat is one tap to "just FOH-Webster please".
    const [audienceFilter, setAudienceFilter] = useState('all');
    const [busy, setBusy] = useState(false);

    const candidates = useMemo(() => {
        // Location separation (2026-05-16): non-admin staff at a single
        // location only see same-location peers + 'both'-location staff
        // (owners + floaters). Admin sees everyone — they're the only
        // role allowed to start cross-location chats.
        const term = filter.trim().toLowerCase();
        const myLoc = viewer?.location;
        const sameLocation = (s) => {
            if (isAdmin) return true;             // admin sees all locations
            if (!myLoc || myLoc === 'both') return true; // floaters/admins
            if (s.location === 'both') return true;     // 'both' staff visible to everyone
            return s.location === myLoc;
        };
        return (staffList || [])
            .filter(s => s.name && s.name !== staffName)
            .filter(sameLocation)
            .filter(s => matchesAudienceFilter(s, audienceFilter))
            .filter(s => !term || s.name.toLowerCase().includes(term))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [staffList, staffName, filter, viewer, isAdmin, audienceFilter]);

    // Filter pills available to this viewer. Cross-location pills only
    // surface for admins (or floaters with location 'both') since
    // non-admin Webster staff never see Maryland candidates and a
    // "Maryland" pill would render an empty list.
    const filterChips = useMemo(() => {
        const myLoc = viewer?.location;
        const showCross = isAdmin || myLoc === 'both' || !myLoc;
        const base = [
            { key: 'all',       label: tx('All', 'Todos'),       emoji: '👥' },
            { key: 'foh',       label: 'FOH',                    emoji: '🪑' },
            { key: 'boh',       label: 'BOH',                    emoji: '👩‍🍳' },
            { key: 'managers',  label: tx('Mgrs', 'Gerentes'),   emoji: '🧑‍💼' },
        ];
        const cross = [
            { key: 'webster',      label: 'Webster',      emoji: '🏠' },
            { key: 'maryland',     label: 'Maryland',     emoji: '🏠' },
            { key: 'foh-webster',  label: 'FOH · Webster',  emoji: '🪑' },
            { key: 'foh-maryland', label: 'FOH · Maryland', emoji: '🪑' },
            { key: 'boh-webster',  label: 'BOH · Webster',  emoji: '👩‍🍳' },
            { key: 'boh-maryland', label: 'BOH · Maryland', emoji: '👩‍🍳' },
        ];
        return showCross ? [...base, ...cross] : base;
    }, [isEs, isAdmin, viewer]);

    const mode = picked.length <= 1 ? 'dm' : 'group';

    function toggle(name) {
        setPicked(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
    }

    async function handleCreate() {
        if (picked.length === 0 || busy) return;
        setBusy(true);
        try {
            if (mode === 'dm') {
                // Use deterministic DM id so re-opening DM stays in same thread.
                const other = picked[0];
                const id = dmDocId(staffName, other);
                const ref = doc(db, 'chats', id);
                const snap = await getDoc(ref);
                if (!snap.exists()) {
                    await setDoc(ref, {
                        type: 'dm',
                        members: [staffName, other],
                        admins: [],
                        createdBy: staffName,
                        createdByTier: viewerTier,
                        editTier: 'admin', // DMs aren't editable; nominal floor
                        createdAt: serverTimestamp(),
                        lastActivityAt: serverTimestamp(),
                    });
                }
                onCreated(id);
            } else {
                // Group create — fill in editTier from creator's role tier.
                const finalName = groupName.trim() || picked.slice(0, 3).join(', ');
                const ref = await addDoc(collection(db, 'chats'), {
                    type: 'group',
                    name: finalName,
                    emoji: groupEmoji,
                    members: [staffName, ...picked],
                    admins: [], // creator is implicit admin via createdBy
                    createdBy: staffName,
                    createdByTier: viewerTier,
                    editTier: viewerTier,
                    createdAt: serverTimestamp(),
                    lastActivityAt: serverTimestamp(),
                });
                onCreated(ref.id);
            }
        } catch (e) {
            console.warn('NewChatModal create failed:', e);
            alert(isEs ? 'No se pudo crear el chat.' : 'Could not create chat.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div
                className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl flex flex-col max-h-[88vh] md:max-h-[80vh] shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Drag handle (mobile) */}
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>
                {/* Header */}
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between">
                    <h2 className="text-lg font-black text-dd-text">
                        {isEs ? 'Nuevo chat' : 'New chat'}
                    </h2>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center text-dd-text-2">
                        ✕
                    </button>
                </div>

                {/* Picked chips */}
                {picked.length > 0 && (
                    <div className="px-3 py-2 border-b border-dd-line flex flex-wrap gap-1.5">
                        {picked.map(n => (
                            <button
                                key={n}
                                onClick={() => toggle(n)}
                                className="px-2 py-1 rounded-full bg-dd-sage-50 border border-dd-green/30 text-xs font-bold text-dd-green-700 flex items-center gap-1"
                            >
                                {n} <span className="text-dd-green-700/60">×</span>
                            </button>
                        ))}
                    </div>
                )}

                {/* Group name + emoji (only when ≥2 picked) */}
                {mode === 'group' && (
                    <div className="px-3 py-2 border-b border-dd-line space-y-2 bg-dd-bg/40">
                        <div className="flex items-center gap-2">
                            <EmojiPicker value={groupEmoji} onChange={setGroupEmoji} />
                            <input
                                type="text"
                                value={groupName}
                                onChange={(e) => setGroupName(e.target.value)}
                                placeholder={isEs ? 'Nombre del grupo' : 'Group name'}
                                className="flex-1 px-3 py-2 rounded-lg bg-white border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                                maxLength={40}
                            />
                        </div>
                        <div className="text-[11px] text-dd-text-2 px-1">
                            {isEs
                                ? `Solo ${viewerTier === 'admin' ? 'admins' : viewerTier === 'manager' ? 'managers y admins' : 'tú y los admins'} podrán editar este grupo.`
                                : `Only ${viewerTier === 'admin' ? 'admins' : viewerTier === 'manager' ? 'managers and admins' : 'you and admins'} can edit this group.`}
                        </div>
                    </div>
                )}

                {/* Audience filter pills — horizontal scrollable strip
                    so "FOH Webster only" / "BOH Maryland only" / etc.
                    is one tap. Cross-location pills hidden for
                    non-admin staff at a single location. */}
                <div className="px-3 pt-2 pb-1 border-b border-dd-line/60 shrink-0 overflow-x-auto scrollbar-thin">
                    <div className="flex gap-1.5 w-max">
                        {filterChips.map(c => (
                            <button
                                key={c.key}
                                onClick={() => setAudienceFilter(c.key)}
                                className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold border transition active:scale-95 ${audienceFilter === c.key
                                    ? 'bg-dd-green text-white border-dd-green shadow-sm'
                                    : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}
                            >
                                <span>{c.emoji}</span>
                                <span>{c.label}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Search */}
                <div className="px-3 py-2 border-b border-dd-line shrink-0">
                    <input
                        type="search"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder={isEs ? 'Buscar persona…' : 'Search staff…'}
                        className="w-full px-3 py-2 rounded-lg bg-dd-bg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                    />
                </div>

                {/* Candidate list */}
                <div className="flex-1 overflow-y-auto">
                    {candidates.map(s => {
                        const on = picked.includes(s.name);
                        return (
                            <button
                                key={s.name}
                                onClick={() => toggle(s.name)}
                                className="w-full flex items-center gap-3 px-3 py-2.5 border-b border-dd-line/60 hover:bg-dd-bg text-left"
                            >
                                <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-dd-charcoal text-white text-sm font-black shrink-0">
                                    {(s.name.split(' ').map(p => p[0]).slice(0, 2).join('') || '?').toUpperCase()}
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-sm font-bold text-dd-text truncate">{s.name}</span>
                                    {s.role && (
                                        <span className="block text-[11px] text-dd-text-2 truncate">{s.role}</span>
                                    )}
                                </span>
                                <span className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${on ? 'bg-dd-green border-dd-green text-white' : 'border-dd-line'}`}>
                                    {on ? '✓' : ''}
                                </span>
                            </button>
                        );
                    })}
                    {candidates.length === 0 && (
                        <div className="px-4 py-8 text-center text-sm text-dd-text-2">
                            {isEs ? 'Sin resultados' : 'No matches'}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-3 py-3 border-t border-dd-line flex items-center justify-between gap-3 shrink-0">
                    <span className="text-xs text-dd-text-2">
                        {picked.length === 0
                            ? (isEs ? 'Elige al menos 1 persona' : 'Pick at least 1 person')
                            : (mode === 'dm'
                                ? (isEs ? 'Mensaje directo (1 a 1)' : 'Direct message (1-on-1)')
                                : `${isEs ? 'Grupo' : 'Group'} · ${picked.length + 1} ${isEs ? 'miembros' : 'members'}`)}
                    </span>
                    <button
                        onClick={handleCreate}
                        disabled={picked.length === 0 || busy}
                        className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-dd-green-700"
                    >
                        {busy ? (isEs ? 'Creando…' : 'Creating…') : (isEs ? 'Crear' : 'Create')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Tiny emoji popover for group icon. Not exhaustive — just the most
// useful "team" emoji so it's a single tap to pick something fitting.
function EmojiPicker({ value, onChange }) {
    const [open, setOpen] = useState(false);
    const opts = ['💬', '👥', '🍜', '🍣', '🥗', '🔥', '🧊', '🎉', '⭐', '📣', '🪑', '👩‍🍳', '🧹', '🚚', '💰', '🚨'];
    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="w-10 h-10 rounded-lg bg-white border border-dd-line text-xl flex items-center justify-center shrink-0 hover:bg-dd-bg"
            >
                {value}
            </button>
            {open && (
                <div className="absolute top-full left-0 mt-1 z-10 bg-white border border-dd-line rounded-xl shadow-lg p-2 grid grid-cols-8 gap-1 w-[280px]">
                    {opts.map(e => (
                        <button
                            key={e}
                            type="button"
                            onClick={() => { onChange(e); setOpen(false); }}
                            className="w-8 h-8 rounded hover:bg-dd-bg text-lg flex items-center justify-center"
                        >
                            {e}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Action sheet for chat-list long-press ───────────────────────
// Bottom-sheet on mobile, centered modal on desktop. Shows the chat
// title up top and a list of actions — currently Delete + Open
// settings (more later: mute, pin-to-top, mark-read).
//
// Delete here = soft delete (clear members + set deletedAt). The
// settings modal has the danger-zone for hard-delete and channel-
// reset cases.
function ChatListActionSheet({ chat, viewer, isAdmin, staffName, isEs, onClose, onDeleted, onOpenSettings }) {
    const tx = (en, es) => isEs ? es : en;
    const [busy, setBusy] = useState(false);
    const candelete = canDeleteChat(chat, viewer, isAdmin);
    const name = chatDisplayName(chat, staffName);

    async function handleDelete() {
        if (!candelete || busy) return;
        const typeLabel = chat.type === 'channel'
            ? tx('channel (will auto-recreate)', 'canal (se recreará)')
            : chat.type === 'dm'
            ? tx('DM', 'DM')
            : tx('chat', 'chat');
        if (!window.confirm(tx(
            `Delete this ${typeLabel}? Disappears for everyone. Messages stay in audit log.`,
            `¿Eliminar este ${typeLabel}? Desaparece para todos. Mensajes en log.`
        ))) return;
        setBusy(true);
        try {
            await updateDoc(doc(db, 'chats', chat.id), {
                members: [],
                deletedAt: serverTimestamp(),
                deletedBy: staffName,
            });
            recordAudit({
                action: 'chat.delete.soft',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'chat',
                targetId: chat.id,
                details: {
                    chatType: chat.type,
                    chatName: chat.name || null,
                    channelKey: chat.channelKey || null,
                    via: 'long_press',
                },
            });
            onDeleted();
        } catch (e) {
            console.warn('chat delete failed:', e);
            alert(tx('Delete failed', 'Error al eliminar'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div className="bg-white w-full md:max-w-sm md:rounded-2xl rounded-t-2xl p-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="md:hidden flex justify-center pt-1 pb-2">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>
                <div className="px-3 py-2 border-b border-dd-line mb-1">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-dd-text-2">{tx('Chat actions', 'Acciones')}</div>
                    <div className="text-sm font-black text-dd-text truncate">{name}</div>
                </div>
                <button
                    onClick={onOpenSettings}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-dd-bg text-left"
                >
                    <span className="text-xl">👥</span>
                    <span className="flex-1">
                        <span className="block font-bold text-dd-text">{tx('Manage members', 'Gestionar miembros')}</span>
                        <span className="block text-[11px] text-dd-text-2">{tx('Add or remove staff, rename, etc.', 'Añadir/quitar, renombrar, etc.')}</span>
                    </span>
                </button>
                {candelete && (
                    <button
                        onClick={handleDelete}
                        disabled={busy}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-red-50 text-left text-red-700 font-bold disabled:opacity-50"
                    >
                        <span className="text-xl">🗑</span>
                        <span>{busy ? tx('Deleting…', 'Eliminando…') : tx('Delete chat', 'Eliminar chat')}</span>
                    </button>
                )}
                <button
                    onClick={onClose}
                    className="w-full px-4 py-3 mt-1 text-sm font-bold text-dd-text-2 border-t border-dd-line"
                >
                    {tx('Cancel', 'Cancelar')}
                </button>
            </div>
        </div>
    );
}
