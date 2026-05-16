// ChatAnnouncementComposer — manager-only "broadcast a thing" modal.
//
// Workflow:
//   1. Pick audience (all-team, FOH, BOH, managers, location, custom)
//   2. Write body (text + optional photo)
//   3. Toggle "require ack" + optional deadline
//   4. Post → message lands in target channel(s) as type='announcement'
//
// Acknowledgment lives on the message: ackRequired/ackDeadline.
// Per-user ack records live on the chat subcollection:
//   /chats/{chatId}/acks/{messageId}_{userName} = { userName, ackedAt }
//
// Cross-posting: if "all" is picked but a separate "also send to
// #managers" is checked, we write TWO message docs — one per channel.
// They share an `announcementGroupId` so the dashboard can aggregate.

import { useState, useMemo } from 'react';
import { db, storage } from '../firebase';
import {
    collection, doc, addDoc, getDocs, query, where, serverTimestamp,
    updateDoc,
} from 'firebase/firestore';
import { ref as sref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { recordAudit } from '../data/audit';
import { notifyStaff } from '../data/notify';
import { canPostAnnouncements } from '../data/chatPermissions';
import { channelDocId, AUTO_CHANNELS } from '../data/chat';

export default function ChatAnnouncementComposer({
    language = 'en', staffName, staffList, viewer, isAdmin, isManager,
    onClose, onPosted,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const canPost = canPostAnnouncements(viewer, isAdmin, isManager);

    const [audience, setAudience] = useState('announcements'); // channelKey or 'custom'
    const [customChannels, setCustomChannels] = useState([]); // channelIds (for custom)
    const [body, setBody] = useState('');
    const [photo, setPhoto] = useState(null); // { file, previewUrl }
    const [ackRequired, setAckRequired] = useState(false);
    const [ackDeadlineHours, setAckDeadlineHours] = useState(24);
    const [crosspostManagers, setCrosspostManagers] = useState(false);
    const [busy, setBusy] = useState(false);

    // Audience options based on viewer's role + the standard channels.
    const audienceOptions = useMemo(() => {
        const opts = [
            { value: 'announcements', label: tx('📣 Announcements (everyone, ack-friendly)', '📣 Anuncios (todos)') },
            { value: 'all',           label: tx('🍜 All Team channel', '🍜 Canal de Todo el Equipo') },
            { value: 'foh',           label: tx('🪑 Front of House only', '🪑 Solo Front of House') },
            { value: 'boh',           label: tx('👩‍🍳 Back of House only', '👩‍🍳 Solo Back of House') },
            { value: 'managers',      label: tx('🧑‍💼 Managers only', '🧑‍💼 Solo gerentes') },
            { value: 'webster',       label: tx('🏠 Webster only', '🏠 Solo Webster') },
            { value: 'maryland',      label: tx('🏠 Maryland Hts only', '🏠 Solo Maryland') },
        ];
        return opts;
    }, [isEs]);

    if (!canPost) {
        return (
            <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onClose}>
                <div className="bg-white rounded-xl p-6 max-w-sm" onClick={(e) => e.stopPropagation()}>
                    <p className="text-dd-text mb-3">{tx('Only managers can post announcements.', 'Solo los gerentes pueden publicar anuncios.')}</p>
                    <button onClick={onClose} className="px-4 py-2 bg-dd-bg rounded font-bold text-sm">{tx('Close', 'Cerrar')}</button>
                </div>
            </div>
        );
    }

    function handlePhotoPick(e) {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        const previewUrl = URL.createObjectURL(f);
        setPhoto({ file: f, previewUrl });
    }

    async function uploadPhoto(file, announcementId) {
        const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase();
        const path = `chats/announcements/${announcementId}.${ext}`;
        const ref = sref(storage, path);
        await uploadBytes(ref, file, { contentType: file.type });
        const url = await getDownloadURL(ref);
        return { url, path, mime: file.type };
    }

    async function handlePost() {
        if (!body.trim() && !photo) return;
        if (busy) return;
        setBusy(true);

        try {
            // Resolve target channelIds. `audience` maps to a channelKey.
            const targets = new Set();
            targets.add(channelDocId(audience));
            if (crosspostManagers && audience !== 'managers') {
                targets.add(channelDocId('managers'));
            }

            const announcementGroupId = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const ackDeadline = ackRequired && ackDeadlineHours > 0
                ? new Date(Date.now() + ackDeadlineHours * 3600_000)
                : null;

            // Upload photo once, reuse URL across cross-posts.
            let mediaShape = null;
            if (photo?.file) {
                const m = await uploadPhoto(photo.file, announcementGroupId);
                mediaShape = { mediaUrl: m.url, mediaPath: m.path, mediaType: m.mime };
            }

            const recipientsAll = new Set();
            for (const chatId of targets) {
                // Look up the channel doc to fan-out notifications.
                const chQ = query(collection(db, 'chats'), where('__name__', '==', chatId));
                const chSnap = await getDocs(chQ);
                const chDoc = chSnap.docs[0];
                if (!chDoc) {
                    console.warn(`announcement: channel ${chatId} not found, skipping`);
                    continue;
                }
                const chData = chDoc.data();
                const members = Array.isArray(chData.members) ? chData.members : [];

                // Append the message doc.
                const msgRef = await addDoc(collection(db, 'chats', chatId, 'messages'), {
                    senderName: staffName,
                    senderId: viewer?.id || null,
                    senderRole: viewer?.role || null,
                    type: 'announcement',
                    text: body.trim(),
                    ...(mediaShape || {}),
                    ackRequired: !!ackRequired,
                    ackDeadline: ackDeadline ? ackDeadline.toISOString() : null,
                    announcementGroupId,
                    audienceLabel: audienceOptions.find(o => o.value === audience)?.label || audience,
                    reactions: {},
                    mentions: [],
                    createdAt: serverTimestamp(),
                });
                // Bump chat preview.
                await updateDoc(doc(db, 'chats', chatId), {
                    lastMessage: {
                        text: '📣 ' + (body.trim().slice(0, 100) || 'Announcement'),
                        sender: staffName,
                        ts: serverTimestamp(),
                        type: 'announcement',
                    },
                    lastActivityAt: serverTimestamp(),
                    [`lastReadByName.${staffName}`]: serverTimestamp(),
                });
                // Fan-out per recipient.
                for (const recipient of members) {
                    if (recipient === staffName) continue;
                    recipientsAll.add(recipient);
                    notifyStaff({
                        forStaff: recipient,
                        type: 'announcement',
                        title: '📣 ' + tx('New announcement', 'Nuevo anuncio'),
                        body: body.trim().slice(0, 140),
                        deepLink: 'chat',
                        link: '/chat',
                        tag: `announcement:${announcementGroupId}:${recipient}`,
                        createdBy: staffName,
                    }).catch(() => {});
                }

                recordAudit({
                    action: 'chat.announcement.send',
                    actorName: staffName,
                    actorId: viewer?.id,
                    actorRole: viewer?.role,
                    targetType: 'chat',
                    targetId: chatId,
                    details: {
                        messageId: msgRef.id,
                        ackRequired,
                        ackDeadline: ackDeadline?.toISOString() || null,
                        audience,
                        announcementGroupId,
                        memberCount: members.length,
                    },
                });
            }

            onPosted?.({ announcementGroupId, recipientCount: recipientsAll.size });
        } catch (e) {
            console.error('announcement post failed:', e);
            alert(tx('Send failed: ', 'Error al enviar: ') + (e.message || e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div
                className="bg-white w-full md:max-w-lg md:rounded-2xl rounded-t-2xl flex flex-col max-h-[92vh] shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-black text-dd-text">📣 {tx('New Announcement', 'Nuevo Anuncio')}</h2>
                        <p className="text-[11px] text-dd-text-2">{tx('Broadcast to your team', 'Difunde a tu equipo')}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Audience */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Audience', 'Audiencia')}
                        </label>
                        <select
                            value={audience}
                            onChange={(e) => setAudience(e.target.value)}
                            className="w-full px-3 py-2.5 rounded-lg border border-dd-line bg-white text-sm font-bold text-dd-text focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                        >
                            {audienceOptions.map(o => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                        </select>
                        {audience !== 'managers' && (
                            <label className="mt-2 flex items-center gap-2 text-xs text-dd-text-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={crosspostManagers}
                                    onChange={(e) => setCrosspostManagers(e.target.checked)}
                                    className="w-4 h-4"
                                />
                                {tx('Also cross-post to #managers', 'También cruz-publicar en #managers')}
                            </label>
                        )}
                    </div>

                    {/* Body */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Message', 'Mensaje')}
                        </label>
                        <textarea
                            rows={5}
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            placeholder={tx('Write the announcement…', 'Escribe el anuncio…')}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                            maxLength={2000}
                        />
                        <div className="text-[10px] text-dd-text-2 text-right">{body.length}/2000</div>
                    </div>

                    {/* Photo */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Photo (optional)', 'Foto (opcional)')}
                        </label>
                        {photo ? (
                            <div className="relative rounded-lg overflow-hidden border border-dd-line">
                                <img src={photo.previewUrl} alt="" className="w-full max-h-[200px] object-cover" />
                                <button
                                    onClick={() => { URL.revokeObjectURL(photo.previewUrl); setPhoto(null); }}
                                    className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 text-white text-sm flex items-center justify-center"
                                >
                                    ✕
                                </button>
                            </div>
                        ) : (
                            <label className="block w-full px-3 py-3 rounded-lg border-2 border-dashed border-dd-line text-center text-sm text-dd-text-2 cursor-pointer hover:border-dd-green hover:bg-dd-sage-50">
                                📷 {tx('Tap to add a photo', 'Tap para agregar foto')}
                                <input type="file" accept="image/*" onChange={handlePhotoPick} className="hidden" />
                            </label>
                        )}
                    </div>

                    {/* Require ack */}
                    <div className="p-3 rounded-lg bg-amber-50/60 border border-amber-200">
                        <label className="flex items-center gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={ackRequired}
                                onChange={(e) => setAckRequired(e.target.checked)}
                                className="w-5 h-5"
                            />
                            <div className="flex-1">
                                <div className="text-sm font-black text-dd-text">
                                    ✅ {tx('Require acknowledgment', 'Requerir acuse de recibo')}
                                </div>
                                <div className="text-[11px] text-dd-text-2 mt-0.5">
                                    {tx('Staff must tap "Mark as read". Read-rate dashboard becomes available.',
                                        'El personal debe tocar "Marcar leído". Se habilita el panel de seguimiento.')}
                                </div>
                            </div>
                        </label>
                        {ackRequired && (
                            <div className="mt-3 pl-8">
                                <label className="block text-[11px] font-bold text-dd-text-2 mb-1">
                                    {tx('Deadline', 'Fecha límite')}
                                </label>
                                <select
                                    value={ackDeadlineHours}
                                    onChange={(e) => setAckDeadlineHours(parseInt(e.target.value))}
                                    className="px-2 py-1.5 rounded border border-dd-line bg-white text-sm"
                                >
                                    <option value={0}>{tx('No deadline', 'Sin límite')}</option>
                                    <option value={4}>{tx('4 hours', '4 horas')}</option>
                                    <option value={24}>{tx('24 hours', '24 horas')}</option>
                                    <option value={72}>{tx('3 days', '3 días')}</option>
                                    <option value={168}>{tx('1 week', '1 semana')}</option>
                                </select>
                            </div>
                        )}
                    </div>
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex items-center justify-between gap-3 shrink-0">
                    <button onClick={onClose} className="px-3 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={handlePost}
                        disabled={busy || (!body.trim() && !photo)}
                        className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-dd-green-700"
                    >
                        {busy ? tx('Posting…', 'Publicando…') : tx('📣 Post Announcement', '📣 Publicar Anuncio')}
                    </button>
                </div>
            </div>
        </div>
    );
}
