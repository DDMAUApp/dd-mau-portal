// TvConfigsEditor — admin section for managing menu TV displays.
//
// Andrew 2026-05-20 — Phase 2 of menu-TV feature. Each restaurant
// can have multiple TVs (front-of-house, drive-thru-style, bar);
// this editor lets admin add/edit/remove TV configs, generate the
// kiosk URL for each TV, and pick layout + category filter.

import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { MENU_DATA } from '../data/menu';
import {
    subscribeTvConfigs, saveTvConfig, deleteTvConfig,
    LAYOUTS, MODES, DEFAULT_LAYOUT, DEFAULT_MODE,
    DEFAULT_ROTATE_SECONDS, DEFAULT_IMAGE_ROTATE_SECONDS,
    makeTvId,
} from '../data/tvConfigs';
import { uploadMenuFile } from '../data/menuImageUpload';
import { toast } from '../toast';

// Lazy because the hit-zone editor pulls in a fair amount of UI
// state + per-zone rendering that most admin views don't need.
const HitZoneEditor = lazy(() => import('./HitZoneEditor'));

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

    const baseUrl = useMemo(() => {
        try { return `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}`.replace(/\/$/, ''); }
        catch { return 'https://app.ddmaustl.com'; }
    }, []);

    return (
        <div className="mt-6 mb-4 bg-white border-2 border-sky-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-2xl">📺</span>
                    <h3 className="text-base font-bold text-sky-900">
                        {tx('Menu TV displays', 'Pantallas de menú')}
                    </h3>
                    <span className="text-[10px] font-bold text-sky-700 bg-sky-50 px-2 py-0.5 rounded-full border border-sky-300">
                        {configs.length} {tx('configured', 'configuradas')}
                    </span>
                </div>
                <button onClick={() => setEditing('new')}
                    className="px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-bold hover:bg-sky-700">
                    + {tx('Add TV', 'Agregar TV')}
                </button>
            </div>
            <p className="text-[11px] text-sky-700 mb-3 leading-snug">
                {tx(
                    'Each Fire TV Stick (or any kiosk browser) points at a URL with a TV ID. The "webster" and "maryland" IDs work without any config (data-driven fallback) — but click "Override default" below to replace them with an uploaded PDF/JPEG menu or a custom layout.',
                    'Cada Fire TV apunta a una URL con un ID. Los IDs "webster" y "maryland" funcionan sin config (datos por defecto) — pero usa "Personalizar" para reemplazarlos con un menú PDF/JPEG o un layout personalizado.',
                )}
            </p>

            {/* Quick-start: the two reserved defaults */}
            <div className="bg-sky-50 border border-sky-200 rounded-lg p-2.5 mb-3">
                <div className="text-[10px] font-black uppercase tracking-widest text-sky-800 mb-1.5">
                    {tx('Default kiosk URLs', 'URLs por defecto')}
                </div>
                <div className="space-y-1.5">
                    {['webster', 'maryland'].map(loc => {
                        // Has admin already created a custom config that
                        // overrides this default? If so, show the custom
                        // row instead so the layout/mode it already has
                        // is reflected (and Edit takes admin to that doc).
                        const existing = configs.find(c => c.tvId === loc);
                        if (existing) {
                            return (
                                <TvConfigRow key={loc}
                                    cfg={{ ...existing, label: `${existing.label || LOC_LABEL[loc]} (default override)` }}
                                    baseUrl={baseUrl}
                                    onEdit={() => setEditing({ existing })}
                                    tx={tx} />
                            );
                        }
                        return (
                            <div key={loc} className="space-y-0.5">
                                <KioskUrlRow
                                    label={`${LOC_LABEL[loc]} (default)`}
                                    url={`${baseUrl}/?tv=${loc}`}
                                    tx={tx} />
                                <div className="pl-32">
                                    <button onClick={() => setEditing({ presetForDefault: loc })}
                                        className="text-[10px] font-bold text-sky-700 hover:underline">
                                        ✏ {tx(`Override ${LOC_LABEL[loc]} default with a custom config (image / layout / categories)`, `Personalizar ${LOC_LABEL[loc]}`)}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Custom configured TVs */}
            {configs.length > 0 ? (
                <div className="space-y-1.5">
                    {configs.map(cfg => (
                        <TvConfigRow key={cfg.tvId}
                            cfg={cfg}
                            baseUrl={baseUrl}
                            onEdit={() => setEditing({ existing: cfg })}
                            tx={tx} />
                    ))}
                </div>
            ) : (
                <p className="text-[11px] text-sky-700/70 italic px-2 py-3">
                    {tx(
                        'No custom TVs configured yet. The default Webster + MD Heights URLs above work fine for one TV per restaurant. Add a custom TV if you want a 2nd screen, a different layout, or a category filter.',
                        'Sin TVs personalizadas. Las URLs por defecto bastan para una TV por tienda. Añade una personalizada para 2da pantalla, layout distinto o filtrar categorías.',
                    )}
                </p>
            )}

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
    const pageCount = Array.isArray(cfg.imageUrls) ? cfg.imageUrls.length : 0;
    const modeLabel = isImageMode
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
    // Three modes for the modal:
    //   • brand-new   — initial null. Both tvId + label editable, no Delete.
    //   • preset-for-default — initial.tvId is webster/maryland and the doc
    //     doesn't exist yet. tvId locked (we WANT the slug to be exactly
    //     webster/maryland to override the default), no Delete (nothing
    //     to delete), title says "Override default".
    //   • editing existing — initial is the real doc. tvId locked, Delete
    //     button shown.
    const isPreset = !!initial?._isPresetForDefault;
    const docExists = !!initial && !isPreset;
    const isNew = !initial;
    const tvIdLocked = !isNew;     // both preset + editing-existing lock the slug
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
    const [imageHitZones, setImageHitZones] = useState(Array.isArray(initial?.imageHitZones) ? initial.imageHitZones : []);
    const [hitZoneEditorOpen, setHitZoneEditorOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const categories = useMemo(() => MENU_DATA.map(c => c.category), []);

    const previewTvId = isNew
        ? (tvId.trim() || makeTvId(label, location))
        : tvId;
    const previewUrl = previewTvId ? `${baseUrl}/?tv=${previewTvId}` : '';

    const handleFilePick = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';  // allow re-picking same file
        if (file.size > 30 * 1024 * 1024) {
            toast(tx('File too large (max 30 MB).', 'Archivo muy grande (máx 30 MB).'), { kind: 'error' });
            return;
        }
        setUploading(true);
        try {
            const slugPrefix = (previewTvId || 'tv').replace(/[^a-z0-9-]/g, '-');
            const urls = await uploadMenuFile({ file, folder: 'tv_images', slugPrefix });
            // REPLACE the existing image set — this is "upload a new menu",
            // not "append more pages". Admin can re-upload if they want
            // to swap. Avoids the surprise of old pages lingering.
            setImageUrls(urls);
            toast(tx(`✓ Uploaded ${urls.length} page(s)`, `✓ Subido ${urls.length} página(s)`), { kind: 'success' });
        } catch (err) {
            console.warn('upload failed:', err);
            toast(tx('Upload failed: ', 'Error al subir: ') + (err?.message || ''), { kind: 'error' });
        } finally {
            setUploading(false);
        }
    };

    const removeImageAt = (idx) => {
        setImageUrls(prev => prev.filter((_, i) => i !== idx));
    };

    const save = async () => {
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
            };
            if (mode === MODES.IMAGE) {
                payload.imageUrls = imageUrls;
                payload.imageRotateSeconds = imageUrls.length > 1
                    ? Math.max(3, Math.min(60, Number(imageRotateSeconds) || DEFAULT_IMAGE_ROTATE_SECONDS))
                    : null;
                payload.imageHitZones = imageHitZones;
                // Clear menu-mode fields on the saved doc to avoid stale data.
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
            }
            await saveTvConfig({ tvId: finalId, payload, byName });
            toast(tx('✓ Saved', '✓ Guardado'), { kind: 'success' });
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

                    {/* Mode picker (top-level: data menu vs image) */}
                    <div>
                        <span className="block text-[10px] font-bold uppercase tracking-wide text-dd-text-2 mb-1">
                            {tx('Display mode', 'Modo de pantalla')}
                        </span>
                        <div className="grid grid-cols-2 gap-2">
                            {[
                                { val: MODES.MENU,  emoji: '📋', en: 'Live menu data',   es: 'Datos en vivo',  sub: '86 strikes, photos, edits' },
                                { val: MODES.IMAGE, emoji: '🖼', en: 'Image / PDF menu', es: 'Imagen / PDF',   sub: 'upload designer file' },
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

                    {mode === MODES.IMAGE ? (
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
                                        {uploading ? tx('Uploading…', 'Subiendo…') : (imageUrls.length > 0 ? tx('Replace file', 'Reemplazar') : tx('Choose file', 'Elegir archivo'))}
                                        <input type="file"
                                            accept="image/*,application/pdf"
                                            onChange={handleFilePick}
                                            disabled={uploading}
                                            className="hidden" />
                                    </label>
                                </div>
                                <p className="text-[10px] text-sky-700/80 leading-snug">
                                    {tx(
                                        'Accepts PDF or JPEG/PNG. PDFs are converted to one image per page; multi-page menus auto-rotate on the TV.',
                                        'Acepta PDF o JPEG/PNG. Los PDF se convierten a una imagen por página; los menús de varias páginas rotan automáticamente.',
                                    )}
                                </p>
                                {imageUrls.length > 0 && (
                                    <div className="grid grid-cols-3 gap-2 pt-1">
                                        {imageUrls.map((url, idx) => (
                                            <div key={url} className="relative border border-sky-300 rounded overflow-hidden bg-white">
                                                <img src={url} alt={`page ${idx + 1}`}
                                                    className="w-full h-24 object-contain" />
                                                <div className="absolute top-1 left-1 bg-sky-900/80 text-white text-[9px] font-black px-1.5 py-0.5 rounded">
                                                    {idx + 1}
                                                </div>
                                                <button onClick={() => removeImageAt(idx)} type="button"
                                                    className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-600 text-white text-[10px] font-black hover:bg-red-700">
                                                    ✕
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {imageUrls.length > 1 && (
                                    <label className="block pt-1">
                                        <span className="block text-[10px] font-bold uppercase tracking-wide text-sky-800 mb-0.5">
                                            {tx('Seconds per page', 'Segundos por página')}
                                        </span>
                                        <input type="number" value={imageRotateSeconds}
                                            onChange={(e) => setImageRotateSeconds(Number(e.target.value) || DEFAULT_IMAGE_ROTATE_SECONDS)}
                                            min={3} max={60} step={1}
                                            className="w-full px-2 py-1.5 rounded border border-sky-300 text-sm bg-white font-mono" />
                                    </label>
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
                    <button onClick={save} disabled={saving}
                        className="flex-1 py-2 rounded-lg bg-sky-600 text-white font-bold hover:bg-sky-700 disabled:opacity-40">
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                </footer>
            </div>

            {/* Hit zone editor — opened from the image-mode panel */}
            {hitZoneEditorOpen && (
                <Suspense fallback={null}>
                    <HitZoneEditor
                        imageUrls={imageUrls}
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
                                setImageUrls(result.imageUrls);
                            }
                        }}
                        onClose={() => setHitZoneEditorOpen(false)} />
                </Suspense>
            )}
        </div>
    );
}
