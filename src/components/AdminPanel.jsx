import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, collection, onSnapshot, setDoc, getDoc, getDocs, updateDoc, query, orderBy, limit } from 'firebase/firestore';
import { t } from '../data/translations';
import { isAdmin, ADMIN_IDS, LOCATION_LABELS } from '../data/staff';
import ChecklistHistory from './ChecklistHistory';
import InventoryHistory from './InventoryHistory'; 

// Wrapper enforces admin-only access BEFORE the inner component's hooks run.
// Early-returning inside AdminPanelInner would violate React's rules-of-hooks
// (hooks must run in the same order every render). This wrapper-pattern is the
// idiomatic fix.
export default function AdminPanel(props) {
    if (!isAdmin(props.staffName, props.staffList)) {
        return (
            <div className="p-6 text-center text-gray-500">
                {props.language === "es" ? "Acceso denegado." : "Access denied."}
            </div>
        );
    }
    return <AdminPanelInner {...props} />;
}

function AdminPanelInner({ language, staffName, staffList, setStaffList, storeLocation }) {
            const [editingId, setEditingId] = useState(null);
            const [editPin, setEditPin] = useState("");
            const [editRole, setEditRole] = useState("");
            const [editOpsAccess, setEditOpsAccess] = useState(false);
            const [editRecipesAccess, setEditRecipesAccess] = useState(false);
            const [editShiftLead, setEditShiftLead] = useState(false);
            const [editIsMinor, setEditIsMinor] = useState(false);
            const [editScheduleSide, setEditScheduleSide] = useState("foh");
            const [editTargetHours, setEditTargetHours] = useState(0);
            // Designated-scheduler toggles. Per-side so the FOH scheduler
            // can't accidentally publish over BOH shifts and vice versa.
            const [editCanEditScheduleFOH, setEditCanEditScheduleFOH] = useState(false);
            const [editCanEditScheduleBOH, setEditCanEditScheduleBOH] = useState(false);
            const [showBulkTag, setShowBulkTag] = useState(false);
            const [bulkSearch, setBulkSearch] = useState("");
            const [bulkFilter, setBulkFilter] = useState("all"); // all | untagged | foh | boh

            // Centralized BOH role inference — same vocabulary as Schedule.jsx,
            // duplicated here so AdminPanel doesn't take a Schedule import.
            const BULK_BOH_ROLES = ["BOH", "Pho", "Pho Station", "Grill", "Fryer", "Fried Rice", "Dish", "Bao/Tacos/Banh Mi", "Spring Rolls/Prep", "Prep", "Kitchen Manager", "Asst Kitchen Manager"];
            const inferSide = (role) => BULK_BOH_ROLES.includes(role) ? "boh" : "foh";

            // One-shot auto-tag — fills in scheduleSide for every staff that
            // currently has no explicit value. Saves a single Firestore write
            // (whole-list setDoc) instead of N separate ones, so 60+ staff
            // get tagged in a fraction of a second.
            const autoTagUntagged = async () => {
                let touched = 0;
                let latest = null;
                setStaffList(prev => {
                    const next = prev.map(s => {
                        if (s.scheduleSide === "foh" || s.scheduleSide === "boh") return s;
                        touched += 1;
                        return { ...s, scheduleSide: inferSide(s.role) };
                    });
                    latest = next;
                    return next;
                });
                if (touched > 0 && latest) {
                    await saveStaffToFirestore(latest);
                    showSaved();
                }
                alert(language === "es"
                    ? `✓ Etiquetados automáticamente: ${touched}.`
                    : `✓ Auto-tagged ${touched} staff from role.`);
            };

            // Migration helper: flip every staff record's recipesAccess to
            // true. The recipes policy moved from opt-IN to opt-OUT, so any
            // existing record that's false (or unset) needs an explicit true
            // to participate cleanly. Idempotent — safe to click again.
            // After this runs, the manager only has to TOGGLE OFF anyone they
            // don't want to have access (rare).
            const grantRecipesToAll = async () => {
                if (!confirm(language === "es"
                    ? "¿Dar acceso a Recetas a TODO el personal? (Puedes quitárselo a alguien después.)"
                    : "Grant Recipes access to ALL staff? (You can revoke individuals later.)")) return;
                let touched = 0;
                let latest = null;
                setStaffList(prev => {
                    const next = prev.map(s => {
                        if (s.recipesAccess === true) return s;
                        touched += 1;
                        return { ...s, recipesAccess: true };
                    });
                    latest = next;
                    return next;
                });
                if (touched > 0 && latest) {
                    await saveStaffToFirestore(latest);
                    showSaved();
                }
                alert(language === "es"
                    ? `✓ Acceso a Recetas otorgado: ${touched}.`
                    : `✓ Recipes access granted to ${touched} staff.`);
            };

            // Sweep a filtered subset to one side. Used by the "Tag all
            // visible as FOH/BOH" action — one batched write instead of
            // dozens of taps.
            const bulkSetSide = async (ids, side) => {
                if (ids.length === 0) return;
                const idSet = new Set(ids);
                let latest = null;
                setStaffList(prev => {
                    latest = prev.map(s => idSet.has(s.id) ? { ...s, scheduleSide: side } : s);
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
                showSaved();
            };
            const [availabilityForId, setAvailabilityForId] = useState(null); // staff id whose availability we're editing
            const [showAdd, setShowAdd] = useState(false);
            const [newName, setNewName] = useState("");
            const [newRole, setNewRole] = useState("FOH");
            const [newPin, setNewPin] = useState("");
            const [newLocation, setNewLocation] = useState(storeLocation || "webster");
            const [newOpsAccess, setNewOpsAccess] = useState(false);
            // Recipes is opt-OUT — every new hire gets access by default.
            // Manager can flip the toggle off if they don't want a specific
            // person to see recipes (rare). Operations stays opt-in (default
            // false) because access is genuinely restricted there.
            const [newRecipesAccess, setNewRecipesAccess] = useState(true);
            const [newShiftLead, setNewShiftLead] = useState(false);
            const [newIsMinor, setNewIsMinor] = useState(false);
            const [newScheduleSide, setNewScheduleSide] = useState("foh");
            const [editLocation, setEditLocation] = useState("");
            const [savedMsg, setSavedMsg] = useState(null);
            const [confirmRemoveId, setConfirmRemoveId] = useState(null);
            const [staffExpanded, setStaffExpanded] = useState(false);
            const [maintenanceRequests, setMaintenanceRequests] = useState([]);
            const [maintenanceExpanded, setMaintenanceExpanded] = useState(true);
            const [selectedRequest, setSelectedRequest] = useState(null);
            const [adminNote, setAdminNote] = useState("");
            const [maintFilter, setMaintFilter] = useState("all");

            const showSaved = () => { setSavedMsg(true); setTimeout(() => setSavedMsg(null), 1500); };

            // Filter maintenance requests by selected filter (all / webster / maryland)
            const filteredMaintenance = maintFilter === "all" ? maintenanceRequests : maintenanceRequests.filter(r => !r.storeBranch || r.storeBranch === maintFilter);

            // Filter staff by active location
            const [staffFilter, setStaffFilter] = useState("all");
            const filteredStaff = staffFilter === "all" ? staffList : staffList.filter(s => s.location === staffFilter || s.location === "both");

            // Load maintenance requests
            useEffect(() => {
                const unsub = onSnapshot(query(collection(db, "maintenanceRequests"), orderBy("createdAt", "desc"), limit(50)), (snap) => {
                    const reqs = [];
                    snap.forEach(docSnapshot => reqs.push({ id: docSnapshot.id, ...docSnapshot.data() }));
                    setMaintenanceRequests(reqs);
                }, (err) => { console.error("Error loading maintenance requests:", err); });
                return () => unsub();
            }, []);

            const updateRequestStatus = async (reqId, newStatus) => {
                try {
                    const updates = { status: newStatus, updatedAt: new Date().toISOString() };
                    if (adminNote.trim()) updates.adminNote = adminNote.trim();
                    await updateDoc(doc(db, "maintenanceRequests", reqId), updates);
                    setAdminNote("");
                    showSaved();
                } catch (err) { console.error("Error updating request:", err); }
            };

            const addAdminNoteToRequest = async (reqId) => {
                if (!adminNote.trim()) return;
                try {
                    await updateDoc(doc(db, "maintenanceRequests", reqId), {
                        adminNote: adminNote.trim(), updatedAt: new Date().toISOString()
                    });
                    setAdminNote("");
                    showSaved();
                } catch (err) { console.error("Error adding note:", err); }
            };

            const saveStaffToFirestore = async (updatedList) => {
                try {
                    await setDoc(doc(db, "config", "staff"), { list: updatedList });
                } catch (err) { console.error("Error saving staff:", err); }
            };

            // Tap-to-flip bulk tag handler — used by the Bulk Tag modal.
            // BUG FIX: rapid taps were clobbering each other because the closed-over
            // `staffList` could be stale between renders. Use the functional setter
            // form so we always merge into the latest list, then persist outside the
            // setter (idempotent — last save wins, matches the displayed state).
            const handleBulkUpdate = async (id, patch) => {
                let latest = null;
                setStaffList(prev => {
                    latest = prev.map(s => s.id === id ? { ...s, ...patch } : s);
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
            };

            const handleSavePin = async (id) => {
                if (editPin.length !== 4 || !/^\d{4}$/.test(editPin)) return;
                // Functional setState avoids stale-closure clobber when a
                // concurrent admin edit is in flight (same fix as bulk-tag).
                let latest = null;
                setStaffList(prev => {
                    latest = prev.map(s => s.id === id ? { ...s, pin: editPin, role: editRole, location: editLocation || s.location || "webster", opsAccess: editOpsAccess, recipesAccess: editRecipesAccess, shiftLead: editShiftLead, isMinor: editIsMinor, scheduleSide: editScheduleSide, targetHours: Number(editTargetHours) || 0, canEditScheduleFOH: editCanEditScheduleFOH, canEditScheduleBOH: editCanEditScheduleBOH } : s);
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
                setEditingId(null);
                setEditPin("");
                setEditRole("");
                setEditLocation("");
                setEditOpsAccess(false);
                setEditRecipesAccess(false);
                setEditShiftLead(false);
                setEditIsMinor(false);
                setEditScheduleSide("foh");
                setEditTargetHours(0);
                showSaved();
            };

            const handleAddStaff = async () => {
                if (!newName.trim() || newPin.length !== 4 || !/^\d{4}$/.test(newPin)) return;
                // Functional setState — read latest list from React state
                // instead of closing over a stale snapshot. Otherwise two
                // admins adding back-to-back can silently lose one entry
                // (and the new id is computed off the stale max).
                let latest = null;
                setStaffList(prev => {
                    const maxId = Math.max(...prev.map(s => s.id), 0);
                    const newStaff = { id: maxId + 1, name: newName.trim(), role: newRole, pin: newPin, location: newLocation, opsAccess: newOpsAccess, recipesAccess: newRecipesAccess, shiftLead: newShiftLead, isMinor: newIsMinor, scheduleSide: newScheduleSide };
                    latest = [...prev, newStaff];
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
                setShowAdd(false);
                setNewName("");
                setNewRole("FOH");
                setNewPin("");
                setNewLocation(storeLocation || "webster");
                setNewOpsAccess(false);
                setNewRecipesAccess(true);
                setNewShiftLead(false);
                setNewIsMinor(false);
                setNewScheduleSide("foh");
                showSaved();
            };

            const handleRemoveStaff = async (id) => {
                // Block removal by ADMIN_ID (not name) so renaming an admin
                // doesn't bypass this guard.
                if (ADMIN_IDS.includes(id)) return;
                // Functional setState avoids stale-closure clobber.
                let latest = null;
                setStaffList(prev => {
                    latest = prev.filter(s => s.id !== id);
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
                setConfirmRemoveId(null);
                showSaved();
            };

            const roleOptions = ["FOH", "BOH", "Shift Lead", "Kitchen Manager", "Asst Kitchen Manager", "Manager", "Owner", "Prep", "Grill", "Fryer", "Fried Rice", "Dish", "Bao/Tacos/Banh Mi", "Spring Rolls/Prep", "Pho Station"];

            return (
                <div className="p-4 pb-bottom-nav">
                    <h2 className="text-2xl font-bold text-mint-700 mb-2">⚙️ {t("adminPanel", language)}</h2>
                    <p className="text-xs text-gray-500 mb-4 bg-mint-50 border border-mint-200 rounded-lg p-2">
                        🔐 {language === "es"
                            ? "Solo Andrew Shih y Julie Shih pueden acceder a este panel."
                            : "Only Andrew Shih and Julie Shih can access this panel."}
                    </p>

                    {savedMsg && (
                        <div className="mb-3 p-2 bg-green-100 border border-green-300 rounded-lg text-center text-green-700 font-bold text-sm">
                            ✅ {t("saved", language)}
                        </div>
                    )}

                    {/* ── MAINTENANCE REQUESTS ── */}
                    <div className="mb-6">
                        <button onClick={() => setMaintenanceExpanded(!maintenanceExpanded)}
                            className="w-full flex items-center justify-between bg-red-50 border-2 border-red-200 rounded-xl p-4 hover:bg-red-100 transition">
                            <div className="flex items-center gap-2">
                                <span className="text-2xl">🔧</span>
                                <div className="text-left">
                                    <h3 className="font-bold text-red-700">{language === "es" ? "Solicitudes de Mantenimiento" : "Maintenance Requests"}</h3>
                                    <p className="text-xs text-red-500">
                                        {filteredMaintenance.filter(r => r.status === "open").length} {language === "es" ? "abiertos" : "open"}
                                        {filteredMaintenance.filter(r => r.status === "in-progress").length > 0 && (
                                            ` • ${filteredMaintenance.filter(r => r.status === "in-progress").length} ${language === "es" ? "en progreso" : "in progress"}`
                                        )}
                                    </p>
                                </div>
                            </div>
                            <span className="text-gray-400 text-xl">{maintenanceExpanded ? "▼" : "▶"}</span>
                        </button>

                        {maintenanceExpanded && (
                            <div className="mt-2 space-y-2">
                                <div className="flex gap-1 justify-center">
                                    {[{k:"all",en:"All Locations",es:"Todas"},{k:"webster",en:"Webster",es:"Webster"},{k:"maryland",en:"MD Heights",es:"MD Heights"}].map(f => (
                                        <button key={f.k} onClick={() => setMaintFilter(f.k)}
                                            className={`px-3 py-1 rounded-full text-xs font-bold border transition ${maintFilter === f.k ? "bg-red-600 text-white border-red-600" : "bg-white text-red-600 border-red-300 hover:bg-red-50"}`}>
                                            {language === "es" ? f.es : f.en}
                                            {f.k !== "all" && <span className="ml-1 opacity-70">({maintenanceRequests.filter(r => r.storeBranch === f.k).length})</span>}
                                        </button>
                                    ))}
                                </div>
                                {filteredMaintenance.length === 0 ? (
                                    <p className="text-center text-gray-400 text-sm py-4">{language === "es" ? "No hay solicitudes" : "No requests yet"}</p>
                                ) : <div className="md:grid md:grid-cols-2 md:gap-2 space-y-2 md:space-y-0">{filteredMaintenance.map(req => {
                                    const isExpanded = selectedRequest === req.id;
                                    const statusColors = { open: "bg-yellow-100 text-yellow-700 border-yellow-300", "in-progress": "bg-blue-100 text-blue-700 border-blue-300", completed: "bg-green-100 text-green-700 border-green-300", declined: "bg-red-100 text-red-700 border-red-300" };
                                    const urgencyDot = { low: "🟢", normal: "🟡", high: "🟠", urgent: "🔴" };
                                    return (
                                        <div key={req.id} className={`bg-white rounded-lg border-2 overflow-hidden ${req.status === "open" ? "border-yellow-200" : "border-gray-200"}`}>
                                            <button onClick={() => setSelectedRequest(isExpanded ? null : req.id)}
                                                className="w-full p-3 text-left">
                                                <div className="flex items-start justify-between">
                                                    <div className="flex-1">
                                                        <div className="flex items-center gap-1.5 mb-0.5">
                                                            <span className="text-sm">{urgencyDot[req.urgency] || "🟡"}</span>
                                                            <p className="text-sm font-bold text-gray-800">{req.description}</p>
                                                        </div>
                                                        <p className="text-xs text-gray-500">📍 {req.location} {req.storeBranch ? <span className={`inline-block ml-1 px-1.5 py-0.5 rounded text-xs font-bold ${req.storeBranch === "webster" ? "bg-emerald-100 text-emerald-700" : "bg-purple-100 text-purple-700"}`}>{LOCATION_LABELS[req.storeBranch] || req.storeBranch}</span> : null} • 👤 {req.submittedBy} • {new Date(req.createdAt).toLocaleDateString()}</p>
                                                    </div>
                                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ml-2 whitespace-nowrap ${statusColors[req.status] || "bg-gray-100 text-gray-600 border-gray-300"}`}>
                                                        {req.status === "in-progress" ? (language === "es" ? "En Progreso" : "In Progress") : req.status === "open" ? (language === "es" ? "Abierto" : "Open") : req.status === "completed" ? (language === "es" ? "Completado" : "Done") : (language === "es" ? "Rechazado" : "Declined")}
                                                    </span>
                                                </div>
                                            </button>

                                            {isExpanded && (
                                                <div className="px-3 pb-3 border-t border-gray-100 pt-2 space-y-2">
                                                    {req.reason && <p className="text-xs text-gray-600"><span className="font-bold">{language === "es" ? "Razón:" : "Why:"}</span> {req.reason}</p>}
                                                    <p className="text-xs text-gray-500">{language === "es" ? "Enviado:" : "Submitted:"} {new Date(req.createdAt).toLocaleString()}</p>
                                                    {req.photoUrl && (
                                                        <img src={req.photoUrl} alt="Maintenance" className="rounded-lg border border-gray-200 max-w-full cursor-pointer" style={{maxHeight: "200px"}}
                                                            onClick={() => window.open(req.photoUrl, "_blank")} />
                                                    )}
                                                    {req.adminNote && <p className="text-xs bg-blue-50 border border-blue-200 rounded p-2 text-blue-700">💬 {req.adminNote}</p>}

                                                    {/* Admin note input */}
                                                    <div className="flex gap-1">
                                                        <input type="text" value={adminNote} onChange={e => setAdminNote(e.target.value)}
                                                            placeholder={language === "es" ? "Agregar nota..." : "Add note..."}
                                                            className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-xs" />
                                                        <button onClick={() => addAdminNoteToRequest(req.id)}
                                                            className="bg-blue-500 text-white text-xs font-bold px-2 py-1.5 rounded">💬</button>
                                                    </div>

                                                    {/* Status buttons */}
                                                    <div className="flex gap-1.5">
                                                        {req.status !== "in-progress" && (
                                                            <button onClick={() => updateRequestStatus(req.id, "in-progress")}
                                                                className="flex-1 py-1.5 bg-blue-500 text-white rounded text-xs font-bold">
                                                                {language === "es" ? "En Progreso" : "In Progress"}
                                                            </button>
                                                        )}
                                                        {req.status !== "completed" && (
                                                            <button onClick={() => updateRequestStatus(req.id, "completed")}
                                                                className="flex-1 py-1.5 bg-green-600 text-white rounded text-xs font-bold">
                                                                {language === "es" ? "Completado" : "Done"}
                                                            </button>
                                                        )}
                                                        {req.status !== "declined" && req.status !== "completed" && (
                                                            <button onClick={() => updateRequestStatus(req.id, "declined")}
                                                                className="flex-1 py-1.5 bg-red-500 text-white rounded text-xs font-bold">
                                                                {language === "es" ? "Rechazar" : "Decline"}
                                                            </button>
                                                        )}
                                                        {(req.status === "completed" || req.status === "declined") && (
                                                            <button onClick={() => updateRequestStatus(req.id, "open")}
                                                                className="flex-1 py-1.5 bg-yellow-500 text-white rounded text-xs font-bold">
                                                                {language === "es" ? "Reabrir" : "Reopen"}
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}</div>}
                            </div>
                        )}
                    </div>

                    {/* ── STAFF LIST (collapsible) ── */}
                    <div className="mb-6">
                        <button onClick={() => setStaffExpanded(!staffExpanded)}
                            className="w-full flex items-center justify-between bg-blue-50 border-2 border-blue-200 rounded-xl p-4 hover:bg-blue-100 transition">
                            <div className="flex items-center gap-2">
                                <span className="text-2xl">👥</span>
                                <div className="text-left">
                                    <h3 className="font-bold text-blue-700">{language === "es" ? "Personal" : "Staff"}</h3>
                                    <p className="text-xs text-blue-500">{filteredStaff.length} {language === "es" ? "empleados" : "members"}</p>
                                </div>
                            </div>
                            <span className="text-gray-400 text-xl">{staffExpanded ? "▼" : "▶"}</span>
                        </button>

                        {staffExpanded && (
                            <div className="mt-2">
                                <div className="flex gap-1 justify-center mb-3 flex-wrap">
                                    {[{k:"all",en:"All",es:"Todos"},{k:"webster",en:"Webster",es:"Webster"},{k:"maryland",en:"MD Heights",es:"MD Heights"}].map(f => (
                                        <button key={f.k} onClick={() => setStaffFilter(f.k)}
                                            className={`px-3 py-1 rounded-full text-xs font-bold border transition ${staffFilter === f.k ? "bg-blue-600 text-white border-blue-600" : "bg-white text-blue-600 border-blue-300 hover:bg-blue-50"}`}>
                                            {language === "es" ? f.es : f.en}
                                            {f.k !== "all" && <span className="ml-1 opacity-70">({staffList.filter(s => s.location === f.k || s.location === "both").length})</span>}
                                        </button>
                                    ))}
                                    <button onClick={() => setShowBulkTag(true)}
                                        className="px-3 py-1 rounded-full text-xs font-bold border bg-purple-600 text-white border-purple-600 hover:bg-purple-700 transition ml-2">
                                        🏷 {language === "es" ? "Etiquetar en lote" : "Bulk Tag"}
                                    </button>
                                </div>
                                <div className="space-y-2 mb-4 md:space-y-0 md:grid md:grid-cols-2 md:gap-2">
                                    {filteredStaff.map(person => (
                                        <div key={person.id} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                                            {editingId === person.id ? (
                                                <div className="p-3 bg-blue-50 space-y-2">
                                                    <p className="font-bold text-gray-800">{person.name}</p>
                                                    <div>
                                                        <label className="text-xs text-gray-600 font-semibold">{t("staffRole", language)}</label>
                                                        <select value={editRole} onChange={(e) => setEditRole(e.target.value)}
                                                            className="w-full px-2 py-2 border-2 border-gray-300 rounded-lg focus:border-mint-700 focus:outline-none text-sm">
                                                            {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
                                                        </select>
                                                    </div>
                                                    <div>
                                                        <label className="text-xs text-gray-600 font-semibold">{language === "es" ? "Ubicación" : "Location"}</label>
                                                        <select value={editLocation} onChange={(e) => setEditLocation(e.target.value)}
                                                            className="w-full px-2 py-2 border-2 border-gray-300 rounded-lg focus:border-mint-700 focus:outline-none text-sm">
                                                            <option value="webster">Webster</option>
                                                            <option value="maryland">Maryland Heights</option>
                                                            <option value="both">Both Locations</option>
                                                        </select>
                                                    </div>
                                                    <div>
                                                        <label className="text-xs text-gray-600 font-semibold">{t("newPIN", language)}</label>
                                                        <input type="text" inputMode="numeric" maxLength={4} value={editPin}
                                                            onChange={(e) => setEditPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                                                            placeholder="0000"
                                                            className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg text-center text-2xl tracking-widest font-mono focus:border-mint-700 focus:outline-none" />
                                                    </div>
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Acceso a Operaciones" : "Daily Ops Access"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "Desbloquear sin contrase\u00F1a" : "Unlock without password"}</p>
                                                        </div>
                                                        <button onClick={() => setEditOpsAccess(!editOpsAccess)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editOpsAccess ? "bg-green-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editOpsAccess ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Acceso a Recetas" : "Recipes Access"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "Ver y gestionar recetas" : "View and manage recipes"}</p>
                                                        </div>
                                                        <button onClick={() => setEditRecipesAccess(!editRecipesAccess)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editRecipesAccess ? "bg-green-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editRecipesAccess ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Líder de Turno" : "Shift Lead"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "Acceso a entrenamientos y SOPs de líder" : "Access to Lead-tier training & SOPs"}</p>
                                                        </div>
                                                        <button onClick={() => setEditShiftLead(!editShiftLead)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editShiftLead ? "bg-green-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editShiftLead ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Menor de edad (<18)" : "Minor (under 18)"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "El programador advierte sobre límites de horas/horario" : "Scheduler warns on hour/time limits"}</p>
                                                        </div>
                                                        <button onClick={() => setEditIsMinor(!editIsMinor)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editIsMinor ? "bg-amber-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editIsMinor ? "translate-x-7" : "translate-x-1"}`} />
                                                        </button>
                                                    </div>
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">{language === "es" ? "Horario" : "Schedule Side"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">{language === "es" ? "En cuál horario aparece esta persona" : "Which schedule this person appears on"}</p>
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <button onClick={() => setEditScheduleSide("foh")}
                                                                className={`py-2 rounded-md text-xs font-bold ${editScheduleSide === "foh" ? "bg-teal-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                FOH
                                                            </button>
                                                            <button onClick={() => setEditScheduleSide("boh")}
                                                                className={`py-2 rounded-md text-xs font-bold ${editScheduleSide === "boh" ? "bg-orange-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                BOH
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">{language === "es" ? "Horas semanales objetivo" : "Target Hours / Week"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">{language === "es" ? "Usado por el auto-populador. 0 = sin objetivo." : "Used by auto-fill. 0 = no target."}</p>
                                                        <input type="number" min="0" max="80" step="1"
                                                            value={editTargetHours} onChange={e => setEditTargetHours(e.target.value)}
                                                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                                                    </div>
                                                    {/* Designated-scheduler toggles. ONLY the people you turn on here can
                                                        edit / publish the schedule for that side. Everyone else can still
                                                        view, offer up shifts, take shifts, and request PTO. */}
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">📅 {language === "es" ? "Editor de horario" : "Schedule Editor"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">
                                                            {language === "es"
                                                                ? "Solo los activados aquí pueden crear/editar/publicar turnos. Admin (Andrew/Julie) siempre puede."
                                                                : "Only people toggled on here can create/edit/publish shifts. Admin (Andrew/Julie) always can."}
                                                        </p>
                                                        <div className="flex items-center justify-between mb-2">
                                                            <span className="text-xs font-bold text-teal-700">FOH {language === "es" ? "editor" : "editor"}</span>
                                                            <button onClick={() => setEditCanEditScheduleFOH(!editCanEditScheduleFOH)}
                                                                className={`w-12 h-6 rounded-full relative transition ${editCanEditScheduleFOH ? "bg-teal-600" : "bg-gray-300"}`}>
                                                                <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition ${editCanEditScheduleFOH ? "translate-x-6" : "translate-x-0.5"}`} />
                                                            </button>
                                                        </div>
                                                        <div className="flex items-center justify-between">
                                                            <span className="text-xs font-bold text-orange-700">BOH {language === "es" ? "editor" : "editor"}</span>
                                                            <button onClick={() => setEditCanEditScheduleBOH(!editCanEditScheduleBOH)}
                                                                className={`w-12 h-6 rounded-full relative transition ${editCanEditScheduleBOH ? "bg-orange-600" : "bg-gray-300"}`}>
                                                                <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition ${editCanEditScheduleBOH ? "translate-x-6" : "translate-x-0.5"}`} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <button onClick={() => setAvailabilityForId(person.id)}
                                                        className="w-full py-2 rounded-lg bg-purple-100 text-purple-700 text-xs font-bold hover:bg-purple-200">
                                                        🗓 {language === "es" ? "Editar disponibilidad" : "Edit Availability"}
                                                    </button>
                                                    <div className="flex gap-2">
                                                        <button onClick={() => handleSavePin(person.id)}
                                                            disabled={editPin.length !== 4}
                                                            className={`flex-1 py-2 rounded-lg font-bold text-white transition ${editPin.length === 4 ? "bg-green-700 hover:bg-green-800" : "bg-gray-300 cursor-not-allowed"}`}>
                                                            {t("save", language)}
                                                        </button>
                                                        <button onClick={() => { setEditingId(null); setEditPin(""); setEditRole(""); setEditLocation(""); setEditOpsAccess(false); setEditRecipesAccess(false); setEditShiftLead(false); setEditIsMinor(false); setEditScheduleSide("foh"); setEditTargetHours(0); setEditCanEditScheduleFOH(false); setEditCanEditScheduleBOH(false); }}
                                                            className="flex-1 py-2 rounded-lg font-bold bg-gray-500 text-white hover:bg-gray-600 transition">
                                                            {t("cancel", language)}
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="p-3 flex items-center justify-between">
                                                    <div>
                                                        <p className="font-bold text-gray-800">{person.name}</p>
                                                        <p className="text-xs text-gray-500">{person.role} • {LOCATION_LABELS[person.location] || "Webster"} • PIN: {person.pin}{person.opsAccess ? " • \u{1F4CB} Ops" : ""}{person.recipesAccess ? " • \u{1F9D1}\u{200D}\u{1F373} Recipes" : ""}{person.shiftLead ? " • \u{1F6E1}\u{FE0F} Lead" : ""}{person.isMinor ? " • \u{1F511} Minor" : ""} • {(person.scheduleSide || "foh").toUpperCase()}{person.targetHours ? ` • ${person.targetHours}h` : ""}</p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <button onClick={() => { setEditingId(person.id); setEditPin(person.pin); setEditRole(person.role); setEditLocation(person.location || "webster"); setEditOpsAccess(!!person.opsAccess); setEditRecipesAccess(person.recipesAccess !== false); setEditShiftLead(!!person.shiftLead); setEditIsMinor(!!person.isMinor); setEditScheduleSide(person.scheduleSide || "foh"); setEditTargetHours(person.targetHours || 0); setEditCanEditScheduleFOH(!!person.canEditScheduleFOH); setEditCanEditScheduleBOH(!!person.canEditScheduleBOH); }}
                                                            className="px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold hover:bg-blue-200 transition">
                                                            ✏️ {t("changePIN", language)}
                                                        </button>
                                                        {!ADMIN_IDS.includes(person.id) && (
                                                            confirmRemoveId === person.id ? (
                                                                <div className="flex gap-1">
                                                                    <button onClick={() => handleRemoveStaff(person.id)}
                                                                        className="px-2 py-1.5 bg-red-600 text-white rounded-lg text-xs font-bold hover:bg-red-700">✓</button>
                                                                    <button onClick={() => setConfirmRemoveId(null)}
                                                                        className="px-2 py-1.5 bg-gray-400 text-white rounded-lg text-xs font-bold hover:bg-gray-500">✕</button>
                                                                </div>
                                                            ) : (
                                                                <button onClick={() => setConfirmRemoveId(person.id)}
                                                                    className="px-2 py-1.5 bg-mint-100 text-mint-700 rounded-lg text-xs font-bold hover:bg-mint-200 transition">
                                                                    🗑️
                                                                </button>
                                                            )
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>

                                {showAdd ? (
                                    <div className="bg-green-50 border-2 border-green-300 rounded-lg p-4 space-y-3">
                                        <h3 className="font-bold text-green-800">{t("addStaff", language)}</h3>
                                        <div>
                                            <label className="text-xs text-gray-600 font-semibold">{t("staffName", language)}</label>
                                            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                                                placeholder={language === "es" ? "Nombre completo" : "Full name"}
                                                className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-green-700 focus:outline-none" />
                                        </div>
                                        <div>
                                            <label className="text-xs text-gray-600 font-semibold">{t("staffRole", language)}</label>
                                            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}
                                                className="w-full px-2 py-2 border-2 border-gray-300 rounded-lg focus:border-green-700 focus:outline-none text-sm">
                                                {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-xs text-gray-600 font-semibold">{language === "es" ? "Ubicación" : "Location"}</label>
                                            <select value={newLocation} onChange={(e) => setNewLocation(e.target.value)}
                                                className="w-full px-2 py-2 border-2 border-gray-300 rounded-lg focus:border-green-700 focus:outline-none text-sm">
                                                <option value="webster">Webster</option>
                                                <option value="maryland">Maryland Heights</option>
                                                <option value="both">Both Locations</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-xs text-gray-600 font-semibold">{t("staffPIN", language)} (4 {language === "es" ? "dígitos" : "digits"})</label>
                                            <input type="text" inputMode="numeric" maxLength={4} value={newPin}
                                                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                                                placeholder="0000"
                                                className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg text-center text-2xl tracking-widest font-mono focus:border-green-700 focus:outline-none" />
                                        </div>
                                        <div className="flex items-center justify-between bg-white rounded-lg p-3 border border-gray-200">
                                            <div>
                                                <p className="text-sm font-bold text-gray-700">{language === "es" ? "Acceso a Operaciones" : "Daily Ops Access"}</p>
                                                <p className="text-xs text-gray-500">{language === "es" ? "Desbloquear sin contrase\u00F1a" : "Unlock without password"}</p>
                                            </div>
                                            <button onClick={() => setNewOpsAccess(!newOpsAccess)}
                                                className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${newOpsAccess ? "bg-green-600" : "bg-gray-300"}`}>
                                                <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${newOpsAccess ? "translate-x-7" : "translate-x-1"}`} />
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-between bg-white rounded-lg p-3 border border-gray-200">
                                            <div>
                                                <p className="text-sm font-bold text-gray-700">{language === "es" ? "Acceso a Recetas" : "Recipes Access"}</p>
                                                <p className="text-xs text-gray-500">{language === "es" ? "Ver y gestionar recetas" : "View and manage recipes"}</p>
                                            </div>
                                            <button onClick={() => setNewRecipesAccess(!newRecipesAccess)}
                                                className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${newRecipesAccess ? "bg-green-600" : "bg-gray-300"}`}>
                                                <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${newRecipesAccess ? "translate-x-7" : "translate-x-1"}`} />
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-between bg-white rounded-lg p-3 border border-gray-200">
                                            <div>
                                                <p className="text-sm font-bold text-gray-700">{language === "es" ? "Líder de Turno" : "Shift Lead"}</p>
                                                <p className="text-xs text-gray-500">{language === "es" ? "Acceso a entrenamientos y SOPs de líder" : "Access to Lead-tier training & SOPs"}</p>
                                            </div>
                                            <button onClick={() => setNewShiftLead(!newShiftLead)}
                                                className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${newShiftLead ? "bg-green-600" : "bg-gray-300"}`}>
                                                <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${newShiftLead ? "translate-x-7" : "translate-x-1"}`} />
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-between bg-white rounded-lg p-3 border border-gray-200">
                                            <div>
                                                <p className="text-sm font-bold text-gray-700">{language === "es" ? "Menor de edad (<18)" : "Minor (under 18)"}</p>
                                                <p className="text-xs text-gray-500">{language === "es" ? "El programador advierte sobre límites de horas/horario" : "Scheduler warns on hour/time limits"}</p>
                                            </div>
                                            <button onClick={() => setNewIsMinor(!newIsMinor)}
                                                className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${newIsMinor ? "bg-amber-600" : "bg-gray-300"}`}>
                                                <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${newIsMinor ? "translate-x-7" : "translate-x-1"}`} />
                                            </button>
                                        </div>
                                        <div className="bg-white rounded-lg p-3 border border-gray-200">
                                            <p className="text-sm font-bold text-gray-700 mb-1">{language === "es" ? "Horario" : "Schedule Side"}</p>
                                            <div className="grid grid-cols-2 gap-2">
                                                <button onClick={() => setNewScheduleSide("foh")}
                                                    className={`py-2 rounded-md text-xs font-bold ${newScheduleSide === "foh" ? "bg-teal-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                    FOH
                                                </button>
                                                <button onClick={() => setNewScheduleSide("boh")}
                                                    className={`py-2 rounded-md text-xs font-bold ${newScheduleSide === "boh" ? "bg-orange-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                    BOH
                                                </button>
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            <button onClick={handleAddStaff}
                                                disabled={!newName.trim() || newPin.length !== 4}
                                                className={`flex-1 py-2 rounded-lg font-bold text-white transition ${newName.trim() && newPin.length === 4 ? "bg-green-700 hover:bg-green-800" : "bg-gray-300 cursor-not-allowed"}`}>
                                                {t("addStaff", language)}
                                            </button>
                                            <button onClick={() => { setShowAdd(false); setNewName(""); setNewRole("FOH"); setNewPin(""); setNewOpsAccess(false); setNewRecipesAccess(true); setNewShiftLead(false); setNewIsMinor(false); setNewScheduleSide("foh"); }}
                                                className="flex-1 py-2 rounded-lg font-bold bg-gray-500 text-white hover:bg-gray-600 transition">
                                                {t("cancel", language)}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <button onClick={() => setShowAdd(true)}
                                        className="w-full py-3 bg-green-700 text-white font-bold rounded-lg hover:bg-green-800 transition text-lg">
                                        + {t("addStaff", language)}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Checklist History Section */}
                    <div className="mt-8 pt-6 border-t-2 border-gray-200">
                        <h3 className="text-xl font-bold text-mint-700 mb-1">📋 {language === "es" ? "Historial de Listas" : "Checklist History"}</h3>
                        <p className="text-xs text-gray-500 mb-4">{language === "es"
                            ? "Revisa las listas de apertura y cierre de días anteriores"
                            : "Review opening and closing checklists from previous days"}</p>
                        <ChecklistHistory language={language} storeLocation={storeLocation} />
                    </div>

                    {/* Inventory History Section */}
                    <div className="mt-8 pt-6 border-t-2 border-gray-200">
                        <h3 className="text-xl font-bold text-mint-700 mb-1">📦 {language === "es" ? "Historial de Inventario" : "Inventory History"}</h3>
                        <p className="text-xs text-gray-500 mb-4">{language === "es"
                            ? "Revisa los conteos de inventario de días anteriores. Los cambios vs el día anterior se muestran en verde/rojo."
                            : "Review inventory counts from previous days. Changes vs the prior day are shown in green/red."}</p>
                        <InventoryHistory language={language} customInventory={null} storeLocation={storeLocation} />
                    </div>

                    {/* ── Availability Editor Modal ── */}
                    {availabilityForId !== null && (() => {
                        const person = staffList.find(p => p.id === availabilityForId);
                        if (!person) return null;
                        const DAYS = [
                            { k: "sun", en: "Sunday",    es: "Domingo" },
                            { k: "mon", en: "Monday",    es: "Lunes" },
                            { k: "tue", en: "Tuesday",   es: "Martes" },
                            { k: "wed", en: "Wednesday", es: "Miércoles" },
                            { k: "thu", en: "Thursday",  es: "Jueves" },
                            { k: "fri", en: "Friday",    es: "Viernes" },
                            { k: "sat", en: "Saturday",  es: "Sábado" },
                        ];
                        // availability stored as: { mon: { available: true, from: "09:00", to: "17:00" } | { available: false }, ... }
                        const avail = person.availability || {};
                        const updateDay = async (dayKey, patch) => {
                            // Functional setState — avoids clobbering a sibling
                            // edit that might land between snapshot and save.
                            // Read fresh availability from `prev` rather than
                            // closing over `avail` from the parent scope.
                            let latest = null;
                            setStaffList(prev => {
                                const me = prev.find(s => s.id === person.id);
                                const curAvail = (me && me.availability) || {};
                                const cur = curAvail[dayKey] || { available: true, from: "09:00", to: "21:00" };
                                const nextDay = { ...cur, ...patch };
                                const nextAvail = { ...curAvail, [dayKey]: nextDay };
                                latest = prev.map(s => s.id === person.id ? { ...s, availability: nextAvail } : s);
                                return latest;
                            });
                            if (latest) await saveStaffToFirestore(latest);
                        };
                        return (
                            <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
                                <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                                    <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                                        <div>
                                            <h3 className="text-lg font-bold text-purple-700">🗓 {language === "es" ? "Disponibilidad" : "Availability"}</h3>
                                            <p className="text-xs text-gray-500">{person.name}</p>
                                        </div>
                                        <button onClick={() => setAvailabilityForId(null)}
                                            className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
                                    </div>
                                    <div className="flex-1 overflow-y-auto p-3 space-y-2">
                                        <p className="text-xs text-gray-500 mb-1">{language === "es" ? "Auto-popular usa esto para asignar turnos." : "Auto-fill uses this to assign shifts."}</p>
                                        {DAYS.map(d => {
                                            const dayData = avail[d.k] || { available: true, from: "09:00", to: "21:00" };
                                            const available = dayData.available !== false;
                                            return (
                                                <div key={d.k} className="bg-gray-50 rounded-lg p-2">
                                                    <div className="flex items-center justify-between mb-1">
                                                        <span className="font-bold text-sm text-gray-800">{language === "es" ? d.es : d.en}</span>
                                                        <button onClick={() => updateDay(d.k, { available: !available })}
                                                            className={`px-3 py-1 rounded-full text-xs font-bold ${available ? "bg-green-600 text-white" : "bg-gray-300 text-gray-600"}`}>
                                                            {available ? (language === "es" ? "Disponible" : "Available") : (language === "es" ? "No disponible" : "Off")}
                                                        </button>
                                                    </div>
                                                    {available && (
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <div>
                                                                <label className="text-[10px] text-gray-500 block">{language === "es" ? "Desde" : "From"}</label>
                                                                <input type="time" value={dayData.from || "09:00"}
                                                                    onChange={e => updateDay(d.k, { from: e.target.value })}
                                                                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                                                            </div>
                                                            <div>
                                                                <label className="text-[10px] text-gray-500 block">{language === "es" ? "Hasta" : "To"}</label>
                                                                <input type="time" value={dayData.to || "21:00"}
                                                                    onChange={e => updateDay(d.k, { to: e.target.value })}
                                                                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <div className="border-t border-gray-200 p-3">
                                        <button onClick={() => setAvailabilityForId(null)}
                                            className="w-full py-2 rounded-lg bg-purple-700 text-white font-bold">{language === "es" ? "Listo" : "Done"}</button>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* ── Bulk Tag Modal — fast scheduleSide / isMinor tagging ── */}
                    {showBulkTag && (() => {
                        const search = bulkSearch.toLowerCase().trim();
                        const visible = staffList
                            .filter(s => staffFilter === "all" || s.location === staffFilter || s.location === "both")
                            .filter(s => !search || (s.name || "").toLowerCase().includes(search) || (s.role || "").toLowerCase().includes(search))
                            // Tagging-state filter (all / untagged / foh / boh)
                            .filter(s => {
                                if (bulkFilter === "all") return true;
                                if (bulkFilter === "untagged") return !s.scheduleSide;
                                if (bulkFilter === "foh") return s.scheduleSide === "foh";
                                if (bulkFilter === "boh") return s.scheduleSide === "boh";
                                return true;
                            })
                            .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
                        // Counts use the EXPLICIT field (no role inference) so the
                        // "Untagged" pill reflects the real state we're trying to fix.
                        const fohExplicit = staffList.filter(s => s.scheduleSide === "foh").length;
                        const bohExplicit = staffList.filter(s => s.scheduleSide === "boh").length;
                        const minorCount = staffList.filter(s => s.isMinor).length;
                        const untagged = staffList.filter(s => !s.scheduleSide).length;
                        const visibleIds = visible.map(s => s.id);
                        return (
                            <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
                                <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                                    <div className="border-b border-gray-200 p-4">
                                        <div className="flex items-center justify-between mb-2">
                                            <h3 className="text-lg font-bold text-purple-700">🏷 {language === "es" ? "Etiquetar Personal en Lote" : "Bulk Tag Staff"}</h3>
                                            <button onClick={() => { setShowBulkTag(false); setBulkSearch(""); }}
                                                className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
                                        </div>
                                        <p className="text-xs text-gray-500 mb-2">
                                            {language === "es"
                                                ? "Toca para alternar. Los cambios se guardan al instante."
                                                : "Tap to flip. Changes save instantly."}
                                        </p>
                                        <div className="flex flex-wrap gap-2 text-[10px] mb-2">
                                            <span className="px-2 py-0.5 rounded-full bg-teal-100 text-teal-800 font-bold">FOH: {fohExplicit}</span>
                                            <span className="px-2 py-0.5 rounded-full bg-orange-100 text-orange-800 font-bold">BOH: {bohExplicit}</span>
                                            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold">🔑 {language === "es" ? "Menores" : "Minors"}: {minorCount}</span>
                                            {untagged > 0 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-800 font-bold">⚠ {language === "es" ? "Sin etiqueta" : "Untagged"}: {untagged}</span>}
                                        </div>

                                        {/* Auto-tag — one-shot fill of every untagged staff using role inference. */}
                                        {untagged > 0 && (
                                            <button onClick={autoTagUntagged}
                                                className="w-full mb-2 py-2 rounded-lg bg-purple-600 text-white text-sm font-bold hover:bg-purple-700">
                                                ✨ {language === "es" ? `Auto-etiquetar ${untagged} pendientes (por rol)` : `Auto-tag ${untagged} untagged (from role)`}
                                            </button>
                                        )}
                                        {/* Grant Recipes to all — one-shot migration helper for the
                                            opt-OUT recipes policy. Use after first deploy of the new
                                            policy or after onboarding a batch of new hires. */}
                                        <button onClick={grantRecipesToAll}
                                            className="w-full mb-2 py-2 rounded-lg bg-green-600 text-white text-sm font-bold hover:bg-green-700">
                                            🧑‍🍳 {language === "es" ? "Dar acceso a Recetas a TODO el personal" : "Grant Recipes access to ALL staff"}
                                        </button>

                                        {/* Filter chips — narrow the list quickly */}
                                        <div className="flex gap-1 mb-2">
                                            {[
                                                { id: "all",      labelEn: `All (${staffList.length})`, labelEs: `Todos (${staffList.length})` },
                                                { id: "untagged", labelEn: `Untagged (${untagged})`,    labelEs: `Sin etiq. (${untagged})` },
                                                { id: "foh",      labelEn: `FOH (${fohExplicit})`,      labelEs: `FOH (${fohExplicit})` },
                                                { id: "boh",      labelEn: `BOH (${bohExplicit})`,      labelEs: `BOH (${bohExplicit})` },
                                            ].map(f => (
                                                <button key={f.id} onClick={() => setBulkFilter(f.id)}
                                                    className={`flex-1 py-1.5 rounded-md text-[10px] font-bold border ${
                                                        bulkFilter === f.id
                                                            ? "bg-purple-600 text-white border-purple-600"
                                                            : "bg-white text-gray-600 border-gray-300"
                                                    }`}>
                                                    {language === "es" ? f.labelEs : f.labelEn}
                                                </button>
                                            ))}
                                        </div>

                                        <input type="text" value={bulkSearch} onChange={e => setBulkSearch(e.target.value)}
                                            placeholder={language === "es" ? "Buscar nombre o rol…" : "Search name or role…"}
                                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2" />

                                        {/* Sweep-visible buttons — flip every visible staff to FOH or BOH at once.
                                            Useful after filtering: "show me all the prep staff who got tagged FOH by
                                            mistake → bulk flip them to BOH." */}
                                        {visible.length > 0 && bulkFilter !== "all" && (
                                            <div className="flex gap-1 text-[10px]">
                                                <button onClick={() => bulkSetSide(visibleIds, "foh")}
                                                    className="flex-1 py-1.5 rounded-md bg-teal-100 text-teal-800 font-bold border border-teal-300 hover:bg-teal-200">
                                                    → {language === "es" ? `Marcar ${visible.length} como FOH` : `Tag ${visible.length} as FOH`}
                                                </button>
                                                <button onClick={() => bulkSetSide(visibleIds, "boh")}
                                                    className="flex-1 py-1.5 rounded-md bg-orange-100 text-orange-800 font-bold border border-orange-300 hover:bg-orange-200">
                                                    → {language === "es" ? `Marcar ${visible.length} como BOH` : `Tag ${visible.length} as BOH`}
                                                </button>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                                        {visible.length === 0 && (
                                            <p className="text-center text-gray-400 text-sm py-8">{language === "es" ? "Sin resultados." : "No results."}</p>
                                        )}
                                        {visible.map(s => {
                                            const side = s.scheduleSide || (s.role && ["BOH","Pho","Pho Station","Grill","Fryer","Fried Rice","Dish","Bao/Tacos/Banh Mi","Spring Rolls/Prep","Prep","Kitchen Manager","Asst Kitchen Manager"].includes(s.role) ? "boh" : "foh");
                                            const explicitTagged = !!s.scheduleSide;
                                            return (
                                                <div key={s.id} className={`flex items-center gap-2 p-2 rounded-lg border ${explicitTagged ? "bg-white border-gray-200" : "bg-red-50 border-red-200"}`}>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="font-bold text-sm text-gray-800 truncate flex items-center gap-1">
                                                            {s.name}
                                                            {!explicitTagged && <span className="text-[9px] text-red-600 font-bold">⚠ {language === "es" ? "inferido" : "inferred"}</span>}
                                                        </div>
                                                        <div className="text-[10px] text-gray-500 truncate">{s.role} · {LOCATION_LABELS[s.location] || s.location}</div>
                                                    </div>
                                                    <div className="flex gap-0.5">
                                                        <button onClick={() => handleBulkUpdate(s.id, { scheduleSide: "foh" })}
                                                            className={`px-2 py-1 rounded-l text-[10px] font-bold border ${side === "foh" && explicitTagged ? "bg-teal-600 text-white border-teal-600" : side === "foh" ? "bg-teal-100 text-teal-800 border-teal-300" : "bg-white text-gray-500 border-gray-300"}`}>
                                                            FOH
                                                        </button>
                                                        <button onClick={() => handleBulkUpdate(s.id, { scheduleSide: "boh" })}
                                                            className={`px-2 py-1 rounded-r text-[10px] font-bold border-t border-r border-b ${side === "boh" && explicitTagged ? "bg-orange-600 text-white border-orange-600" : side === "boh" ? "bg-orange-100 text-orange-800 border-orange-300" : "bg-white text-gray-500 border-gray-300"}`}>
                                                            BOH
                                                        </button>
                                                    </div>
                                                    <button onClick={() => handleBulkUpdate(s.id, { isMinor: !s.isMinor })}
                                                        title={language === "es" ? "Menor de edad" : "Minor"}
                                                        className={`w-8 h-8 rounded text-sm font-bold border ${s.isMinor ? "bg-amber-500 text-white border-amber-600" : "bg-white text-gray-300 border-gray-300"}`}>
                                                        🔑
                                                    </button>
                                                    <input type="number" min="0" max="80" step="1"
                                                        value={s.targetHours || 0}
                                                        onChange={e => handleBulkUpdate(s.id, { targetHours: Number(e.target.value) || 0 })}
                                                        title={language === "es" ? "Horas/sem objetivo" : "Target hrs/week"}
                                                        className="w-12 text-center text-xs border border-gray-300 rounded py-1" />
                                                    <button onClick={() => { setShowBulkTag(false); setAvailabilityForId(s.id); }}
                                                        title={language === "es" ? "Disponibilidad" : "Availability"}
                                                        className="w-8 h-8 rounded text-sm border bg-white text-purple-600 border-purple-300 hover:bg-purple-50">
                                                        🗓
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    <div className="border-t border-gray-200 p-3">
                                        <button onClick={() => { setShowBulkTag(false); setBulkSearch(""); }}
                                            className="w-full py-2 rounded-lg bg-purple-700 text-white font-bold">{language === "es" ? "Listo" : "Done"}</button>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}
                </div>
            );
        }

        // Catering Menu Data — proteinOptions = single pick from list; hasProteins+proteinCount = multi pick
        const CATERING_MENU = [
            {
                category: "Finger Food",
                categoryEs: "Bocadillos",
                emoji: "🥟",
                items: [
                    {
                        name: "Crab Rangoons",
                        nameEs: "Crab Rangoons",
                        sizes: [
                            { label: "15 PCS", price: 23.99 },
                            { label: "30 PCS", price: 43.99 },
                            { label: "60 PCS", price: 84.99 }
                        ],
                        note: "Served w/ Sweet Chili Sauce",
                        noteEs: "Servido con Salsa de Chile Dulce",
                        hasSauces: false,
                        hasProteins: false
                    },
                    {
                        name: "Vietnamese/Vegetarian Egg Rolls",
                        nameEs: "Rollos de Huevo Vietnamitas/Vegetarianos",
                        sizes: [
                            { label: "20 Halves", price: 27.99 },
                            { label: "40 Halves", price: 41.99 },
                            { label: "60 Halves", price: 53.90 }
                        ],
                        typeOptions: ["Vietnamese", "Vegetarian"],
                        typeOptionsEs: ["Vietnamitas", "Vegetarianos"],
                        singleSauceOptions: ["Vietnamese Vinaigrette", "Sweet Chili"],
                        singleSauceOptionsEs: ["Vinagreta Vietnamita", "Chile Dulce"],
                        hasSauces: false,
                        hasProteins: false
                    },
                    {
                        name: "Spring Rolls",
                        nameEs: "Rollos de Primavera",
                        sizes: [
                            { label: "16 PCS", price: 92.99, sauceCount: 2, proteinCount: 2 },
                            { label: "32 PCS", price: 177.99, sauceCount: 3, proteinCount: 3 },
                            { label: "48 PCS", price: 246.99, sauceCount: 4, proteinCount: 4 }
                        ],
                        hasSauces: true,
                        hasProteins: true
                    },
                    {
                        name: "Bao Sliders",
                        nameEs: "Mini Baos",
                        sizes: [
                            { label: "12 PCS", price: 77.99, sauceCount: 2, proteinCount: 2 },
                            { label: "24 PCS", price: 130.99, sauceCount: 3, proteinCount: 3 },
                            { label: "36 PCS", price: 192.99, sauceCount: 4, proteinCount: 4 }
                        ],
                        hasSauces: true,
                        hasProteins: true
                    },
                    {
                        name: "Banh Mi",
                        nameEs: "Bánh Mì",
                        sizes: [
                            { label: "12 PCS", price: 77.99, sauceCount: 2, proteinCount: 2 },
                            { label: "24 PCS", price: 154.99, sauceCount: 3, proteinCount: 3 },
                            { label: "36 PCS", price: 223.99, sauceCount: 4, proteinCount: 4 }
                        ],
                        hasSauces: true,
                        hasProteins: true
                    }
                ]
            },
            {
                category: "Fork & Knife Trays",
                categoryEs: "Bandejas con Cubiertos",
                emoji: "🍴",
                items: [
                    {
                        name: "Tray — Chicken, Pork, or Tofu",
                        nameEs: "Bandeja — Pollo, Puerco o Tofu",
                        sizes: [
                            { label: "Serves 6-8", price: 146.99 },
                            { label: "Serves 10-12", price: 223.99 }
                        ],
                        proteinOptions: ["Chicken", "Pork", "Tofu"],
                        proteinOptionsEs: ["Pollo", "Puerco", "Tofu"],
                        hasBase: true,
                        hasSauces: true,
                        sauceCount: 3,
                        hasProteins: false,
                        hasUtensils: true
                    },
                    {
                        name: "Tray — Steak, Shrimp, Veggie, or Vegan Beef",
                        nameEs: "Bandeja — Res, Camarón, Vegetal o Res Vegana",
                        sizes: [
                            { label: "Serves 6-8", price: 161.99 },
                            { label: "Serves 10-12", price: 246.99 }
                        ],
                        proteinOptions: ["Steak", "Shrimp", "Veggie", "Vegan Beef"],
                        proteinOptionsEs: ["Res", "Camarón", "Vegetal", "Res Vegana"],
                        hasBase: true,
                        hasSauces: true,
                        sauceCount: 3,
                        hasProteins: false,
                        hasUtensils: true
                    }
                ]
            },
            {
                category: "Mini Bowls",
                categoryEs: "Mini Tazones",
                emoji: "🥢",
                items: [
                    {
                        name: "Mini Bowls — Chicken, Pork, or Tofu",
                        nameEs: "Mini Tazones — Pollo, Puerco o Tofu",
                        sizes: [
                            { label: "10 Bowls", price: 130.99 },
                            { label: "20 Bowls", price: 254.99 }
                        ],
                        proteinOptions: ["Chicken", "Pork", "Tofu"],
                        proteinOptionsEs: ["Pollo", "Puerco", "Tofu"],
                        hasBase: true,
                        hasSauces: true,
                        sauceCount: 3,
                        hasProteins: false,
                        hasUtensils: true
                    },
                    {
                        name: "Mini Bowls — Steak, Shrimp, Veggie, or Vegan Beef",
                        nameEs: "Mini Tazones — Res, Camarón, Vegetal o Res Vegana",
                        sizes: [
                            { label: "10 Bowls", price: 146.99 },
                            { label: "20 Bowls", price: 284.99 }
                        ],
                        proteinOptions: ["Steak", "Shrimp", "Veggie", "Vegan Beef"],
                        proteinOptionsEs: ["Res", "Camarón", "Vegetal", "Res Vegana"],
                        hasBase: true,
                        hasSauces: true,
                        sauceCount: 3,
                        hasProteins: false,
                        hasUtensils: true
                    }
                ]
            },
            {
                category: "Fried Rice Trays",
                categoryEs: "Bandejas de Arroz Frito",
                emoji: "🍚",
                items: [
                    {
                        name: "Fried Rice — Plain",
                        nameEs: "Arroz Frito — Solo",
                        sizes: [
                            { label: "Serves 6-8", price: 61.99 },
                            { label: "Serves 10-12", price: 107.99 }
                        ],
                        note: "Eggs, Scallions, and White Onions",
                        noteEs: "Huevos, Cebollín y Cebolla Blanca",
                        hasSauces: false,
                        hasProteins: false,
                        hasUtensils: true
                    },
                    {
                        name: "Fried Rice — Chicken, Pork, or Tofu",
                        nameEs: "Arroz Frito — Pollo, Puerco o Tofu",
                        sizes: [
                            { label: "Serves 6-8", price: 77.99 },
                            { label: "Serves 10-12", price: 138.99 }
                        ],
                        note: "Eggs, Scallions, and White Onions",
                        noteEs: "Huevos, Cebollín y Cebolla Blanca",
                        proteinOptions: ["Chicken", "Pork", "Tofu"],
                        proteinOptionsEs: ["Pollo", "Puerco", "Tofu"],
                        hasSauces: false,
                        hasProteins: false,
                        hasUtensils: true
                    },
                    {
                        name: "Fried Rice — Steak, Shrimp, Veggie, or Vegan Beef",
                        nameEs: "Arroz Frito — Res, Camarón, Vegetal o Res Vegana",
                        sizes: [
                            { label: "Serves 6-8", price: 92.99 },
                            { label: "Serves 10-12", price: 169.99 }
                        ],
                        note: "Eggs, Scallions, and White Onions",
                        noteEs: "Huevos, Cebollín y Cebolla Blanca",
                        proteinOptions: ["Steak", "Shrimp", "Veggie", "Vegan Beef"],
                        proteinOptionsEs: ["Res", "Camarón", "Vegetal", "Res Vegana"],
                        hasSauces: false,
                        hasProteins: false,
                        hasUtensils: true
                    }
                ]
            },
            {
                category: "DD Mau Sampler",
                categoryEs: "Muestra DD Mau",
                emoji: "🎉",
                items: [
                    {
                        name: "DD Mau Sampler",
                        nameEs: "Muestra DD Mau",
                        sizes: [
                            { label: "Serves 4-6", price: 154.99 }
                        ],
                        note: "6 Banh Mi Bites, 4 Mini Vermicelli Bowls, 8 Rice Paper Roll Halves, 10 Egg Roll Halves. Cutlery & napkins included.",
                        noteEs: "6 Banh Mi, 4 Mini Tazones de Fideos, 8 Mitades de Rollos de Arroz, 10 Mitades de Rollos de Huevo. Cubiertos y servilletas incluidos.",
                        hasSauces: true,
                        sauceCount: 2,
                        hasProteins: false, 
                        isSampler: true,
                        samplerPicks: [
                            { name: "Banh Mi Bites (6 pcs)", nameEs: "Banh Mi (6 pzas)", count: 3 },
                            { name: "Mini Vermicelli Bowls (4)", nameEs: "Mini Tazones de Fideos (4)", count: 2 },
                            { name: "Rice Paper Rolls (8 halves)", nameEs: "Rollos de Arroz (8 mitades)", count: 2 }
                        ],
                        samplerEggRollType: true
                    }
                ]
            }
        ];

        const ALL_SAUCES = ["Vietnamese Vinaigrette", "Peanut", "Hoisin", "Sweet Chili", "DD", "Spicy DD"];
        const ALL_SAUCES_ES = ["Vinagreta Vietnamita", "Cacahuate", "Hoisin", "Chile Dulce", "DD", "DD Picante"];
        const ALL_PROTEINS = ["Steak", "Shrimp", "Chicken", "Pork", "Tofu"];
        const ALL_PROTEINS_ES = ["Res", "Camarón", "Pollo", "Puerco", "Tofu"];
        const BASE_OPTIONS = ["Vermicelli", "Salad", "Rice"];
        const BASE_OPTIONS_ES = ["Fideos", "Ensalada", "Arroz"];

        // Catering Order Component
