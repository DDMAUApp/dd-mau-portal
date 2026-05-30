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
import { db } from '../firebase';
import { collection, query, where, onSnapshot, limit, Timestamp } from 'firebase/firestore';
import {
    subscribeTvConfigs, subscribeTvHeartbeats, MODES,
    publishTvConfigDraft, discardTvConfigDraft,
} from '../data/tvConfigs';

// Heavy editor form lives in its existing file; we render it inline
// below the dashboard for v1 so create + edit still work today.
const TvConfigsEditor = lazy(() =>
    import('./TvConfigsEditor').then(m => ({ default: m.default })));
// Pair Device modal — opens when admin taps the "Pair device"
// button. Lazy because most dashboard visits never open it; saves
// the chunk cost on every Menu Screens load.
const PairDeviceModal = lazy(() =>
    import('./PairDeviceModal').then(m => ({ default: m.default })));
// Version history modal — shown when admin taps "History" on a
// screen card. Lazy for the same chunk-cost reason.
const TvConfigVersionsModal = lazy(() =>
    import('./TvConfigVersionsModal').then(m => ({ default: m.default })));
// Templates gallery — opens from the "Templates" header button.
// Picking a template creates a new tv_config doc and jumps the
// admin into the editor. Lazy because the template payloads + UI
// are dead weight for the common dashboard-view path.
const TvTemplatesModal = lazy(() =>
    import('./TvTemplatesModal').then(m => ({ default: m.default })));
// Holiday Scheduler — date-bound TV overlays (Tết, Mother's Day,
// Christmas, etc.). Lazy because most page visits are "check the
// dashboard", not "configure holidays."
const TvHolidaysEditor = lazy(() =>
    import('./TvHolidaysEditor').then(m => ({ default: m.default })));

const LOC_LABEL = { webster: 'Webster', maryland: 'MD Heights' };

// Status thresholds (minutes). Driven by /tv_heartbeats — MenuDisplay
// writes there every 60s while the Pi is online. The 2-min "live"
// window covers a missed beat (jittery Wi-Fi, a single retry); past
// 10 min we assume the device is down and the customer is seeing
// nothing. Matches the Raydiant / Yodeck "online / stale / offline"
// convention and the threshold used by checkTvHeartbeats below in
// functions/index.js — keep them in sync.
const STALE_AFTER_MIN   = 2;
const OFFLINE_AFTER_MIN = 10;

function minutesSince(ts) {
    if (!ts) return null;
    const ms = ts.toMillis ? ts.toMillis()
        : ts.seconds ? ts.seconds * 1000
        : 0;
    if (!ms) return null;
    return Math.round((Date.now() - ms) / 60000);
}

// Status for a TV given its heartbeat row. No heartbeat at all =
// "never" (the Pi has never pointed at this URL, OR it's been
// offline so long the doc got cleaned up). 'never' shows a neutral
// pill rather than a red one so a brand-new restaurant doesn't see
// alarming red dots before any TV is even plugged in.
function statusForHeartbeat(hb) {
    if (!hb) return 'never';
    const m = minutesSince(hb.lastSeenAt);
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

    // Live subscription to /tv_heartbeats. MenuDisplay pings this
    // every 60s while a Pi has the TV URL open; the dashboard reads
    // it to color the per-card status pills + the health strip.
    // Local clock state ticks every 30s so the "Xm ago" labels in
    // the cards roll forward smoothly without needing to reload.
    const [heartbeats, setHeartbeats] = useState({});
    useEffect(() => subscribeTvHeartbeats(setHeartbeats), []);

    // Recent crashes by tvId. 2026-05-23: TvErrorBoundary now logs
    // render crashes to /tv_crash_logs/{tvId_ts}. We tally crashes
    // from the last 24h per tvId so the card UI can show a red
    // "⚠️ N crashes" badge — early warning that a TV is in a bad
    // state even if heartbeat is green (since the boundary auto-
    // reloads, heartbeat alone doesn't catch it).
    const [crashesByTv, setCrashesByTv] = useState({});
    useEffect(() => {
        const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
        // Andrew 2026-05-30 — bounded with a Firestore `where` on
        // crashedAt + a hard limit() so this listener doesn't grow to
        // wire every historical crash on every snapshot. The 500-row
        // limit is a defense-in-depth; real bad-day volume is <50.
        // Client-side filter kept as a belt-and-suspenders in case a
        // doc lacks crashedAt (older format).
        const cutoffTs = Timestamp.fromMillis(cutoffMs);
        const q = query(
            collection(db, 'tv_crash_logs'),
            where('crashedAt', '>=', cutoffTs),
            limit(500)
        );
        const unsub = onSnapshot(q, (snap) => {
            const counts = {};
            const latestByTv = {};
            for (const d of snap.docs) {
                const data = d.data();
                const ms = data.crashedAt?.toMillis ? data.crashedAt.toMillis()
                    : data.crashedAt?.seconds ? data.crashedAt.seconds * 1000
                    : 0;
                if (!ms || ms < cutoffMs) continue;
                const tvId = data.tvId || 'unknown';
                counts[tvId] = (counts[tvId] || 0) + 1;
                if (!latestByTv[tvId] || latestByTv[tvId] < ms) {
                    latestByTv[tvId] = ms;
                }
            }
            const out = {};
            for (const tvId of Object.keys(counts)) {
                out[tvId] = { count: counts[tvId], latestMs: latestByTv[tvId] };
            }
            setCrashesByTv(out);
        }, (err) => console.warn('tv_crash_logs subscription failed:', err));
        return unsub;
    }, []);

    const [nowTick, setNowTick] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNowTick(Date.now()), 30_000);
        return () => clearInterval(id);
    }, []);

    // Location filter chips. 'all' shows every TV; a specific value
    // narrows to that store. Defaults to the admin's current store
    // so opening the page lands on the most-relevant set.
    const [locFilter, setLocFilter] = useState(() => storeLocation || 'all');

    // Pair Device modal visibility. The modal does its own code
    // generation + Firestore writes — we just toggle it open here
    // and pass the live configs + heartbeats so it can show a
    // current "pick a TV" list without re-subscribing.
    const [showPairModal, setShowPairModal] = useState(false);
    // Version-history modal target — null when closed, or the
    // ScreenCard's screen object when open. Holding the whole
    // screen (not just tvId) so the modal can show label/etc.
    // without re-querying.
    const [historyTarget, setHistoryTarget] = useState(null);
    // Templates gallery visibility. Same per-modal toggle pattern
    // as the Pair + History modals.
    const [showTemplatesModal, setShowTemplatesModal] = useState(false);
    // Page tab — 'screens' (dashboard grid + editor) or 'holidays'
    // (date-bound TV overlays). Defaults to screens since that's the
    // bread-and-butter view. Holidays tab is the second-most-common
    // admin task; keeping both within one URL avoids router changes.
    const [pageTab, setPageTab] = useState('screens');

    // Pull the always-present "default URL" rows (webster / maryland
    // each work without a config doc) into the dashboard so the card
    // grid covers everything the TVs can actually point at.
    const baseUrl = useMemo(() => {
        try { return `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}`.replace(/\/$/, ''); }
        catch { return 'https://app.ddmaustl.com'; }
    }, []);

    // Build a merged list: configured TVs + synthetic default rows
    // for any location that doesn't yet have a config override + ANY
    // heartbeat that doesn't yet have a matching config (an
    // unrecognized Pi pointed at a custom URL we haven't configured —
    // we surface it as a ghost card so admin can see and adopt it).
    const screens = useMemo(() => {
        const seenTvIds = new Set();
        const out = configs.map(c => {
            seenTvIds.add(c.tvId);
            return {
                tvId: c.tvId,
                label: c.label || c.tvId,
                location: c.location || 'webster',
                mode: c.mode || MODES.MENU,
                layout: c.layout || 'dense',
                updatedAt: c.updatedAt,
                updatedBy: c.updatedBy,
                heartbeat: heartbeats[c.tvId] || null,
                recentCrashes: crashesByTv[c.tvId] || null,
                isDefault: false,
                isGhost: false,
                cfg: c,
            };
        });
        // Synthetic default rows for the two reserved tvIds (?tv=webster
        // and ?tv=maryland always render, even without a config doc).
        for (const loc of ['webster', 'maryland']) {
            if (!seenTvIds.has(loc)) {
                seenTvIds.add(loc);
                out.push({
                    tvId: loc,
                    label: `${LOC_LABEL[loc]} default`,
                    location: loc,
                    mode: MODES.MENU,
                    layout: 'dense',
                    updatedAt: null,
                    heartbeat: heartbeats[loc] || null,
                    recentCrashes: crashesByTv[loc] || null,
                    isDefault: true,
                    isGhost: false,
                });
            }
        }
        // Ghost rows for tvIds that have a heartbeat but no config —
        // i.e. a Pi pointed at a URL we haven't registered yet. Sort
        // them at the bottom and tag them so the card UI offers
        // "Adopt this screen" as the primary action.
        for (const tvId of Object.keys(heartbeats)) {
            if (seenTvIds.has(tvId)) continue;
            const hb = heartbeats[tvId];
            out.push({
                tvId,
                label: `Unregistered · ${tvId}`,
                location: 'webster',
                mode: MODES.MENU,
                layout: 'dense',
                updatedAt: null,
                heartbeat: hb,
                recentCrashes: crashesByTv[tvId] || null,
                isDefault: false,
                isGhost: true,
            });
        }
        return out;
    // nowTick is a dep so the memo re-evaluates every 30s — keeps the
    // health-strip counters and the "Xm ago" labels fresh without
    // needing a separate clock prop drilled through every card.
    }, [configs, heartbeats, crashesByTv, nowTick]);

    const filteredScreens = useMemo(() => {
        if (locFilter === 'all') return screens;
        return screens.filter(s => s.location === locFilter);
    }, [screens, locFilter]);

    // Health strip stats — driven by heartbeats. We tally EVERY
    // screen the dashboard knows about (configured + defaults +
    // ghost), because to the admin "how many TVs are live right
    // now?" is the answer they care about — whether each TV has a
    // config doc is a separate concern. Unconfigured stays as its
    // own bucket so the admin still sees the "you have screens to
    // set up" nudge.
    const health = useMemo(() => {
        const live    = filteredScreens.filter(s => statusForHeartbeat(s.heartbeat) === 'live').length;
        const stale   = filteredScreens.filter(s => statusForHeartbeat(s.heartbeat) === 'stale').length;
        const offline = filteredScreens.filter(s => statusForHeartbeat(s.heartbeat) === 'offline').length;
        const unconfigured = filteredScreens.filter(s => s.isDefault).length;
        // Most-recent heartbeat across the filtered set — used in the
        // header as "last heartbeat Xm ago" so admin can tell at a
        // glance whether the dashboard is showing fresh data.
        const newest = filteredScreens.reduce((acc, s) => {
            const m = minutesSince(s.heartbeat?.lastSeenAt);
            return m !== null && (acc === null || m < acc) ? m : acc;
        }, null);
        return { total: filteredScreens.length, live, stale, offline, unconfigured, newestMin: newest };
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
                    {pageTab === 'screens' && (
                        <>
                            <button
                                onClick={() => openEditor({ isDefault: true, location: locFilter === 'all' ? 'webster' : locFilter })}
                                className="px-3.5 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 active:scale-95 transition shadow-sm">
                                + {tx('New screen', 'Nueva pantalla')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowPairModal(true)}
                                title={tx(
                                    'Generate a 6-digit code, type it on the Pi at /?pair=1, and the screen pairs itself.',
                                    'Genera un código de 6 dígitos, escríbelo en el Pi en /?pair=1, y la pantalla se vincula sola.',
                                )}
                                className="px-3.5 py-2 rounded-lg bg-white border border-dd-line text-sm font-bold text-dd-text hover:bg-dd-bg active:scale-95 transition">
                                🔗 {tx('Pair device', 'Vincular')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowTemplatesModal(true)}
                                title={tx('Start a new screen from a template — Food / Drinks / Specials / Photos / Promo / QR / Split.', 'Crea una pantalla desde una plantilla.')}
                                className="px-3.5 py-2 rounded-lg bg-white border border-dd-line text-sm font-bold text-dd-text hover:bg-dd-bg active:scale-95 transition">
                                🎨 {tx('Templates', 'Plantillas')}
                            </button>
                        </>
                    )}
                </div>
            </header>

            {/* Tab strip — 'screens' grid vs 'holidays' editor. Adding
                tabs keeps everything for TV management on one URL while
                separating the daily-use dashboard from the
                occasional-use holiday scheduler. */}
            <div className="flex gap-1 border-b border-dd-line">
                {[
                    { id: 'screens',  label: tx('📺 Screens',  '📺 Pantallas') },
                    { id: 'holidays', label: tx('🎄 Holidays', '🎄 Fiestas') },
                ].map(t => (
                    <button key={t.id} onClick={() => setPageTab(t.id)}
                        className={`px-4 py-2 text-sm font-bold border-b-2 -mb-px transition ${
                            pageTab === t.id
                                ? 'border-dd-green text-dd-text'
                                : 'border-transparent text-dd-text-2 hover:text-dd-text hover:bg-dd-bg'
                        }`}>
                        {t.label}
                    </button>
                ))}
            </div>

            {pageTab === 'holidays' && (
                <Suspense fallback={
                    <div className="text-xs text-gray-400 italic py-6 text-center">
                        {tx('Loading holidays…', 'Cargando fiestas…')}
                    </div>
                }>
                    <TvHolidaysEditor
                        language={language}
                        staffName={staffName}
                        tvConfigs={configs} />
                </Suspense>
            )}

            {pageTab === 'screens' && (<>

            {/* Health strip — 4 stats inline, color-coded. Reads from
                left to right: how many total, how many recently
                touched, how many getting stale, how many appear
                abandoned. The "last published" footnote on the right
                tells admins whether the dashboard is up to date. */}
            {/* One-time clarifier — admins kept asking whether the TV
                needed its own Toast sync. It doesn't: TVs read the
                SAME /ops/86_{location} doc the 86 board reads, which
                the Railway scraper pipeline keeps in sync with Toast.
                No per-TV setup needed. This tiny banner saves the
                recurring question. Hidden on small screens so it
                doesn't compete with the header actions. */}
            <div className="hidden md:flex items-center gap-2 text-[11px] text-dd-text-2 italic">
                <span>ℹ️</span>
                <span>
                    {tx(
                        'TVs auto-pull from your existing Toast 86 sync — no per-screen setup.',
                        'Las TVs usan tu sync de Toast existente — no se configura por pantalla.',
                    )}
                </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 md:gap-3 bg-white border border-dd-line rounded-xl px-3 py-2.5 shadow-sm">
                {/* health.total = filteredScreens.length already includes
                    the isDefault (unconfigured) rows, so adding
                    health.unconfigured double-counted them. */}
                <HealthStat label={tx('Total', 'Total')} value={health.total} tone="neutral" />
                <span className="text-dd-line">·</span>
                <HealthStat label={tx('Live', 'En vivo')} value={health.live} tone="good" />
                <HealthStat label={tx('Stale', 'Sin cambios')} value={health.stale} tone="warn" />
                <HealthStat label={tx('Offline', 'Sin actividad')} value={health.offline} tone="danger" />
                {health.unconfigured > 0 && (
                    <HealthStat label={tx('Unconfigured', 'Sin configurar')} value={health.unconfigured} tone="neutral" />
                )}
                <span className="flex-1" />
                {health.newestMin !== null ? (
                    <span className="text-[11px] text-dd-text-2 shrink-0">
                        {tx('Last heartbeat', 'Último latido')}: <span className="font-bold text-dd-text">{health.newestMin < 1 ? tx('just now', 'ahora') : `${health.newestMin} min`}</span>
                    </span>
                ) : (
                    <span className="text-[11px] text-dd-text-2 shrink-0 italic">
                        {tx('No devices yet', 'Sin dispositivos aún')}
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
                            staffName={staffName}
                            onEdit={() => openEditor(s)}
                            onShowHistory={() => setHistoryTarget(s)} />
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

            </>)}{/* end pageTab === 'screens' */}

            {/* Pair Device modal — lazy-loaded. Renders only when
                showPairModal is true so the chunk doesn't enter the
                graph for the common dashboard-view case. The modal
                handles its own Firestore writes; we just pass the
                live configs + heartbeats so it can render the
                "pick a TV" list without re-subscribing. */}
            {showPairModal && (
                <Suspense fallback={null}>
                    <PairDeviceModal
                        language={language}
                        staffName={staffName}
                        configs={configs}
                        heartbeats={heartbeats}
                        onClose={() => setShowPairModal(false)} />
                </Suspense>
            )}

            {/* Version history modal — same lazy-mount pattern as
                Pair. Renders only when a card's History/version
                badge has been tapped. */}
            {historyTarget && (
                <Suspense fallback={null}>
                    <TvConfigVersionsModal
                        language={language}
                        staffName={staffName}
                        tvId={historyTarget.tvId}
                        label={historyTarget.label}
                        onClose={() => setHistoryTarget(null)} />
                </Suspense>
            )}

            {/* Templates gallery — pick a starter config, name the
                screen, create + drop into the editor. */}
            {showTemplatesModal && (
                <Suspense fallback={null}>
                    <TvTemplatesModal
                        language={language}
                        staffName={staffName}
                        defaultLocation={locFilter === 'all' ? 'webster' : locFilter}
                        existingTvIds={configs.map(c => c.tvId)}
                        onClose={() => setShowTemplatesModal(false)} />
                </Suspense>
            )}
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
function ScreenCard({ screen, baseUrl, isEs, staffName, onEdit, onShowHistory }) {
    const tx = (en, es) => (isEs ? es : en);
    const url = `${baseUrl}/?tv=${screen.tvId}`;
    // Draft + version state from the underlying tv_config doc.
    // Synthesized "default" / "ghost" screens never carry these
    // fields so the badges + buttons hide naturally for those rows.
    const hasDraft       = !!screen.cfg?.draftSnapshot;
    const publishedVer   = Number(screen.cfg?.publishedVersion || 0);
    const showVersion    = !screen.isDefault && publishedVer > 0;
    const [busyAction, setBusyAction] = useState(null); // 'publish' | 'discard' | null
    const [errMsg, setErrMsg]         = useState(null);

    async function handlePublishDraft() {
        if (busyAction) return;
        setBusyAction('publish');
        setErrMsg(null);
        try {
            await publishTvConfigDraft({ tvId: screen.tvId, byName: staffName });
        } catch (e) {
            setErrMsg(e?.message || 'Publish failed');
        } finally {
            setBusyAction(null);
        }
    }
    async function handleDiscardDraft() {
        if (busyAction) return;
        const ok = window.confirm(tx(
            'Discard the pending draft for this screen? The published version stays live.',
            '¿Descartar el borrador pendiente? La versión publicada continúa en vivo.',
        ));
        if (!ok) return;
        setBusyAction('discard');
        setErrMsg(null);
        try {
            await discardTvConfigDraft({ tvId: screen.tvId, byName: staffName });
        } catch (e) {
            setErrMsg(e?.message || 'Discard failed');
        } finally {
            setBusyAction(null);
        }
    }
    // Status comes from the heartbeat, not the config — admins want
    // to know "is the screen actually showing my menu right now?",
    // not "did I edit this last week?". The two distinct meanings of
    // "never" diverge here: ghost screens get a special "New device"
    // pill (Pi heartbeat present but no config) so admin notices
    // the unbound TV and clicks Adopt.
    const status = statusForHeartbeat(screen.heartbeat);
    const isNewDevice = screen.isGhost && status === 'live';
    const statusPill = isNewDevice
        ? { bg: 'bg-sky-50',     border: 'border-sky-300',     text: 'text-sky-700',     dot: 'bg-sky-500',     label: tx('New device',   'Nuevo') }
        : {
            live:    { bg: 'bg-emerald-50',  border: 'border-emerald-300', text: 'text-emerald-700', dot: 'bg-emerald-500', label: tx('Live',         'En vivo') },
            stale:   { bg: 'bg-amber-50',    border: 'border-amber-300',   text: 'text-amber-700',   dot: 'bg-amber-500',   label: tx('Stale',        'Antiguo') },
            offline: { bg: 'bg-red-50',      border: 'border-red-300',     text: 'text-red-700',     dot: 'bg-red-500',     label: tx('Offline',      'Sin conexión') },
            never:   { bg: 'bg-dd-bg',       border: 'border-dd-line',     text: 'text-dd-text-2',   dot: 'bg-gray-400',    label: tx('Not paired',   'Sin vincular') },
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
                {/* Crash badge — top-LEFT corner. Shows when this TV's
                    TvErrorBoundary has caught a render crash in the
                    last 24h. The Pi auto-reloads after 30s so heartbeat
                    can stay green; this is the only surface that tells
                    admin a screen is unstable. Pulse animation draws
                    the eye even at a glance across a 10-card grid. */}
                {screen.recentCrashes?.count > 0 && (
                    <span className="absolute top-2 left-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-red-300 bg-red-50 text-red-800 text-[10px] font-black uppercase tracking-wider shadow-sm animate-pulse"
                        title={tx(
                            `${screen.recentCrashes.count} render crash(es) in last 24h — most recent ${relativeLabel({ toMillis: () => screen.recentCrashes.latestMs }, isEs)}. Admin → Menu Screens → click "Health" later to see stack traces.`,
                            `${screen.recentCrashes.count} caída(s) en últimas 24h`,
                        )}>
                        ⚠️ {screen.recentCrashes.count}× {tx('crash', 'caída')}
                    </span>
                )}
            </div>

            {/* Card body — label, location chip, mode badge, last
                seen + last edited. The relative-time stamp prefers
                heartbeat ("seen 30s ago" — what's happening RIGHT
                NOW) and falls back to config updatedAt ("edited 2d
                ago" — what we know about it) so a card always shows
                the freshest signal available. Action row below has
                primary (Edit) and secondary (Open, Copy URL). */}
            <div className="p-3 flex-1 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-black text-dd-text leading-tight truncate">{screen.label}</h3>
                    {screen.heartbeat?.lastSeenAt ? (
                        <span className="text-[10px] font-bold text-dd-text-2 shrink-0" title={tx('Last heartbeat', 'Último latido')}>
                            👁 {relativeLabel(screen.heartbeat.lastSeenAt, isEs)}
                        </span>
                    ) : (
                        <span className="text-[10px] font-bold text-dd-text-2 shrink-0" title={tx('Last edited', 'Última edición')}>
                            ✏ {relativeLabel(screen.updatedAt, isEs)}
                        </span>
                    )}
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
                    {/* Published version badge — only shown once the
                        new publish flow has touched this config (first
                        save under the flow becomes v1). Synth defaults
                        and ghost screens have no version. */}
                    {showVersion && (
                        <span
                            className="px-1.5 py-0.5 rounded bg-white text-dd-text-2 border border-dd-line cursor-pointer hover:bg-dd-bg"
                            onClick={onShowHistory}
                            title={tx('View version history', 'Ver historial')}>
                            v{publishedVer}
                        </span>
                    )}
                    {hasDraft && (
                        <span className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-300 inline-flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
                            {tx('Draft', 'Borrador')}
                        </span>
                    )}
                </div>

                {/* Draft action row — only renders when this screen
                    has an unpublished draft. Lifted to its own row
                    above the main actions so the Publish CTA is the
                    most prominent thing in the card right now. */}
                {hasDraft && (
                    <div className="mt-1 p-2 bg-sky-50 border border-sky-200 rounded-lg flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] text-sky-900 font-bold flex-1 min-w-0 truncate">
                            📝 {tx('Unpublished draft saved', 'Borrador sin publicar')}
                        </span>
                        <button onClick={handlePublishDraft}
                            disabled={!!busyAction}
                            className="px-2.5 py-1 rounded-md bg-sky-600 text-white text-[11px] font-bold hover:bg-sky-700 active:scale-95 transition disabled:opacity-60">
                            {busyAction === 'publish' ? tx('Publishing…', 'Publicando…') : `⬆ ${tx('Publish', 'Publicar')}`}
                        </button>
                        <button onClick={handleDiscardDraft}
                            disabled={!!busyAction}
                            className="px-2.5 py-1 rounded-md bg-white border border-sky-200 text-sky-700 text-[11px] font-bold hover:bg-sky-100 disabled:opacity-60">
                            {busyAction === 'discard' ? tx('Discarding…', 'Descartando…') : `✕ ${tx('Discard', 'Descartar')}`}
                        </button>
                        {errMsg && (
                            <span className="basis-full text-[10px] text-red-700 font-bold">⚠ {errMsg}</span>
                        )}
                    </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    <button onClick={onEdit}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold active:scale-95 transition ${
                            screen.isGhost
                                ? 'bg-sky-600 text-white hover:bg-sky-700'
                                : 'bg-dd-green text-white hover:bg-dd-green-700'
                        }`}>
                        {screen.isGhost ? `🔗 ${tx('Adopt', 'Adoptar')}` : `✏ ${tx('Edit', 'Editar')}`}
                    </button>
                    <a href={url} target="_blank" rel="noreferrer"
                        className="px-2.5 py-1 rounded-lg bg-white border border-dd-line text-[11px] font-bold text-dd-text-2 hover:bg-dd-bg">
                        ↗ {tx('Open', 'Abrir')}
                    </a>
                    <button onClick={copyUrl}
                        className="px-2.5 py-1 rounded-lg bg-white border border-dd-line text-[11px] font-bold text-dd-text-2 hover:bg-dd-bg">
                        📋 {tx('Copy URL', 'Copiar URL')}
                    </button>
                    {/* History button — only relevant for configured
                        screens that have at least one version archived.
                        Synth defaults + ghosts don't have history yet,
                        and showing the button for v1 (no prior version
                        archived) would dump admin into an empty modal. */}
                    {showVersion && publishedVer > 1 && (
                        <button onClick={onShowHistory}
                            title={tx('Version history & rollback', 'Historial y reversión')}
                            className="px-2.5 py-1 rounded-lg bg-white border border-dd-line text-[11px] font-bold text-dd-text-2 hover:bg-dd-bg">
                            🕰 {tx('History', 'Historial')}
                        </button>
                    )}
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
