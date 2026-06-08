// TvConfigsEditor — admin section for managing menu TV displays.
//
// Andrew 2026-05-20 — Phase 2 of menu-TV feature. Each restaurant
// can have multiple TVs (front-of-house, drive-thru-style, bar);
// this editor lets admin add/edit/remove TV configs, generate the
// kiosk URL for each TV, and pick layout + category filter.

import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { MENU_DATA as LEGACY_MENU_DATA } from '../data/menu';
import { useMenuConfigLegacy } from '../data/menuConfig';
import {
    subscribeTvConfigs, saveTvConfig, saveTvConfigDraft, deleteTvConfig,
    LAYOUTS, MODES, DEFAULT_LAYOUT, DEFAULT_MODE,
    DEFAULT_ROTATE_SECONDS, DEFAULT_IMAGE_ROTATE_SECONDS,
    makeTvId, findDaypartGaps,
} from '../data/tvConfigs';
import { uploadMenuFile } from '../data/menuImageUpload';
import { generatePromo } from '../data/aiGeneratePromo';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

// Lazy because the hit-zone editor pulls in a fair amount of UI
// state + per-zone rendering that most admin views don't need.
const HitZoneEditor = lazy(() => import('./HitZoneEditor'));
const PictureEditor = lazy(() => import('./PictureEditor'));
const DaypartEditor = lazy(() => import('./DaypartEditor'));

const LOC_LABEL = { webster: 'Webster', maryland: 'MD Heights' };

export default function TvConfigsEditor({ language = 'en', byName }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [configs, setConfigs] = useState([]);
    const [editing, setEditing] = useState(null); // null | { existing? } | 'new'

    useEffect(() => {
        const unsub = subscribeTvConfigs(setConfigs);
        return unsub;
    }, []);

    // Cross-component edit trigger. MenuScreensPage's cards
    // dispatch `ddmau:openTvEditor` when admin clicks "Edit" so
    // this editor jumps straight into the right config without
    // requiring admin to re-find the row below. The detail payload
    // is { tvId, presetLocation }: tvId null → new screen with
    // location preselected; tvId set → edit that existing config.
    // Side-channel rather than props because the dashboard renders
    // the editor lazily through <Suspense> and prop drilling would
    // mean threading state through both halves of the page.
    useEffect(() => {
        // Andrew 2026-05-30 — track deferred-tick timers so they're
        // cancelled if the editor unmounts before the next frame.
        // Without this, fast open-then-close cycles can fire setState
        // after unmount and emit the "memory leak" warning. Tiny edge,
        // belt-and-suspenders fix.
        const pendingTimers = new Set();
        function onOpen(ev) {
            const { tvId, presetLocation } = (ev && ev.detail) || {};
            if (tvId) {
                // Defer one tick so configs are populated if the
                // editor just mounted in the same frame.
                const t = setTimeout(() => {
                    pendingTimers.delete(t);
                    setConfigs(prev => {
                        const existing = prev.find(c => c.tvId === tvId);
                        if (existing) setEditing({ existing });
                        else if (tvId === 'webster' || tvId === 'maryland') setEditing({ presetForDefault: tvId });
                        else setEditing({ presetLocation: presetLocation || 'webster' });
                        return prev;
                    });
                }, 0);
                pendingTimers.add(t);
            } else {
                setEditing({ presetLocation: presetLocation || 'webster' });
            }
        }
        window.addEventListener('ddmau:openTvEditor', onOpen);
        return () => {
            window.removeEventListener('ddmau:openTvEditor', onOpen);
            for (const t of pendingTimers) clearTimeout(t);
            pendingTimers.clear();
        };
    }, []);

    const baseUrl = useMemo(() => {
        try { return `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}`.replace(/\/$/, ''); }
        catch { return 'https://app.ddmaustl.com'; }
    }, []);

    return (
        <div className="mt-6 mb-4 bg-white border-2 border-sky-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-2xl">📺</span>
                <h3 className="text-base font-bold text-sky-900">
                    {tx('Menu TV displays', 'Pantallas de menú')}
                </h3>
                <span className="text-[10px] font-bold text-sky-700 bg-sky-50 px-2 py-0.5 rounded-full border border-sky-300">
                    {configs.length} {tx('configured', 'configuradas')}
                </span>
            </div>
            <p className="text-[11px] text-sky-700 mb-3 leading-snug">
                {tx(
                    'Each Fire TV Stick (or any kiosk browser) points at a URL with a TV ID. The "webster" and "maryland" IDs work without any config (data-driven fallback) — but click "Override default" below to replace them with an uploaded PDF/JPEG menu or a custom layout.',
                    'Cada Fire TV apunta a una URL con un ID. Los IDs "webster" y "maryland" funcionan sin config (datos por defecto) — pero usa "Personalizar" para reemplazarlos con un menú PDF/JPEG o un layout personalizado.',
                )}
            </p>

            {/* Location-grouped TV list. Each location (Webster /
                MD Heights) gets its own panel showing:
                  • the default URL row (or override config if admin
                    already replaced the default)
                  • every custom TV config tied to that location
                  • a "+ Add TV here" button with the location preset
                Layout matches Andrew's mental model of "this
                restaurant has these screens" — easier to scan when
                you've got 3+ TVs at one location. */}
            <div className="space-y-3">
                {['webster', 'maryland'].map(loc => {
                    // Default override (admin saved a config at id='webster'
                    // or id='maryland' to replace the synthetic fallback).
                    const defaultOverride = configs.find(c => c.tvId === loc);
                    // Custom TVs for this location (excluding the
                    // default-override one — that one's rendered separately).
                    const customsForLoc = configs.filter(c =>
                        c.location === loc && c.tvId !== loc);
                    const totalCount = (defaultOverride ? 1 : 0) + customsForLoc.length;
                    return (
                        <div key={loc} className="bg-sky-50 border-2 border-sky-200 rounded-lg p-3">
                            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-base">🏠</span>
                                    <h4 className="text-sm font-black uppercase tracking-widest text-sky-900">
                                        {LOC_LABEL[loc]}
                                    </h4>
                                    <span className="text-[10px] font-bold text-sky-700 bg-white px-2 py-0.5 rounded-full border border-sky-300">
                                        {totalCount} {totalCount === 1 ? tx('TV', 'TV') : tx('TVs', 'TVs')}
                                    </span>
                                </div>
                                <button onClick={() => setEditing({ presetLocation: loc })}
                                    className="px-2.5 py-1 rounded-lg bg-sky-600 text-white text-[11px] font-bold hover:bg-sky-700">
                                    + {tx(`Add ${LOC_LABEL[loc]} TV`, `Agregar TV`)}
                                </button>
                            </div>

                            <div className="space-y-1.5">
                                {/* Default URL row — show as TvConfigRow if
                                    overridden, otherwise as a KioskUrlRow with
                                    an "Override default" link. */}
                                {defaultOverride ? (
                                    <TvConfigRow
                                        cfg={{ ...defaultOverride, label: `${defaultOverride.label || LOC_LABEL[loc]} (default URL)` }}
                                        baseUrl={baseUrl}
                                        onEdit={() => setEditing({ existing: defaultOverride })}
                                        tx={tx} />
                                ) : (
                                    <div className="space-y-0.5">
                                        <KioskUrlRow
                                            label={`${LOC_LABEL[loc]} default`}
                                            url={`${baseUrl}/?tv=${loc}`}
                                            tx={tx} />
                                        <div className="pl-32">
                                            <button onClick={() => setEditing({ presetForDefault: loc })}
                                                className="text-[10px] font-bold text-sky-700 hover:underline">
                                                ✏ {tx('Override this default URL with an image / custom layout', 'Personalizar')}
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {/* Custom TVs for this location */}
                                {customsForLoc.map(cfg => (
                                    <TvConfigRow key={cfg.tvId}
                                        cfg={cfg}
                                        baseUrl={baseUrl}
                                        onEdit={() => setEditing({ existing: cfg })}
                                        tx={tx} />
                                ))}

                                {customsForLoc.length === 0 && !defaultOverride && (
                                    <p className="text-[10px] text-sky-700/60 italic pl-2 pt-1">
                                        {tx(
                                            `No extra TVs configured for ${LOC_LABEL[loc]} yet. Use "Add ${LOC_LABEL[loc]} TV" for a 2nd or 3rd screen (e.g. pictures TV + menu TV + drinks TV).`,
                                            `Sin TVs adicionales para ${LOC_LABEL[loc]}. Usa "Agregar TV" para más pantallas.`,
                                        )}
                                    </p>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {editing && (
                <EditTvConfigModal
                    initial={
                        editing === 'new' ? null
                            : editing.existing ? editing.existing
                            : editing.presetForDefault
                                ? {
                                    // Preset for "Override default" — pre-populate
                                    // with the reserved-loc slug + image mode so the
                                    // admin can drop the PDF and save.
                                    tvId: editing.presetForDefault,
                                    label: LOC_LABEL[editing.presetForDefault] || editing.presetForDefault,
                                    location: editing.presetForDefault,
                                    mode: MODES.IMAGE,
                                    _isPresetForDefault: true,
                                }
                            : editing.presetLocation
                                ? {
                                    // Preset for "+ Add Webster TV" / "+ Add MD
                                    // Heights TV" — fresh new TV but with the
                                    // location pre-filled so admin doesn't have
                                    // to pick. tvId stays editable (admin types
                                    // e.g. "webster-pictures") so they can have
                                    // multiple TVs at the same location.
                                    tvId: '',
                                    label: '',
                                    location: editing.presetLocation,
                                    mode: MODES.MENU,
                                    _isPresetForLocation: true,
                                }
                            : null
                    }
                    baseUrl={baseUrl}
                    onClose={() => setEditing(null)}
                    byName={byName}
                    tx={tx} />
            )}
        </div>
    );
}

function TvConfigRow({ cfg, baseUrl, onEdit, tx }) {
    const isImageMode = cfg.mode === 'image';
    const isSplitMode = cfg.mode === 'split';
    const pageCount = Array.isArray(cfg.imageUrls) ? cfg.imageUrls.length : 0;
    const leftCount = Array.isArray(cfg.split?.leftImageUrls) ? cfg.split.leftImageUrls.length : 0;
    const rightCount = Array.isArray(cfg.split?.rightImageUrls) ? cfg.split.rightImageUrls.length : 0;
    const modeLabel = isSplitMode
        ? `🪟 Split (${leftCount}+${rightCount})`
        : isImageMode
            ? (pageCount > 1 ? `🖼 Image (${pageCount}p)` : '🖼 Image')
            : (cfg.layout === 'rotate' ? '🔄 Rotate'
            : cfg.layout === 'spotlight' ? '⭐ Spotlight'
            : '📋 Dense');
    const url = `${baseUrl}/?tv=${cfg.tvId}`;
    return (
        <div className="border border-sky-200 rounded-lg p-2.5 bg-sky-50/40">
            <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-black text-sky-900">{cfg.label || cfg.tvId}</span>
                    <span className="text-[10px] text-sky-700 font-mono">#{cfg.tvId}</span>
                    <span className="text-[10px] font-bold text-sky-800 bg-white px-1.5 py-0.5 rounded border border-sky-200">
                        {LOC_LABEL[cfg.location] || cfg.location}
                    </span>
                    <span className="text-[10px] font-bold text-sky-800 bg-white px-1.5 py-0.5 rounded border border-sky-200">
                        {modeLabel}
                    </span>
                    {!isImageMode && cfg.showPhotos && (
                        <span className="text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                            📷
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    <a href={url} target="_blank" rel="noopener noreferrer"
                        className="px-2.5 py-1 text-[11px] font-bold text-sky-700 hover:bg-sky-100 rounded transition flex items-center gap-1">
                        👁 {tx('Preview', 'Vista previa')}
                    </a>
                    <button onClick={onEdit}
                        className="px-2.5 py-1 text-[11px] font-bold text-sky-700 hover:bg-sky-100 rounded transition">
                        {tx('Edit', 'Editar')}
                    </button>
                </div>
            </div>
            <KioskUrlRow url={url} tx={tx} />
        </div>
    );
}

function KioskUrlRow({ url, label, tx }) {
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            toast(tx('✓ URL copied', '✓ URL copiada'), { kind: 'success' });
        } catch {
            toast(tx('Copy failed', 'Error al copiar'), { kind: 'error' });
        }
    };
    return (
        <div className="flex items-center gap-2">
            {label && (
                <span className="text-[10px] font-bold text-sky-800 w-32 flex-shrink-0">
                    {label}
                </span>
            )}
            <code className="flex-1 text-[11px] text-sky-900 bg-white px-2 py-1 rounded border border-sky-200 truncate font-mono">
                {url}
            </code>
            <a href={url} target="_blank" rel="noopener noreferrer"
                className="px-2 py-1 rounded-lg bg-white border border-sky-300 text-sky-700 text-[10px] font-bold hover:bg-sky-50 whitespace-nowrap">
                👁 {tx('Preview', 'Vista previa')}
            </a>
            <button onClick={copy}
                className="px-2 py-1 rounded-lg bg-white border border-sky-300 text-sky-700 text-[10px] font-bold hover:bg-sky-50">
                📋 {tx('Copy', 'Copiar')}
            </button>
        </div>
    );
}

function EditTvConfigModal({ initial, baseUrl, onClose, byName, tx }) {
    // Four modes for the modal:
    //   • brand-new           — initial null. Both tvId + label editable, no Delete.
    //   • preset-for-default  — initial.tvId is webster/maryland and doc doesn't
    //                            exist yet. tvId locked (slug MUST stay so it
    //                            overrides the synthetic default), no Delete.
    //   • preset-for-location — initial.location is preset, but tvId is blank
    //                            and editable. Used by "+ Add Webster TV". No
    //                            Delete (no doc yet).
    //   • editing existing    — initial is the real doc. tvId locked, Delete
    //                            button shown.
    const isPresetForDefault = !!initial?._isPresetForDefault;
    const isPresetForLocation = !!initial?._isPresetForLocation;
    const isPreset = isPresetForDefault;     // legacy alias; only default-override locks slug
    const docExists = !!initial && !isPresetForDefault && !isPresetForLocation;
    const isNew = !initial || isPresetForLocation;    // location-preset acts like new
    const tvIdLocked = !isNew;
    const [tvId, setTvId] = useState(initial?.tvId || '');
    const [label, setLabel] = useState(initial?.label || '');
    const [location, setLocation] = useState(initial?.location || 'webster');
    const [mode, setMode] = useState(initial?.mode || DEFAULT_MODE);
    const [layout, setLayout] = useState(initial?.layout || DEFAULT_LAYOUT);
    const [showPhotos, setShowPhotos] = useState(initial?.showPhotos === true);
    const [rotateSeconds, setRotateSeconds] = useState(Number(initial?.rotateSeconds) || DEFAULT_ROTATE_SECONDS);
    const [spotlightCategory, setSpotlightCategory] = useState(initial?.spotlightCategory || '');
    const [includeAll, setIncludeAll] = useState(!Array.isArray(initial?.includeCategories) || initial.includeCategories.length === 0);
    const [includeCategories, setIncludeCategories] = useState(initial?.includeCategories || []);
    // Image-mode state
    const [imageUrls, setImageUrls] = useState(Array.isArray(initial?.imageUrls) ? initial.imageUrls : []);
    const [imageRotateSeconds, setImageRotateSeconds] = useState(Number(initial?.imageRotateSeconds) || DEFAULT_IMAGE_ROTATE_SECONDS);
    // Slideshow transition style. Six options exposed to admin:
    //   fade       — default; 700ms cross-fade between images
    //   cut        — instant swap, no transition
    //   slide-left — new image slides in from the right
    //   slide-up   — new image slides up from below
    //   zoom       — gentle zoom-in on the active slide; fade between
    //   ken-burns  — slow zoom + pan during dwell (the "documentary" look)
    // Stored on tv_config.imageTransition. MenuDisplay.ImageModeLayout
    // reads this and applies the right CSS.
    const [imageTransition, setImageTransition] = useState(initial?.imageTransition || 'fade');
    // Transition duration in ms. Separate from imageRotateSeconds
    // (the dwell-between-slides). Clamped 100..3000 in render so
    // bad values can't break the animation.
    const [imageTransitionMs, setImageTransitionMs] = useState(Number(initial?.imageTransitionMs) || 700);
    // Shuffle the slideshow on each cycle so the same photo doesn't
    // always appear at the same time of day. Stored on
    // tvConfig.imageShuffle as a boolean. Off by default — order
    // matters for menu PDFs (page 1, then 2, then 3); shuffle is
    // strictly a photo-slideshow polish.
    const [imageShuffle, setImageShuffle] = useState(initial?.imageShuffle === true);
    // How the image fills the slide box. 'contain' (default) keeps
    // the full image visible with letterbox bars when the image
    // doesn't match the 16:9 box. 'cover' fills the box, cropping
    // the edges of the image. After our auto-crop step the image
    // SHOULD already be 16:9 so this is mostly a fine-tune knob
    // for edge cases (uploaded an already-cropped image, want
    // edge-to-edge guarantee, etc.).
    const [imageFit, setImageFit] = useState(initial?.imageFit === 'cover' ? 'cover' : 'contain');
    const [imageHitZones, setImageHitZones] = useState(Array.isArray(initial?.imageHitZones) ? initial.imageHitZones : []);
    // Per-picture edit recipes (crop / text / starburst), index-aligned with
    // imageUrls. Each entry is { originalUrl, crop, texts[], bursts[] } | null.
    // Non-destructive: imageUrls[i] holds the BAKED output; the recipe lets the
    // admin reopen and re-edit. See PictureEditor + bakePictureEdits().
    const [imageLayers, setImageLayers] = useState(Array.isArray(initial?.imageLayers) ? initial.imageLayers : []);
    // Index of the image open in the per-picture editor, or null.
    const [pictureEditorIdx, setPictureEditorIdx] = useState(null);
    const [dayparts, setDayparts] = useState(Array.isArray(initial?.dayparts) ? initial.dayparts : []);
    const [split, setSplit] = useState(initial?.split || {
        leftImageUrls: [],
        leftRotateSeconds: 12,
        rightImageUrls: [],
        rightRotateSeconds: 8,
        leftWidthPct: 70,
    });
    const [splitUploading, setSplitUploading] = useState(null); // 'left' | 'right' | null
    const [promoStrip, setPromoStrip] = useState(initial?.promoStrip || {
        enabled: false,
        position: 'bottom',
        textEn: '',
        textEs: '',
        style: 'sage',
        speed: 0,
    });
    // AI promo generation state
    const [aiHint, setAiHint] = useState('');
    const [aiGenerating, setAiGenerating] = useState(false);
    const [aiVariants, setAiVariants] = useState([]);

    const handleGeneratePromo = async () => {
        const hint = aiHint.trim();
        if (!hint) {
            toast(tx('Type a hint first (e.g. "happy hour")', 'Escribe una pista'), { kind: 'error' });
            return;
        }
        setAiGenerating(true);
        try {
            const { variants } = await generatePromo({ hint });
            if (!variants.length) {
                toast(tx('AI returned nothing. Try a different hint.', 'AI no devolvió variantes.'), { kind: 'error' });
            } else {
                setAiVariants(variants);
            }
        } catch (e) {
            console.warn('aiGeneratePromo failed:', e);
            toast(tx('AI failed: ', 'Error AI: ') + (e?.message || ''), { kind: 'error' });
        } finally {
            setAiGenerating(false);
        }
    };

    const applyVariant = (v) => {
        setPromoStrip(p => ({
            ...p,
            enabled: true,
            textEn: v.en || p.textEn,
            textEs: v.es || p.textEs,
        }));
        setAiVariants([]);
        toast(tx('✓ Applied to promo strip', '✓ Aplicado'), { kind: 'success' });
    };
    const [hitZoneEditorOpen, setHitZoneEditorOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    // Andrew 2026-05-30 Phase 1.E — categories list from the live
    // Firestore menu (so newly-added categories show up in the TV
    // include-filter picker), with the hardcoded MENU_DATA as cold-
    // boot fallback.
    const { menu: liveMenu } = useMenuConfigLegacy();
    const categories = useMemo(() => {
        const base = (liveMenu && liveMenu.length > 0) ? liveMenu : LEGACY_MENU_DATA;
        return base.map(c => c.category);
    }, [liveMenu]);

    const previewTvId = isNew
        ? (tvId.trim() || makeTvId(label, location))
        : tvId;
    const previewUrl = previewTvId ? `${baseUrl}/?tv=${previewTvId}` : '';

    const handleFilePick = async (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        e.target.value = '';  // allow re-picking same file
        // 80 MB ceiling — fits restaurant sizzle reels (MP4, ~30-60 MB)
        // and the largest PDF menus. Validate every file up-front so
        // we don't half-upload then bail on a big one.
        for (const file of files) {
            if (file.size > 80 * 1024 * 1024) {
                toast(tx(`File "${file.name}" too large (max 80 MB).`, `Archivo "${file.name}" muy grande (máx 80 MB).`), { kind: 'error' });
                return;
            }
        }
        setUploading(true);
        // Behavior change (Andrew 2026-05-23 audit follow-up): picking
        // multiple files at once APPENDS to the existing imageUrls
        // array. Previously the single-file path REPLACED the whole
        // set, which made it impossible to build a multi-photo
        // slideshow without uploading them as a single multi-page
        // PDF. The "Replace" semantic still exists via Clear All +
        // re-pick. PDFs (multi-page menus) still replace because
        // dropping a new PDF on top of an existing one almost
        // always means "swap to the new menu".
        const hasPdf = files.some(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
        try {
            let cropped = 0, resized = 0, lowRes = 0;
            const newUrls = [];
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const slugPrefix = `${(previewTvId || 'tv').replace(/[^a-z0-9-]/g, '-')}-${Date.now()}-${i}`;
                const urls = await uploadMenuFile({ file, folder: 'tv_images', slugPrefix });
                for (const u of urls) newUrls.push(u);
                const meta = urls.meta;
                if (meta?.wasCropped) cropped++;
                if (meta?.wasResized) resized++;
                if (meta?.isLowResolution) lowRes++;
            }
            // PDF uploads still replace; image batches append.
            if (hasPdf) {
                setImageUrls(newUrls);
                setImageLayers([]);                                   // new menu set — drop old per-picture edits
            } else {
                setImageUrls(prev => [...prev, ...newUrls]);
                setImageLayers(prev => [...prev, ...newUrls.map(() => null)]);   // keep index-aligned
            }
            // Aggregate toast — one line summarizing the whole batch
            // rather than a flood of per-file toasts.
            if (files.length > 1) {
                const noteBits = [];
                if (cropped) noteBits.push(tx(`${cropped} cropped to 16:9`, `${cropped} recortado(s)`));
                if (resized) noteBits.push(tx(`${resized} resized`, `${resized} redimensionado(s)`));
                const note = noteBits.length > 0 ? ` · ${noteBits.join(', ')}` : '';
                toast(tx(
                    `✓ Added ${newUrls.length} image${newUrls.length === 1 ? '' : 's'} to slideshow${note}`,
                    `✓ Agregada${newUrls.length === 1 ? '' : 's'} ${newUrls.length} imagen${newUrls.length === 1 ? '' : 'es'}${note}`,
                ), { kind: 'success' });
            } else {
                // Single-file flow keeps the richer existing toast
                // because it's worth surfacing exactly what
                // happened for a one-off upload.
                const meta = (newUrls).meta || {};
                if (cropped) {
                    toast(tx('✓ Uploaded · cropped to 16:9 for full-screen TV display', '✓ Subido · recortado a 16:9'), { kind: 'success' });
                } else if (resized) {
                    toast(tx('✓ Uploaded · resized for faster TV display', '✓ Subido · redimensionado para TV más rápido'), { kind: 'success' });
                } else {
                    toast(tx(`✓ Uploaded ${newUrls.length} page(s)`, `✓ Subido ${newUrls.length} página(s)`), { kind: 'success' });
                }
            }
            if (lowRes > 0) {
                toast(tx(
                    `⚠ ${lowRes} image${lowRes === 1 ? '' : 's'} below 1280px wide — may look soft on a 1080p TV.`,
                    `⚠ ${lowRes} imagen${lowRes === 1 ? '' : 'es'} bajo 1280px — pueden verse borrosas en TV 1080p.`,
                ), { kind: 'warn' });
            }
        } catch (err) {
            console.warn('upload failed:', err);
            toast(tx('Upload failed: ', 'Error al subir: ') + (err?.message || ''), { kind: 'error' });
        } finally {
            setUploading(false);
        }
    };

    // "Clear all" companion to multi-upload — admin removes the
    // entire image list at once so a fresh slideshow starts clean.
    // Confirms because it's destructive.
    const clearAllImages = () => {
        if (imageUrls.length === 0) return;
        const ok = window.confirm(tx(
            `Remove all ${imageUrls.length} images? (Existing config saves stay until you click Save & Publish.)`,
            `¿Quitar las ${imageUrls.length} imágenes? (La configuración persiste hasta Guardar y publicar.)`,
        ));
        if (ok) { setImageUrls([]); setImageLayers([]); }
    };

    const removeImageAt = (idx) => {
        setImageUrls(prev => prev.filter((_, i) => i !== idx));
        setImageLayers(prev => prev.filter((_, i) => i !== idx));
    };
    // Reorder helpers. We use ↑/↓ buttons rather than HTML5 drag-drop
    // because drag has rough touch support on iPad and a mixed
    // mouse-vs-finger experience for restaurants where the admin is
    // often editing on a phone. Up/down arrows work identically on
    // every device.
    const moveImage = (fromIdx, dir) => {
        const toIdx = fromIdx + dir;
        if (toIdx < 0 || toIdx >= imageUrls.length) return;
        const move = (arr) => {
            const next = [...arr];
            const [item] = next.splice(fromIdx, 1);
            next.splice(toIdx, 0, item);
            return next;
        };
        setImageUrls(prev => move(prev));
        // Reorder the per-picture recipes in lock-step (pad to length first).
        setImageLayers(prev => move(Array.from({ length: imageUrls.length }, (_, i) => prev[i] ?? null)));
    };

    // Split-mode upload handler — supports multi-file pickers
    // (Andrew 2026-05-23). The right side is specifically a carousel
    // and benefits the most from batch upload; the left side is
    // usually a single menu PDF but multi-image stacks are still
    // useful for "menu + ad" combos. PDF uploads still REPLACE for
    // the same reason as the main flow.
    const handleSplitUpload = async (side, e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        e.target.value = '';
        for (const file of files) {
            if (file.size > 80 * 1024 * 1024) {
                toast(tx(`File "${file.name}" too large (max 80 MB).`, `Archivo "${file.name}" muy grande (máx 80 MB).`), { kind: 'error' });
                return;
            }
        }
        const hasPdf = files.some(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
        setSplitUploading(side);
        try {
            const newUrls = [];
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const slugPrefix = `${(previewTvId || 'tv').replace(/[^a-z0-9-]/g, '-')}-${side}-${Date.now()}-${i}`;
                const urls = await uploadMenuFile({ file, folder: 'tv_images', slugPrefix });
                for (const u of urls) newUrls.push(u);
            }
            const key = side === 'left' ? 'leftImageUrls' : 'rightImageUrls';
            setSplit(s => ({
                ...s,
                [key]: hasPdf ? newUrls : [...(s[key] || []), ...newUrls],
            }));
            // One aggregate toast across the batch (works for both
            // single-file and multi-file picks). The verb is "added"
            // for image batches and "replaced" for PDFs to match the
            // actual behavior.
            const verb = hasPdf ? tx('Replaced', 'Reemplazado')
                                 : tx('Added',    'Agregada' + (newUrls.length === 1 ? '' : 's'));
            const sideLabel = side === 'left' ? tx('left', 'izquierda') : tx('right', 'derecha');
            toast(`✓ ${verb}: ${newUrls.length} ${side === 'left' ? sideLabel : sideLabel} · ${newUrls.length === 1 ? tx('image', 'imagen') : tx('images', 'imágenes')}`, { kind: 'success' });
        } catch (err) {
            console.warn('split upload failed:', err);
            toast(tx('Upload failed: ', 'Error al subir: ') + (err?.message || ''), { kind: 'error' });
        } finally {
            setSplitUploading(null);
        }
    };

    // asDraft=true routes through saveTvConfigDraft, which writes
    // to the `draftSnapshot` field instead of the published root.
    // The TV display keeps rendering the previously-published
    // state until the admin hits Publish on the dashboard card.
    // asDraft=false (default) is the legacy save-and-publish flow,
    // preserved verbatim so existing muscle memory still works.
    const save = async ({ asDraft = false } = {}) => {
        if (saving) return;
        const finalId = (tvId.trim() || makeTvId(label, location)).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);
        if (!finalId) {
            toast(tx('TV ID required', 'ID de TV requerido'), { kind: 'error' });
            return;
        }
        // Note: 'webster' and 'maryland' used to be reserved here, but
        // that prevented admin from overriding the synthetic defaults
        // (e.g. swapping the Webster default to image mode with an
        // uploaded PDF). Removed 2026-05-20 per Andrew's request when
        // /?tv=webster was rendering the data-driven fallback instead
        // of his designer PDF.
        if (mode === MODES.IMAGE && imageUrls.length === 0) {
            toast(tx('Upload at least one menu image first.', 'Sube al menos una imagen del menú.'), { kind: 'error' });
            return;
        }
        setSaving(true);
        try {
            const payload = {
                label: label.trim() || finalId,
                location,
                mode,
                promoStrip: promoStrip?.textEn || promoStrip?.textEs ? promoStrip : null,
            };
            if (mode === MODES.IMAGE) {
                payload.imageUrls = imageUrls;
                payload.imageRotateSeconds = imageUrls.length > 1
                    ? Math.max(3, Math.min(60, Number(imageRotateSeconds) || DEFAULT_IMAGE_ROTATE_SECONDS))
                    : null;
                payload.imageTransition = imageTransition || 'fade';
                payload.imageTransitionMs = Math.max(100, Math.min(3000, Number(imageTransitionMs) || 700));
                payload.imageShuffle = imageShuffle === true;
                payload.imageFit = imageFit === 'cover' ? 'cover' : 'contain';
                payload.imageHitZones = imageHitZones;
                payload.imageLayers = imageLayers;
                payload.dayparts = dayparts;
                payload.split = null;
                // Clear menu-mode fields on the saved doc to avoid stale data.
                payload.layout = null;
                payload.showPhotos = null;
                payload.rotateSeconds = null;
                payload.spotlightCategory = null;
                payload.includeCategories = null;
            } else if (mode === MODES.SPLIT) {
                if (!Array.isArray(split.leftImageUrls) || split.leftImageUrls.length === 0) {
                    toast(tx('Upload at least one image for the LEFT side of the split.', 'Sube al menos una imagen para el lado izquierdo.'), { kind: 'error' });
                    setSaving(false);
                    return;
                }
                payload.split = split;
                // Hit zones still live at top level — they apply to the
                // left (menu) side of the split.
                payload.imageHitZones = imageHitZones;
                payload.imageLayers = null;
                payload.imageUrls = null;
                payload.imageRotateSeconds = null;
                payload.dayparts = null;
                payload.layout = null;
                payload.showPhotos = null;
                payload.rotateSeconds = null;
                payload.spotlightCategory = null;
                payload.includeCategories = null;
            } else {
                payload.layout = layout;
                payload.showPhotos = !!showPhotos;
                payload.rotateSeconds = layout === 'rotate' ? Math.max(3, Math.min(60, Number(rotateSeconds) || DEFAULT_ROTATE_SECONDS)) : null;
                payload.spotlightCategory = layout === 'spotlight' ? (spotlightCategory || null) : null;
                payload.includeCategories = includeAll ? null : includeCategories;
                payload.imageUrls = null;
                payload.imageRotateSeconds = null;
                payload.imageHitZones = null;
                payload.imageLayers = null;
                payload.dayparts = null;
                payload.split = null;
            }
            if (asDraft) {
                await saveTvConfigDraft({ tvId: finalId, payload, byName });
                toast(tx('✓ Draft saved — click Publish on the card to push live', '✓ Borrador guardado — toca Publicar para enviar en vivo'), { kind: 'success' });
            } else {
                await saveTvConfig({ tvId: finalId, payload, byName });
                toast(tx('✓ Saved & published', '✓ Guardado y publicado'), { kind: 'success' });
            }
            onClose();
        } catch (e) {
            console.warn('saveTvConfig failed:', e);
            toast(tx('Save failed: ', 'Error al guardar: ') + (e?.message || ''), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        if (deleting || isNew) return;
        const ok = window.confirm(tx(`Delete TV "${initial.label || initial.tvId}"?`, `¿Eliminar TV "${initial.label || initial.tvId}"?`));
        if (!ok) return;
        setDeleting(true);
        try {
            await deleteTvConfig({ tvId: initial.tvId, byName });
            toast(tx('✓ Deleted', '✓ Eliminado'), { kind: 'success' });
            onClose();
        } catch (e) {
            toast(tx('Delete failed', 'Error al eliminar'), { kind: 'error' });
        } finally {
            setDeleting(false);
        }
    };

    const toggleCategory = (cat) => {
        setIncludeCategories(prev => prev.includes(cat)
            ? prev.filter(c => c !== cat)
            : [...prev, cat]);
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/40"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
                <header className="bg-sky-600 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                    <div>
                        <div className="text-base font-black">
                            {isPreset
                                ? tx(`Override ${LOC_LABEL[initial.tvId] || initial.tvId} default`, `Personalizar ${LOC_LABEL[initial.tvId] || initial.tvId}`)
                                : isNew
                                    ? tx('Add TV display', 'Agregar TV')
                                    : tx('Edit TV display', 'Editar TV')}
                        </div>
                        {!isNew && <div className="text-[11px] opacity-90 font-mono">#{initial.tvId}</div>}
                    </div>
                    <button onClick={onClose}
                        className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 transition text-lg font-black">
                        ✕
                    </button>
                </header>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {/* Label + ID */}
                    <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                {tx('Label (display name)', 'Etiqueta')}
                            </span>
                            <input type="text" value={label}
                                onChange={(e) => setLabel(e.target.value)}
                                placeholder={tx('e.g. Webster Front', 'ej. Webster Frente')}
                                className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white" />
                        </label>
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                {tx('TV ID (URL slug)', 'ID de TV')}
                            </span>
                            <input type="text" value={tvId}
                                onChange={(e) => setTvId(e.target.value)}
                                disabled={tvIdLocked}
                                placeholder={makeTvId(label, location)}
                                className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white font-mono disabled:bg-stone-50 disabled:text-stone-500" />
                        </label>
                    </div>

                    {/* Location */}
                    <div>
                        <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-1">
                            {tx('Location (which 86 list)', 'Ubicación')}
                        </span>
                        <div className="grid grid-cols-2 gap-2">
                            {['webster', 'maryland'].map(loc => (
                                <button key={loc} type="button"
                                    onClick={() => setLocation(loc)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition ${
                                        location === loc
                                            ? 'bg-sky-600 text-white border-sky-700'
                                            : 'bg-white text-sky-800 border-sky-200 hover:bg-sky-50'
                                    }`}>
                                    {LOC_LABEL[loc]}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Promo / announcement strip — works in both modes */}
                    <details className="border border-amber-200 rounded-lg overflow-hidden">
                        <summary className="px-3 py-2 cursor-pointer bg-amber-50 text-[11px] font-bold text-amber-900 flex items-center gap-2 hover:bg-amber-100">
                            <span>🎉 {tx('Promo / announcement strip', 'Anuncio')}</span>
                            {promoStrip?.enabled && (promoStrip?.textEn || promoStrip?.textEs) && (
                                <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                                    ✓ {tx('Active', 'Activo')}
                                </span>
                            )}
                            <span className="ml-auto text-amber-700 text-[10px] italic">
                                {tx('e.g. "Happy hour 3-5"', 'ej. "Happy hour 3-5"')}
                            </span>
                        </summary>
                        <div className="p-3 space-y-2 bg-white">
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={promoStrip?.enabled === true}
                                    onChange={(e) => setPromoStrip(p => ({ ...p, enabled: e.target.checked }))}
                                    className="w-4 h-4 accent-amber-600" />
                                <span className="text-[12px] font-bold text-amber-800">
                                    {tx('Show promo strip on this TV', 'Mostrar anuncio')}
                                </span>
                            </label>

                            <div className="grid grid-cols-2 gap-2">
                                <label className="block">
                                    <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                        {tx('Text (English)', 'Texto (EN)')}
                                    </span>
                                    <input type="text"
                                        value={promoStrip?.textEn || ''}
                                        onChange={(e) => setPromoStrip(p => ({ ...p, textEn: e.target.value }))}
                                        placeholder="🎉 Happy hour 3-5pm: half off boba!"
                                        maxLength={200}
                                        className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white" />
                                </label>
                                <label className="block">
                                    <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                        {tx('Text (Español)', 'Texto (ES)')}
                                    </span>
                                    <input type="text"
                                        value={promoStrip?.textEs || ''}
                                        onChange={(e) => setPromoStrip(p => ({ ...p, textEs: e.target.value }))}
                                        placeholder="🎉 Happy hour 3-5pm: ¡boba a mitad de precio!"
                                        maxLength={200}
                                        className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white" />
                                </label>
                            </div>

                            {/* ── AI promo generation ─────────────────
                                Andrew's hint → Claude returns 3 bilingual
                                banner variants → admin picks one which
                                auto-fills the EN/ES inputs above. */}
                            <div className="border-t border-amber-200 pt-2 mt-1 space-y-2">
                                <div className="flex items-center gap-2">
                                    <input type="text"
                                        value={aiHint}
                                        onChange={(e) => setAiHint(e.target.value)}
                                        placeholder={tx('Tell AI what to promote (e.g. "happy hour", "promote catering")', 'Dile a la AI qué promover')}
                                        maxLength={300}
                                        className="flex-1 px-2 py-1.5 rounded border border-purple-300 text-sm bg-white" />
                                    <button type="button"
                                        onClick={handleGeneratePromo}
                                        disabled={aiGenerating || !aiHint.trim()}
                                        className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white text-xs font-black hover:opacity-90 disabled:opacity-40 whitespace-nowrap">
                                        {aiGenerating ? tx('🤖 …', '🤖 …') : tx('🤖 Generate', '🤖 Generar')}
                                    </button>
                                </div>
                                {aiVariants.length > 0 && (
                                    <div className="space-y-1.5">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-purple-800">
                                                {tx(`${aiVariants.length} variants — pick one`, `${aiVariants.length} variantes`)}
                                            </span>
                                            <button type="button" onClick={() => setAiVariants([])}
                                                className="text-[10px] font-bold text-stone-600 hover:underline">
                                                {tx('Dismiss', 'Cerrar')}
                                            </button>
                                        </div>
                                        {aiVariants.map((v, i) => (
                                            <button key={i} type="button"
                                                onClick={() => applyVariant(v)}
                                                className="w-full text-left bg-white border border-purple-200 rounded-md p-2 hover:bg-purple-50 transition">
                                                <div className="text-[12px] font-bold text-dd-text">{v.en}</div>
                                                {v.es && (
                                                    <div className="text-[11px] text-dd-text-2 mt-0.5">{v.es}</div>
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                                <label className="block">
                                    <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                        {tx('Position', 'Posición')}
                                    </span>
                                    <select value={promoStrip?.position || 'bottom'}
                                        onChange={(e) => setPromoStrip(p => ({ ...p, position: e.target.value }))}
                                        className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white">
                                        <option value="bottom">{tx('Bottom', 'Inferior')}</option>
                                        <option value="top">{tx('Top', 'Superior')}</option>
                                    </select>
                                </label>
                                <label className="block">
                                    <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                        {tx('Color', 'Color')}
                                    </span>
                                    <select value={promoStrip?.style || 'sage'}
                                        onChange={(e) => setPromoStrip(p => ({ ...p, style: e.target.value }))}
                                        className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white">
                                        <option value="sage">🟢 DD Green</option>
                                        <option value="red">🔴 Red</option>
                                        <option value="amber">🟡 Amber</option>
                                        <option value="sky">🔵 Blue</option>
                                        <option value="dark">⚫ Dark</option>
                                    </select>
                                </label>
                                <label className="block">
                                    <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                        {tx('Scroll speed', 'Velocidad')}
                                    </span>
                                    <select value={Number(promoStrip?.speed) || 0}
                                        onChange={(e) => setPromoStrip(p => ({ ...p, speed: Number(e.target.value) }))}
                                        className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white">
                                        <option value="0">{tx('Static (no scroll)', 'Estático')}</option>
                                        <option value="40">{tx('Slow', 'Lento')}</option>
                                        <option value="60">{tx('Medium', 'Medio')}</option>
                                        <option value="80">{tx('Fast', 'Rápido')}</option>
                                    </select>
                                </label>
                            </div>
                        </div>
                    </details>

                    {/* Mode picker (top-level: data menu vs image) */}
                    <div>
                        <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-1">
                            {tx('Display mode', 'Modo de pantalla')}
                        </span>
                        <div className="grid grid-cols-3 gap-2">
                            {[
                                { val: MODES.MENU,  emoji: '📋', en: 'Live menu data',   es: 'Datos en vivo',  sub: '86 strikes, photos, edits' },
                                { val: MODES.IMAGE, emoji: '🖼', en: 'Image / PDF menu', es: 'Imagen / PDF',   sub: 'upload designer file' },
                                { val: MODES.SPLIT, emoji: '🪟', en: 'Split (menu + carousel)', es: 'Split',     sub: 'menu + photo side panel' },
                            ].map(m => (
                                <button key={m.val} type="button"
                                    onClick={() => setMode(m.val)}
                                    className={`text-left px-3 py-2 rounded-lg border-2 text-[11px] font-bold transition ${
                                        mode === m.val
                                            ? 'bg-sky-600 text-white border-sky-700'
                                            : 'bg-white text-sky-800 border-sky-200 hover:bg-sky-50'
                                    }`}>
                                    <div>{m.emoji} {tx(m.en, m.es)}</div>
                                    <div className={`text-[9px] font-normal mt-0.5 ${mode === m.val ? 'text-sky-100' : 'text-sky-500'}`}>
                                        {m.sub}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {mode === MODES.SPLIT ? (
                        <>
                            {/* Split-mode UX — two upload slots + width slider */}
                            <div className="bg-sky-50 border-2 border-sky-200 rounded-lg p-3 space-y-3">
                                <p className="text-[11px] text-sky-800 leading-snug">
                                    {tx(
                                        'Split mode: two image sources side-by-side. LEFT = main menu (carries the SOLD OUT / price / QR overlays). RIGHT = secondary carousel (photos, promos, branding loop). Each side has its own upload + rotation speed.',
                                        'Modo dividido: dos imágenes lado a lado. Izquierda = menú principal (con SOLD OUT). Derecha = carrusel secundario.',
                                    )}
                                </p>

                                {/* Width slider */}
                                <label className="block">
                                    <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wide text-sky-800 mb-1">
                                        <span>{tx('Left side width', 'Ancho izquierdo')}</span>
                                        <span className="text-sky-900">{split.leftWidthPct || 70}% / {100 - (split.leftWidthPct || 70)}%</span>
                                    </div>
                                    <input type="range" min="50" max="85" step="5"
                                        value={split.leftWidthPct || 70}
                                        onChange={(e) => setSplit(s => ({ ...s, leftWidthPct: Number(e.target.value) }))}
                                        className="w-full accent-sky-600" />
                                </label>

                                {/* Two upload slots side by side */}
                                <div className="grid grid-cols-2 gap-3">
                                    {['left', 'right'].map(side => {
                                        const urls = split[side === 'left' ? 'leftImageUrls' : 'rightImageUrls'] || [];
                                        const isUploading = splitUploading === side;
                                        return (
                                            <div key={side} className="bg-white border border-sky-200 rounded-lg p-2.5">
                                                <div className="flex items-center justify-between mb-1.5">
                                                    <span className="text-[10px] font-black uppercase tracking-widest text-sky-800">
                                                        {side === 'left' ? tx('Left (menu + 86)', 'Izquierda') : tx('Right (carousel)', 'Derecha')}
                                                    </span>
                                                    <label className={`px-2 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
                                                        isUploading ? 'bg-sky-200 text-sky-600 opacity-60' : 'bg-sky-100 text-sky-700 hover:bg-sky-200'
                                                    }`}>
                                                        {isUploading ? '⏳' : (urls.length > 0 ? tx('+ Add', '+ Agregar') : tx('Upload', 'Subir'))}
                                                        <input type="file" accept="image/*,video/mp4,video/webm,video/quicktime,application/pdf"
                                                            onChange={(e) => handleSplitUpload(side, e)}
                                                            disabled={isUploading}
                                                            multiple
                                                            className="hidden" />
                                                    </label>
                                                </div>
                                                {urls.length > 0 ? (
                                                    <div className="text-[10px] text-sky-700 font-bold">
                                                        {urls.length} {urls.length === 1 ? tx('item', 'item') : tx('items', 'items')}
                                                    </div>
                                                ) : (
                                                    <div className="text-[10px] text-stone-500 italic">
                                                        {tx('No upload yet', 'Sin subir')}
                                                    </div>
                                                )}
                                                {urls.length > 1 && (
                                                    <label className="block mt-2">
                                                        <span className="block text-[9px] font-bold text-sky-700 uppercase tracking-wide mb-0.5">
                                                            {tx('Sec/page', 'Seg/pág')}
                                                        </span>
                                                        <input type="number"
                                                            min={3} max={60}
                                                            value={split[side === 'left' ? 'leftRotateSeconds' : 'rightRotateSeconds'] || (side === 'left' ? 12 : 8)}
                                                            onChange={(e) => setSplit(s => ({
                                                                ...s,
                                                                [side === 'left' ? 'leftRotateSeconds' : 'rightRotateSeconds']: Number(e.target.value) || 8,
                                                            }))}
                                                            className="w-full px-1.5 py-0.5 rounded border border-sky-200 text-[11px] font-mono bg-white" />
                                                    </label>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Hit zone editor for the LEFT side */}
                                {(split.leftImageUrls?.length || 0) > 0 && (
                                    <button onClick={() => setHitZoneEditorOpen(true)} type="button"
                                        className="w-full px-3 py-2 rounded-lg bg-white border-2 border-amber-500 text-amber-700 text-xs font-bold hover:bg-amber-50 transition flex items-center justify-center gap-1.5">
                                        🎯 {imageHitZones.length > 0
                                            ? tx(`Edit SOLD OUT zones on LEFT (${imageHitZones.length} mapped)`, `Editar zonas (${imageHitZones.length})`)
                                            : tx('Map LEFT-side items for SOLD OUT overlays', 'Mapear items')}
                                    </button>
                                )}
                            </div>
                        </>
                    ) : mode === MODES.IMAGE ? (
                        <>
                            {/* Image / PDF upload */}
                            <div className="bg-sky-50 border-2 border-sky-200 rounded-lg p-3 space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[11px] font-bold text-sky-900">
                                        🖼 {tx('Menu file', 'Archivo del menú')}
                                    </span>
                                    <label className={`px-3 py-1.5 rounded-lg text-[11px] font-bold cursor-pointer transition ${
                                        uploading
                                            ? 'bg-sky-300 text-white opacity-60'
                                            : 'bg-sky-600 text-white hover:bg-sky-700'
                                    }`}>
                                        {uploading
                                            ? tx('Uploading…', 'Subiendo…')
                                            : (imageUrls.length > 0
                                                ? tx('+ Add more', '+ Agregar más')
                                                : tx('+ Add images', '+ Agregar imágenes'))}
                                        <input type="file"
                                            accept="image/*,video/mp4,video/webm,video/quicktime,application/pdf"
                                            onChange={handleFilePick}
                                            disabled={uploading}
                                            multiple
                                            className="hidden" />
                                    </label>
                                    {imageUrls.length > 0 && (
                                        <button type="button" onClick={clearAllImages}
                                            className="px-2 py-1 rounded text-[10px] font-bold text-sky-700 hover:bg-sky-100">
                                            {tx('Clear all', 'Quitar todo')}
                                        </button>
                                    )}
                                </div>
                                <p className="text-[10px] text-sky-700/80 leading-snug">
                                    {tx(
                                        'Pick multiple images at once to build a slideshow — they\'ll appear in upload order. PDFs are converted to one image per page and REPLACE the existing set (use Clear All first if mixing PDF + images).',
                                        'Selecciona varias imágenes a la vez para crear un carrusel — aparecen en orden de subida. Los PDF se convierten a una imagen por página y REEMPLAZAN el conjunto existente.',
                                    )}
                                </p>
                                {imageUrls.length > 0 && (
                                    <div className="grid grid-cols-3 gap-2 pt-1">
                                        {imageUrls.map((url, idx) => (
                                            <div key={`${url}_${idx}`} className="relative border border-sky-300 rounded overflow-hidden bg-white">
                                                <img src={url} alt={`page ${idx + 1}`}
                                                    className="w-full h-24 object-contain" />
                                                <div className="absolute top-1 left-1 bg-sky-900/80 text-white text-[9px] font-black px-1.5 py-0.5 rounded">
                                                    {idx + 1}
                                                </div>
                                                <button onClick={() => removeImageAt(idx)} type="button"
                                                    className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-600 text-white text-[10px] font-black hover:bg-red-700">
                                                    ✕
                                                </button>
                                                {/* Reorder up/down — only shown when there's
                                                    actually somewhere to move (no ↑ on first,
                                                    no ↓ on last). Stacked vertically along the
                                                    bottom edge so they don't fight the X close
                                                    button visually. */}
                                                {imageUrls.length > 1 && (
                                                    <div className="absolute bottom-1 right-1 flex flex-col gap-0.5">
                                                        {idx > 0 && (
                                                            <button type="button" onClick={() => moveImage(idx, -1)}
                                                                title={tx('Move up', 'Subir')}
                                                                className="w-5 h-5 rounded bg-white/90 hover:bg-white text-sky-900 text-[10px] font-black border border-sky-300">↑</button>
                                                        )}
                                                        {idx < imageUrls.length - 1 && (
                                                            <button type="button" onClick={() => moveImage(idx, +1)}
                                                                title={tx('Move down', 'Bajar')}
                                                                className="w-5 h-5 rounded bg-white/90 hover:bg-white text-sky-900 text-[10px] font-black border border-sky-300">↓</button>
                                                        )}
                                                    </div>
                                                )}
                                                {/* Per-picture editor — crop / text / starbursts (images only, not video) */}
                                                {!/\.(mp4|webm|mov|m4v)$/i.test(String(url).split('?')[0]) && (
                                                    <>
                                                        <button type="button" onClick={() => setPictureEditorIdx(idx)}
                                                            title={tx('Edit picture', 'Editar imagen')}
                                                            className="absolute bottom-1 left-1 px-1.5 h-5 rounded bg-violet-600 text-white text-[10px] font-black hover:bg-violet-700 flex items-center">
                                                            ✏️ {tx('Edit', 'Editar')}
                                                        </button>
                                                        {Array.isArray(imageLayers) && imageLayers[idx] && (
                                                            <span className="absolute top-1 left-7 bg-violet-600 text-white text-[9px] font-black px-1 rounded"
                                                                title={tx('Has edits', 'Editada')}>★</span>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {imageUrls.length > 1 && (
                                    <>
                                        <label className="block pt-1">
                                            <span className="block text-[10px] font-bold uppercase tracking-wide text-sky-800 mb-0.5">
                                                {tx('Seconds per slide', 'Segundos por imagen')}
                                            </span>
                                            <input type="number" value={imageRotateSeconds}
                                                onChange={(e) => setImageRotateSeconds(Number(e.target.value) || DEFAULT_IMAGE_ROTATE_SECONDS)}
                                                min={3} max={60} step={1}
                                                className="w-full px-2 py-1.5 rounded border border-sky-300 text-sm bg-white font-mono" />
                                        </label>
                                        {/* Slideshow transition picker. 6 options
                                            from "no effect" to "full Ken-Burns
                                            documentary". Visual icons in the chips
                                            so admin sees the look without having
                                            to read the labels. */}
                                        <div className="pt-1">
                                            <span className="block text-[10px] font-bold uppercase tracking-wide text-sky-800 mb-1">
                                                {tx('Transition', 'Transición')}
                                            </span>
                                            <div className="grid grid-cols-3 gap-1.5">
                                                {[
                                                    { id: 'fade',       icon: '🌊', en: 'Fade',       es: 'Atenuar' },
                                                    { id: 'cut',        icon: '✂️', en: 'Cut',        es: 'Corte' },
                                                    { id: 'slide-left', icon: '⏩', en: 'Slide L→R',  es: 'Desliz I→D' },
                                                    { id: 'slide-up',   icon: '⬆️', en: 'Slide up',   es: 'Desliz arriba' },
                                                    { id: 'zoom',       icon: '🔍', en: 'Zoom in',    es: 'Acercar' },
                                                    { id: 'ken-burns',  icon: '🎬', en: 'Ken Burns',  es: 'Ken Burns' },
                                                ].map(opt => (
                                                    <button key={opt.id} type="button"
                                                        onClick={() => setImageTransition(opt.id)}
                                                        className={`px-2 py-1.5 rounded text-[10.5px] font-bold border transition flex flex-col items-center gap-0.5 ${
                                                            imageTransition === opt.id
                                                                ? 'bg-sky-600 text-white border-sky-700'
                                                                : 'bg-white text-sky-800 border-sky-200 hover:bg-sky-50'
                                                        }`}>
                                                        <span className="text-base leading-none">{opt.icon}</span>
                                                        <span className="leading-none">{tx(opt.en, opt.es)}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        {/* Transition duration — only matters for
                                            fade / slide / zoom; ignored for cut.
                                            Default 700ms; range 100–3000ms. */}
                                        {imageTransition !== 'cut' && (
                                            <label className="block pt-1">
                                                <span className="block text-[10px] font-bold uppercase tracking-wide text-sky-800 mb-0.5">
                                                    {tx('Transition speed (ms)', 'Velocidad transición (ms)')}
                                                </span>
                                                <input type="number" value={imageTransitionMs}
                                                    onChange={(e) => setImageTransitionMs(Number(e.target.value) || 700)}
                                                    min={100} max={3000} step={100}
                                                    className="w-full px-2 py-1.5 rounded border border-sky-300 text-sm bg-white font-mono" />
                                                <span className="block text-[10px] text-sky-700/70 mt-0.5">
                                                    {tx('100 = fast · 700 = standard · 2000 = slow + cinematic', '100 = rápido · 700 = estándar · 2000 = lento + cinematográfico')}
                                                </span>
                                            </label>
                                        )}

                                        {/* Shuffle toggle + Fit picker — two more slideshow
                                            polish knobs. Same row to save vertical space. */}
                                        <div className="grid grid-cols-2 gap-2 pt-1">
                                            <label className="flex items-start gap-2 px-2 py-1.5 rounded border border-sky-200 bg-white cursor-pointer hover:bg-sky-50">
                                                <input type="checkbox"
                                                    checked={imageShuffle}
                                                    onChange={(e) => setImageShuffle(e.target.checked)}
                                                    className="mt-0.5 w-3.5 h-3.5 accent-sky-600" />
                                                <div className="min-w-0">
                                                    <div className="text-[11px] font-black text-sky-900 leading-none">
                                                        🔀 {tx('Shuffle', 'Mezclar')}
                                                    </div>
                                                    <div className="text-[10px] text-sky-700/70 mt-0.5 leading-snug">
                                                        {tx('Random order', 'Orden aleatorio')}
                                                    </div>
                                                </div>
                                            </label>
                                            <div>
                                                <div className="text-[10px] font-bold uppercase tracking-wide text-sky-800 mb-0.5">
                                                    {tx('Fit', 'Ajuste')}
                                                </div>
                                                <div className="grid grid-cols-2 gap-1">
                                                    {[
                                                        { id: 'contain', en: 'Fit',  es: 'Caber',  hint: tx('letterbox', 'caja') },
                                                        { id: 'cover',   en: 'Fill', es: 'Llenar', hint: tx('crop edges', 'recorta') },
                                                    ].map(opt => (
                                                        <button key={opt.id} type="button"
                                                            onClick={() => setImageFit(opt.id)}
                                                            title={opt.hint}
                                                            className={`px-2 py-1 rounded text-[10px] font-bold border transition ${
                                                                imageFit === opt.id
                                                                    ? 'bg-sky-600 text-white border-sky-700'
                                                                    : 'bg-white text-sky-800 border-sky-200 hover:bg-sky-50'
                                                            }`}>
                                                            {tx(opt.en, opt.es)}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </>
                                )}

                                {/* Hit zone editor entry — only available after at least one image is uploaded */}
                                {imageUrls.length > 0 && (
                                    <div className="pt-1.5">
                                        <button onClick={() => setHitZoneEditorOpen(true)} type="button"
                                            className="w-full px-3 py-2 rounded-lg bg-white border-2 border-sky-600 text-sky-700 text-xs font-bold hover:bg-sky-100 transition flex items-center justify-center gap-1.5">
                                            🎯 {imageHitZones.length > 0
                                                ? tx(`Edit SOLD OUT zones (${imageHitZones.length} mapped)`, `Editar zonas SOLD OUT (${imageHitZones.length})`)
                                                : tx('Map items for SOLD OUT overlays', 'Mapear items para tachados')}
                                        </button>
                                        {imageHitZones.length === 0 && (
                                            <p className="text-[10px] text-sky-700/70 mt-1 italic leading-snug">
                                                {tx(
                                                    'Optional. Map each item on the image to its menu name so SOLD OUT stickers can overlay automatically when 86\'d. Without zones, the TV just shows the menu image as-is.',
                                                    'Opcional. Mapea cada item en la imagen para que aparezca SOLD OUT cuando se acabe.',
                                                )}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>
                            <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 leading-snug">
                                ⚠️ {tx(
                                    'Image mode shows the file as-is. Live 86 strike-throughs and price edits do NOT apply (they\'re menu-data features). Re-upload when the designer ships a new file.',
                                    'El modo imagen muestra el archivo tal cual. Los tachados de 86 y cambios de precio NO se aplican aquí. Vuelve a subir cuando llegue un menú nuevo.',
                                )}
                            </p>

                            {/* ── Daypart scheduling ───────────────────
                                Optional. When dayparts are configured,
                                MenuDisplay picks the one covering the
                                current hour and shows ITS imageUrls /
                                hitZones (so lunch + dinner can be totally
                                separate menus). Falls back to the top-level
                                upload when no daypart matches the hour. */}
                            <div className="border-2 border-sky-200 rounded-lg p-3 bg-white">
                                <Suspense fallback={<div className="text-xs text-dd-text-2 italic py-2">Loading daypart editor…</div>}>
                                    <DaypartEditor
                                        dayparts={dayparts}
                                        onChange={setDayparts}
                                        slugPrefix={tvId || makeTvId(label, location)}
                                        language={tx('en', 'es') === 'es' ? 'es' : 'en'} />
                                </Suspense>
                                {/* Gap warning — 2026-05-23. If dayparts
                                    don't cover all 24 hours, MenuDisplay's
                                    new resolveActiveOrLastDaypart falls
                                    back to the most-recent past daypart so
                                    the TV doesn't blank — but admin still
                                    wants to know they have a coverage gap
                                    so they can decide if that's intentional
                                    (overnight = closed) or a mistake. */}
                                {(() => {
                                    if (!dayparts || dayparts.length === 0) return null;
                                    const gaps = findDaypartGaps(dayparts);
                                    // Don't show a warning for fully
                                    // uncovered (admin probably hasn't
                                    // added any dayparts yet) — only when
                                    // SOME hours are covered but gaps exist.
                                    if (gaps.length === 0 || gaps.length >= 48) return null;
                                    const fmt = (h) => {
                                        const hh = Math.floor(h);
                                        const mm = Math.round((h - hh) * 60);
                                        return `${hh.toString().padStart(2,'0')}:${mm.toString().padStart(2,'0')}`;
                                    };
                                    return (
                                        <div className="mt-2 p-2 rounded-lg border border-amber-300 bg-amber-50 text-[11px] text-amber-900">
                                            <div className="font-bold mb-1">
                                                ⚠️ {tx(
                                                    `Schedule gap${gaps.length > 1 ? 's' : ''} detected:`,
                                                    `Hueco${gaps.length > 1 ? 's' : ''} en horario:`,
                                                )}
                                            </div>
                                            <ul className="list-disc pl-4 space-y-0.5">
                                                {gaps.slice(0, 5).map((g, i) => (
                                                    <li key={i}>
                                                        {fmt(g.startHour)}–{fmt(g.endHour)}
                                                    </li>
                                                ))}
                                            </ul>
                                            <p className="mt-1 text-amber-800">
                                                {tx(
                                                    'During gaps, the TV will keep showing the previous daypart\'s content (won\'t blank). Add a daypart to control what shows then.',
                                                    'Durante huecos, la TV seguirá mostrando el contenido anterior (no se pondrá en blanco).',
                                                )}
                                            </p>
                                        </div>
                                    );
                                })()}
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Layout */}
                            <div>
                                <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-1">
                                    {tx('Layout', 'Layout')}
                                </span>
                                <div className="grid grid-cols-3 gap-2">
                                    {[
                                        { val: LAYOUTS.DENSE,     emoji: '📋', en: 'Dense',     es: 'Denso',     sub: 'all-on-one' },
                                        { val: LAYOUTS.ROTATE,    emoji: '🔄', en: 'Rotate',    es: 'Rotar',     sub: 'auto-cycle' },
                                        { val: LAYOUTS.SPOTLIGHT, emoji: '⭐', en: 'Spotlight', es: 'Destacar',  sub: 'one big +' },
                                    ].map(l => (
                                        <button key={l.val} type="button"
                                            onClick={() => setLayout(l.val)}
                                            className={`px-2 py-1.5 rounded-lg text-[11px] font-bold border-2 transition ${
                                                layout === l.val
                                                    ? 'bg-sky-600 text-white border-sky-700'
                                                    : 'bg-white text-sky-800 border-sky-200 hover:bg-sky-50'
                                            }`}>
                                            <div>{l.emoji} {tx(l.en, l.es)}</div>
                                            <div className={`text-[9px] font-normal mt-0.5 ${layout === l.val ? 'text-sky-100' : 'text-sky-500'}`}>
                                                {l.sub}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Layout-specific options */}
                            {layout === LAYOUTS.ROTATE && (
                                <label className="block">
                                    <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                        {tx('Seconds per page', 'Segundos por página')}
                                    </span>
                                    <input type="number" value={rotateSeconds}
                                        onChange={(e) => setRotateSeconds(Number(e.target.value) || DEFAULT_ROTATE_SECONDS)}
                                        min={3} max={60} step={1}
                                        className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white font-mono" />
                                </label>
                            )}
                            {layout === LAYOUTS.SPOTLIGHT && (
                                <label className="block">
                                    <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-0.5">
                                        {tx('Hero category', 'Categoría destacada')}
                                    </span>
                                    <select value={spotlightCategory}
                                        onChange={(e) => setSpotlightCategory(e.target.value)}
                                        className="w-full px-2 py-1.5 rounded border border-dd-line text-sm bg-white">
                                        <option value="">{tx('First category (auto)', 'Primera categoría (auto)')}</option>
                                        {categories.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </label>
                            )}

                            {/* Photos */}
                            <label className="flex items-center gap-2 p-2 rounded-lg bg-amber-50 border border-amber-200">
                                <input type="checkbox" checked={showPhotos}
                                    onChange={(e) => setShowPhotos(e.target.checked)}
                                    className="w-4 h-4 accent-amber-600" />
                                <span className="text-[12px] font-bold text-amber-800">
                                    📷 {tx('Show item photos when present', 'Mostrar fotos cuando existen')}
                                </span>
                            </label>

                            {/* Category filter */}
                            <div>
                                <label className="flex items-center gap-2 mb-1.5">
                                    <input type="checkbox" checked={includeAll}
                                        onChange={(e) => setIncludeAll(e.target.checked)}
                                        className="w-4 h-4 accent-sky-600" />
                                    <span className="text-[12px] font-bold text-dd-text">
                                        {tx('Show all categories', 'Mostrar todas las categorías')}
                                    </span>
                                </label>
                                {!includeAll && (
                                    <div className="grid grid-cols-3 gap-1.5 pl-6">
                                        {categories.map(c => (
                                            <button key={c} type="button"
                                                onClick={() => toggleCategory(c)}
                                                className={`px-2 py-1 rounded text-[10px] font-bold border transition ${
                                                    includeCategories.includes(c)
                                                        ? 'bg-sky-600 text-white border-sky-700'
                                                        : 'bg-white text-sky-800 border-sky-200 hover:bg-sky-50'
                                                }`}>
                                                {c}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    {/* URL preview */}
                    {previewUrl && (
                        <div className="bg-sky-50 border border-sky-200 rounded-lg p-2.5">
                            <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                                <span className="text-[10px] font-black uppercase tracking-widest text-sky-800">
                                    {tx('Kiosk URL for this TV', 'URL del kiosko')}
                                </span>
                                {(docExists || isPreset) && (
                                    <a href={previewUrl} target="_blank" rel="noopener noreferrer"
                                        className="px-2 py-0.5 rounded bg-white border border-sky-300 text-sky-700 text-[10px] font-bold hover:bg-sky-100 whitespace-nowrap">
                                        👁 {tx('Preview', 'Vista previa')}
                                    </a>
                                )}
                            </div>
                            <code className="block text-[11px] text-sky-900 break-all font-mono">{previewUrl}</code>
                            {isNew && (
                                <p className="text-[10px] text-sky-700/70 italic mt-1">
                                    {tx('Save first to preview this TV in a new tab.', 'Guarda primero para previsualizar.')}
                                </p>
                            )}
                            {isPreset && (
                                <p className="text-[10px] text-sky-700/70 italic mt-1">
                                    {tx('This will replace the default kiosk URL once you Save.', 'Reemplazará la URL por defecto al guardar.')}
                                </p>
                            )}
                        </div>
                    )}
                </div>

                <footer className="border-t border-dd-line p-3 flex gap-2 flex-shrink-0">
                    {docExists && (
                        <button onClick={remove} disabled={deleting}
                            className="px-3 py-2 rounded-lg bg-white border border-red-300 text-red-700 text-xs font-bold hover:bg-red-50 disabled:opacity-40">
                            {deleting ? tx('Deleting…', 'Borrando…') : tx('Delete', 'Eliminar')}
                        </button>
                    )}
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-white border border-dd-line text-dd-text font-bold hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    {/* Save as Draft — writes to draftSnapshot so the
                        TV keeps showing the previous live version.
                        Less prominent than the main Save (smaller +
                        outlined) so existing muscle-memory still
                        lands on Save & Publish. Reads "Draft" not
                        "Save as Draft" to fit the narrower button. */}
                    <button onClick={() => save({ asDraft: true })} disabled={saving}
                        title={tx('Save without publishing — TV keeps showing the current live version', 'Guardar sin publicar — TV sigue mostrando la versión actual')}
                        className="px-3 py-2 rounded-lg bg-white border border-sky-300 text-sky-700 text-xs font-bold hover:bg-sky-50 disabled:opacity-40">
                        📝 {tx('Draft', 'Borrador')}
                    </button>
                    <button onClick={() => save()} disabled={saving}
                        className="flex-1 py-2 rounded-lg bg-sky-600 text-white font-bold hover:bg-sky-700 disabled:opacity-40">
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save & Publish', 'Guardar y publicar')}
                    </button>
                </footer>
            </div>

            {/* Hit zone editor — sources images from image-mode OR
                the LEFT side of split-mode, whichever is active. */}
            {hitZoneEditorOpen && (
                <Suspense fallback={null}>
                    <HitZoneEditor
                        imageUrls={mode === MODES.SPLIT ? (split.leftImageUrls || []) : imageUrls}
                        initialZones={imageHitZones}
                        language={tx('en', 'es') === 'es' ? 'es' : 'en'}
                        onSave={(result) => {
                            // result = { zones, imageUrls }. The imageUrls
                            // entry may have been swapped if the editor's
                            // save flow baked price overrides into the
                            // image — bring both back into modal state.
                            if (result && Array.isArray(result.zones)) {
                                setImageHitZones(result.zones);
                            }
                            if (result && Array.isArray(result.imageUrls)) {
                                if (mode === MODES.SPLIT) {
                                    setSplit(s => ({ ...s, leftImageUrls: result.imageUrls }));
                                } else {
                                    setImageUrls(result.imageUrls);
                                }
                            }
                        }}
                        onClose={() => setHitZoneEditorOpen(false)} />
                </Suspense>
            )}

            {/* Per-picture editor (crop / text / starbursts). Bakes edits into a
                new image and stores the recipe in imageLayers for re-editing. */}
            {pictureEditorIdx !== null && imageUrls[pictureEditorIdx] && (
                <Suspense fallback={null}>
                    <PictureEditor
                        imageUrl={imageUrls[pictureEditorIdx]}
                        originalUrl={imageLayers?.[pictureEditorIdx]?.originalUrl || imageUrls[pictureEditorIdx]}
                        initialRecipe={imageLayers?.[pictureEditorIdx] || null}
                        slugPrefix={`${(previewTvId || 'tv').replace(/[^a-z0-9-]/g, '-')}-p${pictureEditorIdx + 1}`}
                        language={tx('en', 'es') === 'es' ? 'es' : 'en'}
                        onSave={(newUrl, recipe) => {
                            const idx = pictureEditorIdx;
                            setImageUrls(prev => prev.map((u, i) => (i === idx ? newUrl : u)));
                            setImageLayers(prev => {
                                const next = Array.from({ length: Math.max(prev.length, idx + 1) }, (_, i) => prev[i] ?? null);
                                next[idx] = recipe;
                                return next;
                            });
                        }}
                        onClose={() => setPictureEditorIdx(null)} />
                </Suspense>
            )}
        </div>
        </ModalPortal>
    );
}
