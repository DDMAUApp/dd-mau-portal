import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, collection, onSnapshot, setDoc, getDoc, getDocs, updateDoc, query, orderBy, limit } from 'firebase/firestore';
import { t } from '../data/translations';
import { isAdmin, LOCATION_LABELS } from '../data/staff'; 

import InventoryHistory from './InventoryHistory';

export default function AdminPanel({ language, staffList, setStaffList, storeLocation }) {
            const [editingId, setEditingId] = useState(null);
            const [editPin, setEditPin] = useState("");
            const [editRole, setEditRole] = useState("");
            const [editOpsAccess, setEditOpsAccess] = useState(false);
            const [showAdd, setShowAdd] = useState(false);
            const [newName, setNewName] = useState("");
            const [newRole, setNewRole] = useState("FOH");
            const [newPin, setNewPin] = useState("");
            const [newLocation, setNewLocation] = useState(storeLocation || "webster");
            const [newOpsAccess, setNewOpsAccess] = useState(false);
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

            const handleSavePin = async (id) => {
                if (editPin.length !== 4 || !/^\d{4}$/.test(editPin)) return;
                const updated = staffList.map(s => s.id === id ? { ...s, pin: editPin, role: editRole, location: editLocation || s.location || "webster", opsAccess: editOpsAccess } : s);
                setStaffList(updated);
                await saveStaffToFirestore(updated);
                setEditingId(null);
                setEditPin("");
                setEditRole("");
                setEditLocation("");
                setEditOpsAccess(false);
                showSaved();
            };

            const handleAddStaff = async () => {
                if (!newName.trim() || newPin.length !== 4 || !/^\d{4}$/.test(newPin)) return;
                const maxId = Math.max(...staffList.map(s => s.id), 0);
                const newStaff = { id: maxId + 1, name: newName.trim(), role: newRole, pin: newPin, location: newLocation, opsAccess: newOpsAccess };
                const updated = [...staffList, newStaff];
                setStaffList(updated);
                await saveStaffToFirestore(updated);
                setShowAdd(false);
                setNewName("");
                setNewRole("FOH");
                setNewPin("");
                setNewLocation(storeLocation || "webster");
                setNewOpsAccess(false);
                showSaved();
            };

            const handleRemoveStaff = async (id) => {
                const person = staffList.find(s => s.id === id);
                if (isAdmin(person?.name)) return; // can't remove admins
                const updated = staffList.filter(s => s.id !== id);
                setStaffList(updated);
                await saveStaffToFirestore(updated);
                setConfirmRemoveId(null);
                showSaved();
            };

            const roleOptions = ["FOH", "BOH", "Shift Lead", "Kitchen Manager", "Asst Kitchen Manager", "Manager", "Owner", "Prep", "Grill", "Fryer", "Fried Rice", "Dish", "Bao/Tacos/Banh Mi", "Spring Rolls/Prep", "Pho Station"];

            return (
                <div className="p-4 pb-24">
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
                                ) : filteredMaintenance.map(req => {
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
                                })}
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
                                <div className="flex gap-1 justify-center mb-3">
                                    {[{k:"all",en:"All",es:"Todos"},{k:"webster",en:"Webster",es:"Webster"},{k:"maryland",en:"MD Heights",es:"MD Heights"}].map(f => (
                                        <button key={f.k} onClick={() => setStaffFilter(f.k)}
                                            className={`px-3 py-1 rounded-full text-xs font-bold border transition ${staffFilter === f.k ? "bg-blue-600 text-white border-blue-600" : "bg-white text-blue-600 border-blue-300 hover:bg-blue-50"}`}>
                                            {language === "es" ? f.es : f.en}
                                            {f.k !== "all" && <span className="ml-1 opacity-70">({staffList.filter(s => s.location === f.k || s.location === "both").length})</span>}
                                        </button>
                                    ))}
                                </div>
                                <div className="space-y-2 mb-4">
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
                                                    <div className="flex gap-2">
                                                        <button onClick={() => handleSavePin(person.id)}
                                                            disabled={editPin.length !== 4}
                                                            className={`flex-1 py-2 rounded-lg font-bold text-white transition ${editPin.length === 4 ? "bg-green-700 hover:bg-green-800" : "bg-gray-300 cursor-not-allowed"}`}>
                                                            {t("save", language)}
                                                        </button>
                                                        <button onClick={() => { setEditingId(null); setEditPin(""); setEditRole(""); setEditLocation(""); setEditOpsAccess(false); }}
                                                            className="flex-1 py-2 rounded-lg font-bold bg-gray-500 text-white hover:bg-gray-600 transition">
                                                            {t("cancel", language)}
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="p-3 flex items-center justify-between">
                                                    <div>
                                                        <p className="font-bold text-gray-800">{person.name}</p>
                                                        <p className="text-xs text-gray-500">{person.role} • {LOCATION_LABELS[person.location] || "Webster"} • PIN: {person.pin}{person.opsAccess ? " • \u{1F4CB} Ops" : ""}</p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <button onClick={() => { setEditingId(person.id); setEditPin(person.pin); setEditRole(person.role); setEditLocation(person.location || "webster"); setEditOpsAccess(!!person.opsAccess); }}
                                                            className="px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold hover:bg-blue-200 transition">
                                                            ✏️ {t("changePIN", language)}
                                                        </button>
                                                        {!isAdmin(person.name) && (
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
                                        <div className="flex gap-2">
                                            <button onClick={handleAddStaff}
                                                disabled={!newName.trim() || newPin.length !== 4}
                                                className={`flex-1 py-2 rounded-lg font-bold text-white transition ${newName.trim() && newPin.length === 4 ? "bg-green-700 hover:bg-green-800" : "bg-gray-300 cursor-not-allowed"}`}>
                                                {t("addStaff", language)}
                                            </button>
                                            <button onClick={() => { setShowAdd(false); setNewName(""); setNewRole("FOH"); setNewPin(""); setNewOpsAccess(false); }}
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
