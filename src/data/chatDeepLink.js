// Conversation-level push deep links (2026-08-11, chat forensics C4).
//
// Chat pushes have always carried deepLink:'chat' — tab-level only, so
// tapping "Julie: are we out of mint?" opened the chat LIST and the user
// had to find the conversation. The notification doc (and the FCM data
// payload) now also carries `chatId`; the tap-routing layers compose it
// into a `chat:{chatId}` tab string, App.jsx splits it here, and
// ChatCenter opens the exact conversation.
//
// Why a module-level store instead of React state: the tap can land
// BEFORE ChatCenter is mounted (cold launch, PIN lock, different tab).
// The id parks here until ChatCenter mounts and consumes it; if the
// user is ALREADY in chat, the 'ddmau:open-chat' event opens it live.
//
// The 10-minute expiry keeps a stale park (user tapped a push, then got
// distracted at the lock screen for an hour) from yanking them into an
// old conversation much later.

const EXPIRY_MS = 10 * 60 * 1000;
let _pending = null; // { id, at }

// Split a composite tab string. 'chat:abc123' → { tab:'chat', chatId:'abc123' };
// anything else passes through with chatId null. Pure — unit-tested.
export function parseChatDeepLink(raw) {
    const s = String(raw || '');
    if (s.startsWith('chat:')) {
        const chatId = s.slice(5).trim();
        return { tab: 'chat', chatId: chatId || null };
    }
    return { tab: s, chatId: null };
}

export function setPendingChatOpen(chatId) {
    if (!chatId) return;
    _pending = { id: String(chatId), at: Date.now() };
    // Live path — ChatCenter (if mounted) opens it immediately.
    try {
        window.dispatchEvent(new CustomEvent('ddmau:open-chat', { detail: { chatId: String(chatId) } }));
    } catch { /* SSR/test env — park only */ }
}

// One-shot read. Returns the parked chat id (or null) and clears it.
export function consumePendingChatOpen() {
    const p = _pending;
    _pending = null;
    if (!p) return null;
    if (Date.now() - p.at > EXPIRY_MS) return null;
    return p.id;
}
