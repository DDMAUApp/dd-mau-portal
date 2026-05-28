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

import { useState, useEffect, useMemo, useRef, useCallback, memo, lazy, Suspense, useDeferredValue } from 'react';
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
// 2026-05-27 — breadcrumb every chat-open + chat-back so the Sentry
// timeline panel shows what the user did before any chat-related
// error. Tiny, in-memory ring buffer; attached to the next error_logs
// row and to every Sentry event. See src/data/logger.js for the ring.
import { breadcrumb } from '../data/logger';
import { ChatAvatar, chatDisplayName } from './ChatShared';
import { recordAudit } from '../data/audit';
import { toast } from '../toast';

// Lazy children. Andrew 2026-05-23: use the explicit `.then(m =>
// ({ default: m.default }))` form instead of bare `lazy(() =>
// import(...))`. The bare form is what Safari was TDZ-erroring on
// ("Cannot access 'C' before initialization") — Vite was bundling it
// as `import('./X.js').then(t => t.C)` where `C` is a generated
// namespace-wrapper export. Some interaction with ChatThread's
// chunk (which ALSO re-exports TranslatableText as `T`, so the chunk
// has two namespace-wrapper exports `C` and `T`) made Safari throw
// TDZ on the `C` access when the lazy fired. App.jsx already uses
// the explicit `.then(m => ({default: m.default}))` form for every
// other route and none of those crash — adopting it here forces Vite
// to access `m.default` directly, sidestepping the wrapper entirely.
// Don't revert to the bare form without re-running the Safari crash
// repro.
const ChatThread = lazy(() => import('./ChatThread').then(m => ({ default: m.default })));
const ChatSettingsModal = lazy(() => import('./ChatSettingsModal').then(m => ({ default: m.default })));
const ChatAnnouncementComposer = lazy(() => import('./ChatAnnouncementComposer').then(m => ({ default: m.default })));
const ChatCoverageRequestModal = lazy(() => import('./ChatCoverageRequestModal').then(m => ({ default: m.default })));
const ChatPhotoIssueModal = lazy(() => import('./ChatPhotoIssueModal').then(m => ({ default: m.default })));
const ChatSearchPanel = lazy(() => import('./ChatSearchPanel').then(m => ({ default: m.default })));
const ChatNotifSettings = lazy(() => import('./ChatNotifSettings').then(m => ({ default: m.default })));

export default function ChatCenter({
    language = 'en',
    staffName = '',
    staffList = [],
    setStaffList,
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
    // 2026-05-27 — load/error UX state. Andrew: "about half the time
    // the separate chats do not load the first time." Root cause of
    // the chat LIST half of that bug: the onSnapshot error handler was
    // a silent console.warn. A transient permission-denied / network
    // error killed the subscription and left the user with an empty
    // chat list with no indication anything went wrong. Now we surface
    // load state + error state so the user can retry without a refresh.
    const [chatsLoading, setChatsLoading] = useState(true);
    const [chatsError, setChatsError] = useState(null);
    const [chatsSubGen, setChatsSubGen] = useState(0);
    // 2026-05-28 audit fix (Audit #1): one-way staffListReady gate.
    // Before this, the chats query fired as soon as `staffName` was
    // restored from sessionStorage — even if the live `/config/staff`
    // snapshot hadn't landed yet. On weak Wi-Fi that gap can run
    // 1–3s. If the staff member was renamed/deactivated since their
    // last session, the query ran with a stale identity and returned
    // empty, presenting as "my chats didn't load." Waiting on a
    // non-empty staffList ensures the chats query runs only after
    // the roster is confirmed.
    //
    // staffListReady is intentionally a one-way edge (length > 0)
    // included in the dep array, NOT staffList itself. Tracking the
    // full array would cause re-subscription on every roster snapshot
    // (~once per minute of normal admin activity), creating WebSocket
    // churn for no benefit. We only need to re-fire when the gate
    // flips false → true.
    const staffListReady = Array.isArray(staffList) && staffList.length > 0;
    useEffect(() => {
        if (!staffName) return;
        if (!staffListReady) return;
        // Firestore can't do "array-contains-any with OR another filter"
        // in one query, but we don't need it — channels are kept in the
        // members array by the sync logic below. So one query covers it.
        // Audit 2026-05-22 fix: cap at 100 chats. Was unbounded.
        // The ideal would be orderBy(lastActivityAt desc) + limit(100)
        // 2026-05-24 audit fix: previously `limit(100)` alone — meant
        // Firestore returned WHATEVER 100 chats the query plan picked,
        // NOT the most-recent 100. A user in 105+ chats would silently
        // miss 5 with no UI indication. Now adds `orderBy(lastActivityAt, desc)`
        // so the cap consistently keeps the freshest chats. Composite
        // index defined in firestore.indexes.json (members + lastActivityAt).
        setChatsLoading(true);
        setChatsError(null);
        const timeoutId = setTimeout(() => {
            // 6s on the chat list is more generous than the 8s on the
            // message thread — chat list is the primary surface so a
            // slow-network signal here matters more.
            setChatsError((prev) => prev || 'timeout');
            setChatsLoading(false);
        }, 6000);
        const q = query(
            collection(db, 'chats'),
            where('members', 'array-contains', staffName),
            orderBy('lastActivityAt', 'desc'),
            limit(100),
        );
        const unsub = onSnapshot(q, (snap) => {
            clearTimeout(timeoutId);
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
            setChatsLoading(false);
            setChatsError(null);
        }, (err) => {
            clearTimeout(timeoutId);
            console.warn('chats snapshot failed:', err);
            setChatsError(err?.code || err?.message || 'load-failed');
            setChatsLoading(false);
        });
        return () => {
            clearTimeout(timeoutId);
            unsub();
        };
    }, [staffName, chatsSubGen, staffListReady]);

    // Retry handler — bumps chatsSubGen to re-fire the subscription
    // effect with a fresh listener. The error-state UI's Retry button
    // calls this. Most chat-snapshot failures are transient (network
    // hiccup, Firestore re-establishing its WebSocket); a retry tap
    // recovers cleanly.
    const retryChatsLoad = useCallback(() => {
        setChatsError(null);
        setChatsLoading(true);
        setChatsSubGen(g => g + 1);
    }, []);

    // ── Auto-channel sync ─────────────────────────────────────────
    // On first mount + whenever staffList changes, make sure the
    // canonical channels exist and that their members[] reflects the
    // current roster.
    //
    // 2026-05-16 — Andrew deleted a channel and it kept coming back.
    // Two delete states the sync now respects so a delete sticks:
    //   1. SOFT-DELETED chat doc (deletedAt is set) — leave it alone;
    //      do NOT repopulate the members array.
    //   2. HARD-DELETED — the chat doc is gone. We check a tombstone
    //      collection (/chats_purged/{channelKey}). If a tombstone
    //      exists, do NOT recreate the chat doc.
    // Both delete sites (settings modal + chat-list action sheet) now
    // write the tombstone on hard-delete and skip-on-soft naturally
    // works because deletedAt is set.
    //
    // To bring a system channel back, an admin can delete its
    // tombstone in /chats_purged via Firestore console (or via a
    // "Restore channel" UI — out of v1 scope).
    useEffect(() => {
        if (!Array.isArray(staffList) || staffList.length === 0) return;
        let cancelled = false;
        (async () => {
            for (const ch of AUTO_CHANNELS) {
                const id = channelDocId(ch.key);
                const ref = doc(db, 'chats', id);
                const tombRef = doc(db, 'chats_purged', id);
                try {
                    // Tombstone check first — if hard-deleted, never recreate.
                    const tombSnap = await getDoc(tombRef);
                    if (cancelled) return;
                    if (tombSnap.exists()) continue;

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
                        const data = snap.data();
                        // Soft-deleted — leave it alone. Repopulating
                        // would resurrect the channel for everyone.
                        if (data.deletedAt) continue;
                        const cur = data.members || [];
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

    // ── One-shot admin migration: purge all auto-created channels ───
    // 2026-05-16 — Andrew asked us to nuke the system channels we
    // created so he can build his own groups from scratch. Runs once
    // per admin device (idempotent + localStorage-gated). Each
    // channel gets a soft-delete (members: [], deletedAt) PLUS a
    // tombstone in /chats_purged so the auto-sync can never resurrect
    // them. Custom groups (type=group) and DMs are untouched.
    useEffect(() => {
        if (!isAdmin || !staffName) return;
        const FLAG_KEY = 'ddmau:chat_autochannels_purged_v1';
        try { if (localStorage.getItem(FLAG_KEY)) return; } catch {}
        let cancelled = false;
        (async () => {
            try {
                const q = query(collection(db, 'chats'), where('type', '==', 'channel'));
                const snap = await getDocs(q);
                if (cancelled || snap.empty) {
                    try { localStorage.setItem(FLAG_KEY, String(Date.now())); } catch {}
                    return;
                }
                let count = 0;
                // Two batched writes per channel — chat doc + tombstone.
                // Firestore batch cap is 500 ops; we play safe with 50
                // channels per batch (DD Mau has ~10).
                const batch = writeBatch(db);
                for (const d of snap.docs) {
                    const data = d.data() || {};
                    batch.update(d.ref, {
                        members: [],
                        deletedAt: serverTimestamp(),
                        deletedBy: staffName,
                        deletedReason: 'admin_clear_autochannels',
                    });
                    batch.set(doc(db, 'chats_purged', d.id), {
                        purgedAt: serverTimestamp(),
                        purgedBy: staffName,
                        chatType: 'channel',
                        channelKey: data.channelKey || null,
                        chatName: data.name || null,
                        reason: 'admin_clear_autochannels',
                    });
                    count++;
                }
                await batch.commit();
                try { localStorage.setItem(FLAG_KEY, String(Date.now())); } catch {}
                console.log(`[chat] purged ${count} auto-channels`);
            } catch (e) {
                console.warn('one-shot autochannel purge failed:', e);
                // Don't set the flag on failure so the next mount can retry.
            }
        })();
        return () => { cancelled = true; };
    }, [isAdmin, staffName]);

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
    // When the user lands here from the cross-chat search, we pass this
    // through to ChatThread which scrolls + highlights the message. The
    // id is one-shot — ChatThread clears the highlight after a brief
    // flash, but the prop stays until they navigate to a different chat
    // (cheap; the effect inside ChatThread is keyed on the id so it
    // won't re-fire spuriously).
    const [jumpToMessageId, setJumpToMessageId] = useState(null);
    const [search, setSearch] = useState('');
    // Andrew 2026-05-21 perf: useDeferredValue keeps the search input
    // typing-snappy while the chat-list filter (100+ chats) runs as
    // low-priority work. React commits the input change immediately
    // and schedules the filtered list re-render when the main thread
    // has time.
    const deferredSearch = useDeferredValue(search);
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

    // 2026-05-27 — Andrew: "when in a chat room the bottom navigation
    // bar at the bottom can disappear." Toggle a body data attribute
    // when a chat thread is active so the AppShellV2's MobileBottomNav
    // hides itself (CSS rule in index.css). Reverts on chat-close OR
    // unmount, so navigating away from Chat tab automatically restores
    // the nav even without an explicit clean-up sequence.
    //
    // We gate on activeChatId only — desktop is fine showing both
    // panes AND the chat thread, but desktop doesn't render the
    // mobile bottom nav anyway (`md:hidden`), so the body class is
    // effectively a no-op on desktop. Cheaper than computing isMobile.
    useEffect(() => {
        if (typeof document === 'undefined') return;
        if (activeChatId) {
            document.body.dataset.chatThreadOpen = 'true';
        } else {
            delete document.body.dataset.chatThreadOpen;
        }
        return () => {
            // Defensive cleanup on Chat tab unmount: if the user
            // navigates away (e.g. back to Home) while a chat was
            // open, clear the flag so the next tab's bottom nav
            // shows normally.
            delete document.body.dataset.chatThreadOpen;
        };
    }, [activeChatId]);

    // 2026-05-27 — Andrew: "the very bottom nav bar can be deleted for
    // this page only its redundent since you press back and takes back
    // to home screen." `data-chat-page-open` is the ChatCenter-mounted
    // sibling to data-chat-thread-open: it's true the moment the user
    // enters the Chat tab and stays true regardless of whether a thread
    // is open. CSS uses it to:
    //   - hide the mobile bottom nav across the whole tab
    //   - black-out the v2 app header so the chat tab feels like one
    //     coherent surface from the iPhone notch down
    //   - propagate #0a0a0a to body / #root / .bg-dd-sage so safe-area
    //     strips inherit the chat background rather than sage
    useEffect(() => {
        if (typeof document === 'undefined') return;
        document.body.dataset.chatPageOpen = 'true';
        return () => { delete document.body.dataset.chatPageOpen; };
    }, []);

    // ── Filtered list ─────────────────────────────────────────────
    const filteredChats = useMemo(() => {
        const term = deferredSearch.trim().toLowerCase();
        if (!term) return chats;
        return chats.filter(c => {
            if (chatDisplayName(c, staffName).toLowerCase().includes(term)) return true;
            const preview = previewOf(c.lastMessage).toLowerCase();
            return preview.includes(term);
        });
    }, [chats, deferredSearch, staffName]);

    // Container height uses dynamic viewport units (dvh) instead of vh
    // — iOS Safari treats vh as the INITIAL viewport (address bar
    // visible) and never shrinks when the keyboard slides up. With vh,
    // tapping the composer pushed it below the keyboard and forced the
    // user to scroll the whole page to reach the input. dvh recomputes
    // as the visible viewport changes, so the composer stays anchored
    // at the bottom of whatever's actually visible. (Andrew 2026-05-17.)
    //
    // Mobile height math (Andrew 2026-05-17 follow-up): the previous
    // `100dvh - 160px` left the composer behind the bottom nav on
    // iPhones with a notch because it didn't subtract env(safe-area-
    // inset-top) — header is h-14 (56px) PLUS the notch (44–50px on
    // iPhone X+), and the bottom nav is ~60px PLUS the home-indicator
    // safe area (~34px). The new calc:
    //
    //   100dvh  − 146px  − env(top)  − env(bottom)
    //
    // = (header 56) + (bottom nav 60) + (30px breathing room)
    //   + variable notch / home-indicator
    //
    // gives ~30px of empty space above the bottom nav on every device,
    // notch or no notch. The vh fallback uses a static 220px (worst-
    // case iPhone) so older browsers that don't grok dvh still keep
    // the composer above the nav — just with slightly more empty space
    // on devices without a notch (acceptable trade).
    //
    // dvh: Safari 15.4+ / Chrome 108+ / Firefox 101+. The vh class is
    // listed FIRST so older browsers parsing the dvh declaration as
    // invalid fall back to the previous vh value — keeps the old
    // pre-fix behavior intact rather than collapsing to auto-height.
    return (
        /* 2026-05-27 — `ddmau-chat-shell` hook lets CSS expand this
           container to the full viewport on mobile when a chat thread
           is open (the v2 app header + bottom nav get hidden so the
           calc above leaves a 116px void up top). Also drives the
           dark-theme color overrides for mobile chat. See index.css. */
        <div className="ddmau-chat-shell flex h-[calc(100vh-220px)] h-[calc(100dvh_-_146px_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] md:h-[calc(100vh-130px)] md:h-[calc(100dvh-130px)] -mx-4 sm:-mx-6 lg:-mx-8 -mt-3 md:-my-6 bg-white md:rounded-xl overflow-hidden">
            {/* ── LEFT PANE: chat list ──────────────────────────── */}
            <aside className={`${mobileShowList ? 'flex' : 'hidden'} md:flex flex-col w-full md:w-[340px] md:border-r border-dd-line bg-white shrink-0`}>
                {/* Header — desktop only.
                    Andrew 2026-05-27 round 2: "put the search emoji next
                    to the search chats bar and move everything up. the
                    report bug tab at the bottom can go too. at the bottom
                    there is a white line across the bottom above the +."
                    Mobile drops this row entirely; the search pill below
                    becomes the topmost element under the v2 header so
                    everything moves up. The previous mobile-only 🔍 icon
                    button is folded into the search pill as a prefix. */}
                <div className="hidden md:flex px-4 py-3 md:border-b border-dd-line items-center justify-between bg-white shrink-0 gap-2">
                    <h1 className="text-[18px] font-black text-dd-text tracking-tight">
                        💬 {tx('Chat', 'Chat')}
                    </h1>
                    <div className="flex items-center gap-1 md:ml-auto">
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
                            className="w-9 h-9 rounded-full hover:bg-dd-bg items-center justify-center text-lg flex"
                            aria-label={tx('Notifications', 'Notificaciones')}
                            title={tx('Notifications', 'Notificaciones')}
                        >
                            🔔
                        </button>
                        <button
                            onClick={() => setShowActionMenu(true)}
                            className="w-9 h-9 rounded-full bg-dd-green text-white text-lg font-black items-center justify-center shadow-sm hover:bg-dd-green-700 active:scale-95 transition flex"
                            aria-label={tx('New', 'Nuevo')}
                        >
                            +
                        </button>
                    </div>
                </div>

                {/* Search — single pill with inline 🔍 icon prefix.
                    iOS / iMessage / WhatsApp pattern: one rounded
                    container with the icon and input combined, no
                    separate row above. The wrapping div carries the pill
                    chrome via `ddmau-chat-search-pill`; the icon and the
                    input are flush inside it. The border-b that was
                    here previously is gone (Andrew: "white line across
                    the bottom") — separator collapses into the bg
                    contrast between the search pill (#1c1c1e) and the
                    chat surface (#0a0a0a). */}
                <div className="px-3 pt-2 pb-1 shrink-0">
                    <label className="ddmau-chat-search-pill flex items-center gap-2 px-3 rounded-full bg-dd-bg border border-dd-line focus-within:ring-2 focus-within:ring-dd-green/30 focus-within:border-dd-green transition">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0 opacity-60">
                            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
                            <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                        <input
                            type="search"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={tx('Search chats', 'Buscar chats')}
                            className="w-full py-2 bg-transparent text-sm text-dd-text placeholder:text-dd-text-2 focus:outline-none"
                        />
                    </label>
                </div>

                {/* Chat list.
                    2026-05-27 — gate the empty-state copy behind
                    chatsLoading + chatsError so a slow first-fetch
                    doesn't briefly tell the user "No chats yet" and
                    a transient snapshot error gets a Retry button
                    instead of silently showing the same empty state.
                    Order matters: loading wins, then error, then
                    empty, then the actual rendered list. */}
                <div className="flex-1 overflow-y-auto">
                    {chatsLoading && chats.length === 0 ? (
                        <div className="p-8 text-center text-sm text-dd-text-2">
                            <div className="inline-block w-6 h-6 border-2 border-dd-line border-t-dd-green rounded-full animate-spin mb-3" />
                            <div>{tx('Loading chats…', 'Cargando chats…')}</div>
                        </div>
                    ) : chatsError && chats.length === 0 ? (
                        <div className="p-6 text-center">
                            <div className="text-3xl mb-2">⚠️</div>
                            <div className="text-sm font-bold text-dd-text mb-1">
                                {tx("Couldn't load chats", 'No se pudo cargar')}
                            </div>
                            <div className="text-[12px] text-dd-text-2 mb-3 max-w-xs mx-auto">
                                {chatsError === 'timeout'
                                    ? tx(
                                        'Network is slow — try again in a moment.',
                                        'Red lenta — intenta de nuevo.',
                                    )
                                    : tx(
                                        'Tap retry. If it keeps happening, check Wi-Fi or tell Andrew.',
                                        'Toca reintentar. Si sigue, revisa Wi-Fi o avísale a Andrew.',
                                    )}
                            </div>
                            <button
                                onClick={retryChatsLoad}
                                className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 active:scale-95 transition shadow-sm"
                            >
                                ↻ {tx('Retry', 'Reintentar')}
                            </button>
                            <div className="text-[10px] text-dd-text-2/70 mt-2 font-mono break-all">
                                {String(chatsError).slice(0, 80)}
                            </div>
                        </div>
                    ) : filteredChats.length === 0 ? (
                        <div className="p-8 text-center text-sm text-dd-text-2">
                            {search
                                ? tx('No matches', 'Sin resultados')
                                : tx('No chats yet. Start one →', 'Aún no hay chats. Inicia uno →')}
                        </div>
                    ) : (
                        filteredChats.map(c => (
                            <ChatListItemInner
                                key={c.id}
                                chat={c}
                                viewerName={staffName}
                                active={c.id === activeChatId}
                                onClick={() => {
                                    breadcrumb('chat.open', c.id, {
                                        type: c.type || 'unknown',
                                        memberCount: Array.isArray(c.members) ? c.members.length : 0,
                                    });
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
                            jumpToMessageId={jumpToMessageId}
                            onBack={() => {
                                breadcrumb('chat.back', activeChat?.id || 'unknown');
                                setActiveChatId(null);
                                setMobileShowList(true);
                            }}
                            onOpenSettings={() => setShowSettings(true)}
                        />
                    </Suspense>
                ) : (
                    <EmptyState isEs={isEs} onStart={() => setShowNewChat(true)} />
                )}
            </section>

            {/* ── Floating "+" FAB (mobile chat-list only) ────────────
                2026-05-27 — Andrew: "put the + at the very bottom
                instead of more button at the very bottom." The mobile
                bottom nav is hidden on the chat tab (data-chat-page-
                open CSS rule), and the old top-right "+" was removed
                in the same pass — so this FAB is the sole new-chat
                affordance on mobile. Positioned with bottom-nav-safe
                so it sits above the iPhone home indicator.
                Hidden when the user is inside a thread (the composer
                is the new-content entry point there) and on desktop
                (the two-pane layout keeps its inline + button). */}
            {mobileShowList && !activeChatId && (
                <button
                    onClick={() => setShowActionMenu(true)}
                    aria-label={tx('New chat', 'Nuevo chat')}
                    title={tx('New chat', 'Nuevo chat')}
                    className="md:hidden ddmau-chat-fab fixed right-5 z-40 w-14 h-14 rounded-full bg-dd-green text-white flex items-center justify-center text-3xl font-black shadow-[0_8px_24px_-4px_rgba(0,0,0,0.6)] active:scale-95 hover:bg-dd-green-700 transition"
                    style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
                >
                    +
                </button>
            )}

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
                        viewer={viewer}
                        onClose={() => setShowSearchPanel(false)}
                        onJump={({ chatId, messageId }) => {
                            setShowSearchPanel(false);
                            setActiveChatId(chatId);
                            setJumpToMessageId(messageId || null);
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
                        staffList={staffList}
                        setStaffList={setStaffList}
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
// Andrew 2026-05-21 perf: memo-wrapped so the chat list (often
// 50-100 chats) doesn't re-render every row when the user types in
// the search box. The shallow compare on (chat, viewerName, active,
// isEs) skips unchanged rows — only the row whose `active` flipped
// (from search-result open) re-renders. onClick / onLongPress
// handlers come from the parent — if they're new refs each render
// the memo only partially lands; future pass can useCallback them.
// Inner component as a function declaration so it's HOISTED to the
// top of the module. The memo() wrapper below is a const and lives
// in TDZ until module evaluation reaches it. Pre-fix this was one
// `const ChatListItem = memo(function ChatListItem(...) {...})`
// at line 656 — but the JSX at line 407 inside the default-export
// ChatCenter function references ChatListItem. In some bundle
// orderings / PWA stale-chunk situations, that triggered
// "Cannot access 'C' before initialization" the moment the chat
// tab mounted. Splitting it (hoisted function for the body, const
// memo wrapper at the bottom) makes the body always available
// even before the memo wrapper has been built. Andrew 2026-05-22.
function ChatListItemInner({ chat, viewerName, active, onClick, onLongPress, isEs }) {
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
const ChatListItem = memo(ChatListItemInner);

// ChatAvatar + chatDisplayName moved to ./ChatShared.jsx (2026-05-22)
// to break a circular import that crashed Safari with a TDZ on a
// minified binding when the user clicked into a chat. See ChatShared
// header comment for the full story. Importing here for local use,
// re-exporting so any straggler `import { ChatAvatar } from
// './ChatCenter'` keeps working. The cycle is broken because the
// child modules (ChatThread, ChatSearchPanel, ChatSettingsModal)
// now import directly from ChatShared, not from ChatCenter.
export { ChatAvatar, chatDisplayName };

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

    // Are all currently-visible candidates already picked?
    const allVisibleSelected = candidates.length > 0
        && candidates.every(c => picked.includes(c.name));

    // Select-all / Clear-all toggle — operates on the CURRENT filter
    // result so "Webster" + tap "Select all" adds every Webster
    // staff. Stays additive: pressing "Select all" on a narrower
    // filter doesn't drop already-picked people outside the filter.
    function toggleSelectAllVisible() {
        const visibleNames = candidates.map(c => c.name);
        if (allVisibleSelected) {
            // Drop visible ones; keep anyone picked from prior filters.
            setPicked(prev => prev.filter(n => !visibleNames.includes(n)));
        } else {
            // Union: add every visible that isn't already in picked.
            setPicked(prev => Array.from(new Set([...prev, ...visibleNames])));
        }
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
            toast(isEs ? 'No se pudo crear el chat.' : 'Could not create chat.', { kind: 'error' });
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

                {/* Select-all bar — only appears when there's something
                    to bulk-pick. Always visible (not just when filtered)
                    so the affordance is consistent: count on the left,
                    toggle on the right. */}
                {candidates.length > 0 && (
                    <div className="px-3 py-1.5 border-b border-dd-line/60 bg-dd-bg/40 flex items-center justify-between shrink-0">
                        <span className="text-[11px] font-bold text-dd-text-2 tabular-nums">
                            {candidates.length} {candidates.length === 1
                                ? tx('person shown', 'persona')
                                : tx('people shown', 'personas')}
                        </span>
                        <button
                            onClick={toggleSelectAllVisible}
                            className={`px-2.5 py-1 rounded-full text-[11px] font-black border transition active:scale-95 ${allVisibleSelected
                                ? 'bg-white text-red-700 border-red-200 hover:bg-red-50'
                                : 'bg-dd-green text-white border-dd-green hover:bg-dd-green-700'}`}
                        >
                            {allVisibleSelected
                                ? `✕ ${tx('Clear all', 'Quitar todos')}`
                                : `✓ ${tx('Select all', 'Seleccionar todos')}`}
                        </button>
                    </div>
                )}

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
            toast(tx('Delete failed', 'Error al eliminar'), { kind: 'error' });
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
