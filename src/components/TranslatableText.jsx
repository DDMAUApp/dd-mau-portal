// TranslatableText — shared chat message renderer + 🌐 Translate chip.
//
// Lifted out of ChatThread on 2026-05-17 so the chip surfaces on every
// chat view that renders a stored message — not just the main thread.
// Today's call sites:
//   • ChatThread (text bubbles, AnnouncementCard, CoverageCard,
//     PhotoIssueCard, TaskHandoffCard)
//   • ChatPinsDrawer (pinned snippets)
//   • ChatSearchPanel (search results)
//   • ChatAckDashboard (managers reviewing an announcement)
//
// The chip + state machine is identical at every site. The shared
// component reads the per-message translation cache stored at
// message.translations.{targetLang} (written by the Cloud Function on
// first translate of a given target), so opening a message in the
// PinsDrawer that was already translated in the thread is instant +
// free.
//
// Sites that just want to render the body without the chip can pass
// `showChip={false}` (currently nobody — every text-render UI in chat
// wants the chip).

import { useState, useEffect, useRef } from 'react';
import { openExternalUrl } from '../capacitor-bridge';
import {
    translateMessage as translateMsg,
    readCachedTranslation,
    shouldOfferTranslation,
    subscribeTranslation,
    detectLanguageHint,
} from '../data/translation';

export default function TranslatableText({
    message, targetLang, autoTranslate, staffName, chatId,
    isMine, isEs, blockMode, showChip = true,
}) {
    const tx = (en, es) => (isEs ? es : en);
    const original = message.text || '';
    const cached = readCachedTranslation(message, targetLang);
    const offered = shouldOfferTranslation(message, staffName, targetLang);

    // showing = which version we're rendering right now: 'original' or 'translated'.
    // pending = a Cloud Function call is in flight.
    // err     = the last call failed (we show a "retry" chip).
    // sameLang = the Cloud Function detected source == target — no real
    //            translation happened. We swap the chip for an inert
    //            "Already in your language" pill so the user doesn't
    //            tap the same un-translated text forever wondering why
    //            nothing changed. (2026-05-17 fix.)
    const [showing, setShowing] = useState('original');
    const [pending, setPending] = useState(false);
    const [err, setErr] = useState(null);
    const [liveTranslation, setLiveTranslation] = useState(cached || null);
    const [sameLang, setSameLang] = useState(false);
    // Latches true the moment the viewer taps Show original / Show
    // translation on THIS bubble — after that, auto-translate keeps
    // its hands off the toggle (flipping a message back to translated
    // right after someone chose the original reads as broken).
    const userChoseRef = useRef(false);

    // The message text changed (edit) or the viewer's target language
    // flipped — every piece of local state is now about the WRONG
    // text/lang. Re-seed from the doc cache for the new key. Without
    // this, a bubble showing a translation kept showing the PRE-edit
    // translation after an edit (handleEditMessage wipes the doc's
    // translations map, but not this component's state).
    useEffect(() => {
        setLiveTranslation(readCachedTranslation(message, targetLang) || null);
        setShowing('original');
        setSameLang(false);
        setErr(null);
        userChoseRef.current = false;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [original, targetLang]);

    // Subscribe to the in-memory cache so another bubble (or auto-
    // translate firing in the background) can fill us in even if the
    // message doc snapshot hasn't re-arrived yet. Keyed on the text
    // too, so a stale pre-edit entry can't land here.
    useEffect(() => {
        if (!chatId || !message.id) return;
        const unsub = subscribeTranslation(chatId, message.id, targetLang, (v) => {
            if (v) setLiveTranslation(v);
        }, original);
        return () => unsub();
    }, [chatId, message.id, targetLang, original]);

    // If the message doc updates with a fresh cached translation
    // (e.g., someone else translated it first), pick that up.
    useEffect(() => {
        if (cached) setLiveTranslation(cached);
    }, [cached]);

    // Auto-translate promises "show every foreign message translated
    // into your language" (ChatNotifSettings copy) — so once a
    // translation is available, DISPLAY it, don't just prefetch it.
    // Before this fix the auto path only warmed the cache and the
    // viewer still had to tap "Show translation" on every message,
    // which is exactly the tap the setting claims to remove. The
    // userChoseRef latch keeps manual toggles sticky.
    useEffect(() => {
        if (!autoTranslate || userChoseRef.current) return;
        if (offered && liveTranslation) setShowing('translated');
    }, [autoTranslate, offered, liveTranslation]);

    async function doTranslate(autoFire = false) {
        if (pending) return;
        setPending(true);
        setErr(null);
        try {
            const res = await translateMsg({
                chatId, messageId: message.id,
                text: original, targetLang,
            });
            // Source language equals target → there's nothing to
            // translate. The Cloud Function returns the original text
            // unchanged. We surface that as an "Already in [lang]"
            // chip instead of pretending we translated. Also compare
            // the returned text to the original as a safety net in
            // case the API didn't report a sourceLang for some reason.
            const sourceMatches = res?.sourceLang
                && targetLang
                && res.sourceLang.toLowerCase().split('-')[0]
                   === targetLang.toLowerCase().split('-')[0];
            const textUnchanged = res?.translatedText
                && res.translatedText.trim() === original.trim();
            if (sourceMatches || textUnchanged) {
                setSameLang(true);
            } else if (res?.translatedText) {
                setLiveTranslation(res.translatedText);
                if (!autoFire) setShowing('translated');
            }
        } catch (e) {
            console.warn('translate failed:', e);
            setErr(e?.message || 'failed');
        } finally {
            setPending(false);
        }
    }

    // Auto-translate on mount / when prefs flip on / when the text is
    // edited. Repeat runs are cheap: the module memo (keyed on the
    // text) dedupes, so only genuinely new text hits the API.
    // liveTranslation + sameLang are in the deps ON PURPOSE — the
    // edit-reset effect above clears them a render after `original`
    // changes, and this effect must re-run on that second render to
    // fire the re-translate (on the first render its closure still
    // sees the stale pre-edit values and correctly skips).
    useEffect(() => {
        if (!autoTranslate) return;
        if (!offered) return;
        if (liveTranslation || sameLang) return;
        const hint = detectLanguageHint(original);
        if (hint && hint === targetLang?.split('-')[0]) return;
        doTranslate(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoTranslate, offered, targetLang, original, liveTranslation, sameLang]);

    const showTranslated = showing === 'translated' && !!liveTranslation;
    const body = showTranslated ? liveTranslation : original;

    return (
        <>
            <span className={`whitespace-pre-wrap text-[14.5px] leading-snug ${blockMode ? 'block mt-1' : ''}`}>
                {renderWithMentions(body, isMine)}
            </span>
            {showChip && offered && (
                <div className={`mt-1 ${isMine ? 'text-right' : 'text-left'}`}>
                    {sameLang ? (
                        <span
                            className={`inline-flex items-center gap-1 text-[10.5px] font-bold rounded-full px-2 py-0.5 ${isMine
                                ? 'bg-white/10 text-white/60'
                                : 'bg-dd-bg text-dd-text-2/70 border border-dd-line'}`}
                            title={tx('Already in your language', 'Ya está en tu idioma')}
                        >
                            <span>🌐</span>
                            <span>
                                {tx(
                                    `Already in ${targetLang?.toUpperCase() === 'ES' ? 'Spanish' : targetLang?.toUpperCase() === 'EN' ? 'English' : targetLang?.toUpperCase()}`,
                                    `Ya está en ${targetLang?.toUpperCase() === 'ES' ? 'español' : targetLang?.toUpperCase() === 'EN' ? 'inglés' : targetLang?.toUpperCase()}`,
                                )}
                            </span>
                        </span>
                    ) : showTranslated ? (
                        <button
                            onClick={() => { userChoseRef.current = true; setShowing('original'); }}
                            className={`inline-flex items-center gap-1 text-[10.5px] font-bold rounded-full px-2 py-0.5 transition active:scale-95 ${isMine
                                ? 'bg-white/15 text-white/80 hover:bg-white/25'
                                : 'bg-dd-bg text-dd-text-2 border border-dd-line hover:bg-white'}`}
                            title={tx('Show the message as it was sent', 'Mostrar el mensaje original')}
                        >
                            <span>🌐</span>
                            <span>{tx('Translated · Show original', 'Traducido · Ver original')}</span>
                        </button>
                    ) : liveTranslation ? (
                        <button
                            onClick={() => { userChoseRef.current = true; setShowing('translated'); }}
                            className={`inline-flex items-center gap-1 text-[10.5px] font-bold rounded-full px-2 py-0.5 transition active:scale-95 ${isMine
                                ? 'bg-white/15 text-white/80 hover:bg-white/25'
                                : 'bg-dd-bg text-dd-text-2 border border-dd-line hover:bg-white'}`}
                        >
                            <span>🌐</span>
                            <span>{tx('Show translation', 'Ver traducción')}</span>
                        </button>
                    ) : (
                        <button
                            onClick={() => doTranslate(false)}
                            disabled={pending}
                            className={`inline-flex items-center gap-1 text-[10.5px] font-bold rounded-full px-2 py-0.5 transition active:scale-95 disabled:opacity-60 ${isMine
                                ? 'bg-white/15 text-white/80 hover:bg-white/25'
                                : 'bg-dd-bg text-dd-text-2 border border-dd-line hover:bg-white'}`}
                            title={err ? tx('Retry translation', 'Reintentar traducción') : tx('Translate this message', 'Traducir este mensaje')}
                        >
                            <span>🌐</span>
                            <span>
                                {pending ? tx('Translating…', 'Traduciendo…')
                                    : err ? tx('Retry', 'Reintentar')
                                    : tx('Translate', 'Traducir')}
                            </span>
                        </button>
                    )}
                </div>
            )}
        </>
    );
}

// Render text body with @mentions highlighted. Cheap regex split.
// Unicode-aware to match parseMentions in chat.js — @María / @José
// get the highlight treatment same as ASCII names.
// Turn http(s):// and www. URLs in a plain-text run into clickable links.
// target="_blank" opens a new tab on web and is intercepted by the native
// bridge (capacitor-bridge a[target="_blank"] handler → in-app browser) on
// iOS/Android. stopPropagation so tapping a link doesn't also trigger the
// message bubble's reply/react tap. (Andrew 2026-06-17 — "make posted web
// pages clickable in chat".)
const URL_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
function linkifyRun(text, keyPrefix, isMine) {
    if (!text || !/(https?:\/\/|www\.)/i.test(text)) return text;
    const out = [];
    let last = 0;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
        let url = m[0];
        // Don't swallow trailing sentence punctuation into the URL.
        let trail = '';
        const tm = url.match(/[.,!?;:)\]]+$/);
        if (tm) { trail = tm[0]; url = url.slice(0, -trail.length); }
        if (!url) { continue; }
        if (m.index > last) out.push(text.slice(last, m.index));
        const href = url.startsWith('www.') ? `https://${url}` : url;
        out.push(
            // Open EXPLICITLY via openExternalUrl on click — NOT target="_blank".
            // In the native iOS/Android WebView a `target="_blank"` link does
            // nothing on its own, and the global a[target="_blank"] click
            // interceptor in capacitor-bridge wasn't reliably firing for these
            // (App Store app: links "weren't clickable", Andrew 2026-06-20).
            // openExternalUrl routes to the in-app browser on native
            // (@capacitor/browser, which IS in the native build) and a new tab
            // on web. preventDefault stops the default no-op nav; stopPropagation
            // keeps the tap from also opening the bubble's reply/react menu.
            // No target="_blank" so the interceptor can't ALSO fire (double-open).
            <a key={`${keyPrefix}-u${m.index}`} href={href} rel="noopener noreferrer"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); openExternalUrl(href); }}
                className={`underline break-all ${isMine ? 'text-white' : 'text-dd-green'}`}>
                {url}
            </a>
        );
        if (trail) out.push(trail);
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

export function renderWithMentions(text, isMine) {
    if (!text) return null;
    const parts = text.split(/(@"[^"]+"|@\p{L}[\p{L}'\-]*)/gu);
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
        return <span key={i}>{linkifyRun(p, i, isMine)}</span>;
    });
}
