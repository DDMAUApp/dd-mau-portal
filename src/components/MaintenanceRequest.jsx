import { useState, useEffect } from 'react';
import { db, storage } from '../firebase';
import { doc, collection, query, orderBy, limit, onSnapshot, setDoc, deleteDoc, getDoc, addDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { t } from '../data/translations';
import { toast } from '../toast';

export default function MaintenanceRequest({ language, staffName, storeLocation }) {
            const [description, setDescription] = useState("");
            const [location, setLocation] = useState("");
            const [urgency, setUrgency] = useState("normal");
            const [reason, setReason] = useState("");
            const [photoFile, setPhotoFile] = useState(null);
            const [photoPreview, setPhotoPreview] = useState(null);
            const [submitting, setSubmitting] = useState(false);
            const [submitted, setSubmitted] = useState(false);
            const [myRequests, setMyRequests] = useState([]);

            const locationOptions = [
                { en: "Kitchen — Line", es: "Cocina — Línea" },
                { en: "Kitchen — Prep Area", es: "Cocina — Área de Prep" },
                { en: "Kitchen — Walk-in", es: "Cocina — Walk-in" },
                { en: "Kitchen — Dish Pit", es: "Cocina — Lavaplatos" },
                { en: "Dining Room", es: "Comedor" },
                { en: "Restroom", es: "Baño" },
                { en: "Bar Area", es: "Área de Bar" },
                { en: "Front Entrance", es: "Entrada Principal" },
                { en: "Back of House — Office", es: "Trastienda — Oficina" },
                { en: "Back of House — Storage", es: "Trastienda — Almacén" },
                { en: "Exterior / Parking", es: "Exterior / Estacionamiento" },
                { en: "Other", es: "Otro" }
            ];

            // Load this person's recent requests
            useEffect(() => {
                const q = query(
                    collection(db, "maintenanceRequests"),
                    orderBy("createdAt", "desc"),
                    limit(50)
                );
                const unsub = onSnapshot(q, (snap) => {
                    const reqs = [];
                    snap.forEach(doc => {
                        const d = doc.data();
                        if (d.submittedBy === staffName) reqs.push({ id: doc.id, ...d });
                    });
                    setMyRequests(reqs.slice(0, 10));
                }, (err) => { console.error("Error loading requests:", err); });
                return () => unsub();
            }, [staffName]);

            const handlePhotoSelect = (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setPhotoFile(file);
                const reader = new FileReader();
                reader.onload = (ev) => setPhotoPreview(ev.target.result);
                reader.readAsDataURL(file);
            };

            const handleSubmit = async () => {
                if (!description.trim() || !location) return;
                setSubmitting(true);
                // FIX (2026-05-14): orphan-photo cleanup. If the Firestore
                // addDoc throws AFTER the Storage upload succeeded, the
                // file persists forever with no DB reference — same
                // class of bug fixed earlier in Operations.jsx photo
                // capture. Track the photoRef so we can delete it on
                // failure.
                let photoRef = null;
                let photoUploaded = false;
                try {
                    let photoUrl = null;
                    if (photoFile) {
                        const photoPath = "maintenance-photos/" + Date.now() + "_" + photoFile.name;
                        photoRef = ref(storage, photoPath);
                        await uploadBytes(photoRef, photoFile);
                        photoUploaded = true;
                        photoUrl = await getDownloadURL(photoRef);
                    }
                    const now = new Date();
                    await addDoc(collection(db, "maintenanceRequests"), {
                        description: description.trim(),
                        location,
                        urgency,
                        reason: reason.trim(),
                        photoUrl,
                        submittedBy: staffName,
                        storeBranch: storeLocation,
                        createdAt: now.toISOString(),
                        date: now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0"),
                        status: "open"
                    });
                    setDescription("");
                    setLocation("");
                    setUrgency("normal");
                    setReason("");
                    setPhotoFile(null);
                    setPhotoPreview(null);
                    setSubmitted(true);
                    setTimeout(() => setSubmitted(false), 3000);
                } catch (err) {
                    console.error("Error submitting request:", err);
                    // Clean up the orphaned photo if the Firestore write
                    // failed after the upload succeeded.
                    if (photoUploaded && photoRef) {
                        try { await deleteObject(photoRef); }
                        catch (cleanupErr) { console.warn("Maintenance photo orphan cleanup failed:", cleanupErr); }
                    }
                    toast(language === "es" ? "Error al enviar solicitud" : "Error submitting request");
                }
                setSubmitting(false);
            };

            const statusColors = { open: "bg-yellow-100 text-yellow-700", "in-progress": "bg-blue-100 text-blue-700", completed: "bg-green-100 text-green-700", declined: "bg-red-100 text-red-700" };
            const statusLabels = { open: language === "es" ? "Abierto" : "Open", "in-progress": language === "es" ? "En Progreso" : "In Progress", completed: language === "es" ? "Completado" : "Completed", declined: language === "es" ? "Rechazado" : "Declined" };

            return (
                <div className="p-4 pb-bottom-nav">
                    <h2 className="text-2xl font-bold text-mint-700 mb-2">🔧 {language === "es" ? "Solicitud de Mantenimiento" : "Maintenance Request"}</h2>
                    <p className="text-xs text-gray-500 mb-4">{language === "es" ? "Reporta cualquier problema o reparación necesaria" : "Report any issue or repair needed"}</p>

                    {submitted && (
                        <div className="mb-4 p-3 bg-green-100 border border-green-300 rounded-lg text-center text-green-700 font-bold text-sm">
                            ✅ {language === "es" ? "¡Solicitud enviada!" : "Request submitted!"}
                        </div>
                    )}

                    <div className="bg-white rounded-xl border-2 border-gray-200 p-4 space-y-4 mb-6">
                        {/* What — description */}
                        <div>
                            <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                                {language === "es" ? "¿Qué necesita arreglo?" : "What needs fixing?"} *
                            </label>
                            <textarea value={description} onChange={e => setDescription(e.target.value)}
                                rows={3} placeholder={language === "es" ? "Describe el problema..." : "Describe the issue..."}
                                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none" />
                        </div>

                        {/* Where — location */}
                        <div>
                            <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                                {language === "es" ? "¿Dónde?" : "Where?"} *
                            </label>
                            <select value={location} onChange={e => setLocation(e.target.value)}
                                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none">
                                <option value="">{language === "es" ? "Selecciona ubicación..." : "Select location..."}</option>
                                {locationOptions.map(loc => (
                                    <option key={loc.en} value={loc.en}>{language === "es" ? loc.es : loc.en}</option>
                                ))}
                            </select>
                        </div>

                        {/* Urgency */}
                        <div>
                            <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                                {language === "es" ? "Urgencia" : "Urgency"}
                            </label>
                            <div className="flex gap-2">
                                {[
                                    { val: "low", en: "Low", es: "Baja", color: "bg-gray-100 text-gray-700 border-gray-300", active: "bg-gray-700 text-white border-gray-700" },
                                    { val: "normal", en: "Normal", es: "Normal", color: "bg-yellow-50 text-yellow-700 border-yellow-300", active: "bg-yellow-600 text-white border-yellow-600" },
                                    { val: "high", en: "High", es: "Alta", color: "bg-orange-50 text-orange-700 border-orange-300", active: "bg-orange-600 text-white border-orange-600" },
                                    { val: "urgent", en: "Urgent", es: "Urgente", color: "bg-red-50 text-red-700 border-red-300", active: "bg-red-600 text-white border-red-600" }
                                ].map(u => (
                                    <button key={u.val} onClick={() => setUrgency(u.val)}
                                        className={`flex-1 py-2 rounded-lg text-xs font-bold border-2 transition ${urgency === u.val ? u.active : u.color}`}>
                                        {language === "es" ? u.es : u.en}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Why */}
                        <div>
                            <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                                {language === "es" ? "¿Por qué es importante? (opcional)" : "Why is this important? (optional)"}
                            </label>
                            <input type="text" value={reason} onChange={e => setReason(e.target.value)}
                                placeholder={language === "es" ? "Riesgo de seguridad, afecta servicio, etc." : "Safety risk, affects service, etc."}
                                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm focus:border-mint-500 focus:outline-none" />
                        </div>

                        {/* Photo */}
                        <div>
                            <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                                {language === "es" ? "📷 Foto (opcional)" : "📷 Photo (optional)"}
                            </label>
                            {photoPreview ? (
                                <div className="relative">
                                    <img src={photoPreview} alt="Preview" className="rounded-lg border border-gray-200 max-w-full" style={{maxHeight: "200px"}} />
                                    <button onClick={() => { setPhotoFile(null); setPhotoPreview(null); }}
                                        className="absolute top-1 right-1 bg-red-500 text-white rounded-full w-6 h-6 text-xs font-bold">✕</button>
                                </div>
                            ) : (
                                <label className="block w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-center text-sm text-gray-500 cursor-pointer hover:border-mint-400 hover:text-mint-600 transition">
                                    📷 {language === "es" ? "Toca para tomar foto" : "Tap to take photo"}
                                    <input type="file" accept="image/*" capture="environment" onChange={handlePhotoSelect} className="hidden" />
                                </label>
                            )}
                        </div>

                        {/* Submit */}
                        <button onClick={handleSubmit}
                            disabled={submitting || !description.trim() || !location}
                            className={`w-full py-3 rounded-lg font-bold text-white text-lg transition ${
                                submitting || !description.trim() || !location ? "bg-gray-300 cursor-not-allowed" : "bg-mint-700 hover:bg-mint-800"}`}>
                            {submitting ? (language === "es" ? "Enviando..." : "Submitting...") : (language === "es" ? "📩 Enviar Solicitud" : "📩 Submit Request")}
                        </button>
                    </div>

                    {/* My recent requests */}
                    {myRequests.length > 0 && (
                        <div>
                            <h3 className="text-lg font-bold text-gray-700 mb-2">{language === "es" ? "Mis Solicitudes Recientes" : "My Recent Requests"}</h3>
                            <div className="space-y-2">
                                {myRequests.map(req => (
                                    <div key={req.id} className="bg-white rounded-lg border border-gray-200 p-3">
                                        <div className="flex items-start justify-between mb-1">
                                            <p className="text-sm font-bold text-gray-800 flex-1">{req.description}</p>
                                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ml-2 whitespace-nowrap ${statusColors[req.status] || "bg-gray-100 text-gray-600"}`}>
                                                {statusLabels[req.status] || req.status}
                                            </span>
                                        </div>
                                        <p className="text-xs text-gray-500">📍 {req.location} • {new Date(req.createdAt).toLocaleDateString()}</p>
                                        {req.adminNote && <p className="text-xs text-blue-600 mt-1">💬 {req.adminNote}</p>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            );
        }

