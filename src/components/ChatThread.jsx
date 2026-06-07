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

import { Component, memo, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
// 2026-05-27 — Andrew: "the mic emoji lets make it more modern." Swapped
// the 🎤 in both the composer voice-message button and the staged-audio
// preview pill icon for Lucide's `Mic` glyph. Same lucide-react chunk
// that vendor-react already pulls in (see vite.config.js manualChunks
// — lucide-react is co-located with React after the 2026-05-27 outage
// fix), so this is a zero-byte-add at the bundle level.
// 2026-05-27 — Andrew: "in chat the + button we need to make the
// photo, video, poll etc all look more professional and apple. fix
// the emopjis. make that window glass." Adding Lucide glyphs for
// the attach menu items + a Sparkles for the AI fix-grammar pill.
import {
    Mic, Camera, Video, BarChart3, Ban, Smile, Sparkles, Calendar,
} from 'lucide-react';
import { db, storage } from '../firebase';
import {
    collection, doc, query, orderBy, limit, onSnapshot,
    addDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, where, getCountFromServer,
    arrayUnion, arrayRemove, getDoc, runTransaction,
    Timestamp,
} from 'firebase/firestore';
import { ref as sref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { ChatAvatar, chatDisplayName } from './ChatShared';
// Pure formatters lifted out 2026-05-23 — see chatThreadHelpers.js
// for the rationale on the incremental ChatThread split.
import { previewScheduledList, relativeTime, groupByDate } from './chatThreadHelpers';
import { parseMentions, QUICK_REACTIONS, canEditChat, ISSUE_URGENCIES, ISSUE_CATEGORIES, formatChatName, canSeeReceiptsForMessage, getSeenByForMessage, pollTally, isPollOpen, canEditMessage } from '../data/chat';
// 2026-05-24 — Andrew: "make all messages in the chat push regardless
// if they are working or not." Removed the off-shift gate UI entirely.
// Server-side chat_message/chat_mention are already in
// ALWAYS_DELIVER_TYPES so they bypass the off-shift gate; we now also
// always send forceDeliver: true as a belt-and-suspenders so a future
// edit to ALWAYS_DELIVER_TYPES can't accidentally re-introduce silent
// chat suppression. `offShiftMembers` import deleted (no remaining
// callers in this file).
// PERF, 2026-05-30: removed `INVENTORY_CATEGORIES` import — it lived
// here only to forward into the lazy ChatEightySixModal, which means the
// 68KB inventory blob shipped with every chat first-paint. ChatEightySixModal
// now imports it directly inside its own lazy chunk; the prop fallback in
// that file does the work.
import { postEightySixToChat } from '../data/eightySixChat';
import { canPostAnnouncements, canPinMessages, canConvertToTask, canDeleteAnyMessage, canDeleteOwnMessage, canClaimCoverage, canApproveCoverage } from '../data/chatPermissions';
import { notifyStaff } from '../data/notify';
// 2026-05-27 — breadcrumb every send so the Sentry timeline shows
// "user sent a message of type=X to chat=Y" before any error that
// fires afterward. Single chokepoint at the bottom-of-file
// sendMessage(); covers text, image, video, voice, poll, 86 paths.
import { breadcrumb } from '../data/logger';
import { recordAudit } from '../data/audit';
import { claimCoverage, approveCoverage, denyCoverage, withdrawCoverage } from '../data/coverage';
import { toast } from '../toast';
import { fixText as aiFixText } from '../data/aiFixText';
import TranslatableText, { renderWithMentions } from './TranslatableText';
import ModalPortal from './ModalPortal';

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
            // Bilingual fallback — language comes from the parent wrapper so
            // Spanish-language staff don't see the English-only crash screen.
            // Default to English if the prop is missing (defensive).
            const isEs = this.props.language === 'es';
            return (
                <div className="flex flex-col items-center justify-center h-full bg-dd-bg text-center px-6 py-12 gap-3">
                    <div className="text-5xl">💬</div>
                    <h3 className="text-base font-black text-dd-text">
                        {isEs
                            ? 'Algo salió mal al cargar este chat'
                            : 'Something went wrong loading this chat'}
                    </h3>
                    <p className="text-sm text-dd-text-2 max-w-md">
                        {isEs
                            ? 'Tus otros chats están bien. Toca volver a la lista de chats e intenta abrir este otra vez — si sigue fallando, un gerente puede revisar el registro.'
                            : 'The rest of your chats are fine. Tap back to the chat list and try opening this one again — if it keeps crashing, a manager can check the audit log.'}
                    </p>
                    <button
                        onClick={() => {
                            this.setState({ hasError: false, error: null });
                            this.props.onReset?.();
                        }}
                        className="mt-2 px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 active:scale-95 transition shadow-sm">
                        {isEs ? '← Volver a los chats' : '← Back to chats'}
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
    // 2026-05-27 — load/error UX state. Andrew: "about half the time
    // the separate chats do not load the first time." Root cause:
    // ChatThread had ZERO loading state — between mount and first
    // snapshot arrival (200–2000ms on slow restaurant Wi-Fi), users
    // saw a blank chat with no signal that anything was loading.
    // Worse: switching from chat A to chat B kept rendering chat A's
    // messages until chat B's first snapshot landed, because we never
    // reset the `messages` array on chat change.
    //
    //   loading   → true while we're waiting on the FIRST snapshot
    //                for this chat. Flips false once we hear back
    //                (success or empty). Used to render the spinner
    //                + suppress the "no messages yet" empty state
    //                during the initial fetch.
    //   loadError → set when onSnapshot's error callback fires. The
    //                old behavior was console.warn only → silent
    //                failure → user assumes "it didn't load" and
    //                refreshes. Now the UI surfaces a Retry button
    //                that bumps subscriptionGen to force a re-sub.
    //   subscriptionGen → manual reset key. Bumped by Retry to force
    //                a fresh subscription without changing chat.id.
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [subscriptionGen, setSubscriptionGen] = useState(0);

    useEffect(() => {
        if (!chat?.id) return;
        // Reset pagination AND messages AND loading state on chat
        // switch. Resetting messages is the key fix for the "shows
        // previous chat's content briefly" symptom. Resetting loading
        // back to true tells the UI to show a spinner until the new
        // chat's first snapshot lands.
        setMessageLimit(50);
        setHasMore(true);
        setMessages([]);
        setLoading(true);
        setLoadError(null);
    }, [chat?.id]);

    useEffect(() => {
        if (!chat?.id) return;
        // The mount-to-first-snapshot fallback. If 8 seconds pass and
        // the snapshot still hasn't arrived (slow Wi-Fi, Firestore
        // sync hiccup), surface an error state with Retry instead of
        // leaving the spinner spinning forever.
        const timeoutId = setTimeout(() => {
            // Use a functional check so we don't capture stale state.
            // If loading is still true after 8s, something's wrong.
            setLoadError((prev) => prev || 'timeout');
            setLoading(false);
        }, 8000);

        const q = query(
            collection(db, 'chats', chat.id, 'messages'),
            orderBy('createdAt', 'desc'),
            limit(messageLimit)
        );
        // Unmount guard — perf audit 2026-05-28 #2: snapshot can
        // fire AFTER the user navigates to another chat, leaving us
        // calling setState on an unmounted/superseded effect. The
        // alive flag short-circuits all the state writes in that
        // window so React stops logging warnings and we stop
        // overwriting fresh state from the new effect.
        let alive = true;
        const unsub = onSnapshot(q, (snap) => {
            if (!alive) return;
            clearTimeout(timeoutId);
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            // Snapshot is newest-first because of the desc order; reverse
            // so render order stays oldest-first / newest-at-bottom.
            list.reverse();
            setMessages(list);
            setLoading(false);
            setLoadError(null);
            // If we got fewer than we asked for, there's no older to load.
            if (snap.size < messageLimit) setHasMore(false);
        }, (err) => {
            // Was just console.warn — silent failure mode. Now we
            // surface the error in the UI so the user knows to retry
            // (or knows something is wrong with their network/perms)
            // instead of seeing a blank chat forever. Permission-denied
            // is the most likely real cause (rules tightened a chat
            // someone was previously in); network errors auto-recover
            // when Firestore re-establishes its WebSocket so a Retry
            // tap will usually succeed.
            if (!alive) return;
            clearTimeout(timeoutId);
            console.warn('messages snapshot failed:', err);
            setLoadError(err?.code || err?.message || 'load-failed');
            setLoading(false);
        });
        return () => {
            alive = false;
            clearTimeout(timeoutId);
            unsub();
        };
    }, [chat?.id, messageLimit, subscriptionGen]);

    // Retry handler — bumps subscriptionGen to force the message
    // subscription effect to re-run with a fresh listener. Called by
    // the error-state "Retry" button below.
    const retryMessageLoad = useCallback(() => {
        setLoadError(null);
        setLoading(true);
        setSubscriptionGen(g => g + 1);
    }, []);

    // Load-older handler — bumps the limit by another 50. Re-runs the
    // subscription effect above against the new limit, which re-fetches
    // (Firestore can't extend a snapshot's limit incrementally).
    //
    // 2026-05-28 Audit #7 — flagged this as potentially overlapping
    // subscriptions on slow networks. Verified: useEffect cleanup is
    // synchronous, so the OLD onSnapshot's unsub() always fires before
    // the NEW one opens — no overlap. The remaining cost is bandwidth
    // (50 → 100 → 150 messages each re-sent through the WebSocket on
    // every Load Older tap, not incremental), which in practice is
    // bounded by the fact that staff almost never scroll back past the
    // initial 50. A snapshot-pagination refactor (startAfter cursor +
    // separate subscriptions for the older slice) would fix the
    // re-fetch but is medium-risk for negligible production impact.
    // MAX_MESSAGE_LIMIT below caps runaway growth from accidental
    // long-press / rapid-tap.
    const MAX_MESSAGE_LIMIT = 2000;
    function loadOlderMessages() {
        setMessageLimit(n => Math.min(n + 50, MAX_MESSAGE_LIMIT));
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
    //
    // Andrew 2026-05-31: switched useEffect → useLayoutEffect. The
    // previous version ran AFTER paint, so on chat-open the user saw
    // ~1 frame of messages anchored to the TOP, then a visible
    // "snap" down to the bottom on the next frame. Felt laggy /
    // jumpy. useLayoutEffect runs synchronously between commit and
    // paint, so the scroll position is correct in the first painted
    // frame — the user lands at the newest message instantly with no
    // flash. Trade-off is a tiny pre-paint block to set scrollTop;
    // for the chat thread length we render, this is sub-ms and not
    // noticeable.
    const scrollRef = useRef(null);
    const innerRef = useRef(null);
    const atBottomRef = useRef(true);
    const [atBottom, setAtBottom] = useState(true);
    useLayoutEffect(() => { atBottomRef.current = atBottom; }, [atBottom]);
    useLayoutEffect(() => {
        if (!atBottom) return;
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages.length, atBottom]);
    // ── ResizeObserver — handles the "bottom → jump up → bottom" jitter
    //
    // Andrew 2026-05-31: opening a chat showed a visible jump-up-then-
    // back-down. Root cause is the iMessage-style `justify-end
    // min-h-full` trick on the inner wrapper. When total content
    // height < viewport, justify-end pushes messages to the bottom of
    // the scroll container. When an image (or async-loaded element)
    // finishes loading and pushes total height > viewport, the flex
    // collapses out of justify-end mode and the content reflows to
    // top-anchored — the user sees their bottom-pinned view jump
    // UP by the image height. The previous img-load listener fired
    // post-paint, so the jump was visible before the snap-back.
    //
    // ResizeObserver fires synchronously after layout but BEFORE
    // paint. We re-snap to bottom there, so the user only ever sees
    // the final corrected position — no jitter. Catches everything:
    // image loads, font swaps, async-rendered reply previews, date
    // dividers, you name it.
    //
    // Also pairs well with overflow-anchor: none on the scroll
    // container (set on the parent JSX below) to stop the browser's
    // automatic scroll-anchoring heuristic from competing with us.
    useEffect(() => {
        const el = scrollRef.current;
        const inner = innerRef.current;
        if (!el || !inner) return;
        if (typeof ResizeObserver === 'undefined') return; // very old browsers
        let lastH = inner.getBoundingClientRect().height;
        const ro = new ResizeObserver(() => {
            const h = inner.getBoundingClientRect().height;
            if (h === lastH) return;
            lastH = h;
            // Only re-anchor if the user was already pinned to bottom.
            // If they've scrolled up to read older messages, leave them.
            if (!atBottomRef.current) return;
            el.scrollTop = el.scrollHeight;
        });
        ro.observe(inner);
        return () => ro.disconnect();
    }, []);
    function handleScroll() {
        const el = scrollRef.current;
        if (!el) return;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        setAtBottom(gap < 100);
    }
    // 2026-05-24 audit fix: iOS soft keyboard opens → viewport shrinks
    // by ~270px → the still-running scroll handler reads "gap > 100"
    // and flips atBottom to false → subsequent incoming messages no
    // longer auto-scroll to the new bottom. Caused users to think
    // their messages went off-screen. visualViewport.resize fires
    // when the keyboard slides in/out on iOS; on resize, re-evaluate
    // and if we WERE at bottom, snap the list back to bottom.
    useEffect(() => {
        const vv = typeof window !== 'undefined' ? window.visualViewport : null;
        if (!vv) return;
        const onViewport = () => {
            const el = scrollRef.current;
            if (!el) return;
            // If we were at bottom pre-resize, re-anchor after the
            // layout settles. requestAnimationFrame so the new
            // viewport dimensions are committed before we measure.
            if (atBottom) {
                requestAnimationFrame(() => {
                    if (el) el.scrollTop = el.scrollHeight;
                });
            }
        };
        vv.addEventListener('resize', onViewport);
        return () => vv.removeEventListener('resize', onViewport);
    }, [atBottom]);

    // ── Composer state ────────────────────────────────────────────
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [recording, setRecording] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(null); // { kind, pct }
    const [typingNames, setTypingNames] = useState([]);
    // ── Pending media attachment (Andrew 2026-05-27) ────────────────
    // When the user picks a photo/video or finishes a voice memo, we
    // now STAGE it as a preview in the composer instead of uploading
    // + sending immediately. The user can add an optional text
    // caption, keep typing, swap to a different attachment, or
    // cancel — and the actual upload + send only happens when they
    // tap the send arrow.
    // Single slot (matches the per-message schema: one mediaUrl per
    // msg). Shape:
    //   {
    //     kind:       'image' | 'video' | 'audio',
    //     uploadFile: Blob | File,   // the blob to actually upload
    //                                //   (resized for images; raw
    //                                //   for video/audio)
    //     previewUrl: string,        // local object URL — MUST be
    //                                //   revoked on clear/unmount
    //                                //   (see cleanup useEffect)
    //     mimeType:   string,
    //     width?:     number,
    //     height?:    number,
    //     duration?:  number,
    //     filename?:  string,
    //   }
    const [pendingAttachment, setPendingAttachment] = useState(null);

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
    // 2026-05-24 — `notifyAnyway` state removed (chat always pushes).
    // See the import-block comment up top.
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
        let alive = true;
        const unsub = onSnapshot(q, (snap) => {
            if (!alive) return;
            const set = new Set();
            snap.forEach(d => {
                const data = d.data();
                if (data.messageId) set.add(data.messageId);
            });
            setMyAcks(set);
        }, () => {});
        return () => { alive = false; unsub(); };
    }, [chat?.id, staffName]);

    // Pinned-message count for the top-of-thread banner.
    const pinnedMessages = useMemo(
        () => messages.filter(m => m.pinned === true && !m.deleted),
        [messages]
    );

    // 2026-05-24 — off-shift detection subscription + memo deleted.
    // The Cloud Function still has its off-shift gate, but chat_message
    // / chat_mention are in ALWAYS_DELIVER_TYPES so they bypass it.
    // Per Andrew's "all chat pushes regardless of shift", we additionally
    // always send forceDeliver: true from this file. The "today's shifts"
    // snapshot that fed this is gone — saves an unnecessary subscription
    // per chat thread.

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
        let alive = true;
        const unsub = onSnapshot(q, (snap) => {
            if (!alive) return;
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setScheduledMessages(list);
        }, (err) => console.warn('scheduled snapshot failed:', err));
        return () => { alive = false; unsub(); };
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
        // Snippet is stored in Firestore with the sender's language at write time —
        // a future polish would store message.type instead and translate at read
        // time so the recipient sees their own language. For now Spanish staff
        // at least get Spanish labels for THEIR replies.
        const snippet = (message.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
            || (message.type === 'image' ? tx('📷 Photo', '📷 Foto')
                : message.type === 'video' ? tx('🎬 Video', '🎬 Video')
                : message.type === 'audio' ? tx('🎤 Voice', '🎤 Voz')
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
        // 2026-05-24 — chat always force-delivers. See top-of-file comment.
        const capturedNotify = true;
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
            // notifyAnyway removed 2026-05-24 — chat always pushes.
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

    // ── Stage media (photo / video) ────────────────────────────────
    // 2026-05-27 — Andrew: "when we add a photo or video or voice
    // memo i want it to load in the message input board and then i
    // send it when we want." Previously this function uploaded to
    // Firebase Storage and called sendMessage() inline; now it just
    // resizes/probes the file and parks it in `pendingAttachment`
    // so the composer can render a preview. The real upload+send
    // is deferred to `sendStagedAttachment()`, fired when the user
    // taps the send arrow (which is now also wired to fire whenever
    // a staged attachment is present, regardless of caption text).
    async function handleMediaPick(e, kind) {
        const file = e.target.files?.[0];
        e.target.value = ''; // reset so re-picking same file fires change
        if (!file) return;
        if (kind === 'video' && file.size > MAX_VIDEO_BYTES) {
            toast(tx('Video too large (50MB max).', 'Video muy grande (50MB máx).'), { kind: 'warn' });
            return;
        }
        // Briefly disable the composer while we resize/probe — these
        // are fast (sub-second) but blocking. Not an upload, so we
        // don't show an upload-progress bar.
        setSending(true);
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
            // Build a local preview URL the composer can render. Note:
            // the useEffect cleanup above revokes the PREVIOUS value's
            // URL automatically when setPendingAttachment fires, so
            // back-to-back picks don't leak.
            const previewUrl = URL.createObjectURL(uploadFile);
            setPendingAttachment({
                kind,
                uploadFile,
                previewUrl,
                mimeType: file.type,
                width, height, duration,
                filename: file.name || '',
            });
        } catch (err) {
            console.warn(`${kind} stage failed:`, err);
            toast(tx('Could not load file', 'No se pudo cargar el archivo'), { kind: 'error' });
        } finally {
            setSending(false);
        }
    }

    // ── Send a staged attachment (photo / video / voice memo) ─────
    // Mirrors the upload+send flow that handleMediaPick / uploadVoice
    // USED to do inline; now it's deferred to the moment the user
    // taps the send arrow so they can add captions, cancel, or swap
    // files before committing. The draft text becomes the caption.
    // On failure we KEEP the staged attachment so the user can
    // retry without re-picking.
    async function sendStagedAttachment() {
        if (!pendingAttachment) return;
        if (sendingRef.current) return;
        const att = pendingAttachment;
        sendingRef.current = true;
        setSending(true);
        setUploadProgress({ kind: att.kind, pct: 0 });
        try {
            // Extension picking:
            //   • voice: mime decides m4a vs webm
            //   • photo/video: original filename suffix
            let ext;
            if (att.kind === 'audio') {
                ext = att.mimeType?.includes('mp4') ? 'm4a' : 'webm';
            } else {
                ext = (att.filename?.split('.').pop() || 'bin').toLowerCase();
            }
            const messageId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const path = `chats/${chat.id}/${messageId}.${ext}`;
            const r = sref(storage, path);
            await uploadBytes(r, att.uploadFile, { contentType: att.mimeType });
            const url = await getDownloadURL(r);
            await sendMessage({
                chat, staffName, viewer, staffList,
                type: att.kind,
                text: draft.trim(),  // optional caption (photos/videos);
                                     //   voice memos pre-2026-05-27 always
                                     //   sent text:'' — we now allow a
                                     //   caption on voice too, since the
                                     //   composer textarea is right there
                                     //   and the message schema supports it.
                mediaUrl: url,
                mediaPath: path,
                mediaType: att.mimeType,
                width: att.width,
                height: att.height,
                duration: att.duration,
                replyTo: replyTarget,
                forceDeliver: true,
            });
            setDraft('');
            setReplyTarget(null);
            setPendingAttachment(null);  // effect cleanup revokes URL
        } catch (err) {
            console.warn(`${att.kind} send failed:`, err);
            toast(tx('Upload failed', 'Error al subir'), { kind: 'error' });
        } finally {
            sendingRef.current = false;
            setSending(false);
            setUploadProgress(null);
        }
    }

    // Dispatcher wired to the composer's send arrow + Enter-to-send.
    // Routes to staged-attachment send when one is present (caption
    // is optional in that case), otherwise falls through to the
    // text-only send path — preserving today's behavior for
    // text-only messages.
    async function handleSend() {
        if (pendingAttachment) {
            await sendStagedAttachment();
        } else {
            await handleSendText();
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

    // Pending-attachment object-URL cleanup. Every staged photo /
    // video / voice memo creates a `URL.createObjectURL()` blob URL
    // that the <img>/<video>/<audio> preview tags consume. Without
    // explicit `URL.revokeObjectURL()` the browser pins each blob
    // in memory until the tab closes — so back-to-back staging
    // (pick photo A → swap to photo B → swap to photo C) would
    // leak every prior blob.
    //
    // This effect's cleanup fires whenever `pendingAttachment`
    // changes (revoking the PREVIOUS value's URL) and on unmount
    // (revoking the FINAL value's URL — covers chat switches via
    // the parent's `key={chatId}` remount and tab navigation).
    useEffect(() => {
        return () => {
            if (pendingAttachment?.previewUrl) {
                try { URL.revokeObjectURL(pendingAttachment.previewUrl); } catch {}
            }
        };
    }, [pendingAttachment]);

    function clearPendingAttachment() {
        // The effect above handles URL.revokeObjectURL on the state
        // transition — we just null the slot here.
        setPendingAttachment(null);
    }
    // 2026-05-27 — function name is now misleading: it no longer
    // uploads anything. It just stages the voice blob into
    // pendingAttachment so the composer can render an <audio>
    // preview. The real Storage upload + sendMessage now lives in
    // sendStagedAttachment() (single choke-point with photo/video).
    // Kept the name `uploadVoice` only to minimize churn at the
    // single call site (rec.onstop above); semantically it's
    // "stagePendingVoice".
    async function uploadVoice(blob, duration) {
        try {
            const previewUrl = URL.createObjectURL(blob);
            setPendingAttachment({
                kind: 'audio',
                uploadFile: blob,
                previewUrl,
                mimeType: blob.type,
                duration,
                filename: `voice.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`,
            });
        } catch (e) {
            console.warn('voice stage failed:', e);
            toast(tx('Voice capture failed', 'Error al grabar voz'), { kind: 'error' });
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
            // 2026-05-24 audit fix: edit was leaving the stale `mentions[]`
            // array on the doc — if a user edited "hey team" → "hey @Andrea",
            // the bubble's "mentioned you" highlight never appeared, and any
            // filter on "your mentions" missed the edit. Conversely, removing
            // an @-name left the stale highlight on. Re-parse mentions and
            // patch alongside text. Intentional: we do NOT re-fire push
            // notifications for new mentions in an edit (CLAUDE.md policy —
            // avoid users gaming edits to re-ping people).
            const { mentions: nextMentions } = parseMentions(trimmed, staffList);
            await updateDoc(doc(db, 'chats', chat.id, 'messages', message.id), {
                text: trimmed,
                edited: true,
                editedAt: serverTimestamp(),
                editedBy: staffName,
                mentions: nextMentions,
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
                forceDeliver: true,   // 2026-05-24 — always push chat (was: notifyAnyway)
            });
            setReplyTarget(null);
            // notifyAnyway removed 2026-05-24 — chat always pushes.
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
                    // 2026-05-24 audit fix: dedup was case-folded + trimmed
                    // only — "Chicken Wings " (trailing space) and
                    // "chicken-wings" went through as distinct. Strip all
                    // non-alphanumerics for the comparison key so spelling
                    // variants collapse to the same row. Display name is
                    // unchanged.
                    const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                    const norm = slugify(itemName);
                    const exists = cur.some(it => slugify(it?.name) === norm);
                    if (exists) return; // already on the list — no-op
                    // 2026-05-23 — also persist the optional note + the
                    // staffer's ID. The note already rides on the chat
                    // message (eightySixData.note); duplicating it onto
                    // the items[] entry lets the Eighty6Dashboard show
                    // context like "Marked by Sarah at 4:23pm — running
                    // low for service" without having to cross-reference
                    // back to the chat doc. addedById is captured for
                    // future "tap to message the 86er" UX; it's harmless
                    // to record even if we never read it.
                    const nextItems = [
                        ...cur,
                        {
                            name: itemName,
                            status: 'OUT_OF_STOCK',
                            addedBy: staffName,
                            addedById: viewer?.id || null,
                            addedAt: new Date().toISOString(),
                            note: (note || '').trim() || null,
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
                    // 2026-05-24 — chat always pushes. Stamp forceDeliver
                    // on the scheduled doc so the Cloud Function honors
                    // the same always-deliver intent at fire time.
                    forceDeliver: true,
                },
            });
            setDraft('');
            setReplyTarget(null);
            // notifyAnyway removed 2026-05-24 — chat always pushes.
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
                manage-membership flow Andrew kept missing.
                2026-05-27 — added `safe-top` so the header clears the
                iPhone notch when the chat thread takes the full
                viewport (after the bottom-nav-hide change). Without
                this padding, the back button sits BEHIND the notch on
                PWA installs and can't be tapped. */}
            {/* 2026-05-27 — Andrew: "make it look like this. look how
                the top and bottom looks." Restructured the header into
                three floating elements (Zenzap / iMessage / Slack iOS
                pattern):
                  [○ back]  [🍴 Maryland FOH — 12 members ]  [○ ⚙]
                Back arrow and settings are small circular "pucks"; the
                title is a rounded pill chip carrying avatar + name +
                subtitle. No bottom border, no full-width bg — the chip
                bg + the chat shell bg create depth via elevation, not
                a divider line. ddmau-header-back-puck /
                ddmau-header-chip / ddmau-header-action-puck are the
                CSS hooks for the layered dark fills (see index.css). */}
            <header className="safe-top px-3 pt-2.5 pb-2 bg-white flex items-center gap-2 shrink-0">
                <button
                    onClick={onBack}
                    className="ddmau-header-back-puck md:hidden w-10 h-10 rounded-full flex items-center justify-center shrink-0 active:scale-95 transition"
                    aria-label={tx('Back to chats', 'Volver a chats')}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                </button>
                <button
                    onClick={onOpenSettings}
                    className="ddmau-header-chip flex items-center gap-2.5 min-w-0 flex-1 px-2.5 py-1.5 rounded-2xl active:scale-[0.98] transition text-left"
                    title={tx('Open chat info', 'Abrir info del chat')}
                >
                    <ChatAvatar chat={chat} viewerName={staffName} size={32} />
                    <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-black text-dd-text leading-tight truncate">
                            {chatDisplayName(chat, staffName)}
                        </div>
                        <div className="text-[11px] text-dd-text-2 truncate">
                            {chat.type === 'dm'
                                ? (typingNames.length > 0
                                    ? tx('typing…', 'escribiendo…')
                                    : tx('Direct message', 'Mensaje directo'))
                                : (typingNames.length > 0
                                    ? `${formatChatName(typingNames[0])} ${tx('is typing…', 'está escribiendo…')}`
                                    : `${(chat.members || []).length} ${tx('members', 'miembros')}`)}
                        </div>
                    </div>
                </button>
                <button
                    onClick={onOpenSettings}
                    className="ddmau-header-action-puck w-10 h-10 rounded-full flex items-center justify-center text-base shrink-0 active:scale-95 transition"
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
                className="flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain px-3 py-2"
                style={{
                    WebkitOverflowScrolling: 'touch',
                    // Andrew 2026-05-31: disable the browser's scroll-
                    // anchoring heuristic. With it ON, when content
                    // height changes (image loads, fonts swap), the
                    // browser shifts scrollTop to "keep the visual
                    // position stable" — but that competes with our
                    // ResizeObserver re-snap and produces visible
                    // jitter. With it OFF, the ResizeObserver is the
                    // single source of truth for "where should the
                    // scroll be" and the result is one clean snap.
                    overflowAnchor: 'none',
                }}
            >
                {/* 2026-05-27 — Andrew: "the chats and how its not stuch
                    to the bottom." iMessage / Zenzap pin messages to the
                    BOTTOM of the visible area when the thread is short,
                    not float them in the middle. Trick: wrap the message
                    list in a flex column with `min-h-full justify-end`
                    inside the overflow-y-auto scroller. Short threads
                    sit at the bottom (justify-end pushes them down to
                    fill the min-height); long threads grow past min-h
                    and scroll normally with oldest at the top, newest
                    at the bottom — same UX.

                    innerRef (Andrew 2026-05-31): a ResizeObserver above
                    watches this wrapper's height so any async expansion
                    (image load, font swap, etc.) re-snaps to bottom
                    pre-paint and the user never sees the jump-up. */}
                <div ref={innerRef} className="flex flex-col justify-end min-h-full space-y-1">
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
                        <div className="ddmau-chat-divider text-center text-[11px] font-bold text-dd-text-2 uppercase tracking-widest py-3">
                            {group.label}
                        </div>
                        {group.messages.map((msg, i) => {
                            const prev = group.messages[i - 1];
                            const sameSender = prev?.senderName === msg.senderName
                                && msg.createdAt?.toMillis && prev?.createdAt?.toMillis
                                && (msg.createdAt.toMillis() - prev.createdAt.toMillis()) < 5 * 60 * 1000;
                            return (
                                // PERF-1, 2026-05-30: was rendering
                                // `MessageBubbleInner` directly, which silently
                                // bypassed the `memo()` wrapper + custom equality
                                // comparator defined ~360 lines below as
                                // `MessageBubble`. Every keystroke in the composer
                                // and every snapshot fan-out re-rendered every
                                // visible bubble. Switching to `MessageBubble`
                                // re-engages the comparator and limits re-renders
                                // to the bubbles whose data actually changed.
                                <MessageBubble
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
                {/* 2026-05-27 — three distinct states instead of the
                    previous "always show 'Be the first to say hi'":
                      - loading  → spinner with explanatory text
                      - loadError → red banner + Retry button
                      - empty     → the original empty-chat message
                    Order matters: loading wins over error wins over empty
                    so a stalled first-load doesn't briefly flash the
                    empty-state copy. */}
                {messages.length === 0 && loading && (
                    <div className="py-12 text-center text-sm text-dd-text-2">
                        <div className="inline-block w-6 h-6 border-2 border-dd-line border-t-dd-green rounded-full animate-spin mb-3" />
                        <div>{tx('Loading messages…', 'Cargando mensajes…')}</div>
                    </div>
                )}
                {messages.length === 0 && !loading && loadError && (
                    <div className="py-10 px-4 text-center">
                        <div className="text-4xl mb-2">⚠️</div>
                        <div className="text-sm font-bold text-dd-text mb-1">
                            {loadError === 'failed-precondition'
                                ? tx('Updating chat indexes', 'Actualizando índices')
                                : loadError === 'unavailable'
                                ? tx('Offline', 'Sin conexión')
                                : loadError === 'permission-denied'
                                ? tx('Access denied', 'Acceso denegado')
                                : tx("Couldn't load this chat", 'No se pudo cargar este chat')}
                        </div>
                        {/* 2026-05-28 Audit #4 — same error-code split as
                            ChatCenter so the user gets specific guidance
                            for the most common failure modes (index
                            building after deploy, transient offline,
                            permission rule change). */}
                        <div className="text-[12px] text-dd-text-2 mb-3 max-w-xs mx-auto">
                            {loadError === 'timeout'
                                ? tx(
                                    'Network is slow — give it another try in a second.',
                                    'La red está lenta — intenta de nuevo en un momento.',
                                )
                                : loadError === 'failed-precondition'
                                ? tx(
                                    'Just deployed — try again in about a minute.',
                                    'Recién actualizado — intenta en un minuto.',
                                )
                                : loadError === 'unavailable'
                                ? tx(
                                    'Reconnecting to Firestore…',
                                    'Reconectando a Firestore…',
                                )
                                : loadError === 'permission-denied'
                                ? tx(
                                    'Your access to this chat changed. Tell Andrew.',
                                    'Tu acceso a este chat cambió. Avísale a Andrew.',
                                )
                                : tx(
                                    'Tap retry. If it keeps happening, check your Wi-Fi or tell Andrew.',
                                    'Toca reintentar. Si sigue pasando, revisa tu Wi-Fi o avísale a Andrew.',
                                )}
                        </div>
                        <button
                            onClick={retryMessageLoad}
                            className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 active:scale-95 transition shadow-sm"
                        >
                            ↻ {tx('Retry', 'Reintentar')}
                        </button>
                        <div className="text-[10px] text-dd-text-2/70 mt-2 font-mono">
                            {String(loadError).slice(0, 80)}
                        </div>
                    </div>
                )}
                {messages.length === 0 && !loading && !loadError && (
                    <div className="py-12 text-center text-sm text-dd-text-2">
                        {tx('Be the first to say hi 👋', '¡Sé el primero en saludar 👋!')}
                    </div>
                )}
                </div>
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
                // 2026-05-27 — `onSendText` is now a dispatcher that
                // routes to the staged-attachment send path when a
                // pending photo/video/voice memo is parked in the
                // composer. Text-only sends still hit handleSendText
                // through the dispatcher (handleSend).
                onSendText={handleSend}
                onPickImage={(e) => handleMediaPick(e, 'image')}
                onPickVideo={(e) => handleMediaPick(e, 'video')}
                onStartRecording={startRecording}
                onStopRecording={() => stopRecording(false)}
                onCancelRecording={() => stopRecording(true)}
                onOpenPoll={() => setShowPollModal(true)}
                onOpenSchedule={() => setShowScheduleModal(true)}
                onOpen86={() => setShow86Modal(true)}
                recordStartMs={recordStartRef.current}
                // Staged attachment + cancel handle. Composer renders
                // the preview pill + flips the send/mic toggle.
                pendingAttachment={pendingAttachment}
                onClearAttachment={clearPendingAttachment}
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
        <ChatThreadErrorBoundary key={chatId} onReset={props?.onBack} language={props?.language}>
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
    // Shared reaction-chips row. Andrew 2026-05-28: "in chat when i
    // double click a message and put the thumbs up it doesnt show up."
    // Bug was that the chips were only inlined in the catch-all bubble
    // branch (text/image/video/audio). The 6 specialty bubble types
    // (announcement, coverage_request, eighty_six_alert, photo_issue,
    // task_handoff, poll) all wire up the MessageActionMenu correctly
    // so the Firestore write happens, but they never rendered chips —
    // so the user picked 👍 and nothing visible came back. Now every
    // branch injects this fragment after its specialty card, so the
    // chips appear no matter which bubble type was reacted to. Layout
    // mirrors the catch-all original: row of pills aligned to the
    // sender's side (right for "mine", left for theirs); click toggles
    // own reaction off.
    const reactionsRow = reactionEntries.length > 0 ? (
        <div className={`flex gap-1 mt-1 px-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
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
    ) : null;
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
                {reactionsRow}
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
                {reactionsRow}
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
                {reactionsRow}
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
                {reactionsRow}
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
                {reactionsRow}
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
                {reactionsRow}
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
                        // 2026-05-28 — Andrew requested iMessage-style
                        // double-click on a bubble to open the reactions +
                        // reply menu. Long-press handled this on mobile;
                        // right-click handled it on desktop; now double-
                        // click does too. preventDefault stops the
                        // browser's text-selection from triggering on the
                        // bubble body — the user is asking for an action,
                        // not a copy. Right-click + long-press still work.
                        onDoubleClick={(e) => { e.preventDefault(); setShowActions(true); }}
                        className={`relative rounded-2xl px-3 py-2 break-words ${isMine
                            ? 'bg-dd-green text-white rounded-br-md'
                            : (mentioned
                                ? 'bg-amber-50 text-dd-text border border-amber-300 rounded-bl-md'
                                /* `ddmau-bubble-other` flips this to a
                                   dark surface on mobile via index.css —
                                   keeps the white bubble on desktop. */
                                : 'ddmau-bubble-other bg-white text-dd-text border border-dd-line rounded-bl-md')}`}
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
                            <video src={message.mediaUrl} controls playsInline preload="metadata"
                                width="320" height="240" style={{ aspectRatio: '4 / 3' }}
                                className="rounded-lg w-auto max-w-full max-h-[360px] bg-dd-bg/40" />
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
                    {/* Reactions row — shared `reactionsRow` JSX defined
                        at the top of MessageBubbleInner so the chips
                        render on every bubble type, not just the
                        catch-all. */}
                    {reactionsRow}
                    {/* Action menu — reactions + reply + pin + task + delete.
                        2026-05-28 fix: this catch-all menu (rendered when
                        the bubble type wasn't one of the type-specific
                        cases above) was missing onReply + onStartEdit, so
                        replying via the menu silently did nothing for
                        bubble types that landed here. Now matches the
                        type-specific menus' prop set. */}
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
            {/* 2026-05-30 perf — intrinsic 4:3 width/height + matching CSS
                aspectRatio so the browser reserves vertical space BEFORE the
                image bytes arrive. Without these, lazy-loaded chat photos
                snap from 0px to natural height on first paint and shove the
                rest of the message stream around (CLS). */}
            <img
                src={url}
                alt={alt}
                loading="lazy"
                decoding="async"
                width="320"
                height="240"
                onClick={() => setZoom(true)}
                style={{ aspectRatio: '4 / 3' }}
                className="rounded-lg w-auto max-w-full max-h-[360px] object-cover cursor-zoom-in bg-dd-bg/40"
            />
            {zoom && (
                <ModalPortal>
                <div
                    className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
                    onClick={() => setZoom(false)}
                >
                    <img src={url} alt={alt} className="max-w-full max-h-full object-contain" />
                </div>
                </ModalPortal>
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
    onSendText, onPickImage, onPickVideo,
    onStartRecording, onStopRecording, onCancelRecording,
    onOpenPoll, onOpenSchedule, onOpen86,
    recordStartMs,
    // 2026-05-27 — Staged-attachment props. When the user picks a
    // photo/video or finishes a voice memo, the parent parks it in
    // `pendingAttachment` (shape: { kind, previewUrl, mimeType,
    // duration?, filename?, ... }). The composer renders a preview
    // pill + flips the trailing button from mic to send so the user
    // can dispatch the upload with an optional caption. `onClearAttachment`
    // discards the staged file (parent revokes its object URL).
    pendingAttachment, onClearAttachment,
}) {
    const imageInputRef = useRef(null);
    const videoInputRef = useRef(null);
    // Textarea ref — needed so the emoji picker can insert at the
    // user's current cursor position (not blindly at the end). We
    // keep the cursor in a state slot too so re-renders don't lose
    // our place between key + emoji input.
    const textareaRef = useRef(null);
    // 2026-06-07 (round 4) — single send chokepoint. Earlier rounds tried
    // onMouseDown / onPointerDown + preventDefault to keep the soft keyboard
    // up on tap; on iOS WKWebView that SUPPRESSED the click (preventDefault
    // on a down-event cancels the synthetic click) so the arrow never fired.
    // All preventDefault gymnastics are gone now: the button is a plain
    // onClick (reliable everywhere) and the native soft keyboard's Enter key
    // also sends (see onKeyDown). Overlapping / rapid sends are already
    // guarded by sendingRef inside handleSendText, so no dedupe is needed.
    const fireSend = () => { onSendText(); };
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    // Mobile-only attach drawer. On mobile the composer collapses to
    // [+] [textarea] [send] (standard messenger pattern); tapping +
    // reveals a tray with photo / video / poll / 86 / emoji / fix-
    // grammar / schedule. On md+ the inline icon row is preserved and
    // this state is unused. Andrew (2026-05-24).
    const [showAttachMenu, setShowAttachMenu] = useState(false);
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

    // 2026-06-07 — Andrew: "the return key is still sending, make it stop."
    // We temporarily made Enter send on the native app as a workaround while
    // the on-screen arrow was untappable with the keyboard open. That arrow
    // bug is now fixed (scroll-lock revert — see capacitor.config / index.css),
    // so the arrow is the send button on every platform and Return goes back
    // to inserting a newline like a normal multi-line textarea. Only
    // Cmd / Ctrl + Enter still sends (a desktop power-user affordance that no
    // phone soft keyboard can trigger, so it doesn't affect mobile).
    function onKeyDown(e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            fireSend();
        }
    }

    // 2026-05-24 — Andrew: "if the message gets larger than 2 lines let
    // the message input bar grow with the messages until you think we
    // shouldnt get any bigger."
    //
    // Native <textarea rows={1}> stays at one row even when the content
    // wraps to 5 — the user sees only the last line. To make it grow,
    // we reset height to 'auto' (so the browser can recompute the
    // natural content height), read scrollHeight, then write that back
    // capped at maxPx. The cap = MAX_COMPOSER_PX (≈6-7 lines at
    // text-base + line-height 1.4) so it never eats more than ~30% of
    // a typical phone screen — past that the message list above gets
    // squashed and the user loses context of what they're replying to.
    // CSS overflow-y on the textarea kicks in past the cap so a 100-
    // line paste scrolls inside the box instead of pushing the
    // composer up to consume the whole viewport.
    const MIN_COMPOSER_PX = 44;
    const MAX_COMPOSER_PX = 160;
    useEffect(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = 'auto';
        const next = Math.min(Math.max(ta.scrollHeight, MIN_COMPOSER_PX), MAX_COMPOSER_PX);
        ta.style.height = next + 'px';
        // overflow toggle: hide scrollbar until we hit the cap. Without
        // this, browsers paint a thin scrollbar on every keystroke as the
        // height transitions, which flickers on iOS.
        ta.style.overflowY = ta.scrollHeight > MAX_COMPOSER_PX ? 'auto' : 'hidden';
    }, [draft]);

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
                    // 2026-05-27 — was "Send voice" when this button
                    // sent immediately. Now it stops recording and
                    // stages the voice memo in the composer for
                    // review; the user taps the regular send arrow
                    // (on the staged-attachment preview) to actually
                    // dispatch. WhatsApp / iMessage two-step pattern.
                    aria-label={isEs ? 'Terminar grabación' : 'Finish recording'}
                    title={isEs ? 'Terminar grabación' : 'Finish recording'}
                >
                    ✓
                </button>
            </div>
        );
    }

    // `empty` retains its original meaning — there's no DRAFT TEXT —
    // and is still the gate for the Fix-spelling / Schedule-send
    // menu items (which operate on text). The send/mic toggle below
    // now uses `canSend`, which also accounts for staged attachments:
    // the send arrow lights up when there's a photo/video/voice
    // memo to dispatch even if the caption is blank.
    const empty = !draft.trim();
    const hasAttachment = !!pendingAttachment;
    const canSend = !empty || hasAttachment;
    return (
        // 2026-05-24 — Andrew: "make sure the message input bar is stuck
        // to the bottom bar i doesnt need to move."
        //
        // Belt-and-suspenders to keep this row PINNED to the bottom of
        // its scrolling container regardless of:
        //   • how tall the messages list grows
        //   • whether the parent uses 100vh / 100dvh / static height
        //   • iOS keyboard opening (visualViewport changes don't budge
        //     this row — only the messages list above scrolls)
        //
        // sticky bottom-0 wins inside a flex column WHEN the parent has
        // overflow-y other than visible (ChatThread parent does — it
        // uses overflow-hidden). z-10 keeps it ABOVE the messages list
        // backdrop if any message has lingering transform animations.
        // shrink-0 already ensures flex doesn't squeeze it. translateZ(0)
        // forces a GPU layer so iOS scrollKit doesn't reflow it during
        // momentum scroll.
        <div
            // 2026-05-27 — Andrew: "look at safari the app message input
            // bar is still high and its the same in mobile."
            //
            // The chat-shell CSS rule used to subtract BOTH safe-area
            // insets (top + bottom) from 100dvh, which left the
            // composer sitting ~34px above the iPhone home-indicator
            // strip. iOS-standard fix: the bottom safe-area subtraction
            // is gone (see index.css ddmau-chat-shell rule), and the
            // composer extends its WHITE BACKGROUND into the safe-area
            // zone via `padding-bottom: env(safe-area-inset-bottom)`.
            // The inner buttons/textarea row still sits above the home
            // indicator (the padding pushes content up), but the
            // composer's surface flows all the way to the screen
            // bottom — no more sage strip below it.
            // 2026-06-07 — was `sticky bottom-0`. On iOS WKWebView, a
            // `position: sticky` bar under the fixed-body scroll-lock has a
            // touch hit-region that diverges from where it's painted while
            // the soft keyboard is open — so the small send arrow at the
            // right edge couldn't be tapped (keyboard up = dead, keyboard
            // down = fine; the textarea, being large, absorbed the offset).
            // The sticky was redundant anyway: this bar is the last
            // `shrink-0` child of a full-height flex column, so flex already
            // pins it to the bottom. `relative z-10` keeps it stacked above
            // the message list without the sticky hit-test bug.
            className="relative z-10 px-2 pt-2 pb-2 border-t border-dd-line bg-white shrink-0"
            style={{
                // 2026-06-07 — REMOVED `transform: translateZ(0)`. On iOS
                // WKWebView, `position: sticky` + a `transform` on the SAME
                // element breaks hit-testing: the painted position and the
                // actual touch target diverge by a few px, so the large
                // textarea still gets tapped but the small 44px send arrow
                // at the right edge falls outside the shifted touch region
                // and never fires. Confirmed empirically: a bare onClick
                // with no preventDefault STILL didn't send on iOS, while the
                // keyboard Return key (which never touches the button) sends
                // fine. The translateZ was only an anti-flicker GPU-layer
                // hint for momentum scroll — and iOS runs scrollEnabled:false
                // (no WKWebView momentum scroll), so it bought nothing there.
                // The composer stays pinned as the last child of the full-
                // height flex column.
                paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))',
            }}
        >
            {/* 2026-05-24 — off-shift "Notify anyway" banner removed.
                Chat now always pushes regardless of recipient shift
                status (forceDeliver: true on every chat send). The
                banner was a noisy confusing UI surface anyway: users
                read "won't get push" and assumed the message wouldn't
                fan out, even though chat_message + chat_mention were
                ALREADY in the Cloud Function's ALWAYS_DELIVER_TYPES
                set and therefore always pushed. Belt-and-suspenders
                forceDeliver makes the server-side guarantee explicit
                from the client. */}
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
            {/* 2026-05-27 — Pending attachment preview pill. When the
                user picks a photo/video or finishes a voice memo, it
                lands HERE as a preview before the actual upload+send
                happens. Optional caption can be typed in the textarea
                below; tap the send arrow to commit, or ✕ to discard.
                Mirrors the WhatsApp / iMessage staging pattern. Same
                visual treatment as the reply pill above so the two
                stack cleanly when the user is both replying AND
                attaching media. */}
            {pendingAttachment && (
                <div className="flex items-center gap-2 mb-1 px-2 py-1.5 rounded-lg bg-dd-sage-50 border border-dd-green/30">
                    {pendingAttachment.kind === 'image' && (
                        <img
                            src={pendingAttachment.previewUrl}
                            alt=""
                            className="w-14 h-14 rounded-md object-cover shrink-0 bg-black/5"
                            draggable={false}
                        />
                    )}
                    {pendingAttachment.kind === 'video' && (
                        <video
                            src={pendingAttachment.previewUrl}
                            muted
                            playsInline
                            // Showing the first frame as a poster-style
                            // preview. `preload="metadata"` is enough on
                            // most browsers to paint frame 0 without
                            // starting playback.
                            preload="metadata"
                            className="w-14 h-14 rounded-md object-cover shrink-0 bg-black"
                        />
                    )}
                    {pendingAttachment.kind === 'audio' && (
                        <div className="w-14 h-14 rounded-md bg-dd-green/15 text-dd-green-700 flex items-center justify-center shrink-0">
                            <Mic size={26} strokeWidth={2.25} aria-hidden="true" />
                        </div>
                    )}
                    <div className="flex-1 min-w-0">
                        <div className="text-[10.5px] font-black uppercase tracking-wider text-dd-green-700">
                            {pendingAttachment.kind === 'image'
                                ? (isEs ? '📎 Foto lista' : '📎 Photo ready')
                                : pendingAttachment.kind === 'video'
                                ? (isEs ? '📎 Video listo' : '📎 Video ready')
                                : (isEs ? '📎 Memo de voz listo' : '📎 Voice memo ready')}
                        </div>
                        {pendingAttachment.kind === 'audio' ? (
                            // Inline <audio controls> lets the user
                            // play back the recording before sending —
                            // a "did I sound OK?" sanity check. Tiny
                            // height (~28px) so the preview row stays
                            // compact even with the player visible.
                            <audio
                                src={pendingAttachment.previewUrl}
                                controls
                                className="mt-1 h-7 w-full"
                                style={{ maxWidth: '100%' }}
                            />
                        ) : (
                            <div className="text-[12px] text-dd-text-2 truncate">
                                {pendingAttachment.filename || (isEs ? 'Sin nombre' : 'Untitled')}
                                {pendingAttachment.duration
                                    ? ` · ${Math.round(pendingAttachment.duration)}s`
                                    : ''}
                            </div>
                        )}
                    </div>
                    <button
                        onClick={onClearAttachment}
                        disabled={sending}
                        className="w-7 h-7 rounded-full hover:bg-white text-dd-text-2 flex items-center justify-center shrink-0 disabled:opacity-40"
                        aria-label={isEs ? 'Cancelar adjunto' : 'Cancel attachment'}
                        title={isEs ? 'Cancelar' : 'Cancel'}
                    >
                        ✕
                    </button>
                </div>
            )}
            {/* 2026-05-24 — unified attach drawer. Was previously a
                mobile-only collapsed menu PLUS an inline icon strip on
                desktop. Andrew: "put all the bubbles in a + on the
                left and a Send arrow on the right and thats it."
                Same drawer + cleaner [ + | textarea | send ] layout
                on ALL screen sizes. Reduces composer clutter and
                matches WhatsApp / iMessage / Slack muscle memory.
                All 7 actions live here — photo, video, poll, 86,
                emoji, fix-grammar, schedule. Auto-closes after pick.
                Hidden file inputs sit OUTSIDE the drawer block so a
                hide/show transition doesn't unmount the inputs (which
                would drop the in-flight file selection on iOS). */}
            <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={onPickImage}
                className="hidden"
            />
            <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                onChange={onPickVideo}
                className="hidden"
            />
            {/* 2026-05-27 — Andrew: rebuild + menu as a floating
                translucent bubble popup (Zenzap / iMessage style)
                instead of a horizontal bar that pushes the composer
                up. Two layout wins:
                  1. The popup is `absolute bottom-full` so it floats
                     above the composer row WITHOUT pushing it. The
                     composer stays put — no layout shift on open.
                  2. Vertical list with icon + label, anchored to the
                     bottom-left near the + button. Translucent dark
                     bg + backdrop-blur = the bubble effect from the
                     reference screenshots.
                Transparent backdrop fills the viewport so tapping
                outside the bubble dismisses it (handles iOS soft-
                keyboard-with-no-blur edge case). z-30 on the bubble
                + z-20 on the backdrop sit ABOVE the composer's z-10. */}
            {showAttachMenu && (
                <>
                    {/* Click-outside-to-dismiss backdrop — invisible,
                        full-viewport, just catches taps. Tapping
                        inside the bubble doesn't bubble up because
                        the bubble stops propagation via its onClick. */}
                    <button
                        type="button"
                        aria-label={isEs ? 'Cerrar menú' : 'Close menu'}
                        onClick={() => setShowAttachMenu(false)}
                        className="fixed inset-0 z-20 bg-transparent cursor-default"
                    />
                    {/* 2026-05-27 — Andrew: "in chat the + button we need
                        to make the photo, video, poll etc all look more
                        professional and apple. fix the emopjis. make
                        that window glass." Bubble redesigned from a
                        dark zinc-900 frosted panel + emoji icons to a
                        light Apple-glass surface (rgba white + heavy
                        backdrop-blur + hairline border + layered
                        shadow) with Lucide glyphs in sage-tinted icon
                        discs. Each row reads like the home-tile family
                        — same icon disc treatment + body text scale. */}
                    <div
                        role="menu"
                        className="absolute bottom-full left-2 mb-3 z-30 min-w-[220px] max-w-[260px] p-1.5 rounded-glass-xl overflow-hidden animate-fade-in-up"
                        style={{
                            backgroundColor: 'rgba(255, 255, 255, 0.85)',
                            backdropFilter: 'blur(28px) saturate(180%)',
                            WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                            border: '1px solid rgba(15, 23, 42, 0.08)',
                            boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 12px 36px -8px rgba(15, 23, 42, 0.22), 0 4px 10px rgba(15, 23, 42, 0.10)',
                        }}
                    >
                        <AttachMenuItem
                            Icon={Camera}
                            label={isEs ? 'Foto' : 'Photo'}
                            onClick={() => { imageInputRef.current?.click(); setShowAttachMenu(false); }}
                            disabled={sending}
                        />
                        <AttachMenuItem
                            Icon={Video}
                            label={isEs ? 'Video' : 'Video'}
                            onClick={() => { videoInputRef.current?.click(); setShowAttachMenu(false); }}
                            disabled={sending}
                        />
                        {onOpenPoll && (
                            <AttachMenuItem
                                Icon={BarChart3}
                                label={isEs ? 'Encuesta' : 'Poll'}
                                onClick={() => { onOpenPoll(); setShowAttachMenu(false); }}
                                disabled={sending}
                            />
                        )}
                        {onOpen86 && (
                            <AttachMenuItem
                                Icon={Ban}
                                label={isEs ? 'Marcar 86' : 'Post 86'}
                                onClick={() => { onOpen86(); setShowAttachMenu(false); }}
                                disabled={sending}
                                tone="danger"
                            />
                        )}
                        <AttachMenuItem
                            Icon={Smile}
                            label={isEs ? 'Emoji' : 'Emoji'}
                            onClick={() => { setShowEmojiPicker(v => !v); setShowAttachMenu(false); }}
                            disabled={sending}
                            active={showEmojiPicker}
                        />
                        {!empty && (
                            <AttachMenuItem
                                Icon={Sparkles}
                                label={isEs ? 'Corregir texto' : 'Fix spelling'}
                                onClick={() => { handleFixGrammar(); setShowAttachMenu(false); }}
                                disabled={sending || fixing}
                                loading={fixing}
                                tone="purple"
                            />
                        )}
                        {!empty && onOpenSchedule && (
                            <AttachMenuItem
                                Icon={Calendar}
                                label={isEs ? 'Programar envío' : 'Schedule send'}
                                onClick={() => { onOpenSchedule(); setShowAttachMenu(false); }}
                                disabled={sending}
                            />
                        )}
                    </div>
                </>
            )}
            {/* Composer row — same layout EVERYWHERE now:
                  [ + ] [ textarea ] [ 🎤 voice OR ➤ send ]
                Bigger textarea (min-h-44, text-base) — also stops iOS
                Safari from zooming into the field on focus (font-size
                ≥ 16px is the documented threshold). */}
            {/* 2026-05-27 — Composer styled to match the Zenzap reference
                photo: circular dark-fill buttons flanking a pill-shaped
                input, no top divider, flush black bar. The `ddmau-composer-
                btn` class hook lets index.css apply the dark circular fill
                on mobile while keeping the existing light styling on
                desktop (which still uses the two-pane white layout). */}
            <div className="flex items-end gap-2">
                <button
                    onClick={() => setShowAttachMenu(v => !v)}
                    disabled={sending}
                    className={`ddmau-composer-btn w-11 h-11 rounded-full flex items-center justify-center text-2xl shrink-0 disabled:opacity-40 transition-transform duration-200 ${showAttachMenu ? 'bg-dd-sage-50 text-dd-green-700' : 'hover:bg-dd-bg text-dd-text-2'}`}
                    style={{ transform: showAttachMenu ? 'rotate(45deg)' : 'rotate(0deg)' }}
                    aria-label={isEs ? 'Más opciones' : 'More options'}
                    title={isEs ? 'Más opciones' : 'More options'}
                >
                    +
                </button>
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    onFocus={() => setShowAttachMenu(false)}
                    // Placeholder swaps to "Add a caption…" when a
                    // staged attachment is parked above — makes the
                    // optional-caption affordance discoverable.
                    placeholder={hasAttachment
                        ? (isEs ? 'Añade un comentario…' : 'Add a caption…')
                        : (isEs ? 'Mensaje…' : 'Message…')}
                    disabled={sending}
                    // min-h / max-h are the same constants the auto-grow
                    // useEffect above uses — keep them in sync. resize-none
                    // disables the browser's drag-handle (we drive height
                    // from JS instead). Initial inline height ensures the
                    // first paint is exactly MIN_COMPOSER_PX even before
                    // the effect runs.
                    // rounded-full gives a proper pill shape: corners
                    // clamp to half the box height, so single-line stays
                    // a stadium / lozenge and multi-line stays smoothly
                    // rounded at the ends. Matches the Zenzap reference.
                    className="flex-1 min-w-0 px-4 py-2.5 rounded-full bg-dd-bg border border-dd-line text-base text-dd-text resize-none focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green"
                    style={{ lineHeight: 1.4, minHeight: '44px', maxHeight: '160px', height: '44px' }}
                />
                {canSend ? (
                    // Send arrow — shown when there's text OR a staged
                    // attachment to dispatch. `onSendText` is wired in the
                    // parent to a dispatcher (handleSend) that routes to
                    // sendStagedAttachment() when an attachment is parked,
                    // otherwise to handleSendText().
                    //
                    // 2026-06-07 (round 4) — plain onClick, no preventDefault.
                    // Previous rounds preventDefault'd a down-event to keep the
                    // soft keyboard up; on iOS WKWebView that cancels the click
                    // so the arrow never fired. A bare onClick is the reliable
                    // path on every engine. (Tapping send may dismiss the soft
                    // keyboard — acceptable; Enter-to-send in onKeyDown is the
                    // primary path on phones now.) type="button" guards against
                    // a future <form> wrapper auto-submitting.
                    <button
                        type="button"
                        // 2026-06-07 — candidate fix: fire on pointerDOWN (no
                        // preventDefault) in addition to click. pointerdown lands
                        // at the very start of the touch — before iOS can divert
                        // the gesture to dismiss the keyboard — which is the
                        // suspected reason the arrow does nothing while the
                        // keyboard is open. sendingRef in handleSendText swallows
                        // the duplicate so a single tap still sends exactly once.
                        onPointerDown={fireSend}
                        onClick={fireSend}
                        disabled={sending}
                        // `ddmau-composer-btn-send` keeps the brand green on
                        // dark mobile (overrides the generic composer-btn
                        // dark-fill rule) so the send arrow stays bold and
                        // unmissable, the way iMessage's blue send button
                        // anchors the right edge.
                        className="ddmau-composer-btn ddmau-composer-btn-send w-11 h-11 rounded-full bg-dd-green text-white flex items-center justify-center font-black shrink-0 disabled:opacity-40 hover:bg-dd-green-700 active:scale-95 transition"
                        aria-label={isEs ? 'Enviar' : 'Send'}
                    >
                        ➤
                    </button>
                ) : (
                    <button
                        onClick={onStartRecording}
                        disabled={sending}
                        className="ddmau-composer-btn w-11 h-11 rounded-full hover:bg-dd-bg flex items-center justify-center shrink-0 disabled:opacity-40 text-dd-text-2"
                        aria-label={isEs ? 'Mensaje de voz' : 'Voice message'}
                        title={isEs ? 'Voz' : 'Voice'}
                    >
                        {/* Lucide Mic — strokeWidth 2.25 matches the
                            other composer-area glyphs (send arrow,
                            attach +) at this size. Inherits the
                            button's text color via stroke=currentColor. */}
                        <Mic size={20} strokeWidth={2.25} aria-hidden="true" />
                    </button>
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
    // Breadcrumb every send for Sentry forensics — single chokepoint
    // catches all message paths (text/image/video/voice/poll/86).
    // We capture type + a short tag for chat id + whether there was
    // attached media. Body text deliberately omitted (might contain
    // PII, scrubbed by redactor anyway, but skip to be tidy).
    try {
        breadcrumb('chat.send', `${type || 'unknown'}@${chat.id.slice(0, 10)}`, {
            hasMedia: !!mediaUrl,
            hasPoll: !!poll,
            hasReplyTo: !!(replyTo && replyTo.id),
            textLen: typeof text === 'string' ? text.length : 0,
        });
    } catch {}
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
    // 2026-05-28 — Andrew: "when i reply to a message on the chat does
    // the person im replying to get a notification? saying so and so
    // replied to your message." Before this they got the generic
    // chat_message that every member got. Now the replied-to author
    // gets a distinct chat_reply notification with louder copy
    // ("↩ Andrew replied to you") and includes the snippet of THEIR
    // own message so they remember which one was replied to.
    //
    // Mention beats reply: if the replied-to person was ALSO @-tagged
    // in the body, the mention wins (it's explicit intent + already
    // loud). No double-notify.
    //
    // Self-reply (replying to your own message) skips the reply
    // notification entirely — you don't need a push for talking to
    // yourself in a thread.
    const replyToAuthor = (replyTo?.senderName || '').trim();
    const replySnippet = String(replyTo?.snippet || '').slice(0, 80);
    await Promise.all(recipients.map(async (to) => {
        const wasMentioned = mentions.includes(to);
        const isReplyTarget = !wasMentioned
            && replyToAuthor
            && to === replyToAuthor
            && replyToAuthor !== staffName;
        const notifType = wasMentioned
            ? 'chat_mention'
            : isReplyTarget
                ? 'chat_reply'
                : 'chat_message';
        const notifTitle = wasMentioned
            ? `@${staffName} → ${title}`
            : isReplyTarget
                ? (chat.type === 'dm'
                    ? `↩ ${staffName} replied`
                    : `↩ ${staffName} replied in ${chatLabel}`)
                : title;
        // For replies, body shape: "they replied to: '{your message}'"
        // gives the receiver immediate context for which of THEIR
        // messages was the target — useful in long threads where
        // they might have sent dozens of messages today.
        const notifBody = isReplyTarget
            ? (replySnippet
                ? `↩ "${replySnippet}"\n${staffName}: ${preview.slice(0, 80)}`
                : `${staffName}: ${preview.slice(0, 120)}`)
            : body.slice(0, 140);
        try {
            await notifyStaff({
                forStaff: to,
                type: notifType,
                title: notifTitle,
                body: notifBody.slice(0, 200),
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
                    <img src={message.mediaUrl} alt="" loading="lazy" decoding="async" className="w-full max-h-[280px] object-cover rounded-lg mb-3" />
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
                <img src={message.mediaUrl} alt="" loading="lazy" decoding="async" className="w-full max-h-[300px] object-cover" />
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
// previewScheduledList moved to chatThreadHelpers.js (2026-05-23).

// Bottom-sheet listing pending scheduled messages with a cancel button
// per row. Tapping cancel deletes the scheduled_messages doc; the
// realtime subscription on the parent updates the banner instantly.
function ScheduledListDrawer({ items, isEs, onCancel, onClose }) {
    const tx = (en, es) => isEs ? es : en;
    return (
        <ModalPortal>
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
        </ModalPortal>
    );
}

// relativeTime moved to chatThreadHelpers.js (2026-05-23).

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
        <ModalPortal>
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
        </ModalPortal>
    );
}

// groupByDate moved to chatThreadHelpers.js (2026-05-23).

// AttachMenuItem — one row in the floating bubble popup. Andrew
// 2026-05-27: match the Zenzap / iMessage popup style — icon on the
// left, label on the right, full-width tap target, subtle hover.
// Three optional tones:
//   • default — neutral light-on-dark
//   • danger  — red (used for the 86/post-out-of-stock action)
//   • purple  — used for the AI grammar-fix action
// `active` highlights the row when the corresponding feature is
// already toggled (emoji picker). `loading` shows a small spinner in
// place of the icon (grammar-fix is the in-flight case).
// 2026-05-27 — redesigned for the Apple-glass attach menu.
// Each item: icon disc on left (sage/danger/purple-tinted by `tone`),
// label on right with HIG body-md type. Selected state (`active`)
// fills the row with a sage wash. Loading swaps the glyph for a
// small spinner inside the same disc.
function AttachMenuItem({ Icon, label, onClick, disabled, active, loading, tone }) {
    // Icon-disc tint per tone — matches the page-header iconTint
    // palette so the family reads as cohesive across the app.
    const discClasses = tone === 'danger'
        ? 'bg-red-50 text-red-700'
        : tone === 'purple'
        ? 'bg-purple-50 text-purple-700'
        : 'bg-dd-sage-50 text-dd-green-700';
    // Row chrome — active state gets a soft sage wash so the user
    // sees which option is currently engaged (e.g. emoji picker on).
    const rowClasses = active
        ? 'bg-dd-sage-50/70 text-dd-text'
        : 'text-dd-text hover:bg-white/70 active:bg-white/85';
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onClick}
            disabled={disabled}
            className={`w-full flex items-center gap-3 px-2 py-2 rounded-glass-md text-left text-body-md font-medium transition-colors duration-glass-fast ease-glass-out disabled:opacity-40 disabled:cursor-not-allowed ${rowClasses}`}
        >
            <span className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${discClasses}`}>
                {loading
                    ? <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                    : (Icon ? <Icon size={18} strokeWidth={2.25} aria-hidden="true" /> : null)}
            </span>
            <span className="flex-1 truncate">{label}</span>
        </button>
    );
}
