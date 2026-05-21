// DaypartEditor — manages a TV's time-of-day schedule.
//
// Andrew 2026-05-20: "see what [the SaaS leaders] are doing and lets
// do it better". Daypart scheduling is the single biggest universal
// feature on Raydiant / ScreenCloud / Samsung VXT — every restaurant
// signage tool auto-switches the menu by time of day. This adds it
// to DD Mau Portal AND gives each daypart its own image upload +
// hit zones (so lunch and dinner can be entirely different PDFs
// with their own SOLD OUT mappings) — something the leaders don't
// always offer cleanly.
//
// ─── UX ──────────────────────────────────────────────────────
// Each row = one daypart:
//   Label | Start (24h) | End (24h) | Upload PDF/JPEG | Map items | ✕
// Click "+ Add daypart" or pick a preset (Breakfast / Lunch / Dinner /
// Happy Hour / Late Night) to drop a row. Edit hours inline.
// The top "Currently active" pill shows which daypart will display
// right now based on the local time.

import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { PRESET_DAYPARTS, resolveActiveDaypart } from '../data/tvConfigs';
import { uploadMenuFile } from '../data/menuImageUpload';
import { toast } from '../toast';

const HitZoneEditor = lazy(() => import('./HitZoneEditor'));

export default function DaypartEditor({
    dayparts = [],
    onChange,
    slugPrefix = 'tv',
    language = 'en',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [editingZonesIdx, setEditingZonesIdx] = useState(null);
    const [uploadingIdx, setUploadingIdx] = useState(null);
    const [now, setNow] = useState(() => new Date());

    // Tick clock every 30s so the "Currently active" pill stays current
    // without admin needing to refresh.
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 30_000);
        return () => clearInterval(t);
    }, []);

    const active = useMemo(() => resolveActiveDaypart(dayparts, now), [dayparts, now]);

    const update = (idx, patch) => {
        onChange(dayparts.map((d, i) => i === idx ? { ...d, ...patch } : d));
    };

    const remove = (idx) => {
        const ok = window.confirm(tx(
            `Remove "${dayparts[idx]?.label || 'this daypart'}"?`,
            `¿Quitar "${dayparts[idx]?.label || 'daypart'}"?`,
        ));
        if (!ok) return;
        onChange(dayparts.filter((_, i) => i !== idx));
    };

    const addBlank = () => {
        onChange([...dayparts, {
            label: tx('New daypart', 'Nuevo'),
            startHour: 11, endHour: 14,
            imageUrls: [], imageHitZones: [],
        }]);
    };

    const addPreset = (preset) => {
        // Don't add if already present by label.
        if (dayparts.some(d => d.label === preset.label)) {
            toast(tx(`"${preset.label}" already exists`, `"${preset.label}" ya existe`), { kind: 'error' });
            return;
        }
        onChange([...dayparts, {
            label: preset.label,
            startHour: preset.startHour,
            endHour: preset.endHour,
            imageUrls: [],
            imageHitZones: [],
        }]);
    };

    const handleUpload = async (idx, file) => {
        if (!file) return;
        if (file.size > 80 * 1024 * 1024) {
            toast(tx('File too large (max 80 MB).', 'Archivo muy grande (máx 80 MB).'), { kind: 'error' });
            return;
        }
        setUploadingIdx(idx);
        try {
            const urls = await uploadMenuFile({
                file,
                folder: 'tv_images',
                slugPrefix: `${slugPrefix}_${(dayparts[idx]?.label || 'daypart').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            });
            update(idx, { imageUrls: urls });
            toast(tx(`✓ Uploaded ${urls.length} page(s)`, `✓ Subido ${urls.length}`), { kind: 'success' });
        } catch (err) {
            console.warn('daypart upload failed:', err);
            toast(tx('Upload failed: ', 'Error: ') + (err?.message || ''), { kind: 'error' });
        } finally {
            setUploadingIdx(null);
        }
    };

    return (
        <div className="space-y-2">
            {/* Currently-active pill */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-[10px] font-bold uppercase tracking-wide text-dd-text-2">
                    {tx('Daypart schedule', 'Horario por daypart')}
                </div>
                {dayparts.length > 0 && (
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        active
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                            : 'bg-stone-100 text-stone-700 border border-stone-300'
                    }`}>
                        🟢 {active
                            ? tx(`Now: ${active.label}`, `Ahora: ${active.label}`)
                            : tx('No daypart active right now', 'Ninguno activo')}
                    </span>
                )}
            </div>

            <p className="text-[10px] text-dd-text-2/80 leading-snug">
                {tx(
                    'Each daypart has its OWN menu image, hit zones, and rotation speed. MenuDisplay switches automatically based on the local time. Hours are 24-hour format (e.g. 11 = 11am, 14 = 2pm, 22 = 10pm). Wraps midnight is fine (22→4 covers late night).',
                    'Cada daypart tiene su propio menú, zonas y velocidad. La pantalla cambia automáticamente.',
                )}
            </p>

            {/* Daypart rows */}
            {dayparts.length === 0 ? (
                <p className="text-[11px] text-dd-text-2/70 italic px-2 py-3 border-2 border-dashed border-dd-line rounded-lg">
                    {tx(
                        'No dayparts configured — the TV will use the main image config above. Add a daypart to auto-switch between breakfast / lunch / dinner menus.',
                        'Sin dayparts — la TV usa el menú principal. Agrega uno para cambio automático por hora.',
                    )}
                </p>
            ) : (
                <div className="space-y-1.5">
                    {dayparts.map((dp, idx) => {
                        const isActive = active === dp;
                        const uploading = uploadingIdx === idx;
                        const hasImages = Array.isArray(dp.imageUrls) && dp.imageUrls.length > 0;
                        return (
                            <div key={idx}
                                className={`border-2 rounded-lg p-2 ${
                                    isActive ? 'border-emerald-400 bg-emerald-50/50' : 'border-dd-line bg-white'
                                }`}>
                                <div className="grid grid-cols-12 gap-2 items-center">
                                    {/* Label */}
                                    <input type="text" value={dp.label || ''}
                                        onChange={(e) => update(idx, { label: e.target.value })}
                                        placeholder={tx('Label', 'Etiqueta')}
                                        className="col-span-3 px-2 py-1 rounded border border-dd-line text-xs font-bold bg-white" />
                                    {/* Start / End hours */}
                                    <div className="col-span-3 flex items-center gap-1 text-xs">
                                        <input type="number" value={dp.startHour ?? 11}
                                            onChange={(e) => update(idx, { startHour: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })}
                                            min={0} max={23} step={1}
                                            className="w-12 px-1.5 py-1 rounded border border-dd-line text-center font-mono bg-white" />
                                        <span className="text-dd-text-2">→</span>
                                        <input type="number" value={dp.endHour ?? 14}
                                            onChange={(e) => update(idx, { endHour: Math.max(0, Math.min(24, Number(e.target.value) || 0)) })}
                                            min={0} max={24} step={1}
                                            className="w-12 px-1.5 py-1 rounded border border-dd-line text-center font-mono bg-white" />
                                        <span className="text-[9px] text-dd-text-2 ml-0.5">24h</span>
                                    </div>
                                    {/* Pages preview / Upload */}
                                    <div className="col-span-4">
                                        {hasImages ? (
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-[10px] font-bold text-dd-text">
                                                    {dp.imageUrls.length} {dp.imageUrls.length === 1 ? tx('page', 'página') : tx('pages', 'páginas')}
                                                </span>
                                                {dp.imageHitZones?.length > 0 && (
                                                    <span className="text-[9px] text-emerald-700 font-bold">
                                                        · {dp.imageHitZones.length} {tx('mapped', 'mapeados')}
                                                    </span>
                                                )}
                                                <label className={`ml-auto px-2 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
                                                    uploading ? 'bg-sky-200 text-sky-600 opacity-60'
                                                              : 'bg-sky-100 text-sky-700 hover:bg-sky-200'
                                                }`}>
                                                    {uploading ? '⏳' : tx('Replace', 'Reemplazar')}
                                                    <input type="file" accept="image/*,video/mp4,video/webm,video/quicktime,application/pdf"
                                                        onChange={(e) => { handleUpload(idx, e.target.files?.[0]); e.target.value = ''; }}
                                                        disabled={uploading}
                                                        className="hidden" />
                                                </label>
                                            </div>
                                        ) : (
                                            <label className={`block w-full text-center px-2 py-1 rounded-md text-[11px] font-bold cursor-pointer transition border-2 border-dashed ${
                                                uploading
                                                    ? 'border-sky-300 bg-sky-50 text-sky-500'
                                                    : 'border-sky-300 bg-white text-sky-700 hover:bg-sky-50'
                                            }`}>
                                                {uploading ? tx('Uploading…', 'Subiendo…') : tx('📄 Upload PDF/JPEG', '📄 Subir PDF/JPEG')}
                                                <input type="file" accept="image/*,video/mp4,video/webm,video/quicktime,application/pdf"
                                                    onChange={(e) => { handleUpload(idx, e.target.files?.[0]); e.target.value = ''; }}
                                                    disabled={uploading}
                                                    className="hidden" />
                                            </label>
                                        )}
                                    </div>
                                    {/* Map items + Delete */}
                                    <div className="col-span-2 flex items-center gap-1 justify-end">
                                        <button type="button"
                                            onClick={() => setEditingZonesIdx(idx)}
                                            disabled={!hasImages}
                                            className="px-2 py-0.5 rounded text-[10px] font-bold border bg-white text-amber-700 border-amber-300 hover:bg-amber-50 disabled:opacity-30 disabled:cursor-not-allowed"
                                            title={tx('Map SOLD OUT zones for this daypart', 'Mapear zonas')}>
                                            🎯
                                        </button>
                                        <button type="button"
                                            onClick={() => remove(idx)}
                                            className="w-5 h-5 rounded-full bg-red-100 hover:bg-red-200 text-red-700 text-[10px] font-black"
                                            title={tx('Remove', 'Quitar')}>
                                            ✕
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Add buttons — presets + custom */}
            <div className="flex items-center gap-1.5 flex-wrap pt-1">
                <span className="text-[10px] font-bold text-dd-text-2 mr-1">
                    {tx('Add:', 'Agregar:')}
                </span>
                {PRESET_DAYPARTS.map(p => (
                    <button key={p.label} type="button"
                        onClick={() => addPreset(p)}
                        disabled={dayparts.some(d => d.label === p.label)}
                        className="px-2 py-1 rounded-full text-[10px] font-bold border bg-white text-sky-700 border-sky-300 hover:bg-sky-50 disabled:opacity-30 disabled:cursor-not-allowed">
                        + {p.label}
                    </button>
                ))}
                <button type="button" onClick={addBlank}
                    className="px-2 py-1 rounded-full text-[10px] font-bold border bg-white text-stone-700 border-stone-300 hover:bg-stone-50">
                    + {tx('Custom', 'Personalizada')}
                </button>
            </div>

            {/* Hit zone editor for the daypart being mapped */}
            {editingZonesIdx !== null && dayparts[editingZonesIdx] && (
                <Suspense fallback={null}>
                    <HitZoneEditor
                        imageUrls={dayparts[editingZonesIdx].imageUrls || []}
                        initialZones={dayparts[editingZonesIdx].imageHitZones || []}
                        language={language}
                        onSave={(result) => {
                            const patch = {};
                            if (result && Array.isArray(result.zones)) patch.imageHitZones = result.zones;
                            if (result && Array.isArray(result.imageUrls)) patch.imageUrls = result.imageUrls;
                            update(editingZonesIdx, patch);
                        }}
                        onClose={() => setEditingZonesIdx(null)} />
                </Suspense>
            )}
        </div>
    );
}
