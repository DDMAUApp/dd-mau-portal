// Programmatic one-shot DM sender (2026-07-23).
//
// Andrew: "in the staff usage page when it shows that the staff is still
// using the web app can we add a button to send them a chat message with
// the link to download the app." First caller is StaffUsageAudit's
// "Send app link" button; written generically so any admin surface can
// drop a message into a DM thread.
//
// Mirrors the three steps ChatThread.sendMessage performs, minus the
// UI-only machinery (breadcrumbs, mentions, media, replies):
//   1. Ensure the deterministic DM doc exists (same shape ChatCenter's
//      New-DM flow writes, so opening the thread later Just Works).
//   2. Append the message doc — the only awaited failure point.
//   3. Best-effort: denormalize the chat preview + push-notify the
//      recipient (same 'chat_message' shape as a hand-typed DM, so the
//      bell drawer + FCM deep-link behave identically).
import { db } from '../firebase';
import {
    doc, getDoc, setDoc, addDoc, updateDoc, collection, serverTimestamp,
} from 'firebase/firestore';
import { dmDocId } from './chat';
import { notifyStaff } from './notify';

export async function sendDirectMessage({ fromName, fromId = null, toName, text }) {
    const body = String(text || '').trim();
    if (!fromName || !toName || fromName === toName || !body) {
        return { ok: false, error: 'bad_args' };
    }
    try {
        const id = dmDocId(fromName, toName);
        const ref = doc(db, 'chats', id);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
            await setDoc(ref, {
                type: 'dm',
                members: [fromName, toName],
                admins: [],
                createdBy: fromName,
                createdByTier: 'admin',   // callers are admin surfaces
                editTier: 'admin',        // DMs aren't editable; nominal floor
                createdAt: serverTimestamp(),
                lastActivityAt: serverTimestamp(),
            });
        }
        await addDoc(collection(db, 'chats', id, 'messages'), {
            senderName: fromName,
            senderId: fromId,
            type: 'text',
            text: body,
            reactions: {},
            mentions: [],
            createdAt: serverTimestamp(),
        });
        // Preview + activity bump — best-effort, same as the interactive path.
        try {
            await updateDoc(ref, {
                lastMessage: { text: body.slice(0, 200), sender: fromName, ts: serverTimestamp(), type: 'text' },
                lastActivityAt: serverTimestamp(),
                [`lastReadByName.${fromName}`]: serverTimestamp(),
            });
        } catch (e) { console.warn('sendDirectMessage preview update failed:', e); }
        // Push the recipient. DM notification shape: title = sender name,
        // body = the message — matches ChatThread's fan-out.
        notifyStaff({
            forStaff: toName,
            type: 'chat_message',
            title: fromName,
            body: body.slice(0, 200),
            deepLink: 'chat',
            link: '/chat',
            tag: `chat:${id}`,
            createdBy: fromName,
        }).catch(() => {});
        return { ok: true, chatId: id };
    } catch (e) {
        console.warn('sendDirectMessage failed:', e);
        return { ok: false, error: e?.message || 'send_failed' };
    }
}
