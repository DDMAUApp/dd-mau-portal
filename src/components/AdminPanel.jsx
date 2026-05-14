import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, collection, onSnapshot, setDoc, getDoc, getDocs, updateDoc, deleteDoc, writeBatch, query, orderBy, limit, where, serverTimestamp } from 'firebase/firestore';
import { t } from '../data/translations';
import { isAdmin, ADMIN_IDS, LOCATION_LABELS, HIDEABLE_PAGES } from '../data/staff';
import { getPositionTemplate, hasPositionTemplate } from '../data/positionTemplates';
import ChecklistHistory from './ChecklistHistory';
import InventoryHistory from './InventoryHistory';
import { toast, undoToast } from '../toast';
import { enableFcmPush } from '../messaging';

// Wrapper enforces admin-only access BEFORE the inner component's hooks run.
// Early-returning inside AdminPanelInner would violate React's rules-of-hooks
// (hooks must run in the same order every render). This wrapper-pattern is the
// idiomatic fix.

// AccessToggle — bulk-edit per-staff "what can this person SEE" pill.
// Designed for the redesigned bulk edit cards: shows a clear icon + label,
// big enough to be tappable on a phone, with on/off state read at a glance
// (mint pill = ON, ghost-grey strikethrough = OFF). Replaces the old 8x8
// icon-only buttons that had no labels.
function AccessToggle({ on, label, icon, onClick }) {
    return (
        <button onClick={onClick}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition active:scale-95 ${
                on
                    ? 'bg-dd-green-50 text-dd-green-700 border-dd-green/30 hover:bg-dd-sage-50'
                    : 'bg-white text-dd-text-2 border-dd-line line-through opacity-70 hover:opacity-100'
            }`}>
            <span className="text-sm">{icon}</span>
            <span>{label}</span>
        </button>
    );
}

// Lists the last 10 notification docs targeted at this staff member.
// Lets admin diagnose where a missing-push problem actually is:
//   - Row present, recent → doc was created. If you didn't see a toast,
//     the issue is FCM delivery (Cloud Function not deployed, dead
//     token, browser permission, etc.).
//   - Row missing → upstream (notify() never fired). Check the event
//     handler that should have written it.
//
// Reads /notifications WHERE forStaff == currentStaff ORDER BY createdAt
// DESC LIMIT 10. No realtime subscription; refresh button re-reads.
function RecentNotificationsFeed({ staffName, language }) {
    const [items, setItems] = useState(null);
    const [refresh, setRefresh] = useState(0);
    const tx = (en, es) => (language === 'es' ? es : en);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const { collection, query: q, where, orderBy, limit, getDocs } = await import('firebase/firestore');
                const ref = collection(db, 'notifications');
                const qq = q(ref, where('forStaff', '==', staffName), orderBy('createdAt', 'desc'), limit(10));
                const snap = await getDocs(qq);
                if (!alive) return;
                setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            } catch (e) {
                console.warn('recent notifications query failed:', e);
                if (alive) setItems([]);
            }
        })();
        return () => { alive = false; };
    }, [staffName, refresh]);

    const fmtTime = (ts) => {
        if (!ts) return '—';
        try {
            const d = ts.toDate ? ts.toDate() : new Date(ts);
            const now = Date.now();
            const diff = (now - d.getTime()) / 1000;
            if (diff < 60) return `${Math.round(diff)}s ago`;
            if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
            if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
            return d.toLocaleString();
        } catch { return '—'; }
    };

    return (
        <div className="mt-3 mb-2 bg-white border border-blue-200 rounded-lg p-2">
            <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-blue-800">
                    {tx('Recent notification docs sent to you', 'Notificaciones recientes para ti')}
                </div>
                <button onClick={() => setRefresh(r => r + 1)}
                    className="text-[10px] font-bold text-blue-700 hover:underline">
                    ↻ {tx('Refresh', 'Actualizar')}
                </button>
            </div>
            {items === null ? (
                <p className="text-[11px] text-blue-700 italic">{tx('Loading…', 'Cargando…')}</p>
            ) : items.length === 0 ? (
                <p className="text-[11px] text-blue-700 italic">
                    {tx('No notification docs found for you. If you triggered an event that should notify you, check whether notify() actually fired (or whether forStaff was you and got skipped by the self-notify guard).',
                        'Sin notificaciones para ti. Si activaste un evento que debería notificarte, revisa si notify() corrió.')}
                </p>
            ) : (
                <div className="divide-y divide-gray-100">
                    {items.map(n => (
                        <div key={n.id} className="py-1.5 first:pt-0 last:pb-0">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-bold text-dd-text truncate">{n.title || n.type || '(no title)'}</span>
                                <span className="text-[10px] text-gray-500 flex-shrink-0">{fmtTime(n.createdAt)}</span>
                            </div>
                            {n.body && <div className="text-[10px] text-gray-600 truncate">{n.body}</div>}
                            <div className="text-[9px] text-gray-400 mt-0.5">
                                {n.type || '?'} · tag: {n.tag || '(none)'} · by: {n.createdBy || '?'}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

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

function AdminPanelInner({ language, staffName, staffList, setStaffList, storeLocation, onNavigate, hasOnboardingAccess }) {
            const [editingId, setEditingId] = useState(null);
            const [editPin, setEditPin] = useState("");
            const [editRole, setEditRole] = useState("");
            const [editOpsAccess, setEditOpsAccess] = useState(false);
            const [editRecipesAccess, setEditRecipesAccess] = useState(false);
            const [editViewLabor, setEditViewLabor] = useState(false);
            const [editShiftLead, setEditShiftLead] = useState(false);
            const [editIsMinor, setEditIsMinor] = useState(false);
            const [editScheduleSide, setEditScheduleSide] = useState("foh");
            const [editTargetHours, setEditTargetHours] = useState(0);
            // Preferred language for outbound notifications (push, in-app
            // banners). Defaults to English for legacy records that don't
            // carry the field. New staff form picks this up from the device's
            // current UI language.
            const [editPreferredLanguage, setEditPreferredLanguage] = useState("en");
            // Per-staff Home view override. When set to a tab id (e.g. 'schedule'),
            // tapping the Home tab — or signing in for the first time — shows
            // that tab's content instead of the default dashboard. Useful for:
            // FOH staff landing on Schedule, kitchen on Recipes, trainees on
            // Training, etc. Empty/'auto' = the default unified Home page.
            const [editHomeView, setEditHomeView] = useState("auto");
            // Per-staff tab visibility — array of HIDEABLE_PAGES ids that are
            // FORCE-HIDDEN. Empty array = sees everything. Mirrors the
            // staff.hiddenPages field. Edit form drives this; bulk-tag panel
            // also writes to it from a different surface.
            const [editHiddenPages, setEditHiddenPages] = useState([]);
            // Designated-scheduler toggles. Per-side so the FOH scheduler
            // can't accidentally publish over BOH shifts and vice versa.
            const [editCanEditScheduleFOH, setEditCanEditScheduleFOH] = useState(false);
            const [editCanEditScheduleBOH, setEditCanEditScheduleBOH] = useState(false);
            const [showBulkTag, setShowBulkTag] = useState(false);
            const [bulkSearch, setBulkSearch] = useState("");
            const [bulkFilter, setBulkFilter] = useState("all"); // all | untagged | foh | boh
            // Bulk toggles panel is collapsed by default so the staff list gets
            // the most room. Expand on demand for mass on/off operations.
            const [bulkTogglesOpen, setBulkTogglesOpen] = useState(false);
            // Live counts for the Onboarding launcher card. Only subscribe when
            // the current admin actually has PII access — defaults to off for
            // everyone except owners (Julie + Andrew).
            const [onboardingPendingApps, setOnboardingPendingApps] = useState(0);
            const [onboardingActiveHires, setOnboardingActiveHires] = useState(0);
            useEffect(() => {
                if (!hasOnboardingAccess) return;
                const unsubA = onSnapshot(collection(db, 'onboarding_applications'),
                    (snap) => setOnboardingPendingApps(snap.size),
                    () => setOnboardingPendingApps(0));
                const unsubH = onSnapshot(collection(db, 'onboarding_hires'),
                    (snap) => {
                        let active = 0;
                        snap.forEach(d => {
                            const s = (d.data() || {}).status;
                            if (s !== 'archived' && s !== 'complete') active++;
                        });
                        setOnboardingActiveHires(active);
                    },
                    () => setOnboardingActiveHires(0));
                return () => { unsubA(); unsubH(); };
            }, [hasOnboardingAccess]);
            // Two-step confirmation for the System Refresh broadcast.
            // First tap arms the button; second tap (within 10s) fires it.
            const [confirmingRefresh, setConfirmingRefresh] = useState(false);
            // Recipe view audit log — most recent N opens. Used in the
            // "Recipe Audit" panel below; collected by Recipes.jsx on every
            // accordion expand.
            const [recipeViews, setRecipeViews] = useState([]);
            const [showAllViews, setShowAllViews] = useState(false);
            // Heavy history panels are collapsed by default — they were
            // dominating the admin page and forcing people to scroll past
            // hundreds of rows to reach the more important controls.
            const [checklistHistoryExpanded, setChecklistHistoryExpanded] = useState(false);
            const [inventoryHistoryExpanded, setInventoryHistoryExpanded] = useState(false);
            useEffect(() => {
                if (!confirmingRefresh) return;
                const t = setTimeout(() => setConfirmingRefresh(false), 10000);
                return () => clearTimeout(t);
            }, [confirmingRefresh]);
            const handleSystemRefresh = async () => {
                try {
                    await setDoc(doc(db, "config", "forceRefresh"), {
                        triggeredAt: serverTimestamp(),
                        triggeredBy: staffName,
                    });
                    setConfirmingRefresh(false);
                    toast(language === "es"
                        ? "✓ Refresco enviado. Cada dispositivo activo se actualizará en segundos."
                        : "✓ Broadcast sent. Every active device will refresh within seconds.");
                } catch (e) {
                    console.error("System refresh broadcast failed:", e);
                    toast((language === "es" ? "Error: " : "Error: ") + e.message);
                }
            };

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
                toast(language === "es"
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
                toast(language === "es"
                    ? `✓ Acceso a Recetas otorgado: ${touched}.`
                    : `✓ Recipes access granted to ${touched} staff.`);
            };

            // Generic bulk-update helper — sweep a subset of staff records
            // to the same value for the same field. Used by every "Sweep N
            // visible to ON/OFF" button in the bulk-toggle section.
            const bulkSetField = async (ids, field, value) => {
                if (!ids || ids.length === 0) return;
                const idSet = new Set(ids);
                let touched = 0;
                let latest = null;
                setStaffList(prev => {
                    latest = prev.map(s => {
                        if (!idSet.has(s.id)) return s;
                        if (s[field] === value) return s; // skip no-ops
                        touched += 1;
                        return { ...s, [field]: value };
                    });
                    return latest;
                });
                if (touched > 0 && latest) {
                    await saveStaffToFirestore(latest);
                    showSaved();
                }
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
            // Side filter inside a location tab. Only meaningful when a
            // specific location is selected (Webster or Maryland) — when "All
            // Locations" is showing, the side filter is hidden but kept in
            // state so toggling locations preserves the user's choice.
            const [staffSideFilter, setStaffSideFilter] = useState("all"); // 'all' | 'foh' | 'boh'
            // Resolve a person's effective side: explicit scheduleSide if set,
            // else infer from BOH-tagged role list. Same logic the schedule
            // uses, kept consistent so the count chips match.
            const personSide = (s) => s.scheduleSide || (BULK_BOH_ROLES.includes(s.role) ? 'boh' : 'foh');
            const filteredStaff = (() => {
                let out = staffList;
                if (staffFilter !== "all") out = out.filter(s => s.location === staffFilter || s.location === "both");
                if (staffSideFilter !== "all" && staffFilter !== "all") {
                    out = out.filter(s => personSide(s) === staffSideFilter);
                }
                return out;
            })();

            // Load maintenance requests
            useEffect(() => {
                const unsub = onSnapshot(query(collection(db, "maintenanceRequests"), orderBy("createdAt", "desc"), limit(50)), (snap) => {
                    const reqs = [];
                    snap.forEach(docSnapshot => reqs.push({ id: docSnapshot.id, ...docSnapshot.data() }));
                    setMaintenanceRequests(reqs);
                }, (err) => { console.error("Error loading maintenance requests:", err); });
                return () => unsub();
            }, []);

            // Recipe view audit — last 200. Sorted client-side because
            // serverTimestamp() can be momentarily null on the writer's
            // own snapshot before round-trip; we sort by it once it lands.
            useEffect(() => {
                const unsub = onSnapshot(
                    query(collection(db, "recipe_views"), orderBy("viewedAt", "desc"), limit(200)),
                    (snap) => {
                        const arr = [];
                        snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
                        setRecipeViews(arr);
                    },
                    (err) => { console.warn("Error loading recipe views:", err); }
                );
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

            // Delete a single maintenance request. Hard delete — no archive.
            // Confirm prompt because this is permanent.
            const deleteMaintenanceRequest = async (reqId) => {
                if (!confirm(language === "es"
                    ? "¿Eliminar esta solicitud permanentemente?"
                    : "Delete this request permanently?")) return;
                try {
                    await deleteDoc(doc(db, "maintenanceRequests", reqId));
                    showSaved();
                } catch (err) {
                    console.error("Error deleting request:", err);
                    toast((language === "es" ? "Error al eliminar: " : "Delete failed: ") + (err.message || err));
                }
            };

            // Bulk-clear: delete every "completed" or "declined" request
            // (optionally restricted to the active maintenance filter). Two-step
            // confirm — staff lose audit trail. Uses a Firestore batch (max 500
            // ops) so cleanup is atomic.
            const clearOldMaintenanceRequests = async () => {
                const targets = filteredMaintenance.filter(r => r.status === "completed" || r.status === "declined");
                if (targets.length === 0) {
                    toast(language === "es"
                        ? "No hay solicitudes completadas o rechazadas para eliminar."
                        : "No completed/declined requests to delete.");
                    return;
                }
                const msg = language === "es"
                    ? `Eliminar permanentemente ${targets.length} solicitud(es) completadas/rechazadas? No se puede deshacer.`
                    : `Permanently delete ${targets.length} completed/declined request(s)? Cannot be undone.`;
                if (!confirm(msg)) return;
                try {
                    // Chunk into batches of 450 to stay safely under Firestore's 500-op cap.
                    for (let i = 0; i < targets.length; i += 450) {
                        const chunk = targets.slice(i, i + 450);
                        const batch = writeBatch(db);
                        chunk.forEach(r => batch.delete(doc(db, "maintenanceRequests", r.id)));
                        await batch.commit();
                    }
                    toast((language === "es" ? "Eliminadas: " : "Deleted: ") + targets.length);
                    showSaved();
                } catch (err) {
                    console.error("Error clearing requests:", err);
                    toast((language === "es" ? "Error: " : "Error: ") + (err.message || err));
                }
            };

            // Refuse-to-write-empty-pin guard + PIN audit log.
            // After the 2026-05-09 PIN-corruption incident (the legacy migration
            // block was silently re-writing PINs to placeholder defaults), every
            // staff write goes through this helper. Two protections:
            //
            // 1. PIN INTEGRITY GATE: any record whose pin would land as empty,
            //    null, or non-4-digit is REJECTED — the entire save is aborted
            //    and the admin sees a toast. This kills the class of bug where
            //    a stale React state writes pin: "" or pin: undefined.
            //
            // 2. AUDIT LOG: we read the current Firestore record, diff against
            //    the new list, and write a doc to /pin_audits for every PIN
            //    that actually changed. Each entry: {id, name, oldPin, newPin,
            //    changedBy, changedAt}. So if a PIN ever changes again, we
            //    have a full forensic trail naming the actor.
            const saveStaffToFirestore = async (updatedList) => {
                // GATE: bail if any PIN is missing/blank/wrong-length.
                const bad = updatedList.find(s => {
                    const p = String(s.pin ?? '').trim();
                    return !p || !/^\d{4}$/.test(p);
                });
                if (bad) {
                    console.error('Refusing staff save — invalid PIN on:', bad.name, 'pin=', bad.pin);
                    toast(language === 'es'
                        ? `Guardado bloqueado: PIN inválido en ${bad.name}. No se hicieron cambios.`
                        : `Save blocked: invalid PIN on ${bad.name}. No changes made.`,
                        { kind: 'error', duration: 8000 });
                    return;
                }
                // AUDIT: read current Firestore + compute diff before write.
                let oldByName = new Map();
                try {
                    const cur = await getDoc(doc(db, 'config', 'staff'));
                    if (cur.exists()) {
                        const list = (cur.data() || {}).list || [];
                        for (const s of list) oldByName.set(`${s.id}|${s.name}`, s.pin);
                    }
                } catch (e) {
                    console.warn('audit: pre-read failed (proceeding anyway):', e);
                }
                try {
                    await setDoc(doc(db, "config", "staff"), { list: updatedList });
                } catch (err) {
                    console.error("Error saving staff:", err);
                    toast(language === 'es' ? 'Error al guardar personal' : 'Staff save failed', { kind: 'error' });
                    return;
                }
                // Post-write: log every PIN change to /pin_audits.
                // Fire-and-forget so a logging failure never blocks the save.
                for (const s of updatedList) {
                    const key = `${s.id}|${s.name}`;
                    const oldPin = oldByName.get(key);
                    if (oldPin != null && oldPin !== s.pin) {
                        addDoc(collection(db, 'pin_audits'), {
                            staffId: s.id,
                            staffName: s.name,
                            oldPin: oldPin,
                            newPin: s.pin,
                            changedBy: staffName,
                            changedAt: serverTimestamp(),
                            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
                        }).catch(e => console.warn('pin audit write failed:', e));
                    }
                }
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
                    latest = prev.map(s => s.id === id ? { ...s, pin: editPin, role: editRole, location: editLocation || s.location || "webster", opsAccess: editOpsAccess, recipesAccess: editRecipesAccess, viewLabor: editViewLabor, shiftLead: editShiftLead, isMinor: editIsMinor, scheduleSide: editScheduleSide, targetHours: Number(editTargetHours) || 0, canEditScheduleFOH: editCanEditScheduleFOH, canEditScheduleBOH: editCanEditScheduleBOH, preferredLanguage: editPreferredLanguage, homeView: editHomeView, hiddenPages: editHiddenPages } : s);
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
                    // Auto-apply the position template for this role so new
                    // hires land with reasonable access defaults (homeView,
                    // hiddenPages, viewLabor, scheduler flags). The visible
                    // form toggles below intentionally take precedence so an
                    // admin who flipped, say, opsAccess OFF gets that intent.
                    const template = getPositionTemplate(newRole) || {};
                    const newStaff = {
                        id: maxId + 1,
                        ...template,
                        name: newName.trim(),
                        role: newRole,
                        pin: newPin,
                        location: newLocation,
                        opsAccess: newOpsAccess,
                        recipesAccess: newRecipesAccess,
                        shiftLead: newShiftLead,
                        isMinor: newIsMinor,
                        scheduleSide: newScheduleSide,
                    };
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
                // Capture the name BEFORE we drop them from the list — needed
                // to clean up future-dated shifts so the schedule stops
                // showing them as a ghost row (bug 2026-05-09).
                const removedPerson = (staffList || []).find(s => s.id === id);
                const removedName = removedPerson?.name;
                // Functional setState avoids stale-closure clobber.
                let latest = null;
                setStaffList(prev => {
                    latest = prev.filter(s => s.id !== id);
                    return latest;
                });
                if (latest) await saveStaffToFirestore(latest);
                // Cascade-delete future shifts for the removed staff so
                // they don't sit as orphans on the schedule. Past shifts
                // are kept (for hours history / audit).
                if (removedName) {
                    try {
                        const today = new Date();
                        const todayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
                        const futureShifts = await getDocs(query(
                            collection(db, 'shifts'),
                            where('staffName', '==', removedName),
                            where('date', '>=', todayKey)
                        ));
                        if (!futureShifts.empty) {
                            const batch = writeBatch(db);
                            futureShifts.forEach(d => batch.delete(d.ref));
                            await batch.commit();
                            console.log(`[handleRemoveStaff] cascaded ${futureShifts.size} future shifts for ${removedName}`);
                        }
                    } catch (e) {
                        console.warn('cascade shift cleanup failed:', e);
                    }
                }
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

                    {/* ── ONBOARDING LAUNCHER ──
                        Onboarding lives behind the admin page (not in the main
                        nav) because it handles PII and is owner-only. Tapping
                        the card switches the active tab to the full-screen
                        Onboarding view. Badge count surfaces new applications
                        + active hires so admins notice attention-worthy state. */}
                    {hasOnboardingAccess && onNavigate && (
                        <button
                            onClick={() => onNavigate('onboarding')}
                            className="w-full mb-4 flex items-center justify-between bg-gradient-to-r from-rose-50 to-amber-50 border-2 border-rose-200 rounded-xl p-4 hover:from-rose-100 hover:to-amber-100 active:scale-[0.99] transition shadow-sm group">
                            <div className="flex items-center gap-3 min-w-0">
                                <span className="text-3xl flex-shrink-0">🪪</span>
                                <div className="text-left min-w-0">
                                    <h3 className="font-black text-rose-800 text-base flex items-center gap-2 flex-wrap">
                                        {language === "es" ? "Onboarding" : "Onboarding"}
                                        {onboardingPendingApps > 0 && (
                                            <span className="text-[10px] font-bold bg-amber-200 text-amber-900 border border-amber-300 px-1.5 py-0.5 rounded-full">
                                                {onboardingPendingApps} {language === "es" ? "nueva" : "new"}{onboardingPendingApps !== 1 ? 's' : ''}
                                            </span>
                                        )}
                                    </h3>
                                    <p className="text-[11px] text-rose-700/80 truncate">
                                        {language === "es"
                                            ? `${onboardingActiveHires} contrataciones activas · papeleo W-4/I-9/DL · PII solo dueños`
                                            : `${onboardingActiveHires} active hires · W-4/I-9/DL paperwork · owners-only PII`}
                                    </p>
                                </div>
                            </div>
                            <span className="text-rose-600 text-2xl flex-shrink-0 group-hover:translate-x-0.5 transition-transform">→</span>
                        </button>
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
                                <div className="flex gap-1 justify-center flex-wrap">
                                    {[{k:"all",en:"All Locations",es:"Todas"},{k:"webster",en:"Webster",es:"Webster"},{k:"maryland",en:"MD Heights",es:"MD Heights"}].map(f => (
                                        <button key={f.k} onClick={() => setMaintFilter(f.k)}
                                            className={`px-3 py-1 rounded-full text-xs font-bold border transition ${maintFilter === f.k ? "bg-red-600 text-white border-red-600" : "bg-white text-red-600 border-red-300 hover:bg-red-50"}`}>
                                            {language === "es" ? f.es : f.en}
                                            {f.k !== "all" && <span className="ml-1 opacity-70">({maintenanceRequests.filter(r => r.storeBranch === f.k).length})</span>}
                                        </button>
                                    ))}
                                </div>
                                {/* Bulk-clear: deletes every completed/declined request in the
                                    current filter. Shown only when there's something to delete. */}
                                {filteredMaintenance.some(r => r.status === "completed" || r.status === "declined") && (
                                    <div className="flex justify-center">
                                        <button onClick={clearOldMaintenanceRequests}
                                            className="text-xs font-bold px-3 py-1 rounded-full border border-red-300 text-red-600 bg-white hover:bg-red-50">
                                            🗑️ {language === "es"
                                                ? `Limpiar completadas/rechazadas (${filteredMaintenance.filter(r => r.status === "completed" || r.status === "declined").length})`
                                                : `Clear completed/declined (${filteredMaintenance.filter(r => r.status === "completed" || r.status === "declined").length})`}
                                        </button>
                                    </div>
                                )}
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
                                                    {/* Permanent delete — separate row so it's not adjacent to "Done"
                                                        (avoids accidental misclick). Confirms via deleteMaintenanceRequest. */}
                                                    <button onClick={() => deleteMaintenanceRequest(req.id)}
                                                        className="w-full py-1.5 bg-white border border-red-300 text-red-600 rounded text-xs font-bold hover:bg-red-50">
                                                        🗑️ {language === "es" ? "Eliminar permanentemente" : "Delete permanently"}
                                                    </button>
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
                                <div className="flex gap-1 justify-center mb-2 flex-wrap">
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
                                {/* Side sub-tabs — only meaningful when a specific
                                    location is selected. Hidden under "All Locations"
                                    because filtering by side across both stores rarely
                                    matches what an admin actually wants to see. */}
                                {staffFilter !== "all" && (
                                    <div className="flex gap-1 justify-center mb-3 flex-wrap">
                                        {[
                                            { k: "all", en: "All", es: "Todos", tone: "blue" },
                                            { k: "foh", en: "🪑 FOH", es: "🪑 FOH", tone: "blue" },
                                            { k: "boh", en: "🍳 BOH", es: "🍳 BOH", tone: "orange" },
                                        ].map(f => {
                                            const active = staffSideFilter === f.k;
                                            const count = staffList.filter(s =>
                                                (s.location === staffFilter || s.location === "both") &&
                                                (f.k === "all" || personSide(s) === f.k)
                                            ).length;
                                            const activeCls = f.tone === 'orange'
                                                ? 'bg-orange-600 text-white border-orange-600'
                                                : 'bg-blue-500 text-white border-blue-500';
                                            return (
                                                <button key={f.k} onClick={() => setStaffSideFilter(f.k)}
                                                    className={`px-3 py-1 rounded-full text-[11px] font-bold border transition ${active ? activeCls : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}>
                                                    {language === "es" ? f.es : f.en}
                                                    <span className="ml-1 opacity-70">({count})</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
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
                                                        {/* Position template — one-tap fill of every access toggle below
                                                            based on the current role. NOT auto-applied on role change,
                                                            so a manual customization isn't silently clobbered. */}
                                                        {hasPositionTemplate(editRole) ? (
                                                            <button type="button"
                                                                onClick={() => {
                                                                    const t = getPositionTemplate(editRole);
                                                                    if (!t) return;
                                                                    const has = Object.keys(t).some(k => {
                                                                        if (k === 'scheduleSide') return editScheduleSide !== t[k];
                                                                        if (k === 'opsAccess') return editOpsAccess !== t[k];
                                                                        if (k === 'recipesAccess') return editRecipesAccess !== t[k];
                                                                        if (k === 'viewLabor') return editViewLabor !== t[k];
                                                                        if (k === 'shiftLead') return editShiftLead !== t[k];
                                                                        if (k === 'canEditScheduleFOH') return editCanEditScheduleFOH !== t[k];
                                                                        if (k === 'canEditScheduleBOH') return editCanEditScheduleBOH !== t[k];
                                                                        if (k === 'homeView') return editHomeView !== t[k];
                                                                        if (k === 'hiddenPages') return JSON.stringify(editHiddenPages.slice().sort()) !== JSON.stringify((t[k] || []).slice().sort());
                                                                        return false;
                                                                    });
                                                                    if (has && !confirm(language === "es"
                                                                        ? `Aplicar plantilla "${editRole}"? Sobrescribirá los toggles actuales.`
                                                                        : `Apply "${editRole}" template? This will overwrite your current toggles.`)) return;
                                                                    if (typeof t.scheduleSide === 'string') setEditScheduleSide(t.scheduleSide);
                                                                    if (typeof t.opsAccess === 'boolean') setEditOpsAccess(t.opsAccess);
                                                                    if (typeof t.recipesAccess === 'boolean') setEditRecipesAccess(t.recipesAccess);
                                                                    if (typeof t.viewLabor === 'boolean') setEditViewLabor(t.viewLabor);
                                                                    if (typeof t.shiftLead === 'boolean') setEditShiftLead(t.shiftLead);
                                                                    if (typeof t.canEditScheduleFOH === 'boolean') setEditCanEditScheduleFOH(t.canEditScheduleFOH);
                                                                    if (typeof t.canEditScheduleBOH === 'boolean') setEditCanEditScheduleBOH(t.canEditScheduleBOH);
                                                                    if (typeof t.homeView === 'string') setEditHomeView(t.homeView);
                                                                    if (Array.isArray(t.hiddenPages)) setEditHiddenPages([...t.hiddenPages]);
                                                                }}
                                                                className="mt-1.5 w-full py-1.5 rounded-lg text-[11px] font-bold bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 transition">
                                                                ⚡ {language === "es"
                                                                    ? `Aplicar plantilla "${editRole}"`
                                                                    : `Apply "${editRole}" template`}
                                                            </button>
                                                        ) : (
                                                            <p className="mt-1.5 text-[10px] text-gray-400 italic">
                                                                {language === "es"
                                                                    ? "Sin plantilla para este rol — ajusta los toggles manualmente."
                                                                    : "No template for this role — toggle access manually."}
                                                            </p>
                                                        )}
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
                                                    {/* Labor % visibility — gated dashboard data. Default ON for
                                                        managers/owners, OFF for staff. Admin can override per-person. */}
                                                    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-700">{language === "es" ? "Ver % de Mano de Obra" : "View Labor %"}</p>
                                                            <p className="text-xs text-gray-500">{language === "es" ? "Ver KPI de costo laboral en Inicio + Operaciones" : "See labor-cost KPI on Home + Operations"}</p>
                                                        </div>
                                                        <button onClick={() => setEditViewLabor(!editViewLabor)}
                                                            className={`w-14 h-8 rounded-full transition-colors duration-200 relative ${editViewLabor ? "bg-green-600" : "bg-gray-300"}`}>
                                                            <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform duration-200 ${editViewLabor ? "translate-x-7" : "translate-x-1"}`} />
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
                                                    {/* Per-staff Home view picker. Determines what THIS person sees
                                                        when they tap the Home tab (and what tab they land on after
                                                        signing in for the first time on a device). 'Auto' = the
                                                        default unified Home; any other value redirects to that tab. */}
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">🏠 {language === "es" ? "Vista de inicio" : "Home view"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">{language === "es"
                                                            ? "Qué ve esta persona al abrir la app."
                                                            : "What this person sees when they open the app."}</p>
                                                        <select value={editHomeView}
                                                            onChange={(e) => setEditHomeView(e.target.value)}
                                                            className="w-full px-2 py-2 border-2 border-gray-300 rounded-lg focus:border-mint-700 focus:outline-none text-sm bg-white">
                                                            <option value="auto">{language === "es" ? "🏠 Inicio (predeterminado)" : "🏠 Default Home"}</option>
                                                            <option value="schedule">{language === "es" ? "📅 Horario" : "📅 Schedule"}</option>
                                                            <option value="recipes">{language === "es" ? "🧑‍🍳 Recetas" : "🧑‍🍳 Recipes"}</option>
                                                            <option value="operations">{language === "es" ? "📋 Operaciones (tareas)" : "📋 Operations (tasks)"}</option>
                                                            <option value="training">{language === "es" ? "📚 Capacitación" : "📚 Training"}</option>
                                                            <option value="menu">{language === "es" ? "🍜 Menú" : "🍜 Menu"}</option>
                                                            <option value="eighty6">{language === "es" ? "🚫 Tablero 86" : "🚫 86 Board"}</option>
                                                            <option value="handoff">{language === "es" ? "🤝 Entrega de turno" : "🤝 Shift Handoff"}</option>
                                                            <option value="tardies">{language === "es" ? "⏰ Tardanzas" : "⏰ Tardies"}</option>
                                                            <option value="labor">{language === "es" ? "📊 Mano de obra" : "📊 Labor Dashboard"}</option>
                                                        </select>
                                                    </div>

                                                    {/* Per-staff tab access — toggle which optional tabs this
                                                        person sees in the sidebar / mobile launcher. Default
                                                        (empty array) = sees everything. Toggling OFF adds the
                                                        tab id to hiddenPages, hiding it from this person's view.
                                                        Schedule/Home are never hideable (they're core). Recipes,
                                                        Operations have their own access flags above. */}
                                                    {(() => {
                                                        const visibleCount = HIDEABLE_PAGES.length - editHiddenPages.length;
                                                        const allVisible = editHiddenPages.length === 0;
                                                        const allHidden = editHiddenPages.length === HIDEABLE_PAGES.length;
                                                        const toggle = (id) => {
                                                            setEditHiddenPages(prev => prev.includes(id)
                                                                ? prev.filter(x => x !== id)
                                                                : [...prev, id]);
                                                        };
                                                        return (
                                                            <div className="bg-gray-50 rounded-lg p-3">
                                                                <div className="flex items-center justify-between mb-1 flex-wrap gap-1">
                                                                    <p className="text-sm font-bold text-gray-700">
                                                                        👁 {language === "es" ? "Acceso a pestañas" : "Tab access"}
                                                                    </p>
                                                                    <span className="text-[10px] font-bold text-gray-500">
                                                                        {visibleCount}/{HIDEABLE_PAGES.length} {language === "es" ? "visibles" : "visible"}
                                                                    </span>
                                                                </div>
                                                                <p className="text-xs text-gray-500 mb-2">
                                                                    {language === "es"
                                                                        ? "Activa/desactiva qué pestañas opcionales ve esta persona. Horario/Inicio siempre visibles. Recetas y Operaciones tienen sus propios accesos arriba."
                                                                        : "Toggle which optional tabs this person sees. Home/Schedule always visible. Recipes & Operations have their own access above."}
                                                                </p>
                                                                <div className="flex gap-1 mb-2">
                                                                    <button type="button" onClick={() => setEditHiddenPages([])}
                                                                        className={`flex-1 py-1 rounded text-[10px] font-bold border ${allVisible ? 'bg-green-600 text-white border-green-600' : 'bg-white text-green-700 border-green-300 hover:bg-green-50'}`}>
                                                                        ✓ {language === "es" ? "Todas visibles" : "All on"}
                                                                    </button>
                                                                    <button type="button" onClick={() => setEditHiddenPages(HIDEABLE_PAGES.map(p => p.id))}
                                                                        className={`flex-1 py-1 rounded text-[10px] font-bold border ${allHidden ? 'bg-red-600 text-white border-red-600' : 'bg-white text-red-700 border-red-300 hover:bg-red-50'}`}>
                                                                        ✕ {language === "es" ? "Todas ocultas" : "All off"}
                                                                    </button>
                                                                </div>
                                                                <div className="grid grid-cols-2 gap-1.5">
                                                                    {HIDEABLE_PAGES.map(pg => {
                                                                        const isVisible = !editHiddenPages.includes(pg.id);
                                                                        return (
                                                                            <button key={pg.id} type="button" onClick={() => toggle(pg.id)}
                                                                                className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-bold border-2 transition active:scale-95 ${
                                                                                    isVisible
                                                                                        ? 'bg-white text-dd-text border-dd-line hover:border-dd-green/50'
                                                                                        : 'bg-gray-100 text-gray-400 border-gray-200 line-through'
                                                                                }`}>
                                                                                <span className="text-sm">{pg.emoji}</span>
                                                                                <span className="flex-1 text-left truncate">{language === "es" ? pg.labelEs : pg.labelEn}</span>
                                                                                <span className={`w-3.5 h-3.5 rounded-full flex-shrink-0 ${isVisible ? 'bg-green-500' : 'bg-gray-300'}`} />
                                                                            </button>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        );
                                                    })()}

                                                    {/* Preferred language for this person's notifications. */}
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">🗣 {language === "es" ? "Idioma de notificaciones" : "Notification language"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">{language === "es"
                                                            ? "Pushes y mensajes de tareas se enviarán en este idioma."
                                                            : "Pushes and task messages will be sent in this language."}</p>
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <button onClick={() => setEditPreferredLanguage("en")}
                                                                className={`py-2 rounded-md text-xs font-bold ${editPreferredLanguage === "en" ? "bg-blue-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                English
                                                            </button>
                                                            <button onClick={() => setEditPreferredLanguage("es")}
                                                                className={`py-2 rounded-md text-xs font-bold ${editPreferredLanguage === "es" ? "bg-blue-600 text-white" : "bg-white border border-gray-300 text-gray-600"}`}>
                                                                Español
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <div className="bg-gray-50 rounded-lg p-3">
                                                        <p className="text-sm font-bold text-gray-700 mb-1">{language === "es" ? "Horas semanales objetivo" : "Target Hours / Week"}</p>
                                                        <p className="text-xs text-gray-500 mb-2">{language === "es" ? "Usado por el auto-populador. 0 = sin objetivo." : "Used by auto-fill. 0 = no target."}</p>
                                                        <input type="number" inputMode="numeric" pattern="[0-9]*" min="0" max="80" step="1"
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
                                                        <button onClick={() => { setEditingId(null); setEditPin(""); setEditRole(""); setEditLocation(""); setEditOpsAccess(false); setEditRecipesAccess(false); setEditShiftLead(false); setEditIsMinor(false); setEditScheduleSide("foh"); setEditTargetHours(0); setEditCanEditScheduleFOH(false); setEditCanEditScheduleBOH(false); setEditHiddenPages([]); }}
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
                                                        <button onClick={() => { setEditingId(person.id); setEditPin(person.pin); setEditRole(person.role); setEditLocation(person.location || "webster"); setEditOpsAccess(!!person.opsAccess); setEditRecipesAccess(person.recipesAccess !== false); setEditViewLabor(person.viewLabor === true || (person.viewLabor !== false && /manager|owner/i.test(person.role || ''))); setEditShiftLead(!!person.shiftLead); setEditIsMinor(!!person.isMinor); setEditScheduleSide(person.scheduleSide || "foh"); setEditTargetHours(person.targetHours || 0); setEditCanEditScheduleFOH(!!person.canEditScheduleFOH); setEditCanEditScheduleBOH(!!person.canEditScheduleBOH); setEditPreferredLanguage(person.preferredLanguage || "en"); setEditHomeView(person.homeView || "auto"); setEditHiddenPages(Array.isArray(person.hiddenPages) ? [...person.hiddenPages] : []); }}
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
                                            {hasPositionTemplate(newRole) ? (
                                                <p className="mt-1 text-[10px] text-indigo-700 font-bold">
                                                    ⚡ {language === "es"
                                                        ? `Se aplicarán los accesos predeterminados de "${newRole}" al guardar.`
                                                        : `"${newRole}" template will apply default access on save.`}
                                                </p>
                                            ) : (
                                                <p className="mt-1 text-[10px] text-gray-400 italic">
                                                    {language === "es"
                                                        ? "Sin plantilla — ajusta el acceso luego en Editar."
                                                        : "No template — tweak access later via Edit."}
                                                </p>
                                            )}
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

                    {/* Checklist History Section — collapsed by default. The
                        rendered list is hundreds of rows long; mounting it on
                        every Admin visit pushed the more important controls way
                        below the fold. Now: header bar opens / closes; the
                        component itself is unmounted while collapsed so its
                        Firestore subscription doesn't run when nobody's looking. */}
                    <div className="mt-8 pt-6 border-t-2 border-gray-200">
                        <button onClick={() => setChecklistHistoryExpanded(v => !v)}
                            className="w-full flex items-center justify-between text-left">
                            <div>
                                <h3 className="text-xl font-bold text-mint-700 mb-1">📋 {language === "es" ? "Historial de Listas" : "Checklist History"}</h3>
                                <p className="text-xs text-gray-500">{language === "es"
                                    ? "Revisa las listas de apertura y cierre de días anteriores"
                                    : "Review opening and closing checklists from previous days"}</p>
                            </div>
                            <span className="text-gray-400 text-xl ml-2">{checklistHistoryExpanded ? "▼" : "▶"}</span>
                        </button>
                        {checklistHistoryExpanded && (
                            <div className="mt-3"><ChecklistHistory language={language} storeLocation={storeLocation} /></div>
                        )}
                    </div>

                    {/* Inventory History Section — collapsed by default for the
                        same reason as Checklist History. */}
                    <div className="mt-8 pt-6 border-t-2 border-gray-200">
                        <button onClick={() => setInventoryHistoryExpanded(v => !v)}
                            className="w-full flex items-center justify-between text-left">
                            <div>
                                <h3 className="text-xl font-bold text-mint-700 mb-1">📦 {language === "es" ? "Historial de Inventario" : "Inventory History"}</h3>
                                <p className="text-xs text-gray-500">{language === "es"
                                    ? "Revisa los conteos de inventario de días anteriores. Los cambios vs el día anterior se muestran en verde/rojo."
                                    : "Review inventory counts from previous days. Changes vs the prior day are shown in green/red."}</p>
                            </div>
                            <span className="text-gray-400 text-xl ml-2">{inventoryHistoryExpanded ? "▼" : "▶"}</span>
                        </button>
                        {inventoryHistoryExpanded && (
                            <div className="mt-3"><InventoryHistory language={language} customInventory={null} storeLocation={storeLocation} /></div>
                        )}
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
                                {/* Wider modal so the per-row controls (FOH/BOH, minor, recipes,
                                    ops, language, home view, target hours, availability) fit
                                    side-by-side without crowding. Two-column staff list on
                                    lg+ screens so admins can edit ~12 rows at a time without
                                    scrolling. */}
                                {/* Modal is one big scroll container instead of
                                    a sticky-header + flex-body split. Per
                                    Andrew: makes scrolling through staff
                                    much easier — the search/filters scroll
                                    out of view but the staff list gets the
                                    full vertical space. The 'Done' button at
                                    the bottom + the X in the (now scrolling)
                                    header are both reachable. */}
                                <div className="bg-white w-full sm:max-w-3xl lg:max-w-5xl xl:max-w-6xl sm:rounded-2xl rounded-t-2xl max-h-[95vh] sm:max-h-[92vh] overflow-y-auto">
                                    <div className="border-b border-gray-200 p-4 sticky top-0 bg-white z-10">
                                        <div className="flex items-center justify-between mb-2">
                                            <h3 className="text-lg font-bold text-purple-700">🏷 {language === "es" ? "Etiquetar Personal en Lote" : "Bulk Tag Staff"}</h3>
                                            <button onClick={() => { setShowBulkTag(false); setBulkSearch(""); }}
                                                className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
                                        </div>
                                    </div>
                                    <div className="p-4">
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
                                        {/* Bulk toggle section — sweep ON/OFF for every staff currently
                                            visible (after search + filter). Operates on `visibleIds`,
                                            so first narrow the list with the filter chips + search box,
                                            then hit a button. Acts on the displayed staff only.
                                            COLLAPSED by default to give the staff list more room —
                                            click the header to expand. */}
                                        {visible.length > 0 && (
                                            <div className="mt-2 pt-2 border-t border-gray-200">
                                                <button
                                                    onClick={() => setBulkTogglesOpen(o => !o)}
                                                    className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-[10px] font-bold text-gray-700 bg-gray-50 hover:bg-gray-100 border border-gray-200"
                                                    aria-expanded={bulkTogglesOpen}>
                                                    <span>
                                                        🔁 {language === "es" ? `Toggles en lote (${visible.length} visibles)` : `Bulk toggles (${visible.length} visible)`}
                                                    </span>
                                                    <span className="text-gray-400">{bulkTogglesOpen ? '▴' : '▾'}</span>
                                                </button>
                                            </div>
                                        )}
                                        {visible.length > 0 && bulkTogglesOpen && (
                                            <div className="mt-2 px-2 py-2 rounded-md bg-gray-50 border border-gray-200">
                                                {[
                                                    { field: "recipesAccess",        labelEn: "Recipes",      labelEs: "Recetas",      emoji: "🧑‍🍳", onColor: "bg-green-600",  offColor: "bg-gray-300" },
                                                    { field: "opsAccess",            labelEn: "Operations",   labelEs: "Operaciones",  emoji: "📋", onColor: "bg-mint-700",   offColor: "bg-gray-300" },
                                                    { field: "viewLabor",            labelEn: "Labor %",      labelEs: "Mano obra %",  emoji: "📊", onColor: "bg-emerald-600", offColor: "bg-gray-300" },
                                                    { field: "shiftLead",            labelEn: "Shift Lead",   labelEs: "Líder",        emoji: "🛡️", onColor: "bg-purple-600", offColor: "bg-gray-300" },
                                                    { field: "canEditScheduleFOH",   labelEn: "FOH editor",   labelEs: "Editor FOH",   emoji: "📅", onColor: "bg-teal-600",   offColor: "bg-gray-300" },
                                                    { field: "canEditScheduleBOH",   labelEn: "BOH editor",   labelEs: "Editor BOH",   emoji: "📅", onColor: "bg-orange-600", offColor: "bg-gray-300" },
                                                    { field: "canViewOnboarding",    labelEn: "Onboarding (PII)", labelEs: "Onboarding (PII)", emoji: "🪪", onColor: "bg-rose-700",   offColor: "bg-gray-300" },
                                                    { field: "canReceive86Alerts",   labelEn: "86 alerts (push)", labelEs: "Alertas 86 (push)", emoji: "🚫", onColor: "bg-red-700", offColor: "bg-gray-300" },
                                                ].map(t => (
                                                    <div key={t.field} className="flex items-center gap-1 mb-1">
                                                        <div className="flex-1 text-[10px] font-bold text-gray-700 truncate">
                                                            {t.emoji} {language === "es" ? t.labelEs : t.labelEn}
                                                        </div>
                                                        <button onClick={() => bulkSetField(visibleIds, t.field, true)}
                                                            className={`px-2 py-1 rounded text-[9px] font-bold text-white ${t.onColor} hover:opacity-90`}
                                                            title={language === "es" ? `Activar para ${visible.length}` : `Turn ON for ${visible.length}`}>
                                                            ON
                                                        </button>
                                                        <button onClick={() => bulkSetField(visibleIds, t.field, false)}
                                                            className={`px-2 py-1 rounded text-[9px] font-bold text-white ${t.offColor} hover:opacity-90`}
                                                            title={language === "es" ? `Desactivar para ${visible.length}` : `Turn OFF for ${visible.length}`}>
                                                            OFF
                                                        </button>
                                                    </div>
                                                ))}
                                                {/* Language sweep — set ALL visible to a single language at once.
                                                    Two buttons (EN / ES) instead of ON/OFF since this is a value
                                                    not a flag. */}
                                                <div className="flex items-center gap-1 mb-1">
                                                    <div className="flex-1 text-[10px] font-bold text-gray-700 truncate">
                                                        🗣 {language === "es" ? "Idioma de notificaciones" : "Notification language"}
                                                    </div>
                                                    <button onClick={() => bulkSetField(visibleIds, "preferredLanguage", "en")}
                                                        className="px-2 py-1 rounded text-[9px] font-bold text-white bg-blue-600 hover:opacity-90"
                                                        title={language === "es" ? `English para ${visible.length}` : `English for ${visible.length}`}>
                                                        EN
                                                    </button>
                                                    <button onClick={() => bulkSetField(visibleIds, "preferredLanguage", "es")}
                                                        className="px-2 py-1 rounded text-[9px] font-bold text-white bg-blue-800 hover:opacity-90"
                                                        title={language === "es" ? `Español para ${visible.length}` : `Spanish for ${visible.length}`}>
                                                        ES
                                                    </button>
                                                </div>
                                                {/* Home view sweep — set the landing tab for all visible at once.
                                                    Common patterns: "All FOH → Schedule home" or "All trainees →
                                                    Training home" or "All BOH → Recipes home". */}
                                                <div className="flex items-center gap-1 mb-1">
                                                    <div className="flex-1 text-[10px] font-bold text-gray-700 truncate">
                                                        🏠 {language === "es" ? "Vista de inicio" : "Home view"}
                                                    </div>
                                                    <select onChange={e => { if (e.target.value) { bulkSetField(visibleIds, "homeView", e.target.value); e.target.value = ''; } }}
                                                        className="text-[9px] font-bold border border-gray-300 rounded px-1 py-1 bg-white max-w-[110px]"
                                                        defaultValue="">
                                                        <option value="">{language === "es" ? `Aplicar a ${visible.length}…` : `Apply to ${visible.length}…`}</option>
                                                        <option value="auto">🏠 {language === "es" ? "Predet." : "Default"}</option>
                                                        <option value="schedule">📅 {language === "es" ? "Horario" : "Schedule"}</option>
                                                        <option value="recipes">🧑‍🍳 {language === "es" ? "Recetas" : "Recipes"}</option>
                                                        <option value="operations">📋 {language === "es" ? "Operaciones" : "Operations"}</option>
                                                        <option value="training">📚 {language === "es" ? "Capacit." : "Training"}</option>
                                                        <option value="menu">🍜 {language === "es" ? "Menú" : "Menu"}</option>
                                                        <option value="eighty6">🚫 86</option>
                                                    </select>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="p-2 space-y-1 lg:grid lg:grid-cols-2 lg:gap-2 lg:space-y-0">
                                        {visible.length === 0 && (
                                            <p className="text-center text-gray-400 text-sm py-8">{language === "es" ? "Sin resultados." : "No results."}</p>
                                        )}
                                        {/* CARD-LAYOUT bulk edit: each staff member is a full
                                            card with controls grouped into clearly-labeled rows.
                                            Was a 1-line cramped strip — controls were 8x8 icon
                                            buttons with no labels, very hard to use during a real
                                            admin session. New layout: 3 rows per card on phone, all
                                            inline on lg+. Each toggle has visible label text so
                                            admins know what they're flipping. */}
                                        {visible.map(s => {
                                            const side = s.scheduleSide || (s.role && ["BOH","Pho","Pho Station","Grill","Fryer","Fried Rice","Dish","Bao/Tacos/Banh Mi","Spring Rolls/Prep","Prep","Kitchen Manager","Asst Kitchen Manager"].includes(s.role) ? "boh" : "foh");
                                            const explicitTagged = !!s.scheduleSide;
                                            const rec = s.recipesAccess !== false;
                                            const ops = s.opsAccess === true;
                                            const labor = s.viewLabor === true || (s.viewLabor !== false && /manager|owner/i.test(s.role || ''));
                                            const lng = s.preferredLanguage === "es" ? "es" : "en";
                                            const cur = s.homeView || 'auto';
                                            return (
                                                <div key={s.id} className={`p-3 rounded-xl border-2 transition ${explicitTagged ? "bg-white border-dd-line" : "bg-red-50 border-red-200"}`}>
                                                    {/* HEADER ROW — name + role + side toggle */}
                                                    <div className="flex items-center gap-3 mb-3">
                                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${side === 'foh' ? 'bg-dd-green-50 text-dd-green-700 border-2 border-dd-green/30' : 'bg-orange-50 text-orange-700 border-2 border-orange-200'}`}>
                                                            {(s.name || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                                                        </div>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="font-bold text-sm text-dd-text truncate flex items-center gap-1.5">
                                                                {s.name}
                                                                {!explicitTagged && <span className="text-[10px] text-red-600 font-bold uppercase tracking-wider">⚠ {language === "es" ? "inferido" : "inferred"}</span>}
                                                            </div>
                                                            <div className="text-[11px] text-dd-text-2 truncate">{s.role} · {LOCATION_LABELS[s.location] || s.location}</div>
                                                        </div>
                                                        <div className="flex gap-1 bg-dd-bg rounded-lg p-0.5 border border-dd-line">
                                                            <button onClick={() => handleBulkUpdate(s.id, { scheduleSide: "foh" })}
                                                                className={`px-3 py-1 rounded-md text-[11px] font-bold transition ${side === "foh" && explicitTagged ? "bg-dd-green text-white shadow-sm" : "text-dd-text-2 hover:bg-white"}`}>
                                                                FOH
                                                            </button>
                                                            <button onClick={() => handleBulkUpdate(s.id, { scheduleSide: "boh" })}
                                                                className={`px-3 py-1 rounded-md text-[11px] font-bold transition ${side === "boh" && explicitTagged ? "bg-orange-600 text-white shadow-sm" : "text-dd-text-2 hover:bg-white"}`}>
                                                                BOH
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {/* PAGE ACCESS ROW — what this person can SEE.
                                                        Includes the new viewLabor toggle (was missing). */}
                                                    <div className="mb-3">
                                                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                                                            {language === "es" ? "Acceso a páginas" : "Page access"}
                                                        </div>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            <AccessToggle
                                                                on={rec} label={language === "es" ? "Recetas" : "Recipes"} icon="🧑‍🍳"
                                                                onClick={() => handleBulkUpdate(s.id, { recipesAccess: !rec })} />
                                                            <AccessToggle
                                                                on={ops} label={language === "es" ? "Operaciones" : "Operations"} icon="📋"
                                                                onClick={() => handleBulkUpdate(s.id, { opsAccess: !ops })} />
                                                            <AccessToggle
                                                                on={labor} label={language === "es" ? "Labor %" : "Labor %"} icon="📊"
                                                                onClick={() => handleBulkUpdate(s.id, { viewLabor: !labor })} />
                                                            <AccessToggle
                                                                on={!!s.shiftLead} label={language === "es" ? "Líder" : "Lead"} icon="🛡"
                                                                onClick={() => handleBulkUpdate(s.id, { shiftLead: !s.shiftLead })} />
                                                            <AccessToggle
                                                                on={!!s.isMinor} label={language === "es" ? "Menor" : "Minor"} icon="🔑"
                                                                onClick={() => handleBulkUpdate(s.id, { isMinor: !s.isMinor })} />
                                                            <AccessToggle
                                                                on={!!s.canReceive86Alerts} label={language === "es" ? "Alertas 86" : "86 alerts"} icon="🚫"
                                                                onClick={() => handleBulkUpdate(s.id, { canReceive86Alerts: !s.canReceive86Alerts })} />
                                                        </div>
                                                    </div>

                                                    {/* HIDDEN PAGES ROW — admin can hide tabs from this
                                                        staff. Default = nothing hidden (all visible).
                                                        Click a chip to toggle hidden state. */}
                                                    {(() => {
                                                        const hidden = Array.isArray(s.hiddenPages) ? s.hiddenPages : [];
                                                        const togglePage = (pageId) => {
                                                            const next = hidden.includes(pageId)
                                                                ? hidden.filter(p => p !== pageId)
                                                                : [...hidden, pageId];
                                                            handleBulkUpdate(s.id, { hiddenPages: next });
                                                        };
                                                        return (
                                                            <div className="mb-3">
                                                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                                                                    {language === "es" ? "Pestañas ocultas" : "Hidden tabs"}
                                                                </div>
                                                                <div className="flex flex-wrap gap-1.5">
                                                                    {HIDEABLE_PAGES.map(pg => {
                                                                        const isHidden = hidden.includes(pg.id);
                                                                        return (
                                                                            <button key={pg.id} onClick={() => togglePage(pg.id)}
                                                                                title={language === "es"
                                                                                    ? (isHidden ? `${pg.labelEs} está OCULTA — clic para mostrar` : `${pg.labelEs} es VISIBLE — clic para ocultar`)
                                                                                    : (isHidden ? `${pg.labelEn} is HIDDEN — click to show` : `${pg.labelEn} is VISIBLE — click to hide`)}
                                                                                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition active:scale-95 ${
                                                                                    isHidden
                                                                                        ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                                                                                        : 'bg-white text-dd-text-2 border-dd-line opacity-60 hover:opacity-100'
                                                                                }`}>
                                                                                <span className="text-sm">{pg.emoji}</span>
                                                                                <span>{language === "es" ? pg.labelEs : pg.labelEn}</span>
                                                                                {isHidden && <span className="text-[10px]">🚫</span>}
                                                                            </button>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        );
                                                    })()}

                                                    {/* SETTINGS ROW — quick prefs the admin tunes per-staff.
                                                        Always visible, never hidden behind another modal. */}
                                                    <div>
                                                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                                                            {language === "es" ? "Preferencias" : "Settings"}
                                                        </div>
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-dd-text-2">
                                                                {language === "es" ? "Inicio:" : "Default tab:"}
                                                                <select value={cur}
                                                                    onChange={e => handleBulkUpdate(s.id, { homeView: e.target.value })}
                                                                    className="border border-dd-line rounded-md px-2 py-1 text-xs bg-white font-bold text-dd-text focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50">
                                                                    <option value="auto">🏠 {language === "es" ? "Auto" : "Auto"}</option>
                                                                    <option value="schedule">📅 {language === "es" ? "Horario" : "Schedule"}</option>
                                                                    <option value="recipes">📖 {language === "es" ? "Recetas" : "Recipes"}</option>
                                                                    <option value="operations">📋 {language === "es" ? "Ops" : "Ops"}</option>
                                                                    <option value="training">📚 {language === "es" ? "Capac." : "Training"}</option>
                                                                    <option value="menu">🍜 {language === "es" ? "Menú" : "Menu"}</option>
                                                                    <option value="eighty6">🚫 86</option>
                                                                    <option value="handoff">🤝 {language === "es" ? "Entrega" : "Handoff"}</option>
                                                                    <option value="tardies">⏰ {language === "es" ? "Tardanzas" : "Tardies"}</option>
                                                                    <option value="labor">📊 Labor</option>
                                                                </select>
                                                            </label>
                                                            <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-dd-text-2">
                                                                {language === "es" ? "Idioma:" : "Lang:"}
                                                                <button onClick={() => handleBulkUpdate(s.id, { preferredLanguage: lng === "es" ? "en" : "es" })}
                                                                    className="px-2.5 py-1 rounded-md text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition">
                                                                    {lng.toUpperCase()}
                                                                </button>
                                                            </label>
                                                            <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-dd-text-2">
                                                                {language === "es" ? "Hrs/sem:" : "Hrs/wk:"}
                                                                <input type="number" inputMode="numeric" pattern="[0-9]*" min="0" max="80" step="1"
                                                                    value={s.targetHours || 0}
                                                                    onChange={e => handleBulkUpdate(s.id, { targetHours: Number(e.target.value) || 0 })}
                                                                    className="w-14 text-center text-xs font-bold border border-dd-line rounded-md py-1 text-dd-text focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50" />
                                                            </label>
                                                            <button onClick={() => { setShowBulkTag(false); setAvailabilityForId(s.id); }}
                                                                title={language === "es" ? "Disponibilidad" : "Availability"}
                                                                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg transition">
                                                                🗓 {language === "es" ? "Disponib." : "Avail"}
                                                            </button>
                                                        </div>
                                                    </div>
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

                    {/* ── RECIPE AUDIT — who opened what, when, where ────────────────
                        Real audit trail backing the "Your name is logged on every
                        view" disclaimer in Recipes.jsx. Each accordion expand writes
                        to /recipe_views {staffName, recipeTitle, viewedAt, geoStatus,
                        userAgent}. If a recipe ever leaks, we have a starting point. */}
                    {(() => {
                        const shown = showAllViews ? recipeViews : recipeViews.slice(0, 25);
                        const fmtTime = (ts) => {
                            if (!ts) return '—';
                            try {
                                const d = ts.toDate ? ts.toDate() : new Date(ts);
                                return d.toLocaleString(language === 'es' ? 'es' : 'en', {
                                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                                });
                            } catch { return '—'; }
                        };
                        const geoBadge = (k) => {
                            if (k === 'inside')   return { c: 'bg-green-100 text-green-700',  t: language === 'es' ? 'En tienda' : 'In-store' };
                            if (k === 'admin')    return { c: 'bg-purple-100 text-purple-700', t: 'Admin' };
                            if (k === 'denied')   return { c: 'bg-amber-100 text-amber-700',  t: language === 'es' ? 'GPS denegado' : 'GPS denied' };
                            if (k === 'error')    return { c: 'bg-amber-100 text-amber-700',  t: language === 'es' ? 'GPS error' : 'GPS err' };
                            if (k === 'outside')  return { c: 'bg-red-100 text-red-700',      t: language === 'es' ? 'Fuera' : 'Off-prem' };
                            return { c: 'bg-gray-100 text-gray-600', t: '—' };
                        };
                        return (
                            <div className="mt-6 mb-4 border border-gray-200 rounded-xl bg-white p-4">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xl">🔍</span>
                                        <h3 className="text-base font-bold text-gray-800">
                                            {language === 'es' ? 'Auditoría de recetas' : 'Recipe view audit'}
                                        </h3>
                                    </div>
                                    <span className="text-[10px] text-gray-400">{recipeViews.length} {language === 'es' ? 'recientes' : 'recent'}</span>
                                </div>
                                <p className="text-[11px] text-gray-500 mb-3">
                                    {language === 'es'
                                        ? 'Cada vez que alguien abre una receta queda registrado: quién, qué, cuándo y desde dónde.'
                                        : 'Every time anyone opens a recipe it\'s logged: who, what, when, and from where.'}
                                </p>
                                {recipeViews.length === 0 ? (
                                    <p className="text-xs text-gray-400 italic">{language === 'es' ? 'Sin vistas registradas todavía.' : 'No views recorded yet.'}</p>
                                ) : (
                                    <div className="overflow-x-auto -mx-2">
                                        <table className="w-full text-[11px]">
                                            <thead>
                                                <tr className="text-gray-500 border-b">
                                                    <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Hora' : 'Time'}</th>
                                                    <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Empleado' : 'Staff'}</th>
                                                    <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Receta' : 'Recipe'}</th>
                                                    <th className="text-left px-2 py-1 font-semibold">{language === 'es' ? 'Ubicación' : 'Location'}</th>
                                                    <th className="text-center px-2 py-1 font-semibold" title={language === 'es' ? 'Señales sospechosas' : 'Suspicious signals'}>⚠️</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {shown.map(v => {
                                                    const g = geoBadge(v.geoStatus);
                                                    const sc  = v.screenshotShortcutCount || 0;
                                                    const qb  = v.quickBlurCount || 0;
                                                    const blr = v.blurCount || 0;
                                                    // Highlight rows where the desktop screenshot shortcut fired
                                                    // (definitive) OR more than 1 quick-blur happened (likely iOS
                                                    // screenshot, allowing 1 for an incidental notification).
                                                    const sus = sc > 0 || qb > 1;
                                                    return (
                                                        <tr key={v.id} className={`border-b last:border-0 ${sus ? 'bg-red-50' : ''}`}>
                                                            <td className="px-2 py-1 text-gray-700 whitespace-nowrap">{fmtTime(v.viewedAt)}</td>
                                                            <td className="px-2 py-1 text-gray-800 font-medium">{v.staffName || '—'}</td>
                                                            <td className="px-2 py-1 text-gray-700">{v.recipeTitle || `#${v.recipeId}`}</td>
                                                            <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded ${g.c} font-semibold`}>{g.t}</span></td>
                                                            <td className="px-2 py-1 text-center">
                                                                {sc > 0 && (
                                                                    <span title={language === 'es' ? `Atajo de captura presionado ${sc}×` : `Screenshot shortcut pressed ${sc}×`}
                                                                        className="inline-block bg-red-200 text-red-800 px-1.5 py-0.5 rounded font-bold mr-1">📸 {sc}</span>
                                                                )}
                                                                {qb > 0 && (
                                                                    <span title={language === 'es' ? `Foco rápido (probable captura iOS) ${qb}×` : `Quick focus loss (likely iOS screenshot) ${qb}×`}
                                                                        className={`inline-block px-1.5 py-0.5 rounded font-bold mr-1 ${qb > 1 ? 'bg-amber-200 text-amber-800' : 'bg-amber-100 text-amber-700'}`}>👁 {qb}</span>
                                                                )}
                                                                {blr > 0 && sc === 0 && qb === 0 && (
                                                                    <span title={language === 'es' ? `Cambió de app ${blr}×` : `App-switched ${blr}×`}
                                                                        className="inline-block bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">↗ {blr}</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                        <div className="mt-2 text-[10px] text-gray-500 px-2 leading-relaxed">
                                            <span className="font-semibold">{language === 'es' ? 'Leyenda:' : 'Legend:'}</span>{' '}
                                            <span className="bg-red-200 text-red-800 px-1 rounded">📸</span> {language === 'es' ? 'atajo de captura (definitivo)' : 'screenshot shortcut (definitive)'} ·{' '}
                                            <span className="bg-amber-200 text-amber-800 px-1 rounded">👁</span> {language === 'es' ? 'foco rápido (probable captura iOS)' : 'quick focus loss (likely iOS screenshot)'} ·{' '}
                                            <span className="bg-gray-100 text-gray-600 px-1 rounded">↗</span> {language === 'es' ? 'cambió de app' : 'app-switched'}
                                        </div>
                                    </div>
                                )}
                                {recipeViews.length > 25 && (
                                    <button onClick={() => setShowAllViews(s => !s)}
                                        className="mt-2 text-[11px] font-bold text-mint-700">
                                        {showAllViews
                                            ? (language === 'es' ? 'Mostrar menos' : 'Show less')
                                            : (language === 'es' ? `Ver todas (${recipeViews.length})` : `View all (${recipeViews.length})`)}
                                    </button>
                                )}
                            </div>
                        );
                    })()}

                    {/* ── PUSH NOTIFICATIONS DIAGNOSTIC ──────────────────────────────
                        Quick verification panel. Shows the local SW + permission +
                        FCM-token state, and a "Test push" button that writes a
                        notification doc to YOU. If you receive it on your phone
                        with the app CLOSED, end-to-end push is working. If you
                        only receive it with the app open, the Cloud Function
                        isn't deployed (`firebase deploy --only functions`) or
                        background SW isn't registering (check console for
                        "FCM service worker register failed"). */}
                    {(() => {
                        const me = staffList.find(s => s.name === staffName);
                        const tokens = (me?.fcmTokens || []).length;
                        const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
                        const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
                        // iOS push gate: iOS Safari refuses to deliver
                        // push to non-standalone (non-PWA) sessions, even
                        // with permission granted. Detect iOS + non-
                        // standalone and surface the exact remediation
                        // ("Add to Home Screen, then open from there"),
                        // otherwise users see a green diagnostic but
                        // never receive a single push.
                        const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
                        const isIOS = /iPad|iPhone|iPod/.test(ua)
                            || (ua.includes('Mac') && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
                        const isStandalone = typeof window !== 'undefined' && (
                            window.matchMedia?.('(display-mode: standalone)')?.matches
                            || window.navigator?.standalone === true
                        );
                        const iosBlocksPush = isIOS && !isStandalone;
                        const sendTestPush = async () => {
                            try {
                                const { addDoc, collection, serverTimestamp } = await import('firebase/firestore');
                                await addDoc(collection(db, 'notifications'), {
                                    forStaff: staffName,
                                    type: 'test',
                                    title: language === 'es' ? '🔔 Prueba de notificación' : '🔔 Push test',
                                    body: language === 'es'
                                        ? `Si recibes esto con la app cerrada, el push funciona. Hora: ${new Date().toLocaleTimeString()}`
                                        : `If you got this with the app closed, push works end-to-end. Sent ${new Date().toLocaleTimeString()}`,
                                    createdAt: serverTimestamp(),
                                    read: false,
                                    createdBy: staffName,
                                });
                            } catch (e) {
                                console.error('test push failed:', e);
                            }
                        };
                        return (
                            <div className="mt-6 mb-4 border border-blue-200 rounded-xl bg-blue-50 p-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-xl">🔔</span>
                                    <h3 className="text-base font-bold text-blue-900">
                                        {language === 'es' ? 'Diagnóstico de notificaciones' : 'Push notifications diagnostic'}
                                    </h3>
                                </div>
                                <ul className="text-xs text-blue-900 space-y-1 mb-3">
                                    <li><strong>{language === 'es' ? 'Service Worker:' : 'Service Worker:'}</strong> {swSupported ? '✅' : '❌'} {swSupported ? (language === 'es' ? 'soportado' : 'supported') : (language === 'es' ? 'no soportado en este dispositivo' : 'not supported on this device')}</li>
                                    <li><strong>{language === 'es' ? 'Permiso del navegador:' : 'Browser permission:'}</strong> {perm === 'granted' ? '✅' : perm === 'denied' ? '🚫' : '⚠️'} {perm}</li>
                                    <li><strong>{language === 'es' ? 'Tokens FCM registrados:' : 'FCM tokens registered:'}</strong> {tokens > 0 ? '✅' : '❌'} {tokens}</li>
                                    {isIOS && (
                                        <li>
                                            <strong>{language === 'es' ? 'Modo iOS:' : 'iOS mode:'}</strong>{' '}
                                            {isStandalone ? '✅' : '🚫'}{' '}
                                            {isStandalone
                                                ? (language === 'es' ? 'PWA instalado (pushes funcionarán)' : 'Installed PWA (push works)')
                                                : (language === 'es' ? 'Safari — iOS NO entregará push aquí' : 'Safari — iOS will NOT deliver push here')}
                                        </li>
                                    )}
                                </ul>
                                {iosBlocksPush && (
                                    <div className="mb-3 p-3 rounded-lg bg-amber-100 border-2 border-amber-300 text-xs text-amber-900">
                                        <div className="font-bold mb-1">
                                            🍎 {language === 'es' ? 'iOS bloquea push en Safari' : 'iOS blocks push in Safari'}
                                        </div>
                                        <div className="leading-relaxed">
                                            {language === 'es'
                                                ? 'Apple sólo permite notificaciones push cuando la app está instalada en la pantalla de inicio. Para activar:'
                                                : "Apple only allows push notifications when the app is installed to your Home Screen. To enable:"}
                                            <ol className="list-decimal ml-4 mt-1 space-y-0.5">
                                                <li>{language === 'es' ? 'Toca el ícono de Compartir (cuadro con flecha arriba) en Safari' : 'Tap the Share icon (square with up-arrow) in Safari'}</li>
                                                <li>{language === 'es' ? 'Desplázate y toca "Añadir a pantalla de inicio"' : 'Scroll down → tap "Add to Home Screen"'}</li>
                                                <li>{language === 'es' ? 'Cierra Safari y abre DD Mau desde el ícono nuevo' : 'Close Safari and open DD Mau from the new icon'}</li>
                                                <li>{language === 'es' ? 'Acepta el permiso de notificaciones cuando aparezca' : 'Accept the notification permission when prompted'}</li>
                                            </ol>
                                        </div>
                                    </div>
                                )}
                                {/* Recent notifications for THIS staff — proves
                                    whether the issue is "notification docs aren't
                                    being written" vs "they are written but FCM
                                    delivery is failing." If you see your event
                                    here but no toast on your device, the problem
                                    is delivery (Cloud Function not deployed,
                                    token stale, etc.). If you don't see your
                                    event here at all, the problem is upstream
                                    (notify() didn't fire for some reason). */}
                                <RecentNotificationsFeed staffName={staffName} language={language} />
                                <button onClick={sendTestPush}
                                    className="w-full py-2 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700">
                                    🧪 {language === 'es' ? 'Enviar push de prueba a mí' : 'Send test push to myself'}
                                </button>
                                {/* Register-now — runs enableFcmPush on demand and
                                    surfaces the exact failure reason inline. Use
                                    when token count = 0: the auto-register on app
                                    load may have failed silently (permission
                                    denied, SW register error, getToken throw)
                                    and a full reload doesn't fix it. This button
                                    is the deterministic path to "make my token
                                    appear right now or tell me why it won't." */}
                                <button
                                    onClick={async () => {
                                        try {
                                            const result = await enableFcmPush(staffName, staffList, setStaffList);
                                            if (result.ok) {
                                                alert(language === 'es'
                                                    ? '✅ Registrado. Tu token está guardado. Prueba enviarte un push.'
                                                    : '✅ Registered. Your token is saved. Try sending a test push.');
                                            } else {
                                                const reasonLabel = {
                                                    'no-notification-api': language === 'es' ? 'Este navegador no soporta notificaciones' : "This browser doesn't support notifications",
                                                    'permission-denied': language === 'es' ? 'Permisos bloqueados — actívalos en ajustes del navegador' : 'Permission denied — turn notifications back on in browser settings',
                                                    'no-vapid-key': language === 'es' ? 'Clave VAPID falta (error de despliegue)' : 'VAPID key missing (deploy bug)',
                                                    'messaging-unsupported': language === 'es' ? 'FCM no soportado aquí (Safari sin iOS 16.4+?)' : 'FCM unsupported here (Safari without iOS 16.4+?)',
                                                    'sw-register-failed': language === 'es' ? 'No se pudo registrar el Service Worker' : 'Service Worker failed to register',
                                                    'get-token-failed': language === 'es' ? 'FCM rechazó dar un token (mira la consola)' : 'FCM refused to issue a token (check console)',
                                                    'no-token': language === 'es' ? 'FCM devolvió token vacío' : 'FCM returned empty token',
                                                }[result.reason] || result.reason;
                                                alert((language === 'es' ? '❌ Falló: ' : '❌ Failed: ') + reasonLabel);
                                            }
                                        } catch (e) {
                                            console.error('register now failed:', e);
                                            alert((language === 'es' ? '❌ Error: ' : '❌ Error: ') + (e.message || e));
                                        }
                                    }}
                                    className="w-full mt-2 py-2 rounded-lg bg-green-600 text-white text-sm font-bold hover:bg-green-700">
                                    📲 {language === 'es' ? 'Registrar este dispositivo ahora' : 'Register this device now'}
                                </button>
                                {/* Reset push tokens — nukes ALL fcmTokens on this
                                    staff's record. Use when you're getting
                                    duplicate notifications: legacy entries without
                                    a deviceId can't be auto-deduped, so the only
                                    cleanup is to wipe + re-register fresh. After
                                    reset, this device re-registers automatically
                                    on the next page load (via App.jsx's
                                    enableFcmPush useEffect) — that new entry has
                                    a deviceId so future rotations dedupe cleanly. */}
                                <button
                                    onClick={async () => {
                                        if (!confirm(language === 'es'
                                            ? '¿Borrar tus tokens de notificación y volver a registrar? Soluciona notificaciones duplicadas.'
                                            : 'Clear your push tokens and re-register? Fixes duplicate-notification issues.'
                                        )) return;
                                        try {
                                            const { runTransaction, doc } = await import('firebase/firestore');
                                            await runTransaction(db, async (tx) => {
                                                const ref = doc(db, 'config', 'staff');
                                                const snap = await tx.get(ref);
                                                if (!snap.exists()) return;
                                                const liveList = (snap.data() || {}).list || [];
                                                const next = liveList.map(s =>
                                                    s.name === staffName
                                                        ? { ...s, fcmTokens: [] }
                                                        : s
                                                );
                                                tx.set(ref, { list: next });
                                            });
                                            alert(language === 'es'
                                                ? 'Tokens borrados. Recarga la página para re-registrar.'
                                                : 'Tokens cleared. Reload the page to re-register a fresh single token.');
                                        } catch (e) {
                                            console.error('reset push tokens failed:', e);
                                            alert('Reset failed: ' + (e.message || e));
                                        }
                                    }}
                                    className="w-full mt-2 py-2 rounded-lg bg-white border-2 border-blue-300 text-blue-700 text-sm font-bold hover:bg-blue-100">
                                    🔄 {language === 'es' ? 'Borrar mis tokens (resolver duplicados)' : 'Reset my push tokens (fix duplicates)'}
                                </button>
                                <p className="text-[10px] text-blue-800 mt-2 leading-relaxed">
                                    {language === 'es'
                                        ? 'Cierra la app, luego pulsa el botón. Si recibes la notificación con la app cerrada, todo el camino funciona. Si sólo la ves al abrir la app, la Cloud Function no está desplegada o el SW falló.'
                                        : 'Close the app, then tap the button. If the notification arrives while the app is closed, end-to-end push is working. If you only see it after opening the app, the Cloud Function isn\'t deployed or the SW failed to register.'}
                                </p>
                            </div>
                        );
                    })()}

                    {/* ── DANGER ZONE — System Refresh broadcast ────────────────────
                        Writes a timestamp to /config/forceRefresh. Every active
                        client subscribes to that doc in App.jsx and force-refreshes
                        on change. Use SPARINGLY — interrupts every staff member
                        mid-action. Reserved for production breakage / critical fixes. */}
                    <div className="mt-8 mb-4 border-2 border-red-300 rounded-xl bg-red-50 p-4">
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-2xl">⚠️</span>
                            <h3 className="text-base font-bold text-red-900 uppercase tracking-wide">
                                {language === "es" ? "Zona Peligrosa" : "Danger Zone"}
                            </h3>
                        </div>
                        <p className="text-xs text-red-900 mb-3">
                            {language === "es"
                                ? "El refresco del sistema obliga a TODOS los dispositivos activos a recargar inmediatamente. Cualquier persona en medio de algo perderá su trabajo no guardado. Úsalo solo para fallas reales o correcciones críticas."
                                : "System Refresh forces EVERY active device to reload immediately. Anyone mid-action will lose unsaved work. Use only for real production breakage or critical fixes."}
                        </p>
                        {!confirmingRefresh ? (
                            <button onClick={() => setConfirmingRefresh(true)}
                                className="w-full py-3 rounded-lg bg-red-600 text-white text-sm font-bold uppercase tracking-wide hover:bg-red-700 active:scale-[0.99] transition shadow-lg shadow-red-200">
                                🚨 {language === "es" ? "Refresco del Sistema" : "System Refresh"}
                            </button>
                        ) : (
                            <div className="space-y-2">
                                <div className="bg-red-700 text-white rounded-lg p-3 text-center text-sm font-bold animate-pulse">
                                    {language === "es"
                                        ? "¿Estás SEGURO? Esto interrumpirá a todos los dispositivos activos."
                                        : "Are you SURE? This will interrupt every active device."}
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <button onClick={() => setConfirmingRefresh(false)}
                                        className="py-3 rounded-lg bg-gray-200 text-gray-800 text-sm font-bold hover:bg-gray-300">
                                        {language === "es" ? "Cancelar" : "Cancel"}
                                    </button>
                                    <button onClick={handleSystemRefresh}
                                        className="py-3 rounded-lg bg-red-700 text-white text-sm font-bold uppercase tracking-wide hover:bg-red-800 shadow-lg">
                                        ✓ {language === "es" ? "Confirmar Refresco" : "Confirm Refresh"}
                                    </button>
                                </div>
                                <p className="text-[10px] text-red-700 text-center">
                                    {language === "es" ? "Auto-cancelar en 10 segundos." : "Auto-cancels in 10 seconds."}
                                </p>
                            </div>
                        )}
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
