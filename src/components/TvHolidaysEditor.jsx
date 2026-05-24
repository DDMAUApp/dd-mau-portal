// TvHolidaysEditor — admin UI for managing date-bound TV overlays.
//
// Wired into MenuScreensPage as the "🎄 Holidays" tab. Lists every
// holiday doc with its date range + applies-to scope + enabled state,
// and lets admin create/edit/delete + pick a preset (Tết, Mother's
// Day, Christmas, etc.) which pre-fills sensible defaults.
//
// MVP shape: flat list (no calendar grid yet). Each row collapsible
// to its full editor form. Hide-vs-delete handled by `enabled` flag
// so admin can pre-build "Tết 2027" months ahead and just flip it on
// the day. Wait for Phase 2 to add a real calendar visualization.
//
// All writes go to /tv_holidays/{id}. The MenuDisplay component
// subscribes to the collection separately and applies overlays at
// render time — this file is admin-side only.

import { useEffect, useMemo, useState } from 'react';
import {
    collection, doc, onSnapshot, setDoc, deleteDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import {
    HOLIDAY_PRESETS, HOLIDAY_PRESET_ORDER,
    isHolidayActiveOn, daysUntilHoliday,
} from '../data/tvHolidays';

const LOC_LABEL = { webster: 'Webster', maryland: 'MD Heights' };

// Stable random-ish doc id for new holidays — short, URL-friendly,
// no Firestore round-trip required just to know the new id.
function newHolidayId() {
    const r = Math.random().toString(36).slice(2, 8);
    return `hol_${Date.now()}_${r}`;
}

export default function TvHolidaysEditor({ language, staffName, tvConfigs }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [holidays, setHolidays] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState(null);
    const [showNewMenu, setShowNewMenu] = useState(false);

    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'tv_holidays'), (snap) => {
            const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            // Sort: enabled active first, then enabled upcoming by
            // start-date asc, then disabled at the bottom.
            list.sort((a, b) => {
                const ae = a.enabled !== false;
                const be = b.enabled !== false;
                if (ae !== be) return ae ? -1 : 1;
                const aActive = isHolidayActiveOn(a) ? 1 : 0;
                const bActive = isHolidayActiveOn(b) ? 1 : 0;
                if (aActive !== bActive) return bActive - aActive;
                return (a.dateStart || '').localeCompare(b.dateStart || '');
            });
            setHolidays(list);
            setLoading(false);
        }, (err) => {
            console.warn('tv_holidays subscription failed:', err);
            setLoading(false);
        });
        return unsub;
    }, []);

    async function createFromPreset(presetKey) {
        const preset = HOLIDAY_PRESETS[presetKey];
        if (!preset) return;
        const year = new Date().getFullYear();
        // For lunar presets the dateRangeFn returns null if we don't
        // have the year in the lookup table — fall back to "today"
        // so the admin can edit dates manually.
        let range = preset.dateRangeFn(year);
        if (!range) {
            // Try next year if current year past
            range = preset.dateRangeFn(year + 1) || {
                dateStart: new Date().toISOString().slice(0, 10),
                dateEnd:   new Date().toISOString().slice(0, 10),
            };
        }
        const id = newHolidayId();
        const name = preset.label.includes(year) ? preset.label : `${preset.label} ${year}`;
        await setDoc(doc(db, 'tv_holidays', id), {
            name,
            preset: presetKey,
            dateStart: range.dateStart,
            dateEnd: range.dateEnd,
            priority: 0,
            appliesTo: { allTvs: true, tvIds: [], locations: [] },
            overrides: {
                accentColor: preset.accentColor || null,
                bannerText: preset.bannerText || null,
                imageUrls: [],
                showCountdown: !!preset.showCountdown,
                confettiOnEnter: false,
            },
            enabled: true,
            createdBy: staffName || 'admin',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });
        setShowNewMenu(false);
        setEditingId(id);
    }

    async function createBlank() {
        const id = newHolidayId();
        const today = new Date().toISOString().slice(0, 10);
        await setDoc(doc(db, 'tv_holidays', id), {
            name: tx('New holiday', 'Nueva fiesta'),
            preset: null,
            dateStart: today,
            dateEnd: today,
            priority: 0,
            appliesTo: { allTvs: true, tvIds: [], locations: [] },
            overrides: {
                accentColor: null,
                bannerText: null,
                imageUrls: [],
                showCountdown: false,
                confettiOnEnter: false,
            },
            enabled: true,
            createdBy: staffName || 'admin',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });
        setShowNewMenu(false);
        setEditingId(id);
    }

    return (
        <div>
            <p className="text-[11px] text-dd-text-2 mb-3">
                {tx(
                    'Date-bound overlays that auto-swap TV content on holidays. Schedule once, the system flips it on/off on the dates you pick. Lunar New Year (Tết) and Mid-Autumn are pre-loaded for the next 5 years.',
                    'Superposiciones por fecha que cambian el contenido de la TV en días festivos automáticamente.',
                )}
            </p>

            {/* New button + preset menu */}
            <div className="relative inline-block mb-3">
                <button onClick={() => setShowNewMenu(s => !s)}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700">
                    + {tx('New holiday', 'Nueva fiesta')}
                </button>
                {showNewMenu && (
                    <div className="absolute top-full left-0 mt-1 z-10 bg-white border border-dd-line rounded-lg shadow-lg min-w-[220px] max-h-[60vh] overflow-y-auto">
                        <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500 border-b border-dd-line">
                            {tx('Pick a preset', 'Elige una plantilla')}
                        </div>
                        {HOLIDAY_PRESET_ORDER.map(k => {
                            const p = HOLIDAY_PRESETS[k];
                            return (
                                <button key={k} onClick={() => createFromPreset(k)}
                                    className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-gray-50 flex items-center gap-2">
                                    <span className="text-base">{p.emoji}</span>
                                    <span className="font-bold">{p.label}</span>
                                </button>
                            );
                        })}
                        <div className="border-t border-dd-line">
                            <button onClick={createBlank}
                                className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-gray-50 text-gray-600 italic">
                                {tx('+ Blank (custom dates)', '+ En blanco')}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Holiday list */}
            {loading && (
                <div className="text-xs text-gray-400 italic px-2 py-4">
                    {tx('Loading…', 'Cargando…')}
                </div>
            )}
            {!loading && holidays.length === 0 && (
                <div className="text-xs text-gray-500 px-3 py-6 text-center bg-gray-50 rounded-lg border border-dashed border-gray-300">
                    {tx(
                        'No holidays scheduled. Click "+ New holiday" above to set one up — Tết and Mother\'s Day are the high-leverage starting points.',
                        'Sin fiestas programadas. Toca "+ Nueva fiesta" para comenzar.',
                    )}
                </div>
            )}
            <div className="space-y-2">
                {holidays.map(h => (
                    <HolidayRow key={h.id} holiday={h}
                        editing={editingId === h.id}
                        onToggleEdit={() => setEditingId(editingId === h.id ? null : h.id)}
                        tvConfigs={tvConfigs}
                        staffName={staffName}
                        isEs={isEs} />
                ))}
            </div>
        </div>
    );
}

// ── Single holiday row ───────────────────────────────────────────────
function HolidayRow({ holiday, editing, onToggleEdit, tvConfigs, staffName, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const active = isHolidayActiveOn(holiday);
    const days = daysUntilHoliday(holiday);
    const preset = holiday.preset ? HOLIDAY_PRESETS[holiday.preset] : null;
    const emoji = preset?.emoji || '🎉';
    const enabled = holiday.enabled !== false;

    const dateLabel = holiday.dateStart === holiday.dateEnd
        ? holiday.dateStart
        : `${holiday.dateStart} → ${holiday.dateEnd}`;
    const statusBadge = !enabled
        ? { bg: 'bg-gray-100', text: 'text-gray-600', label: tx('Disabled', 'Desactivado') }
        : active
            ? { bg: 'bg-emerald-100', text: 'text-emerald-800', label: tx('LIVE NOW', 'EN VIVO') }
            : days !== null && days > 0 && days < 14
                ? { bg: 'bg-amber-100', text: 'text-amber-800', label: tx(`in ${days}d`, `en ${days}d`) }
                : days !== null && days < 0
                    ? { bg: 'bg-gray-100', text: 'text-gray-500', label: tx('past', 'pasado') }
                    : { bg: 'bg-sky-100', text: 'text-sky-800', label: tx('scheduled', 'programado') };

    return (
        <div className={`border border-dd-line rounded-xl overflow-hidden ${active && enabled ? 'bg-emerald-50/30' : 'bg-white'}`}>
            <button onClick={onToggleEdit}
                className="w-full px-3 py-2 text-left hover:bg-gray-50 flex items-center gap-2">
                <span className="text-xl flex-shrink-0">{emoji}</span>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[13px] font-bold text-gray-900 truncate">{holiday.name}</span>
                        <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${statusBadge.bg} ${statusBadge.text}`}>
                            {statusBadge.label}
                        </span>
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5">
                        {dateLabel} · {scopeLabel(holiday.appliesTo, isEs)}
                    </div>
                </div>
                <span className="text-gray-400 text-sm">{editing ? '▼' : '▶'}</span>
            </button>
            {editing && (
                <HolidayEditForm holiday={holiday} tvConfigs={tvConfigs}
                    staffName={staffName} isEs={isEs} onClose={onToggleEdit} />
            )}
        </div>
    );
}

function scopeLabel(appliesTo, isEs) {
    const a = appliesTo || {};
    if (a.allTvs) return isEs ? 'todas las TVs' : 'all TVs';
    const parts = [];
    if (Array.isArray(a.locations) && a.locations.length > 0) {
        parts.push(a.locations.map(l => LOC_LABEL[l] || l).join(', '));
    }
    if (Array.isArray(a.tvIds) && a.tvIds.length > 0) {
        parts.push(`${a.tvIds.length} ${isEs ? 'TV específicas' : 'specific TVs'}`);
    }
    return parts.length ? parts.join(' · ') : (isEs ? 'sin destino' : 'no target');
}

// ── Edit form (collapsible inside a row) ─────────────────────────────
function HolidayEditForm({ holiday, tvConfigs, staffName, isEs, onClose }) {
    const tx = (en, es) => (isEs ? es : en);
    const [name, setName] = useState(holiday.name || '');
    const [dateStart, setDateStart] = useState(holiday.dateStart || '');
    const [dateEnd, setDateEnd] = useState(holiday.dateEnd || '');
    const [priority, setPriority] = useState(Number(holiday.priority || 0));
    const [enabled, setEnabled] = useState(holiday.enabled !== false);
    const [accentColor, setAccentColor] = useState(holiday.overrides?.accentColor || '');
    const [bannerEn, setBannerEn] = useState(holiday.overrides?.bannerText?.en || '');
    const [bannerEs, setBannerEs] = useState(holiday.overrides?.bannerText?.es || '');
    const [bannerVi, setBannerVi] = useState(holiday.overrides?.bannerText?.vi || '');
    const [showCountdown, setShowCountdown] = useState(!!holiday.overrides?.showCountdown);
    const [allTvs, setAllTvs] = useState(holiday.appliesTo?.allTvs !== false);
    const [selectedLocations, setSelectedLocations] = useState(
        Array.isArray(holiday.appliesTo?.locations) ? holiday.appliesTo.locations : []
    );
    const [selectedTvIds, setSelectedTvIds] = useState(
        Array.isArray(holiday.appliesTo?.tvIds) ? holiday.appliesTo.tvIds : []
    );
    const [saving, setSaving] = useState(false);
    const [errMsg, setErrMsg] = useState(null);

    const tvOptions = useMemo(
        () => Array.isArray(tvConfigs) ? tvConfigs : [], [tvConfigs]);

    async function handleSave() {
        if (saving) return;
        setSaving(true);
        setErrMsg(null);
        try {
            await setDoc(doc(db, 'tv_holidays', holiday.id), {
                ...holiday,
                name: name.trim() || 'Untitled',
                dateStart, dateEnd,
                priority: Number(priority) || 0,
                enabled,
                appliesTo: {
                    allTvs,
                    locations: allTvs ? [] : selectedLocations,
                    tvIds: allTvs ? [] : selectedTvIds,
                },
                overrides: {
                    ...(holiday.overrides || {}),
                    accentColor: accentColor.trim() || null,
                    bannerText: (bannerEn || bannerEs || bannerVi)
                        ? { en: bannerEn, es: bannerEs, vi: bannerVi }
                        : null,
                    showCountdown,
                },
                updatedBy: staffName || 'admin',
                updatedAt: serverTimestamp(),
            }, { merge: true });
            onClose?.();
        } catch (e) {
            setErrMsg(e?.message || 'Save failed');
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete() {
        if (!window.confirm(tx(
            `Delete "${name}" holiday? This can't be undone.`,
            `¿Eliminar "${name}"? No se puede deshacer.`,
        ))) return;
        setSaving(true);
        try {
            await deleteDoc(doc(db, 'tv_holidays', holiday.id));
        } catch (e) {
            setErrMsg(e?.message || 'Delete failed');
            setSaving(false);
        }
    }

    return (
        <div className="p-3 border-t border-dd-line bg-white space-y-3">
            {/* Name */}
            <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">
                    {tx('Name', 'Nombre')}
                </label>
                <input type="text" value={name} onChange={e => setName(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-sm" />
            </div>
            {/* Dates */}
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">
                        {tx('Start date', 'Inicio')}
                    </label>
                    <input type="date" value={dateStart} onChange={e => setDateStart(e.target.value)}
                        className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-sm" />
                </div>
                <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">
                        {tx('End date', 'Fin')}
                    </label>
                    <input type="date" value={dateEnd} onChange={e => setDateEnd(e.target.value)}
                        className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-sm" />
                </div>
            </div>
            {/* Applies to */}
            <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">
                    {tx('Applies to', 'Aplica a')}
                </label>
                <label className="flex items-center gap-2 text-[12px] mb-1">
                    <input type="checkbox" checked={allTvs} onChange={e => setAllTvs(e.target.checked)} />
                    {tx('All TVs (both locations)', 'Todas las TVs')}
                </label>
                {!allTvs && (
                    <div className="ml-5 space-y-1">
                        <div className="flex gap-3 text-[12px]">
                            {['webster', 'maryland'].map(loc => (
                                <label key={loc} className="flex items-center gap-1">
                                    <input type="checkbox"
                                        checked={selectedLocations.includes(loc)}
                                        onChange={e => {
                                            setSelectedLocations(s => e.target.checked
                                                ? [...s, loc] : s.filter(x => x !== loc));
                                        }} />
                                    {LOC_LABEL[loc]}
                                </label>
                            ))}
                        </div>
                        {tvOptions.length > 0 && (
                            <div className="text-[11px] mt-1">
                                <div className="text-gray-600 mb-1">{tx('Specific TVs:', 'TVs específicas:')}</div>
                                <div className="max-h-32 overflow-y-auto border border-dd-line rounded p-1.5 space-y-0.5">
                                    {tvOptions.map(t => (
                                        <label key={t.tvId} className="flex items-center gap-1.5 text-[11px] hover:bg-gray-50 rounded px-1">
                                            <input type="checkbox"
                                                checked={selectedTvIds.includes(t.tvId)}
                                                onChange={e => {
                                                    setSelectedTvIds(s => e.target.checked
                                                        ? [...s, t.tvId] : s.filter(x => x !== t.tvId));
                                                }} />
                                            {t.label || t.tvId}
                                            <span className="text-gray-400 ml-auto">{t.location}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
            {/* Banner text */}
            <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">
                    {tx('Banner text (optional)', 'Texto del banner (opcional)')}
                </label>
                <input type="text" value={bannerEn} onChange={e => setBannerEn(e.target.value)}
                    placeholder="EN" className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-sm mb-1" />
                <input type="text" value={bannerEs} onChange={e => setBannerEs(e.target.value)}
                    placeholder="ES" className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-sm mb-1" />
                <input type="text" value={bannerVi} onChange={e => setBannerVi(e.target.value)}
                    placeholder="VI (tiếng Việt)" className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-sm" />
            </div>
            {/* Accent color + countdown */}
            <div className="grid grid-cols-2 gap-2 items-end">
                <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">
                        {tx('Accent color', 'Color de acento')}
                    </label>
                    <div className="flex items-center gap-2">
                        <input type="color" value={accentColor || '#15803d'}
                            onChange={e => setAccentColor(e.target.value)}
                            className="w-10 h-9 rounded border border-dd-line cursor-pointer" />
                        <input type="text" value={accentColor} onChange={e => setAccentColor(e.target.value)}
                            placeholder="#hex" className="flex-1 px-2 py-1.5 rounded-lg border border-dd-line text-sm font-mono text-[11px]" />
                    </div>
                </div>
                <label className="flex items-center gap-2 text-[12px] mt-5">
                    <input type="checkbox" checked={showCountdown}
                        onChange={e => setShowCountdown(e.target.checked)} />
                    {tx('Show countdown ("3 days to…")', 'Mostrar cuenta regresiva')}
                </label>
            </div>
            {/* Priority + enabled */}
            <div className="grid grid-cols-2 gap-2 items-end">
                <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">
                        {tx('Priority (higher wins on overlap)', 'Prioridad')}
                    </label>
                    <input type="number" value={priority}
                        onChange={e => setPriority(e.target.value)}
                        className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-sm" />
                </div>
                <label className="flex items-center gap-2 text-[12px] mt-5">
                    <input type="checkbox" checked={enabled}
                        onChange={e => setEnabled(e.target.checked)} />
                    {tx('Enabled', 'Activado')}
                </label>
            </div>

            {errMsg && (
                <div className="px-2 py-1.5 rounded bg-red-50 border border-red-200 text-[11px] text-red-700">
                    ⚠️ {errMsg}
                </div>
            )}

            <div className="flex gap-2 pt-2 border-t border-dd-line">
                <button onClick={handleSave} disabled={saving}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 disabled:opacity-50">
                    {saving ? '…' : tx('💾 Save', '💾 Guardar')}
                </button>
                <button onClick={onClose} disabled={saving}
                    className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 text-xs font-bold hover:bg-gray-200">
                    {tx('Close', 'Cerrar')}
                </button>
                <button onClick={handleDelete} disabled={saving}
                    className="ml-auto px-3 py-1.5 rounded-lg bg-red-50 text-red-700 text-xs font-bold hover:bg-red-100 border border-red-200">
                    {tx('Delete', 'Eliminar')}
                </button>
            </div>
        </div>
    );
}
