import { useState, useEffect, useRef, useMemo, lazy, memo, Suspense, Component } from 'react';
import { db } from './firebase';
import { doc, getDoc, setDoc, collection, getDocs, query, limit, writeBatch } from 'firebase/firestore';
import { onSnapshot } from 'firebase/firestore';
import { t } from './data/translations';
import { isAdmin, DEFAULT_STAFF, LOCATION_LABELS, canSeePage, canViewOnboarding } from './data/staff';
import { enableFcmPush, disableFcmPush, onForegroundMessage } from './messaging';
import { playKitchenBell } from './data/bell';
// Components — eagerly loaded (needed immediately)
import HomePage from './components/HomePage';
import InstallAppButton from './components/InstallAppButton';
import AppVersion from './components/AppVersion';
// AppToast is mounted at root in main.jsx (not here) so it renders
// across every code path including the lock screen and the public
// onboarding/apply routes that bypass App's main shell.
// Eager-loaded — the off-site prompt has to fire as soon as the staff
// signs in so we don't gate it behind a tab-chunk download. The
// component is tiny (~3KB gzipped) and unrendered (returns null) when
// the staff has no pending/active off-site shift.
import OffsiteClockPrompt from './components/OffsiteClockPrompt';
// v2 design preview — gated by ?v2=1 query param.
const AppShellV2 = lazy(() => import('./v2/AppShellV2'));
const HomeV2 = lazy(() => import('./v2/HomeV2'));
const MobileHome = lazy(() => import('./v2/MobileHome'));
import useIsMobile from './v2/useIsMobile';
import useGeofence from './components/hooks/useGeofence';
import usePullToRefresh, { forceRefresh } from './components/hooks/usePullToRefresh';
import { RefreshCw } from 'lucide-react';
// Components — lazy loaded (only when tab is active)
const TrainingHub = lazy(() => import('./components/TrainingHub').then(m => ({ default: memo(m.default) })));
// memo-wrap the heaviest routes — Andrew 2026-05-21: "the site is
// still very glitchy". When a staff member's lastSeen ticks (which
// fires the /config/staff onSnapshot), App.jsx re-renders. Without
// memo each heavy route's function body would run again on every
// such tick — its 12-16 hooks each iterating deps, even though
// nothing the route cares about changed. memo here uses the default
// shallow prop compare; the access-gate useMemo block further down
// stabilizes the boolean props so shallow compare actually catches
// the no-op cases.
// Andrew 2026-05-21 perf pass 3: extend the memo wrap to every lazy
// route. Each one's body re-runs on every parent re-render (e.g.
// staffList tick from a lastSeen update) unless memo skips it. The
// access-gate useMemo block below stabilizes the boolean props so
// memo's shallow compare can actually catch the no-op renders.
const Operations = lazy(() => import('./components/Operations').then(m => ({ default: memo(m.default) })));
// Staff-facing personal task list — what's been assigned to me by managers
// via Operations → Assign Tasks. Visible to every signed-in staff member.
const MyTasksPanel = lazy(() => import('./components/MyTasksPanel').then(m => ({ default: memo(m.default) })));
const MenuReference = lazy(() => import('./components/MenuReference').then(m => ({ default: memo(m.default) })));
const DateStickerPrinter = lazy(() => import('./components/DateStickerPrinter').then(m => ({ default: memo(m.default) })));
const Schedule = lazy(() => import('./components/Schedule').then(m => ({ default: memo(m.default) })));
const Recipes = lazy(() => import('./components/Recipes').then(m => ({ default: memo(m.default) })));
const LaborDashboard = lazy(() => import('./components/LaborDashboard').then(m => ({ default: memo(m.default) })));
const Eighty6Dashboard = lazy(() => import('./components/Eighty6Dashboard').then(m => ({ default: memo(m.default) })));
const CateringOrder = lazy(() => import('./components/CateringOrder').then(m => ({ default: memo(m.default) })));
const MaintenanceRequest = lazy(() => import('./components/MaintenanceRequest').then(m => ({ default: memo(m.default) })));
const AdminPanel = lazy(() => import('./components/AdminPanel').then(m => ({ default: memo(m.default) })));
// 2026-05-24 — per-staff push opt-out matrix (admin only). See
// src/data/notificationTypes.js for the type registry.
const NotificationsAdmin = lazy(() => import('./components/NotificationsAdmin'));
// 📧 Inbox triage — owner-only admin tab (Andrew 2026-05-26). Reads
// /email_intel written by the pollGmail Cloud Function. Lazy because
// non-owners never load it.
const InboxTriage = lazy(() => import('./components/InboxTriage'));
const InsuranceEnrollment = lazy(() => import('./components/InsuranceEnrollment').then(m => ({ default: memo(m.default) })));
const AiAssistant = lazy(() => import('./components/AiAssistant').then(m => ({ default: memo(m.default) })));
const TardinessTracker = lazy(() => import('./components/TardinessTracker').then(m => ({ default: memo(m.default) })));
const ShiftHandoff = lazy(() => import('./components/ShiftHandoff').then(m => ({ default: memo(m.default) })));
const Onboarding = lazy(() => import('./components/Onboarding').then(m => ({ default: memo(m.default) })));
const ChatCenter = lazy(() => import('./components/ChatCenter').then(m => ({ default: memo(m.default) })));
// Menu Screens dashboard — admin-only TV signage management page,
// promoted out of AdminPanel on 2026-05-23 so it has room to grow
// into a Yodeck / OptiSigns / Raydiant-style dashboard.
const MenuScreensPage = lazy(() => import('./components/MenuScreensPage').then(m => ({ default: memo(m.default) })));
// Admin Health — read-only system status page (Firestore liveness,
// TVs, backups, recent audit). Surfaces "is this broken or is it
// me?" data in one place so admins stop hunting across 4 tabs.
const AdminHealthPage = lazy(() => import('./components/AdminHealthPage').then(m => ({ default: memo(m.default) })));
// Error Report — owner-only triage view for /error_logs + /bug_reports
// + AI failures. Andrew 2026-05-27: "lets not put errors in the
// notifications. make a spot where i can say look at the error report
// and we both can see all the errors." This is that spot. Sections
// moved out of AdminHealthPage so Health stays focused on systems
// status and ErrorReport is a single-purpose tab.
const ErrorReportPage = lazy(() => import('./components/ErrorReportPage').then(m => ({ default: memo(m.default) })));
// Label Printing Center — admin-only label-printer dashboard. Test
// prints, per-printer status, and a live feed of recent print jobs
// (success / fail / error message) sourced from /print_jobs.
const LabelPrintingCenter = lazy(() => import('./components/LabelPrintingCenter').then(m => ({ default: memo(m.default) })));
// Per-page error boundary. Wraps the high-risk routes (Schedule,
// Operations, ChatCenter, AdminPanel) so a sync render crash in
// one tab leaves the rest of the app usable + offers Try Again /
// Refresh recovery instead of falling through to the global
// stale-chunk handler. Eager import — class component is ~2KB and
// always needed at render time, no point lazy-loading it.
import PageErrorBoundary from './components/PageErrorBoundary';
// Bug-logging system (Andrew 2026-05-26). Eager imports — the global
// handlers install at module init, and the floating bug-report button
// is mounted on every signed-in screen so it has to be available
// without a lazy chunk fetch. Both are tiny.
//   • installGlobalHandlers — wires window.onerror + unhandledrejection
//     into /error_logs (non-chunk errors only; chunk errors keep the
//     existing auto-reload path above).
//   • setIdentity — pushes the signed-in staff's id/role/location to
//     window globals so every log row carries who-was-it metadata.
//   • logError — used directly here by the global ErrorBoundary on
//     non-chunk crashes.
// 2026-05-27 — ReportProblemButton + import removed (Andrew: "lets
// delete the staff enter bug program"). Cloud Function +
// /bug_reports rules left intact for historical data; staff just
// can't file new reports through the UI anymore.
import { installGlobalHandlers, setIdentity, logError } from './data/logger';
const OnboardingPortal = lazy(() => import('./components/OnboardingPortal'));
const OnboardingApply = lazy(() => import('./components/OnboardingApply'));
const InstallSplash = lazy(() => import('./components/InstallSplash'));
const RequiredTaskFlow = lazy(() => import('./components/RequiredTaskFlow'));
const MenuDisplay = lazy(() => import('./components/MenuDisplay'));
// Pi-side pairing screen — full-screen 6-digit code entry. Lazy
// because only a TV that's deliberately hitting /?pair=1 ever needs
// this chunk, and the rest of the app should never carry the cost.
const PairDevicePage = lazy(() => import('./components/PairDevicePage'));
// Wall-mount kitchen task display. Public URL (?display=walltasks&...)
// bypasses the PIN, mirrors the ?tv= MenuDisplay pattern. Andrew 5/21:
// "small monitor that i can hang up that we can put today task on".
const TaskDisplay = lazy(() => import('./components/TaskDisplay'));

// Pre-warmed chunk fetchers. React.lazy() above only fetches a chunk
// when the component first renders. Calling these import() URLs
// earlier (e.g. after Home settles) lets the browser cache the chunk
// in the background; the next tap on Schedule / Operations / Recipes
// then resolves instantly instead of waiting on a network round-trip.
//
// We don't capture the result — Vite's HMR + Rollup's chunk graph
// dedupe so the lazy() promise hits the same cached chunk. The
// .catch() swallows transient network errors; the lazy() call will
// retry on real render with normal error handling.
const prewarmChunks = () => {
    import('./components/Schedule').catch(() => {});
    import('./components/Operations').catch(() => {});
    import('./components/Recipes').catch(() => {});
    import('./components/MenuReference').catch(() => {});
    import('./components/Eighty6Dashboard').catch(() => {});
    // Chat is a primary tile on MobileHome and a daily destination for
    // every staff member — pre-warming it removes the brief spinner the
    // first time someone taps the chat tile after sign-in.
    import('./components/ChatCenter').catch(() => {});
    // Pull in the ChatThread + commonly-mounted lazy children of
    // ChatCenter at the same time so a tap into a specific chat
    // doesn't restart the chunk-fetch dance.
    import('./components/ChatThread').catch(() => {});
};

// Error boundary — catches render errors in child components.
//
// The recurring "Something went wrong → refresh fixes it" pattern Andrew
// reported (2026-05-14) is almost always a stale-chunk error: a phone has
// the old index.html in cache, clicks a lazy-loaded route, and the import
// tries to fetch a hash that no longer exists on the server. The browser
// throws `ChunkLoadError` / "Failed to fetch dynamically imported module"
// / "Importing a module script failed", which lands here.
//
// Two behavior changes:
//   1. Detect chunk-load errors and AUTO-RELOAD the whole app once. The
//      `triedReload` localStorage flag prevents a reload loop if the
//      reload itself fails for some other reason.
//   2. Show the real error message in dev so we can debug what's actually
//      breaking. Production still shows a friendly message but now
//      includes the error name (e.g. "ChunkLoadError") so support can
//      diagnose at a glance.
const CHUNK_ERR_PATTERN = /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|dynamically imported module|Failed to load module/i;
const RELOAD_FLAG_KEY = "ddmau:errorBoundaryReloaded";

class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, errorInfo) {
        console.error("ErrorBoundary caught:", error, errorInfo);
        // Stale-chunk recovery: hard-reload once. If reload happens to be
        // racing some other failure we'd loop forever, so guard with a
        // localStorage flag set right before reload and cleared on the
        // next successful render (see useEffect in App below).
        try {
            const msg = (error && (error.message || error.toString())) || "";
            const name = error?.name || "";
            const isChunkErr = CHUNK_ERR_PATTERN.test(msg) || name === "ChunkLoadError";
            const alreadyTried = (() => {
                try { return sessionStorage.getItem(RELOAD_FLAG_KEY); } catch { return null; }
            })();
            if (isChunkErr && !alreadyTried) {
                try { sessionStorage.setItem(RELOAD_FLAG_KEY, String(Date.now())); } catch {}
                // Use replace to avoid adding to history; defer so React
                // can finish painting the fallback (in case reload is
                // blocked, the user still sees the friendly message).
                setTimeout(() => { window.location.reload(); }, 50);
            } else if (!isChunkErr) {
                // Non-chunk crash that fell all the way to the global
                // boundary — almost always a top-level render bug (e.g.
                // App.jsx itself threw, before any PageErrorBoundary could
                // catch it). Drop a row in /error_logs at severity=critical
                // so it pages the owners via the onCriticalError CF.
                // Fire-and-forget; the boundary's render() still paints
                // its friendly fallback below.
                try {
                    Promise.resolve(logError({
                        error,
                        severity: 'critical',
                        feature: 'app-shell',
                        meta: { componentStack: errorInfo?.componentStack?.slice(0, 4000) },
                    })).catch(() => {});
                } catch {}
            }
        } catch (_) { /* swallow — fallback UI still rendered */ }
    }
    render() {
        if (this.state.hasError) {
            const isEs = this.props.language === "es";
            const errName = this.state.error?.name || "Error";
            const isChunk = CHUNK_ERR_PATTERN.test(this.state.error?.message || "") || errName === "ChunkLoadError";
            return (
                <div style={{padding: "32px 16px", textAlign: "center"}}>
                    <p style={{fontSize: "40px", marginBottom: "12px"}}>⚠️</p>
                    <p style={{fontSize: "18px", fontWeight: 700, color: "#dc2626", marginBottom: "8px"}}>
                        {isEs ? "Algo salió mal" : "Something went wrong"}
                    </p>
                    <p style={{fontSize: "14px", color: "#6b7280", marginBottom: "8px"}}>
                        {isChunk
                            ? (isEs ? "Actualizando la app… espera un momento." : "Updating the app — one moment.")
                            : (isEs ? "Esta sección tuvo un error. Intenta recargar." : "This section had an error. Try reloading.")}
                    </p>
                    {/* Show error type for diagnosis (not the full stack — keeps it user-friendly). */}
                    <p style={{fontSize: "11px", color: "#9ca3af", marginBottom: "16px", fontFamily: "monospace"}}>
                        {errName}
                    </p>
                    <button onClick={() => { this.setState({ hasError: false, error: null }); try { sessionStorage.removeItem(RELOAD_FLAG_KEY); } catch {} }}
                        style={{padding: "10px 24px", background: "#059669", color: "white", border: "none", borderRadius: "8px", fontWeight: 700, fontSize: "14px", cursor: "pointer", marginRight: "8px"}}>
                        {isEs ? "Reintentar" : "Try Again"}
                    </button>
                    <button onClick={() => { try { sessionStorage.removeItem(RELOAD_FLAG_KEY); } catch {} window.location.reload(); }}
                        style={{padding: "10px 24px", background: "#fff", color: "#374151", border: "1px solid #d1d5db", borderRadius: "8px", fontWeight: 700, fontSize: "14px", cursor: "pointer"}}>
                        {isEs ? "Recargar" : "Reload"}
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

// Clears the reload-flag on first successful render so the next chunk
// error gets one fresh auto-reload attempt. Lives outside the boundary
// because the boundary itself only mounts when something throws.
function ChunkReloadFlagReset() {
    useEffect(() => {
        try { sessionStorage.removeItem(RELOAD_FLAG_KEY); } catch {}
    }, []);
    return null;
}

// Catch chunk-load errors that slip past the React boundary (e.g. when a
// lazy import is triggered from inside an async callback after the
// boundary has unmounted, or from outside a React tree). Same one-shot
// auto-reload behavior as the boundary.
if (typeof window !== "undefined") {
    const maybeReload = (msg, name) => {
        try {
            const isChunk = CHUNK_ERR_PATTERN.test(msg || "") || name === "ChunkLoadError";
            if (!isChunk) return;
            const alreadyTried = sessionStorage.getItem(RELOAD_FLAG_KEY);
            if (alreadyTried) return;
            sessionStorage.setItem(RELOAD_FLAG_KEY, String(Date.now()));
            setTimeout(() => { window.location.reload(); }, 50);
        } catch {}
    };
    window.addEventListener("error", (e) => {
        maybeReload(e?.message, e?.error?.name);
    });
    window.addEventListener("unhandledrejection", (e) => {
        const r = e?.reason;
        maybeReload(r?.message || String(r || ""), r?.name);
    });
}

// Bug-logging system — install the /error_logs handlers alongside the
// chunk-reload listeners above. Both run; the chunk listener has its
// own ChunkLoadError filter to dedupe. installGlobalHandlers() is
// idempotent (self-guards via window.__ddmau_loggerInstalled) so HMR
// double-mounting in dev won't double-bind.
try { installGlobalHandlers(); } catch {}

// Loading spinner for lazy-loaded components
function TabLoading({ language }) {
    return (
        <div style={{padding: "48px 16px", textAlign: "center"}}>
            <div style={{width: "32px", height: "32px", border: "3px solid #e5e7eb", borderTopColor: "#059669", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px"}} />
            <p style={{fontSize: "14px", color: "#9ca3af"}}>{language === "es" ? "Cargando..." : "Loading..."}</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
}

// Version check hook — polls /version.json every 2 minutes
function useVersionCheck() {
    const [updateAvailable, setUpdateAvailable] = useState(false);
    const savedVersion = useRef(null);
    useEffect(() => {
        // 2026-05-24 audit fix:
        //   1. Was polling unconditionally including while the tab is
        //      hidden — wasted bandwidth + battery on phones in pockets.
        //      Now gated on visibilityState === 'visible'.
        //   2. No AbortController — a slow fetch on cellular could stack
        //      with the next interval. Now cancels in-flight requests on
        //      cleanup AND when the next check kicks in.
        let timer;
        let currentController = null;
        async function check() {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            try { currentController?.abort(); } catch {}
            currentController = new AbortController();
            try {
                const res = await fetch("/version.json?t=" + Date.now(), { signal: currentController.signal });
                if (!res.ok) return;
                const data = await res.json();
                if (savedVersion.current === null) {
                    savedVersion.current = data.v;
                } else if (data.v !== savedVersion.current) {
                    setUpdateAvailable(true);
                }
            } catch (e) { /* ignore (aborts + transient network) */ }
        }
        check();
        timer = setInterval(check, 2 * 60 * 1000);
        return () => {
            clearInterval(timer);
            try { currentController?.abort(); } catch {}
        };
    }, []);
    return updateAvailable;
}

// One-time migration: copy old non-suffixed docs/collections to _webster if they exist
async function runMigrations() {
    try {
        const docMigrations = [
            { from: "ops/checklists2", to: "ops/checklists2_webster" },
            { from: "ops/inventory", to: "ops/inventory_webster" }
        ];
        for (const m of docMigrations) {
            const [fromCol, fromDoc] = m.from.split('/');
            const [toCol, toDoc] = m.to.split('/');
            const newDocSnap = await getDoc(doc(db, toCol, toDoc));
            if (!newDocSnap.exists()) {
                const oldDocSnap = await getDoc(doc(db, fromCol, fromDoc));
                if (oldDocSnap.exists()) {
                    await setDoc(doc(db, toCol, toDoc), oldDocSnap.data());
                    console.log("Migrated " + m.from + " → " + m.to);
                }
            }
        }
        const collMigrations = [
            { from: "checklistHistory", to: "checklistHistory_webster" },
            { from: "inventoryHistory", to: "inventoryHistory_webster" }
        ];
        for (const m of collMigrations) {
            const newSnap = await getDocs(query(collection(db, m.to), limit(1)));
            if (newSnap.empty) {
                const oldSnap = await getDocs(collection(db, m.from));
                if (!oldSnap.empty) {
                    const batch = writeBatch(db);
                    oldSnap.forEach(d => batch.set(doc(db, m.to, d.id), d.data()));
                    await batch.commit();
                    console.log("Migrated collection " + m.from + " → " + m.to + " (" + oldSnap.size + " docs)");
                }
            }
        }
    } catch (err) { console.error("Migration error:", err); }
}
let migrationRan = false;

// Session persistence — pulls down/refreshing the page should keep the user
// signed in on the same tab instead of bouncing them to the staff picker.
// All saved keys live under "ddmau:*". Logout clears them.
const SS = {
    get: (k, d = null) => { try { return localStorage.getItem("ddmau:" + k) ?? d; } catch { return d; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem("ddmau:" + k) : localStorage.setItem("ddmau:" + k, v); } catch {} },
};

// ── Lock on app close (PWA + tab) ──────────────────────────────────────
//
// Andrew's request: closing the app on his iPhone should require a PIN on
// reopen. localStorage alone keeps the user signed in across closes (the
// browser persists it forever). To get "stays signed in on refresh, locks
// on close" we add two layers:
//
//   1. Cold-launch detection via sessionStorage: this storage SURVIVES a
//      page refresh (same tab/PWA) but is CLEARED when the tab is fully
//      closed or the iOS PWA is swiped away. We set a marker on every
//      page load; if the marker wasn't already there, this is a fresh
//      launch — clear staffName so the lock screen shows. Runs at module
//      load, BEFORE any React state initializes.
//
//   2. Idle-timeout (below, inside App): if the page is left in the
//      background for more than IDLE_LOCK_MS, lock on return-to-visible.
//      Backstop for the "I left my phone unlocked on the counter" case.
//
// Manual logout still works via setStaffName(null) which clears the
// localStorage key directly — no special handling needed.
const IDLE_LOCK_MS = 5 * 60 * 1000;   // 5 minutes of being hidden = relock

// PullToRefreshIndicator — visible feedback during the pull-down
// gesture. The hook (usePullToRefresh) was already wired and force-
// reloading correctly, but its return values were going nowhere on
// screen — so the user pulled and saw no feedback until the page
// reloaded itself. Andrew 2026-05-28 asked for "that refresh button
// spinning" while pulling.
//
// Behavior matches native iOS Mail / Twitter:
//   • Hidden when idle (no pull, no refresh in flight).
//   • Visible bubble translates DOWN with the finger as the user
//     pulls; rotation tracks pull-progress 0..360deg so the icon
//     winds up like a tension spring.
//   • When the user has held past threshold long enough (armed=true,
//     500ms dwell) the bubble pulses scale + turns brand-green to
//     telegraph "let go and I'll refresh."
//   • Once refresh fires (refreshing=true) the bubble snaps to a
//     fixed top offset and switches to a continuous spin animation
//     for the brief moment before the page reload.
//
// Mobile only (md:hidden); desktop has its own refresh affordances
// (Cmd-R, sidebar refresh button) and doesn't need this overlay.
function PullToRefreshIndicator({ pullDistance, progress, refreshing, armed }) {
    if (pullDistance === 0 && !refreshing) return null;
    // Dampen the visual translation so the bubble settles around 60-80px
    // even on aggressive pulls — the hook already rubber-bands the raw
    // distance past 200, this scales that for the indicator separately.
    const translateY = refreshing
        ? 28
        : Math.min(pullDistance * 0.45, 80);
    const rotationDeg = refreshing ? 0 : Math.round(progress * 360);
    return (
        <div
            aria-hidden="true"
            className="md:hidden fixed top-0 left-1/2 z-50 pointer-events-none"
            style={{
                transform: `translate(-50%, ${translateY}px)`,
                transition: refreshing ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none',
            }}
        >
            <div
                className={`w-11 h-11 rounded-full bg-white/90 backdrop-blur-sm shadow-lg border border-dd-line/40 flex items-center justify-center transition-transform duration-200 ease-out ${
                    armed && !refreshing ? 'scale-110' : 'scale-100'
                }`}
            >
                <RefreshCw
                    size={20}
                    strokeWidth={2.5}
                    className={
                        refreshing
                            ? 'animate-spin text-dd-green'
                            : armed
                                ? 'text-dd-green'
                                : 'text-dd-text-2'
                    }
                    style={refreshing ? undefined : { transform: `rotate(${rotationDeg}deg)` }}
                    aria-hidden="true"
                />
            </div>
        </div>
    );
}
// Module-scope stable empty array used as a default for the
// hiddenPages memo (Audit #13). Defined once at module load so
// every render returns the SAME reference — lets memo-wrapped
// child components skip re-rendering when nothing meaningful
// changed. Don't push into this; treat as frozen.
const EMPTY_ARRAY = Object.freeze([]);
try {
    if (typeof window !== 'undefined') {
        const alive = sessionStorage.getItem('ddmau:sessionAlive');
        if (!alive) {
            // Cold launch — wipe the persisted auth state so the PIN screen
            // is the first thing the user sees.
            const priorStaff = localStorage.getItem('ddmau:staffName');
            localStorage.removeItem('ddmau:staffName');
            // 2026-05-24 audit fix: also tell FCM to invalidate this
            // device's token + clear the prior staff's fcmTokens entry.
            // Otherwise: shared-iPad-at-restaurant goes cold overnight,
            // the morning's first PIN-locked device is still receiving
            // push notifications for last night's staffer (which show
            // on the OS lockscreen). Fire-and-forget — never block UI on
            // FCM cleanup. Dynamic import so this doesn't get baked into
            // the cold-launch critical path.
            if (priorStaff) {
                import('./messaging').then(m => {
                    try { m.disableFcmPush(priorStaff); } catch {}
                }).catch(() => {});
            }
            // We deliberately don't clear activeTab/language/etc — those
            // are preferences, not credentials, and the user will want
            // them restored after they unlock.
        }
        sessionStorage.setItem('ddmau:sessionAlive', '1');
    }
} catch {}

// v2 design is the ONLY shell now (2026-05-10). The legacy v1 sidebar,
// bottom nav, and main rendering have been removed entirely. Previously
// v1 lived at the bottom of this file as a fallback when ?v2=0 was set;
// after several days of v2 being the default with no regressions, the
// fallback became dead weight and was deleted along with the useV2Flag
// hook, the onExitV2 prop chain, and the ddmau:v2_optout localStorage key.
//
// If a user lands on a stale URL like ?v2=0, it has no effect — the URL
// param is ignored, v2 always renders. One-time cleanup of the legacy
// localStorage opt-out key happens at module load below.
try { if (typeof localStorage !== 'undefined') localStorage.removeItem('ddmau:v2_optout'); } catch {}

// Detect digital-signage TV mode at mount. URL form:
//   ?tv=<tvId>
// Where tvId is either a reserved default ('webster' / 'maryland')
// or any admin-defined slug from /tv_configs (e.g. 'webster-foh',
// 'webster-drivethru', 'maryland-bar'). MenuDisplay subscribes to
// the config doc and renders accordingly; if the slug doesn't
// exist and isn't a reserved default, MenuDisplay shows a friendly
// "no config for this TV" message.
//
// Bypasses the PIN entirely (it's a public-facing menu, not staff
// data). Set on the Fire TV Stick / kiosk browser as the start URL.
// Andrew 2026-05-20.
function readTvMode() {
    if (typeof window === 'undefined') return null;
    try {
        const params = new URLSearchParams(window.location.search);
        const raw = String(params.get('tv') || '').toLowerCase().trim();
        // URL-safe slug: keep [a-z0-9-]. Reject empty/garbage so the
        // PWA's normal lock screen still loads if someone hits a bare
        // ?tv=.
        const tvId = raw.replace(/[^a-z0-9-]+/g, '').slice(0, 48);
        if (tvId) return { tvId };
    } catch {}
    return null;
}

// ?display=walltasks&side=FOH|BOH&location=webster|maryland — kiosk
// view for the wall-mounted kitchen task tablet. Public, no PII;
// scoped to one (side, location) pair via URL so the wall is locked
// to its assigned data. Garbage / partial params → null → fall
// through to normal PIN flow.
// ?pair=1 — Pi-side TV pairing entry. Bypasses the PIN (it's a
// public-facing kiosk page like ?tv= and ?apply=). Surfaces the
// 6-digit code entry form that completes the loop with the admin's
// PairDeviceModal in Menu Screens. See src/data/devicePairing.js
// for the full flow rationale.
function readPairMode() {
    if (typeof window === 'undefined') return false;
    try {
        const params = new URLSearchParams(window.location.search);
        return params.get('pair') === '1' || params.get('pair') === 'true';
    } catch { return false; }
}

function readTaskDisplayMode() {
    if (typeof window === 'undefined') return null;
    try {
        const params = new URLSearchParams(window.location.search);
        if ((params.get('display') || '').toLowerCase() !== 'walltasks') return null;
        const side = (params.get('side') || '').toUpperCase();
        const location = (params.get('location') || '').toLowerCase();
        if (side !== 'FOH' && side !== 'BOH') return null;
        if (location !== 'webster' && location !== 'maryland') return null;
        return { side, location };
    } catch {}
    return null;
}

// Detect onboarding URL params at mount time. Three apply-mode triggers
// (all equivalent — the canonical short URL is apply.ddmaustl.com which
// Squarespace 302-forwards to ?apply=1; we rewrite the URL bar to /apply
// after the React app boots so the path looks clean):
//   /apply          — clean path after history rewrite
//   ?apply=1        — legacy + post-redirect form from Squarespace
//   ?onboard=TOKEN  — a new hire opening their invite link
// All three bypass the PIN. Path detection trims any trailing slash and
// ignores the deploy base (currently '/').
function readOnboardingMode() {
    if (typeof window === 'undefined') return { mode: null };
    try {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('onboard');
        if (token) return { mode: 'portal', token };
        if (params.get('apply') === '1' || params.get('apply') === 'true') {
            return { mode: 'apply' };
        }
        // Install splash — reached via NFC sticker scan
        // (?install=1 in the URL). Skipped automatically if the page
        // is already running standalone (display-mode media query OR
        // navigator.standalone), so an installed user who scans the
        // sticker just lands on the normal lock screen.
        if (params.get('install') === '1' || params.get('install') === 'true') {
            const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches
                || window.navigator?.standalone === true;
            if (!standalone) return { mode: 'install' };
        }
        // Path-based detection: /apply (or /apply/ with trailing slash).
        const path = window.location.pathname.replace(/\/+$/, '');
        if (path === '/apply' || path.endsWith('/apply')) {
            return { mode: 'apply' };
        }
    } catch {}
    return { mode: null };
}

// Andrew 2026-05-21 perf: structural hash of the staff list that
// EXCLUDES the volatile bookkeeping fields (lastSeen, per-token
// lastSeen). The /config/staff doc re-emits all day long because
// every login bumps that staffer's lastSeen — without this hash
// the App re-renders the entire tree N times per shift for
// effectively zero new info. We hash the rest of the record and
// only call setStaffList when the result actually changed.
//
// Kept as a module-level function so the closure stays stable
// across re-renders. Defensive try/catch + slice to keep this
// fast even on huge staff docs (typical = ~50 entries).
function computeStaffListShapeHash(list) {
    try {
        return JSON.stringify((list || []).map((s) => {
            if (!s) return null;
            const { lastSeen, fcmTokens, ...rest } = s;
            return {
                ...rest,
                // Keep the COUNT (so FCM enable/disable still
                // triggers an update) but drop per-token bookkeeping
                // (lastSeen, deviceId rotations don't matter for UI).
                fcmTokenCount: Array.isArray(fcmTokens) ? fcmTokens.length : 0,
            };
        }));
    } catch {
        // If JSON.stringify throws (circular ref etc.) fall through
        // to a always-update behavior — safer than dropping changes.
        return String(Math.random());
    }
}

export default function App() {
    const isMobile = useIsMobile();
    // Onboarding URL routing — if the user landed here via an invite link or
    // the in-store Apply QR, skip the lock screen entirely. Computed once at
    // mount; if the user dismisses Apply, we clear the flag and fall through
    // to the normal PIN flow.
    const [onboardingMode, setOnboardingMode] = useState(() => readOnboardingMode());
    // TV / digital-signage mode — Fire TV Stick or any browser hitting
    // /?tv=<location>. Read once at mount; the kiosk browser is a
    // long-lived tab that never navigates away.
    const [tvMode] = useState(() => readTvMode());
    // Pi-side pairing entry. Bypasses the PIN like ?tv= and ?apply=.
    // Once paired, PairDevicePage navigates away to ?tv=<assignedId>.
    const [pairMode] = useState(() => readPairMode());
    // Wall-mount kitchen task display mode — locked to one (side, location)
    // via URL. PIN bypassed, no nav chrome. Public read+write to the
    // wall_tasks doc (small list, low value). Same precedent as tvMode.
    const [taskDisplayMode] = useState(() => readTaskDisplayMode());
    // Clean up the URL on apply-mode entry — applicants landed via the
    // Squarespace 302 forward from apply.ddmaustl.com which leaves them
    // at app.ddmaustl.com/?apply=1. We can't change the hostname (browser
    // security) but we CAN replace the ugly query string with a clean
    // path. After this runs, the URL bar reads "app.ddmaustl.com/apply"
    // instead of "app.ddmaustl.com/?apply=1". history.replaceState
    // doesn't trigger a reload so React state stays put.
    useEffect(() => {
        if (onboardingMode.mode !== 'apply') return;
        try {
            const path = window.location.pathname.replace(/\/+$/, '');
            const hasQuery = window.location.search.includes('apply=');
            if (hasQuery || !(path === '/apply' || path.endsWith('/apply'))) {
                window.history.replaceState({}, '', '/apply');
            }
        } catch {}
    }, [onboardingMode.mode]);
    // Lazy-init from localStorage so the user stays on the same screen across reloads.
    const [staffName, setStaffName] = useState(() => SS.get("staffName"));
    const [staffLocation, setStaffLocation] = useState(() => SS.get("staffLocation", "webster"));
    const [activeLocation, setActiveLocation] = useState(() => SS.get("activeLocation", "webster"));
    const [language, setLanguage] = useState(() => SS.get("language", "en"));
    const [activeTab, setActiveTab] = useState(() => SS.get("activeTab", "home"));
    const [staffList, setStaffList] = useState(DEFAULT_STAFF);
    // 2026-05-27 — Bug #3 from the audit dossier. `staffList` starts
    // as DEFAULT_STAFF (a hardcoded array of 71 names baked into
    // staff.js) so the PIN lock screen can render instantly on cold
    // launch. The hardcoded list is good UX for that case, but it's
    // a STALE source of truth — any staff hired after the hardcoded
    // list was written isn't in it. If our staff-name-validation
    // effect (below) runs against the stale list, it can:
    //   • briefly log out a freshly-hired staff member because they
    //     "don't exist" in DEFAULT_STAFF
    //   • briefly flip access flags (isAdmin/isManager/hasOpsAccess)
    //     to the wrong value for a few hundred ms
    // staffListReady flips true on the first real /config/staff
    // snapshot. Effects that should wait for real data gate on it.
    // The PIN screen still gets the instant cold-launch render
    // because it reads `staffList` directly, not `staffListReady`.
    const [staffListReady, setStaffListReady] = useState(false);
    // Persist session-level state on every change. Logout (setStaffName(null))
    // also clears the stored value via SS.set's null branch.
    useEffect(() => { SS.set("staffName", staffName); }, [staffName]);
    useEffect(() => { SS.set("staffLocation", staffLocation); }, [staffLocation]);
    useEffect(() => { SS.set("activeLocation", activeLocation); }, [activeLocation]);
    useEffect(() => { SS.set("language", language); }, [language]);
    useEffect(() => { SS.set("activeTab", activeTab); }, [activeTab]);
    // ── Force-refresh broadcast ──────────────────────────────────────
    // Subscribes to /config/forceRefresh. When admin clicks the
    // "System Refresh" button, that doc's `triggeredAt` timestamp jumps.
    // Every active client sees the change in <1s and force-refreshes,
    // pulling the newest deployed build. Devices that are CLOSED pick
    // up the new build via the static service worker on next open.
    //
    // Baseline-stamp pattern prevents an infinite loop: the FIRST time
    // we see a value (page load), we just remember it. Only LATER
    // changes trigger the refresh.
    useEffect(() => {
        const ref = doc(db, 'config', 'forceRefresh');
        let baseline = null;
        const unsub = onSnapshot(ref, (snap) => {
            const data = snap.exists() ? snap.data() : null;
            const ts = data?.triggeredAt;
            const ms = ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
            if (baseline === null) {
                baseline = ms; // first snapshot — remember and bail
                return;
            }
            if (ms > baseline) {
                baseline = ms;
                console.warn('System refresh broadcast received — refreshing.');
                forceRefresh();
            }
        }, (err) => { console.warn('forceRefresh listener error:', err); });
        return () => unsub();
    }, []);

    // ── Idle-timeout relock ──────────────────────────────────────────
    // When the app is sent to the background (tab hidden / iPhone home
    // button), mark the timestamp. When the user returns and the gap
    // exceeds IDLE_LOCK_MS, log them out so the PIN screen shows.
    //
    // This is the "I left the app open then walked away" case. The
    // cold-launch handler at module load handles the "I closed the
    // PWA and reopened it" case. Both together give the strict lock
    // behavior Andrew expects.
    useEffect(() => {
        if (!staffName) return;
        // Anchor lastActive on first render so an immediate visibility
        // event doesn't immediately log out a user who just signed in.
        try { localStorage.setItem('ddmau:lastActive', String(Date.now())); } catch {}

        // 2026-05-28 Audit #3 — interaction-based activity bump.
        // Before this, the idle timer was ONLY refreshed on
        // visibilitychange — meaning a manager who stayed focused
        // on a long form (Onboarding, Schedule editor, Maintenance
        // request, Operations checklist) for >5 minutes without
        // tabbing away would be force-logged-out mid-entry. Unsaved
        // form data was lost.
        //
        // resetActive bumps lastActive on every keydown/touch/click,
        // but throttled to ≤1 localStorage write per 5 seconds. Without
        // the throttle, fast typing would trigger hundreds of sync
        // writes per minute, jamming the main thread.
        let lastInteractionBump = Date.now();
        const resetActive = () => {
            const now = Date.now();
            if (now - lastInteractionBump < 5000) return; // 5s throttle
            lastInteractionBump = now;
            try { localStorage.setItem('ddmau:lastActive', String(now)); } catch {}
        };

        const onVisibility = () => {
            if (typeof document === 'undefined') return;
            if (document.visibilityState === 'hidden') {
                try { localStorage.setItem('ddmau:lastActive', String(Date.now())); } catch {}
                return;
            }
            // visibilityState === 'visible' — coming back. Compare gap.
            let lastActive = 0;
            try { lastActive = parseInt(localStorage.getItem('ddmau:lastActive') || '0', 10) || 0; } catch {}
            if (lastActive && Date.now() - lastActive > IDLE_LOCK_MS) {
                console.log('[lock] idle for >5min, locking');
                // 2026-05-24 audit fix: same FCM cleanup as manual logout
                // — drop this device's token so push for the prior staff
                // doesn't keep firing on the locked screen.
                try { disableFcmPush(staffName); } catch {}
                setStaffName(null);
                setActiveTab('home');
            } else {
                try { localStorage.setItem('ddmau:lastActive', String(Date.now())); } catch {}
                lastInteractionBump = Date.now();
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        // Passive listeners — never call preventDefault; this is just
        // a heartbeat. Passive = browser knows scrolling/input is safe
        // to commit immediately and doesn't wait for our handler.
        document.addEventListener('keydown',    resetActive, { passive: true });
        document.addEventListener('touchstart', resetActive, { passive: true });
        document.addEventListener('mousedown',  resetActive, { passive: true });
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            document.removeEventListener('keydown',    resetActive);
            document.removeEventListener('touchstart', resetActive);
            document.removeEventListener('mousedown',  resetActive);
        };
    }, [staffName]);

    const { isAtDDMau, checking: geoChecking, error: geoError, retry: geoRetry, permState: geoPermState } = useGeofence();
    const updateAvailable = useVersionCheck();
    // Mobile pull-down-to-refresh — bypasses the cached SW and forces the
    // app to re-download HTML+JS. Without this, PWAs installed on iOS get
    // stuck on stale builds (no native pull-to-refresh in standalone mode).
    const pullRefresh = usePullToRefresh();
    // Run migrations once on first mount
    useEffect(() => {
        if (!migrationRan) {
            migrationRan = true;
            runMigrations();
        }
    }, []);
    // Pre-warm the most-likely-next chunks once the user signs in. Schedule,
    // Operations, Recipes etc. are lazy-loaded, which means tapping them
    // fires a network request mid-tap. We can fetch those chunks in the
    // background AFTER first paint so the tap-to-render transition is
    // instant. requestIdleCallback (or a 500ms fallback) ensures the
    // pre-warm doesn't compete with the main-thread work of initial
    // render.
    useEffect(() => {
        if (!staffName) return;
        const idle = window.requestIdleCallback
            ? window.requestIdleCallback(() => prewarmChunks(), { timeout: 2000 })
            : setTimeout(prewarmChunks, 500);
        return () => {
            if (window.cancelIdleCallback && typeof idle === 'number') window.cancelIdleCallback(idle);
            else clearTimeout(idle);
        };
    }, [staffName]);

    // FCM push init — wire AFTER staff is logged in AND staffList is loaded.
    // The runbook says push is deployed; before this, enableFcmPush was
    // exported from messaging.js but never called, so tokens were never saved
    // and Cloud Function reminders never reached devices.
    // Foreground message handler shows an in-app toast/console log.
    useEffect(() => {
        if (!staffName || !Array.isArray(staffList) || staffList.length === 0) return;
        let unsubForeground = null;
        let cancelled = false;
        (async () => {
            try {
                const result = await enableFcmPush(staffName, staffList, setStaffList);
                if (cancelled) return;
                if (result.ok) {
                    console.log("[FCM] push enabled for", staffName);
                    unsubForeground = await onForegroundMessage((payload) => {
                        // Read from EITHER `data` or `notification` field
                        // — same defense-in-depth as the SW. Lets the
                        // foreground display path work regardless of which
                        // payload format the Cloud Function is sending
                        // (during a deploy or with legacy senders).
                        const data = payload?.data || {};
                        const notif = payload?.notification || {};
                        const title = data.title || notif.title || "DD Mau";
                        const body  = data.body  || notif.body  || "";
                        const tag   = data.tag   || `ddmau-${Date.now()}`;
                        console.log("[FCM foreground]", title, body, payload);
                        // Kitchen-bell ding — fires whenever a push lands
                        // while the app is open. Closed-app pushes use the
                        // OS default sound (SW can't play audio).
                        playKitchenBell();
                        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                            try {
                                new Notification(title, {
                                    body,
                                    // 2026-05-24 audit fix: /icon-192.png
                                    // doesnt exist in public/. Was rendering
                                    // a broken icon on the OS notification.
                                    // Use the inline SVG that the FCM SW
                                    // already serves to keep them visually
                                    // consistent.
                                    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%23255a37'/><text y='70' x='50' text-anchor='middle' font-size='60'>🍜</text></svg>",
                                    tag,
                                    renotify: false,
                                    silent: true,
                                });
                            } catch {}
                        }
                    });
                } else {
                    console.log("[FCM] not enabled:", result.reason);
                }
            } catch (e) {
                console.warn("[FCM] init failed:", e);
            }
        })();
        return () => {
            cancelled = true;
            if (typeof unsubForeground === "function") unsubForeground();
        };
    }, [staffName, staffList?.length]);
    // Load staff list from Firestore.
    //
    // ⚠ DISABLED 2026-05-09: legacy migration block was silently rewriting
    // every staff member's record using DEFAULT_STAFF as the base whenever
    // ANY single record was missing a `location` field — and using
    // `pin: fsMatch.pin || ds.pin` meant any record whose live pin had
    // become falsy/empty got reset to the placeholder PIN in the source
    // file. That's how Andrew's PIN reverted to 0000 and Lorena's reverted
    // to 2537 (the seed values). We removed the migration entirely and
    // now ONLY mirror the live Firestore list into local state. If a
    // schema migration is ever needed again, do it as a one-shot script
    // run from a desktop with admin credentials, NOT in the page-load path.
    useEffect(() => {
        // Andrew 2026-05-21 perf: dedup snapshot updates that only
        // bumped `lastSeen` or rotated `fcmTokens`. The /config/staff
        // doc re-emits on every staff member's app open (their
        // lastSeen ticks) and every FCM token refresh — neither
        // changes anything the UI actually reads, but each one was
        // forcing a full React tree re-render via setStaffList. The
        // shape-hash compare below skips no-op updates entirely so
        // downstream effects + memo'd routes only react to real
        // changes (name / role / access flags / availability /
        // scheduleSide / etc.).
        let prevShapeHash = '';
        const unsubscribe = onSnapshot(doc(db, "config", "staff"), (docSnap) => {
            if (!docSnap.exists()) {
                // The doc not existing is still a valid "we've heard
                // back from Firestore" signal — flip ready so gated
                // effects can stop waiting. Without this, a fresh
                // project with no /config/staff doc would hang the
                // validation effect forever.
                setStaffListReady(true);
                return;
            }
            const list = docSnap.data().list;
            if (!Array.isArray(list)) {
                setStaffListReady(true);
                return;
            }
            const hash = computeStaffListShapeHash(list);
            if (hash === prevShapeHash) {
                // Same shape — still flip ready (first snapshot might
                // hash-match the placeholder).
                setStaffListReady(true);
                return;
            }
            prevShapeHash = hash;
            setStaffList(list);
            setStaffListReady(true);
        }, (err) => {
            // Network-error path: surface to logger but DON'T flip
            // ready, so gated effects keep waiting for real data
            // rather than running against the stale placeholder.
            // The subscription will re-fire when Firestore reconnects.
            console.warn('config/staff snapshot error:', err);
        });
        return () => unsubscribe();
    }, []);
    // Validate the persisted staffName against the live staffList. If admin
    // deleted the staff member while their device still had the localStorage
    // entry, force a clean logout instead of silently leaving them "signed
    // in" as a name that no longer exists (no shifts, no permissions, no
    // way to detect the orphan from the UI).
    //
    // 2026-05-27 — Bug #3 from the audit dossier. Previously this ran on
    // every staffList change INCLUDING the initial DEFAULT_STAFF
    // placeholder. A staff member added AFTER the hardcoded list was
    // written (e.g. a new hire) would not be in DEFAULT_STAFF, the
    // validation would fail on cold launch, and they'd get auto-logged
    // out before the real /config/staff snapshot landed. The
    // staffListReady gate (set when the real Firestore snapshot
    // arrives — see the staff subscription effect above) makes the
    // validation wait for real data.
    useEffect(() => {
        if (!staffName) return;
        if (!staffListReady) return;
        if (!Array.isArray(staffList) || staffList.length === 0) return;
        const exists = staffList.some(s => s.name === staffName);
        if (!exists) {
            console.warn(`[session] staffName "${staffName}" not in staffList — forcing logout`);
            setStaffName(null);
            setActiveTab("home");
        }
    }, [staffName, staffList, staffListReady]);
    // Andrew 2026-05-21: "the site is still very glitchy". Wrapped each
    // access-gate derivation in useMemo so the BOOLEAN results stabilize
    // across staffList re-emits (lastSeen ticks etc.). The useMemo body
    // still re-runs every staffList change (object reference differs),
    // but when the resulting boolean is the same React's Object.is
    // dependency check on downstream useEffect/useMemo skips them. Cuts
    // a large cascade of "no-op" effects that fired on every login/
    // sweep update.
    //
    // CRITICAL: the `isManager` const MUST stay declared BEFORE the
    // useEffect below that references it in its dep array. TDZ
    // ("Cannot access 'isManager' before initialization") broke the
    // whole app in May 2026 — leave the ordering as-is.
    const staffIsAdmin = useMemo(
        () => isAdmin(staffName, staffList),
        [staffName, staffList],
    );
    const currentStaffRecord = useMemo(
        () => (staffList || []).find(s => s.name === staffName) || null,
        [staffList, staffName],
    );
    // Mirror staff identity to the logger globals so every /error_logs,
    // /security_logs, and /bug_reports row carries who-was-it metadata.
    // Runs whenever the staff record changes (PIN unlock, admin rename,
    // logout). On logout (currentStaffRecord null + staffName null) we
    // clear the globals so anonymous error rows don't leak the last
    // signed-in person's name.
    useEffect(() => {
        try {
            setIdentity({
                staffId:   currentStaffRecord?.id ?? null,
                staffName: staffName ?? null,
                role:      currentStaffRecord?.role ?? (staffName ? 'staff' : 'anonymous'),
                location:  currentStaffRecord?.location ?? null,
            });
        } catch {}
    }, [staffName, currentStaffRecord]);

    // Recipes access — opt-OUT model. Default: every staff has access.
    // Admin can flip recipesAccess to FALSE to revoke a specific person.
    const hasRecipesAccess = useMemo(
        () => staffIsAdmin || !currentStaffRecord || currentStaffRecord.recipesAccess !== false,
        [staffIsAdmin, currentStaffRecord],
    );
    // Operations access — opt-IN model. Default: NO access.
    const hasOpsAccess = useMemo(
        () => staffIsAdmin || (currentStaffRecord && currentStaffRecord.opsAccess === true),
        [staffIsAdmin, currentStaffRecord],
    );
    // Manager-or-admin gate for HR-style features (tardiness, shift
    // handoff). Catches Manager / Asst Manager / Kitchen Manager / Asst
    // Kitchen Manager via role title. Shift Lead is intentionally NOT
    // included — tardy authority sits with managers.
    const isManager = useMemo(
        () => staffIsAdmin || (currentStaffRecord && /manager/i.test(currentStaffRecord.role || '')),
        [staffIsAdmin, currentStaffRecord],
    );
    // Onboarding access — tighter than isAdmin. Holds PII (SSN, W4, DL).
    // Defaults true for owners (id 40/41); everyone else needs the
    // explicit canViewOnboarding=true flag.
    const hasOnboardingAccess = useMemo(
        () => canViewOnboarding(currentStaffRecord),
        [currentStaffRecord],
    );
    // 2026-05-28 Audit #13 — memoize hiddenPages so memo-wrapped lazy
    // routes can actually skip re-renders. Before, this was computed
    // inline twice in renderV2Body() (MobileHome + AppShellV2 calls)
    // — `(currentStaffRecord && Array.isArray(...)) ? ... : []` —
    // which produced a fresh `[]` reference on every render when the
    // staff had no hidden pages. React.memo's shallow compare saw a
    // changed prop and re-rendered the whole route subtree.
    const hiddenPages = useMemo(
        () => (currentStaffRecord && Array.isArray(currentStaffRecord.hiddenPages))
            ? currentStaffRecord.hiddenPages
            : EMPTY_ARRAY,
        [currentStaffRecord],
    );
    // Guard: if a non-admin restored a session that landed on admin/labor,
    // bounce them back to Home. Otherwise the tab gate hides the content
    // and they see a blank screen + a sidebar item highlighted that they
    // don't have permission for.
    useEffect(() => {
        if (!staffName) return;
        if ((activeTab === "admin" || activeTab === "labor" || activeTab === "menuscreens" || activeTab === "health" || activeTab === "errorreport" || activeTab === "labels") && !staffIsAdmin) {
            setActiveTab("home");
        }
        // tardies + handoff are manager-or-admin only — same defensive bounce.
        if ((activeTab === "tardies" || activeTab === "handoff") && !isManager) {
            setActiveTab("home");
        }
        // operations + recipes are toggle-gated — bounce if access was revoked
        // mid-session (admin flipped a toggle while the staff member was on
        // that tab).
        if (activeTab === "operations" && !hasOpsAccess) setActiveTab("home");
        if (activeTab === "recipes" && !hasRecipesAccess) setActiveTab("home");
        // Onboarding holds PII — same defensive bounce if access removed.
        if (activeTab === "onboarding" && !hasOnboardingAccess) setActiveTab("home");
    }, [staffName, staffIsAdmin, isManager, hasOpsAccess, hasRecipesAccess, hasOnboardingAccess, activeTab]);
    const effectiveLocation = staffIsAdmin ? activeLocation : staffLocation;
    const handleSelectStaff = (name) => {
        setStaffName(name);
        const staff = staffList.find(s => s.name === name);
        const loc = staff?.location || "webster";
        setStaffLocation(loc);
        setActiveLocation(loc === "both" ? "webster" : loc);
        // Per-staff Home view override: if admin set this person's homeView
        // to a specific tab (e.g. 'schedule', 'recipes'), land them on that
        // tab. Empty / 'auto' / 'home' → default Home behavior. Admins can
        // change a staff member's home view from Admin → Edit staff or from
        // the Bulk Tag modal.
        const tab = (staff?.homeView && staff.homeView !== 'auto' && staff.homeView !== 'home')
            ? staff.homeView
            : "home";
        setActiveTab(tab);
    };
    // Same logic applied to the in-session Home tab — when staff (even on a
    // device that didn't just sign in) taps Home, redirect to their preferred
    // landing tab. This is a one-shot effect: once it redirects, normal nav
    // takes over (so they CAN reach the default Home by going through some
    // other tab and tapping Home again is fine — they'll get redirected, but
    // any other manual tab tap stays put).
    useEffect(() => {
        if (activeTab !== 'home') return;
        if (!currentStaffRecord) return;
        const target = currentStaffRecord.homeView;
        if (!target || target === 'auto' || target === 'home') return;
        // Don't redirect to a tab the user can't access.
        if (target === 'operations' && !hasOpsAccess) return;
        if (target === 'recipes' && !hasRecipesAccess) return;
        setActiveTab(target);
    }, [activeTab, currentStaffRecord?.homeView, hasOpsAccess, hasRecipesAccess]);

    // ── Required-task interceptor ───────────────────────────────────────
    // After PIN unlock, check if the current staffer has any BLOCKING
    // required tasks in /required_tasks. If so, the v2 shell is replaced
    // by the full-screen RequiredTaskFlow until each task is completed
    // or skipped (where allowed).
    //
    // Two effect responsibilities:
    //   1. Auto-resolve tasks whose autoComplete predicate passes against
    //      the current staff record. This catches the case where a staffer
    //      sets availability via the Schedule tab AFTER the task was
    //      pushed but before they hit the gate — the task closes itself
    //      so we don't make them stare at "set your availability" when
    //      they already did.
    //   2. Fetch the remaining pending+blocking tasks and stash the
    //      count + a re-fetch trigger so the conditional render below
    //      knows whether to show the flow.
    //
    // We refetch on staffName change and on every staffList update so
    // that admin actions (push a new campaign, cancel a pending task)
    // propagate without requiring the staffer to re-sign-in.
    const [requiredTaskTick, setRequiredTaskTick] = useState(0);
    const [pendingBlockingCount, setPendingBlockingCount] = useState(null); // null = unchecked
    // gateBypassed: temporary pass-through when a task component fires
    // a navigate event with { fromRequiredTask: true }. Lets the user
    // reach the destination tab (e.g. Schedule for availability) to
    // actually do the work that satisfies the task. Bypass is per-
    // session — resets every staffName change (sign-in/out), so the
    // gate re-evaluates fresh on the next login. (Bug 2026-05-20 —
    // before this, tapping "Open availability editor" did nothing
    // because the gate kept rendering over Schedule.)
    const [gateBypassed, setGateBypassed] = useState(false);
    useEffect(() => { setGateBypassed(false); }, [staffName]);
    useEffect(() => {
        if (!staffName) {
            setPendingBlockingCount(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                // Resolve in two steps; the imports are scoped inside the
                // effect so the requiredTasks module is only loaded when
                // we actually need it (post-PIN).
                const mod = await import('./data/requiredTasks');
                if (cancelled) return;
                if (currentStaffRecord) {
                    await mod.autoResolveTasksFor(currentStaffRecord);
                }
                if (cancelled) return;
                const pending = await mod.fetchPendingTasksFor(staffName);
                if (cancelled) return;
                const blocking = pending.filter(t => t.blockApp === true).length;
                setPendingBlockingCount(blocking);
            } catch (e) {
                console.warn('required-task check failed:', e);
                setPendingBlockingCount(0); // fail-open: don't brick the app
            }
        })();
        return () => { cancelled = true; };
    }, [staffName, currentStaffRecord, requiredTaskTick]);

    // Listen for in-app navigation events from task components.
    // RequiredTaskAvailability dispatches one when the user taps
    // "Open availability editor" — we switch the active tab and
    // close out of the flow.
    useEffect(() => {
        const handler = (ev) => {
            const tab = ev?.detail?.tab;
            if (tab) setActiveTab(tab);
            // Required-task escape hatch: when a task component asks
            // us to navigate to do the work elsewhere, drop the gate
            // for the rest of this session so the user can complete
            // the task in context (e.g. fill availability in Schedule).
            if (ev?.detail?.fromRequiredTask) setGateBypassed(true);
        };
        window.addEventListener('ddmau:navigate', handler);
        return () => window.removeEventListener('ddmau:navigate', handler);
    }, []);

    // ── PWA install auto-detection ─────────────────────────────────────
    // When the app boots in standalone display mode (i.e. opened from
    // a home-screen icon, not a browser tab), stamp pwaInstalled=true
    // on the current staffer's record. The required-task framework's
    // install_pwa autoComplete predicate reads this flag, so any
    // staffer who has the app on their home screen on ANY device gets
    // the install gate to close itself automatically.
    //
    // Why this matters: on iPhone, web push notifications ONLY fire
    // when the PWA is installed to the home screen. The gate forces
    // that install; this effect closes the gate as soon as it has
    // happened, so staff don't see "install the app" after they
    // already did.
    //
    // Idempotent: writes only on the false→true transition. Subsequent
    // standalone-mode launches are no-ops (no Firestore write).
    useEffect(() => {
        if (!staffName || !currentStaffRecord) return;
        if (currentStaffRecord.pwaInstalled === true) return;
        const isStandalone = (
            (typeof window !== 'undefined') && (
                (window.matchMedia?.('(display-mode: standalone)')?.matches === true)
                || (window.navigator?.standalone === true)
            )
        );
        if (!isStandalone) return;
        let cancelled = false;
        (async () => {
            try {
                const ref = doc(db, 'config', 'staff');
                const snap = await getDoc(ref);
                if (cancelled) return;
                const list = (snap.exists() ? snap.data().list : []) || [];
                const next = list.map(s => s && s.name === staffName
                    ? { ...s, pwaInstalled: true, pwaInstalledAt: new Date().toISOString(), pwaInstalledMethod: 'auto' }
                    : s);
                await setDoc(ref, { list: next });
            } catch (e) {
                console.warn('pwa install auto-detect write failed:', e);
            }
        })();
        return () => { cancelled = true; };
    }, [staffName, currentStaffRecord?.pwaInstalled]);

    // ── Last-sign-in stamp (Andrew 2026-05-27) ─────────────────────────
    // The StaffUsageAudit panel was reading fcmTokens[].lastSeen as a
    // "last seen" signal, but that field only ticks when enableFcmPush()
    // SUCCEEDS at acquiring a token — so a staffer who signs in on
    // desktop, declines push, opens an iOS Safari tab instead of the
    // installed PWA, etc. ends up showing a stale timestamp (or none
    // at all). Symptom: "Brandon logged in today but it says 5 days
    // ago" — exactly that case.
    //
    // Fix: stamp a true lastSignInAt on the staff doc whenever a
    // staffName binds in this session, independent of push state. This
    // is the canonical "we saw this person open the app" timestamp.
    // Debounced via an in-doc check (skip if < 30 min old) so multiple
    // mounts inside a single session don't cause repeat writes.
    // Also stamps lastSignInPlatform / lastSignInStandalone so admins
    // can tell at a glance whether the staffer is opening the PWA or a
    // browser tab.
    useEffect(() => {
        if (!staffName || !currentStaffRecord) return;
        let cancelled = false;
        (async () => {
            try {
                // Skip if we've stamped within the last 30 min — keeps
                // writes to roughly one per real session.
                const prev = currentStaffRecord.lastSignInAt;
                if (prev) {
                    const ms = typeof prev === 'number' ? prev : Date.parse(prev);
                    if (Number.isFinite(ms) && Date.now() - ms < 30 * 60 * 1000) return;
                }
                const standalone = (
                    (window.matchMedia?.('(display-mode: standalone)')?.matches === true)
                    || (window.navigator?.standalone === true)
                );
                const ua = window.navigator?.userAgent || '';
                // Coarse platform tag — keeps the admin audit's
                // "where did they sign in from?" column readable.
                const platform = /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
                    : /Android/i.test(ua) ? 'Android'
                    : /Mac OS X|Macintosh/i.test(ua) ? 'Mac'
                    : /Windows/i.test(ua) ? 'Windows'
                    : 'other';
                const ref = doc(db, 'config', 'staff');
                const snap = await getDoc(ref);
                if (cancelled) return;
                const list = (snap.exists() ? snap.data().list : []) || [];
                const next = list.map(s => s && s.name === staffName
                    ? {
                        ...s,
                        lastSignInAt: Date.now(),
                        lastSignInPlatform: platform,
                        lastSignInStandalone: standalone,
                    }
                    : s);
                await setDoc(ref, { list: next });
            } catch (e) {
                console.warn('lastSignInAt write failed (non-fatal):', e);
            }
        })();
        return () => { cancelled = true; };
    }, [staffName, currentStaffRecord?.id]);

    // TV / kiosk deep link (handled before auth):
    //   /?tv=webster   → Webster menu board (digital signage)
    //   /?tv=maryland  → MD Heights menu board
    // The Fire TV Stick at each restaurant points its kiosk browser
    // here. No PIN, no staff context — just a read-only public menu
    // with live 86 status. Andrew 2026-05-20.
    if (tvMode) {
        return (
            <Suspense fallback={<div className="fixed inset-0 bg-white" />}>
                <MenuDisplay tvId={tvMode.tvId} />
            </Suspense>
        );
    }

    // TV pairing flow — Pi-side entry. ?pair=1 lands here, also PIN-
    // free since the Pi is a public kiosk. Lazy chunk so the page
    // doesn't enter the bundle graph for normal staff sessions.
    if (pairMode) {
        return (
            <Suspense fallback={<div className="fixed inset-0 bg-dd-charcoal text-white flex items-center justify-center font-bold">Loading…</div>}>
                <PairDevicePage />
            </Suspense>
        );
    }

    // Wall-mount kitchen task tablet. Bypasses the PIN, full-screen
    // dark kiosk view. URL: ?display=walltasks&side=FOH|BOH
    // &location=webster|maryland. Andrew 2026-05-21.
    if (taskDisplayMode) {
        return (
            <Suspense fallback={<div className="fixed inset-0 bg-[#111315]" />}>
                <TaskDisplay side={taskDisplayMode.side} location={taskDisplayMode.location} />
            </Suspense>
        );
    }

    // Onboarding deep links (handled before auth):
    //   /?onboard=TOKEN → token-gated public new-hire portal
    //   /?apply=1       → public job-application form
    // These bypass the PIN entirely. Hires don't have a DD Mau account;
    // their token IS the credential.
    if (onboardingMode.mode === 'portal') {
        return (
            <Suspense fallback={<TabLoading language={language} />}>
                <OnboardingPortal token={onboardingMode.token} language={language} />
            </Suspense>
        );
    }
    if (onboardingMode.mode === 'install') {
        // NFC-sticker install splash. Clears ?install=1 from the URL
        // when the user taps "Skip" so a refresh doesn't keep showing
        // the splash. Replace history entry so the splash isn't
        // navigable-back-to.
        return (
            <Suspense fallback={<TabLoading language={language} />}>
                <InstallSplash
                    language={language}
                    onSkip={() => {
                        try {
                            const u = new URL(window.location.href);
                            u.searchParams.delete('install');
                            window.history.replaceState({}, '', u.pathname + (u.search ? u.search : ''));
                        } catch {}
                        setOnboardingMode({ mode: null });
                    }}
                />
            </Suspense>
        );
    }
    if (onboardingMode.mode === 'apply') {
        return (
            <Suspense fallback={<TabLoading language={language} />}>
                <OnboardingApply
                    language={language}
                    onClose={() => {
                        // Drop the apply flag from the URL and fall through to the PIN screen.
                        try {
                            const u = new URL(window.location.href);
                            u.searchParams.delete('apply');
                            window.history.replaceState({}, '', u.toString());
                        } catch {}
                        setOnboardingMode({ mode: null });
                    }}
                />
            </Suspense>
        );
    }
    if (!staffName) {
        // No onApplyClick: the staff lock screen no longer surfaces the
        // job-application entry. Applicants reach the apply form via a
        // dedicated QR / link (generated by admin in the Onboarding tab)
        // that lands them directly on /?apply=1 — they never see the PIN
        // pad. Direct deep links like /?apply=1 still work as before.
        return <HomePage
            onSelectStaff={handleSelectStaff}
            language={language}
            staffList={staffList}
        />;
    }

    // ── Required-task gate ──────────────────────────────────────────────
    // pendingBlockingCount === null means we haven't finished the first
    // check yet — render a neutral placeholder so we don't flash the
    // normal app + a flow for the same frame. pendingBlockingCount > 0
    // means hard-gate: replace the v2 shell entirely with the flow.
    if (pendingBlockingCount === null) {
        return <div className="min-h-screen bg-dd-bg" />;
    }
    if (pendingBlockingCount > 0 && !gateBypassed) {
        return (
            <Suspense fallback={<TabLoading language={language} />}>
                <RequiredTaskFlow
                    staffName={staffName}
                    staff={currentStaffRecord}
                    staffList={staffList}
                    setStaffList={setStaffList}
                    language={language}
                    onAllDone={() => setRequiredTaskTick(t => t + 1)}
                    onSignOut={() => {
                        // 2026-05-24 audit fix: drop this device's FCM
                        // token + push subscription so push notifications
                        // for the prior signed-in staff don't keep firing
                        // on this lock-screened device. Fire-and-forget;
                        // never block sign-out on FCM cleanup.
                        try { disableFcmPush(staffName); } catch {}
                        setStaffName(null);
                        setActiveTab('home');
                    }}
                />
            </Suspense>
        );
    }

    // ── v2 shell (the only shell) ────────────────────────────────────────
    // Renders the active tab's component inside the v2 shell. Same data
    // paths, same gates, same race fixes as the deleted v1 — just a
    // different frame. Per-tab access checks happen here (Operations
    // requires opsAccess, Recipes requires recipesAccess, etc.).
    const renderV2Body = () => {
            if (activeTab === 'home') {
                // Mobile gets a launcher (clean tile grid of every destination
                // — staff open the app for a specific reason, not to browse a
                // dashboard). Desktop gets the data-rich HomeV2 dashboard.
                return isMobile ? (
                    <MobileHome
                        language={language}
                        staffName={staffName}
                        storeLocation={effectiveLocation}
                        staffList={staffList}
                        setStaffList={setStaffList}
                        onNavigate={(tab) => setActiveTab(tab)}
                        hasOpsAccess={hasOpsAccess}
                        hasRecipesAccess={hasRecipesAccess}
                        hasOnboardingAccess={hasOnboardingAccess}
                        isAdmin={staffIsAdmin}
                        isManager={isManager}
                        hiddenPages={hiddenPages}
                    />
                ) : (
                    <HomeV2
                        language={language}
                        staffName={staffName}
                        storeLocation={effectiveLocation}
                        staffList={staffList}
                        setStaffList={setStaffList}
                        onNavigate={(tab) => setActiveTab(tab)} />
                );
            }
            // For everything else, render the legacy component as-is. They
            // sit on the sage page background; cards inside them stay white.
            // We negate the top-level dark backgrounds some legacy components
            // ship with via a CSS reset class that the tab itself defines.
            if (activeTab === 'chat') return <PageErrorBoundary tabName="Chat" language={language}><ChatCenter language={language} staffName={staffName} staffList={staffList} setStaffList={setStaffList} isAdmin={staffIsAdmin} isManager={isManager} storeLocation={effectiveLocation} /></PageErrorBoundary>;
            if (activeTab === 'training' && canSeePage(currentStaffRecord, 'training')) return <TrainingHub staffName={staffName} language={language} staffList={staffList} />;
            if (activeTab === 'operations' && hasOpsAccess) return <PageErrorBoundary tabName="Operations" language={language}><Operations language={language} staffList={staffList} staffName={staffName} storeLocation={effectiveLocation} /></PageErrorBoundary>;
            if (activeTab === 'mytasks') return <MyTasksPanel language={language} staffName={staffName} staffList={staffList} isAdmin={staffIsAdmin} isManager={isManager} />;
            if (activeTab === 'menu' && canSeePage(currentStaffRecord, 'menu')) return <MenuReference language={language} />;
            if (activeTab === 'datestickers') return <DateStickerPrinter language={language} staffName={staffName} storeLocation={effectiveLocation} staffList={staffList} />;
            if (activeTab === 'schedule') return <PageErrorBoundary tabName="Schedule" language={language}><Schedule staffName={staffName} language={language} storeLocation={effectiveLocation} staffList={staffList} setStaffList={setStaffList} /></PageErrorBoundary>;
            if (activeTab === 'recipes' && hasRecipesAccess) return <Recipes language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} isAtDDMau={isAtDDMau} geoChecking={geoChecking} geoError={geoError} geoRetry={geoRetry} geoPermState={geoPermState} />;
            if (activeTab === 'labor' && staffIsAdmin) return <LaborDashboard language={language} storeLocation={effectiveLocation} />;
            if (activeTab === 'eighty6' && canSeePage(currentStaffRecord, 'eighty6')) return <Eighty6Dashboard language={language} storeLocation={effectiveLocation} staffName={staffName} staffList={staffList} isAdmin={staffIsAdmin} />;
            if (activeTab === 'catering' && canSeePage(currentStaffRecord, 'catering')) return <CateringOrder language={language} staffName={staffName} />;
            if (activeTab === 'maintenance' && canSeePage(currentStaffRecord, 'maintenance')) return <MaintenanceRequest language={language} staffName={staffName} storeLocation={effectiveLocation} />;
            if (activeTab === 'insurance' && canSeePage(currentStaffRecord, 'insurance')) return <InsuranceEnrollment language={language} staffName={staffName} staffList={staffList} />;
            if (activeTab === 'ai' && canSeePage(currentStaffRecord, 'ai')) return <AiAssistant language={language} staffName={staffName} storeLocation={effectiveLocation} />;
            if (activeTab === 'tardies' && isManager) return <TardinessTracker language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} />;
            if (activeTab === 'handoff' && isManager) return <ShiftHandoff language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} />;
            if (activeTab === 'menuscreens' && staffIsAdmin) return <PageErrorBoundary tabName="Menu Screens" language={language}><MenuScreensPage language={language} staffName={staffName} storeLocation={effectiveLocation} /></PageErrorBoundary>;
            if (activeTab === 'health' && staffIsAdmin) return <PageErrorBoundary tabName="System Health" language={language}><AdminHealthPage language={language} staffName={staffName} /></PageErrorBoundary>;
            if (activeTab === 'errorreport' && staffIsAdmin) return <PageErrorBoundary tabName="Error Report" language={language}><ErrorReportPage language={language} staffName={staffName} /></PageErrorBoundary>;
            if (activeTab === 'labels' && staffIsAdmin) return <PageErrorBoundary tabName="Label Printing" language={language}><LabelPrintingCenter language={language} staffName={staffName} /></PageErrorBoundary>;
            if (activeTab === 'admin' && staffIsAdmin) return <PageErrorBoundary tabName="Admin" language={language}><AdminPanel language={language} staffName={staffName} staffList={staffList} setStaffList={setStaffList} storeLocation={effectiveLocation} onNavigate={(tab) => setActiveTab(tab)} hasOnboardingAccess={hasOnboardingAccess} /></PageErrorBoundary>;
            if (activeTab === 'notifications' && staffIsAdmin) return <PageErrorBoundary tabName="Notifications" language={language}><NotificationsAdmin language={language} staffName={staffName} staffList={staffList} setStaffList={setStaffList} /></PageErrorBoundary>;
            // 📧 Inbox triage — owner-only (ids 40/41 via staffIsAdmin).
            if (activeTab === 'inbox' && staffIsAdmin) return <PageErrorBoundary tabName="Inbox" language={language}><InboxTriage language={language} staffName={staffName} staffList={staffList} /></PageErrorBoundary>;
            if (activeTab === 'onboarding' && hasOnboardingAccess) return <Onboarding language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} onBack={() => setActiveTab('admin')} />;
            // Tab not accessible — bounce home (uses same mobile/desktop split).
            return isMobile ? (
                <MobileHome
                    language={language}
                    staffName={staffName}
                    storeLocation={effectiveLocation}
                    staffList={staffList}
                    onNavigate={(tab) => setActiveTab(tab)}
                    hasOpsAccess={hasOpsAccess}
                    hasRecipesAccess={hasRecipesAccess}
                    isAdmin={staffIsAdmin}
                    isManager={isManager}
                />
            ) : (
                <HomeV2
                    language={language}
                    staffName={staffName}
                    storeLocation={effectiveLocation}
                    staffList={staffList}
                    onNavigate={(tab) => setActiveTab(tab)} />
            );
        };
        // Wrap legacy tabs in a white card so they lift cleanly off the
        // sage page background and match v2's card vocabulary. HomeV2
        // already paints its own white cards on the sage canvas, so it
        // gets no wrapper.
        const isHome = activeTab === 'home';
        return (
            // Outer Suspense covers the AppShellV2 lazy() chunk (shell +
            // sidebar + header). On cold load it was flashing a plain
            // sage rectangle — TabLoading shows the same spinner the
            // inner per-tab Suspense uses so the loading state is
            // visually consistent. (Inner Suspense still catches per-tab
            // chunks once the shell is mounted.)
            <Suspense fallback={<TabLoading language={language} />}>
                <ChunkReloadFlagReset />
                {/* 2026-05-28 — Pull-to-refresh visual indicator. The
                    usePullToRefresh hook returns pullDistance/progress/
                    armed/refreshing; rendering them here is what makes
                    the gesture FEEL connected (was working silently
                    until the page reloaded). Mobile only. */}
                <PullToRefreshIndicator
                    pullDistance={pullRefresh.pullDistance}
                    progress={pullRefresh.progress}
                    refreshing={pullRefresh.refreshing}
                    armed={pullRefresh.armed}
                />
                <AppShellV2
                    language={language}
                    staffName={staffName}
                    storeLocation={effectiveLocation}
                    activeTab={activeTab}
                    onNavigate={(tab) => setActiveTab(tab)}
                    hasOpsAccess={hasOpsAccess}
                    hasRecipesAccess={hasRecipesAccess}
                    hasOnboardingAccess={hasOnboardingAccess}
                    isAdmin={staffIsAdmin}
                    isManager={isManager}
                    hiddenPages={(currentStaffRecord && Array.isArray(currentStaffRecord.hiddenPages)) ? currentStaffRecord.hiddenPages : []}
                    // Passed through to Header → EnableNotificationsHeaderButton
                    // so the header-bell-adjacent fix pill can write the
                    // FCM token to the right staff record.
                    staffList={staffList}
                    setStaffList={setStaffList}
                    // 2026-05-28 Audit #2 — plumb staffListReady through so
                    // AppDataProvider can gate its staff-identity-dependent
                    // subscriptions (notifications, 86 auto-post) until the
                    // live /config/staff snapshot lands. Without this, those
                    // subscriptions fire with whatever staffName was
                    // restored from sessionStorage and can return wrong
                    // results during the 1-3s gap before staffList arrives.
                    staffListReady={staffListReady}
                    // Logout returns the app to the lock screen by clearing
                    // the active staffName. The render branches at the top
                    // of App() route to <HomePage /> when staffName is null.
                    onLogout={() => {
                        // 2026-05-24 audit fix: same FCM cleanup as onSignOut.
                        try { disableFcmPush(staffName); } catch {}
                        setStaffName(null);
                        setActiveTab('home');
                    }}
                    // Same forceRefresh used by pull-to-refresh + the legacy
                    // sidebar's refresh button. Clears all caches and reloads.
                    onForceRefresh={() => forceRefresh()}
                    onLanguageToggle={() => setLanguage(language === 'en' ? 'es' : 'en')}
                    // Bell click — jumps to Schedule, where the per-user
                    // notification drawer lives (shift offers, swap approvals,
                    // PTO updates). When a real cross-app notifications
                    // panel ships, point this at it instead.
                    onBellClick={() => setActiveTab('schedule')}
                    // Location cycle — admins can flip between webster /
                    // maryland / both; staff are pinned to their assigned
                    // location (no-op when not admin).
                    onLocationChange={() => {
                        if (!staffIsAdmin) return;
                        const cycle = ['webster', 'maryland', 'both'];
                        const idx = cycle.indexOf(activeLocation);
                        const next = cycle[(idx + 1) % cycle.length];
                        setActiveLocation(next);
                    }}
                >
                    <Suspense fallback={<TabLoading language={language} />}>
                        <ErrorBoundary language={language} key={activeTab}>
                            {isHome ? renderV2Body() : (
                                <div className="bg-dd-surface rounded-xl border border-dd-line shadow-card -mx-4 sm:mx-0">
                                    {renderV2Body()}
                                </div>
                            )}
                        </ErrorBoundary>
                    </Suspense>
                </AppShellV2>
                {/* Off-site clock prompt — top-level overlay so it fires
                    regardless of active tab. Renders null when there's
                    nothing pending/active for this staff member, so the
                    cost of mounting it everywhere is zero. */}
                <OffsiteClockPrompt
                    language={language}
                    staffName={staffName}
                    viewer={currentStaffRecord}
                />
                {/* 2026-05-27 — Andrew: "the bug report at the bottom
                    right of the home page need to be deleted. lets
                    delete the staff enter bug program." The
                    <ReportProblemButton> FAB + its component file are
                    gone. PageErrorBoundary's "Report this" button is
                    also removed (it dispatched ddmau:open-bug-report
                    which only this listener picked up). The admin-side
                    ErrorReportPage that views historical reports is
                    kept — old /bug_reports docs are still readable
                    from there, just no new ones can be written. */}
            </Suspense>
        );
}
