// ChatMedia — photo + video bubbles and the full-screen viewer for chat.
//
// Andrew 2026-09-25: "for some android users cant see the video and i
// can[t] enlarge to make full screen … make sure the attachments in chat is
// all working and fast."
//
// Why a custom viewer: the Android app's WebView (Capacitor 8,
// BridgeWebChromeClient.onShowCustomView) immediately hides native
// full-screen, so the <video> ⤢ button does nothing there. This overlay is
// plain fixed-position CSS — identical on Android, iPhone and web — and
// never touches the native full-screen API.
//
// Why a poster tile instead of an inline <video>: an inline player showed a
// blank box until the (often 100MB+) file streamed. The tile shows the
// poster (sender-captured, or the server's) and loads NOTHING until tapped.
// The viewer plays the server's 720p H.264 copy (playbackUrl — plays on
// every phone) and falls back to the original, then to "Open in browser".

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import ModalPortal from './ModalPortal';
import { openExternalUrl, pushBackHandler } from '../capacitor-bridge';

// Bubble aspect from the media's own size, clamped so a very tall/wide shot
// can't blow up the thread: between 3:4 portrait and 16:9 landscape. The
// numbers reserve space before the bytes arrive (no layout jump).
export function mediaAspect(width, height) {
    const w = Number(width), h = Number(height);
    if (!(w > 0 && h > 0)) return 4 / 3;
    return Math.min(16 / 9, Math.max(3 / 4, w / h));
}

export function formatDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Sources to try in order: the phone-friendly copy first, then the original.
export function videoSources(message) {
    const out = [];
    if (message?.playbackUrl) out.push(message.playbackUrl);
    if (message?.mediaUrl && message.mediaUrl !== message.playbackUrl) out.push(message.mediaUrl);
    return out;
}

// Still being converted? (no phone-friendly copy yet, not failed, recent)
export function videoStillProcessing(message, now = Date.now()) {
    if (!message || message.type !== 'video' || message.playbackUrl || message.transcodeFailedAt) return false;
    const ts = message.createdAt;
    const ms = ts?.toMillis ? ts.toMillis() : (typeof ts?.seconds === 'number' ? ts.seconds * 1000 : null);
    return ms == null ? true : (now - ms) < 15 * 60 * 1000;
}

// A video's upload contentType must be video/* (storage.rules) — some
// Android pickers report '' or application/octet-stream. Normalize from the
// extension when the browser didn't say.
const VIDEO_EXT_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', mkv: 'video/x-matroska' };
export function normalizeVideoMime(type, filename) {
    if (typeof type === 'string' && type.startsWith('video/')) return type;
    const ext = (String(filename || '').split('.').pop() || '').toLowerCase();
    return VIDEO_EXT_MIME[ext] || 'video/mp4';
}

// ── Photo bubble ────────────────────────────────────────────────────────
export const ChatPhoto = memo(function ChatPhoto({ url, width, height, alt = 'Photo', isEs }) {
    const [open, setOpen] = useState(false);
    if (!url) return null;
    const aspect = mediaAspect(width, height);
    return (
        <>
            <img
                src={url}
                alt={alt}
                loading="lazy"
                decoding="async"
                width="320"
                height={Math.round(320 / aspect)}
                onClick={(e) => { e.stopPropagation(); setOpen(true); }}
                style={{ aspectRatio: String(aspect) }}
                className="block rounded-lg w-[260px] max-w-full max-h-[360px] object-cover cursor-zoom-in bg-dd-bg/40"
            />
            {open && (
                <ChatMediaViewer kind="image" sources={[url]} alt={alt} isEs={isEs} onClose={() => setOpen(false)} />
            )}
        </>
    );
});

// ── Video bubble (poster tile) ──────────────────────────────────────────
export const ChatVideoTile = memo(function ChatVideoTile({ message, isEs }) {
    const [open, setOpen] = useState(false);
    const [posterBroken, setPosterBroken] = useState(false);
    const poster = message?.thumbnailUrl || message?.posterUrl || null;
    const aspect = mediaAspect(message?.playbackWidth || message?.width, message?.playbackHeight || message?.height);
    const tx = (en, es) => (isEs ? es : en);
    if (!message?.mediaUrl && !message?.playbackUrl) return null;
    return (
        <>
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen(true); }}
                style={{ aspectRatio: String(aspect) }}
                className="relative block w-[260px] max-w-full max-h-[360px] rounded-lg overflow-hidden bg-neutral-800 active:scale-[0.99] transition"
                aria-label={tx('Play video', 'Reproducir video')}
            >
                {poster && !posterBroken ? (
                    <img src={poster} alt="" loading="lazy" decoding="async" onError={() => setPosterBroken(true)}
                        className="absolute inset-0 w-full h-full object-cover" draggable={false} />
                ) : (
                    <span className="absolute inset-0 bg-gradient-to-br from-neutral-700 to-neutral-900" />
                )}
                <span className="absolute inset-0 flex items-center justify-center">
                    <span className="w-14 h-14 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center shadow-lg">
                        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M8 5v14l11-7z" fill="#fff" /></svg>
                    </span>
                </span>
                {message?.duration > 0 && (
                    <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[11px] font-bold tabular-nums">
                        {formatDuration(message.duration)}
                    </span>
                )}
            </button>
            {open && (
                <ChatMediaViewer
                    kind="video"
                    sources={videoSources(message)}
                    poster={poster && !posterBroken ? poster : undefined}
                    processing={videoStillProcessing(message)}
                    originalUrl={message.mediaUrl}
                    isEs={isEs}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
});

// ── Full-screen viewer ──────────────────────────────────────────────────
// Photos: pinch / double-tap / wheel zoom, drag to pan, swipe down to close.
// Videos: autoplay with controls; on a load error try the next source, then
// offer "Open in browser" (Android's Chrome tab plays what the WebView can't).
export function ChatMediaViewer({ kind, sources, poster, alt = '', processing = false, originalUrl, isEs, onClose }) {
    const tx = (en, es) => (isEs ? es : en);
    const [srcIdx, setSrcIdx] = useState(0);
    const [failed, setFailed] = useState(false);
    const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
    const [dragY, setDragY] = useState(0);
    // The release handler reads the drag distance from a ref — the state
    // copy can be a render behind on a fast swipe (touchmove batches), which
    // made swipe-down-to-close miss.
    const dragYRef = useRef(0);
    const viewRef = useRef(view); viewRef.current = view;
    const gesture = useRef(null);
    const lastTap = useRef(0);
    const videoRef = useRef(null);

    const close = useCallback(() => onClose?.(), [onClose]);

    // Android hardware Back + desktop Esc close the viewer; lock page scroll.
    useEffect(() => {
        const pop = pushBackHandler(() => close());
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        window.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            pop();
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [close]);

    // Start playback (the tap that opened us is the user gesture); if the
    // browser refuses autoplay the controls are there to press.
    const src = sources?.[srcIdx];
    useEffect(() => {
        if (kind !== 'video' || !videoRef.current || !src) return;
        const p = videoRef.current.play?.();
        if (p && typeof p.catch === 'function') p.catch(() => {});
    }, [kind, src]);

    const onVideoError = () => {
        if (srcIdx + 1 < (sources?.length || 0)) setSrcIdx(srcIdx + 1);
        else setFailed(true);
    };

    // ── photo gestures ──
    const clampView = (v) => {
        const scale = Math.min(5, Math.max(1, v.scale));
        if (scale === 1) return { scale: 1, x: 0, y: 0 };
        const maxX = (window.innerWidth * (scale - 1)) / 2;
        const maxY = (window.innerHeight * (scale - 1)) / 2;
        return { scale, x: Math.max(-maxX, Math.min(maxX, v.x)), y: Math.max(-maxY, Math.min(maxY, v.y)) };
    };
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e) => {
        if (kind !== 'image') return;
        const t = e.touches;
        if (t.length === 2) {
            gesture.current = { mode: 'pinch', startDist: dist(t), start: viewRef.current };
        } else if (t.length === 1) {
            const now = Date.now();
            if (now - lastTap.current < 280) {
                // double-tap: toggle 1× ↔ 2.5× around the tap point
                lastTap.current = 0;
                const cur = viewRef.current;
                if (cur.scale > 1) setView({ scale: 1, x: 0, y: 0 });
                else {
                    const cx = t[0].clientX - window.innerWidth / 2;
                    const cy = t[0].clientY - window.innerHeight / 2;
                    setView(clampView({ scale: 2.5, x: -cx * 1.5, y: -cy * 1.5 }));
                }
                gesture.current = null;
                return;
            }
            lastTap.current = now;
            gesture.current = { mode: 'pan', sx: t[0].clientX, sy: t[0].clientY, start: viewRef.current };
        }
    };
    const onTouchMove = (e) => {
        const g = gesture.current;
        if (!g || kind !== 'image') return;
        const t = e.touches;
        if (g.mode === 'pinch' && t.length === 2) {
            setView(clampView({ ...g.start, scale: g.start.scale * (dist(t) / g.startDist) }));
        } else if (g.mode === 'pan' && t.length === 1) {
            const dx = t[0].clientX - g.sx, dy = t[0].clientY - g.sy;
            if (g.start.scale > 1) setView(clampView({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }));
            else { dragYRef.current = Math.max(0, dy); setDragY(dragYRef.current); }   // swipe-down-to-close at 1×
        }
    };
    const onTouchEnd = () => {
        const dy = dragYRef.current;
        dragYRef.current = 0;
        if (kind === 'image' && dy > 110) { close(); return; }
        setDragY(0);
        if (gesture.current?.mode === 'pinch') gesture.current = null;
    };
    const onWheel = (e) => {
        if (kind !== 'image') return;
        const cur = viewRef.current;
        setView(clampView({ ...cur, scale: cur.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15) }));
    };

    const topPad = 'calc(env(safe-area-inset-top, 0px) + 10px)';
    return (
        <ModalPortal>
            <div
                className="fixed inset-0 z-[80] bg-black flex items-center justify-center select-none"
                style={{ opacity: dragY ? Math.max(0.4, 1 - dragY / 400) : 1, touchAction: kind === 'image' ? 'none' : 'auto' }}
                role="dialog"
                aria-modal="true"
                aria-label={kind === 'video' ? tx('Video', 'Video') : tx('Photo', 'Foto')}
                onClick={(e) => { if (e.target === e.currentTarget && kind === 'image' && viewRef.current.scale === 1) close(); }}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                onWheel={onWheel}
            >
                {kind === 'image' && (
                    <img
                        src={src}
                        alt={alt}
                        draggable={false}
                        onDoubleClick={() => setView(viewRef.current.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: 2.5, x: 0, y: 0 })}
                        className="max-w-full max-h-full object-contain"
                        style={{
                            transform: `translate(${view.x}px, ${view.y + dragY}px) scale(${view.scale})`,
                            transition: gesture.current ? 'none' : 'transform 120ms ease-out',
                            willChange: 'transform',
                        }}
                    />
                )}
                {kind === 'video' && !failed && src && (
                    <video
                        key={src}
                        ref={videoRef}
                        src={src}
                        poster={poster}
                        controls
                        autoPlay
                        playsInline
                        preload="auto"
                        controlsList="nofullscreen noremoteplayback"
                        disablePictureInPicture
                        onError={onVideoError}
                        className="w-full h-full max-h-full object-contain bg-black"
                    />
                )}
                {kind === 'video' && (failed || !src) && (
                    <div className="max-w-xs text-center text-white px-6">
                        <div className="text-4xl mb-3">🎬</div>
                        <p className="font-bold">{tx('This video can’t play on this phone yet.', 'Este video no se puede ver en este teléfono todavía.')}</p>
                        <p className="text-sm text-white/70 mt-1">
                            {processing
                                ? tx('It’s still being prepared for all phones — try again in a minute.', 'Todavía se está preparando para todos los teléfonos — inténtalo en un minuto.')
                                : tx('Open it in the browser instead.', 'Ábrelo en el navegador.')}
                        </p>
                        {originalUrl && (
                            <button type="button" onClick={() => openExternalUrl(originalUrl)}
                                className="mt-4 px-4 py-2.5 rounded-full bg-white text-black font-bold text-sm">
                                {tx('Open in browser', 'Abrir en el navegador')}
                            </button>
                        )}
                    </div>
                )}
                {kind === 'video' && processing && !failed && (
                    <div className="absolute left-0 right-0 bottom-0 pb-[calc(env(safe-area-inset-bottom,0px)+64px)] text-center pointer-events-none">
                        <span className="inline-block px-3 py-1 rounded-full bg-black/60 text-white/85 text-[11px]">
                            {tx('Preparing a faster version for all phones…', 'Preparando una versión más rápida para todos…')}
                        </span>
                    </div>
                )}
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); close(); }}
                    style={{ top: topPad }}
                    className="absolute right-3 w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 text-white text-xl font-bold flex items-center justify-center backdrop-blur-sm"
                    aria-label={tx('Close', 'Cerrar')}
                >
                    ✕
                </button>
            </div>
        </ModalPortal>
    );
}
