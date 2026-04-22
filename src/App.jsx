import { useState, useEffect } from 'react';
import { db } from './firebase';
import { doc, getDoc, setDoc, collection, getDocs, query, limit, writeBatch } from 'firebase/firestore';
import { onSnapshot } from 'firebase/firestore';
import { t } from './data/translations';
import { isAdmin, DEFAULT_STAFF, LOCATION_LABELS } from './data/staff';

// Components
import HomePage from './components/HomePage';
import InstallAppButton from './components/InstallAppButton';
import TrainingHub from './components/TrainingHub';
import Operations from './components/Operations';
import MenuReference from './components/MenuReference';
import Schedule from './components/Schedule';
import Recipes from './components/Recipes';
import Eighty6Dashboard from './components/Eighty6Dashboard';
import CateringOrder from './components/CateringOrder';
import MaintenanceRequest from './components/MaintenanceRequest';
import AdminPanel from './components/AdminPanel';
import useGeofence from './components/hooks/useGeofence';

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

// Run once on load
runMigrations();

export default function App() {
    const [staffName, setStaffName] = useState(null);
    const [staffLocation, setStaffLocation] = useState("webster");
    const [activeLocation, setActiveLocation] = useState("webster");
    const [language, setLanguage] = useState("en");
    const [activeTab, setActiveTab] = useState("home");
    const [staffList, setStaffList] = useState(DEFAULT_STAFF);
    const { isAtDDMau, checking: geoChecking, error: geoError } = useGeofence();

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

    return (
        <div className="bg-white min-h-screen">
            {/* Header */}
            <div className="bg-gradient-to-r from-mint-700 to-mint-600 text-white p-4 sticky top-0 z-40 shadow-lg">
                <div className="max-w-lg mx-auto flex justify-between items-center">
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

            {/* Content */}
            <div className="max-w-lg mx-auto">
                {activeTab === "home" && (
                    <div className="pb-24" style={{background: "#111827"}}>
                        <div style={{background: "linear-gradient(135deg, #059669, #047857)", padding: "24px 16px 20px", color: "white"}}>
                            <p style={{fontSize: "13px", opacity: 0.8, margin: 0}}>{language === "es" ? "Buenas tardes" : new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 17 ? "Good afternoon" : "Good evening"}</p>
                            <h2 style={{fontSize: "22px", fontWeight: 700, margin: "4px 0 0"}}>{t("welcome", language)}, {staffName}!</h2>
                        </div>
                        <div style={{padding: "16px"}}>
                            <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px"}}>
                                {[
                                    { tab: "training", icon: "📚", label: t("trainingHub", language), sub: language === "es" ? "Módulos" : "Modules" },
                                    { tab: "operations", icon: "📋", label: t("dailyOps", language), sub: language === "es" ? "Listas" : "Checklists" },
                                    { tab: "menu", icon: "🍜", label: t("menuReference", language), sub: language === "es" ? "Menú completo" : "Full menu" },
                                    { tab: "schedule", icon: "📅", label: t("weeklySchedule", language), sub: language === "es" ? "Tus turnos" : "Your shifts" },
                                ].map(b => (
                                    <button key={b.tab} onClick={() => setActiveTab(b.tab)}
                                        style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                        <div style={{width: "44px", height: "44px", background: "#065f46", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>{b.icon}</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{b.label}</p>
                                        <p style={{fontSize: "10px", color: "#34d399", margin: "2px 0 0"}}>{b.sub}</p>
                                    </button>
                                ))}

                                {(isAtDDMau || staffIsAdmin) ? (
                                    <button onClick={() => setActiveTab("recipes")}
                                        style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                        <div style={{width: "44px", height: "44px", background: "#065f46", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>🧑‍🍳</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{t("recipesTitle", language)}</p>
                                        <p style={{fontSize: "10px", color: "#34d399", margin: "2px 0 0"}}>{staffIsAdmin && !isAtDDMau ? (language === "es" ? "Admin" : "Admin access") : (language === "es" ? "En tienda" : "In-store")}</p>
                                    </button>
                                ) : (
                                    <div style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", opacity: 0.4}}>
                                        <div style={{width: "44px", height: "44px", background: "#374151", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>🔒</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#6b7280", margin: 0}}>{t("recipesTitle", language)}</p>
                                        <p style={{fontSize: "10px", color: "#4b5563", margin: "2px 0 0"}}>
                                            {geoChecking ? (language === "es" ? "Verificando..." : "Checking...") :
                                             geoError === "denied" ? (language === "es" ? "Ubicación denegada" : "Location denied") :
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
                                    { tab: "catering", icon: "🍽️", label: language === "es" ? "Catering" : "Catering", sub: language === "es" ? "Pedidos" : "Orders" },
                                    { tab: "maintenance", icon: "🔧", label: language === "es" ? "Mantenimiento" : "Maintenance", sub: language === "es" ? "Reportar" : "Report issue" },
                                ].map(b => (
                                    <button key={b.tab} onClick={() => setActiveTab(b.tab)}
                                        style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                        <div style={{width: "44px", height: "44px", background: "#065f46", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>{b.icon}</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{b.label}</p>
                                        <p style={{fontSize: "10px", color: "#34d399", margin: "2px 0 0"}}>{b.sub}</p>
                                    </button>
                                ))}

                                {staffIsAdmin && (
                                    <button onClick={() => setActiveTab("admin")}
                                        style={{background: "#1f2937", borderRadius: "16px", padding: "16px", textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.3)", border: "1px solid #374151", cursor: "pointer"}}>
                                        <div style={{width: "44px", height: "44px", background: "#065f46", borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", fontSize: "22px"}}>⚙️</div>
                                        <p style={{fontSize: "13px", fontWeight: 700, color: "#f9fafb", margin: 0}}>{t("adminPanel", language)}</p>
                                        <p style={{fontSize: "10px", color: "#34d399", margin: "2px 0 0"}}>{language === "es" ? "Configuración" : "Settings"}</p>
                                    </button>
                                )}
                            </div>
                            <div style={{marginTop: "12px"}}><InstallAppButton language={language} /></div>
                        </div>
                    </div>
                )}

                {activeTab === "training" && <TrainingHub staffName={staffName} language={language} />}
                {activeTab === "operations" && <Operations language={language} staffList={staffList} staffName={staffName} storeLocation={effectiveLocation} />}
                {activeTab === "menu" && <MenuReference language={language} />}
                {activeTab === "schedule" && <Schedule staffName={staffName} language={language} storeLocation={effectiveLocation} staffList={staffList} />}
                {activeTab === "recipes" && (isAtDDMau || staffIsAdmin) && <Recipes language={language} staffName={staffName} />}
                {activeTab === "eighty6" && <Eighty6Dashboard language={language} storeLocation={effectiveLocation} />}
                {activeTab === "catering" && <CateringOrder language={language} staffName={staffName} />}
                {activeTab === "maintenance" && <MaintenanceRequest language={language} staffName={staffName} storeLocation={effectiveLocation} />}
                {activeTab === "admin" && staffIsAdmin && <AdminPanel language={language} staffList={staffList} setStaffList={setStaffList} storeLocation={effectiveLocation} />}
            </div>

            {/* Bottom Navigation */}
            <nav className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-gray-200 navbar-shadow">
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
