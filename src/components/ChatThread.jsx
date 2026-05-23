// ChatThread — single-chat message view + composer.
//
// Subscribes to /chats/{id}/messages ordered by createdAt asc, capped at
// the last 200. (Older history scrollback is a TODO — for v1 the cap
// keeps Firestore reads bounded and a kitchen team won't usually scroll
// back past a few days.)
//
// On mount + on every new message, we update chat.lastReadByName[me] so
// the chat-list unread dot clears. Auto-scroll-to-bottom on new messages
// unless the user has scrolled up (we don't yank their position).
//
// Composer: text + emoji reactions on long-press + photo + video +
// voice (MediaRecorder API). Voice is a hold-to-record button when the
// text field is empty; the field hides while recording.
//
// Notifications: each text/media message fans out via notifyChatMembers
// → /notifications docs (already wired to FCM via dispatchNotification
// Cloud Function). DMs always notify the other person; groups/channels
// notify everyone except the sender, with @mentions getting a louder
// "you were mentioned" badge.

import { Component, useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { db, storage } from '../firebase';
import {
    collection, doc, query, orderBy, limit, onSnapshot,
    addDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, where, getCountFromServer,
    arrayUnion, arrayRemove, getDoc, runTransaction,
    Timestamp,
} from 'firebase/firestore';
import { ref as sref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { ChatAvatar, chatDisplayName } from './ChatShared';
import { parseMentions, QUICK_REACTIONS, canEditChat, ISSUE_URGENCIES, ISSUE_CATEGORIES, formatChatName, canSeeReceiptsForMessage, getSeenByForMessage, pollTally, isPollOpen, canEditMessage } from '../data/chat';
import { offShiftMembers } from '../data/offShift';
import { INVENTORY_CATEGORIES } from '../data/inventory';
import { postEightySixToChat } from '../data/eightySixChat';
import { canPostAnnouncements, canPinMessages, canConvertToTask, canDeleteAnyMessage, canDeleteOwnMessage, canClaimCoverage, canApproveCoverage } from '../data/chatPermissions';
import { notifyStaff } from '../data/notify';
import { recordAudit } from '../data/audit';
import { claimCoverage, approveCoverage, denyCoverage, withdrawCoverage } from '../data/coverage';
import { toast } from '../toast';
import { fixText as aiFixText } from '../data/aiFixText';
import TranslatableText, { renderWithMentions } from './TranslatableText';

// Lazy-load the heavier modals — keeps the chat-thread chunk small for
// the common case where the user just scrolls + types.
// Use the explicit `.then(m => ({default: m.default}))` form — see
// the comment above the same pattern in ChatCenter.jsx. The bare
// `lazy(() => import('./X'))` form was crashing Safari with a TDZ
// "Cannot access 'C' before initialization" on the auto-generated
// namespace-wrapper export Vite emits for dynamically-imported chunks.
const ChatAckDashboard = lazy(() => import('./ChatAckDashboard').then(m => ({ default: m.default })));
const ChatPinsDrawer = lazy(() => import('./ChatPinsDrawer').then(m => ({ default: m.default })));
const ChatTaskFromMessageModal = lazy(() => import('./ChatTaskFromMessageModal').then(m => ({ default: m.default })));
const ChatPollModal = lazy(() => import('./ChatPollModal').then(m => ({ default: m.default })));
const ChatScheduleModal = lazy(() => import('./ChatScheduleModal').then(m => ({ default: m.default })));
const ChatEmojiPicker = lazy(() => import('./ChatEmojiPicker').then(m => ({ default: m.default })));
const ChatEightySixModal = lazy(() => import('./ChatEightySixModal').then(m => ({ default: m.default })));

const TYPING_TTL_MS = 5000;          // typing heartbeat valid for 5s
const MAX_IMAGE_DIM = 1600;          // resize images larger than this
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;  // 50MB cap on video uploads
// Voice messages auto-stop at 5 minutes. The MediaRecorder will happily
// run forever if the user forgets to hit stop; a runaway hold-to-record
// session can dump hundreds of MB into Storage and overrun the 50MB
// upload-byte budget assumed elsewhere. 5 minutes is the longest useful
// kitchen voice memo (a recipe walkthrough), past that they should
// type or call. Hard stop fires onStop so the upload pipeline runs
// normally — the user just sees the recorder snap closed.
const MAX_RECORD_MS = 5 * 60 * 1000;

// ─── Chat error boundary ─────────────────────────────────────────────
// Catches any synchronous render error inside the thread and shows
// a recoverable fallback ("Something went wrong loading this chat ·
// [Back to chats]") instead of letting the whole Chat tab crash to
// the global ErrorBoundary in App.jsx. The chat surface is the most
// complex tree in the app (3000+ lines, dozens of message types,
// lazy modals, MediaRecorder, mentions, polls, coverage) so a single
// bad message can poison a single conversation — we want that
// damage contained to one chat, not the whole chat experience.
//
// componentDidCatch only fires for sync render errors; async errors
// (failed image loads, Firestore rejections inside effects) are
// already handled at their call sites.
//
// onReset: when the user taps "Back to chats", we both unblock the
// boundary AND tell the parent ChatCenter to close this thread. The
// parent's onBack handler is threaded through props by ChatCenter.
class ChatThreadErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, info) {
        console.error('ChatThread render crashed:', error, info);
    }
    render() {
        if (this.state.hasError) {
            return (
                <div className="flex flex-col items-center justify-center h-full bg-dd-bg text-center px-6 py-12 gap-3">
                    <div className="text-5xl">💬</div>
                    <h3 className="text-base font-black text-dd-text">
                        Something went wrong loading this chat
                    </h3>
                    <p className="text-sm text-dd-text-2 max-w-md">
                        The rest of your chats are fine. Tap back to the chat list
                        and try opening this one again — if it keeps crashing,
                        a manager can check the audit log.
                    </p>
                    <button
                        onClick={() => {
                            this.setState({ hasError: false, error: null });
                            this.props.onReset?.();
                        }}
                        className="mt-2 px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 active:scale-95 transition shadow-sm">
                        ← Back to chats
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

function ChatThreadInner({
    chat, language, staffName, staffList, isAdmin, isManager,
    viewer, viewerTier, onBack, onOpenSettings,
    jumpToMessageId,   // optional id to scroll-into-view + highlight on mount
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const canEdit = canEditChat(chat, viewer, isAdmin);

    // ── Subscribe to messages ─────────────────────────────────────
    // Fetches the newest N messages and reverses them so display
    // stays oldest-first / newest-at-bottom.
    //
    // PREVIOUSLY THIS WAS A BUG: orderBy('createdAt','asc') + limit(200)
    // returns the OLDEST 200 messages. For any chat with >200 total
    // messages, viewers would see ancient history and never the
    // recent stuff. The autoscroll-to-bottom hid the bug for chats
    // ≤200 (those rendered fine), but the moment a chat crossed 200
    // messages, new messages would never load.
    //
    // Also: limit was 200, which felt slow on first paint because we
    // were waiting for 200 docs over the wire before showing anything.
    // Most chat sessions don't scroll back further than ~30 messages,
    // so the new default is 50, with a "Load older" button for older
    // scrollback. (AUDIT CHAT-008.)
    const [messages, setMessages] = useState([]);
    const [messageLimit, setMessageLimit] = useState(50);
    const [hasMore, setHasMore] = useState(true);
    useEffect(() => {
        if (!chat?.id) return;
        // Reset pagination when switching chats.
        setMessageLimit(50);
        setHasMore(true);
    }, [chat?.id]);
    useEffect(() => {
        if (!chat?.id) return;
        const q = query(
            collection(db, 'chats', chat.id, 'messages'),
            orderBy('createdAt', 'desc'),
            limit(messageLimit)
        );
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            // Snapshot is newest-first because of the desc order; reverse
            // so render order stays oldest-first / newest-at-bottom.
            list.reverse();
            setMessages(list);
            // If we got fewer than we asked for, there's no older to load.
            if (snap.size < messageLimit) setHasMore(false);
        }, (err) => console.warn('messages snapshot failed:', err));
        return () => unsub();
    }, [chat?.id, messageLimit]);

    // Load-older handler — bumps the limit by another 50. Re-runs the
    // subscription effect above against the new limit, which re-fetches
    // (Firestore can't extend a snapshot's limit incrementally).
    function loadOlderMessages() {
        setMessageLimit(n => n + 50);
    }

    // ── Mark read on view + on each new message ────────────────────
    // We write a single lastReadByName.{name} timestamp on the chat doc.
    // Dot-notation update preserves other members' read markers.
    //
    // Debounced 1.5s (AUDIT CHAT-002). Previous version fired a write
    // on EVERY messages.length change — so 10 messages streaming in
    // via snapshot triggered 10 writes back to Firestore just to
    // mark-read. With ~30 staff × ~50 chats × ~200 messages/day, that
    // adds up to ~75K wasted writes/day. Debouncing collapses each
    // burst of arrivals into one write while the user is reading.
    useEffect(() => {
        if (!chat?.id || !staffName) return;
        const ref = doc(db, 'chats', chat.id);
        const t = setTimeout(() => {
            updateDoc(ref, { [`lastReadByName.${staffName}`]: serverTimestamp() })
                .catch(e => console.warn('markRead failed:', e));
        }, 1500);
        return () => clearTimeout(t);
    }, [chat?.id, staffName, messages.length]);

    // ── Auto-scroll-to-bottom on new messages ──────────────────────
    // Skip auto-scroll if the user has scrolled up >100px from bottom —
    // they're probably reading older messages, don't yank them.
    const scrollRef = useRef(null);
    const [atBottom, setAtBottom] = useState(true);
    useEffect(() => {
        if (!atBottom) return;
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages.length, atBottom]);
    function handleScroll() {
        const el = scrollRef.current;
        if (!el) return;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        setAtBottom(gap < 100);
    }

    // ── Composer state ────────────────────────────────────────────
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [recording, setRecording] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(null); // { kind, pct }
    const [typingNames, setTypingNames] = useState([]);

    // ── Feature drawers / modals ──────────────────────────────────
    const [showPinsDrawer, setShowPinsDrawer] = useState(false);
    const [ackDashboardMsg, setAckDashboardMsg] = useState(null);
    const [taskModalMsg, setTaskModalMsg] = useState(null);
    const [contextMenuMsg, setContextMenuMsg] = useState(null);  // {message, anchorRect}
    const [highlightMsgId, setHighlightMsgId] = useState(null);  // scroll-target after jump-to
    // ── Reply target ────────────────────────────────────────────────
    // When the user picks "Reply" from a message's action menu we stash
    // a snapshot of the target here ({ id, senderName, snippet, type })
    // — NOT a live message reference, because the target could get
    // edited / deleted between pick and send. The Composer renders the
    // snippet as a pill above the textarea with an ✕ to clear; the
    // sendMessage path stamps it onto the new message's `replyTo`
    // field. Bubble renderer reads `message.replyTo` and draws the
    // quoted preview on top of the bubble (tap → scroll to original).
    const [replyTarget, setReplyTarget] = useState(null);
    const [showPollModal, setShowPollModal] = useState(false);
    const [pollSubmitting, setPollSubmitting] = useState(false);
    const [showScheduleModal, setShowScheduleModal] = useState(false);
    const [show86Modal, setShow86Modal] = useState(false);
    const [posting86, setPosting86] = useState(false);
    // ── Inline edit state ───────────────────────────────────────────
    // editingMessageId: which bubble is currently in the "swap text
    //   for textarea" mode. Only one message can be edited at a time;
    //   tapping Edit on another implicitly cancels the first.
    // We don't store the draft text here — the inline editor manages
    // its own local input state. We just track WHICH bubble.
    const [editingMessageId, setEditingMessageId] = useState(null);
    // "Notify anyway" — when ON, the next message bypasses the
    // server's off-shift gate (notif.forceDeliver=true). User has
    // to flip it for each message; we don't make it sticky because
    // chronic override defeats the point. Visible only when at
    // least one recipient is off-shift.
    const [notifyAnyway, setNotifyAnyway] = useState(false);
    // ── Scheduled messages in this chat (for the banner above composer)
    // Light subscription — we just need the count + a quick list to show
    // the "📅 3 scheduled · view" link. Detailed cancel/edit lives in
    // ChatScheduledDrawer (lazy-mounted on tap).
    const [scheduledMessages, setScheduledMessages] = useState([]);
    const [showScheduledDrawer, setShowScheduledDrawer] = useState(false);

    // ── Translation preferences ──────────────────────────────────
    // Viewer's target language for translations. Chat-side preference
    // (in /chat_prefs/{me}) wins; falls back to the staff-record
    // preferredLanguage; defaults to the current UI language. Auto-
    // translate fires the Cloud Function for every foreign message
    // when ON — when OFF, the user has to tap the "🌐 Translate"
    // chip per message.
    const [autoTranslate, setAutoTranslate] = useState(false);
    const targetLang = useMemo(() => {
        return viewer?.preferredLanguage || (isEs ? 'es' : 'en');
    }, [viewer?.preferredLanguage, isEs]);
    useEffect(() => {
        if (!staffName) return;
        let cancelled = false;
        (async () => {
            try {
                const snap = await getDoc(doc(db, 'chat_prefs', staffName));
                if (cancelled) return;
                if (snap.exists()) {
                    setAutoTranslate(!!snap.data()?.autoTranslate);
                }
            } catch (e) {
                console.warn('autoTranslate pref load failed:', e);
            }
        })();
        return () => { cancelled = true; };
    }, [staffName]);

    // ── Jump-to-message from chat search ─────────────────────────
    // ChatCenter passes jumpToMessageId from the search panel; we
    // scroll the element into view + flash the highlight ring. The
    // effect only fires when the id changes AND messages contain it,
    // so the initial load doesn't trigger before subscriptions land.
    useEffect(() => {
        if (!jumpToMessageId) return;
        if (!messages.some(m => m.id === jumpToMessageId)) return;
        setHighlightMsgId(jumpToMessageId);
        setAtBottom(false);
        const t = setTimeout(() => {
            const el = document.getElementById(`msg-${jumpToMessageId}`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 60);
        const t2 = setTimeout(() => setHighlightMsgId(null), 2800);
        return () => { clearTimeout(t); clearTimeout(t2); };
    }, [jumpToMessageId, messages]);

    // ── My personal ack set for this chat (so I can show "✓ Read") ──
    // Subscribe to /chats/{id}/acks where userName == me. Small per-user
    // set; renderer checks if (msg.id in myAcks) to flip the announcement
    // card to its "acknowledged" state.
    const [myAcks, setMyAcks] = useState(new Set());
    useEffect(() => {
        if (!chat?.id || !staffName) return;
        const q = query(
            collection(db, 'chats', chat.id, 'acks'),
            where('userName', '==', staffName)
        );
        const unsub = onSnapshot(q, (snap) => {
            const set = new Set();
            snap.forEach(d => {
                const data = d.data();
                if (data.messageId) set.add(data.messageId);
            });
            setMyAcks(set);
        }, () => {});
        return () => unsub();
    }, [chat?.id, staffName]);

    // Pinned-message count for the top-of-thread banner.
    const pinnedMessages = useMemo(
        () => messages.filter(m => m.pinned === true && !m.deleted),
        [messages]
    );

    // ── Off-shift member detection ─────────────────────────────
    // We subscribe to today's + yesterday's published shifts (small
    // collection, refreshes when anyone publishes/unpublishes) and
    // compute which members of THIS chat aren't currently on shift.
    // The Cloud Function does the same gate at push time; the client
    // computation feeds the "🔕 N off-shift" header indicator + the
    // composer's "Notify anyway" toggle.
    //
    // Yesterday is included so overnight shifts (date=yesterday in CT,
    // end-time crossed midnight UTC) still count as "on shift".
    // Andrew (2026-05-17). Sized small (members + 2 dates × published
    // shifts) so the snapshot is cheap.
    const [todayShifts, setTodayShifts] = useState([]);
    useEffect(() => {
        const today = new Date();
        const yest = new Date(today.getTime() - 86400_000);
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const dateRange = [fmt(yest), fmt(today)];
        const q = query(
            collection(db, 'shifts'),
            where('date', 'in', dateRange),
            where('published', '==', true),
        );
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setTodayShifts(list);
        }, (err) => console.warn('today shifts snapshot failed:', err));
        return () => unsub();
    }, []);

    // The off-shift subset of THIS chat's members, excluding the
    // current user (we know whether WE are on shift; the indicator
    // is about who RECEIVES our message). Recomputes when chat
    // members or today's shifts change.
    const offShiftRecipients = useMemo(() => {
        const others = (chat?.members || []).filter(n => n && n !== staffName);
        return offShiftMembers(others, todayShifts, staffList);
    }, [chat?.members, staffName, staffList, todayShifts]);

    // Subscribe to MY pending scheduled messages in this chat. The
    // Cloud Function flips status='sent' (or deletes) when delivered;
    // we only render `status==='pending'`. Capped to 20 — the realistic
    // number a person schedules is single digits.
    useEffect(() => {
        if (!chat?.id || !staffName) return;
        const q = query(
            collection(db, 'scheduled_messages'),
            where('chatId', '==', chat.id),
            where('createdBy', '==', staffName),
            where('status', '==', 'pending'),
            orderBy('sendAt', 'asc'),
            limit(20),
        );
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setScheduledMessages(list);
        }, (err) => console.warn('scheduled snapshot failed:', err));
        return () => unsub();
    }, [chat?.id, staffName]);

    // ── Typing indicator ──────────────────────────────────────────
    // We heartbeat into chat.typingByName[me] = serverTimestamp() on
    // each keypress; consumers filter stale entries client-side. The
    // doc fan-out is cheap because typingByName is small per chat.
    const lastTypingRef = useRef(0);
    function maybeSendTyping() {
        const now = Date.now();
        if (now - lastTypingRef.current < 2000) return; // throttle to 2s
        lastTypingRef.current = now;
        updateDoc(doc(db, 'chats', chat.id), {
            [`typingByName.${staffName}`]: serverTimestamp(),
        }).catch(() => {});
    }
    useEffect(() => {
        // Filter the chat.typingByName map for fresh entries (<5s old),
        // excluding the viewer themselves. We pull from chat (passed in
        // from parent's snapshot) so this updates live.
        const map = chat?.typingByName || {};
        const now = Date.now();
        const fresh = Object.entries(map)
            .filter(([name, ts]) => {
                if (name === staffName) return false;
                const ms = ts?.toMillis ? ts.toMillis()
                    : (ts?.seconds ? ts.seconds * 1000 : 0);
                return ms && (now - ms) < TYPING_TTL_MS;
            })
            .map(([name]) => name);
        setTypingNames(fresh);
    }, [chat?.typingByName, staffName]);

    // Pick a target to reply to. Snapshots the relevant fields so the
    // reply survives later edits/deletes of the original. We only carry
    // a 120-char snippet — enough to identify the message at a glance
    // without bloating the new message doc.
    function handleReply(message) {
        if (!message?.id) return;
        const snippet = (message.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
            || (message.type === 'image' ? '📷 Photo'
                : message.type === 'video' ? '🎬 Video'
                : message.type === 'audio' ? '🎤 Voice'
                : '');
        setReplyTarget({
            id: message.id,
            senderName: message.senderName,
            snippet,
            type: message.type,
        });
    }

    // ── Send a text message ───────────────────────────────────────
    //
    // Re-entry guard via a ref (production audit 2026-05-22). The
    // existing `sending` state was checked but it's a React state
    // setter — React batches setState across handlers in the same
    // tick, so on a fast Enter-then-click (or two finger-taps from
    // a fast mobile keyboard) BOTH calls could pass `if (sending)`
    // before either setSending(true) committed, landing two
    // messages in Firestore. sendingRef updates synchronously.
    const sendingRef = useRef(false);

    // ── Failed-send queue ──────────────────────────────────────────
    // Audit follow-up 2026-05-23: previously a failed send just
    // popped a toast and DROPPED the user's text — they'd retype
    // from scratch with no idea what they'd written. Now: on any
    // sendMessage rejection, we capture the body + replyTo on this
    // queue and render a small "Failed to send · Retry" banner
    // above the composer. The retry handler re-runs sendMessage
    // with the captured payload; on success the entry leaves the
    // queue. Per-chat (cleared on chat switch). Bounded to 5
    // entries so a chronic-failure loop doesn't grow forever.
    const [failedSends, setFailedSends] = useState([]);
    useEffect(() => { setFailedSends([]); }, [chat?.id]);

    async function handleSendText() {
        const body = draft.trim();
        if (!body) return;
        if (sendingRef.current) return;
        sendingRef.current = true;
        setSending(true);
        // Capture the payload before we mutate composer state — if
        // the send fails we want to recover the EXACT body the
        // user typed, even if they've started typing the next one.
        const capturedReply = replyTarget;
        const capturedNotify = notifyAnyway;
        try {
            await sendMessage({
                chat, staffName, viewer, staffList,
                type: 'text',
                text: body,
                replyTo: capturedReply,
                forceDeliver: capturedNotify,
            });
            setDraft('');
            setReplyTarget(null);
            setNotifyAnyway(false);
        } catch (e) {
            console.warn('send text failed:', e);
            setFailedSends(prev => {
                // Drop oldest if we'd exceed the cap. 5 is enough
                // headroom for a brief outage; chronic failures
                // signal a bigger problem the user should see fast.
                const next = [...prev, {
                    id: `f${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    body,
                    replyTo: capturedReply,
                    forceDeliver: capturedNotify,
                    failedAt: Date.now(),
                }];
                return next.slice(-5);
            });
            toast(tx('Send failed — saved for retry', 'Error al enviar — guardado'), { kind: 'error' });
        } finally {
            sendingRef.current = false;
            setSending(false);
        }
    }

    // Retry a previously-failed text send. Drops from the queue on
    // success; leaves it in place on failure so the user can keep
    // trying. Uses the same sendingRef guard so a retry can't
    // collide with an in-flight new send.
    async function retryFailedSend(id) {
        const item = failedSends.find(f => f.id === id);
        if (!item) return;
        if (sendingRef.current) return;
        sendingRef.current = true;
        try {
            await sendMessage({
                chat, staffName, viewer, staffList,
                type: 'text',
                text: item.body,
                replyTo: item.replyTo,
                forceDeliver: item.forceDeliver,
            });
            setFailedSends(prev => prev.filter(f => f.id !== id));
        } catch (e) {
            console.warn('retry send failed:', e);
            toast(tx('Still failing — check your connection', 'Aún falla — revisa tu conexión'), { kind: 'error' });
        } finally {
            sendingRef.current = false;
        }
    }

    // Drop a failed send the user has given up on. Also exposed
    // as "Edit instead" via copying the body back to the composer.
    function discardFailedSend(id) {
        setFailedSends(prev => prev.filter(f => f.id !== id));
    }
    function recoverFailedSendToDraft(id) {
        const item = failedSends.find(f => f.id === id);
        if (!item) return;
        // Append to existing draft if one's in progress, otherwise
        // replace. Either way the user can edit before retrying.
        setDraft(prev => (prev.trim() ? `${prev} ${item.body}` : item.body));
        setFailedSends(prev => prev.filter(f => f.id !== id));
    }

    // ── Send media (photo / video) ────────────────────────────────
    async function handleMediaPick(e, kind) {
        const file = e.target.files?.[0];
        e.target.value = ''; // reset so re-picking same file fires change
        if (!file) return;
        if (kind === 'video' && file.size > MAX_VIDEO_BYTES) {
            toast(tx('Video too large (50MB max).', 'Video muy grande (50MB máx).'), { kind: 'warn' });
            return;
        }
        setSending(true);
        setUploadProgress({ kind, pct: 0 });
        try {
            let uploadFile = file;
            let width, height, duration;
            if (kind === 'image') {
                const resized = await resizeImage(file, MAX_IMAGE_DIM);
                uploadFile = resized.blob;
                width = resized.width;
                height = resized.height;
            } else if (kind === 'video') {
                const meta = await probeVideo(file);
                duration = meta.duration;
                width = meta.width;
                height = meta.height;
            }
            const ext = (file.name?.split('.').pop() || 'bin').toLowerCase();
            const messageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const path = `chats/${chat.id}/${messageId}.${ext}`;
            const ref = sref(storage, path);
            await uploadBytes(ref, uploadFile, { contentType: file.type });
            const url = await getDownloadURL(ref);
            await sendMessage({
                chat, staffName, viewer, staffList,
                type: kind,
                text: draft.trim(), // optional caption
                mediaUrl: url,
                mediaPath: path,
                mediaType: file.type,
                width, height, duration,
                replyTo: replyTarget,
                forceDeliver: notifyAnyway,
            });
            setDraft('');
            setReplyTarget(null);
            setNotifyAnyway(false);
        } catch (err) {
            console.warn(`${kind} send failed:`, err);
            toast(tx('Upload failed', 'Error al subir'), { kind: 'error' });
        } finally {
            setSending(false);
            setUploadProgress(null);
        }
    }

    // ── Voice recording ───────────────────────────────────────────
    // MediaRecorder API. iOS Safari 14.5+ supports audio/mp4 (m4a);
    // Chrome/Android prefers audio/webm. We let the browser pick.
    const recorderRef = useRef(null);
    const recordChunks = useRef([]);
    const recordStartRef = useRef(0);
    const recordTimerRef = useRef(null);
    async function startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mime = MediaRecorder.isTypeSupported('audio/webm')
                ? 'audio/webm'
                : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
            const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
            recordChunks.current = [];
            rec.ondataavailable = (e) => { if (e.data?.size > 0) recordChunks.current.push(e.data); };
            rec.onstop = async () => {
                const stoppedAt = Date.now();
                const duration = Math.max(1, Math.round((stoppedAt - recordStartRef.current) / 1000));
                const blob = new Blob(recordChunks.current, { type: rec.mimeType || 'audio/webm' });
                stream.getTracks().forEach(t => t.stop());
                if (blob.size < 1000) return; // too short = accidental tap; drop
                await uploadVoice(blob, duration);
            };
            rec.start();
            recorderRef.current = rec;
            recordStartRef.current = Date.now();
            // Auto-stop at MAX_RECORD_MS so a forgotten hold-to-record
            // doesn't fill Storage. Browsers don't auto-cap MediaRecorder
            // sessions on their own.
            if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
            recordTimerRef.current = setTimeout(() => {
                if (recorderRef.current) stopRecording(false);
            }, MAX_RECORD_MS);
            setRecording(true);
        } catch (e) {
            console.warn('mic access failed:', e);
            toast(tx('Mic access denied', 'Acceso al micrófono denegado'), { kind: 'error' });
        }
    }
    function stopRecording(cancel = false) {
        const rec = recorderRef.current;
        if (recordTimerRef.current) {
            clearTimeout(recordTimerRef.current);
            recordTimerRef.current = null;
        }
        if (!rec) return;
        try {
            if (cancel) {
                rec.ondataavailable = null;
                rec.onstop = () => rec.stream.getTracks().forEach(t => t.stop());
            }
            rec.stop();
        } catch {}
        recorderRef.current = null;
        setRecording(false);
    }

    // Unmount cleanup — production-audit 2026-05-22. If the user
    // navigates away mid-recording (switches chats, closes the tab,
    // hits the back button on mobile), the previous code left the
    // MediaRecorder + getUserMedia stream alive: the mic light on
    // iOS stayed on until the entire tab closed, and the auto-stop
    // timeout fired later against a stale ref. Cancel any in-flight
    // recording on unmount.
    useEffect(() => {
        return () => {
            if (recordTimerRef.current) {
                clearTimeout(recordTimerRef.current);
                recordTimerRef.current = null;
            }
            const rec = recorderRef.current;
            if (rec) {
                try {
                    rec.ondataavailable = null;
                    rec.onstop = null;
                    try { rec.stream?.getTracks?.().forEach(t => t.stop()); } catch {}
                    rec.stop();
                } catch {}
                recorderRef.current = null;
            }
        };
    }, []);
    async function uploadVoice(blob, duration) {
        setSending(true);
        setUploadProgress({ kind: 'audio', pct: 0 });
        try {
            const messageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const ext = (blob.type.includes('mp4') ? 'm4a' : 'webm');
            const path = `chats/${chat.id}/${messageId}.${ext}`;
            const ref = sref(storage, path);
            await uploadBytes(ref, blob, { contentType: blob.type });
            const url = await getDownloadURL(ref);
            await sendMessage({
                chat, staffName, viewer, staffList,
                type: 'audio',
                text: '',
                mediaUrl: url,
                mediaPath: path,
                mediaType: blob.type,
                duration,
            });
        } catch (e) {
            console.warn('voice upload failed:', e);
            toast(tx('Voice send failed', 'Error al enviar voz'), { kind: 'error' });
        } finally {
            setSending(false);
            setUploadProgress(null);
        }
    }

    // ── Action handlers (context-menu targets) ───────────────────
    // Acknowledge an announcement / ack-required message. Idempotent —
    // re-tapping does nothing because the doc id is deterministic.
    async function handleAck(message) {
        if (!message || !staffName) return;
        const ackId = `${message.id}_${staffName.replace(/[^a-zA-Z0-9]/g, '_')}`;
        try {
            await setDoc(doc(db, 'chats', chat.id, 'acks', ackId), {
                messageId: message.id,
                userName: staffName,
                userId: viewer?.id || null,
                ackedAt: serverTimestamp(),
            }, { merge: true });
            recordAudit({
                action: 'chat.ack.complete',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'message',
                targetId: message.id,
                details: { chatId: chat.id },
            });
        } catch (e) {
            console.warn('ack failed:', e);
        }
    }

    // Pin/unpin a message. Capacity check at 5 pins per channel —
    // managers see a prompt to unpin one first.
    async function handleTogglePin(message) {
        if (!message?.id) return;
        const isPinned = message.pinned === true;
        if (!isPinned && pinnedMessages.length >= 5) {
            toast(tx('Up to 5 messages can be pinned. Unpin one first.',
                     'Hasta 5 mensajes pueden estar fijados. Quita uno primero.'),
                  { kind: 'warn' });
            return;
        }
        try {
            await updateDoc(doc(db, 'chats', chat.id, 'messages', message.id), {
                pinned: !isPinned,
                pinnedBy: !isPinned ? staffName : null,
                pinnedAt: !isPinned ? serverTimestamp() : null,
            });
            recordAudit({
                action: isPinned ? 'chat.message.unpin' : 'chat.message.pin',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'message',
                targetId: message.id,
                details: { chatId: chat.id },
            });
        } catch (e) {
            console.warn('pin toggle failed:', e);
        }
    }

    // Delete (soft) a message. Author can always; managers can delete
    // any in their channel. Audit log records the actor + content for
    // dispute resolution.
    async function handleDelete(message) {
        if (!message?.id) return;
        const canOwn = canDeleteOwnMessage(message, viewer);
        const canAny = canDeleteAnyMessage(chat, viewer, isAdmin, isManager);
        if (!canOwn && !canAny) return;
        const ok = window.confirm(tx('Delete this message?', '¿Eliminar este mensaje?'));
        if (!ok) return;
        try {
            await updateDoc(doc(db, 'chats', chat.id, 'messages', message.id), {
                deleted: true,
                deletedBy: staffName,
                deletedAt: serverTimestamp(),
            });
            recordAudit({
                action: 'chat.message.delete',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'message',
                targetId: message.id,
                details: {
                    chatId: chat.id,
                    deletedByOther: !canOwn,
                    originalSender: message.senderName,
                    originalSnippet: (message.text || '').slice(0, 200),
                },
            });
        } catch (e) {
            console.warn('delete failed:', e);
        }
    }

    function handleCopyText(message) {
        const text = message?.text || '';
        if (!text) return;
        try {
            navigator.clipboard.writeText(text);
        } catch {}
    }

    // ── Edit a previously-sent message (own + within window) ─────
    // Patches the message doc with the new text + edited:true +
    // editedAt + editedBy. Wipes any cached translations because
    // the text changed — TranslatableText will refire on next view
    // if the auto-translate pref is on. Audit log captures the
    // original snippet + edit so disputes are resolvable.
    //
    // Note: notifications were already fired when the message was
    // sent. We don't re-notify on edit (a silent typo fix shouldn't
    // ping the whole channel). If someone needs to announce the
    // change, they should send a follow-up.
    async function handleEditMessage(message, newText) {
        if (!message?.id) return;
        if (!canEditMessage(message, viewer)) return;
        const trimmed = String(newText || '').trim();
        if (!trimmed) return; // empty edit = no-op (use delete instead)
        if (trimmed === (message.text || '').trim()) {
            // No textual change — close the editor without writing
            // anything (avoids a noisy "edited" suffix from a fat-
            // finger Save with no actual edit).
            setEditingMessageId(null);
            return;
        }
        try {
            await updateDoc(doc(db, 'chats', chat.id, 'messages', message.id), {
                text: trimmed,
                edited: true,
                editedAt: serverTimestamp(),
                editedBy: staffName,
                // Drop stale translations + auto-detected sourceLang
                // so the next viewer (or the auto-translate pref) re-
                // translates from the current text rather than serving
                // a stale Spanish version of the original.
                translations: {},
                sourceLang: null,
            });
            recordAudit({
                action: 'chat.message.edit',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'message',
                targetId: message.id,
                details: {
                    chatId: chat.id,
                    originalSnippet: (message.text || '').slice(0, 200),
                    editedSnippet: trimmed.slice(0, 200),
                },
            });
            setEditingMessageId(null);
        } catch (e) {
            console.warn('edit failed:', e);
            toast(tx('Edit failed', 'Error al editar'), { kind: 'error' });
        }
    }

    // ── Coverage-request actions (called by CoverageCard) ────────
    async function handleClaimCoverage(message) {
        try {
            await claimCoverage({
                chatId: chat.id, messageId: message.id,
                claimerName: staffName, claimerId: viewer?.id,
            });
        } catch (e) {
            const msg = String(e.message || e);
            if (msg === 'coverage_not_open') toast(tx('Already claimed.', 'Ya reclamado.'), { kind: 'warn' });
            else toast(tx('Claim failed.', 'Error al reclamar.'), { kind: 'error' });
        }
    }
    async function handleApproveCoverage(message) {
        try {
            await approveCoverage({
                chatId: chat.id, messageId: message.id,
                managerName: staffName, managerId: viewer?.id,
            });
        } catch (e) {
            toast(tx('Approve failed.', 'Error al aprobar.'), { kind: 'error' });
        }
    }
    async function handleDenyCoverage(message) {
        try {
            await denyCoverage({
                chatId: chat.id, messageId: message.id,
                managerName: staffName, managerId: viewer?.id,
            });
        } catch (e) {
            toast(tx('Deny failed.', 'Error al negar.'), { kind: 'error' });
        }
    }
    async function handleWithdrawCoverage(message) {
        try {
            await withdrawCoverage({
                chatId: chat.id, messageId: message.id,
                requesterName: staffName, requesterId: viewer?.id,
            });
        } catch (e) {
            toast(tx('Withdraw failed.', 'Error al retirar.'), { kind: 'error' });
        }
    }

    // ── Reaction toggle ──────────────────────────────────────────
    // We use dot-path arrayUnion / arrayRemove so two simultaneous
    // reactors don't overwrite each other. The previous "read map,
    // mutate, write whole map" pattern lost reactions whenever two
    // users tapped within the same Firestore tick — second writer
    // saw a stale `reactions` snapshot and clobbered the first.
    // arrayUnion is the canonical fix and Firestore guarantees it's
    // atomic against concurrent writers.
    //
    // Note: we never actually `delete reactions[emoji]` anymore when
    // the list goes empty. An empty array renders as zero chips in
    // the bubble (the filter on Object.entries drops zero-length
    // entries already), so the doc just carries a dangling `[]` key.
    // Acceptable — keeps the write atomic without a transaction.
    async function handleReact(message, emoji) {
        const ref = doc(db, 'chats', chat.id, 'messages', message.id);
        const cur = Array.isArray(message.reactions?.[emoji]) ? message.reactions[emoji] : [];
        const hasIt = cur.includes(staffName);
        try {
            await updateDoc(ref, {
                [`reactions.${emoji}`]: hasIt ? arrayRemove(staffName) : arrayUnion(staffName),
            });
        } catch (e) {
            console.warn('react failed:', e);
        }
    }

    // ── Polls ─────────────────────────────────────────────────────
    // Create a poll message. Picks up payload from ChatPollModal; the
    // poll content is stored inline on the message (poll.question +
    // options + votes map). We set text = the question so search,
    // chat-preview, and the notification body all surface something
    // useful — the renderer hides the bubble text since the PollCard
    // shows it more prominently.
    async function handleCreatePoll(payload) {
        if (!payload || pollSubmitting) return;
        setPollSubmitting(true);
        try {
            await sendMessage({
                chat, staffName, viewer, staffList,
                type: 'poll',
                text: '📊 ' + payload.question,
                poll: payload,
                replyTo: replyTarget,
                forceDeliver: notifyAnyway,
            });
            setReplyTarget(null);
            setNotifyAnyway(false);
            setShowPollModal(false);
        } catch (e) {
            console.warn('poll create failed:', e);
            toast(tx('Could not post poll', 'No se pudo publicar'), { kind: 'error' });
        } finally {
            setPollSubmitting(false);
        }
    }

    // Toggle a vote on a poll option. Same atomic-write pattern as
    // reactions: dot-path arrayUnion / arrayRemove keeps simultaneous
    // voters from clobbering each other. For multiSelect=false, we
    // remove the voter from every OTHER option first so they end up
    // with exactly one vote (this single dot-path-list write is
    // atomic; a transaction would be overkill).
    async function handleVote(message, optionId) {
        if (!message?.id || !optionId) return;
        const poll = message.poll;
        if (!poll || !isPollOpen(poll)) return;
        const ref = doc(db, 'chats', chat.id, 'messages', message.id);
        const currentArr = Array.isArray(poll.votes?.[optionId]) ? poll.votes[optionId] : [];
        const alreadyVoted = currentArr.includes(staffName);
        const updates = {};
        if (alreadyVoted) {
            updates[`poll.votes.${optionId}`] = arrayRemove(staffName);
        } else {
            updates[`poll.votes.${optionId}`] = arrayUnion(staffName);
            if (!poll.multiSelect) {
                // Strip from every other option in the same write batch.
                for (const o of (poll.options || [])) {
                    if (o.id === optionId) continue;
                    updates[`poll.votes.${o.id}`] = arrayRemove(staffName);
                }
            }
        }
        try {
            await updateDoc(ref, updates);
        } catch (e) {
            console.warn('poll vote failed:', e);
        }
    }

    // ── Nudge (manager → unread reader) ───────────────────────────
    // Manager taps "Nudge" on a row in the SeenBySheet's "Not yet
    // seen" list. We fire a fresh chat_nudge notification at that
    // staff member with forceDeliver=true so the off-shift gate is
    // bypassed (the act of nudging IS the explicit override — the
    // manager has made a deliberate call to reach this person now).
    //
    // The push body names the manager + the chat so the receiver
    // knows who's waiting on them ("Andrew is waiting on your read in
    // #foh-webster"). Tap deep-links into the chat, jumps to the
    // specific message via jumpToMessageId.
    //
    // Audit row per nudge for accountability.
    async function handleNudge(message, targetName) {
        if (!message?.id || !targetName) return;
        // Permission check — manager / admin / chat co-admin only.
        if (!isAdmin && !isManager
            && !(Array.isArray(chat?.admins) && chat.admins.includes(staffName))) {
            return;
        }
        if (targetName === staffName) return; // no self-nudge

        const chatLabel = chat?.type === 'dm' ? staffName : (chat?.name || 'Chat');
        try {
            await notifyStaff({
                forStaff: targetName,
                type: 'chat_nudge',
                title: '⏰ ' + tx('Reminder', 'Recordatorio'),
                body: tx(
                    `${staffName} is waiting on your read in ${chatLabel}`,
                    `${staffName} espera tu lectura en ${chatLabel}`,
                ),
                deepLink: 'chat',
                link: '/chat',
                // tag includes the message id so multiple nudges on
                // DIFFERENT messages don't collapse, but RE-nudging
                // the same message replaces the previous OS toast.
                tag: `chat_nudge:${chat.id}:${message.id}:${targetName}`,
                priority: 'high',
                forceDeliver: true,
                createdBy: staffName,
            });
            recordAudit({
                action: 'chat.nudge.send',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'staff',
                targetId: targetName,
                details: {
                    chatId: chat.id,
                    messageId: message.id,
                    chatLabel,
                },
            });
        } catch (e) {
            console.warn(`nudge failed for ${targetName}:`, e);
            toast(tx('Nudge failed', 'Error al recordar'), { kind: 'error' });
        }
    }

    // Bulk-nudge every unread reader. Used by "Nudge all" in the
    // SeenBySheet header. Sequential awaits (not Promise.all) so a
    // failure on one push doesn't abort the rest — each notifyStaff
    // already swallows its own errors, but explicit sequencing makes
    // the audit log readable in order.
    async function handleNudgeAll(message, targetNames) {
        if (!message?.id || !Array.isArray(targetNames) || targetNames.length === 0) return;
        for (const name of targetNames) {
            await handleNudge(message, name);
        }
        toast(
            tx(`Nudged ${targetNames.length}`, `${targetNames.length} recordados`),
            { kind: 'success' }
        );
    }

    // Close a poll. Only the creator or admin can close.
    async function handleClosePoll(message) {
        if (!message?.id) return;
        if (!isAdmin && message.senderName !== staffName) return;
        try {
            await updateDoc(doc(db, 'chats', chat.id, 'messages', message.id), {
                'poll.closedAt': serverTimestamp(),
            });
        } catch (e) {
            console.warn('poll close failed:', e);
        }
    }

    // ── 86 alerts (compose + resolve) ────────────────────────────
    // Post an `eighty_six_alert` message into the current chat AND
    // sync to the live 86 list at /ops/86_{location}. That doc is
    // already subscribed everywhere (Home tile, sidebar pip,
    // Eighty6Dashboard) so a single write surfaces the item in every
    // 86 view. Audit + FCM fan-out flow through postEightySixToChat
    // (its name is misleading — it doesn't write a chat doc anymore,
    // just audit + push to on-duty FOH staff).
    async function handlePost86({ itemName, location, note }) {
        if (!itemName || !location || posting86) return;
        // Location-permission gate. A staff record carries `location`
        // = 'webster' | 'maryland' | 'both' (or undefined for legacy).
        // We only refuse when there's an EXPLICIT mismatch — undefined
        // location means "no restriction recorded", which we treat as
        // permissive to avoid breaking older accounts. Owners/admins
        // can always post anywhere (their role bypasses the gate).
        if (!isAdmin && viewer?.location
            && viewer.location !== 'both'
            && viewer.location !== location) {
            toast(
                tx(`You can only 86 items at your location (${viewer.location}).`,
                   `Solo puedes marcar 86 en tu ubicación (${viewer.location}).`),
                { kind: 'warn' }
            );
            return;
        }
        setPosting86(true);
        try {
            // 1. Send the chat message — the EightySixCard renders
            //    from message.eightySixData so we pack everything
            //    needed into that field.
            await sendMessage({
                chat, staffName, viewer, staffList,
                type: 'eighty_six_alert',
                text: `🚫 86: ${itemName}${note ? ` — ${note}` : ''}`,
                eightySixData: {
                    itemName,
                    location,
                    note: note || '',
                    transition: 'out',
                    addedBy: staffName,
                    resolved: false,
                },
            });

            // 2. Update /ops/86_{location} — append to the items
            //    array if not already present. Wrapped in a
            //    runTransaction so two cooks 86'ing the same item in
            //    the same second don't read identical "exists: false"
            //    snapshots + both write a duplicate row. Firestore
            //    will retry the transaction body if the doc changed
            //    between read and commit, so the dedup check stays
            //    correct under contention.
            try {
                const ref = doc(db, 'ops', `86_${location}`);
                await runTransaction(db, async (txn) => {
                    const snap = await txn.get(ref);
                    const cur = snap.exists() ? (snap.data().items || []) : [];
                    const norm = itemName.trim().toLowerCase();
                    const exists = cur.some(it => String(it?.name || '').trim().toLowerCase() === norm);
                    if (exists) return; // already on the list — no-op
                    const nextItems = [
                        ...cur,
                        {
                            name: itemName,
                            status: 'OUT_OF_STOCK',
                            addedBy: staffName,
                            addedAt: new Date().toISOString(),
                            source: 'chat',
                        },
                    ];
                    txn.set(ref, { items: nextItems, updatedAt: serverTimestamp() }, { merge: true });
                });
            } catch (e) {
                // Non-fatal — the chat message + push already went
                // out. Surface a warn so the dashboard sync issue is
                // visible without aborting the alert.
                console.warn('86 list sync failed:', e);
            }

            // 3. FCM fan-out + audit. notifyRecipients is the chat's
            //    member list minus the sender — matches the existing
            //    Eighty6Dashboard fan-out behavior at a smaller
            //    scope. (Dashboard fan-out is location-wide; chat
            //    fan-out is chat-wide. Caller's choice.)
            const recipients = (chat?.members || []).filter(n => n && n !== staffName);
            await postEightySixToChat({
                location,
                itemName,
                transition: 'out',
                actorName: staffName,
                actorId: viewer?.id,
                notifyRecipients: recipients,
            });

            setShow86Modal(false);
            toast(tx('86 posted', '86 publicado'), { kind: 'success' });
        } catch (e) {
            console.warn('86 post failed:', e);
            toast(tx('Could not post 86', 'No se pudo publicar 86'), { kind: 'error' });
        } finally {
            setPosting86(false);
        }
    }

    // Mark a previously-86'd item back in stock. Manager + the
    // original poster can resolve; the button only renders for
    // those viewers (see EightySixCard render). We:
    //   1. Patch the source message: eightySixData.resolved = true
    //      + resolvedBy/resolvedAt (so the card flips to its muted
    //      "Back in Stock" treatment)
    //   2. Remove the item from /ops/86_{location}.items
    //   3. Post a new eighty_six_alert with transition='in' so the
    //      team sees a fresh "back in stock" bubble
    async function handleResolve86(message) {
        if (!message?.id) return;
        const data = message.eightySixData || {};
        const itemName = data.itemName;
        const location = data.location;
        if (!itemName || !location) return;
        // Permission check: manager OR original poster
        if (!isAdmin && !isManager && message.senderName !== staffName) return;

        try {
            // 1. Patch the source 86 message
            await updateDoc(doc(db, 'chats', chat.id, 'messages', message.id), {
                'eightySixData.resolved': true,
                'eightySixData.resolvedBy': staffName,
                'eightySixData.resolvedAt': serverTimestamp(),
            });

            // 2. Update the live 86 list — drop the item via the
            //    same runTransaction pattern as the post path. Two
            //    managers tapping "back in stock" simultaneously
            //    would otherwise both read the item present + both
            //    write a filtered-out items array, which is fine for
            //    THIS item but could clobber a DIFFERENT 86 added
            //    between the two reads.
            try {
                const ref = doc(db, 'ops', `86_${location}`);
                await runTransaction(db, async (txn) => {
                    const snap = await txn.get(ref);
                    if (!snap.exists()) return;
                    const cur = snap.data().items || [];
                    const norm = itemName.trim().toLowerCase();
                    const next = cur.filter(it => String(it?.name || '').trim().toLowerCase() !== norm);
                    if (next.length === cur.length) return; // nothing to remove
                    txn.set(ref, { items: next, updatedAt: serverTimestamp() }, { merge: true });
                });
            } catch (e) {
                console.warn('86 list resolve sync failed:', e);
            }

            // 3. Post a fresh "back in stock" message
            await sendMessage({
                chat, staffName, viewer, staffList,
                type: 'eighty_six_alert',
                text: `✅ Back in stock: ${itemName}`,
                eightySixData: {
                    itemName,
                    location,
                    transition: 'in',
                    addedBy: staffName,
                },
            });

            await postEightySixToChat({
                location,
                itemName,
                transition: 'in',
                actorName: staffName,
                actorId: viewer?.id,
                notifyRecipients: (chat?.members || []).filter(n => n && n !== staffName),
            });
        } catch (e) {
            console.warn('86 resolve failed:', e);
            toast(tx('Could not resolve', 'No se pudo resolver'), { kind: 'error' });
        }
    }

    // ── Scheduled send ────────────────────────────────────────────
    // Stash the draft (+ any reply target / poll) into /scheduled_messages
    // with a future sendAt. A Cloud Function (sendScheduledChatMessages)
    // scans every minute, delivers due messages, and marks the doc
    // status='sent'. We never write to chats/{id}/messages directly here.
    //
    // Why a separate collection vs. a `scheduledFor` field on the
    // message doc: scheduled messages aren't VISIBLE in the thread —
    // they shouldn't show up in the normal messages subscription. A
    // separate collection keeps the read path simple. The Cloud
    // Function does the actual delivery so closing the app doesn't
    // strand the message.
    async function handleScheduleSend(sendAt) {
        const body = draft.trim();
        if (!body) return;
        try {
            await addDoc(collection(db, 'scheduled_messages'), {
                chatId: chat.id,
                createdBy: staffName,
                createdById: viewer?.id || null,
                createdAt: serverTimestamp(),
                sendAt: Timestamp.fromDate(sendAt),
                status: 'pending',
                payload: {
                    type: 'text',
                    text: body,
                    // mentions are re-parsed at delivery time so they
                    // match the live staff list (someone might be added
                    // or renamed between scheduling and sending).
                    ...(replyTarget && replyTarget.id ? { replyTo: replyTarget } : {}),
                    // Carry the sender's "Notify anyway" intent into the
                    // future. Without this, the Cloud Function would
                    // apply the off-shift gate at DELIVERY time, even
                    // though the manager already made the explicit
                    // override decision at SCHEDULING time. Surface in
                    // the audit trail of the scheduled doc.
                    ...(notifyAnyway ? { forceDeliver: true } : {}),
                },
            });
            setDraft('');
            setReplyTarget(null);
            setNotifyAnyway(false);
            setShowScheduleModal(false);
            toast(tx('Scheduled', 'Programado'), { kind: 'success' });
        } catch (e) {
            console.warn('schedule failed:', e);
            toast(tx('Schedule failed', 'Error al programar'), { kind: 'error' });
        }
    }

    // Cancel a pending scheduled message before delivery. Realtime
    // subscription removes it from the banner immediately.
    async function handleCancelScheduled(id) {
        try {
            await deleteDoc(doc(db, 'scheduled_messages', id));
        } catch (e) {
            console.warn('cancel scheduled failed:', e);
            toast(tx('Cancel failed', 'Error al cancelar'), { kind: 'error' });
        }
    }

    // Group messages by date for date separators ("Today", "Yesterday", date)
    const grouped = useMemo(() => groupByDate(messages, isEs), [messages, isEs]);

    return (
        <div className="flex flex-col h-full bg-dd-bg">
            {/* ── Header ──────────────────────────────────────── */}
            {/* The whole avatar+name+subtitle block is tappable so
                opening "members + settings" is unmissable. The trailing
                Members chip is an extra-obvious entry point for the
                manage-membership flow Andrew kept missing. */}
            <header className="px-3 py-2.5 border-b border-dd-line bg-white flex items-center gap-2 shrink-0">
                <button
                    onClick={onBack}
                    className="md:hidden w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center text-dd-text text-xl"
                    aria-label={tx('Back', 'Atrás')}
                >
                    ←
                </button>
                <button
                    onClick={onOpenSettings}
                    className="flex items-center gap-3 min-w-0 flex-1 -mx-1 px-1 py-0.5 rounded-lg hover:bg-dd-bg active:bg-dd-bg text-left"
                    title={tx('Open chat info', 'Abrir info del chat')}
                >
                    <ChatAvatar chat={chat} viewerName={staffName} size={36} />
                    <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-black text-dd-text truncate">
                            {chatDisplayName(chat, staffName)}
                        </div>
                        <div className="text-[11px] text-dd-text-2 truncate">
                            {chat.type === 'dm'
                                ? (typingNames.length > 0
                                    ? tx('typing…', 'escribiendo…')
                                    : (offShiftRecipients.length > 0
                                        ? `🔕 ${tx('off-shift · won\'t be pushed', 'fuera de turno · sin push')}`
                                        : tx('Direct message · tap for info', 'Mensaje directo · tap info')))
                                : (typingNames.length > 0
                                    ? `${formatChatName(typingNames[0])} ${tx('is typing…', 'está escribiendo…')}`
                                    : (offShiftRecipients.length > 0
                                        ? `${(chat.members || []).length} ${tx('members', 'miembros')} · 🔕 ${offShiftRecipients.length} ${tx('off-shift', 'fuera de turno')}`
                                        : `${(chat.members || []).length} ${tx('members', 'miembros')} · ${tx('tap to manage', 'tap para gestionar')}`))}
                        </div>
                    </div>
                </button>
                {/* Members button — labeled, large, unmissable. Only
                    shown on group/channel chats (DMs don't have
                    addable members). On groups it's the primary
                    add/remove path; on channels it opens the info
                    modal showing auto-managed membership. */}
                {chat.type !== 'dm' && (
                    <button
                        onClick={onOpenSettings}
                        className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-dd-sage-50 border border-dd-green/30 hover:bg-dd-green/10 text-[11px] font-black text-dd-green-700 active:scale-95 transition shrink-0"
                    >
                        <span>👥</span>
                        <span>{tx('Members', 'Miembros')}</span>
                        <span className="tabular-nums opacity-70">({(chat.members || []).length})</span>
                    </button>
                )}
                {/* Settings gear — always visible. Same destination as
                    the header-name tap above; kept for users who learn
                    the iconography. */}
                <button
                    onClick={onOpenSettings}
                    className="w-9 h-9 rounded-full hover:bg-dd-bg flex items-center justify-center text-lg shrink-0"
                    aria-label={tx('Settings', 'Configuración')}
                    title={canEdit ? tx('Edit', 'Editar') : tx('Info', 'Info')}
                >
                    {canEdit ? '⚙️' : 'ⓘ'}
                </button>
            </header>

            {/* ── Pin banner — only when ≥1 pinned message ──────────── */}
            {pinnedMessages.length > 0 && (
                <button
                    onClick={() => setShowPinsDrawer(true)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 bg-amber-50 border-b border-amber-200 hover:bg-amber-100 text-left shrink-0"
                >
                    <span className="text-amber-700">📌</span>
                    <span className="flex-1 text-xs text-amber-900 truncate">
                        <b>{pinnedMessages.length}</b> {tx('pinned', 'fijado')}{pinnedMessages.length !== 1 ? (isEs ? 's' : '') : ''}: <i>{pinnedMessages[0].text ? pinnedMessages[0].text.slice(0, 60) : (pinnedMessages[0].type === 'image' ? '📷' : '—')}{pinnedMessages[0].text?.length > 60 ? '…' : ''}</i>
                    </span>
                    <span className="text-xs text-amber-700 font-bold">{tx('View →', 'Ver →')}</span>
                </button>
            )}

            {/* ── Message list ────────────────────────────────── */}
            {/* CLASSIC FLEXBOX FIX (Andrew 2026-05-17): the messages list
                MUST have `min-h-0` — without it, a flex item with
                `flex-1 overflow-y-auto` defaults to min-height: auto,
                which means the item grows to its content size and
                pushes the parent flex container to expand beyond its
                bounds. Result: the header + composer get dragged
                off-screen as you scroll because the whole ChatThread
                is taller than its parent. min-h-0 forces the item to
                honor the parent's height constraint, so overflow-y-auto
                actually scrolls INSIDE the bounded box. min-w-0 is the
                same gotcha on the horizontal axis (kept defensively
                for long inline content like raw URLs). */}
            {/* Andrew 2026-05-20 — "if i pull up again it brings the
                text window up off of the bottom and stays up even when
                i scroll back down". iOS over-scroll on the message list
                was propagating the bounce up to the parent, which
                detached the sticky composer at the bottom. overscroll-
                behavior: contain stops the bounce from bubbling up so
                the composer stays anchored regardless of how hard the
                user pulls. WebkitOverflowScrolling keeps the momentum
                scroll feeling on iOS. */}
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain px-3 py-2 space-y-1"
                style={{ WebkitOverflowScrolling: 'touch' }}
            >
                {/* Load-older button — only when we haven't reached the
                    bottom of the message history yet. Bumps the limit
                    by 50 and re-runs the subscription. */}
                {hasMore && messages.length > 0 && (
                    <div className="text-center py-2">
                        <button
                            onClick={loadOlderMessages}
                            className="text-[11px] font-bold text-dd-green hover:text-dd-green-700 px-3 py-1.5 rounded-full bg-dd-sage-50 border border-dd-green/30 hover:bg-dd-green/10 active:scale-95 transition"
                        >
                            ↑ {tx('Load older messages', 'Cargar mensajes antiguos')}
                        </button>
                    </div>
                )}
                {grouped.map((group) => (
                    <div key={group.label}>
                        <div className="text-center text-[11px] font-bold text-dd-text-2 uppercase tracking-widest py-3">
                            {group.label}
                        </div>
                        {group.messages.map((msg, i) => {
                            const prev = group.messages[i - 1];
                            const sameSender = prev?.senderName === msg.senderName
                                && msg.createdAt?.toMillis && prev?.createdAt?.toMillis
                                && (msg.createdAt.toMillis() - prev.createdAt.toMillis()) < 5 * 60 * 1000;
                            return (
                                <MessageBubbleInner
                                    key={msg.id}
                                    message={msg}
                                    chat={chat}
                                    isMine={msg.senderName === staffName}
                                    showSender={!sameSender && chat.type !== 'dm'}
                                    showAvatar={!sameSender}
                                    isEs={isEs}
                                    staffName={staffName}
                                    viewer={viewer}
                                    isAdmin={isAdmin}
                                    isManager={isManager}
                                    myAcks={myAcks}
                                    highlighted={msg.id === highlightMsgId}
                                    targetLang={targetLang}
                                    autoTranslate={autoTranslate}
                                    onReact={(emoji) => handleReact(msg, emoji)}
                                    onReply={() => handleReply(msg)}
                                    onAck={() => handleAck(msg)}
                                    onOpenAckDashboard={() => setAckDashboardMsg(msg)}
                                    onTogglePin={() => handleTogglePin(msg)}
                                    onMakeTask={() => setTaskModalMsg(msg)}
                                    onDelete={() => handleDelete(msg)}
                                    onCopy={() => handleCopyText(msg)}
                                    onClaimCoverage={() => handleClaimCoverage(msg)}
                                    onApproveCoverage={() => handleApproveCoverage(msg)}
                                    onDenyCoverage={() => handleDenyCoverage(msg)}
                                    onWithdrawCoverage={() => handleWithdrawCoverage(msg)}
                                    onVote={(optionId) => handleVote(msg, optionId)}
                                    onClosePoll={() => handleClosePoll(msg)}
                                    onResolve86={() => handleResolve86(msg)}
                                    onNudge={(targetName) => handleNudge(msg, targetName)}
                                    onNudgeAll={(targetNames) => handleNudgeAll(msg, targetNames)}
                                    editing={editingMessageId === msg.id}
                                    onStartEdit={() => setEditingMessageId(msg.id)}
                                    onCancelEdit={() => setEditingMessageId(null)}
                                    onSaveEdit={(newText) => handleEditMessage(msg, newText)}
                                    onJumpToReply={(targetId) => {
                                        if (!targetId) return;
                                        setHighlightMsgId(targetId);
                                        setAtBottom(false);
                                        setTimeout(() => {
                                            const el = document.getElementById(`msg-${targetId}`);
                                            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                            setTimeout(() => setHighlightMsgId(null), 2500);
                                        }, 60);
                                    }}
                                />
                            );
                        })}
                    </div>
                ))}
                {messages.length === 0 && (
                    <div className="py-12 text-center text-sm text-dd-text-2">
                        {tx('Be the first to say hi 👋', '¡Sé el primero en saludar 👋!')}
                    </div>
                )}
            </div>

            {/* ── Upload progress ─────────────────────────────── */}
            {uploadProgress && (
                <div className="px-4 py-2 text-xs text-dd-text-2 border-t border-dd-line bg-white">
                    {tx(`Uploading ${uploadProgress.kind}…`, `Subiendo ${uploadProgress.kind}…`)}
                </div>
            )}

            {/* ── Feature drawers / modals ────────────────────── */}
            {showPinsDrawer && (
                <Suspense fallback={null}>
                    <ChatPinsDrawer
                        chat={chat}
                        language={language}
                        staffName={staffName}
                        targetLang={targetLang}
                        autoTranslate={autoTranslate}
                        onClose={() => setShowPinsDrawer(false)}
                        onJumpToMessage={(id) => {
                            setHighlightMsgId(id);
                            setAtBottom(false);
                            setTimeout(() => {
                                const el = document.getElementById(`msg-${id}`);
                                el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                // Auto-clear highlight after 2s
                                setTimeout(() => setHighlightMsgId(null), 2500);
                            }, 100);
                        }}
                    />
                </Suspense>
            )}
            {ackDashboardMsg && (
                <Suspense fallback={null}>
                    <ChatAckDashboard
                        chat={chat}
                        message={ackDashboardMsg}
                        language={language}
                        staffName={staffName}
                        viewer={viewer}
                        onClose={() => setAckDashboardMsg(null)}
                    />
                </Suspense>
            )}
            {taskModalMsg && (
                <Suspense fallback={null}>
                    <ChatTaskFromMessageModal
                        chat={chat}
                        message={taskModalMsg}
                        language={language}
                        staffName={staffName}
                        staffList={staffList}
                        viewer={viewer}
                        onClose={() => setTaskModalMsg(null)}
                        onCreated={() => setTaskModalMsg(null)}
                    />
                </Suspense>
            )}

            {/* ── Scheduled-message banner ─────────────────── */}
            {scheduledMessages.length > 0 && (
                <button
                    onClick={() => setShowScheduledDrawer(true)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 bg-dd-sage-50 border-t border-dd-green/30 hover:bg-dd-green/10 text-left shrink-0"
                >
                    <span className="text-dd-green-700">📅</span>
                    <span className="flex-1 text-xs text-dd-green-700 truncate">
                        <b>{scheduledMessages.length}</b> {tx(
                            scheduledMessages.length === 1 ? 'scheduled' : 'scheduled',
                            scheduledMessages.length === 1 ? 'programado' : 'programados'
                        )} · <i>{previewScheduledList(scheduledMessages, isEs)}</i>
                    </span>
                    <span className="text-xs text-dd-green-700 font-bold">{tx('View →', 'Ver →')}</span>
                </button>
            )}

            {/* ── Failed sends queue ──────────────────────────────
                Visible just above the composer so the user notices
                immediately on the next render. Per-entry actions:
                  • Retry  → resend; on success leaves the queue
                  • Edit   → copy body back to draft, drop from queue
                  • Dismiss→ drop from queue without sending
                Hidden when there's nothing to retry — no chrome cost
                during normal operation. */}
            {failedSends.length > 0 && (
                <div className="shrink-0 border-t border-red-200 bg-red-50 px-3 py-2 space-y-1.5">
                    <div className="text-[11px] font-black text-red-700 uppercase tracking-wider">
                        {tx(`${failedSends.length} message${failedSends.length === 1 ? '' : 's'} failed to send`,
                            `${failedSends.length} mensaje${failedSends.length === 1 ? '' : 's'} no enviado${failedSends.length === 1 ? '' : 's'}`)}
                    </div>
                    {failedSends.map(item => (
                        <div key={item.id} className="flex items-start gap-2 bg-white border border-red-200 rounded-lg px-2.5 py-1.5">
                            <div className="flex-1 min-w-0">
                                <div className="text-[13px] text-dd-text leading-snug truncate">
                                    {item.body}
                                </div>
                                <div className="text-[10px] text-red-600 mt-0.5">
                                    {tx('Tap retry, or edit and resend', 'Toca reintentar o edita y reenvía')}
                                </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                <button onClick={() => retryFailedSend(item.id)}
                                    className="px-2 py-1 rounded-md bg-red-600 text-white text-[11px] font-bold hover:bg-red-700 active:scale-95 transition">
                                    ↻ {tx('Retry', 'Reintentar')}
                                </button>
                                <button onClick={() => recoverFailedSendToDraft(item.id)}
                                    className="px-2 py-1 rounded-md bg-white border border-red-200 text-red-700 text-[11px] font-bold hover:bg-red-100 transition">
                                    ✎ {tx('Edit', 'Editar')}
                                </button>
                                <button onClick={() => discardFailedSend(item.id)}
                                    title={tx('Discard', 'Descartar')}
                                    className="px-1.5 py-1 rounded-md text-red-500 text-[12px] font-bold hover:bg-red-100 transition">
                                    ✕
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Composer ────────────────────────────────────── */}
            <Composer
                isEs={isEs}
                draft={draft}
                setDraft={(v) => { setDraft(v); if (v) maybeSendTyping(); }}
                sending={sending}
                recording={recording}
                replyTarget={replyTarget}
                onClearReply={() => setReplyTarget(null)}
                offShiftRecipients={offShiftRecipients}
                notifyAnyway={notifyAnyway}
                onToggleNotifyAnyway={() => setNotifyAnyway(v => !v)}
                onSendText={handleSendText}
                onPickImage={(e) => handleMediaPick(e, 'image')}
                onPickVideo={(e) => handleMediaPick(e, 'video')}
                onStartRecording={startRecording}
                onStopRecording={() => stopRecording(false)}
                onCancelRecording={() => stopRecording(true)}
                onOpenPoll={() => setShowPollModal(true)}
                onOpenSchedule={() => setShowScheduleModal(true)}
                onOpen86={() => setShow86Modal(true)}
                recordStartMs={recordStartRef.current}
            />

            {/* ── Poll modal ──────────────────────────────────── */}
            {showPollModal && (
                <Suspense fallback={null}>
                    <ChatPollModal
                        language={language}
                        chat={chat}
                        busy={pollSubmitting}
                        onClose={() => setShowPollModal(false)}
                        onCreate={handleCreatePoll}
                    />
                </Suspense>
            )}

            {/* ── Schedule modal ─────────────────────────────── */}
            {showScheduleModal && (
                <Suspense fallback={null}>
                    <ChatScheduleModal
                        language={language}
                        onClose={() => setShowScheduleModal(false)}
                        onPick={handleScheduleSend}
                    />
                </Suspense>
            )}

            {/* ── 86 modal ────────────────────────────────────── */}
            {show86Modal && (
                <Suspense fallback={null}>
                    <ChatEightySixModal
                        language={language}
                        viewer={viewer}
                        inventory={INVENTORY_CATEGORIES}
                        busy={posting86}
                        onClose={() => setShow86Modal(false)}
                        onPost={handlePost86}
                    />
                </Suspense>
            )}

            {/* ── Scheduled-list drawer ──────────────────────── */}
            {showScheduledDrawer && (
                <ScheduledListDrawer
                    items={scheduledMessages}
                    isEs={isEs}
                    onCancel={handleCancelScheduled}
                    onClose={() => setShowScheduledDrawer(false)}
                />
            )}
        </div>
    );
}

// Default export — wraps the thread in an error boundary so a render
// crash in one chat doesn't kill the whole Chat tab. Re-keys the
// inner component on chat.id so React tears down + remounts when
// the user switches chats; without the key, error-boundary state
// would persist across chats ("this chat is broken" sticking even
// after navigating to a different chat). Added 2026-05-23 after the
// audit flagged chat as the highest-risk surface.
export default function ChatThread(props) {
    const chatId = props?.chat?.id || 'no-chat';
    return (
        <ChatThreadErrorBoundary key={chatId} onReset={props?.onBack}>
            <ChatThreadInner {...props} />
        </ChatThreadErrorBoundary>
    );
}

// ── MessageBubble ───────────────────────────────────────────────
//
// Inner component — exported as memoized MessageBubble below.
// Memoization is critical here: Firestore re-deserializes the
// `messages` array on every snapshot tick (reactions, read receipts,
// new messages), giving every bubble a NEW message-object ref even
// when nothing about that bubble changed. With 50–200 messages on
// screen and per-bubble subtrees (AnnouncementCard, PollCard,
// EightySixCard, audio player, translation), an un-memoized
// re-render of the whole list is the dominant frame cost on iOS
// Safari. The custom comparator below ignores function-ref identity
// (the inline `(emoji) => handleReact(msg, emoji)` closures at the
// call site capture `msg` which we already compare field-by-field,
// so the OLD closure works on the OLD msg correctly) and compares
// the message + chat.lastReadByName + iAcked + the primitive props.
function MessageBubbleInner({
    message, chat, isMine, showSender, showAvatar, isEs, staffName,
    viewer, isAdmin, isManager, myAcks, highlighted,
    targetLang, autoTranslate,
    onReact, onReply, onAck, onOpenAckDashboard, onTogglePin, onMakeTask, onDelete, onCopy,
    onClaimCoverage, onApproveCoverage, onDenyCoverage, onWithdrawCoverage,
    onVote, onClosePoll, onResolve86, onNudge, onNudgeAll,
    editing, onStartEdit, onCancelEdit, onSaveEdit,
    onJumpToReply,
}) {
    const tx = (en, es) => (isEs ? es : en);
    const [showActions, setShowActions] = useState(false);  // long-press menu
    const [showSeenBy, setShowSeenBy] = useState(false);    // seen-by sheet
    const reactionEntries = Object.entries(message.reactions || {})
        .filter(([, names]) => Array.isArray(names) && names.length > 0);
    // Read-receipts gating + readers list. Computed every render — both
    // helpers are cheap and need to reflect the live `lastReadByName`
    // map on the chat doc (which updates ~1.5s after each viewer scrolls
    // a new message into view).
    const canSeeReceipts = canSeeReceiptsForMessage(chat, message, viewer, isAdmin);
    const seenBy = canSeeReceipts ? getSeenByForMessage(chat, message) : [];
    const mentioned = Array.isArray(message.mentions) && message.mentions.includes(staffName);
    const time = useMemo(() => {
        const ts = message.createdAt;
        const ms = ts?.toMillis ? ts.toMillis()
            : (ts?.seconds ? ts.seconds * 1000 : 0);
        if (!ms) return '';
        const d = new Date(ms);
        return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }, [message.createdAt]);

    // Long-press → action menu (reactions + pin + task + delete).
    const longPressTimer = useRef(null);
    function startLongPress() {
        longPressTimer.current = setTimeout(() => setShowActions(true), 400);
    }
    function endLongPress() {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
    }

    // ── Soft-deleted: render a placeholder ────────────────────
    if (message.deleted) {
        return (
            <div className="text-center text-[11px] text-dd-text-2 italic py-1">
                {isEs ? '(mensaje eliminado)' : '(message deleted)'}
            </div>
        );
    }

    // ── System events: minimal centered text ──────────────────
    if (message.type === 'system' || message.type === 'system_event') {
        return (
            <div className="text-center text-[11px] text-dd-text-2 italic py-1">
                {message.text}
            </div>
        );
    }

    // ── Specialty cards: full-width, type-specific UI ─────────
    // These bypass the bubble shell entirely — they ARE the card.
    if (message.type === 'announcement') {
        return (
            <div id={`msg-${message.id}`} className={`relative my-2 transition ${highlighted ? 'ring-2 ring-amber-400 rounded-2xl' : ''}`}>
                <AnnouncementCard
                    message={message}
                    chat={chat}
                    isMine={isMine}
                    isEs={isEs}
                    staffName={staffName}
                    viewer={viewer}
                    isAdmin={isAdmin}
                    isManager={isManager}
                    targetLang={targetLang}
                    autoTranslate={autoTranslate}
                    iAcked={myAcks?.has(message.id)}
                    onAck={onAck}
                    onOpenAckDashboard={onOpenAckDashboard}
                    onLongPress={() => setShowActions(true)}
                />
                {showActions && (
                    <MessageActionMenu
                        message={message} chat={chat} isMine={isMine} viewer={viewer}
                        isAdmin={isAdmin} isManager={isManager} isEs={isEs}
                        onClose={() => setShowActions(false)}
                        onReact={onReact} onReply={onReply} onTogglePin={onTogglePin}
                        onMakeTask={onMakeTask} onDelete={onDelete} onCopy={onCopy}
                        onStartEdit={onStartEdit}
                    />
                )}
            </div>
        );
    }
    if (message.type === 'coverage_request') {
        return (
            <div id={`msg-${message.id}`} className={`relative my-2 transition ${highlighted ? 'ring-2 ring-amber-400 rounded-2xl' : ''}`}>
                <CoverageCard
                    message={message}
                    chat={chat}
                    isMine={isMine}
                    isEs={isEs}
                    staffName={staffName}
                    viewer={viewer}
                    isAdmin={isAdmin}
                    isManager={isManager}
                    targetLang={targetLang}
                    autoTranslate={autoTranslate}
                    onClaim={onClaimCoverage}
                    onApprove={onApproveCoverage}
                    onDeny={onDenyCoverage}
                    onWithdraw={onWithdrawCoverage}
                    onLongPress={() => setShowActions(true)}
                />
                {showActions && (
                    <MessageActionMenu
                        message={message} chat={chat} isMine={isMine} viewer={viewer}
                        isAdmin={isAdmin} isManager={isManager} isEs={isEs}
                        onClose={() => setShowActions(false)}
                        onReact={onReact} onReply={onReply} onTogglePin={onTogglePin}
                        onMakeTask={onMakeTask} onDelete={onDelete} onCopy={onCopy}
                        onStartEdit={onStartEdit}
                    />
                )}
            </div>
        );
    }
    if (message.type === 'eighty_six_alert') {
        return (
            <div id={`msg-${message.id}`} className={`relative my-2 transition ${highlighted ? 'ring-2 ring-amber-400 rounded-2xl' : ''}`}>
                <EightySixCard
                    message={message}
                    isEs={isEs}
                    staffName={staffName}
                    isAdmin={isAdmin}
                    isManager={isManager}
                    onResolve={onResolve86}
                    onLongPress={() => setShowActions(true)}
                />
                {showActions && (
                    <MessageActionMenu
                        message={message} chat={chat} isMine={isMine} viewer={viewer}
                        isAdmin={isAdmin} isManager={isManager} isEs={isEs}
                        onClose={() => setShowActions(false)}
                        onReact={onReact} onReply={onReply} onTogglePin={onTogglePin}
                        onMakeTask={onMakeTask} onDelete={onDelete} onCopy={onCopy}
                        onStartEdit={onStartEdit}
                    />
                )}
            </div>
        );
    }
    if (message.type === 'photo_issue') {
        return (
            <div id={`msg-${message.id}`} className={`relative my-2 transition ${highlighted ? 'ring-2 ring-amber-400 rounded-2xl' : ''}`}>
                <PhotoIssueCard
                    message={message}
                    chat={chat}
                    isEs={isEs}
                    isManager={isManager}
                    staffName={staffName}
                    viewer={viewer}
                    targetLang={targetLang}
                    autoTranslate={autoTranslate}
                    onLongPress={() => setShowActions(true)}
                />
                {showActions && (
                    <MessageActionMenu
                        message={message} chat={chat} isMine={isMine} viewer={viewer}
                        isAdmin={isAdmin} isManager={isManager} isEs={isEs}
                        onClose={() => setShowActions(false)}
                        onReact={onReact} onReply={onReply} onTogglePin={onTogglePin}
                        onMakeTask={onMakeTask} onDelete={onDelete} onCopy={onCopy}
                        onStartEdit={onStartEdit}
                    />
                )}
            </div>
        );
    }
    if (message.type === 'task_handoff') {
        return (
            <div id={`msg-${message.id}`} className={`relative my-2 transition ${highlighted ? 'ring-2 ring-amber-400 rounded-2xl' : ''}`}>
                <TaskHandoffCard
                    message={message}
                    chat={chat}
                    isEs={isEs}
                    staffName={staffName}
                    targetLang={targetLang}
                    autoTranslate={autoTranslate}
                />
            </div>
        );
    }
    if (message.type === 'poll') {
        return (
            <div id={`msg-${message.id}`} className={`relative my-2 transition ${highlighted ? 'ring-2 ring-amber-400 rounded-2xl' : ''}`}>
                <PollCard
                    message={message}
                    isMine={isMine}
                    isEs={isEs}
                    staffName={staffName}
                    viewer={viewer}
                    isAdmin={isAdmin}
                    onVote={onVote}
                    onClose={onClosePoll}
                    onLongPress={() => setShowActions(true)}
                />
                {showActions && (
                    <MessageActionMenu
                        message={message} chat={chat} isMine={isMine} viewer={viewer}
                        isAdmin={isAdmin} isManager={isManager} isEs={isEs}
                        onClose={() => setShowActions(false)}
                        onReact={onReact} onReply={onReply} onTogglePin={onTogglePin}
                        onMakeTask={onMakeTask} onDelete={onDelete} onCopy={onCopy}
                        onStartEdit={onStartEdit}
                    />
                )}
            </div>
        );
    }

    return (
        <div
            id={`msg-${message.id}`}
            className={`flex gap-2 items-end ${isMine ? 'justify-end' : 'justify-start'} mb-0.5 transition ${highlighted ? 'bg-amber-100/50 rounded-xl' : ''}`}
            onContextMenu={(e) => { e.preventDefault(); setShowActions(true); }}
        >
            {!isMine && (
                <div className="w-7 shrink-0">
                    {showAvatar && (
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-dd-charcoal text-white text-[10px] font-black">
                            {(message.senderName || '?').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()}
                        </span>
                    )}
                </div>
            )}
            <div className={`max-w-[78%] sm:max-w-[60%] min-w-0 ${isMine ? 'items-end' : 'items-start'} flex flex-col`}>
                {showSender && !isMine && (
                    <span className="text-[11px] font-bold text-dd-text-2 mb-0.5 px-2">
                        {formatChatName(message.senderName)}
                    </span>
                )}
                <div className="relative">
                    <div
                        onTouchStart={startLongPress}
                        onTouchEnd={endLongPress}
                        onTouchCancel={endLongPress}
                        className={`relative rounded-2xl px-3 py-2 break-words ${isMine
                            ? 'bg-dd-green text-white rounded-br-md'
                            : (mentioned
                                ? 'bg-amber-50 text-dd-text border border-amber-300 rounded-bl-md'
                                : 'bg-white text-dd-text border border-dd-line rounded-bl-md')}`}
                    >
                        {/* Quoted reply preview — rendered ABOVE the bubble's
                            own content so the thread context reads top-down
                            (quote → reply body). Tap = scroll to the original
                            (or just flash if it's outside the loaded window).
                            Color treatment: a softer panel on top of the
                            bubble background — slightly off-tinted for both
                            "my" (green bubble → white-tint quote) and "their"
                            (white bubble → grey quote) so the quote always
                            reads as a NESTED block, not just bold text.
                            The author is bold; the snippet is regular weight
                            line-clamped to 2 so a long quote can't overrun
                            the bubble. Andrew (2026-05-17) — added with the
                            Zenzap-feature-parity batch. */}
                        {message.replyTo && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onJumpToReply?.(message.replyTo?.id); }}
                                className={`block w-full text-left mb-1 -mx-1 px-2 py-1.5 rounded-lg border-l-2 ${isMine
                                    ? 'bg-white/15 border-white/60 hover:bg-white/25'
                                    : 'bg-dd-bg border-dd-green/60 hover:bg-dd-bg/70'} transition`}
                                aria-label={isEs ? 'Saltar al mensaje original' : 'Jump to original message'}
                            >
                                <div className={`text-[10.5px] font-black uppercase tracking-wider ${isMine ? 'text-white/90' : 'text-dd-green-700'}`}>
                                    ↩ {message.replyTo.senderName || (isEs ? 'Mensaje' : 'Message')}
                                </div>
                                <div className={`text-[11.5px] line-clamp-2 ${isMine ? 'text-white/85' : 'text-dd-text-2'}`}>
                                    {message.replyTo.snippet || (isEs ? '(sin texto)' : '(no text)')}
                                </div>
                            </button>
                        )}
                        {message.type === 'image' && (
                            <MediaImage url={message.mediaUrl} alt="Photo" />
                        )}
                        {message.type === 'video' && (
                            <video src={message.mediaUrl} controls playsInline className="rounded-lg max-w-full max-h-[360px]" />
                        )}
                        {message.type === 'audio' && (
                            <AudioPlayer src={message.mediaUrl} duration={message.duration} isMine={isMine} />
                        )}
                        {(message.text || message.type === 'text') && (
                            editing ? (
                                <InlineEditor
                                    initialText={message.text || ''}
                                    isMine={isMine}
                                    isEs={isEs}
                                    onSave={(v) => onSaveEdit?.(v)}
                                    onCancel={() => onCancelEdit?.()}
                                />
                            ) : (
                                <TranslatableText
                                    message={message}
                                    targetLang={targetLang}
                                    autoTranslate={autoTranslate}
                                    staffName={staffName}
                                    chatId={chat.id}
                                    isMine={isMine}
                                    isEs={isEs}
                                    blockMode={message.type !== 'text'}
                                />
                            )
                        )}
                        <div className={`text-[10px] mt-1 text-right ${isMine ? 'text-white/70' : 'text-dd-text-2'}`}>
                            {time}
                            {message.edited && (
                                <span title={message.editedAt?.toMillis
                                    ? new Date(message.editedAt.toMillis()).toLocaleString()
                                    : ''}> · {tx('edited', 'editado')}</span>
                            )}
                        </div>
                    </div>
                    {/* Reactions row */}
                    {reactionEntries.length > 0 && (
                        <div className={`flex gap-1 mt-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
                            {reactionEntries.map(([emoji, names]) => {
                                const youReacted = names.includes(staffName);
                                return (
                                    <button
                                        key={emoji}
                                        onClick={() => onReact(emoji)}
                                        className={`px-1.5 py-0.5 rounded-full text-[12px] font-bold flex items-center gap-1 transition ${youReacted
                                            ? 'bg-dd-green/20 border border-dd-green/40 text-dd-green-700'
                                            : 'bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg'}`}
                                    >
                                        <span>{emoji}</span>
                                        <span className="tabular-nums">{names.length}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    {/* Action menu — reactions + pin + task + delete */}
                    {showActions && (
                        <MessageActionMenu
                            message={message} chat={chat} isMine={isMine} viewer={viewer}
                            isAdmin={isAdmin} isManager={isManager} isEs={isEs}
                            onClose={() => setShowActions(false)}
                            onReact={onReact} onTogglePin={onTogglePin}
                            onMakeTask={onMakeTask} onDelete={onDelete} onCopy={onCopy}
                        />
                    )}
                    {/* Pin chip overlay */}
                    {message.pinned === true && (
                        <span className={`absolute -top-2 ${isMine ? 'left-2' : 'right-2'} text-[10px] bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded-full font-black shadow-sm`}>
                            📌
                        </span>
                    )}
                    {/* Linked task chip */}
                    {message.linkedTaskId && (
                        <div className={`mt-1 flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-[11px] font-bold text-purple-700">
                                📋 {isEs ? 'Tarea creada' : 'Task created'}
                            </span>
                        </div>
                    )}
                    {/* Seen-by pill — small "Seen by N" link below the
                        bubble. Only renders when the viewer is allowed
                        to see receipts under chat.seenByVisibility AND
                        at least one other member has read past this
                        message. Tap → bottom-sheet with the readers
                        list + timestamps. */}
                    {canSeeReceipts && seenBy.length > 0 && (
                        <div className={`mt-1 flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                            <button
                                onClick={() => setShowSeenBy(true)}
                                className="text-[10px] text-dd-text-2 hover:text-dd-text px-1.5 py-0.5 rounded-full hover:bg-dd-bg transition flex items-center gap-1"
                                aria-label={tx('Show who has seen this', 'Mostrar quién lo ha visto')}
                                title={tx('Show readers', 'Mostrar lectores')}
                            >
                                <span>✓✓</span>
                                <span>
                                    {chat.type === 'dm'
                                        ? tx('Seen', 'Visto')
                                        : tx(`Seen by ${seenBy.length}`, `Visto por ${seenBy.length}`)}
                                </span>
                            </button>
                        </div>
                    )}
                </div>
            </div>
            {showSeenBy && (
                <SeenBySheet
                    seenBy={seenBy}
                    chat={chat}
                    message={message}
                    viewer={viewer}
                    isAdmin={isAdmin}
                    isManager={isManager}
                    isEs={isEs}
                    onNudge={onNudge}
                    onNudgeAll={onNudgeAll}
                    onClose={() => setShowSeenBy(false)}
                />
            )}
            {/* Double-tap-to-react affordance on desktop: small ➕ button
                shown on hover. Mobile uses long-press above. */}
            {!showActions && (
                <button
                    onClick={() => setShowActions(true)}
                    className={`hidden md:flex w-7 h-7 rounded-full hover:bg-dd-bg items-center justify-center text-dd-text-2 opacity-0 group-hover:opacity-100 transition ${isMine ? 'order-first' : ''}`}
                    aria-label="React"
                    title="React"
                >
                    ☺︎
                </button>
            )}
        </div>
    );
}

// Memo wrapper for MessageBubble. The comparator returns true (skip
// re-render) when no visible field has changed. Firestore Timestamps
// are compared via .toMillis() since the SDK rebuilds Timestamp
// objects on every snapshot. chat.lastReadByName is compared with a
// JSON hash because it's the input to canSeeReceiptsForMessage /
// getSeenByForMessage — when readers scroll a new msg into view,
// only the bubbles whose seen-by-count changed need to re-render
// (not all of them). Function-ref identity (onReact, onReply, etc.)
// is INTENTIONALLY ignored: the parent's inline arrow closures
// `(emoji) => handleReact(msg, emoji)` capture `msg` from the
// render scope; when we skip a re-render, the OLD closure stays
// bound to the OLD msg, but msg.id is what every handler ultimately
// uses to identify the target, and msg.id is stable for a given
// bubble. Safe in this codebase.
function msgFieldsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.id !== b.id) return false;
    if (a.text !== b.text) return false;
    if (a.edited !== b.edited) return false;
    if (a.deleted !== b.deleted) return false;
    if (a.pinned !== b.pinned) return false;
    if ((a.coverageStatus || '') !== (b.coverageStatus || '')) return false;
    if ((a.coverageClaimedBy || '') !== (b.coverageClaimedBy || '')) return false;
    if ((a.resolvedAt || null) !== (b.resolvedAt || null)) return false;
    // Reactions, mentions, poll, eightySixData are objects/arrays —
    // a JSON compare catches value changes without false positives
    // from Firestore ref churn. The strings are short.
    if (JSON.stringify(a.reactions || null) !== JSON.stringify(b.reactions || null)) return false;
    if (JSON.stringify(a.mentions || null) !== JSON.stringify(b.mentions || null)) return false;
    if (JSON.stringify(a.poll || null) !== JSON.stringify(b.poll || null)) return false;
    if (JSON.stringify(a.eightySixData || null) !== JSON.stringify(b.eightySixData || null)) return false;
    if (JSON.stringify(a.attachments || null) !== JSON.stringify(b.attachments || null)) return false;
    if (JSON.stringify(a.replyTo || null) !== JSON.stringify(b.replyTo || null)) return false;
    // createdAt only changes when the bubble first lands (server
    // resolves the timestamp), then never again.
    const amMs = a.createdAt?.toMillis?.() ?? a.createdAt?.seconds ?? 0;
    const bmMs = b.createdAt?.toMillis?.() ?? b.createdAt?.seconds ?? 0;
    if (amMs !== bmMs) return false;
    return true;
}
// Comparator is wrapped in a try/catch so any unexpected
// JSON.stringify failure (circular refs, weird Firestore values)
// falls through to "re-render anyway" instead of throwing into the
// ErrorBoundary and crashing the whole chat tab. The audit catches
// the rare case; the comparator never throws into React.
const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
    try {
        if (prev.isMine !== next.isMine) return false;
        if (prev.showSender !== next.showSender) return false;
        if (prev.showAvatar !== next.showAvatar) return false;
        if (prev.isEs !== next.isEs) return false;
        if (prev.staffName !== next.staffName) return false;
        if (prev.isAdmin !== next.isAdmin) return false;
        if (prev.isManager !== next.isManager) return false;
        if (prev.highlighted !== next.highlighted) return false;
        if (prev.targetLang !== next.targetLang) return false;
        if (prev.autoTranslate !== next.autoTranslate) return false;
        if (prev.editing !== next.editing) return false;
        // iAcked — the only myAcks state the bubble actually reads is
        // whether THIS message is in the set. Compare by membership,
        // not Set identity.
        const prevAcked = !!prev.myAcks?.has?.(prev.message?.id);
        const nextAcked = !!next.myAcks?.has?.(next.message?.id);
        if (prevAcked !== nextAcked) return false;
        // chat.lastReadByName drives the seen-by render. Hash it. (Tiny
        // map of staffName → ms-since-epoch ints.)
        if (JSON.stringify(prev.chat?.lastReadByName || null) !== JSON.stringify(next.chat?.lastReadByName || null)) return false;
        // chat.members affects mentions + seen-by gating. Stable usually.
        if (JSON.stringify(prev.chat?.members || null) !== JSON.stringify(next.chat?.members || null)) return false;
        if (!msgFieldsEqual(prev.message, next.message)) return false;
        // Function refs intentionally not compared — see comment block.
        return true;
    } catch (e) {
        console.warn('MessageBubble comparator threw — falling back to re-render', e);
        return false;
    }
});

// Inline editor for a message bubble — swaps the rendered text for
// an editable textarea + Save/Cancel buttons. Lives inside the same
// bubble shell so the surrounding context (reactions, seen-by, etc.)
// stays put and the edit feels in-place. Local state owns the draft;
// onSave fires with the trimmed value, parent decides whether to
// write or no-op.
//
// Layout: textarea sized to the bubble width, neutral background on
// "my" bubbles so the green-on-green doesn't bleed legibility. Cmd/
// Ctrl + Enter = Save. Esc = Cancel.
function InlineEditor({ initialText, isMine, isEs, onSave, onCancel }) {
    const tx = (en, es) => isEs ? es : en;
    const [draft, setDraft] = useState(initialText || '');
    const ref = useRef(null);
    useEffect(() => {
        // Auto-focus + select-all on mount so the user can either
        // start typing (replacing) or arrow to a spot (preserving).
        const t = ref.current;
        if (!t) return;
        t.focus();
        try { t.setSelectionRange(0, t.value.length); } catch {}
    }, []);
    function handleKey(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            onCancel?.();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave?.(draft);
        }
    }
    return (
        <div className={`block w-full ${isMine ? 'text-white' : 'text-dd-text'}`}>
            <textarea
                ref={ref}
                rows={Math.min(8, Math.max(2, draft.split('\n').length))}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKey}
                className={`w-full min-w-[200px] px-2 py-1.5 rounded-lg text-[14.5px] leading-snug resize-none focus:outline-none ${isMine
                    ? 'bg-white/15 text-white placeholder-white/60 border border-white/30'
                    : 'bg-dd-bg text-dd-text border border-dd-line'}`}
            />
            <div className="flex items-center justify-end gap-1.5 mt-1">
                <button
                    onClick={onCancel}
                    className={`px-2 py-1 rounded-full text-[11px] font-bold transition ${isMine
                        ? 'bg-white/15 text-white/90 hover:bg-white/25'
                        : 'bg-dd-bg text-dd-text-2 hover:bg-dd-line/40'}`}
                >
                    {tx('Cancel', 'Cancelar')}
                </button>
                <button
                    onClick={() => onSave?.(draft)}
                    disabled={!draft.trim()}
                    className={`px-3 py-1 rounded-full text-[11px] font-black transition disabled:opacity-40 ${isMine
                        ? 'bg-white text-dd-green hover:bg-white/90'
                        : 'bg-dd-green text-white hover:bg-dd-green-700'}`}
                >
                    {tx('Save', 'Guardar')}
                </button>
            </div>
        </div>
    );
}

// Image bubble with lightbox-on-tap. Lazy-loads via the browser.
function MediaImage({ url, alt }) {
    const [zoom, setZoom] = useState(false);
    if (!url) return null;
    return (
        <>
            <img
                src={url}
                alt={alt}
                loading="lazy"
                onClick={() => setZoom(true)}
                className="rounded-lg max-w-full max-h-[360px] object-cover cursor-zoom-in"
            />
            {zoom && (
                <div
                    className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
                    onClick={() => setZoom(false)}
                >
                    <img src={url} alt={alt} className="max-w-full max-h-full object-contain" />
                </div>
            )}
        </>
    );
}

// Audio player — pill with play/pause + duration. Native <audio>
// controls are inconsistent across mobile browsers; we wrap our own.
function AudioPlayer({ src, duration, isMine }) {
    const audioRef = useRef(null);
    const [playing, setPlaying] = useState(false);
    const [t, setT] = useState(0);
    useEffect(() => {
        const a = audioRef.current;
        if (!a) return;
        const onTime = () => setT(a.currentTime);
        const onEnd = () => { setPlaying(false); setT(0); };
        a.addEventListener('timeupdate', onTime);
        a.addEventListener('ended', onEnd);
        return () => {
            a.removeEventListener('timeupdate', onTime);
            a.removeEventListener('ended', onEnd);
        };
    }, []);
    function toggle() {
        const a = audioRef.current;
        if (!a) return;
        if (playing) { a.pause(); setPlaying(false); }
        else { a.play(); setPlaying(true); }
    }
    const total = duration || 0;
    const pct = total > 0 ? Math.min(100, (t / total) * 100) : 0;
    const fmt = (s) => {
        const m = Math.floor(s / 60);
        const r = Math.floor(s % 60);
        return `${m}:${String(r).padStart(2, '0')}`;
    };
    return (
        <div className="flex items-center gap-2 min-w-[180px]">
            {/* preload="none" so 200 visible voice messages don't each
                fire a HEAD request on chat open (200-GET storm noted
                in the 2026-05-22 production audit). The duration label
                shows the stored msg.duration field; metadata is fetched
                lazily when the user actually taps Play. */}
            <audio ref={audioRef} src={src} preload="none" />
            <button
                onClick={toggle}
                className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm ${isMine ? 'bg-white/20 text-white' : 'bg-dd-green text-white'}`}
            >
                {playing ? '▌▌' : '▶'}
            </button>
            <div className={`flex-1 h-1.5 rounded-full ${isMine ? 'bg-white/30' : 'bg-dd-line'}`}>
                <div
                    className={`h-full rounded-full ${isMine ? 'bg-white' : 'bg-dd-green'}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <span className={`text-[11px] tabular-nums shrink-0 ${isMine ? 'text-white/80' : 'text-dd-text-2'}`}>
                {fmt(playing || t > 0 ? t : total)}
            </span>
        </div>
    );
}


// ── Composer ─────────────────────────────────────────────────────
function Composer({
    isEs, draft, setDraft, sending, recording,
    replyTarget, onClearReply,
    offShiftRecipients = [], notifyAnyway = false, onToggleNotifyAnyway,
    onSendText, onPickImage, onPickVideo,
    onStartRecording, onStopRecording, onCancelRecording,
    onOpenPoll, onOpenSchedule, onOpen86,
    recordStartMs,
}) {
    const imageInputRef = useRef(null);
    const videoInputRef = useRef(null);
    // Textarea ref — needed so the emoji picker can insert at the
    // user's current cursor position (not blindly at the end). We
    // keep the cursor in a state slot too so re-renders don't lose
    // our place between key + emoji input.
    const textareaRef = useRef(null);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    // 2026-05-20 — Andrew: "make the staff chat page text bar have ai
    // to help with spelling and grammer too." One-tap ✨ button calls
    // the aiFixText Cloud Function (Claude Haiku) and replaces the
    // draft in place. Original is buffered for the Undo button on the
    // success toast so an unwanted "fix" is one tap away from revert.
    const [fixing, setFixing] = useState(false);
    const handleFixGrammar = async () => {
        const original = draft;
        const text = original.trim();
        if (!text || fixing || sending) return;
        if (text.length > 1000) {
            toast(isEs ? 'Mensaje muy largo para corregir.' : 'Message too long to fix.', { kind: 'warn' });
            return;
        }
        setFixing(true);
        try {
            const { fixed, changed } = await aiFixText({
                text,
                language: isEs ? 'es' : 'en',
            });
            if (!changed) {
                toast(isEs ? '✓ Ya está bien' : '✓ Looks good', { kind: 'success' });
            } else {
                setDraft(fixed);
                toast(isEs ? '✨ Corregido' : '✨ Fixed', {
                    kind: 'success',
                    actionLabel: isEs ? 'Deshacer' : 'Undo',
                    onAction: () => setDraft(original),
                    duration: 6000,
                });
            }
        } catch (e) {
            console.warn('aiFixText failed:', e);
            toast(isEs ? 'IA no disponible' : 'AI unavailable', { kind: 'error' });
        } finally {
            setFixing(false);
        }
    };

    // Insert an emoji at the textarea's current cursor position.
    // Falls back to "append at end" if the textarea isn't mounted
    // (e.g. on first render right after the picker mounts but the
    // ref hasn't latched yet — rare but possible).
    //
    // After insert we re-focus the textarea and place the caret AFTER
    // the inserted emoji so the user can keep typing without tapping
    // the field again.
    function insertEmoji(emoji) {
        const ta = textareaRef.current;
        if (!ta) {
            setDraft((draft || '') + emoji);
            return;
        }
        const start = ta.selectionStart ?? draft.length;
        const end = ta.selectionEnd ?? draft.length;
        const next = draft.slice(0, start) + emoji + draft.slice(end);
        setDraft(next);
        // Defer the cursor reposition until React has applied the
        // value update. Without rAF the caret jumps to 0 because the
        // <textarea> re-renders with the new value before our
        // setSelectionRange call lands.
        requestAnimationFrame(() => {
            const tx = textareaRef.current;
            if (!tx) return;
            tx.focus();
            const caret = start + emoji.length;
            try { tx.setSelectionRange(caret, caret); } catch {}
        });
    }
    useEffect(() => {
        if (!recording) { setElapsed(0); return; }
        const t = setInterval(() => setElapsed(Math.round((Date.now() - recordStartMs) / 1000)), 250);
        return () => clearInterval(t);
    }, [recording, recordStartMs]);

    function onKeyDown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSendText();
        }
    }

    if (recording) {
        return (
            <div className="px-3 py-3 border-t border-dd-line bg-white flex items-center gap-3">
                <button
                    onClick={onCancelRecording}
                    className="w-10 h-10 rounded-full bg-dd-bg flex items-center justify-center text-dd-text-2"
                    aria-label={isEs ? 'Cancelar' : 'Cancel'}
                >
                    ✕
                </button>
                <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-full bg-red-50 border border-red-200">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-sm font-bold text-red-700">
                        {isEs ? 'Grabando' : 'Recording'} · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
                    </span>
                </div>
                <button
                    onClick={onStopRecording}
                    className="w-10 h-10 rounded-full bg-dd-green text-white flex items-center justify-center font-black"
                    aria-label={isEs ? 'Enviar voz' : 'Send voice'}
                >
                    ➤
                </button>
            </div>
        );
    }

    const empty = !draft.trim();
    return (
        <div className="px-2 py-2 border-t border-dd-line bg-white shrink-0">
            {/* Off-shift recipient indicator — appears above the
                composer when at least one recipient is currently off
                shift (per the server's gate window: 30min-before-
                start through end-time). Surfaces:
                  • who's silenced and how many
                  • a "Notify anyway" toggle that sets forceDeliver=
                    true on the notification doc, which makes the
                    Cloud Function bypass the gate for this message
                Always-reachable members (managers, owners) are
                already excluded by offShiftMembers() so they never
                count toward this number. Andrew (2026-05-17). */}
            {offShiftRecipients.length > 0 && (
                <button
                    type="button"
                    onClick={onToggleNotifyAnyway}
                    className={`w-full flex items-center gap-2 mb-1 px-2 py-1.5 rounded-lg border text-left transition ${notifyAnyway
                        ? 'bg-amber-50 border-amber-300'
                        : 'bg-dd-bg border-dd-line hover:bg-dd-bg/70'}`}
                    aria-label={isEs ? 'Notificar de todos modos' : 'Notify anyway'}
                >
                    <span className="text-base shrink-0">{notifyAnyway ? '🔔' : '🔕'}</span>
                    <div className="flex-1 min-w-0">
                        <div className={`text-[11.5px] font-bold ${notifyAnyway ? 'text-amber-800' : 'text-dd-text-2'}`}>
                            {notifyAnyway
                                ? (isEs
                                    ? `Notificando de todos modos a ${offShiftRecipients.length}`
                                    : `Will push ${offShiftRecipients.length} anyway`)
                                : (isEs
                                    ? `🔕 ${offShiftRecipients.length} fuera de turno · no recibirán push`
                                    : `🔕 ${offShiftRecipients.length} off-shift · won't get push`)}
                        </div>
                        <div className="text-[10.5px] text-dd-text-2 truncate">
                            {offShiftRecipients.slice(0, 3).map(n => n.split(' ')[0]).join(', ')}
                            {offShiftRecipients.length > 3 && ` +${offShiftRecipients.length - 3}`}
                            {' · '}
                            {notifyAnyway
                                ? (isEs ? 'tap para desactivar' : 'tap to undo')
                                : (isEs ? 'tap para notificar' : 'tap to notify anyway')}
                        </div>
                    </div>
                </button>
            )}
            {/* Reply preview pill — shown above the input row when the
                user has tapped Reply on a message. The ✕ clears the
                target; tapping the body does nothing (intentionally —
                we don't want a stray tap to navigate away mid-type). */}
            {replyTarget && (
                <div className="flex items-stretch gap-2 mb-1 px-2 py-1.5 rounded-lg bg-dd-sage-50 border border-dd-green/30">
                    <div className="w-1 rounded-full bg-dd-green shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="text-[10.5px] font-black uppercase tracking-wider text-dd-green-700">
                            ↩ {isEs ? 'Respondiendo a' : 'Replying to'} {replyTarget.senderName || ''}
                        </div>
                        <div className="text-[12px] text-dd-text-2 truncate">
                            {replyTarget.snippet || (isEs ? '(sin texto)' : '(no text)')}
                        </div>
                    </div>
                    <button
                        onClick={onClearReply}
                        className="w-7 h-7 rounded-full hover:bg-white text-dd-text-2 flex items-center justify-center shrink-0"
                        aria-label={isEs ? 'Cancelar respuesta' : 'Cancel reply'}
                        title={isEs ? 'Cancelar' : 'Cancel'}
                    >
                        ✕
                    </button>
                </div>
            )}
            <div className="flex items-end gap-1.5">
                {/* Image */}
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={onPickImage}
                    className="hidden"
                />
                <button
                    onClick={() => imageInputRef.current?.click()}
                    disabled={sending}
                    className="w-10 h-10 rounded-full hover:bg-dd-bg flex items-center justify-center text-xl shrink-0 disabled:opacity-40"
                    aria-label={isEs ? 'Foto' : 'Photo'}
                    title={isEs ? 'Foto' : 'Photo'}
                >
                    📷
                </button>
                {/* Video */}
                <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/*"
                    onChange={onPickVideo}
                    className="hidden"
                />
                <button
                    onClick={() => videoInputRef.current?.click()}
                    disabled={sending}
                    className="w-10 h-10 rounded-full hover:bg-dd-bg flex items-center justify-center text-xl shrink-0 disabled:opacity-40"
                    aria-label={isEs ? 'Video' : 'Video'}
                    title={isEs ? 'Video' : 'Video'}
                >
                    🎬
                </button>
                {/* Poll */}
                {onOpenPoll && (
                    <button
                        onClick={onOpenPoll}
                        disabled={sending}
                        className="w-10 h-10 rounded-full hover:bg-dd-bg flex items-center justify-center text-xl shrink-0 disabled:opacity-40"
                        aria-label={isEs ? 'Encuesta' : 'Poll'}
                        title={isEs ? 'Encuesta' : 'Poll'}
                    >
                        📊
                    </button>
                )}
                {/* 86 alert — out of stock. Bright red ring on hover
                    so it visually stands apart from neutral actions
                    (this is destructive/operational, not a neutral
                    media insert). */}
                {onOpen86 && (
                    <button
                        onClick={onOpen86}
                        disabled={sending}
                        className="w-10 h-10 rounded-full hover:bg-red-50 hover:text-red-700 flex items-center justify-center text-xl shrink-0 disabled:opacity-40 transition"
                        aria-label={isEs ? 'Marcar 86' : 'Post 86'}
                        title={isEs ? '86 — sin existencia' : '86 — out of stock'}
                    >
                        🚫
                    </button>
                )}
                {/* Emoji picker — restaurant-themed catalog + recent
                    row. Tapping toggles the picker; the picker itself
                    inserts the chosen emoji at the cursor via
                    insertEmoji() and keeps itself open (keepOpen)
                    so the user can drop multiple emojis without
                    re-opening. Andrew (2026-05-17). */}
                <button
                    onClick={() => setShowEmojiPicker(v => !v)}
                    disabled={sending}
                    className={`w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 disabled:opacity-40 transition ${showEmojiPicker ? 'bg-dd-sage-50 text-dd-green-700' : 'hover:bg-dd-bg'}`}
                    aria-label={isEs ? 'Emojis' : 'Emojis'}
                    title={isEs ? 'Emojis' : 'Emojis'}
                >
                    😀
                </button>
                {/* ✨ Spell / grammar fix — only shows when there's text
                    in the draft. One-tap correction via aiFixText Cloud
                    Function. Loading spinner on the button while in
                    flight; Undo offered via toast for 6s after a fix. */}
                {!empty && (
                    <button
                        onClick={handleFixGrammar}
                        disabled={sending || fixing}
                        className={`w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0 disabled:opacity-40 transition ${fixing ? 'bg-purple-100 text-purple-700' : 'text-purple-600 hover:bg-purple-50'}`}
                        aria-label={isEs ? 'Corregir ortografía y gramática' : 'Fix spelling & grammar'}
                        title={isEs ? '✨ Corregir ortografía y gramática (IA)' : '✨ Fix spelling & grammar (AI)'}
                    >
                        {fixing
                            ? <span className="inline-block w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                            : '✨'}
                    </button>
                )}
                {/* Text input */}
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={isEs ? 'Mensaje…' : 'Message…'}
                    disabled={sending}
                    className="flex-1 min-w-0 px-3 py-2 rounded-2xl bg-dd-bg border border-dd-line text-[14.5px] text-dd-text resize-none focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green max-h-[120px]"
                    style={{ lineHeight: 1.4 }}
                />
                {/* Voice OR (Schedule + Send) */}
                {empty ? (
                    <button
                        onClick={onStartRecording}
                        disabled={sending}
                        className="w-10 h-10 rounded-full hover:bg-dd-bg flex items-center justify-center text-xl shrink-0 disabled:opacity-40"
                        aria-label={isEs ? 'Mensaje de voz' : 'Voice message'}
                        title={isEs ? 'Voz' : 'Voice'}
                    >
                        🎤
                    </button>
                ) : (
                    <>
                        {onOpenSchedule && (
                            <button
                                onClick={onOpenSchedule}
                                disabled={sending}
                                className="w-10 h-10 rounded-full hover:bg-dd-bg flex items-center justify-center text-lg shrink-0 disabled:opacity-40"
                                aria-label={isEs ? 'Programar' : 'Schedule'}
                                title={isEs ? 'Programar envío' : 'Schedule send'}
                            >
                                📅
                            </button>
                        )}
                        <button
                            onClick={onSendText}
                            disabled={sending}
                            className="w-10 h-10 rounded-full bg-dd-green text-white flex items-center justify-center font-black shrink-0 disabled:opacity-40 hover:bg-dd-green-700 active:scale-95 transition"
                            aria-label={isEs ? 'Enviar' : 'Send'}
                        >
                            ➤
                        </button>
                    </>
                )}
            </div>
            {/* Emoji picker — bottom sheet on mobile, popover on
                md+. Inserts at the textarea's cursor position. Lazy-
                loaded so the chat chunk doesn't pay for the emoji
                catalog up front. */}
            {showEmojiPicker && (
                <Suspense fallback={null}>
                    <ChatEmojiPicker
                        language={isEs ? 'es' : 'en'}
                        onPick={insertEmoji}
                        onClose={() => setShowEmojiPicker(false)}
                        keepOpen={true}
                    />
                </Suspense>
            )}
        </div>
    );
}

// ── sendMessage core ─────────────────────────────────────────────
// One choke-point so every send path (text/image/video/audio) goes
// through the same fan-out + notification + chat-doc denormalization
// flow. Keeps the write semantics consistent and lets us add features
// (mention parsing, reply target, etc.) in one place.
async function sendMessage({
    chat, staffName, viewer, staffList,
    type, text = '', mediaUrl, mediaPath, mediaType,
    duration, width, height, thumbnailUrl,
    replyTo, poll, eightySixData, forceDeliver = false,
}) {
    if (!chat?.id) return;
    const { mentions } = parseMentions(text, staffList);
    // Sanitize the reply target. We carry only the four fields the
    // bubble renderer + jump-to-message handler actually use, so the
    // doc stays small and we don't accidentally embed unrelated
    // message state into a reply.
    const replyToField = (replyTo && replyTo.id) ? {
        replyTo: {
            id: String(replyTo.id),
            senderName: replyTo.senderName || '',
            snippet: String(replyTo.snippet || '').slice(0, 120),
            type: replyTo.type || 'text',
        },
    } : {};
    // Poll: stamp the payload as-is. The closesAt field is a JS Date
    // from the modal; Firestore will store it as a Timestamp via the
    // SDK's automatic Date→Timestamp coercion.
    const pollField = (poll && Array.isArray(poll.options) && poll.options.length >= 2) ? { poll } : {};
    const eightySixField = (eightySixData && typeof eightySixData === 'object') ? { eightySixData } : {};
    const msgDoc = {
        senderName: staffName,
        senderId: viewer?.id || null,
        type,
        text,
        ...(mediaUrl ? { mediaUrl, mediaPath, mediaType } : {}),
        ...(duration != null ? { duration } : {}),
        ...(width != null ? { width } : {}),
        ...(height != null ? { height } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...replyToField,
        ...pollField,
        ...eightySixField,
        reactions: {},
        mentions,
        createdAt: serverTimestamp(),
    };
    // 1) Append message
    const ref = await addDoc(collection(db, 'chats', chat.id, 'messages'), msgDoc);

    // 2) Denormalize chat preview + bump activity
    const preview = type === 'image' ? '📷 Photo'
        : type === 'video' ? '🎬 Video'
        : type === 'audio' ? '🎤 Voice'
        : type === 'poll' ? `📊 ${poll?.question || 'Poll'}`
        : type === 'eighty_six_alert'
            ? `${eightySixData?.transition === 'in' ? '✅ Back in stock' : '🚫 86'}: ${eightySixData?.itemName || 'item'}`
            : text;
    try {
        await updateDoc(doc(db, 'chats', chat.id), {
            lastMessage: {
                text: preview.slice(0, 200),
                sender: staffName,
                ts: serverTimestamp(),
                type,
            },
            lastActivityAt: serverTimestamp(),
            // Clear my typing heartbeat — I just hit send.
            [`typingByName.${staffName}`]: null,
            // I implicitly read my own send.
            [`lastReadByName.${staffName}`]: serverTimestamp(),
        });
    } catch (e) {
        console.warn('chat-preview update failed:', e);
    }

    // 3) Fan-out notifications. We hit notifyStaff once per recipient
    // (not the existing notifyAdmins helper — chats span the whole team).
    //
    // Channels can have 30+ members. Each notification is a tiny doc,
    // and the dispatchNotification Cloud Function handles FCM delivery,
    // so fan-out is cheap. We mark @mentioned recipients with type
    // 'chat_mention' so the bell drawer can show a louder tone.
    const recipients = (chat.members || []).filter(n => n && n !== staffName);
    const chatLabel = chat.type === 'dm' ? staffName : (chat.name || 'Chat');
    const title = chat.type === 'dm' ? staffName : `${chatLabel}`;
    const body = chat.type === 'dm' ? preview : `${staffName}: ${preview}`;
    await Promise.all(recipients.map(async (to) => {
        const wasMentioned = mentions.includes(to);
        try {
            await notifyStaff({
                forStaff: to,
                type: wasMentioned ? 'chat_mention' : 'chat_message',
                title: wasMentioned ? `@${staffName} → ${title}` : title,
                body: body.slice(0, 140),
                // The NotificationsDrawer routes deepLink='chat' to
                // the chat tab. ChatCenter sorts unread chats to the
                // top so the user lands next to their new message.
                deepLink: 'chat',
                link: '/chat',
                tag: `chat:${chat.id}:${to}`,
                // 2026-05-16 — Andrew: every chat message must reach
                // every member ASAP. Flagging chat notifications as
                // high-priority signals to the FCM dispatcher (and any
                // future quiet-hours enforcement) that this delivery
                // can't be silenced or batched into a digest.
                priority: 'high',
                // Off-shift gate override — when the sender flipped
                // the "Notify anyway" toggle, stamp every recipient's
                // notif so the dispatcher bypasses the off-shift gate.
                // Mentions ALWAYS deliver regardless (server side),
                // but force-delivering them is harmless.
                forceDeliver: forceDeliver === true,
                createdBy: staffName,
            });
        } catch (e) {
            console.warn(`chat notify failed for ${to}:`, e);
        }
    }));
    return ref.id;
}

// ── Image resize via canvas ──────────────────────────────────────
// Cuts upload size + bandwidth dramatically. Phone cameras shoot
// 4000px+ images; we don't need anything above ~1600px for a chat.
async function resizeImage(file, maxDim) {
    const bitmap = await loadBitmap(file);
    const { width: srcW, height: srcH } = bitmap;
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return { blob, width: w, height: h };
}
async function loadBitmap(file) {
    if (typeof createImageBitmap === 'function') {
        try { return await createImageBitmap(file); } catch {}
    }
    // Fallback for browsers without createImageBitmap (older iOS Safari)
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
        img.src = url;
    });
}

async function probeVideo(file) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => {
            const meta = { duration: Math.round(v.duration || 0), width: v.videoWidth, height: v.videoHeight };
            URL.revokeObjectURL(url);
            resolve(meta);
        };
        v.onerror = () => { URL.revokeObjectURL(url); resolve({}); };
        v.src = url;
    });
}

// ─────────────────────────────────────────────────────────────────
// SPECIALTY MESSAGE CARDS
// Each renderer takes a message + viewer context and returns the
// type-specific UI. They live inline here because they share so much
// state with MessageBubble; splitting would require duplicating the
// time-format / mention parsing / etc.
// ─────────────────────────────────────────────────────────────────

function AnnouncementCard({
    message, chat, isMine, isEs, staffName, viewer, isAdmin, isManager,
    targetLang, autoTranslate,
    iAcked, onAck, onOpenAckDashboard, onLongPress,
}) {
    const tx = (en, es) => isEs ? es : en;
    const deadlineMs = message?.ackDeadline ? Date.parse(message.ackDeadline) : null;
    const overdue = deadlineMs && Date.now() > deadlineMs;
    const isAuthorOrManager = isMine || isManager || isAdmin;
    return (
        <div
            className="rounded-xl overflow-hidden border-2 border-amber-300 bg-gradient-to-br from-amber-50 to-amber-100/40 shadow-card"
            onTouchStart={() => onLongPress?.()}
        >
            <div className="px-4 py-2.5 bg-amber-200/60 border-b border-amber-300 flex items-center gap-2 flex-wrap">
                <span className="text-base">📣</span>
                <span className="text-[11px] font-black uppercase tracking-widest text-amber-900 flex-1">
                    {tx('Announcement', 'Anuncio')}
                </span>
                {/* Reviewed-translation provenance pill. Surfaces when
                    the message was posted with a human-reviewed
                    translation (translationStatus === 'reviewed').
                    Tells bilingual staff they're reading a manager-
                    approved Spanish version, not an auto-translate
                    that might fumble allergen / safety vocabulary. */}
                {message.translationStatus === 'reviewed' && (
                    <span
                        className="text-[10px] font-black uppercase tracking-wider text-dd-green-700 bg-white/70 border border-dd-green/40 rounded-full px-1.5 py-0.5"
                        title={message.translationReviewedBy
                            ? tx(`Translation reviewed by ${message.translationReviewedBy}`,
                                 `Traducción revisada por ${message.translationReviewedBy}`)
                            : tx('Translation reviewed by a manager', 'Traducción revisada por un gerente')}
                    >
                        🌐 {tx('Reviewed', 'Revisada')}
                    </span>
                )}
                <span className="text-[11px] font-bold text-amber-800">
                    {formatChatName(message.senderName)}
                </span>
            </div>
            <div className="px-4 py-3">
                {message.mediaUrl && (
                    <img src={message.mediaUrl} alt="" className="w-full max-h-[280px] object-cover rounded-lg mb-3" />
                )}
                <div className="text-[15px] text-dd-text leading-snug">
                    <TranslatableText
                        message={message}
                        chatId={chat?.id}
                        targetLang={targetLang}
                        autoTranslate={autoTranslate}
                        staffName={staffName}
                        isMine={false}
                        isEs={isEs}
                        blockMode={false}
                    />
                </div>
                {message.ackRequired && (
                    <div className="mt-3">
                        {iAcked ? (
                            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-dd-green/15 text-dd-green-700 text-sm font-bold">
                                ✓ {tx('Acknowledged', 'Confirmado')}
                            </div>
                        ) : (
                            <button
                                onClick={onAck}
                                className={`w-full px-4 py-3 rounded-lg font-black text-sm shadow-sm active:scale-[0.99] transition ${overdue
                                    ? 'bg-red-600 text-white'
                                    : 'bg-dd-green text-white hover:bg-dd-green-700'}`}
                            >
                                {overdue
                                    ? '🚨 ' + tx('OVERDUE — Mark as read', 'VENCIDO — Marcar leído')
                                    : '✅ ' + tx('Mark as read', 'Marcar leído')}
                            </button>
                        )}
                        {deadlineMs && (
                            <p className={`mt-1.5 text-[11px] text-center font-bold ${overdue ? 'text-red-700' : 'text-dd-text-2'}`}>
                                ⏰ {tx('Deadline:', 'Plazo:')} {new Date(deadlineMs).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            </p>
                        )}
                    </div>
                )}
                {isAuthorOrManager && message.ackRequired && (
                    <button
                        onClick={onOpenAckDashboard}
                        className="mt-3 w-full text-xs font-bold text-amber-800 hover:underline px-2 py-1.5 rounded bg-white/60"
                    >
                        📊 {tx('View read-rate dashboard', 'Ver panel de seguimiento')}
                    </button>
                )}
            </div>
        </div>
    );
}

function CoverageCard({
    message, chat, isMine, isEs, staffName, viewer, isAdmin, isManager,
    targetLang, autoTranslate,
    onClaim, onApprove, onDeny, onWithdraw, onLongPress,
}) {
    const tx = (en, es) => isEs ? es : en;
    const status = message.coverageStatus || 'open';
    const shift = message.shiftSnapshot || {};
    const iAmRequester = message.requesterId === staffName;
    const iAmClaimer = message.claimedBy === staffName;
    const canManage = canApproveCoverage(viewer, isAdmin, isManager);
    const claimable = canClaimCoverage(message, viewer) && !iAmRequester;

    const statusBadge = {
        open:      { label: tx('OPEN', 'ABIERTO'),       cls: 'bg-amber-100 text-amber-900 border-amber-300' },
        claimed:   { label: tx('CLAIMED', 'RECLAMADO'),  cls: 'bg-blue-100 text-blue-900 border-blue-300' },
        approved:  { label: tx('COVERED ✓', 'CUBIERTO ✓'),cls: 'bg-dd-green/20 text-dd-green-700 border-dd-green/40' },
        withdrawn: { label: tx('WITHDRAWN', 'RETIRADO'), cls: 'bg-dd-bg text-dd-text-2 border-dd-line' },
        expired:   { label: tx('EXPIRED', 'EXPIRADO'),   cls: 'bg-dd-bg text-dd-text-2 border-dd-line' },
    }[status] || { label: status, cls: 'bg-dd-bg' };

    return (
        <div className="rounded-xl overflow-hidden border-2 border-blue-300 bg-white shadow-card"
             onTouchStart={() => onLongPress?.()}>
            <div className="px-4 py-2.5 bg-blue-100 border-b border-blue-300 flex items-center gap-2">
                <span className="text-base">🙋</span>
                <span className="text-[11px] font-black uppercase tracking-widest text-blue-900 flex-1">
                    {tx('Coverage Request', 'Petición de Cobertura')}
                </span>
                <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${statusBadge.cls}`}>
                    {statusBadge.label}
                </span>
            </div>
            <div className="px-4 py-3">
                <div className="text-sm font-bold text-dd-text">
                    {formatChatName(message.senderName)} — {shift.date && new Date(shift.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
                </div>
                <div className="text-xs text-dd-text-2 mt-0.5">
                    {shift.startTime}–{shift.endTime} · {(shift.side || '').toUpperCase()} · {shift.location === 'maryland' ? 'Maryland' : shift.location === 'webster' ? 'Webster' : shift.location}
                </div>
                {message.text && (
                    <div className="mt-2 text-sm text-dd-text-2 italic">
                        "<TranslatableText
                            message={message}
                            chatId={chat?.id}
                            targetLang={targetLang}
                            autoTranslate={autoTranslate}
                            staffName={staffName}
                            isMine={false}
                            isEs={isEs}
                            blockMode={false}
                        />"
                    </div>
                )}
                {message.claimedBy && (
                    <div className="mt-2 text-xs text-blue-700 font-bold">
                        ✋ {tx('Claimed by', 'Reclamado por')} <b>{formatChatName(message.claimedBy)}</b>
                    </div>
                )}
                {message.approvedBy && (
                    <div className="mt-1 text-xs text-dd-green-700 font-bold">
                        ✓ {tx('Approved by', 'Aprobado por')} <b>{formatChatName(message.approvedBy)}</b>
                    </div>
                )}

                {/* Actions */}
                <div className="mt-3 flex flex-wrap gap-2">
                    {status === 'open' && claimable && (
                        <button onClick={onClaim} className="flex-1 px-3 py-2 rounded-lg bg-dd-green text-white text-sm font-black shadow-sm hover:bg-dd-green-700 active:scale-[0.98]">
                            ✋ {tx("I'll take it", 'Yo lo tomo')}
                        </button>
                    )}
                    {status === 'open' && iAmRequester && (
                        <button onClick={onWithdraw} className="flex-1 px-3 py-2 rounded-lg bg-dd-bg text-dd-text-2 text-sm font-bold border border-dd-line hover:bg-dd-line/30">
                            {tx('Withdraw', 'Retirar')}
                        </button>
                    )}
                    {status === 'claimed' && canManage && (
                        <>
                            <button onClick={onApprove} className="flex-1 px-3 py-2 rounded-lg bg-dd-green text-white text-sm font-black shadow-sm hover:bg-dd-green-700">
                                ✓ {tx('Approve', 'Aprobar')}
                            </button>
                            <button onClick={onDeny} className="flex-1 px-3 py-2 rounded-lg bg-white text-red-700 text-sm font-bold border-2 border-red-300 hover:bg-red-50">
                                ✕ {tx('Deny', 'Negar')}
                            </button>
                        </>
                    )}
                    {status === 'claimed' && iAmClaimer && (
                        <div className="flex-1 px-3 py-2 rounded-lg bg-blue-50 text-blue-900 text-sm font-bold text-center border border-blue-200">
                            {tx('Waiting on manager approval', 'Esperando aprobación')}
                        </div>
                    )}
                    {status === 'open' && !claimable && !iAmRequester && (
                        <div className="flex-1 px-3 py-2 rounded-lg bg-dd-bg text-dd-text-2 text-xs italic text-center">
                            {tx('Not eligible to claim this shift', 'No elegible para este turno')}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function EightySixCard({ message, isEs, staffName, isAdmin, isManager, onResolve, onLongPress }) {
    const tx = (en, es) => isEs ? es : en;
    const data = message.eightySixData || {};
    const isOut = data.transition === 'out';
    // A previously-86'd item has been brought back in stock —
    // visually demote the card so the active 86s stand apart from
    // the historical "resolved" ones in the thread.
    const isResolved = data.resolved === true || data.transition === 'in';

    // Manager / admin / the original poster can flip an 86 back to
    // "in stock". Resolve button shows only on an UNRESOLVED OUT
    // alert — once resolved or once it's a transition='in' bubble,
    // we never need to flip it again.
    const canResolve = isOut && !isResolved
        && (isAdmin || isManager || message.senderName === staffName);

    // Long-press → action menu (react/reply/pin/copy/delete).
    const longPressTimer = useRef(null);
    function startLongPress() {
        longPressTimer.current = setTimeout(() => onLongPress?.(), 400);
    }
    function endLongPress() {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
    }

    const resolvedAtMs = data.resolvedAt?.toMillis ? data.resolvedAt.toMillis()
        : (data.resolvedAt?.seconds ? data.resolvedAt.seconds * 1000 : 0);
    const resolvedWhen = resolvedAtMs ? new Date(resolvedAtMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

    return (
        <div
            onTouchStart={startLongPress}
            onTouchEnd={endLongPress}
            onTouchCancel={endLongPress}
            onContextMenu={(e) => { e.preventDefault(); onLongPress?.(); }}
            className={`rounded-xl overflow-hidden border-2 shadow-card transition ${isResolved
                ? 'border-dd-line bg-dd-bg/70 opacity-80'
                : (isOut
                    ? 'border-red-300 bg-red-50'
                    : 'border-dd-green/40 bg-dd-sage-50')}`}
        >
            <div className={`px-4 py-2 flex items-center gap-2 border-b ${isResolved
                ? 'bg-dd-line/40 border-dd-line'
                : (isOut
                    ? 'bg-red-200 border-red-300'
                    : 'bg-dd-green/15 border-dd-green/40')}`}>
                <span className="text-base">{isResolved ? '✅' : (isOut ? '🚫' : '✅')}</span>
                <span className={`text-[11px] font-black uppercase tracking-widest flex-1 ${isResolved
                    ? 'text-dd-text-2 line-through'
                    : (isOut ? 'text-red-900' : 'text-dd-green-700')}`}>
                    {isOut ? tx('86 Alert', 'Alerta 86') : tx('Back in Stock', 'En existencia')}
                </span>
                {isResolved && (
                    <span className="text-[10px] font-bold text-dd-green-700 px-1.5 py-0.5 rounded-full bg-dd-sage-50">
                        ✓ {tx('resolved', 'resuelto')}
                    </span>
                )}
            </div>
            <div className="px-4 py-3">
                <div className={`text-base font-black ${isResolved ? 'text-dd-text-2 line-through' : 'text-dd-text'}`}>
                    {data.itemName}
                </div>
                <div className="text-xs text-dd-text-2 mt-0.5">
                    {data.location === 'maryland' ? 'Maryland Heights' : 'Webster'}
                    {data.attributedTo && (
                        <span> · {tx('last by', 'último por')} {data.attributedTo}</span>
                    )}
                </div>
                {data.note && !isResolved && (
                    <div className="text-xs text-dd-text-2 mt-1 italic">"{data.note}"</div>
                )}
                {isOut && !isResolved && (
                    <p className="mt-2 text-xs text-red-700 font-bold">
                        {tx('Stop ringing it up — let guests know.', 'Dejen de cobrarlo — avisen a los huéspedes.')}
                    </p>
                )}
                {isResolved && (
                    <p className="mt-2 text-[11px] text-dd-text-2">
                        {tx('Marked back in stock', 'Marcado de vuelta')}
                        {data.resolvedBy && ` ${tx('by', 'por')} ${data.resolvedBy}`}
                        {resolvedWhen && ` · ${resolvedWhen}`}
                    </p>
                )}
                {canResolve && (
                    <button
                        onClick={onResolve}
                        className="mt-3 w-full px-3 py-2 rounded-lg bg-dd-green text-white font-bold text-sm hover:bg-dd-green-700 active:scale-[0.98] transition"
                    >
                        ✅ {tx('Mark back in stock', 'Marcar de vuelta')}
                    </button>
                )}
            </div>
        </div>
    );
}

function PhotoIssueCard({ message, chat, isEs, isManager, staffName, viewer, targetLang, autoTranslate, onLongPress }) {
    const tx = (en, es) => isEs ? es : en;
    const data = message.issueData || {};
    const cat = ISSUE_CATEGORIES.find(c => c.key === data.category);
    const urg = ISSUE_URGENCIES.find(u => u.key === data.urgency);
    return (
        <div className="rounded-xl overflow-hidden border-2 border-orange-300 bg-white shadow-card"
             onTouchStart={() => onLongPress?.()}>
            <div className="px-4 py-2 bg-orange-100 border-b border-orange-300 flex items-center gap-2">
                <span className="text-base">{cat?.emoji || '📸'}</span>
                <span className="text-[11px] font-black uppercase tracking-widest text-orange-900 flex-1">
                    {tx('Issue', 'Problema')} · {cat ? (isEs ? cat.es : cat.en) : data.category}
                </span>
                {urg && (
                    <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${urg.color}`}>
                        {isEs ? urg.es : urg.en}
                    </span>
                )}
            </div>
            {message.mediaUrl && (
                <img src={message.mediaUrl} alt="" className="w-full max-h-[300px] object-cover" />
            )}
            <div className="px-4 py-3">
                <div className="text-xs font-bold text-dd-text-2 mb-1">
                    {formatChatName(message.senderName)} · {data.location === 'maryland' ? 'Maryland' : 'Webster'}
                </div>
                {/* Render the full message text (category + urgency
                    + the user's note as one string). Translatable —
                    cached on the doc so subsequent viewers see the
                    translation instantly. */}
                {message.text && (
                    <div className="text-sm text-dd-text mt-1">
                        <TranslatableText
                            message={message}
                            chatId={chat?.id}
                            targetLang={targetLang}
                            autoTranslate={autoTranslate}
                            staffName={staffName}
                            isMine={false}
                            isEs={isEs}
                            blockMode={false}
                        />
                    </div>
                )}
                <div className="mt-2 flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-dd-bg text-dd-text-2 border border-dd-line">
                        {data.status === 'resolved' ? '✓ ' + tx('Resolved', 'Resuelto')
                            : data.status === 'in_progress' ? '⚙️ ' + tx('In progress', 'En curso')
                            : '🆕 ' + tx('Open', 'Abierto')}
                    </span>
                    {data.ticketId && (
                        <span className="text-[10px] text-dd-text-2">
                            🎫 {tx('Ticket', 'Ticket')} #{data.ticketId.slice(-6)}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

function TaskHandoffCard({ message, chat, isEs, staffName, targetLang, autoTranslate }) {
    const tx = (en, es) => isEs ? es : en;
    return (
        <div className="rounded-xl overflow-hidden border-2 border-purple-300 bg-purple-50/40 shadow-card">
            <div className="px-4 py-2 bg-purple-200/50 border-b border-purple-300 flex items-center gap-2">
                <span className="text-base">📋</span>
                <span className="text-[11px] font-black uppercase tracking-widest text-purple-900 flex-1">
                    {tx('Task', 'Tarea')}
                </span>
            </div>
            <div className="px-4 py-3">
                <div className="text-sm text-dd-text">
                    <TranslatableText
                        message={message}
                        chatId={chat?.id}
                        targetLang={targetLang}
                        autoTranslate={autoTranslate}
                        staffName={staffName}
                        isMine={false}
                        isEs={isEs}
                        blockMode={false}
                    />
                </div>
            </div>
        </div>
    );
}

// Long-press / right-click menu. Shows quick-reactions on top + a list
// of message actions: pin, copy, make task, delete.
function MessageActionMenu({
    message, chat, isMine, viewer, isAdmin, isManager, isEs,
    onClose, onReact, onReply, onTogglePin, onMakeTask, onDelete, onCopy, onStartEdit,
}) {
    const tx = (en, es) => isEs ? es : en;
    const pinnable = canPinMessages(chat, viewer, isAdmin, isManager);
    const taskable = canConvertToTask(viewer, isAdmin, isManager);
    const canOwn = canDeleteOwnMessage(message, viewer);
    const canAny = canDeleteAnyMessage(chat, viewer, isAdmin, isManager);
    const deletable = canOwn || canAny;
    const editable = canEditMessage(message, viewer);
    // Reply is available on any non-deleted message — even your own.
    // Quoting your own message threading-style is legitimate ("see my
    // earlier point about X").
    const replyable = !message.deleted && message.type !== 'system' && message.type !== 'system_event';
    return (
        <>
            <div className="fixed inset-0 z-40" onClick={onClose} />
            <div className={`absolute z-50 -top-2 ${isMine ? 'right-0' : 'left-0'} translate-y-[-100%] bg-white rounded-xl shadow-2xl border border-dd-line min-w-[240px] overflow-hidden`}>
                {/* Reaction row */}
                <div className="flex justify-around px-2 py-2 border-b border-dd-line/60 bg-dd-bg/30">
                    {QUICK_REACTIONS.map(e => (
                        <button
                            key={e}
                            onClick={() => { onReact?.(e); onClose(); }}
                            className="w-9 h-9 rounded-full hover:bg-white text-lg flex items-center justify-center transition active:scale-110"
                        >
                            {e}
                        </button>
                    ))}
                </div>
                {/* Actions */}
                <div className="flex flex-col">
                    {replyable && (
                        <button onClick={() => { onReply?.(); onClose(); }} className="flex items-center gap-2 px-4 py-2.5 hover:bg-dd-bg text-left text-sm">
                            ↩️ {tx('Reply', 'Responder')}
                        </button>
                    )}
                    {editable && onStartEdit && (
                        <button onClick={() => { onStartEdit?.(); onClose(); }} className="flex items-center gap-2 px-4 py-2.5 hover:bg-dd-bg text-left text-sm">
                            ✏️ {tx('Edit', 'Editar')}
                        </button>
                    )}
                    {pinnable && (
                        <button onClick={() => { onTogglePin?.(); onClose(); }} className="flex items-center gap-2 px-4 py-2.5 hover:bg-dd-bg text-left text-sm">
                            📌 {message.pinned ? tx('Unpin message', 'Quitar fijado') : tx('Pin message', 'Fijar mensaje')}
                        </button>
                    )}
                    {taskable && (
                        <button onClick={() => { onMakeTask?.(); onClose(); }} className="flex items-center gap-2 px-4 py-2.5 hover:bg-dd-bg text-left text-sm">
                            📋 {tx('Make this a task', 'Convertir en tarea')}
                        </button>
                    )}
                    {(message.text || '').length > 0 && (
                        <button onClick={() => { onCopy?.(); onClose(); }} className="flex items-center gap-2 px-4 py-2.5 hover:bg-dd-bg text-left text-sm">
                            📋 {tx('Copy text', 'Copiar texto')}
                        </button>
                    )}
                    {deletable && (
                        <button onClick={() => { onDelete?.(); onClose(); }} className="flex items-center gap-2 px-4 py-2.5 hover:bg-red-50 text-left text-sm text-red-700 font-bold">
                            🗑 {tx('Delete', 'Eliminar')}
                        </button>
                    )}
                </div>
            </div>
        </>
    );
}

// ── PollCard ─────────────────────────────────────────────────────
// Full-width card renderer for messages of type 'poll'. Lives in its
// own bubble shell (not the white/green default) so the poll looks
// distinct in the thread — easier to scan past, and visually obvious
// that it's interactive.
//
// Two display states:
//   • OPEN — vote buttons; tapping toggles your vote (or single-
//            selects for non-multiSelect polls).
//   • CLOSED — buttons disabled, %s + bars only.
//
// Anonymous polls hide voter names everywhere (counts only). Non-
// anonymous polls show a thin "voted by" line under each option with
// up to 3 names + "+ N more".
//
// onLongPress lets the user open the standard action menu (react,
// reply, pin, delete) — same pattern as AnnouncementCard.
function PollCard({ message, isMine, isEs, staffName, viewer, isAdmin, onVote, onClose, onLongPress }) {
    const tx = (en, es) => isEs ? es : en;
    const poll = message.poll || {};
    const { counts, total } = pollTally(poll);
    const open = isPollOpen(poll);
    const myVotes = useMemo(() => {
        const set = new Set();
        for (const [optId, names] of Object.entries(poll.votes || {})) {
            if (Array.isArray(names) && names.includes(staffName)) set.add(optId);
        }
        return set;
    }, [poll.votes, staffName]);
    const canClose = open && (isAdmin || message.senderName === staffName);

    // Long-press → action menu.
    const longPressTimer = useRef(null);
    function startLongPress() {
        longPressTimer.current = setTimeout(() => onLongPress?.(), 400);
    }
    function endLongPress() {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
    }

    const closesAtMs = poll.closesAt?.toMillis ? poll.closesAt.toMillis()
        : (poll.closesAt?.seconds ? poll.closesAt.seconds * 1000 : 0);
    const closedAtMs = poll.closedAt?.toMillis ? poll.closedAt.toMillis()
        : (poll.closedAt?.seconds ? poll.closedAt.seconds * 1000 : 0);
    const subtitle = open
        ? (closesAtMs
            ? `${tx('Closes', 'Cierra')} ${relativeTime(closesAtMs, isEs)}`
            : tx('Open · multi-select ' + (poll.multiSelect ? 'on' : 'off'),
                 'Abierto · múltiples ' + (poll.multiSelect ? 'sí' : 'no')))
        : tx('Closed', 'Cerrado') + (closedAtMs ? ` · ${relativeTime(closedAtMs, isEs)}` : '');

    return (
        <div
            onTouchStart={startLongPress}
            onTouchEnd={endLongPress}
            onTouchCancel={endLongPress}
            onContextMenu={(e) => { e.preventDefault(); onLongPress?.(); }}
            className="bg-white border border-dd-line rounded-2xl shadow-sm overflow-hidden"
        >
            {/* Header */}
            <div className="px-3 py-2 border-b border-dd-line/60 bg-dd-sage-50/40 flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-black uppercase tracking-widest text-dd-green-700">
                        📊 {tx('Poll', 'Encuesta')} · {message.senderName}
                    </div>
                    <div className="text-[15px] font-black text-dd-text mt-0.5 leading-snug break-words">
                        {poll.question || tx('Untitled poll', 'Encuesta sin título')}
                    </div>
                    <div className="text-[11px] text-dd-text-2 mt-0.5">
                        {subtitle} · {total} {tx(total === 1 ? 'vote' : 'votes', total === 1 ? 'voto' : 'votos')}
                    </div>
                </div>
                {canClose && (
                    <button
                        onClick={onClose}
                        className="text-[11px] font-bold px-2 py-1 rounded-full bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg shrink-0"
                        aria-label={tx('Close poll', 'Cerrar encuesta')}
                    >
                        {tx('Close', 'Cerrar')}
                    </button>
                )}
            </div>
            {/* Options */}
            <div className="p-2 space-y-1.5">
                {(poll.options || []).map(opt => {
                    const c = counts[opt.id] || 0;
                    const pct = total > 0 ? Math.round((c / total) * 100) : 0;
                    const youVoted = myVotes.has(opt.id);
                    const voters = Array.isArray(poll.votes?.[opt.id]) ? poll.votes[opt.id] : [];
                    return (
                        <button
                            key={opt.id}
                            disabled={!open}
                            onClick={() => onVote?.(opt.id)}
                            className={`relative w-full text-left rounded-lg border-2 transition active:scale-[0.99] ${youVoted
                                ? 'border-dd-green bg-dd-sage-50'
                                : 'border-dd-line bg-white hover:bg-dd-bg'} ${!open ? 'opacity-90 cursor-default' : ''}`}
                        >
                            {/* Progress fill */}
                            <div
                                className={`absolute inset-y-0 left-0 ${youVoted ? 'bg-dd-green/15' : 'bg-dd-bg'} transition-all`}
                                style={{ width: `${pct}%` }}
                            />
                            {/* Content */}
                            <div className="relative px-3 py-2 flex items-center gap-2">
                                <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-[11px] font-black shrink-0 ${youVoted
                                    ? 'border-dd-green bg-dd-green text-white'
                                    : 'border-dd-line text-dd-text-2'}`}>
                                    {youVoted ? '✓' : ''}
                                </span>
                                <span className="flex-1 min-w-0 text-sm font-bold text-dd-text break-words">{opt.label}</span>
                                <span className="text-[11px] tabular-nums font-bold text-dd-text-2 shrink-0">
                                    {pct}% · {c}
                                </span>
                            </div>
                            {/* Voter list (if not anonymous) */}
                            {!poll.anonymous && voters.length > 0 && (
                                <div className="relative px-3 pb-1.5 -mt-0.5 text-[10.5px] text-dd-text-2 truncate">
                                    {voters.slice(0, 3).map(formatChatName).join(', ')}
                                    {voters.length > 3 && ` +${voters.length - 3}`}
                                </div>
                            )}
                        </button>
                    );
                })}
            </div>
            {!open && (
                <div className="px-3 py-1.5 border-t border-dd-line/60 bg-dd-bg/40 text-[11px] font-bold text-dd-text-2 text-center">
                    🔒 {tx('Voting closed', 'Votación cerrada')}
                </div>
            )}
        </div>
    );
}

// One-line preview for the scheduled-messages banner. Uses the FIRST
// scheduled message's text + its sendAt time. Keeps the banner concise.
function previewScheduledList(items, isEs) {
    if (!Array.isArray(items) || items.length === 0) return '';
    const first = items[0];
    const text = (first?.payload?.text || '').replace(/\s+/g, ' ').trim();
    const ts = first?.sendAt;
    const ms = ts?.toMillis ? ts.toMillis() : (ts?.seconds ? ts.seconds * 1000 : 0);
    if (!ms) return text.slice(0, 50);
    const d = new Date(ms);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const tom = new Date(today.getTime() + 86400_000);
    const isTomorrow = d.toDateString() === tom.toDateString();
    const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const dayStr = sameDay ? (isEs ? 'hoy' : 'today')
        : isTomorrow ? (isEs ? 'mañana' : 'tomorrow')
        : d.toLocaleDateString(isEs ? 'es' : 'en', { month: 'short', day: 'numeric' });
    return `${dayStr} ${timeStr} · ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`;
}

// Bottom-sheet listing pending scheduled messages with a cancel button
// per row. Tapping cancel deletes the scheduled_messages doc; the
// realtime subscription on the parent updates the banner instantly.
function ScheduledListDrawer({ items, isEs, onCancel, onClose }) {
    const tx = (en, es) => isEs ? es : en;
    return (
        <>
            <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
            <div className="fixed inset-x-0 bottom-0 sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[460px] sm:max-w-[92vw] z-50 bg-white shadow-2xl rounded-t-2xl sm:rounded-2xl max-h-[85vh] flex flex-col"
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                <header className="px-4 py-3 border-b border-dd-line flex items-center justify-between">
                    <div>
                        <h2 className="text-base font-bold text-dd-text">📅 {tx('Scheduled messages', 'Mensajes programados')}</h2>
                        <p className="text-[11px] text-dd-text-2">
                            {items.length} {tx(items.length === 1 ? 'pending' : 'pending', items.length === 1 ? 'pendiente' : 'pendientes')}
                        </p>
                    </div>
                    <button onClick={onClose}
                        className="w-9 h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg text-lg">×</button>
                </header>
                <div className="flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                    {items.length === 0 ? (
                        <div className="p-8 text-center text-sm text-dd-text-2">
                            {tx('No scheduled messages.', 'Sin mensajes programados.')}
                        </div>
                    ) : (
                        <ul className="divide-y divide-dd-line">
                            {items.map(it => {
                                const ms = it.sendAt?.toMillis ? it.sendAt.toMillis()
                                    : (it.sendAt?.seconds ? it.sendAt.seconds * 1000 : 0);
                                const when = ms ? new Date(ms).toLocaleString(isEs ? 'es' : 'en', {
                                    weekday: 'short', month: 'short', day: 'numeric',
                                    hour: 'numeric', minute: '2-digit',
                                }) : '';
                                const text = it.payload?.text || '';
                                return (
                                    <li key={it.id} className="px-4 py-3">
                                        <div className="text-[11px] font-bold text-dd-green-700 mb-1">
                                            📅 {when}
                                        </div>
                                        <div className="text-sm text-dd-text whitespace-pre-wrap break-words mb-2">
                                            {text}
                                        </div>
                                        <button
                                            onClick={() => onCancel?.(it.id)}
                                            className="text-[11px] font-bold text-red-700 hover:bg-red-50 px-2 py-1 rounded-full transition"
                                        >
                                            🗑 {tx('Cancel', 'Cancelar')}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </>
    );
}

// Relative-time formatter for poll deadlines (short, viewer-language).
// "in 2h", "in 3d", "1h ago" — kept inside ChatThread because nothing
// else needs it; could lift if a second consumer appears.
function relativeTime(ms, isEs) {
    if (!ms) return '';
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const past = diff < 0;
    let label;
    if (abs < 60_000) label = isEs ? 'ahora' : 'now';
    else if (abs < 3600_000) label = `${Math.round(abs / 60_000)}m`;
    else if (abs < 86400_000) label = `${Math.round(abs / 3600_000)}h`;
    else label = `${Math.round(abs / 86400_000)}d`;
    if (label === (isEs ? 'ahora' : 'now')) return label;
    return past ? (isEs ? `hace ${label}` : `${label} ago`) : (isEs ? `en ${label}` : `in ${label}`);
}

// Seen-by bottom sheet — shows who's read this message + when.
// Sender excluded server-side (in getSeenByForMessage). On a DM with
// only the other person listed, this renders "Seen at HH:MM" — on a
// group, a scrollable list of readers, most-recent last.
//
// Manager affordance: a "Nudge" button on each unread row + a
// "Nudge all" header button. Nudging fires a chat_nudge notification
// at the target staff member (forceDeliver=true, bypasses off-shift
// gate — the manager has made an explicit call). Per-row state
// tracks who was just nudged so the button flips to "✓ Nudged" for
// 30 seconds and disables, preventing accidental spam-tapping.
function SeenBySheet({
    seenBy, chat, message, viewer, isAdmin, isManager, isEs,
    onNudge, onNudgeAll, onClose,
}) {
    const tx = (en, es) => (isEs ? es : en);

    // Who can nudge? Manager / app admin / chat co-admin. Staff
    // shouldn't be able to send arbitrary pushes at coworkers.
    // (handleNudge in ChatThread also enforces this server-write
    // side — belt-and-suspenders, since the audit log captures every
    // nudge by actor.)
    const nudgeAllowed = isAdmin || isManager
        || (Array.isArray(chat?.admins) && viewer?.name && chat.admins.includes(viewer.name));

    // Per-row recently-nudged state. After tapping, the row's button
    // flips to "✓ Nudged" + disables for 30s to prevent spam taps.
    // Tracking is a Set in state — single re-render per add/remove.
    const [recentlyNudged, setRecentlyNudged] = useState(() => new Set());
    function markNudged(name) {
        setRecentlyNudged(prev => {
            const next = new Set(prev);
            next.add(name);
            return next;
        });
        setTimeout(() => {
            setRecentlyNudged(prev => {
                if (!prev.has(name)) return prev;
                const next = new Set(prev);
                next.delete(name);
                return next;
            });
        }, 30_000);
    }

    function nudgeOne(name) {
        if (!nudgeAllowed) return;
        if (recentlyNudged.has(name)) return;
        onNudge?.(name);
        markNudged(name);
    }

    const fmtTime = (ms) => {
        if (!ms) return '';
        const d = new Date(ms);
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        const yest = new Date(today.getTime() - 86400_000);
        if (d.toDateString() === yest.toDateString()) {
            return tx('Yesterday', 'Ayer') + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        }
        return d.toLocaleDateString(isEs ? 'es' : 'en', { month: 'short', day: 'numeric' }) + ' ' +
               d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    };
    const members = Array.isArray(chat.members) ? chat.members : [];
    const senderName = message.senderName;
    // Compute "not yet seen" — members who exist but haven't read past
    // this message's timestamp. Excluded: sender (implicit read) and
    // anyone already in `seenBy`.
    const seenNames = new Set(seenBy.map(r => r.name));
    const notSeen = members.filter(n => n !== senderName && !seenNames.has(n));

    // "Nudge all" target list — everyone in not-yet-seen that we
    // haven't already nudged in the last 30s. The button is hidden
    // when this list is empty (nothing left to nudge).
    const nudgeAllTargets = notSeen.filter(n => !recentlyNudged.has(n));

    return (
        <>
            <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
            <div className="fixed inset-x-0 bottom-0 sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[460px] sm:max-w-[92vw] z-50 bg-white shadow-2xl rounded-t-2xl sm:rounded-2xl max-h-[80vh] flex flex-col"
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                <header className="px-4 py-3 border-b border-dd-line flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                        <h2 className="text-base font-bold text-dd-text">
                            {tx('Seen by', 'Visto por')}
                        </h2>
                        <p className="text-[11px] text-dd-text-2">
                            {seenBy.length} {tx('read', 'leído(s)')}
                            {notSeen.length > 0 && ` · ${notSeen.length} ${tx('not yet', 'pendiente(s)')}`}
                        </p>
                    </div>
                    {/* Nudge-all button — visible to managers only when
                        there's at least one un-nudged unread person.
                        Sends a fresh chat_nudge push at every name in
                        the unread list with a 30s recently-nudged
                        cooldown per name to prevent spam. */}
                    {nudgeAllowed && nudgeAllTargets.length > 0 && (
                        <button
                            onClick={() => {
                                onNudgeAll?.(nudgeAllTargets);
                                nudgeAllTargets.forEach(markNudged);
                            }}
                            className="px-2.5 py-1.5 rounded-full bg-dd-green text-white text-[11px] font-black shadow-sm hover:bg-dd-green-700 active:scale-95 transition shrink-0"
                            title={tx('Send a reminder push to everyone who hasn\'t read this',
                                       'Enviar recordatorio a quienes no han leído')}
                        >
                            ⏰ {tx(`Nudge ${nudgeAllTargets.length}`, `Recordar ${nudgeAllTargets.length}`)}
                        </button>
                    )}
                    <button onClick={onClose}
                        className="w-9 h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg active:scale-95 text-lg transition shrink-0"
                        aria-label={tx('Close', 'Cerrar')}>
                        ×
                    </button>
                </header>
                <div className="flex-1 overflow-y-auto"
                    style={{ overscrollBehavior: 'contain', touchAction: 'pan-y' }}>
                    {seenBy.length === 0 && notSeen.length === 0 ? (
                        <div className="py-8 px-4 text-center text-sm text-dd-text-2">
                            {tx('Nobody to track yet.', 'Aún no hay nadie.')}
                        </div>
                    ) : (
                        <ul className="divide-y divide-dd-line">
                            {seenBy.map((r) => (
                                <li key={r.name} className="px-4 py-2.5 flex items-center gap-3">
                                    <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-dd-green text-white text-[11px] font-black shrink-0">
                                        {(r.name || '?').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-dd-text truncate">{r.name}</div>
                                        <div className="text-[11px] text-dd-text-2">{fmtTime(r.readAtMs)}</div>
                                    </div>
                                    <span className="text-dd-green text-base">✓</span>
                                </li>
                            ))}
                            {notSeen.length > 0 && (
                                <li className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-dd-text-2 bg-dd-bg">
                                    {tx('Not yet seen', 'Aún no visto')}
                                </li>
                            )}
                            {notSeen.map((name) => {
                                const wasNudged = recentlyNudged.has(name);
                                return (
                                    <li key={`ns-${name}`} className="px-4 py-2.5 flex items-center gap-3">
                                        <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-dd-bg text-dd-text-2 text-[11px] font-black shrink-0 border border-dd-line">
                                            {(name || '?').split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-dd-text truncate">{name}</div>
                                            <div className="text-[11px] text-dd-text-2">
                                                {wasNudged
                                                    ? tx('Nudged just now', 'Recordado ahora')
                                                    : tx('Not yet', 'Pendiente')}
                                            </div>
                                        </div>
                                        {nudgeAllowed && (
                                            <button
                                                onClick={() => nudgeOne(name)}
                                                disabled={wasNudged}
                                                className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-bold transition ${wasNudged
                                                    ? 'bg-dd-sage-50 text-dd-green-700 cursor-default'
                                                    : 'bg-dd-bg text-dd-text-2 border border-dd-line hover:bg-dd-green hover:text-white hover:border-dd-green active:scale-95'}`}
                                                title={tx('Send a reminder push to this person',
                                                          'Enviar un recordatorio a esta persona')}
                                            >
                                                {wasNudged ? '✓ ' + tx('Nudged', 'Recordado') : '⏰ ' + tx('Nudge', 'Recordar')}
                                            </button>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </>
    );
}

function groupByDate(messages, isEs) {
    const groups = [];
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const todayKey = fmt(new Date());
    const yKey = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return fmt(d); })();
    for (const m of messages) {
        const ts = m.createdAt;
        const ms = ts?.toMillis ? ts.toMillis()
            : (ts?.seconds ? ts.seconds * 1000 : 0);
        const d = ms ? new Date(ms) : new Date();
        const key = fmt(d);
        const label = key === todayKey
            ? (isEs ? 'Hoy' : 'Today')
            : key === yKey
            ? (isEs ? 'Ayer' : 'Yesterday')
            : d.toLocaleDateString(isEs ? 'es' : 'en', { weekday: 'long', month: 'short', day: 'numeric' });
        let last = groups[groups.length - 1];
        if (!last || last.key !== key) {
            last = { key, label, messages: [] };
            groups.push(last);
        }
        last.messages.push(m);
    }
    return groups;
}
