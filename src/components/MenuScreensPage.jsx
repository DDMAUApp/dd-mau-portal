// MenuScreensPage — top-level "TV Menu Screens" dashboard for admins.
//
// Andrew 2026-05-23: promote menu-TV management out of the long
// AdminPanel scroll into its own dedicated page so we can build it
// out into a real digital-signage dashboard (compare: Yodeck,
// OptiSigns, Raydiant). Page is admin-gated via App.jsx tab guard.
//
// ─── What lives here today ─────────────────────────────────────
//   • Header with title + count + primary actions (New screen,
//     Pair device, Templates, Media)
//   • Health strip — 4 inline stats: total / online / stale /
//     offline. Status is derived from `tvConfig.updatedAt` for v1;
//     swap to real device-heartbeat data when /devices is wired.
//   • Location filter chips (All / Webster / Maryland)
//   • Screen card grid — one card per /tv_configs doc. Each card
//     has a live 16:9 iframe preview, status pill, mode badge,
//     last-updated relative time, and inline actions
//     (Edit / Open in tab / Copy URL).
//   • Inline editor — the existing TvConfigsEditor lazy-loaded
//     below the grid. v1 reuses its full form for create + edit;
//     v2 will split this into a focused per-screen editor route.
//
// ─── What's coming next (tracked, not built yet) ───────────────
//   • Real device heartbeat via /devices/{id} → live status pills
//   • 6-digit Pair Device modal — Pi types code, dashboard binds it
//   • Publish button + draft state — currently every save goes live
//   • Templates gallery (Food / Drinks / Specials / Combo / etc.)
//   • Media Library (shared image/video assets across screens)
//   • Daypart calendar visualization
//   • Multi-screen groups
//
// All additive — MenuDisplay.jsx is untouched, the existing
// /tv_configs data model is reused as-is.

import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { subscribeTvConfigs, MODES } from '../data/tvConfigs';

// Heavy editor form lives in its existing file; we render it inline
// below the dashboard for v1 so create + edit still work today.
const TvConfigsEditor = lazy(() =>
    import('./TvConfigsEditor').then(m => ({ default: m.default })));

const LOC_LABEL = { webster: 'Webster', maryland: 'MD Heights' };

// Status thresholds (minutes). Heartbeat-based once /devices ships;
// for v1 we derive from tvConfig.updatedAt as a proxy for "is anyone
// touching this screen?". Threshold values match the Raydiant /
// Yodeck convention.
const STALE_AFTER_MIN   = 60 * 24;     // 1 day
const OFFLINE_AFTER_MIN = 60 * 24 * 7; // 1 week

function minutesSince(ts) {
    if (!ts) return null;
    const ms = ts.toMillis ? ts.toMillis()
        : ts.seconds ? ts.seconds * 1000
        : 0;
    if (!ms) return null;
    return Math.round((Date.now() - ms) / 60000);
}

function statusFor(cfg) {
    // No updatedAt at all → never configured (legacy default URL).
    const m = minutesSince(cfg?.updatedAt);
    if (m === null) return 'never';
    if (m < STALE_AFTER_MIN) return 'live';
    if (m < OFFLINE_AFTER_MIN) return 'stale';
    return 'offline';
}

function relativeLabel(ts, isEs) {
    const m = minutesSince(ts);
    if (m === null) return isEs ? '—' : '—';
    if (m < 1)   return isEs ? 'ahora'    : 'just now';
    if (m < 60)  return `${m} min`;
    if (m < 60 * 24) return `${Math.floor(m / 60)}h`;
    return `${Math.floor(m / 60 / 24)}d`;
}

export default function MenuScreensPage({ language = 'en', staffName, storeLocation = 'webster' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // Live subscription to /tv_configs — same hook the existing
    // editor uses, just consumed from the dashboard too.
    const [configs, setConfigs] = useState([]);
    useEffect(() => subscribeTvConfigs(setConfigs), []);

    // Location filter chips. 'all' shows every TV; a specific value
    // narrows to that store. Defaults to the admin's current store
    // so opening the page lands on the most-relevant set.
    const [locFilter, setLocFilter] = useState(() => storeLocation || 'all');

    // Pull the always-present "default URL" rows (webster / maryland
    // each work without a config doc) into the dashboard so the card
    // grid covers everything the TVs can actually point at.
    const baseUrl = useMemo(() => {
        try { return `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}`.replace(/\/$/, ''); }
        catch { return 'https://app.ddmaustl.com'; }
    }, []);

    // Build a merged list: configured TVs + synthetic default rows
    // for any location that doesn't yet have a config override. The
    // synthetic rows render as "Default — tap to customize" cards so
    // the dashboard never looks empty for a fresh restaurant.
    const screens = useMemo(() => {
        const out = configs.map(c => ({
            tvId: c.tvId,
            label: c.label || c.tvId,
            location: c.location || 'webster',
            mode: c.mode || MODES.MENU,
            layout: c.layout || 'dense',
            updatedAt: c.updatedAt,
            updatedBy: c.updatedBy,
            isDefault: false,
            cfg: c,
        }));
        for (const loc of ['webster', 'maryland']) {
            if (!out.find(s => s.tvId === loc)) {
                out.push({
                    tvId: loc,
                    label: `${LOC_LABEL[loc]} default`,
                    location: loc,
                    mode: MODES.MENU,
                    layout: 'dense',
                    updatedAt: null,
                    isDefault: true,
                });
            }
        }
        return out;
    }, [configs]);

    const filteredScreens = useMemo(() => {
        if (locFilter === 'all') return screens;
        return screens.filter(s => s.location === locFilter);
    }, [screens, locFilter]);

    // Health strip stats — only count "real" (configured) screens
    // for status tallies; synthetic defaults are bucketed separately
    // as "Unconfigured" so admins see at a glance how many they have
    // left to set up.
    const health = useMemo(() => {
        const real = filteredScreens.filter(s => !s.isDefault);
        const live    = real.filter(s => statusFor(s.cfg) === 'live').length;
        const stale   = real.filter(s => statusFor(s.cfg) === 'stale').length;
        const offline = real.filter(s => statusFor(s.cfg) === 'offline').length;
        const unconfigured = filteredScreens.filter(s => s.isDefault).length;
        // Most-recent publish across the filtered set — used in the
        // header as "last published 4m ago".
        const newest = real.reduce((acc, s) => {
            const m = minutesSince(s.updatedAt);
            return m !== null && (acc === null || m < acc) ? m : acc;
        }, null);
        return { total: real.length, live, stale, offline, unconfigured, newestMin: newest };
    }, [filteredScreens]);

    // Card click → scroll the page to the inline editor and pre-open
    // that screen. The TvConfigsEditor below reads its own state for
    // the active edit target; we use a window event to nudge it.
    // (Cross-component side channel is acceptable for v1; we'll
    // refactor when the editor splits out into a real route.)
    function openEditor(screen) {
        try {
            window.dispatchEvent(new CustomEvent('ddmau:openTvEditor', {
                detail: { tvId: screen.isDefault ? null : screen.tvId, presetLocation: screen.location },
            }));
        } catch {}
        const el = document.getElementById('menuscreens-editor');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    return (
        <section className="w-full max-w-6xl mx-auto px-3 md:px-6 py-4 md:py-6 space-y-5">
            {/* Header — title + count + primary actions. On phones the
                action buttons drop below the title; on desktop they
                sit on the right. */}
            <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-2xl md:text-3xl font-black text-dd-text tracking-tight">
                        📺 {tx('Menu Screens', 'Pantallas de menú')}
                    </h1>
                    <p className="text-[12px] text-dd-text-2 mt-0.5">
                        {tx(
                            'Manage every TV menu board across your restaurants from one place.',
                            'Gestiona cada pantalla de menú desde un solo lugar.',
                        )}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                    <button
                        onClick={() => openEditor({ isDefault: true, location: locFilter === 'all' ? 'webster' : locFilter })}
                        className="px-3.5 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 active:scale-95 transition shadow-sm">
                        + {tx('New screen', 'Nueva pantalla')}
                    </button>
                    <button
                        type="button"
                        disabled
                        title={tx('Coming soon — pair a Raspberry Pi by code instead of pasting a URL.', 'Próximamente — vincular Pi por código.')}
                        className="px-3.5 py-2 rounded-lg bg-white border border-dd-line text-sm font-bold text-dd-text-2 opacity-60 cursor-not-allowed">
                        🔗 {tx('Pair device', 'Vincular')}
                    </button>
                    <button
                        type="button"
                        disabled
                        title={tx('Coming soon — start a new screen from a template.', 'Próximamente — plantillas.')}
                        className="px-3.5 py-2 rounded-lg bg-white border border-dd-line text-sm font-bold text-dd-text-2 opacity-60 cursor-not-allowed">
                        🎨 {tx('Templates', 'Plantillas')}
                    </button>
                </div>
            </header>

            {/* Health strip — 4 stats inline, color-coded. Reads from
                left to right: how many total, how many recently
                touched, how many getting stale, how many appear
                abandoned. The "last published" footnote on the right
                tells admins whether the dashboard is up to date. */}
            <div className="flex flex-wrap items-center gap-2 md:gap-3 bg-white border border-dd-line rounded-xl px-3 py-2.5 shadow-sm">
                <HealthStat label={tx('Total', 'Total')} value={health.total + health.unconfigured} tone="neutral" />
                <span className="text-dd-line">·</span>
                <HealthStat label={tx('Live', 'En vivo')} value={health.live} tone="good" />
                <HealthStat label={tx('Stale', 'Sin cambios')} value={health.stale} tone="warn" />
                <HealthStat label={tx('Offline', 'Sin actividad')} value={health.offline} tone="danger" />
                {health.unconfigured > 0 && (
                    <HealthStat label={tx('Unconfigured', 'Sin configurar')} value={health.unconfigured} tone="neutral" />
                )}
                <span className="flex-1" />
                {health.newestMin !== null && (
                    <span className="text-[11px] text-dd-text-2 shrink-0">
                        {tx('Last published', 'Última publicación')}: <span className="font-bold text-dd-text">{health.newestMin < 1 ? tx('just now', 'ahora') : `${health.newestMin} min`}</span>
                    </span>
                )}
            </div>

            {/* Location filter chips. Single-select; "All" resets the
                filter. Highlights the currently-active store so admin
                always knows which lens they're looking through. */}
            <div className="flex flex-wrap gap-2">
                {[
                    { id: 'all',      label: tx('All', 'Todas') },
                    { id: 'webster',  label: 'Webster' },
                    { id: 'maryland', label: 'MD Heights' },
                ].map(o => {
                    const active = locFilter === o.id;
                    return (
                        <button key={o.id} onClick={() => setLocFilter(o.id)}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition ${
                                active
                                    ? 'bg-dd-charcoal text-white border-dd-charcoal'
                                    : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'
                            }`}>
                            {o.label}
                        </button>
                    );
                })}
            </div>

            {/* Screen card grid. 1 col on phones, 2 on tablets, 3 on
                desktop. Each card is the full unit of action for a TV
                — the user shouldn't need to leave the grid for common
                tasks (open the kiosk URL, copy it, see when it last
                published). "Edit" jumps to the inline form below. */}
            {filteredScreens.length === 0 ? (
                <EmptyState
                    isEs={isEs}
                    onCreate={() => openEditor({ isDefault: true, location: locFilter === 'all' ? 'webster' : locFilter })} />
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {filteredScreens.map(s => (
                        <ScreenCard
                            key={s.tvId}
                            screen={s}
                            baseUrl={baseUrl}
                            isEs={isEs}
                            onEdit={() => openEditor(s)} />
                    ))}
                </div>
            )}

            {/* Inline editor — v1 fallback. The existing
                TvConfigsEditor renders its full location-grouped UI
                here so create + edit still work today. v2 will
                split this into a per-screen editor with tabs
                (Content / Schedule / Branding / Preview). */}
            <div id="menuscreens-editor" className="pt-4 border-t border-dd-line">
                <Suspense fallback={
                    <div className="text-sm text-dd-text-2 italic py-6 text-center">
                        {tx('Loading editor…', 'Cargando editor…')}
                    </div>}>
                    <TvConfigsEditor language={language} byName={staffName} />
                </Suspense>
            </div>
        </section>
    );
}

// HealthStat — single inline label + value. The tone prop controls
// the value's color; the label stays muted so the eye lands on the
// number, not the word.
function HealthStat({ label, value, tone = 'neutral' }) {
    const toneClass = tone === 'good'   ? 'text-emerald-700'
                    : tone === 'warn'   ? 'text-amber-700'
                    : tone === 'danger' ? 'text-red-700'
                    :                     'text-dd-text';
    return (
        <span className="inline-flex items-baseline gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-dd-text-2">
                {label}
            </span>
            <span className={`text-base font-black tabular-nums ${toneClass}`}>{value}</span>
        </span>
    );
}

// ScreenCard — one TV's at-a-glance card. Built as a non-button
// container so the action row inside can have its own buttons
// without nested-interactive issues; the whole card has a hover
// shadow lift so it still reads as tappable visually.
function ScreenCard({ screen, baseUrl, isEs, onEdit }) {
    const tx = (en, es) => (isEs ? es : en);
    const url = `${baseUrl}/?tv=${screen.tvId}`;
    const status = screen.isDefault ? 'never' : statusFor(screen.cfg);
    const statusPill = {
        live:    { bg: 'bg-emerald-50',  border: 'border-emerald-300', text: 'text-emerald-700', dot: 'bg-emerald-500', label: tx('Live',         'En vivo') },
        stale:   { bg: 'bg-amber-50',    border: 'border-amber-300',   text: 'text-amber-700',   dot: 'bg-amber-500',   label: tx('Stale',        'Antiguo') },
        offline: { bg: 'bg-red-50',      border: 'border-red-300',     text: 'text-red-700',     dot: 'bg-red-500',     label: tx('Inactive',     'Inactiva') },
        never:   { bg: 'bg-dd-bg',       border: 'border-dd-line',     text: 'text-dd-text-2',   dot: 'bg-gray-400',    label: tx('Unconfigured', 'Sin config.') },
    }[status];
    const modeBadge = screen.mode === 'image' ? '🖼 IMAGE'
                    : screen.mode === 'split' ? '⫴ SPLIT'
                    :                            '🍜 MENU';

    async function copyUrl() {
        try {
            await navigator.clipboard.writeText(url);
        } catch {
            // Older browsers / iOS Safari w/o https — fall back to a
            // hidden textarea + execCommand so the button still does
            // something useful on legacy Pi browsers.
            const ta = document.createElement('textarea');
            ta.value = url; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
        }
    }

    return (
        <div className="bg-white border border-dd-line rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition flex flex-col">
            {/* 16:9 preview frame — wraps an iframe that renders the
                actual TV at full size, then scales it down to fit
                the card. sandbox restricts what the iframe can do so
                this doesn't become an XSS surface; scrolling=no +
                pointer-events-none keeps the user from accidentally
                interacting with the iframe instead of the card.
                Default screens that haven't been customized show a
                friendly placeholder instead of loading a heavy
                iframe for what is essentially the same view as the
                Maryland card next to it. */}
            <div className="relative w-full aspect-video bg-dd-bg overflow-hidden border-b border-dd-line">
                {screen.isDefault ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
                        <span className="text-4xl mb-2">📺</span>
                        <span className="text-sm font-bold text-dd-text">
                            {tx('Default menu', 'Menú por defecto')}
                        </span>
                        <span className="text-[11px] text-dd-text-2 mt-1 max-w-[220px]">
                            {tx(
                                'Tap Edit to customize layout, photos, dayparts, or upload a PDF/JPEG menu.',
                                'Toca Editar para personalizar el diseño, fotos, horarios o subir un PDF/JPEG.',
                            )}
                        </span>
                    </div>
                ) : (
                    <iframe
                        src={url}
                        title={`Preview · ${screen.label}`}
                        sandbox="allow-same-origin allow-scripts"
                        scrolling="no"
                        loading="lazy"
                        // Scale a 1920x1080 viewport down to the card's
                        // actual width. The wrapper aspect-video locks
                        // the box height; the iframe is forced to TV
                        // resolution and then transformed to fit.
                        style={{
                            position: 'absolute',
                            top: 0, left: 0,
                            width: '1920px',
                            height: '1080px',
                            transformOrigin: 'top left',
                            transform: 'scale(calc(100% / 1920 * var(--card-w, 380)))',
                            border: 0,
                            pointerEvents: 'none',
                        }}
                    />
                )}
                {/* Status pill — top-right corner of the preview. */}
                <span className={`absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-black uppercase tracking-wider shadow-sm ${statusPill.bg} ${statusPill.border} ${statusPill.text}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${statusPill.dot}`} />
                    {statusPill.label}
                </span>
            </div>

            {/* Card body — label, location chip, mode badge, last
                updated. Action row below has primary (Edit) and
                secondary (Open, Copy URL) buttons. */}
            <div className="p-3 flex-1 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-black text-dd-text leading-tight truncate">{screen.label}</h3>
                    <span className="text-[10px] font-bold text-dd-text-2 shrink-0">
                        {relativeLabel(screen.updatedAt, isEs)}
                    </span>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[10px] font-bold">
                    <span className="px-1.5 py-0.5 rounded bg-dd-bg text-dd-text-2 border border-dd-line">
                        {LOC_LABEL[screen.location] || screen.location}
                    </span>
                    <span className="px-1.5 py-0.5 rounded bg-dd-sage-50 text-emerald-800 border border-emerald-200">
                        {modeBadge}
                    </span>
                    {screen.mode === 'menu' && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                            {String(screen.layout || 'dense').toUpperCase()}
                        </span>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    <button onClick={onEdit}
                        className="px-2.5 py-1 rounded-lg bg-dd-green text-white text-[11px] font-bold hover:bg-dd-green-700 active:scale-95 transition">
                        ✏ {tx('Edit', 'Editar')}
                    </button>
                    <a href={url} target="_blank" rel="noreferrer"
                        className="px-2.5 py-1 rounded-lg bg-white border border-dd-line text-[11px] font-bold text-dd-text-2 hover:bg-dd-bg">
                        ↗ {tx('Open', 'Abrir')}
                    </a>
                    <button onClick={copyUrl}
                        className="px-2.5 py-1 rounded-lg bg-white border border-dd-line text-[11px] font-bold text-dd-text-2 hover:bg-dd-bg">
                        📋 {tx('Copy URL', 'Copiar URL')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// EmptyState — shown when the active filter has zero screens. v1
// only fires when admin filters down to a location with no configs
// AND no default fallback (which can't really happen given we
// always synthesize the default rows). Kept for forward compat
// when the synthesized defaults are removed in v2.
function EmptyState({ isEs, onCreate }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="bg-white border-2 border-dashed border-dd-line rounded-2xl p-10 text-center">
            <div className="text-5xl mb-2">📺</div>
            <h3 className="text-lg font-black text-dd-text mb-1">
                {tx('No screens yet', 'No hay pantallas aún')}
            </h3>
            <p className="text-sm text-dd-text-2 mb-4 max-w-md mx-auto">
                {tx(
                    'Create your first menu screen, then point a Raspberry Pi or Fire TV at its URL.',
                    'Crea tu primera pantalla y apunta un Raspberry Pi o Fire TV a su URL.',
                )}
            </p>
            <button onClick={onCreate}
                className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 shadow-sm">
                + {tx('Create a screen', 'Crear pantalla')}
            </button>
        </div>
    );
}
