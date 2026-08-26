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
    doc, collection, serverTimestamp, deleteField,
    getDoc as _fsGetDoc,
    setDoc as _fsSetDoc,
    addDoc as _fsAddDoc,
    getDocs as _fsGetDocs,
    query, where, limit,
} from 'firebase/firestore';
// 2026-08-11 (chat forensics C1) — watchdog shadows, same pattern as
// ChatThread/ChatCenter. See firestoreRevive.js.
import { watchdogWrite, watchdogRead } from './firestoreRevive';
const getDoc = (...a) => watchdogRead(_fsGetDoc(...a));
const getDocs = (...a) => watchdogRead(_fsGetDocs(...a));
const setDoc = (...a) => watchdogWrite(_fsSetDoc(...a));
const addDoc = (...a) => watchdogWrite(_fsAddDoc(...a));

// ── DM identity resolver (2026-08-11, chat forensics C6) ─────────────
// dmDocId() embeds the two names VERBATIM in the doc id (trim only — no
// case folding, no whitespace collapsing, despite what its old comment
// claimed). That means a renamed staffer — or name data that drifts by
// a space/case ("Fui jun Mok" → "Fuijun Mok") — computes a DIFFERENT id
// for the same pair, forking the conversation into two threads (the old
// one still lists because renameStaff rewrites members[], but "New chat
// → same person" minted a fresh doc). Rewriting historical doc ids is
// not possible, so the fix is at LOOKUP time: before trusting the
// computed id, check whether a live 2-person DM with this exact pair
// already exists under ANY id and reuse it. Bare array-contains query —
// no composite index needed; a person's chats are capped (~100) so the
// client-side filter is cheap.
//
// Returns the existing chat id, or null when the pair has no live DM
// (caller falls back to dmDocId + create). Never throws.
export async function findLiveDmId(myName, otherName) {
    try {
        if (!myName || !otherName || myName === otherName) return null;
        const snap = await getDocs(query(
            collection(db, 'chats'),
            where('members', 'array-contains', myName),
            // 300, not 100 (2026-08-11 audit): the query has no orderBy, so
            // with more chats than the limit the target DM could fall outside
            // the page and we'd silently fork — the exact bug this resolver
            // exists to prevent. 300 comfortably exceeds any real per-person
            // chat count here.
            limit(300),
        ));
        let best = null;
        let bestMs = -1;
        snap.forEach(d => {
            const c = d.data() || {};
            if (c.type !== 'dm' || c.deletedAt) return;
            const m = Array.isArray(c.members) ? c.members : [];
            if (m.length !== 2 || !m.includes(otherName)) return;
            const ts = c.lastActivityAt || c.createdAt;
            const ms = ts?.toMillis ? ts.toMillis() : (ts?.seconds ? ts.seconds * 1000 : 0);
            if (ms > bestMs) { bestMs = ms; best = d.id; }
        });
        return best;
    } catch (e) {
        console.warn('findLiveDmId failed (falling back to deterministic id):', e);
        return null;
    }
}
import { dmDocId } from './chat';

// `extra` (2026-08-18, training assignments): optional extra fields merged
// into the message doc — e.g. { type: 'training_assignment', training: {…} }.
// `text` stays the plain-text fallback so clients that don't know the type
// (OTA lag), the chat-list preview and the push body all still read well.
// `knownChatId` (2026-08-19): a bulk sender (training assignments → 66 DMs)
// resolves the live-DM map ONCE with liveDmMapFor() and passes the id in,
// instead of re-running the array-contains query per recipient.
// One query → { otherName: chatId } for every live 2-person DM this sender is
// in (latest activity wins on duplicates). For bulk sends.
// Returns a Map on SUCCESS (a miss then means "this sender provably has no
// live DM with that person" — callers may pass knownChatId:false to skip the
// per-recipient fallback query, 2026-08-25). Returns NULL on failure so
// callers know to fall back to per-recipient lookup (knownChatId:null).
export async function liveDmMapFor(myName) {
    const map = new Map();
    try {
        if (!myName) return map;
        const snap = await getDocs(query(collection(db, 'chats'), where('members', 'array-contains', myName), limit(300)));
        const best = new Map();
        snap.forEach(d => {
            const c = d.data() || {};
            if (c.type !== 'dm' || c.deletedAt) return;
            const m = Array.isArray(c.members) ? c.members : [];
            if (m.length !== 2) return;
            const other = m.find(n => n !== myName);
            if (!other) return;
            const ts = c.lastActivityAt || c.createdAt;
            const ms = ts?.toMillis ? ts.toMillis() : (ts?.seconds ? ts.seconds * 1000 : 0);
            if (!best.has(other) || ms > best.get(other)) { best.set(other, ms); map.set(other, d.id); }
        });
    } catch (e) {
        console.warn('liveDmMapFor failed (per-recipient lookup will be used):', e);
        return null;
    }
    return map;
}

export async function sendDirectMessage({ fromName, fromId = null, toName, text, extra = null, knownChatId = null }) {
    const body = String(text || '').trim();
    if (!fromName || !toName || fromName === toName || !body) {
        return { ok: false, error: 'bad_args' };
    }
    try {
        // C6 — reuse a live DM for this pair under ANY id (rename-safe)
        // before minting the deterministic one. knownChatId === false is the
        // bulk-sender sentinel for "the pre-resolved map PROVED there is no
        // live DM" — skip the (guaranteed-empty) 300-doc fallback query and
        // mint the deterministic id directly. On a 66-person first-time
        // assignment that saves ~66 full chat-list reads (2026-08-25).
        const id = knownChatId
            || (knownChatId === false ? null : await findLiveDmId(fromName, toName))
            || dmDocId(fromName, toName);
        const ref = doc(db, 'chats', id);
        const snap = await getDoc(ref);
        // Resurrect a soft-deleted DM (2026-07-26 platform audit H4): the
        // deterministic id means a deleted pair doc still exists — without
        // this, the message landed in a members:[] chat nobody could see.
        const dead = snap.exists() &&
            (snap.data()?.deletedAt || !(snap.data()?.members || []).length);
        if (!snap.exists() || dead) {
            await setDoc(ref, {
                type: 'dm',
                members: [fromName, toName],
                admins: [],
                createdBy: fromName,
                createdByTier: 'admin',   // callers are admin surfaces
                editTier: 'admin',        // DMs aren't editable; nominal floor
                ...(snap.exists() ? {} : { createdAt: serverTimestamp() }),
                deletedAt: deleteField(),
                deletedBy: deleteField(),
                lastActivityAt: serverTimestamp(),
            }, { merge: true });
        }
        await addDoc(collection(db, 'chats', id, 'messages'), {
            senderName: fromName,
            senderId: fromId,
            type: 'text',
            text: body,
            reactions: {},
            mentions: [],
            ...(extra && typeof extra === 'object' ? extra : {}),
            createdAt: serverTimestamp(),
            // 2026-08-11 (chat forensics C3) — the onChatMessageCreated Cloud
            // Function now owns the preview update + recipient notification
            // for stamped messages (survives the sender's app closing right
            // after send). The old inline preview/notify writes are gone —
            // they were this file's copy of the exact fan-out that C3
            // centralizes. DEPLOY COUPLING: CF ships before this client.
            serverFanout: true,
        });
        return { ok: true, chatId: id };
    } catch (e) {
        console.warn('sendDirectMessage failed:', e);
        return { ok: false, error: e?.message || 'send_failed' };
    }
}
