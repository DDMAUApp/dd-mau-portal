import { useState, useEffect, useRef, lazy, Suspense, Component } from 'react';
import { db } from './firebase';
import { doc, getDoc, setDoc, collection, getDocs, query, limit, writeBatch } from 'firebase/firestore';
import { onSnapshot } from 'firebase/firestore';
import { t } from './data/translations';
import { isAdmin, DEFAULT_STAFF, LOCATION_LABELS } from './data/staff';
// Components — eagerly loaded (needed immediately)
import HomePage from './components/HomePage';
import InstallAppButton from './components/InstallAppButton';
import useGeofence from './components/hooks/useGeofence';
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

export default function App() {
    const [staffName, setStaffName] = useState(null);
    const [staffLocation, setStaffLocation] = useState("webster");
    const [activeLocation, setActiveLocation] = useState("webster");
    const [language, setLanguage] = useState("en");
    const [activeTab, setActiveTab] = useState("home");
    const [staffList, setStaffList] = useState(DEFAULT_STAFF);
    const { isAtDDMau, checking: geoChecking, error: geoError } = useGeofence();
    const updateAvailable = useVersionCheck();
    // Run migrations once on first mount
    useEffect(() => {
        if (!migrationRan) {
            migrationRan = true;
            runMigrations();
        }
    }, []);
    // Load staff list from Firestore
    useEffect(() => {
        const unsubscribe = onSnapshot(doc(db, "config", "staff"), (docSnap) => {
            if (docSnap.exists() && docSnap.data().list) {
                const firestoreList = docSnap.data().list;
                const needsMigration = firestoreList.some(s => !s.location);
                if (needsMigration) {
                    const defaultByName = {};
                    DEFAULT_STAFF.forEach(s => { defaultByName[s.name.toLowerCase().trim()] = s; });
                    const firestoreByName = {};
                    firestoreList.forEach(s => { firestoreByName[s.name.toLowerCase().trim()] = s; });
                    const merged = DEFAULT_STAFF.map(ds => {
                        const fsMatch = firestoreByName[ds.name.toLowerCase().trim()];
                        if (fsMatch) {
                            return { ...ds, pin: fsMatch.pin || ds.pin, role: fsMatch.role || ds.role, location: ds.location };
                        }
                        return ds;
                    });
                    firestoreList.forEach(fs => {
                        if (!defaultByName[fs.name.toLowerCase().trim()]) {
                            merged.push({ ...fs, location: fs.location || "webster" });
                        }
                    });
                    setStaffList(merged);
                    setDoc(doc(db, "config", "staff"), { list: merged }).catch(err => console.error("Staff sync error:", err));
                } else {
                    setStaffList(firestoreList);
                }
            }
        });
        return () => unsubscribe();
    }, []);
    const staffIsAdmin = isAdmin(staffName);
    const effectiveLocation = staffIsAdmin ? activeLocation : staffLocation;
    // Per-staff recipes access flag (toggled in AdminPanel). Lets non-admin staff
    // open the Recipes tab even when they're not at a DD Mau location.
    const currentStaffRecord = (staffList || []).find(s => s.name === staffName);
    const hasRecipesAccess = staffIsAdmin || (currentStaffRecord && currentStaffRecord.recipesAccess === true);
    const handleSelectStaff = (name) => {
        setStaffName(name);
        const staff = staffList.find(s => s.name === name);
        const loc = staff?.location || "webster";
        setStaffLocation(loc);
        setActiveLocation(loc === "both" ? "webster" : loc);
    };
    if (!staffName) {
        return <HomePage onSelectStaff={handleSelectStaff} language={language} staffList={staffList} />;
    }
    // Sidebar nav items — all tabs accessible at desktop. Conditional ones gated.
    const sidebarPrimary = [
        { tab: "home",       icon: "🏠", labelEn: "Home",       labelEs: "Inicio" },
        { tab: "training",   icon: "📚", labelEn: "Training",   labelEs: "Capacitación" },
        { tab: "operations", icon: "📋", labelEn: "Operations", labelEs: "Operaciones" },
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
                    {(isAtDDMau || hasRecipesAccess) && renderSidebarBtn({ tab: "recipes", icon: "🧑‍🍳", labelEn: "Recipes", labelEs: "Recetas" })}
                    <div className="pt-3 mt-2 border-t border-white/10">
                        {sidebarSecondary.map(b => renderSidebarBtn(b))}
                    </div>
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
                    <button onClick={() => { setStaffName(null); setActiveTab("home"); }}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-white/10 text-white hover:bg-white/15">
                        🚪 {t("logout", language)}
                    </button>
                </div>
            </aside>

            {/* ─── MAIN COLUMN ─── pad-left on md: to clear the fixed sidebar.
                 min-w-0 keeps wide content (tables, pricing rows) from blowing the
                 column past the sidebar. overflow-x-hidden on md+ pins the body
                 width so internal wide tables scroll within their own container. */}
            <div className="flex-1 md:ml-56 min-h-screen min-w-0 md:overflow-x-hidden">
            {/* Mobile-only header (hidden on md+) — sidebar replaces it on desktop */}
            <div className="md:hidden bg-gradient-to-r from-mint-700 to-mint-600 text-white p-4 sticky top-0 z-40 shadow-lg" style={updateAvailable ? {marginTop: "40px"} : {}}>
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
                    <div className="pb-24" style={{background: "#111827"}}>
                        <div style={{background: "linear-gradient(135deg, #059669, #047857)", padding: "24px 16px 20px", color: "white"}}>
                            <p style={{fontSize: "13px", opacity: 0.8, margin: 0}}>{language === "es" ? (new Date().getHours() < 12 ? "Buenos días" : new Date().getHours() < 17 ? "Buenas tardes" : "Buenas noches") : new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 17 ? "Good afternoon" : "Good evening"}</p>
                            <h2 style={{fontSize: "22px", fontWeight: 700, margin: "4px 0 0"}}>{t("welcome", language)}, {staffName}!</h2>
                        </div>
                        <div style={{padding: "16px"}}>
                            <div className="dd-tile-grid">
                                {[
                                    { tab: "training", icon: "📚", label: t("trainingHub", language), sub: language === "es" ? "Modulos" : "Modules" },
                                    { tab: "operations", icon: "📋", label: t("dailyOps", language), sub: language === "es" ? "Listas" : "Checklists" },
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
                                {(isAtDDMau || hasRecipesAccess) ? (
                                    <button onClick={() => setActiveTab("recipes")}
                                        style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                        <div style={{width: "44px", height: "44px", background: "#065f46", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>🧑‍🍳</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{t("recipesTitle", language)}</p>
                                        <p style={{fontSize: "10px", color: "#34d399", margin: "2px 0 0"}}>{hasRecipesAccess && !isAtDDMau ? (language === "es" ? "Acceso" : "Access granted") : (language === "es" ? "En tienda" : "In-store")}</p>
                                    </button>
                                ) : (
                                    <div style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", opacity: 0.4}}>
                                        <div style={{width: "44px", height: "44px", background: "#374151", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>🔒</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#6b7280", margin: 0}}>{t("recipesTitle", language)}</p>
                                        <p style={{fontSize: "10px", color: "#4b5563", margin: "2px 0 0"}}>
                                            {geoChecking ? (language === "es" ? "Verificando..." : "Checking...") :
                                             geoError === "denied" ? (language === "es" ? "Ubicacion denegada" : "Location denied") :
                                             geoError ? (language === "es" ? "No disponible" : "Unavailable") :
                                             (language === "es" ? "Solo en DD Mau" : "In-store only")}
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
                        {activeTab === "operations" && <Operations language={language} staffList={staffList} staffName={staffName} storeLocation={effectiveLocation} />}
                        {activeTab === "menu" && <MenuReference language={language} />}
                        {activeTab === "schedule" && <Schedule staffName={staffName} language={language} storeLocation={effectiveLocation} staffList={staffList} setStaffList={setStaffList} />}
                        {activeTab === "recipes" && (isAtDDMau || hasRecipesAccess) && <Recipes language={language} staffName={staffName} staffList={staffList} />}
                        {activeTab === "labor" && staffIsAdmin && <LaborDashboard language={language} storeLocation={effectiveLocation} />}
                        {activeTab === "eighty6" && <Eighty6Dashboard language={language} storeLocation={effectiveLocation} />}
                        {activeTab === "catering" && <CateringOrder language={language} staffName={staffName} />}
                        {activeTab === "maintenance" && <MaintenanceRequest language={language} staffName={staffName} storeLocation={effectiveLocation} />}
                        {activeTab === "insurance" && <InsuranceEnrollment language={language} staffName={staffName} staffList={staffList} />}
                        {activeTab === "ai" && <AiAssistant language={language} staffName={staffName} storeLocation={effectiveLocation} />}
                        {activeTab === "admin" && staffIsAdmin && <AdminPanel language={language} staffList={staffList} setStaffList={setStaffList} storeLocation={effectiveLocation} />}
                    </ErrorBoundary>
                </Suspense>
            </div>
            </div>
            {/* Bottom Navigation — hidden on md+ since sidebar replaces it */}
            <nav className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-gray-200 navbar-shadow md:hidden">
                <div className="max-w-lg mx-auto flex justify-around items-center h-20">
                    {[
                        { tab: "home", icon: "🏠", label: t("home", language) },
                        { tab: "training", icon: "📚", label: t("training", language) },
                        { tab: "operations", icon: "📋", label: t("operations", language) },
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
                    {(isAtDDMau || staffIsAdmin) && (
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
