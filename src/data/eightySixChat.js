// Auto-post 86 alerts into chat.
//
// Called from Eighty6Dashboard whenever an item's state flips (set out
// or cleared back in). Posts a `eighty_six_alert` message into the
// location's role channel (#foh-{loc}) so FOH staff stop ringing it up.
//
// We DON'T post into the all-team channel by default — it's noisy and
// BOH staff already see the 86 board. Manager can configure org-wide
// "also broadcast 86s to #all" toggle in the future.
//
// Idempotency: each (item, location, transition direction) gets a tag.
// Same-tag notifications replace at the OS level so FOH on multiple
// devices don't pile up.

import { db } from '../firebase';
import {
    collection, doc, addDoc, updateDoc, setDoc, getDoc, serverTimestamp,
} from 'firebase/firestore';
import { channelDocId } from './chat';
import { notifyStaff } from './notify';
import { recordAudit } from './audit';

// Slugify an item name for use in a deterministic doc ID. Lowercase,
// replace non-alphanum with underscore, trim.
function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

// Hour bucket (UTC) so multi-client races within the same hour land
// in the same deterministic doc id and dedup. Different hour = new doc.
function hourBucket() {
    const d = new Date();
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}_${String(d.getUTCHours()).padStart(2, '0')}`;
}

// `transition`: 'out' (item just 86'd) or 'in' (item back in stock).
export async function postEightySixToChat({
    location,           // 'webster' | 'maryland'
    itemName,
    transition,         // 'out' | 'in'
    actorName,          // who flipped the switch
    actorId,
    attributedTo,       // 'who actually 86'd' from Toast cross-reference (optional)
    notifyRecipients = [],  // staff names to FCM-push
}) {
    // For DD Mau we post into the side-specific channel (FOH cares most
    // about menu-item 86s) AND also stamp the location channel so
    // managers in #managers see them in one place.
    const targets = ['foh'];
    if (transition === 'out' || transition === 'in') {
        targets.push('managers');
    }

    const emoji = transition === 'out' ? '🚫' : '✅';
    const verb = transition === 'out' ? '86\'d' : 'back in stock';
    const text = `${emoji} ${itemName} ${verb}${attributedTo ? ` (last seen by ${attributedTo})` : ''}`;

    // Deterministic message id per (location, item, transition, hour
    // bucket). If two admin clients (or the scraper + a client) both try
    // to post the same transition within the same hour, the SECOND
    // setDoc just overwrites the same doc instead of creating a
    // duplicate. Snapshot listeners in chat threads will then
    // collapse to one rendered card.
    const stableId = `auto86_${slug(itemName)}_${location}_${transition}_${hourBucket()}`;

    for (const channelKey of targets) {
        const chatId = channelDocId(channelKey);
        try {
            const msgRef = doc(db, 'chats', chatId, 'messages', stableId);
            const existing = await getDoc(msgRef);
            if (existing.exists()) continue; // already posted this hour
            await setDoc(msgRef, {
                senderName: actorName || 'System',
                senderId: actorId ?? null,
                type: 'eighty_six_alert',
                text,
                eightySixData: {
                    location,
                    itemName,
                    transition,
                    attributedTo: attributedTo || null,
                },
                reactions: {},
                mentions: [],
                createdAt: serverTimestamp(),
            });
            await updateDoc(doc(db, 'chats', chatId), {
                lastMessage: {
                    text,
                    sender: actorName || 'System',
                    ts: serverTimestamp(),
                    type: 'eighty_six_alert',
                },
                lastActivityAt: serverTimestamp(),
            });
            recordAudit({
                action: 'chat.eighty_six.post',
                actorName: actorName || 'system',
                actorId,
                targetType: 'chat',
                targetId: chatId,
                details: { messageId: stableId, location, itemName, transition },
            });
        } catch (e) {
            console.warn(`86 chat post (${channelKey}) failed:`, e);
        }
    }

    // FCM fan-out to staff currently on-duty at this location (managers
    // exempt — they get the dashboard alerts anyway). The caller passes
    // notifyRecipients pre-filtered (Eighty6Dashboard already has the
    // geofence + on-duty logic from the earlier work).
    for (const to of notifyRecipients) {
        notifyStaff({
            forStaff: to,
            type: 'eighty_six',
            title: emoji + ' ' + (transition === 'out' ? '86 alert' : 'Back in stock'),
            body: `${itemName} · ${location === 'maryland' ? 'Maryland' : 'Webster'}`,
            deepLink: 'chat',
            link: '/chat',
            tag: `eighty_six:${location}:${itemName}:${transition}:${to}`,
            createdBy: actorName || 'system',
        }).catch(() => {});
    }
}
