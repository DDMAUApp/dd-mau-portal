// Announcements v2 (Andrew 2026-07-26): "not in chat — announcements pop up
// when the app is opened by staff that is part of the announcement. I will
// also have a copy in the chat."
//
// Design:
//   • /announcements/{id} is the source of truth and drives the pop-up
//     (AnnouncementPopup.jsx, mounted in AppShellV2 — shows on app open /
//     unlock to every staff member the audience matches, until they tap
//     "Got it", which stamps acks.{name}).
//   • A COPY is appended to the revived 📣 Announcements channel
//     (channel_announcements) so there's a browsable record in Chat. The
//     channel's members are refreshed to the FULL staff list on every post
//     (the May purge emptied it; new hires join automatically this way).
//   • Push fan-out to the audience so closed-app staff still get pinged;
//     the pop-up greets them when they open up.
//
// Doc shape: { text, title?, audience ('all'|'foh'|'boh'|'managers'|
//   'webster'|'maryland'|'custom'), audienceCustom? (names, when audience
//   === 'custom' — Andrew 2026-07-26: "pick certain staff not just
//   groups"), includeManagers, mediaUrl?, mediaPath?,
//   translations?, sourceLang?, ackRequired, ackDeadline?, createdBy,
//   createdAt, active, acks: { [staffName]: ISO } }
import { db } from '../firebase';
import {
    doc, getDoc, setDoc, addDoc, updateDoc, collection, query, orderBy,
    limit, onSnapshot, serverTimestamp, FieldPath,
} from 'firebase/firestore';
import { channelDocId } from './chat';
import { isAdminId, isManagerRoleTitle } from './staff';
import { notifyStaff } from './notify';
import { recordAudit } from './audit';

const isMgr = (s) => !!s && (isAdminId(s.id) || isManagerRoleTitle(s.role) ||
    (s.role || '').trim().toLowerCase() === 'owner');

// Does this announcement apply to this staff member? Unset side/location
// on a staff record errs toward SHOWING (missing an announcement is worse
// than seeing one extra).
export function audienceMatches(a, staff) {
    if (!staff?.name) return false;
    if (a?.includeManagers && isMgr(staff)) return true;
    switch (a?.audience || 'all') {
        case 'all': return true;
        case 'managers': return isMgr(staff);
        // Hand-picked staff — exact name match only (names are the app's
        // join key). No err-toward-showing here: the poster chose the
        // exact list, so nobody outside it should get the pop-up.
        case 'custom': return Array.isArray(a?.audienceCustom) && a.audienceCustom.includes(staff.name);
        case 'foh':
        case 'boh': {
            const side = staff.scheduleSide;
            if (!side || side === 'both') return true;
            return side === a.audience;
        }
        case 'webster':
        case 'maryland': {
            const loc = staff.location;
            if (!loc || loc === 'both') return true;
            return loc === a.audience;
        }
        default: return true;
    }
}

// Compute the concrete recipient names for the push fan-out.
export function audienceRecipients(a, staffList) {
    return (staffList || [])
        .filter(s => s?.name && s.active !== false && audienceMatches(a, s))
        .map(s => s.name);
}

// Ensure the 📣 Announcements channel exists with EVERY current staff
// member — resurrects the purged doc and keeps membership fresh.
export async function ensureAnnouncementsChannel(staffList, byName) {
    const id = channelDocId('announcements');
    const ref = doc(db, 'chats', id);
    const members = (staffList || []).filter(s => s?.name && s.active !== false).map(s => s.name);
    if (members.length === 0) throw new Error('no staff to announce to');
    const snap = await getDoc(ref);
    await setDoc(ref, {
        type: 'channel',
        channelKey: 'announcements',
        name: '📣 Announcements',
        emoji: '📣',
        members,
        admins: [],
        // Read-mostly: only managers/admins post here (the composer is the
        // only writer; editTier keeps the thread composer manager-gated).
        editTier: 'manager',
        readOnly: true,
        createdBy: snap.exists() ? (snap.data().createdBy || byName) : byName,
        ...(snap.exists() ? {} : { createdAt: serverTimestamp() }),
        deletedAt: null,
        lastActivityAt: serverTimestamp(),
    }, { merge: true });
    return id;
}

// Post one announcement: doc (drives pop-ups) + chat copy + push fan-out.
// Returns { id, chatId, recipients }.
export async function postAnnouncement({
    text, staffName, viewer, staffList,
    audience = 'all', customNames = [], includeManagers = false,
    ackRequired = false, ackDeadline = null,
    media = null,                       // { url, path, mime } | null
    translations = null, sourceLang = null, translationStatus = null,
    audienceLabel = '',
}) {
    const body = String(text || '').trim();
    if (!body && !media) throw new Error('empty announcement');
    // Hand-picked audience (Andrew 2026-07-26): exact names, deduped.
    const audienceCustom = audience === 'custom'
        ? [...new Set((customNames || []).filter(Boolean))]
        : null;
    if (audience === 'custom' && audienceCustom.length === 0) {
        throw new Error('pick at least one staff member');
    }
    // One audience object threaded through matching, the chat copy's
    // audienceNames, and the push fan-out — they must never disagree.
    const aud = { audience, includeManagers, ...(audienceCustom ? { audienceCustom } : {}) };

    const translationsField = translations
        ? { translations, sourceLang, translationStatus: translationStatus || 'reviewed' }
        : (translationStatus === 'skipped' ? { translationStatus: 'skipped' } : {});

    // 1. The pop-up doc.
    const annRef = await addDoc(collection(db, 'announcements'), {
        text: body,
        audience,
        ...(audienceCustom ? { audienceCustom } : {}),
        includeManagers: !!includeManagers,
        audienceLabel: audienceLabel || audience,
        ...(media ? { mediaUrl: media.url, mediaPath: media.path, mediaType: media.mime } : {}),
        ...translationsField,
        ackRequired: !!ackRequired,
        ackDeadline: ackDeadline ? ackDeadline.toISOString() : null,
        createdBy: staffName,
        createdById: viewer?.id || null,
        createdAt: serverTimestamp(),
        active: true,
        acks: {},
    });

    // 2. Chat copy — revive/refresh the channel, append the message.
    // audienceNames rides on the message so the ack dashboard counts the
    // REAL audience (the channel's members are the whole staff — an
    // FOH-only announcement must not show BOH as "pending" forever).
    const audienceNames = audienceRecipients(aud, staffList)
        .filter(n => n !== staffName);
    const chatId = await ensureAnnouncementsChannel(staffList, staffName);
    const msgRef = await addDoc(collection(db, 'chats', chatId, 'messages'), {
        senderName: staffName,
        senderId: viewer?.id || null,
        senderRole: viewer?.role || null,
        type: 'announcement',
        text: body,
        ...(media ? { mediaUrl: media.url, mediaPath: media.path, mediaType: media.mime } : {}),
        ...translationsField,
        ackRequired: !!ackRequired,
        ackDeadline: ackDeadline ? ackDeadline.toISOString() : null,
        announcementGroupId: annRef.id,
        audienceLabel: audienceLabel || audience,
        audienceNames,
        reactions: {},
        mentions: [],
        createdAt: serverTimestamp(),
    });
    // Back-link so a popup "Got it" can mirror into the chat-side ack
    // store the manager dashboard reads (2026-07-26 regression review #2).
    await updateDoc(annRef, { chatId, chatMessageId: msgRef.id }).catch(() => {});
    // Varargs form — a FieldPath can't be a computed object key (it would
    // stringify to "[object Object]"), and the poster's name is free text
    // so a template-string dot-path would corrupt on names with dots.
    await updateDoc(doc(db, 'chats', chatId),
        'lastMessage', {
            text: '📣 ' + (body.slice(0, 100) || 'Announcement'),
            sender: staffName,
            ts: serverTimestamp(),
            type: 'announcement',
        },
        'lastActivityAt', serverTimestamp(),
        new FieldPath('lastReadByName', staffName), serverTimestamp(),
    );

    // 3. Push fan-out to the audience (closed apps get the ping; the
    // pop-up greets them at open). Best-effort per recipient.
    const recipients = audienceRecipients(aud, staffList)
        .filter(n => n !== staffName);
    for (const r of recipients) {
        notifyStaff({
            forStaff: r,
            type: 'announcement',
            title: '📣 New announcement',
            body: body.slice(0, 140),
            deepLink: 'home',
            link: '/',
            tag: `announcement:${annRef.id}:${r}`,
            createdBy: staffName,
            // Bypass the off-shift quiet gate (2026-07-26 audit): the whole
            // point is reaching CLOSED-app staff — who are, by definition,
            // usually off shift. Announcements are rare and manager-authored.
            forceDeliver: true,
        }).catch(() => {});
    }

    recordAudit({
        action: 'announcement.post',
        actorName: staffName,
        actorId: viewer?.id,
        targetType: 'announcement',
        targetId: annRef.id,
        details: { audience, includeManagers, ackRequired, recipients: recipients.length, chatId },
    });
    return { id: annRef.id, chatId, recipients };
}

// Live feed for the pop-up — recent announcements, newest first. The
// component filters by audience + own-ack client-side.
export function subscribeAnnouncements(cb) {
    const q = query(collection(db, 'announcements'), orderBy('createdAt', 'desc'), limit(20));
    return onSnapshot(q, (snap) => {
        const out = [];
        snap.forEach(d => out.push({ id: d.id, ...d.data() }));
        cb(out);
    }, (err) => {
        console.warn('subscribeAnnouncements error:', err);
        cb([]);
    });
}

// "Got it" — stamp this staffer's ack on the announcement doc AND mirror
// it into the chat-side ack store (/chats/{chatId}/acks/{messageId}_{name})
// so the manager's Read-rate dashboard on the chat copy counts popup acks
// too (2026-07-26 regression review #2 — the two stores were split-brain).
// FieldPath because staff names are free text (a dot in a name would
// corrupt a template-string dot-path). Accepts the full announcement
// object (needs chatId/chatMessageId); a bare id still acks the doc.
export async function ackAnnouncement(a, staffName) {
    const id = typeof a === 'string' ? a : a?.id;
    if (!id || !staffName) return;
    await updateDoc(doc(db, 'announcements', id),
        new FieldPath('acks', staffName), new Date().toISOString());
    if (typeof a === 'object' && a.chatId && a.chatMessageId) {
        setDoc(doc(db, 'chats', a.chatId, 'acks', `${a.chatMessageId}_${staffName}`), {
            messageId: a.chatMessageId,
            userName: staffName,
            ackedAt: serverTimestamp(),
        }, { merge: true }).catch(() => {});
    }
}
