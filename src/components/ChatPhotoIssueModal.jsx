// ChatPhotoIssueModal — restaurant-specific issue reporter.
//
// "Take photo → pick category → pick urgency → post." Posts a
// `photo_issue` message into #managers (so it never falls off the
// radar) PLUS auto-creates a ticket in /maintenance_tickets so the
// existing MaintenanceRequest dashboard tracks it. The chat card
// renders inline progress (open → in-progress → resolved) by mirroring
// the ticket status.
//
// Why post into #managers always: a broken ice machine reported in
// #foh-webster might never be seen by the maintenance manager who
// works BOH. Cross-posting to #managers + the staff's location channel
// guarantees visibility while keeping the original poster's
// conversational context.

import { useState, useMemo, useRef } from 'react';
import { db, storage } from '../firebase';
import {
    collection, doc, addDoc, updateDoc, serverTimestamp,
} from 'firebase/firestore';
import { ref as sref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { recordAudit } from '../data/audit';
import { notifyStaff } from '../data/notify';
import { channelDocId, ISSUE_CATEGORIES, ISSUE_URGENCIES } from '../data/chat';

export default function ChatPhotoIssueModal({
    language = 'en', staffName, staffList, viewer, storeLocation,
    onClose, onPosted,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const [photo, setPhoto] = useState(null);
    const [category, setCategory] = useState('equipment');
    const [urgency, setUrgency] = useState('medium');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const fileRef = useRef(null);

    const catDef = useMemo(() => ISSUE_CATEGORIES.find(c => c.key === category), [category]);
    const urgDef = useMemo(() => ISSUE_URGENCIES.find(u => u.key === urgency), [urgency]);

    function handlePhotoPick(e) {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        setPhoto({ file: f, previewUrl: URL.createObjectURL(f) });
    }

    async function uploadPhoto(file, ticketId) {
        const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase();
        const path = `chats/issues/${ticketId}.${ext}`;
        const ref = sref(storage, path);
        await uploadBytes(ref, file, { contentType: file.type });
        const url = await getDownloadURL(ref);
        return { url, path, mime: file.type };
    }

    async function handlePost() {
        if (!photo) return;
        if (busy) return;
        setBusy(true);
        try {
            // 1. Create ticket doc first so we have an ID for the photo path
            //    and a stable cross-reference.
            const ticketRef = await addDoc(collection(db, 'maintenance_tickets'), {
                title: `${catDef.en} — ${urgDef.en}`,
                category,
                urgency,
                note: note.trim(),
                status: 'open',          // open → in_progress → resolved
                location: storeLocation === 'both' ? 'webster' : storeLocation,
                reportedBy: staffName,
                reportedById: viewer?.id || null,
                createdAt: serverTimestamp(),
            });
            const ticketId = ticketRef.id;

            // 2. Upload photo with the stable id.
            const media = await uploadPhoto(photo.file, ticketId);

            // 3. Patch ticket with photo URL.
            await updateDoc(doc(db, 'maintenance_tickets', ticketId), {
                photoUrl: media.url,
                photoPath: media.path,
            });

            // 4. Post into #managers + #{location}.
            const locKey = storeLocation === 'both' ? 'webster' : storeLocation;
            const targets = ['managers', locKey];
            const text = `${catDef.emoji} ${catDef[isEs ? 'es' : 'en']} — ${urgDef[isEs ? 'es' : 'en']}${note.trim() ? `: ${note.trim()}` : ''}`;

            for (const channelKey of targets) {
                const chatId = channelDocId(channelKey);
                await addDoc(collection(db, 'chats', chatId, 'messages'), {
                    senderName: staffName,
                    senderId: viewer?.id || null,
                    type: 'photo_issue',
                    text,
                    mediaUrl: media.url,
                    mediaPath: media.path,
                    mediaType: media.mime,
                    issueData: {
                        ticketId,
                        category,
                        urgency,
                        status: 'open',
                        location: locKey,
                        note: note.trim(),
                    },
                    reactions: {},
                    mentions: [],
                    createdAt: serverTimestamp(),
                });
                await updateDoc(doc(db, 'chats', chatId), {
                    lastMessage: {
                        text: `${catDef.emoji} ${tx('Issue reported', 'Problema reportado')}`,
                        sender: staffName,
                        ts: serverTimestamp(),
                        type: 'photo_issue',
                    },
                    lastActivityAt: serverTimestamp(),
                });
            }

            // 5. Notify managers (FCM). Emergency = pierces quiet hours.
            const managers = (staffList || [])
                .filter(s => s.id === 40 || s.id === 41 || /manager|owner/i.test(s.role || ''))
                .filter(s => s.name !== staffName)
                .map(s => s.name);

            const escalate = catDef.escalates || urgency === 'emergency' || urgency === 'high';
            for (const m of managers) {
                notifyStaff({
                    forStaff: m,
                    type: 'photo_issue',
                    title: `${catDef.emoji} ${urgDef.en === 'Emergency' ? '🚨 ' : ''}${tx('Issue reported', 'Problema reportado')}`,
                    body: `${staffName}: ${catDef.en}${note.trim() ? ` — ${note.trim().slice(0, 80)}` : ''}`,
                    deepLink: 'chat',
                    link: '/chat',
                    tag: `issue:${ticketId}:${m}`,
                    createdBy: staffName,
                }).catch(() => {});
            }

            recordAudit({
                action: 'chat.issue.report',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'ticket',
                targetId: ticketId,
                details: { category, urgency, location: locKey, escalated: escalate },
            });

            onPosted?.({ ticketId });
        } catch (e) {
            console.error('issue report failed:', e);
            alert(tx('Report failed', 'Error al reportar'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl flex flex-col max-h-[92vh] shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-black text-dd-text">📸 {tx('Report Issue', 'Reportar Problema')}</h2>
                        <p className="text-[11px] text-dd-text-2">{tx('Snap a photo, pick urgency, post', 'Foto, urgencia, publicar')}</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Photo (required) */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Photo', 'Foto')} <span className="text-red-600">*</span>
                        </label>
                        {photo ? (
                            <div className="relative rounded-lg overflow-hidden border border-dd-line">
                                <img src={photo.previewUrl} alt="" className="w-full max-h-[260px] object-cover" />
                                <button
                                    onClick={() => { URL.revokeObjectURL(photo.previewUrl); setPhoto(null); }}
                                    className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 text-white text-sm flex items-center justify-center"
                                >
                                    ✕
                                </button>
                            </div>
                        ) : (
                            <label className="block w-full px-4 py-8 rounded-lg border-2 border-dashed border-dd-line text-center cursor-pointer hover:border-dd-green hover:bg-dd-sage-50">
                                <div className="text-3xl mb-1">📷</div>
                                <div className="text-sm font-bold text-dd-text">{tx('Take photo', 'Tomar foto')}</div>
                                <div className="text-[11px] text-dd-text-2 mt-1">{tx('or pick from library', 'o elegir de la galería')}</div>
                                <input
                                    ref={fileRef}
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    onChange={handlePhotoPick}
                                    className="hidden"
                                />
                            </label>
                        )}
                    </div>

                    {/* Category */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Category', 'Categoría')}
                        </label>
                        <div className="grid grid-cols-3 gap-1.5">
                            {ISSUE_CATEGORIES.map(c => (
                                <button
                                    key={c.key}
                                    onClick={() => setCategory(c.key)}
                                    className={`p-2 rounded-lg border-2 text-center transition ${category === c.key ? 'border-dd-green bg-dd-sage-50' : 'border-dd-line hover:bg-dd-bg'}`}
                                >
                                    <div className="text-xl">{c.emoji}</div>
                                    <div className="text-[10.5px] font-bold text-dd-text mt-1 leading-tight">
                                        {isEs ? c.es : c.en}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Urgency */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Urgency', 'Urgencia')}
                        </label>
                        <div className="grid grid-cols-4 gap-1.5">
                            {ISSUE_URGENCIES.map(u => (
                                <button
                                    key={u.key}
                                    onClick={() => setUrgency(u.key)}
                                    className={`p-2 rounded-lg border-2 text-xs font-bold transition ${urgency === u.key ? 'border-dd-green ' + u.color : 'border-dd-line text-dd-text-2 hover:bg-dd-bg'}`}
                                >
                                    {isEs ? u.es : u.en}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Note */}
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Note (optional)', 'Nota (opcional)')}
                        </label>
                        <textarea
                            rows={2}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder={tx('e.g. ice machine making grinding noise', 'p.ej. máquina de hielo hace ruido raro')}
                            maxLength={300}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                        />
                    </div>

                    {/* Routing hint */}
                    <div className="px-3 py-2 rounded-lg bg-dd-bg text-[11px] text-dd-text-2">
                        {tx('Posts to', 'Publicado en')}: <b>#managers</b> + <b>#{(storeLocation === 'both' ? 'webster' : storeLocation)}</b>
                        {(catDef?.escalates || urgency === 'emergency' || urgency === 'high') &&
                            <span className="block mt-1 text-amber-700 font-bold">⚡ {tx('Will alert all managers immediately', 'Alertará a todos los gerentes inmediatamente')}</span>}
                    </div>
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex items-center justify-between gap-3 shrink-0">
                    <button onClick={onClose} className="px-3 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={handlePost}
                        disabled={busy || !photo}
                        className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-dd-green-700"
                    >
                        {busy ? tx('Reporting…', 'Reportando…') : tx('📤 Report Issue', '📤 Reportar')}
                    </button>
                </div>
            </div>
        </div>
    );
}
