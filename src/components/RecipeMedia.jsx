// RecipeMedia — photo / video thumbnails under a recipe line, opening the
// same full-screen viewer chat uses (pinch-zoom photos; videos play the
// server's 720p copy → original → "Open in browser"; works on the Android
// WebView where native full-screen is dead). See data/recipeMedia.js.
import { memo, useEffect, useState } from 'react';
import { ChatMediaViewer, mediaAspect, formatDuration } from './ChatMedia';
import { fetchVideoResult } from '../data/recipeMediaUpload';

const SIZES = {
    // Ingredients: small squares so the list stays scannable.
    sm: { h: 56, minW: 56, maxW: 56, square: true },
    // Steps: big enough to learn from without opening.
    lg: { h: 132, minW: 100, maxW: 236, square: false },
};

function tileWidth(size, w, h) {
    const s = SIZES[size] || SIZES.lg;
    if (s.square) return s.minW;
    return Math.round(Math.min(s.maxW, Math.max(s.minW, s.h * mediaAspect(w, h))));
}

const PlayBadge = ({ small }) => (
    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className={`${small ? 'w-7 h-7' : 'w-11 h-11'} rounded-full bg-black/55 flex items-center justify-center shadow`}>
            <svg viewBox="0 0 24 24" width={small ? 14 : 20} height={small ? 14 : 20} aria-hidden="true"><path d="M8 5v14l11-7z" fill="#fff" /></svg>
        </span>
    </span>
);

export const RecipeMediaTile = memo(function RecipeMediaTile({ item, size = 'lg', isEs, watermark, onRemove, removeLabel }) {
    const [open, setOpen] = useState(false);
    const [server, setServer] = useState(null);   // recipe_media/{id} (videos without playbackUrl)
    const [broken, setBroken] = useState(false);
    const isVideo = item?.kind === 'video';
    const needsServer = isVideo && !item.playbackUrl;
    useEffect(() => {
        if (!needsServer) return;
        let alive = true;
        fetchVideoResult(item.id).then(r => { if (alive) setServer(r); });
        return () => { alive = false; };
    }, [needsServer, item?.id]);
    if (!item?.url) return null;

    const playbackUrl = item.playbackUrl || server?.playbackUrl || null;
    const poster = item.thumbUrl || item.posterUrl || server?.thumbnailUrl || server?.posterUrl || null;
    const w = tileWidth(size, item.w, item.h);
    const h = (SIZES[size] || SIZES.lg).h;
    const created = server?.createdAt?.toMillis?.() ?? null;
    // "Preparing a faster version…" only while a conversion job is really
    // running (job doc found, no result/failure yet, < 20 min old).
    const processing = isVideo && !playbackUrl && !!server && !server.transcodeFailedAt && (created == null || Date.now() - created < 20 * 60 * 1000);
    const tx = (en, es) => (isEs ? es : en);
    const thumbSrc = isVideo ? poster : item.url;

    return (
        <span className="relative inline-block flex-shrink-0" style={{ width: w, height: h }}>
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen(true); }}
                className="relative block w-full h-full rounded-lg overflow-hidden bg-neutral-800 border border-black/10 active:scale-[0.98] transition"
                aria-label={isVideo ? tx('Play video', 'Reproducir video') : tx('Open photo', 'Abrir foto')}
            >
                {thumbSrc && !broken ? (
                    <img src={thumbSrc} alt="" loading="lazy" decoding="async" draggable={false}
                        onError={() => setBroken(true)} className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                    <span className="absolute inset-0 flex items-center justify-center text-white/70 text-xl">{isVideo ? '🎬' : '📷'}</span>
                )}
                {isVideo && <PlayBadge small={size === 'sm'} />}
                {isVideo && item.dur > 0 && size !== 'sm' && (
                    <span className="absolute bottom-1 right-1 px-1 rounded bg-black/60 text-white text-[10px] font-bold tabular-nums">{formatDuration(item.dur)}</span>
                )}
            </button>
            {onRemove && (
                <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }}
                    className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-red-600 text-white text-xs font-bold shadow flex items-center justify-center"
                    aria-label={removeLabel || tx('Remove', 'Quitar')}>✕</button>
            )}
            {open && (
                <ChatMediaViewer
                    kind={isVideo ? 'video' : 'image'}
                    sources={isVideo ? [playbackUrl, item.url].filter((u, i, a) => u && a.indexOf(u) === i) : [item.url]}
                    poster={isVideo ? (poster || undefined) : undefined}
                    processing={processing}
                    originalUrl={isVideo ? item.url : undefined}
                    isEs={isEs}
                    watermark={watermark}
                    onClose={() => setOpen(false)}
                />
            )}
        </span>
    );
});

// A row of tiles under one line. Renders nothing when the line has none.
export function RecipeMediaStrip({ items, size = 'lg', isEs, watermark, className = '' }) {
    if (!items?.length) return null;
    return (
        <div className={`flex gap-2 overflow-x-auto pb-1 -mb-1 ${className}`} onClick={(e) => e.stopPropagation()}>
            {items.map(it => <RecipeMediaTile key={it.id || it.url} item={it} size={size} isEs={isEs} watermark={watermark} />)}
        </div>
    );
}
