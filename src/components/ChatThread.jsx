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

import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { db, storage } from '../firebase';
import {
    collection, doc, query, orderBy, limit, onSnapshot,
    addDoc, setDoc, updateDoc, serverTimestamp, where, getCountFromServer,
} from 'firebase/firestore';
import { ref as sref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { ChatAvatar, chatDisplayName } from './ChatCenter';
import { parseMentions, QUICK_REACTIONS, canEditChat, ISSUE_URGENCIES, ISSUE_CATEGORIES } from '../data/chat';
import { canPostAnnouncements, canPinMessages, canConvertToTask, canDeleteAnyMessage, canDeleteOwnMessage, canClaimCoverage, canApproveCoverage } from '../data/chatPermissions';
import { notifyStaff } from '../data/notify';
import { recordAudit } from '../data/audit';
import { claimCoverage, approveCoverage, denyCoverage, withdrawCoverage } from '../data/coverage';

// Lazy-load the heavier modals — keeps the chat-thread chunk small for
// the common case where the user just scrolls + types.
const ChatAckDashboard = lazy(() => import('./ChatAckDashboard'));
const ChatPinsDrawer = lazy(() => import('./ChatPinsDrawer'));
const ChatTaskFromMessageModal = lazy(() => import('./ChatTaskFromMessageModal'));

const TYPING_TTL_MS = 5000;          // typing heartbeat valid for 5s
const MAX_IMAGE_DIM = 1600;          // resize images larger than this
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;  // 50MB cap on video uploads

export default function ChatThread({
    chat, language, staffName, staffList, isAdmin, isManager,
    viewer, viewerTier, onBack, onOpenSettings,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const canEdit = canEditChat(chat, viewer, isAdmin);

    // ── Subscribe to messages ─────────────────────────────────────
    const [messages, setMessages] = useState([]);
    useEffect(() => {
        if (!chat?.id) return;
        const q = query(
            collection(db, 'chats', chat.id, 'messages'),
            orderBy('createdAt', 'asc'),
            limit(200)
        );
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setMessages(list);
        }, (err) => console.warn('messages snapshot failed:', err));
        return () => unsub();
    }, [chat?.id]);

    // ── Mark read on view + on each new message ────────────────────
    // We write a single lastReadByName.{name} timestamp on the chat doc.
    // Dot-notation update preserves other members' read markers.
    useEffect(() => {
        if (!chat?.id || !staffName) return;
        const ref = doc(db, 'chats', chat.id);
        updateDoc(ref, { [`lastReadByName.${staffName}`]: serverTimestamp() })
            .catch(e => console.warn('markRead failed:', e));
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

    // ── Send a text message ───────────────────────────────────────
    async function handleSendText() {
        const body = draft.trim();
        if (!body || sending) return;
        setSending(true);
        try {
            await sendMessage({
                chat, staffName, viewer, staffList,
                type: 'text',
                text: body,
            });
            setDraft('');
        } catch (e) {
            console.warn('send text failed:', e);
            alert(tx('Send failed', 'Error al enviar'));
        } finally {
            setSending(false);
        }
    }

    // ── Send media (photo / video) ────────────────────────────────
    async function handleMediaPick(e, kind) {
        const file = e.target.files?.[0];
        e.target.value = ''; // reset so re-picking same file fires change
        if (!file) return;
        if (kind === 'video' && file.size > MAX_VIDEO_BYTES) {
            alert(tx('Video too large (50MB max).', 'Video muy grande (50MB máx).'));
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
            });
            setDraft('');
        } catch (err) {
            console.warn(`${kind} send failed:`, err);
            alert(tx('Upload failed', 'Error al subir'));
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
            setRecording(true);
        } catch (e) {
            console.warn('mic access failed:', e);
            alert(tx('Mic access denied', 'Acceso al micrófono denegado'));
        }
    }
    function stopRecording(cancel = false) {
        const rec = recorderRef.current;
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
            alert(tx('Voice send failed', 'Error al enviar voz'));
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
            alert(tx('Up to 5 messages can be pinned. Unpin one first.',
                     'Hasta 5 mensajes pueden estar fijados. Quita uno primero.'));
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

    // ── Coverage-request actions (called by CoverageCard) ────────
    async function handleClaimCoverage(message) {
        try {
            await claimCoverage({
                chatId: chat.id, messageId: message.id,
                claimerName: staffName, claimerId: viewer?.id,
            });
        } catch (e) {
            const msg = String(e.message || e);
            if (msg === 'coverage_not_open') alert(tx('Already claimed.', 'Ya reclamado.'));
            else alert(tx('Claim failed.', 'Error al reclamar.'));
        }
    }
    async function handleApproveCoverage(message) {
        try {
            await approveCoverage({
                chatId: chat.id, messageId: message.id,
                managerName: staffName, managerId: viewer?.id,
            });
        } catch (e) {
            alert(tx('Approve failed.', 'Error al aprobar.'));
        }
    }
    async function handleDenyCoverage(message) {
        try {
            await denyCoverage({
                chatId: chat.id, messageId: message.id,
                managerName: staffName, managerId: viewer?.id,
            });
        } catch (e) {
            alert(tx('Deny failed.', 'Error al negar.'));
        }
    }
    async function handleWithdrawCoverage(message) {
        try {
            await withdrawCoverage({
                chatId: chat.id, messageId: message.id,
                requesterName: staffName, requesterId: viewer?.id,
            });
        } catch (e) {
            alert(tx('Withdraw failed.', 'Error al retirar.'));
        }
    }

    // ── Reaction toggle ──────────────────────────────────────────
    async function handleReact(message, emoji) {
        const ref = doc(db, 'chats', chat.id, 'messages', message.id);
        const reactions = { ...(message.reactions || {}) };
        const cur = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
        const hasIt = cur.includes(staffName);
        const next = hasIt ? cur.filter(n => n !== staffName) : [...cur, staffName];
        if (next.length === 0) delete reactions[emoji];
        else reactions[emoji] = next;
        try {
            await updateDoc(ref, { reactions });
        } catch (e) {
            console.warn('react failed:', e);
        }
    }

    // Group messages by date for date separators ("Today", "Yesterday", date)
    const grouped = useMemo(() => groupByDate(messages, isEs), [messages, isEs]);

    return (
        <div className="flex flex-col h-full bg-dd-bg">
            {/* ── Header ──────────────────────────────────────── */}
            <header className="px-3 py-2.5 border-b border-dd-line bg-white flex items-center gap-3 shrink-0">
                <button
                    onClick={onBack}
                    className="md:hidden w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center text-dd-text text-xl"
                    aria-label={tx('Back', 'Atrás')}
                >
                    ←
                </button>
                <ChatAvatar chat={chat} viewerName={staffName} size={36} />
                <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-black text-dd-text truncate">
                        {chatDisplayName(chat, staffName)}
                    </div>
                    <div className="text-[11px] text-dd-text-2 truncate">
                        {chat.type === 'dm'
                            ? (typingNames.length > 0 ? tx('typing…', 'escribiendo…') : tx('Direct message', 'Mensaje directo'))
                            : (typingNames.length > 0
                                ? `${typingNames[0]} ${tx('is typing…', 'está escribiendo…')}`
                                : `${(chat.members || []).length} ${tx('members', 'miembros')}`)}
                    </div>
                </div>
                {/* Settings gear — always visible. For DMs/channels and
                    for non-editors it's a view + delete affordance. The
                    modal hides edit fields when canEdit is false but
                    keeps the Delete option for admins / DM participants
                    / group creators. (2026-05-16 — needed so admins can
                    delete DMs and channels.) */}
                <button
                    onClick={onOpenSettings}
                    className="w-9 h-9 rounded-full hover:bg-dd-bg flex items-center justify-center text-lg"
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
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto px-3 py-2 space-y-1"
            >
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
                                    onReact={(emoji) => handleReact(msg, emoji)}
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

            {/* ── Composer ────────────────────────────────────── */}
            <Composer
                isEs={isEs}
                draft={draft}
                setDraft={(v) => { setDraft(v); if (v) maybeSendTyping(); }}
                sending={sending}
                recording={recording}
                onSendText={handleSendText}
                onPickImage={(e) => handleMediaPick(e, 'image')}
                onPickVideo={(e) => handleMediaPick(e, 'video')}
                onStartRecording={startRecording}
                onStopRecording={() => stopRecording(false)}
                onCancelRecording={() => stopRecording(true)}
                recordStartMs={recordStartRef.current}
            />
        </div>
    );
}

// ── MessageBubble ───────────────────────────────────────────────
function MessageBubble({
    message, chat, isMine, showSender, showAvatar, isEs, staffName,
    viewer, isAdmin, isManager, myAcks, highlighted,
    onReact, onAck, onOpenAckDashboard, onTogglePin, onMakeTask, onDelete, onCopy,
    onClaimCoverage, onApproveCoverage, onDenyCoverage, onWithdrawCoverage,
}) {
    const [showActions, setShowActions] = useState(false);  // long-press menu
    const reactionEntries = Object.entries(message.reactions || {})
        .filter(([, names]) => Array.isArray(names) && names.length > 0);
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
                    isMine={isMine}
                    isEs={isEs}
                    staffName={staffName}
                    viewer={viewer}
                    isAdmin={isAdmin}
                    isManager={isManager}
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
                        onReact={onReact} onTogglePin={onTogglePin}
                        onMakeTask={onMakeTask} onDelete={onDelete} onCopy={onCopy}
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
                    isMine={isMine}
                    isEs={isEs}
                    staffName={staffName}
                    viewer={viewer}
                    isAdmin={isAdmin}
                    isManager={isManager}
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
                        onReact={onReact} onTogglePin={onTogglePin}
                        onMakeTask={onMakeTask} onDelete={onDelete} onCopy={onCopy}
                    />
                )}
            </div>
        );
    }
    if (message.type === 'eighty_six_alert') {
        return (
            <div id={`msg-${message.id}`} className={`relative my-2 transition ${highlighted ? 'ring-2 ring-amber-400 rounded-2xl' : ''}`}>
                <EightySixCard message={message} isEs={isEs} />
            </div>
        );
    }
    if (message.type === 'photo_issue') {
        return (
            <div id={`msg-${message.id}`} className={`relative my-2 transition ${highlighted ? 'ring-2 ring-amber-400 rounded-2xl' : ''}`}>
                <PhotoIssueCard
                    message={message}
                    isEs={isEs}
                    isManager={isManager}
                    staffName={staffName}
                    viewer={viewer}
                    onLongPress={() => setShowActions(true)}
                />
                {showActions && (
                    <MessageActionMenu
                        message={message} chat={chat} isMine={isMine} viewer={viewer}
                        isAdmin={isAdmin} isManager={isManager} isEs={isEs}
                        onClose={() => setShowActions(false)}
                        onReact={onReact} onTogglePin={onTogglePin}
                        onMakeTask={onMakeTask} onDelete={onDelete} onCopy={onCopy}
                    />
                )}
            </div>
        );
    }
    if (message.type === 'task_handoff') {
        return (
            <div id={`msg-${message.id}`} className={`relative my-2 transition ${highlighted ? 'ring-2 ring-amber-400 rounded-2xl' : ''}`}>
                <TaskHandoffCard message={message} isEs={isEs} />
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
                        {message.senderName}
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
                            <span className={`whitespace-pre-wrap text-[14.5px] leading-snug ${message.type !== 'text' ? 'block mt-1' : ''}`}>
                                {renderWithMentions(message.text || '', isMine)}
                            </span>
                        )}
                        <div className={`text-[10px] mt-1 text-right ${isMine ? 'text-white/70' : 'text-dd-text-2'}`}>
                            {time}
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
                </div>
            </div>
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
            <audio ref={audioRef} src={src} preload="metadata" />
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

// Render text body with @mentions highlighted. Cheap regex split.
function renderWithMentions(text, isMine) {
    if (!text) return null;
    const parts = text.split(/(@"[^"]+"|@[A-Za-z][A-Za-z'\-]*)/g);
    return parts.map((p, i) => {
        if (!p) return null;
        if (p.startsWith('@')) {
            const cleaned = p.replace(/^@"?/, '').replace(/"$/, '');
            return (
                <span
                    key={i}
                    className={`font-bold ${isMine ? 'underline decoration-white/40' : 'text-dd-green'}`}
                >
                    @{cleaned}
                </span>
            );
        }
        return <span key={i}>{p}</span>;
    });
}

// ── Composer ─────────────────────────────────────────────────────
function Composer({
    isEs, draft, setDraft, sending, recording,
    onSendText, onPickImage, onPickVideo,
    onStartRecording, onStopRecording, onCancelRecording,
    recordStartMs,
}) {
    const imageInputRef = useRef(null);
    const videoInputRef = useRef(null);
    const [elapsed, setElapsed] = useState(0);
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
                {/* Text input */}
                <textarea
                    rows={1}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={isEs ? 'Mensaje…' : 'Message…'}
                    disabled={sending}
                    className="flex-1 min-w-0 px-3 py-2 rounded-2xl bg-dd-bg border border-dd-line text-[14.5px] text-dd-text resize-none focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green max-h-[120px]"
                    style={{ lineHeight: 1.4 }}
                />
                {/* Voice OR Send */}
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
                    <button
                        onClick={onSendText}
                        disabled={sending}
                        className="w-10 h-10 rounded-full bg-dd-green text-white flex items-center justify-center font-black shrink-0 disabled:opacity-40 hover:bg-dd-green-700 active:scale-95 transition"
                        aria-label={isEs ? 'Enviar' : 'Send'}
                    >
                        ➤
                    </button>
                )}
            </div>
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
}) {
    if (!chat?.id) return;
    const { mentions } = parseMentions(text, staffList);
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
                // (TODO: also pass chatId so the drawer scrolls
                // directly to that thread.)
                deepLink: 'chat',
                link: '/chat',
                tag: `chat:${chat.id}:${to}`,
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
    message, isMine, isEs, staffName, viewer, isAdmin, isManager,
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
            <div className="px-4 py-2.5 bg-amber-200/60 border-b border-amber-300 flex items-center gap-2">
                <span className="text-base">📣</span>
                <span className="text-[11px] font-black uppercase tracking-widest text-amber-900 flex-1">
                    {tx('Announcement', 'Anuncio')}
                </span>
                <span className="text-[11px] font-bold text-amber-800">
                    {message.senderName}
                </span>
            </div>
            <div className="px-4 py-3">
                {message.mediaUrl && (
                    <img src={message.mediaUrl} alt="" className="w-full max-h-[280px] object-cover rounded-lg mb-3" />
                )}
                <p className="text-[15px] text-dd-text whitespace-pre-wrap leading-snug">
                    {message.text}
                </p>
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
    message, isMine, isEs, staffName, viewer, isAdmin, isManager,
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
                    {message.senderName} — {shift.date && new Date(shift.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
                </div>
                <div className="text-xs text-dd-text-2 mt-0.5">
                    {shift.startTime}–{shift.endTime} · {(shift.side || '').toUpperCase()} · {shift.location === 'maryland' ? 'Maryland' : shift.location === 'webster' ? 'Webster' : shift.location}
                </div>
                {message.text && (
                    <p className="mt-2 text-sm text-dd-text-2 italic">"{message.text}"</p>
                )}
                {message.claimedBy && (
                    <div className="mt-2 text-xs text-blue-700 font-bold">
                        ✋ {tx('Claimed by', 'Reclamado por')} <b>{message.claimedBy}</b>
                    </div>
                )}
                {message.approvedBy && (
                    <div className="mt-1 text-xs text-dd-green-700 font-bold">
                        ✓ {tx('Approved by', 'Aprobado por')} <b>{message.approvedBy}</b>
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

function EightySixCard({ message, isEs }) {
    const tx = (en, es) => isEs ? es : en;
    const data = message.eightySixData || {};
    const isOut = data.transition === 'out';
    return (
        <div className={`rounded-xl overflow-hidden border-2 ${isOut ? 'border-red-300 bg-red-50' : 'border-dd-green/40 bg-dd-sage-50'} shadow-card`}>
            <div className={`px-4 py-2 flex items-center gap-2 border-b ${isOut ? 'bg-red-200 border-red-300' : 'bg-dd-green/15 border-dd-green/40'}`}>
                <span className="text-base">{isOut ? '🚫' : '✅'}</span>
                <span className={`text-[11px] font-black uppercase tracking-widest flex-1 ${isOut ? 'text-red-900' : 'text-dd-green-700'}`}>
                    {isOut ? tx('86 Alert', 'Alerta 86') : tx('Back in Stock', 'En existencia')}
                </span>
            </div>
            <div className="px-4 py-3">
                <div className="text-base font-black text-dd-text">{data.itemName}</div>
                <div className="text-xs text-dd-text-2 mt-0.5">
                    {data.location === 'maryland' ? 'Maryland Heights' : 'Webster'}
                    {data.attributedTo && (
                        <span> · {tx('last by', 'último por')} {data.attributedTo}</span>
                    )}
                </div>
                {isOut && (
                    <p className="mt-2 text-xs text-red-700 font-bold">
                        {tx('Stop ringing it up — let guests know.', 'Dejen de cobrarlo — avisen a los huéspedes.')}
                    </p>
                )}
            </div>
        </div>
    );
}

function PhotoIssueCard({ message, isEs, isManager, staffName, viewer, onLongPress }) {
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
                    {message.senderName} · {data.location === 'maryland' ? 'Maryland' : 'Webster'}
                </div>
                {data.note && <p className="text-sm text-dd-text mt-1">{data.note}</p>}
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

function TaskHandoffCard({ message, isEs }) {
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
                <p className="text-sm text-dd-text">{message.text}</p>
            </div>
        </div>
    );
}

// Long-press / right-click menu. Shows quick-reactions on top + a list
// of message actions: pin, copy, make task, delete.
function MessageActionMenu({
    message, chat, isMine, viewer, isAdmin, isManager, isEs,
    onClose, onReact, onTogglePin, onMakeTask, onDelete, onCopy,
}) {
    const tx = (en, es) => isEs ? es : en;
    const pinnable = canPinMessages(chat, viewer, isAdmin, isManager);
    const taskable = canConvertToTask(viewer, isAdmin, isManager);
    const canOwn = canDeleteOwnMessage(message, viewer);
    const canAny = canDeleteAnyMessage(chat, viewer, isAdmin, isManager);
    const deletable = canOwn || canAny;
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
