import { useState, useEffect, useRef, lazy, Suspense, Component } from 'react';
import { db } from './firebase';
import { doc, getDoc, setDoc, collection, getDocs, query, limit, writeBatch } from 'firebase/firestore';
import { onSnapshot } from 'firebase/firestore';
import { t } from './data/translations';
import { isAdmin, DEFAULT_STAFF, LOCATION_LABELS } from './data/staff';
import { enableFcmPush, onForegroundMessage } from './messaging';
// Components — eagerly loaded (needed immediately)
import HomePage from './components/HomePage';
import InstallAppButton from './components/InstallAppButton';
import AppVersion from './components/AppVersion';
import AppToast from './components/AppToast';
// v2 design preview — gated by ?v2=1 query param.
const AppShellV2 = lazy(() => import('./v2/AppShellV2'));
const HomeV2 = lazy(() => import('./v2/HomeV2'));
import useGeofence from './components/hooks/useGeofence';
import usePullToRefresh, { forceRefresh } from './components/hooks/usePullToRefresh';
// Components — lazy loaded (only when tab is active)
const TrainingHub = lazy(() => import('./components/TrainingHub'));
const Operations = lazy(() => import('./components/Operations'));
const MenuReference = lazy(() => import('./components/MenuReference'));
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

// Error boundary — catches render errors in child components
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
    }
    render() {
        if (this.state.hasError) {
            const isEs = this.props.language === "es";
            return (
                <div style={{padding: "32px 16px", textAlign: "center"}}>
                    <p style={{fontSize: "40px", marginBottom: "12px"}}>⚠️</p>
                    <p style={{fontSize: "18px", fontWeight: 700, color: "#dc2626", marginBottom: "8px"}}>
                        {isEs ? "Algo salió mal" : "Something went wrong"}
                    </p>
                    <p style={{fontSize: "14px", color: "#6b7280", marginBottom: "16px"}}>
                        {isEs ? "Esta sección tuvo un error. Intenta recargar." : "This section had an error. Try reloading."}
                    </p>
                    <button onClick={() => this.setState({ hasError: false, error: null })}
                        style={{padding: "10px 24px", background: "#059669", color: "white", border: "none", borderRadius: "8px", fontWeight: 700, fontSize: "14px", cursor: "pointer"}}>
                        {isEs ? "Reintentar" : "Try Again"}
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
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

// v2 design preview — when the URL contains ?v2=1 (or localStorage flag is
// set) we render the new SaaS-style shell instead of the existing app.
// Lets us iterate on the new design with real data and a real toggle without
// breaking the live app. Append ?v2=0 to the URL to leave the preview.
function useV2Flag() {
    const url = typeof window !== 'undefined' ? new URL(window.location.href) : null;
    const queryFlag = url?.searchParams.get('v2');
    if (queryFlag === '1') { try { localStorage.setItem('ddmau:v2', '1'); } catch {} return true; }
    if (queryFlag === '0') { try { localStorage.removeItem('ddmau:v2'); } catch {} return false; }
    try { return localStorage.getItem('ddmau:v2') === '1'; } catch { return false; }
}

export default function App() {
    const v2 = useV2Flag();
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
    const { isAtDDMau, checking: geoChecking, error: geoError } = useGeofence();
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
                        // Minimal foreground handler — log + browser-native banner.
                        // Schedule.jsx already owns its own in-app notifications drawer.
                        const title = payload?.notification?.title || payload?.data?.title || "DD Mau";
                        const body = payload?.notification?.body || payload?.data?.body || "";
                        console.log("[FCM foreground]", title, body, payload);
                        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                            try { new Notification(title, { body, icon: "/icon-192.png" }); } catch {}
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
    }, [staffName, staffIsAdmin, isManager, hasOpsAccess, hasRecipesAccess, activeTab]);
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
    if (!staffName) {
        return <HomePage onSelectStaff={handleSelectStaff} language={language} staffList={staffList} />;
    }
    // ── v2 design preview branch ─────────────────────────────────────────
    // When ?v2=1 is set, render the redesigned shell instead of the legacy
    // app. Currently shows DemoDashboard for the home tab; other tabs fall
    // through to the legacy components inside the new shell.
    if (v2) {
        // Renders the active tab's existing component INSIDE the v2 shell.
        // Zero rewrite of existing components — same data paths, same gates,
        // same race fixes. Just a different frame. Keeps the PIN incident
        // safety nets intact while we iterate on the new UI.
        const renderV2Body = () => {
            if (activeTab === 'home') {
                return (
                    <HomeV2
                        language={language}
                        staffName={staffName}
                        storeLocation={effectiveLocation}
                        staffList={staffList}
                        onNavigate={(tab) => setActiveTab(tab)} />
                );
            }
            // For everything else, render the legacy component as-is. They
            // sit on the sage page background; cards inside them stay white.
            // We negate the top-level dark backgrounds some legacy components
            // ship with via a CSS reset class that the tab itself defines.
            if (activeTab === 'training') return <TrainingHub staffName={staffName} language={language} staffList={staffList} />;
            if (activeTab === 'operations' && hasOpsAccess) return <Operations language={language} staffList={staffList} staffName={staffName} storeLocation={effectiveLocation} />;
            if (activeTab === 'menu') return <MenuReference language={language} />;
            if (activeTab === 'schedule') return <Schedule staffName={staffName} language={language} storeLocation={effectiveLocation} staffList={staffList} setStaffList={setStaffList} />;
            if (activeTab === 'recipes' && hasRecipesAccess) return <Recipes language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} isAtDDMau={isAtDDMau} geoChecking={geoChecking} geoError={geoError} />;
            if (activeTab === 'labor' && staffIsAdmin) return <LaborDashboard language={language} storeLocation={effectiveLocation} />;
            if (activeTab === 'eighty6') return <Eighty6Dashboard language={language} storeLocation={effectiveLocation} />;
            if (activeTab === 'catering') return <CateringOrder language={language} staffName={staffName} />;
            if (activeTab === 'maintenance') return <MaintenanceRequest language={language} staffName={staffName} storeLocation={effectiveLocation} />;
            if (activeTab === 'insurance') return <InsuranceEnrollment language={language} staffName={staffName} staffList={staffList} />;
            if (activeTab === 'ai') return <AiAssistant language={language} staffName={staffName} storeLocation={effectiveLocation} />;
            if (activeTab === 'tardies' && isManager) return <TardinessTracker language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} />;
            if (activeTab === 'handoff' && isManager) return <ShiftHandoff language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} />;
            if (activeTab === 'admin' && staffIsAdmin) return <AdminPanel language={language} staffName={staffName} staffList={staffList} setStaffList={setStaffList} storeLocation={effectiveLocation} />;
            // Tab not accessible — bounce home.
            return (
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
            <Suspense fallback={<div className="min-h-screen bg-dd-sage" />}>
                <AppShellV2
                    language={language}
                    staffName={staffName}
                    activeTab={activeTab}
                    onNavigate={(tab) => setActiveTab(tab)}
                    onExitV2={() => {
                        try { localStorage.removeItem('ddmau:v2'); } catch {}
                        window.location.search = '?v2=0';
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
            </Suspense>
        );
    }
    // Sidebar nav items — all tabs accessible at desktop. Conditional ones gated.
    // Operations is opt-in (admin or opsAccess === true) so we hide the link
    // entirely for non-access staff — they shouldn't see a tab they can't use.
    const sidebarPrimary = [
        { tab: "home",       icon: "🏠", labelEn: "Home",       labelEs: "Inicio" },
        { tab: "training",   icon: "📚", labelEn: "Training",   labelEs: "Capacitación" },
        ...(hasOpsAccess ? [{ tab: "operations", icon: "📋", labelEn: "Operations", labelEs: "Operaciones" }] : []),
        { tab: "menu",       icon: "🍜", labelEn: "Menu",       labelEs: "Menú" },
        { tab: "schedule",   icon: "📅", labelEn: "Schedule",   labelEs: "Horario" },
    ];
    const sidebarSecondary = [
        { tab: "catering",   icon: "🍽️", labelEn: "Orders",      labelEs: "Pedidos" },
        { tab: "maintenance",icon: "🔧", labelEn: "Maintenance", labelEs: "Mantenimiento" },
        { tab: "insurance",  icon: "🏥", labelEn: "Insurance",   labelEs: "Seguro" },
        { tab: "eighty6",    icon: "🚫", labelEn: "86",          labelEs: "86" },
    ];
    const renderSidebarBtn = (b, accentClass = "") => {
        const isActive = activeTab === b.tab;
        const label = language === "es" ? b.labelEs : b.labelEn;
        return (
            <button key={b.tab} onClick={() => setActiveTab(b.tab)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold transition ${
                    isActive
                        ? "bg-white/15 text-white"
                        : "text-mint-100 hover:bg-white/10 hover:text-white"
                } ${accentClass}`}>
                <span className="text-lg">{b.icon}</span>
                <span>{label}</span>
            </button>
        );
    };

    return (
        <div className="bg-white min-h-screen md:flex">
            {/* Update banner */}
            {updateAvailable && (
                <div onClick={() => window.location.reload()} style={{position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999, background: "#2563eb", color: "white", textAlign: "center", padding: "10px 16px", fontSize: "14px", fontWeight: 600, cursor: "pointer"}}>
                    {language === "es" ? "Nueva actualizacion disponible — toca para refrescar" : "New update available — tap to refresh"}
                </div>
            )}

            {/* Pull-to-refresh indicator. Shows during a downward pull at the
                top of the page; goes solid when threshold is reached or while
                the reload is in flight. Mobile-only via the gesture itself —
                desktop has no touch events. */}
            {(pullRefresh.pullDistance > 0 || pullRefresh.refreshing) && (
                <div style={{
                    position: "fixed",
                    top: updateAvailable ? "40px" : "env(safe-area-inset-top, 0px)",
                    left: 0, right: 0,
                    zIndex: 9998,
                    height: pullRefresh.refreshing ? "44px" : `${Math.min(pullRefresh.pullDistance, 80)}px`,
                    background: pullRefresh.triggered || pullRefresh.refreshing ? "#059669" : "#10b981",
                    color: "white",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "13px",
                    fontWeight: 600,
                    transition: pullRefresh.refreshing ? "height 0.15s" : "none",
                    pointerEvents: "none",
                }}>
                    {pullRefresh.refreshing
                        ? <span>↻ {language === "es" ? "Actualizando…" : "Refreshing…"}</span>
                        : pullRefresh.triggered
                            ? <span>↑ {language === "es" ? "Suelta para actualizar" : "Release to refresh"}</span>
                            : <span style={{ opacity: pullRefresh.progress }}>↓ {language === "es" ? "Jala para actualizar" : "Pull to refresh"}</span>
                    }
                </div>
            )}

            {/* ─── DESKTOP SIDEBAR (md and up) ─── */}
            <aside className="hidden md:flex md:flex-col md:fixed md:inset-y-0 md:left-0 md:w-56 bg-gradient-to-b from-mint-800 to-mint-700 text-white z-30 overflow-y-auto"
                style={updateAvailable ? { paddingTop: "40px" } : {}}>
                {/* Logo header */}
                <div className="px-4 py-5 border-b border-white/10">
                    <h1 className="text-xl font-bold">🍜 DD Mau</h1>
                    <p className="text-xs text-mint-200">{t("staffPortal", language)}</p>
                </div>
                {/* Staff + location pill */}
                <div className="px-4 py-3 border-b border-white/10">
                    <p className="text-xs text-mint-200 truncate">👤 {staffName}</p>
                    {(staffLocation === "both" || staffIsAdmin) ? (
                        <div className="flex gap-1 mt-2">
                            <button onClick={() => setActiveLocation("webster")}
                                className={`flex-1 px-2 py-1 rounded text-[10px] font-bold transition ${activeLocation === "webster" ? "bg-white text-mint-700" : "bg-mint-600 text-white hover:bg-mint-500"}`}>
                                Webster
                            </button>
                            <button onClick={() => setActiveLocation("maryland")}
                                className={`flex-1 px-2 py-1 rounded text-[10px] font-bold transition ${activeLocation === "maryland" ? "bg-white text-mint-700" : "bg-mint-600 text-white hover:bg-mint-500"}`}>
                                MD Heights
                            </button>
                        </div>
                    ) : (
                        <p className="text-[10px] text-mint-300 mt-1">📍 {LOCATION_LABELS[staffLocation] || "Webster"}</p>
                    )}
                </div>
                {/* Primary nav */}
                <nav className="flex-1 px-2 py-3 space-y-0.5">
                    {sidebarPrimary.map(b => renderSidebarBtn(b))}
                    {/* AI as a visually distinct purple block */}
                    {(() => {
                        const isActive = activeTab === "ai";
                        return (
                            <button onClick={() => setActiveTab("ai")}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold transition mt-2 ${
                                    isActive ? "bg-purple-500 text-white" : "bg-purple-700/50 text-purple-100 hover:bg-purple-600"
                                }`}>
                                <span className="text-lg">🤖</span>
                                <span>{language === "es" ? "Asistente AI" : "AI Assistant"}</span>
                            </button>
                        );
                    })()}
                    {hasRecipesAccess && renderSidebarBtn({ tab: "recipes", icon: "🧑‍🍳", labelEn: "Recipes", labelEs: "Recetas" })}
                    <div className="pt-3 mt-2 border-t border-white/10">
                        {sidebarSecondary.map(b => renderSidebarBtn(b))}
                    </div>
                    {/* Manager-or-admin section: HR / discipline tools.
                        Sits between the secondary group and the admin-only
                        group because managers see it but staff don't. */}
                    {isManager && (
                        <div className="pt-3 mt-2 border-t border-white/10 space-y-0.5">
                            {renderSidebarBtn({ tab: "handoff", icon: "🤝", labelEn: "Handoff", labelEs: "Entrega" })}
                            {renderSidebarBtn({ tab: "tardies", icon: "⏰", labelEn: "Tardies", labelEs: "Tardanzas" })}
                        </div>
                    )}
                    {staffIsAdmin && (
                        <div className="pt-3 mt-2 border-t border-white/10 space-y-0.5">
                            {renderSidebarBtn({ tab: "labor",  icon: "📊", labelEn: "Labor",  labelEs: "Mano Obra" })}
                            {renderSidebarBtn({ tab: "admin",  icon: "⚙️",  labelEn: "Admin",  labelEs: "Admin" })}
                        </div>
                    )}
                </nav>
                {/* Footer: language + logout */}
                <div className="px-2 py-3 border-t border-white/10 space-y-1.5">
                    <button onClick={() => setLanguage(language === "en" ? "es" : "en")}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-white/10 text-white hover:bg-white/15">
                        🌐 {language === "en" ? "Español" : "English"}
                    </button>
                    {/* Manual refresh — same cache-bust + reload that mobile's
                        pull-down gesture runs. Lets desktop staff (and mobile
                        users who don't know the gesture) recover from a
                        stuck-on-old-build situation with one click. */}
                    <button onClick={() => forceRefresh()}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-white/10 text-white hover:bg-white/15">
                        ↻ {language === "es" ? "Actualizar" : "Refresh"}
                    </button>
                    <button onClick={() => { setStaffName(null); setActiveTab("home"); }}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-white/10 text-white hover:bg-white/15">
                        🚪 {t("logout", language)}
                    </button>
                    <div className="pt-2 mt-2 border-t border-white/10 text-center">
                        <AppVersion language={language} className="text-white/40 hover:text-white/70" />
                    </div>
                </div>
            </aside>

            {/* ─── MAIN COLUMN ─── pad-left on md: to clear the fixed sidebar.
                 min-w-0 keeps wide content (tables, pricing rows) from blowing the
                 column past the sidebar. overflow-x-hidden on md+ pins the body
                 width so internal wide tables scroll within their own container. */}
            <div className="flex-1 md:ml-56 min-h-screen min-w-0 md:overflow-x-hidden">
            {/* Mobile-only header (hidden on md+) — sidebar replaces it on desktop.
                px-4 + pb-4 + pt-safe-banner = base 1rem padding all around, with
                top padding bumped by safe-area-inset-top so iPhone notches don't
                cover the language toggle / logout buttons. */}
            <div className="md:hidden bg-gradient-to-r from-mint-700 to-mint-600 text-white px-4 pb-4 pt-safe-banner sticky top-0 z-40 shadow-lg" style={updateAvailable ? {marginTop: "40px"} : {}}>
                <div className="flex justify-between items-center">
                    <div>
                        <h1 className="text-2xl font-bold">🍜 DD Mau</h1>
                        <p className="text-sm text-mint-100">{t("staffPortal", language)}</p>
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setLanguage(language === "en" ? "es" : "en")}
                            className="bg-mint-500 hover:bg-mint-700 rounded-full p-2 font-bold text-sm transition"
                        >
                            🌐 {language === "en" ? "ES" : "EN"}
                        </button>
                        {/* Manual refresh — same handler that the pull-down
                            gesture uses. Tap-friendly fallback for staff who
                            don't know the gesture, and a discoverable trigger
                            for managers walking through the app. */}
                        <button
                            onClick={() => forceRefresh()}
                            title={language === "es" ? "Actualizar" : "Refresh"}
                            className="bg-mint-500 hover:bg-mint-700 rounded-full p-2 font-bold text-sm transition"
                        >
                            ↻
                        </button>
                        <button
                            onClick={() => { setStaffName(null); setActiveTab("home"); }}
                            className="bg-mint-500 hover:bg-mint-700 px-3 py-2 rounded-lg text-sm font-bold transition"
                        >
                            {t("logout", language)}
                        </button>
                    </div>
                </div>
                <div className="flex justify-between items-center mt-2">
                    <p className="text-xs text-mint-100">{staffName}</p>
                    {(staffLocation === "both" || staffIsAdmin) ? (
                        <div className="flex gap-1">
                            <button onClick={() => setActiveLocation("webster")}
                                className={`px-2 py-0.5 rounded text-xs font-bold transition ${activeLocation === "webster" ? "bg-white text-mint-700" : "bg-mint-500 text-white"}`}>
                                Webster
                            </button>
                            <button onClick={() => setActiveLocation("maryland")}
                                className={`px-2 py-0.5 rounded text-xs font-bold transition ${activeLocation === "maryland" ? "bg-white text-mint-700" : "bg-mint-500 text-white"}`}>
                                MD Heights
                            </button>
                        </div>
                    ) : (
                        <p className="text-xs text-mint-200">{LOCATION_LABELS[staffLocation] || "Webster"}</p>
                    )}
                </div>
            </div>
            {/* Content — wider container at md: */}
            <div className="max-w-lg md:max-w-7xl mx-auto md:px-4 lg:px-6">
                {activeTab === "home" && (
                    <div className="pb-bottom-nav" style={{background: "#111827"}}>
                        <div style={{background: "linear-gradient(135deg, #059669, #047857)", padding: "24px 16px 20px", color: "white"}}>
                            <p style={{fontSize: "13px", opacity: 0.8, margin: 0}}>{language === "es" ? (new Date().getHours() < 12 ? "Buenos días" : new Date().getHours() < 17 ? "Buenas tardes" : "Buenas noches") : new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 17 ? "Good afternoon" : "Good evening"}</p>
                            <h2 style={{fontSize: "22px", fontWeight: 700, margin: "4px 0 0"}}>{t("welcome", language)}, {staffName}!</h2>
                        </div>
                        <div style={{padding: "16px"}}>
                            <div className="dd-tile-grid">
                                {[
                                    { tab: "training", icon: "📚", label: t("trainingHub", language), sub: language === "es" ? "Modulos" : "Modules" },
                                    ...(hasOpsAccess ? [{ tab: "operations", icon: "📋", label: t("dailyOps", language), sub: language === "es" ? "Listas" : "Checklists" }] : []),
                                    { tab: "menu", icon: "🍜", label: t("menuReference", language), sub: language === "es" ? "Menu completo" : "Full menu" },
                                    { tab: "schedule", icon: "📅", label: t("weeklySchedule", language), sub: language === "es" ? "Tus turnos" : "Your shifts" },
                                ].map(b => (
                                    <button key={b.tab} onClick={() => setActiveTab(b.tab)}
                                        style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                        <div style={{width: "44px", height: "44px", background: "#065f46", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>{b.icon}</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{b.label}</p>
                                        <p style={{fontSize: "10px", color: "#34d399", margin: "2px 0 0"}}>{b.sub}</p>
                                    </button>
                                ))}
                                {hasRecipesAccess ? (
                                    <button onClick={() => setActiveTab("recipes")}
                                        style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                        <div style={{width: "44px", height: "44px", background: "#065f46", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>🧑‍🍳</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{t("recipesTitle", language)}</p>
                                        <p style={{fontSize: "10px", color: "#34d399", margin: "2px 0 0"}}>{language === "es" ? "Acceso" : "Access"}</p>
                                    </button>
                                ) : (
                                    <div style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", opacity: 0.4}}>
                                        <div style={{width: "44px", height: "44px", background: "#374151", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>🔒</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#6b7280", margin: 0}}>{t("recipesTitle", language)}</p>
                                        <p style={{fontSize: "10px", color: "#4b5563", margin: "2px 0 0"}}>
                                            {language === "es" ? "Acceso por administrador" : "Admin access required"}
                                        </p>
                                    </div>
                                )}

                                <button onClick={() => setActiveTab("eighty6")}
                                    style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                    <div style={{width: "44px", height: "44px", background: "#991b1b", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>🚫</div>
                                    <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>86</p>
                                    <p style={{fontSize: "10px", color: "#f87171", margin: "2px 0 0"}}>{language === "es" ? "Agotados" : "Out of Stock"}</p>
                                </button>
                                {[
                                    { tab: "catering", icon: "🍽️", label: language === "es" ? "Pedidos" : "Orders", sub: language === "es" ? "Catering y mas" : "Catering & more" },
                                    { tab: "maintenance", icon: "🔧", label: language === "es" ? "Mantenimiento" : "Maintenance", sub: language === "es" ? "Reportar" : "Report issue" },
                                ].map(b => (
                                    <button key={b.tab} onClick={() => setActiveTab(b.tab)}
                                        style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                        <div style={{width: "44px", height: "44px", background: "#065f46", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>{b.icon}</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{b.label}</p>
                                        <p style={{fontSize: "10px", color: "#34d399", margin: "2px 0 0"}}>{b.sub}</p>
                                    </button>
                                ))}
                                <button onClick={() => setActiveTab("insurance")} style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                    <div style={{width: "44px", height: "44px", background: "#065f46", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>🏥</div>
                                    <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{language === "es" ? "Seguro" : "Insurance"}</p>
                                    <p style={{fontSize: "10px", color: "#34d399", margin: "2px 0 0"}}>{language === "es" ? "Beneficios" : "Benefits"}</p>
                                </button>
                                <button onClick={() => setActiveTab("ai")} style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                    <div style={{width: "44px", height: "44px", background: "#5b21b6", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>🤖</div>
                                    <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{language === "es" ? "Asistente AI" : "AI Assistant"}</p>
                                    <p style={{fontSize: "10px", color: "#a78bfa", margin: "2px 0 0"}}>{language === "es" ? "Preguntame" : "Ask anything"}</p>
                                </button>
                                {staffIsAdmin && (
                                    <button onClick={() => setActiveTab("admin")}
                                        style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                        <div style={{width: "44px", height: "44px", background: "#065f46", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>⚙️</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{t("adminPanel", language)}</p>
                                        <p style={{fontSize: "10px", color: "#34d399", margin: "2px 0 0"}}>{language === "es" ? "Configuracion" : "Settings"}</p>
                                    </button>
                                )}
                            </div>
                            <div style={{marginTop: "12px"}}><InstallAppButton language={language} /></div>
                        </div>
                    </div>
                )}
                <Suspense fallback={<TabLoading language={language} />}>
                    <ErrorBoundary language={language} key={activeTab}>
                        {activeTab === "training" && <TrainingHub staffName={staffName} language={language} staffList={staffList} />}
                        {activeTab === "operations" && hasOpsAccess && <Operations language={language} staffList={staffList} staffName={staffName} storeLocation={effectiveLocation} />}
                        {activeTab === "menu" && <MenuReference language={language} />}
                        {activeTab === "schedule" && <Schedule staffName={staffName} language={language} storeLocation={effectiveLocation} staffList={staffList} setStaffList={setStaffList} />}
                        {activeTab === "recipes" && hasRecipesAccess && <Recipes language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} isAtDDMau={isAtDDMau} geoChecking={geoChecking} geoError={geoError} />}
                        {activeTab === "labor" && staffIsAdmin && <LaborDashboard language={language} storeLocation={effectiveLocation} />}
                        {activeTab === "eighty6" && <Eighty6Dashboard language={language} storeLocation={effectiveLocation} />}
                        {activeTab === "catering" && <CateringOrder language={language} staffName={staffName} />}
                        {activeTab === "maintenance" && <MaintenanceRequest language={language} staffName={staffName} storeLocation={effectiveLocation} />}
                        {activeTab === "insurance" && <InsuranceEnrollment language={language} staffName={staffName} staffList={staffList} />}
                        {activeTab === "ai" && <AiAssistant language={language} staffName={staffName} storeLocation={effectiveLocation} />}
                        {activeTab === "tardies" && isManager && <TardinessTracker language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} />}
                        {activeTab === "handoff" && isManager && <ShiftHandoff language={language} staffName={staffName} staffList={staffList} storeLocation={effectiveLocation} />}
                        {activeTab === "admin" && staffIsAdmin && <AdminPanel language={language} staffName={staffName} staffList={staffList} setStaffList={setStaffList} storeLocation={effectiveLocation} />}
                    </ErrorBoundary>
                </Suspense>
            </div>
            </div>
            {/* In-app toast notification stack. Mounted once at app root so
                any module can call toast() without prop-drilling. Replaces
                window.alert() everywhere — native alert showed
                "ddmauapp.github.io says:" as a prefix on Chrome, which we
                don't want staff seeing. */}
            <AppToast />
            {/* Bottom Navigation — hidden on md+ since sidebar replaces it */}
            {/* Mobile-only version footer — sits just above the bottom nav.
                Hidden on md+ since the desktop sidebar already shows it.
                z-30 so it covers sticky-left table cells (which use z-10
                inside Schedule's grid view) — without this, long staff
                lists rendered the bottom names ON TOP of the nav. */}
            <div className="fixed bottom-20 left-0 right-0 flex justify-center md:hidden pointer-events-none z-30">
                <div className="bg-white/80 backdrop-blur rounded-full shadow-sm pointer-events-auto">
                    <AppVersion language={language} />
                </div>
            </div>
            <nav className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-gray-200 navbar-shadow md:hidden bottom-nav-safe z-30">
                <div className="max-w-lg mx-auto flex justify-around items-center h-20">
                    {[
                        { tab: "home", icon: "🏠", label: t("home", language) },
                        { tab: "training", icon: "📚", label: t("training", language) },
                        ...(hasOpsAccess ? [{ tab: "operations", icon: "📋", label: t("operations", language) }] : []),
                        { tab: "menu", icon: "🍜", label: t("menu", language) },
                        { tab: "schedule", icon: "📅", label: t("schedule", language) },
                    ].map(b => (
                        <button key={b.tab}
                            onClick={() => setActiveTab(b.tab)}
                            className={`flex flex-col items-center justify-center flex-1 h-full transition ${activeTab === b.tab ? "text-mint-700 bg-mint-50" : "text-gray-600 hover:text-mint-700"}`}
                        >
                            <span className="text-2xl">{b.icon}</span>
                            <span className="text-xs font-bold mt-1">{b.label}</span>
                        </button>
                    ))}
                    <button
                        onClick={() => setActiveTab("ai")}
                        className={`flex flex-col items-center justify-center flex-1 h-full transition ${activeTab === "ai" ? "text-purple-700 bg-purple-50" : "text-gray-600 hover:text-purple-700"}`}
                    >
                        <span className="text-2xl">🤖</span>
                        <span className="text-xs font-bold mt-1">{language === "es" ? "AI" : "AI"}</span>
                    </button>
                    {hasRecipesAccess && (
                        <button
                            onClick={() => setActiveTab("recipes")}
                            className={`flex flex-col items-center justify-center flex-1 h-full transition ${activeTab === "recipes" ? "text-mint-700 bg-mint-50" : "text-gray-600 hover:text-mint-700"}`}
                        >
                            <span className="text-2xl">🧑‍🍳</span>
                            <span className="text-xs font-bold mt-1">{t("recipes", language)}</span>
                        </button>
                    )}
                    {staffIsAdmin && (
                        <button
                            onClick={() => setActiveTab("admin")}
                            className={`flex flex-col items-center justify-center flex-1 h-full transition ${activeTab === "admin" ? "text-mint-700 bg-mint-50" : "text-gray-600 hover:text-mint-700"}`}
                        >
                            <span className="text-2xl">⚙️</span>
                            <span className="text-xs font-bold mt-1">{t("admin", language)}</span>
                        </button>
                    )}
                </div>
            </nav>
        </div>
    );
}
