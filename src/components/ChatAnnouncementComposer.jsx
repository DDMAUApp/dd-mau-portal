// ChatAnnouncementComposer — manager-only "broadcast a thing" modal.
//
// Workflow (2026-07-26 rework — Andrew: announcements POP UP on app open
// for the matched audience, with a copy in the 📣 Announcements chat):
//   1. Pick audience (all-team, FOH, BOH, managers, location)
//   2. Write body (text + optional photo) + reviewed translation
//   3. Toggle "require ack" + optional deadline
//   4. Post → postAnnouncement() writes the /announcements doc (drives
//      AnnouncementPopup), appends the chat copy, and push-notifies the
//      audience. "Got it" acks live on the announcement doc's acks map.

import { useState, useMemo, useEffect, useRef } from 'react';
import { storage } from '../firebase';
import { ref as sref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { canPostAnnouncements } from '../data/chatPermissions';
import { postAnnouncement } from '../data/announcements';
import { translateMessage, detectLanguageHint } from '../data/translation';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';
import { fileToScaledBlob } from '../data/parseReceipt';

// ── Crash-survival draft (2026-09-01 camera-crash sweep) ─────────────
// Attaching a photo opens the camera, which backgrounds the WebView; on
// memory-squeezed iPhones iOS can kill the page and a fully-composed
// announcement (body + reviewed Spanish + audience + ack settings) came
// back BLANK. Mirror the typed state to localStorage while composing;
// offer Resume on reopen. The photo File itself can't be serialized —
// the banner says to re-attach it.
const ANN_DRAFT_KEY = 'ddmau:announcementDraft';
const ANN_DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
const readAnnDraft = () => {
    try {
        const d = JSON.parse(localStorage.getItem(ANN_DRAFT_KEY) || 'null');
        if (!d || !d.at || (Date.now() - d.at) > ANN_DRAFT_TTL_MS) return null;
        if (!String(d.body || '').trim() && !String(d.translation || '').trim()) return null;
        return d;
    } catch { return null; }
};
const clearAnnDraft = () => { try { localStorage.removeItem(ANN_DRAFT_KEY); } catch { /* noop */ } };

export default function ChatAnnouncementComposer({
    language = 'en', staffName, staffList, viewer, isAdmin, isManager,
    onClose, onPosted,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const canPost = canPostAnnouncements(viewer, isAdmin, isManager);

    const [audience, setAudience] = useState('all'); // who gets the pop-up
    // Hand-picked staff names, for audience === 'custom' (Andrew
    // 2026-07-26: "pick certain staff not just groups").
    const [customNames, setCustomNames] = useState(() => new Set());
    const [body, setBody] = useState('');
    const [photo, setPhoto] = useState(null); // { file, previewUrl }
    const [ackRequired, setAckRequired] = useState(false);
    const [ackDeadlineHours, setAckDeadlineHours] = useState(24);
    const [crosspostManagers, setCrosspostManagers] = useState(false);
    const [busy, setBusy] = useState(false);
    // ── Translation review state ────────────────────────────────────
    // Per Section 14 of the WorkChat blueprint: announcements (and
    // other critical content — ack-required, training, allergen, HR)
    // get a manager-review step before posting. Auto-suggest a
    // translation when the body stabilizes, then let the manager
    // edit it. Both versions are stored on the message doc with
    // translationStatus: 'reviewed' + translationReviewedBy/At so the
    // audit trail shows a human approved this specific Spanish text.
    //
    // sourceLang: which language the manager typed in ('en' or 'es')
    //   — auto-detected from the body. Determines which way we
    //   translate (en→es or es→en). The OTHER language is the
    //   reviewed translation we store.
    // translation: the editable suggested text in the OTHER language.
    // translating: a translateMessage() call is in flight.
    // reviewed: manager has manually edited the suggestion (we trust
    //   it as-is); we still mark translationStatus='reviewed' if they
    //   leave the auto-suggest unchanged — the act of seeing + posting
    //   it counts as review.
    // skipTranslation: bypass the review step entirely. Useful when
    //   the body is bilingual already or contains only numbers/links.
    const [sourceLang, setSourceLang] = useState('en'); // 'en' | 'es'
    const [translation, setTranslation] = useState('');
    const [translating, setTranslating] = useState(false);
    const [translationError, setTranslationError] = useState(null);
    const [translationEdited, setTranslationEdited] = useState(false);
    const [skipTranslation, setSkipTranslation] = useState(false);
    const lastBodyRef = useRef('');
    const debounceTimerRef = useRef(null);
    // 2026-07-27 audit C11 — mint the announcement doc id ONCE per compose
    // session (was inside handlePost, so every retry tap minted a fresh id
    // and a fresh doc). Stable across retries → postAnnouncement's setDoc
    // overwrites the same /announcements doc instead of duplicating the
    // pop-up + push fan-out. Also names the photo upload path.
    const announcementIdRef = useRef(`ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    // Crash-survival draft — see ANN_DRAFT_KEY above. Mirrors the typed
    // state (debounced) while composing; Resume banner on reopen.
    const [resumeDraft, setResumeDraft] = useState(() => readAnnDraft());
    useEffect(() => {
        const t = setTimeout(() => {
            if (!body.trim() && !translation.trim()) return;
            try {
                localStorage.setItem(ANN_DRAFT_KEY, JSON.stringify({
                    body, translation, translationEdited, skipTranslation, sourceLang,
                    audience, customNames: [...customNames],
                    ackRequired, ackDeadlineHours, crosspostManagers,
                    annId: announcementIdRef.current, at: Date.now(),
                }));
            } catch { /* storage blocked/full */ }
        }, 500);
        return () => clearTimeout(t);
    }, [body, translation, translationEdited, skipTranslation, sourceLang, audience,
        customNames, ackRequired, ackDeadlineHours, crosspostManagers]);
    const applyResumeDraft = () => {
        const d = resumeDraft;
        if (!d) return;
        setBody(d.body || '');
        setTranslation(d.translation || '');
        setTranslationEdited(!!d.translationEdited);
        setSkipTranslation(!!d.skipTranslation);
        setSourceLang(d.sourceLang === 'es' ? 'es' : 'en');
        setAudience(d.audience || 'all');
        setCustomNames(new Set(d.customNames || []));
        setAckRequired(!!d.ackRequired);
        setAckDeadlineHours(d.ackDeadlineHours ?? 24);
        setCrosspostManagers(!!d.crosspostManagers);
        // Keep the same announcement id so the C11 retry-dedupe survives
        // the reload too.
        if (d.annId) announcementIdRef.current = d.annId;
        setResumeDraft(null);
    };
    const dropResumeDraft = () => { setResumeDraft(null); clearAnnDraft(); };
    // 2026-07-27 audit C11 (leak) — the photo previewUrl was only revoked on
    // the manual ✕; closing the modal (or a successful post) leaked the blob
    // URL for the session. Ref mirror + unmount cleanup covers every exit.
    // (Revoking an already-revoked URL is a harmless no-op.)
    const photoRef = useRef(null);
    useEffect(() => { photoRef.current = photo; }, [photo]);
    useEffect(() => () => {
        if (photoRef.current?.previewUrl) URL.revokeObjectURL(photoRef.current.previewUrl);
    }, []);

    // The OTHER language — i.e. the one we generate a reviewed
    // translation INTO. Computed from sourceLang. Used for labels +
    // for the translateMessage targetLang.
    const targetLang = sourceLang === 'en' ? 'es' : 'en';

    // Debounced auto-suggest: when the body stabilizes for ~800ms,
    // detect the source language and call the translateMessage Cloud
    // Function to suggest a translation. Cancels in-flight on edits.
    //
    // The manager can edit the suggestion freely; setting
    // translationEdited=true sticks it so subsequent body edits don't
    // overwrite their changes (they'd have to re-tap "Re-suggest").
    useEffect(() => {
        if (skipTranslation) return;
        if (translationEdited) return;
        const trimmed = body.trim();
        if (trimmed.length < 4) {
            setTranslation('');
            setTranslationError(null);
            return;
        }
        // Detect language hint locally so we don't fire the API for
        // English-to-English (i.e., manager already typed in the team's
        // common language). The Cloud Function returns sourceLang too,
        // but we want to avoid the round-trip when we can.
        const hint = detectLanguageHint(trimmed);
        const src = hint || 'en';
        setSourceLang(src);
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(async () => {
            if (lastBodyRef.current === trimmed) return; // unchanged since timer set
            lastBodyRef.current = trimmed;
            const tgt = src === 'en' ? 'es' : 'en';
            setTranslating(true);
            setTranslationError(null);
            try {
                const res = await translateMessage({
                    text: trimmed,
                    targetLang: tgt,
                });
                // If the manager kept typing between the API call
                // starting and finishing, drop the stale result —
                // the next debounce tick will replace it.
                if (lastBodyRef.current !== trimmed) return;
                const out = (res?.translatedText || '').trim();
                if (out && out !== trimmed) {
                    setTranslation(out);
                } else {
                    // Same text back means source == target. Nothing
                    // to review.
                    setTranslation('');
                }
            } catch (e) {
                console.warn('announcement translate suggest failed:', e);
                setTranslationError(e?.message || 'translate failed');
            } finally {
                setTranslating(false);
            }
        }, 800);
        return () => {
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        };
    }, [body, skipTranslation, translationEdited]);

    // Manual re-suggest — clears the "edited" lock so the next
    // debounce tick repopulates. Useful if the manager wants to start
    // over from the auto-suggest.
    function handleResuggest() {
        setTranslation('');
        setTranslationEdited(false);
        lastBodyRef.current = ''; // force a re-run on next debounce
    }

    // Audience options based on viewer's role + the standard channels.
    const audienceOptions = useMemo(() => {
        // 2026-07-26 rework: audiences describe WHO gets the pop-up, not
        // which channel it posts to (the copy always lands in the 📣
        // Announcements chat). The old duplicate "Announcements"/"All Team
        // channel" pair collapsed into one Everyone option.
        const opts = [
            { value: 'all',      label: tx('📣 Everyone (all staff)', '📣 Todos (todo el personal)') },
            { value: 'foh',      label: tx('🪑 Front of House only', '🪑 Solo Front of House') },
            { value: 'boh',      label: tx('👩‍🍳 Back of House only', '👩‍🍳 Solo Back of House') },
            { value: 'managers', label: tx('🧑‍💼 Managers only', '🧑‍💼 Solo gerentes') },
            { value: 'webster',  label: tx('🏠 Webster only', '🏠 Solo Webster') },
            { value: 'maryland', label: tx('🏠 Maryland Hts only', '🏠 Solo Maryland') },
            { value: 'custom',   label: tx('🎯 Pick specific staff…', '🎯 Elegir personal específico…') },
        ];
        return opts;
    }, [isEs]);

    // Active staff, alphabetical — the pick-list for the custom audience.
    const pickableStaff = useMemo(() => (
        (staffList || [])
            .filter(s => s?.name && s.active !== false)
            .map(s => s.name)
            .sort((a, b) => a.localeCompare(b))
    ), [staffList]);

    const toggleCustomName = (name) => {
        setCustomNames(prev => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name); else next.add(name);
            return next;
        });
    };

    if (!canPost) {
        return (
            <ModalPortal>
            <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onClose}>
                <div className="bg-white rounded-xl p-6 max-w-sm" onClick={(e) => e.stopPropagation()}>
                    <p className="text-dd-text mb-3">{tx('Only managers can post announcements.', 'Solo los gerentes pueden publicar anuncios.')}</p>
                    <button onClick={onClose} className="px-4 py-2 bg-dd-bg rounded font-bold text-sm">{tx('Close', 'Cerrar')}</button>
                </div>
            </div>
            </ModalPortal>
        );
    }

    async function handlePhotoPick(e) {
        let f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        // 2026-09-01 camera-crash sweep: downscale before staging (receipts/
        // health recipe) — the preview then decodes ~300KB, not 48MP RGBA,
        // and the upload doesn't crawl in the post-camera window. Fallback
        // keeps the original with the 10MB storage-rule gate.
        try {
            f = await fileToScaledBlob(f, 2000, 0.85);
        } catch {
            if (f.size > 10 * 1024 * 1024) {
                toast(tx('Photo is too large (max 10 MB)', 'La foto es muy grande (máx 10 MB)'), { kind: 'error' });
                return;
            }
        }
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
            // 2026-07-26 (Andrew): announcements are no longer channel posts —
            // they're a /announcements doc that POPS UP when a matching staff
            // member opens the app, plus one copy in the revived 📣
            // Announcements chat and a push to the audience. postAnnouncement
            // (data/announcements.js) does all three.
            const announcementGroupId = announcementIdRef.current; // stable across retries (audit C11)
            const ackDeadline = ackRequired && ackDeadlineHours > 0
                ? new Date(Date.now() + ackDeadlineHours * 3600_000)
                : null;

            let media = null;
            if (photo?.file) {
                media = await uploadPhoto(photo.file, announcementGroupId);
            }

            const reviewedTranslation = !skipTranslation && translation.trim().length > 0
                ? translation.trim()
                : null;

            // Custom audience label = the actual names (truncated) so the
            // chat copy + ack dashboard read naturally.
            const pickedNames = [...customNames];
            const audienceLabel = audience === 'custom'
                ? '🎯 ' + (pickedNames.slice(0, 4).join(', ') + (pickedNames.length > 4 ? ` +${pickedNames.length - 4}` : ''))
                : (audienceOptions.find(o => o.value === audience)?.label || audience);

            const res = await postAnnouncement({
                text: body,
                staffName, viewer, staffList,
                // 2026-07-27 audit C11 — pass the minted id as the doc id so
                // a retry after a mid-flow failure overwrites the same
                // /announcements doc instead of double-posting (double push
                // + double pop-up to the whole audience).
                announcementGroupId,
                audience,
                customNames: pickedNames,
                includeManagers: crosspostManagers && audience !== 'managers' && audience !== 'custom',
                ackRequired, ackDeadline,
                media,
                translations: reviewedTranslation ? { [targetLang]: reviewedTranslation } : null,
                sourceLang: reviewedTranslation ? sourceLang : null,
                translationStatus: reviewedTranslation ? 'reviewed' : (skipTranslation ? 'skipped' : null),
                audienceLabel,
            });
            // Post landed — release the local photo preview blob (audit C11).
            if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
            clearAnnDraft();
            onPosted?.({ announcementGroupId: res.id, recipientCount: res.recipients.length });

        } catch (e) {
            console.error('announcement post failed:', e);
            toast(tx('Send failed: ', 'Error al enviar: ') + (e.message || e), { kind: 'error', duration: 6000 });
        } finally {
            setBusy(false);
        }
    }

    return (
        <ModalPortal>
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
                    {resumeDraft && (
                        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
                            <p className="text-xs font-bold text-amber-800 mb-1">
                                {tx('You have an unfinished announcement.', 'Tienes un anuncio sin terminar.')}
                            </p>
                            <p className="text-[11px] text-amber-700 mb-2 line-clamp-2">
                                “{String(resumeDraft.body || resumeDraft.translation || '').slice(0, 120)}”
                                {' '}{tx('(a photo has to be re-attached)', '(la foto debe adjuntarse de nuevo)')}
                            </p>
                            <div className="flex gap-2">
                                <button onClick={applyResumeDraft}
                                    className="flex-1 py-2 rounded-lg text-sm font-bold bg-dd-green text-white">
                                    {tx('Resume', 'Continuar')}
                                </button>
                                <button onClick={dropResumeDraft}
                                    className="flex-1 py-2 rounded-lg text-sm font-semibold text-dd-text-2 border border-dd-line">
                                    {tx('Discard', 'Descartar')}
                                </button>
                            </div>
                        </div>
                    )}
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
                        {audience === 'custom' && (
                            <div className="mt-2 rounded-lg border border-dd-line bg-dd-bg/50 p-2 max-h-52 overflow-y-auto">
                                <div className="flex items-center justify-between px-1 pb-1.5">
                                    <span className="text-[11px] font-bold text-dd-text-2">
                                        {customNames.size > 0
                                            ? tx(`${customNames.size} selected`, `${customNames.size} seleccionados`)
                                            : tx('Tap the staff who should get this', 'Toca al personal que debe recibirlo')}
                                    </span>
                                    {customNames.size > 0 && (
                                        <button type="button" onClick={() => setCustomNames(new Set())}
                                            className="text-[11px] font-bold text-dd-green hover:text-dd-green-700">
                                            {tx('Clear', 'Limpiar')}
                                        </button>
                                    )}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {pickableStaff.map(name => {
                                        const on = customNames.has(name);
                                        return (
                                            <button key={name} type="button" onClick={() => toggleCustomName(name)}
                                                className={`px-2.5 py-1.5 rounded-full text-xs font-bold border transition ${on
                                                    ? 'bg-dd-green text-white border-dd-green'
                                                    : 'bg-white text-dd-text border-dd-line hover:border-dd-green/50'}`}>
                                                {on ? '✓ ' : ''}{name}
                                            </button>
                                        );
                                    })}
                                    {pickableStaff.length === 0 && (
                                        <span className="text-xs text-dd-text-2 italic px-1">
                                            {tx('No staff found', 'No hay personal')}
                                        </span>
                                    )}
                                </div>
                            </div>
                        )}
                        {audience !== 'managers' && audience !== 'custom' && (
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
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1 flex items-center justify-between">
                            <span>{tx('Message', 'Mensaje')}{sourceLang ? ` (${sourceLang.toUpperCase()})` : ''}</span>
                            {!skipTranslation && (
                                <span className="text-[10px] font-normal text-dd-text-2 italic normal-case tracking-normal">
                                    {tx('Auto-detected', 'Detectado automáticamente')}
                                </span>
                            )}
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

                    {/* Translation review — the manager-review step from
                        Section 14 of the WorkChat blueprint. For
                        announcements (and any ack-required / safety /
                        HR / training broadcast) we want a HUMAN-
                        REVIEWED Spanish translation stored on the
                        message doc, not just an auto-translate at
                        view time. Pattern:
                          1. Manager types message (auto-detect lang)
                          2. We debounce + call translateMessage()
                             with the OTHER language as target
                          3. Show the suggested translation in an
                             EDITABLE textarea
                          4. Manager edits + posts
                          5. We stamp the message doc with
                             translations.{lang} + translationStatus
                             ='reviewed' + translationReviewedBy
                        Why edit-in-place vs review-then-publish:
                        the manager is already mid-flow composing —
                        making them tap a separate "review" page adds
                        friction. Inline edit keeps it one screen.
                        Skip checkbox for when content doesn't need
                        translation (numbers, links, already bilingual).
                        Andrew (2026-05-17). */}
                    <div className={`p-3 rounded-lg border ${skipTranslation
                        ? 'bg-dd-bg border-dd-line'
                        : 'bg-dd-sage-50/50 border-dd-green/30'}`}>
                        <label className="flex items-center justify-between gap-2 cursor-pointer">
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-black text-dd-text">
                                    🌐 {tx(
                                        `${targetLang === 'es' ? 'Spanish' : 'English'} translation`,
                                        `Traducción al ${targetLang === 'es' ? 'español' : 'inglés'}`,
                                    )}
                                </div>
                                <div className="text-[11px] text-dd-text-2 mt-0.5">
                                    {tx(
                                        'Review the auto-suggested translation. Edit as needed before posting.',
                                        'Revisa la traducción sugerida. Edítala si es necesario antes de publicar.',
                                    )}
                                </div>
                            </div>
                            <label className="flex items-center gap-1 text-[10px] text-dd-text-2 cursor-pointer shrink-0">
                                <input
                                    type="checkbox"
                                    checked={skipTranslation}
                                    onChange={(e) => setSkipTranslation(e.target.checked)}
                                    className="w-4 h-4"
                                />
                                {tx('Skip', 'Omitir')}
                            </label>
                        </label>
                        {!skipTranslation && (
                            <>
                                <textarea
                                    rows={4}
                                    value={translation}
                                    onChange={(e) => {
                                        setTranslation(e.target.value);
                                        setTranslationEdited(true);
                                    }}
                                    placeholder={translating
                                        ? tx('Translating…', 'Traduciendo…')
                                        : tx(
                                            `${targetLang === 'es' ? 'Spanish' : 'English'} version will appear here as you type`,
                                            `La versión en ${targetLang === 'es' ? 'español' : 'inglés'} aparecerá aquí mientras escribes`,
                                        )}
                                    className="mt-2 w-full px-3 py-2 rounded-lg border border-dd-green/40 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                                    maxLength={2000}
                                />
                                <div className="mt-1 flex items-center justify-between text-[10px] text-dd-text-2">
                                    <div className="flex items-center gap-2">
                                        {translating && (
                                            <span className="italic">{tx('Translating…', 'Traduciendo…')}</span>
                                        )}
                                        {translationError && (
                                            <span className="text-red-700">
                                                {tx('Auto-translate failed — you can type it manually', 'Auto-traducción falló — escríbelo manualmente')}
                                            </span>
                                        )}
                                        {!translating && !translationError && translation && translationEdited && (
                                            <span className="text-dd-green-700 font-bold">
                                                ✓ {tx('Edited', 'Editado')}
                                            </span>
                                        )}
                                        {!translating && !translationError && translation && !translationEdited && (
                                            <span className="italic">{tx('Auto-suggested', 'Sugerencia automática')}</span>
                                        )}
                                    </div>
                                    {translationEdited && (
                                        <button
                                            type="button"
                                            onClick={handleResuggest}
                                            className="text-dd-green hover:text-dd-green-700 font-bold"
                                        >
                                            ↻ {tx('Re-suggest', 'Sugerir de nuevo')}
                                        </button>
                                    )}
                                </div>
                            </>
                        )}
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
                        disabled={busy || (!body.trim() && !photo) || (audience === 'custom' && customNames.size === 0)}
                        className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-dd-green-700"
                    >
                        {busy ? tx('Posting…', 'Publicando…') : tx('📣 Post Announcement', '📣 Publicar Anuncio')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
