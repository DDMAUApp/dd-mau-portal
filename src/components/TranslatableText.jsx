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

import { useState, useEffect } from 'react';
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

    // Subscribe to the in-memory cache so another bubble (or auto-
    // translate firing in the background) can fill us in even if the
    // message doc snapshot hasn't re-arrived yet.
    useEffect(() => {
        if (!chatId || !message.id) return;
        const unsub = subscribeTranslation(chatId, message.id, targetLang, (v) => {
            if (v) setLiveTranslation(v);
        });
        return () => unsub();
    }, [chatId, message.id, targetLang]);

    // If the message doc updates with a fresh cached translation
    // (e.g., someone else translated it first), pick that up.
    useEffect(() => {
        if (cached) setLiveTranslation(cached);
    }, [cached]);

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

    // Auto-translate on mount / when prefs flip on. Only fires once
    // per (message, targetLang) because the second call is a no-op
    // cache hit anyway (deduped inside translateMsg).
    useEffect(() => {
        if (!autoTranslate) return;
        if (!offered) return;
        if (liveTranslation) return;
        const hint = detectLanguageHint(original);
        if (hint && hint === targetLang?.split('-')[0]) return;
        doTranslate(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoTranslate, offered, targetLang]);

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
                            onClick={() => setShowing('original')}
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
                            onClick={() => setShowing('translated')}
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
        return <span key={i}>{p}</span>;
    });
}
