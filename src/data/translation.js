// Chat message translation — client wrappers around the
// `translateMessage` httpsCallable Cloud Function.
//
// ── Why per-message on-demand (not auto-translate on send) ──────────
// Andrew: "I want to be able to click to select translate and vise
// versa." So the primary UX is a small "🌐 Translate" link under each
// foreign-language message that the viewer can tap. The translation
// is then cached on the message document (translations.{lang}) so
// every subsequent viewer sees it instantly with no extra API call.
//
// An optional "auto-translate everything to my language" preference
// is layered on top in ChatNotifSettings — when ON, the chat thread
// auto-fires translation for any message whose sourceLang doesn't
// match the viewer's preferredLanguage. Same cache path, same Cloud
// Function, just kicked off without a tap.
//
// ── What lives where ────────────────────────────────────────────────
// Message doc (Firestore, written by the Cloud Function on first
// translate of a given target):
//   translations: { en: 'Hello team', es: 'Hola equipo' }
//   sourceLang:   'en' | 'es' | ... (auto-detected on first translate)
//
// Per-user prefs (Firestore /chat_prefs/{staffName}):
//   autoTranslate:        boolean    — fire translation automatically
//                                       for messages not in my language
//   preferredLanguage:    'en' | 'es' (also mirrored on staff record;
//                                       chat_prefs wins when present)
//
// In-memory cache (this module): {chatId}/{messageId}/{targetLang} ->
//   translated string. Survives only the lifetime of the page —
//   Firestore re-hydrates on next mount via the message snapshot.
//
// ── Why a module not a hook ─────────────────────────────────────────
// The translate call is fire-and-forget from the message bubble; we
// don't need to participate in React's render cycle. A tiny event-bus
// (subscribe / publish) is enough: components subscribe to the cache
// for a (chatId, messageId, lang) and re-render when the entry lands.
// This also keeps the implementation testable without React.

import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

// In-flight requests are deduped so two simultaneous taps on the
// same message + lang only hit the API once. Keyed by
// `${chatId}|${messageId}|${targetLang}`.
const inflight = new Map();

// Memo of resolved translations from this session. The message doc
// is the source of truth on next mount; this map just dodges a few
// Firestore re-reads while you're scrolling.
const memo = new Map();

function cacheKey(chatId, messageId, targetLang) {
    return `${chatId || ''}|${messageId || ''}|${(targetLang || '').toLowerCase()}`;
}

// Pull a cached translation off a message doc (written there by the
// Cloud Function the first time someone translated it). Pure helper.
export function readCachedTranslation(message, targetLang) {
    if (!message || !targetLang) return null;
    const lang = String(targetLang).toLowerCase();
    const t = message.translations || {};
    return t && typeof t[lang] === 'string' ? t[lang] : null;
}

// Should this message even offer a translation? We hide the chip on:
//   • Own messages (you already know what you sent)
//   • Empty text / media-only messages (nothing to translate)
//   • Messages whose stored sourceLang already matches the target
//   • System events (announcements / coverage cards translate, but
//     pure system_event control messages do not)
export function shouldOfferTranslation(message, viewerName, targetLang) {
    if (!message || !targetLang) return false;
    if (message.deleted) return false;
    if (message.senderName === viewerName) return false;
    if (message.type === 'system' || message.type === 'system_event') return false;
    if (message.type === 'eighty_six_alert') return false; // emoji-laden alert; not useful
    const text = (message.text || '').trim();
    if (text.length < 2) return false;
    const sourceLang = message.sourceLang;
    if (sourceLang && sourceLang.toLowerCase() === targetLang.toLowerCase()) return false;
    return true;
}

// Cheap-and-cheerful heuristic for whether a string is in Spanish vs
// English. NOT a replacement for the Cloud Translate auto-detect —
// it's used purely to gate the auto-translate toggle so we don't
// spend API calls translating "lol" or "thanks" between identical
// languages.
//
// Rules:
//   • Any ñ / ¡ / ¿ → Spanish
//   • Stop-word hit count: "el la los las que de en por para con"
//     wins → Spanish. "the and or for with you have is" wins → English.
//   • Tie / no hits → null (caller treats as "unknown, ask the server").
const ES_STOP = /\b(el|la|los|las|que|de|en|por|para|con|pero|sí|no|hola|gracias|buenos|días|noche|mañana|tarde)\b/gi;
const EN_STOP = /\b(the|and|or|for|with|you|have|is|are|was|were|to|of|in|on|at|hi|hello|please|thanks|today|tomorrow)\b/gi;
export function detectLanguageHint(text) {
    if (!text || typeof text !== 'string') return null;
    if (/[ñ¡¿áéíóúü]/i.test(text)) return 'es';
    const es = (text.match(ES_STOP) || []).length;
    const en = (text.match(EN_STOP) || []).length;
    if (es > en) return 'es';
    if (en > es) return 'en';
    return null;
}

// Subscribe to a (chatId, messageId, targetLang) cache entry. Calls
// `cb(text)` whenever the cache value lands. Returns an unsubscribe.
const listeners = new Map(); // key -> Set<cb>
function notify(key) {
    const set = listeners.get(key);
    if (!set) return;
    const val = memo.get(key);
    for (const cb of set) {
        try { cb(val); } catch { /* swallow — one bad listener shouldn't kill others */ }
    }
}
export function subscribeTranslation(chatId, messageId, targetLang, cb) {
    const key = cacheKey(chatId, messageId, targetLang);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(cb);
    if (memo.has(key)) cb(memo.get(key));
    return () => {
        const set = listeners.get(key);
        if (set) {
            set.delete(cb);
            if (set.size === 0) listeners.delete(key);
        }
    };
}

// Translate a single message via the Cloud Function. Idempotent:
// re-calls with the same (chatId, messageId, targetLang) coalesce.
//
// Args:
//   chatId, messageId — Firestore coordinates (the function caches
//     the result back onto the message doc; subsequent viewers see
//     the cache via the message snapshot, not via this module).
//   text — only used when chatId/messageId aren't available (e.g.,
//     a preview before send). When both are passed, the function
//     re-reads from Firestore so we always translate the latest text.
//   targetLang — 'en' | 'es' | etc.
//
// Returns a Promise of {translatedText, sourceLang, cached} or rejects.
// The translated text is also written into the in-memory cache and
// every active subscriber is notified.
//
// NOT declared async — we want the returned promise object to be the
// exact same reference for coalesced concurrent calls. An async fn
// wraps every return in a fresh Promise, which would defeat the dedup
// guarantee (two callers in the same tick would each get a unique
// outer promise even though they share the inner work).
export function translateMessage({ chatId, messageId, text, targetLang }) {
    const lang = String(targetLang || '').toLowerCase();
    if (!lang) return Promise.reject(new Error('targetLang required'));
    if (!text && !(chatId && messageId)) {
        return Promise.reject(new Error('need text or chatId+messageId'));
    }

    const key = cacheKey(chatId, messageId, lang);
    if (memo.has(key)) {
        return Promise.resolve({ translatedText: memo.get(key), sourceLang: null, cached: true });
    }
    if (inflight.has(key)) return inflight.get(key);

    const call = httpsCallable(functions, 'translateMessage');
    const payload = { targetLang: lang };
    if (chatId) payload.chatId = chatId;
    if (messageId) payload.messageId = messageId;
    if (text) payload.text = text;

    const promise = (async () => {
        try {
            const res = await call(payload);
            const result = res?.data || {};
            const out = String(result.translatedText || '');
            if (out) {
                memo.set(key, out);
                notify(key);
            }
            return {
                translatedText: out,
                sourceLang: result.sourceLang || null,
                cached: !!result.cached,
            };
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, promise);
    return promise;
}

// Test seam: clear all in-memory state. Used by translation.test.js.
export function _resetTranslationCacheForTest() {
    memo.clear();
    inflight.clear();
    listeners.clear();
}
