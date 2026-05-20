import { useState, useEffect, useRef, lazy, Suspense, Component } from 'react';
import { db } from './firebase';
import { doc, getDoc, setDoc, collection, getDocs, query, limit, writeBatch } from 'firebase/firestore';
import { onSnapshot } from 'firebase/firestore';
import { t } from './data/translations';
import { isAdmin, DEFAULT_STAFF, LOCATION_LABELS, canSeePage, canViewOnboarding } from './data/staff';
import { enableFcmPush, onForegroundMessage } from './messaging';
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
// Components — lazy loaded (only when tab is active)
const TrainingHub = lazy(() => import('./components/TrainingHub'));
const Operations = lazy(() => import('./components/Operations'));
const MenuReference = lazy(() => import('./components/MenuReference'));
const DateStickerPrinter = lazy(() => import('./components/DateStickerPrinter'));
const Schedule = lazy(() => import('./components/Schedule'));
const Recipes = lazy(() => import('./components/Recipes'));
const LaborDashboard = lazy(() => import('./components/LaborDashboard'));
const Eighty6Dashboard = lazy(() => import('./components/Eighty6Dashboard'));
const CateringOrder = lazy(() => import('./components/CateringOrder'));
const MaintenanceRequest = lazy(() => import('./components/MaintenanceRequest'));
const AdminPanel = lazy(() => import('./components/AdminPanel'));
const InsuranceEnrollment = lazy(() => import('./components/InsuranceEnrollment'));
const AiAssistant = lazy(() => import('./components/AiAssistant'));
const TardinessTracker = lazy(() => import('./components/TardinessTracker'));
const ShiftHandoff = lazy(() => import('./components/ShiftHandoff'));
const Onboarding = lazy(() => import('./components/Onboarding'));
const ChatCenter = lazy(() => import('./components/ChatCenter'));
const OnboardingPortal = lazy(() => import('./components/OnboardingPortal'));
const OnboardingApply = lazy(() => import('./components/OnboardingApply'));
const InstallSplash = lazy(() => import('./components/InstallSplash'));
const RequiredTaskFlow = lazy(() => import('./components/RequiredTaskFlow'));
const MenuDisplay = lazy(() => import('./components/MenuDisplay'));

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
        let timer;
        async function check() {
            try {
                const res = await fetch("/version.json?t=" + Date.now());
                if (!res.ok) return;
                const data = await res.json();
                if (savedVersion.current === null) {
                    savedVersion.current = data.v;
                } else if (data.v !== savedVersion.current) {
                    setUpdateAvailable(true);
                }
            } catch (e) { /* ignore */ }
        }
        check();
        timer = setInterval(check, 2 * 60 * 1000);
        return () => clearInterval(timer);
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
try {
    if (typeof window !== 'undefined') {
        const alive = sessionStorage.getItem('ddmau:sessionAlive');
        if (!alive) {
            // Cold launch — wipe the persisted auth state so the PIN screen
            // is the first thing the user sees.
            localStorage.removeItem('ddmau:staffName');
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
//   ?tv=webster   → Webster menu board
//   ?tv=maryland  → MD Heights menu board
// Bypasses the PIN entirely (it's a public-facing menu, not staff
// data). Set on the Fire TV Stick / kiosk browser as the start URL.
// Andrew 2026-05-20.
function readTvMode() {
    if (typeof window === 'undefined') return null;
    try {
        const params = new URLSearchParams(window.location.search);
        const loc = String(params.get('tv') || '').toLowerCase().trim();
        if (loc === 'webster' || loc === 'maryland') {
            return { location: loc };
        }
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
                setStaffName(null);
                setActiveTab('home');
            } else {
                try { localStorage.setItem('ddmau:lastActive', String(Date.now())); } catch {}
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
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
                                    icon: "/icon-192.png",
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
        const unsubscribe = onSnapshot(doc(db, "config", "staff"), (docSnap) => {
            if (docSnap.exists() && docSnap.data().list) {
                setStaffList(docSnap.data().list);
            }
        });
        return () => unsubscribe();
    }, []);
    // Validate the persisted staffName against the live staffList. If admin
    // deleted the staff member while their device still had the localStorage
    // entry, force a clean logout instead of silently leaving them "signed
    // in" as a name that no longer exists (no shifts, no permissions, no
    // way to detect the orphan from the UI).
    useEffect(() => {
        if (!staffName) return;
        if (!Array.isArray(staffList) || staffList.length === 0) return;
        const exists = staffList.some(s => s.name === staffName);
        if (!exists) {
            console.warn(`[session] staffName "${staffName}" not in staffList — forcing logout`);
            setStaffName(null);
            setActiveTab("home");
        }
    }, [staffName, staffList]);
    const staffIsAdmin = isAdmin(staffName, staffList);
    const currentStaffRecord = (staffList || []).find(s => s.name === staffName);
    // Recipes access — opt-OUT model. Default: every staff has access.
    // Admin can flip recipesAccess to FALSE to revoke a specific person.
    // (Schema migration handled by the "Grant recipes to all" button in
    // BulkTag for staff records that pre-date this policy and still have
    // the field unset or false.)
    const hasRecipesAccess = staffIsAdmin || !currentStaffRecord || currentStaffRecord.recipesAccess !== false;
    // Operations access — opt-IN model. Default: NO access. Admin must
    // toggle opsAccess to true per staff member who needs Operations.
    const hasOpsAccess = staffIsAdmin || (currentStaffRecord && currentStaffRecord.opsAccess === true);
    // Manager-or-admin gate for HR-style features (tardiness, shift handoff).
    // "Manager" in role title catches Manager / Asst Manager / Kitchen Manager
    // / Asst Kitchen Manager. Shift Lead is intentionally NOT included —
    // those are leads, not managers, and tardy authority sits with managers.
    //
    // CRITICAL: this `const isManager` MUST be declared BEFORE the useEffect
    // below that references it in its dependency array. The dep array is
    // evaluated on every render — referencing a `const` before its
    // declaration triggers a TDZ "Cannot access 'isManager' before
    // initialization" error and BREAKS THE WHOLE APP. (This was the cause
    // of the May 2026 production outage.)
    const isManager = staffIsAdmin || (currentStaffRecord && /manager/i.test(currentStaffRecord.role || ''));
    // Onboarding access — tighter than isAdmin. Holds PII (SSN, W4, DL etc).
    // Defaults true for owners (id 40/41) only; everyone else needs the
    // explicit canViewOnboarding=true flag in their staff record.
    const hasOnboardingAccess = canViewOnboarding(currentStaffRecord);
    // Guard: if a non-admin restored a session that landed on admin/labor,
    // bounce them back to Home. Otherwise the tab gate hides the content
    // and they see a blank screen + a sidebar item highlighted that they
    // don't have permission for.
    useEffect(() => {
        if (!staffName) return;
        if ((activeTab === "admin" || activeTab === "labor") && !staffIsAdmin) {
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

    // TV / kiosk deep link (handled before auth):
    //   /?tv=webster   → Webster menu board (digital signage)
    //   /?tv=maryland  → MD Heights menu board
    // The Fire TV Stick at each restaurant points its kiosk browser
    // here. No PIN, no staff context — just a read-only public menu
    // with live 86 status. Andrew 2026-05-20.
    if (tvMode) {
        return (
            <Suspense fallback={<div className="fixed inset-0 bg-white" />}>
                <MenuDisplay location={tvMode.location} />
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
            <Suspense fallback={<div className="min-h-screen bg-mint-50" />}>
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
            <Suspense fallback={<div className="min-h-screen bg-mint-50" />}>
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
            <Suspense fallback={<div className="min-h-screen bg-mint-50" />}>
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
            <Suspense fallback={<div className="min-h-screen bg-dd-bg" />}>
                <RequiredTaskFlow
                    staffName={staffName}
                    staff={currentStaffRecord}
                    staffList={staffList}
                    setStaffList={setStaffList}
                    language={language}
                    onAllDone={() => setRequiredTaskTick(t => t + 1)}
                    onSignOut={() => { setStaffName(null); setActiveTab('home'); }}
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
                        hiddenPages={(currentStaffRecord && Array.isArray(currentStaffRecord.hiddenPages)) ? currentStaffRecord.hiddenPages : []}
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
            if (activeTab === 'chat') return <ChatCenter language={language} staffName={staffName} staffList={staffList} setStaffList={setStaffList} isAdmin={staffIsAdmin} isManager={isManager} storeLocation={effectiveLocation} />;
            if (activeTab === 'training' && canSeePage(currentStaffRecord, 'training')) return <TrainingHub staffName={staffName} language={language} staffList={staffList} />;
            if (activeTab === 'operations' && hasOpsAccess) return <Operations language={language} staffList={staffList} staffName={staffName} storeLocation={effectiveLocation} />;
            if (activeTab === 'menu' && canSeePage(currentStaffRecord, 'menu')) return <MenuReference language={language} />;
            if (activeTab === 'datestickers') return <DateStickerPrinter language={language} staffName={staffName} storeLocation={effectiveLocation} staffList={staffList} />;
            if (activeTab === 'schedule') return <Schedule staffName={staffName} language={language} storeLocation={effectiveLocation} staffList={staffList} setStaffList={setStaffList} />;
            if (activeTab === 'recipes' && hasRecipesAccess) return <Recipes language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} isAtDDMau={isAtDDMau} geoChecking={geoChecking} geoError={geoError} geoRetry={geoRetry} geoPermState={geoPermState} />;
            if (activeTab === 'labor' && staffIsAdmin) return <LaborDashboard language={language} storeLocation={effectiveLocation} />;
            if (activeTab === 'eighty6' && canSeePage(currentStaffRecord, 'eighty6')) return <Eighty6Dashboard language={language} storeLocation={effectiveLocation} staffName={staffName} staffList={staffList} isAdmin={staffIsAdmin} />;
            if (activeTab === 'catering' && canSeePage(currentStaffRecord, 'catering')) return <CateringOrder language={language} staffName={staffName} />;
            if (activeTab === 'maintenance' && canSeePage(currentStaffRecord, 'maintenance')) return <MaintenanceRequest language={language} staffName={staffName} storeLocation={effectiveLocation} />;
            if (activeTab === 'insurance' && canSeePage(currentStaffRecord, 'insurance')) return <InsuranceEnrollment language={language} staffName={staffName} staffList={staffList} />;
            if (activeTab === 'ai' && canSeePage(currentStaffRecord, 'ai')) return <AiAssistant language={language} staffName={staffName} storeLocation={effectiveLocation} />;
            if (activeTab === 'tardies' && isManager) return <TardinessTracker language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} />;
            if (activeTab === 'handoff' && isManager) return <ShiftHandoff language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} />;
            if (activeTab === 'admin' && staffIsAdmin) return <AdminPanel language={language} staffName={staffName} staffList={staffList} setStaffList={setStaffList} storeLocation={effectiveLocation} onNavigate={(tab) => setActiveTab(tab)} hasOnboardingAccess={hasOnboardingAccess} />;
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
                    // Logout returns the app to the lock screen by clearing
                    // the active staffName. The render branches at the top
                    // of App() route to <HomePage /> when staffName is null.
                    onLogout={() => { setStaffName(null); setActiveTab('home'); }}
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
            </Suspense>
        );
}
