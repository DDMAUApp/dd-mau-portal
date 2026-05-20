// TvConfigsEditor — admin section for managing menu TV displays.
//
// Andrew 2026-05-20 — Phase 2 of menu-TV feature. Each restaurant
// can have multiple TVs (front-of-house, drive-thru-style, bar);
// this editor lets admin add/edit/remove TV configs, generate the
// kiosk URL for each TV, and pick layout + category filter.

import { useState, useEffect, useMemo } from 'react';
import { MENU_DATA } from '../data/menu';
import {
    subscribeTvConfigs, saveTvConfig, deleteTvConfig,
    LAYOUTS, DEFAULT_LAYOUT, DEFAULT_ROTATE_SECONDS, makeTvId,
} from '../data/tvConfigs';
import { toast } from '../toast';

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
                    'Each Fire TV Stick (or any kiosk browser) points at a URL with a TV ID. Each TV can pick its own location, layout, and shown categories. The "webster" and "maryland" IDs always work without a config doc — useful for first boot.',
                    'Cada Fire TV (o navegador kiosko) apunta a una URL con un ID de TV. Cada una elige ubicación, layout y categorías. Los IDs "webster" y "maryland" funcionan sin config — útil para el primer arranque.',
                )}
            </p>

            {/* Quick-start: the two reserved defaults */}
            <div className="bg-sky-50 border border-sky-200 rounded-lg p-2.5 mb-3">
                <div className="text-[10px] font-black uppercase tracking-widest text-sky-800 mb-1.5">
                    {tx('Default kiosk URLs', 'URLs por defecto')}
                </div>
                <div className="space-y-1">
                    {['webster', 'maryland'].map(loc => (
                        <KioskUrlRow key={loc}
                            label={`${LOC_LABEL[loc]} (default)`}
                            url={`${baseUrl}/?tv=${loc}`}
                            tx={tx} />
                    ))}
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
                    initial={editing === 'new' ? null : editing.existing}
                    baseUrl={baseUrl}
                    onClose={() => setEditing(null)}
                    byName={byName}
                    tx={tx} />
            )}
        </div>
    );
}

function TvConfigRow({ cfg, baseUrl, onEdit, tx }) {
    const layoutLabel = cfg.layout === 'rotate' ? '🔄 Rotate'
        : cfg.layout === 'spotlight' ? '⭐ Spotlight'
        : '📋 Dense';
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
                        {layoutLabel}
                    </span>
                    {cfg.showPhotos && (
                        <span className="text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                            📷
                        </span>
                    )}
                </div>
                <button onClick={onEdit}
                    className="px-2.5 py-1 text-[11px] font-bold text-sky-700 hover:bg-sky-100 rounded transition">
                    {tx('Edit', 'Editar')}
                </button>
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
            <button onClick={copy}
                className="px-2 py-1 rounded-lg bg-white border border-sky-300 text-sky-700 text-[10px] font-bold hover:bg-sky-50">
                📋 {tx('Copy', 'Copiar')}
            </button>
        </div>
    );
}

function EditTvConfigModal({ initial, baseUrl, onClose, byName, tx }) {
    const isNew = !initial;
    const [tvId, setTvId] = useState(initial?.tvId || '');
    const [label, setLabel] = useState(initial?.label || '');
    const [location, setLocation] = useState(initial?.location || 'webster');
    const [layout, setLayout] = useState(initial?.layout || DEFAULT_LAYOUT);
    const [showPhotos, setShowPhotos] = useState(initial?.showPhotos === true);
    const [rotateSeconds, setRotateSeconds] = useState(Number(initial?.rotateSeconds) || DEFAULT_ROTATE_SECONDS);
    const [spotlightCategory, setSpotlightCategory] = useState(initial?.spotlightCategory || '');
    const [includeAll, setIncludeAll] = useState(!Array.isArray(initial?.includeCategories) || initial.includeCategories.length === 0);
    const [includeCategories, setIncludeCategories] = useState(initial?.includeCategories || []);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const categories = useMemo(() => MENU_DATA.map(c => c.category), []);

    const previewTvId = isNew
        ? (tvId.trim() || makeTvId(label, location))
        : tvId;
    const previewUrl = previewTvId ? `${baseUrl}/?tv=${previewTvId}` : '';

    const save = async () => {
        if (saving) return;
        const finalId = (tvId.trim() || makeTvId(label, location)).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);
        if (!finalId) {
            toast(tx('TV ID required', 'ID de TV requerido'), { kind: 'error' });
            return;
        }
        if (finalId === 'webster' || finalId === 'maryland') {
            toast(tx('"webster" and "maryland" are reserved IDs. Pick a unique slug (e.g. webster-foh).', '"webster" y "maryland" son IDs reservados.'), { kind: 'error' });
            return;
        }
        setSaving(true);
        try {
            await saveTvConfig({
                tvId: finalId,
                payload: {
                    label: label.trim() || finalId,
                    location,
                    layout,
                    showPhotos: !!showPhotos,
                    rotateSeconds: layout === 'rotate' ? Math.max(3, Math.min(60, Number(rotateSeconds) || DEFAULT_ROTATE_SECONDS)) : null,
                    spotlightCategory: layout === 'spotlight' ? (spotlightCategory || null) : null,
                    includeCategories: includeAll ? null : includeCategories,
                },
                byName,
            });
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
                            {isNew ? tx('Add TV display', 'Agregar TV') : tx('Edit TV display', 'Editar TV')}
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
                                disabled={!isNew}
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

                    {/* URL preview */}
                    {previewUrl && (
                        <div className="bg-sky-50 border border-sky-200 rounded-lg p-2.5">
                            <div className="text-[10px] font-black uppercase tracking-widest text-sky-800 mb-1">
                                {tx('Kiosk URL for this TV', 'URL del kiosko')}
                            </div>
                            <code className="block text-[11px] text-sky-900 break-all font-mono">{previewUrl}</code>
                        </div>
                    )}
                </div>

                <footer className="border-t border-dd-line p-3 flex gap-2 flex-shrink-0">
                    {!isNew && (
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
        </div>
    );
}
